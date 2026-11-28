// The bounded settings reader (docs/design/setup-effortless.md §3, "The
// settings reader"). It reads OpenClaw's own `openclaw.json` for the default
// and `clawtrate` profiles under a home folder its caller names, and runs no
// OpenClaw code. The home folder is opened without following a link, checked
// and held; every step below it is taken from a held folder. On macOS the
// native helper (packaging/mac/local-gateway.c) takes that held home as fd 3;
// on Linux the same walk is done here through /proc/self/fd. Windows has no
// local proof, so nothing is read there. The text is parsed in a worker with
// resource limits and a deadline, and the token found is held for one attempt
// only (`HeldToken`).
//
// Nothing in a shipped host reads settings yet. Local connect's proof
// (local-prove.ts), behind a host option that is off, holds the home and runs
// the helper as the reader does.

import { spawn } from "node:child_process";
import { constants, lstatSync, realpathSync } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import {
  REFUSALS,
  literalTokenRefusal,
  usablePort,
  type Extracted,
  type SettingsProfile,
} from "./settings-extract.ts";
import {
  ancestorsBelow,
  privateFolder,
  protectedAncestor,
  systemTempRoots,
  within,
} from "./sandbox.ts";
import { accountHome, packagedApp, personsLaunch, SetupRefusedError } from "./world.ts";

export const SETTINGS_LIMIT = 1024 * 1024;
/** The helper's deadline, and the parse worker's. */
export const READ_DEADLINE_MS = 2_000;
const WORKER_LIMITS = { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 };
/** All the helper may write: "ok <device> <inode>\n" and at most the limit, or one refusal line. */
const HELPER_OUTPUT_LIMIT = SETTINGS_LIMIT + 45;

/** The two canonical profiles, by their folder under the home folder. */
export const SETTINGS_PROFILES = [
  { profile: "default", folder: ".openclaw" },
  { profile: "clawtrate", folder: ".openclaw-clawtrate" },
] as const;
/** The profile's settings file, in its folder: the one file the reader reads. */
export const SETTINGS_FILE = "openclaw.json";

const UNSAFE_WHY = [
  "link",
  "type",
  "owner",
  "mode",
  "links",
  "acl",
  "denied",
  "failed",
  "helper",
  "path",
  "changed",
] as const;

/** Why the file wasn't read: each a fixed word, safe for a log. */
export type OpenRefusal =
  | { reason: "absent" }
  | { reason: "unsafe"; why: (typeof UNSAFE_WHY)[number] }
  | { reason: "unreadable"; why: "large" };

/**
 * The profile folder a file was read from, by its device and inode as decimal, "<dev>:<ino>":
 * the folder as it was opened for the read. The proof is given it and refuses a profile folder
 * at that path with another identity (local-prove.ts), and a gateway saved through local
 * connect keeps it with its route.
 */
export type FolderIdentity = string;

type Refusal = { kind: "refused" } & OpenRefusal;
export type Opened = { kind: "read"; bytes: Buffer; identity: FolderIdentity } | Refusal;

/**
 * A token from the settings file, held for one bounded attempt. The value is
 * a private field, so printing, inspecting or serializing the holder never
 * shows it.
 */
