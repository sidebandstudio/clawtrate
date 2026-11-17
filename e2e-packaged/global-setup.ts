// Starts the packaged app for the launch check and returns the teardown that
// quits it and removes everything this run created.
//
// The app is the one `pnpm package:mac` built, never the source tree. It runs
// with a temporary data folder (`--user-data-dir`, which also holds its device
// key and tokens), so it never reads or writes the data folder of a Clawtrate
// someone uses on this machine; the teardown checks that folder did not change.
// The check drives the window over the Chrome DevTools protocol on a port the
// system picks: the shipped binary has Node's inspector turned off.
//
// The development gateway is an instance of this run's own, named `e2e-<run>`,
// and is recorded, like the app, in the same run records `pnpm e2e` keeps, so
// a run killed outright is cleaned up by the next `pnpm e2e` or launch check.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { gatedSpawn } from "../tools/dev-gateway/src/env.ts";
import { newRunId, processIdentity } from "../tools/dev-gateway/src/state-guard.ts";
import { FORBIDDEN_PORTS, listInstances, runningOthers } from "../e2e/global-setup.ts";
import {
  cleanUp,
  recoverDeadRuns,
  saveRecord,
  TEMP_PREFIX,
  type RunRecord,
} from "../e2e/run-record.ts";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "tools/dev-gateway/src/cli.ts");
const RECORDS = join(ROOT, "tools/dev-gateway/.run/e2e");

/** The packaged app for this machine's architecture. */
export function packagedApp(): string {
  const folder = process.arch === "arm64" ? "mac-arm64" : "mac";
  return join(ROOT, "apps/desktop/dist", folder, "Clawtrate.app");
}

/** Where a Clawtrate that someone uses on this machine keeps its data. Never written. */
const REAL_DATA = [
  join(homedir(), "Library/Application Support/Clawtrate"),
  join(homedir(), "Library/Caches/Clawtrate"),
];

/** Every entry under the given folders with its size and modification time, kept in memory only. */
function fingerprint(paths: string[]): string {
  const lines: string[] = [];
  const walk = (path: string) => {
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      lines.push(`${path} absent`);
      return;
    }
    lines.push(`${path} ${stat.mode} ${stat.size} ${stat.mtimeMs}`);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
  };
  for (const path of paths) walk(path);
  return lines.join("\n");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The processes whose command line names `dir`: the app and its helpers, which all carry its data folder. */
export function processesUsing(dir: string): number[] {
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

/** The app's environment: nothing that could point it at a development gateway or change Electron. */
function appEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(CLAWTRATE_|ELECTRON_|NODE_OPTIONS$|OPENCLAW_)/.test(key),
    ),
  );
}

export default async function globalSetup() {
  if (process.platform !== "darwin") throw new Error("the launch check runs on macOS");
  const app = packagedApp();
  if (!existsSync(app)) throw new Error(`${app} does not exist. Run \`pnpm package:mac\` first.`);

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
  const cleanUpOnce = () => (cleaned ??= cleanUp(RECORDS, record, reset));
  const onSignal = (signal: NodeJS.Signals) => {
    const problems = cleanUpOnce();
    if (problems.length > 0) console.error(problems.join("\n"));
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", () => void cleanUpOnce());

  const realBefore = fingerprint(REAL_DATA);
  const othersBefore = runningOthers([name]);
  let appProcess: ChildProcess | null = null;
  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  record.dirs.push(dir);
  saveRecord(RECORDS, record);
  const userData = join(dir, "user-data");

  const teardown = async () => {
    const problems: string[] = [];
    // Quit the app the way the system does at logout, and wait for it and its helpers.
    if (appProcess && appProcess.exitCode === null && appProcess.signalCode === null) {
      const exited = new Promise((resolve) => appProcess!.once("exit", resolve));
      appProcess.kill("SIGTERM");
      if ((await Promise.race([exited, sleep(15_000).then(() => "timeout")])) === "timeout") {
        problems.push(`the app (pid ${appProcess.pid}) did not quit within 15 seconds`);
      }
    }
    for (let i = 0; i < 50 && processesUsing(userData).length > 0; i += 1) await sleep(200);
    const left = processesUsing(userData);
    if (left.length > 0) problems.push(`app processes still running: ${left.join(", ")}`);
    problems.push(...cleanUpOnce());
    if (fingerprint(REAL_DATA) !== realBefore) {
      problems.push("the data folder of this machine's own Clawtrate changed");
    }
    const othersAfter = runningOthers([name]);
    const gone = othersBefore.filter((row) => !othersAfter.includes(row));
    if (gone.length > 0) problems.push(`instances that were running changed: ${gone.join(", ")}`);
    if (listInstances().some((row) => row.name === name)) {
      problems.push(`instance ${name} was not removed`);
    }
    if (problems.length > 0) throw new Error(problems.join("\n"));
    console.log(`Quit the packaged app and removed instance ${name} and ${dir}`);
  };

  try {
    const runId = newRunId();
    record.instances.push({ name, runId });
    saveRecord(RECORDS, record);
    execFileSync(process.execPath, [CLI, "start", "--run-id", runId, "--instance", name], {
      cwd: ROOT,
      env: cliEnv(),
      stdio: ["ignore", "inherit", "inherit"],
    });
    const mine = listInstances().find((row) => row.name === name);
    if (!mine?.gatewayRunning) throw new Error(`instance ${name} is not running`);
    for (const port of [mine.gatewayPort, mine.providerPort]) {
      if (port === null || FORBIDDEN_PORTS.includes(port)) {
        throw new Error(`instance ${name} is on port ${port}, which this check never uses`);
      }
    }

    mkdirSync(userData);
    record.hostPending = true;
    saveRecord(RECORDS, record);
    const gated = gatedSpawn(
      spawn,
      join(app, "Contents/MacOS/Clawtrate"),
      [`--user-data-dir=${userData}`, "--remote-debugging-port=0"],
      { cwd: dir, env: appEnv(), stdio: ["ignore", "ignore", "inherit"] },
    );
    appProcess = gated.child;
    const found = processIdentity(appProcess.pid!);
    if (found.state !== "alive") {
      gated.abort();
      throw new Error("could not record the app's process");
    }
    record.host = { pid: appProcess.pid!, identity: found.identity };
    delete record.hostPending;
    saveRecord(RECORDS, record);
    gated.release();

    // Chromium writes the port it chose into the data folder.
    const portFile = join(userData, "DevToolsActivePort");
    const deadline = Date.now() + 30_000;
    while (!existsSync(portFile)) {
      if (appProcess.exitCode !== null)
        throw new Error(`the app exited with ${appProcess.exitCode}`);
      if (Date.now() > deadline) throw new Error("the app did not open its debugging port");
      await sleep(200);
    }
    const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
    if (!Number.isInteger(port) || port <= 0 || FORBIDDEN_PORTS.includes(port)) {
      throw new Error(`unexpected debugging port ${port}`);
    }
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
