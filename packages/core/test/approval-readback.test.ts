// A decision on an approval that failed says what it established
// (conversation.md section 12, "What happens to a decision"): a gateway error
// refused that decision; no answer leaves it unknown, and nothing but deny is
// accepted until the request's state is read back with `approval.get`.
import { describe, expect, it } from "vitest";
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { isRefusedDecision, REFUSED_DECISION_ANSWERS } from "../src/approval-refusals.ts";
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
      throw new GatewayError({
        code: "INVALID_REQUEST",
        message: "allow-always is unavailable for this command",
        details: { reason: "APPROVAL_ALLOW_ALWAYS_UNAVAILABLE" },
      });
    };
    let reads = 0;
    gateway.handlers["approval.get"] = () => {
      reads += 1;
      return snapshot("ap-1", "pending");
    };
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().approvals.length === 1);
    await expect(client.resolveApproval(KEY, "ap-1", "allow-always")).rejects.toThrow(
      /allow-always is unavailable/,
    );
    expect(transcript().approvals[0]).toMatchObject({
      decisionError: "refused",
      error: expect.stringMatching(/allow-always is unavailable/),
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
      throw new GatewayError({
        code: "INVALID_REQUEST",
        message: "approval already resolved",
        details: { reason: "APPROVAL_ALREADY_RESOLVED" },
      });
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

  it("an answer that does not establish the decision was not applied stays unknown: no allow is sent again before read-back", async () => {
    for (const shape of [
      // The gateway's storage failure, also sent when committing a decision failed after it may have applied.
      { code: "UNAVAILABLE", message: "approval resolve unavailable" },
      // Also sent after a decision was applied when the resolver's authority lapsed.
      {
        code: "INVALID_REQUEST",
        message: "unknown or expired approval id",
        details: { reason: "APPROVAL_NOT_FOUND" },
      },
      // An error this client does not know.
      { code: "SOMETHING_NEW", message: "something new went wrong" },
    ]) {
      const gateway = gatewayWith();
      gateway.handlers["exec.approval.resolve"] = () => {
        throw new GatewayError(shape);
      };
      gateway.handlers["approval.get"] = () => {
        throw new GatewayError({ code: "UNAVAILABLE", message: "approval get unavailable" });
      };
      const { client, transcript } = await openTask({ gateway });
      await until(() => transcript().approvals.length === 1);
      await expect(client.resolveApproval(KEY, "ap-1", "allow-once")).rejects.toThrow();
      expect(transcript().approvals[0], shape.message).toMatchObject({
        status: "pending",
        decisionError: "unknown",
        stillOpen: false,
      });
      await until(() => gateway.calls("approval.get").length >= 1);
      await expect(client.resolveApproval(KEY, "ap-1", "allow-once")).rejects.toThrow(/not known/);
      expect(gateway.calls("exec.approval.resolve"), shape.message).toHaveLength(1);
      client.stop();
    }
  });

  it("a refusal the gateway gives before deciding is refused: missing scope, an unoffered decision, invalid parameters", async () => {
    for (const [shape, method] of [
      [
        {
          code: "FORBIDDEN",
          message: "missing scope: operator.approvals",
          details: {
            code: "MISSING_SCOPE",
            missingScope: "operator.approvals",
            requiredScopes: ["operator.approvals"],
          },
        },
        "exec.approval.resolve",
      ],
      [
        {
          code: "INVALID_REQUEST",
          message: "invalid exec.approval.resolve params: /id must be string",
        },
        "exec.approval.resolve",
      ],
      [{ code: "INVALID_REQUEST", message: "invalid decision" }, "exec.approval.resolve"],
      [
        {
          code: "INVALID_REQUEST",
          message: "allow-always is unavailable for this plugin approval",
          details: { allowedDecisions: ["allow-once", "deny"] },
        },
        "plugin.approval.resolve",
      ],
    ] as const) {
      expect(isRefusedDecision(method, new GatewayProtocolRequestError(shape)), shape.message).toBe(
        true,
      );
    }
    // The same parameter error from the generic method is not a refusal: it turns a malformed decision into a deny.
    expect(
      isRefusedDecision(
        "approval.resolve",
        new GatewayProtocolRequestError({
          code: "INVALID_REQUEST",
          message: "invalid approval.resolve params: x",
        }),
      ),
    ).toBe(false);
    // A plugin's list of decisions is no refusal from another method.
    expect(
      isRefusedDecision(
        "exec.approval.resolve",
        new GatewayProtocolRequestError({
          code: "INVALID_REQUEST",
          message: "x",
          details: { allowedDecisions: [] },
        }),
      ),
    ).toBe(false);
    expect(isRefusedDecision("exec.approval.resolve", new Error("socket closed"))).toBe(false);
    expect(REFUSED_DECISION_ANSWERS.every((each) => each.source && each.why)).toBe(true);
  });

  it("Deny goes out while an Allow is on its way; a second Allow does not; the card shows whichever the gateway applied", async () => {
    // Deny wins: the gateway applies it and answers the Allow as already resolved.
    let releaseAllow!: () => void;
    const gateway = gatewayWith();
    gateway.handlers["exec.approval.resolve"] = (params) => {
      const { decision } = params as { decision: string };
      if (decision === "deny") return { ok: true };
      return new Promise((_, reject) => {
        releaseAllow = () =>
          reject(
            new GatewayError({
              code: "INVALID_REQUEST",
              message: "approval already resolved",
              details: { reason: "APPROVAL_ALREADY_RESOLVED" },
            }),
          );
      });
    };
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().approvals.length === 1);
    const allow = client.resolveApproval(KEY, "ap-1", "allow-once").catch((error: Error) => error);
    await until(() => transcript().approvals[0]!.submitting);
    await expect(client.resolveApproval(KEY, "ap-1", "allow-always")).rejects.toThrow(/on its way/);
    await client.resolveApproval(KEY, "ap-1", "deny");
    expect(gateway.calls("exec.approval.resolve")).toEqual([
      { id: "ap-1", decision: "allow-once" },
      { id: "ap-1", decision: "deny" },
    ]);
    expect(transcript().approvals[0]).toMatchObject({ status: "denied", decision: "deny" });
    releaseAllow();
    expect(await allow).toBeInstanceOf(Error);
    expect(transcript().approvals[0]).toMatchObject({
      status: "denied",
      decisionError: null,
      submitting: false,
    });
    client.stop();
  });

  it("when the Allow on its way wins, the Deny sent after it changes nothing and the card shows the Allow", async () => {
    let releaseAllow!: () => void;
    const gateway = gatewayWith();
    gateway.handlers["exec.approval.resolve"] = (params) => {
      const { decision } = params as { decision: string };
      if (decision === "allow-once")
        return new Promise((resolve) => (releaseAllow = () => resolve({ ok: true })));
      // By the time the Deny arrives the Allow was applied.
      return new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new GatewayError({
                code: "INVALID_REQUEST",
                message: "approval already resolved",
                details: { reason: "APPROVAL_ALREADY_RESOLVED" },
              }),
            ),
          30,
        ),
      );
    };
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().approvals.length === 1);
    const allow = client.resolveApproval(KEY, "ap-1", "allow-once");
    await until(() => transcript().approvals[0]!.submitting);
    const deny = client.resolveApproval(KEY, "ap-1", "deny").catch((error: Error) => error);
    await until(() => gateway.calls("exec.approval.resolve").length === 2);
    releaseAllow();
    await allow;
    expect(await deny).toBeInstanceOf(Error);
    expect(transcript().approvals[0]).toMatchObject({
      status: "allowed",
      decision: "allow-once",
      decisionError: null,
    });
    client.stop();
  });
});
