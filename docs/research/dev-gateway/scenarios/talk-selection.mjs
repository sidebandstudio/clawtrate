import { connect } from "./probe-lib.mjs";
const A = await connect({ name: "T", scopes: ["operator.read", "operator.write", "operator.talk", "operator.admin"] });
const s = await A.call("sessions.create", { agentId: "pixel", label: `talk ${Date.now()}` });
const r = (p) => p.then((x) => "ok " + JSON.stringify(x).slice(0, 200), (e) => `ERR ${e.gatewayCode ?? ""} ${e.message.slice(0, 200)}`);
console.log("catalog:", await r(A.call("talk.catalog", {})));
console.log("session.create no key:", await r(A.call("talk.session.create", {})));
console.log("session.create pixel key:", await r(A.call("talk.session.create", { sessionKey: s.key })));
console.log("client.create pixel key:", await r(A.call("talk.client.create", { sessionKey: s.key })));
await A.close();
