// A turn no person asked for that the bot answered quietly (#680), with each OpenClaw version's
// frames as a development gateway sent them, names made up. 2026.10.6 ends such a turn (its own
// heartbeat turn, for a wake) with lifecycle `end`, `terminalReply.disposition: "silent"`, and a
// `chat` `final` with no message; the row is `done` and history keeps nothing of it. 2026.11.10
// ends it with lifecycle `error` (`livenessState: "abandoned"`, its "no answer" words,
// `terminalReply.disposition: "empty"`, `suppressErrorNotice: true`), a `chat` `error` with the same
// words and the mark, and a row `status: "failed"` with `lastRunError` and the mark; history keeps
// the event's user row and no row of the run. A turn that ended with reasoning only gets the very
// same end and row on 2026.11.10; only its history tells it apart, with the run's reasoning rows.

import { describe, expect, it } from "vitest";
import { answeredNothing, quietPending, settleQuietEnds, type Run } from "../src/runs.ts";
import { MAX_QUIET_CHECKS, QuietChecks, quietInHistory } from "../src/quiet-end.ts";
import { neverRan } from "../src/not-run.ts";
import { mergeSessionRow } from "../src/mapping.ts";
import { agentEvent, grantingGateway, KEY, openTask } from "./client-harness.ts";
import { sleep, until, type FakeGateway } from "./fake-gateway.ts";

const T0 = 1_795_000_000_000;
const OTHER = "agent:otto:nightly-check";
const QUIET = "No answer was returned. Ask again if you still need one.";

type Row = Record<string, unknown>;

/** 2026.11.10's terminal lifecycle data for such a turn. */
const MARKED_END = {
  stopReason: "error",
  aborted: false,
  livenessState: "abandoned",
  phase: "error",
  error: QUIET,
  terminalReply: { disposition: "empty" },
  suppressErrorNotice: true,
  replayInvalid: true,
  executionSettled: true,
};

const markedChat = (runId: string, key = KEY) => ({
  runId,
  sessionKey: key,
  agentId: "otto",
  seq: 15,
  state: "error",
  errorMessage: QUIET,
  suppressErrorNotice: true,
  stopReason: "error",
});

/** The task's row once such a turn ended: the same on 2026.11.10 for a quiet answer and for none. */
const markedRow = (runId: string, key = KEY): Row => ({
  key,
  agentId: "otto",
  status: "failed",
  hasActiveRun: false,
  lastRunError: QUIET,
  lastRunId: runId,
  suppressErrorNotice: true,
  abortedLastRun: false,
  updatedAt: T0 + 5_000,
});

const personRow = {
  role: "user",
  content: "#text",
  timestamp: T0,
  idempotencyKey: "send-1:user",
  provenance: { kind: "external_user" },
  __openclaw: { id: "u-1", seq: 1, idempotencyKey: "send-1:user" },
};
const replyRow = {
  role: "assistant",
  content: [{ type: "text", text: "A plain reply." }],
  stopReason: "stop",
  timestamp: T0 + 1_000,
  __openclaw: { runId: "send-1", id: "a-1", seq: 2 },
};
/** The event the gateway woke the task with, as 2026.11.10 keeps it: a user row of its own. */
const eventRow = {
  role: "user",
  content: "Exec completed (otto-job, code 0) :: the command finished",
  timestamp: T0 + 2_000,
  idempotencyKey: "evt-1",
  provenance: { kind: "internal_system", sourceTool: "cron" },
  __openclaw: {
    senderIsOwner: false,
    transport: { channel: "webchat", messageId: "evt-1" },
    id: "e-1",
    idempotencyKey: "evt-1",
    seq: 3,
  },
};
/** A turn that ended with reasoning only: the row 2026.11.10 keeps for each attempt. */
const thinkingRow = (runId: string, seq: number) => ({
  role: "assistant",
  content: [{ type: "thinking", thinking: "Only thinking, no answer." }],
  stopReason: "stop",
  timestamp: T0 + 2_000 + seq,
  __openclaw: { runId, id: `t-${seq}`, seq },
});
/** A step before the quiet answer: a tool call and its result (the silent row itself is left out). */
const toolRows = (runId: string) => [
  {
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "notes.md" } }],
    stopReason: "toolUse",
    timestamp: T0 + 2_100,
    __openclaw: { runId, id: "c-1", seq: 4 },
  },
  {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "Nothing new." }],
    timestamp: T0 + 2_200,
    __openclaw: { runId, id: "r-1", seq: 5 },
  },
];

