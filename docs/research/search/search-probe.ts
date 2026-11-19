// Probes behind docs/research/search.md. Research code, not a check.
//
//   pnpm dev-gateway start --instance <name>
//   node docs/research/search/search-probe.ts <experiment> --instance <name>
//
// It acts only on a named development instance this checkout started, through
// the tool's own operator client (a new paired device per connection, approved
// by request id through the tool's guarded runner, so always with
// `--profile clawtrate-dev-<name>`). It never prints a token. Every device it
// pairs is removed again before it exits.
//
// Experiments (run in this order on a fresh instance):
//   words     write tier: three tasks with known words in the person's
//             messages, a reply, a tool result and reasoning, and a title;
//             then what each query form matches
//   shape     one result, its messageId against chat.history, limits, scopes
//   many      write tier: 64 tasks sharing one word; what limit 25 returns,
//             and what narrower searches return that it did not; timings
//   long      a task longer than the app's 200-row history page
//   bulk      bulk <n>: n more tasks per bot, then timings
//   gone      archived, deleted and a deleted bot (admin, on this instance only)
//   gone2     archive and delete again, printed in full
//   files     sessions.files.list with search, agents.workspace.list; timings
//   readonly  every source on a read-only connection, and on no scope at all
//   routines  cron.list with and without query (a routine added by the CLI)
//   narrow    within one bot, task keys against the bot's own search
//   q         searches every bot for each word given after it

import { parseArgs } from "node:util";
import { openInstance, openOperator } from "../../../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../../../tools/dev-gateway/src/operator.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { instance: { type: "string" } },
  allowPositionals: true,
});
if (!values.instance) throw new Error("--instance <name> is required; the default instance is never probed");
const inst = openInstance(values.instance);
const experiment = positionals[0];

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v !== null && typeof v === "object" ? (v as Rec) : {});
const READ = ["operator.read"];
const WRITE = ["operator.read", "operator.write"];
const ADMIN = ["operator.read", "operator.write", "operator.admin"];
const opened: OperatorSession[] = [];

async function connect(name: string, scopes: string[]): Promise<OperatorSession> {
  const op = await openOperator(inst, `Clawtrate search probe ${name}`, scopes, ["tool-events"]);
  opened.push(op);
  return op;
}

async function call(op: OperatorSession, method: string, params: unknown): Promise<{ ok: boolean; ms: number; value: Rec; error?: string }> {
  const t = performance.now();
  try {
    const value = rec(await op.request(method, params));
    return { ok: true, ms: Math.round(performance.now() - t), value };
  } catch (error) {
    return { ok: false, ms: Math.round(performance.now() - t), value: {}, error: String((error as Error).message ?? error) };
  }
}

function brief(r: Awaited<ReturnType<typeof call>>): string {
  if (!r.ok) return `REFUSED (${r.ms} ms): ${r.error}`;
  const results = Array.isArray(r.value.results) ? (r.value.results as Rec[]) : [];
  const flags = ["truncated", "indexing", "archivedTranscriptsExcluded"].filter((f) => r.value[f] !== undefined).map((f) => `${f}=${JSON.stringify(r.value[f])}`);
  const rows = results.map((h) => `${h.sessionKey} ${h.role} ${JSON.stringify(String(h.snippet).slice(0, 60))}`);
  return `${results.length} results (${r.ms} ms)${flags.length ? " " + flags.join(" ") : ""}${rows.length ? "\n      " + rows.join("\n      ") : ""}`;
}

async function search(op: OperatorSession, label: string, params: Rec): Promise<Awaited<ReturnType<typeof call>>> {
  const r = await call(op, "sessions.search", params);
  console.log(`  ${label} ${JSON.stringify(params)}\n    -> ${brief(r)}`);
  return r;
}

async function runTurn(op: OperatorSession, key: string, message: string): Promise<void> {
  await op.request("sessions.messages.subscribe", { key });
  const sent = await op.send(key, message);
  const runId = String(sent.runId ?? "");
  if (runId) await op.terminal(runId);
}

async function history(op: OperatorSession, key: string): Promise<Rec[]> {
  const out = rec(await op.request("chat.history", { sessionKey: key, limit: 200 }));
  return Array.isArray(out.messages) ? (out.messages as Rec[]) : [];
}

async function cli(args: string[]): Promise<string> {
  const result = rec(await inst.runner.run(args));
  return String(result.stdout ?? "");
}

