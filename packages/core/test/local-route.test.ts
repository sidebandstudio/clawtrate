// Local connect's sockets in the client (docs/design/setup-effortless.md §3,
// "The send gate"): the host's last proof of a socket comes after the plan's
// last read, with nothing but the send after it; and a gateway set up through
// local connect keeps its proved route for every later socket, reconnects,
// retries and restarts included. Stand-in proofs on a fake gateway.

import { describe, expect, it } from "vitest";
import { ClawtrateClient, SETUP_ENDPOINT_CHANGED, type ProvedRoute } from "../src/client.ts";
import type { KeyValueStore, WebSocketLike } from "../src/host.ts";
import { READ_SCOPE } from "../src/scopes.ts";
import { FAST } from "./client-harness.ts";
import {
  FakeGateway,
  helloOk,
  memoryStorage,
  sleep,
  testHost,
  tokenKey,
  until,
} from "./fake-gateway.ts";

const URL = "ws://127.0.0.1:19940";
const ROUTE = ".openclaw-clawtrate";
const CODE = "fictional".repeat(4) + "1234567";
const SAVED = JSON.stringify({
  token: "device-token",
  grantedScopes: [READ_SCOPE],
  heldScopes: [READ_SCOPE],
});
const code = () => ({ url: URL, bootstrapToken: CODE, expiresAtMs: Date.now() + 60_000 });

/** A gateway that grants read and a device token to any connect, telling `events` of each. */
function readGateway(events: string[] = []) {
  const gateway = new FakeGateway();
  gateway.connectReply = () => {
    events.push("frame");
    return { ok: true, payload: helloOk([READ_SCOPE], "device-token") };
  };
  return gateway;
}

/** The store, telling `events` of each read of the device token. */
function watched(storage: KeyValueStore, events: string[]): KeyValueStore {
  return {
    ...storage,
    get: async (key) => {
      if (key === tokenKey(URL)) events.push("read");
      return storage.get(key);
    },
  };
}

/** A stand-in for the host's proved sockets: counted, and proved again as `answer` says. */
function route(gateway: FakeGateway, answer: () => boolean, events: string[] = []) {
  const made: WebSocketLike[] = [];
  const sockets: ProvedRoute = {
    createSocket: (url) => {
      const socket = gateway.createWebSocket(url);
      made.push(socket);
      return socket;
    },
    verify: async () => {
      events.push("prove");
      await sleep(5);
      return answer();
    },
  };
  return { sockets, made };
}

describe("the host's last proof of a setup socket", () => {
  for (const mode of ["bootstrap", "saved-token"] as const) {
    it(`comes after the plan's last read, with nothing but the frame after it (${mode})`, async () => {
      const events: string[] = [];
      const gateway = readGateway(events);
      const storage = memoryStorage(mode === "saved-token" ? { [tokenKey(URL)]: SAVED } : {});
      const client = new ClawtrateClient(testHost(gateway, watched(storage, events)), FAST);
      await client.start({ resume: false });
      const setup = route(gateway, () => true, events);
      const check = {
        verify: async () => true,
        createSocket: setup.sockets.createSocket,
        prove: setup.sockets.verify,
        route: ROUTE,
      };
      if (mode === "bootstrap") await client.connectWithSetupCode(code(), check);
      else await client.connectForSetup(URL, check);
      await until(() => events.includes("frame"));
      const frame = events.indexOf("frame");
      expect(events.slice(0, frame).lastIndexOf("read")).toBeGreaterThanOrEqual(0);
      expect(events[frame - 1]).toBe("prove");
      expect(events.slice(0, frame).lastIndexOf("read")).toBeLessThan(frame - 1);
      client.stop();
    });
  }

  it("F-492: refused, it ends setup as a change and sends no frame", async () => {
    const events: string[] = [];
    const gateway = readGateway(events);
    const client = new ClawtrateClient(testHost(gateway, memoryStorage()), FAST);
    await client.start({ resume: false });
    const setup = route(gateway, () => false, events);
    await client.connectWithSetupCode(code(), {
      verify: async () => true,
      createSocket: setup.sockets.createSocket,
      prove: setup.sockets.verify,
      route: ROUTE,
    });
    await until(() => client.state.connection.error?.code === SETUP_ENDPOINT_CHANGED);
    await sleep(100);
    expect(events).toContain("prove");
    expect(gateway.connects).toHaveLength(0);
    client.stop();
  });
});

