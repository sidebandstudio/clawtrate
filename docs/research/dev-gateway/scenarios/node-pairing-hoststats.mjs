import { connect, sleep } from "./probe-lib.mjs";
// Approves the fixture node's pending pairing and waits for its node.hostStats.
// Start the fixture node first, under the launcher's environment, with the
// default command surface (a node started with --commands sends no host stats):
//   openclaw --profile <probe> node run --host 127.0.0.1 --port 19101 --no-tls \
//     --display-name "$PROBE_NODE_NAME"
// Only pending requests and nodes whose displayName is exactly PROBE_NODE_NAME
// are touched; the script refuses to run if that name is ambiguous.
const NAME = process.env.PROBE_NODE_NAME;
if (!NAME) throw new Error("set PROBE_NODE_NAME to the fixture node's --display-name");
const A = await connect({ name: "N3", scopes: ["operator.read", "operator.pairing", "operator.admin"] });
const pl = await A.call("node.pair.list", {});
const known = [...(pl.pending ?? []), ...(pl.paired ?? [])].filter((p) => p.displayName === NAME);
const ids = new Set(known.map((p) => p.nodeId));
if (ids.size !== 1) throw new Error(`expected exactly one node named ${NAME}, found ${ids.size}`);
const [nodeId] = ids;
for (const p of (pl.pending ?? []).filter((p) => p.nodeId === nodeId)) {
  console.log("approve fixture request:", JSON.stringify(await A.call("node.pair.approve", { requestId: p.requestId })).slice(0, 200));
}
const stats = await A.waitFor((e) => e.event === "node.hostStats" && e.payload?.nodeId === nodeId, 90_000);
console.log("node.hostStats:", JSON.stringify(stats.payload));
const n = (await A.call("node.describe", { nodeId }));
console.log("node.describe keys:", Object.keys(n).join(","), "| commands:", JSON.stringify(n.commands));
await A.close();
