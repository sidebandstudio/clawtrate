import { connect, sleep, brief } from "./probe-lib.mjs";
const A = await connect({ name: "A", scopes: ["operator.read", "operator.write"] });
const ADM = await connect({ backend: true, scopes: ["operator.read", "operator.write", "operator.admin"] });
// Saves the exact original agents.defaults.compaction.mode and restores it
// (or removes the key if it was unset) in finally.
const cfg = await ADM.call("config.get", {});
const originalMode = cfg.config?.agents?.defaults?.compaction?.mode;
try {
console.log("patch:", JSON.stringify(await ADM.call("config.patch", { raw: JSON.stringify({ agents: { defaults: { compaction: { mode: "default" } } } }), baseHash: cfg.hash })).slice(0, 80));
await sleep(3000);
const s = await A.call("sessions.create", { agentId: "pixel", label: `cp ${Date.now()}` });
const key = s.key; await A.call("sessions.messages.subscribe", { key });
for (const m of ["first fact", "second fact", "third fact", "fourth fact"]) await (await A.send(key, m)).done;
const t0 = Date.now();
const r = await A.send(key, "/compact Focus on the facts"); const f = await r.done; await sleep(5000);
console.log("reply:", JSON.stringify(f.message?.content).slice(0, 200));
for (const e of A.events.filter((e) => e.t >= t0 && e.payload?.sessionKey === key && (e.event !== "agent" || ["compaction", "lifecycle"].includes(e.payload.stream)) && !["sessions.changed"].includes(e.event))) console.log("  ", brief(e, 300));
const h = await A.call("chat.history", { sessionKey: key, limit: 20 });
console.log("history:", h.messages.map((m) => m.__openclaw?.kind ? `[${m.__openclaw.kind} ${JSON.stringify({ tb: m.__openclaw.tokensBefore, ta: m.__openclaw.tokensAfter })}]` : m.role).join(" "));
const c = h.messages.find((m) => m.__openclaw?.kind === "compaction"); if (c) console.log("compaction row:", JSON.stringify(c).slice(0, 500));
} finally {
  const cfg2 = await ADM.call("config.get", {});
  await ADM.call("config.patch", { raw: JSON.stringify({ agents: { defaults: { compaction: { mode: originalMode ?? null } } } }), baseHash: cfg2.hash });
  const after = (await ADM.call("config.get", {})).config?.agents?.defaults?.compaction?.mode;
  if (after !== originalMode) throw new Error(`compaction.mode not restored: ${after} != ${originalMode}`);
}
await A.close(); await ADM.close();
