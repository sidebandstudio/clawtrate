// Losing access, operation by operation: send, Stop, answering a question and
// resolving an approval, started before and after the connection stopped for
// good. None waits forever, each stays retryable, read access is kept, and
// nothing reaches the gateway that it would refuse.

import { describe, expect, it } from "vitest";
import { INTERACTIVE_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { agentEvent, KEY, openTask, questionRecord } from "./client-harness.ts";
import { deferred, FakeGateway, helloOk, sleep, until } from "./fake-gateway.ts";

type ConnectParams = { scopes: string[]; auth?: { deviceToken?: string } };

const execItem = (id: string) => ({
  id,
  request: {
    command: "uname -s",
    host: "gateway",
    sessionKey: KEY,
    runId: "run-1",
    allowedDecisions: ["allow-once", "deny"],
  },
  createdAtMs: 1,
  expiresAtMs: 9_000_000_000_000,
});

function gatewayWithWork() {
  const gateway = new FakeGateway();
  gateway.connectReply = (params) => {
    const { scopes, auth } = params as ConnectParams;
    return { ok: true, payload: helloOk(scopes, auth?.deviceToken ?? "device-token") };
  };
  gateway.handlers["chat.history"] = () => ({ messages: [], inFlightRun: { runId: "run-1" } });
  gateway.handlers["chat.send"] = () => ({ runId: "run-new", status: "started" });
  gateway.handlers["chat.abort"] = () => ({ ok: true, aborted: true });
  gateway.handlers["question.resolve"] = () => ({ status: "answered" });
  gateway.handlers["exec.approval.resolve"] = () => ({ ok: true });
  gateway.handlers["question.list"] = () => ({ questions: [questionRecord("ask_1", "run-1")] });
  gateway.handlers["exec.approval.list"] = () => [execItem("ap-1")];
  gateway.handlers["plugin.approval.list"] = () => [];
  gateway.handlers["openclaw.approval.list"] = () => [];
  return gateway;
}

const revoked = {
  ok: false as const,
  error: {
    code: "UNAUTHORIZED",
    message: "device token mismatch",
    details: { code: "AUTH_DEVICE_TOKEN_MISMATCH", recommendedNextStep: "re_pair" },
  },
};

const ACTIONS = ["chat.send", "chat.abort", "question.resolve", "exec.approval.resolve"];

async function withWork() {
  const gateway = gatewayWithWork();
  const opened = await openTask({ gateway, held: INTERACTIVE_SCOPES });
  gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
  await until(
    () => opened.transcript().questions.length === 1 && opened.transcript().approvals.length === 1,
  );
  return opened;
}

/** Start all four operations; each settles one way or the other. */
function startAll(client: Awaited<ReturnType<typeof withWork>>["client"]) {
  // A question is pending: a plain message would be held. Steer is not wanted here, so queue it.
  const messageId = client.sendMessage(KEY, "after this", { mode: "queue" });
  const settled = (promise: Promise<unknown>) =>
    promise.then(
      () => "resolved",
      (error: Error) => error.message,
    );
  return {
    messageId,
    stop: settled(client.stopRun(KEY, "run-1")),
    answer: settled(client.answerQuestion(KEY, "ask_1", { color: ["Blue"] })),
    approval: settled(client.resolveApproval(KEY, "ap-1", "deny")),
  };
}

describe("operations across a terminal connection failure (A3)", () => {
  it("started before the failure: all are refused when it stops, none waits", async () => {
    const { client, gateway, transcript } = await withWork();
    gateway.connectReply = () => revoked;
    gateway.dropAll();
    await until(() => client.state.connection.status !== "connected");
    const pending = startAll(client);
    await until(() => client.state.connection.status === "error");
    expect(await pending.answer).toMatch(/stopped|refused|Not connected/);
    expect(await pending.approval).toMatch(/stopped|refused|Not connected/);
    expect(await pending.stop).toBe("resolved");
    expect(client.pendingAccessWaiters).toBe(0);
    for (const method of ACTIONS) expect(gateway.calls(method)).toEqual([]);
    // The run went back to how it was, with the reason; the question and approval can be tried again.
    expect(transcript().runs.find((run) => run.id === "run-1")).toMatchObject({
      state: "waiting",
      stopError: expect.any(String),
    });
    expect(transcript().questions[0]).toMatchObject({ status: "pending", submitting: false });
    expect(transcript().approvals[0]).toMatchObject({ status: "pending", submitting: false });
    client.stop();
  });

  it("started after the failure: each fails at once and stays retryable", async () => {
    const { client, gateway, transcript } = await withWork();
    gateway.connectReply = () => revoked;
    gateway.dropAll();
    await until(() => client.state.connection.status === "error");
    const pending = startAll(client);
    expect(await pending.answer).toMatch(/Not connected/);
    expect(await pending.approval).toMatch(/Not connected/);
    expect(await pending.stop).toBe("resolved");
    // The queued message starts once nothing is active; Stop reverted, so it waits queued.
    const queued = transcript().outbox.find((each) => each.id === pending.messageId)!;
    expect(queued.status).toBe("queued");
    expect(client.pendingAccessWaiters).toBe(0);
    expect(transcript().runs.find((run) => run.id === "run-1")!.state).toBe("waiting");
    for (const method of ACTIONS) expect(gateway.calls(method)).toEqual([]);
    // Read state is kept on screen.
    expect(transcript().status).toBe("ready");
    client.stop();
  });

  it("a new task's message sent after the failure fails visibly and is retried once access is back", async () => {
    const gateway = gatewayWithWork();
    gateway.handlers["chat.history"] = () => ({ messages: [] });
    gateway.handlers["question.list"] = () => ({ questions: [] });
    gateway.handlers["exec.approval.list"] = () => [];
    const { client, transcript } = await openTask({ gateway, held: INTERACTIVE_SCOPES });
    const accepting = gateway.connectReply;
    gateway.connectReply = () => revoked;
    gateway.dropAll();
    await until(() => client.state.connection.status === "error");
    const id = client.sendMessage(KEY, "hello");
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().runs.every((run) => run.state !== "running")).toBe(true);
    expect(client.pendingAccessWaiters).toBe(0);
    expect(gateway.calls("chat.send")).toEqual([]);
    // The revoked token is gone: the device reconnects read-only, and the retry asks for access again.
    gateway.connectReply = accepting;
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => ({
      status: "approved",
      requestId: "up-1",
      deviceToken: "rotated",
      scopes: [...INTERACTIVE_SCOPES],
    });
    await client.retryNow();
    await until(() => client.state.connection.status === "connected");
    expect(client.state.connection.canWrite).toBe(false);
    client.retryMessage(KEY, id);
    await until(() => gateway.calls("chat.send").length === 1);
    await sleep(30);
    expect(gateway.calls("chat.send")).toEqual([
      expect.objectContaining({ idempotencyKey: id, message: "hello" }),
    ]);
    client.stop();
  });
});

