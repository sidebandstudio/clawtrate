// Messaged cards and MCP call cards as a view of steps (grok-bot-flows §6.1,
// §6.2). Steps are built by the engine from tool events shaped as in the
// capability map. Test names carry the parity rows they support.

import { beforeEach, describe, expect, it } from "vitest";
import {
  applyApprovalRequested,
  applyApprovalResolved,
  parsePluginApproval,
  resolutionFromSnapshot,
} from "../src/approvals.ts";
import {
  advanceBotMessageState,
  interSessionMessages,
  selectMessageCards,
  type CardInput,
  type CardOptions,
  type LinkedRun,
} from "../src/cards.ts";
import {
  applyAgentEvent,
  emptyActivity,
  RawTable,
  requestStop,
  runsFromHistory,
  type EngineContext,
  type TaskActivity,
} from "../src/runs.ts";

const KEY = "agent:pixel:main";
let raw: RawTable;
const ctx = (): EngineContext => ({ sessionKey: KEY, now: 5_000, raw });
beforeEach(() => {
  raw = new RawTable();
});

let seq = 0;
function tool(
  activity: TaskActivity,
  data: Record<string, unknown>,
  runId = "run-s",
): TaskActivity {
  seq += 1;
  return applyAgentEvent(
    activity,
    { runId, seq, stream: "tool", ts: 1_000 + seq, sessionKey: KEY, data },
    ctx(),
  ).activity;
}
function lifecycle(
  activity: TaskActivity,
  data: Record<string, unknown>,
  runId = "run-s",
): TaskActivity {
  seq += 1;
  return applyAgentEvent(
    activity,
    { runId, seq, stream: "lifecycle", ts: 1_000 + seq, sessionKey: KEY, data },
    ctx(),
  ).activity;
}

const sendArgs = {
  sessionKey: "agent:atlas:main",
  message: "Please list three colours.",
  timeoutSeconds: 60,
};

function startSend(
  id = "c1",
  args: Record<string, unknown> = sendArgs,
  base: TaskActivity = emptyActivity,
) {
  return tool(base, { phase: "start", name: "sessions_send", toolCallId: id, args });
}

function sendResult(
  activity: TaskActivity,
  details: Record<string, unknown>,
  id = "c1",
  isError = false,
) {
  return tool(activity, {
    phase: "result",
    name: "sessions_send",
    toolCallId: id,
    isError,
    result: { content: [{ type: "text", text: JSON.stringify(details) }], details },
  });
}

const OPTIONS: CardOptions = { codingServers: ["coder"] };
const select = (activity: TaskActivity, extra: Partial<CardInput> = {}, options = OPTIONS) =>
  selectMessageCards({ runs: activity.runs, approvals: activity.approvals, ...extra }, options);
const linked = (state: LinkedRun["state"]): Record<string, LinkedRun> => ({
  "run-r": {
    id: "run-r",
    sessionKey: "agent:atlas:main",
    state,
    outcomeKnown: true,
    startedAt: 1,
    endedAt: null,
  },
});