const KEYS = {
  cafe: "agent:main:probe-cafe",
  tool: "agent:otto:probe-tool",
  think: "agent:marlow:probe-think",
};

async function words(): Promise<void> {
  const op = await connect("write", WRITE);
  console.log("Seeding three tasks with known words");
  await runTurn(op, KEYS.cafe, "Plan the café tasting for Zephyrine on Thursday.");
  await op.request("sessions.patch", { key: KEYS.cafe, label: "Quokka itinerary" });
  await runTurn(op, KEYS.tool, "#read");
  await runTurn(op, KEYS.think, "#think");
  for (const key of Object.values(KEYS)) {
    const rows = await history(op, key);
    console.log(`  ${key}: ${rows.length} history rows`);
    for (const row of rows) {
      const content = Array.isArray(row.content) ? (row.content as Rec[]) : [];
      const parts = content.map((b) => `${b.type}:${JSON.stringify(String(b.text ?? b.thinking ?? b.name ?? "").slice(0, 70))}`);
      console.log(`    ${row.role} ${parts.join(" | ") || JSON.stringify(String(row.content ?? "").slice(0, 70))}`);
    }
  }
  console.log("Query forms (scope form unless named), all bots: scope {}");
  for (const query of ["Zephyrine", "zephyrine", "ZEPHYRINE", "Zephyr", "ephyrine", "cafe", "café", "CAFÉ", "Thursday Zephyrine", "Zephyrine Thursday", "Zephyrine OR Plutonium", "Zeph Thurs", "\"tasting for\"", "tast*", "Quokka", "itinerary", "scripted", "instructions", "Juniper"]) {
    await search(op, "scope", { query, scope: {}, limit: 25 });
  }
  console.log("The same prefixes with sessionKeys");
  for (const query of ["Zephyr", "Zephyrine", "cafe"]) {
    await search(op, "keys", { query, sessionKeys: [KEYS.cafe], limit: 25 });
  }
}

async function shape(): Promise<void> {
  const op = await connect("write", WRITE);
  const r = await search(op, "one result", { query: "Zephyrine", scope: {}, limit: 25 });
  const sessions = Array.isArray(r.value.sessions) ? (r.value.sessions as Rec[]) : [];
  console.log("  results:", JSON.stringify(r.value.results));
  console.log("  other fields:", JSON.stringify(Object.keys(r.value)));
  console.log("  sessions rows:", JSON.stringify(sessions.map((row) => ({ key: row.key, label: row.label, displayName: row.displayName, updatedAt: row.updatedAt, archivedAt: row.archivedAt }))));
  const keyed = await search(op, "the same with sessionKeys", { query: "Zephyrine", sessionKeys: ["agent:main:probe-cafe"], limit: 25 });
  console.log("  other fields:", JSON.stringify(Object.keys(keyed.value)));
  const hit = rec((r.value.results as Rec[] | undefined)?.[0]);
  const rows = await history(op, String(hit.sessionKey));
  const ids = rows.map((row) => ({ role: row.role, id: rec(row.__openclaw).id, seq: rec(row.__openclaw).seq }));
  console.log("  history rows' __openclaw:", JSON.stringify(ids).slice(0, 1500));
  console.log(`  messageId ${hit.messageId} found in history meta: ${rows.some((row) => JSON.stringify(row).includes(String(hit.messageId)))}`);
  console.log("Limits");
  for (const limit of [0, -1, 1, 25, 26, 100, 2.5]) await search(op, "limit", { query: "Saturday", scope: {}, limit });
  await search(op, "no limit", { query: "Saturday", scope: {} });
  console.log("Forms");
  await search(op, "query alone", { query: "Saturday" });
  await search(op, "agentId alone", { query: "Saturday", agentId: "pip" });
  await search(op, "keys of two bots", { query: "Saturday", sessionKeys: ["agent:pip:main", "agent:marlow:main"] });
  await search(op, "scope with keys", { query: "Saturday", scope: {}, sessionKeys: ["agent:pip:main"] });
  await search(op, "empty query", { query: "   ", scope: {} });
  await search(op, "unknown key", { query: "Saturday", sessionKeys: ["agent:pip:no-such-task"] });
  console.log("Scope values");
  const list = rec(await op.request("sessions.list", { limit: 200 }));
  const keys = (Array.isArray(list.sessions) ? (list.sessions as Rec[]) : []).map((s) => `${s.key} label=${JSON.stringify(s.label ?? null)} kind=${s.kind ?? ""}`);
  console.log(`  sessions.list: ${keys.length}\n    ${keys.join("\n    ")}`);
  for (const scope of [{}, { agentId: "pip" }, { agentId: "nobody" }, { archived: "all" }, { archived: true }, { activeMinutes: 1 }, { search: "Saturday" }, { search: "route" }, { label: "Which route on Saturday" }, { excludeCron: true, excludeSubagents: true }, { sortBy: "lastInteractionAt" }]) {
    await search(op, "scope", { query: "Saturday", scope, limit: 25 });
  }
}

