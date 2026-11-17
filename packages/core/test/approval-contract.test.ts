// Approval payloads exactly as OpenClaw 2026.10.6 produces them, and the order
// in which they can arrive. System-agent requests and resolutions are their own
// envelopes, not `ApprovalSnapshot`s; `approval.resolve` answers with the
// approval's actual outcome; a resolution that comes before its request is
// kept; and the gateway's word corrects what the client only inferred.

import { describe, expect, it } from "vitest";
import {
  applyApprovalRequested,
  applyApprovalResolved,
  expireApprovals,
  parseApprovalResolved,
  parseApprovalSnapshot,
  parseExecApproval,
  parsePluginApproval,
  parseSystemAgentApproval,
  resolutionFromSnapshot,
  settleUnlistedApprovals,
  type ApprovalKind,
} from "../src/approvals.ts";
import { MAX_APPROVAL_OUTCOMES, MAX_UNROUTED_APPROVALS } from "../src/client.ts";
import { emptyActivity, MAX_SETTLED_APPROVALS } from "../src/runs.ts";
import { deferred, sleep, until } from "./fake-gateway.ts";
import { grantingGateway, KEY, openTask } from "./client-harness.ts";

/** `buildRequestedApprovalEvent(record, "system-agent")`: `{approvalKind, id, request, createdAtMs, expiresAtMs}`. */
function systemAgentRequest(id: string, request: Record<string, unknown> = {}) {
  return {
    approvalKind: "system-agent",
    id,
    request: {
      title: "OpenClaw change",
      description: "Set the default model to dev-2",
      command: "Set the default model to dev-2",
      proposalHash: "hash-1",
      allowedDecisions: ["allow-once", "deny"],
      agentId: "otto",
      sessionKey: KEY,
      sessionId: "s-1",
      turnSourceChannel: null,
      runId: "run-1",
      ...request,
    },
    createdAtMs: 1_000,
    expiresAtMs: 9_999_999_999_999,
  };
}

/** `listVisiblePendingApprovalRequests`: the list item carries no `approvalKind`. */
function systemAgentListItem(id: string) {
  const { approvalKind: _kind, ...item } = systemAgentRequest(id);
  return item;
}

function execItem(id: string, request: Record<string, unknown> = {}) {
  return {
    id,
    request: {
      command: "uname -s",
      host: "gateway",
      agentId: "otto",
      sessionKey: KEY,
      runId: "run-1",
      toolCallId: "call_exec",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      ...request,
    },
    createdAtMs: 2_000,
    expiresAtMs: 9_000_000_000_000,
  };
}

/** A terminal `ApprovalSnapshot` (`buildApprovalSnapshot`): `source` and a typed `resolver`. */
function terminalSnapshot(id: string, fields: Record<string, unknown>) {
  return {
    id,
    urlPath: `/approve/${id}`,
    createdAtMs: 1_000,
    expiresAtMs: 9_999_999_999_999,
    resolvedAtMs: 3_000,
    presentation: {
      kind: "system-agent",
      title: "OpenClaw change",
      description: "Set the default model to dev-2",
      proposalHash: "hash-1",
      allowedDecisions: ["allow-once", "deny"],
    },
    ...fields,
  };
}

describe("system-agent requests are their own envelope (C1)", () => {
  it("reads the request's title, description, command, hash, decisions, session and run", () => {
    for (const value of [systemAgentRequest("sa-1"), systemAgentListItem("sa-1")]) {
      expect(parseSystemAgentApproval(value)).toMatchObject({
        id: "sa-1",
        kind: "system-agent",
        status: "pending",
        sessionKey: KEY,
        agentId: "otto",
        runId: "run-1",
        createdAt: 1_000,
        allowedDecisions: ["allow-once", "deny"],
        systemAgent: {
          title: "OpenClaw change",
          description: "Set the default model to dev-2",
          command: "Set the default model to dev-2",
          proposalHash: "hash-1",
        },
      });
    }
    // Read as a snapshot, the real envelope has no presentation: it would be lost.
    expect(parseApprovalSnapshot(systemAgentRequest("sa-1"))).toBeNull();
    expect(
      parseSystemAgentApproval({ ...systemAgentRequest("x"), approvalKind: "exec" }),
    ).toBeNull();
  });

  it("shows a live request and a listed one in the task, linked to its run", async () => {
    const gateway = grantingGateway();
    gateway.handlers["openclaw.approval.list"] = () => [systemAgentListItem("sa-listed")];
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().approvals.length === 1);
    gateway.emit("openclaw.approval.requested", systemAgentRequest("sa-live", { runId: "run-2" }));
    await until(() => transcript().approvals.length === 2);
    expect(transcript().approvals.map((each) => [each.id, each.kind, each.runId])).toEqual([
      ["sa-listed", "system-agent", "run-1"],
      ["sa-live", "system-agent", "run-2"],
    ]);
    client.stop();
  });
});

