// Approval and question lists are read against a revision and the task's
// opening: a slow, older list changes nothing newer. A list refused for a
// missing scope drops that scope, and one kind failing is reported as such.
// Approvals raised by a messaged bot or a helper reach the task they came from
// and follow that run to its end.

import { describe, expect, it } from "vitest";
import { GatewayError, deferred, sleep, until } from "./fake-gateway.ts";
import { agentEvent, grantingGateway, KEY, openTask, questionRecord } from "./client-harness.ts";

function execItem(id: string, request: Record<string, unknown> = {}) {
  return {
    id,
    request: {
      command: "uname -s",
      host: "gateway",
      agentId: "otto",
      sessionKey: KEY,
      runId: "run-1",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      ...request,
    },
    createdAtMs: 2_000,
    expiresAtMs: 9_000_000_000_000,
  };
}

const pluginItem = (id: string) => ({
  id,
  request: { title: "T", description: "D", sessionKey: KEY },
  createdAtMs: 1,
  expiresAtMs: 9_999_999_999_999,
});

const systemAgentItem = (id: string) => ({
  id,
  request: {
    title: "OpenClaw change",
    description: "D",
    command: "D",
    proposalHash: "h",
    allowedDecisions: ["allow-once", "deny"],
    agentId: "otto",
    sessionKey: KEY,
    runId: "run-1",
  },
  createdAtMs: 1,
  expiresAtMs: 9_999_999_999_999,
});

const LISTS = [
  { method: "exec.approval.list", item: execItem },
  { method: "plugin.approval.list", item: pluginItem },
  { method: "openclaw.approval.list", item: systemAgentItem },
] as const;

/** Hold every call of a method; each call gets its own handle. */
function holdCalls(gateway: ReturnType<typeof grantingGateway>, method: string) {
  const held: Array<ReturnType<typeof deferred<unknown>>> = [];
  gateway.handlers[method] = () => {
    const call = deferred<unknown>();
    held.push(call);
    return call.promise;
  };
  return held;
}

describe("lists carry what they were requested against (B4)", () => {
  for (const list of LISTS) {
    it(`${list.method}: a list from an earlier opening adds nothing to the reopened task`, async () => {
      const gateway = grantingGateway();
      const { client, transcript } = await openTask({ gateway });
      await until(() => transcript().approvalAccess === "ready");
      const held = holdCalls(gateway, list.method);
      gateway.emit("session.message", { sessionKey: KEY });
      await until(() => held.length === 1);
      client.closeSession(KEY);
      gateway.handlers[list.method] = () => [];
      client.openSession(KEY);
      await until(() => client.state.transcripts[KEY]?.approvalAccess === "ready");
      held[0]!.resolve([list.item("old-opening")]);
      await sleep(40);
      expect(transcript().approvals).toEqual([]);
      client.stop();
    });

    it(`${list.method}: an older list that returns after a newer one changes nothing`, async () => {
      const gateway = grantingGateway();
      gateway.handlers[list.method] = () => [list.item("ap")];
      const { client, transcript } = await openTask({ gateway });
      await until(() => transcript().approvals.length === 1);
      const held = holdCalls(gateway, list.method);
      gateway.emit("session.message", { sessionKey: KEY });
      await until(() => held.length === 1);
      // A second read while the first list is out (an expiry or reconnect asks again).
      gateway.emit("session.message", { sessionKey: KEY });
      await until(() => held.length === 2);
      held[1]!.resolve([list.item("ap")]);
      await sleep(40);
      // The first list, older, omits it and lists another: neither is applied.
      held[0]!.resolve([list.item("ghost")]);
      await sleep(40);
      expect(transcript().approvals.map((each) => [each.id, each.status])).toEqual([
        ["ap", "pending"],
      ]);
      client.stop();
    });
  }

  it("question.list: an older list closes nothing and adds nothing", async () => {
    const gateway = grantingGateway();
    // The asking run stays in flight across the reloads.
    gateway.handlers["chat.history"] = () => ({ messages: [], inFlightRun: { runId: "run-1" } });
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().approvalAccess === "ready");
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    const held = holdCalls(gateway, "question.list");
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => held.length === 1);
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => held.length === 2);
    held[1]!.resolve({ questions: [questionRecord("ask_new", "run-1")] });
    await until(() => transcript().questions.length === 1);
    held[0]!.resolve({ questions: [questionRecord("ask_old", "run-1")] });
    await sleep(40);
    expect(transcript().questions.map((each) => [each.id, each.status])).toEqual([
      ["ask_new", "pending"],
    ]);

    // From an earlier opening: nothing.
    const again = holdCalls(gateway, "question.list");
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => again.length === 1);
    client.closeSession(KEY);
    gateway.handlers["question.list"] = () => ({ questions: [] });
    client.openSession(KEY);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    await sleep(20);
    again[0]!.resolve({ questions: [questionRecord("ask_stale", "run-1")] });
    await sleep(40);
    expect(transcript().questions.map((each) => each.id)).not.toContain("ask_stale");
    client.stop();
  });
});

