// A Stop the person presses stays with the run it was meant for, whatever the
// gateway's answers leave unknown: a send whose answer never comes, a dropped
// connection, an acceptance that names no run, other runs active meanwhile.

import { describe, expect, it } from "vitest";
import { agentEvent, grantingGateway, KEY, openTask } from "./client-harness.ts";
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

describe("a confirmed Stop's own follow-ups, while another run is active", () => {
  it("F-468: stay not sent when another device's run is active as the Stop is confirmed, and after it ends", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.emit("agent", agentEvent("stopped-run", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs[0]?.state === "running");
    const later = client.sendMessage(KEY, "Queued behind it", { mode: "queue" });
    await client.stopRun(KEY, "stopped-run");
    // Another device starts a run in the same task before the stop is confirmed.
    gateway.emit("agent", agentEvent("other-run", 1, "lifecycle", { phase: "start" }));
    gateway.emit("chat", { runId: "stopped-run", sessionKey: KEY, seq: 2, state: "aborted" });
    await until(
      () => transcript().runs.find((run) => run.id === "stopped-run")?.state === "stopped",
    );
    expect(transcript().outbox.find((m) => m.id === later)?.status).toBe("not-sent");
    gateway.emit("chat", { runId: "other-run", sessionKey: KEY, seq: 2, state: "final" });
    await until(
      () => transcript().runs.find((run) => run.id === "other-run")?.state === "completed",
    );
    await sleep(30);
    expect(transcript().outbox.find((m) => m.id === later)?.status).toBe("not-sent");
    expect(gateway.calls("chat.send")).toEqual([]);
    // Sent again by the person, it goes; the earlier Stop does not park it again.
    client.retryMessage(KEY, later);
    await until(() => gateway.calls("chat.send").length === 1);
    client.stop();
  });
});

describe("a Stop through any number of disconnects, and an end only inferred", () => {
  it("F-097: an abort whose answer each dropped connection loses is sent again after each reconnect, and the run stays stopping", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.send"] = () => new Promise(() => {});
    gateway.handlers["chat.abort"] = () => new Promise(() => {});
    const { client, transcript } = await openTask({ gateway });
    const id = client.sendMessage(KEY, "Take your time");
    await until(() => gateway.calls("chat.send").length === 1);
    await client.stopRun(KEY, id);
    gateway.handlers["chat.history"] = () => ({ messages: [], inFlightRun: { runId: id } });
    gateway.dropAll();
    // History names the run: it is aborted, and that abort's answer goes with the next drop.
    await until(() => gateway.calls("chat.abort").length === 1);
    gateway.dropAll();
    await until(() => gateway.calls("chat.abort").length === 2);
    gateway.dropAll();
    await until(() => gateway.calls("chat.abort").length === 3);
    expect(
      gateway.calls("chat.abort").every((call) => (call as { runId?: string }).runId === id),
    ).toBe(true);
    expect(transcript().runs.find((run) => run.id === id)).toMatchObject({
      state: "stopping",
      stopError: null,
    });
    gateway.emit("chat", { runId: id, sessionKey: KEY, seq: 2, state: "aborted" });
    await until(() => transcript().runs.find((run) => run.id === id)?.state === "stopped");
    client.stop();
  });

  it("F-097: a refused abort gives the Stop up and says why", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.abort"] = () => {
      throw Object.assign(new Error("unauthorized"), { code: "UNAUTHORIZED" });
    };
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", agentEvent("r1", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.id === "r1"));
    await client.stopRun(KEY, "r1");
    await until(() => transcript().runs[0]?.state === "running");
    expect(transcript().runs[0]?.stopError).not.toBeNull();
    expect(gateway.calls("chat.abort")).toHaveLength(1);
    client.stop();
  });

  it("F-097: a run settled as stopped with no known outcome takes the end the gateway sends later", async () => {
    const gateway = grantingGateway();
    const answer = deferred<unknown>();
    gateway.handlers["chat.send"] = () => answer.promise;
    const { client, transcript } = await openTask({ gateway });
    const id = client.sendMessage(KEY, "Take your time");
    await until(() => gateway.calls("chat.send").length === 1);
    await client.stopRun(KEY, id);
    // Accepted with no run named, and history shows nothing of it: stopped, outcome unknown.
    answer.resolve({ status: "accepted" });
    await until(() => transcript().runs.find((run) => run.id === id)?.outcomeKnown === false);
    expect(transcript().runs.find((run) => run.id === id)?.state).toBe("stopped");
    // It had run to its end: the gateway's final says so, and that is how it ended.
    gateway.emit("chat", { runId: id, sessionKey: KEY, seq: 2, state: "final" });
    await until(() => transcript().runs.find((run) => run.id === id)?.outcomeKnown === true);
    expect(transcript().runs.find((run) => run.id === id)).toMatchObject({
      state: "completed",
      finishedBeforeStop: true,
    });
    client.stop();
  });

  it("a frame that is no end leaves an end only inferred as it is", async () => {
    const gateway = grantingGateway();
    let history: Record<string, unknown> = { messages: [], inFlightRun: { runId: "r1" } };
    gateway.handlers["chat.history"] = () => history;
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().runs.some((run) => run.id === "r1" && run.state === "running"));
    history = { messages: [] };
    gateway.dropAll();
    await until(() => transcript().runs.find((run) => run.id === "r1")?.outcomeKnown === false);
    // A late start and a late status say nothing of how it ended.
    gateway.emit("agent", agentEvent("r1", 1, "lifecycle", { phase: "start" }));
    gateway.emit("chat", { runId: "r1", sessionKey: KEY, seq: 2, state: "status", phase: "model" });
    await sleep(50);
    expect(transcript().runs.find((run) => run.id === "r1")).toMatchObject({
      state: "completed",
      outcomeKnown: false,
    });
    client.stop();
  });

  it("an ordinary run settled as completed with no known outcome takes the failure history records", async () => {
    const gateway = grantingGateway();
    let history: Record<string, unknown> = { messages: [], inFlightRun: { runId: "r1" } };
    gateway.handlers["chat.history"] = () => history;
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().runs.some((run) => run.id === "r1" && run.state === "running"));
    // The run vanished across a reconnect with no row: completed, outcome unknown.
    history = { messages: [] };
    gateway.dropAll();
    await until(() => transcript().runs.find((run) => run.id === "r1")?.outcomeKnown === false);
    history = {
      messages: [
        {
          role: "assistant",
          content: "It did not work.",
          stopReason: "error",
          errorMessage: "The provider failed",
          __openclaw: { id: "a1", runId: "r1" },
        },
      ],
    };
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => transcript().runs.find((run) => run.id === "r1")?.outcomeKnown === true);
    expect(transcript().runs.find((run) => run.id === "r1")?.state).toBe("failed");
    client.stop();
  });
});
