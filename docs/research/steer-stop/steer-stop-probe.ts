// Probes behind docs/research/steer-stop.md. Research code, not a check: it
// prints what the gateway said and asserts nothing.
//
//   pnpm dev-gateway start --instance <name>
//   node docs/research/steer-stop/steer-stop-probe.ts <experiment> --instance <name>
//
// It acts only on a named development instance this checkout started, through
// the tool's own operator client (a new paired device, approved by request id
// through the tool's guarded runner, so always with `--profile
// clawtrate-dev-<name>`). It never prints a token, and removes its device
// before it exits. Every experiment works in a new task of Otto's.
//
// Experiments:
//   joined    a steer during a slow tool: what comes under its own run id
//   order     three steers during a slow tool, sent one after another
//   streaming three steers while the reply streams, sent one after another
//   held      a steer while the run waits on an approval; Stop with the run's id
//   withdraw  as held, then chat.abort with the steer's own id, with and
//             without discardPendingInput, then Stop with the run's id
//   stopall   as held, two steers, then chat.abort with no run id
//   followup  as held, a queueMode "followup" send, then Stop with the run's id
//   command   as held, then a typed /stop

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { openInstance } from "../../../tools/dev-gateway/src/cli.ts";
import { provenEndpoint } from "../../../tools/dev-gateway/src/endpoint.ts";
import { readRunRecord } from "../../../tools/dev-gateway/src/state-guard.ts";
import { OperatorSession, type GatewayEvent } from "../../../tools/dev-gateway/src/operator.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { instance: { type: "string" } },
  allowPositionals: true,
});
if (!values.instance) throw new Error("--instance <name> is required; the default instance is never probed");
const inst = openInstance(values.instance);
const initialRun = readRunRecord(inst.runFile);

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v !== null && typeof v === "object" ? (v as Rec) : {});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function endpoint() {
  const proof = provenEndpoint({ instance: inst.name, home: inst.home, runDir: inst.runDir, checkout: inst.checkout });
  if ("refusal" in proof) throw new Error(proof.refusal);
  if (!initialRun || readRunRecord(inst.runFile)?.runId !== initialRun.runId) throw new Error("The named instance restarted during the probe");
  return proof;
}

async function cli(args: string[]): Promise<void> {
  endpoint();
  const result = await inst.runner.run(args);
  if (result.status !== 0) throw new Error(`Development gateway command failed: ${args[0]} ${args[1]}`);
}

const { url, token } = endpoint();
const op = await OperatorSession.open({
  url, token, scopes: ["operator.read", "operator.write", "operator.approvals"], caps: ["tool-events", "approvals"],
  displayName: "Clawtrate steer probe",
  approvePairing: async (requestId) => { await cli(["devices", "approve", requestId]); },
});
const key = `agent:otto:probe-steer-${positionals[0]}-${Date.now()}`;
const t0 = Date.now();
const short = (id: unknown) => String(id ?? "").slice(0, 8);
const names = new Map<string, string>();
const label = (id: unknown) => names.get(String(id)) ?? short(id);

/** One line per event of the task: chat states, lifecycle phases and tool phases. */
function line(e: GatewayEvent): string | null {
  const p = rec(e.payload);
  if (p.sessionKey !== key) return null;
  const at = `${String(e.at - t0).padStart(6)} ms`;
  if (e.event === "chat") {
    const text = JSON.stringify(rec(p.message).content ?? "").slice(0, 50);
    return p.state === "delta" ? null : `${at} chat ${p.state} run=${label(p.runId)} message=${p.message === undefined ? "none" : text}${p.stopReason ? ` stopReason=${p.stopReason}` : ""}`;
  }
  if (e.event === "agent") {
    const d = rec(p.data);
    if (p.stream === "lifecycle") return `${at} lifecycle ${d.phase} run=${label(p.runId)}${d.aborted ? " aborted" : ""}${d.status ? ` status=${d.status}` : ""}`;
    if (p.stream === "tool" && d.phase !== "update") return `${at} tool ${d.phase} ${d.name} run=${label(p.runId)}${d.isError ? " isError" : ""}`;
  }
  return null;
}

async function send(name: string, message: string, extra: Rec = {}): Promise<string> {
  const ack = await op.request("chat.send", { sessionKey: key, message, idempotencyKey: randomUUID(), ...extra });
  const runId = String(ack.runId);
  if (typeof ack.runId === "string") names.set(runId, name);
  const runIds = Array.isArray(ack.runIds) ? { runIds: ack.runIds.map(label) } : {};
  console.log(`${String(Date.now() - t0).padStart(6)} ms chat.send ${name} ${JSON.stringify(extra)} -> ${JSON.stringify({ ...ack, ...runIds, runId: ack.runId && name })}`);
  return runId;
}

