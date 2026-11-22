// What the reader takes from OpenClaw's settings file: a local gateway's
// literal token and its port candidate, and nothing else
// (docs/design/setup-effortless.md §3, "What it extracts"). The rules follow
// OpenClaw 2026.10.6's own resolution of `gateway.auth`. This runs in the
// parse worker (settings-parse.ts), after the lexer.

import JSON5 from "json5";
import { lexSettings } from "./settings-lexer.ts";
import { OPENCLAW_DEFAULT_PORT } from "./world.ts";

/** The canonical profiles the reader looks at. */
export type SettingsProfile = "default" | "clawtrate";

/**
 * Every refusal, by the design's failure rows (§8): `unreadable` too complex
 * or malformed, `address` a remote profile or an unusable port, `credential`
 * no literal token, a password that could win, or an unsupported auth mode.
 */
export const REFUSALS = {
  unreadable: ["complex", "malformed", "duplicate", "prototype", "include", "shape"],
  address: ["remote", "port"],
  credential: [
    "no-token",
    "auth-mode",
    "password",
    "secret-ref",
    "indirect",
    "redacted",
    "placeholder",
    "empty",
    "long",
    "control",
  ],
} as const;

type Refusal = {
  [Reason in keyof typeof REFUSALS]: {
    kind: "refused";
    reason: Reason;
    why: (typeof REFUSALS)[Reason][number];
  };
}[keyof typeof REFUSALS];

export type Extracted = { kind: "found"; token: string; port: number } | Refusal;

export const TOKEN_MAX_BYTES = 4096;

/**
 * The port OpenClaw listens on when the file names none: 18789 for the
 * default profile, and for a named profile `20000 + FNV-1a(name) % 40000`
 * (`resolveGatewayPort`, `<openclaw>/dist/paths-BP0DYpE8.mjs` lines 214-224),
 * which is 22768 for `clawtrate`.
 */
export const DEFAULT_PORTS: Record<SettingsProfile, number> = {
  default: OPENCLAW_DEFAULT_PORT,
  clawtrate: 22768,
};

/** OpenClaw's display markers, which are never credentials (`isRedactedSecretValue`). */
const REDACTED = new Set([
  "__OPENCLAW_REDACTED__",
  "REDACTED",
  "xoxb-REDACTED",
  "xapp-REDACTED",
  "***",
  "[redacted]",
  "[REDACTED]",
  "<redacted>",
  "[REDACTED_PRIVATE_KEY]",
  "[REDACTED CREDENTIAL]",
]);

/** Values OpenClaw refuses to start with (`<openclaw>/dist/known-weak-gateway-secrets-*.mjs`). */
const PLACEHOLDERS = new Set([
  "change-me-to-a-long-random-token",
  "change-me-now",
  "undefined",
  "null",
]);

/** OpenClaw's `$NAME` shorthand for an environment variable (`ENV_SECRET_SHORTHAND_RE`). */
const ENV_SHORTHAND = /^\$[A-Z][A-Z0-9_]{0,127}$/;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A token the host may hold: what the rules below accept, checked again at the worker's boundary. */
export const usableToken = (token: string) =>
  token.length > 0 &&
  token === token.trim() &&
  Buffer.byteLength(token, "utf8") <= TOKEN_MAX_BYTES &&
  !CONTROL.test(token);

export const usablePort = (port: unknown): port is number =>
  typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
const own = (object: Plain, key: string): unknown =>
  Object.hasOwn(object, key) ? object[key] : undefined;

/**
 * Whether the file's `env` or `env.vars` names this variable, by its key in
 * any case as OpenClaw normalizes it, whatever its value.
 */
function declaresEnv(root: Plain, name: string): boolean {
  const env = own(root, "env");
  if (!isPlain(env)) return false;
  const vars = own(env, "vars");
  const keys = [...Object.keys(env), ...(isPlain(vars) ? Object.keys(vars) : [])];
  return keys.some((key) => key.toUpperCase() === name);
}

const refuse = <Reason extends keyof typeof REFUSALS>(
  reason: Reason,
  why: (typeof REFUSALS)[Reason][number],
) => ({ kind: "refused", reason, why }) as Refusal;

export function extractSettings(text: string, profile: SettingsProfile): Extracted {
  const lexed = lexSettings(text);
  if (lexed) return refuse("unreadable", lexed);
  let root: unknown;
  try {
    root = JSON5.parse(text);
  } catch {
    return refuse("unreadable", "malformed");
  }
  if (!isPlain(root)) return refuse("unreadable", "shape");
  const gateway = own(root, "gateway");
  if (gateway === undefined) return refuse("credential", "no-token");
  if (!isPlain(gateway)) return refuse("unreadable", "shape");

  const mode = own(gateway, "mode");
  if (mode !== undefined && mode !== "local") return refuse("address", "remote");
  // The default only when the port is absent: null or any other value is refused, and so is a
  // port the file's own environment could override.
  const port = Object.hasOwn(gateway, "port") ? gateway.port : DEFAULT_PORTS[profile];
  if (!usablePort(port) || declaresEnv(root, "OPENCLAW_GATEWAY_PORT"))
    return refuse("address", "port");

  const auth = own(gateway, "auth");
  if (auth === undefined) return refuse("credential", "no-token");
  if (!isPlain(auth)) return refuse("unreadable", "shape");
  const authMode = own(auth, "mode");
  if (authMode !== undefined && authMode !== "token") return refuse("credential", "auth-mode");
  // A local password refuses in either mode. With the mode absent, any password OpenClaw
  // could resolve makes it password mode: the remote one, or the file's own environment's.
  if (Object.hasOwn(auth, "password")) return refuse("credential", "password");
  if (authMode === undefined) {
    const remote = own(gateway, "remote");
    if (
      (isPlain(remote) && Object.hasOwn(remote, "password")) ||
      declaresEnv(root, "OPENCLAW_GATEWAY_PASSWORD")
    )
      return refuse("credential", "password");
  }
  const raw = own(auth, "token");
  if (raw === undefined) return refuse("credential", "no-token");
  if (typeof raw !== "string") return refuse("credential", "secret-ref");

  // OpenClaw trims, then treats `$NAME`, `${…}` and its legacy markers as references.
  const token = raw.trim();
  if (!token) return refuse("credential", "empty");
  if (PLACEHOLDERS.has(token)) return refuse("credential", "placeholder");
  if (REDACTED.has(token)) return refuse("credential", "redacted");
  if (
    ENV_SHORTHAND.test(token) ||
    token.includes("${") ||
    token.startsWith("secretref-env:") ||
    token.startsWith("__env__:")
  )
    return refuse("credential", "indirect");
  if (Buffer.byteLength(token, "utf8") > TOKEN_MAX_BYTES) return refuse("credential", "long");
  if (CONTROL.test(token)) return refuse("credential", "control");
  return { kind: "found", token, port };
}
