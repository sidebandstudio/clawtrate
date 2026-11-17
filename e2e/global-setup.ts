// Starts what the end-to-end tests need and returns the teardown that stops it.
//
// Every run has its own development gateway instance, named for the run, on
// ports the dev tooling chooses. It never uses the default instance or its
// ports, whether or not something runs there, so runs in several checkouts can
// go at once. Before its own instance it starts an unseeded sentinel instance,
// so there is always another instance's gateway listening while the tests run;
// the tests and the teardown check that it, and every instance that was already
// running, is left as it was.
//
// Cleanup removes exactly what this run created: each instance by name and by
// the run id this run gave it, the preview host it spawned and its temporary
// folders. Each resource is written to a run record in this checkout before or
// as it is acquired. Cleanup runs from the teardown, from a setup failure, on
// SIGINT and SIGTERM, and when the process exits. A run killed outright leaves
// its record behind, and the next run in this checkout cleans it up once that
// run's runner is proven gone.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { newRunId, processIdentity, validPid } from "../tools/dev-gateway/src/state-guard.ts";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "tools/dev-gateway/src/cli.ts");
/** Run records of this checkout's end-to-end runs. Git-ignored. */
const RECORDS = join(ROOT, "tools/dev-gateway/.run/e2e");
/** The default instance's ports and the web preview's. An e2e run uses none of them. */
export const FORBIDDEN_PORTS = [19001, 19091, 5310, 5311];
const TEMP_PREFIX = "clawtrate-e2e-";

export type ListedInstance = {
  name: string | null;
  stateDir: string;
  gatewayPort: number | null;
  providerPort: number | null;
  gatewayPid: number | null;
  gatewayRunning: boolean;
};

function cliEnv(): NodeJS.ProcessEnv {
  // The instance is named by the flag alone, never inherited from the environment.
  const env = { ...process.env };
  delete env.CLAWTRATE_DEV_INSTANCE;
  return env;
}

