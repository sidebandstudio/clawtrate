// "Stop <Bot> in this task" from the Computer tab, through a viewer's bridge session: it stops
// every run of the task by its own id, as archive and delete do, and a viewer that goes away
// while it waits for write access takes it with it, as the conversation's Stop does.

import { describe, expect, it } from "vitest";
import { createBridgeSession } from "../src/bridge.ts";
import { READ_SCOPES } from "../src/scopes.ts";
import { agentEvent, grantingGateway, KEY, openTask } from "./client-harness.ts";
import { deferred, sleep, until } from "./fake-gateway.ts";

describe("the Computer tab's Stop", () => {
  it("F-145: with two runs active and nothing naming the current one, asks the gateway to stop each", async () => {
    const gateway = grantingGateway();
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
    gateway.emit("agent", agentEvent("original", 1, "lifecycle", { phase: "start" }));
    gateway.emit("agent", agentEvent("current", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.filter((each) => each.state === "running").length === 2);
    const viewer = createBridgeSession(client);
    await viewer.apply({ type: "openSession", key: KEY });
    await viewer.apply({ type: "computerShow", key: KEY });
    await viewer.apply({ type: "computerStopTask" });
    const id = viewer.computerViewer()!;
    expect(client.state.computer?.panes[id]?.stop).toMatchObject({
      sending: false,
      runIds: ["original", "current"],
    });
    const asked = gateway.calls("chat.abort").map((call) => (call as { runId?: string }).runId);
    expect(asked).toEqual(expect.arrayContaining(["original", "current"]));
    viewer.dispose();
    client.stop();
  });

  it("F-145: a Stop still waiting for write access is withdrawn when its viewer goes away", async () => {
    const wait = deferred<unknown>();
    const { client, gateway, transcript } = await openTask({ held: READ_SCOPES });
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    gateway.handlers["chat.abort"] = () => ({ ok: true, aborted: true });
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((each) => each.state === "running"));
    const viewer = createBridgeSession(client);
    await viewer.apply({ type: "openSession", key: KEY });
    await viewer.apply({ type: "computerShow", key: KEY });
    const stopping = viewer.apply({ type: "computerStopTask" });
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
    client.stop();
  });
});
