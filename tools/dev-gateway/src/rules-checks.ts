// The rules checks: the clawtrate-tool-rules plugin on a real development
// gateway, asserted from the gateway's answers. `pnpm scenarios` runs them on
// an instance of their own started with `--with-plugin clawtrate-tool-rules`.
//
// Clients, each its own paired device: an admin connection; the interactive
// device that starts every run (read, write, approvals, questions, as
// Clawtrate's interactive tier); another device holding the approvals scope;
// one with read and write only; and a read-only one. Bots act through the
// scripted model's directives (#write, #read, #ask, #slow-tool, and
// #message-read from Marlow to Pip); a routine is run with `cron.run`.
//
// Where the gateway does something the design did not know, the check
// asserts what it does and says so in its name (the plugin turned off in the
// middle of a run, a run another bot's message started).

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GatewayEvent, OperatorSession } from "./operator.ts";
import { drainSessions } from "./scenario-check.ts";

type JsonRecord = Record<string, unknown>;
const rec = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class RulesCheckFailure extends Error {}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RulesCheckFailure(message);
}
const show = (value: unknown) => JSON.stringify(value)?.slice(0, 400) ?? String(value);
function same(actual: unknown, expected: unknown, what: string): void {
  expect(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${what}: expected ${show(expected)}, got ${show(actual)}`,
  );
}

const INTERACTIVE = ["operator.read", "operator.write", "operator.approvals", "operator.questions"];
export const RULES_CLIENTS = {
  admin: {
    scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
    caps: ["tool-events", "approvals"],
  },
  interactive: { scopes: INTERACTIVE, caps: ["tool-events", "approvals"] },
  approver: {
    scopes: ["operator.read", "operator.write", "operator.approvals"],
    caps: ["tool-events", "approvals"],
  },
  writer: { scopes: ["operator.read", "operator.write"], caps: ["tool-events"] },
  reader: { scopes: ["operator.read"], caps: [] },
} as const;
export type RulesClient = keyof typeof RULES_CLIENTS;

export type RulesContext = {
  clients: Record<RulesClient, OperatorSession>;
  /** The instance's gateway log, which the plugin writes its warnings to. */
  gatewayLog: string;
  /** The instance's state folder, which holds the plugin's rules file. */
  stateDir: string;
};

const PLUGIN = "clawtrate-tool-rules";
const CHANGED_EVENT = `plugin.${PLUGIN}.changed`;
const REQUESTED = "plugin.approval.requested";
/** The plugin's own version and the rules' schema (plugins/clawtrate-tool-rules). */
const VERSION = "1.0.0";
/** What the gateway answers for a call whose approval it could not take (OpenClaw 2026.10.6). */
const GATEWAY_UNAVAILABLE = "Plugin approval required (gateway unavailable)";
const DENIED = "Denied by user. The tool call did not run.";
/** Juniper, whose id is the gateway's built-in `main`. */
const BOT = "main";

type Answer =
  | { ok: true; payload: JsonRecord }
  | { ok: false; code: string; message: string; details: JsonRecord };

async function call(op: OperatorSession, method: string, params: JsonRecord = {}): Promise<Answer> {
  try {
    return { ok: true, payload: rec(await op.request(method, params, 30_000)) };
  } catch (error) {
    const e = rec(error);
    return {
      ok: false,
      code: String(e.gatewayCode ?? e.code ?? ""),
      message: String(e.message ?? error),
      details: rec(e.details),
    };
  }
}
function answered(answer: Answer, what: string): JsonRecord {
  expect(answer.ok, `${what} was refused: ${answer.ok ? "" : `${answer.code} ${answer.message}`}`);
  return answer.payload;
}
const rules = (op: OperatorSession, method: string, params: JsonRecord = {}) =>
  call(op, `${PLUGIN}.${method}`, params);

type Rule = {
  action: "allow" | "ask" | "never";
  tools: string[];
  target?: JsonRecord;
  id?: string;
};
type Scope = {
  version: number;
  fallback: boolean;
  rules: (Rule & { id: string; version: number })[];
};

async function scopes(ctx: RulesContext): Promise<Record<string, Scope>> {
  return rec(answered(await rules(ctx.clients.reader, "get"), "get").scopes) as Record<
    string,
    Scope
  >;
}

/** Save a scope as an admin does: its version as read, then `set`. */
async function save(
  ctx: RulesContext,
  scope: string,
  list: Rule[],
  fallback = false,
): Promise<Scope> {
  const version = (await scopes(ctx))[scope]?.version ?? 0;
  const saved = answered(
    await rules(ctx.clients.admin, "set", {
      scope,
      rules: list,
      fallback,
      expectedVersion: version,
    }),
    `set ${scope}`,
  );
  return saved as unknown as Scope;
}

/** Every scope emptied, so each check starts from no rules. */
async function clearRules(ctx: RulesContext): Promise<void> {
  for (const scope of Object.keys(await scopes(ctx))) await save(ctx, scope, []);
}

/** A tool call of a run; `result` says whether its result arrived at all. */
type ToolCall = {
  name: string;
  result: boolean;
  isError: boolean;
  text: string;
  details: JsonRecord;
};
type BotRun = { runId: string; state: string; calls: ToolCall[] };

type World = { stamp: string; keys: Set<string>; counter: number };

/** A new task of a bot, subscribed to by every client. */
async function task(ctx: RulesContext, world: World, bot: string, tag: string): Promise<string> {
  world.counter += 1;
  const key = `agent:${bot}:rules-${tag}-${world.stamp}-${world.counter}`;
  world.keys.add(key);
  for (const op of Object.values(ctx.clients)) {
    await op.request("sessions.messages.subscribe", { key }).catch(() => {});
  }
  return key;
}

/** Where every client's events stand now, to look only at what comes after. */
const marks = (ctx: RulesContext) =>
  Object.fromEntries(Object.entries(ctx.clients).map(([name, op]) => [name, op.lastSeq])) as Record<
    RulesClient,
    number
  >;

async function start(ctx: RulesContext, key: string, message: string): Promise<string> {
  const sent = await ctx.clients.interactive.send(key, message);
  return String(sent.runId);
}

/** The run's end, and its tool calls with their results, as the interactive device saw them. */
async function finish(ctx: RulesContext, runId: string, timeoutMs = 120_000): Promise<BotRun> {
  const op = ctx.clients.interactive;
  const end = await op.terminal(runId, timeoutMs);
  await sleep(300);
  return { runId, state: String(end.state), calls: toolCallsOf(op.runEvents(runId)) };
}

/** A run's tool calls from its events: a start, then the result if it arrived. */
export function toolCallsOf(events: GatewayEvent[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const event of events) {
    const payload = rec(event.payload);
    if (event.event !== "agent" || payload.stream !== "tool") continue;
    const data = rec(payload.data);
    if (data.phase === "start") {
      calls.push({ name: String(data.name), result: false, isError: false, text: "", details: {} });
    } else if (data.phase === "result") {
      const last = calls.at(-1);
      if (!last) continue;
      const result = rec(data.result);
      const blocks = Array.isArray(result.content) ? (result.content as JsonRecord[]) : [];
      last.result = true;
      last.isError = data.isError === true;
      last.text = blocks.map((block) => String(block.text ?? "")).join("\n");
      last.details = rec(result.details);
    }
  }
  return calls;
}

/** Whether a call ran: its result arrived, and it is not an error. A start alone is not. */
export const ranOk = (call: ToolCall | undefined) => call?.result === true && !call.isError;

type Card = { id: string; request: JsonRecord; createdAtMs: number; expiresAtMs: number };

/** The plugin's card for a run, as the interactive device received it. */
async function cardFor(ctx: RulesContext, runId: string, after: number): Promise<Card> {
  const event = await ctx.clients.interactive.waitFor(
    `the rules plugin's card for run ${runId}`,
    (e) => e.event === REQUESTED && rec(rec(e.payload).request).runId === runId,
    60_000,
    after,
  );
  const payload = rec(event.payload);
  return {
    id: String(payload.id),
    request: rec(payload.request),
    createdAtMs: Number(payload.createdAtMs),
    expiresAtMs: Number(payload.expiresAtMs),
  };
}