async function many(): Promise<void> {
  const op = await connect("write", WRITE);
  const bots = ["main", "otto", "marlow", "pip"];
  console.log("Seeding 64 tasks, 16 per bot, each with one message containing 'lanternfish'");
  const keys: string[] = [];
  for (let i = 0; i < 16; i++) {
    await Promise.all(
      bots.map(async (bot) => {
        const key = `agent:${bot}:probe-many-${String(i).padStart(2, "0")}`;
        keys.push(key);
        await runTurn(op, key, `Count the lanternfish in tank ${bot}-${i}.`);
      }),
    );
  }
  const wide = await search(op, "wide", { query: "lanternfish", scope: {}, limit: 25 });
  const wideKeys = new Set(((wide.value.results as Rec[]) ?? []).map((h) => String(h.sessionKey)));
  console.log(`  wide returned ${wideKeys.size} tasks of 64; bots: ${JSON.stringify(countBy([...wideKeys]))}`);
  for (const bot of bots) {
    const r = await search(op, `per bot ${bot}`, { query: "lanternfish", scope: { agentId: bot }, limit: 25 });
    const got = ((r.value.results as Rec[]) ?? []).map((h) => String(h.sessionKey));
    console.log(`    new beyond wide: ${got.filter((k) => !wideKeys.has(k)).length}`);
  }
  const missing = keys.filter((k) => !wideKeys.has(k) && k.includes(":main:"));
  if (missing.length) {
    const r = await search(op, "keys of juniper tasks the wide search missed", { query: "lanternfish", sessionKeys: missing, limit: 25 });
    console.log(`    found ${((r.value.results as Rec[]) ?? []).length} of ${missing.length}`);
  }
  console.log("Timings, 20 searches each");
  for (const [label, params] of [
    ["scope {} lanternfish", { query: "lanternfish", scope: {}, limit: 25 }],
    ["scope {} prefix 'l'", { query: "l", scope: {}, limit: 25 }],
    ["scope {} 'lan'", { query: "lan", scope: {}, limit: 25 }],
    ["scope agent pip", { query: "lanternfish", scope: { agentId: "pip" }, limit: 25 }],
    ["keys 16", { query: "lanternfish", sessionKeys: keys.filter((k) => k.includes(":pip:")), limit: 25 }],
    ["agents.list", null],
  ] as const) {
    const ms: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = params ? await call(op, "sessions.search", params) : await call(op, "agents.list", {});
      ms.push(r.ms);
    }
    ms.sort((a, b) => a - b);
    console.log(`  ${label}: median ${ms[10]} ms, max ${ms[19]} ms`);
  }
}

function countBy(keys: string[]): Rec {
  const out: Rec = {};
  for (const k of keys) {
    const bot = k.split(":")[1] ?? "";
    out[bot] = Number(out[bot] ?? 0) + 1;
  }
  return out;
}

