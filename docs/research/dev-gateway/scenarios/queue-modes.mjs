import { connect, sleep } from "./probe-lib.mjs";
import crypto from "node:crypto";
const A = await connect({ name: "A", scopes: ["operator.read", "operator.write"] });
const text = (m) => (Array.isArray(m?.content) ? m.content.map((p) => p.text ?? "").join("") : String(m?.content ?? "")).slice(0, 70);
async function trial(label, first, mode, wait = 1500) {
  const s = await A.call("sessions.create", { agentId: "atlas", label: `qm ${label} ${Date.now()}` });
  await A.call("sessions.messages.subscribe", { key: s.key });
  const t0 = Date.now();
  const r1 = await A.send(s.key, first, {}, 120000);
  await sleep(wait);
  const r2 = await A.send(s.key, "second message", mode ? { queueMode: mode } : {}, 120000);
  const [f1, f2] = await Promise.all([r1.done.catch((e) => ({ state: "?" + e.message })), r2.done.catch((e) => ({ state: "?" + e.message }))]);
  await sleep(800);
  const h = await A.call("chat.history", { sessionKey: s.key, limit: 30 });
  const rows = h.messages.map((m) => `${m.role}:${text(m)}`).join(" | ");
  console.log(`\n## ${label} (queueMode ${mode ?? "omitted"})\n send2 reply: ${JSON.stringify({ ...r2, done: undefined })}\n run1 ${f1.state}${f1.errorMessage ? " (" + f1.errorMessage + ")" : ""}: "${text(f1.message)}"\n run2 ${f2.state}${f2.errorMessage ? " (" + f2.errorMessage + ")" : ""}: "${text(f2.message)}" same run id: ${r1.runId === r2.runId}\n history: ${rows}`);
}
for (const mode of [undefined, "steer", "followup", "collect", "interrupt"]) await trial("during text streaming", "#slow 8 Counting", mode);
for (const mode of [undefined, "steer", "followup", "interrupt"]) await trial("during a tool call", '#tool coder__slow_task {"seconds":5}', mode, 2000);
await A.close();
