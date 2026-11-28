// #933: a development gateway never runs an agent tool of the person running it. OpenClaw asks
// such a tool for its sign-in when it refreshes its model list (`claude auth status --json` for
// Claude Code), and at start it adds the folders people install tools into (`~/.local/bin`,
// `~/.npm-global/bin`, pnpm's, bun's and yarn's) to the end of its PATH unless told its PATH is
// set; docs/development/dev-gateway.md lists what each version looks for and where. Here a
// tripwire of each agent tool's name records being run, first on the caller's PATH and in each of
// those folders under a home folder the test gives the tool: starting the gateway, seeding it and
// refreshing its model list run none of them.
//
// Its own instance, started in beforeAll and reset in afterAll, recorded first in a run record of
// its own, so a worker killed outright is cleaned up by the next `pnpm e2e`.
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance } from "../tools/dev-gateway/src/cli.ts";
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
/** The agent tools OpenClaw runs by name, and those of the coding-agent harnesses it can start. */
const TOOLS = [
  ...["agent", "claude", "codex", "copilot", "cursor-agent", "droid", "gemini", "grok"],
  ...["kimi", "kiro-cli", "opencode", "qwen"],
];
/**
 * The folders under the home that OpenClaw 2026.10.6 and 2026.11.10 add to a gateway's PATH
 * (`ensureOpenClawCliOnPath`), and where Claude Code's resolver looks when `claude` is on no PATH.
 */
const HOME_BIN_DIRS = [
  ".local/bin",
  ".npm-global/bin",
  ".local/share/pnpm",
  ".local/share/pnpm/bin",
  ".bun/bin",
  ".yarn/bin",
  "Library/pnpm",
  "Library/pnpm/bin",
  "Library/Application Support/Claude/claude-code/9.9.9/claude.app/Contents/MacOS",
];

let home = "";
let ran = "";
let callerPath = "";
let savedHome: string | undefined;

/** What the tripwires recorded: one line per run, the program and its arguments. */
const runs = () => (existsSync(ran) ? readFileSync(ran, "utf8").trim() : "");

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(480_000);
  record.runner.identity = ownIdentity();
  const runId = newRunId();
  record.instances.push({ name: INSTANCE, runId });
  // The home folder the tool runs with, and so the gateway: its state goes there too.
  home = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  record.dirs.push(home);
  saveRecord(RECORDS, record);
  ran = join(home, "ran.txt");
  const tripwire = `#!/bin/sh\nprintf '%s %s\\n' "$0" "$*" >> '${ran}'\nexit 1\n`;
  for (const dir of ["caller-bin", ...HOME_BIN_DIRS]) {
    mkdirSync(join(home, dir), { recursive: true });
    for (const tool of TOOLS) {
      writeFileSync(join(home, dir, tool), tripwire);
      chmodSync(join(home, dir, tool), 0o755);
    }
  }
  // The caller's PATH, with tripwires first: where a developer's own tools would be.
  callerPath = `${join(home, "caller-bin")}:${process.env.PATH ?? ""}`;
  savedHome = process.env.HOME;
  // This process's own calls to the tool (listing, resetting, the runner below) use it too.
  process.env.HOME = home;
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: callerPath };
  delete env.CLAWTRATE_DEV_INSTANCE;
  // Started and seeded, as every development gateway is.
  process.stdout.write(
    execFileSync(process.execPath, [CLI, "start", "--run-id", runId, "--instance", INSTANCE], {
      cwd: ROOT,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  const row = listInstances().find((entry) => entry.name === INSTANCE);
  if (!row?.gatewayRunning) throw new Error(`instance ${INSTANCE} is not running`);
  if (!row.stateDir.startsWith(`${home}/`))
    throw new Error(`instance ${INSTANCE} is not in the test's home: ${row.stateDir}`);
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  try {
    // Stopped and removed while its home is there (a reset takes its lock in the home), then
    // dropped from the record, so the home goes with the run's folders and nothing is reset twice.
    const { runId } = record.instances[0]!;
    resetInstance(INSTANCE, runId);
    record.instances = [];
    saveRecord(RECORDS, record);
    expect(cleanUp(RECORDS, record, resetInstance)).toEqual([]);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("#933: starting, seeding and refreshing the model list run no agent tool of the person's", async () => {
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
