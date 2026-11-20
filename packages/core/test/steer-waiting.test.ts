// A run is shown as ended only when the gateway said it ended (parity F-468, F-096). A steer
// into a run waiting on an approval or a question: OpenClaw 2026.10.6 keeps that run waiting and
// holds the steer as a queued turn of its own, which `chat.history` then reports as the run in
// flight. Neither the steer's answer nor that history read, nor a reconnect's, ends the run.
import { describe, expect, it } from "vitest";
import { agentEvent, grantingGateway, KEY, openTask, questionRecord } from "./client-harness.ts";
import { sleep, until } from "./fake-gateway.ts";
import {
  applyAgentEvent,
  emptyActivity,
  mergeHistoryRuns,
  RawTable,
  runsFromHistory,
} from "../src/runs.ts";

const RUN = "run-w";
const QUEUED = "run-queued";

/** History as the gateway answers after the steer: the waiting run's rows, the steer queued. */
function steeredHistory(steering: { on: boolean }) {
  return () => ({
    messages: [
      {
        role: "user",
        content: "#approve",
        __openclaw: { id: "u1", idempotencyKey: `${RUN}:user` },
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: { command: "ls" } }],
        stopReason: "toolUse",
        __openclaw: { id: "a1", runId: RUN },
      },
    ],
    hasMore: false,
    ...(steering.on
      ? {
          inFlightRun: { runId: QUEUED },
          pendingInputs: {
            items: [{ id: "p1", state: "queued", runId: QUEUED, message: { role: "user" } }],
            total: 1,
          },
        }
      : { inFlightRun: { runId: RUN } }),
  });
}

async function waitingOn(card: "approval" | "question") {
  const gateway = grantingGateway();
  const steering = { on: false };
  gateway.handlers["chat.history"] = steeredHistory(steering);
  gateway.handlers["chat.send"] = () => ({ runId: "steer-1", status: "started", messageSeq: 5 });
  // The card stays pending on the gateway, as its lists say on every read.
  const approval = {
    id: "approval-1",
    request: { command: "ls", sessionKey: KEY, runId: RUN },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 600_000,
  };
  gateway.handlers["exec.approval.list"] = () => (card === "approval" ? [approval] : []);
  gateway.handlers["plugin.approval.list"] = () => [];
  gateway.handlers["openclaw.approval.list"] = () => [];
  gateway.handlers["question.list"] = () => ({
    questions: card === "question" ? [questionRecord("ask_1", RUN)] : [],
  });
  const task = await openTask({ gateway });
  gateway.emit("agent", agentEvent(RUN, 1, "lifecycle", { phase: "start" }));
  if (card === "approval") {
    gateway.emit("agent", agentEvent(RUN, 2, "lifecycle", { phase: "waiting-approval" }));
    gateway.emit("exec.approval.requested", approval);
  } else {
    gateway.emit("question.requested", questionRecord("ask_1", RUN));
  }
  await until(() => task.transcript().runs[0]?.state === "waiting");
  return { ...task, steering };
}

/** Drop the connection and wait for the task's history as the new connection loaded it. */
async function reconnected(task: Awaited<ReturnType<typeof waitingOn>>) {
  const before = task.client.state.connection.connectedAt;
  task.gateway.dropAll();
  await until(() => {
    const at = task.client.state.connection.connectedAt;
    const loaded = task.transcript().loadedAt;
    return (
      task.client.state.connection.status === "connected" &&
      at !== null &&
      at !== before &&
      loaded !== null &&
      loaded >= at
    );
  }, 10_000);
}

const run = (task: Awaited<ReturnType<typeof waitingOn>>) =>
  task.transcript().runs.find((each) => each.id === RUN)!;

