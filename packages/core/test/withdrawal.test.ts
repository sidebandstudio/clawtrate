// A viewer that goes away takes its requests with it, whether they were still
// waiting for access, or access was already held, or access settled a moment
// before (B3). The final check runs just before the gateway is asked.

import { describe, expect, it } from "vitest";
import { createBridgeSession } from "../src/bridge.ts";
import { INTERACTIVE_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { agentEvent, grantingGateway, KEY, openTask, questionRecord } from "./client-harness.ts";
import { deferred, sleep, until } from "./fake-gateway.ts";

describe("a withdrawn task creation never reaches the gateway (B3)", () => {
  it("with write access already held, disposed before the scope check resumes", async () => {
    const { client, gateway } = await openTask({ held: INTERACTIVE_SCOPES });
    gateway.handlers["sessions.create"] = () => ({ key: "agent:otto:made", runId: "made" });
    const viewer = createBridgeSession(client);
    const pending = viewer
      .apply({ type: "createTask", botId: "otto", text: "create", label: null })
      .then(
        () => "created",
        (error: Error) => error.message,
      );
    viewer.dispose();
    expect(await pending).toBe("The request was withdrawn.");
    await sleep(20);
    expect(gateway.calls("sessions.create")).toEqual([]);
    expect(client.state.transcripts["agent:otto:made"]).toBeUndefined();
    client.stop();
  });

  it("disposed just after access settles, before the creation continues", async () => {
    const { client, gateway } = await openTask({ held: READ_SCOPES });
    const wait = deferred<unknown>();
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    gateway.handlers["sessions.create"] = () => ({ key: "agent:otto:made", runId: "made" });
    const viewer = createBridgeSession(client);
    const pending = viewer
      .apply({ type: "createTask", botId: "otto", text: "create", label: null })
      .then(
        () => "created",
        (error: Error) => error.message,
      );
    await until(() => client.pendingAccessWaiters === 1);
    // The moment the new hello settles the waiter, the viewer goes away.
    const unsubscribe = client.store.subscribe(() => {
      if (client.pendingAccessWaiters === 0 && client.state.connection.canWrite) {
        unsubscribe();
        viewer.dispose();
      }
    });
    wait.resolve({
      status: "approved",
      requestId: "up-1",
      deviceToken: "rotated",
      scopes: [...INTERACTIVE_SCOPES],
    });
    expect(await pending).toBe("The request was withdrawn.");
    await sleep(20);
    expect(gateway.calls("sessions.create")).toEqual([]);
    client.stop();
  });

  it("Stop, an answer and an approval from a viewer that went away are not sent either", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({ messages: [], inFlightRun: { runId: "run-1" } });
    gateway.handlers["question.resolve"] = () => ({ status: "answered" });
    gateway.handlers["exec.approval.resolve"] = () => ({ ok: true });
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    gateway.emit("question.requested", questionRecord("ask_1", "run-1"));
    gateway.emit("exec.approval.requested", {
      id: "ap-1",
      request: {
        command: "ls",
        sessionKey: KEY,
        runId: "run-1",
        allowedDecisions: ["allow-once", "deny"],
      },
      createdAtMs: 1,
      expiresAtMs: 9_000_000_000_000,
    });
    await until(() => transcript().questions.length === 1 && transcript().approvals.length === 1);
    const viewer = createBridgeSession(client);
    await viewer.apply({ type: "openSession", key: KEY });
    const settled = (promise: Promise<unknown>) =>
      promise.then(
        () => "sent",
        (error: Error) => error.message,
      );
    const results = [
      settled(
        viewer.apply({
          type: "answerQuestion",
          key: KEY,
          questionId: "ask_1",
          answers: { color: ["Blue"] },
        }),
      ),
      settled(
        viewer.apply({
          type: "resolveApproval",
          key: KEY,
          approvalId: "ap-1",
          decision: "deny",
          expiresInDays: null,
        }),
      ),
      settled(viewer.apply({ type: "stopRun", key: KEY, runId: "run-1" })),
    ];
    viewer.dispose();
    const [answer, approval] = await Promise.all(results);
    expect([answer, approval]).toEqual([
      "The request was withdrawn.",
      "The request was withdrawn.",
    ]);
    await sleep(20);
    for (const method of ["question.resolve", "exec.approval.resolve", "chat.abort"]) {
      expect(gateway.calls(method)).toEqual([]);
    }
    // Nothing is left half-done: the question and approval are answerable, the run goes on.
    expect(transcript().questions[0]).toMatchObject({ status: "pending", submitting: false });
    expect(transcript().approvals[0]).toMatchObject({ status: "pending", submitting: false });
    expect(transcript().runs[0]!.state).not.toBe("stopping");
    client.stop();
  });
});
