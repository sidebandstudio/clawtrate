import { connect, sleep } from "./probe-lib.mjs";
import crypto from "node:crypto";
const A = await connect({ name: "A", scopes: ["operator.read", "operator.write"] });
console.log("policy:", JSON.stringify(A.hello.policy.attachments), "maxPayload", A.hello.policy.maxPayload);
const s = await A.call("sessions.create", { agentId: "pixel", label: `att ${Date.now()}` });
const png = (bytes) => { const b = Buffer.alloc(bytes); Buffer.from("89504e470d0a1a0a", "hex").copy(b); return b.toString("base64"); };
const send = (label, att) => A.call("chat.send", { sessionKey: s.key, message: label, idempotencyKey: crypto.randomUUID(), attachments: [att] }, 120000)
  .then((r) => `accepted ${JSON.stringify(r).slice(0, 120)}`, (e) => `ERR code=${e.gatewayCode ?? e.code} msg=${e.message} details=${JSON.stringify(e.details ?? "")}`);
console.log("image 6 MiB + 1:", await send("img big", { type: "image", mimeType: "image/png", fileName: "big.png", content: png(6291457) }));
console.log("image 1 MiB:", await send("img ok", { type: "image", mimeType: "image/png", fileName: "ok.png", content: png(1048576) }));
console.log("text file 19464192 + 1:", await send("file big", { type: "file", mimeType: "text/plain", fileName: "big.txt", content: Buffer.alloc(19464193, 97).toString("base64") }));
console.log("frame over 25 MiB:", await Promise.race([send("frame big", { type: "file", mimeType: "text/plain", fileName: "huge.txt", content: Buffer.alloc(20 * 1024 * 1024, 97).toString("base64") }), sleep(15000).then(() => "no reply in 15 s")]));
await A.close().catch(() => {});
