// The send gate with TLS off (docs/design/setup-effortless.md §3, "The send
// gate"): before anything is written to a loopback socket the host opened to
// OpenClaw's port, prove who holds its far end.
//
// (e) Every process holding the server end of exactly this connection is a
//     process of this account, and at least one is found.
// (f) One of them runs Node, has OpenClaw's own native module mapped (pinned by
//     SHA-256, in a package that is OpenClaw of the pinned version), holds this
//     profile's gateway lock and state database open, and is the process that
//     lock names, with this port, this state folder and its start time.
//
// On macOS the native helper reads the kernel's facts (libproc); on Linux they
// are read here from /proc. A missing helper, a timeout, denied access or
// malformed output all mean unverified. The answer is a fixed word: nothing
// about another process is passed on.

import { createHash } from "node:crypto";
import { open, readdir, readFile, readlink, stat, type FileHandle } from "node:fs/promises";
import { endianness } from "node:os";
import { join } from "node:path";
import { FS_SAFE_NATIVE_SHA256, PINNED_OPENCLAW_VERSION } from "./openclaw-pins.ts";
import {
  checkOpened,
  guardHome,
  holdHome,
  openFailure,
  openFlags,
  preflight,
  procHolds,
  readBounded,
  READ_DEADLINE_MS,
  runHelper,
  withDeadline,
  type Opened,
} from "./settings-reader.ts";

const LOCK_LIMIT = 16 * 1024;
const PACKAGE_LIMIT = 512 * 1024;
const HEADER_LIMIT = 160;

/** Why the helper or the /proc walk refused: each a fixed word, safe for a log. */
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
] as const;
/** And why the host refused what it was given. */
export const PROVE_REFUSALS = [
  ...FOUND_REFUSALS,
  "helper",
  "path",
  "pin",
  "package",
  "named",
  "platform",
] as const;
export type ProveRefusal = (typeof PROVE_REFUSALS)[number];
type Refused = { proved: false; why: ProveRefusal };
export type Proof = { proved: true } | Refused;

export type ProveOptions = {
  /** The home folder, as the settings reader takes it: the caller's, never defaulted. */
  home: string;
  /** The profile's folder under it, `.openclaw` or `.openclaw-<name>`. */
  folder: string;
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
  /** The holder's start: seconds on macOS, clock ticks since boot on Linux. */
  start: number;
  /** The module's package suffix, `darwin-arm64` or `linux-x64-gnu`. */
  suffix: string;
  sha256: string;
  lock: Buffer;
  pkg: Buffer;
};

/** Proves the far end of the connection from `localPort` to `port` on 127.0.0.1. */
export async function proveLocalGateway(options: ProveOptions): Promise<Proof> {
  const { home, folder, port, localPort, platform } = options;
  if (platform !== "darwin" && platform !== "linux") return no("platform");
  if (!usablePort(port) || !usablePort(localPort) || port === localPort) return no("path");
  if (!/^\.openclaw(-[a-z0-9][a-z0-9-]{0,63})?$/.test(folder)) return no("path");
  let checked;
  try {
    checked = guardHome(home, options.sandboxed);
  } catch {
    return no("path");
  }
  if (platform === "darwin" && !options.helper) return no("helper");
  const held = await holdHome(home, checked);
  if (!("handle" in held)) return no(fromOpened(held));
  const deadlineMs = options.deadlineMs ?? READ_DEADLINE_MS;
  try {
    const facts =
      platform === "darwin"
        ? await viaHelper(
            options.helper!,
            held.handle,
            checked ? "prove-private" : "prove",
            options,
            deadlineMs,
          )
        : await withDeadline<Facts | Refused>(
            viaProc(held.handle, folder, port, localPort),
            deadlineMs,
            no("failed"),
          );
    return "why" in facts ? facts : judge(facts, join(home, folder), port);
  } finally {
    await held.handle.close();
  }
}

/** The kernel's facts against the pins and the lock. */
function judge(facts: Facts, stateDir: string, port: number): Proof {
  if (FS_SAFE_NATIVE_SHA256[facts.suffix] !== facts.sha256) return no("pin");
  const pkg = parsed(facts.pkg);
  if (pkg?.name !== "openclaw" || pkg.version !== PINNED_OPENCLAW_VERSION) return no("package");
  const lock = parsed(facts.lock);
  const named =
    lock !== null &&
    lock.pid === facts.pid &&
    lock.role === "gateway" &&
    lock.port === port &&
    lock.stateDir === stateDir &&
    typeof lock.startTime === "number" &&
    // macOS records whole seconds, Linux the same clock ticks /proc gives.
    Math.abs(lock.startTime - facts.start) <= (facts.suffix.startsWith("darwin") ? 1 : 0);
  return named ? { proved: true } : no("named");
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

const HEADER = /^proved (\d{1,10}) (\d{1,12}) (arm64|x64) ([0-9a-f]{64}) (\d{1,6}) (\d{1,7})\n/;
const HELPER_REFUSAL = /^refused ([a-z]{1,16})\n$/;

/** macOS: the helper's facts, or why not. Anything but exactly one of its two forms is `helper`. */
async function viaHelper(
  helper: string,
  home: FileHandle,
  command: "prove" | "prove-private",
  options: ProveOptions,
  deadlineMs: number,
): Promise<Facts | Refused> {
  const limit = HEADER_LIMIT + LOCK_LIMIT + PACKAGE_LIMIT;
  const args = [command, options.folder, String(options.port), String(options.localPort)];
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
    output.length !== lockEnd + Number(pkgLength)
  )
    return no("helper");
  return {
    pid: Number(pid),
    start: Number(start),
    suffix: `darwin-${arch}`,
    sha256: sha256!,
    lock: output.subarray(body, lockEnd),
    pkg: output.subarray(lockEnd),
  };
}

