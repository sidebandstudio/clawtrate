// A decision on an approval that failed says what it established
// (conversation.md section 12, "What happens to a decision"): a gateway error
// refused that decision; no answer leaves it unknown, and nothing but deny is
// accepted until the request's state is read back with `approval.get`.
import { describe, expect, it } from "vitest";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
import { grantingGateway, KEY, openTask } from "./client-harness.ts";
import { GatewayError, until } from "./fake-gateway.ts";

function execItem(id: string) {
  return {
    id,
    request: {
      command: "mv /srv/media/cache /srv/scratch/cache",
      cwd: "/srv/media",
      host: "gateway",
      agentId: "otto",
      sessionKey: KEY,
      runId: "run-1",
      toolCallId: "call_mv",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    createdAtMs: 1,
    expiresAtMs: Date.now() + 600_000,
  };
}

const snapshot = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  approval: {
    id,
    status,
    createdAtMs: 1,
    expiresAtMs: Date.now() + 600_000,
    presentation: { kind: "exec", commandText: "mv", allowedDecisions: ["allow-once", "deny"] },
    ...extra,
  },
});

function gatewayWith(item = execItem("ap-1")) {
  const gateway = grantingGateway();
  gateway.handlers["exec.approval.list"] = () => [item];
  return gateway;
}

