// Electron's safeStorage on Windows across a restart, natively: a value one windowless Electron
// process seals through the public async calls the app's box makes (`safeStorageBox`) opens in the
// next process on the same profile, after a normal quit. The value is a random marker, and every
// folder the processes are given (profile, home, temporary and crash folders) is inside one this run
// makes and removes. It shows nothing about a process that ends abruptly, or about moving
// credentials (docs/decisions.md, "Windows keeps its files until a move is proved across
// processes"). It runs only on Windows where the binary is installed (`node -e "require('electron')"`
// in apps/desktop), and CLAWTRATE_WINDOWS_SAFE_STORAGE_TESTS=1 requires it.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DESKTOP = resolve(import.meta.dirname, "..");
const PREFIX = "clawtrate-restart-";

/** The development Electron binary, read from its package without downloading anything. */
function electronBinary(): string | null {
  try {
    const dir = dirname(
      createRequire(join(DESKTOP, "package.json")).resolve("electron/package.json"),
    );
    const path = join(dir, "dist", readFileSync(join(dir, "path.txt"), "utf8").trim());
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

const electron = process.platform === "win32" ? electronBinary() : null;

it.runIf(process.env.CLAWTRATE_WINDOWS_SAFE_STORAGE_TESTS === "1")(
  "finds the development Electron binary on Windows",
  () => {
    expect(process.platform).toBe("win32");
    expect(electron).not.toBeNull();
  },
);

// One step, as Electron's main script: no window, its outcome in a file, then a normal quit.
// Electron shows an uncaught error in a dialog unless the app handles it, so it does, and exits.
const PROBE = String.raw`
const { app, safeStorage } = require("electron");
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const jobPath = process.argv[process.argv.length - 1];
let done = false;
function end(result) {
  if (done) return;
  done = true;
  try {
    writeFileSync(jobPath + ".result", JSON.stringify(result));
  } finally {
    if (result.failed === undefined) app.quit();
    else app.exit(1);
  }
}
const failed = (error) => end({ failed: String((error && error.name) || error) });
process.on("uncaughtException", failed);
process.on("unhandledRejection", failed);
async function run(job) {
  const available = await safeStorage.isAsyncEncryptionAvailable();
  if (job.step === "seal") {
    if (available) writeFileSync(job.sealed, await safeStorage.encryptStringAsync(job.marker));
    return end({ available });
  }
  const opened = await safeStorage.decryptStringAsync(readFileSync(job.sealed)).then(
    ({ result }) => createHash("sha256").update(result).digest("hex"),
    () => null,
  );
  end({ available, opened });
}
try {
  const job = JSON.parse(readFileSync(jobPath, "utf8"));
  app.setPath("userData", job.userData);
  app.setPath("crashDumps", job.crashDumps);
  app.disableHardwareAcceleration();
  app.whenReady().then(() => run(job), failed);
} catch (error) {
  failed(error);
}
`;

/** Removes this run's folder, refusing one it didn't make and any link or junction inside it. */
function removeOwned(dir: string): void {
  if (
    dirname(dir) !== realpathSync(tmpdir()) ||
    !basename(dir).startsWith(PREFIX) ||
    realpathSync(dir) !== dir
  )
    throw new Error(`not this run's folder: ${dir}`);
  const check = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`a link or junction in this run's folder: ${path}`);
    if (stat.isDirectory()) for (const name of readdirSync(path)) check(join(path, name));
  };
  check(dir);
  rmSync(dir, { recursive: true });
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe.skipIf(!electron)("Electron's safeStorage on Windows across a restart", () => {
  let root: string;
  let paths: { userData: string; crashDumps: string };
  let env: NodeJS.ProcessEnv;
  /** Each running process and its exit, so one left by a failure is ended by its handle. */
  const running = new Map<ChildProcess, Promise<number | null>>();

  beforeAll(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), PREFIX));
    writeFileSync(join(root, "probe.cjs"), PROBE);
    const profile = join(root, "profile");
    const home = join(profile, "home");
    paths = { userData: join(profile, "user-data"), crashDumps: join(profile, "crash-dumps") };
    env = {
      SystemRoot: process.env.SystemRoot,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      TEMP: join(profile, "temp"),
      TMP: join(profile, "temp"),
    };
    for (const dir of [
      paths.userData,
      paths.crashDumps,
      env.APPDATA!,
      env.LOCALAPPDATA!,
      env.TEMP!,
    ])
      mkdirSync(dir, { recursive: true });
  });

  afterAll(async () => {
    for (const [child, exit] of running) {
      child.kill();
      await exit.catch(() => null);
    }
    if (root) removeOwned(root);
  });

  /** Runs one step in its own Electron process on the run's profile, and reads its outcome. */
  async function launch(job: Record<string, string>): Promise<Record<string, unknown>> {
    const path = join(root, `${job.step}.json`);
    writeFileSync(path, JSON.stringify({ ...job, ...paths }));
    const child = spawn(electron!, [join(root, "probe.cjs"), path], {
      cwd: root,
      env,
      stdio: "ignore",
      windowsHide: true,
    });
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    running.set(child, exit);
    const timer = setTimeout(() => child.kill(), 60_000);
    try {
      const code = await exit;
      const outcome = existsSync(`${path}.result`)
        ? (JSON.parse(readFileSync(`${path}.result`, "utf8")) as Record<string, unknown>)
        : {};
      expect(outcome.failed, `${job.step} step`).toBeUndefined();
      expect(code, `${job.step} step`).toBe(0);
      return outcome;
    } finally {
      clearTimeout(timer);
      running.delete(child);
    }
  }

  it(
    "a value one process seals opens in the next on the same profile, after a normal quit",
    { timeout: 150_000 },
    async () => {
      const marker = `clawtrate-restart-check-${randomBytes(16).toString("hex")}`;
      const sealed = join(root, "sealed.bin");
      expect(await launch({ step: "seal", marker, sealed })).toEqual({ available: true });
      // What the first process kept is ciphertext, not the marker.
      const bytes = readFileSync(sealed);
      for (const form of [Buffer.from(marker), Buffer.from(marker, "utf16le")])
        expect(bytes.includes(form)).toBe(false);
      expect(await launch({ step: "open", sealed })).toEqual({
        available: true,
        opened: sha256(marker),
      });
    },
  );
});
