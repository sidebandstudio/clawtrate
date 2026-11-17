// A Stop the person presses stays with the run it was meant for, whatever the
// gateway's answers leave unknown: a send whose answer never comes, a dropped
// connection, an acceptance that names no run, other runs active meanwhile.

import { describe, expect, it } from "vitest";
import { grantingGateway, KEY, openTask } from "./client-harness.ts";
import { deferred, sleep, until } from "./fake-gateway.ts";

describe("a Stop pressed before the gateway named the run, when the send's answer is missing", () => {
  it("F-097: the send times out: history names the run in flight, and that run is stopped", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.send"] = () => new Promise(() => {});
    gateway.handlers["chat.history"] = () => ({ messages: [] });
    const { client, transcript } = await openTask({ gateway, client: { requestTimeoutMs: 100 } });
    const id = client.sendMessage(KEY, "Take your time");
    await until(() => gateway.calls("chat.send").length === 1);
    await client.stopRun(KEY, id);
    // The gateway took it after all: its history has the run in flight under the send's id.
    gateway.handlers["chat.history"] = () => ({ messages: [], inFlightRun: { runId: id } });
    await until(() => gateway.calls("chat.abort").length === 1);
    expect(gateway.calls("chat.abort")).toEqual([{ sessionKey: KEY, runId: id }]);
    expect(transcript().runs.find((run) => run.id === id)).toMatchObject({
      state: "stopping",
      bound: true,
    });
    gateway.emit("chat", {
      runId: id,
      sessionKey: KEY,
      seq: 2,
      state: "aborted",
      stopReason: "rpc",
    });
    await until(() => transcript().runs.find((run) => run.id === id)?.state === "stopped");
    client.stop();
  });

  it("F-097: the connection drops: after the reconnect, the run in flight is stopped, not shown running", async () => {
    const gateway = grantingGateway();
    const answer = deferred<unknown>();
    gateway.handlers["chat.send"] = () => answer.promise;
    const { client, transcript } = await openTask({ gateway });
    const id = client.sendMessage(KEY, "Take your time");
    await until(() => gateway.calls("chat.send").length === 1);
    await client.stopRun(KEY, id);
    gateway.handlers["chat.history"] = () => ({ messages: [], inFlightRun: { runId: id } });
    gateway.dropAll();
    await until(() => transcript().caughtUp?.reason === "reconnect");
    await until(() => gateway.calls("chat.abort").length === 1);
    expect(gateway.calls("chat.abort")).toEqual([{ sessionKey: KEY, runId: id }]);
    expect(transcript().runs.find((run) => run.id === id)?.state).toBe("stopping");
    client.stop();
  });

  it("F-468: an acceptance that names no run: nothing queued behind it leaves while it may be in flight", async () => {
    const gateway = grantingGateway();
    const answer = deferred<unknown>();
    let sends = 0;
    gateway.handlers["chat.send"] = () => ((sends += 1) === 1 ? answer.promise : { runId: "next" });
    gateway.handlers["chat.history"] = () => ({ messages: [] });
    const { client, transcript } = await openTask({ gateway });
    const id = client.sendMessage(KEY, "Take your time");
    await until(() => gateway.calls("chat.send").length === 1);
    await client.stopRun(KEY, id);
    const later = client.sendMessage(KEY, "Then this");
    gateway.handlers["chat.history"] = () => ({ messages: [], inFlightRun: { runId: id } });
    answer.resolve({ status: "accepted" });
    await until(() => gateway.calls("chat.abort").length === 1);
    expect(gateway.calls("chat.send")).toHaveLength(1);
    gateway.handlers["chat.history"] = () => ({ messages: [] });
    gateway.emit("chat", {
      runId: id,
      sessionKey: KEY,
      seq: 2,
      state: "aborted",
      stopReason: "rpc",
    });
    // Stopped: what was queued behind it stays, not sent, until the person sends it.
    await until(() => transcript().outbox.find((m) => m.id === later)?.status === "not-sent");
    await sleep(30);
    expect(gateway.calls("chat.send")).toHaveLength(1);
    client.stop();
  });

  it("F-097: nothing shows the send: it settles stopped, outcome unknown, and is still stopped if it turns up in flight", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.send"] = () => new Promise(() => {});
    gateway.handlers["chat.history"] = () => ({ messages: [] });
    const { client, transcript } = await openTask({ gateway, client: { requestTimeoutMs: 100 } });
    const id = client.sendMessage(KEY, "Take your time");
    await until(() => gateway.calls("chat.send").length === 1);
    await client.stopRun(KEY, id);
    await until(() => transcript().runs.find((run) => run.id === id)?.state === "stopped");
    expect(transcript().runs.find((run) => run.id === id)).toMatchObject({ outcomeKnown: false });
    expect(gateway.calls("chat.abort")).toEqual([]);
    gateway.handlers["chat.history"] = () => ({ messages: [], inFlightRun: { runId: id } });
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => gateway.calls("chat.abort").length === 1);
    expect(gateway.calls("chat.abort")).toEqual([{ sessionKey: KEY, runId: id }]);
    client.stop();
  });
});
