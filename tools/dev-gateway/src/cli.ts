// Development gateway control: start, stop, seed, reset, status, approve.
//
//   pnpm dev-gateway start     start the scripted model and `openclaw --dev gateway run`
//   pnpm dev-gateway seed      create the four sample bots and their conversations
//   pnpm dev-gateway up        start, then seed
//   pnpm dev-gateway approve   approve pending Clawtrate pairing requests
//   pnpm dev-gateway status    show what is running
//   pnpm dev-gateway stop      stop the processes this tool started
//   pnpm dev-gateway reset     stop, then delete ~/.openclaw-dev

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
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAvatar } from "./avatars.ts";
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
  openclaw,
  openclawSync,
  parseJsonOutput,
  spawnOpenclawDetached,
} from "./env.ts";
import { SEED_BOTS, sessionKeyFor, type SeedBot } from "./seed-data.ts";
import { spawn, spawnSync } from "node:child_process";

type RunState = {
  providerPid?: number | undefined;
  gatewayPid?: number | undefined;
  startedAt: string;
};
export type DevConnection = { url: string; token: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid: number | undefined): pid is number {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function assertInside(path: string, dir: string): void {
  const rel = relative(dir, path);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`refusing to write outside ${dir}: ${path}`);
}

function readState(): RunState | null {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as RunState;
}

function writeState(state: RunState): void {
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

export function readDevConnection(): DevConnection | null {
  if (!existsSync(CONNECTION_FILE)) return null;
  return JSON.parse(readFileSync(CONNECTION_FILE, "utf8")) as DevConnection;
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

/** The config the development gateway runs with. Written once; `reset` removes it. */
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
    plugins: {
      entries: { "memory-core": { config: { dreaming: { enabled: false } } } },
    },
  };
}

function ensureConfig(): DevConnection {
  assertDevStateDir(DEV_STATE_DIR);
  const existing = readDevConnection();
  if (existsSync(DEV_CONFIG_PATH) && existing) return existing;
  if (existsSync(DEV_CONFIG_PATH)) {
    throw new Error(
      `${DEV_CONFIG_PATH} exists but was not created by this tool. Run \`pnpm dev-gateway reset\` first.`,
    );
  }
  const token = randomBytes(24).toString("base64url");
  mkdirSync(DEV_STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(DEV_CONFIG_PATH, `${JSON.stringify(devConfig(token), null, 2)}\n`, { mode: 0o600 });
  const connection = { url: GATEWAY_URL, token };
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(CONNECTION_FILE, `${JSON.stringify(connection, null, 2)}\n`, { mode: 0o600 });
  const validation = openclawSync(["config", "validate"]);
  if (validation.status !== 0) {
    throw new Error(`generated config is invalid:\n${validation.stdout}${validation.stderr}`);
  }
  return connection;
}

async function gatewayHealthy(): Promise<boolean> {
  if (!(await portOpen(GATEWAY_PORT))) return false;
  const result = await openclaw(["gateway", "call", "health", "--json", "--timeout", "3000"]);
  return result.status === 0;
}

export async function start(): Promise<void> {
  const state = readState();
  if (state && isAlive(state.gatewayPid) && isAlive(state.providerPid)) {
    console.log(`Development gateway already running on ${GATEWAY_URL}`);
    return;
  }
  if (await portOpen(GATEWAY_PORT)) {
    throw new Error(`port ${GATEWAY_PORT} is in use by a process this tool did not start`);
  }
  if (await portOpen(PROVIDER_PORT)) {
    throw new Error(`port ${PROVIDER_PORT} is in use by a process this tool did not start`);
  }
  ensureConfig();
  mkdirSync(RUN_DIR, { recursive: true });

  const providerLog = openSync(join(RUN_DIR, "provider.log"), "a");
  const provider = spawn(
    process.execPath,
    [fileURLToPath(new URL("./provider-main.ts", import.meta.url))],
    {
      detached: true,
      stdio: ["ignore", providerLog, providerLog],
      env: { PATH: process.env.PATH },
    },
  );
  provider.unref();
  closeSync(providerLog);
  writeState({ providerPid: provider.pid, startedAt: new Date().toISOString() });
  await waitFor("the scripted provider", () => portOpen(PROVIDER_PORT), 10_000);

  const gatewayLog = openSync(join(RUN_DIR, "gateway.log"), "a");
  const gateway = spawnOpenclawDetached(
    ["gateway", "run", "--port", String(GATEWAY_PORT), "--bind", "loopback"],
    { stdio: ["ignore", gatewayLog, gatewayLog] },
  );
  gateway.unref();
  closeSync(gatewayLog);
  writeState({
    providerPid: provider.pid,
    gatewayPid: gateway.pid,
    startedAt: new Date().toISOString(),
  });
  await waitFor("the development gateway", gatewayHealthy, 90_000);
  console.log(`Development gateway ready on ${GATEWAY_URL}`);
  console.log(`  scripted model  http://127.0.0.1:${PROVIDER_PORT}/v1 (pid ${provider.pid})`);
  console.log(`  gateway         pid ${gateway.pid}, logs in ${RUN_DIR}`);
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

export async function reset(): Promise<void> {
  await stop();
  assertDevStateDir(DEV_STATE_DIR);
  rmSync(DEV_STATE_DIR, { recursive: true, force: true });
  rmSync(CONNECTION_FILE, { force: true });
  console.log(`Removed ${DEV_STATE_DIR}`);
}

async function status(): Promise<void> {
  const state = readState();
  const connection = readDevConnection();
  console.log(`state dir   ${DEV_STATE_DIR} ${existsSync(DEV_STATE_DIR) ? "" : "(absent)"}`);
  console.log(
    `provider    ${state?.providerPid && isAlive(state.providerPid) ? `running, pid ${state.providerPid}` : "stopped"}`,
  );
  console.log(
    `gateway     ${state?.gatewayPid && isAlive(state.gatewayPid) ? `running, pid ${state.gatewayPid}` : "stopped"}`,
  );
  console.log(`healthy     ${(await gatewayHealthy()) ? "yes" : "no"}`);
  if (connection) console.log(`url         ${connection.url}`);
}

async function must(args: string[]): Promise<string> {
  const result = await openclaw(args);
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
  writeFileSync(join(workspace, "avatar.png"), renderAvatar(bot));
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
    "--avatar",
    "avatar.png",
    "--json",
  ]);
}

/** Run a bot's scripted conversations. Sessions are independent, so bots run in parallel. */
async function seedConversations(bot: SeedBot): Promise<void> {
  const existing = await existingSessionKeys(bot.id);
  for (const task of bot.tasks) {
    const key = sessionKeyFor(bot.id, task.slug);
    if (existing.has(key)) continue;
    for (const turn of task.turns) {
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
      ]);
    }
    await must([
      "gateway",
      "call",
      "sessions.patch",
      "--params",
      JSON.stringify({ key, label: task.label }),
      "--json",
    ]);
    console.log(`  ${bot.name}: ${task.label}`);
  }
}

export async function seed(): Promise<void> {
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
      await start();
      return seed();
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
