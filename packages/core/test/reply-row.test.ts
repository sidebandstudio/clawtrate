// The reply's own row in history while its run is still drawn (#872, #738): known by where it
// stands after a call this connection saw start, or after the run's own start, never by its
// words. Every name and text is invented.

import { describe, expect, it } from "vitest";
import { agentEvent, openTask, questionRecord } from "./client-harness.ts";
import { until } from "./fake-gateway.ts";

describe("what the stream was followed from is forgotten when frames may have been missed", () => {
  const followedRun = async () => {
    const opened = await openTask();
    const { gateway, transcript } = opened;
    const events = [
      agentEvent("run-9", 1, "lifecycle", { phase: "start", startedAt: 1_001 }),
      agentEvent("run-9", 2, "tool", {
        toolCallId: "c1",
        name: "ls",
        phase: "start",
        args: { path: "." },
      }),
      agentEvent("run-9", 3, "tool", {
        toolCallId: "c1",
        name: "ls",
        phase: "result",
        result: { content: [] },
      }),
      agentEvent("run-9", 4, "assistant", {
        text: "All clean.",
        delta: "All clean.",
        itemId: "s:2",
      }),
    ];
    for (const payload of events) gateway.emit("agent", payload);
    await until(() => transcript().runs[0]?.text === "All clean.");
    expect(transcript().runs[0]!.textAfter).toEqual({ call: "c1" });
    return opened;
  };

  it("a new connection forgets it at once, before the task is read again", async () => {
    const { client, gateway, transcript } = await followedRun();
    // The read the reconnect makes is not answered: what is forgotten is the hello's doing.
    gateway.handlers["chat.history"] = () => new Promise(() => {});
    gateway.dropAll();
    await until(() => client.state.connection.status === "connected");
    const run = transcript().runs[0]!;
    expect(run.text).toBe("All clean.");
    expect(run.followed).toBeUndefined();
    expect(run.textAfter).toBeUndefined();
    client.stop();
  });

  it("a run whose task was not open when its frames came is not followed when the task opens", async () => {
    const { client, gateway } = await openTask();
    const other = "agent:otto:other-task";
    const frames = [
      agentEvent("run-7", 1, "lifecycle", { phase: "start", startedAt: 1_001 }, other),
      agentEvent(
        "run-7",
        2,
        "assistant",
        { text: "Which one?", delta: "Which one?", itemId: "s:0" },
        other,
      ),
    ];
    for (const payload of frames) gateway.emit("agent", payload);
    // A run waiting on a question is the one a task carries when it opens.
    gateway.emit("question.requested", questionRecord("ask_1", "run-7", other));
    client.openSession(other);
    await until(() => client.state.transcripts[other]?.status === "ready");
    const run = client.state.transcripts[other]!.runs.find((each) => each.id === "run-7")!;
    expect(run.text).toBe("Which one?");
    expect(run.followed).toBeUndefined();
    expect(run.textAfter).toBeUndefined();
    client.stop();
  });
});
