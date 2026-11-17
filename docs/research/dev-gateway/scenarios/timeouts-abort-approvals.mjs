import { connect, sleep, brief } from "./probe-lib.mjs";
const A = await connect({ name: "A", scopes: ["operator.read", "operator.write", "operator.approvals"], caps: ["tool-events", "approvals", "exec-approvals", "plugin-approvals"] });
const newSession = async (label) => { const s = await A.call("sessions.create", { agentId: "atlas", label: `${label} ${Date.now()}` }); await A.call("sessions.messages.subscribe", { key: s.key, includeApprovals: true }); return s.key; };
const show = (t0, key, pred = () => true) => A.events.filter((e) => e.t >= t0 && (e.payload?.sessionKey === key || e.payload?.request?.sessionKey === key || e.event.startsWith("exec.approval")) && pred(e));
const terminalAndTool = (t0, key) => show(t0, key, (e) => (e.event === "chat" && ["final", "aborted", "error"].includes(e.payload.state)) || (e.event === "agent" && ["tool"].includes(e.payload.stream) && e.payload.data?.phase === "result") || (e.event === "agent" && e.payload.stream === "lifecycle" && ["end", "error"].includes(e.payload.data?.phase)) || e.event.startsWith("exec.approval") || e.event === "session.approval").map((e) => "   " + brief(e, 420)).join("\n");

let key = await newSession("timeout"); let t0 = Date.now();
let r = await A.send(key, '#tool coder__slow_task {"seconds":20}', { timeoutMs: 3000 });
await r.done; await sleep(1500);
console.log("## run timeoutMs 3000 during a 20 s tool\n" + terminalAndTool(t0, key));

key = await newSession("abort-tool"); t0 = Date.now();
r = await A.send(key, '#tool coder__slow_task {"seconds":600}');
await sleep(2000);
console.log("## chat.abort during a 600 s tool:", JSON.stringify(await A.call("chat.abort", { sessionKey: key })));
await r.done; await sleep(1500);
console.log(terminalAndTool(t0, key));
t0 = Date.now(); r = await A.send(key, "after abort"); const f = await r.done;
console.log("   next run in same session:", f.state, JSON.stringify(f.message?.content).slice(0, 60), "after ms", Date.now() - t0);

for (const how of ["new message (default steer)", "new message (interrupt)", "chat.abort", "run timeout"]) {
  key = await newSession("approval"); t0 = Date.now();
  r = await A.send(key, '#tool exec {"command":"ls /"}', how === "run timeout" ? { timeoutMs: 4000 } : {});
  const req = await A.waitFor((e) => e.event === "exec.approval.requested" && e.payload?.request?.sessionKey === key, 30000);
  if (how.startsWith("new message")) await A.send(key, "never mind", how.includes("interrupt") ? { queueMode: "interrupt" } : {});
  if (how === "chat.abort") await A.call("chat.abort", { sessionKey: key });
  await Promise.race([r.done, sleep(20000)]); await sleep(2000);
  const list = await A.call("exec.approval.list", {});
  console.log(`## pending exec approval, then ${how}\n   still listed: ${list.some((a) => a.id === req.payload.id)}\n` + terminalAndTool(t0, key));
  if (list.some((a) => a.id === req.payload.id)) await A.call("exec.approval.resolve", { id: req.payload.id, decision: "deny" });
}
await A.close();