function gatewayWith(rows: Row[], history: () => unknown[] | Error): FakeGateway {
  const gateway = grantingGateway();
  gateway.handlers["agents.list"] = () => ({
    defaultId: "otto",
    agents: [{ id: "otto", identity: { name: "Otto" } }],
  });
  gateway.handlers["sessions.subscribe"] = () => ({
    subscribed: true,
    list: { sessions: rows, hasMore: false },
  });
  gateway.handlers["sessions.list"] = () => ({ sessions: rows, hasMore: false });
  gateway.handlers["chat.history"] = () => {
    const messages = history();
    if (messages instanceof Error) throw messages;
    return { messages, hasMore: false };
  };
  return gateway;
}

/** A `sessions.changed` as both versions send it: the flat fields, and the row under `session`. */
function changed(gateway: FakeGateway, session: Row, reason: string | null = null): void {
  const key = session.key as string;
  gateway.emit("sessions.changed", {
    sessionKey: key,
    agentId: "otto",
    ...(reason ? { reason } : {}),
    ...session,
    session,
  });
}

const task = (
  client: { state: { tasksByBot: Record<string, Array<{ key: string; status: string }>> } },
  key = KEY,
) => client.state.tasksByBot.otto?.find((each) => each.key === key);

/** The gateway's own turn of the task, to its marked end and its row, as 2026.11.10 sends them. */
function wakeAndEndMarked(
  gateway: FakeGateway,
  runId: string,
  order: "lifecycle-first" | "chat-first" = "lifecycle-first",
): void {
  changed(
    gateway,
    {
      key: KEY,
      agentId: "otto",
      status: "running",
      hasActiveRun: true,
      suppressErrorNotice: false,
    },
    "agent.run.started",
  );
  gateway.emit("agent", {
    ...agentEvent(runId, 3, "lifecycle", { phase: "start" }),
    ts: T0 + 2_000,
  });
  gateway.emit(
    "agent",
    agentEvent(runId, 5, "lifecycle", { phase: "model", provider: "scripted", model: "dev-1" }),
  );
  gateway.emit(
    "agent",
    agentEvent(runId, 7, "lifecycle", {
      phase: "finishing",
      stopReason: "stop",
      aborted: false,
      livenessState: "working",
    }),
  );
  const lifecycle = () => gateway.emit("agent", agentEvent(runId, 15, "lifecycle", MARKED_END));
  const chat = () => gateway.emit("chat", markedChat(runId));
  if (order === "lifecycle-first") {
    lifecycle();
    chat();
  } else {
    chat();
    lifecycle();
  }
  changed(gateway, markedRow(runId));
}

const runOf = (transcript: () => { runs: Run[] }, id: string) =>
  transcript().runs.find((each) => each.id === id);

