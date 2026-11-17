import { connect, sleep } from "./probe-lib.mjs";
// The bot asks for a credential with the secrets tool; a device holding
// operator.questions answers the masked question. Checks that the value is
// absent from events and the transcript, and what the bot gets back.
const VALUE = "probe-secret-value-" + Math.random().toString(36).slice(2, 10);
// The device that starts the run must hold operator.questions: without it the
// tool fails with "missing scope: operator.questions" (observed).
const W = await connect({ name: "SW", scopes: ["operator.read", "operator.write", "operator.questions"] });
const Q = await connect({ name: "SQ", scopes: ["operator.read", "operator.write", "operator.questions"] });
const s = await W.call("sessions.create", { agentId: "atlas", label: `secret ${Date.now()}` });
for (const c of [W, Q]) await c.call("sessions.messages.subscribe", { key: s.key });
const run = await W.send(s.key, `#tool secrets ${JSON.stringify({ action: "request", name: "PROBE_TOKEN", reason: "probe test", allowedHosts: ["api.example.invalid"] })}`, {}, 120000);
const req = await Q.waitFor((e) => e.event === "question.requested" && e.payload?.runId === run.runId, 30000).catch(() => null);
if (!req) { console.log("no question raised"); }
else {
  const q0 = req.payload.questions[0];
  console.log("question:", JSON.stringify({ questionId: q0.questionId, header: q0.header, isSecret: q0.isSecret, secretStore: q0.secretStore, secretStoreExisting: q0.secretStoreExisting, options: q0.options }).slice(0, 500));
  const res = await Q.call("question.resolve", { id: req.payload.id, answers: { answers: { [q0.questionId]: [VALUE] } }, secretStoreAllowedHosts: ["api.example.invalid"] }).catch((e) => ({ err: e.message }));
  console.log("resolve:", JSON.stringify(res).slice(0, 300));
}
const fin = await run.done.catch((e) => ({ state: e.message }));
const tr = W.events.find((e) => e.event === "agent" && e.payload?.runId === run.runId && e.payload.stream === "tool" && e.payload.data?.phase === "result");
console.log("tool result:", JSON.stringify({ isError: tr?.payload.data.isError, text: tr?.payload.data.result?.content?.[0]?.text?.slice(0, 300) }));
console.log("run:", fin.state);
const allEvents = JSON.stringify([...W.events, ...Q.events]);
const hist = JSON.stringify(await W.call("chat.history", { sessionKey: s.key, limit: 20 }));
console.log("value in any event:", allEvents.includes(VALUE), "| value in transcript:", hist.includes(VALUE));
await W.close(); await Q.close();
