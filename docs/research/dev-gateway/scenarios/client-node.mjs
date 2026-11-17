import { connect, sleep } from "./probe-lib.mjs";
import { GatewayClient } from "@openclaw/gateway-client";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
// A client acting as a node: declares commands, receives node.invoke.request,
// answers with node.invoke.result. probe-lib's operator connection verifies the
// target first; the node then connects to the same verified endpoint.
const OP = await connect({ name: "op", scopes: ["operator.read", "operator.write", "operator.admin", "operator.pairing"] });
const r = (p, n = 400) => p.then((x) => "ok " + JSON.stringify(x).slice(0, n), (e) => `ERR ${e.gatewayCode ?? ""} ${e.message.slice(0, 200)}`);
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
const ident = { deviceId: crypto.createHash("sha256").update(raw).digest("hex"), publicKeyPem: publicKey.export({ type: "spki", format: "pem" }), privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) };
const tokens = {};
const received = [];
let node;
const ready = new Promise((resolve, reject) => {
  node = new GatewayClient({
    url: "ws://127.0.0.1:19101", token: readFileSync(path.join(process.env.OPENCLAW_DEV_RUN_DIR, "token"), "utf8").trim(),
    clientName: "node-host", mode: "node", role: "node", clientVersion: "0.0.1", platform: "macos", deviceFamily: "Mac", clientDisplayName: "probe client node",
    scopes: [], caps: [], commands: ["system.notify", "device.info", "clawtrate.app.open"], permissions: { notifications: true },
    minProtocol: 4, maxProtocol: 4, deviceIdentity: ident,
    hostDeps: {
      signDevicePayload: (pem, payload) => crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(pem)).toString("base64url"),
      publicKeyRawBase64UrlFromPem: (pem) => crypto.createPublicKey(pem).export({ type: "spki", format: "der" }).subarray(-32).toString("base64url"),
      loadDeviceAuthToken: ({ deviceId, role }) => tokens[`${deviceId}:${role}`],
      storeDeviceAuthToken: (rec) => (tokens[`${rec.deviceId}:${rec.role}`] = rec),
      clearDeviceAuthToken: ({ deviceId, role }) => delete tokens[`${deviceId}:${role}`],
    },
    onConnectError: reject,
    onHelloOk: (hello) => resolve(hello),
    onEvent: async (e) => {
      if (e.event !== "node.invoke.request") return;
      received.push(e.payload);
      if (e.payload.command === "device.info") return; // never answered: shows the timeout
      await node.request("node.invoke.result", { id: e.payload.id, nodeId: e.payload.nodeId, ok: true, payload: { handled: e.payload.command, params: JSON.parse(e.payload.paramsJSON ?? "null") } });
    },
  });
  node.start();
});
const hello = await ready.catch((e) => ({ err: e.message }));
console.log("node hello:", hello.err ?? JSON.stringify({ role: hello.auth?.role, scopes: hello.auth?.scopes }));
const pl = await OP.call("node.pair.list", {});
console.log("pending node pairings:", pl.pending.length, "| paired:", pl.paired.map((p) => ({ name: p.displayName, commands: p.commands })).filter((p) => p.name === "probe client node").map((p) => JSON.stringify(p)).join(","));
for (const p of pl.pending) console.log("approve:", await r(OP.call("node.pair.approve", { requestId: p.requestId }), 200));
await sleep(1500);
const me = (await OP.call("node.list", {})).nodes.find((n) => n.displayName === "probe client node");
console.log("node.list entry:", JSON.stringify({ connected: me?.connected, commands: me?.commands, caps: me?.caps, platform: me?.platform }));
console.log("invoke system.notify:", await r(OP.call("node.invoke", { nodeId: me.nodeId, command: "system.notify", params: { title: "Hi", body: "from probe" }, idempotencyKey: crypto.randomUUID(), timeoutMs: 5000 })));
console.log("invoke custom clawtrate.app.open:", await r(OP.call("node.invoke", { nodeId: me.nodeId, command: "clawtrate.app.open", params: { app: "Notes" }, idempotencyKey: crypto.randomUUID(), timeoutMs: 5000 })));
const t = Date.now();
console.log("invoke device.info, never answered:", await r(OP.call("node.invoke", { nodeId: me.nodeId, command: "device.info", params: {}, idempotencyKey: crypto.randomUUID(), timeoutMs: 2000 }, 20000)), `after ${Date.now() - t} ms`);
console.log("requests the node received:", JSON.stringify(received.map((x) => ({ command: x.command, timeoutMs: x.timeoutMs, hasParams: !!x.paramsJSON }))));
await node.stopAndWait(); await OP.call("node.pair.remove", { nodeId: me.nodeId }).catch(() => {}); await OP.close();
