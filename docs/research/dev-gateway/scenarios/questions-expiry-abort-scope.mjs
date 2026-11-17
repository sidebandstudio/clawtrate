import { connect, sleep } from "./probe-lib.mjs";
import crypto from "node:crypto";
// Question cases not covered by questions.mjs:
//   1. a read+write device (no operator.questions): which question events it
//      receives and what question.list/get/resolve return;
//   2. no answer within the 30 s minimum timeout (expiry);
//   3. chat.abort while the question is pending.
// Device Q holds operator.questions and watches every question event; tool
// events go to W, the device that started the run.
const W = await connect({ name: "W", scopes: ["operator.read", "operator.write"] });
const Q = await connect({ name: "Q", scopes: ["operator.read", "operator.write", "operator.questions"] });
const r = (p) => p.then((x) => "ok " + JSON.stringify(x).slice(0, 200), (e) => `ERR ${e.gatewayCode ?? e.code ?? ""} ${e.message.slice(0, 160)}`);
const ask = (timeoutSeconds) => `#tool ask_user ${JSON.stringify({ questions: [{ id: "color", header: "Colour", question: "Which colour?", options: [{ label: "Red" }, { label: "Blue" }] }], timeoutSeconds })}`;
const qEvents = (c, t0, sessionKey) => c.events.filter((e) => e.t >= t0 && e.event.startsWith("question.")).map((e) => `${e.event}:${e.payload.status}${e.payload.sessionKey && e.payload.sessionKey !== sessionKey ? "(other session)" : ""}`);
async function newTask(label) {
  const s = await W.call("sessions.create", { agentId: "atlas", label: `${label} ${Date.now()}` });
  for (const c of [W, Q]) await c.call("sessions.messages.subscribe", { key: s.key });
  return s.key;
}
function toolResult(c, runId) {
  const e = c.events.find((x) => x.event === "agent" && x.payload?.runId === runId && x.payload.stream === "tool" && x.payload.data?.phase === "result");
  return e ? JSON.stringify({ isError: e.payload.data.isError, details: e.payload.data.result?.details }) : "none";
}

// 1 + 2: W starts the run and tries the question methods; nobody answers.
{
  const key = await newTask("q-expiry");
  const t0 = Date.now();
  const run = await W.send(key, ask(30), {}, 120_000);
  const req = await Q.waitFor((e) => e.event === "question.requested" && e.payload?.runId === run.runId, 30_000);
  console.log("## read+write device W");
  console.log(" question.list:", await r(W.call("question.list", {})));
  console.log(" question.get:", await r(W.call("question.get", { id: req.payload.id })));
  console.log(" question.resolve:", await r(W.call("question.resolve", { id: req.payload.id, cancel: true })));
  const fin = await run.done;
  console.log("## expiry (30 s, no answer)");
  console.log(" Q question events:", qEvents(Q, t0, key).join(", "));
  console.log(" W question events:", qEvents(W, t0, key).join(", ") || "none");
  console.log(" tool result:", toolResult(W, run.runId));
  console.log(" run:", fin.state);
}
// 3: abort while asking.
{
  const key = await newTask("q-abort");
  const t0 = Date.now();
  const run = await W.send(key, ask(600), {}, 120_000);
  await Q.waitFor((e) => e.event === "question.requested" && e.payload?.runId === run.runId, 30_000);
  console.log("## abort while asking");
  console.log(" chat.abort:", await r(W.call("chat.abort", { sessionKey: key })));
  const fin = await run.done;
  await sleep(1000);
  console.log(" Q question events:", qEvents(Q, t0, key).join(", "));
  console.log(" tool result:", toolResult(W, run.runId));
  console.log(" run:", fin.state);
}
await W.close();
await Q.close();
