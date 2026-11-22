// The bounded settings reader (docs/design/setup-effortless.md §3, "The
// settings reader"). It reads OpenClaw's own `openclaw.json` for the default
// and `clawtrate` profiles under a home folder its caller names, and runs no
// OpenClaw code. On macOS the native helper (packaging/mac/local-gateway.c)
// opens the file; on Linux the same walk is done here through /proc. Windows
// has no local proof, so nothing is read there. The text is parsed in a worker
// with resource limits and a deadline, and the token found is held for one
// attempt only (`HeldToken`).
//
// Nothing in a shipped host calls this yet: setup PR 2a-2 connects it, behind
// a host option that is off.

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { inspect } from "node:util";
import { Worker } from "node:worker_threads";
import type { Extracted } from "./settings-extract.ts";
import { accountHome, SANDBOX_MARKERS, SetupRefusedError } from "./world.ts";

export const SETTINGS_LIMIT = 1024 * 1024;
/** The helper's deadline, and the parse worker's. */
export const READ_DEADLINE_MS = 2_000;
const WORKER_LIMITS = { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 };

/** The two canonical profiles, by their folder under the home folder. */
export const SETTINGS_PROFILES = [
  { profile: "default", folder: ".openclaw" },
  { profile: "clawtrate", folder: ".openclaw-clawtrate" },
] as const;
const SETTINGS_FILE = "openclaw.json";

/** Why the file wasn't read: each a fixed word, safe for a log. */
export type OpenRefusal =
  | { reason: "absent" }
  | {
      reason: "unsafe";
      why: "link" | "type" | "owner" | "mode" | "links" | "acl" | "denied" | "failed" | "helper";
    }
  | { reason: "unreadable"; why: "large" };

export type Opened = { kind: "read"; bytes: Buffer } | ({ kind: "refused" } & OpenRefusal);

/**
 * A token from the settings file, held for one bounded attempt. It prints and
 * serializes as a placeholder, so a log line or a message can't carry it.
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
  toJSON(): string {
    return "[token]";
  }
  toString(): string {
    return "[token]";
  }
  [inspect.custom](): string {
    return "[token]";
  }
}

/** What the parse worker answered; `worker` for a crash, a limit or the deadline. */
export type Parsed = Extracted | { kind: "refused"; reason: "unreadable"; why: "worker" };

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
  /** The parse worker's module (settings-parse.ts, or its bundled copy). */
  worker: URL;
  deadlineMs?: number;
};

/**
 * Refuses to read under the account's real home in a run that must be
 * sandboxed, before any file is touched.
 */
function guardHome(home: string, env: NodeJS.ProcessEnv = process.env): void {
  const real = accountHome();
  const sandboxed = SANDBOX_MARKERS.some((key) => Object.hasOwn(env, key));
  if (sandboxed && (real === null || resolve(home) === resolve(real)))
    throw new SetupRefusedError("home");
}

/** Each canonical profile's outcome: the default always, `clawtrate` only when its folder exists. */
export async function readLocalSettings(
  options: ReaderOptions,
): Promise<{ profile: "default" | "clawtrate"; outcome: SettingsOutcome }[]> {
  const results = [];
  for (const { profile, folder } of SETTINGS_PROFILES) {
    const outcome = await readProfile(options, folder);
    const absent = outcome.kind === "refused" && outcome.reason === "absent";
    if (profile === "default" || !absent) results.push({ profile, outcome });
  }
  return results;
}

async function readProfile(options: ReaderOptions, folder: string): Promise<SettingsOutcome> {
  const opened = await openSettingsFile({ ...options, folder, file: SETTINGS_FILE });
  if (opened.kind === "refused") return opened;
  const text = opened.bytes.toString("utf8");
  opened.bytes.fill(0);
  const extracted = await parseInWorker(text, options.worker, options.deadlineMs);
  if (extracted.kind !== "found") return extracted;
  return { kind: "found", token: new HeldToken(extracted.token), port: extracted.port };
}

/** Opens `<home>/<folder>/<file>` by the reader's rules, on this platform. */
export async function openSettingsFile(options: {
  home: string;
  folder: string;
  file: string;
  platform: NodeJS.Platform;
  helper: string | null;
  deadlineMs?: number;
}): Promise<Opened> {
  guardHome(options.home);
  const { home, folder, file } = options;
  if (options.platform === "darwin")
    return options.helper
      ? readWithHelper(options.helper, [home, folder, file], options.deadlineMs)
      : { kind: "refused", reason: "unsafe", why: "helper" };
  if (options.platform === "linux") return readThroughProc(home, folder, file);
  return { kind: "refused", reason: "unsafe", why: "helper" };
}

const HELPER_WHY = new Set(["link", "type", "owner", "mode", "links", "acl", "denied", "failed"]);

/** The helper's answer, or `helper` for a missing helper, a timeout or malformed output. */
function readWithHelper(helper: string, args: string[], deadlineMs = READ_DEADLINE_MS) {
  const failed: Opened = { kind: "refused", reason: "unsafe", why: "helper" };
  return new Promise<Opened>((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const child = spawn(helper, ["read", ...args], {
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const settle = (result: Opened) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const chunk of chunks) chunk.fill(0);
      child.kill("SIGKILL");
      child.stdout.destroy();
      done(result);
    };
    // Its own deadline: a descendant holding the pipe open can't delay the answer.
    const timer = setTimeout(() => settle(failed), deadlineMs);
    child.stdout.on("data", (data: Buffer) => {
      size += data.length;
      chunks.push(data);
      if (size > SETTINGS_LIMIT + 64) settle(failed);
    });
    child.on("error", () => settle(failed));
    child.once("close", (code, signal) => {
      if (settled) return;
      const output = Buffer.concat(chunks);
      const line = output.indexOf(10);
      const head = line > 0 && line <= 32 ? output.subarray(0, line).toString("latin1") : "";
      const why = head.startsWith("refused ") ? head.slice(8) : null;
      let result: Opened = failed;
      if (code !== 0 || signal !== null) result = failed;
      else if (head === "ok")
        result = { kind: "read", bytes: Buffer.from(output.subarray(line + 1)) };
      else if (why === "absent") result = { kind: "refused", reason: "absent" };
      else if (why === "large") result = { kind: "refused", reason: "unreadable", why };
      else if (why !== null && HELPER_WHY.has(why))
        result = { kind: "refused", reason: "unsafe", why: why as "link" };
      output.fill(0);
      settle(result);
    });
  });
}

