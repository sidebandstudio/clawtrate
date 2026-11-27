// The bots checks: the clawtrate-bots plugin's run origins, "read from
// outside" and read tools on a real development gateway, asserted from
// the gateway's answers and the plugin's own `clawtrate-bots.runs.get`.
// `pnpm scenarios` runs them on an instance of their own started with
// `--with-plugin clawtrate-bots`; on its own:
//
//   node tools/dev-gateway/src/bots-checks.ts --instance <name>
//
// Clients: an admin connection, as Clawtrate with full control is (its runs
// are the gateway's owner's, so the gateway offers them its scheduler), and a
// read-only one. Bots act through the scripted model's directives; a routine
// runs with `cron.run`; the command line is `openclaw agent` under the
// instance's own profile.

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { GatewayEvent, OperatorSession } from "./operator.ts";
import { SEED_BOTS } from "./seed-data.ts";

type JsonRecord = Record<string, unknown>;
const rec = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const show = (value: unknown) => JSON.stringify(value)?.slice(0, 400) ?? String(value);

export class BotsCheckFailure extends Error {}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new BotsCheckFailure(message);
}

export const BOTS_CLIENTS = {
  admin: {
    scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
    caps: ["tool-events", "approvals"],
  },
  reader: { scopes: ["operator.read"], caps: [] },
} as const;
export type BotsClient = keyof typeof BOTS_CLIENTS;

export type BotsContext = {
  clients: Record<BotsClient, OperatorSession>;
  /** `openclaw <args>` under the instance's own profile. */
  cli: (args: string[]) => Promise<{ status: number | null; stdout: string; stderr: string }>;
  log?: (line: string) => void;
};

type World = { stamp: string; counter: number; jobs: Set<string> };

/** A new task of a bot, subscribed to by the admin client. */
async function task(ctx: BotsContext, world: World, bot: string, tag: string): Promise<string> {
  world.counter += 1;
  const key = `agent:${bot}:bots-${tag}-${world.stamp}-${world.counter}`;
  await ctx.clients.admin.request("sessions.messages.subscribe", { key }).catch(() => {});
  return key;
}

type ToolCall = { name: string; text: string; ok: boolean };

/** A run's tool calls with their results, from the admin client's events. */
function callsOf(events: GatewayEvent[]): ToolCall[] {
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  for (const event of events) {
    const payload = rec(event.payload);
    if (event.event !== "agent" || payload.stream !== "tool") continue;
    const data = rec(payload.data);
    const id = typeof data.toolCallId === "string" ? data.toolCallId : "";
    if (data.phase === "start") {
      const call = { name: String(data.name), text: "", ok: false };
      calls.push(call);
      if (id) byId.set(id, call);
    } else if (data.phase === "result") {
      const call = byId.get(id);
      if (!call) continue;
      const blocks = Array.isArray(rec(data.result).content)
        ? (rec(data.result).content as JsonRecord[])
        : [];
      call.text = blocks.map((b) => String(b.text ?? "")).join("\n");
      call.ok = data.isError !== true;
    }
  }
  return calls;
}

type Turn = { runId: string; calls: ToolCall[]; reply: string };

/** One typed run: sent by the admin client under a key of its own, waited on to its end. */
async function turn(ctx: BotsContext, key: string, message: string): Promise<Turn> {
  const op = ctx.clients.admin;
  const runId = randomUUID();
  await op.request("chat.send", { sessionKey: key, message, idempotencyKey: runId });
  const end = await op.terminal(runId, 150_000);
  expect(end.state === "final", `${message}: the run ended ${String(end.state)}`);
  await sleep(300);
  return { runId, calls: callsOf(op.runEvents(runId)), reply: await lastReply(ctx, key) };
}

/** The last thing the bot said in a session. */
async function lastReply(ctx: BotsContext, key: string): Promise<string> {
  const history = rec(
    await ctx.clients.admin.request("chat.history", { sessionKey: key, limit: 20 }),
  );
  const messages = Array.isArray(history.messages) ? (history.messages as JsonRecord[]) : [];
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? (content as JsonRecord[]).map((part) => String(part.text ?? "")).join("")
          : "";
    if (text.trim()) return text;
  }
  return "";
}