export function devGateway(instance: string | null, ...args: string[]): string {
  const flags = instance === null ? [] : ["--instance", instance];
  return execFileSync(process.execPath, [CLI, ...args, ...flags], {
    cwd: ROOT,
    env: cliEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

export function listInstances(): ListedInstance[] {
  return JSON.parse(devGateway(null, "list", "--json")) as ListedInstance[];
}

/**
 * The running instances this run must leave alone, by name, pid and ports: the
 * default instance, named instances that are not e2e runs', and the ones in
 * `keep`. Other e2e runs' instances come and go with those runs.
 */
export function runningOthers(own: string[], keep: string[] = []): string[] {
  return listInstances()
    .filter(
      (row) =>
        row.gatewayRunning &&
        (row.name === null ||
          (!own.includes(row.name) && (!row.name.startsWith("e2e-") || keep.includes(row.name)))),
    )
    .map(
      (row) =>
        `${row.name ?? "(default)"} pid ${row.gatewayPid} ports ${row.gatewayPort}/${row.providerPort}`,
    )
    .sort();
}

type Proc = { pid: number; identity: string };

/** What a run created, saved as it goes so an interrupted run can be cleaned up. */
type RunRecord = {
  run: string;
  runner: Proc;
  instances: { name: string; runId: string }[];
  host: Proc | null;
  dirs: string[];
};

const recordPath = (run: string) => join(RECORDS, `${run}.json`);

function saveRecord(record: RunRecord): void {
  mkdirSync(RECORDS, { recursive: true });
  const temp = `${recordPath(record.run)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temp, recordPath(record.run));
}

function readRecord(path: string): RunRecord | null {
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as RunRecord;
    const proc = (p: unknown) =>
      p !== null &&
      typeof p === "object" &&
      validPid((p as Proc).pid) &&
      typeof (p as Proc).identity === "string";
    if (
      /^[0-9a-f]{8}$/.test(record.run) &&
      proc(record.runner) &&
      (record.host === null || proc(record.host)) &&
      Array.isArray(record.instances) &&
      Array.isArray(record.dirs)
    ) {
      return record;
    }
  } catch {
    // unreadable: left alone
  }
  return null;
}

const alive = (proc: Proc) => processIdentity(proc.pid) === proc.identity;

/**
 * Remove everything a run record lists, synchronously, so it also works from a
 * signal or exit handler. The preview host is signalled only if it is still the
 * process that was spawned. Each instance is reset by name and run id; the dev
 * tooling proves its processes before signalling and deletes only when nothing
 * runs. Returns what could not be cleaned up.
 */
function cleanUp(record: RunRecord): string[] {
  const problems: string[] = [];
  if (record.host && alive(record.host)) process.kill(record.host.pid, "SIGTERM");
  for (const dir of record.dirs) {
    if (dirname(dir) === tmpdir() && basename(dir).startsWith(TEMP_PREFIX)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  for (const { name, runId } of [...record.instances].reverse()) {
    try {
      devGateway(name, "reset", "--run-id", runId);
    } catch (error) {
      problems.push(`reset ${name}: ${String(error)}`);
    }
  }
  if (problems.length === 0) rmSync(recordPath(record.run), { force: true });
  return problems;
}

/** Clean up this checkout's earlier runs that were killed and can no longer clean up. */
function recoverDeadRuns(): void {
  let files: string[];
  try {
    files = readdirSync(RECORDS).filter((file) => /^[0-9a-f]{8}\.json$/.test(file));
  } catch {
    return;
  }
  for (const file of files) {
    const record = readRecord(join(RECORDS, file));
    if (!record || alive(record.runner)) continue;
    console.log(`Cleaning up interrupted end-to-end run ${record.run}`);
    const problems = cleanUp(record);
    if (problems.length > 0) console.error(problems.join("\n"));
  }
}

/** Stop a child we started: SIGTERM, a bounded wait, then SIGKILL. */
async function stopChild(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), timeoutMs),
  );
  if ((await Promise.race([exited, timer])) === "timeout") {
    child.kill("SIGKILL");
    await exited;
  }
}

function startHost(instance: string, staticDir: string, dataDir: string) {
  const host = spawn(
    process.execPath,
    [
      join(ROOT, "apps/desktop/src/web-host/main.ts"),
      "--host",
      "127.0.0.1",
      // The system picks a free port; the host prints the one it bound.
      "--port",
      "0",
      "--instance",
      instance,
      "--static-dir",
      staticDir,
      "--data-dir",
      dataDir,
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] },
  );
  const url = new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`preview host did not start:\n${output}`)),
      20_000,
    );
    host.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = /Local\s+(http:\/\/\S+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!.replace("localhost", "127.0.0.1"));
      }
    });
    host.once("exit", (code) => reject(new Error(`preview host exited with ${code}:\n${output}`)));
  });
  return { host, url };
}

export default async function globalSetup() {
  const run = process.env.CLAWTRATE_E2E_RUN ?? randomBytes(4).toString("hex");
  if (!/^[0-9a-f]{8}$/.test(run)) throw new Error(`CLAWTRATE_E2E_RUN must be 8 hex digits`);
  const name = `e2e-${run}`;
  const sentinel = `e2e-${run}-other`;
  const own = [name, sentinel];
  // The spec's own dev-gateway calls address this run's instance.
  process.env.CLAWTRATE_DEV_INSTANCE = name;
  process.env.CLAWTRATE_E2E_SENTINEL = sentinel;

  recoverDeadRuns();

  // Registered before anything is started.
  const record: RunRecord = {
    run,
    runner: { pid: process.pid, identity: processIdentity(process.pid)! },
    instances: [],
    host: null,
    dirs: [],
  };
  saveRecord(record);
  let child: ChildProcess | null = null;
  let host: ChildProcess | null = null;
  let cleaned: string[] | null = null;
  const cleanUpOnce = (): string[] => {
    if (cleaned) return cleaned;
    // A dev-gateway command still running is ended first; the reset below
    // waits for the instance's lock, which that command holds until it exits.
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    cleaned = cleanUp(record);
    return cleaned;
  };
  const onSignal = (signal: NodeJS.Signals) => {
    const problems = cleanUpOnce();
    if (problems.length > 0) console.error(problems.join("\n"));
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", () => void cleanUpOnce());

  /** A dev-gateway command, run so that signals are handled while it runs. */
  const cli = (instance: string, ...args: string[]) =>
    new Promise<void>((resolve, reject) => {
      if (cleaned) return reject(new Error("the run was interrupted"));
      child = spawn(process.execPath, [CLI, ...args, "--instance", instance], {
        cwd: ROOT,
        env: cliEnv(),
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        code === 0
          ? resolve()
          : reject(new Error(`dev-gateway ${args[0]} ${instance} failed (${code ?? signal})`)),
      );
    });
  /** Start an instance, recording its name and run id first. */
  const startInstance = (instance: string, ...flags: string[]) => {
    const runId = newRunId();
    record.instances.push({ name: instance, runId });
    saveRecord(record);
    return cli(instance, "start", "--run-id", runId, ...flags);
  };
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
    record.dirs.push(dir);
    saveRecord(record);
    return dir;
  };

  const alreadyRunning = runningOthers(own);
  const teardown = async () => {
    if (host) await stopChild(host);
    const problems = [...cleanUpOnce()];
    const after = runningOthers(own);
    const gone = alreadyRunning.filter((row) => !after.includes(row));
    if (gone.length > 0) problems.push(`instances that were running changed: ${gone.join(", ")}`);
    if (listInstances().some((row) => row.name !== null && own.includes(row.name))) {
      problems.push("this run's instance folders were not removed");
    }
    if (problems.length > 0) throw new Error(problems.join("\n"));
  };

  try {
    const staticDir = tempDir();
    const dataDir = tempDir();
    // Another instance's gateway is listening before this run's starts.
    await startInstance(sentinel, "--no-seed");
    process.env.CLAWTRATE_E2E_OTHERS = JSON.stringify(runningOthers([name], [sentinel]));
    // Every start is a fresh, seeded gateway.
    await startInstance(name);
    const mine = listInstances().find((row) => row.name === name);
    if (!mine?.gatewayRunning) throw new Error(`instance ${name} is not running`);
    for (const port of [mine.gatewayPort, mine.providerPort]) {
      if (port === null || FORBIDDEN_PORTS.includes(port)) {
        throw new Error(`instance ${name} is on port ${port}, which e2e never uses`);
      }
    }

    // Built into this run's own folder, so parallel runs never share output.
    execFileSync(
      "pnpm",
      [
        "--filter",
        "@clawtrate/desktop",
        "exec",
        "vite",
        "build",
        "--config",
        "vite.web.config.ts",
        "--outDir",
        staticDir,
        "--emptyOutDir",
      ],
      { cwd: ROOT, stdio: "ignore" },
    );
    if (cleaned) throw new Error("the run was interrupted");
    const started = startHost(name, staticDir, dataDir);
    host = started.host;
    record.host = { pid: host.pid!, identity: processIdentity(host.pid!)! };
    saveRecord(record);
    const url = await started.url;
    if (FORBIDDEN_PORTS.includes(Number(new URL(url).port))) {
      throw new Error(`preview host is on ${url}, a port e2e never uses`);
    }
    process.env.CLAWTRATE_E2E_URL = url;
  } catch (error) {
    if (host) await stopChild(host);
    const problems = cleanUpOnce();
    if (problems.length > 0) console.error(problems.join("\n"));
    throw error;
  }
  return teardown;
}
