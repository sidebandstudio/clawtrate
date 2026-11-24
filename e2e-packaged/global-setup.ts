import { appEnv, debuggingPort } from "./desktop-driver.ts";
// Starts the packaged app for the launch check and returns the teardown that
// quits it and removes everything this run created.
//
// On macOS the run builds its own ad hoc signed app under a fresh
// `<APP_ID>.check.<16 hex>` bundle identifier and refuses any other, since
// macOS keeps preferences by bundle identifier outside every data folder. On
// Windows it starts the unpacked or installed app. Every launch gets a data
// folder, home and temporary folder of the run's own.
// The check drives the window over the Chrome DevTools protocol on a port the
// system picks: the shipped binary has Node's inspector turned off.
//
// The development gateway is an instance of this run's own, named `e2e-<run>`,
// and is recorded, like the app, in the same run records `pnpm e2e` keeps, so
// a run killed outright is cleaned up by the next `pnpm e2e` or launch check.
//
// What this run must leave alone is asserted: the processes listening on the
// default instance's and the web preview's ports (19001, 19091, 5310, 5311),
// and a sentinel instance, `e2e-<run>-other`, that it starts unseeded and never
// touches. Other builders' instances come and go on a shared machine; a change
// to them is printed as a note, not counted as a failure, since a snapshot
// cannot show this run caused it.
//
// On Windows no development gateway runs, so the run starts no instances and
// keeps no run record: it launches the app, the tests that need a gateway are
// skipped, and the teardown asks the app to close and checks it did.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { APP_ID } from "../apps/desktop/src/main/identity.ts";
import { gatedSpawn } from "../tools/dev-gateway/src/env.ts";
import { writeSandbox } from "../e2e/setup-sandbox.ts";
import { newRunId, processIdentity } from "../tools/dev-gateway/src/state-guard.ts";
import { FORBIDDEN_PORTS, listInstances, runningOthers } from "../e2e/global-setup.ts";
import { askToClose, forceEnd, windowsProcesses } from "./windows.ts";
import {
  cleanUp,
  recordPath,
  recoverDeadRuns,
  saveRecord,
  successorAtCleanUp,
  TEMP_PREFIX,
  type RunRecord,
} from "../e2e/run-record.ts";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "tools/dev-gateway/src/cli.ts");
const RECORDS = join(ROOT, "tools/dev-gateway/.run/e2e");

/**
 * The packaged app to check: `CLAWTRATE_PACKAGED_APP` when it names one, such
 * as the folder the Windows installer installed into; else on Windows the
 * unpacked folder `pnpm package:win` built, and on macOS a check build for this
 * machine's architecture, made now in a temporary folder removed at exit.
 */
export function packagedApp(): string {
  if (process.env.CLAWTRATE_PACKAGED_APP) return process.env.CLAWTRATE_PACKAGED_APP;
  if (process.platform === "win32") return join(ROOT, "apps/desktop/dist/win-unpacked");
  const folder = process.arch === "arm64" ? "mac-arm64" : "mac";
  const output = mkdtempSync(join(tmpdir(), "clawtrate-check-build-"));
  process.on("exit", () => rmSync(output, { recursive: true, force: true }));
  const cwd = join(ROOT, "apps/desktop");
  execFileSync("pnpm", ["run", "build"], { cwd, stdio: "inherit" });
  execFileSync(process.execPath, ["packaging/build.ts", "mac", "--check", output], {
    cwd,
    stdio: "inherit",
  });
  return join(output, folder, "Clawtrate.app");
}

