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
  callFromStep,
  latestSent,
  placeT3,
  readDimensions,
  readingContextOf,
  readLines,
  t3CallOf,
  threadStateOf,
  workMayContinue,
  type T3Call,
  type T3Sequence,
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
  MESSAGED_STATES,
  sentVerb,
  type MessagedKey,
  questionNote,
  resolvedView,
  sendableDecisions,
  SUMMARY_COMMAND_CHARS,
} from "../../../packages/ui/src/cards/model.ts";
import { placeCards } from "../../../packages/ui/src/cards/placement.ts";
import { selectCards } from "../../../packages/ui/src/cards/useCards.ts";
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
  // No server is named as T3 Code: its calls are known by T3 Code's own tools, as their results name them.
  return { transcript, selected: selectCards(transcript, rawOf) };
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
    const placed = placeCards(received, selectCards(received, rawOf));
    expect([...placed.incoming.keys()]).toEqual(["m-in:0"]);
    expect(received.runs[0]!.anchorItemId).toBe("m-in:0");
    const late = scene("incoming-line").transcript;
    expect([...placeCards(late, selectCards(late, rawOf)).incoming.keys()]).toEqual(["m-late:1"]);
    expect(late.runs.some((run) => run.anchorItemId === "m-late:1")).toBe(false);
  });
});

/** A scene's T3 Code calls as the transcript places them (section 11): the reading the cards draw. */
function t3Of(name: CardSceneName, ctxOver?: Partial<ReturnType<typeof readingContextOf>>) {
  const { transcript } = scene(name);
  const ctx = { ...readingContextOf(transcript), ...ctxOver };
  const sequence: T3Sequence = [];
  const calls: T3Call[] = [];
  for (const run of transcript.runs) {
    for (const step of run.steps) {
      if (step.kind !== "tool") continue;
      const call = t3CallOf(callFromStep(step, run), ctx);
      if (call) calls.push(call);
      sequence.push(call ? { type: "t3", call } : { type: "other" });
      // Text written before the next call is a bubble between them.
      for (const p of run.preambles ?? [])
        if (p.beforeCall === step.toolCallId) sequence.splice(-1, 0, { type: "other" });
    }
    sequence.push({ type: "boundary" });
  }
  const placed = placeT3(sequence);
  const threadOf = (head: string) =>
    calls.filter((c) => {
      const at = placed.get(c.id);
      return c.id === head || ((at?.type === "joined" || at?.type === "line") && at.head === head);
    });
  return { transcript, calls, placed, threadOf };
}

