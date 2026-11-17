import { connect, sleep } from "./probe-lib.mjs";
import crypto from "node:crypto";
// The bot asks for a credential with the secrets tool. Creating a secret-store
// question needs operator.admin plus trusted agent-runtime authority on the
// gateway side (map row 21); answering needs operator.questions.
// Outcomes are explicit: QUESTION (a question arrived and was answered),
// TOOL-ERROR (the tool failed, quoted), or UNKNOWN. The leak check runs only
// when a value was actually submitted. The entry name is unique per run and
// the script deletes only that entry.
const NAME = `PROBE_TOKEN_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const VALUE = `probe-secret-${crypto.randomUUID()}`;
const W = await connect({ name: "SW", scopes: ["operator.read", "operator.write", "operator.questions", "operator.admin"] });
const s = await W.call("sessions.create", { agentId: "atlas", label: `secret ${Date.now()}` });
await W.call("sessions.messages.subscribe", { key: s.key });
let submitted = false;
try {
  const run = await W.send(s.key, `#tool secrets ${JSON.stringify({ action: "request", name: NAME, reason: "probe test", allowedHosts: ["api.example.invalid"] })}`, {}, 120000);
  let outcome = "UNKNOWN";
  for (let i = 0; i < 120 && outcome === "UNKNOWN"; i++) {
    const q = W.events.find((e) => e.event === "question.requested" && e.payload?.runId === run.runId);
    if (q) {
      const q0 = q.payload.questions[0];
      console.log("question:", JSON.stringify({ isSecret: q0.isSecret, secretStore: q0.secretStore }));
      await W.call("question.resolve", { id: q.payload.id, answers: { answers: { [q0.questionId]: [VALUE] } }, secretStoreAllowedHosts: ["api.example.invalid"] });
      submitted = true;
      outcome = "QUESTION";
    }
    const tr = W.events.find((e) => e.event === "agent" && e.payload?.runId === run.runId && e.payload.stream === "tool" && e.payload.data?.phase === "result");
    if (outcome === "UNKNOWN" && tr) {
      outcome = tr.payload.data.isError ? "TOOL-ERROR" : "UNKNOWN";
      console.log("tool result:", JSON.stringify({ isError: tr.payload.data.isError, text: tr.payload.data.result?.content?.[0]?.text?.slice(0, 300) }));
      if (!tr.payload.data.isError) break;
    }
    if (outcome === "UNKNOWN") await sleep(500);
  }
  console.log("outcome:", outcome);
  const fin = await run.done.catch((e) => ({ state: e.message }));
  console.log("run:", fin.state);
  if (submitted) {
    const hist = JSON.stringify(await W.call("chat.history", { sessionKey: s.key, limit: 20 }));
    console.log("value in any event:", JSON.stringify(W.events).includes(VALUE), "| value in transcript:", hist.includes(VALUE));
  } else console.log("no value was submitted, so no leak check was made");
} finally {
  const listed = (await W.call("secrets.store.list", {}).catch(() => ({ entries: [] }))).entries ?? [];
  if (listed.some((e) => e.name === NAME)) console.log("delete own entry:", JSON.stringify(await W.call("secrets.store.delete", { name: NAME }).catch((e) => e.message)).slice(0, 120));
  await W.close();
}
