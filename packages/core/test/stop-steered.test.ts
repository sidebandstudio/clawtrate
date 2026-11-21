// Stop aborts the run running on the task (parity F-097, F-169), whatever acknowledgements the
// client has collected since. OpenClaw 2026.10.6 holds a steer into a run waiting on an approval
// as a queued turn under a run id of its own, which `chat.history` reports in flight. An abort of
// that id stops only the queued turn, and the waiting run goes on. These fakes do what the
// gateway does: only an abort naming the waiting run ends it and settles its approval.
import { describe, expect, it } from "vitest";
import { deferred, GatewayError, sleep, until } from "./fake-gateway.ts";
import { agentEvent, grantingGateway, KEY, openTask } from "./client-harness.ts";

const RUN = "run-w";

function gatewayWithWaitingRun() {
  const gateway = grantingGateway();
  const queued: string[] = [];
  const approval = {
    id: "approval-1",
    request: { command: "ls", sessionKey: KEY, runId: RUN },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 600_000,
  };
  let pending = true;
  let steers = 0;
  gateway.handlers["exec.approval.list"] = () => (pending ? [approval] : []);
  gateway.handlers["plugin.approval.list"] = () => [];
  gateway.handlers["openclaw.approval.list"] = () => [];
  gateway.handlers["question.list"] = () => ({ questions: [] });
  gateway.handlers["chat.send"] = () => {
    // Each steer is held as a queued turn of its own.
    const id = `steer-${(steers += 1)}`;
    queued.push(id);
    return { runId: id, status: "started", messageSeq: 5 };
  };
  gateway.handlers["chat.history"] = () => ({
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
    ...(queued.length > 0
      ? {
          inFlightRun: { runId: queued[0] },
          pendingInputs: {
            items: queued.map((runId) => ({ id: `p-${runId}`, state: "queued", runId })),
            total: queued.length,
          },
        }
      : { inFlightRun: { runId: RUN } }),
  });
  gateway.handlers["chat.abort"] = (params) => {
    const { runId } = params as { runId: string };
    if (runId !== RUN) return { ok: true, aborted: true, runIds: [runId] };
    // The waiting run is aborted: the gateway settles its approval and ends the run.
    pending = false;
    setTimeout(() => {
      gateway.emit("exec.approval.resolved", {
        id: "approval-1",
        decision: "deny",
        ts: Date.now(),
        request: approval.request,
      });
      gateway.emit("agent", agentEvent(RUN, 9, "lifecycle", { phase: "end", aborted: true }));
    }, 0);
    return { ok: true, aborted: true, runIds: [RUN] };
  };
  return { gateway, approval };
}

async function waiting() {
  const { gateway } = gatewayWithWaitingRun();
  const task = await openTask({ gateway });
  // A run this client did not start: the gateway's own events name it.
  gateway.emit("agent", agentEvent(RUN, 1, "lifecycle", { phase: "start" }));
  gateway.emit("agent", agentEvent(RUN, 2, "lifecycle", { phase: "waiting-approval" }));
  gateway.emit("exec.approval.requested", {
    id: "approval-1",
    request: { command: "ls", sessionKey: KEY, runId: RUN },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 600_000,
  });
  await until(() => task.transcript().runs[0]?.state === "waiting");
  return task;
}

type Task = Awaited<ReturnType<typeof waiting>>;
const run = (task: Task, id = RUN) => task.transcript().runs.find((each) => each.id === id);

/** Stop as the composer presses it on the run it shows, here the newest active one. */
async function stopNewest(task: Task) {
  const active = task
    .transcript()
    .runs.filter((each) => ["running", "waiting"].includes(each.state));
  await task.client.stopRun(KEY, active.at(-1)!.id);
}

async function stoppedRightly(task: Task) {
  await until(() => run(task)?.state === "stopped");
  // The abort named the waiting run itself, and the gateway's end is that same run's.
  expect(task.gateway.calls("chat.abort")).toEqual([{ sessionKey: KEY, runId: RUN }]);
  expect(run(task)).toMatchObject({ state: "stopped", outcomeKnown: true });
  // Its approval was settled by the gateway's own record, not only hidden here.
  await until(() => task.transcript().approvals[0]?.status !== "pending");
  expect(task.transcript().approvals[0]!.settledBy.map((each) => each.via)).toContain(
    "exec.approval.resolved",
  );
}

