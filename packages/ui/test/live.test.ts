// What the live conversation shows, derived from the engine's state alone
// (docs/design/conversation.md, sections 3, 5, 15, 16 and 17). Each check's
// title starts with the parity rows it covers.

import {
  emptyActivity,
  initialState,
  INTERACTIVE_SCOPES,
  newRun,
  READ_SCOPES,
  type ConnectionState,
  type OutgoingMessage,
  type QuestionCard,
  type Run,
  type Step,
  type Transcript,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { canWrite } from "../src/access.ts";
import { refusalFor, size } from "../src/Composer.tsx";
import {
  composerFor,
  duration,
  elapsed,
  endingOf,
  outgoingBubbles,
  sendName,
  shelfMessages,
  statusLineFor,
} from "../src/live.ts";

const NOW = 1_800_000_000_000;

function transcript(runs: Run[], change: Partial<Transcript> = {}): Transcript {
  return {
    ...emptyActivity,
    linkedRuns: {},
    interSession: [],
    sessionKey: "agent:otto:a",
    status: "ready",
    items: [],
    error: null,
    hasMore: false,
    live: null,
    loadedAt: NOW,
    runs,
    ...change,
  };
}

const run = (change: Partial<Run> = {}): Run =>
  newRun(
    "run-1",
    { state: "running", origin: "local", bound: true, reportedStartAt: NOW - 42_000, ...change },
    NOW - 42_000,
  );

function step(name: string, args: Record<string, unknown>, change: Partial<Step> = {}): Step {
  const text = JSON.stringify(args);
  return {
    id: `tool:${name}`,
    kind: "tool",
    title: name,
    toolName: name,
    toolCallId: name,
    status: "running",
    startedAt: NOW,
    endedAt: null,
    argsText: { text, totalChars: text.length },
    output: null,
    result: null,
    error: null,
    approvalId: null,
    failureKind: null,
    truncated: false,
    replaceable: false,
    correction: 0,
    continuation: null,
    raw: null,
    rawSize: null,
    ...change,
  };
}

const question = (status: QuestionCard["status"] = "pending"): QuestionCard => ({
  id: "q-1",
  runId: "run-1",
  status,
  questions: [],
  createdAt: NOW,
  expiresAt: null,
  answers: null,
  submitting: false,
  error: null,
  raw: null,
  ordinary: true,
  sent: null,
  settledBy: [],
});

const message = (change: Partial<OutgoingMessage>): OutgoingMessage => ({
  id: "m-1",
  text: "Hello",
  mode: "new",
  status: "sent",
  runId: null,
  messageSeq: null,
  leftAt: null,
  createdAt: NOW,
  error: null,
  attachments: [],
  ...change,
});

const live = { connected: true, interactive: true };

describe("the status line", () => {
  it("F-081 F-085 F-083: a run with nothing to report says Thinking, never empty and with no bot name", () => {
    const view = statusLineFor(run(), transcript([run()]), live);
    expect(view).toMatchObject({ state: "thinking", phrase: "Thinking", tone: "live" });
    expect(view.phrase).not.toMatch(/Otto/);
    expect(view.startedAt).toBe(NOW - 42_000);
  });

  it("F-082: a running step's title is the phrase; a reasoning step or none is Thinking", () => {
    const reading = run({
      steps: [step("read", { path: "/var/log/backup/backup-2026-11-15.log" })],
    });
    expect(statusLineFor(reading, transcript([reading]), live)).toMatchObject({
      state: "working",
      phrase: "Reading backup-2026-11-15.log",
    });
    const finished = run({
      steps: [step("read", { path: "a.log" }, { status: "done", endedAt: NOW })],
    });
    expect(statusLineFor(finished, transcript([finished]), live).phrase).toBe("Thinking");
    const phrase = (name: string, args: Record<string, unknown>, more = {}) => {
      const each = run({ steps: [step(name, args, more)] });
      return statusLineFor(each, transcript([each]), live).phrase;
    };
    expect(phrase("exec", { command: "mv /a /b" })).toBe("Running mv");
    // A tool the app has no kind for gets the general card's words, never the gateway's title.
    expect(phrase("coder__send", {}, { title: "Coder Send" })).toBe("Using coder send");
    expect(phrase("web_search", { query: "heat pump" })).toBe('Searching the web for "heat pump"');
  });

  it("F-082: overlapping calls: the latest to start, then the earliest still running", () => {
    const a = step("read", { path: "a.log" }, { id: "tool:a", toolCallId: "a" });
    const b = step("read", { path: "b.log" }, { id: "tool:b", toolCallId: "b" });
    const c = step("read", { path: "c.log" }, { id: "tool:c", toolCallId: "c" });
    const all = run({ steps: [a, b, c] });
    expect(statusLineFor(all, transcript([all]), live)).toMatchObject({
      phrase: "Reading c.log",
      callId: "c",
    });
    const ended = run({
      steps: [a, b, { ...c, status: "done", endedAt: NOW, result: { text: "x", totalChars: 1 } }],
    });
    expect(statusLineFor(ended, transcript([ended]), live)).toMatchObject({
      phrase: "Reading a.log",
      callId: "a",
    });
  });

  it("F-082: the gateway's status phases give the phrase more to say while no step runs", () => {
    const preparing = run({ phase: "preparing-workspace" });
    expect(statusLineFor(preparing, transcript([preparing]), live).phrase).toBe(
      "Setting up the workspace",
    );
    const context = run({ phase: "memory-flush" });
    expect(statusLineFor(context, transcript([context]), live).phrase).toBe("Gathering context");
  });

  it("F-292: a pending card reads Waiting for you, and the running phrase returns when it settles", () => {
    const waiting = run({
      state: "waiting",
      pendingCards: [{ id: "a-1", kind: "approval", since: NOW }],
      steps: [step("read", { path: "a.log" })],
    });
    expect(statusLineFor(waiting, transcript([waiting]), live)).toMatchObject({
      state: "waiting",
      badge: "waiting",
      phrase: "Waiting for you",
      tone: "warn",
    });
    const asked = run();
    expect(
      statusLineFor(asked, transcript([asked], { questions: [question()] }), live).phrase,
    ).toBe("Waiting for you");
    const answered = run({ steps: [step("read", { path: "a.log" })] });
    expect(
      statusLineFor(answered, transcript([answered], { questions: [question("answered")] }), live)
        .phrase,
    ).toBe("Reading a.log");
  });

  it("F-097: Stop pressed reads Stopping… with the idle avatar and no shimmer", () => {
    const stopping = run({ state: "stopping", stopRequestedAt: NOW });
    expect(statusLineFor(stopping, transcript([stopping]), live)).toMatchObject({
      state: "idle",
      phrase: "Stopping…",
      tone: "muted",
    });
  });

  it("F-104: a lost connection stops the line and says what was last seen, with no elapsed time", () => {
    const reading = run({ steps: [step("read", { path: "/var/log/backup.log" })] });
    expect(
      statusLineFor(reading, transcript([reading]), { connected: false, interactive: true }),
    ).toEqual({
      state: "blocked",
      badge: "blocked",
      phrase: "Reconnecting. Last seen reading backup.log",
      tone: "muted",
      startedAt: null,
      callId: "read",
    });
  });

  it("F-086: a wait reported on the read tier reads Waiting for an answer with the blocked badge", () => {
    const waiting = run({ state: "waiting" });
    expect(
      statusLineFor(waiting, transcript([waiting]), { connected: true, interactive: false }),
    ).toMatchObject({ badge: "blocked", phrase: "Waiting for an answer", tone: "muted" });
  });

  it("F-081: the clock shows only a start the gateway reported, never this client's send time", () => {
    const unreported = run({ reportedStartAt: null });
    expect(statusLineFor(unreported, transcript([unreported]), live).startedAt).toBeNull();
    const reported = run({ reportedStartAt: NOW - 5_000 });
    expect(statusLineFor(reported, transcript([reported]), live).startedAt).toBe(NOW - 5_000);
  });

  it("F-081: elapsed time reads m:ss, and a duration the gateway reported reads 48s, 1m 12s, 1h 04m", () => {
    expect(elapsed(42_000)).toBe("0:42");
    expect(elapsed(3_725_000)).toBe("1:02:05");
    expect(duration(48_000)).toBe("48s");
    expect(duration(72_000)).toBe("1m 12s");
    expect(duration(3_840_000)).toBe("1h 04m");
  });
});

describe("the composer during a run", () => {
  const otto = { bot: "Otto", connected: true, chosen: null };

  it("F-068: with no run it reads Message Otto and Send sends", () => {
    const view = composerFor(transcript([]), otto);
    expect(view).toMatchObject({ placeholder: "Message Otto", mode: "send", stoppable: null });
    expect(sendName(view.mode)).toBe("Send");
  });

  it("F-097 F-096: while a run is running, Stop is offered beside Send and plain Enter steers", () => {
    const active = run();
    const view = composerFor(transcript([active]), otto);
    expect(view).toMatchObject({ placeholder: "Steer Otto", mode: "steer", modeWord: "Steer" });
    expect(view.stoppable?.id).toBe("run-1");
    expect(sendName(view.mode)).toBe("Steer this turn");
  });

  it("F-061: Queue after this turn, once chosen, is what plain Enter does for the rest of the run", () => {
    const view = composerFor(transcript([run()]), { ...otto, chosen: "queue" });
    expect(view).toMatchObject({ mode: "queue", modeWord: "Queue" });
    expect(sendName(view.mode)).toBe("Queue after this turn");
  });

  it("F-468: a steer while only an approval is pending joins the run; a question holds every message", () => {
    const approval = run({
      state: "waiting",
      pendingCards: [{ id: "a-1", kind: "approval", since: NOW }],
    });
    expect(composerFor(transcript([approval]), otto)).toMatchObject({
      placeholder: "Answer above, or message Otto",
      mode: "steer",
    });
    const asking = run({
      state: "waiting",
      pendingCards: [{ id: "q-1", kind: "question", since: NOW }],
    });
    const held = composerFor(transcript([asking], { questions: [question()] }), {
      ...otto,
      chosen: "queue",
    });
    expect(held).toMatchObject({ mode: "hold", modeWord: "Hold", menu: "hold" });
    expect(sendName(held.mode)).toBe("Hold until you answer");
  });

  it("F-421 F-097: while a run is stopping a message is queued, Stop is gone and the composer says Stopping…", () => {
    const stopping = run({ state: "stopping", stopRequestedAt: NOW });
    expect(composerFor(transcript([stopping]), otto)).toMatchObject({
      placeholder: "Queue a message for Otto",
      mode: "queue",
      stoppable: null,
      stopping: true,
    });
  });

  it("F-287 F-104: offline, the placeholder says messages send when you reconnect", () => {
    expect(composerFor(transcript([]), { ...otto, connected: false }).placeholder).toBe(
      "Offline. Messages send when you reconnect.",
    );
  });

  it("F-281 F-280: queued and held messages are shelf rows, never bubbles, until they are sent", () => {
    const t = transcript([], {
      outbox: [
        message({ id: "a", status: "queued", mode: "queue" }),
        message({ id: "b", status: "held", mode: "steer" }),
        message({ id: "c", status: "cancelled", mode: "queue" }),
        message({ id: "d", status: "sent", mode: "steer" }),
      ],
    });
    expect(shelfMessages(t).map((each) => each.id)).toEqual(["a", "b"]);
    expect(outgoingBubbles(t).map((each) => each.id)).toEqual(["d"]);
  });
});

describe("how a run ends", () => {
  it("F-299: a confirmed stop says how long the run took and that completed steps are not undone", () => {
    expect(
      endingOf(run({ state: "stopped", stopRequestedAt: NOW - 1, endedAt: NOW - 2_000 })),
    ).toEqual({ kind: "stopped", after: "40s", elsewhere: false });
    expect(endingOf(run({ state: "stopped", endedAt: NOW }))).toMatchObject({ elsewhere: true });
    // A stop command this device sent while the run went is not "from elsewhere".
    const stopped = run({ state: "stopped", endedAt: NOW });
    expect(
      endingOf(
        stopped,
        transcript([stopped], {
          outbox: [message({ status: "handled", text: "/stop", createdAt: NOW - 1_000 })],
        }),
      ),
    ).toMatchObject({ elsewhere: false });
    // A run rebuilt from history whose ending is not known is not called stopped.
    expect(endingOf(run({ state: "stopped", outcomeKnown: false }))).toBeNull();
  });

  it("F-419: a run that completed after Stop was pressed says it finished before Stop took effect", () => {
    expect(endingOf(run({ state: "completed", finishedBeforeStop: true }))).toEqual({
      kind: "finished-before-stop",
    });
    expect(endingOf(run({ state: "completed" }))).toBeNull();
  });

  it("F-100: a run that reached its turn limit ends as failed with a note naming the limit", () => {
    expect(
      endingOf(
        run({
          state: "failed",
          error: { message: "Stopped at the 50-minute turn limit.", kind: "turn-limit" },
        }),
      ),
    ).toMatchObject({ kind: "turn-limit", minutes: 50 });
  });

  it("F-102: a failed run carries the gateway's reason", () => {
    expect(
      endingOf(run({ state: "failed", error: { message: "Provider overloaded.", kind: null } })),
    ).toEqual({ kind: "failed", reason: "Provider overloaded." });
  });
});

describe("the access tier", () => {
  const connection = (change: Partial<ConnectionState>): ConnectionState => ({
    ...initialState.connection,
    status: "connected",
    ...change,
  });

  it("F-456: the read tier may not write; the granted interactive scopes may, and a lost connection keeps the tier held", () => {
    expect(
      canWrite(connection({ scopes: [...READ_SCOPES], requestedScopes: [...READ_SCOPES] })),
    ).toBe(false);
    expect(
      canWrite(
        connection({
          scopes: [...INTERACTIVE_SCOPES],
          requestedScopes: [...INTERACTIVE_SCOPES],
          canWrite: true,
        }),
      ),
    ).toBe(true);
    // Approving and answering never stand in for writing.
    expect(
      canWrite(
        connection({
          scopes: ["operator.read", "operator.approvals"],
          canApprove: true,
          canWrite: false,
        }),
      ),
    ).toBe(false);
    expect(
      canWrite(connection({ status: "reconnecting", requestedScopes: [...INTERACTIVE_SCOPES] })),
    ).toBe(true);
    // A host pinned to the read tier never writes.
    expect(
      canWrite(connection({ scopes: [...INTERACTIVE_SCOPES], canWrite: true }), { readOnly: true }),
    ).toBe(false);
  });
});

describe("attachments", () => {
  it("F-285 F-074: a file over the gateway's limit is refused with its size before anything is sent", () => {
    expect(refusalFor({ size: 8.2 * 1024 * 1024, type: "image/png" })).toBe(
      "8.2 MB. Images can be up to 6 MB.",
    );
    expect(refusalFor({ size: 21 * 1024 * 1024, type: "application/pdf" })).toBe(
      "21.0 MB. Files can be up to 20 MB.",
    );
    expect(refusalFor({ size: 1024 * 1024, type: "application/pdf" })).toBeNull();
    expect(size(640 * 1024)).toBe("640 KB");
  });
});
