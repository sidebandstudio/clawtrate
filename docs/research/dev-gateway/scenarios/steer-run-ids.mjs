import { connect, sleep } from "./probe-lib.mjs";
const A = await connect({ name: "A", scopes: ["operator.read", "operator.write"] });
const s = await A.call("sessions.create", { agentId: "atlas", label: `qm2 ${Date.now()}` });
await A.call("sessions.messages.subscribe", { key: s.key });
const t0 = Date.now();
const r1 = await A.send(s.key, "#slow 8 Counting");
await sleep(1500);
const r2 = await A.send(s.key, "second message");
await r1.done; await r2.done; await sleep(4000);
console.log("run1", r1.runId.slice(0, 8), "run2", r2.runId.slice(0, 8));
for (const e of A.events.filter((e) => e.t >= t0 && e.payload?.sessionKey === s.key && ((e.event === "chat" && ["final", "aborted", "error"].includes(e.payload.state)) || (e.event === "agent" && e.payload.stream === "lifecycle" && ["start", "end"].includes(e.payload.data?.phase)))))
  console.log(" ", e.event, e.payload.runId.slice(0, 8), e.payload.state ?? e.payload.data.phase, JSON.stringify(e.payload.message?.content ?? "").slice(0, 60));
const msgs = (await A.call("chat.history", { sessionKey: s.key, limit: 10 })).messages;
for (const m of msgs) console.log(" row", m.role, m.__openclaw?.runId?.slice(0, 8) ?? "", JSON.stringify(m.content).slice(0, 50), "provenance:", JSON.stringify(m.provenance ?? m.__openclaw?.inputProvenance ?? "").slice(0, 80));
await A.close();
