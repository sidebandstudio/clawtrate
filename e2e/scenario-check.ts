// `pnpm scenarios`: the scenario check on an instance of its own.
//
// It starts an unseeded instance named like an end-to-end run's, `e2e-<run>`,
// and records it in the same run records as `pnpm e2e` before starting it, so
// a run killed outright is cleaned up by the next `pnpm e2e` or `pnpm
// scenarios` in this checkout. It never uses the default instance or its ports.
// Afterwards it resets exactly that instance, also on Ctrl-C or SIGTERM.
//
// Then the computer checks (computer-checks.ts) run on a second instance,
// `e2e-<run>-computer`, started with `--with-plugin clawtrate-computer`,
// whose bots Marlow and Pip have browsers of their own; it is recorded and
// reset the same way.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  browserPorts,
  instancePorts,
  openInstance,
  openOperator,
} from "../tools/dev-gateway/src/cli.ts";
import {
  COMPUTER_CLIENTS,
  runComputerChecks,
  type ComputerClient,
} from "../tools/dev-gateway/src/computer-checks.ts";
import { loadDevPlugin } from "../tools/dev-gateway/src/dev-plugins.ts";
import { PLUGIN_RULE } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import {
  openCheckClients,
  FAMILY_ROWS,
  ownerAgent,
  runScenarioChecks,
  UNDECLARED_FIELDS,
} from "../tools/dev-gateway/src/scenario-check.ts";
import { newRunId, processIdentity } from "../tools/dev-gateway/src/state-guard.ts";
import { FORBIDDEN_PORTS, devGateway, listInstances } from "./global-setup.ts";
import { cleanUp, recoverDeadRuns, saveRecord, type RunRecord } from "./run-record.ts";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "tools/dev-gateway/src/cli.ts");
const RECORDS = join(ROOT, "tools/dev-gateway/.run/e2e");
const reset = (name: string, runId: string) => void devGateway(name, "reset", "--run-id", runId);

async function main(): Promise<number> {
  recoverDeadRuns(RECORDS, reset);
  const run = randomBytes(4).toString("hex");
  const name = `e2e-${run}`;
  const runId = newRunId();
  const computerName = `${name}-computer`;
  const computerRunId = newRunId();
  const self = processIdentity(process.pid);
  if (self.state !== "alive") throw new Error("could not determine this process's start time");
  const record: RunRecord = {
    run,
    runner: { pid: process.pid, identity: self.identity },
    instances: [
      { name, runId },
      { name: computerName, runId: computerRunId },
    ],
    host: null,
    dirs: [],
  };
  saveRecord(RECORDS, record);
  let cleaned = false;
  const cleanUpOnce = () => {
    if (cleaned) return [];
    cleaned = true;
    return cleanUp(RECORDS, record, reset);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      const problems = cleanUpOnce();
      if (problems.length > 0) console.error(problems.join("\n"));
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
  const startInstance = (instance: string, id: string, extra: string[] = []) =>
    new Promise<void>((resolve, reject) => {
      const env = { ...process.env };
      delete env.CLAWTRATE_DEV_INSTANCE;
      const child = spawn(
        process.execPath,
        [CLI, "start", "--no-seed", "--run-id", id, "--instance", instance, ...extra],
        { cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"] },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`start failed (${code})`)),
      );
    });
  try {
    console.log(`Starting instance ${name} for the scenario check`);
    await startInstance(name, runId);
    const mine = listInstances().find((row) => row.name === name);
    for (const port of [mine?.gatewayPort, mine?.providerPort]) {
      if (port === null || port === undefined || FORBIDDEN_PORTS.includes(port)) {
        throw new Error(`instance ${name} is on port ${port}, which the check never uses`);
      }
    }
    const inst = openInstance(name);
    let scenariosFailed = 0;
    const clients = await openCheckClients((label, scopes, caps) =>
      openOperator(inst, label, scopes, caps),
    );
    try {
      const { passed, failed, notes } = await runScenarioChecks(clients, {
        ownerAgent: (botId, key, message) => ownerAgent(inst, botId, key, message),
        providerUrl: `http://127.0.0.1:${instancePorts(inst).providerPort}`,
      });
      for (const row of FAMILY_ROWS) console.log(`family ${JSON.stringify(row)}`);
      for (const note of notes) console.log(`note  ${note}`);
      for (const [kind, fields] of [...UNDECLARED_FIELDS].sort()) {
        console.log(
          `note  ${kind} carries fields its schema does not declare: ${[...fields].sort().join(", ")}`,
        );
      }
      console.log(`${passed} of ${passed + failed} scenario checks passed`);
      scenariosFailed = failed;
    } finally {
      for (const op of Object.values(clients)) await op.close();
    }
    const computer = await computerChecks(computerName, computerRunId, startInstance);
    return scenariosFailed === 0 && computer === 0 ? 0 : 1;
  } finally {
    const problems = cleanUpOnce();
    if (problems.length > 0) {
      console.error(problems.join("\n"));
      process.exitCode = 1;
    }
  }
}

/** Start the computer instance, run the computer checks on it, and return how many failed. */
async function computerChecks(
  name: string,
  runId: string,
  startInstance: (instance: string, id: string, extra: string[]) => Promise<void>,
): Promise<number> {
  const declaration = loadDevPlugin("clawtrate-computer", ROOT, PLUGIN_RULE).botBrowsers;
  if (!declaration) throw new Error("clawtrate-computer declares no bot browsers");
  console.log(`Starting instance ${name} for the computer checks`);
  await startInstance(name, runId, ["--with-plugin", "clawtrate-computer"]);
  const inst = openInstance(name);
  const ports = instancePorts(inst);
  const { pagesPort, botCdpPorts } = browserPorts(ports, declaration.bots);
  for (const port of [ports.gatewayPort, ports.providerPort, pagesPort, ...botCdpPorts]) {
    if (FORBIDDEN_PORTS.includes(port)) {
      throw new Error(`instance ${name} is on port ${port}, which the check never uses`);
    }
  }
  const clients: Partial<Record<ComputerClient, OperatorSession>> = {};
  try {
    for (const [client, { scopes, caps }] of Object.entries(COMPUTER_CLIENTS)) {
      clients[client as ComputerClient] = await openOperator(
        inst,
        `Clawtrate computer check (${client})`,
        [...scopes],
        [...caps],
      );
    }
    // Pip acts first; Marlow is the second bot whose browser Pip's session must not see.
    const order = ["pip", "marlow"].filter((bot) => declaration.bots.includes(bot));
    const { passed, failed } = await runComputerChecks({
      clients: clients as Record<ComputerClient, OperatorSession>,
      openExtra: (label) =>
        openOperator(inst, label, ["operator.read", "operator.write"], ["tool-events"]),
      gatewayPort: ports.gatewayPort,
      pagesOrigin: `http://127.0.0.1:${pagesPort}`,
      bots: order.map((id) => ({ id, cdpPort: botCdpPorts[declaration.bots.indexOf(id)]! })),
      renewTimeoutMs: declaration.renewTimeoutMs,
      drainTimeoutMs: declaration.drainTimeoutMs,
    });
    console.log(`${passed} of ${passed + failed} computer checks passed`);
    return failed;
  } finally {
    for (const op of Object.values(clients)) await op.close();
  }
}

main().then(
  (code) => {
    process.exitCode ||= code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