describe("a quiet answer to a turn no person asked for is no failure (#680)", () => {
  it("2026.11.10: the marked end, history holding no row of the run, is a quiet answer and the task is done", async () => {
    let rows: unknown[] = [personRow, replyRow];
    const gateway = gatewayWith(
      [{ key: KEY, agentId: "otto", status: "done", hasActiveRun: false, updatedAt: T0 }],
      () => rows,
    );
    const { client, transcript } = await openTask({ gateway });
    rows = [personRow, replyRow, eventRow];
    wakeAndEndMarked(gateway, "wake-1");
    await until(() => runOf(transcript, "wake-1")?.quietEnd === "settled");
    const run = runOf(transcript, "wake-1")!;
    expect(run.state).toBe("completed");
    expect(run.error).toBeNull();
    expect(run.quietError).toBeUndefined();
    expect(neverRan(run)).toBe(false);
    // No failed state, no "last run failed": the row's failure is the quiet end's.
    await until(() => task(client)?.status === "done");
    await sleep(50);
    expect(task(client)?.status).toBe("done");
    client.stop();
  });

  it("2026.11.10: so it is in either order of its two ends, and with its chat error alone", async () => {
    for (const order of ["chat-first", "lifecycle-first"] as const) {
      let rows: unknown[] = [];
      const gateway = gatewayWith(
        [{ key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 }],
        () => rows,
      );
      const { client, transcript } = await openTask({ gateway });
      rows = [eventRow];
      wakeAndEndMarked(gateway, `wake-${order}`, order);
      await until(() => runOf(transcript, `wake-${order}`)?.quietEnd === "settled");
      expect(runOf(transcript, `wake-${order}`)?.state).toBe("completed");
      client.stop();
    }
    const gateway = gatewayWith(
      [{ key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 }],
      () => [eventRow],
    );
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", {
      ...agentEvent("wake-2", 3, "lifecycle", { phase: "start" }),
      ts: T0 + 2_000,
    });
    gateway.emit("chat", markedChat("wake-2"));
    await until(() => runOf(transcript, "wake-2")?.quietEnd === "settled");
    expect(runOf(transcript, "wake-2")?.state).toBe("completed");
    client.stop();
  }, 30_000);

  it("2026.11.10: a quiet answer after a step (a tool call, then the silent token) is one too", async () => {
    let rows: unknown[] = [];
    const gateway = gatewayWith(
      [{ key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 }],
      () => rows,
    );
    const { client, transcript } = await openTask({ gateway });
    rows = [eventRow, ...toolRows("wake-3")];
    wakeAndEndMarked(gateway, "wake-3");
    await until(() => runOf(transcript, "wake-3")?.quietEnd === "settled");
    expect(runOf(transcript, "wake-3")?.state).toBe("completed");
    await until(() => task(client)?.status === "done");
    client.stop();
  });

  it("while history has not been read since the end, it shows nothing, and is no failure", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    const gateway = gatewayWith(
      [{ key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 }],
      () => [eventRow],
    );
    const history = gateway.handlers["chat.history"]!;
    gateway.handlers["chat.history"] = async (params) => {
      reads += 1;
      if (reads > 1) await held;
      return history(params);
    };
    const { client, transcript } = await openTask({ gateway });
    wakeAndEndMarked(gateway, "wake-4");
    await until(() => runOf(transcript, "wake-4")?.quietEnd === "pending");
    expect(runOf(transcript, "wake-4")?.state).toBe("completed");
    expect(runOf(transcript, "wake-4")?.error).toBeNull();
    await until(() => task(client)?.status === "done");
    release();
    await until(() => runOf(transcript, "wake-4")?.quietEnd === "settled");
    client.stop();
  });
});

