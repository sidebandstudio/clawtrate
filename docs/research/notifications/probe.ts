// Probes behind docs/research/notifications.md. Research code, not a check.
//
//   pnpm dev-gateway start --instance <name>
//   node docs/research/notifications/probe.ts <experiment> --instance <name> [...]
//
// It acts only on a named development instance this checkout started, reads
// that instance's address and token from the tool's own run files, and runs
// `openclaw` only through the tool's guarded runner (so always with
// `--profile clawtrate-dev-<name>`). Every line it prints passes through
// `redact`: tokens, this machine's names, its addresses and the home folder
// never reach the output. Each client folder (`--a`, `--b`, `--r`) is kept
// between experiments, so each device pairs once and is reused.
//
// Experiments:
//   pair      --data <dir>: this project's client connects with the shared token
//             and the gateway's own `devices approve <requestId>` approves it
//   upgrade   --data <dir>: the same device asks for the interactive tier,
//             approved the same way
//   two       --a <dir> --b <dir> [--r <dir>] --bot <id> --directive <text>
//             [--answer <a|b>] [--stop <seconds>]: device A starts a task and
//             sends the directive; every device logs the events it receives;
//             each lists pending approvals and questions; B, then A, tries to
//             answer (approve once, or dismiss a question); the run's end is
//             logged on each device
//   prefs     --a <dir> --b <dir> --r <dir>: users.prefs on A, read back on B,
//             users.prefs.changed on B and R, a write from R, the bounds
//   deleted   --a <dir> --bot <id>: a task is created, deleted, then read and
//             listed again by its key; sessions.describe by key before and after
//   missed    --a <dir> --b <dir> --bot <id> --directive <text>: B is away while A
//             sends; B connects afterwards and logs every event it receives, and
//             what it lists

import { mkdirSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { ClawtrateClient } from "../../../packages/core/src/client.ts";
import { createNodeHost } from "../../../packages/core/src/node/index.ts";
import { openInstance, readDevConnection } from "../../../tools/dev-gateway/src/cli.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    instance: { type: "string" },
    data: { type: "string" },
    a: { type: "string" },
    b: { type: "string" },
    r: { type: "string" },
    bot: { type: "string", default: "otto" },
    directive: { type: "string", default: "#approve" },
    answer: { type: "string", default: "b" },
    stop: { type: "string" },
    leave: { type: "boolean", default: false },
    wait: { type: "string", default: "8" },
    tier: { type: "string", default: "interactive" },
    max: { type: "string", default: "1400" },
  },
  allowPositionals: true,
});
const experiment = positionals[0];
if (!values.instance) throw new Error("--instance <name> is required; the default instance is never probed");
const inst = openInstance(values.instance);
const connection = readDevConnection(inst.connectionFile);
if (!connection || connection.instance !== values.instance) throw new Error("no connection record for this instance");
const url = connection.url;

const secrets: string[] = [connection.token];
const machineWords = [hostname(), hostname().split(".")[0]!].filter((w) => w.length >= 3);
const addresses = Object.values(networkInterfaces())
  .flat()
  .map((i) => i?.address)
  .filter((a): a is string => Boolean(a) && a !== "127.0.0.1" && a !== "::1");
