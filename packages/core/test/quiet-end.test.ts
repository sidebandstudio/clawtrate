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
import {
  answeredNothing,
  isTerminal,
  quietPending,
  RawTable,
  runsFromHistory,
  settleQuietEnds,
  type Run,
} from "../src/runs.ts";
import {
  coveredRuns,
  historyCoversRun,
  MAX_QUIET_CHECKS,
  QUIET_CHECK_ROWS,
  QuietChecks,
  quietInHistory,
  runAliases,
} from "../src/quiet-end.ts";
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

  it("2026.11.10: with its start arriving after its end, it is still settled by its history alone", async () => {
    // The start a late event shows (#686) is kept, and changes nothing: no row of the run is a
    // quiet answer, a row of reasoning only the failure, and neither is one the gateway couldn't run.
    for (const [history, state, status] of [
      [[eventRow], "completed", "done"],
      [[eventRow, thinkingRow("wake-16", 4)], "failed", "failed"],
    ] as const) {
      let rows: unknown[] = [];
      const gateway = gatewayWith(
        [{ key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 }],
        () => rows,
      );
      const { client, transcript } = await openTask({ gateway });
      rows = [...history];
      gateway.emit("chat", markedChat("wake-16"));
      gateway.emit("agent", {
        ...agentEvent("wake-16", 3, "lifecycle", { phase: "start" }),
        ts: T0 + 2_000,
      });
      gateway.emit("agent", agentEvent("wake-16", 15, "lifecycle", MARKED_END));
      changed(gateway, markedRow("wake-16"));
      await until(() => {
        const run = runOf(transcript, "wake-16");
        return run?.quietEnd === "settled" || run?.state === "failed";
      });
      const run = runOf(transcript, "wake-16")!;
      expect(run.state).toBe(state);
      expect(run.startSaid === true || run.reportedStartAt !== null).toBe(true);
      expect(neverRan(run)).toBe(false);
      await until(() => task(client)?.status === status);
      await sleep(50);
      expect(task(client)?.status).toBe(status);
      client.stop();
    }
  }, 30_000);

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
    // Its Raw is the end as the gateway sent it, kept while history was being read.
    const raw = client.readRunRaw(KEY, "wake-5");
    expect(raw?.status).toBe("available");
    // (its lifecycle error, which came first).
    expect(raw?.status === "available" && raw.payload).toMatchObject({
      error: QUIET,
      suppressErrorNotice: true,
      terminalReply: { disposition: "empty" },
    });
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

  it("the run this client holds decides its row: a later read finding nothing doesn't make it quiet", async () => {
    // The task's own reads of its history fail after the end; then every read finds no row of the
    // run, and a check of its row (`QUIET_CHECK_ROWS`) would always have. The run failed when its
    // history couldn't be read, and the task stays failed: its row isn't checked over the run.
    let fail = false;
    const gateway = gatewayWith(
      [{ key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 }],
      () => [eventRow],
    );
    const read = gateway.handlers["chat.history"]!;
    gateway.handlers["chat.history"] = (params) => {
      const { limit } = params as { limit?: number };
      if (fail && limit !== QUIET_CHECK_ROWS) throw new Error("history unavailable");
      return read(params);
    };
    const { client, transcript } = await openTask({ gateway, client: { readAgainMs: 1 } });
    fail = true;
    wakeAndEndMarked(gateway, "wake-15");
    await until(() => runOf(transcript, "wake-15")?.state === "failed", 8_000);
    fail = false;
    changed(gateway, { ...markedRow("wake-15"), updatedAt: T0 + 9_000 });
    await sleep(200);
    expect(runOf(transcript, "wake-15")?.state).toBe("failed");
    expect(task(client)?.status).toBe("failed");
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

  it("with every place for a check taken, a new marked failure isn't read and stays a failure", async () => {
    const others = Array.from({ length: MAX_QUIET_CHECKS + 1 }, (_, i) =>
      markedRow(`wake-n${i}`, `agent:otto:quiet-${i}`),
    );
    const gateway = gatewayWith(
      [
        { key: KEY, agentId: "otto", status: "done", hasActiveRun: false, updatedAt: T0 },
        ...others,
      ],
      () => [eventRow],
    );
    const read = gateway.handlers["chat.history"]!;
    let checks = 0;
    const held: Array<() => void> = [];
    gateway.handlers["chat.history"] = (params) => {
      if ((params as { sessionKey: string }).sessionKey === KEY) return read(params);
      checks += 1;
      // Not answered while the check runs.
      return new Promise((resolve) => held.push(() => resolve({ messages: [], hasMore: false })));
    };
    const { client } = await openTask({ gateway });
    await until(() => checks === MAX_QUIET_CHECKS);
    await sleep(50);
    const statuses = others.map((row) => task(client, row.key as string)?.status);
    expect(statuses.filter((status) => status === "done")).toHaveLength(MAX_QUIET_CHECKS);
    expect(statuses.filter((status) => status === "failed")).toHaveLength(1);
    expect(checks).toBe(MAX_QUIET_CHECKS);
    client.stop();
    for (const answer of held) answer();
  }, 30_000);

  it("checks that failed don't make way for others: history isn't read again and again", async () => {
    const others = Array.from({ length: MAX_QUIET_CHECKS + 1 }, (_, i) =>
      markedRow(`wake-n${i}`, `agent:otto:quiet-${i}`),
    );
    const gateway = gatewayWith(
      [
        { key: KEY, agentId: "otto", status: "done", hasActiveRun: false, updatedAt: T0 },
        ...others,
      ],
      () => [eventRow],
    );
    const read = gateway.handlers["chat.history"]!;
    const checked: string[] = [];
    gateway.handlers["chat.history"] = (params) => {
      const key = (params as { sessionKey: string }).sessionKey;
      if (key === KEY) return read(params);
      checked.push(key);
      throw new Error("history unavailable");
    };
    const { client } = await openTask({ gateway });
    await until(() => checked.length === MAX_QUIET_CHECKS);
    await sleep(200);
    expect(checked).toHaveLength(MAX_QUIET_CHECKS);
    const statuses = others.map((row) => task(client, row.key as string)?.status);
    expect(statuses.every((status) => status === "failed")).toBe(true);
    // A row that no longer reports its marked failure lets its check go: the one left out is read.
    const left = others.map((row) => row.key as string).find((key) => !checked.includes(key))!;
    changed(gateway, {
      ...markedRow("wake-n0", "agent:otto:quiet-0"),
      status: "done",
      suppressErrorNotice: false,
      lastRunError: null,
      updatedAt: T0 + 9_000,
    });
    await until(() => checked.includes(left));
    await sleep(100);
    expect(checked).toHaveLength(MAX_QUIET_CHECKS + 1);
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

describe("a read that doesn't hold the whole run proves nothing (#680)", () => {
  // The reasoning-only row just outside what a page holds: the page has the run's later rows (a
  // tool call and its result) and says the transcript goes on before it.
  const outside = (runId: string) => ({ messages: toolRows(runId), hasMore: true });
  const whole = (runId: string, ...rows: Row[]) => ({
    messages: [eventRow, ...rows, ...toolRows(runId)],
    hasMore: false,
  });
  const limitOf = (params: unknown) => (params as { limit?: number }).limit;
  const keyOf = (params: unknown) => (params as { sessionKey: string }).sessionKey;

  it("an open task: a page that doesn't reach the run's start is read on once; failed unless that holds it whole", async () => {
    for (const [onward, state] of [
      [whole("wake-20", thinkingRow("wake-20", 3)), "failed"],
      [whole("wake-20"), "completed"],
      [outside("wake-20"), "failed"],
      [new Error("history unavailable"), "failed"],
    ] as const) {
      let page: unknown = { messages: [], hasMore: false };
      const onwards: unknown[] = [];
      const gateway = gatewayWith(
        [{ key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 }],
        () => [],
      );
      gateway.handlers["chat.history"] = (params) => {
        if (limitOf(params) !== QUIET_CHECK_ROWS) return page;
        onwards.push(limitOf(params));
        if (onward instanceof Error) throw onward;
        return onward;
      };
      const { client, transcript } = await openTask({ gateway });
      page = outside("wake-20");
      wakeAndEndMarked(gateway, "wake-20");
      await until(() => {
        const run = runOf(transcript, "wake-20");
        return run?.state === "failed" || run?.quietEnd === "settled";
      });
      expect(runOf(transcript, "wake-20")?.state).toBe(state);
      expect(onwards).toEqual([QUIET_CHECK_ROWS]);
      await until(() => task(client)?.status === (state === "failed" ? "failed" : "done"));
      client.stop();
    }
  }, 30_000);

  it("a task not open: its row's check is quiet only with the run's start or its own input in the page", async () => {
    const input = {
      ...eventRow,
      idempotencyKey: "wake-21:user",
      __openclaw: { id: "i-1", seq: 3, idempotencyKey: "wake-21:user" },
    };
    const placeholder = {
      role: "assistant",
      content: [{ type: "text", text: "[chat.history omitted: message too large]" }],
      timestamp: T0 + 2_050,
      __openclaw: { runId: "wake-21", id: "o-1", seq: 4, truncated: true, reason: "oversized" },
    };
    for (const [history, status] of [
      [outside("wake-21"), "failed"],
      [{ messages: [input, ...toolRows("wake-21")], hasMore: true }, "done"],
      [{ ...whole("wake-21"), omission: { omittedCount: 2, byteLimited: true } }, "failed"],
      [whole("wake-21", placeholder), "failed"],
      [{ messages: [eventRow, ...toolRows("wake-21")] }, "failed"],
      // `hasMore: false` without the rows themselves.
      [{ hasMore: false }, "failed"],
    ] as const) {
      const gateway = gatewayWith(
        [
          { key: KEY, agentId: "otto", status: "done", hasActiveRun: false, updatedAt: T0 },
          markedRow("wake-21", OTHER),
        ],
        () => [],
      );
      const asked: unknown[] = [];
      gateway.handlers["chat.history"] = (params) => {
        if (keyOf(params) !== OTHER) return { messages: [], hasMore: false };
        asked.push(limitOf(params));
        return history;
      };
      const { client } = await openTask({ gateway });
      await until(() => asked.length > 0);
      await sleep(50);
      expect(task(client, OTHER)?.status).toBe(status);
      expect(asked).toEqual([QUIET_CHECK_ROWS]);
      client.stop();
    }
  }, 30_000);

  it("a run followed for a card: a page that doesn't reach its start is read on once; failed unless that holds it whole", async () => {
    type Foreign = Map<string, { runs: Run[] }>;
    const foreignRun = (client: unknown) =>
      (client as { foreign: Foreign }).foreign.get(OTHER)?.runs.find((run) => run.id === "wake-23");
    for (const [onward, state] of [
      [whole("wake-23", thinkingRow("wake-23", 3)), "failed"],
      [whole("wake-23"), "completed"],
      [outside("wake-23"), "failed"],
    ] as const) {
      const gateway = gatewayWith(
        [{ key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 }],
        () => [],
      );
      const { client } = await openTask({ gateway });
      gateway.handlers["chat.history"] = (params) => {
        if (keyOf(params) !== OTHER) return { messages: [], hasMore: false };
        return limitOf(params) === QUIET_CHECK_ROWS ? onward : outside("wake-23");
      };
      gateway.emit("agent", {
        ...agentEvent("wake-23", 3, "lifecycle", { phase: "start" }, OTHER),
        ts: T0 + 2_000,
      });
      gateway.emit("chat", markedChat("wake-23", OTHER));
      await until(() => {
        const run = foreignRun(client);
        return run !== undefined && run.quietEnd !== "pending" && isTerminal(run.state);
      });
      expect(foreignRun(client)?.state).toBe(state);
      client.stop();
    }
  }, 30_000);

  it("a run followed for a card whose first read is refused isn't read on: it stays failed", async () => {
    type Foreign = Map<string, { runs: Run[] }>;
    const foreignRun = (client: unknown) =>
      (client as { foreign: Foreign }).foreign.get(OTHER)?.runs.find((run) => run.id === "wake-27");
    const gateway = gatewayWith(
      [{ key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 }],
      () => [],
    );
    const { client } = await openTask({ gateway });
    const onwards: unknown[] = [];
    gateway.handlers["chat.history"] = (params) => {
      if (keyOf(params) !== OTHER) return { messages: [], hasMore: false };
      if (limitOf(params) !== QUIET_CHECK_ROWS) throw new Error("history unavailable");
      onwards.push(limitOf(params));
      // What a read on would have said: quiet.
      return whole("wake-27");
    };
    gateway.emit("agent", {
      ...agentEvent("wake-27", 3, "lifecycle", { phase: "start" }, OTHER),
      ts: T0 + 2_000,
    });
    gateway.emit("chat", markedChat("wake-27", OTHER));
    await until(() => {
      const run = foreignRun(client);
      return run !== undefined && run.quietEnd !== "pending" && isTerminal(run.state);
    });
    expect(foreignRun(client)?.state).toBe("failed");
    expect(onwards).toEqual([]);
    client.stop();
  }, 30_000);

  it("a queued run's rows under the gateway's id, learnt from the read on's own page, count: one of reasoning only fails it", async () => {
    // The run is known by the send's id; the page shows its input keyed by that id and then its
    // rows under the gateway's own id, the last of reasoning only.
    const input = {
      role: "user",
      content: "#think-only",
      timestamp: T0 + 2_000,
      __openclaw: { id: "u-9", seq: 3, idempotencyKey: "send-9:user" },
    };
    const page = {
      messages: [input, ...toolRows("gw-9"), thinkingRow("gw-9", 6)],
      hasMore: true,
    };
    const gateway = gatewayWith(
      [
        { key: KEY, agentId: "otto", status: "done", hasActiveRun: false, updatedAt: T0 },
        markedRow("send-9", OTHER),
      ],
      () => [],
    );
    let asked = 0;
    gateway.handlers["chat.history"] = (params) => {
      if (keyOf(params) !== OTHER) return { messages: [], hasMore: false };
      asked += 1;
      return page;
    };
    const { client } = await openTask({ gateway });
    await until(() => asked > 0);
    await sleep(50);
    expect(task(client, OTHER)?.status).toBe("failed");
    client.stop();
  }, 30_000);

  it("an open task: a read on the socket's end cut off settles nothing; the next connection's read does", async () => {
    let page: unknown = { messages: [], hasMore: false };
    let onwards = 0;
    const gateway = gatewayWith(
      [{ key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 }],
      () => [],
    );
    gateway.handlers["chat.history"] = (params) => {
      if (limitOf(params) !== QUIET_CHECK_ROWS) return page;
      onwards += 1;
      // The first read on is never answered: the connection drops under it.
      return onwards === 1 ? new Promise(() => {}) : whole("wake-26");
    };
    const { client, transcript } = await openTask({ gateway });
    page = outside("wake-26");
    wakeAndEndMarked(gateway, "wake-26");
    await until(() => onwards === 1);
    page = whole("wake-26");
    gateway.dropAll();
    await until(() => runOf(transcript, "wake-26")?.quietEnd === "settled", 10_000);
    expect(runOf(transcript, "wake-26")?.state).toBe("completed");
    client.stop();
  }, 30_000);

  it("a run followed for a card, its pair known: a failed row under the gateway's id fails it", async () => {
    // The pair is the session's own, already kept; the page alone doesn't show it.
    type Activity = { runs: Run[]; queueAliases: Record<string, string> };
    const foreign = (client: unknown) => (client as { foreign: Map<string, Activity> }).foreign;
    const gateway = gatewayWith(
      [{ key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 }],
      () => [],
    );
    const { client } = await openTask({ gateway });
    const failedRow = {
      role: "assistant",
      content: [],
      stopReason: "error",
      timestamp: T0 + 2_100,
      __openclaw: { runId: "gw-28", id: "f-1", seq: 4 },
    };
    gateway.handlers["chat.history"] = (params) =>
      keyOf(params) === OTHER
        ? { messages: [eventRow, failedRow], hasMore: false }
        : { messages: [], hasMore: false };
    gateway.emit("agent", {
      ...agentEvent("send-28", 3, "lifecycle", { phase: "start" }, OTHER),
      ts: T0 + 2_000,
    });
    await until(() => foreign(client).get(OTHER) !== undefined);
    const kept = foreign(client).get(OTHER)!;
    foreign(client).set(OTHER, { ...kept, queueAliases: { "gw-28": "send-28" } });
    gateway.emit("chat", markedChat("send-28", OTHER));
    const run = () =>
      foreign(client)
        .get(OTHER)
        ?.runs.find((each) => each.id === "send-28");
    await until(
      () => run() !== undefined && run()!.quietEnd !== "pending" && isTerminal(run()!.state),
    );
    expect(run()?.state).toBe("failed");
    client.stop();
  }, 30_000);

  it("a task not open, its row naming the gateway's id: the run's input under the send's id shows the page holds it", async () => {
    const input = {
      role: "user",
      content: "#text",
      timestamp: T0 + 2_000,
      __openclaw: { id: "u-29", seq: 3, idempotencyKey: "send-29:user" },
    };
    const gateway = gatewayWith(
      [
        { key: KEY, agentId: "otto", status: "done", hasActiveRun: false, updatedAt: T0 },
        markedRow("gw-29", OTHER),
      ],
      () => [],
    );
    let asked = 0;
    gateway.handlers["chat.history"] = (params) => {
      if (keyOf(params) !== OTHER) return { messages: [], hasMore: false };
      asked += 1;
      return { messages: [input, ...toolRows("gw-29")], hasMore: true };
    };
    const { client } = await openTask({ gateway });
    await until(() => asked > 0);
    await sleep(50);
    expect(task(client, OTHER)?.status).toBe("done");
    client.stop();
  }, 30_000);

  it("the rule alone: a run is held whole under either of its ids", () => {
    const page = (rows: Row[]) => ({ messages: rows, hasMore: true });
    const input = (key: string): Row => ({ role: "user", __openclaw: { idempotencyKey: key } });
    const pairs = { gw: "send" };
    expect(runAliases("gw", pairs)).toEqual(["gw", "send"]);
    expect(runAliases("send", pairs)).toEqual(["send", "gw"]);
    expect(runAliases("other", pairs)).toEqual(["other"]);
    const ids = new Set(["gw", "send"]);
    expect(coveredRuns(page([input("send:user")]), ids, () => null, pairs)).toEqual(ids);
    expect(coveredRuns(page([input("gw:user")]), ids, () => null, pairs)).toEqual(ids);
    expect(coveredRuns(page([input("send:user")]), new Set(["gw"]), () => null)).toEqual(new Set());
  });

  it("the rule alone: the transcript's start or the run's input, and nothing left out", () => {
    const page = (rows: Row[], more?: boolean, extra: Row = {}) => ({
      messages: rows,
      ...(more === undefined ? {} : { hasMore: more }),
      ...extra,
    });
    expect(historyCoversRun(page([], false), "r")).toBe(true);
    expect(historyCoversRun(page([]), "r")).toBe(false);
    expect(historyCoversRun(page([], true), "r")).toBe(false);
    const keyed = { role: "user", __openclaw: { idempotencyKey: "r:user" } };
    expect(historyCoversRun(page([keyed], true), "r")).toBe(true);
    expect(historyCoversRun(page([{ role: "user", idempotencyKey: "r" }], true), "r")).toBe(true);
    expect(historyCoversRun(page([{ role: "user", idempotencyKey: "s:user" }], true), "r")).toBe(
      false,
    );
    expect(historyCoversRun(page([], false, { omission: { omittedCount: 1 } }), "r")).toBe(false);
    expect(historyCoversRun(null, "r")).toBe(false);
    expect(historyCoversRun({ hasMore: false }, "r")).toBe(false);
    expect(historyCoversRun({ messages: null, hasMore: false }, "r")).toBe(false);
  });
});

describe("a long main session: a row of an earlier run shows where this one starts (#680)", () => {
  // A main session past one page (`hasMore: true`): 1,000 rows of earlier turns, a person's and
  // the bot's, then the event the gateway woke the task with. That row is keyed by the event, not
  // by the run (2026.11.10), so only an earlier run's row, written before this run started, shows
  // the page holds the whole run.
  const earlier = (count: number): Row[] =>
    Array.from({ length: count }, (_, i) =>
      i % 2 === 0
        ? {
            role: "user",
            content: `Earlier message ${i}`,
            timestamp: T0 - 100_000 + i * 10,
            __openclaw: { id: `p-${i}`, seq: i + 1, idempotencyKey: `old-${i}:user` },
          }
        : {
            role: "assistant",
            content: [{ type: "text", text: "Done." }],
            stopReason: "stop",
            timestamp: T0 - 100_000 + i * 10,
            __openclaw: { runId: `old-${i - 1}`, id: `a-${i}`, seq: i + 1 },
          },
    );
  const longPage = (rows: Row[]) => ({ messages: rows, hasMore: true, totalMessages: 1_201 });
  /** The run's own later rows, filling a page: its first row, reasoning only, is on an older one. */
  const ownRows = (runId: string, count: number): Row[] =>
    Array.from({ length: count }, (_, i) => ({
      ...(i % 2 === 0 ? toolRows(runId)[0]! : toolRows(runId)[1]!),
      timestamp: T0 + 2_200 + i,
      __openclaw: { runId, id: `own-${i}`, seq: 2_000 + i },
    }));
  /** Another run's row written after this one started (a helper's report, say): no boundary. */
  const laterOther: Row = {
    role: "assistant",
    content: [{ type: "text", text: "A helper's report." }],
    stopReason: "stop",
    timestamp: T0 + 3_000,
    __openclaw: { runId: "helper-1", id: "h-1", seq: 3_000 },
  };
  const keyOf = (params: unknown) => (params as { sessionKey: string }).sessionKey;
  const limitOf = (params: unknown) => (params as { limit?: number }).limit;

  it("a task not open: a quiet wake is done; one whose reasoning row is on an older page stays failed", async () => {
    for (const [page, status] of [
      [longPage([...earlier(999), eventRow]), "done"],
      [longPage([...ownRows("wake-31", 999), laterOther]), "failed"],
    ] as const) {
      const gateway = gatewayWith(
        [
          { key: KEY, agentId: "otto", status: "done", hasActiveRun: false, updatedAt: T0 },
          { ...markedRow("wake-31", OTHER), startedAt: T0 + 2_100 },
        ],
        () => [],
      );
      const asked: unknown[] = [];
      gateway.handlers["chat.history"] = (params) => {
        if (keyOf(params) !== OTHER) return { messages: [], hasMore: false };
        asked.push(limitOf(params));
        return page;
      };
      const { client } = await openTask({ gateway });
      await until(() => asked.length > 0);
      await sleep(50);
      expect(task(client, OTHER)?.status).toBe(status);
      client.stop();
    }
  }, 30_000);

  it("an open task: a quiet wake is settled from the read on; one whose reasoning row is on an older page fails", async () => {
    // One transcript per case, read as its latest 200 rows (the task's read) and its latest 1,000
    // (the read on): the larger holds the smaller.
    const latest = (rows: Row[], count: number) => ({
      messages: rows.slice(-count),
      hasMore: true,
    });
    for (const [rows, state] of [
      // Quiet: an earlier run's rows are outside the latest 200 and inside the latest 1,000.
      [[...earlier(999), eventRow, ...ownRows("wake-32", 300)], "completed"],
      // Reasoning only, its row older than both windows: neither holds the run.
      [
        [...earlier(999), eventRow, thinkingRow("wake-32", 4), ...ownRows("wake-32", 1_000)],
        "failed",
      ],
    ] as const) {
      let ready = false;
      const gateway = gatewayWith(
        [{ key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 }],
        () => [],
      );
      gateway.handlers["chat.history"] = (params) =>
        ready ? latest([...rows], limitOf(params) ?? 200) : { messages: [], hasMore: false };
      const { client, transcript } = await openTask({ gateway });
      ready = true;
      // The task's own read holds no earlier run's row: only the read on can show the boundary.
      const earlierIn = (count: number) =>
        latest([...rows], count).messages.some((row) =>
          String((row as { __openclaw?: { runId?: string } }).__openclaw?.runId).startsWith("old-"),
        );
      expect(earlierIn(200)).toBe(false);
      expect(earlierIn(QUIET_CHECK_ROWS)).toBe(state === "completed");
      wakeAndEndMarked(gateway, "wake-32");
      await until(() => {
        const run = runOf(transcript, "wake-32");
        return run?.state === "failed" || run?.quietEnd === "settled";
      });
      expect(runOf(transcript, "wake-32")?.state).toBe(state);
      client.stop();
    }
  }, 30_000);

  it("the rule alone: only the run machinery's row of another run, written before this run started", () => {
    const row = (role: string, runId: string, at: number): Row => ({
      role,
      content: [{ type: "text", text: "x" }],
      timestamp: at,
      __openclaw: { runId, id: "z", seq: 1 },
    });
    const covers = (rows: Row[], started: number | null) =>
      historyCoversRun(longPage(rows), "r", started);
    expect(covers([row("assistant", "q", 99)], 100)).toBe(true);
    expect(covers([row("toolResult", "q", 99)], 100)).toBe(true);
    expect(covers([row("assistant", "q", 100)], 100)).toBe(false);
    expect(covers([row("assistant", "q", 99)], null)).toBe(false);
    expect(covers([row("user", "q", 99)], 100)).toBe(false);
    expect(covers([row("custom", "q", 99)], 100)).toBe(false);
    expect(covers([row("assistant", "r", 99)], 100)).toBe(false);
    expect(covers([{ role: "assistant", content: [], timestamp: 99 }], 100)).toBe(false);
    // A run's own input counts only as a person's or a system's row: OpenClaw keys some
    // assistant rows by a run's id too.
    expect(covers([{ role: "assistant", idempotencyKey: "r", timestamp: 200 }], 100)).toBe(false);
    expect(covers([{ role: "assistant", idempotencyKey: "r:user", timestamp: 200 }], 100)).toBe(
      false,
    );
    expect(covers([{ role: "user", idempotencyKey: "r", timestamp: 200 }], 100)).toBe(true);
  });
});

describe("the sidebar and the run this client holds agree (#680)", () => {
  type Foreign = Map<string, { runs: Run[] }>;
  const foreignRun = (client: unknown, id: string) =>
    (client as { foreign: Foreign }).foreign.get(OTHER)?.runs.find((run) => run.id === id);
  const keyOf = (params: unknown) => (params as { sessionKey: string }).sessionKey;

  it("a task opened after its row's check found it quiet stays done: its run rebuilt from rows alone doesn't overrule the check", async () => {
    // A routine's turn that used a tool, then answered quietly, on a task opened cold.
    const gateway = gatewayWith(
      [
        { key: KEY, agentId: "otto", status: "done", hasActiveRun: false, updatedAt: T0 },
        markedRow("wake-22", OTHER),
      ],
      () => [],
    );
    let checks = 0;
    gateway.handlers["chat.history"] = (params) => {
      if (keyOf(params) !== OTHER) return { messages: [], hasMore: false };
      checks += 1;
      return { messages: [eventRow, ...toolRows("wake-22")], hasMore: false };
    };
    const { client } = await openTask({ gateway });
    // The check's own verdict, not only a read begun: the row shows done while it is pending too.
    const inner = client as unknown as { quietChecks: QuietChecks; epoch: number };
    await until(
      () => checks > 0 && inner.quietChecks.verdict(OTHER, "wake-22", inner.epoch) === "quiet",
    );
    expect(task(client, OTHER)?.status).toBe("done");
    client.openSession(OTHER);
    await until(() => client.state.transcripts[OTHER]?.status === "ready");
    const run = client.state.transcripts[OTHER]!.runs.find((each) => each.id === "wake-22");
    expect(run).toMatchObject({ origin: "history", state: "completed" });
    // Opening it changes nothing, before any refresh of its row republishes the list.
    await sleep(50);
    expect(task(client, OTHER)?.status).toBe("done");
    // An ordinary refresh of its row.
    changed(gateway, { ...markedRow("wake-22", OTHER), updatedAt: T0 + 9_000 });
    await sleep(100);
    expect(task(client, OTHER)?.status).toBe("done");
    client.stop();
  });

  it("a run followed for a card that its history fails turns its row failed as it settles", async () => {
    const gateway = gatewayWith(
      [
        { key: KEY, agentId: "otto", status: "done", hasActiveRun: false, updatedAt: T0 },
        { key: OTHER, agentId: "otto", status: "done", hasActiveRun: false, updatedAt: T0 },
      ],
      () => [],
    );
    const { client } = await openTask({ gateway });
    gateway.handlers["chat.history"] = (params) =>
      keyOf(params) === OTHER
        ? { messages: [eventRow, thinkingRow("wake-25", 4)], hasMore: false }
        : { messages: [], hasMore: false };
    gateway.emit("agent", {
      ...agentEvent("wake-25", 3, "lifecycle", { phase: "start" }, OTHER),
      ts: T0 + 2_000,
    });
    gateway.emit("chat", markedChat("wake-25", OTHER));
    // The row comes while the run waits for its history: the sidebar goes by the run.
    changed(gateway, markedRow("wake-25", OTHER));
    expect(task(client, OTHER)?.status).toBe("done");
    await until(() => foreignRun(client, "wake-25")?.state === "failed");
    await until(() => task(client, OTHER)?.status === "failed");
    client.stop();
  });

  it("a run followed for a card whose read failed is the sidebar's failure too, though a check would find it quiet", async () => {
    const gateway = gatewayWith(
      [
        { key: KEY, agentId: "otto", status: "done", hasActiveRun: false, updatedAt: T0 },
        { key: OTHER, agentId: "otto", status: "done", hasActiveRun: false, updatedAt: T0 },
      ],
      () => [],
    );
    let fail = true;
    const { client } = await openTask({ gateway });
    gateway.handlers["chat.history"] = (params) => {
      if (keyOf(params) !== OTHER) return { messages: [], hasMore: false };
      if (fail) throw new Error("history unavailable");
      return { messages: [eventRow], hasMore: false };
    };
    gateway.emit("agent", {
      ...agentEvent("wake-24", 3, "lifecycle", { phase: "start" }, OTHER),
      ts: T0 + 2_000,
    });
    gateway.emit("chat", markedChat("wake-24", OTHER));
    await until(() => foreignRun(client, "wake-24")?.state === "failed");
    // Its row now says the same; reads succeed from here on.
    fail = false;
    changed(gateway, markedRow("wake-24", OTHER));
    await sleep(150);
    expect(foreignRun(client, "wake-24")?.state).toBe("failed");
    expect(task(client, OTHER)?.status).toBe("failed");
    client.stop();
  });
});

describe("a sender's card follows a recipient open beside it (#680)", () => {
  it("the recipient's read failing restores its failure on the sender's card too", async () => {
    let fail = false;
    const gateway = gatewayWith(
      [
        { key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 },
        { key: OTHER, agentId: "otto", hasActiveRun: false, updatedAt: T0 },
      ],
      () => [],
    );
    gateway.handlers["chat.history"] = (params) => {
      if (fail && (params as { sessionKey: string }).sessionKey === OTHER)
        throw new Error("history unavailable");
      return { messages: [], hasMore: false };
    };
    const { client, transcript } = await openTask({ gateway });
    client.openSession(OTHER);
    await until(() => client.state.transcripts[OTHER]?.status === "ready");
    gateway.emit("agent", {
      ...agentEvent("wake-33", 3, "lifecycle", { phase: "start" }, OTHER),
      ts: T0 + 2_000,
    });
    // This task's bot messages the other task; the result names its run.
    gateway.emit("agent", agentEvent("run-s", 1, "lifecycle", { phase: "start" }));
    gateway.emit(
      "agent",
      agentEvent("run-s", 2, "tool", {
        phase: "start",
        name: "sessions_send",
        toolCallId: "c1",
        args: { sessionKey: OTHER, message: "Anything new?" },
      }),
    );
    gateway.emit(
      "agent",
      agentEvent("run-s", 3, "tool", {
        phase: "result",
        name: "sessions_send",
        toolCallId: "c1",
        isError: false,
        result: {
          content: [{ type: "text", text: "{}" }],
          details: { runId: "wake-33", sessionKey: OTHER, status: "accepted" },
        },
      }),
    );
    await until(() => transcript().linkedRuns["wake-33"]?.state === "running");
    fail = true;
    gateway.emit("chat", markedChat("wake-33", OTHER));
    const recipient = () =>
      client.state.transcripts[OTHER]?.runs.find((run) => run.id === "wake-33");
    await until(() => recipient()?.state === "failed");
    await until(() => transcript().linkedRuns["wake-33"]?.state === "failed");
    client.stop();
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

  it("after a reload, a turn of reasoning only is rebuilt from history as completed, its rows marked (#766)", () => {
    const [run] = runsFromHistory([eventRow, thinkingRow("wake-30", 4)], null, {
      sessionKey: KEY,
      now: T0 + 9_000,
      raw: new RawTable(),
    });
    // What the conversation shows after a reload; the sidebar goes by the row and its check.
    expect(run).toMatchObject({ id: "wake-30", state: "completed", unansweredInHistory: true });
    expect(run?.error).toBeNull();
  });

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

  it("the checks keep at most their bound, none giving way, and last while their row reports the run", () => {
    const checks = new QuietChecks();
    for (let i = 0; i < MAX_QUIET_CHECKS; i += 1) expect(checks.begin(`k${i}`, "r", 1)).toBe(true);
    expect(checks.begin("over", "r", 1)).toBe(false);
    // A settled one doesn't give way either: the task it held would be read again at once.
    checks.settle("k3", "r", 1, "quiet");
    expect(checks.begin("over", "r", 1)).toBe(false);
    expect(checks.verdict("k3", "r", 1)).toBe("quiet");
    // A task already kept takes its own place again.
    expect(checks.begin("k3", "s", 1)).toBe(true);
    // One whose row no longer reports that run's marked failure is let go, and frees its place.
    checks.retain((key, runId) => key !== "k4" && runId === "r");
    expect(checks.verdict("k3", "s", 1)).toBeUndefined();
    expect(checks.verdict("k4", "r", 1)).toBeUndefined();
    expect(checks.verdict("k5", "r", 1)).toBe("pending");
    expect(checks.begin("over", "r", 1)).toBe(true);
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
