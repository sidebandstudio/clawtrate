import { connect, sleep, brief } from "./probe-lib.mjs";
const caps = ["tool-events", "approvals", "exec-approvals", "plugin-approvals"];
const A = await connect({ name: "A", scopes: ["operator.read", "operator.write", "operator.approvals", "operator.questions"], caps });
const r = (p) => p.then((x) => "ok " + JSON.stringify(x).slice(0, 300), (e) => `ERR ${e.gatewayCode ?? ""} ${e.message.slice(0, 250)}`);
const newS = async (agentId, label) => { const s = await A.call("sessions.create", { agentId, label: `${label} ${Date.now()}` }); await A.call("sessions.messages.subscribe", { key: s.key, includeApprovals: true }); return s.key; };
const which = process.argv[2];
if (which === "helper") {
  for (const opts of [{}, { preserveSideRuns: true }]) {
    const key = await newS("atlas", "helper");
    const t0 = Date.now();
    const run = await A.send(key, `#tool sessions_spawn ${JSON.stringify({ task: '#tool exec {"command":"ls /"}' })}`);
    const req = await A.waitFor((e) => e.event === "exec.approval.requested" && e.payload?.request?.command === "ls /" && e.payload?.request?.sessionKey !== key && e.t >= t0, 40000).catch(() => null);
    console.log(`## helper approval, abort parent ${JSON.stringify(opts)}`);
    console.log(" child approval:", req ? JSON.stringify({ id: req.payload.id, sessionKey: req.payload.request.sessionKey, agentId: req.payload.request.agentId }) : "none");
    const sa = A.events.filter((e) => e.event === "session.approval" && e.t >= t0).map((e) => `${e.payload.sessionKey === key ? "parent" : "other"}:${e.payload.phase} src=${e.payload.sourceSessionKey === key ? "parent" : (e.payload.sourceSessionKey ?? "").slice(0, 40)}`);
    console.log(" session.approval on parent subscription:", sa.join(", ") || "none");
    const pf = await Promise.race([run.done, sleep(3000).then(() => "running")]);
    console.log(" parent run before abort:", typeof pf === "string" ? pf : pf.state);
    console.log(" abort parent:", await r(A.call("chat.abort", { sessionKey: key, ...opts })));
    await sleep(3000);
    if (req) {
      const list = await A.call("exec.approval.list", {});
      const still = JSON.stringify(list).includes(req.payload.id);
      const res = A.events.find((e) => e.event === "exec.approval.resolved" && e.payload?.id === req.payload.id);
      console.log(" child approval still listed:", still, "resolved:", res ? JSON.stringify({ decision: res.payload.decision, resolvedBy: res.payload.resolvedBy }) : "none");
      if (still) {
        console.log(" abort child session:", await r(A.call("chat.abort", { sessionKey: req.payload.request.sessionKey })));
        await sleep(2000);
        const res2 = A.events.find((e) => e.event === "exec.approval.resolved" && e.payload?.id === req.payload.id);
        console.log(" after child abort resolved:", res2 ? JSON.stringify({ decision: res2.payload.decision, resolvedBy: res2.payload.resolvedBy }) : "none");
        if (!res2) await r(A.call("exec.approval.resolve", { id: req.payload.id, decision: "deny" }));
      }
    }
  }
}
if (which === "recipient") {
  const pk = await newS("pixel", "b2b-appr"); const ak = await newS("atlas", "b2b-appr-r");
  const t0 = Date.now();
  const run = await A.send(pk, `#tool sessions_send ${JSON.stringify({ sessionKey: ak, message: '#tool exec {"command":"ls /"}', timeoutSeconds: 8 })}`, {}, 120000);
  const req = await A.waitFor((e) => e.event === "exec.approval.requested" && e.payload?.request?.sessionKey === ak, 40000).catch(() => null);
  console.log(" recipient approval:", req ? JSON.stringify({ id: req.payload.id, sessionKey: req.payload.request.sessionKey, agentId: req.payload.request.agentId }).slice(0, 300) : "none");
  const lc = A.events.filter((e) => e.event === "agent" && e.payload?.sessionKey === ak && e.payload?.stream === "lifecycle").map((e) => e.payload.data.phase);
  console.log(" recipient lifecycle so far:", lc.join(" > "));
  const tr = await A.waitFor((e) => e.event === "agent" && e.payload?.sessionKey === pk && e.payload?.stream === "tool" && e.payload?.data?.phase === "result", 60000).catch(() => null);
  console.log(" sender tool result:", tr ? JSON.stringify(tr.payload.data.result?.details).slice(0, 400) : "none");
  if (req) { console.log(" approve:", await r(A.call("exec.approval.resolve", { id: req.payload.id, decision: "allow-once" }))); }
  await sleep(12000);
  const h = await A.call("chat.history", { sessionKey: pk, limit: 20 });
  for (const m of h.messages) console.log("  sender row", m.role, JSON.stringify(m.content).slice(0, 120), m.provenance ? JSON.stringify(m.provenance).slice(0, 120) : "");
  const ha = await A.call("chat.history", { sessionKey: ak, limit: 20 });
  for (const m of ha.messages) console.log("  recipient row", m.role, JSON.stringify(m.content).slice(0, 160));
}
await A.close();