describe("Messaged cards (F-119, F-122, F-123, F-309)", () => {
  it("a started call is Started, delivery not established, with the recipient from the arguments", () => {
    const [card] = select(startSend()).botMessages;
    expect(card).toMatchObject({
      id: "tool:c1",
      state: "started",
      text: "Please list three colours.",
      recipient: {
        sessionKey: "agent:atlas:main",
        agentId: "atlas",
        label: null,
        source: "arguments",
      },
      reply: null,
      recipientRunId: null,
    });
  });

  it("takes the recipient from agentId or label when no session key is given, and guesses nothing else", () => {
    expect(
      select(startSend("c1", { agentId: "atlas", message: "hi" })).botMessages[0]!.recipient,
    ).toEqual({
      sessionKey: null,
      agentId: "atlas",
      label: null,
      source: "arguments",
    });
    expect(
      select(startSend("c1", { label: "Research", message: "hi" })).botMessages[0]!.recipient,
    ).toMatchObject({
      label: "Research",
      agentId: null,
    });
    expect(select(startSend("c1", {})).botMessages[0]).toMatchObject({
      recipient: { sessionKey: null, agentId: null, label: null, source: null },
      text: null,
    });
  });

  it("Replied when the result carries the reply; the recipient comes from the result's session key", () => {
    const activity = sendResult(startSend("c1", { agentId: "atlas", message: "hi" }), {
      runId: "run-r",
      status: "ok",
      sessionKey: "agent:atlas:main",
      delivery: { status: "skipped" },
      reply: "Red, green, blue.",
    });
    expect(select(activity).botMessages[0]).toMatchObject({
      state: "replied",
      reply: { text: "Red, green, blue." },
      recipient: { sessionKey: "agent:atlas:main", agentId: "atlas", source: "result" },
      recipientRunId: "run-r",
    });
  });

  it("follows the recipient's run once the send is accepted (F-469, F-434)", () => {
    const activity = sendResult(startSend(), {
      runId: "run-r",
      status: "accepted",
      sessionKey: "agent:atlas:main",
      targetDisposition: "queued",
      delivery: { status: "pending" },
    });
    const states = (
      [
        "queued",
        "running",
        "stopping",
        "waiting",
        "completed",
        "failed",
        "stopped",
        "cancelled",
      ] as const
    ).map((state) => select(activity, { linkedRuns: linked(state) }).botMessages[0]!.state);
    expect(states).toEqual([
      "working",
      "working",
      "working",
      "recipient-waiting",
      "no-reply-yet",
      "failed",
      "recipient-stopped",
      "recipient-stopped",
    ]);
    // Without the recipient's events the card says only that it was sent.
    expect(select(activity).botMessages[0]!.state).toBe("sent");
  });

  it("a queued result with no run id is Sent and nothing more", () => {
    const activity = sendResult(startSend(), {
      status: "queued",
      sessionKey: "agent:atlas:main",
      notificationId: "n1",
      durability: "process",
      runStarted: false,
    });
    expect(select(activity, { linkedRuns: linked("running") }).botMessages[0]).toMatchObject({
      state: "sent",
      recipientRunId: null,
    });
  });

  it("No reply yet, Blocked by policy and Failed from the result's own status", () => {
    const noReply = sendResult(startSend(), {
      runId: "run-r",
      status: "no_reply",
      sessionKey: "agent:atlas:main",
    });
    expect(select(noReply).botMessages[0]!.state).toBe("no-reply-yet");
    const forbidden = sendResult(startSend(), {
      runId: "run-r",
      status: "forbidden",
      error: "not allowed",
    });
    expect(select(forbidden).botMessages[0]).toMatchObject({
      state: "blocked-by-policy",
      error: "not allowed",
    });
    const error = sendResult(startSend(), {
      runId: "run-r",
      status: "error",
      error: "agent error",
      sentBeforeError: true,
    });
    expect(select(error).botMessages[0]).toMatchObject({ state: "failed", error: "agent error" });
    expect(select(error, { linkedRuns: linked("stopped") }).botMessages[0]!.state).toBe(
      "recipient-stopped",
    );
  });

  it("Unknown when the sender was stopped before a delivery result, or the call closed without one", () => {
    let stopped = startSend();
    stopped = requestStop(stopped, "run-s", 2_000);
    stopped = tool(stopped, {
      phase: "result",
      name: "sessions_send",
      toolCallId: "c1",
      isError: true,
      result: { content: [{ type: "text", text: "Aborted" }], details: { aborted: true } },
    });
    stopped = lifecycle(stopped, { phase: "end", aborted: true });
    expect(select(stopped).botMessages[0]).toMatchObject({
      state: "unknown",
      error: "Aborted",
      deliveryUncertain: true,
    });

    // A toolCall in history is the model's request; with no result it proves nothing was sent.
    const history = runsFromHistory(
      [
        { role: "user", content: "ask Atlas", __openclaw: { id: "u1", seq: 1 } },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "c9", name: "sessions_send", arguments: sendArgs }],
          __openclaw: { id: "a1", seq: 2, runId: "run-h" },
        },
      ],
      null,
      ctx(),
    );
    expect(select({ ...emptyActivity, runs: history }).botMessages[0]!.state).toBe("unknown");
  });

  it("an exchange read back from history is Replied: history keeps the send's status and reply only in the result's text (F-119)", () => {
    // As chat.history returns it: the toolResult row keeps details.sessionKey alone.
    const sent = {
      runId: "1f3cfe7f-0000-4000-8000-000000000001",
      sessionKey: "agent:atlas:main",
      status: "ok",
      delivery: { status: "skipped" },
      reply: "Happy to help.",
    };
    const rows = (result: Record<string, unknown>) => [
      { role: "user", content: "ask Atlas", __openclaw: { id: "u1", seq: 1 } },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c9",
            name: "sessions_send",
            arguments: { agentId: "atlas", message: "Could you look?", timeoutSeconds: 30 },
          },
        ],
        __openclaw: { id: "a1", seq: 2, runId: "run-h" },
      },
      {
        role: "toolResult",
        toolCallId: "c9",
        toolName: "sessions_send",
        isError: false,
        ...result,
        __openclaw: { id: "t1", seq: 3, runId: "run-h" },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Atlas replied." }],
        __openclaw: { id: "a2", seq: 4, runId: "run-h" },
      },
    ];
    // What the engine keeps of each history row, as the client reads it for a card.
    const card = (result: Record<string, unknown>) =>
      select(
        { ...emptyActivity, runs: runsFromHistory(rows(result), null, ctx()) },
        {},
        { ...OPTIONS, rawOf: (step) => step.raw ?? raw.get(KEY, step.id) },
      ).botMessages[0]!;
    const text = (value: unknown) => [{ type: "text", text: JSON.stringify(value, null, 2) }];
    expect(
      card({ details: { sessionKey: "agent:atlas:main" }, content: text(sent) }),
    ).toMatchObject({
      state: "replied",
      reply: { text: "Happy to help." },
      recipient: { sessionKey: "agent:atlas:main", agentId: "atlas" },
    });
    // The result's own details win over its text.
    expect(
      card({ details: { sessionKey: "agent:atlas:main", status: "queued" }, content: text(sent) })
        .state,
    ).toBe("sent");
    // A text that is not exactly one JSON object with a status says nothing more.
    for (const content of [
      [{ type: "text", text: "Delivered." }],
      [...text(sent), { type: "text", text: "and more" }],
      text([sent]),
      text({ reply: "no status" }),
    ]) {
      expect(card({ details: { sessionKey: "agent:atlas:main" }, content }).state).toBe("unknown");
    }
  });

  it("Waiting for approval, then Not sent when the approval is denied (F-312, F-436)", () => {
    let activity = startSend();
    activity = applyApprovalRequested(
      activity,
      parsePluginApproval({
        id: "pl-1",
        request: {
          title: "Message Atlas",
          description: "Pixel wants to message Atlas",
          severity: "info",
          toolCallId: "c1",
          sessionKey: KEY,
          runId: "run-s",
        },
        createdAtMs: 1,
        expiresAtMs: 9_000_000_000_000,
      })!,
    );
    expect(select(activity).botMessages[0]).toMatchObject({
      state: "waiting-for-approval",
      approvalId: "pl-1",
    });
    activity = applyApprovalResolved(
      activity,
      resolutionFromSnapshot({
        id: "pl-1",
        urlPath: "/a",
        createdAtMs: 1,
        expiresAtMs: 9_000_000_000_000,
        resolvedAtMs: 2,
        status: "denied",
        decision: "deny",
        reason: "user",
        presentation: {
          kind: "plugin",
          title: "Message another bot",
          description: "d",
          severity: "warning",
          allowedDecisions: ["allow-once", "deny"],
        },
      })!,
    );
    activity = tool(activity, {
      phase: "result",
      name: "sessions_send",
      toolCallId: "c1",
      isError: true,
      result: { content: [{ type: "text", text: "Denied" }], details: { status: "blocked" } },
    });
    expect(select(activity).botMessages[0]!.state).toBe("not-sent");
  });

  it("never attaches a late reply: it stays an incoming message (F-120)", () => {
    const activity = sendResult(startSend(), {
      runId: "run-r",
      status: "accepted",
      sessionKey: "agent:atlas:main",
    });
    const incoming = interSessionMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "Red, green, blue." }],
        provenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:atlas:main",
          sourceTool: "sessions_send",
        },
        senderLabel: "Forwarded from atlas",
        senderSession: { sessionKey: "agent:atlas:main", agentId: "atlas" },
        timestamp: 9,
        __openclaw: { id: "a7", seq: 7 },
      },
      { role: "assistant", content: "ordinary", __openclaw: { id: "a8", seq: 8 } },
    ]);
    expect(incoming).toEqual([
      {
        itemId: "a7:0",
        text: "Red, green, blue.",
        sourceSessionKey: "agent:atlas:main",
        sourceTool: "sessions_send",
        senderLabel: "Forwarded from atlas",
        senderAgentId: "atlas",
        timestamp: 9,
      },
    ]);
    const cards = select(activity, { interSession: incoming, linkedRuns: linked("completed") });
    expect(cards.botMessages[0]).toMatchObject({ state: "no-reply-yet", reply: null });
    expect(cards.incoming).toEqual(incoming);
  });

  it("moves only forward: a late send result never turns Working or Replied back (F-435)", () => {
    const accepted = sendResult(startSend(), {
      runId: "run-r",
      status: "accepted",
      sessionKey: "agent:atlas:main",
    });
    const working = select(accepted, { linkedRuns: linked("running") });
    expect(working.botMessages[0]!.state).toBe("working");
    // The recipient's events are gone (evicted); the card does not fall back to Sent.
    expect(select(accepted, {}, { ...OPTIONS, previous: working }).botMessages[0]!.state).toBe(
      "working",
    );
    expect(advanceBotMessageState("replied", "working")).toBe("replied");
    expect(advanceBotMessageState("no-reply-yet", "replied")).toBe("replied");
    expect(advanceBotMessageState("working", "recipient-waiting")).toBe("recipient-waiting");
    expect(advanceBotMessageState("recipient-waiting", "working")).toBe("working");
    expect(advanceBotMessageState("unknown", "sent")).toBe("sent");
    expect(advanceBotMessageState("started", "unknown")).toBe("unknown");
    expect(advanceBotMessageState("sent", "unknown")).toBe("sent");
  });

  it("one card per call; a replayed event updates it and never adds one", () => {
    let activity = sendResult(startSend(), { runId: "run-r", status: "ok", reply: "Yes." });
    activity = sendResult(activity, { runId: "run-r", status: "ok", reply: "Yes." });
    expect(select(activity).botMessages).toHaveLength(1);
  });
});

