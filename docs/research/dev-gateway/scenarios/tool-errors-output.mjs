import { connect, sleep } from "./probe-lib.mjs";
import crypto from "node:crypto";const A = await connect({ name: "A", scopes: ["operator.read", "operator.write", "operator.approvals"], caps: ["tool-events", "approvals", "exec-approvals"] });
A.events; const approve = (e) => { if (e.event === "exec.approval.requested") A.call("exec.approval.resolve", { id: e.payload.id, decision: "allow-once" }).catch(() => {}); };
setInterval(() => { for (const e of A.events.splice(0)) { approve(e); seen.push(e); } }, 100);
const seen = [];
async function run(label, cmd) {
  const s = await A.call("sessions.create", { agentId: "atlas", label: `tl ${Date.now()}` });
  await A.call("sessions.messages.subscribe", { key: s.key });
  const r = await A.call("chat.send", { sessionKey: s.key, message: `#tool exec ${JSON.stringify(cmd)}`, idempotencyKey: crypto.randomUUID() });
  for (let i = 0; i < 120; i++) { if (seen.some((e) => e.event === "chat" && e.payload?.runId === r.runId && ["final","error","aborted"].includes(e.payload.state))) break; await sleep(500); }
  const res = seen.find((e) => e.event === "agent" && e.payload?.runId === r.runId && e.payload.stream === "tool" && e.payload.data?.phase === "result");
  const outs = seen.filter((e) => e.event === "agent" && e.payload?.runId === r.runId && e.payload.stream === "command_output");
  const text = res?.payload.data.result?.content?.[0]?.text ?? "";
  console.log(`\n## ${label}\n isError=${res?.payload.data.isError} details=${JSON.stringify({ ...res?.payload.data.result?.details, aggregated: undefined, tail: undefined })}\n event text length ${text.length}, head ${JSON.stringify(text.slice(0, 60))}, tail ${JSON.stringify(text.slice(-90))}\n command_output events ${outs.length}, last output length ${outs.at(-1)?.payload.data.output?.length}`);
  const h = await A.call("chat.history", { sessionKey: s.key, limit: 10 });
  const tr = h.messages.find((m) => m.role === "toolResult");
  const ht = tr?.content?.[0]?.text ?? "";
  console.log(` history toolResult text length ${ht.length}, tail ${JSON.stringify(ht.slice(-80))}, __openclaw keys ${Object.keys(tr?.__openclaw ?? {}).join(",")}`);
  if (tr?.__openclaw?.id) { const full = await A.call("chat.message.get", { sessionKey: s.key, messageId: tr.__openclaw.id, maxChars: 2000000 }).catch((e) => ({ err: e.message })); console.log(` chat.message.get length ${full.message?.content?.[0]?.text?.length ?? JSON.stringify(full).slice(0, 120)}`); }
}
await run("exec exceeding its own timeout", { command: "sleep 5", timeoutSeconds: 1 });
await run("exec failing", { command: "ls /definitely-missing" });
await run("long output", { command: "seq 1 200000" });
process.exit(0);