describe("a real failure is never hidden as a quiet answer (#680)", () => {
  it("2026.11.10: the same marked end after reasoning only, which history keeps, is the failure with the gateway's words", async () => {
    let rows: unknown[] = [];
    const gateway = gatewayWith(
      [{ key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 }],
      () => rows,
    );
    const { client, transcript } = await openTask({ gateway });
    rows = [eventRow, thinkingRow("wake-5", 4), thinkingRow("wake-5", 6), thinkingRow("wake-5", 8)];
    wakeAndEndMarked(gateway, "wake-5");
    await until(() => runOf(transcript, "wake-5")?.state === "failed");
    const run = runOf(transcript, "wake-5")!;
    expect(run.error).toMatchObject({ message: QUIET, quiet: true });
    expect(run.quietEnd).toBeUndefined();
    expect(run.unansweredInHistory).toBe(true);
    // It ran: not a message the gateway couldn't run.
    expect(neverRan(run)).toBe(false);
    await sleep(50);
    expect(task(client)?.status).toBe("failed");
    client.stop();
  });

  it("history read before the end already holding a row that answered nothing fails the run at its end", async () => {
    let rows: unknown[] = [];
    const gateway = gatewayWith(
      [{ key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 }],
      () => rows,
    );
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", {
      ...agentEvent("wake-6", 3, "lifecycle", { phase: "start" }),
      ts: T0 + 2_000,
    });
    rows = [eventRow, thinkingRow("wake-6", 4)];
    // The row's own `session.message` reads history while the run goes on, which says so.
    gateway.handlers["chat.history"] = () => ({
      messages: rows,
      hasMore: false,
      inFlightRun: { runId: "wake-6" },
    });
    gateway.emit("session.message", { sessionKey: KEY, message: thinkingRow("wake-6", 4) });
    await until(() => runOf(transcript, "wake-6")?.unansweredInHistory === true);
    gateway.handlers["chat.history"] = () => new Promise(() => {});
    gateway.emit("chat", markedChat("wake-6"));
    await until(() => runOf(transcript, "wake-6")?.state === "failed");
    expect(runOf(transcript, "wake-6")?.error?.message).toBe(QUIET);
    client.stop();
  });

  it("a row of the run that failed, or one empty, is no quiet answer", async () => {
    for (const row of [
      {
        role: "assistant",
        content: [{ type: "text", text: "Upstream refused." }],
        stopReason: "error",
        timestamp: T0 + 2_100,
        __openclaw: { runId: "wake-7", id: "x-1", seq: 4 },
      },
      {
        role: "assistant",
        content: [],
        stopReason: "stop",
        timestamp: T0 + 2_100,
        __openclaw: { runId: "wake-7", id: "x-2", seq: 4 },
      },
    ]) {
      let rows: unknown[] = [];
      const gateway = gatewayWith(
        [{ key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 }],
        () => rows,
      );
      const { client, transcript } = await openTask({ gateway });
      rows = [eventRow, row];
      wakeAndEndMarked(gateway, "wake-7");
      await until(() => runOf(transcript, "wake-7")?.state === "failed");
      client.stop();
    }
  }, 30_000);

  it("with its history unread (the read failed), the marked end stays the failure", async () => {
    let fail = false;
    const gateway = gatewayWith(
      [{ key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 }],
      () => (fail ? new Error("history unavailable") : []),
    );
    const { client, transcript } = await openTask({ gateway, client: { readAgainMs: 1 } });
    fail = true;
    wakeAndEndMarked(gateway, "wake-8");
    await until(() => runOf(transcript, "wake-8")?.state === "failed", 8_000);
    expect(runOf(transcript, "wake-8")?.error?.message).toBe(QUIET);
    await until(() => task(client)?.status === "failed");
    client.stop();
  }, 30_000);

  it("the same words unmarked (a person's message on 2026.11.10, or a mark not `true`) are a failure", async () => {
    for (const mark of [undefined, false, "true", 1]) {
      const gateway = gatewayWith(
        [{ key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 }],
        () => [eventRow],
      );
      const { client, transcript } = await openTask({ gateway });
      gateway.emit("agent", {
        ...agentEvent("run-9", 3, "lifecycle", { phase: "start" }),
        ts: T0 + 2_000,
      });
      const { suppressErrorNotice: _mark, ...frame } = markedChat("run-9");
      gateway.emit("chat", mark === undefined ? frame : { ...frame, suppressErrorNotice: mark });
      changed(gateway, { ...markedRow("run-9"), suppressErrorNotice: mark ?? false });
      await until(() => runOf(transcript, "run-9")?.state === "failed");
      expect(runOf(transcript, "run-9")?.quietEnd).toBeUndefined();
      await until(() => task(client)?.status === "failed");
      client.stop();
    }
  }, 30_000);

  it("a row's mark on a run the gateway killed keeps it stopped, and a mark with no run named is a failure", async () => {
    const gateway = gatewayWith(
      [
        {
          key: KEY,
          agentId: "otto",
          status: "killed",
          abortedLastRun: true,
          suppressErrorNotice: true,
          hasActiveRun: false,
          updatedAt: T0,
        },
        {
          key: OTHER,
          agentId: "otto",
          status: "failed",
          lastRunError: QUIET,
          suppressErrorNotice: true,
          hasActiveRun: false,
          updatedAt: T0,
        },
      ],
      () => [],
    );
    const { client } = await openTask({ gateway });
    await until(() => task(client, OTHER) !== undefined);
    expect(task(client)?.status).toBe("stopped");
    expect(task(client, OTHER)?.status).toBe("failed");
    client.stop();
  });
});