async function gone(): Promise<void> {
  const op = await connect("write", WRITE);
  const archived = "agent:pip:probe-many-00";
  const deleted = "agent:pip:probe-many-01";
  console.log("Archive one task");
  console.log("  patch:", JSON.stringify((await call(op, "sessions.patch", { key: archived, archived: true })).ok));
  await search(op, "default scope", { query: "pip-0", scope: { agentId: "pip" }, limit: 25 });
  await search(op, "archived all", { query: "pip-0", scope: { agentId: "pip", archived: "all" }, limit: 25 });
  await search(op, "keys", { query: "pip-0", sessionKeys: [archived], limit: 25 });
  console.log("Delete one task (archive, then delete with archivedOnly)");
  await call(op, "sessions.patch", { key: deleted, archived: true });
  const del = await call(op, "sessions.delete", { key: deleted, archivedOnly: true });
  console.log("  delete:", del.ok ? JSON.stringify(del.value).slice(0, 300) : del.error);
  await search(op, "keys", { query: "pip-1", sessionKeys: [deleted], limit: 25 });
  await search(op, "archived all", { query: "pip-1", scope: { agentId: "pip", archived: "all" }, limit: 25 });
  console.log("  history of the deleted task:", JSON.stringify(await call(op, "chat.history", { sessionKey: deleted, limit: 5 }).then((r) => (r.ok ? `${(r.value.messages as unknown[] | undefined)?.length} rows` : r.error))));
  console.log("A search result held while the task is deleted elsewhere");
  const held = await search(op, "before", { query: "marlow-2", scope: { agentId: "marlow" }, limit: 25 });
  const heldKey = String(rec((held.value.results as Rec[] | undefined)?.[0]).sessionKey);
  await call(op, "sessions.patch", { key: heldKey, archived: true });
  await call(op, "sessions.delete", { key: heldKey, archivedOnly: true });
  const after = await call(op, "chat.history", { sessionKey: heldKey, limit: 5 });
  console.log(`  opening ${heldKey} afterwards: ${after.ok ? `${(after.value.messages as unknown[] | undefined)?.length} rows` : after.error}`);
  const sub = await call(op, "sessions.messages.subscribe", { key: heldKey });
  console.log(`  subscribe: ${sub.ok ? JSON.stringify(sub.value).slice(0, 200) : sub.error}`);
  console.log("Delete a bot (admin connection, this instance only)");
  const admin = await connect("admin", ADMIN);
  const before = await search(op, "before", { query: "lanternfish", scope: { agentId: "otto" }, limit: 3 });
  const ottoKey = String(rec((before.value.results as Rec[] | undefined)?.[0]).sessionKey);
  const delBot = await call(admin, "agents.delete", { agentId: "otto" });
  console.log("  agents.delete:", delBot.ok ? JSON.stringify(delBot.value).slice(0, 300) : delBot.error);
  await new Promise((r) => setTimeout(r, 1500));
  const agents = await call(op, "agents.list", {});
  console.log("  agents now:", JSON.stringify(((agents.value.agents as Rec[]) ?? []).map((a) => a.id)));
  await search(op, "scope {}", { query: "lanternfish", scope: {}, limit: 25 });
  await search(op, "scope otto", { query: "lanternfish", scope: { agentId: "otto" }, limit: 25 });
  await search(op, "keys otto", { query: "lanternfish", sessionKeys: [ottoKey], limit: 25 });
  const h = await call(op, "chat.history", { sessionKey: ottoKey, limit: 5 });
  console.log(`  opening ${ottoKey}: ${h.ok ? `${(h.value.messages as unknown[] | undefined)?.length} rows` : h.error}`);
}

async function files(): Promise<void> {
  const op = await connect("read", READ);
  for (const params of [
    { sessionKey: "agent:otto:probe-tool", search: "agents" },
    { sessionKey: "agent:otto:probe-tool", search: "AGENTS.MD" },
    { sessionKey: "agent:pip:weekend-trip", search: "trail" },
    { sessionKey: "agent:pip:weekend-trip", search: "md" },
    { sessionKey: "agent:pip:weekend-trip", search: "" },
    { sessionKey: "agent:pip:weekend-trip" },
    { sessionKey: "agent:pip:main", search: "trail" },
    { sessionKey: "agent:pip:no-such-task", search: "trail" },
  ]) {
    const r = await call(op, "sessions.files.list", params);
    const browser = rec(r.value.browser);
    const entries = Array.isArray(browser.entries) ? (browser.entries as Rec[]) : [];
    console.log(`  sessions.files.list ${JSON.stringify(params)} (${r.ms} ms) -> ${r.ok ? `root=${r.value.root ? "yes" : "no"} files=${(r.value.files as unknown[] | undefined)?.length} browser.search=${JSON.stringify(browser.search)} entries=${entries.length} truncated=${JSON.stringify(browser.truncated)} ${JSON.stringify(entries.slice(0, 6).map((e) => e.path))}` : r.error}`);
  }
  for (const params of [{ agentId: "pip" }, { agentId: "pip", path: "pictures" }, { agentId: "pip", limit: 501 }, { agentId: "nobody" }]) {
    const r = await call(op, "agents.workspace.list", params);
    const entries = Array.isArray(r.value.entries) ? (r.value.entries as Rec[]) : [];
    console.log(`  agents.workspace.list ${JSON.stringify(params)} (${r.ms} ms) -> ${r.ok ? `total=${r.value.totalEntries} ${JSON.stringify(entries.map((e) => `${e.kind}:${e.path}`))}` : r.error}`);
  }
}

