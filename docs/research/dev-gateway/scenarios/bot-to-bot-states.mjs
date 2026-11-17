import { connect, sleep, brief } from "./probe-lib.mjs";
const A = await connect({ name: "A", scopes: ["operator.read", "operator.write", "operator.approvals", "operator.questions"], caps: ["tool-events", "approvals", "exec-approvals"] });
const text = (m) => (Array.isArray(m?.content) ? m.content.map((p) => p.text ?? (p.type === "toolCall" ? `[toolCall ${p.name}]` : "")).join("") : String(m?.content ?? ""));
async function scenario(label, recipientMsg, sendArgs, during = async () => {}, watchMs = 12000) {
  const atl = await A.call("sessions.create", { agentId: "atlas", label: `b2b-r ${label} ${Date.now()}` });
  const pix = await A.call("sessions.create", { agentId: "pixel", label: `b2b-s ${label} ${Date.now()}` });
  for (const k of [atl.key, pix.key]) await A.call("sessions.messages.subscribe", { key: k, includeApprovals: true });
  const t0 = Date.now();
  const r = await A.send(pix.key, `#tool sessions_send ${JSON.stringify({ sessionKey: atl.key, message: recipientMsg, ...sendArgs })}`, {}, 120000);
  await during(atl.key, pix.key, t0);
  await r.done.catch(() => {});
  await sleep(watchMs);
  const res = A.events.find((e) => e.t >= t0 && e.event === "agent" && e.payload?.runId === r.runId && e.payload.stream === "tool" && e.payload.data?.phase === "result" && e.payload.data.name === "sessions_send");
  console.log(`\n## ${label}\n sessions_send details: ${JSON.stringify(res?.payload.data.result?.details).slice(0, 300)}`);
  const pixRuns = [...new Set(A.events.filter((e) => e.t >= t0 && e.payload?.sessionKey === pix.key && e.event === "chat" && ["final", "error", "aborted"].includes(e.payload.state)).map((e) => `${e.payload.runId.slice(0, 8)}:${e.payload.state}`))];
  console.log(" sender runs:", pixRuns.join(", "));
  const other = A.events.filter((e) => e.t >= t0 && (e.event.startsWith("question.") || e.event.startsWith("exec.approval") || e.event === "session.approval")).map((e) => `${e.event} session=${(e.payload?.sessionKey ?? e.payload?.request?.sessionKey ?? "").slice(6, 20)} src=${(e.payload?.sourceSessionKey ?? "").slice(6, 20)} status=${e.payload?.status ?? e.payload?.phase ?? e.payload?.approval?.status ?? ""}`);
  if (other.length) console.log(" approvals/questions:", [...new Set(other)].join(" | "));
  const h = await A.call("chat.history", { sessionKey: pix.key, limit: 30 });
  for (const m of h.messages) console.log("  sender row", m.role, JSON.stringify(text(m)).slice(0, 110), "prov:", JSON.stringify(m.provenance ?? m.__openclaw?.provenance ?? "").slice(0, 160));
  const ah = await A.call("chat.history", { sessionKey: atl.key, limit: 5 });
  const u = ah.messages.find((m) => m.role === "user");
  if (u) console.log("  recipient user row prov:", JSON.stringify(u.provenance ?? "").slice(0, 300));
  return { atl, pix, r };
}
await scenario("ok", "hello there", { timeoutSeconds: 30 }, undefined, 3000);
await scenario("fire-and-forget", "#slow 3 later", { timeoutSeconds: 0 });
await scenario("timeout then late reply", "#slow 8 slowly", { timeoutSeconds: 2 }, undefined, 15000);
await scenario("no_reply", "#say NO_REPLY", { timeoutSeconds: 30 }, undefined, 3000);
await scenario("recipient asks its user", `#tool ask_user ${JSON.stringify({ questions: [{ id: "ok", header: "OK", question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }] })}`, { timeoutSeconds: 6 }, async (atl, pix, t0) => {
  const q = await A.waitFor((e) => e.event === "question.requested" && e.payload?.sessionKey === atl, 30000).catch(() => null);
  console.log("\n question.requested for recipient:", q ? JSON.stringify(q.payload).slice(0, 260) : "none");
  await sleep(8000); if (q) await A.call("question.resolve", { id: q.payload.id, answers: { answers: { ok: ["Yes"] } } });
});
await scenario("recipient waits on an approval", '#tool exec {"command":"ls /"}', { timeoutSeconds: 6 }, async (atl) => {
  const a = await A.waitFor((e) => e.event === "exec.approval.requested" && e.payload?.request?.sessionKey === atl, 30000).catch(() => null);
  await sleep(8000); if (a) await A.call("exec.approval.resolve", { id: a.payload.id, decision: "allow-once" });
});
await scenario("recipient stopped", "#slow 10 stopping", { timeoutSeconds: 30 }, async (atl) => { await sleep(2500); console.log("\n abort recipient:", JSON.stringify(await A.call("chat.abort", { sessionKey: atl }))); }, 3000);
await scenario("watch true", "#slow 3 watched", { timeoutSeconds: 0, watch: true });
await A.close();
