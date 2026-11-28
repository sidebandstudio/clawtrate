// #913: a gateway restart is said while it plausibly lasts, beside the connection's status. The
// frames are OpenClaw's own: `shutdown` `{reason, restartExpectedMs: 1500}` before a restart and
// `{reason}` alone before a stop (2026.10.6 and 2026.11.10 alike), then a 1012 close either way;
// a config write's answer carries `sentinel.payload.stats.requiresRestart`.
import { describe, expect, it } from "vitest";
import type { ClawtrateClient } from "../src/client.ts";
import { RESTART_ASK_MS, RESTART_WAIT_MS } from "../src/restart.ts";
import { createRemoteBridge } from "../src/remote-bridge.ts";
import type { WebSocketLike } from "../src/host.ts";
import { initialState, type ClawtrateState } from "../src/types.ts";
import { deferred, sleep, until } from "./fake-gateway.ts";
import { grantingGateway, KEY, openTask, sentTexts, URL_A, URL_B } from "./client-harness.ts";

const RESTARTING = { reason: "gateway restarting", restartExpectedMs: 1500 };
const STOPPING = { reason: "gateway stopping" };

/** A config write's answer, as both versions give it, saying whether it restarts the gateway. */
const patchAnswer = (requiresRestart: unknown) => ({
  ok: true,
  path: "/home/sam/.openclaw/openclaw.json",
  hash: "hash-2",
  changedPaths: ["gateway.controlUi.basePath"],
  sentinel: {
    persisted: true,
    payload: {
      kind: "config-patch",
      status: "ok",
      stats: { mode: "config.patch", requiresRestart },
    },
  },
});

/** A write of this app's, through the client's one request path (as every engine's goes). */
const write = (client: ClawtrateClient, method: string, params: unknown = {}) =>
  (client as unknown as { request: (m: string, p: unknown) => Promise<unknown> }).request(
    method,
    params,
  );

const restartOf = (client: ClawtrateClient) => client.state.connection.restart ?? null;

describe("a restart this app asked for (#913)", () => {
  it("is said from the drop that follows a write the gateway restarts to apply, until the next hello", async () => {
    const gateway = grantingGateway();
    gateway.handlers["config.patch"] = () => patchAnswer(true);
    const { client } = await openTask({ gateway });
    await write(client, "config.patch", { raw: "{}", baseHash: "hash-1" });
    // Answered, still connected: nothing is said yet (2026.10.6 may wait minutes for running work).
    expect(restartOf(client)).toBeNull();
    gateway.refuseConnections = true;
    gateway.dropAll();
    await until(() => client.state.connection.status === "reconnecting");
    expect(restartOf(client)).toMatchObject({ cause: "asked" });
    const { since, until: end } = restartOf(client)!;
    expect(end - since).toBe(RESTART_WAIT_MS);
    // The status keeps its meaning: the restart is a fact beside it.
    expect(client.state.connection.status).toBe("reconnecting");
    gateway.refuseConnections = false;
    await until(() => client.state.connection.status === "connected");
    expect(restartOf(client)).toBeNull();
    client.stop();
  });

  it("a write that applies without a restart, or one answered on another method, asks for none", async () => {
    const gateway = grantingGateway();
    gateway.handlers["config.patch"] = () => patchAnswer(false);
    // The same field on another method's answer, and a near miss on the right one.
    gateway.handlers["agents.update"] = () => patchAnswer(true);
    gateway.handlers["config.apply"] = () => patchAnswer("true");
    const { client } = await openTask({
      gateway,
      client: { reconnect: { initialMs: 50, maxMs: 50 } },
    });
    await write(client, "config.patch");
    await write(client, "agents.update");
    await write(client, "config.apply");
    gateway.dropAll();
    await until(() => client.state.connection.status === "reconnecting");
    expect(restartOf(client)).toBeNull();
    client.stop();
  });

  it("an ask older than the gateway's longest wait for running work is not the drop's cause", async () => {
    let clock = 1_000_000;
    const gateway = grantingGateway();
    gateway.handlers["config.patch"] = () => patchAnswer(true);
    const { client } = await openTask({ gateway });
    (client as unknown as { host: { now: () => number } }).host.now = () => clock;
    await write(client, "config.patch");
    clock += RESTART_ASK_MS + 1;
    gateway.refuseConnections = true;
    gateway.dropAll();
    await until(() => client.state.connection.status === "reconnecting");
    expect(restartOf(client)).toBeNull();
    client.stop();
  });
});

