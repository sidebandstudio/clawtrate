// What the look's programs printed, turned into typed facts in memory
// (docs/design/setup.md §2 rule 6, §19 "Validated arguments"). Every value
// is checked against the shape it must have; anything else is "the wrong
// shape" and the raw text is dropped with the result.

import { MAX_LOOK_OTHER_CHARS, type LookService } from "@clawtrate/core";

/** `openclaw --version`: `OpenClaw 2026.10.6 (fe06181)`. */
const VERSION_LINE = /^OpenClaw (\d{4})\.(\d{1,2})\.(\d{1,3})( \([0-9a-f]{7,12}\))?$/;
/** A gateway's own version, as `gateway status --json` reports it. */
const BARE_VERSION = /^(\d{4})\.(\d{1,2})\.(\d{1,3})$/;

export type Version = { text: string; parts: [number, number, number] };

export function parseVersionLine(stdout: string): Version | null {
  const match = VERSION_LINE.exec(stdout.trim());
  if (!match) return null;
  const parts: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return { text: parts.join("."), parts };
}

export function parseBareVersion(value: unknown): Version | null {
  if (typeof value !== "string") return null;
  const match = BARE_VERSION.exec(value);
  if (!match) return null;
  const parts: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return { text: parts.join("."), parts };
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i += 1) if (a.parts[i] !== b.parts[i]) return a.parts[i]! - b.parts[i]!;
  return 0;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** One JSON value and nothing else, or null. */
function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/** What `openclaw gateway status --json` says about one profile's gateway. */
export type GatewayStatus = {
  configExists: boolean;
  /** The profile's config file, kept to tell this gateway from another; never shown or opened. */
  configPath: string;
  port: number;
  bind: "loopback" | "network";
  /** The registered service, or none for a gateway started by hand. */
  service: { kind: "launchagent" | "systemd"; state: "running" | "stopped" | "other" } | null;
  /** Whether something listens on the gateway's port. */
  listening: boolean;
  /** `rpc.ok` with the version the running gateway reported, or null. */
  answered: Version | null;
  /** `rpc.ok` was false. */
  unanswered: boolean;
};

/** `gateway status --json`, or null when any fact the look needs has the wrong shape. */
export function parseStatus(stdout: string): GatewayStatus | null {
  const root = record(parseJson(stdout));
  if (!root) return null;
  const config = record(record(root.config)?.cli);
  const gateway = record(root.gateway);
  const service = record(root.service);
  const runtime = record(service?.runtime);
  const port = record(root.port);
  const rpc = record(root.rpc);
  if (!config || typeof config.exists !== "boolean") return null;
  if (typeof config.path !== "string" || config.path.length > 1024) return null;
  if (!gateway || !service || !port || !rpc || typeof rpc.ok !== "boolean") return null;
  const number = gateway.port;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1024 || number > 65535)
    return null;
  if (typeof gateway.bindMode !== "string") return null;
  if (port.status !== "free" && port.status !== "busy") return null;

  let kind: "launchagent" | "systemd" | null;
  if (typeof service.label !== "string") return null;
  if (/^launchagent$/i.test(service.label)) kind = "launchagent";
  else if (/^systemd( user)?$/i.test(service.label)) kind = "systemd";
  else kind = null;
  const status = runtime?.status;
  const missing = runtime?.missingUnit === true;
  // A registered service is one launchd or systemd knows of: loaded, or its unit is there.
  const registered = kind !== null && !missing && (service.loaded === true || status === "stopped");
  let answered: Version | null = null;
  if (rpc.ok) {
    answered =
      parseBareVersion(rpc.version) ??
      parseBareVersion(record(rpc.server)?.version) ??
      parseBareVersion(gateway.version);
    // An answer must carry its version.
    if (!answered) return null;
  }
  return {
    configExists: config.exists,
    configPath: config.path,
    port: number,
    bind: gateway.bindMode === "loopback" ? "loopback" : "network",
    service: registered
      ? {
          kind: kind!,
          state: status === "running" ? "running" : status === "stopped" ? "stopped" : "other",
        }
      : null,
    listening: port.status === "busy",
    answered,
    unanswered: !rpc.ok,
  };
}

/** The service as the found card names it. */
export function serviceFact(status: GatewayStatus): LookService {
  if (!status.service) return "none";
  const stopped = status.service.state === "stopped";
  if (status.service.kind === "launchagent") return stopped ? "launchagent-stopped" : "launchagent";
  return stopped ? "systemd-stopped" : "systemd";
}

/** A service label from `extraServices`: shown as text, never used. */
const SERVICE_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._()@:-]*$/;

/** The labels of `gateway status --json --deep`'s `extraServices`, or null for the wrong shape. */
export function parseExtraServices(stdout: string): string[] | null {
  const root = record(parseJson(stdout));
  if (!root || !Array.isArray(root.extraServices)) return null;
  const labels: string[] = [];
  for (const entry of root.extraServices) {
    const label = record(entry)?.label;
    if (
      typeof label === "string" &&
      label.length <= MAX_LOOK_OTHER_CHARS &&
      SERVICE_LABEL.test(label)
    )
      labels.push(label);
  }
  return labels;
}

export type AuthMode = "token" | "password" | "none" | "trusted-proxy";

/** `openclaw config get gateway.auth.mode --json`: one JSON string. */
export function parseAuthMode(stdout: string): AuthMode | null {
  const value = parseJson(stdout);
  return value === "token" || value === "password" || value === "none" || value === "trusted-proxy"
    ? value
    : null;
}

/** What the host keeps of a setup code it made: in memory, for one connect. */
export type SetupCode = { url: string; bootstrapToken: string; expiresAtMs: number };

/** A bootstrap token as OpenClaw mints them: base64url, 32 to 128 characters. */
const BOOTSTRAP_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * `openclaw qr --json --voice-node --url <url>`: the code, decoded, only when
 * its address is exactly `url`. Nothing else of the output is kept.
 */
export function parseSetupCode(stdout: string, url: string, now: number): SetupCode | null {
  const root = record(parseJson(stdout));
  const encoded = root?.setupCode;
  if (typeof encoded !== "string" || encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded))
    return null;
  let payload: Record<string, unknown> | null;
  try {
    payload = record(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
  } catch {
    return null;
  }
  const token = payload?.bootstrapToken;
  const expires = payload?.expiresAtMs;
  if (payload?.url !== url) return null;
  if (typeof token !== "string" || !BOOTSTRAP_TOKEN.test(token)) return null;
  if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= now) return null;
  return { url, bootstrapToken: token, expiresAtMs: expires };
}
