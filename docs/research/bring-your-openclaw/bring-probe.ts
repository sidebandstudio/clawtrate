// Probes behind docs/research/bring-your-openclaw.md. Research code, not a check.
//
//   pnpm dev-gateway start --instance <name> --with-plugin clawtrate-memory
//   node docs/research/bring-your-openclaw/bring-probe.ts <experiment> --instance <name>
//
// It acts only on a named development instance this checkout started, through
// the tool's own operator client (a new paired device per connection, approved
// by request id through the tool's guarded runner). Every device it pairs is
// removed again before it exits. It never prints a token or a path outside the
// instance's own workspaces.
//
// Experiments (run in this order on a fresh instance):
//   knowledge  what a bot's memory, profile, notes and skills are, how each is
//              read at the read tier, and which writes into another bot's
//              workspace the gateway accepts (admin), refuses, or lacks
//   skills     a workspace skill seen per bot; a copy into the person's library
//   selection  whether a new task of each bot shows the library copy selected
//   jobs       a job moved to another bot and back with cron.update: its id,
//              definition, revision, state and history, and runs either side
//   scopes     the same reads and writes at the read and write tiers
//   record     a put-back record carried in the job's own description, written in
//              the same cron.update as the move; and a move while a run is going

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { openInstance } from "../../../tools/dev-gateway/src/cli.ts";
import { provenEndpoint } from "../../../tools/dev-gateway/src/endpoint.ts";
import { readRunRecord } from "../../../tools/dev-gateway/src/state-guard.ts";
import { OperatorSession } from "../../../tools/dev-gateway/src/operator.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { instance: { type: "string" } },
  allowPositionals: true,
});
if (!values.instance) throw new Error("--instance <name> is required; the default instance is never probed");
const inst = openInstance(values.instance);
const initialRun = readRunRecord(inst.runFile);
const experiment = positionals[0];

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v !== null && typeof v === "object" ? (v as Rec) : {});
const list = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);
const READ = ["operator.read"];
const WRITE = ["operator.read", "operator.write"];
const ADMIN = ["operator.read", "operator.write", "operator.admin"];
const opened: OperatorSession[] = [];

// The source bot plays "the bot a person already has"; the target plays the Main Bot.
const SOURCE = "otto";
const TARGET = "main";

function endpoint() {
  const proof = provenEndpoint({ instance: inst.name, home: inst.home, runDir: inst.runDir, checkout: inst.checkout });
  if ("refusal" in proof) throw new Error(proof.refusal);
  if (!initialRun || readRunRecord(inst.runFile)?.runId !== initialRun.runId) throw new Error("The named instance restarted during the probe");
  return proof;
}

async function cli(args: string[]): Promise<string> {
  endpoint();
  const result = await inst.runner.run(args);
  if (result.status !== 0) throw new Error(`Development gateway command failed: ${args[0]} ${args[1]}`);
  return result.stdout;
}

async function connect(name: string, scopes: string[]): Promise<OperatorSession> {
  const { url, token } = endpoint();
  const op = await OperatorSession.open({
    url, token, scopes, caps: ["tool-events"], displayName: `Clawtrate bring probe ${name}`,
    approvePairing: async (requestId) => { await cli(["devices", "approve", requestId]); },
  });
  opened.push(op);
  return op;
}

type Result = { ok: boolean; value: Rec; error?: string; details?: unknown };
async function call(op: OperatorSession, method: string, params: unknown): Promise<Result> {
  try {
    return { ok: true, value: rec(await op.request(method, params)) };
  } catch (error) {
    const e = error as { message?: string; details?: unknown; data?: unknown };
    return { ok: false, value: {}, error: String(e.message ?? error), details: e.details ?? e.data };
  }
}

function show(label: string, r: Result, pick?: (v: Rec) => unknown): void {
  if (!r.ok) {
    console.log(`  ${label}: REFUSED ${r.error}${r.details ? " " + JSON.stringify(r.details) : ""}`);
    return;
  }
  console.log(`  ${label}: ok ${JSON.stringify(pick ? pick(r.value) : r.value)}`);
}