describe("T3 Code thread cards from the engine's state", () => {
  it("F-132: with the gateway's map a call is T3 Code's from its start; without it, an ordinary card until its result names it", () => {
    const mapped = t3Of("t3-started");
    expect(mapped.calls.map((c) => [c.tool, c.state, c.mapped])).toEqual([
      ["t3_thread_launch", "started", true],
    ]);
    expect(mapped.placed.get("call_t3")).toEqual({ type: "card", thread: null, head: "call_t3" });
    expect(t3Of("t3-general").calls).toEqual([]);
    // Recognized per call, by its tool: no server is T3 Code as a whole.
    const listing = t3Of("t3-listings");
    expect(listing.calls.map((c) => c.role)).toEqual(["listing", "listing"]);
  });

  it("F-134 F-314 F-470: each thread's state is what its calls' events establish", () => {
    const word = (name: CardSceneName) => {
      const t = t3Of(name);
      const head = [...t.placed].find(([, at]) => at.type === "card")![0];
      return threadStateOf(t.threadOf(head));
    };
    expect(word("t3-started")).toEqual({ type: "open", word: "call-started" });
    expect(word("t3-approval")).toEqual({ type: "open", word: "waiting" });
    expect(word("t3-checking")).toEqual({ type: "open", word: "checking" });
    // Several calls reported a status: Call made, each status on its own item.
    expect(word("t3-thread")).toMatchObject({ type: "call", state: "made" });
    expect(word("t3-refused")).toMatchObject({ type: "reported", status: "running" });
    // A launch that ended without a result naming a thread joins none: it is a card of its own,
    // saying how the call itself ended.
    const own = (name: CardSceneName) => {
      const t = t3Of(name);
      return [t.placed.get("call_t3")?.type, t.calls[0]!.state];
    };
    expect(own("t3-failed")).toEqual(["own", "failed"]);
    expect(own("t3-not-sent")).toEqual(["own", "not-sent"]);
    expect(own("t3-delivery-unknown")).toEqual(["own", "unknown"]);
    const refused = t3Of("t3-refused").calls[1]!;
    expect([refused.state, refused.error]).toEqual([
      "failed",
      { code: "thread_not_sendable", message: "Nothing is running to steer: the thread is idle." },
    ]);
  });

  it("F-313: one card per thread: a call directly under it joins; one after a bubble keeps its line, and is an item too", () => {
    const t = t3Of("t3-thread");
    expect(Object.fromEntries([...t.placed].map(([id, at]) => [id, at.type]))).toEqual({
      call_t3: "card",
      call_t3w: "joined",
      call_t3s: "line",
      call_t3r: "line",
    });
    expect(t.threadOf("call_t3").map((c) => c.id)).toEqual([
      "call_t3",
      "call_t3w",
      "call_t3s",
      "call_t3r",
    ]);
    expect(latestSent(t.threadOf("call_t3"))).toBe(
      "Also add a test for machines that wake up late.",
    );
  });

  it("F-313: a thread whose launch is not in the record has its card at its first call there", () => {
    const t = t3Of("t3-before-record");
    expect(t.placed.get("call_t3s")).toMatchObject({ type: "card", head: "call_t3s" });
    expect(t.placed.get("call_t3w")).toMatchObject({ type: "joined", head: "call_t3s" });
    expect(threadStateOf(t.threadOf("call_t3s"))).toMatchObject({ type: "call", state: "made" });
  });

  it("F-441: two threads are two cards, and the same thread id on another server is a third", () => {
    const t = t3Of("t3-two-threads");
    const cards = [...t.placed].filter(([, at]) => at.type === "card").map(([id]) => id);
    expect(cards).toEqual(["call_t3", "call_t3b", "call_t3l"]);
    const keys = cards.map((id) => t.calls.find((c) => c.id === id)!.thread!.key);
    expect(new Set(keys).size).toBe(3);
  });

  it("F-133: a read says how much it read in both dimensions", () => {
    const [, cut, page] = t3Of("t3-read-cut").calls;
    expect(readLines(readDimensions(cut!.facts))).toEqual([
      "Part of the reply only: its text was cut, and the rest was not read",
    ]);
    expect(readLines(readDimensions(page!.facts))).toEqual([
      "First page only: the reply may continue",
      "Part of the run only: an item's text was cut, and the rest was not read",
    ]);
    expect(readLines(readDimensions(t3Of("t3-thread").calls[3]!.facts))).toEqual([
      "Read to the end",
    ]);
  });

  it("F-137: after a stop, a launch that was made keeps Call made and may go on; one that had not returned is Delivery unknown", () => {
    const made = t3Of("t3-work-may-continue").calls;
    expect([made[0]!.state, workMayContinue(made)]).toEqual(["made", true]);
    const unknown = t3Of("t3-delivery-unknown").calls;
    expect([unknown[0]!.state, workMayContinue(unknown)]).toEqual(["unknown", false]);
  });

  it("F-134: Delivery unknown is not final: the call's own result, read later, makes it Call made", () => {
    const stopped = scene("t3-delivery-unknown").transcript;
    const later = scene("t3-work-may-continue").transcript;
    const ctx = readingContextOf(stopped);
    const step = (t: Transcript) => t.runs[0]!.steps.find((s) => s.toolCallId === "call_t3")!;
    expect(t3CallOf(callFromStep(step(stopped), stopped.runs[0]!), ctx)!.state).toBe("unknown");
    expect(t3CallOf(callFromStep(step(later), stopped.runs[0]!), ctx)!.state).toBe("made");
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
