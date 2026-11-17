import { connect } from "./probe-lib.mjs";
const A = await connect({ name: "A", scopes: ["operator.read", "operator.write"] });
const list = await A.call("sessions.list", { limit: 100, rowMode: "compact" });
const keys = list.sessions.filter((s) => s.agentId === "pixel").map((s) => s.key);
const r = (p) => p.then((x) => JSON.stringify(x).slice(0, 600), (e) => "ERR " + e.message);
console.log("sessionKeys only:", await r(A.call("sessions.search", { query: "zebra", sessionKeys: keys.slice(0, 50), limit: 3 })));
console.log("agentId + sessionKeys:", await r(A.call("sessions.search", { query: "zebra", agentId: "pixel", sessionKeys: keys.slice(0, 50) })));
console.log("scope only:", await r(A.call("sessions.search", { query: "zebra", scope: { configuredAgentsOnly: true } })));
await A.close();