const fileBrief = (v: Rec) => {
  const f = rec(v.file);
  return { name: f.name, missing: f.missing, size: f.size, hash: typeof f.hash === "string" ? f.hash.slice(0, 12) : f.hash };
};

// A memory a person's bot might have, including the kind of line that must not travel.
const SOURCE_MEMORY = [
  "# Memory",
  "",
  "- The media box is the small server in the hall cupboard; backups go to the blue drive.",
  "- Prefers a short summary first, details after.",
  "- Home network token: tok_example_0000000000000000 (do not share)",
  "",
].join("\n");
const SOURCE_USER = [
  "# About you",
  "",
  "- Call me Sam.",
  "- Writes in British English. Prefers metric units.",
  "- Works weekdays 9 to 5, Lisbon time.",
  "",
].join("\n");
const SOURCE_NOTE = "# 2026-11-20\n\n- Replaced the blue drive's cable; the backup ran clean afterwards.\n";
const SOURCE_SKILL = [
  "---",
  "name: disk-check",
  "description: Check free space on the media box and say which folders grew this week.",
  "---",
  "",
  "1. Run `df -h` and `du -sh` on the media folders.",
  "2. Compare with last week's note in memory.",
  "3. Report the three folders that grew most.",
  "",
].join("\n");

async function seedSource(admin: OperatorSession): Promise<string> {
  console.log(`Seeding ${SOURCE}'s memory, profile and one note through the gateway`);
  for (const [name, content] of [["MEMORY.md", SOURCE_MEMORY], ["USER.md", SOURCE_USER]] as const) {
    const now = await call(admin, "agents.files.get", { agentId: SOURCE, name });
    const f = rec(now.value.file);
    const params = f.missing ? { agentId: SOURCE, name, content, expectedMissing: true } : { agentId: SOURCE, name, content, expectedHash: f.hash };
    show(`agents.files.set ${SOURCE} ${name}`, await call(admin, "agents.files.set", params), (v) => ({ ok: v.ok, size: rec(v.file).size }));
  }
  show(`clawtrate-memory.write ${SOURCE} memory/2026-11-20.md`, await call(admin, "clawtrate-memory.write", { agentId: SOURCE, path: "memory/2026-11-20.md", content: SOURCE_NOTE, expectedHash: null }), (v) => ({ hash: String(v.hash ?? rec(v.file).hash ?? "").slice(0, 12) }));
  // No gateway method writes a workspace skill (see the research note), so the
  // fixture writes one file into this development instance's own workspace.
  const ws = String((await call(admin, "agents.files.get", { agentId: SOURCE, name: "AGENTS.md" })).value.workspace ?? "");
  const inside = path.relative(inst.home, ws);
  if (!ws || inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("The source workspace is not inside the instance");
  mkdirSync(path.join(ws, "skills", "disk-check"), { recursive: true });
  writeFileSync(path.join(ws, "skills", "disk-check", "SKILL.md"), SOURCE_SKILL);
  console.log(`  fixture: wrote skills/disk-check/SKILL.md in ${SOURCE}'s workspace on disk`);
  return ws;
}

async function knowledge(): Promise<void> {
  const admin = await connect("admin", ADMIN);
  const reader = await connect("read", READ);
  await seedSource(admin);

  console.log(`\nReading ${SOURCE} at the read tier`);
  show("agents.files.list", await call(reader, "agents.files.list", { agentId: SOURCE }), (v) => list(v.files).map((f) => `${f.name}${f.missing ? " (missing)" : ` ${f.size} B`}`));
  for (const name of ["MEMORY.md", "USER.md", "SOUL.md", "AGENTS.md", "IDENTITY.md", "TOOLS.md", "memory/2026-11-20.md"]) {
    show(`agents.files.get ${name}`, await call(reader, "agents.files.get", { agentId: SOURCE, name }), fileBrief);
  }
  show("agents.workspace.list /", await call(reader, "agents.workspace.list", { agentId: SOURCE }), (v) => list(v.entries ?? v.items ?? v.files).map((e) => `${e.path ?? e.name}${e.kind === "directory" || e.type === "directory" ? "/" : ""}`));
  show("agents.workspace.list memory", await call(reader, "agents.workspace.list", { agentId: SOURCE, path: "memory" }), (v) => list(v.entries ?? v.items ?? v.files).map((e) => e.path ?? e.name));
  show("agents.workspace.list skills/disk-check", await call(reader, "agents.workspace.list", { agentId: SOURCE, path: "skills/disk-check" }), (v) => list(v.entries ?? v.items ?? v.files).map((e) => e.path ?? e.name));
  show("agents.workspace.get memory note", await call(reader, "agents.workspace.get", { agentId: SOURCE, path: "memory/2026-11-20.md" }), (v) => ({ size: rec(v.file).size, chars: String(rec(v.file).content ?? "").length, mimeType: rec(v.file).mimeType }));
  show("agents.workspace.get SKILL.md", await call(reader, "agents.workspace.get", { agentId: SOURCE, path: "skills/disk-check/SKILL.md" }), (v) => ({ size: rec(v.file).size, chars: String(rec(v.file).content ?? "").length }));
  show("clawtrate-memory.list", await call(reader, "clawtrate-memory.list", { agentId: SOURCE }), (v) => list(v.entries ?? v.items ?? v.notes).map((e) => `${e.path} ${e.size} B`));
  show("memory.status", await call(reader, "memory.status", { agentId: SOURCE }), (v) => ({ status: v.status, providerId: v.providerId }));

  console.log(`\nWriting into ${TARGET}'s workspace (admin)`);
  const before = await call(admin, "agents.files.get", { agentId: TARGET, name: "MEMORY.md" });
  show(`agents.files.get ${TARGET} MEMORY.md`, before, fileBrief);
  const tf = rec(before.value.file);
  const memParams = tf.missing ? { expectedMissing: true } : { expectedHash: tf.hash };
  const wrote = await call(admin, "agents.files.set", { agentId: TARGET, name: "MEMORY.md", content: SOURCE_MEMORY, ...memParams });
  show(`agents.files.set ${TARGET} MEMORY.md`, wrote, (v) => ({ ok: v.ok, size: rec(v.file).size, hash: String(rec(v.file).hash ?? "").slice(0, 12) }));
  show(`agents.files.set ${TARGET} MEMORY.md again with the old precondition`, await call(admin, "agents.files.set", { agentId: TARGET, name: "MEMORY.md", content: "x", ...memParams }));
  show(`agents.files.set ${TARGET} memory/2026-11-20.md`, await call(admin, "agents.files.set", { agentId: TARGET, name: "memory/2026-11-20.md", content: SOURCE_NOTE, expectedMissing: true }));
  show(`agents.files.set ${TARGET} skills/disk-check/SKILL.md`, await call(admin, "agents.files.set", { agentId: TARGET, name: "skills/disk-check/SKILL.md", content: SOURCE_SKILL, expectedMissing: true }));
  show(`agents.files.set ${TARGET} 2 MiB + 1 byte`, await call(admin, "agents.files.set", { agentId: TARGET, name: "USER.md", content: "a".repeat(2_097_153), expectedMissing: true }));
  show(`clawtrate-memory.write ${TARGET} memory/imported/2026-11-20.md`, await call(admin, "clawtrate-memory.write", { agentId: TARGET, path: "memory/imported/2026-11-20.md", content: SOURCE_NOTE, expectedHash: null }), (v) => Object.keys(v));
  show(`clawtrate-memory.write ${TARGET} skills/disk-check/SKILL.md`, await call(admin, "clawtrate-memory.write", { agentId: TARGET, path: "skills/disk-check/SKILL.md", content: SOURCE_SKILL, expectedHash: null }));
  show(`agents.files.get ${TARGET} MEMORY.md after`, await call(reader, "agents.files.get", { agentId: TARGET, name: "MEMORY.md" }), fileBrief);

  console.log("\nCopying or cloning a bot in one step");
  const methods = rec(await reader.request("schema", {}).catch(() => ({})));
  console.log(`  schema answered: ${Object.keys(methods).length > 0}`);
  show("agents.clone", await call(admin, "agents.clone", { agentId: SOURCE, name: "Copy" }));
  show("agents.duplicate", await call(admin, "agents.duplicate", { agentId: SOURCE, name: "Copy" }));
  show("agents.create with a workspace field naming another bot's", await call(admin, "agents.create", { name: "Probe copy", workspace: "../workspaces/otto" }), (v) => ({ agentId: v.agentId, workspace: v.workspace ? path.relative(inst.home, String(v.workspace)) : null }));
}

async function skills(): Promise<void> {
  const admin = await connect("admin", ADMIN);
  const writer = await connect("write", WRITE);
  const reader = await connect("read", READ);
  const names = (v: Rec) => list(v.skills).filter((s) => s.source !== "openclaw-bundled" && s.bundled !== true).map((s) => `${s.name} [${s.source}] eligible=${s.eligible}`);
  show(`skills.status ${SOURCE}`, await call(reader, "skills.status", { agentId: SOURCE }), names);
  show(`skills.status ${TARGET}`, await call(reader, "skills.status", { agentId: TARGET }), names);
  show("skills.library.list mine (read)", await call(reader, "skills.library.list", { scope: "mine" }), (v) => list(v.entries ?? v.skills).map((e) => e.slug));
  const saved = await call(writer, "skills.library.save", { expectedRevision: null, slug: "disk-check", content: SOURCE_SKILL });
  show("skills.library.save disk-check (write)", saved, (v) => ({ state: v.state, target: v.target, entry: { slug: rec(v.entry).slug, enabled: rec(v.entry).enabled, revision: String(rec(v.entry).revision ?? "").slice(0, 12) } }));
  show("skills.library.save the same slug again with null revision", await call(writer, "skills.library.save", { expectedRevision: null, slug: "disk-check", content: SOURCE_SKILL }));
  show("skills.library.list mine after", await call(reader, "skills.library.list", { scope: "mine" }), (v) => list(v.entries ?? v.skills).map((e) => `${e.slug} enabled=${e.enabled}`));
  show(`skills.status ${TARGET} after`, await call(reader, "skills.status", { agentId: TARGET }), names);
  const cfg = await call(reader, "config.get", {});
  const entries = rec(rec(rec(cfg.value.config ?? cfg.value.parsed).agents).entries);
  console.log(`  config agents.entries.<id>.skills: ${JSON.stringify(Object.fromEntries(Object.entries(entries).map(([id, e]) => [id, rec(e).skills ?? "(all)"])))}`);
  void admin;
}

const jobBrief = (v: Rec) => {
  const st = rec(v.state);
  return { id: v.id, agentId: v.agentId ?? null, enabled: v.enabled, sessionTarget: v.sessionTarget, revision: String(v.configRevision ?? "").slice(0, 12), nextRunAtMs: st.nextRunAtMs ?? null, lastRunStatus: st.lastRunStatus ?? st.lastStatus ?? null, lastRunAtMs: st.lastRunAtMs ?? null };
};

async function runNow(admin: OperatorSession, id: string): Promise<Rec> {
  const r = await call(admin, "cron.run", { id, mode: "force", waitTimeoutMs: 60_000 });
  show(`cron.run ${id}`, r, (v) => ({ ran: v.ran, runId: v.runId, status: rec(v.run).status, sessionKey: rec(v.run).sessionKey }));
  return r.value;
}

async function runs(reader: OperatorSession, id: string, extra: Rec = {}): Promise<Rec[]> {
  const r = await call(reader, "cron.runs", { id, limit: 20, ...extra });
  show(`cron.runs ${id} ${JSON.stringify(extra)}`, r, (v) => list(v.entries).map((e) => ({ runId: e.runId, status: e.status, sessionKey: e.sessionKey })));
  return list(r.value.entries);
}

async function jobs(): Promise<void> {
  const admin = await connect("admin", ADMIN);
  const reader = await connect("read", READ);
  const writer = await connect("write", WRITE);
  const base = { schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "Europe/Lisbon" }, wakeMode: "now", delivery: { mode: "none" } };

  console.log("Adding three jobs on the source bot");
  const j1 = await call(admin, "cron.add", { name: "Probe morning check", agentId: SOURCE, sessionTarget: "isolated", payload: { kind: "agentTurn", message: "Check the backups. #steps" }, ...base });
  const j2 = await call(admin, "cron.add", { name: "Probe default-bot job", sessionTarget: "isolated", payload: { kind: "agentTurn", message: "Say hello." }, ...base });
  const j3 = await call(admin, "cron.add", { name: "Probe paused job", agentId: SOURCE, enabled: false, sessionTarget: "isolated", payload: { kind: "agentTurn", message: "Weekly tidy." }, ...base });
  for (const [label, r] of [["J1", j1], ["J2 (no agentId)", j2], ["J3 (paused)", j3]] as const) show(`cron.add ${label}`, r, jobBrief);
  const id1 = String(j1.value.id), id2 = String(j2.value.id), id3 = String(j3.value.id);

  const original = (await call(reader, "cron.get", { id: id1 })).value;
  show("cron.get J1", { ok: true, value: original }, (v) => ({ ...jobBrief(v), keys: Object.keys(v) }));
  await runNow(admin, id1);
  const firstRuns = await runs(reader, id1);

  console.log(`\nMoving J1 to ${TARGET} in one step`);
  show("write tier cron.update agentId", await call(writer, "cron.update", { id: id1, patch: { agentId: TARGET } }));
  const moved = await call(admin, "cron.update", { id: id1, patch: { agentId: TARGET }, expectedConfigRevision: original.configRevision });
  show("cron.update agentId with the revision read", moved, jobBrief);
  show("cron.update again with the old revision", await call(admin, "cron.update", { id: id1, patch: { enabled: false }, expectedConfigRevision: original.configRevision }));
  show("cron.update agentId to a bot that doesn't exist", await call(admin, "cron.update", { id: id1, patch: { agentId: "nobody" } }), jobBrief);
  show("cron.get J1 after the move", await call(reader, "cron.get", { id: id1 }), jobBrief);
  await runs(reader, id1);
  await runs(reader, id1, { agentId: SOURCE });
  await runs(reader, id1, { agentId: TARGET });
  if (firstRuns[0]) {
    show("cron.history of the run before the move", await call(reader, "cron.history", { id: id1, runId: firstRuns[0].runId }), (v) => ({ messages: list(v.messages).length }));
  }
  await runNow(admin, id1);
  const bothRuns = await runs(reader, id1);

  console.log(`\nReversing J1 to ${SOURCE}`);
  const now = (await call(reader, "cron.get", { id: id1 })).value;
  const back = await call(admin, "cron.update", { id: id1, patch: { agentId: SOURCE }, expectedConfigRevision: now.configRevision });
  show("cron.update agentId back", back, jobBrief);
  console.log(`  revision equals the original: ${back.value.configRevision === original.configRevision}`);
  const strip = (v: Rec) => JSON.stringify({ ...v, state: undefined, updatedAtMs: undefined, configRevision: undefined });
  console.log(`  definition equals the original (state and updatedAtMs aside): ${strip(back.value) === strip(original)}`);
  const diff = Object.keys({ ...original, ...back.value }).filter((k) => JSON.stringify(original[k]) !== JSON.stringify(back.value[k]));
  console.log(`  fields that differ from the original read: ${JSON.stringify(diff)}`);
  await runs(reader, id1);
  for (const run of bothRuns) {
    show(`cron.history ${run.sessionKey}`, await call(reader, "cron.history", { id: id1, runId: run.runId }), (v) => ({ messages: list(v.messages).length }));
  }

  console.log("\nJ2 has no agentId: it runs as the default bot");
  const j2now = (await call(reader, "cron.get", { id: id2 })).value;
  show(`cron.update J2 agentId ${SOURCE}`, await call(admin, "cron.update", { id: id2, patch: { agentId: SOURCE }, expectedConfigRevision: j2now.configRevision }), jobBrief);
  const j2moved = (await call(reader, "cron.get", { id: id2 })).value;
  const j2back = await call(admin, "cron.update", { id: id2, patch: { agentId: null }, expectedConfigRevision: j2moved.configRevision });
  show("cron.update J2 agentId null", j2back, jobBrief);
  console.log(`  J2 revision equals the original: ${j2back.value.configRevision === j2now.configRevision}; agentId absent: ${!("agentId" in j2back.value)}`);

  console.log("\nJ3 is paused: moving keeps it paused");
  const j3now = (await call(reader, "cron.get", { id: id3 })).value;
  show(`cron.update J3 agentId ${TARGET}`, await call(admin, "cron.update", { id: id3, patch: { agentId: TARGET }, expectedConfigRevision: j3now.configRevision }), jobBrief);

  console.log("\nA job bound to one of the source bot's own tasks");
  const j4 = await call(admin, "cron.add", { name: "Probe bound job", agentId: SOURCE, sessionTarget: `session:agent:${SOURCE}:main`, payload: { kind: "agentTurn", message: "Nudge." }, ...base });
  show("cron.add J4", j4, jobBrief);
  if (j4.ok) {
    show(`cron.update J4 agentId ${TARGET}`, await call(admin, "cron.update", { id: String(j4.value.id), patch: { agentId: TARGET }, expectedConfigRevision: j4.value.configRevision }), jobBrief);
  }
  const j5 = await call(admin, "cron.add", { name: "Probe main-session job", agentId: SOURCE, sessionTarget: "main", payload: { kind: "systemEvent", text: "Reminder: stretch." }, schedule: base.schedule, wakeMode: "now" });
  show("cron.add J5 (main session, system event)", j5, jobBrief);
  if (j5.ok) {
    show(`cron.update J5 agentId ${TARGET}`, await call(admin, "cron.update", { id: String(j5.value.id), patch: { agentId: TARGET }, expectedConfigRevision: j5.value.configRevision }), jobBrief);
  }

  console.log("\nA job that announces to the bot's last chat: bot and delivery changed together, then back");
  const j6 = await call(admin, "cron.add", { name: "Probe announce job", agentId: SOURCE, sessionTarget: "isolated", payload: { kind: "agentTurn", message: "Summarise." }, schedule: base.schedule, wakeMode: "now", delivery: { mode: "announce", channel: "last" } });
  show("cron.add J6 announce to last", j6, (v) => ({ ...jobBrief(v), delivery: v.delivery }));
  if (j6.ok) {
    const id6 = String(j6.value.id);
    const listed = await call(reader, "cron.list", { includeDisabled: true, limit: 50 });
    console.log(`  cron.list deliveryPreviews[J6]: ${JSON.stringify(rec(listed.value.deliveryPreviews)[id6] ?? null)}`);
    const in6 = await call(admin, "cron.update", { id: id6, patch: { agentId: TARGET, delivery: { mode: "none" } }, expectedConfigRevision: j6.value.configRevision });
    show("cron.update J6 agentId + delivery none", in6, (v) => ({ ...jobBrief(v), delivery: v.delivery, deliveryPreview: v.deliveryPreview ?? null }));
    const out6 = await call(admin, "cron.update", { id: id6, patch: { agentId: SOURCE, delivery: j6.value.delivery }, expectedConfigRevision: in6.value.configRevision });
    show("cron.update J6 back with the original delivery", out6, (v) => ({ ...jobBrief(v), delivery: v.delivery }));
    console.log(`  J6 revision equals the original: ${out6.value.configRevision === j6.value.configRevision}`);
    const only = await call(admin, "cron.update", { id: id6, patch: { agentId: TARGET }, expectedConfigRevision: out6.value.configRevision });
    show("cron.update J6 agentId only", only, (v) => ({ ...jobBrief(v), deliveryPreview: v.deliveryPreview ?? null }));
  }

  console.log("\nEvents the read device saw");
  const cronEvents = reader.events.filter((e) => e.event === "cron").map((e) => ({ action: rec(e.payload).action, jobId: rec(e.payload).jobId, agentId: rec(rec(e.payload).job).agentId ?? null }));
  console.log(`  ${JSON.stringify(cronEvents)}`);
  console.log(`  cron.list fields: ${JSON.stringify(Object.keys(list((await call(reader, "cron.list", { includeDisabled: true, limit: 5 })).value.jobs)[0] ?? {}))}`);
}