describe("Stop after a steer (F-097, F-169)", () => {
  it("F-097 F-169: Stop after a steer into a run waiting on an approval aborts that run, which the gateway ends and whose approval it settles", async () => {
    const task = await waiting();
    task.client.sendMessage(KEY, "Only the notes folder.");
    await until(() => task.gateway.calls("chat.history").length >= 2);
    await until(() => run(task, "steer-1") !== undefined);
    await stopNewest(task);
    await stoppedRightly(task);
    task.client.stop();
  });

  it("F-097 F-169: after two steers, Stop still aborts the waiting run", async () => {
    const task = await waiting();
    task.client.sendMessage(KEY, "Only the notes folder.");
    task.client.sendMessage(KEY, "And skip the logs.");
    await until(() => task.gateway.calls("chat.send").length === 2);
    await sleep(100);
    await stopNewest(task);
    await stoppedRightly(task);
    task.client.stop();
  });

  it("F-097 F-169: a steer history shows in flight before its send answer still leaves one current run", async () => {
    const task = await waiting();
    // The gateway queues the steer and its history reports it in flight, but answers the send
    // only after this client has read that history.
    const answer = deferred<unknown>();
    const send = task.gateway.handlers["chat.send"]!;
    task.gateway.handlers["chat.send"] = (params) => {
      const reply = send(params);
      task.gateway.emit("session.message", { sessionKey: KEY });
      return answer.promise.then(() => reply);
    };
    task.client.sendMessage(KEY, "Only the notes folder.");
    await until(() => run(task, "steer-1") !== undefined);
    answer.resolve(undefined);
    await until(() => task.transcript().outbox[0]?.status === "sent");
    await stopNewest(task);
    await stoppedRightly(task);
    task.client.stop();
  });

  it("F-097 F-169: after a steer the gateway refused, Stop aborts the waiting run", async () => {
    const task = await waiting();
    task.gateway.handlers["chat.send"] = () => {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "not admitted" });
    };
    task.client.sendMessage(KEY, "Only the notes folder.");
    await until(() => task.transcript().outbox[0]?.status === "failed");
    await stopNewest(task);
    await stoppedRightly(task);
    task.client.stop();
  });
});