export class HeldToken {
  #value: string | null;
  constructor(value: string) {
    this.#value = value;
  }
  /** The token, until it is dropped. */
  reveal(): string {
    if (this.#value === null) throw new Error("This token was dropped.");
    return this.#value;
  }
  drop(): void {
    this.#value = null;
  }
}

/** What the parse worker answered; `worker` for a crash, a limit, the deadline or a bad answer. */
export type Parsed = Extracted | { kind: "refused"; reason: "unreadable"; why: "worker" | "large" };

export type SettingsOutcome =
  | { kind: "found"; token: HeldToken; port: number; identity: FolderIdentity }
  | ({ kind: "refused" } & OpenRefusal)
  | Exclude<Parsed, { kind: "found" }>;

export type ReaderOptions = {
  /** The home folder to look under. Always the caller's: never defaulted here. */
  home: string;
  platform: NodeJS.Platform;
  /** The native helper on macOS; null where the host has none. */
  helper: string | null;
  /**
   * Whether this run must be sandboxed (`mustSandbox`). Only an explicit
   * `false`, in a run with no sandbox marker, may read a home outside the
   * system's temporary roots.
   */
  sandboxed: boolean;
  /** The parse worker's module (settings-parse.ts, or its bundled copy). */
  worker: URL;
  deadlineMs?: number;
};

const refused = (why: (typeof UNSAFE_WHY)[number]): Refusal => ({
  kind: "refused",
  reason: "unsafe",
  why,
});

/** One path component: not empty, no separator or NUL, not "." or "..". */
const component = (name: string) =>
  name.length > 0 && name.length <= 255 && !/[/\0]/.test(name) && name !== "." && name !== "..";

/** The checked home folder, by device and inode, so that the one opened is the one checked. */
export type HomeIdentity = { dev: bigint; ino: bigint };

/**
 * The same folder, by its exact device and inode. Both are read as bigints
 * (`{ bigint: true }`, as `private-update-directory.ts` does): a 64-bit inode
 * can't always be held exactly by a JavaScript number.
 */
export const sameFolder = (a: HomeIdentity, b: HomeIdentity) => a.dev === b.dev && a.ino === b.ino;

/**
 * Which home may be read, decided before anything in it is opened. A
 * production run (the caller says so, no sandbox marker is present, and this
 * process is a packaged app's: `packagedApp`) reads only the home the
 * operating system reports for this account, and nothing when that can't be
 * determined. A caller that says production anywhere else (a development
 * build, a test, a Node host) is refused outright: outside a person's
 * packaged app there is no default home. Any other run reads only a private
 * folder of this account's, by its canonical path, below one of this
 * machine's temporary roots with no folder on the way that another account
 * could swap, and away from the account's real home; its identity is
 * returned so the folder opened can be held to it.
 */
export function guardHome(
  home: string,
  sandboxed: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
  accountHomeOf: () => string | null = accountHome,
  packaged: () => boolean = packagedApp,
  argv: readonly string[] = process.argv,
): HomeIdentity | null {
  const real = accountHomeOf();
  // A marker variable, or a switch that marks a driven app, makes a run sandboxed whatever
  // its caller says; a production run outside a packaged app is refused (`personsLaunch`).
  if (sandboxed === false && personsLaunch(env, argv, () => true)) {
    if (!packaged() || real === null || home !== resolve(real)) throw new SetupRefusedError("home");
    return null;
  }
  const uid = process.geteuid?.() ?? null;
  const orNull = <T>(read: () => T): T | null => {
    try {
      return read();
    } catch {
      return null;
    }
  };
  const canonical = orNull(() => realpathSync(home));
  const entry = orNull(() => lstatSync(home, { bigint: true }));
  const realHome = real === null ? null : orNull(() => realpathSync(real));
  const root = systemTempRoots(process.platform).find(
    (temp) =>
      orNull(() => realpathSync(temp.canonical)) === temp.canonical && within(home, temp.canonical),
  );
  if (
    canonical !== home ||
    root === undefined ||
    real === null ||
    realHome === null ||
    within(home, realHome) ||
    within(realHome, home) ||
    within(home, real) ||
    !ancestorsBelow(root.canonical, home).every((folder) =>
      protectedAncestor(
        orNull(() => lstatSync(folder)),
        uid,
      ),
    ) ||
    !privateFolder(
      entry && {
        isDirectory: () => entry.isDirectory(),
        isFile: () => entry.isFile(),
        uid: Number(entry.uid),
        mode: Number(entry.mode),
        nlink: Number(entry.nlink),
      },
      uid,
    )
  )
    throw new SetupRefusedError("home");
  return { dev: entry!.dev, ino: entry!.ino };
}

/** Each canonical profile's outcome: the default always, `clawtrate` only when its folder exists. */
export async function readLocalSettings(
  options: ReaderOptions,
): Promise<{ profile: SettingsProfile; outcome: SettingsOutcome }[]> {
  const results = [];
  for (const { profile, folder } of SETTINGS_PROFILES) {
    const outcome = await readProfile(options, profile, folder);
    const absent = outcome.kind === "refused" && outcome.reason === "absent";
    if (profile === "default" || !absent) results.push({ profile, outcome });
  }
  return results;
}

/** The CLI's profile-name rule and the canonical suffix it uses for a named profile. */
const NAMED_PROFILE_FOLDER = /^\.openclaw-([a-z0-9][a-z0-9_-]{0,63})$/i;
const PROFILE_SCAN_LIMIT = 2_048;

/** Detect other profiles by metadata only. Never read their settings or probe their ports. */
export async function findOtherLocalProfile(
  options: Pick<ReaderOptions, "home" | "sandboxed">,
): Promise<{ profile: string | null; complete: boolean }> {
  const { home, sandboxed } = options;
  const incomplete = { profile: null, complete: false };
  const checked = guardHome(home, sandboxed);
  const held = await holdHome(home, checked);
  if (!("handle" in held)) return incomplete;
  try {
    const homeIdentity = await held.handle.stat({ bigint: true });
    const dir = await opendir(home);
    try {
      const currentHome = await lstat(home, { bigint: true });
      if (!currentHome.isDirectory() || !sameFolder(homeIdentity, currentHome)) return incomplete;
      for (let index = 0; index < PROFILE_SCAN_LIMIT; index += 1) {
        const entry = await dir.read();
        if (!entry) return { profile: null, complete: true };
        const name = NAMED_PROFILE_FOLDER.exec(entry.name)?.[1];
        if (
          !name ||
          name.toLowerCase() === "default" ||
          name === "clawtrate" ||
          !entry.isDirectory()
        )
          continue;

        const path = join(home, entry.name);
        const folder = await lstat(path);
        if (
          !folder.isDirectory() ||
          folder.uid !== process.geteuid?.() ||
          (folder.mode & 0o022) !== 0
        )
          continue;
        const settings = await lstat(join(path, SETTINGS_FILE)).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
            throw error;
          },
        );
        if (settings?.isFile() && settings.uid === folder.uid)
          return { profile: name, complete: true };
      }
      return incomplete;
    } finally {
      await dir.close();
    }
  } catch {
    return incomplete;
  } finally {
    await held.handle.close();
  }
}