/** A tool's answer in a session, once it is there (at most 90 seconds). */
async function toolAnswer(ctx: BotsContext, key: string, tool: string): Promise<string> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const history = rec(
      await ctx.clients.admin
        .request("chat.history", { sessionKey: key, limit: 40 })
        .catch(() => ({})),
    );
    const messages = Array.isArray(history.messages) ? (history.messages as JsonRecord[]) : [];
    const found = messages.find((m) => m.role === "toolResult" && m.toolName === tool);
    if (found) {
      const content = found.content;
      return Array.isArray(content)
        ? (content as JsonRecord[]).map((part) => String(part.text ?? "")).join("")
        : String(content ?? "");
    }
    expect(Date.now() < deadline, `no ${tool} answer in ${key} within 90 seconds`);
    await sleep(1000);
  }
}

/** The plugin's record of a run (`clawtrate-bots.runs.get`), read with read access only. */
async function runOf(ctx: BotsContext, runId: string): Promise<JsonRecord> {
  return rec(await ctx.clients.reader.request("clawtrate-bots.runs.get", { runId }));
}

type Revision = { hash?: string; configRevisionHash?: string; appliedConfigHash?: string };

/** A merge patch, waited on until the gateway runs with it. */
async function patchConfig(ctx: BotsContext, patch: JsonRecord): Promise<void> {
  const admin = ctx.clients.admin;
  const before = rec(await admin.request("config.get", {})) as Revision;
  const patched = rec(
    await admin.request("config.patch", { raw: JSON.stringify(patch), baseHash: before.hash }),
  );
  expect(patched.ok === true, `config.patch was refused: ${show(patched)}`);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // A read that fails proves nothing: wait and read again.
    const read = await admin.request("config.get", {}).catch(() => null);
    const now = rec(read) as Revision;
    if (
      read !== null &&
      typeof now.configRevisionHash === "string" &&
      (patched.noop === true || now.configRevisionHash !== before.configRevisionHash) &&
      now.appliedConfigHash === now.configRevisionHash
    )
      return;
    await sleep(200);
  }
  throw new BotsCheckFailure("the gateway did not apply the patched config within 30 seconds");
}

/**
 * One `tools` setting for one check, put back afterwards to what it was
 * (removed when it was absent), whatever happens.
 */
async function withSetting<T>(
  ctx: BotsContext,
  key: string,
  value: unknown,
  body: () => Promise<T>,
): Promise<T> {
  const read = rec(await ctx.clients.admin.request("config.get", {}));
  const tools = rec(rec(read.config).tools);
  const before = Object.hasOwn(tools, key) ? tools[key] : null;
  try {
    // Inside: a patch the gateway took but didn't apply in time is put back too.
    await patchConfig(ctx, { tools: { [key]: value } });
    return await body();
  } finally {
    await patchConfig(ctx, { tools: { [key]: restorePatch(before, value) } });
  }
}

const isRecord = (v: unknown): v is JsonRecord =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The merge patch that puts back `before` after `set` was merged over it: a key `set` added
 * is removed (null), one it changed gets its old value, and an absent setting is removed.
 */
export function restorePatch(before: unknown, set: unknown): unknown {
  if (before === null || before === undefined) return null;
  if (!isRecord(before) || !isRecord(set)) return before;
  const out: JsonRecord = {};
  for (const key of Object.keys(set))
    out[key] = Object.hasOwn(before, key) ? restorePatch(before[key], set[key]) : null;
  return out;
}

/** The gateway's routines, disabled ones included. */
async function routines(ctx: BotsContext): Promise<JsonRecord[]> {
  const listed = rec(await ctx.clients.admin.request("cron.list", { includeDisabled: true }));
  return Array.isArray(listed.jobs) ? (listed.jobs as JsonRecord[]) : [];
}

/** Removes every routine this run of the checks made. */
async function clearRoutines(ctx: BotsContext, world: World): Promise<void> {
  for (const job of await routines(ctx)) {
    if (world.jobs.has(String(job.id)))
      await ctx.clients.admin.request("cron.remove", { id: job.id }).catch(() => {});
  }
}

/** A routine of the admin's own, run once now in a session of its own. */
async function routineRun(ctx: BotsContext, world: World, message: string): Promise<string> {
  const admin = ctx.clients.admin;
  const added = rec(
    await admin.request("cron.add", {
      name: `Bots check ${world.stamp}-${++world.counter}`,
      agentId: "pip",
      schedule: { kind: "at", at: "2035-01-01T09:00:00Z" },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message },
      delivery: { mode: "none" },
    }),
  );
  const id = String(added.id ?? rec(added.job).id);
  world.jobs.add(id);
  await admin.request("cron.run", { id, mode: "force" });
  return id;
}

