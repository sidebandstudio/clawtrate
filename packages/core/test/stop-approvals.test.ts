// Stop is a request that can fail (conversation.md section 16): a pending
// approval closes as Cancelled only when the gateway establishes its
// cancellation, and a Stop the gateway refuses leaves it pending (F-169).

import { describe, expect, it } from "vitest";
import { agentEvent, KEY, openTask } from "./client-harness.ts";
import { GatewayError, sleep, until } from "./fake-gateway.ts";

const item = {
  id: "ap-1",
  request: {
    command: "sleep 9",
    host: "gateway",
    agentId: "otto",
    sessionKey: KEY,
    runId: "run-1",
    toolCallId: "call_1",
    allowedDecisions: ["allow-once", "allow-always", "deny"],
  },
  createdAtMs: 1,
  expiresAtMs: 9_000_000_000_000,
};

describe("F-169: pending approvals and Stop", () => {
  it("a Stop the gateway refuses leaves the approval pending and answerable", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["chat.abort"] = () => {
      throw new GatewayError({
        code: "INVALID_REQUEST",
        message: "the run is owned by another session",
      });
    };
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    gateway.emit("exec.approval.requested", item);
    gateway.emit(
      "agent",
      agentEvent("run-1", 2, "lifecycle", { phase: "waiting-approval", approvalId: "ap-1" }),
    );
    await until(() => transcript().approvals.length === 1);
    await client.stopRun(KEY, "run-1").catch(() => undefined);
    await until(
      () =>
        transcript().runs[0]?.stopError !== null && transcript().runs[0]?.stopError !== undefined,
    );
    await sleep(30);
    expect(transcript().approvals[0]).toMatchObject({ id: "ap-1", status: "pending" });
    expect(transcript().runs[0]!.state).not.toBe("stopped");
    expect(gateway.calls("exec.approval.resolve")).toEqual([]);
    client.stop();
  });

  it("Stop alone does not close the card: only the gateway's cancellation does", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    gateway.emit("exec.approval.requested", item);
    await until(() => transcript().approvals.length === 1);
    await client.stopRun(KEY, "run-1").catch(() => undefined);
    expect(gateway.calls("chat.abort")).toEqual([{ sessionKey: KEY, runId: "run-1" }]);
    await sleep(30);
    expect(transcript().approvals[0]!.status).toBe("pending");
    // The gateway cancels it when it stops the run; its own snapshot says so.
    gateway.handlers["approval.get"] = () => ({
      approval: {
        id: "ap-1",
        status: "cancelled",
        reason: "run-aborted",
        presentation: { kind: "exec" },
        createdAtMs: 1,
        expiresAtMs: 9_000_000_000_000,
      },
    });
    gateway.emit("exec.approval.resolved", { id: "ap-1", decision: "deny", request: item.request });
    gateway.emit("agent", agentEvent("run-1", 3, "lifecycle", { phase: "end", aborted: true }));
    await until(() => transcript().approvals[0]!.status === "cancelled");
    client.stop();
  });
});