/** 127.0.0.1:<port> as /proc/net/tcp and tcp6 print it on this machine. */
function procAddress(port: number): string[] {
  const four = endianness() === "LE" ? "0100007F" : "7F000001";
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  return [`${four}:${portHex}`, `0000000000000000FFFF0000${four}:${portHex}`];
}

/** Linux's `st_dev` from the major and minor numbers /proc/<pid>/maps prints. */
function makedev(major: bigint, minor: bigint): bigint {
  return (
    ((major & 0xfffff000n) << 32n) |
    ((major & 0xfffn) << 8n) |
    ((minor & 0xffffff00n) << 12n) |
    (minor & 0xffn)
  );
}

type Identity = { dev: bigint; ino: bigint };
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Linux: the same facts from /proc. The held home is reached through
 * /proc/self/fd, checked to be that same folder first, so a missing or
 * masked /proc reads nothing.
 */
async function viaProc(
  home: FileHandle,
  folder: string,
  port: number,
  localPort: number,
): Promise<Facts | Refused> {
  const refuse = no;
  const flags = openFlags();
  if (!flags || !(await procHolds(home))) return refuse("failed");
  const homePath = `/proc/self/fd/${home.fd}`;
  // The profile's lock and database, by the reader's rules, through held folders.
  const handles: FileHandle[] = [];
  const step = async (
    path: string,
    isFolder: boolean,
    limit = 0,
  ): Promise<FileHandle | ProveRefusal> => {
    const early = isFolder ? null : await preflight(path);
    if (early) return fromOpened(early);
    let handle: FileHandle;
    try {
      handle = await open(path, isFolder ? flags.folder : flags.file);
    } catch (error) {
      return fromOpened(await openFailure(error, path));
    }
    handles.push(handle);
    const wrong = await checkOpened(handle, isFolder, limit);
    return wrong ? fromOpened(wrong) : handle;
  };
  try {
    // In the helper's order, and with its words: a profile whose gateway isn't running has no
    // lock, and may have no database yet.
    const profile = await step(`${homePath}/${folder}`, true);
    if (typeof profile === "string") return refuse(profile);
    const missing = (why: ProveRefusal, as: ProveRefusal) => refuse(why === "absent" ? as : why);
    const stateFolder = await step(`/proc/self/fd/${profile.fd}/state`, true);
    if (typeof stateFolder === "string") return missing(stateFolder, "state");
    const tmp = await step(`/proc/self/fd/${profile.fd}/tmp`, true);
    if (typeof tmp === "string") return missing(tmp, "lock");
    const own = await step(`/proc/self/fd/${tmp.fd}/openclaw-${process.geteuid!()}`, true);
    if (typeof own === "string") return missing(own, "lock");
    const lockFile = await step(`/proc/self/fd/${own.fd}/gateway.state.lock`, false, LOCK_LIMIT);
    if (typeof lockFile === "string") return missing(lockFile, "lock");
    const database = await step(`/proc/self/fd/${stateFolder.fd}/openclaw.sqlite`, false);
    if (typeof database === "string") return missing(database, "state");
    const lockRead = await readBounded(lockFile);
    if (lockRead.kind !== "read") return refuse("large");
    const lockId = await lockFile.stat({ bigint: true });
    const databaseId = await database.stat({ bigint: true });
    // (e), repeated for up to 1.5 s while the accepted connection reaches its holder's table.
    let holders: number[] = [];
    const until = Date.now() + 1_500;
    for (let first = true; holders.length === 0 && (first || Date.now() < until); first = false) {
      if (!first) await sleep(25);
      const found = await procHolders(port, localPort);
      if (typeof found === "string") return refuse(found);
      holders = found;
    }
    if (holders.length === 0) return refuse("holder");
    let first: ProveRefusal | null = null;
    for (const pid of holders) {
      const facts = await procGateway(pid, lockId, databaseId, lockRead.bytes);
      if (!("why" in facts)) return facts;
      first ??= facts.why;
    }
    return refuse(first ?? "node");
  } finally {
    for (const handle of handles.reverse()) await handle.close().catch(() => {});
  }
}