describe("a decision that failed, read back", () => {
  it("no answer: unknown, no allow until read back, then the choices return while it is pending", async () => {
    const gateway = gatewayWith();
    let answer = false;
    gateway.handlers["exec.approval.resolve"] = () =>
      answer ? { ok: true } : new Promise(() => undefined);
    let state = "pending";
    gateway.handlers["approval.get"] = () => {
      if (state === "fail") throw new GatewayError({ code: "UNAVAILABLE", message: "busy" });
      return snapshot("ap-1", state);
    };
    const { client, transcript } = await openTask({ gateway, client: { requestTimeoutMs: 80 } });
    await until(() => transcript().approvals.length === 1);

    state = "fail";
    await expect(client.resolveApproval(KEY, "ap-1", "allow-once")).rejects.toThrow();
    expect(transcript().approvals[0]).toMatchObject({
      status: "pending",
      submitting: false,
      decisionError: "unknown",
    });
    // The automatic read-back failed: still unknown, and an allow is refused before anything is sent.
    await until(() => gateway.calls("approval.get").length === 1);
    expect(transcript().approvals[0]!.decisionError).toBe("unknown");
    const sent = gateway.calls("exec.approval.resolve").length;
    await expect(client.resolveApproval(KEY, "ap-1", "allow-once")).rejects.toThrow(/not known/);
    await expect(client.resolveApproval(KEY, "ap-1", "allow-always")).rejects.toThrow(/not known/);
    expect(gateway.calls("exec.approval.resolve")).toHaveLength(sent);

    // "Check again": still pending on the gateway, so the decision was not applied.
    state = "pending";
    await client.checkApproval(KEY, "ap-1");
    expect(transcript().approvals[0]).toMatchObject({
      status: "pending",
      decisionError: null,
      error: null,
    });
    answer = true;
    await client.resolveApproval(KEY, "ap-1", "allow-once");
    expect(transcript().approvals[0]).toMatchObject({ status: "allowed", decision: "allow-once" });
    client.stop();
  });

  it("no answer, then read back as settled: the card shows how it ended", async () => {
    const gateway = gatewayWith();
    gateway.handlers["exec.approval.resolve"] = () => new Promise(() => undefined);
    gateway.handlers["approval.get"] = () =>
      snapshot("ap-1", "allowed", { decision: "allow-once", reason: "user", resolvedAtMs: 9 });
    const { client, transcript } = await openTask({ gateway, client: { requestTimeoutMs: 80 } });
    await until(() => transcript().approvals.length === 1);
    await expect(client.resolveApproval(KEY, "ap-1", "allow-once")).rejects.toThrow();
    await until(() => transcript().approvals[0]!.status === "allowed");
    expect(transcript().approvals[0]).toMatchObject({
      decision: "allow-once",
      decisionError: null,
      error: null,
    });
    client.stop();
  });

  it("deny stays possible while the outcome is unknown", async () => {
    const gateway = gatewayWith();
    let calls = 0;
    gateway.handlers["exec.approval.resolve"] = () =>
      (calls += 1) === 1 ? new Promise(() => undefined) : { ok: true };
    gateway.handlers["approval.get"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "busy" });
    };
    const { client, transcript } = await openTask({ gateway, client: { requestTimeoutMs: 80 } });
    await until(() => transcript().approvals.length === 1);
    await expect(client.resolveApproval(KEY, "ap-1", "allow-once")).rejects.toThrow();
    expect(transcript().approvals[0]!.decisionError).toBe("unknown");
    await client.resolveApproval(KEY, "ap-1", "deny");
    expect(gateway.calls("exec.approval.resolve").at(-1)).toEqual({ id: "ap-1", decision: "deny" });
    expect(transcript().approvals[0]).toMatchObject({ status: "denied", decisionError: null });
    client.stop();
  });

  it("refused: the reason shows, and the request is said to be open only once read back as pending", async () => {
    const gateway = gatewayWith();
    gateway.handlers["exec.approval.resolve"] = () => {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "grant scope not allowed" });
    };
    let reads = 0;
    gateway.handlers["approval.get"] = () => {
      reads += 1;
      return snapshot("ap-1", "pending");
    };
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().approvals.length === 1);
    await expect(client.resolveApproval(KEY, "ap-1", "allow-always")).rejects.toThrow(
      /grant scope/,
    );
    expect(transcript().approvals[0]).toMatchObject({
      decisionError: "refused",
      error: expect.stringMatching(/grant scope/),
    });
    await until(() => transcript().approvals[0]!.stillOpen);
    expect(reads).toBe(1);
    expect(transcript().approvals[0]).toMatchObject({
      status: "pending",
      decisionError: "refused",
    });
    client.stop();
  });

  it("refused because it was already settled: the read-back shows the winner, and says the decision was not applied", async () => {
    const gateway = gatewayWith();
    gateway.handlers["exec.approval.resolve"] = () => {
      throw new GatewayError({ code: "APPROVAL_ALREADY_RESOLVED", message: "already resolved" });
    };
    gateway.handlers["approval.get"] = () =>
      snapshot("ap-1", "denied", { decision: "deny", reason: "user", resolvedAtMs: 9 });
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().approvals.length === 1);
    await expect(client.resolveApproval(KEY, "ap-1", "allow-once")).rejects.toThrow();
    await until(() => transcript().approvals[0]!.status === "denied");
    expect(transcript().approvals[0]!.error).toMatch(/already been settled/);
    client.stop();
  });

  it("a decision that never left this client is neither refused nor unknown", async () => {
    const gateway = gatewayWith();
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().approvals.length === 1);
    client.stop();
    await expect(client.resolveApproval(KEY, "ap-1", "allow-once")).rejects.toThrow();
    expect(transcript().approvals[0]).toMatchObject({ status: "pending", decisionError: null });
  });

  it("the bridge carries checkApproval for a task this viewer has open", async () => {
    expect(parseBridgeCommand({ type: "checkApproval", key: KEY, approvalId: "ap-1" })).toEqual({
      type: "checkApproval",
      key: KEY,
      approvalId: "ap-1",
    });
    expect(() => parseBridgeCommand({ type: "checkApproval", key: KEY })).toThrow();
    const gateway = gatewayWith();
    const { client } = await openTask({ gateway });
    const viewer = createBridgeSession(client);
    await expect(
      viewer.apply({ type: "checkApproval", key: KEY, approvalId: "ap-1" }),
    ).rejects.toThrow();
    viewer.apply({ type: "openSession", key: KEY });
    // Nothing failed, so there is nothing to read back.
    await viewer.apply({ type: "checkApproval", key: KEY, approvalId: "ap-1" });
    expect(gateway.calls("approval.get")).toEqual([]);
    viewer.dispose();
    client.stop();
  });
});
