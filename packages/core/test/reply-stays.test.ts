// A run's reply stays on screen when the run ends (#912): a run a live frame ended keeps being
// drawn from the engine until a history read holds its rows, on every path a run can end by.
// Every name and text is invented.

import { describe, expect, it } from "vitest";
import { awaitRows, emptyActivity, rowsRead, type Run, type TaskActivity } from "../src/runs.ts";
import { agentEvent, KEY, openTask } from "./client-harness.ts";
import { until } from "./fake-gateway.ts";

const RUN = "run-9";
const user = { role: "user", content: "List the logs.", __openclaw: { id: "u1", seq: 1 } };
const answerRow = {
  role: "assistant",
  content: [{ type: "text", text: "All clean." }],
  __openclaw: { id: "a1", seq: 2, runId: RUN },
};
const lifecycle = (seq: number, phase: string, extra: Record<string, unknown> = {}) =>
  agentEvent(RUN, seq, "lifecycle", { phase, ...extra });
const said = (seq: number, text: string) =>
  agentEvent(RUN, seq, "assistant", { text, delta: text, itemId: "s:1" });
const chat = (seq: number, state: string, extra: Record<string, unknown> = {}) => ({
  runId: RUN,
  sessionKey: KEY,
  seq,
  state,
  ...extra,
});

/** A task open on a gateway whose history reads wait to be answered, one at a time. */
async function withHeldReads() {
  const opened = await openTask();
  const reads: Array<(answer: unknown) => void> = [];
  opened.gateway.handlers["chat.history"] = () =>
    new Promise((resolve) => {
      reads.push(resolve);
    });
  const run = () => opened.transcript().runs.find((each) => each.id === RUN);
  return { ...opened, reads, run };
}

describe("#912: a run a live frame ended keeps its reply drawn until history holds its rows", () => {
  it("an ordinary end, of a run another device started: kept, then let go by the read after it", async () => {
    const { client, gateway, reads, run } = await withHeldReads();
    for (const payload of [lifecycle(1, "start"), said(2, "All clean."), lifecycle(3, "end")])
      gateway.emit("agent", payload);
    await until(() => run()?.state === "completed");
    expect(run()!.awaitsRows).toBe(true);
    // The read the end asks for: the gateway answers with the run's rows and no run in flight.
    await until(() => reads.length > 0);
    reads.shift()!({ messages: [user, answerRow], hasMore: false });
    await until(() => run()?.awaitsRows === undefined);
    client.stop();
  });

  it("a terminal chat event ends it the same way", async () => {
    const { client, gateway, run } = await withHeldReads();
    for (const payload of [lifecycle(1, "start"), said(2, "All clean.")])
      gateway.emit("agent", payload);
    gateway.emit("chat", chat(3, "final"));
    await until(() => run()?.state === "completed");
    expect(run()!.awaitsRows).toBe(true);
    client.stop();
  });

  it("a stop: the stopped run's reply is kept too", async () => {
    const { client, gateway, run } = await withHeldReads();
    for (const payload of [lifecycle(1, "start"), said(2, "Checking the first")])
      gateway.emit("agent", payload);
    gateway.emit("chat", chat(3, "aborted"));
    await until(() => run()?.state === "stopped");
    expect(run()!.awaitsRows).toBe(true);
    client.stop();
  });

  it("an error: the failed run's reply is kept too", async () => {
    const { client, gateway, run } = await withHeldReads();
    for (const payload of [lifecycle(1, "start"), said(2, "Checking the first")])
      gateway.emit("agent", payload);
    gateway.emit("chat", chat(3, "error", { errorMessage: "The provider stopped answering." }));
    await until(() => run()?.state === "failed");
    expect(run()!.awaitsRows).toBe(true);
    client.stop();
  });

  it("a run that ends with tool output and no text waits for nothing: no reply is drawn", async () => {
    const { client, gateway, run } = await withHeldReads();
    for (const payload of [
      lifecycle(1, "start"),
      agentEvent(RUN, 2, "tool", { toolCallId: "c1", name: "ls", phase: "start", args: {} }),
      agentEvent(RUN, 3, "tool", {
        toolCallId: "c1",
        name: "ls",
        phase: "result",
        result: { content: [] },
      }),
      lifecycle(4, "end"),
    ])
      gateway.emit("agent", payload);
    await until(() => run()?.state === "completed");
    expect(run()!.awaitsRows).toBeUndefined();
    client.stop();
  });

  it("a read the gateway answered while the run was still in flight doesn't let it go; the next does", async () => {
    const { client, gateway, reads, run } = await withHeldReads();
    for (const payload of [lifecycle(1, "start"), said(2, "All clean.")])
      gateway.emit("agent", payload);
    // A read asked for during the run, answered before the end, applied after it.
    client.reloadSession(KEY);
    await until(() => reads.length > 0);
    gateway.emit("agent", lifecycle(3, "end"));
    await until(() => run()?.state === "completed");
    reads.shift()!({ messages: [user], hasMore: false, inFlightRun: { runId: RUN } });
    await until(() => reads.length > 0);
    expect(run()!.awaitsRows).toBe(true);
    reads.shift()!({ messages: [user, answerRow], hasMore: false });
    await until(() => run()?.awaitsRows === undefined);
    client.stop();
  });

  it("a read asked for after the end lets it go even if it still names the run in flight", async () => {
    const { client, gateway, reads, run } = await withHeldReads();
    for (const payload of [lifecycle(1, "start"), said(2, "All clean."), lifecycle(3, "end")])
      gateway.emit("agent", payload);
    await until(() => run()?.awaitsRows === true && reads.length > 0);
    reads.shift()!({ messages: [user, answerRow], hasMore: false, inFlightRun: { runId: RUN } });
    await until(() => run()?.awaitsRows === undefined);
    client.stop();
  });

  it("a follow-up that runs as a run of its own: the ended run is kept beside it, and the read after the end lets only it go", async () => {
    const { client, gateway, reads, run } = await withHeldReads();
    const NEXT = "run-10";
    for (const payload of [lifecycle(1, "start"), said(2, "All clean."), lifecycle(3, "end")])
      gateway.emit("agent", payload);
    // The waiting message starts its own run before the read the end asked for is answered.
    gateway.emit("agent", agentEvent(NEXT, 4, "lifecycle", { phase: "start" }));
    gateway.emit(
      "agent",
      agentEvent(NEXT, 5, "assistant", { text: "Now", delta: "Now", itemId: "s:2" }),
    );
    const next = () => client.state.transcripts[KEY]?.runs.find((each) => each.id === NEXT);
    await until(() => next()?.text === "Now");
    expect(run()!.state).toBe("completed");
    expect(run()!.awaitsRows).toBe(true);
    await until(() => reads.length > 0);
    reads.shift()!({ messages: [user, answerRow], hasMore: false, inFlightRun: { runId: NEXT } });
    await until(() => run()?.awaitsRows === undefined);
    expect(next()!.state).toBe("running");
    expect(next()!.awaitsRows).toBeUndefined();
    client.stop();
  });

  it("a read that fails lets it go: no reply is drawn as if history held it", async () => {
    const { client, gateway, reads, run } = await withHeldReads();
    gateway.handlers["chat.history"] = () => Promise.reject(new Error("not reachable"));
    for (const payload of [lifecycle(1, "start"), said(2, "All clean."), lifecycle(3, "end")])
      gateway.emit("agent", payload);
    await until(() => run()?.state === "completed");
    await until(() => run()?.awaitsRows === undefined, 20_000);
    expect(reads).toEqual([]);
    client.stop();
  });

  it("a reconnect in the window: the new connection's read lets it go", async () => {
    const { client, gateway, reads, run } = await withHeldReads();
    for (const payload of [lifecycle(1, "start"), said(2, "All clean."), lifecycle(3, "end")])
      gateway.emit("agent", payload);
    await until(() => run()?.awaitsRows === true);
    gateway.dropAll();
    await until(() => client.state.connection.status === "connected");
    await until(() => reads.length > 0);
    while (reads.length > 0) reads.shift()!({ messages: [user, answerRow], hasMore: false });
    await until(() => run()?.awaitsRows === undefined);
    client.stop();
  });
});