/** The executable inside the packaged app. */
export function packagedExecutable(app: string): string {
  return process.platform === "win32"
    ? join(app, "Clawtrate.exe")
    : join(app, "Contents/MacOS/Clawtrate");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * The processes listening on the protected ports, each by PID, start time and
 * address. `lsof` exits 1 when any one of the ports has no listener, with the
 * others' rows on its output, or none when nothing listens: both are answers.
 */
export function protectedListeners(): string[] {
  let out: string;
  try {
    out = execFileSync(
      "lsof",
      ["-nP", ...FORBIDDEN_PORTS.map((port) => `-iTCP:${port}`), "-sTCP:LISTEN", "-Fpn"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch (error) {
    const failed = error as { status?: number; stdout?: string };
    if (failed.status !== 1) throw error;
    out = failed.stdout ?? "";
  }
  const rows: string[] = [];
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (line.startsWith("n")) {
      const found = processIdentity(pid);
      rows.push(
        `pid ${pid} (${found.state === "alive" ? found.identity : found.state}) ${line.slice(1)}`,
      );
    }
  }
  return [...new Set(rows)].sort();
}

export function bundleIdentifier(app: string): string {
  return execFileSync(
    "plutil",
    ["-extract", "CFBundleIdentifier", "raw", join(app, "Contents/Info.plist")],
    { encoding: "utf8" },
  ).replace(/\n$/, "");
}

const CHECK_BUNDLE = new RegExp(`^${APP_ID.replaceAll(".", "\\.")}\\.check\\.[0-9a-f]{16}$`);

/**
 * Runs the macOS check with `domain` only if it is a check build's bundle
 * identifier. Everything that reads or writes preferences, which macOS keeps by
 * that identifier, happens inside `use`, so a person's own Clawtrate
 * (`APP_ID`) is refused before any of it.
 */
export function withCheckBundle<T>(domain: string, use: (domain: string) => T): T {
  if (!CHECK_BUNDLE.test(domain)) {
    throw new Error(`refusing ${domain}: the launch check runs only a check build`);
  }
  return use(domain);
}

/**
 * Forgets a check build's preferences, once. Returns a problem, or null.
 * Synchronous, for signal handlers too. The preferences daemon caches them, so
 * it is told first, and the file is then removed and looked for after a pause.
 */
function preferencesForgetter(domain: string): () => string | null {
  const path = join(homedir(), "Library/Preferences", `${domain}.plist`);
  let forgotten: string | null | undefined;
  return () => {
    if (forgotten !== undefined) return forgotten;
    try {
      try {
        execFileSync("defaults", ["delete", domain], { stdio: "ignore" });
      } catch {
        // the domain was never written
      }
      rmSync(path, { force: true });
      sleepSync(2000);
      forgotten = existsSync(path) ? `${path} could not be removed` : null;
    } catch (error) {
      forgotten = `removing ${path}: ${String(error)}`;
    }
    return forgotten;
  };
}

/** The processes whose command line names `dir`: the app and its helpers, which all carry its data folder. */
export function processesUsing(dir: string): number[] {
  if (process.platform === "win32") {
    return windowsProcesses()
      .filter(({ pid, command }) => command.includes(dir) && pid !== process.pid)
      .map(({ pid }) => pid);
  }
  const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((line) => line.includes(dir))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => pid !== process.pid);
}

function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAWTRATE_DEV_INSTANCE;
  return env;
}

/**
 * The environment and working folder of every packaged launch, the second
 * included: the app's own, with the run's temporary home and temporary
 * folder, in a working folder of the run's own. Made under `dir`. macOS
 * ignores `HOME` for an app's Library (logs, caches, preferences) unless
 * `CFFIXED_USER_HOME` names it too. Windows keeps a profile's folders in
 * variables of their own, which it treats regardless of case.
 */
export function launchPlace(
  dir: string,
  platform = process.platform,
  inherited = appEnv(),
): { env: NodeJS.ProcessEnv; cwd: string } {
  const home = join(dir, "home");
  const tmp = join(dir, "tmp");
  const cwd = join(dir, "work");
  for (const folder of [home, tmp, cwd]) mkdirSync(folder, { recursive: true, mode: 0o700 });
  const env = { ...inherited };
  if (platform === "win32") {
    for (const key of Object.keys(env)) {
      if (/^(HOME|TMPDIR|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA)$/i.test(key))
        delete env[key];
    }
    const drive = win32.parse(home).root.replace(/[\\/]$/, "");
    env.USERPROFILE = home;
    env.HOMEDRIVE = drive;
    env.HOMEPATH = home.slice(drive.length);
    env.APPDATA = join(home, "AppData", "Roaming");
    env.LOCALAPPDATA = join(home, "AppData", "Local");
    for (const folder of [env.APPDATA, env.LOCALAPPDATA]) mkdirSync(folder, { recursive: true });
  }
  if (platform === "darwin") env.CFFIXED_USER_HOME = home;
  return { env: { ...env, HOME: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp }, cwd };
}

/** The exit of each packaged app this run started, recorded the moment it was spawned. */
const exits = new WeakMap<ChildProcess, Promise<void>>();
export function recordExit(child: ChildProcess): ChildProcess {
  exits.set(child, new Promise((resolve) => child.once("exit", () => resolve())));
  return child;
}

/**
 * Writes the app's exit status to `file` as it exits, for the test that quits
 * it: that test runs in a worker, and only this runner, which started the app,
 * sees how it ended.
 */
export function reportExit(child: ChildProcess, file: string): void {
  child.once("exit", (code, signal) => {
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify({ code, signal }));
      renameSync(`${file}.tmp`, file);
    } catch {
      // The run's folder is removed once the app is gone; no test reads it after that.
    }
  });
}