describe("system-agent resolutions (C2)", () => {
  const resolved = (fields: Record<string, unknown>) => ({
    id: "sa-1",
    decision: "deny",
    resolvedBy: null,
    ts: 4_000,
    request: systemAgentRequest("sa-1").request,
    ...fields,
  });

  it("takes terminalStatus as authoritative: a cancellation or expiry is not a user's denial", () => {
    expect(
      parseApprovalResolved(resolved({ terminalStatus: "cancelled" }), "system-agent"),
    ).toMatchObject({
      status: "cancelled",
      decision: null,
    });
    expect(
      parseApprovalResolved(resolved({ terminalStatus: "expired" }), "system-agent"),
    ).toMatchObject({
      status: "expired",
      decision: null,
      reason: "timeout",
    });
    expect(parseApprovalResolved(resolved({}), "system-agent")).toMatchObject({
      status: "denied",
      decision: "deny",
    });
    // terminalStatus belongs to the system-agent kind only.
    expect(parseApprovalResolved(resolved({ terminalStatus: "cancelled" }), "exec")!.status).toBe(
      "denied",
    );
  });

  it("keeps the application result apart from the permission outcome, for both emissions", async () => {
    const gateway = grantingGateway();
    gateway.handlers["openclaw.approval.list"] = () => [systemAgentListItem("sa-1")];
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().approvals.length === 1);
    // The decision, then the application result (`publishApplicationResult`).
    gateway.emit(
      "openclaw.approval.resolved",
      resolved({ decision: "allow-once", resolvedBy: "Ops" }),
    );
    gateway.emit(
      "openclaw.approval.resolved",
      resolved({ decision: "allow-once", resolvedBy: "Ops", applicationStatus: "not-applied" }),
    );
    await until(() => transcript().approvals[0]!.applicationStatus !== null);
    expect(transcript().approvals[0]).toMatchObject({
      status: "allowed",
      decision: "allow-once",
      resolvedBy: "Ops",
      applicationStatus: "not-applied",
    });
    client.stop();
  });
});

describe("approval.resolve answers with the actual outcome (C3)", () => {
  it("shows how the approval actually ended, even when another reviewer settled it first", async () => {
    const gateway = grantingGateway();
    gateway.handlers["openclaw.approval.list"] = () => [systemAgentListItem("sa-1")];
    gateway.handlers["approval.resolve"] = () => ({
      applied: false,
      approval: terminalSnapshot("sa-1", {
        status: "denied",
        decision: "deny",
        reason: "user",
        source: { agentId: "otto", sessionKey: KEY },
        resolver: { kind: "channel", id: "reviewer-7" },
      }),
    });
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().approvals.length === 1);
    await client.resolveApproval(KEY, "sa-1", "allow-once");
    expect(gateway.calls("approval.resolve")).toEqual([
      { id: "sa-1", kind: "system-agent", decision: "allow-once" },
    ]);
    expect(transcript().approvals[0]).toMatchObject({
      status: "denied",
      decision: "deny",
      resolver: { kind: "channel", id: "reviewer-7" },
      submitting: false,
    });
    expect(transcript().approvals[0]!.error).toMatch(/already been settled/);
    client.stop();
  });

  it("applies the outcome the gateway reports when it did apply the decision", async () => {
    const gateway = grantingGateway();
    gateway.handlers["openclaw.approval.list"] = () => [systemAgentListItem("sa-1")];
    gateway.handlers["approval.resolve"] = () => ({
      applied: true,
      approval: terminalSnapshot("sa-1", {
        status: "allowed",
        decision: "allow-once",
        reason: "user",
        resolver: { kind: "device", id: "device-1" },
      }),
    });
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().approvals.length === 1);
    await client.resolveApproval(KEY, "sa-1", "allow-once");
    expect(transcript().approvals[0]).toMatchObject({
      status: "allowed",
      decision: "allow-once",
      resolver: { kind: "device", id: "device-1" },
      error: null,
    });
    client.stop();
  });

  it("refuses a second answer while the first is on its way", async () => {
    const gateway = grantingGateway();
    gateway.handlers["exec.approval.list"] = () => [execItem("ap-1")];
    const slow = deferred<unknown>();
    gateway.handlers["exec.approval.resolve"] = () => slow.promise;
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().approvals.length === 1);
    const first = client.resolveApproval(KEY, "ap-1", "deny");
    await expect(client.resolveApproval(KEY, "ap-1", "deny")).rejects.toThrow(/on its way/);
    slow.resolve({ ok: true });
    await first;
    expect(gateway.calls("exec.approval.resolve")).toHaveLength(1);
    client.stop();
  });
});