async function readonly(): Promise<void> {
  const op = await connect("read", READ);
  const checks: [string, unknown][] = [
    ["agents.list", {}],
    ["cron.list", {}],
    ["cron.list", { query: "digest" }],
    ["sessions.search", { query: "Saturday", scope: {}, limit: 25 }],
    ["sessions.search", { query: "Saturday", sessionKeys: ["agent:pip:main"], limit: 25 }],
    ["sessions.files.list", { sessionKey: "agent:pip:weekend-trip", search: "trail" }],
    ["agents.workspace.list", { agentId: "pip" }],
    ["chat.history", { sessionKey: "agent:pip:main", limit: 1 }],
  ];
  console.log("Read-only connection (operator.read)");
  for (const [method, params] of checks) {
    const r = await call(op, method, params);
    console.log(`  ${method} ${JSON.stringify(params)}: ${r.ok ? `ok (${r.ms} ms)` : `REFUSED: ${r.error}`}`);
  }
  console.log("No scope at all");
  try {
    const none = await connect("none", []);
    for (const [method, params] of checks) {
      const r = await call(none, method, params);
      console.log(`  ${method}: ${r.ok ? "ok" : `REFUSED: ${r.error}`}`);
    }
  } catch (error) {
    console.log(`  connect with no scope: ${String(error)}`);
  }
}

async function routines(): Promise<void> {
  if (positionals[1] !== "again") {
    console.log("Adding one routine through the instance's own CLI (the scheduler is off here)");
    console.log(
    (await cli(["cron", "add", "--name", "Weekday tide digest", "--agent", "pip", "--cron", "0 7 * * 1-5", "--message", "Summarise the tide table.", "--session", "isolated", "--disabled", "--json"])).slice(0, 400),
    );
  }
  const op = await connect("read", READ);
  for (const params of [{}, { query: "tide" }, { query: "TIDE" }, { query: "dig" }, { query: "ide dig" }, { query: "tide table" }, { query: "nothing-like-it" }, { includeDisabled: true }, { includeDisabled: true, query: "tide" }, { enabled: "all", query: "TIDE" }, { enabled: "all", query: "ide dig" }, { enabled: "all", query: "tide table" }, { enabled: "all", query: "pip" }, { enabled: "all", query: "Summarise" }, { enabled: "all", limit: 1 }]) {
    const r = await call(op, "cron.list", params);
    const jobs = Array.isArray(r.value.jobs) ? (r.value.jobs as Rec[]) : [];
    console.log(`  cron.list ${JSON.stringify(params)} -> ${r.ok ? `${jobs.length} jobs ${JSON.stringify(jobs.map((j) => j.name))} total=${JSON.stringify(r.value.total)} hasMore=${JSON.stringify(r.value.hasMore)}` : r.error}`);
  }
}

