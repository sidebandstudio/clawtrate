// The LOOK script, run on the other computer as `/bin/sh -s` with the script on
// standard input (docs/design/setup.md, section 19), and the parser for what it
// prints. The script is a constant; its one value is the run's request id,
// which the host makes and validates. It looks only in fixed places and prints
// one JSON line per fact between a begin and an end line carrying that id, so
// anything a login start-up file printed before it is told apart and dropped.
// Every program output travels as base64 and is checked here, in memory,
// before any fact is returned; nothing raw is kept.

import { randomUUID } from "node:crypto";

/** The fixed places, in order; the facts name a place by its index. */
export const PROGRAM_PLACES = [
  "~/.openclaw/bin/openclaw",
  "/opt/homebrew/bin/openclaw",
  "/usr/local/bin/openclaw",
  "~/.local/bin/openclaw",
  "~/.npm-global/bin/openclaw",
] as const;

export type ProgramPlace = (typeof PROGRAM_PLACES)[number];

/** The script's body. Edit with care: a test runs it under several shells and a hostile login. */
export const LOOK_SCRIPT_BODY = String.raw`set -eu
case "$request_id" in
  *[!0-9a-f-]*|'') exit 64 ;;
esac
# Stop after 30 seconds, whatever is still running.
( sleep 30 </dev/null >/dev/null 2>&1 & s=$!
  trap 'kill "$s" 2>/dev/null; exit 0' TERM
  wait "$s" && kill -TERM 0 2>/dev/null ) </dev/null >/dev/null 2>&1 &
watchdog=$!
cd "$HOME" 2>/dev/null || cd /
b64() { head -c "$1" | base64 | tr -d '\r\n'; }
line() { printf '{"k":"%s"%s}\n' "$1" "$2"; }
line begin ",\"id\":\"$request_id\""
line uname ",\"s\":\"$(uname -s </dev/null 2>/dev/null | b64 256 || true)\",\"m\":\"$(uname -m </dev/null 2>/dev/null | b64 256 || true)\",\"n\":\"$(uname -n </dev/null 2>/dev/null | b64 256 || true)\""
prog=''
i=0
for p in "$HOME/.openclaw/bin/openclaw" /opt/homebrew/bin/openclaw /usr/local/bin/openclaw "$HOME/.local/bin/openclaw" "$HOME/.npm-global/bin/openclaw"; do
  if [ -z "$prog" ] && [ -f "$p" ] && [ -x "$p" ]; then prog=$p; line program ",\"i\":$i"; fi
  i=$((i + 1))
done
run() {
  key=$1; shift
  out=$("$prog" "$@" </dev/null 2>/dev/null) && code=0 || code=$?
  line "$key" ",\"exit\":$code,\"v\":\"$(printf '%s' "$out" | b64 32768 || true)\""
}
if [ -n "$prog" ]; then
  run version --version
  run status-default gateway status --json
  if [ -d "$HOME/.openclaw-clawtrate" ]; then
    run status-clawtrate --profile clawtrate gateway status --json
  fi
fi
has() { if [ -e "$1" ]; then printf 1; else printf 0; fi; }
line signs ",\"state\":$(has "$HOME/.openclaw"),\"launchd\":$(has "$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"),\"systemd\":$(has "$HOME/.config/systemd/user/openclaw-gateway.service"),\"cstate\":$(has "$HOME/.openclaw-clawtrate"),\"claunchd\":$(has "$HOME/Library/LaunchAgents/ai.openclaw.clawtrate.plist"),\"csystemd\":$(has "$HOME/.config/systemd/user/openclaw-gateway-clawtrate.service")"
kill -TERM "$watchdog" 2>/dev/null || true
line end ",\"id\":\"$request_id\""
`;

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The script as sent: the one assignment the host writes, then the constant body. */
export function lookScript(requestId: string = randomUUID()): { requestId: string; text: string } {
  if (!REQUEST_ID.test(requestId)) throw new Error("Not a request id.");
  return { requestId, text: `request_id='${requestId}'\n${LOOK_SCRIPT_BODY}` };
}

export type Version = { year: number; month: number; day: number; build: string | null };

export type ServiceLabel = "LaunchAgent" | "systemd user" | "systemd" | "Scheduled Task" | "other";

