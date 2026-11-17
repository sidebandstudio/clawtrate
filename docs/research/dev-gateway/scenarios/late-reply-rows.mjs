import { connect } from "./probe-lib.mjs";
const A = await connect({ name: "A" });
const list = await A.call("sessions.list", { limit: 50, rowMode: "compact" });
for (const s of list.sessions.filter((s) => s.label?.startsWith("late-s"))) {
  const h = await A.call("chat.history", { sessionKey: s.key, limit: 20 });
  const late = h.messages.find((m) => m.provenance?.kind === "inter_session");
  console.log(JSON.stringify({ senderLabel: late?.senderLabel, senderSession: late?.senderSession, timestamp: late?.timestamp, content: JSON.stringify(late?.content).slice(0, 80) }));
}
await A.close();