describe("awaitRows and rowsRead", () => {
  const live = (extra: Partial<Run> = {}): TaskActivity => ({
    ...emptyActivity,
    runs: [
      {
        ...({} as Run),
        id: RUN,
        state: "running",
        text: "All clean.",
        textItemId: "s:1",
        preambles: [],
        ...extra,
      } as Run,
    ],
  });
  const ended = (activity: TaskActivity, state: Run["state"] = "completed"): TaskActivity => ({
    ...activity,
    runs: activity.runs.map((run) => ({ ...run, state })),
  });

  it("only an end a frame brings marks the run; a run already ended stays as it is", () => {
    const before = live();
    expect(awaitRows(before, ended(before)).runs[0]!.awaitsRows).toBe(true);
    const done = ended(before);
    expect(awaitRows(done, done).runs[0]!.awaitsRows).toBeUndefined();
  });

  it("a run whose text was placed beside a call has no reply to keep", () => {
    const before = live({
      preambles: [{ id: "s:1", item: "s:1", text: "x", ended: true, beforeCall: "c1" }],
    });
    expect(awaitRows(before, ended(before)).runs[0]!.awaitsRows).toBeUndefined();
  });

  it("a read naming the run in flight keeps it waiting; one that doesn't, or a failed one, lets it go", () => {
    const waiting = [
      { ...live().runs[0]!, state: "completed" as const, awaitsRows: true as const },
    ];
    expect(rowsRead(waiting, RUN)[0]!.awaitsRows).toBe(true);
    expect(rowsRead(waiting, null)[0]!.awaitsRows).toBeUndefined();
    expect(rowsRead(waiting, "another-run")[0]!.awaitsRows).toBeUndefined();
    // Never past a read asked for while it already waited, whatever that read says.
    expect(rowsRead(waiting, RUN, new Set([RUN]))[0]!.awaitsRows).toBeUndefined();
  });
});