describe("a task not open: its row's marked failure is read once against its history (#680)", () => {
  const rowsOf = (otherRow: Row): Row[] => [
    { key: KEY, agentId: "otto", status: "done", hasActiveRun: false, updatedAt: T0 },
    otherRow,
  ];

  it("no row of the run that answered nothing: done; one: failed; history unread: failed", async () => {
    for (const [history, status] of [
      [[eventRow], "done"],
      [[eventRow, thinkingRow("wake-10", 4)], "failed"],
      [new Error("history unavailable"), "failed"],
    ] as const) {
      const gateway = gatewayWith(
        rowsOf(markedRow("wake-10", OTHER)),
        () => history as unknown[] | Error,
      );
      let checked = 0;
      const read = gateway.handlers["chat.history"]!;
      gateway.handlers["chat.history"] = (params) => {
        if ((params as { sessionKey: string }).sessionKey !== OTHER)
          return { messages: [], hasMore: false };
        checked += 1;
        return read(params);
      };
      const { client } = await openTask({ gateway });
      await until(() => checked > 0);
      await until(() => task(client, OTHER)?.status === status);
      await sleep(50);
      expect(task(client, OTHER)?.status).toBe(status);
      // Once for the run its row names.
      changed(gateway, { ...markedRow("wake-10", OTHER), updatedAt: T0 + 9_000 });
      await sleep(50);
      expect(checked).toBe(1);
      client.stop();
    }
  }, 30_000);

  it("a check from an earlier connection says nothing: the new one reads again", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let checks = 0;
    const gateway = gatewayWith(rowsOf(markedRow("wake-14", OTHER)), () => [
      eventRow,
      thinkingRow("wake-14", 4),
    ]);
    const read = gateway.handlers["chat.history"]!;
    gateway.handlers["chat.history"] = async (params) => {
      if ((params as { sessionKey: string }).sessionKey !== OTHER) return read(params);
      checks += 1;
      if (checks === 1) await held;
      return read(params);
    };
    const { client } = await openTask({ gateway });
    await until(() => checks === 1);
    // While it is on its way, the connection drops and comes back.
    gateway.dropAll();
    await until(() => checks === 2, 10_000);
    await until(() => task(client, OTHER)?.status === "failed");
    release();
    await sleep(50);
    expect(task(client, OTHER)?.status).toBe("failed");
    client.stop();
  }, 30_000);

  it("a marked failure of a later run is read again", async () => {
    const seen: string[] = [];
    const gateway = gatewayWith(rowsOf(markedRow("wake-11", OTHER)), () => [eventRow]);
    const read = gateway.handlers["chat.history"]!;
    gateway.handlers["chat.history"] = (params) => {
      if ((params as { sessionKey: string }).sessionKey === OTHER) seen.push("read");
      return read(params);
    };
    const { client } = await openTask({ gateway });
    await until(() => seen.length === 1);
    gateway.handlers["chat.history"] = () => ({
      messages: [eventRow, thinkingRow("wake-12", 4)],
      hasMore: false,
    });
    changed(gateway, markedRow("wake-12", OTHER));
    await until(() => task(client, OTHER)?.status === "failed");
    client.stop();
  });
});

describe("a run followed for a card, in a task nobody has open (#680)", () => {
  type Foreign = Map<string, { runs: Run[] }>;
  const foreignRun = (client: unknown, id: string) =>
    (client as { foreign: Foreign }).foreign.get(OTHER)?.runs.find((run) => run.id === id);

  it("settles from its history: quiet with no row that answered nothing, failed with one or unread", async () => {
    for (const [history, state] of [
      [[eventRow], "completed"],
      [[eventRow, thinkingRow("wake-13", 4)], "failed"],
      [new Error("history unavailable"), "failed"],
    ] as const) {
      const gateway = gatewayWith(
        [{ key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 }],
        () => [],
      );
      const { client } = await openTask({ gateway });
      gateway.handlers["chat.history"] = (params) => {
        if ((params as { sessionKey: string }).sessionKey !== OTHER)
          return { messages: [], hasMore: false };
        if (history instanceof Error) throw history;
        return { messages: history, hasMore: false };
      };
      gateway.emit("agent", {
        ...agentEvent("wake-13", 3, "lifecycle", { phase: "start" }, OTHER),
        ts: T0 + 2_000,
      });
      gateway.emit("chat", markedChat("wake-13", OTHER));
      await until(() => {
        const run = foreignRun(client, "wake-13");
        return run?.state === state && run.quietEnd !== "pending";
      });
      client.stop();
    }
  }, 30_000);
});