export async function exitedWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const deadline = setTimeout(() => resolve(false), ms);
    exits.get(child)?.then(() => {
      clearTimeout(deadline);
      resolve(true);
    });
  });
}

export async function windowsQuitProblem(child: ChildProcess): Promise<string | null> {
  if (!(await exitedWithin(child, 15_000))) {
    return `the app (pid ${child.pid}) did not quit within 15 seconds`;
  }
  return child.exitCode === 0 ? null : `the app exited with ${child.exitCode ?? child.signalCode}`;
}

/**
 * The packaged app's launch arguments: its own data folder, the debugging
 * port this check drives it over, always a sandbox, and the checkout whose
 * run records prove the sandbox's instance (a packaged app has no checkout of
 * its own). Nothing may automate a packaged app without a sandbox: such an
 * app would be a person's, and look at the real computer.
 */
export function launchArgs(userData: string, sandbox: string, checkout: string): string[] {
  return [
    `--user-data-dir=${userData}`,
    "--remote-debugging-port=0",
    `--clawtrate-setup-sandbox=${sandbox}`,
    `--clawtrate-setup-checkout=${checkout}`,
  ];
}

/** This checkout, as the dev-gateway tool records it. */
export const CHECKOUT = realpathSync(ROOT);

/**
 * The sandbox the app's look on this computer is given (docs/development/setup.md):
 * a private run folder whose description names this run's instance and its
 * current run. On Windows the look reads nothing and no instance runs, so the
 * description there names none that is running.
 */
function setupSandbox(dir: string, instance: string): { file: string; appData: string } {
  const parent = join(dir, "setup");
  mkdirSync(parent, { recursive: true });
  const run = process.platform === "win32" ? { run: "0".repeat(48) } : {};
  const sandbox = writeSandbox({ instance, parent, ...run });
  // The app keeps its data in the sandbox's own folder; the check passes and reads that one.
  return { file: sandbox.file, appData: realpathSync.native(sandbox.appData) };
}

export default async function globalSetup() {
  if (process.platform === "win32") return windowsSetup();
  if (process.platform !== "darwin") throw new Error("the launch check runs on macOS and Windows");
  const app = packagedApp();
  if (!existsSync(app)) throw new Error(`${app} does not exist. Check the packaged app path.`);
  return withCheckBundle(bundleIdentifier(app), (domain) => macSetup(app, domain));
}

