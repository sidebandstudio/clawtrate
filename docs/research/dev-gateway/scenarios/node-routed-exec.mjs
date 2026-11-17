import { connect, sleep, brief } from "./probe-lib.mjs";
// Routes one task's exec to the fixture node (PROBE_NODE_NAME, see
// node-pairing-hoststats.mjs) with the admin fields sessions.create {execNode}
// and sessions.patch {execHost:"node"}, then runs `pwd` so the output shows the
// working directory the node used when no workdir or execCwd is given.
// Only an approval raised in this task's own session is allowed.
const NAME = process.env.PROBE_NODE_NAME;
if (!NAME) throw new Error("set PROBE_NODE_NAME to the fixture node's --display-name");
const caps = ["tool-events", "approvals", "exec-approvals", "plugin-approvals"];
const A = await connect({ name: "M", scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"], caps });
const matches = (await A.call("node.list", {})).nodes.filter((n) => n.displayName === NAME && n.connected);
if (matches.length !== 1) throw new Error(`expected exactly one connected node named ${NAME}, found ${matches.length}`);
const nodeId = matches[0].nodeId;
const s = await A.call("sessions.create", { agentId: "atlas", label: `mach3 ${Date.now()}`, execNode: nodeId });
await A.call("sessions.patch", { key: s.key, execHost: "node" });
await A.call("sessions.messages.subscribe", { key: s.key, includeApprovals: true });
const t0 = Date.now();
const run = await A.send(s.key, '#tool exec {"command":"pwd"}');
// pwd may run without approval (allowlisted read-only command), so approve
// only if this task's own approval arrives before the run ends.
let approved = false;
for (let i = 0; i < 120; i++) {
  const req = approved ? null : A.events.find((e) => e.t >= t0 && e.event === "exec.approval.requested" && e.payload?.request?.sessionKey === s.key);
  if (req) {
    approved = true;
    console.log("approval:", JSON.stringify({ host: req.payload.request.host, nodeId: req.payload.request.nodeId === nodeId ? "fixture" : req.payload.request.nodeId, command: req.payload.request.command }));
    await A.call("exec.approval.resolve", { id: req.payload.id, decision: "allow-once" });
  }
  if (A.events.some((e) => e.event === "chat" && e.payload?.runId === run.runId && ["final", "error", "aborted"].includes(e.payload.state))) break;
  await sleep(500);
}
if (!approved) console.log("no approval was requested for this task's pwd");
const fin = await run.done;
const out = A.events.find((e) => e.t >= t0 && e.event === "agent" && e.payload?.runId === run.runId && e.payload.stream === "command_output" && e.payload.data?.phase === "end");
console.log("run:", fin.state, "| pwd output:", JSON.stringify(out?.payload.data.output ?? null), "| exitCode:", out?.payload.data.exitCode);
await A.close();
