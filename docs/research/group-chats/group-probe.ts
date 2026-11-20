// Probes behind docs/research/group-chats.md. Research code, not a check.
//
//   pnpm dev-gateway start --instance <name>
//   node docs/research/group-chats/group-probe.ts <experiment> --instance <name>
//
// It acts only on a named development instance this checkout started, through
// the tool's own `openOperator` (a new device key, its pairing approved by id
// through the tool's guarded runner, so `openclaw` only ever runs with
// `--profile clawtrate-dev-<name>`). It prints no token. Each experiment pairs
// its own devices and removes them when it ends.
//
// Juniper's agent id on the development gateway is `main`.
//
// Experiments:
//   nomulti    one session per bot: a send naming another bot, the methods
//              whose names suggest a group, sessions.create's key
//   fanout     one message to three new tasks (Juniper, Otto, Marlow) as three
//              chat.send calls; the replies' order and clocks; history rows
//   busy       the same, while Otto's task is still running a slow turn
//   refused    the same, with Marlow's task archived first
//   mentions   chat.send with a mention, from this client
//   reply      chat.send with replyToId: a message of the same task, and one
//              of another task; what the scripted model received
//   stop       three slow runs, then chat.abort on each
//   prefs      users.prefs: a group record written, read back by a second
//              device, the change event, compare-and-set, deletion, limits,
//              and a read-only device
//   approval   an approval raised in one member task: what it names, which
//              devices receive it, what it offers
//   relay      Marlow messages Pip from a group task: where it lands
//   archive    archiving and deleting a member's task
//   create     sessions.create for the members: a shared label, an unknown bot
//   stopdevices  two devices, each Stop on the other's run and its own
//   queuedstop   a later input from another device, then a task-wide Stop; a run-specific Stop
//   cards        a question and an approval from device A, as B and a read-only device see them
//   order        two replies: the order their runs end against their saved timestamps
//   ownqueued    a task-wide abort by the device whose input is queued; a run-specific abort
//   replaced     an old sessionId alone against a task already replaced; a member removed mid-run
//   guard        a send to a task deleted after the check, unguarded and guarded
//   delbot     a member bot deleted (admin): what is left of its task

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openInstance, openOperator } from "../../../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../../../tools/dev-gateway/src/operator.ts";

