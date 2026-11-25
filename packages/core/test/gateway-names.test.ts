// Names given to gateways on this device (docs/design/titlebar.md, section 4).
import { describe, expect, it } from "vitest";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
import { ClawtrateClient, GatewayChangedError } from "../src/client.ts";
import {
  GATEWAY_NAMES_KEY,
  MAX_GATEWAY_NAMES,
  MAX_GATEWAY_NAME_CHARS,
  cleanGatewayName,
  gatewayAddress,
  gatewayNameFor,
  readGatewayNames,
  withGatewayName,
  writeGatewayNames,
} from "../src/gateway-names.ts";
import { FakeGateway, deferred, helloOk, memoryStorage, testHost, until } from "./fake-gateway.ts";

const URL = "ws://127.0.0.1:19001";
const FAST = { reconnect: { initialMs: 20, maxMs: 40 } };

describe("F-526: gateway names", () => {
  it("keys a name by the normalised address: host case, a default port and a trailing slash don't matter", () => {
    expect(gatewayAddress("wss://Devbox.Example.test:443/")).toBe("wss://devbox.example.test");
    expect(gatewayAddress("ws://127.0.0.1:19001/gw/")).toBe("ws://127.0.0.1:19001/gw");
    expect(gatewayAddress("not a url")).toBeNull();
    expect(
      gatewayAddress(`ws://127.0.0.1:19001/${"a".repeat(2048)}`),
      "too long to name",
    ).toBeNull();
    const names = withGatewayName([], "wss://devbox.example.test/", "Devbox");
    expect(gatewayNameFor(names, "wss://DEVBOX.example.test:443")).toBe("Devbox");
    expect(gatewayNameFor(names, "wss://devbox.example.test:8443")).toBeNull();
    expect(gatewayNameFor(names, null)).toBeNull();
  });

  it("an empty name removes the name; a name is one trimmed line of at most 40 characters", () => {
    const named = withGatewayName([], URL, "Devbox");
    expect(withGatewayName(named, URL, "   ")).toEqual([]);
    expect(cleanGatewayName("  Dev\nbox\u0000 \u202e ")).toBe("Dev box");
    expect([...cleanGatewayName("x".repeat(60))]).toHaveLength(40);
  });

  it("a name keeps the zero-width joiner and non-joiner an emoji or a word needs, and a name of joiners alone is none", () => {
    const [zwj, zwnj] = [0x200d, 0x200c].map((c) => String.fromCodePoint(c));
    const coder = `${String.fromCodePoint(0x1f469)}${zwj}${String.fromCodePoint(0x1f4bb)}`;
    // Changed on purpose: these joiners used to become a space, splitting the emoji and the word.
    expect(cleanGatewayName(`${coder} Lab`)).toBe(`${coder} Lab`);
    expect(cleanGatewayName(`ﻣﯽ${zwnj}خواهم`)).toBe(`ﻣﯽ${zwnj}خواهم`);
    expect(cleanGatewayName(` ${zwj}${zwnj} `)).toBe("");
    expect(cleanGatewayName(`${zwj} Lab ${zwnj}`)).toBe("Lab");
    expect(withGatewayName([], URL, zwj)).toEqual([]);
  });

  it("a name stays within two JSON characters per character, lone surrogates and all", () => {
    for (const raw of [
      "\ud800".repeat(60),
      "a\udfffb".repeat(20),
      '"\\'.repeat(30),
      "😀".repeat(60),
    ]) {
      const name = cleanGatewayName(raw);
      expect(JSON.stringify(name).length - 2, JSON.stringify(raw).slice(0, 20)).toBeLessThanOrEqual(
        2 * MAX_GATEWAY_NAME_CHARS,
      );
    }
    expect(cleanGatewayName("Dev\ud800box")).toBe("Dev box");
    expect(cleanGatewayName("😀 Lab")).toBe("😀 Lab");
  });

  it("keeps the newest 32 and reads anything unreadable as no names", () => {
    let names = withGatewayName([], URL, "First");
    for (let i = 1; i <= MAX_GATEWAY_NAMES; i++)
      names = withGatewayName(names, `ws://127.0.0.1:${20000 + i}`, `Gateway ${i}`);
    expect(names).toHaveLength(MAX_GATEWAY_NAMES);
    expect(gatewayNameFor(names, URL), "the oldest is dropped").toBeNull();
    expect(readGatewayNames(writeGatewayNames(names))).toEqual(names);
    expect(readGatewayNames("{")).toEqual([]);
    expect(readGatewayNames('{"a":1}')).toEqual([]);
    expect(readGatewayNames('[["ws://a",""],[1,"x"],["ws://b","B"]]')).toEqual([
      { address: "ws://b", name: "B" },
    ]);
  });

  it("names the selected gateway in the host's storage, keeps it across Disconnect, and never sends it", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const storage = memoryStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: "bootstrap" });
    await until(() => client.state.discovery.status === "ready");
    const session = createBridgeSession(client);

    await session.apply(
      parseBridgeCommand({ type: "nameGateway", gatewayUrl: URL, name: "  Devbox " }),
    );
    expect(client.state.connection.gatewayName).toBe("Devbox");
    expect(readGatewayNames(storage.data.get(GATEWAY_NAMES_KEY) ?? null)).toEqual([
      { address: URL, name: "Devbox" },
    ]);

    // Only the address the person saw.
    await expect(client.nameGateway("ws://127.0.0.1:19002", "Other")).rejects.toThrow(
      GatewayChangedError,
    );

    await session.apply(parseBridgeCommand({ type: "disconnect", gatewayUrl: URL }));
    expect(client.state.connection.gatewayName).toBeNull();
    await client.connect({ url: URL + "/", token: "bootstrap" });
    await until(() => client.state.connection.status === "connected");
    expect(client.state.connection.gatewayName, "kept across Disconnect").toBe("Devbox");

    // A new client on the same storage reads it back.
    client.stop();
    const again = new ClawtrateClient(testHost(gateway, storage), FAST);
    await again.start();
    await until(() => again.state.connection.status === "connected");
    expect(again.state.connection.gatewayName).toBe("Devbox");

    await again.nameGateway(again.state.connection.gatewayUrl!, "");
    expect(again.state.connection.gatewayName).toBeNull();
    again.stop();

    expect(JSON.stringify(gateway.requests)).not.toContain("Devbox");
  });

  it("a name the host could not keep is not taken", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const storage = memoryStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: "bootstrap" });
    await until(() => client.state.connection.status === "connected");
    storage.set = () => Promise.reject(new Error("The disk is full."));
    await expect(client.nameGateway(URL, "Devbox")).rejects.toThrow("The disk is full.");
    expect(client.state.connection.gatewayName).toBeNull();
    client.stop();
  });

  it("refuses a malformed command before it reaches the client", () => {
    expect(() => parseBridgeCommand({ type: "nameGateway", gatewayUrl: URL })).toThrow(
      "invalid name",
    );
    expect(() => parseBridgeCommand({ type: "nameGateway", name: "x" })).toThrow("invalid url");
    expect(() =>
      parseBridgeCommand({ type: "nameGateway", gatewayUrl: URL, name: "x".repeat(1001) }),
    ).toThrow("invalid name");
  });
});

