// Where a steer went, and what Stop does with one the gateway still holds, by the gateway's own
// record (docs/research/steer-stop.md). OpenClaw 2026.10.6 answers every steer `started` under
// its idempotency key. One the run takes in gets a bare `chat` final under that id while the run
// goes on; one it holds can be withdrawn with `chat.abort` naming that id, which ends it `chat`
// aborted and lifecycle end `aborted: true`, with no start, and never runs it.
import { describe, expect, it } from "vitest";
import { STEER_WITHDRAWAL_WAIT_MS } from "../src/client.ts";
import { agentEvent, grantingGateway, KEY, openTask } from "./client-harness.ts";
import { deferred, sleep, until } from "./fake-gateway.ts";

const RUN = "run-1";

type Send = { message: string; idempotencyKey: string };

/** A run under way, steered into; `withdraws` is what the gateway answers an abort of a steer. */
async function steered(withdraws: (id: string) => boolean = () => true) {
  const gateway = grantingGateway();
  gateway.handlers["chat.send"] = (params) => ({
    runId: (params as Send).idempotencyKey,
    status: "started",
  });
  gateway.handlers["chat.abort"] = (params) => {
    const { runId } = params as { runId: string };
    if (runId !== RUN && !withdraws(runId)) return { ok: true, aborted: false, runIds: [] };
    setTimeout(() => {
      gateway.emit("chat", { runId, sessionKey: KEY, state: "aborted", stopReason: "rpc" });
      gateway.emit(
        "agent",
        agentEvent(runId, 9, "lifecycle", { phase: "end", aborted: true, status: "cancelled" }),
      );
    }, 0);
    return { ok: true, aborted: true, runIds: [runId] };
  };
  const task = await openTask({ gateway });
  gateway.emit("agent", agentEvent(RUN, 1, "lifecycle", { phase: "start" }));
  await until(() => task.transcript().runs[0]?.state === "running");
  const id = task.client.sendMessage(KEY, "Only the notes folder.");
  await until(() => task.transcript().outbox[0]?.status === "sent");
  return { ...task, id };
}

/** As `steered`, but the gateway holds its answer to the steer's send until `answer` is called. */
async function steeredUnanswered(withdraws: (id: string) => boolean = () => true) {
  const task = await steered(withdraws);
  const held = deferred<unknown>();
  task.gateway.handlers["chat.send"] = () => held.promise;
  const id = task.client.sendMessage(KEY, "Skip the hidden files.");
  // The gateway has the frame; its answer has not come.
  await until(() => task.transcript().outbox[1]?.leftAt != null);
  expect(task.transcript().outbox[1]!.status).toBe("sending");
  return { ...task, id, answer: (reply: unknown) => held.resolve(reply) };
}

const run = (task: Awaited<ReturnType<typeof steered>>, id = RUN) =>
  task.transcript().runs.find((each) => each.id === id);