async function readProfile(
  options: ReaderOptions,
  profile: SettingsProfile,
  folder: string,
): Promise<SettingsOutcome> {
  const opened = await openSettingsFile({ ...options, folder, file: SETTINGS_FILE });
  if (opened.kind === "refused") return opened;
  const text = opened.bytes.toString("utf8");
  opened.bytes.fill(0);
  const parsed = await parseInWorker(text, profile, options.worker, options.deadlineMs);
  if (parsed.kind !== "found") return parsed;
  return {
    kind: "found",
    token: new HeldToken(parsed.token),
    port: parsed.port,
    identity: opened.identity,
  };
}

/** The open flags every step needs; a platform without one of them reads nothing. */
function openFlags() {
  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK, O_NOCTTY } = constants;
  if ([O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK, O_NOCTTY].some((flag) => typeof flag !== "number"))
    return null;
  return {
    folder: O_RDONLY | O_DIRECTORY! | O_NOFOLLOW!,
    file: O_RDONLY | O_NOFOLLOW! | O_NONBLOCK! | O_NOCTTY!,
  };
}

/** Opens `<home>/<folder>/<file>` by the reader's rules, on this platform. */
export async function openSettingsFile(options: {
  home: string;
  folder: string;
  file: string;
  platform: NodeJS.Platform;
  helper: string | null;
  sandboxed: boolean;
  deadlineMs?: number;
}): Promise<Opened> {
  const { home, folder, file, platform } = options;
  // No local proof on any other system: nothing is looked up, resolved or opened there.
  if (platform !== "darwin" && platform !== "linux") return refused("helper");
  if (!isAbsolute(home) || normalize(home) !== home || !component(folder) || !component(file))
    return refused("path");
  const checked = guardHome(home, options.sandboxed);
  if (platform === "darwin" && !options.helper) return refused("helper");
  const held = await holdHome(home, checked);
  if (!("handle" in held)) return held;
  try {
    return platform === "darwin"
      ? await readWithHelper(
          options.helper!,
          held.handle,
          // A sandboxed run's home must be private, ACL included; a production one keeps the
          // ordinary home rule.
          [checked ? "read-private" : "read", folder, file],
          options.deadlineMs,
        )
      : await readThroughProc(held.handle, folder, file);
  } finally {
    await held.handle.close();
  }
}

/**
 * The home folder, opened without following a link and checked on what was
 * opened: a folder of this account's that neither its group nor others may
 * write to. When the guard checked a sandboxed home, the folder opened must
 * be that same folder, by device and inode, and still private: a folder put
 * in its place between the check and the open is refused. A path ending in a
 * separator is refused, since an open would follow a link before it.
 */
export async function holdHome(
  home: string,
  checked: HomeIdentity | null,
): Promise<{ handle: FileHandle } | Opened> {
  const flags = openFlags();
  if (!flags) return refused("failed");
  if (home.length > 1 && home.endsWith("/")) return refused("path");
  let handle: FileHandle;
  try {
    handle = await open(home, flags.folder);
  } catch (error) {
    return await openFailure(error, home);
  }
  try {
    const stat = await handle.stat({ bigint: true });
    const mode = Number(stat.mode);
    const why = !stat.isDirectory()
      ? "type"
      : Number(stat.uid) !== process.geteuid?.()
        ? "owner"
        : (mode & 0o022) !== 0
          ? "mode"
          : checked && !sameFolder(checked, stat)
            ? "changed"
            : checked && (mode & 0o077) !== 0
              ? "mode"
              : null;
    if (why === null) return { handle };
    await handle.close();
    return refused(why);
  } catch {
    await handle.close();
    return refused("failed");
  }
}

