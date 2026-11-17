import { connect, sleep } from "./probe-lib.mjs";
import crypto from "node:crypto";const A = await connect({ name: "A", scopes: ["operator.read", "operator.write"] });
const B = await connect({ name: "B", scopes: ["operator.read", "operator.write", "operator.questions"] });
const key = "agent:atlas:main";
for (const c of [A, B]) await c.call("sessions.messages.subscribe", { key });
console.log("pending before:", (await B.call("question.list", {})).questions.map((q) => q.id));
const ask = (qs) => `#tool ask_user ${JSON.stringify({ questions: qs })}`;
const single = [{ id: "color", header: "Colour", question: "Which colour?", options: [{ label: "Red" }, { label: "Blue" }] }];
const multi = [{ id: "langs", header: "Languages", question: "Which languages?", options: [{ label: "TypeScript" }, { label: "Swift" }, { label: "Rust" }], multiSelect: true }];
const two = [single[0], { id: "size", header: "Size", question: "Which size?", options: [{ label: "S" }, { label: "M" }] }];
async function run(label, message, act) {
  const t0 = Date.now();
  const r = await A.send(key, message, {}, 120000);
  const q = (await B.waitFor((e) => e.event === "question.requested" && e.payload?.runId === r.runId, 30000)).payload;
  await act(q);
  const fin = await r.done;
  const res = [...A.events].reverse().find((e) => e.t >= t0 && e.event === "agent" && e.payload?.data?.name === "ask_user" && e.payload?.data?.phase === "result");
  const resolved = B.events.find((e) => e.t >= t0 && e.event === "question.resolved" && e.payload?.id === q.id);
  const msgs = A.events.filter((e) => e.t >= t0 && e.event === "session.message" && e.payload?.message?.role === "user").map((e) => JSON.stringify(e.payload.message.content).slice(0, 80));
  console.log(`\n## ${label}\n resolved event: ${JSON.stringify(resolved?.payload)}\n tool details: ${JSON.stringify(res?.payload.data.result?.details)}\n run: ${fin.state}\n user rows in transcript: ${msgs.join(" | ")}`);
}
await run("multi select + free text by B", ask(multi), (q) => B.call("question.resolve", { id: q.id, answers: { answers: { langs: ["TypeScript", "Kotlin (typed in)"] } } }));
await run("two questions in one card", ask(two), (q) => B.call("question.resolve", { id: q.id, answers: { answers: { color: ["Red"], size: ["M"] } } }));
await run("dismissed by B", ask(single), (q) => B.call("question.resolve", { id: q.id, cancel: true }));
await run("plain chat.send while pending (single)", ask(single), async () => { await sleep(300); const s = await A.call("chat.send", { sessionKey: key, message: "Blue please", idempotencyKey: crypto.randomUUID() }); console.log(" chat.send reply:", JSON.stringify(s)); });
await run("plain chat.send while pending (multi)", ask(multi), async () => { await sleep(300); const s = await A.call("chat.send", { sessionKey: key, message: "Swift, Rust", idempotencyKey: crypto.randomUUID() }); console.log(" chat.send reply:", JSON.stringify(s)); });
await A.close(); await B.close();
