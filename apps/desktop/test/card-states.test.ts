// Every card state in the fixture mode, from the engine's own state: each
// scene is built by the engine's reducers from gateway-shaped events, and the
// card's words come from the same selection and wording the interface uses.
import {
  applyAgentEvent,
  emptyActivity,
  initialState,
  applyApprovalRequested,
  applyQuestionRequested,
  parseExecApproval,
  parsePluginApproval,
  RawTable,
  type TaskActivity,
  type ApprovalCard,
  type ClawtrateState,
  type QuestionCard,
  type Run,
  type Step,
  type Transcript,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import {
  allowLabel,
  answeredRows,
  approvalView,
  botMessageKey,
  botMessageNote,
  decisionPhase,
  expiryLine,
  mayDispatch,
  mcpKey,
  resultLink,
  MESSAGED_STATES,
  sentVerb,
  type MessagedKey,
  mcpNote,
  questionNote,
  resolvedView,
  sendableDecisions,
  SUMMARY_COMMAND_CHARS,
  targetChips,
} from "../../../packages/ui/src/cards/model.ts";
import { placeCards } from "../../../packages/ui/src/cards/placement.ts";
import { selectCards, T3_CODE_TOOLS } from "../../../packages/ui/src/cards/useCards.ts";
import {
  CARD_SCENES,
  CARD_TASK,
  cardScene,
  RECEIVING_TASK,
  wholeApproval,
  type CardSceneName,
} from "../src/fixture/cards.ts";

const NOW = Date.parse("2026-11-16T17:40:00-05:00");
// The fixture's own bots draw a picture with a canvas; these two are all the scenes name.
const bots = ["otto", "marlow"].map((id) => ({
  id,
  name: id === "otto" ? "Otto" : "Marlow",
  emoji: null,
  avatarUrl: null,
  theme: null,
  model: null,
  isDefault: false,
}));
const otto = bots[0];

function scene(name: CardSceneName): { state: ClawtrateState; transcript: Transcript } {
  const base: ClawtrateState = {
    ...initialState,
    bots,
    connection: { ...initialState.connection, status: "connected" },
  };
  const built = cardScene(name, NOW);
  const state = built.change(base);
  return { state, transcript: state.transcripts[built.task]! };
}

const approval = (name: CardSceneName): { card: ApprovalCard; run: Run | undefined } => {
  const { transcript } = scene(name);
  const card = transcript.approvals[0]!;
  return { card, run: transcript.runs.find((run) => run.id === card.runId) };
};

const question = (name: CardSceneName): { card: QuestionCard; run: Run | undefined } => {
  const { transcript } = scene(name);
  const card = transcript.questions[0]!;
  return { card, run: transcript.runs.find((run) => run.id === card.runId) };
};

const rawOf = (step: Step) => step.raw;
const cards = (name: CardSceneName) => {
  const { transcript } = scene(name);
  // No server is named as T3 Code: its calls are known by T3 Code's own tool names.
  return { transcript, selected: selectCards(transcript, [], rawOf) };
};

describe("approval cards from the engine's state", () => {
  it("F-163 F-171 F-168 F-329: a pending command names the bot, what it runs and where, its warnings and its expiry; only offered decisions show, and Deny always", () => {
    const { card } = approval("approval-pending");
    const view = approvalView(card, bots, otto);
    expect(view.title).toBe("Otto wants to run a command");
    expect(view.summary).toEqual({
      lead: "Run ",
      code: "mv /srv/media/transcode-cache /srv/scratch/transcode-cache",
      codeFull: null,
      middle: " on ",
      machine: "media-box",
    });
    expect(view.warnings).toEqual(["This can't be undone"]);
    expect(expiryLine(card, NOW)).toBe("Expires in 28 minutes; the command is not run if it does.");
    expect([view.once, view.always, allowLabel(view)]).toEqual([true, true, "Allow once"]);
    expect([...sendableDecisions(card, false)].sort()).toEqual([
      "allow-always",
      "allow-once",
      "deny",
    ]);

    const only = approval("approval-allow-only").card;
    const onlyView = approvalView(only, bots, otto);
    expect([onlyView.once, onlyView.always, allowLabel(onlyView)]).toEqual([true, false, "Allow"]);
    expect([...sendableDecisions(only, false)].sort()).toEqual(["allow-once", "deny"]);
  });

  it("F-164: the full request carries the exact command and the request's own fields", () => {
    const view = approvalView(approval("approval-pending").card, bots, otto);
    expect(view.exact).toEqual({
      label: "Command",
      text: "mv /srv/media/transcode-cache /srv/scratch/transcode-cache",
    });
    expect(view.rows.map((row) => row.label)).toEqual([
      "Arguments",
      "Runs on",
      "Folder",
      "Asked by",
      "Warning",
    ]);
    expect(view.argv).toEqual(["mv", "/srv/media/transcode-cache", "/srv/scratch/transcode-cache"]);
  });

  it("F-167: the form shows the request's fields and says in words what the gateway keeps; days only for a routine's grant", () => {
    const ordinary = approvalView(approval("approval-pending").card, bots, otto);
    expect(ordinary.form.rows.map((row) => row.label)).toEqual([
      "Command",
      "Arguments",
      "Folder",
      "Runs on",
      "Bot",
    ]);
    expect(ordinary.form.days).toBe(false);
    expect(ordinary.form.sentence).toBe(
      "The gateway will add this to media-box's allowlist, so Otto is not asked again for commands it matches. The gateway decides what that covers; it can be wider than this exact command.",
    );
    const routine = approvalView(approval("approval-routine").card, bots, otto);
    expect(routine.form.days).toBe(true);
    expect(routine.form.rows.at(-1)).toEqual({ label: "For", value: "The routine Weekly cleanup" });
    expect(routine.form.sentence).toBe(
      "The routine Weekly cleanup may run this command without asking.",
    );
    // The field starts from the gateway's default lifetime, when it is whole days from 1 to 3650.
    expect(routine.form.defaultDays).toBe(7);
    expect(ordinary.form.defaultDays).toBe(null);
    const routineCard = approval("approval-routine").card;
    const scope = routineCard.scope as Record<string, unknown>;
    const withDays = (expiresInDays: unknown) =>
      approvalView({ ...routineCard, scope: { ...scope, expiresInDays } }, bots, otto).form
        .defaultDays;
    expect(withDays(undefined)).toBe(null);
    expect(withDays(3650)).toBe(3650);
    for (const bad of [0, 3651, 1.5, "7", null]) expect(withDays(bad)).toBe(null);
  });

  it("F-163: sending, refused and unknown decisions; an unknown outcome offers only Deny", () => {
    expect(decisionPhase(approval("approval-sending").card)).toBe("sending");
    const refused = approval("approval-refused").card;
    expect([decisionPhase(refused), refused.stillOpen]).toEqual(["refused", true]);
    const unknown = approval("approval-unknown").card;
    expect(decisionPhase(unknown)).toBe("unknown");
    expect([...sendableDecisions(unknown, true)]).toEqual(["deny"]);
  });

  it("F-163: a request whose text the engine cut offers only Deny until it is read whole, and the read gives the whole digest", () => {
    const { card } = approval("approval-cut");
    expect(card.decisionCut).toBe(true);
    expect([...sendableDecisions(card, false)]).toEqual(["deny"]);
    expect(sendableDecisions(card, true).has("allow-once")).toBe(true);
    const whole = wholeApproval("approval-cut", NOW, card.id)!;
    expect(whole.decisionDigest).toBe(card.decisionDigest);
    expect(whole.exec!.command!.length).toBeGreaterThan(card.exec!.command!.length);
  });

  it("F-163: who asks: a helper, a messaged bot, a plugin", () => {
    const helper = approvalView(approval("approval-helper").card, bots, otto);
    expect([helper.title, helper.askerLine]).toEqual([
      "A helper of Otto wants to run a command",
      "Asked by a helper Otto started for this task.",
    ]);
    const messaged = approvalView(approval("approval-messaged").card, bots, otto);
    expect([messaged.title, messaged.askerLine]).toEqual([
      "Marlow wants to run a command",
      "Marlow is working on a message from Otto.",
    ]);
    const plugin = approvalView(approval("approval-plugin").card, bots, otto);
    expect(plugin.title).toBe("Otto asks for approval");
    expect(plugin.always).toBe(false);
  });

  it("F-418: a request still pending after its run ended stays answerable (conversation.md section 12)", () => {
    const { card, run } = approval("approval-run-ended");
    expect([card.status, card.runEnded, run?.state]).toEqual(["pending", true, "completed"]);
    expect([...sendableDecisions(card, false)].sort()).toEqual([
      "allow-always",
      "allow-once",
      "deny",
    ]);
  });

  it("F-325 F-165 F-168 F-169 F-032: each settled outcome says what the gateway reported and no more", () => {
    const words = (name: CardSceneName) => {
      const { card, run } = approval(name);
      return resolvedView(card, bots, otto, run);
    };
    expect(words("approval-allowed-once")).toMatchObject({
      tag: "Allowed once",
      sentence: "Allowed once. The command can run now. Otto will ask again next time.",
    });
    expect(words("approval-always-allowlist")).toMatchObject({
      tag: "Always allowed",
      sentence: "Allowed, and saved. The command can run now.",
      saved:
        "Added to media-box's allowlist. The gateway decides what it covers. Seeing that list needs admin access.",
    });
    expect(words("approval-always-routine").saved).toBe(
      "The routine Weekly cleanup may run this command without asking.",
    );
    expect(words("approval-denied")).toMatchObject({
      tag: "Denied",
      sentence: "Denied. The command was not run.",
    });
    expect(words("approval-expired").tag).toBe("Expired");
    expect(words("approval-expired").sentence).toMatch(
      /^Expired at \d+:\d\d [AP]M without an answer\. The command was not run\.$/,
    );
    expect(words("approval-cancelled")).toMatchObject({
      tag: "Cancelled",
      sentence: "You stopped the run before answering. The command was not run.",
    });
    expect(words("approval-closed-ended")).toMatchObject({
      tag: "Closed: the run ended",
      sentence: "The run ended before this was answered. The command was not run.",
    });
    expect(words("approval-closed-failed")).toMatchObject({
      tag: "Closed: the run failed",
      sentence: "The run failed before this was answered. The command was not run.",
    });
    // Not listed after a reload says nothing about how it ended: no claim that it was not run.
    expect(words("approval-closed-unknown").sentence).not.toMatch(/not run/);
    expect(words("approval-winner").winner).toMatch(
      /^Decided by Pip's laptop at .*\. Your decision was not applied\.$/,
    );
  });
});

describe("question cards from the engine's state", () => {
  it("F-112 F-006: ordinary records are answerable; any other is readable only", () => {
    for (const name of ["question-single", "question-multi", "question-three"] as CardSceneName[]) {
      expect(question(name).card.ordinary, name).toBe(true);
    }
    expect(question("question-unanswerable").card.ordinary).toBe(false);
    const single = question("question-single").card;
    expect(single.questions[0]!.options.map((option) => option.description)).toEqual([
      "Delete it next Monday",
      null,
      "Keep it and remind me",
      null,
    ]);
    expect(single.questions[0]!.allowsOther).toBe(true);
  });

  it("F-113 F-114 F-303: answered rows show the letter and the answer, typed text as typed", () => {
    const rows = (name: CardSceneName) => {
      const { card } = question(name);
      return answeredRows(card.questions[0]!, card.answers?.[card.questions[0]!.id]);
    };
    expect(rows("question-answered")).toEqual([{ letter: "A", text: "A week" }]);
    expect(rows("question-answered-typed")).toEqual([
      { letter: null, text: "Two weeks, then ask me" },
    ]);
    expect(rows("question-answered-multi")).toEqual([
      { letter: "A", text: "media-box" },
      { letter: "C", text: "attic-nas" },
    ]);
    expect(question("question-multi").card.questions[0]!.multiSelect).toBe(true);
  });

  it("F-302: dismissed, expired, cancelled and closed questions say so", () => {
    const note = (name: CardSceneName) => {
      const { card, run } = question(name);
      return questionNote(card, run);
    };
    expect(note("question-dismissed")).toBe("Dismissed");
    expect(note("question-expired")).toBe("Expired without an answer");
    expect(note("question-cancelled")).toBe("Cancelled: you stopped the run");
    expect(note("question-closed-ended")).toBe("Closed: the run ended");
    expect(note("question-closed-failed")).toBe("Closed: the run failed");
  });
});

describe("Messaged cards from the engine's state", () => {
  const expected: Array<[CardSceneName, string]> = [
    ["messaged-started", "call-started"],
    ["messaged-approval", "approval"],
    ["messaged-sent", "sent"],
    ["messaged-working", "working"],
    ["messaged-recipient-waiting", "recipient-waiting"],
    ["messaged-no-reply", "no-reply"],
    ["messaged-no-reply-timeout", "no-reply"],
    ["messaged-replied", "replied"],
    ["messaged-recipient-stopped", "recipient-stopped"],
    ["messaged-recipient-failed", "recipient-failed"],
    ["messaged-failed", "failed"],
    ["messaged-blocked", "blocked"],
    ["messaged-not-sent", "not-sent"],
    ["messaged-unknown", "unknown"],
  ];

  it("F-119 F-122 F-434 F-469: every state of a message to another bot comes from the events that establish it", () => {
    for (const [name, key] of expected) {
      const { selected } = cards(name);
      const card = selected.botMessages.find((each) => each.id === "tool:call_msg");
      expect(card, name).toBeDefined();
      expect(botMessageKey(card!), name).toBe(key);
    }
  });

  it("F-123 F-438: the card carries the exact text sent, the reply and the recipient's run", () => {
    const replied = cards("messaged-replied").selected.botMessages.at(-1)!;
    expect(replied.text).toMatch(/^Write a two-line entry for the house log/);
    expect(replied.reply?.text).toMatch(/^Nov 16/);
    expect(replied.recipient).toMatchObject({ agentId: "marlow", source: "result" });
    const working = cards("messaged-working").selected.botMessages[0]!;
    expect([working.recipientRunId, working.recipientRunState]).toEqual(["run_m42b", "running"]);
  });

  it("F-122: what the open card says for states that are a sentence", () => {
    const say = (name: CardSceneName) => {
      const { transcript, selected } = cards(name);
      const card = selected.botMessages[0]!;
      const run = transcript.runs.find((each) => each.id === card.runId);
      return botMessageNote(
        botMessageKey(card),
        card,
        { sender: "Otto", recipient: "Marlow" },
        transcript.approvals,
        run,
      );
    };
    expect(say("messaged-started")).toBe(
      "Otto began this call. Nothing yet shows that it was made.",
    );
    expect(say("messaged-approval")).toBe(
      "This message waits for your approval. Nothing has been sent.",
    );
    expect(say("messaged-sent")).toBe("Marlow received it. No reply yet.");
    expect(say("messaged-no-reply-timeout")).toMatch(
      /^The message was sent, and no reply came in time\./,
    );
    expect(say("messaged-recipient-stopped")).toBe(
      "Marlow's run for this message was stopped before it replied.",
    );
    expect(say("messaged-not-sent")).toBe("You denied the approval. Nothing was sent.");
    expect(say("messaged-unknown")).toBe(
      "Otto was stopped before the call returned. The gateway cannot say whether Marlow received it.",
    );
    expect(say("messaged-blocked")).toBe(
      "A messaging rule stopped this: Otto may not message Marlow's tasks. Nothing was sent.",
    );
  });

  it("F-439 F-120 F-125: the card sits under the message that started its run; an incoming message is a card or a line", () => {
    const { transcript, selected } = cards("messaged-replied");
    const placement = placeCards(transcript, selected);
    expect(placement.afterItem.get(transcript.items[0]!.id)).toEqual([
      { kind: "bot-message", id: "tool:call_msg0" },
      { kind: "bot-message", id: "tool:call_msg" },
    ]);
    const received = scene("received-working").transcript;
    expect(received.sessionKey).toBe(RECEIVING_TASK);
    const placed = placeCards(received, selectCards(received, [], rawOf));
    expect([...placed.incoming.keys()]).toEqual(["m-in:0"]);
    expect(received.runs[0]!.anchorItemId).toBe("m-in:0");
    const late = scene("incoming-line").transcript;
    expect([...placeCards(late, selectCards(late, [], rawOf)).incoming.keys()]).toEqual([
      "m-late:1",
    ]);
    expect(late.runs.some((run) => run.anchorItemId === "m-late:1")).toBe(false);
  });
});

describe("Messaged T3 Code cards from the engine's state", () => {
  it("F-132 F-134 F-314 F-470: every state, from the bot's own tool events only", () => {
    const expected: Array<[CardSceneName, string]> = [
      ["t3-started", "call-started"],
      ["t3-approval", "approval"],
      ["t3-call-made", "call-made"],
      ["t3-work-may-continue", "call-made"],
      ["t3-delivery-unknown", "delivery-unknown"],
      ["t3-failed", "failed"],
      ["t3-not-sent", "not-sent"],
    ];
    for (const [name, key] of expected) {
      const { transcript, selected } = cards(name);
      const calls = selected.mcpCalls.filter((card) => card.codingAgent);
      expect(calls, name).toHaveLength(1);
      const step = transcript.runs[0]!.steps.find((each) => each.id === calls[0]!.stepId);
      expect(mcpKey(calls[0]!, transcript.approvals, step?.status === "waiting"), name).toBe(key);
    }
    expect(cards("t3-failed").selected.mcpCalls[0]!.error).toMatch(/ECONNREFUSED/);
  });

  it("F-133 F-135: the sent text, the target fields it carries, the result's own files and link", () => {
    const call = cards("t3-call-made").selected.mcpCalls[0]!;
    expect(call.text).toMatch(/^In backup-scripts/);
    expect(targetChips(call.args)).toEqual([
      { label: "Project", value: "backup-scripts" },
      { label: "Branch", value: "main" },
    ]);
    expect(call.files.map((file) => file.name)).toEqual(["plan.md"]);
    expect(resultLink(call)).toEqual({
      uri: "https://t3.example.test/projects/backup-scripts/threads/18",
      title: null,
    });
    // A call with no link in its result offers none.
    expect(resultLink(cards("t3-failed").selected.mcpCalls[0]!)).toBeNull();
  });

  it("F-137: after a stop, a call that returned keeps Call made and says work may continue; one that had not returned is Delivery unknown", () => {
    const made = cards("t3-work-may-continue").selected.mcpCalls[0]!;
    expect([made.state, made.workMayContinue]).toEqual(["returned", true]);
    const { transcript, selected } = cards("t3-delivery-unknown");
    const unknown = selected.mcpCalls[0]!;
    expect(mcpNote("delivery-unknown", unknown, "Otto", [], transcript.runs[0])).toBe(
      "Otto was stopped before the call returned. The gateway cannot say whether T3 Code received it.",
    );
  });

  it("F-441: two calls with no identifier between them are two cards", () => {
    const { transcript } = cards("t3-call-made");
    const run = transcript.runs[0]!;
    const second: Step = {
      ...run.steps[0]!,
      id: "tool:call_t3b",
      toolCallId: "call_t3b",
      raw: run.steps[0]!.raw ? { ...run.steps[0]!.raw } : null,
    };
    const doubled = { ...transcript, runs: [{ ...run, steps: [...run.steps, second] }] };
    const calls = selectCards(doubled, [], rawOf).mcpCalls;
    expect(calls.map((card) => card.id)).toEqual(["tool:call_t3", "tool:call_t3b"]);
  });

  it("F-132 F-138: a call is T3 Code by T3 Code's published tool name on any server, with no setting and no address", () => {
    const run = (name: string, details?: Record<string, unknown>) => {
      const raw = new RawTable();
      const ctx = { sessionKey: "agent:otto:t", now: 1, raw };
      let a = applyAgentEvent(
        emptyActivity,
        {
          runId: "r",
          seq: 1,
          stream: "tool",
          ts: 1,
          sessionKey: ctx.sessionKey,
          data: { phase: "start", name, toolCallId: "c", args: { message: "Go" } },
        },
        ctx,
      ).activity;
      if (details) {
        a = applyAgentEvent(
          a,
          {
            runId: "r",
            seq: 2,
            stream: "tool",
            ts: 2,
            sessionKey: ctx.sessionKey,
            data: {
              phase: "result",
              name,
              toolCallId: "c",
              isError: false,
              result: { content: [{ type: "text", text: "ok" }], details },
            },
          },
          ctx,
        ).activity;
      }
      return { runs: a.runs, approvals: [], linkedRuns: {}, interSession: [] };
    };
    const t3 = (name: string, details?: Record<string, unknown>, servers: string[] = []) =>
      selectCards(run(name, details), servers, rawOf).mcpCalls.filter((card) => card.codingAgent)
        .length;
    for (const tool of T3_CODE_TOOLS) {
      expect(t3(`my_coder__${tool}`), tool).toBe(1);
    }
    // After the result, by the result's own server and tool.
    expect(t3("renamed_tool_9", { mcpServer: "coder", mcpTool: "t3_thread_send" })).toBe(1);
    // Another tool, even on the same server, is not T3 Code; nor is a name only containing one.
    expect(t3("my_coder__orchestrator_capabilities")).toBe(0);
    expect(t3("my_coder__send_message")).toBe(0);
    expect(t3("t3_thread_launch")).toBe(0);
    expect(t3("my_coder__t3_thread_launch_v2")).toBe(0);
    // A server a host names counts for any of its tools.
    expect(t3("my_coder__send_message", undefined, ["my_coder"])).toBe(1);
  });
});

describe("every card scene", () => {
  it("builds, and opens its own task", () => {
    for (const name of CARD_SCENES) {
      const { transcript } = scene(name);
      expect(transcript.status, name).toBe("ready");
      expect([CARD_TASK, RECEIVING_TASK]).toContain(transcript.sessionKey);
    }
  });
});

describe("cards follow the gateway's identifiers, forward only", () => {
  const KEY = "agent:otto:order";
  const raw = new RawTable();
  let seq = 0;
  const event = (activity: TaskActivity, data: Record<string, unknown>, runId = "run-o") => {
    seq += 1;
    return applyAgentEvent(
      activity,
      { runId, seq, stream: "tool", ts: 1_000 + seq, sessionKey: KEY, data },
      { sessionKey: KEY, now: 5_000, raw },
    ).activity;
  };
  const start = (activity: TaskActivity, name: string, id: string, message: string) =>
    event(activity, {
      phase: "start",
      name,
      toolCallId: id,
      args: { message, sessionKey: "agent:marlow:main" },
    });
  const result = (
    activity: TaskActivity,
    name: string,
    id: string,
    details: Record<string, unknown>,
  ) =>
    event(activity, {
      phase: "result",
      name,
      toolCallId: id,
      isError: false,
      result: { content: [{ type: "text", text: "ok" }], details },
    });
  const select = (
    activity: TaskActivity,
    previous?: ReturnType<typeof selectCards>,
    linkedRuns = {},
  ) =>
    selectCards(
      { runs: activity.runs, approvals: [], linkedRuns, interSession: [] },
      [],
      rawOf,
      previous,
    );

  it("F-443 F-441: two simultaneous calls whose results arrive in the opposite order each land on the card their identifiers name", () => {
    let a = start(emptyActivity, "t3code__t3_thread_send", "c1", "First change");
    a = start(a, "t3code__t3_thread_send", "c2", "Second change");
    a = event(a, {
      phase: "result",
      name: "t3code__t3_thread_send",
      toolCallId: "c2",
      isError: true,
      result: {
        content: [{ type: "text", text: "second failed" }],
        details: { mcpServer: "t3code", mcpTool: "t3_thread_send" },
      },
    });
    a = result(a, "t3code__t3_thread_send", "c1", {
      mcpServer: "t3code",
      mcpTool: "t3_thread_send",
    });
    const calls = select(a).mcpCalls;
    expect(calls.map((card) => [card.text, card.state, card.error])).toEqual([
      ["First change", "returned", null],
      ["Second change", "failed", "second failed"],
    ]);
  });

  it("F-313: a later call with its own identifier never changes an earlier card; nothing is matched by project or thread", () => {
    let a = start(emptyActivity, "t3code__t3_thread_send", "c1", "Fix the check");
    a = result(a, "t3code__t3_thread_send", "c1", {
      mcpServer: "t3code",
      mcpTool: "t3_thread_send",
      structuredContent: { threadId: 18 },
    });
    const before = select(a);
    a = start(a, "t3code__t3_thread_read", "c3", "How is thread 18 going?");
    a = event(a, {
      phase: "result",
      name: "t3code__t3_thread_read",
      toolCallId: "c3",
      isError: true,
      result: {
        content: [{ type: "text", text: "thread 18 failed" }],
        details: {
          mcpServer: "t3code",
          mcpTool: "t3_thread_read",
          structuredContent: { threadId: 18 },
        },
      },
    });
    const after = select(a, before).mcpCalls;
    expect(after.find((card) => card.toolCallId === "c1")).toMatchObject({
      state: "returned",
      error: null,
    });
    expect(after.find((card) => card.toolCallId === "c3")).toMatchObject({ state: "failed" });
  });

  it("F-435: a send result that arrives after the recipient's run started never moves the card back to Sent, and a final state never changes", () => {
    let a = start(emptyActivity, "sessions_send", "m1", "Write the entry");
    a = result(a, "sessions_send", "m1", {
      status: "accepted",
      runId: "run-r",
      sessionKey: "agent:marlow:main",
    });
    const running = {
      "run-r": {
        id: "run-r",
        sessionKey: "agent:marlow:main",
        state: "running" as const,
        outcomeKnown: true,
        startedAt: 1,
        endedAt: null,
      },
    };
    const working = select(a, undefined, running);
    expect(botMessageKey(working.botMessages[0]!)).toBe("working");
    // The recipient's run is no longer known here: the card does not fall back to Sent.
    const later = select(a, working, {});
    expect(botMessageKey(later.botMessages[0]!)).toBe("working");
    // The same call, as a connection that saw its result carry the reply reads it.
    const withReply = result(
      start(emptyActivity, "sessions_send", "m1", "Write the entry"),
      "sessions_send",
      "m1",
      {
        status: "ok",
        runId: "run-r",
        sessionKey: "agent:marlow:main",
        reply: "Done.",
      },
    );
    const replied = withReply;
    const final = select(replied, later, running);
    expect(botMessageKey(final.botMessages[0]!)).toBe("replied");
    const failedAfter = { "run-r": { ...running["run-r"], state: "failed" as const, endedAt: 2 } };
    expect(botMessageKey(select(replied, final, failedAfter).botMessages[0]!)).toBe("replied");
  });
});

describe("the approval says what the request carries, as it carries it", () => {
  const exec = (request: Record<string, unknown>) =>
    parseExecApproval({
      id: "apr_q",
      request: {
        agentId: "otto",
        host: "gateway",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        ...request,
      },
    })!;

  it("F-167 F-163: the command stays exact and its arguments keep their boundaries", () => {
    const card = exec({ command: "printf '%s' 'a b'", commandArgv: ["printf", "%s", "a b"] });
    const view = approvalView(card, bots, otto);
    expect(view.exact).toEqual({ label: "Command", text: "printf '%s' 'a b'" });
    const command = view.form.rows.find((row) => row.label === "Command")!;
    const args = view.form.rows.find((row) => row.label === "Arguments")!;
    expect(command.value).toBe("printf '%s' 'a b'");
    expect(args.list).toEqual(["printf", "%s", "a b"]);
    // A request with arguments and no command shows no command it did not send.
    const argvOnly = approvalView(exec({ commandArgv: ["ls", "-la"] }), bots, otto);
    expect(argvOnly.exact).toBeNull();
    expect(argvOnly.form.rows.map((row) => row.label)).not.toContain("Command");
  });

  it("F-163: the summary stays short however long the command; the whole is in the full request", () => {
    const long = `rsync -a ${"/srv/media/archive/".repeat(40)} /mnt/backup`;
    const view = approvalView(exec({ command: long }), bots, otto);
    expect(view.summary.code!.length).toBeLessThanOrEqual(SUMMARY_COMMAND_CHARS + 1);
    expect(view.summary.code!.endsWith("…")).toBe(true);
    expect(view.summary.codeFull).toBe(long);
    expect(view.exact!.text).toBe(long);
    const twoLines = approvalView(exec({ command: "echo one\necho two" }), bots, otto);
    expect(twoLines.summary.code).toBe("echo one…");
  });

  it("F-163: without approval access no decision is dispatched, and without question access no answer", () => {
    const none = { canApprove: false, canAnswer: false };
    for (const decision of ["allow-once", "allow-always", "deny"]) {
      expect(mayDispatch({ type: "resolveApproval", decision } as { type: string }, none)).toBe(
        false,
      );
    }
    expect(mayDispatch({ type: "answerQuestion" }, none)).toBe(false);
    expect(mayDispatch({ type: "dismissQuestion" }, none)).toBe(false);
    expect(mayDispatch({ type: "requestAccess" }, none)).toBe(true);
    expect(mayDispatch({ type: "resolveApproval" }, { canApprove: true, canAnswer: false })).toBe(
      true,
    );
  });
});

describe("the Messaged cards claim only what an event established", () => {
  it("F-122 F-134: the outgoing row says sent only once the call returned and its result says the message went", () => {
    const delivered = [
      "sent",
      "working",
      "recipient-waiting",
      "no-reply",
      "replied",
      "recipient-stopped",
      "recipient-failed",
      "call-made",
    ];
    const notDelivered = [
      "call-started",
      "approval",
      "failed",
      "blocked",
      "not-sent",
      "unknown",
      "delivery-unknown",
    ];
    for (const key of delivered) expect(sentVerb(key as MessagedKey), key).toBe("sent");
    for (const key of notDelivered) expect(sentVerb(key as MessagedKey), key).toBe("asked to send");
    // Every state is one or the other.
    expect([...delivered, ...notDelivered].sort()).toEqual(Object.keys(MESSAGED_STATES).sort());
  });
});

describe("cards in the order the gateway's events establish", () => {
  it("F-119: a request asked before a later call comes first; a call comes before the approval it waits on", () => {
    const KEY = "agent:otto:order2";
    const raw = new RawTable();
    let seq = 0;
    const ctx = () => ({ sessionKey: KEY, now: 9_000, raw });
    const tool = (activity: TaskActivity, data: Record<string, unknown>, ts: number) =>
      applyAgentEvent(
        activity,
        { runId: "run-x", seq: (seq += 1), stream: "tool", ts, sessionKey: KEY, data },
        ctx(),
      ).activity;
    let a = applyAgentEvent(
      emptyActivity,
      {
        runId: "run-x",
        seq: (seq += 1),
        stream: "lifecycle",
        ts: 1_000,
        sessionKey: KEY,
        data: { phase: "start" },
      },
      ctx(),
    ).activity;
    // A question at 2,000, then a message to Marlow at 3,000, then an approval for that message at 3,000.
    a = applyQuestionRequested(
      a,
      {
        id: "q1",
        runId: "run-x",
        sessionKey: KEY,
        createdAtMs: 2_000,
        expiresAtMs: 900_000,
        status: "pending",
        questions: [
          {
            questionId: "a",
            header: "A",
            question: "Which?",
            options: [{ label: "x" }, { label: "y" }],
            isOther: true,
          },
        ],
      },
      ctx(),
    );
    a = tool(
      a,
      {
        phase: "start",
        name: "sessions_send",
        toolCallId: "m1",
        args: { sessionKey: "agent:marlow:main", message: "Hi" },
      },
      3_000,
    );
    const approval = parsePluginApproval({
      id: "ap1",
      request: {
        title: "message Marlow",
        toolCallId: "m1",
        runId: "run-x",
        sessionKey: KEY,
        agentId: "otto",
      },
      createdAtMs: 3_000,
      expiresAtMs: 900_000,
    })!;
    a = applyApprovalRequested(a, approval);
    // And an exec approval asked at 1,500, before both.
    a = applyApprovalRequested(
      a,
      parseExecApproval({
        id: "ap0",
        request: {
          command: "ls",
          runId: "run-x",
          sessionKey: KEY,
          agentId: "otto",
          allowedDecisions: ["allow-once", "deny"],
        },
        createdAtMs: 1_500,
        expiresAtMs: 900_000,
      })!,
    );
    const placed = placeCards(
      { runs: a.runs, approvals: a.approvals, questions: a.questions, items: [], interSession: [] },
      selectCards(
        { runs: a.runs, approvals: a.approvals, linkedRuns: {}, interSession: [] },
        [],
        rawOf,
      ),
    );
    expect(placed.byRun.get("run-x")).toEqual([
      { kind: "approval", id: "ap0" },
      { kind: "question", id: "q1" },
      { kind: "bot-message", id: "tool:m1" },
      { kind: "approval", id: "ap1" },
    ]);
  });
});

describe("a T3 Code card's state moves only as its own call's events establish", () => {
  it("F-134: Delivery unknown is not final: the call's own result, read later from history, makes it Call made; Call made is final", () => {
    const stopped = cards("t3-delivery-unknown");
    const before = stopped.selected;
    expect(before.mcpCalls[0]!.state).toBe("unknown");
    // The same call, as history later holds it with its result (same call id, same run).
    const made = cards("t3-call-made").transcript;
    const later = selectCards(
      {
        ...stopped.transcript,
        runs: stopped.transcript.runs.map((run) => ({ ...run, steps: made.runs[0]!.steps })),
      },
      [],
      rawOf,
      before,
    );
    expect(later.mcpCalls[0]).toMatchObject({ id: before.mcpCalls[0]!.id, state: "returned" });
    // Call made is final: another result for the same call that is not the gateway's own
    // correction (a `replace` frame) changes nothing.
    const KEY = "agent:otto:final";
    const raw = new RawTable();
    const ctx = { sessionKey: KEY, now: 1, raw };
    let seq = 0;
    const tool = (activity: TaskActivity, data: Record<string, unknown>) =>
      applyAgentEvent(
        activity,
        { runId: "r", seq: (seq += 1), stream: "tool", ts: seq, sessionKey: KEY, data },
        ctx,
      ).activity;
    const name = "t3code__t3_thread_launch";
    const details = { mcpServer: "t3code", mcpTool: "t3_thread_launch" };
    let a = tool(emptyActivity, { phase: "start", name, toolCallId: "c", args: { message: "Go" } });
    a = tool(a, {
      phase: "result",
      name,
      toolCallId: "c",
      isError: false,
      result: { content: [{ type: "text", text: "ok" }], details },
    });
    const madeCards = selectCards(
      { runs: a.runs, approvals: [], linkedRuns: {}, interSession: [] },
      [],
      rawOf,
    );
    a = tool(a, {
      phase: "result",
      name,
      toolCallId: "c",
      isError: true,
      result: { content: [{ type: "text", text: "late" }], details },
    });
    const after = selectCards(
      { runs: a.runs, approvals: [], linkedRuns: {}, interSession: [] },
      [],
      rawOf,
      madeCards,
    );
    expect(after.mcpCalls[0]).toMatchObject({ state: "returned", error: null });
  });
});
