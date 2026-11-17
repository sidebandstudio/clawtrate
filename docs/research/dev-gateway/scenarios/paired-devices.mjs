import { connect } from "./probe-lib.mjs";
const A = await connect({ name: "D", scopes: ["operator.read", "operator.pairing"] });
const l = await A.call("device.pair.list", {});
const p = (l.paired ?? [])[0];
console.log("keys:", Object.keys(l).join(","), "| paired[0] keys:", p ? Object.keys(p).join(",") : "none");
await A.close();
