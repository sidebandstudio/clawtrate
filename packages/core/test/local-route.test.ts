// Local connect's sockets in the client (docs/design/setup-effortless.md §3,
// "The send gate"): the host's last proof of a socket comes after the plan's
// last read, with nothing but the send after it; and a gateway set up through
// local connect keeps its proved route for every later socket, reconnects,
// retries and restarts included. Stand-in proofs on a fake gateway.

import { describe, expect, it } from "vitest";
import {
  ClawtrateClient,
  LOCAL_ROUTE_ONLY,
  ROUTE_IDENTITY_CHANGED,
  SETUP_ENDPOINT_CHANGED,
  type ProvedRoute,
} from "../src/client.ts";
import type { WebSocketLike } from "../src/host.ts";
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

type Store = ReturnType<typeof memoryStorage>;

/** The store, telling `events` of each read of the device token. */
function watched(storage: Store, events: string[]): Store {
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
  function host(gateway: FakeGateway, storage: Store) {
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
    // Its device token is saved with the route too, and goes on no other socket.
    expect(JSON.parse(storage.data.get(tokenKey(URL))!).route).toBe(ROUTE);
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

  for (const how of [
    "a typed connect",
    "Disconnect, then a typed connect",
    "a record that lost its route",
    "a setup on the route's sockets with no last proof",
  ] as const)
    it(`F-492: never sends a token saved over the route after ${how}`, async () => {
      const gateway = readGateway();
      const storage = memoryStorage({
        connection: JSON.stringify({
          url: URL,
          token: null,
          ...(how === "a record that lost its route" ? {} : { route: ROUTE }),
        }),
        [tokenKey(URL)]: JSON.stringify({ ...JSON.parse(SAVED), route: ROUTE }),
      });
      const { host: app, plain } = host(gateway, storage);
      const later = route(gateway, () => true);
      const client = new ClawtrateClient(app, { ...FAST, localConnect: () => later.sockets });
      if (how === "a record that lost its route") await client.start();
      else if (how === "a setup on the route's sockets with no last proof") {
        await client.start({ resume: false });
        await client.connectForSetup(URL, {
          createSocket: later.sockets.createSocket,
          route: ROUTE,
        });
      } else {
        await client.start({ resume: how === "a typed connect" ? false : true });
        if (how !== "a typed connect") {
          await until(() => client.state.connection.status === "connected");
          await client.disconnect();
        }
        await client.connect({ url: URL, token: "typed" });
      }
      // Said as it is: the pairing belongs to This computer, and that is the way to it.
      await until(() => client.state.connection.error?.code === LOCAL_ROUTE_ONLY);
      expect(client.state.connection.error).toMatchObject({
        message: expect.stringMatching(
          /^This device is paired for This computer, .*No credential was sent\.$/,
        ) as unknown,
        hint: "Choose This computer to connect to it.",
      });
      await sleep(100);
      // The route's own connection, before Disconnect, is the only frame there is.
      expect(gateway.connects).toHaveLength(how === "Disconnect, then a typed connect" ? 1 : 0);
      expect(later.made.length + plain.length).toBeGreaterThan(0);
      client.stop();
    });

  it("F-492: never sends a token that gained a route before the plan's last read", async () => {
    const gateway = readGateway();
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null }),
      [tokenKey(URL)]: SAVED,
    });
    let reads = 0;
    const get = storage.get;
    // The plan reads the token, the lifecycle reads it, then the plan reads it once more last:
    // by then another connection on this store saved it over the route.
    storage.get = async (key) => {
      if (key === tokenKey(URL) && gateway.sockets.length > 0 && ++reads >= 3)
        return JSON.stringify({ ...JSON.parse(SAVED), route: ROUTE });
      return get(key);
    };
    const { host: app } = host(gateway, storage);
    const client = new ClawtrateClient(app, FAST);
    await client.start();
    await until(() => client.state.connection.error?.code === LOCAL_ROUTE_ONLY);
    await sleep(100);
    expect(gateway.connects).toHaveLength(0);
    client.stop();
  });

  it("F-492: a token saved over another route goes on none of this route's sockets, and its first pairing replaces it", async () => {
    // Saved through This computer when the profile folder was another one; found again since,
    // with the folder put in its place, and connected on its own route.
    const earlier = `${ROUTE}@1:1`;
    const now = `${ROUTE}@1:2`;
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null, route: earlier }),
      [tokenKey(URL)]: JSON.stringify({
        ...JSON.parse(SAVED),
        token: "earlier-device-token",
        route: earlier,
      }),
    });
    const gateway = readGateway();
    const { host: app, plain } = host(gateway, storage);
    const sockets = route(gateway, () => true);
    const client = new ClawtrateClient(app, { ...FAST, localConnect: () => sockets.sockets });
    await client.start({ resume: false });
    await client.connect(
      { url: URL, token: "settings-token" },
      {
        createSocket: sockets.sockets.createSocket,
        prove: sockets.sockets.verify,
        route: now,
        consent: () => true,
      },
    );
    await until(() => client.state.connection.status === "connected");
    expect(JSON.stringify(gateway.connects)).not.toContain("earlier-device-token");
    expect(JSON.stringify(gateway.connects[0])).toContain("settings-token");
    // The pairing on this route replaces the other route's, and the gateway is saved with it.
    await until(() => JSON.parse(storage.data.get(tokenKey(URL))!).route === now);
    expect(JSON.parse(storage.data.get(tokenKey(URL))!).token).toBe("device-token");
    await until(() => JSON.parse(storage.data.get("connection")!).route === now);
    expect(plain).toHaveLength(0);
    client.stop();
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