const READ = ["operator.read"];
const INTERACTIVE = ["operator.read", "operator.write", "operator.approvals", "operator.questions"];
const ADMIN = [...INTERACTIVE, "operator.admin"];
const APPROVAL_CAPS = ["tool-events", "approvals", "exec-approvals", "plugin-approvals"];

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v !== null && typeof v === "object" ? (v as Rec) : {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (label: string, value: unknown) => console.log(`${label}: ${JSON.stringify(value)}`);

const args = process.argv.slice(2);
const experiment = args[0];
const instIdx = args.indexOf("--instance");
const name = instIdx >= 0 ? args[instIdx + 1] : undefined;
if (!experiment || !name) {
  console.error("usage: group-probe.ts <experiment> --instance <name>");
  process.exit(2);
}
const inst = openInstance(name);
const opened: OperatorSession[] = [];

async function device(label: string, scopes = INTERACTIVE, caps = APPROVAL_CAPS) {
  const op = await openOperator(inst, `Clawtrate group probe ${label}`, scopes, caps);
  opened.push(op);
  return op;
}

async function cleanup() {
  for (const op of opened) {
    await op.close();
    await inst.runner.run(["devices", "remove", op.deviceId]).catch(() => {});
  }
}

async function call(op: OperatorSession, method: string, params: Rec) {
  try {
    return { ok: true, result: await op.request(method, params) };
  } catch (error) {
    const e = rec(error);
    return { ok: false, error: String(e.message ?? error), code: e.gatewayCode ?? e.code, details: e.details };
  }
}

async function newTask(op: OperatorSession, agentId: string, label: string) {
  const r = rec(await op.request("sessions.create", { agentId, label }));
  return String(r.key);
}

async function patchLifecycle(op: OperatorSession, key: string, fields: Rec) {
  const d = rec(rec((await call(op, "sessions.describe", { key })).result).session);
  return call(op, "sessions.patch", { key, expectedSessionId: d.sessionId, ...fields });
}

async function subscribe(op: OperatorSession, key: string, includeApprovals = false) {
  return call(op, "sessions.messages.subscribe", { key, ...(includeApprovals ? { includeApprovals } : {}) });
}

function summarizeRow(m: unknown) {
  const r = rec(m);
  const oc = rec(r.__openclaw);
  const content = Array.isArray(r.content)
    ? r.content.map((c) => rec(c).text ?? rec(c).type).join(" | ")
    : r.content;
  return {
    role: r.role,
    timestamp: r.timestamp,
    id: oc.id,
    seq: oc.seq,
    idempotencyKey: r.idempotencyKey,
    replyTo: oc.replyToId ? { id: oc.replyToId, message: JSON.stringify(oc.replyToMessage ?? null).slice(0, 160), preview: JSON.stringify(oc.replyToPreview ?? null).slice(0, 160) } : undefined,
    text: String(content ?? "").slice(0, 80),
    keys: Object.keys(r).sort(),
    openclawKeys: Object.keys(oc).sort(),
  };
}

async function history(op: OperatorSession, key: string) {
  const h = rec(await op.request("chat.history", { sessionKey: key, limit: 50 }));
  return (h.messages as unknown[]).map(summarizeRow);
}

/** Send one text to several tasks as separate chat.send calls, at once. */
async function fan(op: OperatorSession, keys: string[], message: string) {
  const sentAt = Date.now();
  const results = await Promise.all(
    keys.map(async (key) => {
      const t0 = Date.now();
      const r = await call(op, "chat.send", { sessionKey: key, message, idempotencyKey: `grp-${randomUUID()}` });
      return { key, ms: Date.now() - t0, ...r };
    }),
  );
  return { sentAt, results };
}

/** Terminal chat events for the given run ids, in the order they reached this device. */
async function ends(op: OperatorSession, runIds: string[], timeoutMs = 90_000) {
  const done = await Promise.all(
    runIds.map((id) => op.terminal(id, timeoutMs).then((p) => ({ runId: id, state: p.state, sessionKey: p.sessionKey }))),
  );
  const order = op.events
    .filter((e) => e.event === "chat" && runIds.includes(String(rec(e.payload).runId)) && ["final", "aborted", "error"].includes(String(rec(e.payload).state)))
    .map((e) => ({ at: e.at, seq: e.seq, sessionKey: rec(e.payload).sessionKey, state: rec(e.payload).state, errorMessage: rec(e.payload).errorMessage }));
  return { done, order };
}

const runIdsOf = (f: Awaited<ReturnType<typeof fan>>) =>
  f.results.filter((r) => r.ok).map((r) => String(rec(r.result).runId));

const experiments: Record<string, () => Promise<void>> = {
  async nomulti() {
    const op = await device("a");
    const key = await newTask(op, "main", `Probe ${Date.now()}`);
    out("sessions.create key", key);
    out("chat.send to Juniper's task naming agentId otto", await call(op, "chat.send", { sessionKey: key, agentId: "otto", message: "#text", idempotencyKey: randomUUID() }));
    out("session.members.add with identityId agent:otto", await call(op, "session.members.add", { sessionKey: key, identityId: "agent:otto" }));
    out("session.members.list", await call(op, "session.members.list", { sessionKey: key }));
    out("sessions.groups.list", await call(op, "sessions.groups.list", {}));
    out("session.discussion.info", await call(op, "session.discussion.info", { sessionKey: key }));
  },

  async fanout() {
    const op = await device("a");
    const stamp = Date.now();
    const keys = [
      await newTask(op, "main", `Group probe J ${stamp}`),
      await newTask(op, "otto", `Group probe O ${stamp}`),
      await newTask(op, "marlow", `Group probe M ${stamp}`),
    ];
    for (const k of keys) await subscribe(op, k);
    const f = await fan(op, keys, "#text");
    out("three chat.send answers", f.results.map((r) => ({ key: r.key, ok: r.ok, ms: r.ms, result: r.result, error: r.error })));
    out("ends", await ends(op, runIdsOf(f)));
    for (const k of keys) out(`history ${k}`, await history(op, k));
  },

  async busy() {
    const op = await device("a");
    const stamp = Date.now();
    const keys = [
      await newTask(op, "main", `Group busy J ${stamp}`),
      await newTask(op, "otto", `Group busy O ${stamp}`),
      await newTask(op, "marlow", `Group busy M ${stamp}`),
    ];
    for (const k of keys) await subscribe(op, k);
    const first = rec(await op.request("chat.send", { sessionKey: keys[1], message: "#slow 8", idempotencyKey: randomUUID() }));
    out("Otto's slow run", first);
    await sleep(1500);
    const f = await fan(op, keys, "#text");
    out("three chat.send answers while Otto runs", f.results.map((r) => ({ key: r.key, ok: r.ok, result: r.result, error: r.error })));
    out("ends", await ends(op, [String(first.runId), ...runIdsOf(f)], 120_000));
    out(`history Otto`, await history(op, keys[1]));
  },

  async refused() {
    const op = await device("a");
    const stamp = Date.now();
    const keys = [
      await newTask(op, "main", `Group refused J ${stamp}`),
      await newTask(op, "otto", `Group refused O ${stamp}`),
      await newTask(op, "marlow", `Group refused M ${stamp}`),
    ];
    out("archive Marlow's task", await patchLifecycle(op, keys[2], { archived: true }));
    out("Marlow's task archived", rec(rec(rec((await call(op, "sessions.describe", { key: keys[2] })).result).session)).archived);
    const f = await fan(op, keys, "#text");
    out("three chat.send answers", f.results.map((r) => ({ key: r.key, ok: r.ok, result: r.result, error: r.error })));
    out("ends", await ends(op, runIdsOf(f)));
    out("a send with no text to one task", await call(op, "chat.send", { sessionKey: keys[0], message: "", idempotencyKey: randomUUID() }));
    const ghost = `agent:otto:dashboard:${randomUUID()}`;
    out("describe a task key that does not exist", await call(op, "sessions.describe", { key: ghost }));
    out("a send to that key", await call(op, "chat.send", { sessionKey: ghost, message: "#text", idempotencyKey: randomUUID() }));
    await sleep(3000);
    const g = rec(rec((await call(op, "sessions.describe", { key: ghost })).result).session);
    out("describe it after the send", { key: g.key, createdVia: g.createdVia, label: g.label });
  },

  async mentions() {
    const op = await device("a");
    const key = await newTask(op, "main", `Group mentions ${Date.now()}`);
    const message = "@Juniper #text";
    out("chat.send with a mention of the bot's name", await call(op, "chat.send", { sessionKey: key, message, idempotencyKey: randomUUID(), mentions: [{ profileId: "juniper", start: 0, end: 8 }] }));
    out("chat.send of the same text without mentions", await call(op, "chat.send", { sessionKey: key, message, idempotencyKey: randomUUID() }));
    await sleep(3000);
    out("history", await history(op, key));
  },

  async reply() {
    const op = await device("a");
    const stamp = Date.now();
    const j = await newTask(op, "main", `Group reply J ${stamp}`);
    const o = await newTask(op, "otto", `Group reply O ${stamp}`);
    for (const k of [j, o]) await subscribe(op, k);
    const f = await fan(op, [j, o], "#text");
    await ends(op, runIdsOf(f));
    const hj = await history(op, j);
    const juniperReply = [...hj].reverse().find((r) => r.role === "assistant");
    out("Juniper's reply id", juniperReply?.id);
    const before = providerLogSize();
    const r1 = await call(op, "chat.send", { sessionKey: j, message: "#text reply in Juniper's own task", idempotencyKey: randomUUID(), replyToId: juniperReply?.id });
    out("reply to Juniper's message in Juniper's task", r1);
    if (r1.ok) await op.terminal(String(rec(r1.result).runId));
    const r2 = await call(op, "chat.send", { sessionKey: o, message: "#text reply naming Juniper's message in Otto's task", idempotencyKey: randomUUID(), replyToId: juniperReply?.id });
    out("the same replyToId sent to Otto's task", r2);
    if (r2.ok) await op.terminal(String(rec(r2.result).runId));
    out("what the scripted model received since (user turns, last 600 chars each)", providerUserTurns(before));
    out("history Juniper (tail)", (await history(op, j)).slice(-2));
    out("history Otto (tail)", (await history(op, o)).slice(-2));
  },

  async stop() {
    const op = await device("a");
    const stamp = Date.now();
    const keys = [
      await newTask(op, "main", `Group stop J ${stamp}`),
      await newTask(op, "otto", `Group stop O ${stamp}`),
      await newTask(op, "marlow", `Group stop M ${stamp}`),
    ];
    for (const k of keys) await subscribe(op, k);
    const f = await fan(op, keys, "#slow 10");
    await sleep(2000);
    const aborts = await Promise.all(keys.map((k) => call(op, "chat.abort", { sessionKey: k })));
    out("chat.abort on each", aborts);
    out("ends", await ends(op, runIdsOf(f)));
    out("chat.abort on a task with no run", await call(op, "chat.abort", { sessionKey: keys[0] }));
  },

  async prefs() {
    const a = await device("a");
    const b = await device("b");
    const r = await device("r", READ, ["tool-events"]);
    const key = `clawtrate.group.${randomUUID().slice(0, 8)}`;
    const group = {
      v: 1,
      name: "Weekend plans",
      members: [
        { agentId: "main", sessionKey: "agent:main:dashboard:00000000-0000-4000-8000-000000000001" },
        { agentId: "otto", sessionKey: "agent:otto:dashboard:00000000-0000-4000-8000-000000000002" },
        { agentId: "marlow", sessionKey: "agent:marlow:dashboard:00000000-0000-4000-8000-000000000003" },
      ],
      createdAt: Date.now(),
    };
    out("a: users.prefs.get before", await call(a, "users.prefs.get", { keys: [key] }));
    const seqB = b.lastSeq;
    out("a: set, must be absent", await call(a, "users.prefs.set", { entries: { [key]: group }, expectedEntries: { [key]: null } }));
    out("a: the same set again, must be absent", await call(a, "users.prefs.set", { entries: { [key]: group }, expectedEntries: { [key]: null } }));
    out("b: get", await call(b, "users.prefs.get", { keys: [key] }));
    await sleep(500);
    out("b: users.prefs.changed received", b.events.filter((e) => e.seq > seqB && e.event === "users.prefs.changed").map((e) => e.payload));
    out("r (read only): get", await call(r, "users.prefs.get", { keys: [key] }));
    out("r (read only): users.prefs.changed received", r.events.filter((e) => e.event === "users.prefs.changed").map((e) => e.payload));
    out("r (read only): set", await call(r, "users.prefs.set", { entries: { [key]: { ...group, name: "x" } } }));
    const renamed = { ...group, name: "Saturday" };
    out("b: rename with compare-and-set on the old record", await call(b, "users.prefs.set", { entries: { [key]: renamed }, expectedEntries: { [key]: group } }));
    out("a: rename with the now stale record", await call(a, "users.prefs.set", { entries: { [key]: { ...group, name: "Sunday" } }, expectedEntries: { [key]: group } }));
    out("a: get", await call(a, "users.prefs.get", { keys: [key] }));
    const big = { ...group, pad: "x".repeat(4200) };
    out("a: a value over 4,096 bytes", await call(a, "users.prefs.set", { entries: { [key + "-big"]: big } }));
    out("a: get all keys (count)", Object.keys(rec(rec((await call(a, "users.prefs.get", {})).result).entries)).length);
    // The profile's key limit: fill up to it with throwaway keys, then remove them.
    const filler: string[] = [];
    let limit: unknown = null;
    for (let batch = 0; batch < 6 && !limit; batch++) {
      const entries: Rec = {};
      for (let i = 0; i < 32; i++) {
        const k = `clawtrate.probe.fill.${batch}.${i}`;
        entries[k] = i;
        filler.push(k);
      }
      const res = await call(a, "users.prefs.set", { entries });
      if (!res.ok) limit = res;
    }
    out("a: past the key limit", limit);
    const del: Rec = {};
    for (const k of filler) del[k] = null;
    for (let i = 0; i < filler.length; i += 32) {
      const chunk: Rec = {};
      for (const k of filler.slice(i, i + 32)) chunk[k] = null;
      await call(a, "users.prefs.set", { entries: chunk });
    }
    out("a: delete the group (null)", await call(a, "users.prefs.set", { entries: { [key]: null } }));
    out("b: get after delete", await call(b, "users.prefs.get", { keys: [key] }));
    out("a: users.self", await call(a, "users.self", {}));
    out("b: users.self", await call(b, "users.self", {}));
  },

  async approval() {
    const a = await device("a");
    const b = await device("b");
    const r = await device("r", READ, ["tool-events"]);
    const stamp = Date.now();
    const j = await newTask(a, "main", `Group approval J ${stamp}`);
    const o = await newTask(a, "otto", `Group approval O ${stamp}`);
    for (const k of [j, o]) {
      out(`a subscribes ${k.split(":")[1]} with approvals`, (await subscribe(a, k, true)).ok);
      out(`b subscribes ${k.split(":")[1]} with approvals`, await subscribe(b, k, true));
      out(`r subscribes ${k.split(":")[1]}`, (await subscribe(r, k)).ok);
    }
    const seq = { a: a.lastSeq, b: b.lastSeq, r: r.lastSeq };
    const f = await fan(a, [j, o], "#approve");
    out("two chat.send answers", f.results.map((x) => ({ key: x.key, ok: x.ok, result: x.result })));
    const req = await a.waitFor("exec.approval.requested", (e) => e.event === "exec.approval.requested", 60_000, seq.a);
    const p = rec(req.payload);
    const request = rec(p.request);
    out("a: exec.approval.requested", { id: p.id, agentId: request.agentId, sessionKey: request.sessionKey, command: request.command, allowedDecisions: request.allowedDecisions ?? p.allowedDecisions, keys: Object.keys(request).sort() });
    await sleep(1000);
    const names = (op: OperatorSession, after: number) => op.events.filter((e) => e.seq > after && /approval/.test(e.event)).map((e) => e.event);
    out("b: approval events", names(b, seq.b));
    out("r: approval events", names(r, seq.r));
    out("r: lifecycle waiting-approval seen", r.events.some((e) => e.seq > seq.r && e.event === "agent" && rec(rec(e.payload).data).phase === "waiting-approval"));
    out("b: exec.approval.list", await call(b, "exec.approval.list", {}));
    out("b resolves allow-once", await call(b, "exec.approval.resolve", { id: p.id, decision: "allow-once" }));
    out("a resolves allow-always", await call(a, "exec.approval.resolve", { id: p.id, decision: "allow-always" }));
    out("ends", await ends(a, runIdsOf(f)));
    const admin = await device("admin", ADMIN);
    const file = rec(rec((await call(admin, "exec.approvals.get", {})).result).file);
    const agents = rec(file.agents);
    out("exec.approvals.get: agents with an allowlist", Object.fromEntries(Object.entries(agents).map(([id, v]) => [id, (rec(v).allowlist as unknown[] | undefined)?.map((e) => rec(e).pattern ?? e)])));
    out("exec.approvals.get: top-level keys", Object.keys(file));
  },

  async relay() {
    const op = await device("a");
    const stamp = Date.now();
    const m = await newTask(op, "marlow", `Group relay M ${stamp}`);
    const p = await newTask(op, "pip", `Group relay P ${stamp}`);
    for (const k of [m, p]) await subscribe(op, k);
    const r = rec(await op.request("chat.send", { sessionKey: m, message: "#message", idempotencyKey: randomUUID() }));
    await op.terminal(String(r.runId), 120_000);
    const tool = op.events.filter((e) => e.event === "agent" && rec(e.payload).runId === r.runId && rec(e.payload).stream === "tool").map((e) => rec(rec(e.payload).data));
    out("Marlow's sessions_send events", tool.map((d) => ({ phase: d.phase, name: d.name, args: d.args, result: d.result ? JSON.stringify(d.result).slice(0, 600) : undefined })));
    out("Pip's group task history after", await history(op, p));
    const list = rec(await op.request("sessions.list", { agentId: "pip", limit: 50 }));
    out("Pip's tasks", (list.sessions as unknown[]).map((s) => ({ key: rec(s).key, label: rec(s).label, updatedAt: rec(s).updatedAt })).slice(0, 6));
  },

  async archive() {
    const op = await device("a");
    const stamp = Date.now();
    const j = await newTask(op, "main", `Group archive J ${stamp}`);
    await subscribe(op, j);
    const r = rec(await op.request("chat.send", { sessionKey: j, message: "#text", idempotencyKey: randomUUID() }));
    await op.terminal(String(r.runId));
    out("archive", await patchLifecycle(op, j, { archived: true }));
    out("history of the archived task (count)", (await history(op, j)).length);
    out("listed without archived", (rec(await op.request("sessions.list", { agentId: "main", limit: 100 })).sessions as unknown[]).some((s) => rec(s).key === j));
    out("listed with archived:true", (rec(await op.request("sessions.list", { agentId: "main", limit: 100, archived: true })).sessions as unknown[]).some((s) => rec(s).key === j));
    out("send to it while archived", await call(op, "chat.send", { sessionKey: j, message: "#text", idempotencyKey: randomUUID() }));
    await sleep(3000);
    out("archived after the send", rec(rec((await call(op, "sessions.describe", { key: j })).result).session).archived);
    out("restore", await patchLifecycle(op, j, { archived: false }));
    out("delete without archivedOnly (write)", await call(op, "sessions.delete", { key: j }));
    out("archive again", await patchLifecycle(op, j, { archived: true }));
    out("delete archivedOnly (write)", await call(op, "sessions.delete", { key: j, archivedOnly: true }));
    out("history after delete", await call(op, "chat.history", { sessionKey: j, limit: 5 }));
    out("describe after delete", await call(op, "sessions.describe", { key: j }));
  },

  async create() {
    const op = await device("a");
    const label = `Weekend plans ${Date.now()}`;
    out("create Juniper's task", await call(op, "sessions.create", { agentId: "main", label }));
    out("create Otto's task with the same label", await call(op, "sessions.create", { agentId: "otto", label }));
    out("create a second Juniper task with the same label", await call(op, "sessions.create", { agentId: "main", label }));
    out("create a task for an agent that does not exist", await call(op, "sessions.create", { agentId: "nobody", label: `${label} x` }));
    const r = rec(rec((await call(op, "sessions.list", { agentId: "otto", limit: 5 })).result).sessions);
    out("sessions.list row keys", Object.keys(rec((r as unknown as unknown[])[0])).sort());
  },

  async stopdevices() {
    const a = await device("a");
    const b = await device("b");
    const stamp = Date.now();
    const j = await newTask(a, "main", `Group stopdev J ${stamp}`);
    const o = await newTask(a, "otto", `Group stopdev O ${stamp}`);
    for (const k of [j, o]) {
      await subscribe(a, k);
      await subscribe(b, k);
    }
    const ra = rec((await call(a, "chat.send", { sessionKey: j, message: "#slow 8", idempotencyKey: randomUUID() })).result);
    const rb = rec((await call(b, "chat.send", { sessionKey: o, message: "#slow 8", idempotencyKey: randomUUID() })).result);
    out("A started Juniper's run, B started Otto's", { a: ra.runId, b: rb.runId });
    await sleep(1500);
    out("A stops Otto's task (B's run)", await call(a, "chat.abort", { sessionKey: o }));
    out("B stops Juniper's task (A's run)", await call(b, "chat.abort", { sessionKey: j }));
    out("A stops Juniper's task (its own run)", await call(a, "chat.abort", { sessionKey: j }));
    out("ends", await ends(a, [String(ra.runId), String(rb.runId)], 60_000));
  },

  async queuedstop() {
    const a = await device("a");
    const b = await device("b");
    const stamp = Date.now();
    const k = await newTask(a, "main", `Group queued ${stamp}`);
    await subscribe(a, k);
    await subscribe(b, k);
    const first = rec((await call(a, "chat.send", { sessionKey: k, message: "#slow 6", idempotencyKey: randomUUID() })).result);
    await sleep(1500);
    const later = rec((await call(b, "chat.send", { sessionKey: k, message: "#text", idempotencyKey: randomUUID() })).result);
    out("A's run, then B's input into the same task", { first, later });
    const pending = rec(rec(await a.request("chat.history", { sessionKey: k, limit: 50 })).pendingInputs);
    out("pendingInputs while A's run is active", { total: pending.total, items: (pending.items as unknown[] | undefined)?.map((i) => Object.keys(rec(i)).sort()) });
    await sleep(500);
    out("A stops the task", await call(a, "chat.abort", { sessionKey: k }));
    out("ends", await ends(a, [String(first.runId), String(later.runId)], 60_000));
    out("history", (await history(a, k)).map((r) => ({ role: r.role, idempotencyKey: r.idempotencyKey, text: r.text.slice(0, 40) })));
    const raw = rec(await a.request("chat.history", { sessionKey: k, limit: 50 }));
    out("steerTargetRunId on user rows", (raw.messages as unknown[]).filter((m) => rec(m).role === "user").map((m) => rec(rec(m).__openclaw).steerTargetRunId ?? null));
    // Same device: a run-specific stop, then a later input.
    const k2 = await newTask(a, "main", `Group queued2 ${stamp}`);
    await subscribe(a, k2);
    const f2 = rec((await call(a, "chat.send", { sessionKey: k2, message: "#slow 6", idempotencyKey: randomUUID() })).result);
    await sleep(1500);
    const l2 = rec((await call(a, "chat.send", { sessionKey: k2, message: "#text", idempotencyKey: randomUUID() })).result);
    out("same device, later input", l2);
    out("A stops only the first run by id", await call(a, "chat.abort", { sessionKey: k2, runId: f2.runId }));
    out("ends", await ends(a, [String(f2.runId), String(l2.runId)], 60_000));
  },

  async cards() {
    const a = await device("a");
    const b = await device("b");
    const r = await device("r", READ, ["tool-events"]);
    const stamp = Date.now();
    const o = await newTask(a, "otto", `Group cards O ${stamp}`);
    const j = await newTask(a, "main", `Group cards J ${stamp}`);
    for (const k of [o, j]) {
      await subscribe(a, k, true);
      await subscribe(b, k, true);
      await subscribe(r, k);
    }
    const seq = { a: a.lastSeq, b: b.lastSeq, r: r.lastSeq };
    await call(a, "chat.send", { sessionKey: o, message: "#approve", idempotencyKey: randomUUID() });
    await call(a, "chat.send", { sessionKey: j, message: "#ask", idempotencyKey: randomUUID() });
    const ask = rec((await a.waitFor("question", (e) => e.event === "question.requested", 60_000, seq.a)).payload);
    const appr = rec((await a.waitFor("approval", (e) => e.event === "exec.approval.requested", 60_000, seq.a)).payload);
    out("question", { id: ask.id, runId: ask.runId ?? rec(ask.request).runId, sessionKey: ask.sessionKey ?? rec(ask.request).sessionKey });
    out("approval", { id: appr.id, runId: rec(appr.request).runId, sessionKey: rec(appr.request).sessionKey });
    await sleep(800);
    const seen = (op: OperatorSession, after: number) => ({
      question: op.events.filter((e) => e.seq > after && e.event === "question.requested").length,
      approval: op.events.filter((e) => e.seq > after && e.event === "exec.approval.requested").length,
    });
    out("events seen", { a: seen(a, seq.a), b: seen(b, seq.b), r: seen(r, seq.r) });
    out("b: question.list", await call(b, "question.list", {}));
    out("b: exec.approval.list", await call(b, "exec.approval.list", {}));
    out("r: question.list", await call(r, "question.list", {}));
    out("b dismisses A's question", await call(b, "question.resolve", { id: ask.id, cancel: true }));
    out("b answers A's approval", await call(b, "exec.approval.resolve", { id: appr.id, decision: "deny" }));
    out("a denies its approval", await call(a, "exec.approval.resolve", { id: appr.id, decision: "deny" }));
  },

  async order() {
    const a = await device("a");
    const stamp = Date.now();
    const j = await newTask(a, "main", `Group order J ${stamp}`);
    const o = await newTask(a, "otto", `Group order O ${stamp}`);
    for (const k of [j, o]) await subscribe(a, k);
    const ro = rec((await call(a, "chat.send", { sessionKey: o, message: "#stream 6", idempotencyKey: randomUUID() })).result);
    await sleep(300);
    const rj = rec((await call(a, "chat.send", { sessionKey: j, message: "#text", idempotencyKey: randomUUID() })).result);
    out("ends, in the order they arrived", (await ends(a, [String(ro.runId), String(rj.runId)], 60_000)).order.map((e) => ({ at: e.at, key: String(e.sessionKey).split(":")[1] })));
    for (const [name, k] of [["Juniper", j], ["Otto", o]] as const) {
      const raw = rec(await a.request("chat.history", { sessionKey: k, limit: 50 }));
      out(`${name} assistant rows`, (raw.messages as unknown[]).filter((m) => rec(m).role === "assistant").map((m) => ({ timestamp: rec(m).timestamp, agentId: rec(m).agentId ?? null })));
    }
  },

  async guard() {
    const a = await device("a");
    const b = await device("b");
    const stamp = Date.now();
    const describe = async (k: string) => rec(rec((await call(a, "sessions.describe", { key: k })).result).session);
    const remove = async (k: string) => {
      const sid = (await describe(k)).sessionId;
      await call(b, "sessions.patch", { key: k, expectedSessionId: sid, archived: true });
      return call(b, "sessions.delete", { key: k, archivedOnly: true });
    };
    // A task with history: is the guard accepted on it, and does it refuse after deletion?
    const k = await newTask(a, "main", `Group guard ${stamp}`);
    await subscribe(a, k);
    const r0 = rec((await call(a, "chat.send", { sessionKey: k, message: "#text", idempotencyKey: randomUUID() })).result);
    await a.terminal(String(r0.runId));
    const sid = String((await describe(k)).sessionId);
    const ok = await call(a, "chat.send", { sessionKey: k, message: "#text", idempotencyKey: randomUUID(), sessionId: sid, expectedLeafEntryId: null });
    out("guarded send to a task with history (sessionId, expectedLeafEntryId null)", ok);
    if (ok.ok) await a.terminal(String(rec(ok.result).runId));
    out("deleted between check and send", await remove(k));
    out("unguarded send to the deleted key", await call(a, "chat.send", { sessionKey: k, message: "#text", idempotencyKey: randomUUID() }));
    await sleep(2500);
    out("session id now at the key (was " + sid + ")", (await describe(k)).sessionId ?? null);
    const k2 = await newTask(a, "main", `Group guard2 ${stamp}`);
    const sid2 = String((await describe(k2)).sessionId);
    await remove(k2);
    out("sessionId alone, after deletion", await call(a, "chat.send", { sessionKey: k2, message: "#text", idempotencyKey: randomUUID(), sessionId: sid2 }));
    await sleep(2500);
    out("session id now (was " + sid2 + ")", (await describe(k2)).sessionId ?? null);
    const k3 = await newTask(a, "main", `Group guard3 ${stamp}`);
    const sid3 = String((await describe(k3)).sessionId);
    await remove(k3);
    out("sessionId and expectedLeafEntryId null, after deletion", await call(a, "chat.send", { sessionKey: k3, message: "#text", idempotencyKey: randomUUID(), sessionId: sid3, expectedLeafEntryId: null }));
    out("session at the key after the refused send", (await describe(k3)).sessionId ?? null);
    const k4 = await newTask(a, "main", `Group guard4 ${stamp}`);
    const sid4 = String((await describe(k4)).sessionId);
    await remove(k4);
    out("the same with queueMode steer, after deletion", await call(a, "chat.send", { sessionKey: k4, message: "#text", idempotencyKey: randomUUID(), sessionId: sid4, expectedLeafEntryId: null, queueMode: "steer" }));
    await sleep(2500);
    out("session id now (was " + sid4 + ")", (await describe(k4)).sessionId ?? null);
    // A running task: does the guarded send (no queueMode) still join it?
    const k5 = await newTask(a, "main", `Group guard5 ${stamp}`);
    await subscribe(a, k5);
    const sid5 = String((await describe(k5)).sessionId);
    const busy = rec((await call(a, "chat.send", { sessionKey: k5, message: "#slow 5", idempotencyKey: randomUUID() })).result);
    await sleep(1500);
    const g5 = await call(a, "chat.send", { sessionKey: k5, message: "#text", idempotencyKey: randomUUID(), sessionId: sid5, expectedLeafEntryId: null });
    out("guarded send while the task runs", g5);
    out("ends", await ends(a, [String(busy.runId), ...(g5.ok ? [String(rec(g5.result).runId)] : [])], 60_000));
  },

  async ownqueued() {
    const a = await device("a");
    const b = await device("b");
    const stamp = Date.now();
    const k = await newTask(a, "main", `Group ownqueued ${stamp}`);
    await subscribe(a, k);
    await subscribe(b, k);
    const first = rec((await call(a, "chat.send", { sessionKey: k, message: "#slow 8", idempotencyKey: randomUUID() })).result);
    await sleep(1500);
    const queued = rec((await call(b, "chat.send", { sessionKey: k, message: "#text", idempotencyKey: randomUUID() })).result);
    out("A's run, then B's input queued behind it", { first: first.runId, queued: queued.runId });
    out("B stops the task (task-wide)", await call(b, "chat.abort", { sessionKey: k }));
    out("ends", await ends(a, [String(first.runId), String(queued.runId)], 60_000));
    // A run-specific request names only its run.
    const k2 = await newTask(a, "main", `Group ownqueued2 ${stamp}`);
    await subscribe(a, k2);
    const f2 = rec((await call(a, "chat.send", { sessionKey: k2, message: "#slow 6", idempotencyKey: randomUUID() })).result);
    await sleep(1500);
    const q2 = rec((await call(a, "chat.send", { sessionKey: k2, message: "#text", idempotencyKey: randomUUID() })).result);
    out("A's run and A's later input", { first: f2.runId, later: q2.runId });
    out("A stops the first run by its id", await call(a, "chat.abort", { sessionKey: k2, runId: f2.runId }));
    out("ends", await ends(a, [String(f2.runId), String(q2.runId)], 60_000));
  },

  async replaced() {
    const a = await device("a");
    const b = await device("b");
    const stamp = Date.now();
    const describe = async (k: string) => rec(rec((await call(a, "sessions.describe", { key: k })).result).session);
    const k = await newTask(a, "main", `Group replaced ${stamp}`);
    await subscribe(a, k);
    const old = String((await describe(k)).sessionId);
    await call(b, "sessions.patch", { key: k, expectedSessionId: old, archived: true });
    await call(b, "sessions.delete", { key: k, archivedOnly: true });
    const r = rec((await call(b, "chat.send", { sessionKey: k, message: "#text", idempotencyKey: randomUUID() })).result);
    await sleep(2500);
    const now = String((await describe(k)).sessionId);
    out("a replacement made at the key", { old, now, run: r.runId });
    const alone = await call(a, "chat.send", { sessionKey: k, message: "#text", idempotencyKey: randomUUID(), sessionId: old });
    out("the old sessionId alone, into the replacement", alone);
    if (alone.ok) out("its end", await ends(a, [String(rec(alone.result).runId)], 60_000));
    out("the old sessionId with expectedLeafEntryId null", await call(a, "chat.send", { sessionKey: k, message: "#text", idempotencyKey: randomUUID(), sessionId: old, expectedLeafEntryId: null }));
    // A member removed from the group record while its run is active.
    const m = await newTask(a, "marlow", `Group removed ${stamp}`);
    const j = await newTask(a, "main", `Group removed J ${stamp}`);
    await subscribe(a, m);
    const key = `clawtrate.group.probe${stamp}`;
    const rec0 = { v: 1, name: "Probe", members: [{ agentId: "main", sessionKey: j }, { agentId: "marlow", sessionKey: m }] };
    await call(a, "users.prefs.set", { entries: { [key]: rec0 }, expectedEntries: { [key]: null } });
    const run = rec((await call(a, "chat.send", { sessionKey: m, message: "#slow 4", idempotencyKey: randomUUID() })).result);
    await sleep(800);
    out("record written without Marlow", await call(a, "users.prefs.set", { entries: { [key]: { ...rec0, members: rec0.members.slice(0, 1) } }, expectedEntries: { [key]: rec0 } }));
    out("Marlow's run after", await ends(a, [String(run.runId)], 60_000));
    out("Marlow's task after", { exists: !!(await describe(m)).sessionId });
    await call(a, "users.prefs.set", { entries: { [key]: null } });
  },

  async delbot() {
    const admin = await device("admin", ADMIN);
    const created = await call(admin, "agents.create", { name: "Probe Wren", workspace: "probe-wren" });
    out("agents.create", created);
    const agentId = String(rec(created.result).agentId ?? rec(rec(created.result).agent).id ?? "");
    if (!agentId) return;
    await sleep(2000);
    const key = await newTask(admin, agentId, `Group delbot ${Date.now()}`);
    out("task", key);
    out("agents.delete", await call(admin, "agents.delete", { agentId }));
    await sleep(2000);
    out("history of its task after", await call(admin, "chat.history", { sessionKey: key, limit: 5 }));
    out("send to its task after", await call(admin, "chat.send", { sessionKey: key, message: "#text", idempotencyKey: randomUUID() }));
    out("sessions.describe after", await call(admin, "sessions.describe", { key }));
  },
};

/** The scripted model's request log, so a probe can say what a bot received. */
function providerLogPath() {
  return path.join(inst.runDir, "provider.log");
}
function providerLogSize() {
  try {
    return readFileSync(providerLogPath(), "utf8").length;
  } catch {
    return 0;
  }
}
function providerUserTurns(from: number) {
  try {
    return readFileSync(providerLogPath(), "utf8").slice(from).split("\n").filter(Boolean).slice(-12).map((l) => l.slice(-600));
  } catch (error) {
    return String(error);
  }
}

const run = experiments[experiment];
if (!run) {
  console.error(`unknown experiment ${experiment}; one of ${Object.keys(experiments).join(", ")}`);
  process.exit(2);
}
try {
  await run();
} finally {
  await cleanup();
}
