// A request still pending when its own run completes or fails is closed by
// this client: it denies it, once, so its action is not taken after the run
// it belonged to, and the card says the run ended (F-418). A stopped run is
// the gateway's to cancel, and a device without approval access sends nothing.

import { describe, expect, it } from "vitest";
import { READ_SCOPES } from "../src/scopes.ts";
import { agentEvent, grantingGateway, KEY, openTask } from "./client-harness.ts";
import { deferred, GatewayError, sleep, until } from "./fake-gateway.ts";

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

describe("F-418: a request still pending after its run ended", () => {
  it("the run completed: the client denies it once, and the card closes as the run ended, its command not run", async () => {
    const gateway = gatewayWith([]);
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    gateway.emit("exec.approval.requested", item("ap-1"));
    await until(() => transcript().approvals.length === 1);
    expect(gateway.calls("exec.approval.resolve")).toEqual([]);
    gateway.emit("agent", agentEvent("run-1", 2, "lifecycle", { phase: "end" }));
    await until(() => transcript().approvals[0]!.status === "denied");
    expect(gateway.calls("exec.approval.resolve")).toEqual([{ id: "ap-1", decision: "deny" }]);
    expect(transcript().approvals[0]).toMatchObject({
      status: "denied",
      decision: "deny",
      reason: "run-ended",
    });
    // The gateway's own resolved event (a legacy deny, which says nothing of why) changes nothing.
    gateway.emit("exec.approval.resolved", { id: "ap-1", decision: "deny", resolvedBy: "x" });
    await sleep(30);
    expect(transcript().approvals[0]).toMatchObject({ status: "denied", reason: "run-ended" });
    // Later changes of the task never send it again.
    gateway.emit("agent", agentEvent("run-2", 1, "lifecycle", { phase: "start" }));
    gateway.emit("agent", agentEvent("run-2", 2, "lifecycle", { phase: "end" }));
    await sleep(30);
    expect(gateway.calls("exec.approval.resolve")).toHaveLength(1);
    client.stop();
  });

  it("the run failed: the card closes as the run failed", async () => {
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
    await until(() => transcript().approvals[0]!.status === "denied");
    expect(transcript().approvals[0]!.reason).toBe("run-failed");
    client.stop();
  });

  it("while the run is still going, or after it was stopped, nothing is sent", async () => {
    const gateway = gatewayWith([]);
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    gateway.emit("exec.approval.requested", item("ap-1"));
    await until(() => transcript().approvals.length === 1);
    await sleep(30);
    expect(gateway.calls("exec.approval.resolve")).toEqual([]);
    gateway.emit("agent", agentEvent("run-1", 2, "lifecycle", { phase: "end", aborted: true }));
    await until(() => transcript().approvals[0]!.runEnded);
    await sleep(30);
    expect(gateway.calls("exec.approval.resolve")).toEqual([]);
    expect(transcript().approvals[0]!.status).toBe("pending");
    client.stop();
  });

  it("a device that cannot approve sends nothing and asks for no access", async () => {
    const gateway = gatewayWith([]);
    const { client, transcript } = await openTask({ gateway, held: READ_SCOPES });
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    gateway.emit("agent", agentEvent("run-1", 2, "lifecycle", { phase: "end" }));
    await until(() => transcript().runs[0]?.state === "completed");
    await sleep(30);
    expect(gateway.calls("exec.approval.resolve")).toEqual([]);
    expect(client.state.connection.upgrade.status).toBe("idle");
    client.stop();
  });

  it("a decision that raced the deny shows as the gateway reports it: another reviewer's allow wins", async () => {
    const gateway = gatewayWith([]);
    const answer = deferred<unknown>();
    gateway.handlers["exec.approval.resolve"] = () => answer.promise;
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    gateway.emit("exec.approval.requested", item("ap-1"));
    await until(() => transcript().approvals.length === 1);
    gateway.emit("agent", agentEvent("run-1", 2, "lifecycle", { phase: "end" }));
    await until(() => gateway.calls("exec.approval.resolve").length === 1);
    gateway.emit("exec.approval.resolved", {
      id: "ap-1",
      decision: "allow-once",
      resolvedBy: "another reviewer",
    });
    answer.reject(
      new GatewayError({ code: "INVALID_REQUEST", message: "approval already resolved" }),
    );
    await until(() => transcript().approvals[0]!.status === "allowed");
    expect(transcript().approvals[0]).toMatchObject({ decision: "allow-once" });
    expect(transcript().approvals[0]!.reason).not.toBe("run-ended");
    client.stop();
  });
});
