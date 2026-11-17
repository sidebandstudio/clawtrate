// Development gateway control.
//
//   pnpm dev-gateway start     a fresh, seeded gateway: stop the tool's own gateway,
//                              delete its state, create it again empty, configure,
//                              start the scripted model and `openclaw --dev gateway run`,
//                              then seed the sample bots and conversations
//   pnpm dev-gateway up        the same as start
//   pnpm dev-gateway seed      seed the running gateway again (verifies what exists)
//   pnpm dev-gateway approve   approve pending Clawtrate pairing requests
//   pnpm dev-gateway status    show what is running
//   pnpm dev-gateway stop      stop the processes this tool started
//   pnpm dev-gateway reset     stop, then delete the tool's own ~/.openclaw-dev
//
// State is never reused: OpenClaw keeps credentials in SQLite stores that a
// clean profile also has, so only a folder created empty by this start is safe.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ForeignStateError,
  isAlive,
  newRunId,
  ownership,
  prepareFreshState,
  readRunRecord,
  recordGateway,
  type RunRecord,
} from "./state-guard.ts";
import {
  CONNECTION_FILE,
  DEV_CONFIG_PATH,
  DEV_STATE_DIR,
  GATEWAY_PORT,
  GATEWAY_URL,
  MODEL_ID,
  MODEL_REF,
  PROVIDER_ID,
  PROVIDER_PORT,
  RUN_DIR,
  STATE_FILE,
  assertDevStateDir,
  defaultRunner,
  parseJsonOutput,
  providerEnv,
  type OpenclawRunner,
} from "./env.ts";
import {
  SEED_BOTS,
  sessionKeyFor,
  type SeedBot,
  type SeedTask,
  type SeedTurn,
} from "./seed-data.ts";
import { spawn, spawnSync } from "node:child_process";

export type DevConnection = { url: string; token: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function assertInside(path: string, dir: string): void {
  const rel = relative(dir, path);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`refusing to write outside ${dir}: ${path}`);
}

function readState(): RunRecord | null {
  return readRunRecord(STATE_FILE);
}

