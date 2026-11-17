import { connect } from "./probe-lib.mjs";
import crypto from "node:crypto";
// Web Push from a non-browser client: subscribe with an endpoint on a closed
// loopback port (no network leaves the host), read and set preferences, and
// see what a test send reports. Also prints presence rows for client kinds.
const A = await connect({ name: "P", scopes: ["operator.read", "operator.write", "operator.approvals"] });
const r = (p, n = 600) => p.then((x) => "ok " + JSON.stringify(x).slice(0, n), (e) => `ERR ${e.gatewayCode ?? ""} ${e.message.slice(0, 200)}`);
const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys();
const keys = { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") };
const endpoint = "https://127.0.0.1:9/probe-push";
console.log("vapidPublicKey:", await r(A.call("push.web.vapidPublicKey", {}), 60));
console.log("subscribe:", await r(A.call("push.web.subscribe", { endpoint, keys })));
console.log("preferences.get:", await r(A.call("push.web.preferences.get", { endpoint }), 900));
console.log("test:", await r(A.call("push.web.test", { endpoint }), 400));
console.log("unsubscribe:", await r(A.call("push.web.unsubscribe", { endpoint })));
const pres = await A.call("system-presence", {});
console.log("presence client fields:", JSON.stringify(pres.filter((p) => p.connectionId).map((p) => ({ clientId: p.clientId, mode: p.mode, platform: p.platform, deviceFamily: p.deviceFamily, lastInputSeconds: p.lastInputSeconds, roles: p.roles }))).slice(0, 400));
await A.close();
