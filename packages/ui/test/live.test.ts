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
import { messageRefusal, refusalFor, size } from "../src/Composer.tsx";
import { stoppedWithLines } from "../src/LiveTurn.tsx";
import {
  composerFor,
  currentRun,
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
    mcpTools: {},
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
    ).toEqual({ kind: "stopped", after: "40s", elsewhere: false, timeouts: null });
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

  it("F-100: a run this client stopped at its turn limit, once stopped, names the limit; one the gateway timed out is worded as the gateway's", () => {
    expect(endingOf(run({ state: "stopped", stopRequestedAt: 1, turnLimit: 50 }))).toEqual({
      kind: "turn-limit",
      minutes: 50,
    });
    // Still stopping, or put back after a refused abort: no ending at all yet.
    expect(endingOf(run({ state: "stopping", stopRequestedAt: 1, turnLimit: 50 }))).toBeNull();
    expect(endingOf(run({ state: "running", turnLimit: 50 }))).toBeNull();
    expect(
      endingOf(
        run({
          state: "failed",
          error: { message: "The run timed out.", kind: null },
          ending: { timeoutPhase: "run" } as Run["ending"],
        }),
      ),
    ).toEqual({ kind: "gateway-timeout", reason: "The run timed out." });
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

  it("F-074 F-285: the ceilings are the smaller of Clawtrate's and the gateway's, and the whole request is counted as sent, base64 and all", () => {
    const gateway = {
      imageBytes: 4 * 1024 * 1024,
      fileBytes: 19_464_192,
      payloadBytes: 25 * 1024 * 1024,
      files: 20,
    };
    expect(refusalFor({ size: 5 * 1024 * 1024, type: "image/jpeg" }, gateway)).toBe(
      "5.0 MB. Images can be up to 4 MB.",
    );
    expect(refusalFor({ size: 19 * 1024 * 1024, type: "application/pdf" }, gateway)).toBe(
      "19.0 MB. Files can be up to 18.6 MB.",
    );
    expect(refusalFor({ size: 18 * 1024 * 1024, type: "application/pdf" }, gateway)).toBeNull();
    const draft = (files: Array<{ fileName: string; bytes: number }>) => ({
      sessionKey: "agent:otto:disk-space",
      text: "",
      idempotencyKey: "x".repeat(36),
      queueMode: "followup" as const,
      files: files.map((file) => ({ ...file, mimeType: "application/pdf" })),
    });
    // Four files of 5 MiB are 20 MiB as files but 26.7 MiB as the frame carries them.
    const four = [1, 2, 3, 4].map((n) => ({ fileName: `part-${n}.pdf`, bytes: 5 * 1024 * 1024 }));
    expect(messageRefusal(draft(four), gateway)).toBe(
      "26.7 MB to send with its files. A message can carry up to 25 MB.",
    );
    expect(messageRefusal(draft(four.slice(0, 3)), gateway)).toBeNull();
    const many = Array.from({ length: 21 }, (_, n) => ({ fileName: `${n}.txt`, bytes: 10 }));
    expect(messageRefusal(draft(many), gateway)).toBe(
      "21 files attached. A message can carry up to 20 files.",
    );
    // One byte over a ceiling does not read as the ceiling itself.
    expect(refusalFor({ size: 6_291_457, type: "image/png" })).toBe(
      "6,291,457 bytes. Images can be up to 6,291,456 bytes.",
    );
  });
});

describe("F-468: what the transition tables leave on screen", () => {
  const otto = { bot: "Otto", connected: true, chosen: null };
  const held = (text: string, id: string) =>
    message({ id, text, mode: "steer", status: "held", runId: "run-1" });
  const cases: Array<[string, Transcript, (t: Transcript) => void]> = [
    [
      "a completed run leaves no status line, and the composer is back to Message Otto",
      transcript([run({ state: "completed", endedAt: NOW })]),
      (t) => {
        expect(currentRun(t)).toBeUndefined();
        expect(composerFor(t, otto)).toMatchObject({ placeholder: "Message Otto", mode: "send" });
      },
    ],
    [
      "with only an approval pending, plain Enter steers and the status line waits for you",
      transcript([
        run({ state: "waiting", pendingCards: [{ id: "a-1", kind: "approval", since: NOW }] }),
      ]),
      (t) => {
        expect(composerFor(t, otto)).toMatchObject({ mode: "steer", modeWord: "Steer" });
        expect(statusLineFor(currentRun(t)!, t, live)).toMatchObject({
          phrase: "Waiting for you",
        });
      },
    ],
    [
      "with a question pending, typed messages are held on the shelf, never your bubbles, and plain Enter holds",
      transcript(
        [run({ state: "waiting", pendingCards: [{ id: "q-1", kind: "question", since: NOW }] })],
        {
          questions: [question()],
          outbox: [held("first", "m-1"), held("second", "m-2")],
        },
      ),
      (t) => {
        expect(composerFor(t, otto)).toMatchObject({ mode: "hold", modeWord: "Hold" });
        expect(shelfMessages(t).map((m) => [m.text, m.status])).toEqual([
          ["first", "held"],
          ["second", "held"],
        ]);
        expect(outgoingBubbles(t)).toEqual([]);
      },
    ],
    [
      "after a confirmed Stop the messages are Not sent on the shelf, no run is current, and the composer starts a new run",
      transcript([run({ state: "stopped", endedAt: NOW })], {
        outbox: [message({ id: "m-1", text: "left", mode: "queue", status: "not-sent" })],
      }),
      (t) => {
        expect(currentRun(t)).toBeUndefined();
        expect(shelfMessages(t).map((m) => m.status)).toEqual(["not-sent"]);
        expect(composerFor(t, otto).mode).toBe("send");
      },
    ],
  ];
  it.each(cases)("F-468: %s", (_name, t, check) => check(t));
});

