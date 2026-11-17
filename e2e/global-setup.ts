// Starts what the end-to-end tests need and returns the teardown that stops it.
//
// Every run has its own development gateway instance, named for the run, on
// ports the dev tooling chooses. It never uses the default instance or its
// ports, whether or not something runs there, so runs in several checkouts can
// go at once. Before its own instance it starts an unseeded sentinel instance,
// so there is always another instance's gateway listening while the tests run;
// the tests and the teardown check that it, and every instance that was already
// running, is left as it was. Teardown stops everything by PID and removes both
// instances' state, also when setup or a test fails.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "tools/dev-gateway/src/cli.ts");
/** The default instance's ports and the web preview's. An e2e run uses none of them. */
export const FORBIDDEN_PORTS = [19001, 19091, 5310];

export type ListedInstance = {
  name: string | null;
  stateDir: string;
  gatewayPort: number | null;
  providerPort: number | null;
  gatewayPid: number | null;
  gatewayRunning: boolean;
};

export function devGateway(instance: string | null, ...args: string[]): string {
  const flags = instance === null ? [] : ["--instance", instance];
  // The instance is named by the flag alone, never inherited from the environment.
  const env = { ...process.env };
  delete env.CLAWTRATE_DEV_INSTANCE;
  return execFileSync(process.execPath, [CLI, ...args, ...flags], {
    cwd: ROOT,
    env,
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

  const staticDir = mkdtempSync(join(tmpdir(), "clawtrate-e2e-web-"));
  const dataDir = mkdtempSync(join(tmpdir(), "clawtrate-e2e-"));
  let host: ChildProcess | null = null;
  const alreadyRunning = runningOthers(own);

  const teardown = async () => {
    const problems: string[] = [];
    if (host) await stopChild(host);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(staticDir, { recursive: true, force: true });
    for (const instance of own) {
      try {
        // Stops this checkout's processes for the instance by PID, then removes its folder.
        devGateway(instance, "reset");
      } catch (error) {
        problems.push(`reset ${instance}: ${String(error)}`);
      }
    }
    devGateway(null, "prune");
    const after = runningOthers(own);
    const gone = alreadyRunning.filter((row) => !after.includes(row));
    if (gone.length > 0) problems.push(`instances that were running changed: ${gone.join(", ")}`);
    if (listInstances().some((row) => row.name !== null && own.includes(row.name))) {
      problems.push("this run's instance folders were not removed");
    }
    if (problems.length > 0) throw new Error(problems.join("\n"));
  };

  try {
    // Another instance's gateway is listening before this run's starts.
    devGateway(sentinel, "start", "--no-seed");
    process.env.CLAWTRATE_E2E_OTHERS = JSON.stringify(runningOthers([name], [sentinel]));
    // Every start is a fresh, seeded gateway.
    devGateway(name, "start");
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
    const started = startHost(name, staticDir, dataDir);
    host = started.host;
    const url = await started.url;
    if (FORBIDDEN_PORTS.includes(Number(new URL(url).port))) {
      throw new Error(`preview host is on ${url}, a port e2e never uses`);
    }
    process.env.CLAWTRATE_E2E_URL = url;
  } catch (error) {
    await teardown().catch((cleanup: unknown) => console.error(String(cleanup)));
    throw error;
  }
  return teardown;
}
