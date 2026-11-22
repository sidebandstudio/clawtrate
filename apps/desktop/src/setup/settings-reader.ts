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
// Nothing in a shipped host calls this yet: setup PR 2a-2 connects it, behind
// a host option that is off.

import { spawn } from "node:child_process";
import { constants, lstatSync, realpathSync } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { Worker } from "node:worker_threads";
import {
  REFUSALS,
  usablePort,
  usableToken,
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
import { accountHome, SANDBOX_MARKERS, SetupRefusedError } from "./world.ts";

export const SETTINGS_LIMIT = 1024 * 1024;
/** The helper's deadline, and the parse worker's. */
export const READ_DEADLINE_MS = 2_000;
const WORKER_LIMITS = { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 };
/** All the helper may write: "ok\n" and at most the limit, or one refusal line. */
const HELPER_OUTPUT_LIMIT = SETTINGS_LIMIT + 3;

/** The two canonical profiles, by their folder under the home folder. */
export const SETTINGS_PROFILES = [
  { profile: "default", folder: ".openclaw" },
  { profile: "clawtrate", folder: ".openclaw-clawtrate" },
] as const;
const SETTINGS_FILE = "openclaw.json";

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
] as const;

/** Why the file wasn't read: each a fixed word, safe for a log. */
export type OpenRefusal =
  | { reason: "absent" }
  | { reason: "unsafe"; why: (typeof UNSAFE_WHY)[number] }
  | { reason: "unreadable"; why: "large" };

export type Opened = { kind: "read"; bytes: Buffer } | ({ kind: "refused" } & OpenRefusal);

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
  | { kind: "found"; token: HeldToken; port: number }
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

const refused = (why: (typeof UNSAFE_WHY)[number]): Opened => ({
  kind: "refused",
  reason: "unsafe",
  why,
});

/** One path component: not empty, no separator or NUL, not "." or "..". */
const component = (name: string) =>
  name.length > 0 && name.length <= 255 && !/[/\0]/.test(name) && name !== "." && name !== "..";

/**
 * Unless the caller says this is a production run and no sandbox marker is
 * present, the home folder must be a private folder of this account's, by
 * its canonical path, below one of this machine's temporary roots with no
 * folder on the way that another account could swap, and away from the
 * account's real home. Checked before anything in it is opened.
 */
export function guardHome(
  home: string,
  sandboxed: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (sandboxed === false && !SANDBOX_MARKERS.some((key) => Object.hasOwn(env, key))) return;
  const uid = process.geteuid?.() ?? null;
  const orNull = <T>(read: () => T): T | null => {
    try {
      return read();
    } catch {
      return null;
    }
  };
  const real = accountHome();
  const canonical = orNull(() => realpathSync(home));
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
      orNull(() => lstatSync(home)),
      uid,
    )
  )
    throw new SetupRefusedError("home");
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
  return { kind: "found", token: new HeldToken(parsed.token), port: parsed.port };
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
  if (!isAbsolute(home) || normalize(home) !== home || !component(folder) || !component(file))
    return refused("path");
  guardHome(home, options.sandboxed);
  if (platform !== "darwin" && platform !== "linux") return refused("helper");
  if (platform === "darwin" && !options.helper) return refused("helper");
  const held = await holdHome(home);
  if (!("handle" in held)) return held;
  try {
    return platform === "darwin"
      ? await readWithHelper(options.helper!, held.handle, [folder, file], options.deadlineMs)
      : await readThroughProc(held.handle, folder, file);
  } finally {
    await held.handle.close();
  }
}

/**
 * The home folder, opened without following a link and checked on what was
 * opened: a folder of this account's that neither its group nor others may
 * write to.
 */
export async function holdHome(home: string): Promise<{ handle: FileHandle } | Opened> {
  const flags = openFlags();
  if (!flags) return refused("failed");
  let handle: FileHandle;
  try {
    handle = await open(home, flags.folder);
  } catch (error) {
    return await openFailure(error, home);
  }
  try {
    const stat = await handle.stat();
    const why = !stat.isDirectory()
      ? "type"
      : stat.uid !== process.geteuid?.()
        ? "owner"
        : (stat.mode & 0o022) !== 0
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

/**
 * The helper's answer, or `helper` for a missing helper, a timeout, a failed
 * exit, or output that isn't exactly one of its two forms.
 */
function readWithHelper(
  helper: string,
  home: FileHandle,
  args: string[],
  deadlineMs = READ_DEADLINE_MS,
) {
  const failed = refused("helper");
  return new Promise<Opened>((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const settle = (result: Opened) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const chunk of chunks) chunk.fill(0);
      child?.kill("SIGKILL");
      child?.stdout?.destroy();
      done(result);
    };
    // Its own deadline: a descendant holding the pipe open can't delay the answer.
    const timer = setTimeout(() => settle(failed), deadlineMs);
    try {
      child = spawn(helper, ["read", ...args], {
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "ignore", home.fd],
      });
    } catch {
      settle(failed);
      return;
    }
    child.stdout!.on("data", (data: Buffer) => {
      size += data.length;
      chunks.push(data);
      if (size > HELPER_OUTPUT_LIMIT) settle(failed);
    });
    child.on("error", () => settle(failed));
    child.once("close", (code, signal) => {
      if (settled) return;
      const output = Buffer.concat(chunks);
      settle(code === 0 && signal === null ? helperAnswer(output) : failed);
      output.fill(0);
    });
  });
}

const HELPER_REFUSAL = /^refused ([a-z]{1,16})\n$/;

/** "ok\n" and the file, or exactly one whitelisted refusal line; anything else is unverified. */
function helperAnswer(output: Buffer): Opened {
  if (output.subarray(0, 3).equals(Buffer.from("ok\n")))
    return output.length - 3 <= SETTINGS_LIMIT
      ? { kind: "read", bytes: Buffer.from(output.subarray(3)) }
      : refused("helper");
  const why = output.length <= 32 ? HELPER_REFUSAL.exec(output.toString("latin1"))?.[1] : null;
  if (why === "absent") return { kind: "refused", reason: "absent" };
  if (why === "large") return { kind: "refused", reason: "unreadable", why };
  const unsafe = UNSAFE_WHY.find((word) => word === why && word !== "helper" && word !== "path");
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
export async function checkOpened(handle: FileHandle, folder: boolean): Promise<Opened | null> {
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
export async function readBounded(handle: FileHandle): Promise<Opened> {
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
    const filePath = `/proc/self/fd/${dir.fd}/${file}`;
    const notFile = await preflight(filePath);
    if (notFile) return notFile;
    try {
      handle = await open(filePath, flags.file);
    } catch (error) {
      return await openFailure(error, filePath);
    }
    return (await checkOpened(handle, false)) ?? (await readBounded(handle));
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
    return typeof token === "string" && usableToken(token) && usablePort(port)
      ? { kind: "found", token, port }
      : null;
  if (kind !== "refused" || typeof reason !== "string" || !Object.hasOwn(REFUSALS, reason))
    return null;
  const whys: readonly string[] = REFUSALS[reason as keyof typeof REFUSALS];
  return typeof why === "string" && whys.includes(why)
    ? ({ kind: "refused", reason, why } as Extracted)
    : null;
}