const missingApprovals = () => {
  throw new GatewayError({
    code: "FORBIDDEN",
    message: "missing scope: operator.approvals",
    details: { code: "MISSING_SCOPE", missingScope: "operator.approvals" },
  });
};

describe("a list refused for a missing scope revokes approval access (B6)", () => {
  for (const list of LISTS) {
    it(`${list.method}: drops operator.approvals and stops asking, keeping read access`, async () => {
      const gateway = grantingGateway();
      gateway.handlers[list.method] = missingApprovals;
      const { client, transcript } = await openTask({ gateway });
      await until(() => !client.state.connection.canApprove);
      expect(client.state.connection.scopes).not.toContain("operator.approvals");
      expect(client.state.connection.scopes).toContain("operator.read");
      expect(client.state.connection.canWrite).toBe(true);
      await until(() => transcript().approvalAccess === "unavailable");
      const calls = gateway.calls(list.method).length;
      gateway.emit("session.message", { sessionKey: KEY });
      await sleep(250);
      // The refused list is not asked again on this connection.
      expect(gateway.calls(list.method).length).toBe(calls);
      expect(transcript().status).toBe("ready");
      client.stop();
    });
  }

  it("asks for access again on the next approval action, and recovers on the new grant", async () => {
    const gateway = grantingGateway();
    let refuse = true;
    gateway.handlers["exec.approval.list"] = () => {
      if (refuse) missingApprovals();
      return [execItem("ap-1")];
    };
    gateway.handlers["exec.approval.resolve"] = () => ({ ok: true });
    const wait = deferred<unknown>();
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().approvalAccess === "unavailable");
    gateway.emit("exec.approval.requested", execItem("ap-1"));
    await until(() => transcript().approvals.length === 1);
    const resolving = client.resolveApproval(KEY, "ap-1", "deny");
    await until(() => gateway.calls("device.scopes.requestUpgrade").length === 1);
    expect(gateway.calls("exec.approval.resolve")).toEqual([]);
    refuse = false;
    wait.resolve({
      status: "approved",
      requestId: "up-1",
      deviceToken: "rotated",
      scopes: ["operator.read", "operator.write", "operator.approvals", "operator.questions"],
    });
    await resolving;
    expect(gateway.calls("exec.approval.resolve")).toEqual([{ id: "ap-1", decision: "deny" }]);
    await until(() => transcript().approvalAccess === "ready");
    expect(client.state.connection.canApprove).toBe(true);
    expect(transcript().approvals[0]!.status).toBe("denied");
    client.stop();
  });

  it("reports one kind failing as partial, not as no approvals", async () => {
    const gateway = grantingGateway();
    gateway.handlers["exec.approval.list"] = () => [execItem("ap-1")];
    gateway.handlers["plugin.approval.list"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "plugin approvals unavailable" });
    };
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().approvalSources.plugin === "error");
    await until(() => transcript().approvalAccess === "partial");
    expect(transcript().approvalSources).toEqual({
      exec: "ready",
      plugin: "error",
      "system-agent": "ready",
    });
    expect(transcript().approvals.map((each) => each.id)).toEqual(["ap-1"]);
    expect(client.state.connection.canApprove).toBe(true);
    // A retry that succeeds makes it whole.
    gateway.handlers["plugin.approval.list"] = () => [];
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => transcript().approvalAccess === "ready");
    client.stop();
  });
});

