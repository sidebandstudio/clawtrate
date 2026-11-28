// #933: a development gateway gets a PATH the tool builds itself, so OpenClaw never finds an agent
// tool of the person running it. OpenClaw asks such a tool for its sign-in when it refreshes its
// model list (`claude auth status --json` for Claude Code); docs/development/dev-gateway.md lists
// what each version looks for. Here a stand-in of each name, first on the caller's PATH, records
// being run: starting the gateway, seeding it and refreshing its model list run none of them.
//
// Its own instance, started in beforeAll and reset in afterAll, recorded first in a run record of
// its own, so a worker killed outright is cleaned up by the next `pnpm e2e`.
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance } from "../tools/dev-gateway/src/cli.ts";
import { STAND_INS_ENV } from "../tools/dev-gateway/src/env.ts";
import { newRunId, ownIdentity } from "../tools/dev-gateway/src/state-guard.ts";
import { listInstances, resetInstance } from "./global-setup.ts";
import { cleanUp, saveRecord, TEMP_PREFIX, type RunRecord } from "./run-record.ts";

const RECORDS = join(import.meta.dirname, "../tools/dev-gateway/.run/e2e");
const CLI = join(import.meta.dirname, "../tools/dev-gateway/src/cli.ts");
const ROOT = join(import.meta.dirname, "..");
const record: RunRecord = {
  run: randomBytes(4).toString("hex"),
  runner: { pid: process.pid, identity: "" },
  instances: [],
  host: null,
  dirs: [],
};
const INSTANCE = `e2e-${record.run}-path`;
/** Every agent tool OpenClaw names, and the ones a developer's computer commonly has. */
const TOOLS = ["claude", "codex", "gemini", "copilot", "opencode"];

let standIns = "";
let ran = "";
let callerPath = "";

/** What the stand-ins recorded: one line per run, the program's name and its arguments. */
const runs = () => (existsSync(ran) ? readFileSync(ran, "utf8").trim() : "");

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(480_000);
  record.runner.identity = ownIdentity();
  const runId = newRunId();
  record.instances.push({ name: INSTANCE, runId });
  standIns = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  record.dirs.push(standIns);
  saveRecord(RECORDS, record);
  ran = join(standIns, "ran.txt");
  for (const tool of TOOLS) {
    const file = join(standIns, tool);
    writeFileSync(file, `#!/bin/sh\nprintf '%s %s\\n' "$0" "$*" >> '${ran}'\nexit 1\n`);
    chmodSync(file, 0o755);
  }
  // The caller's PATH, with the stand-ins first: where a developer's own tools would be.
  callerPath = `${standIns}:${process.env.PATH ?? ""}`;
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: callerPath };
  delete env.CLAWTRATE_DEV_INSTANCE;
  delete env[STAND_INS_ENV];
  // Started and seeded, as every development gateway is.
  process.stdout.write(
    execFileSync(process.execPath, [CLI, "start", "--run-id", runId, "--instance", INSTANCE], {
      cwd: ROOT,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  if (!listInstances().find((row) => row.name === INSTANCE)?.gatewayRunning)
    throw new Error(`instance ${INSTANCE} is not running`);
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  expect(cleanUp(RECORDS, record, resetInstance)).toEqual([]);
});

test("#933: starting, seeding and refreshing the model list run no agent tool on the caller's PATH", async () => {
  test.setTimeout(240_000);
  expect(runs()).toBe("");
  // The refreshes a gateway does when Clawtrate reads accounts and models, asked with the caller's
  // PATH in this process too: each OpenClaw command the tool runs builds its own.
  const saved = process.env.PATH;
  process.env.PATH = callerPath;
  try {
    const runner = openInstance(INSTANCE).runner;
    for (const [method, params] of [
      ["models.authStatus", { refresh: true }],
      ["models.list", {}],
    ] as const) {
      const result = await runner.run([
        "gateway",
        "call",
        method,
        "--params",
        JSON.stringify(params),
        "--json",
      ]);
      expect(result.status, `${method}: ${result.stderr}`).toBe(0);
    }
  } finally {
    process.env.PATH = saved;
  }
  expect(runs()).toBe("");
});