describe("terminal snapshots name a typed resolver and their source (C4, C5)", () => {
  it.each([
    [
      { kind: "device", id: "device-9" },
      { kind: "device", id: "device-9" },
    ],
    [
      { kind: "channel", id: "slack:U1" },
      { kind: "channel", id: "slack:U1" },
    ],
    [
      { kind: "runtime", id: "gateway-client" },
      { kind: "runtime", id: "gateway-client" },
    ],
    [{ kind: "system" }, { kind: "system", id: null }],
  ])("keeps resolver %j without inventing a label", (resolver, expected) => {
    const card = parseApprovalSnapshot(
      terminalSnapshot("sa-1", {
        status: "allowed",
        decision: "allow-once",
        reason: "user",
        resolver,
      }),
    )!;
    expect(card.resolver).toEqual(expected);
    expect(card.resolvedBy).toBeNull();
  });

  it("reads the session and agent from source on a terminal snapshot", () => {
    const card = parseApprovalSnapshot(
      terminalSnapshot("sa-1", {
        status: "cancelled",
        reason: "run-aborted",
        source: { agentId: "atlas", sessionKey: "agent:atlas:main" },
      }),
    )!;
    expect(card).toMatchObject({ sessionKey: "agent:atlas:main", agentId: "atlas" });
    expect(
      resolutionFromSnapshot(
        terminalSnapshot("sa-1", {
          status: "expired",
          reason: "timeout",
          source: { sessionKey: KEY },
        }),
      ),
    ).toMatchObject({
      status: "expired",
      sessionKey: KEY,
    });
    // A pending snapshot names its session as `sourceSessionKey`.
    expect(
      parseApprovalSnapshot({
        ...terminalSnapshot("sa-2", {}),
        status: "pending",
        sourceSessionKey: KEY,
      })!.sessionKey,
    ).toBe(KEY);
  });
});

describe("plugin approvals without a decisions list (D7)", () => {
  const pluginRequest = (request: Record<string, unknown>) => ({
    id: "pl-1",
    request: {
      title: "Post publicly",
      description: "Post to the channel",
      severity: "warning",
      sessionKey: KEY,
      ...request,
    },
    createdAtMs: 1,
    expiresAtMs: 9_999_999_999_999,
  });

  it("offers the gateway's plugin default, including the standing allow", () => {
    expect(parsePluginApproval(pluginRequest({}))!.allowedDecisions).toEqual([
      "allow-once",
      "allow-always",
      "deny",
    ]);
    expect(
      parsePluginApproval(pluginRequest({ allowedDecisions: null }))!.allowedDecisions,
    ).toEqual(["allow-once", "allow-always", "deny"]);
  });

  it("keeps a restrictive list exactly, with deny", () => {
    expect(
      parsePluginApproval(pluginRequest({ allowedDecisions: ["allow-once"] }))!.allowedDecisions,
    ).toEqual(["allow-once", "deny"]);
  });

  it("lets the user choose the default standing allow, still without a duration", async () => {
    const gateway = grantingGateway();
    gateway.handlers["plugin.approval.list"] = () => [pluginRequest({})];
    gateway.handlers["plugin.approval.resolve"] = () => ({ ok: true });
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().approvals.length === 1);
    await expect(
      client.resolveApproval(KEY, "pl-1", "allow-always", { expiresInDays: 3 }),
    ).rejects.toThrow(/no duration/);
    await client.resolveApproval(KEY, "pl-1", "allow-always");
    expect(gateway.calls("plugin.approval.resolve")).toEqual([
      { id: "pl-1", decision: "allow-always" },
    ]);
    client.stop();
  });
});

