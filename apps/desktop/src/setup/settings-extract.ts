// What the reader takes from OpenClaw's settings file: a local gateway's
// literal token and its port candidate, and nothing else
// (docs/design/setup-effortless.md §3, "What it extracts"). The rules follow
// OpenClaw 2026.10.6's own resolution of `gateway.auth`. This runs in the
// parse worker (settings-parse.ts), after the lexer.

import JSON5 from "json5";
import { lexSettings, type LexRefusal } from "./settings-lexer.ts";
import { OPENCLAW_DEFAULT_PORT } from "./world.ts";

/**
 * Why a file gave no usable gateway, by the design's failure rows (§8):
 * `unreadable` too complex or malformed, `address` a remote profile or an
 * invalid port, `credential` no literal token or an unsupported auth mode.
 */
export type Extracted =
  | { kind: "found"; token: string; port: number }
  | { kind: "refused"; reason: "unreadable"; why: LexRefusal | "shape" }
  | { kind: "refused"; reason: "address"; why: "remote" | "port" }
  | {
      kind: "refused";
      reason: "credential";
      why:
        | "no-token"
        | "auth-mode"
        | "password"
        | "secret-ref"
        | "indirect"
        | "redacted"
        | "empty"
        | "long"
        | "control";
    };

export const TOKEN_MAX_BYTES = 4096;

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

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
const own = (object: Plain, key: string): unknown =>
  Object.hasOwn(object, key) ? object[key] : undefined;

export function extractSettings(text: string): Extracted {
  const lexed = lexSettings(text);
  if (lexed) return { kind: "refused", reason: "unreadable", why: lexed };
  let root: unknown;
  try {
    root = JSON5.parse(text);
  } catch {
    return { kind: "refused", reason: "unreadable", why: "malformed" };
  }
  if (!isPlain(root)) return { kind: "refused", reason: "unreadable", why: "shape" };
  const gateway = own(root, "gateway");
  if (gateway === undefined) return { kind: "refused", reason: "credential", why: "no-token" };
  if (!isPlain(gateway)) return { kind: "refused", reason: "unreadable", why: "shape" };

  const mode = own(gateway, "mode");
  if (mode !== undefined && mode !== "local")
    return { kind: "refused", reason: "address", why: "remote" };
  // The default only when the port is absent: null or any other value is refused.
  const port = Object.hasOwn(gateway, "port") ? gateway.port : OPENCLAW_DEFAULT_PORT;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
    return { kind: "refused", reason: "address", why: "port" };

  const auth = own(gateway, "auth");
  if (auth === undefined) return { kind: "refused", reason: "credential", why: "no-token" };
  if (!isPlain(auth)) return { kind: "refused", reason: "unreadable", why: "shape" };
  // An absent mode is password mode when a password is set, so a password refuses either way.
  const authMode = own(auth, "mode");
  if (authMode !== undefined && authMode !== "token")
    return { kind: "refused", reason: "credential", why: "auth-mode" };
  if (Object.hasOwn(auth, "password"))
    return { kind: "refused", reason: "credential", why: "password" };
  const raw = own(auth, "token");
  if (raw === undefined) return { kind: "refused", reason: "credential", why: "no-token" };
  if (typeof raw !== "string") return { kind: "refused", reason: "credential", why: "secret-ref" };

  // OpenClaw trims, then treats `$NAME`, `${…}` and its legacy markers as references.
  const token = raw.trim();
  if (!token) return { kind: "refused", reason: "credential", why: "empty" };
  if (REDACTED.has(token)) return { kind: "refused", reason: "credential", why: "redacted" };
  if (
    token.startsWith("$") ||
    token.includes("${") ||
    token.startsWith("secretref-env:") ||
    token.startsWith("__env__:")
  )
    return { kind: "refused", reason: "credential", why: "indirect" };
  if (Buffer.byteLength(token, "utf8") > TOKEN_MAX_BYTES)
    return { kind: "refused", reason: "credential", why: "long" };
  if (CONTROL.test(token)) return { kind: "refused", reason: "credential", why: "control" };
  return { kind: "found", token, port };
}