/** A routine's runs once one has finished, with what it said. */
async function routineFinished(ctx: BotsContext, id: string): Promise<JsonRecord> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const runs = rec(
      await ctx.clients.admin.request("cron.runs", { id, limit: 5 }).catch(() => ({})),
    );
    const entries = (
      Array.isArray(runs.entries) ? runs.entries : Array.isArray(runs.runs) ? runs.runs : []
    ) as JsonRecord[];
    const done = entries.find(
      (e) => e.status === "ok" || e.status === "error" || e.action === "finished",
    );
    if (done) return done;
    expect(Date.now() < deadline, `routine ${id} did not finish a run within 90 seconds`);
    await sleep(1000);
  }
}

const lines = (text: string) => text.split("\n")[0] ?? "";

export type BotsCheck = {
  name: string;
  /** The scripted directives it sends. */
  covers: string[];
  run(ctx: BotsContext, world: World): Promise<void>;
};

export const BOTS_CHECKS: BotsCheck[] = [
  {
    name: "Tool Search: before_tool_call fires for a call through the catalog (tool_call; dispatch_action on 2026.11.10), with the tool's own name and the run's id",
    covers: ["#catalog-call"],
    async run(ctx, world) {
      await withSetting(ctx, "toolSearch", true, async () => {
        const t = await turn(ctx, await task(ctx, world, "pip", "catalog"), "#catalog-call");
        expect(
          t.calls.some((c) => (c.name === "tool_call" || c.name === "dispatch_action") && c.ok),
          `no tool_call ran: ${show(t.calls)}`,
        );
        const run = await runOf(ctx, t.runId);
        expect(run.known === true, `the plugin doesn't know the run: ${show(run)}`);
        expect(
          rec(run.readOutside).tool === "sessions_list",
          `the hook didn't see sessions_list through the catalog: ${show(run.readOutside)}`,
        );
      });
    },
  },
  {
    name: "Code Mode: before_tool_call fires for a call from a code cell, with the tool's own name and the run's id",
    covers: ["#code-call"],
    async run(ctx, world) {
      await withSetting(ctx, "codeMode", { enabled: true }, async () => {
        const t = await turn(ctx, await task(ctx, world, "pip", "code"), "#code-call");
        expect(
          t.calls.some((c) => c.name === "exec" && c.ok),
          `no code cell ran: ${show(t.calls)}`,
        );
        const run = await runOf(ctx, t.runId);
        expect(
          rec(run.readOutside).tool === "sessions_list",
          `the hook didn't see sessions_list from the code cell: ${show(run.readOutside)}`,
        );
      });
    },
  },
  {
    name: "a run Clawtrate sent is typed here, its run id is the device's key, and clawtrate_here can't tell from the plugin alone",
    covers: ["#here"],
    async run(ctx, world) {
      const t = await turn(ctx, await task(ctx, world, "pip", "here"), "#here");
      const run = await runOf(ctx, t.runId);
      expect(
        run.known === true && run.kind === "typed" && run.channel === "webchat",
        `run: ${show(run)}`,
      );
      expect(run.readOutside === null, `a typed run that read nothing was marked: ${show(run)}`);
      expect(t.reply.startsWith("In Clawtrate: can't tell yet"), `reply: ${lines(t.reply)}`);
    },
  },
  {
    name: "another bot's sessions_send is not typed here",
    covers: ["#message-here"],
    async run(ctx, world) {
      const t = await turn(ctx, await task(ctx, world, "pip", "message"), "#message-here");
      expect(
        t.reply.includes("In Clawtrate: no. This run was started by a message from another bot"),
        `Marlow's answer, as Pip relayed it: ${t.reply.slice(0, 300)}`,
      );
    },
  },
  {
    name: "a run from the command line is not typed here",
    covers: [],
    async run(ctx, world) {
      const key = await task(ctx, world, "pip", "cli");
      const out = await ctx.cli([
        "agent",
        "--agent",
        "pip",
        "--session-key",
        key,
        "--message",
        "#here",
        "--json",
      ]);
      expect(out.status === 0, `openclaw agent failed: ${out.stderr.slice(0, 300)}`);
      const reply = await lastReply(ctx, key);
      expect(
        reply.startsWith("In Clawtrate: no. This message came from the gateway's command line"),
        `reply: ${lines(reply)}`,
      );
    },
  },
  {
    // On 2026.10.6 a task's run carries nothing that tells it from a typed one (design 4.1);
    // the plugin knows it from the spawn it let through.
    name: "a visible task's run is not typed here, on both versions (the plugin saw the spawn)",
    covers: ["#hand-off-here"],
    async run(ctx, world) {
      const t = await turn(ctx, await task(ctx, world, "pip", "task"), "#hand-off-here");
      const spawned = t.calls.find((c) => c.name === "sessions_spawn");
      const child = /"childSessionKey":\s*"([^"]+)"/.exec(spawned?.text ?? "")?.[1];
      expect(child, `no task started: ${show(t.calls)}`);
      const said = await toolAnswer(ctx, child, "clawtrate_here");
      const expected = "In Clawtrate: no. This run is a task's brief";
      expect(said.startsWith(expected), `the task's clawtrate_here: ${lines(said)}`);
    },
  },
  {
    name: "a spawn the gateway refused leaves no wait behind: the person's next task is typed",
    covers: ["#hand-off-twice", "#hand-off-same"],
    async run(ctx, world) {
      const t = await turn(ctx, await task(ctx, world, "pip", "twice"), "#hand-off-twice");
      const spawns = t.calls.filter((c) => c.name === "sessions_spawn");
      expect(
        spawns.length === 2 && /"status":\s*"error"/.test(spawns[1]!.text),
        `the second spawn: ${show(spawns.map((c) => c.text.slice(0, 120)))}`,
      );
      // Once the first task has reported back, one refused spawn on its own, nothing after it.
      await sleep(5000);
      const again = await turn(ctx, await task(ctx, world, "pip", "same"), "#hand-off-same");
      const refused = again.calls.find((c) => c.name === "sessions_spawn");
      expect(
        /"status":\s*"error"/.test(refused?.text ?? ""),
        `the refused spawn: ${show(refused)}`,
      );
      // Within the minute a spawn waits for its task's first run.
      const next = await turn(ctx, await task(ctx, world, "pip", "after-twice"), "#text");
      const run = await runOf(ctx, next.runId);
      expect(run.kind === "typed", `the person's next task: ${show(run)}`);
    },
  },
  {
    name: "a run's record isn't vouched for across a change of conversation access, through runs.get too",
    covers: [],
    async run(ctx, world) {
      const t = await turn(ctx, await task(ctx, world, "pip", "access"), "#text");
      expect((await runOf(ctx, t.runId)).known === true, "the run isn't known with access on");
      const access = (on: boolean) => ({
        plugins: { entries: { "clawtrate-bots": { hooks: { allowConversationAccess: on } } } },
      });
      try {
        await patchConfig(ctx, access(false));
        const off = await runOf(ctx, t.runId);
        expect(off.known === false, `with access off: ${show(off)}`);
      } finally {
        await patchConfig(ctx, access(true));
      }
      const back = await runOf(ctx, t.runId);
      expect(back.known === false, `with access back on: ${show(back)}`);
      // A run that starts now is recorded as usual.
      const fresh = await turn(ctx, await task(ctx, world, "pip", "access-back"), "#text");
      const run = await runOf(ctx, fresh.runId);
      expect(
        run.known === true && run.kind === "typed",
        `a run after access is back: ${show(run)}`,
      );
    },
  },
  {
    name: "after a web search, the bot's own hidden task is a task, and carries what its starter read",
    covers: ["#hand-off-hidden-here"],
    async run(ctx, world) {
      const t = await turn(
        ctx,
        await task(ctx, world, "pip", "hidden"),
        "#search #hand-off-hidden-here",
      );
      const spawned = t.calls.find((c) => c.name === "sessions_spawn");
      const child = /"childSessionKey":\s*"([^"]+)"/.exec(spawned?.text ?? "")?.[1];
      expect(child, `no task started: ${show(t.calls)}`);
      await toolAnswer(ctx, child, "clawtrate_here").catch(() => "");
      const run = rec(
        await ctx.clients.reader.request("clawtrate-bots.runs.get", { sessionKey: child }),
      );
      expect(
        run.kind === "task" && rec(run.readOutside).source === "web",
        `the hidden task's run: ${show(run)}`,
      );
    },
  },
  {
    // An isolated routine run keeps no history a client can read, so the plugin's own record says.
    name: "a routine's run is not typed here",
    covers: [],
    async run(ctx, world) {
      const id = await routineRun(ctx, world, "#here");
      const done = await routineFinished(ctx, id);
      const run = rec(
        await ctx.clients.reader.request("clawtrate-bots.runs.get", {
          sessionKey: done.sessionKey,
        }),
      );
      expect(run.known === true && run.kind === "routine", `the routine's run: ${show(run)}`);
    },
  },
  {
    name: "a run that searched the web is marked, with its source",
    covers: ["#search"],
    async run(ctx, world) {
      const t = await turn(ctx, await task(ctx, world, "pip", "search"), "#search #here");
      expect(rec((await runOf(ctx, t.runId)).readOutside).source === "web", "not marked");
      expect(
        t.reply.includes("You've read a web page in this run"),
        `reply: ${t.reply.slice(0, 300)}`,
      );
    },
  },
  {
    name: "a run that read a task's history is marked, with its source",
    covers: ["#read-history"],
    async run(ctx, world) {
      const t = await turn(ctx, await task(ctx, world, "pip", "history"), "#read-history #here");
      expect(rec((await runOf(ctx, t.runId)).readOutside).source === "task", "not marked");
      expect(
        t.reply.includes("You've read a task's history in this run"),
        `reply: ${t.reply.slice(0, 300)}`,
      );
    },
  },
  {
    name: "clawtrate_bots: find returns ids only and marks nothing; a full list marks the run",
    covers: ["#find-partner", "#list-bots"],
    async run(ctx, world) {
      const found = await turn(ctx, await task(ctx, world, "pip", "find"), "#find-partner");
      expect((await runOf(ctx, found.runId)).readOutside === null, "find marked the run");
      expect(found.reply.startsWith("Bots with that name:"), `reply: ${lines(found.reply)}`);
      const listed = await turn(ctx, await task(ctx, world, "pip", "list"), "#list-bots");
      expect(
        rec((await runOf(ctx, listed.runId)).readOutside).source === "names",
        "the list didn't mark the run",
      );
    },
  },
];