const PEER = "agent:atlas:main";
const sendResult = (runId: string, sessionKey = PEER) => ({
  runId: "run-s",
  seq: 3,
  stream: "tool",
  ts: 1_003,
  sessionKey: KEY,
  data: {
    phase: "result",
    name: "sessions_send",
    toolCallId: "call_send",
    isError: false,
    result: {
      content: [{ type: "text", text: "{}" }],
      details: { status: "accepted", runId, sessionKey },
    },
  },
});

describe("approvals raised by a messaged bot or a helper (D1)", () => {
  async function sender() {
    const opened = await openTask();
    await until(() => opened.transcript().approvalAccess === "ready");
    opened.gateway.emit("agent", agentEvent("run-s", 1, "lifecycle", { phase: "start" }));
    opened.gateway.emit(
      "agent",
      agentEvent("run-s", 2, "tool", {
        phase: "start",
        name: "sessions_send",
        toolCallId: "call_send",
        args: { sessionKey: PEER, message: "Please check" },
      }),
    );
    return opened;
  }

  it("shows a messaged bot's approval in the sending task, with its origin", async () => {
    const { client, gateway, transcript } = await sender();
    gateway.emit("agent", sendResult("run-r"));
    // The recipient's events carry no spawnedBy: it was messaged, not spawned.
    gateway.emit("agent", agentEvent("run-r", 1, "lifecycle", { phase: "start" }, PEER));
    gateway.emit(
      "exec.approval.requested",
      execItem("ap-r", { sessionKey: PEER, runId: "run-r", agentId: "atlas" }),
    );
    await until(() => transcript().approvals.length === 1);
    expect(transcript().approvals[0]).toMatchObject({
      id: "ap-r",
      sessionKey: PEER,
      agentId: "atlas",
      runId: "run-r",
      parentSessionKey: KEY,
      relation: "messaged",
      status: "pending",
    });
    expect(client.state.unroutedApprovals).toEqual([]);
    client.stop();
  });

  it("keeps one that arrives before the send result, and places it once the result names the run", async () => {
    const { client, gateway, transcript } = await sender();
    gateway.emit(
      "exec.approval.requested",
      execItem("ap-r", { sessionKey: PEER, runId: "run-r", agentId: "atlas" }),
    );
    await until(() => client.state.unroutedApprovals.length === 1);
    expect(transcript().approvals).toEqual([]);
    gateway.emit("agent", sendResult("run-r"));
    await until(() => transcript().approvals.length === 1);
    expect(transcript().approvals[0]).toMatchObject({
      relation: "messaged",
      parentSessionKey: KEY,
    });
    expect(client.state.unroutedApprovals).toEqual([]);
    client.stop();
  });

  it("finds it on a fresh opening from the send in history", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({
      messages: [
        { role: "user", content: "Ask Atlas", __openclaw: { id: "u1", seq: 1 } },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_send",
              name: "sessions_send",
              arguments: { sessionKey: PEER },
            },
          ],
          __openclaw: { id: "a1", seq: 2, runId: "run-s" },
        },
        {
          role: "toolResult",
          toolCallId: "call_send",
          isError: false,
          content: [{ type: "text", text: "{}" }],
          details: { status: "accepted", runId: "run-r", sessionKey: PEER },
          __openclaw: { id: "t1", seq: 3, runId: "run-s" },
        },
      ],
      inFlightRun: { runId: "run-s" },
    });
    gateway.handlers["exec.approval.list"] = () => [
      execItem("ap-r", { sessionKey: PEER, runId: "run-r", agentId: "atlas" }),
    ];
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().approvals.length === 1);
    expect(transcript().approvals[0]).toMatchObject({ id: "ap-r", relation: "messaged" });
    client.stop();
  });

  it("follows a helper's run to its end: the approval says it outlived its run", async () => {
    const { client, gateway, transcript } = await openTask();
    await until(() => transcript().approvalAccess === "ready");
    const helper = "agent:otto:subagent:sweep";
    gateway.emit("agent", {
      ...agentEvent("run-h", 1, "lifecycle", { phase: "start" }, helper),
      spawnedBy: KEY,
    });
    gateway.emit(
      "exec.approval.requested",
      execItem("ap-h", { sessionKey: helper, runId: "run-h", toolCallId: "call_h" }),
    );
    await until(() => transcript().approvals.length === 1);
    expect(transcript().approvals[0]).toMatchObject({ relation: "helper", runEnded: false });
    gateway.emit("agent", agentEvent("run-h", 2, "lifecycle", { phase: "end" }, helper));
    await until(() => transcript().approvals[0]!.runEnded);
    expect(transcript().approvals[0]!.status).toBe("pending");
    client.stop();
  });

  it("follows a messaged bot's run to its end", async () => {
    const { client, gateway, transcript } = await sender();
    gateway.emit("agent", sendResult("run-r"));
    gateway.emit("agent", agentEvent("run-r", 1, "lifecycle", { phase: "start" }, PEER));
    gateway.emit("exec.approval.requested", execItem("ap-r", { sessionKey: PEER, runId: "run-r" }));
    await until(() => transcript().approvals.length === 1);
    gateway.emit("agent", agentEvent("run-r", 2, "lifecycle", { phase: "end" }, PEER));
    await until(() => transcript().approvals[0]!.runEnded);
    client.stop();
  });

  it("places a helper approval that came before its spawn was known", async () => {
    const { client, gateway, transcript } = await openTask();
    await until(() => transcript().approvalAccess === "ready");
    const helper = "agent:otto:subagent:late";
    gateway.emit(
      "exec.approval.requested",
      execItem("ap-h", { sessionKey: helper, runId: "run-h" }),
    );
    await until(() => client.state.unroutedApprovals.length === 1);
    gateway.emit("agent", {
      ...agentEvent("run-h", 1, "lifecycle", { phase: "start" }, helper),
      spawnedBy: KEY,
    });
    await until(() => transcript().approvals.length === 1);
    expect(transcript().approvals[0]!.relation).toBe("helper");
    expect(client.state.unroutedApprovals).toEqual([]);
    client.stop();
  });
});

