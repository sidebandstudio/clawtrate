import { connect, sleep, withAgentExecPolicy } from "./probe-lib.mjs";
// exec.mode "auto" with the scripted reviewer in ../fake-openai.mjs, which
// answers allow (low risk) for read-only commands and deny (high risk) for
// commands containing "rm ". Shows those two verdicts only; the "ask" verdict,
// reviewer failure and the three-denial escalation are not exercised.
// Atlas's exec block is restored exactly afterwards (withAgentExecPolicy).
// Approvals are resolved only when raised in the session this script created.
const caps = ["tool-events", "approvals", "exec-approvals", "plugin-approvals"];
const A = await connect({ name: "AU", scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"], caps });
await withAgentExecPolicy(A, "atlas", { mode: "auto" }, async () => {
  await sleep(3000);
  for (const cmd of ["ls /", "rm -f ./does-not-exist"]) {
    const s = await A.call("sessions.create", { agentId: "atlas", label: `auto ${Date.now()}` });
    await A.call("sessions.messages.subscribe", { key: s.key, includeApprovals: true });
    const t0 = Date.now();
    const run = await A.send(s.key, `#tool exec ${JSON.stringify({ command: cmd })}`);
    const handled = new Set();
    const stop = Date.now() + 45000;
    let f;
    while (Date.now() < stop) {
      const req = A.events.find((e) => e.t >= t0 && e.event === "exec.approval.requested" && e.payload?.request?.sessionKey === s.key && !handled.has(e.payload.id));
      if (req) {
        handled.add(req.payload.id);
        console.log("  human approval asked:", JSON.stringify(req.payload.request.warningText ?? "").slice(0, 200));
        await A.call("exec.approval.resolve", { id: req.payload.id, decision: "deny" });
      }
      f = A.events.find((e) => e.t >= t0 && e.event === "chat" && e.payload?.runId === run.runId && ["final", "error", "aborted"].includes(e.payload.state));
      if (f) break;
      await sleep(500);
    }
    if (!f) throw new Error(`run for "${cmd}" did not finish within 45 s`);
    console.log(`## ${cmd}`);
    for (const e of A.events.filter((e) => e.t >= t0 && e.event === "agent" && e.payload?.runId === run.runId && e.payload?.stream === "tool")) console.log("  tool", e.payload.data.phase, JSON.stringify({ approvalReviewOutcome: e.payload.data.approvalReviewOutcome, review: e.payload.data.review, isError: e.payload.data.isError, text: e.payload.data.result?.content?.[0]?.text?.slice(0, 220), detailsReview: e.payload.data.result?.details?.approvalReviewOutcome }));
  }
});
await A.close();