describe("what a stop also ended (F-298)", () => {
  const names = (key: string) => (key.includes("marlow") ? "Marlow" : "Pip");
  const record = (change: Partial<NonNullable<Run["stoppedWith"]>>) => ({
    helpers: 0,
    bots: [],
    uncertain: [],
    refused: [],
    unanswered: [],
    omitted: 0,
    recipientsAsked: true,
    ...change,
  });
  it("F-298 F-296: the note lists each helper run and bot run the gateway stopped, each recipient it refused or did not answer, and a message whose delivery is unknown", () => {
    const stopped = run({
      state: "stopped",
      stoppedWith: record({
        helpers: 2,
        bots: ["agent:marlow:main"],
        uncertain: ["agent:pip:main"],
        refused: ["agent:pip:other"],
        unanswered: ["agent:marlow:notes"],
        omitted: 2,
      }),
    });
    expect(stoppedWithLines(stopped, names)).toEqual([
      "Stopped with it: 2 helper runs and Marlow's run for this message.",
      "The gateway refused to stop Pip's run for this message.",
      "Marlow's run for this message may still be going: its stop got no answer.",
      "The message to Pip may or may not have been delivered.",
      "2 more runs were asked to stop, not listed here.",
    ]);
  });

  it("F-298: nothing the gateway did not report is claimed", () => {
    expect(stoppedWithLines(run({ state: "stopped" }), names)).toEqual([]);
    expect(stoppedWithLines(run({ state: "stopped", stoppedWith: record({}) }), names)).toEqual([]);
  });
});

describe("a run stopped for timeouts (F-101)", () => {
  it("F-101: the ending says how many calls in a row timed out", () => {
    expect(
      endingOf(run({ state: "stopped", stopRequestedAt: NOW - 1, stoppedForTimeouts: 3 })),
    ).toMatchObject({ kind: "stopped", timeouts: 3 });
  });
});

describe("the status line while the gateway retries (F-082)", () => {
  it("F-082: a retry says the attempt, ahead of Thinking, and a pending card still comes first", () => {
    const retrying = run({ retry: { attempt: 2, of: 5, reason: "rate_limit" } });
    expect(statusLineFor(retrying, transcript([retrying]), live).phrase).toBe(
      "Rate limited. Retrying, attempt 2 of 5",
    );
    const waiting = run({
      state: "waiting",
      retry: { attempt: 2, of: 5, reason: "rate_limit" },
      pendingCards: [{ id: "a-1", kind: "approval", since: NOW }],
    });
    expect(statusLineFor(waiting, transcript([waiting]), live).phrase).toBe("Waiting for you");
  });

  it("F-082: only a rate limit is called one; a retry for any other reason the gateway names is said plainly", () => {
    for (const reason of ["output_limit", "overloaded", "timeout", "unknown"]) {
      const retrying = run({ retry: { attempt: 3, of: 10, reason } });
      const phrase = statusLineFor(retrying, transcript([retrying]), live).phrase;
      expect(phrase).toBe("Retrying, attempt 3 of 10");
      expect(phrase).not.toMatch(/unavailable|rate limit/i);
    }
  });
});

describe("a stop after timeouts (F-101)", () => {
  it("F-101: when the automatic stop was refused, a later Stop's ending is a plain stop's", () => {
    expect(
      endingOf(run({ state: "stopped", stopRequestedAt: 1, stoppedForTimeouts: 0 })),
    ).toMatchObject({ kind: "stopped", timeouts: null });
    expect(
      endingOf(run({ state: "stopped", stopRequestedAt: 1, stoppedForTimeouts: 3 })),
    ).toMatchObject({ kind: "stopped", timeouts: 3 });
  });
});