describe("a restart the gateway announced (#913)", () => {
  it("is said from the announcement, while the socket is still open, through the drop, until the next hello", async () => {
    const gateway = grantingGateway();
    const { client } = await openTask({ gateway });
    gateway.emit("shutdown", RESTARTING);
    await until(() => restartOf(client) !== null);
    expect(restartOf(client)).toMatchObject({ cause: "announced" });
    expect(client.state.connection.status).toBe("connected");
    const first = restartOf(client)!;
    gateway.refuseConnections = true;
    gateway.dropAll();
    await until(() => client.state.connection.status === "reconnecting");
    // The drop doesn't start another wait.
    expect(restartOf(client)).toEqual(first);
    gateway.refuseConnections = false;
    await until(() => client.state.connection.status === "connected");
    expect(restartOf(client)).toBeNull();
    client.stop();
  });

  it("an announcement after a write that restarts is the asked restart", async () => {
    const gateway = grantingGateway();
    gateway.handlers["config.patch"] = () => patchAnswer(true);
    const { client } = await openTask({ gateway });
    await write(client, "config.patch");
    gateway.emit("shutdown", RESTARTING);
    await until(() => restartOf(client) !== null);
    expect(restartOf(client)).toMatchObject({ cause: "asked" });
    client.stop();
  });

  it("a stop, a malformed announcement, another event or the close code alone is not a restart", async () => {
    const gateway = grantingGateway();
    const { client } = await openTask({
      gateway,
      client: { reconnect: { initialMs: 50, maxMs: 50 } },
    });
    gateway.emit("shutdown", STOPPING);
    gateway.emit("shutdown", { reason: "gateway restarting", restartExpectedMs: "1500" });
    gateway.emit("shutdown", { reason: "gateway restarting", restartExpectedMs: null });
    gateway.emit("shutdown", null);
    gateway.emit("plugin.shutdown", RESTARTING);
    gateway.emit("gateway.suspension", { phase: "draining" });
    await sleep(30);
    expect(restartOf(client)).toBeNull();
    // Every close of OpenClaw's is 1012 "service restart", a stop's too: it says nothing alone.
    gateway.dropAll();
    await until(() => client.state.connection.status === "reconnecting");
    expect(restartOf(client)).toBeNull();
    client.stop();
  });
});

describe("an unannounced drop (#913)", () => {
  it("is shown as it always was: reconnecting, with no restart", async () => {
    const gateway = grantingGateway();
    const { client } = await openTask({ gateway });
    const seen: Array<ClawtrateState["connection"]["restart"]> = [];
    const stop = client.store.subscribe((state) => seen.push(state.connection.restart));
    gateway.refuseConnections = true;
    gateway.dropAll();
    await until(() => client.state.connection.status === "reconnecting");
    gateway.refuseConnections = false;
    await until(() => client.state.connection.status === "connected");
    stop();
    expect(seen.every((restart) => restart == null)).toBe(true);
    // A connection that never restarted carries no trace of the field at all.
    expect("restart" in client.state.connection).toBe(false);
    client.stop();
  });
});

