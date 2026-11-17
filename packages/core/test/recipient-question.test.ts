// A recipient's run this client follows, because a task's send named it, asks
// its own user a question in a session nobody here has open: the run waits,
// so the sender's Messaged card can say so, and goes on once it is answered.
// Only the run keeps the question's id; the question is not kept.
import { describe, expect, it } from "vitest";
import { agentEvent, KEY, openTask, questionRecord } from "./client-harness.ts";
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
