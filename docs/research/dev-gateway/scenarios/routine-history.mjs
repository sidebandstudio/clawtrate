import { connect, sleep } from "./probe-lib.mjs";
// A routine with delivery off: run it, then read its run log entry, its
// history through cron.history, and whether its session is listed.
const A = await connect({ name: "R3", scopes: ["operator.read", "operator.write", "operator.admin"] });
const t0 = Date.now();
const add = await A.call("cron.add", { name: "probe quiet routine", agentId: "pixel", schedule: { kind: "every", everyMs: 3600000 }, sessionTarget: "isolated", wakeMode: "now", payload: { kind: "agentTurn", message: "daily summary" }, delivery: { mode: "none" } });
await A.call("cron.run", { id: add.id, mode: "force" });
for (let i = 0; i < 60 && !A.events.some((e) => e.t >= t0 && e.event === "cron" && e.payload.action === "finished"); i++) await sleep(500);
const fin = A.events.find((e) => e.t >= t0 && e.event === "cron" && e.payload.action === "finished");
console.log("finished event keys:", Object.keys(fin.payload).join(","));
console.log("finished:", JSON.stringify({ ...fin.payload, job: undefined }).slice(0, 500));
const runs = (await A.call("cron.runs", { id: add.id, limit: 3 })).entries;
const e0 = runs[0];
console.log("cron.history by runAtMs:", JSON.stringify(await A.call("cron.history", { id: add.id, runAtMs: e0.runAtMs }).catch((e) => ({ err: e.message }))).slice(0, 600));
const h = await A.call("chat.history", { sessionKey: e0.sessionKey, limit: 5 }).catch((e) => ({ err: e.message }));
console.log("chat.history on run session:", h.err ?? `${h.messages.length} rows: ` + h.messages.map((m) => `${m.role}:${JSON.stringify(m.content).slice(0, 50)}`).join(" | "));
const all = await A.call("sessions.list", { limit: 200, agentId: "pixel" });
const row = all.sessions.find((s) => s.key === e0.sessionKey);
console.log("run session in sessions.list:", !!row, row ? JSON.stringify({ label: row.label, kind: row.kind, createdVia: row.createdVia, displayName: row.displayName }).slice(0, 300) : "", "| keys with :cron:", all.sessions.filter((s) => s.key.includes(":cron:")).length);
const lcStart = A.events.find((e) => e.t >= t0 && e.event === "agent" && e.payload?.sessionKey === e0.sessionKey && e.payload?.stream === "lifecycle");
console.log("agent event top-level keys on cron run:", lcStart ? Object.keys(lcStart.payload).join(",") : "none");
await A.call("cron.remove", { id: add.id });
await A.close();