/** (e) on Linux: the holders of the connection's server end, all this account's; or why not. */
async function procHolders(port: number, localPort: number): Promise<number[] | ProveRefusal> {
  const local = procAddress(port);
  const remote = procAddress(localPort);
  const inodes = new Set<string>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = await readFile(table, "latin1").catch(() => (table.endsWith("6") ? "" : null));
    if (text === null) return "failed";
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length > 9 && local.includes(fields[1]!) && remote.includes(fields[2]!))
        inodes.add(fields[9]!);
    }
  }
  if (inodes.size === 0) return [];
  const uid = process.geteuid!();
  const holders: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let links: string[];
    try {
      links = await readdir(`/proc/${entry}/fd`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Another account's descriptors are hidden; one of this account's that can't be read isn't.
      if (code === "ENOENT" || code === "ESRCH") continue;
      const owner = await stat(`/proc/${entry}`).then(
        (s) => s.uid,
        () => null,
      );
      if (owner === uid) return "denied";
      continue;
    }
    let holds = false;
    for (const fd of links) {
      const target = await readlink(`/proc/${entry}/fd/${fd}`).catch(() => "");
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      if (inode && inodes.has(inode)) holds = true;
    }
    if (!holds) continue;
    const status = await readFile(`/proc/${entry}/status`, "latin1").catch(() => "");
    const ids = /^Uid:\s+(\d+)\s+(\d+)/m.exec(status);
    if (!ids || Number(ids[1]) !== uid || Number(ids[2]) !== uid) return "account";
    holders.push(Number(entry));
  }
  return holders;
}

const LINUX_MODULE =
  /^(\/.+)\/node_modules\/@openclaw\/fs-safe-(linux-(?:x64|arm64)-(?:gnu|musl))\/fs-safe-native\.node$/;

/** (f) on Linux for one holder: its facts, or why not. */
async function procGateway(
  pid: number,
  lock: Identity,
  database: Identity,
  lockBytes: Buffer,
): Promise<Facts | Refused> {
  const refuse = no;
  const exe = await readlink(`/proc/${pid}/exe`).catch(() => "");
  if (!exe.endsWith("/node")) return refuse("node");
  // The kernel's own link to the program, so this one open follows it.
  const magic = await readHead(`/proc/${pid}/exe`, 4, true);
  if (!magic?.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return refuse("node");
  const maps = await readFile(`/proc/${pid}/maps`, "latin1").catch(() => "");
  let module: { root: string; suffix: string; path: string; id: Identity } | null = null;
  for (const line of maps.split("\n")) {
    const fields = /^\S+ \S+ \S+ ([0-9a-f]+):([0-9a-f]+) (\d+)\s+(\/.*)$/.exec(line);
    const match = fields && LINUX_MODULE.exec(fields[4]!);
    if (!fields || !match) continue;
    const id = {
      dev: makedev(BigInt(`0x${fields[1]}`), BigInt(`0x${fields[2]}`)),
      ino: BigInt(fields[3]!),
    };
    module = { root: match[1]!, suffix: match[2]!, path: fields[4]!, id };
    break;
  }
  if (!module) return refuse("module");
  const flags = openFlags()!;
  let sha256: string;
  try {
    const handle = await open(module.path, flags.file);
    try {
      const id = await handle.stat({ bigint: true });
      if (!id.isFile() || !same(id, module.id)) return refuse("module");
      const hash = createHash("sha256");
      let total = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        total += (chunk as Buffer).length;
        if (total > 64 * 1024 * 1024) return refuse("large");
        hash.update(chunk as Buffer);
      }
      sha256 = hash.digest("hex");
    } finally {
      await handle.close();
    }
  } catch {
    return refuse("module");
  }
  let holdsLock = false;
  let holdsDatabase = false;
  for (const fd of await readdir(`/proc/${pid}/fd`).catch(() => [])) {
    const id = await stat(`/proc/${pid}/fd/${fd}`, { bigint: true }).catch(() => null);
    if (id && same(id, lock)) holdsLock = true;
    if (id && same(id, database)) holdsDatabase = true;
  }
  if (!holdsLock) return refuse("lock");
  if (!holdsDatabase) return refuse("state");
  const statLine = await readFile(`/proc/${pid}/stat`, "latin1").catch(() => "");
  const start = Number(
    statLine
      .slice(statLine.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/)[19],
  );
  if (!Number.isSafeInteger(start)) return refuse("failed");
  const pkg = await readHead(`${module.root}/package.json`, PACKAGE_LIMIT + 1);
  if (!pkg || pkg.length > PACKAGE_LIMIT) return refuse("module");
  return { pid, start, suffix: module.suffix, sha256, lock: lockBytes, pkg };
}

/** At most `limit` bytes of a regular file, opened without following its last link unless told. */
async function readHead(path: string, limit: number, follow = false): Promise<Buffer | null> {
  try {
    const handle = await open(path, follow ? "r" : openFlags()!.file);
    try {
      if (!(await handle.stat()).isFile()) return null;
      const buffer = Buffer.alloc(limit);
      const { bytesRead } = await handle.read(buffer, 0, limit, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