const redact = (text: string) => {
  let out = text;
  for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join("<redacted>");
  out = out.split(homedir()).join("~");
  for (const word of machineWords) out = out.split(word).join("<this machine>");
  for (const address of addresses) out = out.split(address).join("<an address>");
  out = out.replace(/("(?:displayName|label|senderName|machineName|hostname)"\s*:\s*")[^"]+/g, "$1<redacted>");
  return out.replace(/("(?:token|deviceToken|bootstrapToken|publicKey)"\s*:\s*")[^"]+/g, "$1<redacted>");
};
const max = Number(values.max);
const say = (...parts: unknown[]) => {
  const line = redact(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
  console.log(line.length > max ? `${line.slice(0, max)} …(${line.length} chars)` : line);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runOpenclaw(args: string[]) {
  const result = inst.runner.runSync(args);
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function coreClient(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return new ClawtrateClient(
    createNodeHost({
      dataDir: dir,
      client: { displayName: "Clawtrate Desktop", version: "0.0.0-research", platform: process.platform },
    }),
    { reconnect: { initialMs: 500, maxMs: 2000 } },
  );
}

async function settle(done: () => boolean, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !done()) await sleep(100);
}

type Request = (m: string, p: unknown) => Promise<unknown>;
type Seen = { name: string; at: number; payload: Record<string, unknown> };

const QUIET = new Set(["tick", "health", "presence", "heartbeat", "node.hostStats", "chat.send_timing"]);

async function device(dir: string, label: string) {
  const client = coreClient(dir);
  const seen: Seen[] = [];
  const target = client as unknown as { handleEvent(e: { event: string; payload?: unknown }, g: number): void };
  const original = target.handleEvent.bind(client);
  target.handleEvent = (event, generation) => {
    if (!QUIET.has(event.event)) {
      seen.push({ name: event.event, at: Date.now(), payload: (event.payload ?? {}) as Record<string, unknown> });
    }
    original(event, generation);
  };
  await client.start();
  await settle(() => client.state.connection.status === "connected");
  if (client.state.connection.status !== "connected") throw new Error(`${label} not connected`);
  const request = (client as unknown as { request: Request }).request.bind(client);
  say(`${label}: connected with`, client.state.connection.scopes);
  return { label, client, request, seen };
}
type Device = Awaited<ReturnType<typeof device>>;

async function attempt(request: Request, method: string, params: unknown) {
  try {
    return { ok: true, result: await request(method, params) };
  } catch (error) {
    const e = error as Error & { code?: string; details?: unknown };
    return { ok: false, error: { code: e.code, message: e.message } };
  }
}

/** One line per event, reduced to what the note needs. */
function brief(e: Seen) {
  const p = e.payload;
  const data = (p.data ?? {}) as Record<string, unknown>;
  const request = (p.request ?? {}) as Record<string, unknown>;
  const message = p.message as { content?: unknown } | undefined;
  let text: string | undefined;
  if (message && Array.isArray(message.content)) {
    text = message.content.map((c) => (c as { text?: string }).text ?? "").join(" ").slice(0, 60);
  }
  return {
    event: e.name,
    ...(p.sessionKey ? { sessionKey: p.sessionKey } : {}),
    ...(request.sessionKey ? { requestSession: request.sessionKey } : {}),
    ...(p.stream ? { stream: p.stream } : {}),
    ...(data.name ? { tool: data.name } : {}),
    ...(data.phase ? { phase: data.phase } : {}),
    ...(data.stopReason ? { stopReason: data.stopReason } : {}),
    ...(data.status ? { status: data.status } : {}),
    ...(p.state ? { state: p.state } : {}),
    ...(p.errorKind ? { errorKind: p.errorKind } : {}),
    ...(p.id ? { id: String(p.id).slice(0, 12) } : {}),
    ...(p.decision ? { decision: p.decision } : {}),
    ...(p.status && typeof p.status === "string" ? { recordStatus: p.status } : {}),
    ...(p.keys ? { keys: p.keys } : {}),
    ...(text !== undefined ? { text } : {}),
  };
}

function report(d: Device, key: string, since: number) {
  const mine = d.seen.filter((e) => e.at >= since);
  const counts: Record<string, number> = {};
  for (const e of mine) counts[e.name] = (counts[e.name] ?? 0) + 1;
  say(`${d.label} events since the send:`, counts);
  const interesting = mine.filter((e) => {
    if (e.name === "agent") {
      const stream = e.payload.stream;
      return stream === "lifecycle" || stream === "error";
    }
    if (e.name === "chat") return e.payload.state !== "delta";
    if (e.name === "sessions.changed") return false;
    return true;
  });
  for (const e of interesting) say(`  ${d.label}:`, brief(e));
  const rows = mine.filter((e) => e.name === "sessions.changed" && JSON.stringify(e.payload).includes(key));
  if (rows.length) {
    const last = rows.at(-1)!.payload;
    const row = (Array.isArray(last.sessions) ? (last.sessions as Record<string, unknown>[]).find((s) => s.key === key) : last) ?? last;
    say(`  ${d.label}: last sessions.changed naming the task, fields:`, Object.keys(row as object));
    const r = row as Record<string, unknown>;
    say(`  ${d.label}: status fields:`, {
      status: r.status,
      runStatus: r.runStatus,
      hasActiveRun: r.hasActiveRun,
      waiting: r.waiting,
      pendingApprovals: r.pendingApprovals,
      pendingQuestions: r.pendingQuestions,
      unread: r.unread,
      reason: r.reason,
      agentStatus: r.agentStatus,
      activitySummary: r.activitySummary,
    });
  }
}

async function pendingFor(d: Device, key: string) {
  const exec = await attempt(d.request, "exec.approval.list", {});
  const questions = await attempt(d.request, "question.list", {});
  const execIds = exec.ok
    ? ((exec.result as Record<string, unknown>[] | { approvals?: Record<string, unknown>[] }) as unknown as Record<string, unknown>[])
    : [];
  const list = Array.isArray(execIds) ? execIds : ((exec.result as { approvals?: Record<string, unknown>[] })?.approvals ?? []);
  const approvals = list.filter((a) => JSON.stringify(a).includes(key)).map((a) => String(a.id));
  const qResult = questions.ok ? (questions.result as { questions?: Record<string, unknown>[] }) : null;
  const qs = (qResult?.questions ?? []).filter((q) => JSON.stringify(q).includes(key) && q.status === "pending").map((q) => String(q.id));
  say(`${d.label} lists:`, {
    "exec.approval.list": exec.ok ? { forThisTask: approvals.length } : exec.error,
    "question.list": questions.ok ? { pendingForThisTask: qs.length } : questions.error,
  });
  return { approvals, questions: qs };
}

async function two() {
  if (!values.a || !values.b) throw new Error("--a and --b are required");
  const A = await device(values.a, "A");
  const B = await device(values.b, "B");
  const R = values.r ? await device(values.r, "R (read-only)") : null;
  let all = [A, B, ...(R ? [R] : [])];
  const created = await attempt(A.request, "sessions.create", { agentId: values.bot, idempotencyKey: randomUUID() });
  const key = (created.result as { key?: string })?.key;
  if (!key) throw new Error(`no task: ${JSON.stringify(created)}`);
  say(`A created a task with ${values.bot}:`, key);
  const since = Date.now();
  const send = await attempt(A.request, "chat.send", {
    sessionKey: key,
    message: values.directive,
    idempotencyKey: randomUUID(),
    queueMode: "followup",
  });
  say(`A sent ${values.directive}:`, send.ok ? { ok: true, runId: (send.result as { runId?: string })?.runId } : send.error);
  if (values.leave) {
    await sleep(3000);
    say("A disconnects (its client stops) while the run waits");
    A.client.stop();
  }
  if (values.stop) {
    await sleep(Number(values.stop) * 1000);
    const runId = (send.result as { runId?: string })?.runId;
    say("A stops the run (chat.abort):", await attempt(A.request, "chat.abort", { sessionKey: key, runId }));
  }
  await sleep(Number(values.wait) * 1000);
  say("— while it waits, or once it ended —");
  if (values.leave) all = all.filter((d) => d !== A);
  for (const d of all) report(d, key, since);
  const pending = new Map<string, { approvals: string[]; questions: string[] }>();
  for (const d of all) pending.set(d.label, await pendingFor(d, key));
  const ids = pending.get("A") ?? pending.get("B")!;
  const order = values.answer === "a" ? [A] : values.leave ? [B] : [B, A];
  for (const d of order) {
    for (const id of ids.approvals) {
      say(`${d.label} exec.approval.resolve allow-once ${id.slice(0, 8)}:`, await attempt(d.request, "exec.approval.resolve", { id, decision: "allow-once" }));
    }
    for (const id of ids.questions) {
      say(`${d.label} question.resolve cancel ${id.slice(0, 12)}:`, await attempt(d.request, "question.resolve", { id, cancel: true }));
    }
  }
  const after = Date.now();
  await sleep(Number(values.wait) * 1000);
  say("— after the answers —");
  for (const d of all) report(d, key, after);
  const listed = await attempt(B.request, "sessions.list", { limit: 200 });
  const row = ((listed.result as { sessions?: Record<string, unknown>[] })?.sessions ?? []).find((s) => s.key === key);
  say("B sessions.list row for the task, fields:", row ? Object.keys(row) : "not listed");
  if (row) say("B sessions.list row status:", { status: row.status, hasActiveRun: row.hasActiveRun, unread: row.unread, lastMessagePreview: typeof row.lastMessagePreview === "string" ? row.lastMessagePreview.slice(0, 60) : row.lastMessagePreview });
  if (values.leave) {
    const a2 = await device(values.a, "A again");
    await pendingFor(a2, key);
    say("A again lists, then the task's state:", ((await attempt(a2.request, "sessions.list", { limit: 200 })).result as { sessions?: Record<string, unknown>[] })?.sessions?.find((s) => s.key === key)?.status);
    a2.client.stop();
  }
  for (const d of all) d.client.stop();
}

async function prefs() {
  if (!values.a || !values.b || !values.r) throw new Error("--a, --b and --r are required");
  const A = await device(values.a, "A");
  const B = await device(values.b, "B");
  const R = await device(values.r, "R (read-only)");
  const KEY = "clawtrate.notifications.probe";
  const value = {
    version: 1,
    bots: { otto: false },
    tasks: { "agent:otto:example": "on" },
    quiet: { enabled: true, startMinute: 1320, endMinute: 420, timeZone: "Europe/Lisbon" },
  };
  say("A users.self:", await attempt(A.request, "users.self", {}));
  say("A users.prefs.get:", await attempt(A.request, "users.prefs.get", { keys: [KEY, "notifications.web.v1"] }));
  const since = Date.now();
  say("A users.prefs.set:", await attempt(A.request, "users.prefs.set", { entries: { [KEY]: value } }));
  await sleep(1500);
  for (const d of [B, R]) {
    const got = d.seen.filter((e) => e.at >= since && e.name === "users.prefs.changed").map((e) => e.payload.keys);
    say(`${d.label} users.prefs.changed:`, got);
    say(`${d.label} users.prefs.get:`, await attempt(d.request, "users.prefs.get", { keys: [KEY] }));
  }
  say("R users.prefs.set:", await attempt(R.request, "users.prefs.set", { entries: { [KEY]: value } }));
  say("A set with a stale expectedEntries:", await attempt(A.request, "users.prefs.set", {
    entries: { [KEY]: { ...value, bots: {} } },
    expectedEntries: { [KEY]: { stale: true } },
  }));
  say("A set with the current expectedEntries:", await attempt(A.request, "users.prefs.set", {
    entries: { [KEY]: { ...value, bots: { otto: true } } },
    expectedEntries: { [KEY]: value },
  }));
  const big = { pad: "x".repeat(4100) };
  say("A set a value over 4096 bytes:", await attempt(A.request, "users.prefs.set", { entries: { [KEY]: big } }));
  const fits = { pad: "x".repeat(4096 - 12) };
  say(`A set a value of ${JSON.stringify(fits).length} bytes:`, await attempt(A.request, "users.prefs.set", { entries: { [KEY]: fits } }));
  say("A removes it (null):", await attempt(A.request, "users.prefs.set", { entries: { [KEY]: null } }));
  say("A users.prefs.get after:", await attempt(A.request, "users.prefs.get", { keys: [KEY] }));
  for (const d of [A, B, R]) d.client.stop();
}

async function deleted() {
  if (!values.a) throw new Error("--a is required");
  const A = await device(values.a, "A");
  const created = await attempt(A.request, "sessions.create", { agentId: values.bot, idempotencyKey: randomUUID() });
  const key = (created.result as { key?: string })?.key;
  if (!key) throw new Error("no task");
  say("created:", key);
  say("sessions.describe before:", ((await attempt(A.request, "sessions.describe", { key })).result as { session?: unknown })?.session ? "session" : "null");
  say("sessions.delete:", await attempt(A.request, "sessions.delete", { key }));
  await sleep(1500);
  const listed = await attempt(A.request, "sessions.list", { limit: 200 });
  const row = ((listed.result as { sessions?: Record<string, unknown>[] })?.sessions ?? []).find((s) => s.key === key);
  say("listed after delete:", row ? "yes" : "no");
  const history = await attempt(A.request, "chat.history", { sessionKey: key, limit: 5 });
  const h = history.result as { messages?: unknown[]; sessionInfo?: unknown } | undefined;
  say("chat.history after delete:", history.ok ? { ok: true, messages: h?.messages?.length, sessionInfo: Boolean(h?.sessionInfo) } : history.error);
  const changed = A.seen.filter((e) => e.name === "sessions.changed" && JSON.stringify(e.payload).includes(key)).map((e) => e.payload.reason);
  say("sessions.changed reasons naming the task:", changed);
  const described = await attempt(A.request, "sessions.describe", { key });
  say("sessions.describe after:", described.ok ? ((described.result as { session?: unknown }).session ? "session" : "session: null") : described.error);
  say("sessions.list once more:", ((await attempt(A.request, "sessions.list", { limit: 200 })).result as { sessions?: { key: string }[] })?.sessions?.some((s) => s.key === key) ? "listed" : "not listed");
  A.client.stop();
}

async function pair() {
  if (!values.data) throw new Error("--data is required");
  const client = coreClient(values.data);
  await client.start();
  await client.connect({ url, token: connection!.token });
  await settle(() => ["connected", "pairing", "error"].includes(client.state.connection.status));
  const requestId = client.state.connection.pairing?.requestId;
  if (requestId) {
    const approved = runOpenclaw(["devices", "approve", requestId]);
    say(`devices approve <request>: exit ${approved.status}`);
    await settle(() => client.state.connection.status === "connected", 20_000);
  }
  say("paired:", { status: client.state.connection.status, scopes: client.state.connection.scopes });
  client.stop();
}

async function upgrade() {
  if (!values.data) throw new Error("--data is required");
  const client = coreClient(values.data);
  await client.start();
  await settle(() => client.state.connection.status === "connected");
  const tier = values.tier === "admin" ? "admin" : "interactive";
  const asked = client.requestAccess(tier).catch((e: unknown) => say("requestAccess:", String(e)));
  await settle(() => !["idle", "requesting"].includes(client.state.connection.upgrade.status), 10_000);
  const requestId = client.state.connection.upgrade.requestId;
  if (requestId) {
    const approved = runOpenclaw(["devices", "approve", requestId]);
    say(`devices approve <request>: exit ${approved.status}`);
    await settle(() => (tier === "admin" ? client.state.connection.canAdmin : client.state.connection.canWrite), 20_000);
    await sleep(1500);
  }
  say("after approval:", client.state.connection.scopes);
  void asked;
  client.stop();
}

async function missed() {
  if (!values.a || !values.b) throw new Error("--a and --b are required");
  const A = await device(values.a, "A");
  const created = await attempt(A.request, "sessions.create", { agentId: values.bot, idempotencyKey: randomUUID() });
  const key = (created.result as { key?: string })?.key;
  if (!key) throw new Error("no task");
  say(`A created a task with ${values.bot}; B is not connected`);
  say(`A sent ${values.directive}:`, (await attempt(A.request, "chat.send", { sessionKey: key, message: values.directive, idempotencyKey: randomUUID(), queueMode: "followup" })).ok);
  await sleep(Number(values.wait) * 1000);
  const since = Date.now();
  const B = await device(values.b, "B (connects after the run)");
  await sleep(6000);
  const events = B.seen.filter((e) => e.at >= since && JSON.stringify(e.payload).includes(key)).map((e) => `${e.name}${e.payload.stream ? `:${(e.payload.data as { phase?: string })?.phase ?? e.payload.stream}` : ""}${e.payload.state ? `:${e.payload.state}` : ""}`);
  say("B events naming the task after it connected:", events);
  await pendingFor(B, key);
  const listed = await attempt(B.request, "sessions.list", { limit: 200 });
  const row = ((listed.result as { sessions?: Record<string, unknown>[] })?.sessions ?? []).find((s) => s.key === key);
  say("B sessions.list row:", row ? { status: row.status, unread: row.unread } : "not listed");
  const history = await attempt(B.request, "chat.history", { sessionKey: key, limit: 10 });
  say("B chat.history messages:", history.ok ? ((history.result as { messages?: unknown[] }).messages ?? []).length : history.error);
  for (const d of [A, B]) d.client.stop();
}

const experiments: Record<string, () => Promise<void>> = { pair, upgrade, two, prefs, deleted, missed };
const run = experiment ? experiments[experiment] : undefined;
if (!run) throw new Error(`experiment: one of ${Object.keys(experiments).join(", ")}`);
await run();
process.exit(0);
