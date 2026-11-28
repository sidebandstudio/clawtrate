// Electron's safeStorage on Windows across a restart, natively: a value one windowless Electron
// process seals through the public async calls the app's box makes (`safeStorageBox`) opens in the
// next process on the same profile, after a normal quit. And with that box, `createSecureCredentials`
// moves an earlier build's files into its sealed record at a normal start, and the next normal start
// opens the same identity and token from it. That record and `state.json`, copied without the rest
// of the profile to a fresh profile on the same account, open there as locked and change nothing,
// and the first profile still opens them. Every value is random and made for this run, the
// earlier build's files by core's own file store and key, and every folder the processes are given
// (profile, home, temporary and crash folders) is inside one this run makes and removes. It shows
// nothing about a process that ends abruptly (docs/decisions.md, "Windows keeps its files until a
// move is proved across processes"). It runs only on Windows where the binary is installed
// (`node -e "require('electron')"` in apps/desktop), and CLAWTRATE_WINDOWS_SAFE_STORAGE_TESTS=1
// requires it.

import {
  createFileSigner,
  createFileStore,
  CREDENTIALS_FILE,
  DEVICE_KEY_FILE,
  STATE_FILE,
} from "@clawtrate/core/node";
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
/** An address nothing serves (RFC 2606); nothing here connects to anything. */
const GATEWAY = "wss://gateway.invalid";

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
// A start loads the app's own box and core's credentials from their sources (Electron's Node
// strips the types), as the main process uses them. It hands back the token's digest, never the token.
const PROBE = String.raw`
const { app, safeStorage } = require("electron");
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { pathToFileURL } = require("node:url");
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
async function start(job) {
  const { safeStorageBox } = await import(pathToFileURL(job.boxModule).href);
  const { createSecureCredentials } = await import(pathToFileURL(job.coreModule).href);
  const warned = [];
  const credentials = createSecureCredentials({
    dataDir: job.dataDir,
    box: safeStorageBox(safeStorage, process.platform),
    log: (_level, line) => warned.push(line),
  });
  const status = await credentials.status();
  const { deviceId } = await credentials.signer.loadIdentity();
  const token = await credentials.storage.get(job.tokenKey);
  const opened = token === null ? null : createHash("sha256").update(token).digest("hex");
  end({ status, deviceId, token: opened, warned });
}
// Each read on its own, so one that is refused doesn't hide the rest. A refusal comes back as
// the name of core's own error, anything else as "other", and warnings only as a count.
const REFUSALS = [
  "SecureStorageUnavailableError",
  "CredentialRecordInvalidError",
  "SavedSettingsInvalidError",
];
async function inspect(job) {
  const { safeStorageBox } = await import(pathToFileURL(job.boxModule).href);
  const { createSecureCredentials } = await import(pathToFileURL(job.coreModule).href);
  let warned = 0;
  const credentials = createSecureCredentials({
    dataDir: job.dataDir,
    box: safeStorageBox(safeStorage, process.platform),
    log: () => (warned += 1),
  });
  const digest = (text) => (text === null ? null : createHash("sha256").update(text).digest("hex"));
  const read = (promise) =>
    promise.then(
      (value) => ({ value }),
      (error) => ({ refused: REFUSALS.includes(error && error.name) ? error.name : "other" }),
    );
  const status = await credentials.status();
  const secure = await credentials.secure();
  const identity = await read(credentials.signer.loadIdentity().then(({ deviceId }) => deviceId));
  const token = await read(credentials.storage.get(job.tokenKey).then(digest));
  const settings = await read(credentials.storage.get("connection").then(digest));
  end({ status, secure, identity, token, settings, warned });
}
async function run(job) {
  if (job.step === "start" || job.step === "restart") return start(job);
  if (job.step === "inspect") return inspect(job);
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
  // A scanner or a helper can hold a file a moment longer: Node retries a busy or refused removal.
  rmSync(dir, { recursive: true, maxRetries: 5 });
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

type Profile = { paths: { userData: string; crashDumps: string }; env: NodeJS.ProcessEnv };

type Read = { value: string | null } | { refused: string };

/** What an `inspect` step established, in fixed words: each read the same as sealed, or what refused it. */
function established(
  outcome: Record<string, unknown>,
  sealed: { deviceId: string; token: string; settings: string },
) {
  const word = (read: Read, expected: string) =>
    "refused" in read
      ? read.refused
      : read.value === null
        ? "none"
        : read.value === expected
          ? "same"
          : "different";
  return {
    status: outcome.status,
    secure: outcome.secure,
    identity: word(outcome.identity as Read, sealed.deviceId),
    token: word(outcome.token as Read, sealed.token),
    settings: word(outcome.settings as Read, sealed.settings),
    warned: outcome.warned,
  };
}

describe.skipIf(!electron)("Electron's safeStorage on Windows across a restart", () => {
  let root: string;
  /** Each running process and its exit, so one left by a failure is ended by its handle. */
  const running = new Map<ChildProcess, Promise<number | null>>();
  /** Numbers each launch's job, so no earlier step's outcome is read as a later one's. */
  let launched = 0;

  beforeAll(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), PREFIX));
    writeFileSync(join(root, "probe.cjs"), PROBE);
  });

  afterAll(async () => {
    for (const [child, exit] of running) {
      child.kill();
      await exit.catch(() => null);
    }
    if (root) removeOwned(root);
  });

  /** A profile of the case's own in the run's folder, so no key safeStorage made earlier is there. */
  function newProfile(name: string): Profile {
    const profile = join(root, name);
    const home = join(profile, "home");
    const paths = {
      userData: join(profile, "user-data"),
      crashDumps: join(profile, "crash-dumps"),
    };
    const env = {
      SystemRoot: process.env.SystemRoot,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      TEMP: join(profile, "temp"),
      TMP: join(profile, "temp"),
    };
    for (const dir of [paths.userData, paths.crashDumps, env.APPDATA, env.LOCALAPPDATA, env.TEMP])
      mkdirSync(dir, { recursive: true });
    return { paths, env };
  }

  /** Runs one step in its own Electron process on the profile, and reads its outcome. */
  async function launch(
    { paths, env }: Profile,
    job: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const path = join(root, `${job.step}-${(launched += 1)}.json`);
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
      const profile = newProfile("seal");
      const marker = `clawtrate-restart-check-${randomBytes(16).toString("hex")}`;
      const sealed = join(root, "sealed.bin");
      expect(await launch(profile, { step: "seal", marker, sealed })).toEqual({ available: true });
      // What the first process kept is ciphertext, not the marker.
      const bytes = readFileSync(sealed);
      for (const form of [Buffer.from(marker), Buffer.from(marker, "utf16le")])
        expect(bytes.includes(form)).toBe(false);
      expect(await launch(profile, { step: "open", sealed })).toEqual({
        available: true,
        opened: sha256(marker),
      });
    },
  );

  it(
    "an earlier build's files move at a normal start, and the next normal start opens the same identity and token",
    { timeout: 150_000 },
    async () => {
      const profile = newProfile("move");
      const dataDir = join(profile.paths.userData, "gateway");
      // An earlier build's files, as core's own file store and key write them without a box: the
      // key in clear text, this device's token for an address nothing serves, and a plain setting.
      const { deviceId } = await createFileSigner(join(dataDir, DEVICE_KEY_FILE)).loadIdentity();
      const tokenKey = `deviceToken:${encodeURIComponent(GATEWAY)}:${deviceId}:operator`;
      const token = `clawtrate-restart-token-${randomBytes(16).toString("hex")}`;
      const record = JSON.stringify({
        token,
        grantedScopes: ["operator.read"],
        heldScopes: ["operator.read"],
      });
      const connection = JSON.stringify({ url: GATEWAY, token: null });
      const earlier = createFileStore(join(dataDir, STATE_FILE));
      await earlier.set("connection", connection);
      await earlier.set(tokenKey, record);
      await earlier.set("turn-limit-minutes", "30");
      const pem = readFileSync(join(dataDir, DEVICE_KEY_FILE), "utf8");
      expect(readdirSync(dataDir).sort()).toEqual([DEVICE_KEY_FILE, STATE_FILE].sort());
      expect(readFileSync(join(dataDir, STATE_FILE), "utf8").includes(token)).toBe(true);

      const job = {
        dataDir,
        tokenKey,
        boxModule: join(DESKTOP, "src", "main", "secret-box.ts"),
        coreModule: createRequire(join(DESKTOP, "package.json")).resolve("@clawtrate/core/node"),
      };
      const opened = { status: "secure", deviceId, token: sha256(record), warned: [] };
      expect(await launch(profile, { step: "start", ...job })).toEqual(opened);
      // As the move promises: the sealed record replaces the key file and the token, and the
      // setting that isn't a credential stays in `state.json`.
      expect(readdirSync(dataDir).sort()).toEqual([CREDENTIALS_FILE, STATE_FILE].sort());
      const settings = JSON.parse(readFileSync(join(dataDir, STATE_FILE), "utf8")) as object;
      expect(Object.keys(settings).sort()).toEqual(["connection", "turn-limit-minutes"]);
      expect(settings).toEqual({ connection, "turn-limit-minutes": "30" });
      const sealed = readFileSync(join(dataDir, CREDENTIALS_FILE));
      for (const secret of [token, pem, "PRIVATE KEY"]) expect(sealed.includes(secret)).toBe(false);

      expect(await launch(profile, { step: "restart", ...job })).toEqual(opened);
      // The restart only read: both files are as the move left them.
      expect(readdirSync(dataDir).sort()).toEqual([CREDENTIALS_FILE, STATE_FILE].sort());
      expect(readFileSync(join(dataDir, CREDENTIALS_FILE)).equals(sealed)).toBe(true);
      expect(JSON.parse(readFileSync(join(dataDir, STATE_FILE), "utf8"))).toEqual(settings);
    },
  );

  it(
    "a fresh profile reports the copied credentials as locked and leaves both files unchanged for the original profile to reopen",
    { timeout: 200_000 },
    async () => {
      // The donor: an earlier build's key and token, moved into a sealed record at a normal start.
      const donor = newProfile("donor");
      const donorDir = join(donor.paths.userData, "gateway");
      const { deviceId } = await createFileSigner(join(donorDir, DEVICE_KEY_FILE)).loadIdentity();
      const tokenKey = `deviceToken:${encodeURIComponent(GATEWAY)}:${deviceId}:operator`;
      const token = `clawtrate-restore-token-${randomBytes(16).toString("hex")}`;
      const record = JSON.stringify({
        token,
        grantedScopes: ["operator.read"],
        heldScopes: ["operator.read"],
      });
      const connection = JSON.stringify({ url: GATEWAY, token: null });
      const earlier = createFileStore(join(donorDir, STATE_FILE));
      await earlier.set("connection", connection);
      await earlier.set(tokenKey, record);
      const sealed = { deviceId, token: sha256(record), settings: sha256(connection) };
      const opens = {
        status: "secure",
        secure: true,
        identity: "same",
        token: "same",
        settings: "same",
        warned: 0,
      };
      const job = {
        step: "inspect",
        tokenKey,
        boxModule: join(DESKTOP, "src", "main", "secret-box.ts"),
        coreModule: createRequire(join(DESKTOP, "package.json")).resolve("@clawtrate/core/node"),
      };
      const open = async (profile: Profile, dataDir: string) =>
        established(await launch(profile, { ...job, dataDir }), sealed);
      expect(await open(donor, donorDir)).toEqual(opens);
      expect(readdirSync(donorDir).sort()).toEqual([CREDENTIALS_FILE, STATE_FILE].sort());

      // Copy only credentials.bin and state.json to a fresh profile on the same Windows account.
      const copied = new Map(
        [CREDENTIALS_FILE, STATE_FILE].map((name) => [name, readFileSync(join(donorDir, name))]),
      );
      const fresh = newProfile("restored");
      const restored = join(fresh.paths.userData, "gateway");
      mkdirSync(restored);
      for (const [name, bytes] of copied) writeFileSync(join(restored, name), bytes);
      const unchanged = (label: string) => {
        expect(readdirSync(restored).sort(), label).toEqual([...copied.keys()].sort());
        for (const [name, bytes] of copied)
          expect(readFileSync(join(restored, name)).equals(bytes), `${label}: ${name}`).toBe(true);
      };

      // Locked, read as safeStorage being unavailable: no identity is made in place of the sealed
      // one and no token is read; only the address, which was never a credential, still reads.
      expect(await open(fresh, restored)).toEqual({
        status: "locked",
        secure: false,
        identity: "SecureStorageUnavailableError",
        token: "SecureStorageUnavailableError",
        settings: "same",
        warned: 1,
      });
      unchanged("after the fresh profile");

      // The same bytes, after that, open on the donor's profile as the same device with its token.
      expect(await open(donor, restored)).toEqual(opens);
      unchanged("after the donor's profile");
    },
  );
});