/** Which clients received a card for `runId` (or any card, without one) since `since`. */
function cardsSeen(ctx: RulesContext, since: Record<RulesClient, number>, runId?: string) {
  return (Object.keys(ctx.clients) as RulesClient[]).filter((name) =>
    ctx.clients[name].events.some(
      (e) =>
        e.seq > since[name] &&
        e.event === REQUESTED &&
        (runId === undefined || rec(rec(e.payload).request).runId === runId),
    ),
  );
}

/** The ids of the plugin cards a connection can list as waiting. */
async function waitingCards(op: OperatorSession): Promise<string[]> {
  const listed = await op.request<unknown>("plugin.approval.list", {}, 30_000);
  return (Array.isArray(listed) ? (listed as unknown[]) : []).map((card) => String(rec(card).id));
}

async function resolve(ctx: RulesContext, id: string, decision: string): Promise<void> {
  answered(
    await call(ctx.clients.interactive, "plugin.approval.resolve", { id, decision }),
    `answering ${decision}`,
  );
}

type Decision = JsonRecord & { decision: string; source: JsonRecord | null; callId: string | null };

/** The plugin's decision records of a run, read at the read tier, newest first. */
async function decisionsOf(ctx: RulesContext, filter: JsonRecord): Promise<Decision[]> {
  const listed = answered(
    await rules(ctx.clients.reader, "decisions.list", filter),
    "decisions.list",
  );
  return (listed.records ?? []) as Decision[];
}

/** The audit log's tool records of a run, at the read tier. */
async function auditOf(ctx: RulesContext, runId: string): Promise<JsonRecord[]> {
  const listed = answered(
    await call(ctx.clients.reader, "audit.activity.list", { runId, limit: 50 }),
    "audit.activity.list",
  );
  return ((listed.events ?? []) as JsonRecord[]).filter((e) => e.kind === "tool_action");
}

/** The audit record of the call a decision record names, by run and hashed call id. */
async function joined(ctx: RulesContext, record: Decision): Promise<JsonRecord> {
  expect(record.callId?.startsWith("sha256:"), `the record's call id: ${show(record.callId)}`);
  const deadline = Date.now() + 10_000;
  for (;;) {
    const found = (await auditOf(ctx, String(record.runId))).find(
      (e) => e.toolCallId === record.callId && e.action === "tool.action.finished",
    );
    if (found) return found;
    expect(
      Date.now() < deadline,
      `no audit record shares run ${record.runId} and call ${record.callId}`,
    );
    await sleep(500);
  }
}

type Revision = { hash: string; configRevisionHash?: string; appliedConfigHash?: string };

/**
 * A merge patch, waited on until the gateway runs with it. A list it removes
 * entries from is named in `replacePaths`, as the gateway asks.
 */
