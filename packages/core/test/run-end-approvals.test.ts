// A request can outlive its run: the gateway's approval and the run that asked
// have separate lifetimes. Clawtrate never answers one by itself. The card says
// the run has ended only from an end the engine accepted for that run, stays
// answerable while the gateway holds the request, and closes only with the
// gateway's own outcome for it, with who decided where the gateway says (F-418).

import { describe, expect, it } from "vitest";
import { admitApproval, normalizeApprovals, parseExecApproval } from "../src/approvals.ts";
import { emptyActivity, newRun } from "../src/runs.ts";
import { agentEvent, grantingGateway, KEY, openTask } from "./client-harness.ts";
import { sleep, until } from "./fake-gateway.ts";

const item = (id: string, runId = "run-1") => ({
  id,
  request: {
    command: "sleep 9",
    host: "gateway",
    agentId: "otto",
    sessionKey: KEY,
    runId,
    toolCallId: `call_${id}`,
    allowedDecisions: ["allow-once", "allow-always", "deny"],
  },
  createdAtMs: 1,
  expiresAtMs: 9_000_000_000_000,
});

function gatewayWith(pending: ReturnType<typeof item>[]) {
  const gateway = grantingGateway();
  gateway.handlers["exec.approval.list"] = () => pending;
  gateway.handlers["exec.approval.resolve"] = () => ({ ok: true });
  return gateway;
}

describe("F-418: a request that outlives its run", () => {
  it("the run completes: nothing is sent; the card says the run ended and stays answerable", async () => {
    const gateway = gatewayWith([]);
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    gateway.emit("exec.approval.requested", item("ap-1"));
    await until(() => transcript().approvals.length === 1);
    expect(transcript().approvals[0]!.runEnded).toBe(false);
    gateway.emit("agent", agentEvent("run-1", 2, "lifecycle", { phase: "end" }));
    await until(() => transcript().approvals[0]!.runEnded);
    await sleep(50);
    expect(gateway.calls("exec.approval.resolve")).toEqual([]);
    expect(transcript().approvals[0]).toMatchObject({ status: "pending", runEnded: true });
    client.stop();
  });

  it("the run fails: nothing is sent either", async () => {
    const gateway = gatewayWith([]);
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    gateway.emit("exec.approval.requested", item("ap-1"));
    await until(() => transcript().approvals.length === 1);
    gateway.emit(
      "agent",
      agentEvent("run-1", 2, "lifecycle", {
        phase: "error",
        error: "boom",
        executionSettled: true,
      }),
    );
    await until(() => transcript().approvals[0]!.runEnded);
    await sleep(50);
    expect(gateway.calls("exec.approval.resolve")).toEqual([]);
    expect(transcript().approvals[0]!.status).toBe("pending");
    client.stop();
  });

  it("an older end the engine rejected does not say the run ended, and a later history read sends nothing (the review's case)", async () => {
    const gateway = gatewayWith([item("ap-review")]);
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", agentEvent("run-1", 10, "lifecycle", { phase: "start" }));
    gateway.emit("exec.approval.requested", item("ap-review"));
    gateway.emit(
      "agent",
      agentEvent("run-1", 11, "lifecycle", { phase: "waiting-approval", approvalId: "ap-review" }),
    );
    await until(() => transcript().runs[0]?.state === "waiting");
    gateway.emit("agent", agentEvent("run-1", 9, "lifecycle", { phase: "end" }));
    await sleep(50);
    expect(transcript().runs[0]!.state).toBe("waiting");
    expect(transcript().approvals[0]!.runEnded).toBe(false);
    gateway.handlers["chat.history"] = () => ({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "A previous partial answer." }],
          stopReason: "stop",
          __openclaw: { id: "a1", runId: "run-1" },
        },
      ],
    });
    client.closeSession(KEY);
    client.openSession(KEY);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    await sleep(100);
    expect(gateway.calls("exec.approval.resolve")).toEqual([]);
    expect(transcript().approvals.find((card) => card.id === "ap-review")?.status).toBe("pending");
    client.stop();
  });

  it("a run whose end is only a stand-in (outcome not known) does not say the run ended; an accepted end does", () => {
    const pending = admitApproval(parseExecApproval(item("ap-1"))!);
    const activity = (outcomeKnown: boolean) =>
      normalizeApprovals({
        ...emptyActivity,
        runs: [{ ...newRun("run-1", { state: "completed", bound: true }, 1), outcomeKnown }],
        approvals: [pending],
      });
    expect(activity(false).approvals[0]!.runEnded).toBe(false);
    expect(activity(true).approvals[0]!.runEnded).toBe(true);
  });

  it("the card closes only with the gateway's own outcome, and keeps who decided as the gateway names them", async () => {
    const gateway = gatewayWith([]);
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    gateway.emit("exec.approval.requested", item("ap-1"));
    gateway.emit("agent", agentEvent("run-1", 2, "lifecycle", { phase: "end" }));
    await until(() => transcript().approvals[0]?.runEnded === true);
    gateway.emit("exec.approval.resolved", {
      id: "ap-1",
      decision: "allow-once",
      resolvedBy: "Pip's laptop",
      request: item("ap-1").request,
    });
    await until(() => transcript().approvals[0]!.status === "allowed");
    expect(transcript().approvals[0]).toMatchObject({
      decision: "allow-once",
      resolvedBy: "Pip's laptop",
      runEnded: false,
    });
    expect(gateway.calls("exec.approval.resolve")).toEqual([]);
    client.stop();
  });
});
