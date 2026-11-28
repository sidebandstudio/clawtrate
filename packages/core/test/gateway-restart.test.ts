// #913: a gateway that restarts. OpenClaw 2026.10.6 and 2026.11.10 send `shutdown` with
// `restartExpectedMs` before an in-process restart closes the connection with 1012, and
// `shutdown` with its reason alone before a stop (measured, `docs/decisions.md`).

import { afterEach, describe, expect, it, vi } from "vitest";
import { ClawtrateClient, RESTART_WAIT_MS, type ClientOptions } from "../src/client.ts";
import { KEY, openTask, URL_A } from "./client-harness.ts";
import { FakeGateway, testHost, until } from "./fake-gateway.ts";

const RESTARTING = { reason: "gateway restarting", restartExpectedMs: 1500 };
const STOPPING = { reason: "gateway stopping" };
/** A backoff that doubles from 20 ms, so a few attempts show whether it grew. */
const DOUBLING: ClientOptions = { reconnect: { initialMs: 20, maxMs: 2_000 } };

async function connected(options: ClientOptions = DOUBLING) {
  const gateway = new FakeGateway();
  const client = new ClawtrateClient(testHost(gateway), options);
  await client.start();
  await client.connect({ url: URL_A, token: "bootstrap" });
  await until(() => client.state.discovery.status === "ready");
  return { client, gateway };
}

/** The wait before each reconnect attempt the client schedules from now on. */
function delays(client: ClawtrateClient): number[] {
  const seen: number[] = [];
  let last: number | null = null;
  client.store.subscribe((state) => {
    const at = state.connection.retryAt;
    if (at !== null && at !== last) seen.push(at - Date.now());
    last = at;
  });
  return seen;
}

/** The gateway goes away, announcing it with `notice` or with nothing, and refuses for a while. */
function goAway(gateway: FakeGateway, notice: object | null) {
  if (notice) gateway.emit("shutdown", notice);
  gateway.refuseConnections = true;
  gateway.dropAll();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("F-603: a restart the gateway announces", () => {
  it("F-603: from the notice until the next hello it reads as restarting, and every attempt waits the first delay instead of doubling", async () => {
    const { client, gateway } = await connected();
    const waits = delays(client);
    goAway(gateway, RESTARTING);
    await until(() => client.state.connection.status === "reconnecting");
    expect(client.state.connection.restart).toBe("restarting");
    await until(() => waits.length >= 6);
    // Doubling from 20 ms, the sixth attempt would wait 640 ms.
    expect(Math.max(...waits)).toBeLessThan(30);
    gateway.refuseConnections = false;
    await until(() => client.state.connection.status === "connected");
    expect(client.state.connection.restart).toBeNull();
    client.stop();
  });

  it("F-603: two minutes after the notice without a hello it reads as late, and the attempts back off again", async () => {
    const { client, gateway } = await connected({ reconnect: { initialMs: 1_000, maxMs: 30_000 } });
    expect(RESTART_WAIT_MS).toBe(2 * 60_000);
    vi.useFakeTimers();
    goAway(gateway, RESTARTING);
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS - 1);
    expect(client.state.connection).toMatchObject({
      status: "reconnecting",
      restart: "restarting",
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(client.state.connection.restart).toBe("late");
    const waits = delays(client);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(Math.max(...waits)).toBeGreaterThan(1_500);
    gateway.refuseConnections = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.state.connection).toMatchObject({ status: "connected", restart: null });
    client.stop();
  });

  it("F-603: a send the closed connection may have delivered is not sent again on the new one", async () => {
    const { client, gateway, transcript } = await openTask();
    // The gateway took the message and went away before it answered.
    gateway.handlers["chat.send"] = () => new Promise(() => {});
    client.sendMessage(KEY, "Are you back?");
    await until(() => gateway.calls("chat.send").length === 1);
    goAway(gateway, RESTARTING);
    await until(() => client.state.connection.restart === "restarting");
    gateway.refuseConnections = false;
    await until(() => client.state.connection.status === "connected");
    await until(
      () => transcript().status === "ready" && transcript().outbox[0]?.status !== "sending",
    );
    expect(gateway.calls("chat.send")).toHaveLength(1);
    client.stop();
  });
});

describe("F-603: a stop, or a drop the gateway didn't announce", () => {
  it("F-603: a stop's notice, and no notice at all, read as any lost connection: no restart, and the backoff doubles", async () => {
    for (const notice of [STOPPING, null]) {
      const { client, gateway } = await connected();
      const waits = delays(client);
      goAway(gateway, notice);
      await until(() => waits.length >= 6, 8_000);
      expect(client.state.connection).toMatchObject({ status: "reconnecting", restart: null });
      expect(Math.max(...waits)).toBeGreaterThan(300);
      client.stop();
    }
  });
});