describe("F-526: gateway names saved one at a time", () => {
  const OTHER = "ws://127.0.0.1:19002";
  /** Storage whose next write of the names waits until the returned function is called. */
  function heldNames(initial: Record<string, string> = {}) {
    const storage = memoryStorage(initial);
    const set = storage.set.bind(storage);
    const get = storage.get.bind(storage);
    let holdSet: Promise<void> | null = null;
    let holdGet: Promise<void> | null = null;
    storage.set = async (key, value) => {
      if (key === GATEWAY_NAMES_KEY && holdSet) {
        const gate = holdSet;
        holdSet = null;
        await gate;
      }
      return set(key, value);
    };
    storage.get = async (key) => {
      if (key === GATEWAY_NAMES_KEY && holdGet) {
        const value = await get(key);
        const gate = holdGet;
        holdGet = null;
        await gate;
        return value;
      }
      return get(key);
    };
    return {
      storage,
      holdNextSet: () => {
        const gate = deferred<void>();
        holdSet = gate.promise;
        return () => gate.resolve();
      },
      holdNextGet: () => {
        const gate = deferred<void>();
        holdGet = gate.promise;
        return () => gate.resolve();
      },
    };
  }
  async function connected(storage: ReturnType<typeof memoryStorage>) {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: "bootstrap" });
    await until(() => client.state.connection.status === "connected");
    return client;
  }
  const stored = (storage: ReturnType<typeof memoryStorage>) =>
    readGatewayNames(storage.data.get(GATEWAY_NAMES_KEY) ?? null);

  it("a second rename sent while the first is saving ends as the name, in memory and in storage", async () => {
    const held = heldNames();
    const client = await connected(held.storage);
    const release = held.holdNextSet();
    const first = client.nameGateway(URL, "Devbox");
    const second = client.nameGateway(URL, "Lab");
    release();
    await Promise.all([first, second]);
    expect(client.state.connection.gatewayName).toBe("Lab");
    expect(stored(held.storage)).toEqual([{ address: URL, name: "Lab" }]);
    client.stop();
  });

  it("two quick renames of two gateways both keep their names", async () => {
    const held = heldNames();
    const client = await connected(held.storage);
    const release = held.holdNextSet();
    const first = client.nameGateway(URL, "Devbox");
    // Another gateway becomes the selected one before the first name has landed.
    client.store.update((state) => ({
      ...state,
      connection: { ...state.connection, gatewayUrl: OTHER },
    }));
    const second = client.nameGateway(OTHER, "Lab");
    release();
    await Promise.all([first, second]);
    expect(stored(held.storage)).toEqual([
      { address: URL, name: "Devbox" },
      { address: OTHER, name: "Lab" },
    ]);
    expect(client.state.connection.gatewayName).toBe("Lab");
    client.store.update((state) => ({
      ...state,
      connection: { ...state.connection, gatewayUrl: URL },
    }));
    expect(client.state.connection.gatewayName, "kept in memory too").toBe("Devbox");
    client.stop();
  });

  it("a name cleared while the startup read is on its way stays cleared", async () => {
    const held = heldNames({
      [GATEWAY_NAMES_KEY]: writeGatewayNames(withGatewayName([], URL, "Devbox")),
    });
    const gateway = new FakeGateway();
    const client = new ClawtrateClient(testHost(gateway, held.storage), FAST);
    const release = held.holdNextGet();
    const starting = client.start({ resume: false });
    await until(() => client.state.connection.deviceId !== null);
    // The gateway it names is selected (a stand-in for a connection made meanwhile).
    client.store.update((state) => ({
      ...state,
      connection: { ...state.connection, gatewayUrl: URL },
    }));
    const clearing = client.nameGateway(URL, "");
    release();
    await Promise.all([starting, clearing]);
    expect(client.state.connection.gatewayName).toBeNull();
    expect(stored(held.storage)).toEqual([]);
    client.stop();
  });

  it("a names read that never answers doesn't hold later starts or renames once stopped", async () => {
    const storage = memoryStorage();
    const get = storage.get.bind(storage);
    let hang = true;
    const settingsReads: number[] = [];
    storage.get = (key) => {
      if (key === GATEWAY_NAMES_KEY && hang) return new Promise(() => {});
      if (key === "connection") settingsReads.push(Date.now());
      return get(key);
    };
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    const first = client.start();
    await until(() => client.state.connection.deviceId !== null);
    client.stop();
    await first;
    hang = false;
    await client.start();
    expect(settingsReads.length, "the second start reached its settings read").toBeGreaterThan(0);
    await client.connect({ url: URL, token: "bootstrap" });
    await until(() => client.state.connection.status === "connected");
    await client.nameGateway(URL, "Devbox");
    expect(client.state.connection.gatewayName).toBe("Devbox");
    client.stop();
  });

  it("a names read that fails on a later start keeps the names already held", async () => {
    const OTHER_NAME = { address: OTHER, name: "Lab" };
    const storage = memoryStorage({
      [GATEWAY_NAMES_KEY]: writeGatewayNames([OTHER_NAME, { address: URL, name: "Devbox" }]),
    });
    const client = await connected(storage);
    expect(client.state.connection.gatewayName).toBe("Devbox");
    client.stop();
    const get = storage.get.bind(storage);
    storage.get = (key) =>
      key === GATEWAY_NAMES_KEY ? Promise.reject(new Error("unreadable")) : get(key);
    await client.start();
    await client.connect({ url: URL, token: "bootstrap" });
    await until(() => client.state.connection.status === "connected");
    await client.nameGateway(URL, "Home");
    expect(stored(storage)).toEqual([OTHER_NAME, { address: URL, name: "Home" }]);
    client.stop();
  });
});
