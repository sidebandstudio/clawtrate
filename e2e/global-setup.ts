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

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatedSpawn, type Gated } from "../tools/dev-gateway/src/env.ts";
import {
  newRunId,
  ownIdentity,
  processIdentity,
  processState,
} from "../tools/dev-gateway/src/state-guard.ts";
import { cleanUp, recoverDeadRuns, saveRecord, TEMP_PREFIX, type RunRecord } from "./run-record.ts";

export const ROOT = join(import.meta.dirname, "..");
export const CLI = join(ROOT, "tools/dev-gateway/src/cli.ts");
/** Run records of this checkout's end-to-end runs. Git-ignored. */
const RECORDS = join(ROOT, "tools/dev-gateway/.run/e2e");
import { STATE_FILE } from "../packages/core/src/node/secure.ts";
import { FORBIDDEN_PORTS } from "./ports.ts";
export { FORBIDDEN_PORTS } from "./ports.ts";

export type ListedInstance = {
  name: string | null;
  stateDir: string;
  gatewayPort: number | null;
  providerPort: number | null;
  gatewayPid: number | null;
  gatewayRunning: boolean;
  gatewayState: "none" | "dead" | "alive" | "unknown";
};

export function cliEnv(): NodeJS.ProcessEnv {
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
        // A gateway that cannot be checked counts as running: it must be left alone too.
        (row.gatewayState === "alive" || row.gatewayState === "unknown") &&
        (row.name === null ||
          (!own.includes(row.name) && (!row.name.startsWith("e2e-") || keep.includes(row.name)))),
    )
    .map(
      (row) =>
        `${row.name ?? "(default)"} pid ${row.gatewayPid} ports ${row.gatewayPort}/${row.providerPort}`,
    )
    .sort();
}

/**
 * Reset one of this run's instances, only if it still holds the run this run
 * gave it. A reset that fails throws with everything it printed, so a failed
 * teardown says what kept the instance.
 */
export const resetInstance = (name: string, runId: string) => {
  const args = ["reset", "--run-id", runId, "--instance", name];
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: cliEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const printed = [result.stdout, result.stderr]
      .map((text) => (text ?? "").trim())
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `dev-gateway ${args.join(" ")} failed (${result.error?.message ?? result.status ?? result.signal})` +
        (printed ? `:\n${printed}` : " and printed nothing"),
    );
  }
};

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Stop a child we started: SIGTERM, a bounded wait, then SIGKILL. */
export async function stopChild(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  if (!child.kill("SIGTERM")) return;
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<"timeout">((resolve) => {
    handle = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const outcome = await Promise.race([exited, timer]);
  clearTimeout(handle);
  if (outcome === "timeout" && child.exitCode === null && child.signalCode === null) {
    if (!child.kill("SIGKILL")) return;
    await exited;
  }
}

/** The host's kept "Show the gateway's own bot", turned on unless it already holds a choice. */
function showGatewayBot(dataDir: string): void {
  const file = join(dataDir, STATE_FILE);
  const kept = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>)
    : {};
  if ("show-gateway-bot" in kept) return;
  writeFileSync(file, `${JSON.stringify({ ...kept, "show-gateway-bot": "true" }, null, 2)}\n`, {
    mode: 0o600,
  });
}

/**
 * The preview host, spawned behind a gate so it cannot run before it is
 * recorded. A test that quits and restarts a client starts its own with this,
 * on its own copy of the host's data, and stops it by its process.
 *
 * Unless `gatewayBot: "default"`, a host with no choice of its own starts with "Show the
 * gateway's own bot" on (F-562): the checks of other flows work on Juniper, the development
 * gateway's own bot. `e2e/gateway-bot.spec.ts` checks the default.
 */
export function startHost(
  instance: string,
  staticDir: string,
  dataDir: string,
  options: {
    readOnly?: boolean;
    env?: Record<string, string>;
    gatewayBot?: "shown" | "default";
  } = {},
) {
  if (options.gatewayBot !== "default") showGatewayBot(dataDir);
  const gated: Gated = gatedSpawn(
    spawn,
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
      // A host pinned to the read tier: it never asks for more access.
      ...(options.readOnly ? ["--read-only"] : []),
    ],
    // The instance is named by the flag alone, never inherited from the environment.
    { cwd: ROOT, env: { ...cliEnv(), ...options.env }, stdio: ["ignore", "pipe", "inherit"] },
  );
  const host = gated.child;
  const url = new Promise<string>((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`preview host did not start:\n${output}`))),
      20_000,
    );
    host.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = /Local\s+(http:\/\/\S+)/.exec(output);
      if (match) finish(() => resolve(match[1]!.replace("localhost", "127.0.0.1")));
    });
    host.once("error", (error) =>
      finish(() => reject(new Error(`preview host failed to spawn: ${error.message}`))),
    );
    host.once("exit", (code, signal) =>
      finish(() => reject(new Error(`preview host exited with ${code ?? signal}:\n${output}`))),
    );
  });
  return { host, url, gated };
}