// A task longer than the 200 history rows the app loads.
async function long(): Promise<void> {
  const op = await connect("write", WRITE);
  const key = "agent:pip:probe-long";
  console.log("Seeding one task: a first message with 'aardwolf', then 120 more turns");
  await runTurn(op, key, "Note the aardwolf sighting by the north gate.");
  for (let i = 1; i <= 120; i++) await runTurn(op, key, `Filler message ${i}.`);
  const hit = rec(((await search(op, "search", { query: "aardwolf", scope: { agentId: "pip" }, limit: 25 })).value.results as Rec[] | undefined)?.[0]);
  const page = await call(op, "chat.history", { sessionKey: key, limit: 200 });
  const rows = (page.value.messages as Rec[] | undefined) ?? [];
  const pageIds = rows.map((row) => String(rec(row.__openclaw).id));
  console.log(`  chat.history limit 200: ${rows.length} rows, other fields ${JSON.stringify(Object.keys(page.value).filter((k) => k !== "messages"))}, hasMore=${JSON.stringify(page.value.hasMore)}`);
  console.log(`  the matched message is in that page: ${pageIds.includes(String(hit.messageId))}`);
  for (const params of [
    { sessionKey: key, messageId: hit.messageId, limit: 20 },
    { sessionKey: key, messageId: hit.messageId, sessionId: hit.sessionId, limit: 20 },
  ]) {
    const r = await call(op, "chat.history", params);
    const got = ((r.value.messages as Rec[] | undefined) ?? []).map((row) => String(rec(row.__openclaw).id));
    const at = got.indexOf(String(hit.messageId));
    console.log(`  chat.history ${JSON.stringify(Object.keys(params))}: ${r.ok ? `${got.length} rows, the match at index ${at}, fields ${JSON.stringify(Object.keys(r.value).filter((k) => k !== "messages"))} offset=${JSON.stringify(r.value.offset)} hasMore=${JSON.stringify(r.value.hasMore)}` : r.error}`);
  }
  const one = await call(op, "chat.message.get", { sessionKey: key, sessionId: hit.sessionId, messageId: hit.messageId });
  console.log(`  chat.message.get: ${one.ok ? JSON.stringify({ ok: one.value.ok, role: rec(one.value.message).role, unavailableReason: one.value.unavailableReason }) : one.error}`);
}

// Many more tasks, for timings: bulk --count N (per bot), each with a longer message.
async function bulk(): Promise<void> {
  const op = await connect("write", WRITE);
  const count = Number(positionals[1] ?? 80);
  const bots = ["main", "otto", "marlow", "pip"];
  console.log(`Seeding ${count * bots.length} more tasks`);
  const t = performance.now();
  for (let i = 0; i < count; i++) {
    await Promise.all(bots.map((bot) => runTurn(op, `agent:${bot}:probe-bulk-${String(i).padStart(3, "0")}`, `Bulk note ${bot} ${i}: compare the heron count with the kestrel count along the estuary path, then file the tally.`)));
  }
  console.log(`  seeded in ${Math.round((performance.now() - t) / 1000)} s`);
  const list = rec(await op.request("sessions.list", { limit: 1 }));
  console.log(`  sessions.list total=${JSON.stringify(list.total ?? list.count)}`);
  for (const [label, params] of [
    ["scope {} heron (every bulk task matches)", { query: "heron", scope: {}, limit: 25 }],
    ["scope {} 'h' prefix", { query: "h", scope: {}, limit: 25 }],
    ["scope {} lanternfish", { query: "lanternfish", scope: {}, limit: 25 }],
    ["scope {} no match", { query: "xylophonist", scope: {}, limit: 25 }],
    ["scope agent pip heron", { query: "heron", scope: { agentId: "pip" }, limit: 25 }],
  ] as const) {
    const ms: number[] = [];
    let flags = "";
    for (let i = 0; i < 20; i++) {
      const r = await call(op, "sessions.search", params);
      ms.push(r.ms);
      flags = `truncated=${JSON.stringify(r.value.truncated)} indexing=${JSON.stringify(r.value.indexing)}`;
    }
    ms.sort((a, b) => a - b);
    console.log(`  ${label}: median ${ms[10]} ms, max ${ms[19]} ms, last ${flags}`);
  }
}