describe("a steered run that waits on you (F-468, F-096)", () => {
  it("F-468 F-096: a steer into a run waiting on an approval, then a reconnect: the run stays waiting with its approval pending", async () => {
    const task = await waitingOn("approval");
    task.client.sendMessage(KEY, "Only the notes folder.");
    await until(() => task.gateway.calls("chat.send").length === 1);
    task.steering.on = true;
    // The history read after the steer, as the gateway then answers it.
    await sleep(100);
    expect(run(task).state).toBe("waiting");
    await reconnected(task);
    await sleep(100);
    expect(run(task)).toMatchObject({ state: "waiting" });
    expect(task.transcript().approvals.map((each) => each.status)).toEqual(["pending"]);
    // The gateway's own end is what ends it.
    task.gateway.emit("agent", agentEvent(RUN, 9, "lifecycle", { phase: "end" }));
    await until(() => run(task).state === "completed");
    task.client.stop();
  });

  it("F-468: a steer into a run waiting on a question is held, and a reconnect does not end the run", async () => {
    const task = await waitingOn("question");
    task.client.sendMessage(KEY, "Only the notes folder.");
    expect(task.transcript().outbox[0]!.status).toBe("held");
    task.steering.on = true;
    await reconnected(task);
    await sleep(100);
    expect(run(task).state).toBe("waiting");
    expect(task.transcript().questions[0]!.status).toBe("pending");
    expect(task.gateway.calls("chat.send")).toEqual([]);
    task.client.stop();
  });

  it("F-468: with nothing of the task in flight or queued on the gateway, a run history shows stopped at a tool call still settles, its outcome not known", async () => {
    const task = await waitingOn("approval");
    task.gateway.handlers["chat.history"] = () => ({
      ...steeredHistory({ on: false })(),
      inFlightRun: undefined,
    });
    task.gateway.dropAll();
    await until(() => run(task).state === "completed");
    expect(run(task).outcomeKnown).toBe(false);
    task.client.stop();
  });
  it("F-468: a task opened anew, its history showing that run's rows short of an end and the steer queued, shows the run not ended", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = steeredHistory({ on: true });
    const task = await openTask({ gateway });
    const opened = task.transcript().runs.find((each) => each.id === RUN)!;
    expect(opened.state).not.toBe("completed");
    expect(opened.endFromRows ?? false).toBe(false);
    task.client.stop();
  });

  it("F-468: a question still listed after a history gap continues to hold the draft", async () => {
    const gateway = grantingGateway();
    let gap = false;
    // After the gap, history holds none of the run and nothing in flight: its end only inferred.
    gateway.handlers["chat.history"] = () =>
      gap
        ? { messages: [], hasMore: false }
        : { messages: [], hasMore: false, inFlightRun: { runId: RUN } };
    gateway.handlers["question.list"] = () => ({ questions: [questionRecord("ask_1", RUN)] });
    const approval = {
      id: "approval-1",
      request: { command: "ls", sessionKey: KEY, runId: RUN },
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 600_000,
    };
    gateway.handlers["exec.approval.list"] = () => [approval];
    gateway.handlers["plugin.approval.list"] = () => [];
    gateway.handlers["openclaw.approval.list"] = () => [];
    const task = await openTask({ gateway });
    gateway.emit("agent", agentEvent(RUN, 1, "lifecycle", { phase: "start" }));
    gateway.emit("question.requested", questionRecord("ask_1", RUN));
    gateway.emit("exec.approval.requested", approval);
    await until(() => task.transcript().questions[0]?.status === "pending");
    gap = true;
    gateway.dropAll();
    await until(
      () =>
        task.transcript().runs.find((each) => each.id === RUN)?.state !== "waiting" &&
        task.transcript().runs.find((each) => each.id === RUN)?.state !== "running",
      10_000,
    ).catch(() => {});
    await sleep(200);
    // The gateway still lists the question as pending: it stays pending, and a message is held.
    expect(task.transcript().questions[0]!.status).toBe("pending");
    expect(task.transcript().approvals[0]!.runEnded).toBe(false);
    task.client.sendMessage(KEY, "About that");
    await sleep(100);
    expect(task.transcript().outbox[0]!.status).toBe("held");
    expect(gateway.calls("chat.send")).toEqual([]);
    gateway.emit("question.resolved", {
      id: "ask_1",
      status: "answered",
      sessionKey: KEY,
      ts: Date.now(),
    });
    await until(() => gateway.calls("chat.send").length === 1);
    task.client.stop();
  });

  it("F-468: a message held by a question while no run is going shows no run until the question settles, then goes as a turn of its own", async () => {
    const gateway = grantingGateway();
    let gap = false;
    gateway.handlers["chat.history"] = () =>
      gap
        ? { messages: [], hasMore: false }
        : { messages: [], hasMore: false, inFlightRun: { runId: RUN } };
    gateway.handlers["question.list"] = () => ({ questions: [questionRecord("ask_1", RUN)] });
    const task = await openTask({ gateway });
    gateway.emit("agent", agentEvent(RUN, 1, "lifecycle", { phase: "start" }));
    gateway.emit("question.requested", questionRecord("ask_1", RUN));
    await until(() => task.transcript().questions[0]?.status === "pending");
    // A gap after which history holds nothing of the run: its end is inferred, the question listed.
    gap = true;
    gateway.dropAll();
    await until(() => {
      const state = task.transcript().runs.find((each) => each.id === RUN)?.state;
      return state !== undefined && state !== "waiting" && state !== "running";
    }, 10_000);
    await sleep(200);
    expect(task.transcript().questions[0]!.status).toBe("pending");
    const id = task.client.sendMessage(KEY, "About that");
    await sleep(100);
    // Held, and nothing shows as running for it: nothing has left.
    expect(task.transcript().outbox.find((each) => each.id === id)?.status).toBe("held");
    expect(
      task
        .transcript()
        .runs.filter((each) => ["running", "waiting", "stopping"].includes(each.state)),
    ).toEqual([]);
    gateway.emit("question.resolved", {
      id: "ask_1",
      status: "answered",
      sessionKey: KEY,
      ts: Date.now(),
    });
    await until(() => gateway.calls("chat.send").length === 1);
    // A turn of its own, not a steer into a run of its own making.
    expect(gateway.calls("chat.send")[0]).toMatchObject({
      message: "About that",
      queueMode: "followup",
    });
    task.client.stop();
  });
});

