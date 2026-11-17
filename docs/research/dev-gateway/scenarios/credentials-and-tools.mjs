import { connect } from "./probe-lib.mjs";
// F-047 and F-269: which credentials a bot can reach (model auth status, the
// shared secret store) and whether an image-generation tool is offered.
const A = await connect({ name: "CR", scopes: ["operator.read", "operator.admin"] });
const r = (p, n = 500) => p.then((x) => "ok " + JSON.stringify(x).slice(0, n), (e) => `ERR ${e.gatewayCode ?? ""} ${e.message.slice(0, 200)}`);
console.log("models.authStatus atlas:", await r(A.call("models.authStatus", { agentId: "atlas" })));
console.log("secrets.store.list:", await r(A.call("secrets.store.list", {})));
const eff = await A.call("tools.effective", { sessionKey: "agent:atlas:main" }).catch((e) => ({ err: e.message }));
const names = JSON.stringify(eff);
console.log("tools.effective has image_generate:", names.includes("image_generate"), "| view_image:", names.includes("view_image"), "| secrets:", names.includes('"secrets"'));
const cat = await A.call("tools.catalog", { agentId: "atlas" });
const img = JSON.stringify(cat).match(/\{[^{}]*"image_generate"[^{}]*\}/);
console.log("catalog entry:", img ? img[0].slice(0, 300) : "none");
await A.close();