// Archive and delete, printed in full: gone2 <archived suffix> <deleted suffix>
async function gone2(): Promise<void> {
  const op = await connect("write", WRITE);
  const archived = `agent:pip:probe-many-${positionals[1] ?? "04"}`;
  const deleted = `agent:pip:probe-many-${positionals[2] ?? "05"}`;
  const listed = async (key: string, archivedParam?: boolean | "all") => {
    const r = await call(op, "sessions.list", { agentId: "pip", limit: 200, search: key.split(":")[2], ...(archivedParam === undefined ? {} : { archived: archivedParam }) });
    return ((r.value.sessions as Rec[] | undefined) ?? []).some((row) => row.key === key);
  };
  const sessionIdOf = async (key: string) => {
    const r = await call(op, "sessions.list", { agentId: "pip", limit: 200, search: key.split(":")[2], archived: "all" });
    return String(((r.value.sessions as Rec[] | undefined) ?? []).find((row) => row.key === key)?.sessionId ?? "");
  };
  const p1 = await call(op, "sessions.patch", { key: archived, archived: true, expectedSessionId: await sessionIdOf(archived) });
  console.log(`  archive ${archived}: ${p1.ok ? JSON.stringify(rec(p1.value.entry).archivedAt ?? Object.keys(p1.value)) : p1.error}`);
  console.log(`    in sessions.list default ${await listed(archived)}, archived:true ${await listed(archived, true)}`);
  for (const [label, params] of [
    ["scope {}", { query: "lanternfish", scope: { agentId: "pip" }, limit: 25 }],
    ["scope archived all", { query: "lanternfish", scope: { agentId: "pip", archived: "all" }, limit: 25 }],
    ["scope archived true", { query: "lanternfish", scope: { agentId: "pip", archived: true }, limit: 25 }],
    ["keys", { query: "lanternfish", sessionKeys: [archived], limit: 25 }],
  ] as const) {
    const r = await call(op, "sessions.search", params);
    const keys = ((r.value.results as Rec[] | undefined) ?? []).map((h) => String(h.sessionKey));
    console.log(`    ${label}: ${r.ok ? `${keys.length} results, includes the archived task: ${keys.includes(archived)}` : r.error}`);
  }
  const deletedId = await sessionIdOf(deleted);
  const p2 = await call(op, "sessions.patch", { key: deleted, archived: true, expectedSessionId: deletedId });
  console.log(`  archive before delete: ${p2.ok ? "ok" : p2.error}`);
  const d = await call(op, "sessions.delete", { key: deleted, archivedOnly: true, expectedSessionId: deletedId });
  console.log(`  delete ${deleted}: ${d.ok ? JSON.stringify(d.value).slice(0, 200) : d.error}`);
  console.log(`    in sessions.list default ${await listed(deleted)}, archived:true ${await listed(deleted, true)}`);
  for (const [label, params] of [
    ["scope archived all", { query: "lanternfish", scope: { agentId: "pip", archived: "all" }, limit: 25 }],
    ["keys", { query: "lanternfish", sessionKeys: [deleted], limit: 25 }],
  ] as const) {
    const r = await call(op, "sessions.search", params);
    const keys = ((r.value.results as Rec[] | undefined) ?? []).map((h) => String(h.sessionKey));
    console.log(`    ${label}: ${r.ok ? `${keys.length} results, includes the deleted task: ${keys.includes(deleted)}` : r.error}`);
  }
  const h = await call(op, "chat.history", { sessionKey: deleted, limit: 5 });
  console.log(`    chat.history of the deleted task: ${h.ok ? `${(h.value.messages as unknown[] | undefined)?.length} rows` : h.error}`);
}

// Within one bot: do its task keys find matches its own search (limit 25) left out?
async function narrow(): Promise<void> {
  const op = await connect("read", READ);
  const bot = await search(op, "one bot", { query: "lanternfish", scope: { agentId: "pip" }, limit: 25 });
  const got = new Set(((bot.value.results as Rec[] | undefined) ?? []).map((h) => `${h.sessionKey} ${h.messageId}`));
  const keys = Array.from({ length: 16 }, (_, i) => `agent:pip:probe-many-${String(i).padStart(2, "0")}`);
  const r = await search(op, "its 16 task keys, 8 at a time (first 8)", { query: "lanternfish", sessionKeys: keys.slice(0, 8), limit: 25 });
  const r2 = await search(op, "its 16 task keys, 8 at a time (last 8)", { query: "lanternfish", sessionKeys: keys.slice(8), limit: 25 });
  const all = [...((r.value.results as Rec[] | undefined) ?? []), ...((r2.value.results as Rec[] | undefined) ?? [])];
  console.log(`  matches the bot search did not return: ${all.filter((h) => !got.has(`${h.sessionKey} ${h.messageId}`)).length}`);
}

// Ad hoc: q <query>... searches every bot (scope {}) at the read tier.
async function q(): Promise<void> {
  const op = await connect("read", READ);
  for (const query of positionals.slice(1)) await search(op, "scope", { query, scope: {}, limit: 25 });
}

const experiments: Record<string, () => Promise<void>> = { words, shape, many, long, bulk, gone, gone2, files, readonly, routines, narrow, q };
const run = experiments[experiment ?? ""];
if (!run) throw new Error(`experiment must be one of ${Object.keys(experiments).join(", ")}`);
try {
  await run();
} finally {
  for (const op of opened) {
    await op.close().catch(() => {});
    await inst.runner.run(["devices", "remove", op.deviceId]).catch(() => {});
  }
}