async function macSetup(app: string, domain: string) {
  // Forgotten by every way this run ends.
  const forgetPreferences = preferencesForgetter(domain);

  const run = process.env.CLAWTRATE_E2E_RUN ?? randomBytes(4).toString("hex");
  if (!/^[0-9a-f]{8}$/.test(run)) throw new Error("CLAWTRATE_E2E_RUN must be 8 hex digits");
  const name = `e2e-${run}`;
  process.env.CLAWTRATE_DEV_INSTANCE = name;

  recoverDeadRuns(RECORDS, (instance, runId) => {
    execFileSync(process.execPath, [CLI, "reset", "--run-id", runId, "--instance", instance], {
      cwd: ROOT,
      env: cliEnv(),
      stdio: "inherit",
    });
  });

  const self = processIdentity(process.pid);
  if (self.state !== "alive") throw new Error("could not determine this process's start time");
  const record: RunRecord = {
    run,
    runner: { pid: process.pid, identity: self.identity },
    instances: [],
    host: null,
    dirs: [],
  };
  saveRecord(RECORDS, record);
  const reset = (instance: string, runId: string) => {
    execFileSync(process.execPath, [CLI, "reset", "--run-id", runId, "--instance", instance], {
      cwd: ROOT,
      env: cliEnv(),
      stdio: ["ignore", "ignore", "inherit"],
    });
  };
  let cleaned: string[] | null = null;
  const cleanUpOnce = () => {
    if (cleaned) return cleaned;
    // A test may have recorded a newer build it started on the same data folder.
    const successor = successorAtCleanUp(recordPath(RECORDS, record.run), record.runner);
    if (successor) record.successor = successor;
    return (cleaned = cleanUp(RECORDS, record, reset));
  };
  // Forgotten after the app is gone, which cleanUp makes sure of.
  const finish = () => {
    const problems = [...cleanUpOnce()];
    const prefs = forgetPreferences();
    if (prefs) problems.push(prefs);
    return problems;
  };
  const onSignal = (signal: NodeJS.Signals) => {
    const problems = finish();
    if (problems.length > 0) console.error(problems.join("\n"));
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", () => void finish());

  const sentinel = `${name}-other`;
  const sentinelState = () => {
    const row = listInstances().find((entry) => entry.name === sentinel);
    return row
      ? `running ${row.gatewayRunning}, gateway pid ${row.gatewayPid}, ports ${row.gatewayPort}/${row.providerPort}`
      : "absent";
  };
  let sentinelBefore: string | null = null;
  const listenersBefore = protectedListeners();
  const othersBefore = runningOthers([name, sentinel]);
  let appProcess: ChildProcess | null = null;
  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  record.dirs.push(dir);
  saveRecord(RECORDS, record);
  // The sandbox's data folder once it is written; nothing of the app's runs before that.
  let userData = join(realpathSync.native(dir), "user-data");

  const teardown = async () => {
    const problems: string[] = [];
    // Quit the app the way the system does at logout, and wait for it and its helpers.
    if (appProcess && appProcess.exitCode === null && appProcess.signalCode === null) {
      appProcess.kill("SIGTERM");
      if (!(await exitedWithin(appProcess, 15_000))) {
        // The graceful shutdown failed: that is reported, and only the recorded app is ended.
        problems.push(`the app (pid ${appProcess.pid}) did not quit within 15 seconds`);
        forceEnd(appProcess.pid!);
      }
    }
    for (let i = 0; i < 50 && processesUsing(userData).length > 0; i += 1) await sleep(200);
    const left = processesUsing(userData);
    if (left.length > 0) problems.push(`app processes still running: ${left.join(", ")}`);
    if (sentinelBefore !== null && sentinelState() !== sentinelBefore) {
      problems.push(`the sentinel instance changed: ${sentinelBefore} -> ${sentinelState()}`);
    }
    problems.push(...finish());
    const listenersAfter = protectedListeners();
    if (listenersAfter.join("\n") !== listenersBefore.join("\n")) {
      problems.push(
        `the listeners on ports ${FORBIDDEN_PORTS.join(", ")} changed:\n` +
          `before: ${listenersBefore.join("; ") || "none"}\nafter: ${listenersAfter.join("; ") || "none"}`,
      );
    }
    const othersAfter = runningOthers([name, sentinel]);
    const changed = othersBefore.filter((row) => !othersAfter.includes(row));
    if (changed.length > 0) {
      console.log(`Note: other instances changed during the run, not by it: ${changed.join(", ")}`);
    }
    if (listInstances().some((row) => row.name === name || row.name === sentinel)) {
      problems.push(`instance ${name} or ${sentinel} was not removed`);
    }
    if (problems.length > 0) throw new Error(problems.join("\n"));
    console.log(
      `Quit the packaged app, removed instances ${name} and ${sentinel} and ${dir}, and forgot ${domain}'s preferences`,
    );
  };

  /** Start an instance, recording its name and run id first. */
  const startInstance = (instance: string, ...flags: string[]) => {
    const runId = newRunId();
    record.instances.push({ name: instance, runId });
    saveRecord(RECORDS, record);
    execFileSync(
      process.execPath,
      [CLI, "start", "--run-id", runId, "--instance", instance, ...flags],
      { cwd: ROOT, env: cliEnv(), stdio: ["ignore", "inherit", "inherit"] },
    );
  };

  try {
    // Another gateway this run owns and never touches, listening the whole time.
    startInstance(sentinel, "--no-seed");
    sentinelBefore = sentinelState();
    if (!sentinelBefore.startsWith("running true")) {
      throw new Error(`sentinel ${sentinel} is not running`);
    }
    // With the scripted accounts and sign-ins, for the check that types a key into the app.
    startInstance(name, "--with-accounts", "--with-plugin", "clawtrate-dev-signin");
    const mine = listInstances().find((row) => row.name === name);
    if (!mine?.gatewayRunning) throw new Error(`instance ${name} is not running`);
    for (const port of [mine.gatewayPort, mine.providerPort]) {
      if (port === null || FORBIDDEN_PORTS.includes(port)) {
        throw new Error(`instance ${name} is on port ${port}, which this check never uses`);
      }
    }

    // What the app writes to its output, its log, kept beside its data folder for the checks.
    const log = join(dir, "app.log");
    const logFd = openSync(log, "a", 0o600);
    record.hostPending = true;
    saveRecord(RECORDS, record);
    const written = setupSandbox(dir, name);
    const sandbox = written.file;
    userData = written.appData;
    process.env.CLAWTRATE_PACKAGED_SANDBOX = sandbox;
    const place = launchPlace(dir);
    process.env.CLAWTRATE_PACKAGED_PLACE = dir;
    const gated = gatedSpawn(
      spawn,
      packagedExecutable(app),
      launchArgs(userData, sandbox, CHECKOUT),
      {
        cwd: place.cwd,
        env: place.env,
        stdio: ["ignore", logFd, logFd],
      },
    );
    appProcess = recordExit(gated.child);
    const exitFile = join(dir, "app-exit.json");
    reportExit(appProcess, exitFile);
    const found = processIdentity(appProcess.pid!);
    if (found.state !== "alive") {
      gated.abort();
      throw new Error("could not record the app's process");
    }
    record.host = { pid: appProcess.pid!, identity: found.identity };
    delete record.hostPending;
    saveRecord(RECORDS, record);
    gated.release();

    const port = await debuggingPort(userData, appProcess);
    process.env.CLAWTRATE_PACKAGED_CDP = `http://127.0.0.1:${port}`;
    process.env.CLAWTRATE_PACKAGED_APP = app;
    process.env.CLAWTRATE_PACKAGED_USER_DATA = userData;
    process.env.CLAWTRATE_PACKAGED_PID = String(appProcess.pid);
    process.env.CLAWTRATE_PACKAGED_LOG = log;
    process.env.CLAWTRATE_PACKAGED_EXIT = exitFile;
    process.env.CLAWTRATE_PACKAGED_BUNDLE_ID = domain;
    process.env.CLAWTRATE_PACKAGED_RECORD = recordPath(RECORDS, record.run);
  } catch (error) {
    await teardown().catch((problem: unknown) => console.error(String(problem)));
    throw error;
  }
  return teardown;
}

/**
 * The Windows run: the packaged app alone, with a temporary data folder. No
 * development gateway runs on Windows, so there are no instances, no run
 * record and no listeners to protect. The app is asked to close the way
 * Windows asks at sign-out (a close message to its windows), and the run
 * fails if it or a helper is still running 15 seconds later; anything left
 * is then ended by PID so the machine is not left with it.
 */
async function windowsSetup() {
  const app = packagedApp();
  const exe = packagedExecutable(app);
  if (!existsSync(exe)) throw new Error(`${exe} does not exist. Run \`pnpm package:win\` first.`);
  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  // The sandbox's data folder once it is written.
  let userData = join(realpathSync.native(dir), "user-data");
  let appProcess: ChildProcess | null = null;

  /** Ends whatever is left of the app by PID and removes the folder. Synchronous, for the exit handler too. */
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    for (const pid of processesUsing(userData)) forceEnd(pid);
    if (appProcess?.pid && appProcess.exitCode === null) forceEnd(appProcess.pid);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  process.on("exit", finish);

  const teardown = async () => {
    const problems: string[] = [];
    if (appProcess && (appProcess.exitCode !== null || appProcess.signalCode !== null)) {
      // The app must still be running when it is asked to close. One that ended by
      // itself, cleanly or not, did not "stay up and close when asked".
      problems.push(
        `the app exited before it was asked to close, with ${appProcess.exitCode ?? appProcess.signalCode}`,
      );
    } else if (appProcess) {
      const refused = askToClose(appProcess.pid!);
      if (refused) problems.push(`asking the app to close failed: ${refused}`);
      else {
        const problem = await windowsQuitProblem(appProcess);
        if (problem) problems.push(problem);
      }
    }
    for (let i = 0; i < 50 && processesUsing(userData).length > 0; i += 1) await sleep(200);
    const left = processesUsing(userData);
    if (left.length > 0) problems.push(`app processes still running: ${left.join(", ")}`);
    finish();
    if (existsSync(dir)) problems.push(`${dir} could not be removed`);
    if (problems.length > 0) throw new Error(problems.join("\n"));
    console.log(`Closed the packaged app and removed ${dir}`);
  };

  try {
    const written = setupSandbox(dir, `e2e-${randomBytes(4).toString("hex")}`);
    const sandbox = written.file;
    userData = written.appData;
    process.env.CLAWTRATE_PACKAGED_SANDBOX = sandbox;
    const place = launchPlace(dir);
    process.env.CLAWTRATE_PACKAGED_PLACE = dir;
    appProcess = recordExit(
      spawn(exe, launchArgs(userData, sandbox, CHECKOUT), {
        cwd: place.cwd,
        env: place.env,
        stdio: ["ignore", "ignore", "inherit"],
      }),
    );
    const port = await debuggingPort(userData, appProcess);
    process.env.CLAWTRATE_PACKAGED_CDP = `http://127.0.0.1:${port}`;
    process.env.CLAWTRATE_PACKAGED_APP = app;
    process.env.CLAWTRATE_PACKAGED_USER_DATA = userData;
    process.env.CLAWTRATE_PACKAGED_PID = String(appProcess.pid);
  } catch (error) {
    await teardown().catch((problem: unknown) => console.error(String(problem)));
    throw error;
  }
  return teardown;
}
