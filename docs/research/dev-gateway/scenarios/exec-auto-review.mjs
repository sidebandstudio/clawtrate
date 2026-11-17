import { connect, sleep } from "./probe-lib.mjs";
const caps = ["tool-events", "approvals", "exec-approvals", "plugin-approvals"];
const A = await connect({ name: "AU", scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"], caps });
const c = await A.call("config.get", {});
console.log("patch auto:", JSON.stringify(await A.call("config.patch", { raw: JSON.stringify({ agents: { entries: { atlas: { tools: { exec: { mode: "auto" } } } } } }), baseHash: c.hash })).slice(0, 60));
await sleep(3000);
for (const cmd of ["ls /", "rm -f ./does-not-exist"]) {
  const s = await A.call("sessions.create", { agentId: "atlas", label: `auto ${Date.now()}` });
  await A.call("sessions.messages.subscribe", { key: s.key, includeApprovals: true });
  const t0 = Date.now();
  const run = await A.send(s.key, `#tool exec ${JSON.stringify({ command: cmd })}`);
  const stop = Date.now() + 45000; let f;
  while (Date.now() < stop) {
    const req = A.events.find((e) => e.t >= t0 && e.event === "exec.approval.requested" && !e.done);
    if (req) { req.done = true; console.log("  human approval asked:", JSON.stringify(req.payload.request.warningText ?? "").slice(0, 200)); await A.call("exec.approval.resolve", { id: req.payload.id, decision: "deny" }); }
    f = A.events.find((e) => e.t >= t0 && e.event === "chat" && e.payload?.runId === run.runId && ["final", "error", "aborted"].includes(e.payload.state));
    if (f) break; await sleep(500);
  }
  console.log(`## ${cmd}`);
  for (const e of A.events.filter((e) => e.t >= t0 && e.event === "agent" && e.payload?.stream === "tool")) console.log("  tool", e.payload.data.phase, JSON.stringify({ approvalReviewOutcome: e.payload.data.approvalReviewOutcome, review: e.payload.data.review, isError: e.payload.data.isError, text: e.payload.data.result?.content?.[0]?.text?.slice(0, 220), detailsReview: e.payload.data.result?.details?.approvalReviewOutcome }));
}
const c2 = await A.call("config.get", {});
await A.call("config.patch", { raw: JSON.stringify({ agents: { entries: { atlas: { tools: { exec: null } } } } }), baseHash: c2.hash });
await sleep(1500); await A.close();