describe("a failed list leaves state as it was (A10, ruling 4)", () => {
  const unavailable = () =>
    new GatewayError({ code: "UNAVAILABLE", message: "no current approvals view" });
  const kindOf = {
    "exec.approval.list": "exec",
    "plugin.approval.list": "plugin",
    "openclaw.approval.list": "system-agent",
  } as const;

  for (const list of LISTS) {
    const kind = kindOf[list.method];

    it(`${list.method}: a newer list fails, then an older one returns: nothing old is added`, async () => {
      const { client, gateway, transcript } = await openTask();
      await until(() => transcript().approvalAccess === "ready");
      const held = holdCalls(gateway, list.method);
      gateway.emit("session.message", { sessionKey: KEY });
      await until(() => held.length === 1);
      gateway.emit("session.message", { sessionKey: KEY });
      await until(() => held.length === 2);
      held[1]!.reject(unavailable());
      await until(() => transcript().approvalSources[kind] === "error");
      held[0]!.resolve([list.item("old")]);
      await sleep(40);
      expect(transcript().approvalSources[kind]).toBe("error");
      expect(transcript().approvals).toEqual([]);
      client.stop();
    });

    it(`${list.method}: an older list fails after a newer one succeeded: the newer stands`, async () => {
      const { client, gateway, transcript } = await openTask();
      await until(() => transcript().approvalAccess === "ready");
      const held = holdCalls(gateway, list.method);
      gateway.emit("session.message", { sessionKey: KEY });
      await until(() => held.length === 1);
      gateway.emit("session.message", { sessionKey: KEY });
      await until(() => held.length === 2);
      held[1]!.resolve([list.item("new")]);
      await until(() => transcript().approvals.length === 1);
      held[0]!.reject(unavailable());
      await sleep(40);
      expect(transcript().approvalSources[kind]).toBe("ready");
      expect(transcript().approvals.map((each) => [each.id, each.status])).toEqual([
        ["new", "pending"],
      ]);
      client.stop();
    });

    it(`${list.method}: a newer refusal for the scope, then an older success: unavailable, nothing added, and back after a new grant`, async () => {
      const gateway = grantingGateway();
      const wait = deferred<unknown>();
      gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
      gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
      const { client, transcript } = await openTask({ gateway });
      await until(() => transcript().approvalAccess === "ready");
      const held = holdCalls(gateway, list.method);
      gateway.emit("session.message", { sessionKey: KEY });
      await until(() => held.length === 1);
      gateway.emit("session.message", { sessionKey: KEY });
      await until(() => held.length === 2);
      held[1]!.reject(
        new GatewayError({
          code: "FORBIDDEN",
          message: "missing scope: operator.approvals",
          details: { code: "MISSING_SCOPE", missingScope: "operator.approvals" },
        }),
      );
      await until(() => !client.state.connection.canApprove);
      held[0]!.resolve([list.item("old")]);
      await sleep(40);
      expect(transcript().approvals).toEqual([]);
      expect(transcript().approvalSources[kind]).toBe("unavailable");
      // A new grant reads the lists again.
      gateway.handlers[list.method] = () => [list.item("fresh")];
      void client.requestAccess();
      await until(() => gateway.calls("device.scopes.requestUpgrade").length === 1);
      wait.resolve({
        status: "approved",
        requestId: "up-1",
        deviceToken: "rotated",
        scopes: ["operator.read", "operator.write", "operator.approvals", "operator.questions"],
      });
      await until(() => transcript().approvals.some((each) => each.id === "fresh"));
      expect(transcript().approvalSources[kind]).toBe("ready");
      client.stop();
    });
  }

  it("question.list: a newer list fails, then an older one returns: nothing old is added", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({ messages: [], inFlightRun: { runId: "run-1" } });
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().approvalAccess === "ready");
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    const held = holdCalls(gateway, "question.list");
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => held.length === 1);
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => held.length === 2);
    held[1]!.reject(unavailable());
    await sleep(20);
    held[0]!.resolve({ questions: [questionRecord("ask_old", "run-1")] });
    await sleep(40);
    expect(transcript().questions).toEqual([]);
    client.stop();
  });

  it("question.list: an older list fails after a newer one succeeded: the newer stands", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({ messages: [], inFlightRun: { runId: "run-1" } });
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().approvalAccess === "ready");
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    const held = holdCalls(gateway, "question.list");
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => held.length === 1);
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => held.length === 2);
    held[1]!.resolve({ questions: [questionRecord("ask_new", "run-1")] });
    await until(() => transcript().questions.length === 1);
    held[0]!.reject(unavailable());
    await sleep(40);
    expect(transcript().questions.map((each) => [each.id, each.status])).toEqual([
      ["ask_new", "pending"],
    ]);
    client.stop();
  });
});