describe("a call of a run history only infers to have ended (F-468)", () => {
  it("F-468: while the gateway runs another turn, history's inferred end leaves the live run's open call open, and its own result closes it", () => {
    const ctx = { sessionKey: KEY, now: 5_000, raw: new RawTable() };
    const event = (seq: number, stream: string, data: object) => ({
      runId: "r-old",
      seq,
      stream,
      ts: 1_000 + seq,
      sessionKey: KEY,
      data,
    });
    let activity = applyAgentEvent(
      emptyActivity,
      event(1, "lifecycle", { phase: "start" }),
      ctx,
    ).activity;
    activity = applyAgentEvent(
      activity,
      event(2, "tool", { phase: "start", name: "exec", toolCallId: "c1", args: { command: "ls" } }),
      ctx,
    ).activity;
    // History's rows of the run stop at its call, a later turn's rows follow, and the gateway has
    // a turn of the task in flight: it infers the run's end, which the gateway has not said.
    const rows = [
      { role: "user", content: "First", __openclaw: { id: "u1", idempotencyKey: "r-old:user" } },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "exec", arguments: { command: "ls" } }],
        stopReason: "toolUse",
        __openclaw: { id: "a1", runId: "r-old" },
      },
      { role: "user", content: "Then", __openclaw: { id: "u2", idempotencyKey: "r-mid:user" } },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        stopReason: "stop",
        __openclaw: { id: "a2", runId: "r-mid" },
      },
    ];
    const history = runsFromHistory(rows, "r-queued", ctx, { busy: true });
    expect(history.find((run) => run.id === "r-old")?.steps[0]?.status).toBe("unknown");
    const runs = mergeHistoryRuns(activity.runs, history, ctx, true).runs;
    const old = runs.find((run) => run.id === "r-old")!;
    expect(old.state).toBe("running");
    expect(old.steps.find((step) => step.id === "tool:c1")?.status).toBe("running");
    activity = applyAgentEvent(
      { ...activity, runs },
      event(3, "tool", {
        phase: "result",
        name: "exec",
        toolCallId: "c1",
        isError: false,
        result: { content: [{ type: "text", text: "notes" }] },
      }),
      ctx,
    ).activity;
    const step = activity.runs
      .find((run) => run.id === "r-old")!
      .steps.find((each) => each.id === "tool:c1");
    expect(step).toMatchObject({ status: "done", result: { text: "notes" } });
  });
});
