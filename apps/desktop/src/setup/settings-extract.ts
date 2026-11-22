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

type TokenRefusal = "placeholder" | "redacted" | "indirect" | "empty" | "long" | "control";

/**
 * Why a token, already trimmed as OpenClaw trims it, isn't a literal the host
 * may hold, or null. The one rule for both the extraction below and the
 * host's check of the worker's answer.
 */
export function literalTokenRefusal(token: string): TokenRefusal | null {
  if (!token) return "empty";
  if (PLACEHOLDERS.has(token)) return "placeholder";
  if (REDACTED.has(token)) return "redacted";
  // OpenClaw treats `$NAME`, `${…}` and its legacy markers as references.
  if (
    ENV_SHORTHAND.test(token) ||
    token.includes("${") ||
    token.startsWith("secretref-env:") ||
    token.startsWith("__env__:")
  )
    return "indirect";
  if (Buffer.byteLength(token, "utf8") > TOKEN_MAX_BYTES) return "long";
  if (CONTROL.test(token)) return "control";
  return null;
}

export const usablePort = (port: unknown): port is number =>
  typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
const own = (object: Plain, key: string): unknown =>
  Object.hasOwn(object, key) ? object[key] : undefined;

/**
 * Whether the file's `env` or `env.vars` names this variable, whatever its
 * value, by its key as OpenClaw normalizes it: trimmed (`normalizeEnvVarKey`,
 * `<openclaw>/dist/host-env-security-*.mjs`), in any case.
 */
function envDeclarations(root: Plain, name: string): unknown[] {
  const env = own(root, "env");
  if (!isPlain(env)) return [];
  const vars = own(env, "vars");
  const entries = [...Object.entries(env), ...(isPlain(vars) ? Object.entries(vars) : [])];
  return entries.filter(([key]) => key.trim().toUpperCase() === name).map(([, value]) => value);
}
const declaresEnv = (root: Plain, name: string) => envDeclarations(root, name).length > 0;

/**
 * The values OpenClaw reads as a switch turned on (`isTruthyEnvValue`,
 * `<openclaw>/dist/env-CIlPDP83.mjs` lines 44-46, by `parseBooleanValue`,
 * `boolean-CFfzB3ix.mjs`): trimmed and lowercased. Anything else is off.
 */
const SWITCH_ON = new Set(["true", "1", "yes", "on"]);

/**
 * Whether the file turns on OpenClaw's login-shell import, which then fills
 * a missing `OPENCLAW_GATEWAY_PASSWORD` from the shell:
 * - `env.shellEnv.enabled` (`<openclaw>/dist/io.factory-B2b2ehlc.mjs` line
 *   625), counted unless it is absent or `false`;
 * - an `OPENCLAW_LOAD_SHELL_ENV` that the file's `env` or `env.vars` sets for
 *   that check (`run-CZZ9dIV4.mjs` lines 2532-2533,
 *   `shell-env-BMzNsAbc.mjs` line 259), counted when any declaration is a
 *   string OpenClaw reads as on, or one with a `$` whose value the file alone
 *   can't settle. OpenClaw applies only string values
 *   (`config-env-vars-97Jxmxag.mjs` line 56).
 */
function loadsShellEnv(root: Plain): boolean {
  const env = own(root, "env");
  const shellEnv = isPlain(env) ? own(env, "shellEnv") : undefined;
  const enabled = isPlain(shellEnv) ? own(shellEnv, "enabled") : undefined;
  if (enabled !== undefined && enabled !== false) return true;
  return envDeclarations(root, "OPENCLAW_LOAD_SHELL_ENV").some(
    (value) =>
      typeof value === "string" &&
      (value.includes("$") || SWITCH_ON.has(value.trim().toLowerCase())),
  );
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
  // could resolve makes it password mode: the remote one, the file's own environment's, or
  // one the login shell supplies when the file turns that import on.
  if (Object.hasOwn(auth, "password")) return refuse("credential", "password");
  if (authMode === undefined) {
    const remote = own(gateway, "remote");
    if (
      (isPlain(remote) && Object.hasOwn(remote, "password")) ||
      declaresEnv(root, "OPENCLAW_GATEWAY_PASSWORD") ||
      loadsShellEnv(root)
    )
      return refuse("credential", "password");
  }
  const raw = own(auth, "token");
  if (raw === undefined) return refuse("credential", "no-token");
  if (typeof raw !== "string") return refuse("credential", "secret-ref");

  const token = raw.trim();
  const why = literalTokenRefusal(token);
  return why ? refuse("credential", why) : { kind: "found", token, port };
}