describe("an approval this client closed by inference is read back for how it ended", () => {
  it("F-164: one no longer listed takes the gateway's outcome and terminal reason from approval.get", async () => {
    const gateway = grantingGateway();
    gateway.handlers["exec.approval.list"] = () => [execItem("ap")];
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().approvals[0]?.status === "pending");
    // Recorded shape: approval.get of a settled request answers its terminal snapshot, whose
    // `reason` is the gateway's terminal reason (`record.terminalReason`).
    gateway.handlers["approval.get"] = () => ({
      approval: {
        id: "ap",
        status: "expired",
        presentation: { kind: "exec", commandText: "uname -s", host: "gateway", agentId: "otto" },
        createdAtMs: 2_000,
        expiresAtMs: 1_802_000,
        resolvedAtMs: 1_802_000,
        reason: "timeout",
        source: { agentId: "otto", sessionKey: KEY },
      },
    });
    gateway.handlers["exec.approval.list"] = () => [];
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => gateway.calls("approval.get").length === 1);
    expect(gateway.calls("approval.get")[0]).toEqual({ id: "ap" });
    await until(() => transcript().approvals[0]?.inferred === false);
    expect(transcript().approvals[0]).toMatchObject({
      status: "expired",
      reason: "timeout",
      resolvedAt: 1_802_000,
    });
    // Asked once, when the inference was made: a later list does not ask again.
    gateway.emit("session.message", { sessionKey: KEY });
    await sleep(300);
    expect(gateway.calls("approval.get")).toHaveLength(1);
    client.stop();
  });
});
