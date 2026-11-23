// A recipient's run this client follows, because a task's send named it, asks
// its own user a question in a session nobody here has open: the run waits,
// so the sender's Messaged card can say so, and goes on once it is answered.
// Only the run keeps the question's id; the question is not kept.
import { describe, expect, it } from "vitest";
import { agentEvent, KEY, openTask, questionRecord, asShown } from "./client-harness.ts";
import { until } from "./fake-gateway.ts";

const PEER = "agent:marlow:main";

describe("a recipient's run that asks its own user", () => {
  it("F-122: waits while its question is pending, and goes on once it is answered", async () => {
    const { client, gateway, transcript } = await openTask();
    try {
      // This task's bot sends to Marlow; the result names Marlow's run.
      gateway.emit("agent", agentEvent("run-s", 1, "lifecycle", { phase: "start" }));
      gateway.emit(
        "agent",
        agentEvent("run-s", 2, "tool", {
          phase: "start",
          name: "sessions_send",
          toolCallId: "c1",
          args: { agentId: "marlow", message: "Which route?" },
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
            details: { runId: "run-r", sessionKey: PEER, status: "accepted" },
          },
        }),
      );
      // Marlow's run, in a session nobody here has open.
      gateway.emit("agent", agentEvent("run-r", 1, "lifecycle", { phase: "start" }, PEER));
      await until(() => transcript().linkedRuns["run-r"]?.state === "running");

      gateway.emit("question.requested", questionRecord("q-peer", "run-r", PEER));
      await until(() => transcript().linkedRuns["run-r"]?.state === "waiting");
      // Not shown in this task, and not kept for Marlow's session.
      expect(transcript().questions).toEqual([]);
      const kept = (client as unknown as { foreign: Map<string, { questions: unknown[] }> })
        .foreign;
      expect(kept.get(PEER)?.questions).toEqual([]);

      gateway.emit("question.resolved", {
        id: "q-peer",
        status: "answered",
        answers: { answers: { color: ["Blue"] } },
      });
      await until(() => transcript().linkedRuns["run-r"]?.state === "running");

      // The same question asked again, late or repeated: it settled, and stays settled.
      gateway.emit("question.requested", questionRecord("q-peer", "run-r", PEER));
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(transcript().linkedRuns["run-r"]?.state).toBe("running");
      expect(kept.get(PEER)?.questions).toEqual([]);
    } finally {
      client.stop();
    }
  });

  /** This task's bot sends to Marlow, whose run then asks its own user; nobody has Marlow open. */
  async function waitingRecipient() {
    const opened = await openTask();
    const { gateway, transcript } = opened;
    gateway.emit("agent", agentEvent("run-s", 1, "lifecycle", { phase: "start" }));
    gateway.emit(
      "agent",
      agentEvent("run-s", 2, "tool", {
        phase: "result",
        name: "sessions_send",
        toolCallId: "c1",
        isError: false,
        result: {
          content: [{ type: "text", text: "{}" }],
          details: { runId: "run-r", sessionKey: PEER, status: "accepted" },
        },
      }),
    );
    gateway.emit("agent", agentEvent("run-r", 1, "lifecycle", { phase: "start" }, PEER));
    gateway.emit("question.requested", questionRecord("q-peer", "run-r", PEER));
    await until(() => transcript().linkedRuns["run-r"]?.state === "waiting");
    // Marlow's history read on opening shows the run still going; the question list is slow.
    gateway.handlers["chat.history"] = () => ({
      messages: [],
      hasMore: false,
      inFlightRun: { runId: "run-r" },
    });
    let answerList!: (value: unknown) => void;
    gateway.handlers["question.list"] = () => new Promise((resolve) => (answerList = resolve));
    return { ...opened, list: () => answerList };
  }

  it("F-122 F-468: opened while its question is known, Marlow's task holds a message from the first moment, and a list without it settles it", async () => {
    const { client, gateway, list } = await waitingRecipient();
    try {
      client.openSession(PEER);
      const opened = () => client.state.transcripts[PEER]!;
      // Known at once, before any read: the run waits on the question it is known to have.
      expect(opened().runs.find((run) => run.id === "run-r")?.state).toBe("waiting");
      await until(() => opened().status === "ready" && list() !== undefined);
      expect(opened().runs.find((run) => run.id === "run-r")?.state).toBe("waiting");
      client.sendMessage(PEER, "Keep this for after the answer.", asShown(client, PEER));
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(gateway.calls("chat.send")).toEqual([]);
      expect(opened().outbox[0]?.status).toBe("held");
      // The gateway no longer lists it: it settled while nobody here watched.
      list()({ questions: [] });
      await until(() => opened().runs.find((run) => run.id === "run-r")?.state === "running");
      expect(opened().questions).toEqual([]);
      await until(() => gateway.calls("chat.send").length === 1);
    } finally {
      client.stop();
    }
  });

  it("F-122 F-468: opened while its question is known, the question's own resolution lets the run go on", async () => {
    const { client, gateway, list } = await waitingRecipient();
    try {
      client.openSession(PEER);
      const opened = () => client.state.transcripts[PEER]!;
      await until(() => opened().status === "ready" && list() !== undefined);
      gateway.emit("question.resolved", { id: "q-peer", status: "answered" });
      await until(() => opened().runs.find((run) => run.id === "run-r")?.state === "running");
      // A list asked before the answer, still listing it, does not bring it back.
      list()({ questions: [questionRecord("q-peer", "run-r", PEER)] });
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(opened().runs.find((run) => run.id === "run-r")?.state).toBe("running");
      expect(opened().questions.filter((question) => question.status === "pending")).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("carries no other run into a task opened after it was seen while the task was closed", async () => {
    const { client, gateway } = await openTask();
    try {
      // Marlow's own runs, seen while nobody here had Marlow's task open: one finished, one going.
      gateway.emit("agent", agentEvent("run-a", 1, "lifecycle", { phase: "start" }, PEER));
      gateway.emit("agent", agentEvent("run-a", 2, "lifecycle", { phase: "end" }, PEER));
      gateway.emit("agent", agentEvent("run-b", 1, "lifecycle", { phase: "start" }, PEER));
      const kept = (client as unknown as { foreign: Map<string, { runs: unknown[] }> }).foreign;
      await until(() => kept.get(PEER)?.runs.length === 2);
      gateway.handlers["chat.history"] = () => new Promise(() => {});
      client.openSession(PEER);
      // Its history, still loading, rebuilds them: nothing carried stands in for it.
      expect(client.state.transcripts[PEER]!.runs).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("leaves a question of a session this client follows no run of alone", async () => {
    const { client, gateway } = await openTask();
    try {
      gateway.emit("question.requested", questionRecord("q-other", "run-x", "agent:pip:main"));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      const kept = (client as unknown as { foreign: Map<string, unknown> }).foreign;
      expect(kept.has("agent:pip:main")).toBe(false);
      expect(KEY).not.toBe("agent:pip:main");
    } finally {
      client.stop();
    }
  });
});
