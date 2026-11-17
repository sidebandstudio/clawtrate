import { connect, sleep } from "./probe-lib.mjs";
import crypto from "node:crypto";
// MCP servers as the user sees them: catalog entries, adding a command server
// with config.patch and using it without a restart, and mcp.authLogin from a
// non-browser client.
const A = await connect({ name: "M", scopes: ["operator.read", "operator.write", "operator.admin"] });
const r = (p, n = 400) => p.then((x) => "ok " + JSON.stringify(x).slice(0, n), (e) => `ERR ${e.gatewayCode ?? ""} ${e.message.slice(0, 220)}`);
const cat = await A.call("tools.catalog", { agentId: "atlas", includePlugins: true });
const flat = JSON.stringify(cat);
console.log("catalog top keys:", Object.keys(cat).join(","), "| mentions coder:", flat.includes("coder"));
const grp = (cat.groups ?? []).find((g) => JSON.stringify(g).includes("coder"));
console.log("catalog group with coder:", grp ? JSON.stringify(grp).slice(0, 400) : "none");
const cfg = await A.call("config.get", {});
const coder = cfg.config?.mcp?.servers?.coder;
console.log("config mcp.servers.coder (redacted view):", JSON.stringify(coder).slice(0, 200));
const t0 = Date.now();
console.log("patch add coder2:", await r(A.call("config.patch", { raw: JSON.stringify({ mcp: { servers: { coder2: { command: coder.command, args: coder.args } } } }), baseHash: cfg.hash }), 80));
await sleep(3000);
const reload = A.events.filter((e) => e.t >= t0 && ["config.changed", "plugins.changed", "skills.changed"].includes(e.event)).map((e) => `${e.event} ${JSON.stringify(e.payload).slice(0, 120)}`);
console.log("events after patch:", reload.join(" | ") || "none");
const s = await A.call("sessions.create", { agentId: "atlas", label: `mcp ${Date.now()}` });
await A.call("sessions.messages.subscribe", { key: s.key });
const t1 = Date.now();
await (await A.send(s.key, "#tool coder2__list_threads {}")).done;
const tr = A.events.find((e) => e.t >= t1 && e.event === "agent" && e.payload?.stream === "tool" && e.payload.data?.phase === "result");
console.log("call to new server without restart:", JSON.stringify({ name: tr?.payload.data.name, isError: tr?.payload.data.isError, text: tr?.payload.data.result?.content?.[0]?.text?.slice(0, 120) }));
console.log("mcp.authLogin (no browser origin):", await r(A.call("mcp.authLogin", { sessionId: crypto.randomUUID(), serverName: "coder" })));
const cfg2 = await A.call("config.get", {});
// Removing a server whose args array would shrink needs replacePaths.
await A.call("config.patch", { raw: JSON.stringify({ mcp: { servers: { coder2: null } } }), baseHash: cfg2.hash, replacePaths: ["mcp.servers.coder2.args"] });
await A.close();
