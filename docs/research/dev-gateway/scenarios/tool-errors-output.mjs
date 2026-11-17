import { connect, sleep } from "./probe-lib.mjs";
import crypto from "node:crypto";
// Approves exactly one exec request per run: the one raised in this run's own
// session for the expected command. Every other pending approval is ignored.
const A = await connect({ name: "A", scopes: ["operator.read", "operator.write", "operator.approvals"], caps: ["tool-events", "approvals", "exec-approvals"] });
async function run(label, cmd) {
  const s = await A.call("sessions.create", { agentId: "atlas", label: `tl ${Date.now()}` });
  await A.call("sessions.messages.subscribe", { key: s.key });
  const t0 = Date.now();
  const r = await A.call("chat.send", { sessionKey: s.key, message: `#tool exec ${JSON.stringify(cmd)}`, idempotencyKey: crypto.randomUUID() });
  let approvedId = null;
  try {
    for (let i = 0; i < 120; i++) {
      const req = approvedId ? null : A.events.find((e) => e.t >= t0 && e.event === "exec.approval.requested" && e.payload?.request?.sessionKey === s.key && String(e.payload?.request?.command ?? "").includes(cmd.command));
      if (req) { approvedId = req.payload.id; await A.call("exec.approval.resolve", { id: approvedId, decision: "allow-once" }).catch(() => {}); }
      if (A.events.some((e) => e.event === "chat" && e.payload?.runId === r.runId && ["final", "error", "aborted"].includes(e.payload.state))) break;
      await sleep(500);
    }
  } finally {
    if (!approvedId) console.log(" (no matching approval request was raised)");
  }
  const seen = A.events.filter((e) => e.t >= t0);
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
try {
  await run("long output", { command: "seq 1 200000" });
} finally {
  await A.close();
}