async function patchConfig(
  ctx: RulesContext,
  patch: JsonRecord,
  replacePaths: string[] = [],
): Promise<void> {
  const admin = ctx.clients.admin;
  const before = await admin.request<Revision>("config.get", {});
  const patched = await admin.request<{ ok?: boolean }>("config.patch", {
    raw: JSON.stringify(patch),
    baseHash: before.hash,
    ...(replacePaths.length > 0 ? { replacePaths } : {}),
  });
  expect(patched.ok === true, `config.patch was refused: ${show(patched)}`);
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const now = await admin.request<Revision>("config.get", {}).catch(() => null);
    if (now && now.configRevisionHash !== before.configRevisionHash) {
      if (now.appliedConfigHash === now.configRevisionHash) return;
    }
    await sleep(200);
  }
  throw new RulesCheckFailure("the gateway did not apply the patched config within 30 seconds");
}

/**
 * Run `body` with a temporary setting: `apply` inside the try, so a change the
 * gateway took but did not confirm in time is undone too, and `restore` in
 * the finally, whether the body passed or not.
 */
export async function withConfig<T>(
  apply: () => Promise<void>,
  restore: () => Promise<void>,
  body: () => Promise<T>,
): Promise<T> {
  try {
    await apply();
    return await body();
  } finally {
    await restore();
  }
}

const botEntry = async (ctx: RulesContext, bot: string) =>
  rec(rec(rec(rec(await ctx.clients.admin.request("config.get", {})).config).agents).entries)[bot];

/** Wait until the plugin answers `status` with its hook registered, or fail. */
async function pluginRunning(ctx: RulesContext): Promise<JsonRecord> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const status = await rules(ctx.clients.reader, "status");
    if (status.ok && rec(status.payload.hook).registered === true) return status.payload;
    expect(Date.now() < deadline, `the rules plugin did not answer again: ${show(status)}`);
    await sleep(500);
  }
}

const WRITE_PATH = "notes/scratch.md";
const askWrite = (pattern = "notes/**"): Rule => ({
  action: "ask",
  tools: ["write"],
  target: { kind: "path", pattern },
});

export type RulesCheck = {
  name: string;
  /** The scripted directives it sends. */
  covers: string[];
  run(ctx: RulesContext, world: World): Promise<void>;
};

/** The plugin's rules file in the instance (plugins/clawtrate-tool-rules, lib/store.js). */
const rulesFile = (ctx: RulesContext) => join(ctx.stateDir, PLUGIN, "rules.json");

const statusOf = async (ctx: RulesContext) =>
  answered(await rules(ctx.clients.reader, "status"), "status");

/** Wait until the gateway's log holds `text`, which the plugin writes as its state changes. */
/** What `get` returns once it returns something, waiting at most `timeoutMs`. */
export async function eventually<T>(
  what: string,
  get: () => Promise<T | undefined>,
  timeoutMs = 30_000,
  everyMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await get();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new RulesCheckFailure(`${what} did not appear within ${timeoutMs} ms`);
    }
    await sleep(everyMs);
  }
}

export const logSaysAfter = (log: Buffer, text: string, from: number) =>
  log.subarray(from).toString("utf8").includes(text);

/** Where the gateway's log ends now: take it before a transition, then look after it. */
function logMark(ctx: RulesContext): number {
  try {
    return statSync(ctx.gatewayLog).size;
  } catch {
    return 0;
  }
}

/** Wait until the gateway's log says `text` after `from`, so an earlier line never counts. */
async function logged(ctx: RulesContext, text: string, from: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!logSaysAfter(readFileSync(ctx.gatewayLog), text, from)) {
    expect(Date.now() < deadline, `the gateway's log never said, after the change: ${text}`);
    await sleep(250);
  }
}

/** Turn approval forwarding on with no destination, so nothing is delivered anywhere. */
const FORWARD_NOWHERE = { approvals: { plugin: { enabled: true, mode: "targets", targets: [] } } };