async function scopes(): Promise<void> {
  const reader = await connect("read", READ);
  const writer = await connect("write", WRITE);
  for (const [tier, op] of [["read", reader], ["write", writer]] as const) {
    console.log(`${tier} tier`);
    show("agents.files.get MEMORY.md", await call(op, "agents.files.get", { agentId: SOURCE, name: "MEMORY.md" }), fileBrief);
    show("agents.files.set MEMORY.md", await call(op, "agents.files.set", { agentId: TARGET, name: "MEMORY.md", content: "x", expectedMissing: true }));
    show("clawtrate-memory.write", await call(op, "clawtrate-memory.write", { agentId: TARGET, path: "memory/x.md", content: "x", expectedHash: null }));
    show("cron.list", await call(op, "cron.list", { includeDisabled: true, limit: 1 }), (v) => ({ total: v.total }));
    show("cron.update", await call(op, "cron.update", { id: "none", patch: { enabled: false } }));
    show("skills.library.save", await call(op, "skills.library.save", { expectedRevision: null, slug: `scope-${tier}`, content: "---\nname: scope\ndescription: probe\n---\n" }), (v) => ({ state: v.state }));
  }
}

// After "skills": does a new task of each bot select the library copy?
async function selection(): Promise<void> {
  const writer = await connect("write", WRITE);
  const reader = await connect("read", READ);
  for (const agentId of [TARGET, "marlow"]) {
    const key = `agent:${agentId}:probe-selection-2`;
    show(`sessions.create ${key}`, await call(writer, "sessions.create", { key }), (v) => ({ ok: v.ok ?? true, key: v.key }));
    show(`skills.status ${agentId} for that task`, await call(reader, "skills.status", { agentId, sessionKey: key }), (v) => list(v.skills).filter((s) => !String(s.source).startsWith("openclaw-")).map((s) => `${s.name} [${s.source}]`).concat(Object.keys(v).filter((k) => /select|library/i.test(k)).map((k) => `${k}=${JSON.stringify(v[k]).slice(0, 200)}`)));
  }
  const rows = await call(reader, "sessions.list", { limit: 200 });
  for (const row of list(rows.value.sessions).filter((r) => String(r.key).includes("probe-selection"))) {
    console.log(`  sessions.list ${row.key}: skillLibrarySelections=${JSON.stringify(row.skillLibrarySelections ?? null)}`);
  }
  show(`skills.workshop.list ${SOURCE}`, await call(reader, "skills.workshop.list", { agentId: SOURCE }), (v) => Object.keys(v));
}