export default async function globalSetup() {
  const run = process.env.CLAWTRATE_E2E_RUN ?? randomBytes(4).toString("hex");
  if (!/^[0-9a-f]{8}$/.test(run)) throw new Error(`CLAWTRATE_E2E_RUN must be 8 hex digits`);
  const name = `e2e-${run}`;
  const sentinel = `e2e-${run}-other`;
  // An instance only some specs use is started by those specs, only where they run: the accounts
  // instance by e2e/accounts-instance.ts, and the Computer tab's, bot voice's and others' by their
  // own spec files.
  const own = [name, sentinel];
  // The spec's own dev-gateway calls address this run's instance.
  process.env.CLAWTRATE_DEV_INSTANCE = name;
  process.env.CLAWTRATE_E2E_SENTINEL = sentinel;

  recoverDeadRuns(RECORDS, resetInstance);

  // Registered before anything is started.
  const record: RunRecord = {
    run,
    runner: { pid: process.pid, identity: ownIdentity() },
    instances: [],
    host: null,
    dirs: [],
  };
  saveRecord(RECORDS, record);
  let child: ChildProcess | null = null;
  let host: ChildProcess | null = null;
  let cleaned: string[] | null = null;
  const cleanUpOnce = (): string[] => {
    if (cleaned) return cleaned;
    // A dev-gateway command still running is ended first; the reset below
    // waits for the instance's lock, which that command holds until it exits.
    if (child && child.exitCode === null && child.signalCode === null) {
      const found = processIdentity(child.pid!);
      child.kill("SIGTERM");
      // Wait, synchronously, until it has exited: the reset must not see it running.
      if (found.state === "alive") {
        const deadline = Date.now() + 15_000;
        while (
          processState(child.pid, found.identity, processIdentity) === "alive" &&
          Date.now() < deadline
        ) {
          sleepSync(100);
        }
      }
    }
    cleaned = cleanUp(RECORDS, record, resetInstance);
    return cleaned;
  };
  const onSignal = (signal: NodeJS.Signals) => {
    const problems = cleanUpOnce();
    if (problems.length > 0) console.error(problems.join("\n"));
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", () => {
    const first = cleaned === null;
    const problems = cleanUpOnce();
    // Said only when nothing cleaned up before, and written at once: the process ends next.
    if (first && problems.length > 0) sayNow(`${problems.join("\n")}\n`);
  });

  /** A dev-gateway command, run so that signals are handled while it runs. */
  const cli = (instance: string, ...args: string[]) =>
    new Promise<void>((resolve, reject) => {
      if (cleaned) return reject(new Error("the run was interrupted"));
      child = spawn(process.execPath, [CLI, ...args, "--instance", instance], {
        cwd: ROOT,
        env: {
          ...cliEnv(),
          ...(args.includes("clawtrate-memory") ? { FS_SAFE_NATIVE_MODE: "require" } : {}),
        },
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
    saveRecord(RECORDS, record);
    return cli(instance, "start", "--run-id", runId, ...flags);
  };
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
    record.dirs.push(dir);
    saveRecord(RECORDS, record);
    return dir;
  };

  const alreadyRunning = runningOthers(own);
  const teardown = async () => {
    if (host) await stopChild(host);
    const problems = [...cleanUpOnce()];
    const after = runningOthers(own);
    const gone = alreadyRunning.filter((row) => !after.includes(row));
    // The default instance is this run's to leave alone. Another named instance belongs
    // to other work on the machine and may stop or restart during a run, as the packaged
    // check already allows; the sentinel proves this run touches no instance but its own.
    const guarded = gone.filter((row) => row.startsWith("(default) "));
    if (guarded.length > 0) {
      problems.push(`instances that were running changed: ${guarded.join(", ")}`);
    }
    const others = gone.filter((row) => !row.startsWith("(default) "));
    if (others.length > 0) {
      console.log(`Note: other instances changed during the run, not by it: ${others.join(", ")}`);
    }
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
    // With the stand-in image provider, for the pictures a bot makes (e2e/ui-pictures.spec.ts).
    await startInstance(
      name,
      "--with-plugin",
      "clawtrate-memory",
      "--with-images",
      "--with-message-tool",
    );
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
    record.hostPending = true;
    saveRecord(RECORDS, record);
    const started = startHost(name, staticDir, dataDir);
    host = started.host;
    const found = processIdentity(host.pid!);
    if (found.state !== "alive") {
      started.url.catch(() => {});
      started.gated.abort();
      throw new Error("could not record the preview host");
    }
    record.host = { pid: host.pid!, identity: found.identity };
    delete record.hostPending;
    saveRecord(RECORDS, record);
    started.gated.release();
    const url = await started.url;
    if (FORBIDDEN_PORTS.includes(Number(new URL(url).port))) {
      throw new Error(`preview host is on ${url}, a port e2e never uses`);
    }
    process.env.CLAWTRATE_E2E_URL = url;
    // For a test that runs a second client host from the same build and a copy of this one's data.
    process.env.CLAWTRATE_E2E_STATIC = staticDir;
    process.env.CLAWTRATE_E2E_DATA = dataDir;
  } catch (error) {
    if (host) await stopChild(host);
    const problems = cleanUpOnce();
    if (problems.length > 0) console.error(problems.join("\n"));
    throw error;
  }
  return teardown;
}

/**
 * Writes to standard error before the process ends. A short write is finished;
 * a closed or full standard error loses the text, never the run's exit code.
 */
function sayNow(text: string): void {
  const bytes = Buffer.from(text);
  try {
    for (let at = 0; at < bytes.length;) at += writeSync(2, bytes, at);
  } catch {
    // Nobody is reading what is left.
  }
}