async function call(method: string, params: Rec): Promise<void> {
  try {
    const answer = rec(await op.request(method, params));
    const ids = Array.isArray(answer.runIds) ? answer.runIds.map(label) : answer.runIds;
    console.log(`${String(Date.now() - t0).padStart(6)} ms ${method} ${JSON.stringify({ ...params, sessionKey: undefined, message: undefined, idempotencyKey: params.idempotencyKey && label(params.idempotencyKey), runId: params.runId && label(params.runId) })} -> ${JSON.stringify({ ...answer, runIds: ids, ...(answer.runId ? { runId: label(answer.runId) } : {}) })}`);
  } catch (error) {
    console.log(`${method} REFUSED: ${error instanceof Error ? error.message : error}`);
  }
}

/** What chat.history says the gateway holds: pending inputs, receipts for the ids, active runs. */
async function holds(when: string, runIds: string[]): Promise<void> {
  const h = rec(await op.request("chat.history", { sessionKey: key, limit: 20, inputRunIds: runIds }));
  const items = (rec(h.pendingInputs).items as Rec[] | undefined) ?? [];
  const pending = items.map((i) => `${label(i.runId)}:${i.state}${i.queued ? ":queued" : ""}`);
  const receipts = ((h.inputReceipts as Rec[] | undefined) ?? []).map((r) => `${label(r.runId)}:${r.state}${r.cancelled ? ":cancelled" : ""}${r.queued ? ":queued" : ""}`);
  const info = rec(h.sessionInfo);
  const active = Array.isArray(info.activeRunIds) ? JSON.stringify(info.activeRunIds.map(label)) : "absent";
  console.log(`  [${when}] pendingInputs=${JSON.stringify(pending)} inputReceipts=${JSON.stringify(receipts)} status=${info.status} hasActiveRun=${info.hasActiveRun} activeRunIds=${active} inFlightRun=${label(rec(h.inFlightRun).runId) || "none"}`);
}

/** The run record of each id with no wait: the gateway's own word on whether it ended. */
async function records(runIds: string[]): Promise<void> {
  for (const runId of runIds) {
    const r = rec(await op.request("agent.wait", { runId, timeoutMs: 0 }));
    console.log(`  agent.wait ${label(runId)} -> status=${r.status}${r.stopReason ? ` stopReason=${r.stopReason}` : ""}${r.endedAt ? " ended" : ""}`);
  }
}

/** The history rows in order: role, the run id and idempotency key they carry, and their text. */
async function rows(): Promise<void> {
  const h = rec(await op.request("chat.history", { sessionKey: key, limit: 40 }));
  console.log("  history rows:");
  for (const m of (h.messages as Rec[] | undefined) ?? []) {
    const meta = rec(m.__openclaw);
    const content = Array.isArray(m.content) ? (m.content as Rec[]) : [{ type: "text", text: m.content }];
    const text = content.map((b) => b.type === "text" ? JSON.stringify(String(b.text).slice(0, m.role === "toolResult" ? 120 : 40)) : String(b.type)).join(" ");
    const idem = String(meta.idempotencyKey ?? m.idempotencyKey ?? "");
    const idemName = idem ? label(idem.replace(/:user$/, "")) + (idem.endsWith(":user") ? ":user" : "") : "";
    console.log(`    ${String(meta.seq ?? "").padStart(3)} ${m.role} run=${label(meta.runId) || "-"} key=${idemName || "-"} ${meta.openclawAbort ? "openclawAbort " : ""}${text}`);
  }
}

const toolStarted = () => op.waitFor("the slow tool's start", (e) => {
  const p = rec(e.payload);
  return p.sessionKey === key && e.event === "agent" && p.stream === "tool" && rec(p.data).phase === "start";
}, 60_000);

async function idle(): Promise<void> {
  for (let n = 0; n < 120; n += 1) {
    const h = rec(await op.request("chat.history", { sessionKey: key, limit: 1 }));
    const items = ((rec(h.pendingInputs).items as Rec[] | undefined) ?? []).filter((i) => i.state !== "cancelled");
    if (!h.inFlightRun && items.length === 0) return;
    await sleep(500);
  }
  throw new Error("the task did not go idle in 60 s");
}

async function joined(): Promise<void> {
  const run = await send("RUN", "Back up the photos. #slow-tool 8");
  await toolStarted();
  const steer = await send("STEER", "Only the photos from this year.", { queueMode: "steer" });
  await holds("just after the steer's ack", [steer]);
  await op.terminal(steer, 60_000);
  await holds("after the steer's own end", [steer]);
  await records([run, steer]);
  await call("chat.abort", { sessionKey: key, runId: steer });
  await op.terminal(run, 60_000);
  await idle();
  await records([run, steer]);
  await rows();
}