/** The helper's answer, or `helper` for any failure of `runHelper` or output of another form. */
async function readWithHelper(
  helper: string,
  home: FileHandle,
  args: string[],
  deadlineMs = READ_DEADLINE_MS,
): Promise<Opened> {
  const output = await runHelper(helper, home, args, HELPER_OUTPUT_LIMIT, deadlineMs);
  if (!output) return refused("helper");
  try {
    return helperAnswer(output);
  } finally {
    output.fill(0);
  }
}

/**
 * Runs the native helper with the held home as fd 3, a fixed environment and
 * no input: its whole output, or null for a missing helper, a timeout, a
 * failed exit, or more than `limit` bytes.
 */
export function runHelper(
  helper: string,
  home: FileHandle,
  args: string[],
  limit: number,
  deadlineMs = READ_DEADLINE_MS,
): Promise<Buffer | null> {
  return new Promise<Buffer | null>((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const settle = (result: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const chunk of chunks) chunk.fill(0);
      child?.kill("SIGKILL");
      child?.stdout?.destroy();
      done(result);
    };
    // Its own deadline: a descendant holding the pipe open can't delay the answer.
    const timer = setTimeout(() => settle(null), deadlineMs);
    try {
      child = spawn(helper, args, {
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "ignore", home.fd],
      });
    } catch {
      settle(null);
      return;
    }
    child.stdout!.on("data", (data: Buffer) => {
      size += data.length;
      chunks.push(data);
      if (size > limit) settle(null);
    });
    child.on("error", () => settle(null));
    child.once("close", (code, signal) => {
      if (settled) return;
      settle(code === 0 && signal === null ? Buffer.concat(chunks) : null);
    });
  });
}

const HELPER_REFUSAL = /^refused ([a-z]{1,16})\n$/;

const HELPER_READ = /^ok (0|[1-9]\d{0,19}) (0|[1-9]\d{0,19})\n/;

/**
 * "ok", the profile folder's device and inode, and the file, or exactly one whitelisted
 * refusal line; anything else is unverified.
 */
function helperAnswer(output: Buffer): Opened {
  const read = HELPER_READ.exec(output.subarray(0, 45).toString("latin1"));
  if (read)
    return output.length - read[0].length <= SETTINGS_LIMIT
      ? {
          kind: "read",
          bytes: Buffer.from(output.subarray(read[0].length)),
          identity: `${read[1]}:${read[2]}`,
        }
      : refused("helper");
  const why = output.length <= 32 ? HELPER_REFUSAL.exec(output.toString("latin1"))?.[1] : null;
  if (why === "absent") return { kind: "refused", reason: "absent" };
  if (why === "large") return { kind: "refused", reason: "unreadable", why };
  const unsafe = UNSAFE_WHY.find(
    (word) => word === why && word !== "helper" && word !== "path" && word !== "changed",
  );
  return refused(unsafe ?? "helper");
}

/** Why an open failed. A link opened as a folder fails as "not a folder", so it is told apart. */
async function openFailure(error: unknown, path: string): Promise<Opened> {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return { kind: "refused", reason: "absent" };
  if (code === "ELOOP") return refused("link");
  if (code === "ENOTDIR") {
    const link = await lstat(path).then(
      (stat) => stat.isSymbolicLink(),
      () => false,
    );
    return refused(link ? "link" : "type");
  }
  if (code === "EACCES" || code === "EPERM") return refused("denied");
  return refused("failed");
}

/**
 * The checks on what was opened, as the helper makes them. On Linux a POSIX
 * ACL's entries are bounded by its mask, which is the mode's group bits, so a
 * file of exactly 0600 in a folder without group or other bits grants nothing
 * to another account.
 */
export async function checkOpened(handle: FileHandle, folder: boolean): Promise<Refusal | null> {
  const stat = await handle.stat();
  if (folder ? !stat.isDirectory() : !stat.isFile()) return refused("type");
  if (stat.uid !== process.geteuid?.()) return refused("owner");
  if (folder ? (stat.mode & 0o077) !== 0 : (stat.mode & 0o7777) !== 0o600) return refused("mode");
  if (!folder && stat.nlink !== 1) return refused("links");
  if (!folder && stat.size > SETTINGS_LIMIT)
    return { kind: "refused", reason: "unreadable", why: "large" };
  return null;
}

