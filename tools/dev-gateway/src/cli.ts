// Development gateway control.
//
//   pnpm dev-gateway start     a fresh, seeded gateway: stop the tool's own gateway,
//                              delete its state, create it again empty, configure,
//                              start the scripted model and the gateway, then seed
//                              the sample bots and conversations
//   pnpm dev-gateway up        the same as start
//   pnpm dev-gateway seed      seed the running gateway again (verifies what exists)
//   pnpm dev-gateway approve   approve pending Clawtrate pairing requests
//   pnpm dev-gateway status    show what is running
//   pnpm dev-gateway stop      stop the processes this tool started
//   pnpm dev-gateway reset     stop, then delete the instance's state folder
//   pnpm dev-gateway list      the instances this tool created on this machine
//   pnpm dev-gateway prune     remove named instances nothing is running on
//
// Every command takes `--instance <name>` (or CLAWTRATE_DEV_INSTANCE). Without
// one it addresses the default instance: `openclaw --dev`, ~/.openclaw-dev,
// ports 19001 and 19091. A named instance is `openclaw --profile
// clawtrate-dev-<name>` in ~/.openclaw-clawtrate-dev-<name>, on free ports the
// tool chooses at start and records. See instance.ts.
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
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { renderAvatar } from "./avatars.ts";
import {
  ForeignStateError,
  inUseRefusal,
  isAlive,
  newRunId,
  ownership,
  prepareFreshState,
  readRunRecord,
  recordGateway,
  StateInUseError,
  type RunRecord,
} from "./state-guard.ts";
import {
  CHECKOUT_DIR,
  GATEWAY_PORT,
  MODEL_ID,
  MODEL_REF,
  PROVIDER_ID,
  PROVIDER_PORT,
  RUN_DIR,
  assertInstanceStateDir,
  instancePaths,
  parseJsonOutput,
  providerEnv,
  runnerFor,
  type InstancePaths,
  type OpenclawRunner,
} from "./env.ts";
import { profileArgs, runDirFor, selectInstance } from "./instance.ts";
import {
  choosePorts,
  listInstances,
  portOpen,
  pruneInstances,
  withPortLock,
  type InstanceEntry,
  type InstancePorts,
} from "./registry.ts";
import {
  SEED_BOTS,
  sessionKeyFor,
  type SeedBot,
  type SeedTask,
  type SeedTurn,
} from "./seed-data.ts";
import { spawn, spawnSync } from "node:child_process";

export type DevConnection = { url: string; token: string; instance?: string | null };

/** One instance as a command sees it: its paths, its guarded runner and the home it is under. */
export type DevInstance = InstancePaths & { home: string; runner: OpenclawRunner };

export function openInstance(
  name: string | null,
  options: { home?: string; runRoot?: string; runner?: OpenclawRunner } = {},
): DevInstance {
  const home = options.home ?? homedir();
  const paths = instancePaths(name, {
    home,
    ...(options.runRoot ? { runRoot: options.runRoot } : {}),
  });
  return { ...paths, home, runner: options.runner ?? runnerFor(paths) };
}

const DEFAULT_PORTS: InstancePorts = { gatewayPort: GATEWAY_PORT, providerPort: PROVIDER_PORT };

const label = (inst: { name: string | null }) =>
  inst.name === null ? "the default instance" : `instance "${inst.name}"`;

/** The flag a printed command needs to address the same instance. */
const instanceFlag = (inst: { name: string | null }) =>
  inst.name === null ? "" : ` --instance ${inst.name}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function assertInside(path: string, dir: string): void {
  const rel = relative(dir, path);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`refusing to write outside ${dir}: ${path}`);
}

function writeState(inst: DevInstance, state: RunRecord): void {
  mkdirSync(inst.runDir, { recursive: true });
  writeFileSync(inst.runFile, `${JSON.stringify(state, null, 2)}\n`);
}

export function readDevConnection(path: string): DevConnection | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as DevConnection;
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
export function devConfig(token: string, ports: InstancePorts = DEFAULT_PORTS) {
  return {
    gateway: {
      mode: "local",
      port: ports.gatewayPort,
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
          baseUrl: `http://127.0.0.1:${ports.providerPort}/v1`,
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
export function sandboxProblems(config: unknown, ports?: InstancePorts): string[] {
  const problems: string[] = [];
  if (ports) {
    if (at(config, "gateway", "port") !== ports.gatewayPort)
      problems.push(`gateway.port must be this instance's ${ports.gatewayPort}`);
    if (
      at(config, "models", "providers", PROVIDER_ID, "baseUrl") !==
      `http://127.0.0.1:${ports.providerPort}/v1`
    )
      problems.push(`the scripted provider must be this instance's port ${ports.providerPort}`);
  }
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

function assertSandboxed(inst: DevInstance, ports: InstancePorts): void {
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(inst.configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read ${inst.configPath}: ${String(error)}. Run \`pnpm dev-gateway reset${instanceFlag(inst)}\`.`,
      { cause: error },
    );
  }
  const problems = sandboxProblems(config, ports);
  if (problems.length > 0) {
    throw new Error(
      `the development gateway config is not sandboxed:\n  - ${problems.join("\n  - ")}\nRun \`pnpm dev-gateway reset${instanceFlag(inst)}\` to recreate it.`,
    );
  }
}