function mcpStart(
  activity: TaskActivity,
  id: string,
  name = "coder__send_message",
  args: Record<string, unknown> = { message: "Fix the failing login test" },
) {
  return tool(activity, { phase: "start", name, toolCallId: id, args });
}

function mcpResult(
  activity: TaskActivity,
  id: string,
  details: Record<string, unknown>,
  extra: { isError?: boolean; content?: unknown[]; name?: string } = {},
) {
  return tool(activity, {
    phase: "result",
    name: extra.name ?? "coder__send_message",
    toolCallId: id,
    isError: extra.isError ?? false,
    result: {
      content: extra.content ?? [{ type: "text", text: "structuredContent:\n{}" }],
      details,
    },
  });
}

const coderDetails = {
  mcpServer: "coder",
  mcpTool: "send_message",
  structuredContent: { threadId: "thread-1", reply: "On it." },
};

describe("MCP and coding-agent cards (F-132, F-133, F-135, F-137, F-313, F-314)", () => {
  it("does not parse a tool name: a started call is no card unless the caller maps its exact name", () => {
    const activity = mcpStart(emptyActivity, "m1");
    expect(select(activity).mcpCalls).toEqual([]);
    const mapped = selectMessageCards(
      { runs: activity.runs },
      {
        codingServers: ["coder"],
        mcpTools: { coder__send_message: { server: "coder", tool: "send_message" } },
      },
    );
    expect(mapped.mcpCalls[0]).toMatchObject({
      state: "started",
      server: "coder",
      tool: "send_message",
      codingAgent: true,
    });
  });

  it("Returned from the result's own server and tool, with what was sent and the result", () => {
    const activity = mcpResult(
      mcpStart(emptyActivity, "m1", "coder_x__send_message_2"),
      "m1",
      coderDetails,
      {
        name: "coder_x__send_message_2",
      },
    );
    expect(select(activity).mcpCalls[0]).toMatchObject({
      state: "returned",
      server: "coder",
      tool: "send_message",
      codingAgent: true,
      text: "Fix the failing login test",
      args: { message: "Fix the failing login test" },
      structuredContent: { threadId: "thread-1", reply: "On it." },
      result: { text: "structuredContent:\n{}" },
      files: [],
      links: [],
      workMayContinue: false,
    });
    // Another server is still a card, just not the coding agent.
    const other = mcpResult(
      mcpStart(emptyActivity, "m2", "files__read"),
      "m2",
      { mcpServer: "files", mcpTool: "read" },
      { name: "files__read" },
    );
    expect(select(other).mcpCalls[0]).toMatchObject({ server: "files", codingAgent: false });
  });

  it("attaches files and links only from the call's own result content (F-135)", () => {
    const activity = mcpResult(mcpStart(emptyActivity, "m1"), "m1", coderDetails, {
      content: [
        { type: "text", text: "done" },
        { type: "resource_link", uri: "https://example.com/pr/1", name: "Pull request" },
        {
          type: "resource",
          resource: { uri: "file:///report.md", name: "report.md", mimeType: "text/markdown" },
        },
      ],
    });
    expect(select(activity).mcpCalls[0]).toMatchObject({
      links: [{ uri: "https://example.com/pr/1", title: "Pull request" }],
      files: [{ name: "report.md", mimeType: "text/markdown", uri: "file:///report.md" }],
    });
  });

  it("Failed with the error text on a tool error (F-314)", () => {
    const activity = mcpResult(mcpStart(emptyActivity, "m1"), "m1", coderDetails, {
      isError: true,
      content: [{ type: "text", text: "thread not found" }],
    });
    expect(select(activity).mcpCalls[0]).toMatchObject({
      state: "failed",
      error: "thread not found",
    });
  });

  it("Unknown, with the returned error kept, when the result says the call was aborted; work may continue only after it returned (F-137, F-470)", () => {
    const known = {
      codingServers: ["coder"],
      mcpTools: { coder__send_message: { server: "coder", tool: "send_message" } },
    };
    let aborted = requestStop(mcpStart(emptyActivity, "m1"), "run-s", 2_000);
    aborted = mcpResult(
      aborted,
      "m1",
      { status: "aborted" },
      { isError: true, content: [{ type: "text", text: "Aborted" }] },
    );
    aborted = lifecycle(aborted, { phase: "end", aborted: true });
    expect(selectMessageCards({ runs: aborted.runs }, known).mcpCalls[0]).toMatchObject({
      state: "unknown",
      error: "Aborted",
      deliveryUncertain: true,
      workMayContinue: false,
    });

    let returned = mcpResult(mcpStart(emptyActivity, "m2"), "m2", coderDetails);
    returned = lifecycle(requestStop(returned, "run-s", 3_000), { phase: "end", aborted: true });
    expect(select(returned).mcpCalls[0]).toMatchObject({
      state: "returned",
      workMayContinue: true,
    });
  });

  it("two calls with the same text are two cards, and results land by their own ids (F-441, F-443, F-442)", () => {
    let activity = mcpStart(mcpStart(emptyActivity, "m1"), "m2");
    activity = mcpResult(activity, "m2", {
      ...coderDetails,
      structuredContent: { threadId: "t-2" },
    });
    activity = mcpResult(activity, "m1", {
      ...coderDetails,
      structuredContent: { threadId: "t-1" },
    });
    activity = mcpResult(activity, "m1", {
      ...coderDetails,
      structuredContent: { threadId: "t-1" },
    });
    const cards = select(activity).mcpCalls;
    expect(
      cards.map((card) => [card.id, (card.structuredContent as { threadId: string }).threadId]),
    ).toEqual([
      ["tool:m1", "t-1"],
      ["tool:m2", "t-2"],
    ]);
  });
});
