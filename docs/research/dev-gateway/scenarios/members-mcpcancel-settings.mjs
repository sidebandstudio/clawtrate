import { connect, sleep, brief } from "./probe-lib.mjs";
import crypto from "node:crypto";
const caps = ["tool-events", "approvals", "exec-approvals", "plugin-approvals"];
const A = await connect({ name: "A", scopes: ["operator.read", "operator.write", "operator.approvals", "operator.questions"], caps });
const ADM = await connect({ backend: true, scopes: ["operator.read", "operator.write", "operator.admin", "operator.approvals"], caps });
const r = (p) => p.then((x) => "ok " + JSON.stringify(x).slice(0, 300), (e) => `ERR ${e.gatewayCode ?? ""} ${e.message.slice(0, 250)}`);
const newS = async (agentId, label) => { const s = await A.call("sessions.create", { agentId, label: `${label} ${Date.now()}` }); await A.call("sessions.messages.subscribe", { key: s.key, includeApprovals: true }); return s.key; };
const pending = async () => (await A.call("exec.approval.list", {})).approvals ?? (await A.call("exec.approval.list", {}));
const which = process.argv[2];

if (which === "members") {
  const key = await newS("atlas", "members");
  console.log("members.list:", await r(A.call("session.members.list", { sessionKey: key })));
  for (const id of ["pixel", "agent:pixel"]) console.log(`members.add ${id}:`, await r(A.call("session.members.add", { sessionKey: key, identityId: id })));
  console.log("chat.send atlas key with agentId pixel:", await r(A.call("chat.send", { sessionKey: key, agentId: "pixel", message: "hi", idempotencyKey: crypto.randomUUID() })));
  console.log("users.mentionable:", await r(A.call("users.mentionable", {})));
}
if (which === "mcpcancel") {
  const key = await newS("atlas", "mcpcancel");
  const run = await A.send(key, '#tool coder__slow_task {"seconds":600}');
  await A.waitFor((e) => e.event === "agent" && e.payload?.runId === run.runId && e.payload?.stream === "tool" && e.payload?.data?.phase === "start");
  await sleep(1500);
  console.log("abort:", await r(A.call("chat.abort", { sessionKey: key })));
  await run.done.catch(() => {});
  await sleep(1500);
  const q = await A.send(key, "#tool coder__received_notifications {}");
  const f = await q.done;
  console.log("received:", JSON.stringify(f.message?.content).slice(0, 900));
}
if (which === "settings") {
  for (const change of (process.argv[3] ?? "permissionMode,configFull").split(",")) {
    const key = await newS("atlas", "settings");
    const run = await A.send(key, '#tool exec {"command":"ls /"}');
    const req = await A.waitFor((e) => e.event === "exec.approval.requested" && e.payload?.request?.command === "ls /" && e.payload?.request?.sessionKey === key, 30000);
    const id = req.payload.id;
    let res;
    if (change === "permissionMode") res = await r(A.call("sessions.patch", { key, permissionMode: "guarded" }));
    if (change === "sessionsPatchExecAsk") res = await r(ADM.call("sessions.patch", { key, execAsk: "off", execSecurity: "full" }));
    if (change === "configFull") { const c = await ADM.call("config.get", {}); res = await r(ADM.call("config.patch", { raw: JSON.stringify({ agents: { entries: { atlas: { tools: { exec: { mode: "full" } } } } } }), baseHash: c.hash })); }
    await sleep(4000);
    const list = await A.call("exec.approval.list", {});
    const still = JSON.stringify(list).includes(id);
    const resolved = A.events.find((e) => e.event === "exec.approval.resolved" && e.payload?.id === id);
    console.log(`## ${change}: change=${res}\n still listed: ${still}; resolved event: ${resolved ? JSON.stringify(resolved.payload).slice(0, 300) : "none"}`);
    if (still) await r(A.call("exec.approval.resolve", { id, decision: "deny" }));
    const f = await run.done.catch((e) => ({ state: "?" + e.message }));
    console.log(" run:", f.state, f.errorMessage ?? "");
    if (change === "configFull") { const c = await ADM.call("config.get", {}); await ADM.call("config.patch", { raw: JSON.stringify({ agents: { entries: { atlas: { tools: { exec: null } } } } }), baseHash: c.hash }); await sleep(2000); }
  }
}
await A.close(); await ADM.close();