export const RULES_CHECKS: RulesCheck[] = [
  {
    // First, while this gateway process has never read a rules file.
    name: "rules lost with no copy read: every call but ask_user asks, saying the rules could not be read, and status says so",
    covers: ["#read", "#ask"],
    async run(ctx, world) {
      const before = await statusOf(ctx);
      same(
        [rec(before.rules).state, before.enforcing],
        ["none", "nothing"],
        "status before any rules file",
      );
      mkdirSync(join(ctx.stateDir, PLUGIN), { recursive: true });
      const losing = logMark(ctx);
      writeFileSync(rulesFile(ctx), "{ not rules");
      try {
        const status = await statusOf(ctx);
        same(
          [status.rules, status.enforcing, status.matches],
          [
            { state: "lost", reason: "the rules file is not JSON", keptCopyReadAt: null },
            "ask-every-call",
            null,
          ],
          "status with the rules lost",
        );
        await logged(
          ctx,
          "Rules unavailable: the rules file is not JSON. No copy was read",
          losing,
        );
        const key = await task(ctx, world, BOT, "lost");
        const since = marks(ctx);
        const runId = await start(ctx, key, "#read");
        const card = await cardFor(ctx, runId, since.interactive);
        same(card.request.title, "read: Clawtrate's rules could not be read", "the card's title");
        same(card.request.allowedDecisions, ["allow-once", "deny"], "the card's decisions");
        await resolve(ctx, card.id, "deny");
        await finish(ctx, runId);
        const [record] = await decisionsOf(ctx, { runId });
        same(
          [record?.rules, record?.decision, record?.source],
          ["lost", "ask", { kind: "rules-lost" }],
          "the lost-rules decision record",
        );
        const question = marks(ctx);
        const askRun = await start(ctx, key, "#ask");
        await ctx.clients.interactive.waitFor(
          "the question",
          (e) => e.event === "question.requested",
          60_000,
          question.interactive,
        );
        await sleep(1000);
        same(cardsSeen(ctx, question, askRun), [], "who received a card for ask_user");
        await ctx.clients.interactive.request("chat.abort", { sessionKey: key }).catch(() => {});
        await ctx.clients.interactive.terminal(askRun, 60_000);
      } finally {
        writeFileSync(rulesFile(ctx), JSON.stringify({ format: PLUGIN, schema: 1, scopes: {} }));
      }
      same((await statusOf(ctx)).enforcing, "rules", "status after reading a valid empty policy");
    },
  },
  {
    name: "status, get and decisions.list answer at the read tier, set only for admin, and its event is empty",
    covers: [],
    async run(ctx) {
      const { admin, reader } = ctx.clients;
      const status = answered(await rules(reader, "status"), "status at the read tier");
      same(
        [
          status.plugin,
          status.version,
          status.rulesSchema,
          rec(status.rules).state,
          status.enforcing,
          rec(status.hook).registered,
        ],
        // The check before it leaves a valid empty store.
        [PLUGIN, VERSION, 1, "read", "rules", true],
        "the plugin's status",
      );
      answered(await rules(reader, "get"), "get at the read tier");
      answered(
        await rules(reader, "decisions.list", { limit: 1 }),
        "decisions.list at the read tier",
      );
      for (const name of ["reader", "writer", "approver", "interactive"] as const) {
        const refused = await rules(ctx.clients[name], "set", {
          scope: BOT,
          rules: [],
          fallback: false,
          expectedVersion: 0,
        });
        expect(!refused.ok, `set from the ${name} connection was accepted`);
        same(
          [refused.code, refused.details.missingScope],
          ["FORBIDDEN", "operator.admin"],
          `set from the ${name} connection`,
        );
      }
      const since = marks(ctx);
      await save(ctx, BOT, [askWrite()]);
      for (const [name, op] of Object.entries(ctx.clients)) {
        const event = await op.waitFor(
          `${name}'s invalidation event`,
          (e) => e.event === CHANGED_EVENT,
          10_000,
          since[name as RulesClient],
        );
        same(event.payload, {}, `the invalidation event ${name} received`);
      }
      const after = answered(await rules(admin, "status"), "status after a save");
      same(rec(after.matches).tools, ["write"], "the tools the rules match");
    },
  },
  {
    name: "an Ask shows the gateway's card to the run's device and admin only; Allow once runs the call once and the next identical call asks again",
    covers: ["#write"],
    async run(ctx, world) {
      const saved = await save(ctx, BOT, [askWrite()]);
      const ruleId = saved.rules[0]!.id;
      const key = await task(ctx, world, BOT, "ask");
      const since = marks(ctx);
      const runId = await start(ctx, key, "#write");
      const card = await cardFor(ctx, runId, since.interactive);
      same(card.request.pluginId, PLUGIN, "the card's plugin");
      same(card.request.allowedDecisions, ["allow-once", "deny"], "the card's decisions");
      same(card.expiresAtMs - card.createdAtMs, 600_000, "the card's wait");
      const title = String(card.request.title);
      const description = String(card.request.description);
      expect(title.length <= 80, `the title is ${title.length} characters`);
      expect(description.length <= 512, `the description is ${description.length} characters`);
      expect(
        description.includes(`rule ${ruleId}`) && description.includes(WRITE_PATH),
        `the description names the rule and the target: ${description}`,
      );
      await sleep(1000);
      same(cardsSeen(ctx, since, runId).sort(), ["admin", "interactive"], "who received the card");
      await resolve(ctx, card.id, "allow-once");
      const first = await finish(ctx, runId);
      same(first.state, "final", "the first run's end");
      expect(
        first.calls.length === 1 && first.calls[0]!.name === "write" && ranOk(first.calls[0]),
        `Allow once did not run the write: ${show(first.calls)}`,
      );
      const again = marks(ctx);
      const secondRun = await start(ctx, key, "#write");
      const second = await cardFor(ctx, secondRun, again.interactive);
      expect(second.id !== card.id, "the second call reused the first card");
      await resolve(ctx, second.id, "deny");
      await finish(ctx, secondRun);
      const [record] = await decisionsOf(ctx, { runId });
      same(
        [record?.decision, record?.source, record?.answer],
        ["ask", { kind: "rule", scope: BOT, ruleId, version: 1, action: "ask" }, "allow-once"],
        "the decision record of the first call",
      );
      same((await joined(ctx, record!)).status, "succeeded", "the joined audit record's status");
    },
  },
  {
    name: "Deny on the card refuses the call",
    covers: ["#write"],
    async run(ctx, world) {
      await save(ctx, BOT, [askWrite()]);
      const key = await task(ctx, world, BOT, "deny");
      const since = marks(ctx);
      const runId = await start(ctx, key, "#write");
      const card = await cardFor(ctx, runId, since.interactive);
      await resolve(ctx, card.id, "deny");
      const run = await finish(ctx, runId);
      const write = run.calls[0];
      expect(write?.isError && write.text.includes(DENIED), `the denied call: ${show(run.calls)}`);
      same(write!.details.status, "error", "the denied call's status");
      const [record] = await decisionsOf(ctx, { runId });
      same(record?.answer, "deny", "the decision record's answer");
      same((await joined(ctx, record!)).status, "blocked", "the joined audit record's status");
    },
  },
  {
    name: "a Never blocks the call with the rule named, and no card",
    covers: ["#write"],
    async run(ctx, world) {
      const saved = await save(ctx, BOT, [
        { action: "never", tools: ["write"], target: { kind: "path", pattern: "notes/**" } },
      ]);
      const ruleId = saved.rules[0]!.id;
      const key = await task(ctx, world, BOT, "never");
      const since = marks(ctx);
      const runId = await start(ctx, key, "#write");
      const run = await finish(ctx, runId);
      const write = run.calls[0];
      expect(write?.isError, `the write was not refused: ${show(run.calls)}`);
      same(write!.details.status, "blocked", "the refused call's status");
      expect(
        String(write!.details.reason).includes(`rule ${ruleId}`) &&
          String(write!.details.reason).includes("version 1"),
        `the reason does not name the rule: ${show(write!.details)}`,
      );
      same(cardsSeen(ctx, since, runId), [], "who received a card");
      const [record] = await decisionsOf(ctx, { runId });
      same(record?.decision, "block", "the decision record");
      same((await joined(ctx, record!)).status, "blocked", "the joined audit record's status");
    },
  },
  {
    name: "an Allow does not pass an Ask, from the bot's rules or every bot's",
    covers: ["#write"],
    async run(ctx, world) {
      const saved = await save(ctx, BOT, [
        { action: "allow", tools: ["write"], target: { kind: "path", pattern: "notes/**" } },
        askWrite(),
      ]);
      await save(ctx, "*", [{ action: "allow", tools: ["write"] }]);
      const key = await task(ctx, world, BOT, "allow");
      const since = marks(ctx);
      const runId = await start(ctx, key, "#write");
      const card = await cardFor(ctx, runId, since.interactive);
      expect(
        String(card.request.description).includes(`rule ${saved.rules[1]!.id}`),
        `the card names another rule: ${String(card.request.description)}`,
      );
      await resolve(ctx, card.id, "deny");
      await finish(ctx, runId);
    },
  },
  {
    name: "Ask when nothing else decides asks, an Allow keeps it from asking, and ask_user is never asked",
    covers: ["#read", "#ask"],
    async run(ctx, world) {
      await save(ctx, BOT, [], true);
      const key = await task(ctx, world, BOT, "fallback");
      const since = marks(ctx);
      const runId = await start(ctx, key, "#read");
      const card = await cardFor(ctx, runId, since.interactive);
      expect(
        String(card.request.description).includes("Ask when nothing else decides"),
        `the card does not say the fallback asked: ${String(card.request.description)}`,
      );
      await resolve(ctx, card.id, "deny");
      await finish(ctx, runId);
      const [asked] = await decisionsOf(ctx, { runId });
      same(asked?.source, { kind: "fallback", scope: BOT }, "the fallback's decision record");
      const saved = await save(ctx, BOT, [{ action: "allow", tools: ["read"] }], true);
      const free = marks(ctx);
      const readRun = await start(ctx, key, "#read");
      const read = await finish(ctx, readRun);
      expect(
        read.calls[0]?.name === "read" && ranOk(read.calls[0]),
        `the allowed read: ${show(read.calls)}`,
      );
      same(cardsSeen(ctx, free, readRun), [], "who received a card for the allowed read");
      const [allowed] = await decisionsOf(ctx, { runId: readRun });
      same(
        [allowed?.decision, rec(allowed?.source).ruleId],
        ["allow", saved.rules[0]!.id],
        "the allowed read's decision record",
      );
      const question = marks(ctx);
      const askRun = await start(ctx, key, "#ask");
      await ctx.clients.interactive.waitFor(
        "the question",
        (e) => e.event === "question.requested",
        60_000,
        question.interactive,
      );
      await sleep(1000);
      same(cardsSeen(ctx, question, askRun), [], "who received a card for ask_user");
      const [record] = await decisionsOf(ctx, { runId: askRun });
      same(
        [record?.tool, record?.decision, record?.rules],
        ["ask_user", "none", null],
        "ask_user's decision record",
      );
      await ctx.clients.interactive.request("chat.abort", { sessionKey: key }).catch(() => {});
      await ctx.clients.interactive.terminal(askRun, 60_000);
    },
  },
  {
    name: "a save past a limit is refused and saves nothing",
    covers: [],
    async run(ctx) {
      const allow = (n: number): Rule[] =>
        Array.from({ length: n }, () => ({ action: "allow", tools: ["read"] }));
      const full = await save(ctx, BOT, allow(20));
      const kept: Rule[] = full.rules.map((r) => ({ id: r.id, action: "allow", tools: ["read"] }));
      const tries: [string, Rule[], JsonRecord][] = [
        ["a 21st Allow rule", [...kept, ...allow(1)], { action: "allow", limit: 20, count: 21 }],
        [
          "a 21st Ask rule",
          [
            ...kept,
            ...Array.from({ length: 21 }, (): Rule => ({ action: "ask", tools: ["write"] })),
          ],
          { action: "ask", limit: 20, count: 21 },
        ],
        [
          "a 51st Never rule",
          [
            ...kept,
            ...Array.from({ length: 51 }, (): Rule => ({ action: "never", tools: ["edit"] })),
          ],
          { action: "never", limit: 50, count: 51 },
        ],
        [
          "a 1,001-character pattern",
          [askWrite(`notes/${"a".repeat(995)}`)],
          { limit: 1000, length: 1001 },
        ],
      ];
      for (const [what, list, details] of tries) {
        const refused = await rules(ctx.clients.admin, "set", {
          scope: BOT,
          rules: list,
          fallback: false,
          expectedVersion: full.version,
        });
        expect(!refused.ok, `${what} was saved`);
        same(
          [refused.code, refused.details],
          ["INVALID_REQUEST", { reason: "limit", ...details }],
          what,
        );
      }
      const after = (await scopes(ctx))[BOT];
      same(
        [after?.version, after?.rules.map((r) => r.id)],
        [full.version, full.rules.map((r) => r.id)],
        "the scope after the refused saves",
      );
      const withPattern = await save(ctx, BOT, [...kept, askWrite(`notes/${"a".repeat(994)}`)]);
      same(
        withPattern.rules.length,
        21,
        "20 Allow rules and one Ask with a 1,000-character pattern",
      );
      const asks = await save(
        ctx,
        "pip",
        Array.from({ length: 20 }, () => askWrite()),
      );
      const keptAsks: Rule[] = asks.rules.map((r) => ({ ...askWrite(), id: r.id }));
      same(
        (await save(ctx, "pip", [...keptAsks, { action: "allow", tools: ["read"] }])).rules.length,
        21,
        "an Allow beside 20 Ask rules",
      );
      same((await save(ctx, "marlow", [askWrite()])).rules.length, 1, "another bot's Ask");
    },
  },
  {
    name: "rules lost after a copy was read: the copy is enforced, status says when it was read, and the log says each change",
    covers: ["#write"],
    async run(ctx, world) {
      const saved = await save(ctx, BOT, [
        { action: "never", tools: ["write"], target: { kind: "path", pattern: "notes/**" } },
      ]);
      const read = await statusOf(ctx);
      same([rec(read.rules).state, read.enforcing], ["read", "rules"], "status with rules read");
      const readAt = rec(read.rules).readAt;
      const good = readFileSync(rulesFile(ctx), "utf8");
      const losing = logMark(ctx);
      let restoring: number;
      writeFileSync(rulesFile(ctx), JSON.stringify({ format: PLUGIN, schema: 1 }));
      try {
        const lost = await statusOf(ctx);
        same(
          [lost.rules, lost.enforcing],
          [
            {
              state: "lost",
              reason: "the rules file is not a valid rules store",
              keptCopyReadAt: readAt,
            },
            "kept-copy",
          ],
          "status with a copy kept",
        );
        await logged(
          ctx,
          "Rules unavailable: the rules file is not a valid rules store. Enforcing the copy read at",
          losing,
        );
        const key = await task(ctx, world, BOT, "kept");
        const run = await finish(ctx, await start(ctx, key, "#write"));
        expect(
          run.calls[0]?.isError &&
            String(run.calls[0].details.reason).includes(`rule ${saved.rules[0]!.id}`),
          `the kept copy did not block the write: ${show(run.calls)}`,
        );
        const [record] = await decisionsOf(ctx, { runId: run.runId });
        same([record?.rules, record?.decision], ["kept", "block"], "the decision record");
      } finally {
        restoring = logMark(ctx);
        writeFileSync(rulesFile(ctx), good);
      }
      same((await statusOf(ctx)).enforcing, "rules", "status once the file is good again");
      await logged(ctx, "Rules read; enforcing them.", restoring);
    },
  },
  {
    name: "a Never catches another spelling of the same file; an Allow covers only the spelling given",
    covers: ["#write"],
    async run(ctx, world) {
      const never = await save(ctx, BOT, [
        {
          action: "never",
          tools: ["write"],
          target: { kind: "path", pattern: "NOTES/Scratch.md" },
        },
      ]);
      const key = await task(ctx, world, BOT, "spelling");
      const blocked = await finish(ctx, await start(ctx, key, "#write"));
      expect(
        blocked.calls[0]?.isError &&
          String(blocked.calls[0].details.reason).includes(`rule ${never.rules[0]!.id}`),
        `a Never on NOTES/Scratch.md did not block notes/scratch.md: ${show(blocked.calls)}`,
      );
      await save(
        ctx,
        BOT,
        [
          {
            action: "allow",
            tools: ["write"],
            target: { kind: "path", pattern: "NOTES/SCRATCH.md" },
          },
        ],
        true,
      );
      const since = marks(ctx);
      const runId = await start(ctx, key, "#write");
      const card = await cardFor(ctx, runId, since.interactive);
      expect(
        String(card.request.description).includes("Ask when nothing else decides"),
        `the Allow of another spelling kept the fallback from asking: ${String(card.request.description)}`,
      );
      await resolve(ctx, card.id, "deny");
      await finish(ctx, runId);
      await save(
        ctx,
        BOT,
        [{ action: "allow", tools: ["write"], target: { kind: "path", pattern: WRITE_PATH } }],
        true,
      );
      const free = marks(ctx);
      const freeRun = await start(ctx, key, "#write");
      const ran = await finish(ctx, freeRun);
      expect(ranOk(ran.calls[0]), `the exact Allow: ${show(ran.calls)}`);
      same(cardsSeen(ctx, free, freeRun), [], "who received a card for the exact Allow");
    },
  },
  {
    name: "with forwarding configured the plugin's approval text omits the path and bot id; full text restores the path",
    covers: ["#write"],
    async run(ctx, world) {
      same(
        (await statusOf(ctx)).cardDetails,
        { mode: "full", because: "no-forwarding" },
        "card details with no forwarding",
      );
      await save(ctx, BOT, [askWrite()]);
      const key = await task(ctx, world, BOT, "forwarding");
      const cardText = async () => {
        const since = marks(ctx);
        const runId = await start(ctx, key, "#write");
        const card = await cardFor(ctx, runId, since.interactive);
        await resolve(ctx, card.id, "deny");
        await finish(ctx, runId);
        return `${String(card.request.title)}\n${String(card.request.description)}`;
      };
      const restore = async () => {
        await patchConfig(
          ctx,
          {
            approvals: null,
            plugins: { entries: { [PLUGIN]: { config: { cardDetails: null } } } },
          },
          ["approvals.plugin.targets"],
        );
        await pluginRunning(ctx);
      };
      await withConfig(
        () => patchConfig(ctx, FORWARD_NOWHERE),
        restore,
        async () => {
          same(
            (await statusOf(ctx)).cardDetails,
            { mode: "redacted", because: "forwarding-configured" },
            "card details with forwarding",
          );
          const redacted = await cardText();
          expect(
            !redacted.includes(WRITE_PATH) &&
              !redacted.includes(BOT) &&
              redacted.endsWith("The details are in Clawtrate."),
            `the forwarded card carries the target or the bot: ${redacted}`,
          );
          await patchConfig(ctx, {
            plugins: { entries: { [PLUGIN]: { config: { cardDetails: "full" } } } },
          });
          await pluginRunning(ctx);
          same(
            (await statusOf(ctx)).cardDetails,
            { mode: "full", because: "setting" },
            "card details forced by the setting",
          );
          const full = await cardText();
          expect(full.includes(WRITE_PATH), `the forced card left out the target: ${full}`);
        },
      );
      same(
        (await statusOf(ctx)).cardDetails,
        { mode: "full", because: "no-forwarding" },
        "card details once forwarding is off again",
      );
    },
  },
  {
    name: "a routine's call is refused with no card, the audit log counts it failed, and the routine's own summary still says it was done",
    covers: [],
    async run(ctx) {
      const { admin } = ctx.clients;
      await save(ctx, BOT, [{ action: "ask", tools: ["read"] }]);
      const added = answered(
        await call(admin, "cron.add", {
          name: `rules check ${Date.now().toString(36)}`,
          agentId: BOT,
          schedule: { kind: "every", everyMs: 3_600_000 },
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "#read" },
          delivery: { mode: "none" },
        }),
        "cron.add",
      );
      const id = String(added.id);
      try {
        const since = marks(ctx);
        answered(await call(admin, "cron.run", { id, mode: "force" }), "cron.run");
        let entry: JsonRecord | undefined;
        const deadline = Date.now() + 90_000;
        while (!entry) {
          expect(Date.now() < deadline, "the routine's run did not finish within 90 seconds");
          await sleep(1000);
          const runs = answered(await call(admin, "cron.runs", { id, limit: 1 }), "cron.runs");
          entry = ((runs.entries ?? []) as JsonRecord[]).find((e) => e.action === "finished");
        }
        same(cardsSeen(ctx, since), [], "who received a card");
        const [record] = await decisionsOf(ctx, { sessionKey: String(entry.sessionKey) });
        same(
          [record?.tool, record?.decision, record?.answer],
          ["read", "ask", "cancelled"],
          "the routine's call in the decision record",
        );
        // The audit log counts the refused call as failed, not blocked.
        const audited = await joined(ctx, record!);
        same(
          [audited.status, audited.errorCode],
          ["failed", "tool_failed"],
          "the routine's call in the audit log",
        );
        same(entry.summary, "I read my instructions file.", "the routine's own summary");
      } finally {
        await call(admin, "cron.remove", { id });
      }
    },
  },
  {
    name: "a setting changed while a card waits: after a rules change Allow once runs the call; after a config change the call fails",
    covers: ["#write"],
    async run(ctx, world) {
      const original = await botEntry(ctx, BOT);
      for (const change of ["rules", "config"] as const) {
        await save(ctx, BOT, [askWrite()]);
        const key = await task(ctx, world, BOT, `waiting-${change}`);
        const since = marks(ctx);
        const runId = await start(ctx, key, "#write");
        const card = await cardFor(ctx, runId, since.interactive);
        const answer = async () => {
          expect(
            (await waitingCards(ctx.clients.interactive)).includes(card.id),
            `the card was no longer listed after the ${change} change`,
          );
          await resolve(ctx, card.id, "allow-once");
          return finish(ctx, runId);
        };
        if (change === "rules") {
          await save(ctx, BOT, [{ action: "allow", tools: ["write"] }]);
          const run = await answer();
          expect(ranOk(run.calls[0]), `after a rules change: ${show(run.calls)}`);
          continue;
        }
        // The deny is undone however the check ends.
        const run = await withConfig(
          () =>
            patchConfig(ctx, {
              agents: { entries: { [BOT]: { tools: { deny: ["web_search"] } } } },
            }),
          () =>
            patchConfig(ctx, { agents: { entries: { [BOT]: { tools: { deny: null } } } } }, [
              `agents.entries.${BOT}.tools.deny`,
            ]),
          answer,
        );
        const write = run.calls[0];
        expect(
          write?.isError && write.text.includes(GATEWAY_UNAVAILABLE),
          `after a config change: ${show(run.calls)}`,
        );
      }
      same(await botEntry(ctx, BOT), original, "Juniper's settings once the deny is removed again");
      await pluginRunning(ctx);
    },
  },
  {
    name: "the plugin turned off mid-run: that run's next call is still asked; a run started after runs the call with no card",
    covers: ["#slow-tool", "#write"],
    async run(ctx, world) {
      await save(ctx, BOT, [askWrite()]);
      const key = await task(ctx, world, BOT, "stopped");
      const since = marks(ctx);
      const runId = await start(ctx, key, "#slow-tool 6 #write");
      await ctx.clients.interactive.waitFor(
        "the slow tool",
        (e) =>
          e.event === "agent" &&
          rec(e.payload).runId === runId &&
          rec(e.payload).stream === "tool" &&
          rec(rec(e.payload).data).phase === "start",
        60_000,
        since.interactive,
      );
      const plugin = (enabled: boolean) => () =>
        patchConfig(ctx, { plugins: { entries: { [PLUGIN]: { enabled } } } });
      await withConfig(plugin(false), plugin(true), async () => {
        const off = await rules(ctx.clients.reader, "status");
        expect(!off.ok, `status still answered with the plugin off: ${show(off)}`);
        // The run that started with the plugin keeps its hook: its write is asked.
        const card = await cardFor(ctx, runId, since.interactive);
        await resolve(ctx, card.id, "allow-once");
        const during = await finish(ctx, runId);
        same(
          during.calls.map((c) => [c.name, ranOk(c)]),
          [
            ["coder__slow_task", true],
            ["write", true],
          ],
          "the run the plugin was turned off in",
        );
        // A run that starts with the plugin off: nothing asks.
        const fresh = await task(ctx, world, BOT, "stopped-fresh");
        const after = marks(ctx);
        const freshRun = await start(ctx, fresh, "#write");
        const run = await finish(ctx, freshRun);
        expect(
          run.calls[0]?.name === "write" && ranOk(run.calls[0]),
          `the write with the plugin off: ${show(run.calls)}`,
        );
        same(cardsSeen(ctx, after), [], "who received a card with the plugin off");
      });
      const status = await pluginRunning(ctx);
      same(
        [rec(status.rules).state, status.enforcing],
        ["read", "rules"],
        "the plugin's rules once it runs again",
      );
    },
  },
  {
    name: "a call in a run another bot's message started is refused with no card for anyone",
    covers: ["#message-read"],
    async run(ctx, world) {
      await save(ctx, "pip", [{ action: "ask", tools: ["read"] }]);
      const key = await task(ctx, world, "marlow", "message-read");
      world.keys.add("agent:pip:main");
      for (const op of Object.values(ctx.clients)) {
        await op.request("sessions.messages.subscribe", { key: "agent:pip:main" }).catch(() => {});
      }
      const since = marks(ctx);
      const sentAt = Date.now();
      const runId = await start(ctx, key, "#message-read");
      const run = await finish(ctx, runId);
      same(
        run.calls.map((c) => c.name),
        ["sessions_send"],
        "Marlow's tool calls",
      );
      // Pip's run can still be queued after Marlow's send returns: wait for its record.
      const record = await eventually("Pip's decision record", async () =>
        (await decisionsOf(ctx, { agentId: "pip", limit: 5 })).find((r) => Number(r.at) >= sentAt),
      );
      same(cardsSeen(ctx, since), [], "who received a card");
      same(
        [record?.tool, record?.decision, record?.answer],
        ["read", "ask", "cancelled"],
        "Pip's call in the decision record",
      );
      // The refused read's result is written after the hook returns: wait for it in the history.
      const text = await eventually("Pip's read result in its history", async () => {
        const history = answered(
          await call(ctx.clients.admin, "chat.history", {
            sessionKey: "agent:pip:main",
            limit: 20,
          }),
          "Pip's main task",
        );
        const results = ((history.messages ?? []) as JsonRecord[]).filter(
          (m) => m.role === "toolResult" && m.toolName === "read",
        );
        const last = results.at(-1);
        return last ? JSON.stringify(last.content ?? "") : undefined;
      });
      expect(text.includes(GATEWAY_UNAVAILABLE), `Pip's read result: ${text.slice(0, 300)}`);
    },
  },
  {
    name: "the gateway's log names each bot whose settings let it change the rules, and no other",
    covers: [],
    async run(ctx) {
      const log = readFileSync(ctx.gatewayLog, "utf8");
      const warned = [...log.matchAll(/clawtrate-tool-rules: Bot ([a-z0-9_-]+) may /g)].map(
        (m) => m[1],
      );
      // Otto runs commands on the gateway's machine (its own policy asks);
      // every other bot is denied commands, the gateway tools and files outside its workspace.
      same([...new Set(warned)], ["otto"], "the bots the plugin warned about");
    },
  },
];