describe("Stop with no one current run (F-097)", () => {
  it("F-097: an older missed end cannot redirect Stop away from the current run after reconnect", async () => {
    const gateway = grantingGateway();
    // After a reconnect that missed the original run's end: its rows stop at a tool call, and
    // the gateway has the current run in flight.
    gateway.handlers["chat.history"] = () => ({
      messages: [
        {
          role: "user",
          content: "First",
          __openclaw: { id: "u1", idempotencyKey: "original:user" },
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: { command: "ls" } }],
          stopReason: "toolUse",
          __openclaw: { id: "a1", runId: "original" },
        },
      ],
      hasMore: false,
      inFlightRun: { runId: "current" },
    });
    gateway.handlers["chat.abort"] = (params) => ({
      ok: true,
      aborted: true,
      runIds: [(params as { runId: string }).runId],
    });
    const task = await openTask({ gateway });
    gateway.emit("agent", agentEvent("original", 1, "lifecycle", { phase: "start" }));
    gateway.emit("agent", agentEvent("current", 1, "lifecycle", { phase: "start" }));
    await until(
      () => task.transcript().runs.filter((each) => each.state === "running").length === 2,
    );
    // Both are plausible: Stop is withheld, whichever is asked.
    await task.client.stopRun(KEY, "original");
    await task.client.stopRun(KEY, "current");
    expect(task.gateway.calls("chat.abort")).toEqual([]);
    // The older run's end arrives: one current run, and Stop names it.
    gateway.emit("agent", agentEvent("original", 9, "lifecycle", { phase: "end" }));
    await until(() => run(task, "original")?.state === "completed");
    await task.client.stopRun(KEY, "current");
    expect(task.gateway.calls("chat.abort")).toEqual([{ sessionKey: KEY, runId: "current" }]);
    task.client.stop();
  });
  it.each([
    // What OpenClaw 2026.10.6 answers with no wait for a run it aborted, and for one that hit
    // its turn limit; for the run still going it answers a bare timeout.
    ["stopped", { status: "error", error: "aborted", stopReason: "rpc", endedAt: 5_000 }],
    [
      "failed",
      { status: "timeout", timeoutPhase: "provider", providerStarted: true, endedAt: 5_000 },
    ],
  ] as const)(
    "F-097: after a reconnect that missed a run's end, the gateway's run record ends it (%s) and Stop names the current run",
    async (ended, record) => {
      const gateway = grantingGateway();
      gateway.handlers["chat.abort"] = (params) => ({
        ok: true,
        aborted: true,
        runIds: [(params as { runId: string }).runId],
      });
      gateway.handlers["agent.wait"] = (params) => {
        const { runId } = params as { runId: string };
        return runId === "original" ? { runId, ...record } : { runId, status: "timeout" };
      };
      const task = await openTask({ gateway });
      gateway.emit("agent", agentEvent("original", 1, "lifecycle", { phase: "start" }));
      await until(() => run(task, "original")?.state === "running");
      // Stopped during the gap mid-tool, so its rows stop at the call, and a new run is in flight.
      gateway.handlers["chat.history"] = () => ({
        messages: [
          {
            role: "user",
            content: "First",
            __openclaw: { id: "u1", idempotencyKey: "original:user" },
          },
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "call-1", name: "exec", arguments: { command: "ls" } },
            ],
            stopReason: "toolUse",
            __openclaw: { id: "a1", runId: "original" },
          },
          { role: "user", content: "Second", __openclaw: { id: "u2" } },
        ],
        hasMore: false,
        inFlightRun: { runId: "current" },
      });
      gateway.dropAll();
      await until(() => run(task, "original")?.state === ended);
      expect(run(task, "original")).toMatchObject({ outcomeKnown: true, endedAt: 5_000 });
      expect(run(task, "current")?.state).toBe("running");
      await task.client.stopRun(KEY, "current");
      expect(task.gateway.calls("chat.abort")).toEqual([{ sessionKey: KEY, runId: "current" }]);
      task.client.stop();
    },
  );
  it("F-097: when live events alone leave two runs active, the gateway's run record ends the older and Stop names the current run", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.abort"] = (params) => ({
      ok: true,
      aborted: true,
      runIds: [(params as { runId: string }).runId],
    });
    gateway.handlers["agent.wait"] = (params) => {
      const { runId } = params as { runId: string };
      return runId === "original"
        ? { runId, status: "error", error: "aborted", stopReason: "rpc", endedAt: 5_000 }
        : { runId, status: "timeout" };
    };
    const task = await openTask({ gateway });
    const reads = task.gateway.calls("chat.history").length;
    // The original run's end never arrives here, and the next run starts.
    gateway.emit("agent", agentEvent("original", 1, "lifecycle", { phase: "start" }));
    gateway.emit("agent", agentEvent("current", 1, "lifecycle", { phase: "start" }));
    await until(() => run(task, "original")?.state === "stopped");
    expect(task.gateway.calls("chat.history")).toHaveLength(reads);
    expect(run(task, "original")).toMatchObject({ outcomeKnown: true, endedAt: 5_000 });
    expect(run(task, "current")?.state).toBe("running");
    await task.client.stopRun(KEY, "current");
    expect(task.gateway.calls("chat.abort")).toEqual([{ sessionKey: KEY, runId: "current" }]);
    task.client.stop();
  });
  it("F-097: runs live events leave active are checked one set at a time, and each set once", async () => {
    const gateway = grantingGateway();
    const answer = deferred<void>();
    gateway.handlers["agent.wait"] = async (params) => {
      await answer.promise;
      return { runId: (params as { runId: string }).runId, status: "timeout" };
    };
    const task = await openTask({ gateway });
    const waits = () => task.gateway.calls("agent.wait").length;
    gateway.emit("agent", agentEvent("original", 1, "lifecycle", { phase: "start" }));
    gateway.emit("agent", agentEvent("current", 1, "lifecycle", { phase: "start" }));
    await until(() => waits() === 2);
    // A third run while that check is on its way waits for it.
    gateway.emit("agent", agentEvent("third", 1, "lifecycle", { phase: "start" }));
    await until(() => run(task, "third")?.state === "running");
    expect(waits()).toBe(2);
    // Once it answers, the three are asked about, once: the gateway says each is still going.
    answer.resolve();
    await until(() => waits() === 5);
    gateway.emit("agent", agentEvent("third", 2, "assistant", { text: "Working" }));
    await sleep(10);
    expect(waits()).toBe(5);
    expect(task.transcript().runs.map((each) => each.state)).toEqual([
      "running",
      "running",
      "running",
    ]);
    task.client.stop();
  });
  it("F-097: a turn the gateway withdrew, still listed as cancelled, does not keep an inferred end from settling", async () => {
    const gateway = grantingGateway();
    const task = await openTask({ gateway });
    gateway.emit("agent", agentEvent("original", 1, "lifecycle", { phase: "start" }));
    await until(() => run(task, "original")?.state === "running");
    // Its end was missed: its rows stop at a call, which only infers an end, nothing is in
    // flight, and the only input listed is one the gateway withdrew.
    gateway.handlers["chat.history"] = () => ({
      messages: [
        {
          role: "user",
          content: "First",
          __openclaw: { id: "u1", idempotencyKey: "original:user" },
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: { command: "ls" } }],
          stopReason: "toolUse",
          __openclaw: { id: "a1", runId: "original" },
        },
      ],
      hasMore: false,
      pendingInputs: { items: [{ id: "p-1", state: "cancelled", runId: "withdrawn" }], total: 1 },
    });
    gateway.dropAll();
    await until(() => run(task, "original")?.state !== "running");
    expect(run(task, "original")).toMatchObject({ state: "completed", outcomeKnown: false });
    task.client.stop();
  });
});
