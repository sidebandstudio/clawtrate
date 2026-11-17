import { connect, sleep, brief } from "./probe-lib.mjs";
// Routines: create, run now, approval from the run and its standing grant,
// pause, refused run, remove. Prints cron events and the run's session.
// Clear approvals left by earlier probes so they cannot be mistaken for this run's.
const caps = ["tool-events", "approvals", "exec-approvals", "plugin-approvals"];
const A = await connect({ name: "R", scopes: ["operator.read", "operator.write", "operator.admin", "operator.approvals"], caps });
const r = (p, n = 500) => p.then((x) => "ok " + JSON.stringify(x).slice(0, n), (e) => `ERR ${e.gatewayCode ?? ""} ${e.message.slice(0, 200)}`);
for (const a of await A.call("exec.approval.list", {})) await A.call("exec.approval.resolve", { id: a.id, decision: "deny" }).catch(() => {});
const t0 = Date.now();
const add = await A.call("cron.add", { name: "probe routine", agentId: "atlas", schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Paris" }, sessionTarget: "isolated", wakeMode: "now", payload: { kind: "agentTurn", message: '#tool exec {"command":"uname -s"}' } });
const id = add.id ?? add.job?.id;
console.log("cron.add:", JSON.stringify(add).slice(0, 300));
const job = (await A.call("cron.get", { id })).job ?? (await A.call("cron.get", { id }));
console.log("job.state:", JSON.stringify(job.state ?? {}), "nextRunAtMs:", job.nextRunAtMs ?? job.state?.nextRunAtMs, "iso:", new Date(job.state?.nextRunAtMs ?? 0).toISOString());
console.log("cron.status:", await r(A.call("cron.status", {}), 300));
// Run now; answer the approval with allow-always to mint a standing grant.
const runP = A.call("cron.run", { id, mode: "force", waitTimeoutMs: 60000 }, 90000).then((x) => x, (e) => ({ err: e.message }));
let req = null;
for (let i = 0; i < 60 && !req; i++) { req = A.events.find((e) => e.event === "exec.approval.requested" && e.t >= t0) ?? null; if (!req) await sleep(500); }
if (req) {
  console.log("approval from routine:", JSON.stringify({ sessionKey: req.payload.request.sessionKey, agentId: req.payload.request.agentId, scope: req.payload.request.scope, decisions: req.payload.request.allowedDecisions ?? req.payload.allowedDecisions }).slice(0, 400));
  console.log("resolve allow-always:", await r(A.call("exec.approval.resolve", { id: req.payload.id, decision: "allow-always", grantExpiresInDays: 1 })));
}
const run1 = await runP;
for (let i = 0; i < 60 && !A.events.some((e) => e.t >= t0 && e.event === "cron" && e.payload.action === "finished"); i++) await sleep(500);
console.log("cron.run result:", JSON.stringify(run1).slice(0, 400));
console.log("grants.list:", await r(A.call("exec.approval.grants.list", {}), 700));
const t1 = Date.now();
const run2 = await A.call("cron.run", { id, mode: "force", waitTimeoutMs: 60000 }, 90000).catch((e) => ({ err: e.message }));
for (let i = 0; i < 60 && A.events.filter((e) => e.t >= t1 && e.event === "cron" && e.payload.action === "finished").length === 0; i++) await sleep(500);
console.log("second run (grant should apply):", JSON.stringify(run2).slice(0, 250), "| new approval asked:", A.events.some((e) => e.event === "exec.approval.requested" && e.t >= t1));
const runs = await A.call("cron.runs", { id, limit: 5 });
console.log("cron.runs entry keys:", Object.keys((runs.entries ?? runs.runs ?? [])[0] ?? {}).join(","));
const e0 = (runs.entries ?? runs.runs ?? [])[0] ?? {};
console.log("cron.runs[0]:", JSON.stringify({ status: e0.status, sessionKey: e0.sessionKey, runId: e0.runId, usage: e0.usage, model: e0.model, nextRunAtMs: e0.nextRunAtMs }).slice(0, 400));
if (e0.sessionKey) {
  const h = await A.call("chat.history", { sessionKey: e0.sessionKey, limit: 6 }).catch((e) => ({ err: e.message }));
  console.log("run session history:", h.err ?? h.messages.map((m) => `${m.role}:${JSON.stringify(m.content).slice(0, 60)}`).join(" | "));
  const list = await A.call("sessions.list", { limit: 50, agentId: "atlas" });
  const row = list.sessions.find((s) => s.key === e0.sessionKey);
  console.log("in sessions.list:", !!row, row ? JSON.stringify({ label: row.label, kind: row.kind, createdVia: row.createdVia, chatType: row.chatType }) : "");
}
const lc = A.events.find((e) => e.t >= t0 && e.event === "agent" && e.payload?.stream === "lifecycle" && e.payload?.data?.phase === "start" && String(e.payload?.sessionKey ?? "").includes("cron"));
console.log("cron run lifecycle start:", lc ? brief(lc, 400) : "none seen");
const ch = A.events.find((e) => e.t >= t0 && e.event === "chat" && String(e.payload?.sessionKey ?? "").includes("cron"));
console.log("cron run chat keys:", ch ? Object.keys(ch.payload).join(",") : "none");
console.log("pause:", await r(A.call("cron.update", { id, patch: { enabled: false } }), 120));
console.log("run if-enabled while paused:", await r(A.call("cron.run", { id, mode: "if-enabled" }), 300));
console.log("run due while paused:", await r(A.call("cron.run", { id, mode: "due" }), 300));
console.log("remove:", await r(A.call("cron.remove", { id }), 200));
console.log("\ncron events:");
for (const e of A.events.filter((e) => e.t >= t0 && e.event === "cron")) console.log(" ", JSON.stringify({ ...e.payload, job: e.payload.job ? "<job>" : undefined }).slice(0, 330));
for (const g of ((await A.call("exec.approval.grants.list", {})).grants ?? [])) await A.call("exec.approval.grants.revoke", { grantId: g.grantId });
await A.close();
