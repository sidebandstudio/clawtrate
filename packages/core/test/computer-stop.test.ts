// "Stop <Bot> in this task" from the Computer tab, through a viewer's bridge session: it stops
// every run of the task by its own id, as archive and delete do, and a viewer that goes away
// while it waits for write access takes it with it, as the conversation's Stop does.

import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createBridgeSession } from "../src/bridge.ts";
import type { ComputerViews } from "../src/computer.ts";
import { READ_SCOPES } from "../src/scopes.ts";
import {
  agentEvent,
  grantingGateway,
  KEY,
  SESSION,
  openTask,
  questionRecord,
} from "./client-harness.ts";
import { deferred, GatewayError, sleep, until } from "./fake-gateway.ts";

const PEER = "agent:marlow:main";

/** `run-s` in this task has messaged Marlow, whose run `run-r` (another task) it started. */
function messagedPeer(gateway: { emit: (event: string, payload: unknown) => void }) {
  gateway.emit("agent", agentEvent("run-s", 1, "lifecycle", { phase: "start" }));
  gateway.emit(
    "agent",
    agentEvent("run-s", 2, "tool", {
      phase: "result",
      name: "sessions_send",
      toolCallId: "c0",
      isError: false,
      result: {
        content: [{ type: "text", text: "{}" }],
        details: { runId: "run-r", sessionKey: PEER, status: "accepted" },
      },
    }),
  );
  gateway.emit("agent", agentEvent("run-r", 1, "lifecycle", { phase: "start" }, PEER));
}

const runEnded = agentEvent("run-s", 9, "lifecycle", {
  phase: "end",
  status: "cancelled",
  aborted: true,
});

