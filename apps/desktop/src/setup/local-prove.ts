// The send gate with TLS off (docs/design/setup-effortless.md §3, "The send
// gate"): before anything is written to a loopback socket the host opened to
// OpenClaw's port, check who holds its far end, and that it matches this
// account's OpenClaw profile. It doesn't establish which program is running;
// what it defends against, and what it doesn't, is docs/decisions.md, "Local
// connect's proof".
//
// First, the profile folder at its path is the one the settings were read from, by device and
// inode (`FolderIdentity`): a folder put in its place since is refused ("replaced") before any
// process is looked at.
// (e) Every process holding the server end of exactly this connection is a
//     process of this account, and at least one is found.
// (f) One of them, the same process from the scan to the end of the check,
//     holds this profile's gateway lock and state database open, and is the
//     process that lock names, with role gateway, this port, this state folder
//     and its start time.
// (g) That lock names, as the settings file its gateway loaded, the profile's
//     own `openclaw.json`: the file the reader read the port, the token and TLS
//     from. A gateway started on another file (OpenClaw's `OPENCLAW_CONFIG_PATH`)
//     may listen otherwise than the file the reader read says ("config").
// And the pin, a consistency check that authenticates nothing: where that
// holder maps a file laid out as OpenClaw's native module in a package whose
// package.json names a version pinned in openclaw-pins.ts, the module must be
// that version's own, by SHA-256. Every other holder (a newer OpenClaw, an
// install laid out otherwise, no module mapped) skips only that comparison:
// the folder's identity, (e), (f) and the settings file the lock names still
// apply to it.
//
// On macOS the native helper reads the kernel's facts (libproc). Linux's walk
// through /proc is setup PR 2a-3's, so nothing is proved there yet. A missing
// helper, a timeout, denied access or malformed output all mean unverified.
// The answer is a fixed word: nothing about another process is passed on.

import type { ProofRefusalKind } from "@clawtrate/core";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { OPENCLAW_PINS } from "./openclaw-pins.ts";
import {
  guardHome,
  holdHome,
  READ_DEADLINE_MS,
  runHelper,
  SETTINGS_FILE,
  type FolderIdentity,
  type Opened,
} from "./settings-reader.ts";

export type { FolderIdentity };
/** A folder identity as the reader writes it: device and inode, in plain decimal. */
export const FOLDER_IDENTITY = /^(0|[1-9]\d{0,19}):(0|[1-9]\d{0,19})$/;

const LOCK_LIMIT = 16 * 1024;
const PACKAGE_LIMIT = 512 * 1024;
const HEADER_LIMIT = 160;

/** Why the helper refused: each a fixed word, safe for a log. */
const FOUND_REFUSALS = [
  "absent",
  "link",
  "type",
  "owner",
  "mode",
  "links",
  "acl",
  "large",
  "denied",
  "failed",
  "holder",
  "account",
  "node",
  "module",
  "lock",
  "state",
  "replaced",
] as const;
/** And why the host refused what it was given. */
export const PROVE_REFUSALS = [
  ...FOUND_REFUSALS,
  "helper",
  "path",
  "pin",
  "package",
  "named",
  "config",
  "platform",
] as const;
export type ProveRefusal = (typeof PROVE_REFUSALS)[number];
type Refused = { proved: false; why: ProveRefusal };

/** What a refusal means for the person (`PROOF_REFUSAL_LINES`). */
export function refusalKind(why: ProveRefusal): ProofRefusalKind {
  if (why === "holder" || why === "account") return "holder";
  if (["node", "module", "lock", "state", "named"].includes(why)) return "not-gateway";
  if (why === "pin" || why === "package") return "not-published";
  if (["denied", "failed", "helper", "path", "platform"].includes(why)) return "unchecked";
  if (why === "replaced") return "replaced";
  if (why === "config") return "other-settings";
  return "folder";
}
export type Proof = { proved: true } | Refused;

export type ProveOptions = {
  /** The home folder, as the settings reader takes it: the caller's, never defaulted. */
  home: string;
  /** The profile's folder under it, `.openclaw` or `.openclaw-<name>`. */
  folder: string;
  /** That folder's identity as the settings were read from it: another folder there is refused. */
  identity: FolderIdentity;
  /** The gateway's port, and this end's port of the connection to prove. */
  port: number;
  localPort: number;
  platform: NodeJS.Platform;
  /** The native helper on macOS. */
  helper: string | null;
  /** Whether this run must be sandboxed (`mustSandbox`): the home rule of the reader. */
  sandboxed: boolean;
  deadlineMs?: number;
};

const no = (why: ProveRefusal): Refused => ({ proved: false, why });

/** A refusal of the reader's rules, as one of these words. */
function fromOpened(opened: Opened): ProveRefusal {
  if (opened.kind !== "refused" || opened.reason === "absent") return "absent";
  if (opened.reason === "unreadable") return "large";
  return FOUND_REFUSALS.find((word) => word === opened.why) ?? "failed";
}
const usablePort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535;