describe("a gateway set up through local connect", () => {
  /** A host whose own sockets count, and must never be used for this gateway. */
  function host(gateway: FakeGateway, storage: KeyValueStore) {
    const plain: WebSocketLike[] = [];
    const made = testHost(gateway, storage);
    made.createWebSocket = (url) => {
      const socket = gateway.createWebSocket(url);
      plain.push(socket);
      return socket;
    };
    return { host: made, plain };
  }

  it("F-492: proves every socket after setup ends, and a refused one sends nothing", async () => {
    const events: string[] = [];
    const gateway = readGateway(events);
    const storage = memoryStorage();
    const { host: app, plain } = host(gateway, storage);
    let answer = true;
    const later = route(gateway, () => answer, events);
    const asked: string[][] = [];
    const client = new ClawtrateClient(app, {
      ...FAST,
      localConnect: (url, name) => {
        asked.push([url, name]);
        return later.sockets;
      },
    });
    await client.start({ resume: false });
    const setup = route(gateway, () => true);
    await client.connectWithSetupCode(code(), {
      verify: async () => true,
      createSocket: setup.sockets.createSocket,
      prove: setup.sockets.verify,
      route: ROUTE,
    });
    await until(() => client.state.discovery.status === "ready");
    expect(setup.made).toHaveLength(1);
    expect(asked).toEqual([[URL, ROUTE]]);
    // Saved with its route, for the next start.
    await until(
      () => JSON.parse((storage.data.get("connection") ?? "{}") as string).route === ROUTE,
    );
    // Setup is over: a reconnect goes through the route, proved again before its frame.
    events.length = 0;
    gateway.dropAll();
    await until(() => client.state.connection.status === "connected" && events.includes("frame"));
    expect(later.made).toHaveLength(1);
    expect(events.slice(-2)).toEqual(["prove", "frame"]);
    // A reconnect whose socket isn't proved again sends no frame, and is retried the same way.
    answer = false;
    const frames = gateway.connects.length;
    gateway.dropAll();
    await until(() => later.made.length >= 3);
    expect(gateway.connects).toHaveLength(frames);
    expect(plain).toHaveLength(0);
    client.stop();
  });

  it("F-492: after a restart, opens only the route's sockets, and none when the host has no route", async () => {
    const saved = {
      connection: JSON.stringify({ url: URL, token: null, route: ROUTE }),
      [tokenKey(URL)]: SAVED,
    };
    const events: string[] = [];
    const gateway = readGateway(events);
    const { host: app, plain } = host(gateway, memoryStorage(saved));
    const later = route(gateway, () => true, events);
    const client = new ClawtrateClient(app, { ...FAST, localConnect: () => later.sockets });
    await client.start();
    await until(() => client.state.connection.status === "connected");
    expect(later.made).toHaveLength(1);
    expect(events.slice(-2)).toEqual(["prove", "frame"]);
    expect(plain).toHaveLength(0);
    client.stop();

    // A host that can't prove the route, or has none, opens nothing for it.
    for (const localConnect of [() => null, undefined]) {
      const quiet = readGateway();
      const other = host(quiet, memoryStorage(saved));
      const stopped = new ClawtrateClient(other.host, {
        ...FAST,
        ...(localConnect ? { localConnect } : {}),
      });
      await stopped.start();
      await until(() => stopped.state.connection.error?.code === "LOCAL_UNVERIFIED");
      await sleep(100);
      expect(quiet.sockets).toHaveLength(0);
      stopped.stop();
    }
  });

  it("is an ordinary gateway again once the person connects to it by its address", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null, route: ROUTE }),
    });
    const gateway = readGateway();
    const { host: app, plain } = host(gateway, storage);
    const client = new ClawtrateClient(app, { ...FAST, localConnect: () => null });
    await client.start({ resume: false });
    await client.connect({ url: URL, token: "typed" });
    await until(() => client.state.connection.status === "connected");
    expect(plain).toHaveLength(1);
    expect(JSON.parse(storage.data.get("connection")!)).not.toHaveProperty("route");
    client.stop();
  });
});
