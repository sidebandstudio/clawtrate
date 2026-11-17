import { connect, sleep } from "./probe-lib.mjs";
const A = await connect({ name: "A", scopes: ["operator.read", "operator.write"] });
for (const [label, msg] of [["reasoning, tool, reasoning, text", '#tool ls {"path":"."}'], ["reasoning and text, no tool", "just think"]]) {
  const s = await A.call("sessions.create", { agentId: "atlas", label: `rs ${Date.now()}` });
  await A.call("sessions.messages.subscribe", { key: s.key });
  const t0 = Date.now(); const r = await A.send(s.key, msg); await r.done; await sleep(500);
  console.log(`\n## ${label}`);
  for (const e of A.events.filter((e) => e.t >= t0 && e.event === "agent" && e.payload?.runId === r.runId && !["run_status", "usage"].includes(e.payload.stream))) {
    const d = e.payload.data ?? {};
    console.log(`  seq ${e.payload.seq} ${e.payload.stream}${d.phase ? "/" + d.phase : ""} keys=${Object.keys(d).join(",")}${d.itemId ? " itemId=" + d.itemId : ""}${d.delta ? " delta=" + JSON.stringify(d.delta).slice(0, 30) : ""}`);
  }
  const h = await A.call("chat.history", { sessionKey: s.key, limit: 10 });
  for (const m of h.messages) console.log("  row", m.role, JSON.stringify((Array.isArray(m.content) ? m.content : [m.content]).map((p) => p.type ? { type: p.type, keys: Object.keys(p).join(",") } : "text")).slice(0, 220));
}
await A.close();