describe("a capped grant, then an action needing what it left out", () => {
  it.each([
    ["answering a question", "question.resolve"],
    ["resolving an approval", "exec.approval.resolve"],
  ])("%s asks for access again and completes on the second grant", async (_name, method) => {
    const gateway = gatewayWithWork();
    let requests = 0;
    const waits = [deferred<unknown>(), deferred<unknown>()];
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({
      requestId: `up-${(requests += 1)}`,
    });
    gateway.handlers["device.scopes.waitUpgrade"] = () => waits[requests - 1]!.promise;
    const { client, transcript } = await openTask({ gateway, held: READ_SCOPES });
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    await client.requestAccess();
    await until(() => requests === 1);
    waits[0]!.resolve({
      status: "approved",
      requestId: "up-1",
      deviceToken: "rotated",
      scopes: ["operator.read", "operator.write"],
    });
    await until(() => client.state.connection.canWrite);
    expect(client.state.connection).toMatchObject({ canAnswer: false, canApprove: false });
    // Without the scopes the lists were not read; the events still bring the cards.
    gateway.emit("question.requested", questionRecord("ask_1", "run-1"));
    gateway.emit("exec.approval.requested", execItem("ap-1"));
    await until(() => transcript().questions.length === 1 && transcript().approvals.length === 1);
    const action =
      method === "question.resolve"
        ? client.answerQuestion(KEY, "ask_1", { color: ["Blue"] })
        : client.resolveApproval(KEY, "ap-1", "deny");
    await until(() => requests === 2);
    expect(gateway.calls(method)).toEqual([]);
    expect(client.pendingAccessWaiters).toBe(1);
    expect(client.state.connection.scopes).toContain("operator.read");
    waits[1]!.resolve({
      status: "approved",
      requestId: "up-2",
      deviceToken: "rotated-2",
      scopes: [...INTERACTIVE_SCOPES],
    });
    await action;
    expect(gateway.calls(method)).toHaveLength(1);
    expect(client.pendingAccessWaiters).toBe(0);
    expect(client.state.connection).toMatchObject({
      canWrite: true,
      canAnswer: true,
      canApprove: true,
    });
    client.stop();
  });
});