/** What the kernel says about the holder: checked here against the lock and the pins. */
type Facts = {
  pid: number;
  /** The holder's start, in seconds. */
  start: number;
  /**
   * OpenClaw's native module, when the holder maps one: its package suffix (`darwin-arm64`
   * or `darwin-x64`) and SHA-256, null when its file wasn't the mapped one or couldn't be read.
   */
  module: { suffix: string; sha256: string | null } | null;
  lock: Buffer;
  /** The package.json of the package the module belongs to; empty without one. */
  pkg: Buffer;
};

/** Proves the far end of the connection from `localPort` to `port` on 127.0.0.1. */
export async function proveLocalGateway(options: ProveOptions): Promise<Proof> {
  const { home, folder, port, localPort, platform } = options;
  if (platform !== "darwin") return no("platform");
  if (!usablePort(port) || !usablePort(localPort) || port === localPort) return no("path");
  if (!/^\.openclaw(-[a-z0-9][a-z0-9-]{0,63})?$/.test(folder)) return no("path");
  const identity = FOLDER_IDENTITY.exec(options.identity);
  if (!identity) return no("path");
  let checked;
  try {
    checked = guardHome(home, options.sandboxed);
  } catch {
    return no("path");
  }
  if (!options.helper) return no("helper");
  const held = await holdHome(home, checked);
  if (!("handle" in held)) return no(fromOpened(held));
  try {
    // A sandboxed run's home must be private, as the reader's is.
    const command = checked ? "prove-private" : "prove";
    const facts = await viaHelper(options.helper, held.handle, command, options, [
      identity[1]!,
      identity[2]!,
    ]);
    return "why" in facts ? facts : judge(facts, join(home, folder), port);
  } finally {
    await held.handle.close();
  }
}

/** The kernel's facts against the pins, where there are pins, and the lock. */
function judge(facts: Facts, stateDir: string, port: number): Proof {
  if (facts.module) {
    const pkg = parsed(facts.pkg);
    const version = pkg?.name === "openclaw" && typeof pkg.version === "string" ? pkg.version : "";
    const pins = Object.hasOwn(OPENCLAW_PINS, version) ? OPENCLAW_PINS[version]! : null;
    if (pins && pins[facts.module.suffix] !== facts.module.sha256) return no("pin");
  }
  const lock = parsed(facts.lock);
  const named =
    lock !== null &&
    lock.pid === facts.pid &&
    lock.role === "gateway" &&
    lock.port === port &&
    lock.stateDir === stateDir &&
    typeof lock.startTime === "number" &&
    // OpenClaw records the kernel's start time in whole seconds.
    Math.abs(lock.startTime - facts.start) <= 1 &&
    // Both pinned versions write the settings file the gateway loaded into its lock.
    typeof lock.configPath === "string";
  if (!named) return no("named");
  // The settings the reader read are the ones this gateway loaded, or nothing they say about
  // its port, its token or TLS is known to hold for it.
  return lock.configPath === join(stateDir, SETTINGS_FILE) ? { proved: true } : no("config");
}

function parsed(bytes: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const HEADER =
  /^proved (\d{1,10}) (\d{1,12}) (arm64|x64|none) ([0-9a-f]{64}|-) (\d{1,6}) (\d{1,7})\n/;
const HELPER_REFUSAL = /^refused ([a-z]{1,16})\n$/;

/** The helper's facts, or why not. Anything but exactly one of its two forms is `helper`. */
async function viaHelper(
  helper: string,
  home: FileHandle,
  command: "prove" | "prove-private",
  options: ProveOptions,
  identity: [dev: string, ino: string],
): Promise<Facts | Refused> {
  const limit = HEADER_LIMIT + LOCK_LIMIT + PACKAGE_LIMIT;
  const args = [
    command,
    options.folder,
    String(options.port),
    String(options.localPort),
    ...identity,
  ];
  const deadlineMs = options.deadlineMs ?? READ_DEADLINE_MS;
  const output = await runHelper(helper, home, args, limit, deadlineMs);
  if (!output) return no("helper");
  const text = output.subarray(0, HEADER_LIMIT).toString("latin1");
  const refusal = output.length <= 32 ? HELPER_REFUSAL.exec(output.toString("latin1"))?.[1] : null;
  if (refusal) return no(FOUND_REFUSALS.find((word) => word === refusal) ?? "helper");
  const header = HEADER.exec(text);
  if (!header) return no("helper");
  const [line, pid, start, arch, sha256, lockLength, pkgLength] = header;
  const body = line!.length;
  const lockEnd = body + Number(lockLength);
  if (
    Number(lockLength) > LOCK_LIMIT ||
    Number(pkgLength) > PACKAGE_LIMIT ||
    output.length !== lockEnd + Number(pkgLength) ||
    // No module: no hash and no package.
    (arch === "none" && (sha256 !== "-" || Number(pkgLength) !== 0))
  )
    return no("helper");
  return {
    pid: Number(pid),
    start: Number(start),
    module:
      arch === "none"
        ? null
        : { suffix: `darwin-${arch}`, sha256: sha256 === "-" ? null : sha256! },
    lock: output.subarray(body, lockEnd),
    pkg: output.subarray(lockEnd),
  };
}