export type GatewayStatus = {
  profile: "default" | "clawtrate";
  exit: number;
  service: {
    label: ServiceLabel;
    loaded: boolean | null;
    running: boolean | null;
    pid: number | null;
  } | null;
  configPath: string | null;
  port: number | null;
  bindMode: "loopback" | "lan" | "tailnet" | "auto" | "custom" | null;
  version: Version | null;
  rpcOk: boolean | null;
  /** The processes OpenClaw saw listening on the gateway's port. */
  listenerPids: number[];
};

export type LookFacts = {
  system: { os: string; machine: string; nodeName: string } | null;
  program: ProgramPlace | null;
  /** From `openclaw --version`; null when no program, "unreadable" when it answered something else. */
  version: Version | "unreadable" | null;
  gateways: Array<
    GatewayStatus | { profile: "default" | "clawtrate"; exit: number; unreadable: true }
  >;
  signs: {
    defaultState: boolean;
    defaultService: boolean;
    clawtrateState: boolean;
    clawtrateService: boolean;
  };
};

export type LookParse =
  | { ok: true; facts: LookFacts; noiseLines: number }
  | { ok: false; reason: "no-begin" | "no-end" | "malformed" | "too-large" };

export const MAX_LOOK_OUTPUT = 64 * 1024;
const MAX_DECODED = 32 * 1024;

const VERSION = /^OpenClaw (\d{4})\.(\d{1,2})\.(\d{1,3})( \(([0-9a-f]{7,12})\))?$/;
const GATEWAY_VERSION = /^(\d{4})\.(\d{1,2})\.(\d{1,3})$/;
const SYSTEM_WORD = /^[A-Za-z0-9_.-]{1,64}$/;
const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const CONFIG_PATH = /^(?:\/|~\/)[\p{L}\p{N} ._+@/-]{1,1024}$/u;

function decode(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const text = Buffer.from(value, "base64").toString("utf8");
  return text.length > MAX_DECODED ? null : text;
}

export function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text.trim());
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    build: match[5] ?? null,
  };
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const bool = (value: unknown) => (typeof value === "boolean" ? value : null);
const pid = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value < 2 ** 31
    ? value
    : null;

/** The facts the design reads from `gateway status --json`, each checked; the rest is dropped. */
export function parseGatewayStatus(
  profile: "default" | "clawtrate",
  exit: number,
  text: string,
): GatewayStatus | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const top = record(json);
  if (!top) return null;
  const service = record(top.service);
  const runtime = record(service?.runtime);
  const gateway = record(top.gateway);
  const daemon = record(record(top.config)?.daemon);
  const rpc = record(top.rpc);
  const portStatus = record(top.port);
  const label = typeof service?.label === "string" ? service.label : null;
  const port = gateway?.port;
  const bind = gateway?.bindMode;
  const version =
    typeof gateway?.version === "string" ? GATEWAY_VERSION.exec(gateway.version) : null;
  const path =
    typeof daemon?.path === "string" && CONFIG_PATH.test(daemon.path) ? daemon.path : null;
  const status = typeof runtime?.status === "string" ? runtime.status : null;
  return {
    profile,
    exit,
    service: service
      ? {
          label:
            label === "LaunchAgent" ||
            label === "systemd user" ||
            label === "systemd" ||
            label === "Scheduled Task"
              ? label
              : "other",
          loaded: bool(service.loaded),
          running: status === "running" ? true : status === "stopped" ? false : null,
          pid: pid(runtime?.pid),
        }
      : null,
    configPath: path,
    port:
      typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535
        ? port
        : null,
    bindMode:
      bind === "loopback" ||
      bind === "lan" ||
      bind === "tailnet" ||
      bind === "auto" ||
      bind === "custom"
        ? bind
        : null,
    version: version
      ? {
          year: Number(version[1]),
          month: Number(version[2]),
          day: Number(version[3]),
          build: null,
        }
      : null,
    rpcOk: bool(rpc?.ok),
    listenerPids: Array.isArray(portStatus?.listeners)
      ? portStatus.listeners
          .slice(0, 16)
          .map((listener) => pid(record(listener)?.pid))
          .filter((value): value is number => value !== null)
      : [],
  };
}

const flag = (value: unknown) => (value === 0 || value === 1 ? value === 1 : null);