describe("where a steer went (F-096, F-097, F-468)", () => {
  it("F-096: a steer is only requested until the gateway's bare final under its own id says the run took it in", async () => {
    const task = await steered();
    expect(task.transcript().outbox[0]).toMatchObject({ mode: "steer", runId: RUN });
    expect(task.transcript().outbox[0]!.steer).toBeUndefined();
    task.gateway.emit("chat", { runId: task.id, sessionKey: KEY, state: "final" });
    await until(() => task.transcript().outbox[0]?.steer === "joined");
    // The run it joined goes on, and the steer is no run of its own.
    expect(run(task)?.state).toBe("running");
    expect(run(task, task.id)).toBeUndefined();
    task.client.stop();
  });

  it("F-097 F-468: Stop withdraws a steer the gateway holds by its own id before it stops the run; it is Not sent, and its aborted end is no run", async () => {
    const task = await steered();
    await task.client.stopRun(KEY, RUN);
    await until(() => run(task)?.state === "stopped");
    expect(task.gateway.calls("chat.abort")).toEqual([
      { sessionKey: KEY, runId: task.id },
      { sessionKey: KEY, runId: RUN },
    ]);
    expect(task.transcript().outbox[0]).toMatchObject({
      status: "not-sent",
      steer: "withdrawn",
      runId: null,
    });
    await sleep(50);
    expect(run(task, task.id)).toBeUndefined();
    task.client.stop();
  });

  it("F-468: Send on a withdrawn steer sends it again under a new key, which the gateway has not ended", async () => {
    const task = await steered();
    await task.client.stopRun(KEY, RUN);
    await until(() => run(task)?.state === "stopped");
    expect(task.transcript().outbox[0]!.status).toBe("not-sent");
    task.client.retryMessage(KEY, task.id);
    await until(() => task.gateway.calls("chat.send").length === 2);
    const again = task.gateway.calls("chat.send")[1] as Send;
    expect(again.message).toBe("Only the notes folder.");
    expect(again.idempotencyKey).not.toBe(task.id);
    expect(task.transcript().outbox.map((message) => message.id)).toEqual([again.idempotencyKey]);
    expect(task.transcript().outbox[0]!.steer).toBeUndefined();
    task.client.stop();
  });

  it("F-097: a steer whose withdrawal the gateway does not confirm stays as it was, and the run is still stopped", async () => {
    const task = await steered(() => false);
    await task.client.stopRun(KEY, RUN);
    await until(() => run(task)?.state === "stopped");
    expect(task.transcript().outbox[0]).toMatchObject({ status: "sent", runId: RUN });
    expect(task.transcript().outbox[0]!.steer).toBeUndefined();
    task.client.stop();
  });

  it("F-097 F-468: a steer the run took in is not withdrawn by Stop", async () => {
    const task = await steered();
    task.gateway.emit("chat", { runId: task.id, sessionKey: KEY, state: "final" });
    await until(() => task.transcript().outbox[0]?.steer === "joined");
    await task.client.stopRun(KEY, RUN);
    await until(() => run(task)?.state === "stopped");
    expect(task.gateway.calls("chat.abort")).toEqual([{ sessionKey: KEY, runId: RUN }]);
    expect(task.transcript().outbox[0]!.steer).toBe("joined");
    task.client.stop();
  });

  it("F-097 F-468: a typed /stop whose answer names a held steer leaves it Not sent", async () => {
    const task = await steered();
    task.gateway.handlers["chat.send"] = () => ({
      ok: true,
      aborted: true,
      runIds: [RUN, task.id],
    });
    task.client.sendMessage(KEY, "/stop");
    await until(() => task.transcript().outbox[0]?.status === "not-sent");
    expect(task.transcript().outbox[0]!.steer).toBe("withdrawn");
    task.client.stop();
  });

  it("F-097 F-468: a typed /stop that stops a steer's own turn leaves it delivered, not Not sent", async () => {
    const task = await steered();
    // The gateway ran the steer as a turn of its own: it was delivered.
    task.gateway.emit("agent", agentEvent(task.id, 1, "lifecycle", { phase: "start" }));
    await until(() => run(task, task.id)?.state === "running");
    task.gateway.handlers["chat.send"] = () => ({ ok: true, aborted: true, runIds: [task.id] });
    task.client.sendMessage(KEY, "/stop");
    await until(() => task.transcript().outbox[1]?.status === "handled");
    expect(task.transcript().outbox[0]).toMatchObject({ status: "sent", runId: RUN });
    expect(task.transcript().outbox[0]!.steer).toBeUndefined();
    task.client.stop();
  });

  it("F-097 F-468: Stop before a steer's send is answered withdraws it by its key, and the late answer leaves it Not sent", async () => {
    const task = await steeredUnanswered();
    await task.client.stopRun(KEY, RUN);
    await until(() => run(task)?.state === "stopped");
    const aborts = task.gateway.calls("chat.abort") as Array<{ runId: string }>;
    expect(aborts.map((each) => each.runId)).toContain(task.id);
    expect(aborts.at(-1)!.runId).toBe(RUN);
    await until(() => task.transcript().outbox[1]?.status === "not-sent");
    // The gateway answers the send with the stop it keeps for that key.
    task.answer({ runId: task.id, status: "timeout", summary: "aborted", stopReason: "rpc" });
    await sleep(50);
    expect(task.transcript().outbox[1]).toMatchObject({ status: "not-sent", steer: "withdrawn" });
    expect(run(task, task.id)).toBeUndefined();
    task.client.stop();
  });

  it("F-097 F-468: a steer the gateway had already started into the run before its send was answered is not withdrawn", async () => {
    // The gateway was delivering it into the run: it cannot withdraw it, and says so.
    const task = await steeredUnanswered(() => false);
    await task.client.stopRun(KEY, RUN);
    await until(() => run(task)?.state === "stopped");
    expect((task.gateway.calls("chat.abort") as Array<{ runId: string }>).at(-1)!.runId).toBe(RUN);
    expect(task.transcript().outbox[1]!.status).toBe("sending");
    // Its record arrives: the bare final under its key, then the send's answer.
    task.gateway.emit("chat", { runId: task.id, sessionKey: KEY, state: "final" });
    task.answer({ runId: task.id, status: "started" });
    await until(() => task.transcript().outbox[1]?.status === "sent");
    expect(task.transcript().outbox[1]!.steer).toBe("joined");
    expect(run(task, task.id)).toBeUndefined();
    task.client.stop();
  });

  it("F-097: a withdrawal the gateway does not answer, of a steer whose send is unanswered too, holds the run's Stop only briefly", async () => {
    const task = await steeredUnanswered();
    const abort = task.gateway.handlers["chat.abort"]!;
    task.gateway.handlers["chat.abort"] = (params) =>
      (params as { runId: string }).runId === RUN ? abort(params) : new Promise(() => {});
    const asked = Date.now();
    await task.client.stopRun(KEY, RUN);
    await until(() => run(task)?.state === "stopped");
    expect(Date.now() - asked).toBeLessThan(STEER_WITHDRAWAL_WAIT_MS + 1_000);
    expect(task.transcript().outbox[1]!.steer).toBeUndefined();
    task.client.stop();
  });

  it("F-097 F-468: a withdrawal the gateway confirms after history marked the steer unconfirmed still leaves it Not sent", async () => {
    const task = await steered();
    const abort = task.gateway.handlers["chat.abort"]!;
    const late = deferred<unknown>();
    task.gateway.handlers["chat.abort"] = (params) =>
      (params as { runId: string }).runId === RUN ? abort(params) : late.promise;
    await task.client.stopRun(KEY, RUN);
    await until(() => run(task)?.state === "stopped");
    // The run ended and history does not hold the steer: it reads unconfirmed.
    await until(() => task.transcript().outbox[0]?.status === "unconfirmed");
    late.resolve({ ok: true, aborted: true, runIds: [task.id] });
    await until(() => task.transcript().outbox[0]?.status === "not-sent");
    expect(task.transcript().outbox[0]!.steer).toBe("withdrawn");
    task.client.stop();
  }, 15_000);

  it("F-097: a withdrawal the gateway does not answer holds the run's Stop only briefly", async () => {
    const task = await steered();
    const abort = task.gateway.handlers["chat.abort"]!;
    task.gateway.handlers["chat.abort"] = (params) =>
      (params as { runId: string }).runId === RUN ? abort(params) : new Promise(() => {});
    const asked = Date.now();
    await task.client.stopRun(KEY, RUN);
    await until(() => run(task)?.state === "stopped");
    expect(Date.now() - asked).toBeLessThan(STEER_WITHDRAWAL_WAIT_MS + 1_000);
    // Its fate is not established: it is not withdrawn, and the stop note says it may still run.
    expect(task.transcript().outbox[0]!.runId).toBe(RUN);
    expect(task.transcript().outbox[0]!.status).not.toBe("not-sent");
    expect(task.transcript().outbox[0]!.steer).toBeUndefined();
    task.client.stop();
  });
});