describe("the Computer tab's Stop", () => {
  it("F-145: confirming a Stop for the old session never aborts the replacement run", async () => {
    const { client, gateway } = await openTask();
    const viewer = createBridgeSession(client);
    try {
      await viewer.apply({ type: "openSession", key: KEY });
      await viewer.apply({ type: "computerShow", key: KEY });
      gateway.handlers["sessions.describe"] = () => ({
        session: {
          key: KEY,
          sessionId: "replacement",
          hasActiveRun: true,
          activeRunIds: ["run-b"],
        },
      });
      gateway.emit("agent", agentEvent("run-b", 1, "lifecycle", { phase: "start" }));
      await until(
        () => client.state.transcripts[KEY]?.runs.some((run) => run.id === "run-b") === true,
      );
      await viewer.apply({ type: "computerStopTask", key: KEY, sessionId: SESSION });
      expect(client.state.computer?.panes[viewer.computerViewer()!]?.stop?.error).toContain(
        "already deleted or reset",
      );
      expect(gateway.calls("chat.abort")).toEqual([]);
    } finally {
      viewer.dispose();
      client.stop();
    }
  });

  it("F-145: with two runs active and nothing naming the current one, asks the gateway to stop each", async () => {
    const gateway = grantingGateway();
    gateway.handlers["sessions.describe"] = () => ({
      session: {
        key: KEY,
        sessionId: SESSION,
        hasActiveRun: true,
        activeRunIds: ["original", "current"],
      },
    });
    // A reconnect missed the original run's end; the gateway has another run in flight.
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
    gateway.handlers["chat.abort"] = () => ({ ok: true, aborted: true, runIds: [] });
    const { client, transcript } = await openTask({ gateway });
    const viewer = createBridgeSession(client);
    onTestFinished(() => {
      viewer.dispose();
      client.stop();
    });
    gateway.emit("agent", agentEvent("original", 1, "lifecycle", { phase: "start" }));
    gateway.emit("agent", agentEvent("current", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.filter((each) => each.state === "running").length === 2);
    await viewer.apply({ type: "openSession", key: KEY });
    await viewer.apply({ type: "computerShow", key: KEY });
    await viewer.apply({ type: "computerStopTask", key: KEY, sessionId: SESSION });
    const id = viewer.computerViewer()!;
    expect(client.state.computer?.panes[id]?.stop).toMatchObject({
      sending: false,
      runIds: ["original", "current"],
    });
    const asked = gateway.calls("chat.abort").map((call) => (call as { runId?: string }).runId);
    expect(asked).toEqual(expect.arrayContaining(["original", "current"]));
  });

  it("F-145: Stop acts only on a task this viewer still has open: after the task is closed it sends nothing", async () => {
    const gateway = grantingGateway();
    const { client, transcript } = await openTask({ gateway });
    const viewer = createBridgeSession(client);
    onTestFinished(() => {
      viewer.dispose();
      client.stop();
    });
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((each) => each.state === "running"));
    await viewer.apply({ type: "openSession", key: KEY });
    await viewer.apply({ type: "computerShow", key: KEY });
    await viewer.apply({ type: "computerLeave" });
    await viewer.apply({ type: "closeSession", key: KEY });
    await expect(
      viewer.apply({ type: "computerStopTask", key: KEY, sessionId: SESSION }),
    ).rejects.toThrow("This task is not open in this view.");
    expect(gateway.calls("chat.abort")).toEqual([]);
  });

  it("F-145: a Stop still waiting for write access is withdrawn when its viewer goes away", async () => {
    const wait = deferred<unknown>();
    const { client, gateway, transcript } = await openTask({ held: READ_SCOPES });
    const viewer = createBridgeSession(client);
    onTestFinished(() => {
      wait.resolve({ status: "denied" });
      viewer.dispose();
      client.stop();
    });
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    gateway.handlers["chat.abort"] = () => ({ ok: true, aborted: true });
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((each) => each.state === "running"));
    await viewer.apply({ type: "openSession", key: KEY });
    await viewer.apply({ type: "computerShow", key: KEY });
    const stopping = viewer.apply({ type: "computerStopTask", key: KEY, sessionId: SESSION });
    await until(() => client.state.connection.upgrade.status === "pending");
    viewer.dispose();
    wait.resolve({
      status: "approved",
      requestId: "up-1",
      deviceToken: "rotated",
      scopes: ["operator.read", "operator.write"],
    });
    await stopping;
    await sleep(30);
    expect(gateway.calls("chat.abort")).toEqual([]);
  });

  it("F-145: a Stop still waiting for write access is withdrawn when this viewer closes the task, though another window keeps it open", async () => {
    const wait = deferred<unknown>();
    const { client, gateway, transcript } = await openTask({ held: READ_SCOPES });
    const viewer = createBridgeSession(client);
    const other = createBridgeSession(client);
    onTestFinished(() => {
      wait.resolve({ status: "denied" });
      viewer.dispose();
      other.dispose();
      client.stop();
    });
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    gateway.handlers["chat.abort"] = () => ({ ok: true, aborted: true });
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((each) => each.state === "running"));
    await other.apply({ type: "openSession", key: KEY });
    await viewer.apply({ type: "openSession", key: KEY });
    await viewer.apply({ type: "computerShow", key: KEY });
    const stopping = viewer.apply({ type: "computerStopTask", key: KEY, sessionId: SESSION });
    await until(() => client.state.connection.upgrade.status === "pending");
    await viewer.apply({ type: "closeSession", key: KEY });
    wait.resolve({
      status: "approved",
      requestId: "up-1",
      deviceToken: "rotated",
      scopes: ["operator.read", "operator.write"],
    });
    await stopping;
    await until(() => client.state.connection.scopes.includes("operator.write"));
    expect(gateway.calls("chat.abort")).toEqual([]);
  });

  it("F-145: Stop in this task affects only this task: a run its messages started in another task is not stopped", async () => {
    const { client, gateway, transcript } = await openTask();
    const viewer = createBridgeSession(client);
    onTestFinished(() => {
      viewer.dispose();
      client.stop();
    });
    gateway.handlers["chat.abort"] = (params) => {
      if ((params as { sessionKey: string }).sessionKey !== KEY)
        return { ok: true, aborted: true, runIds: ["run-r"] };
      setTimeout(() => gateway.emit("agent", runEnded), 0);
      return { ok: true, aborted: true, runIds: ["run-s"] };
    };
    messagedPeer(gateway);
    await until(() => transcript().linkedRuns["run-r"]?.state === "running");
    await viewer.apply({ type: "openSession", key: KEY });
    await viewer.apply({ type: "computerShow", key: KEY });
    await viewer.apply({ type: "computerStopTask", key: KEY, sessionId: SESSION });
    await until(() => transcript().runs[0]?.state === "stopped");
    // The run's end is where the conversation's Stop asks its recipients: nothing was asked.
    expect(gateway.calls("chat.abort")).toEqual([{ sessionKey: KEY, runId: "run-s" }]);
  });

  it("F-145 F-296: after a refused Stop in this task, the conversation's own Stop still stops the runs its messages started", async () => {
    const { client, gateway, transcript } = await openTask();
    const viewer = createBridgeSession(client);
    onTestFinished(() => {
      viewer.dispose();
      client.stop();
    });
    let refuse = true;
    gateway.handlers["chat.abort"] = (params) => {
      if ((params as { sessionKey: string }).sessionKey !== KEY)
        return { ok: true, aborted: true, runIds: ["run-r"] };
      if (refuse) throw new GatewayError({ code: "UNAVAILABLE", message: "not now" });
      setTimeout(() => gateway.emit("agent", runEnded), 0);
      return { ok: true, aborted: true, runIds: ["run-s"] };
    };
    messagedPeer(gateway);
    await until(() => transcript().linkedRuns["run-r"]?.state === "running");
    await viewer.apply({ type: "openSession", key: KEY });
    await viewer.apply({ type: "computerShow", key: KEY });
    await viewer.apply({ type: "computerStopTask", key: KEY, sessionId: SESSION });
    await until(() => transcript().runs[0]?.state === "running");
    refuse = false;
    await client.stopRun(KEY, "run-s");
    await until(() => (transcript().runs[0]!.stoppedWith?.bots.length ?? 0) === 1);
    expect(gateway.calls("chat.abort")).toContainEqual({ sessionKey: PEER, runId: "run-r" });
  });

  it("F-145: a question cancelled while its run is stopping was cancelled; the run has not ended yet", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.abort"] = () => ({ ok: true, aborted: true, runIds: [] });
    const { client, transcript } = await openTask({ gateway });
    onTestFinished(() => {
      client.stop();
    });
    const closed = vi.spyOn(
      (client as unknown as { computer: ComputerViews }).computer,
      "questionClosed",
    );
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    gateway.emit("question.requested", questionRecord("ask_1", "run-1"));
    await until(() => transcript().questions.length === 1);
    await client.stopRun(KEY, "run-1");
    await until(() => transcript().runs[0]?.state === "stopping");
    gateway.emit("question.resolved", { id: "ask_1", status: "cancelled" });
    await until(() => closed.mock.calls.length > 0);
    expect(closed).toHaveBeenCalledWith(KEY, "ask_1", "cancelled");
  });

  it("F-145: asks the gateway to stop every run at once, not one after another's answer", async () => {
    const gateway = grantingGateway();
    gateway.handlers["sessions.describe"] = () => ({
      session: {
        key: KEY,
        sessionId: SESSION,
        hasActiveRun: true,
        activeRunIds: ["run-1", "run-2"],
      },
    });
    const slow = deferred<unknown>();
    gateway.handlers["chat.abort"] = (params) =>
      (params as { runId?: string }).runId === "run-1"
        ? slow.promise
        : { ok: true, aborted: true, runIds: [] };
    const { client, transcript } = await openTask({ gateway });
    const viewer = createBridgeSession(client);
    onTestFinished(() => {
      slow.resolve({ ok: true, aborted: true, runIds: [] });
      viewer.dispose();
      client.stop();
    });
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    gateway.emit("agent", agentEvent("run-2", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.filter((each) => each.state === "running").length === 2);
    await viewer.apply({ type: "openSession", key: KEY });
    await viewer.apply({ type: "computerShow", key: KEY });
    const stopping = viewer.apply({ type: "computerStopTask", key: KEY, sessionId: SESSION });
    // The first run's answer hasn't come: the second run's Stop has gone anyway.
    await until(() => gateway.calls("chat.abort").length === 2);
    slow.resolve({ ok: true, aborted: true, runIds: [] });
    await stopping;
  });
  it("F-145: Computer hears of a question's closure only once the transcript records it, so the bar sees no pending question", async () => {
    const gateway = grantingGateway();
    const { client, transcript } = await openTask({ gateway });
    onTestFinished(() => {
      client.stop();
    });
    const statuses: string[] = [];
    vi.spyOn(
      (client as unknown as { computer: ComputerViews }).computer,
      "questionClosed",
    ).mockImplementation(() => {
      statuses.push(transcript().questions[0]?.status ?? "none");
    });
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    gateway.emit("question.requested", questionRecord("ask_1", "run-1"));
    await until(() => transcript().questions.length === 1);
    // Answered on another device.
    gateway.emit("question.resolved", { id: "ask_1", status: "answered" });
    await until(() => statuses.length > 0);
    expect(statuses).toEqual(["answered"]);
  });
});