/** Write a new config and bootstrap token into the state folder `start` just created. */
function writeFreshConfig(inst: DevInstance, ports: InstancePorts): DevConnection {
  const token = randomBytes(24).toString("base64url");
  writeFileSync(inst.configPath, `${JSON.stringify(devConfig(token, ports), null, 2)}\n`, {
    mode: 0o600,
  });
  const connection = { url: `ws://127.0.0.1:${ports.gatewayPort}`, token, instance: inst.name };
  mkdirSync(inst.runDir, { recursive: true });
  writeFileSync(inst.connectionFile, `${JSON.stringify(connection, null, 2)}\n`, { mode: 0o600 });
  const validation = inst.runner.runSync(["config", "validate"]);
  if (validation.status !== 0) {
    throw new Error(`generated config is invalid:\n${validation.stdout}${validation.stderr}`);
  }
  return connection;
}

/** Healthy means the guard allows OpenClaw and the gateway answers; a refusal spawns nothing. */
async function gatewayHealthy(runner: OpenclawRunner): Promise<boolean> {
  if (runner.refusal()) return false;
  if (!(await portOpen(runner.gatewayPort()))) return false;
  const result = await runner.run(["gateway", "call", "health", "--json", "--timeout", "3000"]);
  return result.status === 0;
}

type ExecScope = { agentId?: string; security?: { effective?: string } };