/** Why an open failed. A link opened as a folder fails as "not a folder", so it is told apart. */
async function openFailure(error: unknown, path: string): Promise<Opened> {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return { kind: "refused", reason: "absent" };
  if (code === "ELOOP") return { kind: "refused", reason: "unsafe", why: "link" };
  if (code === "ENOTDIR") {
    const link = await lstat(path).then(
      (stat) => stat.isSymbolicLink(),
      () => false,
    );
    return { kind: "refused", reason: "unsafe", why: link ? "link" : "type" };
  }
  if (code === "EACCES" || code === "EPERM")
    return { kind: "refused", reason: "unsafe", why: "denied" };
  return { kind: "refused", reason: "unsafe", why: "failed" };
}

/**
 * The checks on what was opened, as the helper makes them. On Linux a POSIX
 * ACL's entries are bounded by its mask, which is the mode's group bits, so a
 * file of exactly 0600 in a folder without group or other bits grants nothing
 * to another account.
 */
async function checkOpened(handle: FileHandle, folder: boolean): Promise<Opened | null> {
  const stat = await handle.stat();
  const refuse = (why: "type" | "owner" | "mode" | "links"): Opened => ({
    kind: "refused",
    reason: "unsafe",
    why,
  });
  if (folder ? !stat.isDirectory() : !stat.isFile()) return refuse("type");
  if (stat.uid !== process.geteuid?.()) return refuse("owner");
  if (folder ? (stat.mode & 0o077) !== 0 : (stat.mode & 0o7777) !== 0o600) return refuse("mode");
  if (!folder && stat.nlink !== 1) return refuse("links");
  if (!folder && stat.size > SETTINGS_LIMIT)
    return { kind: "refused", reason: "unreadable", why: "large" };
  return null;
}

/** Reads to the end, refusing more than the limit however large the file was when checked. */
export async function readBounded(handle: FileHandle): Promise<Opened> {
  const buffer = Buffer.alloc(SETTINGS_LIMIT + 1);
  let length = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
    if (bytesRead === 0) break;
    length += bytesRead;
    if (length > SETTINGS_LIMIT) {
      buffer.fill(0);
      return { kind: "refused", reason: "unreadable", why: "large" };
    }
  }
  const bytes = Buffer.from(buffer.subarray(0, length));
  buffer.fill(0);
  return { kind: "read", bytes };
}

/**
 * Linux: the folder is held open without following a link, and the file is
 * opened through /proc/self/fd/<folder>, which resolves to that held folder,
 * read-only, no-follow and nonblocking.
 */
async function readThroughProc(home: string, folder: string, file: string): Promise<Opened> {
  const { O_RDONLY, O_DIRECTORY = 0, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = constants;
  let dir: FileHandle | null = null;
  let handle: FileHandle | null = null;
  try {
    const folderPath = `${resolve(home)}/${folder}`;
    try {
      dir = await open(folderPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    } catch (error) {
      return await openFailure(error, folderPath);
    }
    const folderRefused = await checkOpened(dir, true);
    if (folderRefused) return folderRefused;
    const filePath = `/proc/self/fd/${dir.fd}/${file}`;
    try {
      handle = await open(filePath, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (error) {
      return await openFailure(error, filePath);
    }
    return (await checkOpened(handle, false)) ?? (await readBounded(handle));
  } catch {
    return { kind: "refused", reason: "unsafe", why: "failed" };
  } finally {
    await handle?.close();
    await dir?.close();
  }
}

/** The lexer, `json5` and the rules, in a worker with resource limits and a deadline. */
export function parseInWorker(
  text: string,
  worker: URL,
  deadlineMs = READ_DEADLINE_MS,
): Promise<Parsed> {
  const failed = { kind: "refused", reason: "unreadable", why: "worker" } as const;
  return new Promise((done) => {
    let settled = false;
    const finish = (result: Parsed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void thread.terminate();
      done(result);
    };
    const thread = new Worker(worker, {
      workerData: text,
      resourceLimits: WORKER_LIMITS,
      env: {},
      stdout: true,
      stderr: true,
    });
    const timer = setTimeout(() => finish(failed), deadlineMs);
    thread.once("message", (message: unknown) => finish(validExtracted(message) ?? failed));
    thread.once("error", () => finish(failed));
    thread.once("exit", () => finish(failed));
  });
}

/** The worker's answer, if it has the shape the rules produce. */
function validExtracted(message: unknown): Extracted | null {
  if (typeof message !== "object" || message === null) return null;
  const value = message as Record<string, unknown>;
  if (value.kind === "found")
    return typeof value.token === "string" && typeof value.port === "number"
      ? { kind: "found", token: value.token, port: value.port }
      : null;
  if (value.kind !== "refused" || typeof value.reason !== "string" || typeof value.why !== "string")
    return null;
  return ["unreadable", "address", "credential"].includes(value.reason)
    ? (value as Extracted)
    : null;
}
