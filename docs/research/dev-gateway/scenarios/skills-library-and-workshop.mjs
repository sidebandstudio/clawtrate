import { connect, sleep } from "./probe-lib.mjs";
const A = await connect({ name: "SK2", scopes: ["operator.read", "operator.write"] });
const r = (p, n = 400) => p.then((x) => "ok " + JSON.stringify(x).slice(0, n), (e) => `ERR ${e.gatewayCode ?? ""} ${e.message.slice(0, 200)}`);
const s = await A.call("sessions.create", { agentId: "atlas", label: `skill2 ${Date.now()}` });
await A.call("sessions.messages.subscribe", { key: s.key });
for (const args of [{ action: "list" }, { action: "create", name: "probe-greeting", content: "---\nname: probe-greeting\ndescription: Greet.\n---\n\nSay hello.\n" }]) {
  const t0 = Date.now(); await (await A.send(s.key, `#tool skill_workshop ${JSON.stringify(args)}`)).done;
  const tr = A.events.find((e) => e.t >= t0 && e.event === "agent" && e.payload?.stream === "tool" && e.payload.data?.phase === "result");
  console.log(`${args.action}:`, JSON.stringify({ isError: tr?.payload.data.isError, text: tr?.payload.data.result?.content?.[0]?.text?.slice(0, 260) }));
}
const lib = await A.call("skills.library.list", { scope: "mine" });
for (const e of lib.entries) {
  const dis = await A.call("skills.library.mutate", { skillId: e.skillId, expectedRevision: e.revision, action: "disable" }).catch((x) => ({ err: x.message }));
  console.log("disable:", JSON.stringify(dis).slice(0, 250));
  const cur = (await A.call("skills.library.list", { scope: "mine" })).entries.find((x) => x.skillId === e.skillId);
  console.log("after disable enabled=", cur?.enabled, "| remove:", await r(A.call("skills.library.mutate", { skillId: e.skillId, expectedRevision: cur.revision, action: "remove" }), 200));
}
await A.close();