/** Run the checks in order. A check's failure doesn't stop the next. */
export async function runBotsChecks(
  ctx: BotsContext,
  log: (line: string) => void = console.log,
): Promise<{ passed: number; failed: number }> {
  const world: World = { stamp: Date.now().toString(36), counter: 0, jobs: new Set() };
  let passed = 0;
  let failed = 0;
  try {
    await withPairNames(ctx, async () => {
      for (const check of BOTS_CHECKS) {
        try {
          await check.run(ctx, world);
          passed += 1;
          log(`ok    ${check.name}`);
        } catch (error) {
          failed += 1;
          log(`FAIL  ${check.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
  } catch (error) {
    failed += 1;
    log(`FAIL  the pair's names: ${error instanceof Error ? error.message : String(error)}`);
  }
  await clearRoutines(ctx, world).catch(() => {});
  return { passed, failed };
}

/** The pair the checks use, Pip and Marlow, whose names some checks read. */
const PAIR = ["pip", "marlow"];

/**
 * The pair's names as seeding gives them (`agents set-identity`), for an instance
 * started with `--no-seed`, as `pnpm scenarios` starts it; put back afterwards.
 */
async function withPairNames(ctx: BotsContext, body: () => Promise<void>): Promise<void> {
  const read = rec(await ctx.clients.admin.request("config.get", {}));
  const entries = rec(rec(rec(read.config).agents).entries);
  const patch: JsonRecord = {};
  for (const bot of SEED_BOTS.filter((b) => PAIR.includes(b.id))) {
    if (typeof rec(rec(entries[bot.id]).identity).name === "string") continue;
    patch[bot.id] = { identity: { name: bot.name } };
  }
  if (Object.keys(patch).length === 0) return body();
  const before = Object.fromEntries(Object.keys(patch).map((id) => [id, entries[id] ?? null]));
  try {
    await patchConfig(ctx, { agents: { entries: patch } });
    await body();
  } finally {
    await patchConfig(ctx, { agents: { entries: restorePatch(before, patch) } });
  }
}

/** On its own, against a named instance started with `--with-plugin clawtrate-bots`. */
async function main(): Promise<number> {
  const at = process.argv.indexOf("--instance");
  const name = at > 0 ? process.argv[at + 1] : undefined;
  if (!name) throw new Error("usage: bots-checks.ts --instance <name>");
  const { openInstance, openOperator } = await import("./cli.ts");
  const inst = openInstance(name);
  const clients: Partial<Record<BotsClient, OperatorSession>> = {};
  try {
    for (const [client, { scopes, caps }] of Object.entries(BOTS_CLIENTS)) {
      clients[client as BotsClient] = await openOperator(
        inst,
        `Clawtrate bots check (${client})`,
        [...scopes],
        [...caps],
      );
    }
    const { passed, failed } = await runBotsChecks({
      clients: clients as Record<BotsClient, OperatorSession>,
      cli: async (args) => {
        const r = await inst.runner.run(args);
        return { status: r.status, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
      },
    });
    console.log(`${passed} of ${passed + failed} bots checks passed`);
    return failed === 0 ? 0 : 1;
  } finally {
    for (const op of Object.values(clients)) await op?.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