async function order(): Promise<void> {
  const run = await send("RUN", "Back up the photos. #slow-tool 8");
  await toolStarted();
  const steers = [];
  for (const n of [1, 2, 3]) steers.push(await send(`STEER${n}`, `Steer number ${n}.`, { queueMode: "steer" }));
  await holds("after the three acks", steers);
  await op.terminal(run, 60_000);
  await idle();
  await records([run, ...steers]);
  await rows();
}

async function streaming(): Promise<void> {
  const run = await send("RUN", "Look at the disk use. #slow 10");
  await op.waitFor("the run's start", (e) => {
    const p = rec(e.payload);
    return p.sessionKey === key && e.event === "agent" && p.stream === "lifecycle" && rec(p.data).phase === "start";
  });
  const steers = [];
  for (const n of [1, 2, 3]) steers.push(await send(`STEER${n}`, `Steer number ${n}.`, { queueMode: "steer" }));
  await holds("after the three acks", steers);
  await op.terminal(run, 60_000);
  await idle();
  await records([run, ...steers]);
  await rows();
}

async function waiting(): Promise<string> {
  const run = await send("RUN", "#approve");
  await toolStarted();
  await sleep(1_000);
  return run;
}

async function held(): Promise<void> {
  const run = await waiting();
  const steer = await send("STEER", "Only the notes folder.", { queueMode: "steer" });
  await sleep(1_500);
  await holds("steer sent while the approval waits", [steer]);
  await records([run, steer]);
  await call("chat.abort", { sessionKey: key, runId: run });
  await sleep(500);
  await holds("after Stop with the run's id", [steer]);
  await idle();
  await records([run, steer]);
  await rows();
}

async function withdraw(): Promise<void> {
  const run = await waiting();
  const kept = await send("KEPT", "Only the notes folder.", { queueMode: "steer" });
  const cancelled = await send("CANCELLED", "Skip the hidden files.", { queueMode: "steer" });
  const discarded = await send("DISCARDED", "And sort by size.", { queueMode: "steer" });
  await sleep(1_500);
  await holds("three steers while the approval waits", [kept, cancelled, discarded]);
  await call("chat.abort", { sessionKey: key, runId: cancelled });
  await call("chat.abort", { sessionKey: key, runId: discarded, discardPendingInput: true });
  await holds("after withdrawing two", [kept, cancelled, discarded]);
  await records([run, kept, cancelled, discarded]);
  await call("chat.abort", { sessionKey: key, runId: run });
  await idle();
  await holds("idle", [kept, cancelled, discarded]);
  await call("chat.send", { sessionKey: key, message: "Skip the hidden files.", idempotencyKey: cancelled, queueMode: "steer" });
  await sleep(3_000);
  await idle();
  await records([run, kept, cancelled, discarded]);
  await rows();
}

async function stopall(): Promise<void> {
  const run = await waiting();
  const a = await send("STEER1", "Only the notes folder.", { queueMode: "steer" });
  const b = await send("STEER2", "Skip the hidden files.", { queueMode: "steer" });
  await sleep(1_500);
  await holds("two steers while the approval waits", [a, b]);
  await call("chat.abort", { sessionKey: key });
  await sleep(500);
  await holds("after chat.abort with no run id", [a, b]);
  await idle();
  await records([run, a, b]);
  await rows();
}

async function followup(): Promise<void> {
  const run = await waiting();
  const queued = await send("FOLLOWUP", "Then list the notes folder.", { queueMode: "followup" });
  await sleep(1_500);
  await holds("followup sent while the approval waits", [queued]);
  await call("chat.abort", { sessionKey: key, runId: run });
  await idle();
  await records([run, queued]);
  await rows();
}

async function command(): Promise<void> {
  const run = await waiting();
  const steer = await send("STEER", "Only the notes folder.", { queueMode: "steer" });
  await sleep(1_500);
  await holds("steer sent while the approval waits", [steer]);
  await send("STOP", "/stop");
  await sleep(500);
  await holds("after /stop", [steer]);
  await idle();
  await records([run, steer]);
  await rows();
}

const experiments: Record<string, () => Promise<void>> = { joined, order, streaming, held, withdraw, stopall, followup, command };
const experiment = experiments[positionals[0] ?? ""];
try {
  if (!experiment) throw new Error(`experiment must be one of ${Object.keys(experiments).join(", ")}`);
  await op.request("sessions.create", { key, agentId: "otto", label: `Steer probe ${positionals[0]} ${Date.now()}` });
  await op.request("sessions.messages.subscribe", { key });
  await experiment();
  await sleep(3_000);
  console.log("  events:");
  for (const e of op.events) {
    const shown = line(e);
    if (shown) console.log(`    ${shown}`);
  }
} finally {
  await op.close().catch(() => {});
  try {
    await cli(["devices", "remove", op.deviceId]);
  } catch (error) {
    console.error("Could not remove the probe device:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
