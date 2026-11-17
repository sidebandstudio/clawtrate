import { connect, sleep } from "./probe-lib.mjs";
// Can a helper (sessions_spawn) or a bot-to-bot recipient (sessions_send) raise
// an exec approval card, and does stopping the parent cancel it?
//
//   node helper-and-recipient-approvals.mjs helper
//   node helper-and-recipient-approvals.mjs recipient
//   (append "admin" to either to start the parent from an admin device)
//
// The script never reports "no card" from a timed-out wait. For every case it
// prints one of three outcomes, each backed by evidence:
//   CARD     an exec.approval.requested event for the child session arrived;
//   FAILED   the child's own transcript holds an exec toolResult with
//            isError:true, for the exec call the child itself made (quoted);
//   RAN      that exec result has isError:false (it ran; a card may have been
//            raised and resolved before observation, or none was needed);
//   UNKNOWN  none of these before the deadline.
// It resolves only approvals raised in the sessions it created.
const caps = ["tool-events", "approvals", "exec-approvals", "plugin-approvals"];
// Pass "admin" as a second argument to start the parent run from a device that
// also holds operator.admin, to compare how run authority reaches the child.
const withAdmin = process.argv[3] === "admin";
const A = await connect({ name: withAdmin ? "A-admin" : "A", scopes: ["operator.read", "operator.write", "operator.approvals", "operator.questions", ...(withAdmin ? ["operator.admin"] : [])], caps });
const which = process.argv[2];
if (which !== "helper" && which !== "recipient") throw new Error("usage: helper | recipient");

const newSession = async (agentId, label) => {
  const s = await A.call("sessions.create", { agentId, label: `${label} ${Date.now()}` });
  await A.call("sessions.messages.subscribe", { key: s.key, includeApprovals: true });
  return s.key;
};
// The child's own exec call and its result, matched by toolCallId.
const execOutcome = async (sessionKey) => {
  const h = await A.call("chat.history", { sessionKey, limit: 30 });
  const call = h.messages.flatMap((m) => (m.role === "assistant" && Array.isArray(m.content) ? m.content : [])).find((b) => b.type === "toolCall" && b.name === "exec");
  if (!call) return null;
  const row = h.messages.find((m) => m.role === "toolResult" && m.toolCallId === call.id);
  if (!row) return null;
  return { isError: row.isError === true, text: JSON.stringify(row.content).slice(0, 300) };
};

async function observe(childKeyOf, label, deadlineMs = 60_000) {
  const t0 = Date.now();
  let childKey = null;
  while (Date.now() - t0 < deadlineMs) {
    childKey = childKey ?? (await childKeyOf());
    if (childKey) {
      const card = A.events.find((e) => e.t >= t0 && e.event === "exec.approval.requested" && e.payload?.request?.sessionKey === childKey);
      if (card) return { outcome: "CARD", childKey, card };
      const done = await execOutcome(childKey);
      if (done) return { outcome: done.isError ? "FAILED" : "RAN", childKey, error: done.isError ? done.text : undefined };
    }
    await sleep(1000);
  }
  return { outcome: "UNKNOWN", childKey };
}

if (which === "helper") {
  const key = await newSession("atlas", "helper");
  const run = await A.send(key, `#tool sessions_spawn ${JSON.stringify({ task: '#tool exec {"command":"ls /"}' })}`);
  // The child key comes from the spawn tool's own result.
  const childKeyOf = async () => {
    const r = A.events.find((e) => e.event === "agent" && e.payload?.runId === run.runId && e.payload.stream === "tool" && e.payload.data?.phase === "result");
    return r?.payload.data.result?.details?.childSessionKey ?? null;
  };
  const res = await observe(childKeyOf, "helper");
  console.log(`## helper: ${res.outcome}`, JSON.stringify({ childKey: res.childKey, error: res.error, approvalId: res.card?.payload.id }));
  if (res.outcome === "CARD") {
    const abort = await A.call("chat.abort", { sessionKey: key });
    const resolved = await A.waitFor((e) => e.event === "exec.approval.resolved" && e.payload?.id === res.card.payload.id, 15_000).catch(() => null);
    console.log(" abort parent:", JSON.stringify(abort), "| child approval resolved:", resolved ? JSON.stringify({ decision: resolved.payload.decision, resolvedBy: resolved.payload.resolvedBy }) : "not within 15 s");
    if (!resolved) await A.call("exec.approval.resolve", { id: res.card.payload.id, decision: "deny" });
  }
  console.log(" parent run:", (await run.done).state);
}

if (which === "recipient") {
  const sender = await newSession("pixel", "b2b-appr");
  const recipient = await newSession("atlas", "b2b-appr-r");
  const run = await A.send(sender, `#tool sessions_send ${JSON.stringify({ sessionKey: recipient, message: '#tool exec {"command":"ls /"}', timeoutSeconds: 8 })}`, {}, 120_000);
  const res = await observe(async () => recipient, "recipient");
  console.log(`## recipient: ${res.outcome}`, JSON.stringify({ error: res.error, approvalId: res.card?.payload.id }));
  if (res.outcome === "CARD") await A.call("exec.approval.resolve", { id: res.card.payload.id, decision: "deny" });
  const send = await A.waitFor((e) => e.event === "agent" && e.payload?.runId === run.runId && e.payload.stream === "tool" && e.payload.data?.phase === "result", 60_000);
  console.log(" sender tool result:", JSON.stringify(send.payload.data.result?.details).slice(0, 300));
  console.log(" sender run:", (await run.done).state);
}
await A.close();