describe("a gateway saved with a route is the gateway that route first reported", () => {
  /** A device paired over the route, saved as local connect saves it, at a gateway named `id`. */
  async function routed(identity: { id: string }) {
    const gateway = readGateway();
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: identity.id });
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null, route: ROUTE }),
      [tokenKey(URL)]: JSON.stringify({ ...JSON.parse(SAVED), route: ROUTE }),
    });
    const client = new ClawtrateClient(testHost(gateway, storage), {
      ...FAST,
      localConnect: () => route(gateway, () => true).sockets,
    });
    await client.start();
    await until(() => client.state.connection.status === "connected");
    return { gateway, storage, client };
  }

  it("saves the identity at the first hello, and keeps the pairing while it answers the same", async () => {
    const identity = { id: "gateway-a" };
    const { gateway, storage, client } = await routed(identity);
    try {
      await until(() => storage.data.get("connection")!.includes("gateway-a"));
      expect(JSON.parse(storage.data.get("connection")!)).toMatchObject({
        route: ROUTE,
        gatewayId: "gateway-a",
      });
      gateway.dropAll();
      await until(
        () => gateway.connects.length === 2 && client.state.connection.status === "connected",
      );
      await sleep(100);
      expect(storage.data.has(tokenKey(URL))).toBe(true);
      expect(client.state.connection.status).toBe("connected");
    } finally {
      client.stop();
    }
  });

  it("drops this device's token, and stops, when the route reports another identity", async () => {
    const identity = { id: "gateway-a" };
    const { gateway, storage, client } = await routed(identity);
    try {
      await until(() => storage.data.get("connection")!.includes("gateway-a"));
      // Another gateway answers on the same profile and port now.
      identity.id = "gateway-b";
      gateway.dropAll();
      await until(() => client.state.connection.error?.code === ROUTE_IDENTITY_CHANGED);
      expect(storage.data.has(tokenKey(URL))).toBe(false);
      expect(client.state.connection.status).toBe("error");
      // Not used again until this device pairs there again: nothing reconnects by itself.
      const connects = gateway.connects.length;
      await sleep(300);
      expect(gateway.connects).toHaveLength(connects);
    } finally {
      client.stop();
    }
  });

  it("a route another client on this store saved with another identity since this one started is stopped, and that identity kept", async () => {
    const gateway = readGateway();
    let answer!: () => void;
    const asked = new Promise<void>((done) => (answer = done));
    // The gateway names itself only once the other client has saved the route's identity.
    gateway.handlers["gateway.identity.get"] = async () => {
      await asked;
      return { deviceId: "gateway-b" };
    };
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null, route: ROUTE }),
      [tokenKey(URL)]: JSON.stringify({ ...JSON.parse(SAVED), route: ROUTE }),
    });
    const client = new ClawtrateClient(testHost(gateway, storage), {
      ...FAST,
      localConnect: () => route(gateway, () => true).sockets,
    });
    try {
      await client.start();
      await until(() => client.state.connection.status === "connected");
      await storage.set(
        "connection",
        JSON.stringify({ url: URL, token: null, route: ROUTE, gatewayId: "gateway-a" }),
      );
      answer();
      await until(() => client.state.connection.error?.code === ROUTE_IDENTITY_CHANGED);
      expect(JSON.parse(storage.data.get("connection")!)).toMatchObject({ gatewayId: "gateway-a" });
      expect(storage.data.has(tokenKey(URL))).toBe(false);
      const connects = gateway.connects.length;
      await sleep(300);
      expect(gateway.connects).toHaveLength(connects);
    } finally {
      client.stop();
    }
  });

  it("a changed route stops before its token is dropped, publishes no other identity, and says so when the token can't be dropped", async () => {
    const identity = { id: "gateway-a" };
    const { gateway, storage, client } = await routed(identity);
    const published: Array<string | null> = [];
    client.store.subscribe((state) => void published.push(state.connection.gatewayId));
    const atDelete: string[] = [];
    const remove = storage.delete.bind(storage);
    storage.delete = async (key) => {
      if (key !== tokenKey(URL)) return remove(key);
      atDelete.push(client.state.connection.status);
      throw new Error("the store refused");
    };
    try {
      await until(() => storage.data.get("connection")!.includes("gateway-a"));
      identity.id = "gateway-b";
      gateway.dropAll();
      await until(() => atDelete.length > 0);
      // The connection had stopped before the token's deletion was asked.
      expect(atDelete).toEqual(["error"]);
      await until(
        () => client.state.connection.error?.message.includes("couldn't remove") === true,
      );
      expect(client.state.connection.status).toBe("error");
      expect(published).not.toContain("gateway-b");
      // The token stayed, and nothing reconnects by itself.
      expect(storage.data.has(tokenKey(URL))).toBe(true);
      const connects = gateway.connects.length;
      await sleep(300);
      expect(gateway.connects).toHaveLength(connects);
      expect(client.state.connection.status).toBe("error");
    } finally {
      client.stop();
    }
  });

  it("an ordinary gateway, saved without a route, saves no identity and loses nothing", async () => {
    const gateway = readGateway();
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gateway-a" });
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null }),
      [tokenKey(URL)]: SAVED,
    });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    try {
      await client.start();
      await until(() => client.state.connection.gatewayId === "gateway-a");
      await sleep(100);
      expect(JSON.parse(storage.data.get("connection")!)).toEqual({ url: URL, token: null });
    } finally {
      client.stop();
    }
  });
});
