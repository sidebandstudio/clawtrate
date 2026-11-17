// Approvals, exec, plugin and generic, through request, resolution and every
// way they end (capability map rows 8 and 19). Test names carry parity rows.

import { beforeEach, describe, expect, it } from "vitest";
import {
  applyApprovalRequested,
  applyApprovalResolved,
  expireApprovals,
  normalizeApprovals,
  parseApprovalResolved,
  parseApprovalSnapshot,
  parseExecApproval,
  parsePluginApproval,
  resolveRequest,
  settleUnlistedApprovals,
  type ApprovalCard,
} from "../src/approvals.ts";
import { APPROVAL_CAPS, CLIENT_CAPS, ClawtrateClient } from "../src/client.ts";
import {
  applyAgentEvent,
  applyChatEvent,
  emptyActivity,
  RawTable,
  registerSteerAlias,
  requestStop,
  type EngineContext,
  type TaskActivity,
} from "../src/runs.ts";
import { INTERACTIVE_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import {
  FakeGateway,
  helloOk,
  memoryStorage,
  sleep,
  testHost,
  tokenKey,
  until,
} from "./fake-gateway.ts";

const KEY = "agent:otto:disk-space";
let raw: RawTable;
const ctx = (): EngineContext => ({ sessionKey: KEY, now: 5_000, raw });
beforeEach(() => {
  raw = new RawTable();
});

const agent = (runId: string, seq: number, stream: string, data: Record<string, unknown>) => ({
  runId,
  seq,
  stream,
  ts: 1_000 + seq,
  sessionKey: KEY,
  data,
});

function feed(activity: TaskActivity, ...events: Array<ReturnType<typeof agent>>): TaskActivity {
  let next = activity;
  for (const event of events)
    next = normalizeApprovals(applyAgentEvent(next, event, ctx()).activity);
  return next;
}

/** An `exec.approval.list` item, as the map records it live. */
function execItem(id: string, request: Record<string, unknown> = {}) {
  return {
    id,
    request: {
      command: "uname -s",
      cwd: "/workspace",
      host: "gateway",
      nodeId: null,
      security: "allowlist",
      ask: "on-miss",
      agentId: "otto",
      sessionKey: KEY,
      runId: "run-1",
      toolCallId: "call_exec",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      commandAnalysis: { risk: "low" },
      resolvedPath: "/usr/bin/uname",
      ...request,
    },
    createdAtMs: 2_000,
    expiresAtMs: 9_000_000_000_000,
    approvalKind: "exec",
  };
}

const execStart = agent("run-1", 2, "tool", {
  phase: "start",
  name: "exec",
  toolCallId: "call_exec",
  args: { command: "uname -s" },
});

function waitingOnExec(): TaskActivity {
  let activity = feed(emptyActivity, agent("run-1", 1, "lifecycle", { phase: "start" }), execStart);
  activity = applyApprovalRequested(activity, parseExecApproval(execItem("ap-1"))!);
  return activity;
}

const run = (activity: TaskActivity) => activity.runs[0]!;
const approval = (activity: TaskActivity, id = "ap-1") =>
  activity.approvals.find((each) => each.id === id)!;

describe("what an approval carries (F-163, F-164, F-171)", () => {
  it("keeps every field of an exec approval, exactly as listed", () => {
    const card = parseExecApproval(execItem("ap-1"))!;
    expect(card).toMatchObject({
      id: "ap-1",
      kind: "exec",
      status: "pending",
      sessionKey: KEY,
      agentId: "otto",
      runId: "run-1",
      toolCallId: "call_exec",
      createdAt: 2_000,
      expiresAt: 9_000_000_000_000,
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      exec: {
        command: "uname -s",
        cwd: "/workspace",
        host: "gateway",
        security: "allowlist",
        ask: "on-miss",
        resolvedPath: "/usr/bin/uname",
        commandAnalysis: { risk: "low" },
      },
    });
    expect(card.raw).toEqual(execItem("ap-1"));
  });

  it("always offers deny, whatever the gateway lists", () => {
    expect(
      parseExecApproval(execItem("ap-1", { allowedDecisions: ["allow-once"] }))!.allowedDecisions,
    ).toEqual(["allow-once", "deny"]);
    expect(
      parseExecApproval(execItem("ap-1", { allowedDecisions: undefined }))!.allowedDecisions,
    ).toContain("deny");
  });

  it("reads plugin approvals and generic snapshots", () => {
    const plugin = parsePluginApproval({
      id: "pl-1",
      request: {
        title: "Message another bot",
        description: "Otto wants to message Atlas",
        severity: "warning",
        pluginId: "policy",
        toolName: "sessions_send",
        toolCallId: "call_send",
        sessionKey: KEY,
        agentId: "otto",
      },
      createdAtMs: 1,
      expiresAtMs: 2,
    })!;
    expect(plugin).toMatchObject({
      kind: "plugin",
      toolCallId: "call_send",
      plugin: { title: "Message another bot", severity: "warning", toolName: "sessions_send" },
    });

    const snapshot = parseApprovalSnapshot({
      id: "sa-1",
      urlPath: "/approvals/sa-1",
      createdAtMs: 1,
      expiresAtMs: 2,
      sourceSessionKey: KEY,
      status: "pending",
      presentation: {
        kind: "system-agent",
        title: "Apply proposal",
        description: "Change two settings",
        proposalHash: "abc",
        allowedDecisions: ["allow-once", "deny"],
      },
    })!;
    expect(snapshot).toMatchObject({
      kind: "system-agent",
      sessionKey: KEY,
      runId: null,
      toolCallId: null,
      systemAgent: { title: "Apply proposal", proposalHash: "abc" },
      allowedDecisions: ["allow-once", "deny"],
    });
  });
});

describe("an approval is its tool step's waiting status", () => {
  it("makes the running step waiting without adding a step; the run follows its own lifecycle (F-163)", () => {
    const activity = waitingOnExec();
    expect(run(activity).steps).toHaveLength(1);
    expect(run(activity).steps[0]).toMatchObject({
      id: "tool:call_exec",
      status: "waiting",
      approvalId: "ap-1",
    });
    expect(approval(activity).stepId).toBe("tool:call_exec");
    // No waiting-approval lifecycle event yet: the run is not assumed blocked.
    expect(run(activity)).toMatchObject({ state: "running", pendingCards: [] });
    const blocked = feed(activity, agent("run-1", 3, "lifecycle", { phase: "waiting-approval" }));
    expect(run(blocked).state).toBe("waiting");
    const released = feed(blocked, agent("run-1", 4, "lifecycle", { phase: "approval-resolved" }));
    expect(run(released).state).toBe("running");
  });

  it("links once the step appears when the approval comes first", () => {
    let activity = feed(emptyActivity, agent("run-1", 1, "lifecycle", { phase: "start" }));
    activity = applyApprovalRequested(activity, parseExecApproval(execItem("ap-1"))!);
    expect(approval(activity).stepId).toBeNull();
    activity = feed(activity, execStart);
    expect(approval(activity).stepId).toBe("tool:call_exec");
    expect(run(activity).steps[0]!.status).toBe("waiting");
  });

  it("is a card of its own when it names no tool call", () => {
    let activity = feed(emptyActivity, agent("run-1", 1, "lifecycle", { phase: "start" }));
    activity = applyApprovalRequested(
      activity,
      parseExecApproval(execItem("ap-2", { toolCallId: undefined }))!,
    );
    expect(approval(activity, "ap-2").stepId).toBeNull();
    expect(run(activity).steps).toEqual([]);
  });

  it("does not invent a run for an approval whose run the task has not seen", () => {
    const activity = applyApprovalRequested(emptyActivity, parseExecApproval(execItem("ap-1"))!);
    expect(activity.runs).toEqual([]);
    expect(approval(activity)).toMatchObject({ status: "pending", stepId: null, runEnded: false });
  });

  it("stays pending when the tool returns approval-pending and the run ends: it outlives its run", () => {
    let activity = feed(
      waitingOnExec(),
      agent("run-1", 3, "tool", {
        phase: "result",
        name: "exec",
        toolCallId: "call_exec",
        isError: false,
        result: {
          content: [{ type: "text", text: "Waiting for approval in the background" }],
          details: { status: "approval-pending" },
        },
      }),
    );
    expect(run(activity).steps[0]).toMatchObject({ status: "done", approvalId: "ap-1" });
    expect(approval(activity)).toMatchObject({ status: "pending", runEnded: false });
    activity = feed(activity, agent("run-1", 4, "lifecycle", { phase: "end", aborted: false }));
    expect(run(activity).state).toBe("completed");
    expect(approval(activity)).toMatchObject({ status: "pending", runEnded: true });
    expect(approval(activity).allowedDecisions).toContain("deny");
  });

  it("normalizing twice changes nothing", () => {
    const activity = waitingOnExec();
    expect(normalizeApprovals(activity)).toBe(activity);
  });
});

describe("resolving (F-165, F-166, F-167)", () => {
  it("allow once releases the step to running, and the tool result finishes it", () => {
    let activity = applyApprovalResolved(
      waitingOnExec(),
      parseApprovalResolved({
        id: "ap-1",
        decision: "allow-once",
        resolvedBy: "Clawtrate Desktop",
        ts: 3_000,
        request: {},
      })!,
    );
    expect(approval(activity)).toMatchObject({
      status: "allowed",
      decision: "allow-once",
      resolvedAt: 3_000,
      resolvedBy: "Clawtrate Desktop",
    });
    expect(run(activity).steps[0]!.status).toBe("running");
    activity = feed(
      activity,
      agent("run-1", 3, "tool", {
        phase: "result",
        name: "exec",
        toolCallId: "call_exec",
        isError: false,
        result: { content: [{ type: "text", text: "Linux" }], details: {} },
      }),
    );
    expect(run(activity).steps[0]).toMatchObject({ status: "done", approvalId: "ap-1" });
  });

  it("deny ends the approval; the tool's error result fails the step", () => {
    let activity = applyApprovalResolved(
      waitingOnExec(),
      parseApprovalResolved({ id: "ap-1", decision: "deny", ts: 3_000 })!,
    );
    expect(approval(activity)).toMatchObject({ status: "denied", decision: "deny" });
    activity = feed(
      activity,
      agent("run-1", 3, "tool", {
        phase: "result",
        name: "exec",
        toolCallId: "call_exec",
        isError: true,
        result: { content: [{ type: "text", text: "Approval denied" }], details: {} },
      }),
    );
    expect(run(activity).steps[0]).toMatchObject({ status: "failed", error: "Approval denied" });
  });

  it("a standing allow carries its duration where the kind takes one", () => {
    const exec = parseExecApproval(execItem("ap-1"))!;
    expect(resolveRequest(exec, "allow-always", 30)).toEqual({
      method: "exec.approval.resolve",
      params: { id: "ap-1", decision: "allow-always", grantExpiresInDays: 30 },
    });
    expect(resolveRequest(exec, "allow-always", null)).toEqual({
      method: "exec.approval.resolve",
      params: { id: "ap-1", decision: "allow-always" },
    });
    expect(resolveRequest(exec, "deny", 30).params).toEqual({ id: "ap-1", decision: "deny" });
    const plugin = { ...exec, kind: "plugin" } as ApprovalCard;
    expect(resolveRequest(plugin, "allow-once", null)).toEqual({
      method: "plugin.approval.resolve",
      params: { id: "ap-1", decision: "allow-once" },
    });
    const generic = { ...exec, kind: "system-agent" } as ApprovalCard;
    expect(resolveRequest(generic, "allow-always", 7)).toEqual({
      method: "approval.resolve",
      params: { id: "ap-1", kind: "system-agent", decision: "allow-always", grantExpiresInDays: 7 },
    });
  });

  it("a resolved approval is final; a late duplicate request does not reopen it", () => {
    const resolved = applyApprovalResolved(
      waitingOnExec(),
      parseApprovalResolved({ id: "ap-1", decision: "deny" })!,
    );
    expect(applyApprovalRequested(resolved, parseExecApproval(execItem("ap-1"))!)).toBe(resolved);
  });
});

describe("how pending approvals end (F-168, F-169)", () => {
  it("stopping the run does not settle them locally; the gateway's cancellation does", () => {
    let activity = requestStop(waitingOnExec(), "run-1", 3_000);
    activity = normalizeApprovals(
      applyChatEvent(
        activity,
        { runId: "run-1", sessionKey: KEY, seq: 3, state: "aborted" },
        null,
        ctx(),
      ),
    );
    expect(run(activity).state).toBe("stopped");
    expect(approval(activity)).toMatchObject({ status: "pending", runEnded: true });
    activity = applyApprovalResolved(
      activity,
      parseApprovalResolved({
        id: "ap-1",
        urlPath: "/a",
        createdAtMs: 1,
        expiresAtMs: 2,
        resolvedAtMs: 3,
        status: "cancelled",
        reason: "run-aborted",
        presentation: { kind: "exec", commandText: "uname -s", allowedDecisions: ["deny"] },
      })!,
    );
    expect(approval(activity)).toMatchObject({ status: "cancelled", reason: "run-aborted" });
  });

  it("an interrupt aborts the run; the approval waits for the gateway's word too", () => {
    const activity = normalizeApprovals(
      applyAgentEvent(
        waitingOnExec(),
        agent("run-1", 3, "lifecycle", { phase: "end", status: "cancelled", aborted: true }),
        ctx(),
      ).activity,
    );
    expect(run(activity).state).toBe("stopped");
    expect(approval(activity)).toMatchObject({ status: "pending", runEnded: true });
  });

  it("a steer leaves them pending", () => {
    const activity = normalizeApprovals(registerSteerAlias(waitingOnExec(), "steer-run", "run-1"));
    expect(approval(activity).status).toBe("pending");
    expect(run(activity).steps[0]!.status).toBe("waiting");
  });

  it("a run timeout keeps its structured classification and leaves them pending", () => {
    const activity = normalizeApprovals(
      applyChatEvent(
        waitingOnExec(),
        {
          runId: "run-1",
          sessionKey: KEY,
          seq: 3,
          state: "error",
          errorMessage: "Timed out",
          errorKind: "timeout",
        },
        null,
        ctx(),
      ),
    );
    expect(run(activity)).toMatchObject({ state: "failed", error: { kind: "timeout" } });
    expect(approval(activity)).toMatchObject({ status: "pending", runEnded: true });
  });

  it("expires at its expiry time, and its step goes back to running (F-168)", () => {
    let activity = expireApprovals(waitingOnExec(), 8_999_999_999_999);
    expect(approval(activity).status).toBe("pending");
    activity = expireApprovals(activity, 9_000_000_000_000);
    expect(approval(activity)).toMatchObject({ status: "expired", reason: "timeout" });
    expect(run(activity).steps[0]!.status).toBe("running");
  });

  it("one no longer listed after a reload was settled elsewhere", () => {
    const activity = settleUnlistedApprovals(waitingOnExec(), ["exec"], new Set());
    expect(approval(activity)).toMatchObject({ status: "closed", reason: "no-longer-listed" });
    expect(settleUnlistedApprovals(waitingOnExec(), ["plugin"], new Set())).toEqual(
      waitingOnExec(),
    );
  });
});

// Through the client ----------------------------------------------------------------------

const URL_A = "ws://127.0.0.1:19001";
const FAST = { reconnect: { initialMs: 20, maxMs: 40 } };

function approvalGateway() {
  const gateway = new FakeGateway();
  gateway.connectReply = (params) => {
    const { scopes, auth } = params as { scopes: string[]; auth?: { deviceToken?: string } };
    return { ok: true, payload: helloOk(scopes, auth?.deviceToken ?? "device-token") };
  };
  gateway.handlers["question.list"] = () => ({ questions: [] });
  gateway.handlers["exec.approval.list"] = () => [
    execItem("ap-1"),
    execItem("ap-x", { sessionKey: "agent:otto:other" }),
  ];
  gateway.handlers["plugin.approval.list"] = () => [];
  gateway.handlers["openclaw.approval.list"] = () => ({ approvals: [] });
  gateway.handlers["exec.approval.resolve"] = () => ({ ok: true });
  gateway.handlers["plugin.approval.resolve"] = () => ({ ok: true });
  return gateway;
}

async function openTask(held: readonly string[], gateway = approvalGateway()) {
  const storage = memoryStorage({
    connection: JSON.stringify({ url: URL_A, token: null }),
    [tokenKey(URL_A)]: JSON.stringify({
      token: "device-token",
      grantedScopes: held,
      heldScopes: held,
    }),
  });
  const client = new ClawtrateClient(testHost(gateway, storage), FAST);
  await client.start();
  await until(() => client.state.discovery.status === "ready");
  client.openSession(KEY);
  await until(() => client.state.transcripts[KEY]?.status === "ready");
  return { client, gateway, transcript: () => client.state.transcripts[KEY]! };
}

describe("approvals through the client (F-163, F-165, F-166, F-168)", () => {
  it("advertises the approval caps only with operator.approvals", async () => {
    const readOnly = await openTask(READ_SCOPES);
    const caps = (readOnly.gateway.connects[0] as { caps: string[] }).caps;
    expect(caps).toEqual([...CLIENT_CAPS]);
    readOnly.client.stop();
    const interactive = await openTask(INTERACTIVE_SCOPES);
    expect((interactive.gateway.connects[0] as { caps: string[] }).caps).toEqual([
      "tool-events",
      ...APPROVAL_CAPS,
    ]);
    expect(APPROVAL_CAPS).toEqual(["approvals", "exec-approvals", "plugin-approvals"]);
    interactive.client.stop();
  });

  it("says approvals cannot be seen on a read-only connection, rather than none", async () => {
    const { client, gateway, transcript } = await openTask(READ_SCOPES);
    await sleep(20);
    expect(transcript()).toMatchObject({ approvalAccess: "unavailable", approvals: [] });
    expect(client.state.connection.canApprove).toBe(false);
    expect(gateway.calls("exec.approval.list")).toEqual([]);
    client.stop();
  });

  it("loads this task's pending approvals when it opens, and again after a reconnect", async () => {
    const { client, gateway, transcript } = await openTask(INTERACTIVE_SCOPES);
    await until(() => transcript().approvalAccess === "ready");
    expect(transcript().approvals.map((each) => each.id)).toEqual(["ap-1"]);
    for (const method of ["exec.approval.list", "plugin.approval.list", "openclaw.approval.list"]) {
      expect(gateway.calls(method)).toEqual([{}]);
    }

    gateway.handlers["exec.approval.list"] = () => [];
    gateway.dropAll();
    await until(() => transcript().approvals[0]?.status === "closed");
    expect(gateway.calls("exec.approval.list").length).toBe(2);
    client.stop();
  });

  it("consumes requested and resolved events for each kind", async () => {
    const gateway = approvalGateway();
    gateway.handlers["exec.approval.list"] = () => [];
    const { client, transcript } = await openTask(INTERACTIVE_SCOPES, gateway);
    await until(() => transcript().approvalAccess === "ready");
    gateway.emit("exec.approval.requested", execItem("ap-2"));
    gateway.emit("plugin.approval.requested", {
      id: "pl-1",
      request: {
        title: "Post",
        description: "Post publicly",
        severity: "critical",
        sessionKey: KEY,
      },
      createdAtMs: 1,
      expiresAtMs: 9_999_999_999_999,
    });
    gateway.emit("openclaw.approval.requested", {
      id: "sa-1",
      urlPath: "/a",
      createdAtMs: 1,
      expiresAtMs: 9_999_999_999_999,
      status: "pending",
      sourceSessionKey: KEY,
      presentation: {
        kind: "system-agent",
        title: "Apply",
        description: "Apply it",
        proposalHash: "h",
        allowedDecisions: ["allow-once", "deny"],
      },
    });
    await until(() => transcript().approvals.length === 3);
    expect(transcript().approvals.map((each) => each.kind)).toEqual([
      "exec",
      "plugin",
      "system-agent",
    ]);

    gateway.emit("exec.approval.resolved", {
      id: "ap-2",
      decision: "allow-once",
      resolvedBy: "someone",
      ts: 4,
    });
    gateway.emit("plugin.approval.resolved", { id: "pl-1", decision: "deny", ts: 5 });
    gateway.emit("openclaw.approval.resolved", {
      id: "sa-1",
      urlPath: "/a",
      createdAtMs: 1,
      expiresAtMs: 2,
      resolvedAtMs: 6,
      status: "expired",
      reason: "timeout",
      presentation: {
        kind: "system-agent",
        title: "Apply",
        description: "Apply it",
        proposalHash: "h",
        allowedDecisions: ["deny"],
      },
    });
    await until(() => transcript().approvals.every((each) => each.status !== "pending"));
    expect(transcript().approvals.map((each) => each.status)).toEqual([
      "allowed",
      "denied",
      "expired",
    ]);
    client.stop();
  });

  it("resolves with the kind's method; deny is always possible; offered decisions are enforced", async () => {
    const gateway = approvalGateway();
    gateway.handlers["exec.approval.list"] = () => [
      execItem("ap-1"),
      execItem("ap-2", { toolCallId: "call_2", allowedDecisions: ["allow-once"] }),
    ];
    const { client, transcript } = await openTask(INTERACTIVE_SCOPES, gateway);
    await until(() => transcript().approvals.length === 2);

    await client.resolveApproval(KEY, "ap-1", "allow-always", { expiresInDays: 30 });
    expect(gateway.calls("exec.approval.resolve")).toEqual([
      { id: "ap-1", decision: "allow-always", grantExpiresInDays: 30 },
    ]);
    expect(transcript().approvals[0]).toMatchObject({
      status: "allowed",
      decision: "allow-always",
    });

    await expect(client.resolveApproval(KEY, "ap-2", "allow-always")).rejects.toThrow(
      /does not offer/,
    );
    await expect(
      client.resolveApproval(KEY, "ap-2", "allow-once", { expiresInDays: 3 }),
    ).rejects.toThrow(/Only a standing allow/);
    await client.resolveApproval(KEY, "ap-2", "deny");
    expect(gateway.calls("exec.approval.resolve").at(-1)).toEqual({ id: "ap-2", decision: "deny" });
    expect(transcript().approvals[1]!.status).toBe("denied");
    await expect(client.resolveApproval(KEY, "ap-2", "deny")).rejects.toThrow(/no longer open/);
    client.stop();
  });

  it("expires a pending approval at its expiry time", async () => {
    const gateway = approvalGateway();
    gateway.handlers["exec.approval.list"] = () => [
      { ...execItem("ap-1"), expiresAtMs: Date.now() + 60 },
    ];
    const { client, transcript } = await openTask(INTERACTIVE_SCOPES, gateway);
    await until(() => transcript().approvals.length === 1);
    gateway.handlers["exec.approval.list"] = () => [];
    await until(() => transcript().approvals[0]!.status === "expired");
    client.stop();
  });
});