describe("the rules, alone", () => {
  const run = (over: Partial<Run>): Run =>
    ({
      id: "r",
      state: "completed",
      error: null,
      quietEnd: "pending",
      quietError: { message: QUIET, kind: null, quiet: true },
      ...over,
    }) as Run;

  it("a row answers nothing with no text and no tool call, or when it failed; a silent row is left out by the gateway", () => {
    const row = (content: unknown, stopReason = "stop") => ({
      role: "assistant",
      content,
      stopReason,
    });
    expect(answeredNothing(row([{ type: "thinking", thinking: "…" }]))).toBe(true);
    expect(answeredNothing(row([]))).toBe(true);
    expect(answeredNothing(row([{ type: "text", text: "  " }]))).toBe(true);
    expect(answeredNothing(row(""))).toBe(true);
    expect(answeredNothing(row([{ type: "text", text: "Done." }], "error"))).toBe(true);
    expect(answeredNothing(row([{ type: "text", text: "Done." }]))).toBe(false);
    expect(answeredNothing(row("Done."))).toBe(false);
    expect(answeredNothing(row([{ type: "toolCall", id: "c", name: "read" }], "toolUse"))).toBe(
      false,
    );
    expect(answeredNothing(row([{ type: "tool_use", id: "c", name: "read" }], "toolUse"))).toBe(
      false,
    );
    expect(answeredNothing(row([], "aborted"))).toBe(false);
    expect(answeredNothing({ ...row([]), openclawAbort: { aborted: true } })).toBe(false);
    // Only the bot's own rows: a person's, or a tool's, never.
    expect(answeredNothing({ role: "user", content: "" })).toBe(false);
    expect(answeredNothing({ role: "toolResult", content: [] })).toBe(false);
  });

  it("history holds the run quiet only with no row of it that answered nothing, by its id", () => {
    expect(quietInHistory([eventRow, ...toolRows("r")], "r")).toBe(true);
    expect(quietInHistory([thinkingRow("other", 4)], "r")).toBe(true);
    expect(quietInHistory([thinkingRow("r", 4)], "r")).toBe(false);
    expect(quietInHistory(null, "r")).toBe(true);
  });

  it("a read settles only the ends pending before it was asked; a row that answered nothing fails any", () => {
    expect(settleQuietEnds([run({})], new Set())[0]!.quietEnd).toBe("pending");
    expect(settleQuietEnds([run({})], new Set(["r"]))[0]).toMatchObject({
      quietEnd: "settled",
      state: "completed",
    });
    expect(settleQuietEnds([run({ unansweredInHistory: true })], new Set())[0]).toMatchObject({
      state: "failed",
      error: { message: QUIET },
    });
    expect(settleQuietEnds([run({})], new Set(["r"]), true)[0]).toMatchObject({ state: "failed" });
    expect(settleQuietEnds([run({})], new Set(), true)[0]!.quietEnd).toBe("pending");
    const { quietError: _kept, ...base } = run({ quietEnd: "settled" });
    const settled = [base as Run];
    expect(settleQuietEnds(settled, new Set(["r"]), true)).toBe(settled);
    expect([...quietPending([run({}), run({ id: "s", quietEnd: "settled" })])]).toEqual(["r"]);
  });

  it("a row that reports its run state whole without the mark has none (as for `status`, #664)", () => {
    const marked = markedRow("wake-1");
    expect(mergeSessionRow(marked, { hasActiveRun: true, status: "running" })).not.toHaveProperty(
      "suppressErrorNotice",
    );
    expect(mergeSessionRow(marked, { updatedAt: T0 + 9_000 })).toMatchObject({
      suppressErrorNotice: true,
    });
  });

  it("the checks keep at most their bound, a settled one giving way, and refuse when all are on their way", () => {
    const checks = new QuietChecks();
    for (let i = 0; i < MAX_QUIET_CHECKS; i += 1) expect(checks.begin(`k${i}`, "r", 1)).toBe(true);
    expect(checks.begin("over", "r", 1)).toBe(false);
    checks.settle("k3", "r", 1, "quiet");
    expect(checks.begin("over", "r", 1)).toBe(true);
    expect(checks.verdict("k3", "r", 1)).toBeUndefined();
    expect(checks.verdict("over", "r", 1)).toBe("pending");
    // A later run's check replaces the task's; an earlier run's verdict is not taken for it.
    checks.settle("over", "r", 1, "failed");
    expect(checks.verdict("over", "s", 1)).toBeUndefined();
    checks.begin("over", "s", 1);
    checks.settle("over", "r", 1, "quiet");
    expect(checks.verdict("over", "s", 1)).toBe("pending");
  });

  it("a check on its way or unread on an earlier connection says nothing on the next; a settled one does", () => {
    const checks = new QuietChecks();
    checks.begin("a", "r", 1);
    checks.begin("b", "r", 1);
    checks.settle("b", "r", 1, "unread");
    checks.begin("c", "r", 1);
    checks.settle("c", "r", 1, "failed");
    checks.begin("d", "r", 1);
    checks.settle("d", "r", 1, "quiet");
    expect(["a", "b", "c", "d"].map((key) => checks.verdict(key, "r", 2))).toEqual([
      undefined,
      undefined,
      "failed",
      "quiet",
    ]);
    // An earlier connection's read never settles the check begun again on this one.
    checks.begin("a", "r", 2);
    checks.settle("a", "r", 1, "quiet");
    expect(checks.verdict("a", "r", 2)).toBe("pending");
  });
});
