import { connect, sleep } from "./probe-lib.mjs";
import crypto from "node:crypto";
// "Always allow" on an expired exec approval: create a 2 s approval with
// exec.approval.request, let it expire, then resolve it with allow-always and
// check whether any rule was saved.
const caps = ["approvals", "exec-approvals"];
const A = await connect({ name: "EX", scopes: ["operator.read", "operator.approvals", "operator.admin"], caps });
const r = (p, n = 400) => p.then((x) => "ok " + JSON.stringify(x).slice(0, n), (e) => `ERR ${e.gatewayCode ?? ""} ${e.message.slice(0, 220)} ${JSON.stringify(e.details ?? "")}`);
const before = JSON.stringify((await A.call("exec.approvals.get", {})).file ?? {});
const id = crypto.randomUUID();
const req = A.call("exec.approval.request", { id, command: "uname -a", host: "gateway", agentId: "atlas", security: "allowlist", ask: "on-miss", timeoutMs: 2000 }, 30000).then((x) => x, (e) => ({ err: e.message }));
await sleep(500);
console.log("listed while pending:", (await A.call("exec.approval.list", {})).some((a) => a.id === id));
const fin = await req;
console.log("request result after timeout:", JSON.stringify(fin).slice(0, 300));
const resolved = A.events.find((e) => e.event === "exec.approval.resolved" && e.payload?.id === id);
console.log("resolved event:", resolved ? JSON.stringify({ decision: resolved.payload.decision, resolvedBy: resolved.payload.resolvedBy }) : "none");
console.log("allow-always on expired:", await r(A.call("exec.approval.resolve", { id, decision: "allow-always" })));
console.log("approval.get on expired:", await r(A.call("exec.approval.get", { id }), 300));
const after = JSON.stringify((await A.call("exec.approvals.get", {})).file ?? {});
console.log("approvals document changed:", before !== after);
await A.close();