describe("the wait for a restart (#913)", () => {
  it("runs out: then the connection reads as lost, as any other", async () => {
    const gateway = grantingGateway();
    const { client } = await openTask({ gateway, client: { restartWaitMs: 150 } });
    gateway.emit("shutdown", RESTARTING);
    await until(() => restartOf(client) !== null);
    gateway.refuseConnections = true;
    gateway.dropAll();
    await until(() => client.state.connection.status === "reconnecting");
    expect(restartOf(client)).not.toBeNull();
    await until(() => restartOf(client) === null);
    expect(client.state.connection.status).toBe("reconnecting");
    client.stop();
  });

  it("covers a gateway silent for over a minute while it closes its skill watchers, its closed port and one reconnect gap", () => {
    // Measured on OpenClaw 2026.10.6 on macOS (#914): the watcher step up to 104 s with the event
    // loop blocked, the port closed up to 16 s, and the client's longest reconnect gap 30 s.
    expect(RESTART_WAIT_MS).toBeGreaterThanOrEqual(104_000 + 16_000 + 30_000);
  });

  it("holds through a gateway that answers nothing after its announcement, then closes late, until it is back", async () => {
    const gateway = grantingGateway();
    // The stand-in for a blocked event loop: the gateway's answers are held back.
    const held = deferred<unknown>();
    gateway.handlers["status"] = () => held.promise;
    const { client } = await openTask({ gateway, client: { restartWaitMs: 3_000 } });
    gateway.emit("shutdown", RESTARTING);
    await until(() => restartOf(client) !== null);
    const first = restartOf(client)!;
    const asked = write(client, "status").catch(() => null);
    // Silent, still connected, for a good part of the wait: still restarting.
    await sleep(800);
    expect(client.state.connection.status).toBe("connected");
    expect(restartOf(client)).toEqual(first);
    // The late close, a port shut for a while, then back.
    gateway.refuseConnections = true;
    gateway.dropAll();
    await until(() => client.state.connection.status === "reconnecting");
    await sleep(300);
    expect(restartOf(client)).toEqual(first);
    gateway.refuseConnections = false;
    await until(() => client.state.connection.status === "connected");
    expect(restartOf(client)).toBeNull();
    await asked;
    client.stop();
  });

  it("a second announcement on the same connection doesn't extend it; a restart after the gateway is back starts its own", async () => {
    let clock = 5_000_000;
    const gateway = grantingGateway();
    const { client } = await openTask({ gateway });
    (client as unknown as { host: { now: () => number } }).host.now = () => clock;
    gateway.emit("shutdown", RESTARTING);
    await until(() => restartOf(client) !== null);
    const first = restartOf(client)!;
    clock += 10_000;
    gateway.emit("shutdown", RESTARTING);
    await sleep(20);
    expect(restartOf(client)).toEqual(first);
    // Back from the first, then the second.
    gateway.dropAll();
    await until(() => client.state.connection.status === "connected" && restartOf(client) === null);
    clock += 10_000;
    gateway.emit("shutdown", RESTARTING);
    await until(() => restartOf(client) !== null);
    expect(restartOf(client)!.since).toBe(first.since + 20_000);
    expect(restartOf(client)!.until).toBe(first.since + 20_000 + RESTART_WAIT_MS);
    client.stop();
  });

  it("Retry while it restarts keeps it; Disconnect ends it", async () => {
    const gateway = grantingGateway();
    const { client } = await openTask({ gateway });
    gateway.emit("shutdown", RESTARTING);
    await until(() => restartOf(client) !== null);
    gateway.refuseConnections = true;
    gateway.dropAll();
    await until(() => client.state.connection.status === "reconnecting");
    await client.retryNow();
    expect(restartOf(client)).not.toBeNull();
    await client.disconnect();
    expect(client.state.connection.status).not.toBe("reconnecting");
    expect(restartOf(client)).toBeNull();
    client.stop();
  });

  it("the preview's bridge, losing its host, doesn't say a restart of the gateway it last reported", async () => {
    const sockets: WebSocketLike[] = [];
    const ready = createRemoteBridge({
      open: () => {
        const socket: WebSocketLike = {
          readyState: 1,
          send: () => {},
          close: () => {},
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
        };
        sockets.push(socket);
        return socket;
      },
      attach: () => Promise.reject(new Error("no files here")),
    });
    const restarting: ClawtrateState = {
      ...initialState,
      connection: {
        ...initialState.connection,
        status: "reconnecting",
        restart: { cause: "announced", since: 1, until: 2 },
      },
    };
    const socket = sockets[0]!;
    socket.onmessage?.({ data: JSON.stringify({ type: "hello", info: {}, state: restarting }) });
    const bridge = await ready;
    expect(bridge.getState().connection.restart).not.toBeNull();
    socket.onclose?.({ code: 1006, reason: "" });
    expect(bridge.getState().connection.error?.code).toBe("HOST_UNREACHABLE");
    expect(bridge.getState().connection.restart).toBeNull();
  });
});

describe("a restart during a send (#913)", () => {
  it("nothing the old connection may have delivered is sent again on the new one", async () => {
    const gateway = grantingGateway();
    const answer = deferred<unknown>();
    gateway.handlers["chat.send"] = () => answer.promise;
    const { client, transcript } = await openTask({ gateway });
    void client.sendMessage(KEY, "Check the disk");
    await until(() => sentTexts(gateway).length === 1);
    gateway.emit("shutdown", RESTARTING);
    await until(() => restartOf(client) !== null);
    gateway.dropAll();
    await until(() => client.state.connection.status === "connected" && restartOf(client) === null);
    await until(() => transcript().outbox.every((message) => message.status !== "sending"));
    await sleep(50);
    expect(sentTexts(gateway)).toEqual(["Check the disk"]);
    // Whether the gateway took it is unknown: it is checked against history, never resent.
    expect(transcript().outbox.map((message) => message.status)).not.toContain("sent");
    client.stop();
  });
});