/** Reads to the end, refusing more than the limit however large the file was when checked. */
export async function readBounded(
  handle: FileHandle,
): Promise<{ kind: "read"; bytes: Buffer } | Refusal> {
  const buffer = Buffer.alloc(SETTINGS_LIMIT + 1);
  try {
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > SETTINGS_LIMIT) return { kind: "refused", reason: "unreadable", why: "large" };
    }
    return { kind: "read", bytes: Buffer.from(buffer.subarray(0, length)) };
  } finally {
    buffer.fill(0);
  }
}

/** Refuses a link, a device or a FIFO by its no-follow stat, before anything opens it. */
export async function preflight(path: string): Promise<Opened | null> {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    return await openFailure(error, path);
  }
  if (entry.isSymbolicLink()) return refused("link");
  return entry.isFile() ? null : refused("type");
}

/**
 * Linux: the profile folder is opened through /proc/self/fd/<home>, which
 * resolves to the held home, and the file through the held profile folder,
 * each without following a link. A no-follow stat refuses a link, a device or
 * a FIFO before the file is opened, and the checks run again on what was.
 */
async function readThroughProc(home: FileHandle, folder: string, file: string): Promise<Opened> {
  const flags = openFlags();
  if (!flags) return refused("failed");
  let dir: FileHandle | null = null;
  let handle: FileHandle | null = null;
  try {
    const folderPath = `/proc/self/fd/${home.fd}/${folder}`;
    try {
      dir = await open(folderPath, flags.folder);
    } catch (error) {
      return await openFailure(error, folderPath);
    }
    const folderRefused = await checkOpened(dir, true);
    if (folderRefused) return folderRefused;
    const { dev, ino } = await dir.stat({ bigint: true });
    const filePath = `/proc/self/fd/${dir.fd}/${file}`;
    const notFile = await preflight(filePath);
    if (notFile) return notFile;
    try {
      handle = await open(filePath, flags.file);
    } catch (error) {
      return await openFailure(error, filePath);
    }
    const read = (await checkOpened(handle, false)) ?? (await readBounded(handle));
    return read.kind === "read" ? { ...read, identity: `${dev}:${ino}` } : read;
  } catch {
    return refused("failed");
  } finally {
    await handle?.close();
    await dir?.close();
  }
}

/** The lexer, `json5` and the rules, in a worker with resource limits and a deadline. */
export function parseInWorker(
  text: string,
  profile: SettingsProfile,
  worker: URL,
  deadlineMs = READ_DEADLINE_MS,
): Promise<Parsed> {
  const failed = { kind: "refused", reason: "unreadable", why: "worker" } as const;
  if (Buffer.byteLength(text, "utf8") > SETTINGS_LIMIT)
    return Promise.resolve({ kind: "refused", reason: "unreadable", why: "large" });
  return new Promise((done) => {
    let settled = false;
    let thread: Worker | undefined;
    const finish = (result: Parsed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void thread?.terminate();
      done(result);
    };
    const timer = setTimeout(() => finish(failed), deadlineMs);
    try {
      thread = new Worker(worker, {
        workerData: { text, profile },
        resourceLimits: WORKER_LIMITS,
        env: {},
        execArgv: [],
        stdout: true,
        stderr: true,
      });
    } catch {
      finish(failed);
      return;
    }
    thread.once("message", (message: unknown) => finish(validExtracted(message) ?? failed));
    thread.once("error", () => finish(failed));
    thread.once("exit", () => finish(failed));
  });
}

/**
 * The worker's answer, rebuilt from its fixed fields: a usable port and token,
 * or a reason and why the rules can give. Nothing else the message carries is kept.
 */
function validExtracted(message: unknown): Extracted | null {
  if (typeof message !== "object" || message === null) return null;
  const { kind, token, port, reason, why } = message as Record<string, unknown>;
  if (kind === "found")
    return typeof token === "string" &&
      token === token.trim() &&
      literalTokenRefusal(token) === null &&
      usablePort(port)
      ? { kind: "found", token, port }
      : null;
  if (kind !== "refused" || typeof reason !== "string" || !Object.hasOwn(REFUSALS, reason))
    return null;
  const whys: readonly string[] = REFUSALS[reason as keyof typeof REFUSALS];
  return typeof why === "string" && whys.includes(why)
    ? ({ kind: "refused", reason, why } as Extracted)
    : null;
}