describe("a resolution that arrives before its request or list entry (B3)", () => {
  const kinds: Array<{
    kind: ApprovalKind;
    list: string;
    resolvedEvent: string;
    requestedEvent: string;
    item: (id: string) => unknown;
  }> = [
    {
      kind: "exec",
      list: "exec.approval.list",
      resolvedEvent: "exec.approval.resolved",
      requestedEvent: "exec.approval.requested",
      item: (id) => execItem(id),
    },
    {
      kind: "plugin",
      list: "plugin.approval.list",
      resolvedEvent: "plugin.approval.resolved",
      requestedEvent: "plugin.approval.requested",
      item: (id) => ({
        id,
        request: { title: "T", description: "D", sessionKey: KEY, runId: "run-1" },
        createdAtMs: 1,
        expiresAtMs: 9_999_999_999_999,
      }),
    },
    {
      kind: "system-agent",
      list: "openclaw.approval.list",
      resolvedEvent: "openclaw.approval.resolved",
      requestedEvent: "openclaw.approval.requested",
      item: (id) => systemAgentListItem(id),
    },
  ];

  for (const source of kinds) {
    it(`${source.kind}: a list entry from before the resolution never makes it actionable`, async () => {
      const gateway = grantingGateway();
      const slow = deferred<unknown>();
      gateway.handlers[source.list] = () => slow.promise;
      const { client, transcript } = await openTask({ gateway });
      await until(() => gateway.calls(source.list).length === 1);
      gateway.emit(source.resolvedEvent, { id: "ap", decision: "deny", ts: 2 });
      await sleep(20);
      slow.resolve([source.item("ap")]);
      await until(() => transcript().approvalSources[source.kind] === "ready");
      expect(transcript().approvals.map((each) => [each.id, each.status])).toEqual([
        ["ap", "denied"],
      ]);
      client.stop();
    });

    it(`${source.kind}: a request reordered behind its resolution never makes it actionable`, async () => {
      const { client, gateway, transcript } = await openTask();
      await until(() => transcript().approvalAccess === "ready");
      gateway.emit(source.resolvedEvent, { id: "ap", decision: "allow-once", ts: 2 });
      gateway.emit(source.requestedEvent, source.item("ap"));
      await until(() => transcript().approvals.length === 1);
      expect(transcript().approvals[0]).toMatchObject({
        status: "allowed",
        decision: "allow-once",
      });
      client.stop();
    });
  }

  it(`a replayed entry after its settled card was trimmed (MAX_SETTLED_APPROVALS = ${MAX_SETTLED_APPROVALS}) stays settled`, async () => {
    const { client, gateway, transcript } = await openTask();
    await until(() => transcript().approvalAccess === "ready");
    for (let i = 0; i <= MAX_SETTLED_APPROVALS; i += 1) {
      gateway.emit("exec.approval.requested", execItem(`ap-${i}`));
      gateway.emit("exec.approval.resolved", { id: `ap-${i}`, decision: "deny", ts: i });
    }
    await until(() => !transcript().approvals.some((each) => each.id === "ap-0"));
    expect(transcript().approvals).toHaveLength(MAX_SETTLED_APPROVALS);
    gateway.emit("exec.approval.requested", execItem("ap-0"));
    await until(() => transcript().approvals.some((each) => each.id === "ap-0"));
    expect(transcript().approvals.find((each) => each.id === "ap-0")!.status).toBe("denied");
    client.stop();
  });

  it(`keeps MAX_APPROVAL_OUTCOMES (${MAX_APPROVAL_OUTCOMES}) outcomes; the oldest gives way first`, async () => {
    const { client, gateway, transcript } = await openTask();
    await until(() => transcript().approvalAccess === "ready");
    // Resolutions with no card yet: kept apart from the cards.
    for (let i = 0; i <= MAX_APPROVAL_OUTCOMES; i += 1) {
      gateway.emit("exec.approval.resolved", { id: `gone-${i}`, decision: "deny", ts: i });
    }
    await sleep(50);
    // The newest MAX_APPROVAL_OUTCOMES are known: the first of them stays settled on replay.
    gateway.emit("exec.approval.requested", execItem("gone-1"));
    // One past the bound: the oldest outcome was let go, so its replay is pending again.
    gateway.emit("exec.approval.requested", execItem("gone-0"));
    await until(() => transcript().approvals.length === 2);
    expect(transcript().approvals.map((each) => [each.id, each.status])).toEqual([
      ["gone-1", "denied"],
      ["gone-0", "pending"],
    ]);
    client.stop();
  });

  it(`keeps at most MAX_UNROUTED_APPROVALS (${MAX_UNROUTED_APPROVALS}) approvals no task can show`, async () => {
    const { client, gateway, transcript } = await openTask();
    await until(() => transcript().approvalAccess === "ready");
    for (let i = 0; i <= MAX_UNROUTED_APPROVALS; i += 1) {
      gateway.emit(
        "exec.approval.requested",
        execItem(`far-${i}`, { sessionKey: "agent:atlas:elsewhere", runId: `run-far-${i}` }),
      );
    }
    await until(
      () => client.state.unroutedApprovals.at(-1)?.id === `far-${MAX_UNROUTED_APPROVALS}`,
    );
    expect(client.state.unroutedApprovals).toHaveLength(MAX_UNROUTED_APPROVALS);
    expect(client.state.unroutedApprovals[0]!.id).toBe("far-1");
    // Settled by the gateway: it is no longer kept.
    gateway.emit("exec.approval.resolved", { id: "far-1", decision: "deny", ts: 1 });
    await until(() => client.state.unroutedApprovals.length === MAX_UNROUTED_APPROVALS - 1);
    // Opening its own task shows it there.
    client.openSession("agent:atlas:elsewhere");
    await until(
      () =>
        client.state.transcripts["agent:atlas:elsewhere"]?.approvals.some(
          (each) => each.id === "far-2",
        ) === true,
    );
    expect(client.state.unroutedApprovals).toEqual([]);
    client.stop();
  });
});