describe("another gateway at the same address (#913)", () => {
  it("is never said to be restarting: a restart, or an ask, is the gateway's that it was made on", async () => {
    const gateway = grantingGateway();
    let identity = "gateway-a";
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: identity });
    gateway.handlers["config.patch"] = () => patchAnswer(true);
    const { client } = await openTask({
      gateway,
      client: { reconnect: { initialMs: 50, maxMs: 50 } },
    });
    await until(() => client.state.connection.gatewayId === "gateway-a");
    // Asked of A, which a blip replaces before it restarts: B answers at the same address.
    await write(client, "config.patch");
    identity = "gateway-b";
    gateway.dropAll();
    // The drop after an ask is that restart, until the next hello.
    await until(() => restartOf(client) !== null);
    await until(() => client.state.connection.status === "connected");
    expect(restartOf(client)).toBeNull();
    await until(() => client.state.connection.gatewayId === "gateway-b");
    // B drops without a word: nothing of A's carries over to it.
    const seen: Array<ClawtrateState["connection"]["restart"]> = [];
    const stop = client.store.subscribe((state) => seen.push(state.connection.restart));
    gateway.refuseConnections = true;
    gateway.dropAll();
    await until(() => client.state.connection.status === "reconnecting");
    await sleep(120);
    stop();
    expect(seen.every((restart) => restart == null)).toBe(true);
    client.stop();
  });
});

describe("what ends a restart, or an ask, besides the next hello (#913)", () => {
  it("a reconnect that waits for the gateway's owner is said as such, not as a restart", async () => {
    const gateway = grantingGateway();
    const { client } = await openTask({ gateway });
    gateway.emit("shutdown", RESTARTING);
    await until(() => restartOf(client) !== null);
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "NOT_PAIRED",
        message: "device pairing required",
        details: {
          code: "PAIRING_REQUIRED",
          reason: "not-paired",
          requestId: "req-1",
          deviceId: "device-1",
          requestedRole: "operator",
          requestedScopes: ["operator.read"],
        },
      },
    });
    gateway.dropAll();
    await until(() => client.state.connection.status === "pairing");
    expect(restartOf(client)).toBeNull();
    client.stop();
  });

  it("an ask doesn't outlive a Disconnect: a Connect that never reaches the gateway isn't a restart", async () => {
    const gateway = grantingGateway();
    gateway.handlers["config.patch"] = () => patchAnswer(true);
    const { client } = await openTask({ gateway });
    await write(client, "config.patch");
    await client.disconnect();
    gateway.refuseConnections = true;
    const sockets = gateway.sockets.length;
    await client.connect({ url: URL_A });
    await until(() => gateway.sockets.length > sockets + 1);
    expect(client.state.connection.status).not.toBe("connected");
    expect(restartOf(client)).toBeNull();
    client.stop();
  });

  it("pointed at another gateway while one restarts, the other isn't said to be restarting", async () => {
    const gateway = grantingGateway();
    const { client } = await openTask({ gateway });
    gateway.emit("shutdown", RESTARTING);
    await until(() => restartOf(client) !== null);
    gateway.refuseConnections = true;
    gateway.dropAll();
    await until(() => client.state.connection.status === "reconnecting");
    await client.connect({ url: URL_B });
    expect(client.state.connection.gatewayUrl).toBe(URL_B);
    expect(restartOf(client)).toBeNull();
    client.stop();
  });

  it("a reopen that finds another address selected, without a new target, ends it", async () => {
    const gateway = grantingGateway();
    const { client } = await openTask({ gateway });
    gateway.emit("shutdown", RESTARTING);
    await until(() => restartOf(client) !== null);
    gateway.refuseConnections = true;
    gateway.dropAll();
    await until(() => client.state.connection.status === "reconnecting");
    // The selected gateway's record changed under this client (another window on the store).
    const inner = client as unknown as { settings: { url: string; token: string | null } };
    inner.settings = { ...inner.settings, url: URL_B };
    await client.retryNow();
    expect(client.state.connection.gatewayUrl).toBe(URL_B);
    expect(restartOf(client)).toBeNull();
    client.stop();
  });
});