/** Ask the running gateway what exec policy each bot actually gets. */
export async function execPolicyProblems(inst: DevInstance): Promise<string[]> {
  const snapshot = parseJsonOutput<{ effectivePolicy?: { scopes?: ExecScope[] } }>(
    await must(inst, ["approvals", "get", "--json"]),
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

async function assertExecDenied(inst: DevInstance): Promise<void> {
  const problems = await execPolicyProblems(inst);
  if (problems.length > 0) throw new Error(`exec is not denied:\n  - ${problems.join("\n  - ")}`);
}

/** Refuse, changing nothing, when another checkout runs this instance's gateway. */
function assertNotInUse(inst: DevInstance): void {
  const reason = inUseRefusal(inst.stateDir, readRunRecord(inst.runFile), isAlive);
  if (reason) throw new StateInUseError(reason);
}

/**
 * The only way to start the gateway: on a state folder this command has just
 * created empty. The tool's own gateway is stopped and its state deleted first;
 * foreign state, and state whose gateway another checkout runs, is refused
 * untouched. Ends with a seeded, verified gateway.
 */
export async function start(inst: DevInstance, options: { seed?: boolean } = {}): Promise<void> {
  assertInstanceStateDir(inst.stateDir, inst.name, inst.home);
  if (ownership(inst.stateDir) === "foreign") throw new ForeignStateError(inst.stateDir);
  assertNotInUse(inst);
  await stop(inst);
  const runner = inst.runner;
  const runId = newRunId();
  // Ports are chosen and recorded in the new marker under one lock, so two
  // starts on this machine never take the same ones.
  const ports = await withPortLock(inst.home, async () => {
    const chosen = inst.name === null ? DEFAULT_PORTS : await choosePorts(inst.name, inst.home);
    for (const port of [chosen.gatewayPort, chosen.providerPort]) {
      if (await portOpen(port)) {
        throw new Error(`port ${port} is in use by a process this tool did not start`);
      }
    }
    prepareFreshState(
      inst.stateDir,
      runId,
      new Date(),
      { instance: inst.name, ...chosen, checkout: CHECKOUT_DIR, startPid: process.pid },
      { run: readRunRecord(inst.runFile), isAlive },
    );
    return chosen;
  });
  runner.freshRunId = runId;
  try {
    writeFreshConfig(inst, ports);
    assertSandboxed(inst, ports);
    mkdirSync(inst.runDir, { recursive: true });

    const providerLog = openSync(join(inst.runDir, "provider.log"), "w");
    const provider = spawn(
      process.execPath,
      [fileURLToPath(new URL("./provider-main.ts", import.meta.url))],
      {
        detached: true,
        stdio: ["ignore", providerLog, providerLog],
        env: providerEnv(process.env, ports.providerPort),
      },
    );
    provider.unref();
    closeSync(providerLog);
    writeState(inst, {
      runId,
      providerPid: provider.pid,
      ...ports,
      startedAt: new Date().toISOString(),
    });
    await waitFor("the scripted provider", () => portOpen(ports.providerPort), 10_000);

    const gatewayLog = openSync(join(inst.runDir, "gateway.log"), "w");
    const gateway = runner.spawnDetached(
      ["gateway", "run", "--port", String(ports.gatewayPort), "--bind", "loopback"],
      { stdio: ["ignore", gatewayLog, gatewayLog] },
    );
    gateway.unref();
    closeSync(gatewayLog);
    writeState(inst, {
      runId,
      providerPid: provider.pid,
      gatewayPid: gateway.pid,
      ...ports,
      startedAt: new Date().toISOString(),
    });
    recordGateway(inst.stateDir, runId, { gatewayPid: gateway.pid!, providerPid: provider.pid! });
  } finally {
    // From here on OpenClaw runs only while this start's gateway is alive.
    runner.freshRunId = null;
  }
  await waitFor("the development gateway", () => gatewayHealthy(runner), 90_000);
  await assertExecDenied(inst);
  const record = readRunRecord(inst.runFile);
  console.log(`Development gateway (${label(inst)}) ready on ws://127.0.0.1:${ports.gatewayPort}`);
  console.log(`  profile         openclaw ${profileArgs(inst.name).join(" ")}`);
  console.log(`  state           ${inst.stateDir}`);
  console.log(
    `  scripted model  http://127.0.0.1:${ports.providerPort}/v1 (pid ${record?.providerPid})`,
  );
  console.log(`  gateway         pid ${record?.gatewayPid}, logs in ${inst.runDir}`);
  // Unseeded starts are for checks that need a running gateway, not its data.
  if (options.seed !== false) await seed(inst);
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

/** Stop the processes this checkout recorded for the instance, by PID. Nothing else. */
export async function stop(inst: DevInstance): Promise<void> {
  const state = readRunRecord(inst.runFile);
  if (!state) {
    console.log(
      `Nothing to stop: this checkout has no running processes on record for ${label(inst)}.`,
    );
    return;
  }
  if (state.gatewayPid) await stopPid(state.gatewayPid, "development gateway");
  if (state.providerPid) await stopPid(state.providerPid, "scripted provider");
  rmSync(inst.runFile, { force: true });
}

/**
 * Stop, then delete the instance's state folder if it is the tool's own and no
 * other checkout runs its gateway. Foreign state is left alone. Only this one
 * instance is affected.
 */
export async function reset(inst: DevInstance): Promise<void> {
  assertInstanceStateDir(inst.stateDir, inst.name, inst.home);
  const owner = ownership(inst.stateDir);
  if (owner === "foreign") throw new ForeignStateError(inst.stateDir);
  assertNotInUse(inst);
  await stop(inst);
  rmSync(inst.connectionFile, { force: true });
  if (owner === "owned") {
    assertNotInUse(inst);
    rmSync(inst.stateDir, { recursive: true });
    console.log(`Removed ${inst.stateDir}`);
  }
  if (inst.name !== null) rmSync(inst.runDir, { recursive: true, force: true });
}

/** Report what is running. OpenClaw is asked only when the guard allows it. */
export async function status(
  inst: DevInstance,
  log: (line: string) => void = console.log,
): Promise<void> {
  const runner = inst.runner;
  const record = readRunRecord(runner.runFile);
  const connection = readDevConnection(inst.connectionFile);
  const owner = ownership(runner.stateDir);
  log(`instance    ${inst.name ?? "(default)"}`);
  log(`state dir   ${runner.stateDir} (${owner})`);
  log(
    `provider    ${record?.providerPid && isAlive(record.providerPid) ? `running, pid ${record.providerPid}` : "stopped"}`,
  );
  log(
    `gateway     ${record?.gatewayPid && isAlive(record.gatewayPid) ? `running, pid ${record.gatewayPid}` : "stopped"}`,
  );
  const inUse = inUseRefusal(runner.stateDir, record, isAlive);
  if (inUse) log(`in use      ${inUse}`);
  const refusal = runner.refusal();
  if (refusal) log(`healthy     no (not checked: ${refusal})`);
  else log(`healthy     ${(await gatewayHealthy(runner)) ? "yes" : "no"}`);
  if (connection) log(`url         ${connection.url}`);
}

async function must(inst: DevInstance, args: string[]): Promise<string> {
  const result = await inst.runner.run(args);
  if (result.status !== 0) {
    throw new Error(
      `openclaw ${profileArgs(inst.name).join(" ")} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

type AgentRow = { id: string; workspace?: string };

async function existingSessionKeys(inst: DevInstance, botId: string): Promise<Set<string>> {
  const out = await must(inst, ["sessions", "--agent", botId, "--json", "--limit", "all"]);
  const parsed = parseJsonOutput<{ sessions?: Array<{ key?: string }> }>(out);
  return new Set((parsed.sessions ?? []).flatMap((row) => (row.key ? [row.key] : [])));
}

/** Create or restyle a bot. These commands write the gateway config, so they run one at a time. */
async function configureBot(
  inst: DevInstance,
  bot: SeedBot,
  agents: Map<string, AgentRow>,
): Promise<void> {
  const workspace = agents.get(bot.id)?.workspace ?? join(inst.stateDir, "workspaces", bot.id);
  assertInside(workspace, inst.stateDir);
  if (!agents.has(bot.id)) {
    await must(inst, [
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
  writeFileSync(join(workspace, "avatar.png"), renderAvatar(bot));
  await must(inst, [
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
    "--avatar",
    "avatar.png",
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
async function seedConversations(inst: DevInstance, bot: SeedBot): Promise<void> {
  const existing = await existingSessionKeys(inst, bot.id);
  for (const task of bot.tasks) {
    const key = sessionKeyFor(bot.id, task.slug);
    const alreadySeeded = existing.has(key);
    for (const turn of alreadySeeded ? [] : task.turns) {
      const output = parseJsonOutput<AgentRunOutput>(
        await must(inst, [
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
      await must(inst, [
        "gateway",
        "call",
        "sessions.patch",
        "--params",
        JSON.stringify({ key, label: task.label }),
        "--json",
      ]);
    const history = parseJsonOutput<{ messages?: HistoryMessage[] }>(
      await must(inst, [
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
      const advice = alreadySeeded
        ? ` (run \`pnpm dev-gateway start${instanceFlag(inst)}\` for a fresh gateway)`
        : "";
      throw new Error(`${bot.name} / ${task.label}: ${problems.join("; ")}${advice}`);
    }
    console.log(
      `  ${bot.name}: ${task.label}${alreadySeeded ? " (already seeded, verified)" : ""}`,
    );
  }
}

export async function seed(inst: DevInstance): Promise<void> {
  const refusal = inst.runner.refusal();
  if (refusal) throw new Error(refusal);
  if (!(await gatewayHealthy(inst.runner))) {
    throw new Error(
      `the development gateway is not running. Run \`pnpm dev-gateway start${instanceFlag(inst)}\` first.`,
    );
  }
  const listed = parseJsonOutput<AgentRow[] | { agents: AgentRow[] }>(
    await must(inst, ["agents", "list", "--json"]),
  );
  const rows = Array.isArray(listed) ? listed : listed.agents;
  const agents = new Map(rows.map((row) => [row.id, row]));
  console.log("Seeding sample bots and conversations");
  for (const bot of SEED_BOTS) await configureBot(inst, bot, agents);
  await assertExecDenied(inst);
  await Promise.all(SEED_BOTS.map((bot) => seedConversations(inst, bot)));
  console.log("Seed complete");
}

type PendingDevice = { requestId: string; clientId?: string; displayName?: string };

export async function approve(inst: DevInstance, requestId?: string): Promise<string[]> {
  const listed = parseJsonOutput<{ pending?: PendingDevice[] }>(
    await must(inst, ["devices", "list", "--json"]),
  );
  const pending = (listed.pending ?? []).filter((request) =>
    requestId ? request.requestId === requestId : request.displayName?.startsWith("Clawtrate"),
  );
  if (pending.length === 0) {
    console.log(requestId ? `No pending request ${requestId}` : "No pending Clawtrate requests");
    return [];
  }
  for (const request of pending) {
    await must(inst, ["devices", "approve", request.requestId]);
    console.log(`Approved ${request.displayName ?? "device"} (${request.requestId})`);
  }
  return pending.map((request) => request.requestId);
}

export type ListedInstance = {
  name: string | null;
  stateDir: string;
  gatewayPort: number | null;
  providerPort: number | null;
  gatewayPid: number | null;
  gatewayRunning: boolean;
  /** Started from this checkout, by its run file. */
  thisCheckout: boolean;
  checkout: string | null;
};

function describeEntry(entry: InstanceEntry, runRoot: string): ListedInstance {
  const run = readRunRecord(join(runDirFor(entry.name, runRoot), "state.json"));
  return {
    name: entry.name,
    stateDir: entry.stateDir,
    gatewayPort: entry.gatewayPort ?? null,
    providerPort: entry.providerPort ?? null,
    gatewayPid: entry.marker.gatewayPid ?? null,
    gatewayRunning: entry.gatewayRunning,
    thisCheckout:
      (run !== null && run.runId === entry.marker.runId) || entry.marker.checkout === CHECKOUT_DIR,
    checkout: entry.marker.checkout ?? null,
  };
}

/** The instances this tool created on this machine, from their state folders' markers. */
export function list(
  options: {
    home?: string;
    runRoot?: string;
    json?: boolean;
    log?: (line: string) => void;
  } = {},
): ListedInstance[] {
  const log = options.log ?? console.log;
  const rows = listInstances(options.home ?? homedir()).map((entry) =>
    describeEntry(entry, options.runRoot ?? RUN_DIR),
  );
  if (options.json) {
    log(JSON.stringify(rows, null, 2));
    return rows;
  }
  if (rows.length === 0) log("No development gateway instances on this machine.");
  for (const row of rows) {
    const gateway = row.gatewayRunning ? `running, pid ${row.gatewayPid}` : "stopped";
    const owner = row.thisCheckout ? "this checkout" : (row.checkout ?? "unknown checkout");
    log(`${row.name ?? "(default)"}`);
    log(`  state     ${row.stateDir}`);
    log(`  ports     gateway ${row.gatewayPort ?? "?"}, scripted model ${row.providerPort ?? "?"}`);
    log(`  gateway   ${gateway}`);
    log(`  started   from ${owner}`);
  }
  return rows;
}

/** Remove named instances whose gateway, scripted model and start are all gone. */
export function prune(
  options: { home?: string; runRoot?: string; log?: (line: string) => void } = {},
): string[] {
  const log = options.log ?? console.log;
  const removed = pruneInstances(options.home ?? homedir(), {
    runDirFor: (name) => runDirFor(name, options.runRoot ?? RUN_DIR),
    log,
  });
  if (removed.length === 0) log("No stopped instances to remove.");
  return removed;
}

const USAGE =
  "usage: pnpm dev-gateway <start|up|seed|approve [requestId]|status|stop|reset|list|prune> [--instance <name>] [--json] [--no-seed]";

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      instance: { type: "string" },
      json: { type: "boolean", default: false },
      "no-seed": { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const [command, ...rest] = positionals;
  if (command === "list") {
    list({ json: values.json });
    return;
  }
  if (command === "prune") {
    prune();
    return;
  }
  const known = ["start", "up", "stop", "seed", "reset", "status", "approve"];
  if (!command || !known.includes(command)) {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
    return;
  }
  // The name is validated here, before any path is built or touched.
  const inst = openInstance(selectInstance(values.instance, env));
  switch (command) {
    case "start":
    case "up":
      return start(inst, { seed: !values["no-seed"] });
    case "stop":
      return stop(inst);
    case "seed":
      return seed(inst);
    case "reset":
      return reset(inst);
    case "status":
      return status(inst);
    case "approve":
      await approve(inst, rest[0]);
      return;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