/** The script's standard output, parsed in memory. */
export function parseLookOutput(stdout: string, requestId: string): LookParse {
  if (stdout.length > MAX_LOOK_OUTPUT) return { ok: false, reason: "too-large" };
  const lines = stdout.split("\n").map((line) => line.replace(/\r$/, ""));
  const begin = lines.findIndex((line) => line === `{"k":"begin","id":"${requestId}"}`);
  if (begin === -1) return { ok: false, reason: "no-begin" };
  const facts: LookFacts = {
    system: null,
    program: null,
    version: null,
    gateways: [],
    signs: {
      defaultState: false,
      defaultService: false,
      clawtrateState: false,
      clawtrateService: false,
    },
  };
  const seen = new Set<string>();
  const after = lines.slice(begin + 1);
  // What follows the last line break is not a line.
  if (after.at(-1) === "") after.pop();
  for (const line of after) {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return { ok: false, reason: "malformed" };
    }
    const fact = record(json);
    const key = fact?.k;
    if (!fact || typeof key !== "string" || seen.has(key))
      return { ok: false, reason: "malformed" };
    seen.add(key);
    switch (key) {
      case "end":
        if (fact.id !== requestId) return { ok: false, reason: "malformed" };
        return { ok: true, facts, noiseLines: begin };
      case "uname": {
        const [os, machine, nodeName] = [decode(fact.s), decode(fact.m), decode(fact.n)].map((v) =>
          v === null ? null : v.trim(),
        );
        facts.system =
          os &&
          machine &&
          nodeName &&
          SYSTEM_WORD.test(os) &&
          SYSTEM_WORD.test(machine) &&
          NODE_NAME.test(nodeName)
            ? { os, machine, nodeName }
            : null;
        break;
      }
      case "program": {
        const place = typeof fact.i === "number" ? PROGRAM_PLACES[fact.i] : undefined;
        if (!place) return { ok: false, reason: "malformed" };
        facts.program = place;
        break;
      }
      case "version": {
        const text = decode(fact.v);
        if (text === null || typeof fact.exit !== "number")
          return { ok: false, reason: "malformed" };
        facts.version = (fact.exit === 0 && parseVersion(text)) || "unreadable";
        break;
      }
      case "status-default":
      case "status-clawtrate": {
        const profile = key === "status-default" ? "default" : "clawtrate";
        const text = decode(fact.v);
        const exit = fact.exit;
        if (text === null || typeof exit !== "number" || !Number.isInteger(exit)) {
          return { ok: false, reason: "malformed" };
        }
        facts.gateways.push(
          parseGatewayStatus(profile, exit, text) ?? { profile, exit, unreadable: true },
        );
        break;
      }
      case "signs": {
        const values = ["state", "launchd", "systemd", "cstate", "claunchd", "csystemd"].map(
          (name) => flag(fact[name]),
        );
        if (values.some((value) => value === null)) return { ok: false, reason: "malformed" };
        const [state, launchd, systemd, cstate, claunchd, csystemd] = values as boolean[];
        facts.signs = {
          defaultState: state!,
          defaultService: launchd! || systemd!,
          clawtrateState: cstate!,
          clawtrateService: claunchd! || csystemd!,
        };
        break;
      }
      default:
        return { ok: false, reason: "malformed" };
    }
  }
  return { ok: false, reason: "no-end" };
}

/** What a repeated LOOK must name again for a route to be usable: the same gateway service on that port. */
export type GatewayService = {
  profile: "default" | "clawtrate";
  serviceLabel: ServiceLabel;
  configPath: string;
  port: number;
};

/** The gateway service a LOOK found on `port`, running and answering, or why not. */
export function serviceOnPort(
  facts: LookFacts,
  port: number,
):
  | { ok: true; service: GatewayService; holdsPort: boolean | null }
  | { ok: false; reason: "none" | "not-running" } {
  for (const gateway of facts.gateways) {
    if ("unreadable" in gateway || gateway.port !== port) continue;
    if (!gateway.service || !gateway.configPath) continue;
    if (gateway.rpcOk !== true || gateway.service.running === false)
      return { ok: false, reason: "not-running" };
    const servicePid = gateway.service.pid;
    return {
      ok: true,
      service: {
        profile: gateway.profile,
        serviceLabel: gateway.service.label,
        configPath: gateway.configPath,
        port,
      },
      holdsPort:
        servicePid === null || gateway.listenerPids.length === 0
          ? null
          : gateway.listenerPids.includes(servicePid),
    };
  }
  return { ok: false, reason: "none" };
}

export function sameService(a: GatewayService, b: GatewayService): boolean {
  return (
    a.profile === b.profile &&
    a.serviceLabel === b.serviceLabel &&
    a.configPath === b.configPath &&
    a.port === b.port
  );
}