describe("the gateway's outcome corrects a closure the client inferred (B5)", () => {
  const pending = () =>
    applyApprovalRequested(emptyActivity, parseExecApproval(execItem("ap", {}))!);
  const expired = () =>
    expireApprovals(
      applyApprovalRequested(emptyActivity, {
        ...parseExecApproval(execItem("ap"))!,
        expiresAt: 5_000,
      }),
      5_000,
    );
  const closed = () => settleUnlistedApprovals(pending(), ["exec"], new Set());

  it.each([
    ["allow once", { decision: "allow-once", ts: 4_000, resolvedBy: "Ops" }, "allowed"],
    ["deny", { decision: "deny", ts: 4_000 }, "denied"],
  ])(
    "a local expiry followed by a delayed %s takes the gateway's outcome",
    (_name, event, status) => {
      const before = expired();
      expect(before.approvals[0]).toMatchObject({ status: "expired", inferred: true });
      const after = applyApprovalResolved(
        before,
        parseApprovalResolved({ id: "ap", ...event }, "exec")!,
      );
      expect(after.approvals[0]).toMatchObject({ status, inferred: false, reason: null });
    },
  );

  it("an inferred closure followed by a gateway cancellation or allow takes the gateway's outcome", () => {
    const cancelled = applyApprovalResolved(
      closed(),
      resolutionFromSnapshot({
        ...terminalSnapshot("ap", { status: "cancelled", reason: "run-aborted" }),
        presentation: { kind: "exec", commandText: "uname -s", allowedDecisions: ["deny"] },
      })!,
    );
    expect(cancelled.approvals[0]).toMatchObject({ status: "cancelled", reason: "run-aborted" });
    const allowed = applyApprovalResolved(
      closed(),
      parseApprovalResolved({ id: "ap", decision: "allow-always", ts: 9 }, "exec")!,
    );
    expect(allowed.approvals[0]).toMatchObject({ status: "allowed", decision: "allow-always" });
  });

  it("a settled approval is never reopened by a replayed request, and a gateway outcome is final", () => {
    const denied = applyApprovalResolved(
      pending(),
      parseApprovalResolved({ id: "ap", decision: "deny" }, "exec")!,
    );
    expect(applyApprovalRequested(denied, parseExecApproval(execItem("ap"))!)).toBe(denied);
    const again = applyApprovalResolved(
      denied,
      parseApprovalResolved({ id: "ap", decision: "allow-once" }, "exec")!,
    );
    expect(again.approvals[0]!.status).toBe("denied");
    // A local inference never overrides the gateway's word.
    expect(expireApprovals(denied, Number.MAX_SAFE_INTEGER)).toBe(denied);
  });
});
