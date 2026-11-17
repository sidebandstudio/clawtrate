import { connect, sleep, brief } from "./probe-lib.mjs";
const caps = ["tool-events", "approvals", "exec-approvals", "plugin-approvals"];
const A = await connect({ name: "M", scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"], caps });
const nodeId = (await A.call("node.list", {})).nodes[0].nodeId;
const s = await A.call("sessions.create", { agentId: "atlas", label: `mach3 ${Date.now()}`, execNode: nodeId });
await A.call("sessions.patch", { key: s.key, execHost: "node" });
await A.call("sessions.messages.subscribe", { key: s.key, includeApprovals: true });
const t0 = Date.now();
const run = await A.send(s.key, '#tool exec {"command":"uname -s"}');
const stop = Date.now() + 60000;
while (Date.now() < stop) {
  const req = A.events.find((e) => e.t >= t0 && (e.event === "exec.approval.requested"));
  if (req && !req.done) { req.done = true; console.log("approval:", JSON.stringify({ host: req.payload.request.host, node: !!req.payload.request.nodeId, security: req.payload.request.security, ask: req.payload.request.ask })); await A.call("exec.approval.resolve", { id: req.payload.id, decision: "allow-once" }).catch((e) => console.log("resolve err", e.message)); }
  if (A.events.some((e) => e.t >= t0 && e.event === "chat" && e.payload?.runId === run.runId && ["final", "error", "aborted"].includes(e.payload.state))) break;
  await sleep(1000);
}
for (const e of A.events.filter((e) => e.t >= t0 && !["tick", "health", "presence", "sessions.changed", "session.message"].includes(e.event) && !(e.event === "agent" && ["thinking", "assistant"].includes(e.payload?.stream)))) console.log(" ", ((e.t - t0) / 1000).toFixed(1), brief(e, 260));
console.log("abort:", JSON.stringify(await A.call("chat.abort", { sessionKey: s.key })));
await sleep(1500); await A.close();
