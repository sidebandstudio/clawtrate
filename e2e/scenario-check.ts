// `pnpm scenarios`: the scenario check on an instance of its own.
//
// It starts an unseeded instance named like an end-to-end run's, `e2e-<run>`,
// and records it in the same run records as `pnpm e2e` before starting it, so
// a run killed outright is cleaned up by the next `pnpm e2e` or `pnpm
// scenarios` in this checkout. It never uses the default instance or its ports.
// Afterwards it resets exactly that instance, also on Ctrl-C or SIGTERM.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import {
  openCheckClients,
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
  const self = processIdentity(process.pid);
  if (self.state !== "alive") throw new Error("could not determine this process's start time");
  const record: RunRecord = {
    run,
    runner: { pid: process.pid, identity: self.identity },
    instances: [{ name, runId }],
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
  try {
    console.log(`Starting instance ${name} for the scenario check`);
    await new Promise<void>((resolve, reject) => {
      const env = { ...process.env };
      delete env.CLAWTRATE_DEV_INSTANCE;
      const child = spawn(
        process.execPath,
        [CLI, "start", "--no-seed", "--run-id", runId, "--instance", name],
        { cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"] },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`start failed (${code})`)),
      );
    });
    const mine = listInstances().find((row) => row.name === name);
    for (const port of [mine?.gatewayPort, mine?.providerPort]) {
      if (port === null || port === undefined || FORBIDDEN_PORTS.includes(port)) {
        throw new Error(`instance ${name} is on port ${port}, which the check never uses`);
      }
    }
    const inst = openInstance(name);
    const clients = await openCheckClients((label, scopes, caps) =>
      openOperator(inst, label, scopes, caps),
    );
    try {
      const { passed, failed, notes } = await runScenarioChecks(clients);
      for (const note of notes) console.log(`note  ${note}`);
      for (const [kind, fields] of [...UNDECLARED_FIELDS].sort()) {
        console.log(
          `note  ${kind} carries fields its schema does not declare: ${[...fields].sort().join(", ")}`,
        );
      }
      console.log(`${passed} of ${passed + failed} scenario checks passed`);
      return failed === 0 ? 0 : 1;
    } finally {
      for (const op of Object.values(clients)) await op.close();
    }
  } finally {
    const problems = cleanUpOnce();
    if (problems.length > 0) {
      console.error(problems.join("\n"));
      process.exitCode = 1;
    }
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