/** Stop every run in the checks' tasks, deny every card still waiting, and empty the rules. */
async function settle(ctx: RulesContext, world: World): Promise<boolean> {
  const { admin } = ctx.clients;
  for (const id of await waitingCards(admin).catch(() => [])) {
    await call(admin, "plugin.approval.resolve", { id, decision: "deny" });
  }
  if (!(await drainSessions(admin, world.keys))) return false;
  try {
    await pluginRunning(ctx);
    await clearRules(ctx);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the checks in order, one line per check; a failure does not stop the
 * others. Each check starts from no rules and no busy task; when that cannot
 * be established after a failure, the next check is not started.
 */
export async function runRulesChecks(
  ctx: RulesContext,
  log: (line: string) => void = console.log,
): Promise<{ passed: number; failed: number }> {
  const world: World = { stamp: Date.now().toString(36), keys: new Set(), counter: 0 };
  let passed = 0;
  let failed = 0;
  let leftBusy: string | null = null;
  for (const check of RULES_CHECKS) {
    if (!(await settle(ctx, world))) {
      leftBusy ??= "the instance could not be brought back to no rules and no running task";
      failed += 1;
      log(`FAIL  ${check.name}: not started: ${leftBusy}`);
      continue;
    }
    leftBusy = null;
    try {
      await check.run(ctx, world);
      passed += 1;
      log(`ok    ${check.name}`);
    } catch (error) {
      failed += 1;
      log(`FAIL  ${check.name}: ${error instanceof Error ? error.message : String(error)}`);
      leftBusy = `the check before it ("${check.name}") failed`;
    }
  }
  await settle(ctx, world);
  return { passed, failed };
}
