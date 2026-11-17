import { connect, sleep } from "./probe-lib.mjs";
import crypto from "node:crypto";
// Skills: the bot's skill_workshop tool and the user's skill library.
// skill_workshop has two contracts, chosen per run (map row 21):
//   personal library: {action:"list"|"read"|"create"|"update"|…, name, skill_id,
//     expected_revision, proposal_content, …} — the default for this probe's
//     non-admin profile;
//   learned workshop: {action:"create"|"patch"|"write_file"|…, name, content}.
// The script creates fixtures with fresh unique slugs, tracks their ids, and
// removes only those. It never disables or removes any other library entry.
const A = await connect({ name: "SK2", scopes: ["operator.read", "operator.write"] });
const r = (p, n = 300) => p.then((x) => "ok " + JSON.stringify(x).slice(0, n), (e) => `ERR ${e.gatewayCode ?? ""} ${e.message.slice(0, 200)}`);
const tag = crypto.randomUUID().slice(0, 8);
const created = new Set();
const s = await A.call("sessions.create", { agentId: "atlas", label: `skill2 ${Date.now()}` });
await A.call("sessions.messages.subscribe", { key: s.key });
const runTool = async (args) => {
  const run = await A.send(s.key, `#tool skill_workshop ${JSON.stringify(args)}`);
  await run.done;
  const tr = A.events.find((e) => e.event === "agent" && e.payload?.runId === run.runId && e.payload.stream === "tool" && e.payload.data?.phase === "result");
  if (!tr) throw new Error(`no tool result for run ${run.runId}`);
  return { isError: tr.payload.data.isError, text: tr.payload.data.result?.content?.[0]?.text ?? "" };
};
try {
  const slug = `probe-greeting-${tag}`;
  const content = `---\nname: ${slug}\ndescription: Greet.\n---\n\nSay hello.\n`;
  const personal = await runTool({ action: "create", name: slug, proposal_content: content });
  console.log("personal create:", JSON.stringify({ isError: personal.isError, text: personal.text.slice(0, 220) }));
  const workshop = await runTool({ action: "create", name: slug, content });
  console.log("workshop-contract create (expected to be rejected by the personal schema here):", JSON.stringify({ isError: workshop.isError, text: workshop.text.slice(0, 220) }));
  // Operator side: save a fixture of our own, then disable and remove it.
  const saved = await A.call("skills.library.save", { expectedRevision: null, slug: `probe-library-${tag}`, content: `---\nname: probe-library-${tag}\ndescription: Library test.\n---\n\nDo the thing.\n` });
  created.add(saved.entry.skillId);
  const mine = (await A.call("skills.library.list", { scope: "mine" })).entries.filter((e) => e.slug === slug);
  for (const e of mine) created.add(e.skillId);
  console.log("bot-created entry found by slug:", mine.length);
  const dis = await A.call("skills.library.mutate", { skillId: saved.entry.skillId, expectedRevision: saved.entry.revision, action: "disable" });
  console.log("disable own fixture: enabled =", dis.entry?.enabled);
} finally {
  const list = (await A.call("skills.library.list", { scope: "mine" })).entries;
  for (const e of list.filter((x) => created.has(x.skillId))) console.log("remove own fixture:", await r(A.call("skills.library.mutate", { skillId: e.skillId, expectedRevision: e.revision, action: "remove" }), 120));
  await A.close();
}