function writeState(state: RunRecord): void {
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

export function readDevConnection(path = CONNECTION_FILE): DevConnection | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as DevConnection;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitFor(label: string, check: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** The config the development gateway runs with. Written fresh by every start. */
export function devConfig(token: string) {
  return {
    gateway: {
      mode: "local",
      port: GATEWAY_PORT,
      bind: "loopback",
      auth: { mode: "token", token },
      // Require explicit approval even on loopback, so the pairing flow is real.
      nodes: { pairing: { autoApproveLocal: false } },
    },
    discovery: { mdns: { mode: "off" } },
    update: { checkOnStart: false },
    models: {
      // Only the scripted provider exists; no ambient or bundled providers are merged in.
      mode: "replace",
      providers: {
        [PROVIDER_ID]: {
          baseUrl: `http://127.0.0.1:${PROVIDER_PORT}/v1`,
          api: "openai-completions",
          apiKey: "scripted-dev-provider",
          models: [
            {
              id: MODEL_ID,
              name: "Scripted dev model",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 8192,
            },
          ],
        },
      },
    },
    agents: {
      defaults: { model: { primary: MODEL_REF }, thinkingDefault: "low" },
    },
    tools: {
      // Offer tools directly instead of behind tool_search/tool_call wrappers,
      // so scripted tool calls name the real tool.
      toolSearch: false,
      // With no policy the gateway runs model shell commands without asking.
      // This global policy is inherited by every bot without its own override,
      // including bots created later; the scripted model never needs a shell.
      exec: { mode: "deny" },
    },
    // Memory search is outside `models` and defaults to a hosted embeddings
    // provider. Off, with no provider, so nothing can reach a paid API.
    memory: { search: { enabled: false, provider: "none" } },
    plugins: {
      entries: { "memory-core": { config: { dreaming: { enabled: false } } } },
    },
  };
}

type JsonRecord = Record<string, unknown>;
const at = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((node, key) => (node as JsonRecord | undefined)?.[key], value);

/**
 * The guarantees the development gateway must keep: only the scripted model,
 * no memory-search embeddings, and no shell for the model. Returns what is wrong.
 */
export function sandboxProblems(config: unknown): string[] {
  const problems: string[] = [];
  if (at(config, "models", "mode") !== "replace") problems.push('models.mode must be "replace"');
  const providers = Object.keys(
    (at(config, "models", "providers") as JsonRecord | undefined) ?? {},
  );
  if (providers.length !== 1 || providers[0] !== PROVIDER_ID) {
    problems.push(`models.providers must contain only "${PROVIDER_ID}"`);
  }
  const baseUrl = at(config, "models", "providers", PROVIDER_ID, "baseUrl");
  if (typeof baseUrl !== "string" || !baseUrl.startsWith("http://127.0.0.1:")) {
    problems.push("the scripted provider must be on loopback");
  }
  if (at(config, "memory", "search", "enabled") !== false)
    problems.push("memory.search.enabled must be false");
  if (at(config, "tools", "exec", "mode") !== "deny")
    problems.push('tools.exec.mode must be "deny"');
  if (at(config, "tools", "exec", "security") !== "deny")
    if (
      at(config, "tools", "exec", "security") !== undefined ||
      at(config, "tools", "exec", "ask") !== undefined
    ) {
      // A legacy security/ask pair would replace the mode instead of deriving from it.
      problems.push("tools.exec must set only mode, not security or ask");
    }
  for (const [id, entry] of Object.entries(
    (at(config, "agents", "entries") as JsonRecord | undefined) ?? {},
  )) {
    const exec = at(entry, "tools", "exec") as JsonRecord | undefined;
    if (
      exec &&
      (exec.mode !== undefined || exec.security !== undefined || exec.ask !== undefined)
    ) {
      problems.push(`agents.entries.${id}.tools.exec overrides the global exec policy`);
    }
    if (at(entry, "memory", "search", "enabled") === true) {
      problems.push(`agents.entries.${id}.memory.search re-enables memory search`);
    }
  }
  if (at(config, "gateway", "bind") !== "loopback")
    problems.push('gateway.bind must be "loopback"');
  return problems;
}

function assertSandboxed(): void {
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(DEV_CONFIG_PATH, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read ${DEV_CONFIG_PATH}: ${String(error)}. Run \`pnpm dev-gateway reset\`.`,
      { cause: error },
    );
  }
  const problems = sandboxProblems(config);
  if (problems.length > 0) {
    throw new Error(
      `the development gateway config is not sandboxed:\n  - ${problems.join("\n  - ")}\nRun \`pnpm dev-gateway reset\` to recreate it.`,
    );
  }
}

/** Write a new config and bootstrap token into the state folder `start` just created. */
function writeFreshConfig(runner: OpenclawRunner): DevConnection {
  const token = randomBytes(24).toString("base64url");
  writeFileSync(DEV_CONFIG_PATH, `${JSON.stringify(devConfig(token), null, 2)}\n`, { mode: 0o600 });
  const connection = { url: GATEWAY_URL, token };
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(CONNECTION_FILE, `${JSON.stringify(connection, null, 2)}\n`, { mode: 0o600 });
  const validation = runner.runSync(["config", "validate"]);
  if (validation.status !== 0) {
    throw new Error(`generated config is invalid:\n${validation.stdout}${validation.stderr}`);
  }
  return connection;
}

/** Healthy means the guard allows OpenClaw and the gateway answers; a refusal spawns nothing. */
async function gatewayHealthy(runner: OpenclawRunner = defaultRunner): Promise<boolean> {
  if (runner.refusal()) return false;
  if (!(await portOpen(GATEWAY_PORT))) return false;
  const result = await runner.run(["gateway", "call", "health", "--json", "--timeout", "3000"]);
  return result.status === 0;
}

type ExecScope = { agentId?: string; security?: { effective?: string } };

/** Ask the running gateway what exec policy each bot actually gets. */
export async function execPolicyProblems(): Promise<string[]> {
  const snapshot = parseJsonOutput<{ effectivePolicy?: { scopes?: ExecScope[] } }>(
    await must(["approvals", "get", "--json"]),
  );
  const scopes = snapshot.effectivePolicy?.scopes ?? [];
  if (scopes.length === 0) return ["the gateway reported no exec policy scopes"];
  return scopes
    .filter((scope) => scope.security?.effective !== "deny")
    .map(
      (scope) =>
        `exec security for ${scope.agentId ?? "?"} is ${scope.security?.effective ?? "unknown"}`,
    );
}

async function assertExecDenied(): Promise<void> {
  const problems = await execPolicyProblems();
  if (problems.length > 0) throw new Error(`exec is not denied:\n  - ${problems.join("\n  - ")}`);
}

/**
 * The only way to start the gateway: on a state folder this command has just
 * created empty. The tool's own gateway is stopped and its state deleted first;
 * foreign state is refused untouched. Ends with a seeded, verified gateway.
 */
export async function start(): Promise<void> {
  assertDevStateDir(DEV_STATE_DIR);
  if (ownership(DEV_STATE_DIR) === "foreign") throw new ForeignStateError(DEV_STATE_DIR);
  await stop();
  if (await portOpen(GATEWAY_PORT)) {
    throw new Error(`port ${GATEWAY_PORT} is in use by a process this tool did not start`);
  }
  if (await portOpen(PROVIDER_PORT)) {
    throw new Error(`port ${PROVIDER_PORT} is in use by a process this tool did not start`);
  }
  const runner = defaultRunner;
  const runId = newRunId();
  prepareFreshState(DEV_STATE_DIR, runId);
  runner.freshRunId = runId;
  try {
    writeFreshConfig(runner);
    assertSandboxed();
    mkdirSync(RUN_DIR, { recursive: true });

    const providerLog = openSync(join(RUN_DIR, "provider.log"), "w");
    const provider = spawn(
      process.execPath,
      [fileURLToPath(new URL("./provider-main.ts", import.meta.url))],
      {
        detached: true,
        stdio: ["ignore", providerLog, providerLog],
        env: providerEnv(),
      },
    );
    provider.unref();
    closeSync(providerLog);
    writeState({ runId, providerPid: provider.pid, startedAt: new Date().toISOString() });
    await waitFor("the scripted provider", () => portOpen(PROVIDER_PORT), 10_000);

    const gatewayLog = openSync(join(RUN_DIR, "gateway.log"), "w");
    const gateway = runner.spawnDetached(
      ["gateway", "run", "--port", String(GATEWAY_PORT), "--bind", "loopback"],
      { stdio: ["ignore", gatewayLog, gatewayLog] },
    );
    gateway.unref();
    closeSync(gatewayLog);
    writeState({
      runId,
      providerPid: provider.pid,
      gatewayPid: gateway.pid,
      startedAt: new Date().toISOString(),
    });
    recordGateway(DEV_STATE_DIR, runId, { gatewayPid: gateway.pid!, providerPid: provider.pid! });
  } finally {
    // From here on OpenClaw runs only while this start's gateway is alive.
    runner.freshRunId = null;
  }
  await waitFor("the development gateway", () => gatewayHealthy(runner), 90_000);
  await assertExecDenied();
  const record = readState();
  console.log(`Development gateway ready on ${GATEWAY_URL}`);
  console.log(
    `  scripted model  http://127.0.0.1:${PROVIDER_PORT}/v1 (pid ${record?.providerPid})`,
  );
  console.log(`  gateway         pid ${record?.gatewayPid}, logs in ${RUN_DIR}`);
  await seed();
}

/** Direct children of a process we started, so none outlive it. */
function childPids(pid: number): number[] {
  const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  return result.stdout
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((child) => Number.isInteger(child) && child > 0);
}

async function stopPid(pid: number, label: string): Promise<void> {
  if (!isAlive(pid)) return;
  const children = childPids(pid);
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 15_000;
  while (isAlive(pid) && Date.now() < deadline) await sleep(200);
  if (isAlive(pid)) {
    process.kill(pid, "SIGKILL");
    console.log(`Stopped ${label} (pid ${pid}) after a forced kill`);
  } else {
    console.log(`Stopped ${label} (pid ${pid})`);
  }
  for (const child of children) {
    if (isAlive(child)) {
      process.kill(child, "SIGTERM");
      console.log(`Stopped a leftover child of ${label} (pid ${child})`);
    }
  }
}

export async function stop(): Promise<void> {
  const state = readState();
  if (!state) {
    console.log("Nothing to stop: this tool has no running processes on record.");
    return;
  }
  if (state.gatewayPid) await stopPid(state.gatewayPid, "development gateway");
  if (state.providerPid) await stopPid(state.providerPid, "scripted provider");
  rmSync(STATE_FILE, { force: true });
}

/** Stop, then delete the state folder if it is the tool's own. Foreign state is left alone. */
export async function reset(): Promise<void> {
  assertDevStateDir(DEV_STATE_DIR);
  const owner = ownership(DEV_STATE_DIR);
  if (owner === "foreign") throw new ForeignStateError(DEV_STATE_DIR);
  await stop();
  rmSync(CONNECTION_FILE, { force: true });
  if (owner === "owned") {
    rmSync(DEV_STATE_DIR, { recursive: true });
    console.log(`Removed ${DEV_STATE_DIR}`);
  }
}

/** Report what is running. OpenClaw is asked only when the guard allows it. */
export async function status(
  runner: OpenclawRunner = defaultRunner,
  log: (line: string) => void = console.log,
): Promise<void> {
  const record = readRunRecord(runner.runFile);
  const connection = readDevConnection(join(dirname(runner.runFile), "connection.json"));
  const owner = ownership(runner.stateDir);
  log(`state dir   ${runner.stateDir} (${owner})`);
  log(
    `provider    ${record?.providerPid && isAlive(record.providerPid) ? `running, pid ${record.providerPid}` : "stopped"}`,
  );
  log(
    `gateway     ${record?.gatewayPid && isAlive(record.gatewayPid) ? `running, pid ${record.gatewayPid}` : "stopped"}`,
  );
  const refusal = runner.refusal();
  if (refusal) log(`healthy     no (not checked: ${refusal})`);
  else log(`healthy     ${(await gatewayHealthy(runner)) ? "yes" : "no"}`);
  if (connection) log(`url         ${connection.url}`);
}

async function must(args: string[]): Promise<string> {
  const result = await defaultRunner.run(args);
  if (result.status !== 0) {
    throw new Error(`openclaw --dev ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

type AgentRow = { id: string; workspace?: string };

async function existingSessionKeys(botId: string): Promise<Set<string>> {
  const out = await must(["sessions", "--agent", botId, "--json", "--limit", "all"]);
  const parsed = parseJsonOutput<{ sessions?: Array<{ key?: string }> }>(out);
  return new Set((parsed.sessions ?? []).flatMap((row) => (row.key ? [row.key] : [])));
}

/** Create or restyle a bot. These commands write the gateway config, so they run one at a time. */
async function configureBot(bot: SeedBot, agents: Map<string, AgentRow>): Promise<void> {
  const workspace = agents.get(bot.id)?.workspace ?? join(DEV_STATE_DIR, "workspaces", bot.id);
  assertInside(workspace, DEV_STATE_DIR);
  if (!agents.has(bot.id)) {
    await must([
      "agents",
      "add",
      bot.id,
      "--non-interactive",
      "--workspace",
      workspace,
      "--model",
      MODEL_REF,
      "--json",
    ]);
  }
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "AGENTS.md"), bot.instructions);
  await must([
    "agents",
    "set-identity",
    "--agent",
    bot.id,
    "--name",
    bot.name,
    "--emoji",
    bot.emoji,
    "--theme",
    bot.theme,
    "--json",
  ]);
}

type AgentRunOutput = {
  status?: string;
  summary?: string;
  result?: {
    meta?: { aborted?: boolean; stopReason?: string; finalAssistantVisibleText?: string };
  };
};

/** The text a scripted turn ends with: the text steps of its last round. */
export function expectedFinalText(turn: SeedTurn): string {
  const last = turn.rounds.at(-1) ?? [];
  return last
    .flatMap((step) => (step.kind === "text" ? [step.text] : []))
    .join("")
    .trim();
}

/** `openclaw agent` waits for the run's terminal outcome; check that it is the one we scripted. */
export function checkTurnOutcome(output: AgentRunOutput, turn: SeedTurn): string | null {
  const meta = output.result?.meta;
  if (output.status !== "ok" || output.summary !== "completed") {
    return `run ended with status ${output.status ?? "?"} (${output.summary ?? "no summary"})`;
  }
  if (meta?.aborted) return "run was aborted";
  if (meta?.stopReason !== "stop")
    return `run stopped with ${meta?.stopReason ?? "no stop reason"}`;
  const actual = (meta.finalAssistantVisibleText ?? "").trim();
  const expected = expectedFinalText(turn);
  if (actual !== expected)
    return `final reply differs from the script: ${JSON.stringify(actual.slice(0, 80))}`;
  return null;
}

type HistoryMessage = { role?: string; stopReason?: string; isError?: boolean; content?: unknown };

/** Check a seeded session's durable history against its script. Returns what is wrong. */
export function checkHistory(messages: HistoryMessage[], task: SeedTask): string[] {
  const problems: string[] = [];
  const users = messages.filter((m) => m.role === "user").length;
  if (users !== task.turns.length)
    problems.push(`expected ${task.turns.length} user turns, found ${users}`);
  const expectedTools = task.turns
    .flatMap((turn) => turn.rounds.flat())
    .filter((step) => step.kind === "tool").length;
  const results = messages.filter((m) => m.role === "toolResult");
  if (results.length !== expectedTools) {
    problems.push(`expected ${expectedTools} tool results, found ${results.length}`);
  }
  if (results.some((m) => m.isError)) problems.push("a tool call failed");
  const last = messages.at(-1);
  if (last?.role !== "assistant" || last.stopReason !== "stop") {
    problems.push("the session does not end with a completed assistant reply");
  }
  return problems;
}

/** Run a bot's scripted conversations. Sessions are independent, so bots run in parallel. */
async function seedConversations(bot: SeedBot): Promise<void> {
  const existing = await existingSessionKeys(bot.id);
  for (const task of bot.tasks) {
    const key = sessionKeyFor(bot.id, task.slug);
    const alreadySeeded = existing.has(key);
    for (const turn of alreadySeeded ? [] : task.turns) {
      const output = parseJsonOutput<AgentRunOutput>(
        await must([
          "agent",
          "--agent",
          bot.id,
          "--session-key",
          key,
          "--message",
          turn.prompt,
          "--thinking",
          "low",
          "--json",
        ]),
      );
      const problem = checkTurnOutcome(output, turn);
      if (problem) throw new Error(`${bot.name} / ${task.label}: ${problem}`);
    }
    if (!alreadySeeded)
      await must([
        "gateway",
        "call",
        "sessions.patch",
        "--params",
        JSON.stringify({ key, label: task.label }),
        "--json",
      ]);
    const history = parseJsonOutput<{ messages?: HistoryMessage[] }>(
      await must([
        "gateway",
        "call",
        "chat.history",
        "--params",
        JSON.stringify({ sessionKey: key, limit: 200 }),
        "--json",
      ]),
    );
    const problems = checkHistory(history.messages ?? [], task);
    if (problems.length > 0) {
      const advice = alreadySeeded ? " (run `pnpm dev-gateway start` for a fresh gateway)" : "";
      throw new Error(`${bot.name} / ${task.label}: ${problems.join("; ")}${advice}`);
    }
    console.log(
      `  ${bot.name}: ${task.label}${alreadySeeded ? " (already seeded, verified)" : ""}`,
    );
  }
}

export async function seed(): Promise<void> {
  const refusal = defaultRunner.refusal();
  if (refusal) throw new Error(refusal);
  if (!(await gatewayHealthy())) {
    throw new Error("the development gateway is not running. Run `pnpm dev-gateway start` first.");
  }
  const listed = parseJsonOutput<AgentRow[] | { agents: AgentRow[] }>(
    await must(["agents", "list", "--json"]),
  );
  const rows = Array.isArray(listed) ? listed : listed.agents;
  const agents = new Map(rows.map((row) => [row.id, row]));
  console.log("Seeding sample bots and conversations");
  for (const bot of SEED_BOTS) await configureBot(bot, agents);
  await assertExecDenied();
  await Promise.all(SEED_BOTS.map((bot) => seedConversations(bot)));
  console.log("Seed complete");
}

type PendingDevice = { requestId: string; clientId?: string; displayName?: string };

export async function approve(requestId?: string): Promise<string[]> {
  const listed = parseJsonOutput<{ pending?: PendingDevice[] }>(
    await must(["devices", "list", "--json"]),
  );
  const pending = (listed.pending ?? []).filter((request) =>
    requestId ? request.requestId === requestId : request.displayName?.startsWith("Clawtrate"),
  );
  if (pending.length === 0) {
    console.log(requestId ? `No pending request ${requestId}` : "No pending Clawtrate requests");
    return [];
  }
  for (const request of pending) {
    await must(["devices", "approve", request.requestId]);
    console.log(`Approved ${request.displayName ?? "device"} (${request.requestId})`);
  }
  return pending.map((request) => request.requestId);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "start":
      return start();
    case "stop":
      return stop();
    case "seed":
      return seed();
    case "up":
      return start();
    case "reset":
      return reset();
    case "status":
      return status();
    case "approve":
      await approve(rest[0]);
      return;
    default:
      console.log("usage: pnpm dev-gateway <start|seed|up|approve|status|stop|reset>");
      process.exitCode = command ? 1 : 0;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