// The record Clawtrate would keep on a moved job: its last line of `description`.
const MARK = "[clawtrate:brought-in";
function withMark(original: unknown, fields: Rec): string {
  const line = `${MARK} ${JSON.stringify(fields)}]`;
  const text = typeof original === "string" ? original : "";
  return text ? `${text}\n\n${line}` : line;
}

async function record(): Promise<void> {
  const admin = await connect("admin", ADMIN);
  const reader = await connect("read", READ);
  const base = { schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "Europe/Lisbon" }, wakeMode: "now", sessionTarget: "isolated" };
  const bots = list((await call(reader, "agents.list", {})).value.agents);
  const created = bots.find((b) => b.id === SOURCE)?.createdAt ?? null;
  console.log(`  agents.list ${SOURCE} createdAt: ${created === null ? "absent" : "present"}`);
  const cases: Array<[string, Rec]> = [
    ["no description", { name: "Rec plain", agentId: SOURCE, payload: { kind: "agentTurn", message: "Check." }, delivery: { mode: "none" }, ...base }],
    ["a description", { name: "Rec described", agentId: SOURCE, description: "Checks the backups each weekday.", payload: { kind: "agentTurn", message: "Check." }, delivery: { mode: "none" }, ...base }],
    ["announce to last", { name: "Rec announce", agentId: SOURCE, payload: { kind: "agentTurn", message: "Summarise." }, delivery: { mode: "announce", channel: "last" }, ...base }],
  ];
  for (const [label, params] of cases) {
    console.log(`\nJob with ${label}`);
    const added = await call(admin, "cron.add", params);
    if (!added.ok) { show("cron.add", added); continue; }
    const id = String(added.value.id);
    const original = (await call(reader, "cron.get", { id })).value;
    const changeDelivery = rec(original.delivery).mode === "announce";
    const fields = { from: SOURCE, fromCreatedAt: created, at: "2026-11-24T10:00:00Z", ...(changeDelivery ? { delivery: original.delivery } : {}) };
    const patch: Rec = { agentId: TARGET, description: withMark(original.description, fields), ...(changeDelivery ? { delivery: { mode: "none" } } : {}) };
    const moved = await call(admin, "cron.update", { id, patch, expectedConfigRevision: original.configRevision });
    show("move with the record in description", moved, (v) => ({ agentId: v.agentId, description: v.description, revision: String(v.configRevision).slice(0, 14) }));
    const seen = (await call(reader, "cron.list", { includeDisabled: true, limit: 200 })).value;
    const row = list(seen.jobs).find((j) => j.id === id) ?? {};
    console.log(`  read device, cron.list description: ${JSON.stringify(row.description ?? null)}`);
    const text = String(rec(moved.value).description ?? "");
    const markAt = text.lastIndexOf(MARK);
    const kept = JSON.parse(text.slice(markAt + MARK.length + 1, -1)) as Rec;
    const before = text.slice(0, markAt).replace(/\n\n$/, "");
    const back = await call(admin, "cron.update", { id, patch: { agentId: kept.from, description: before, ...(kept.delivery ? { delivery: kept.delivery } : {}) }, expectedConfigRevision: moved.value.configRevision });
    show("put back from the record", back, (v) => ({ agentId: v.agentId ?? null, description: v.description ?? null, delivery: v.delivery ?? null }));
    console.log(`  revision equals the original: ${back.value.configRevision === original.configRevision}`);
  }

  console.log("\nA move while a run is going");
  const slow = await call(admin, "cron.add", { name: "Rec slow", agentId: SOURCE, payload: { kind: "agentTurn", message: "Take your time. #slow 8" }, delivery: { mode: "none" }, ...base });
  if (slow.ok) {
    const id = String(slow.value.id);
    show("cron.run without waiting", await call(admin, "cron.run", { id, mode: "force", waitTimeoutMs: 1 }), (v) => ({ ran: v.ran, enqueued: v.enqueued }));
    await new Promise((r) => setTimeout(r, 1500));
    const during = (await call(reader, "cron.get", { id })).value;
    console.log(`  state.runningAtMs set: ${rec(during.state).runningAtMs !== undefined}`);
    show("cron.update agentId during the run", await call(admin, "cron.update", { id, patch: { agentId: TARGET }, expectedConfigRevision: during.configRevision }), (v) => ({ agentId: v.agentId }));
    show("cron.get after", await call(reader, "cron.get", { id }), (v) => ({ agentId: v.agentId }));
  }
}

const experiments: Record<string, () => Promise<void>> = { knowledge, skills, selection, jobs, scopes, record };
const run = experiments[experiment ?? ""];
if (!run) throw new Error(`experiment must be one of ${Object.keys(experiments).join(", ")}`);
try {
  await run();
} finally {
  for (const op of opened) {
    await op.close().catch(() => {});
    try {
      await cli(["devices", "remove", op.deviceId]);
    } catch (error) {
      console.error("Could not remove the probe device:", error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
