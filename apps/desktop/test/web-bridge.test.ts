// The browser's bridge against a real web host: interest survives a reconnect,
// slow viewers are bounded, and uploads arriving together cannot exceed the
// host's room for files.

import {
  AttachmentStore,
  createRemoteBridge,
  MAX_VIEWER_OPEN_TASKS,
  createStore,
  initialState,
  type ClawtrateClient,
  type WebSocketLike,
} from "@clawtrate/core";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { HostRuntime } from "../src/host/runtime.ts";
import {
  ACCESS_COOKIE,
  createViewerChannel,
  MAX_RESULT_CHARS,
  MAX_SNAPSHOTS_IN_FLIGHT,
  MAX_UNACCEPTED_RESULTS,
  SNAPSHOT_DRAIN_TIMEOUT_MS,
  createSnapshotGate,
  viewerState,
  startWebHost,
} from "../src/web-host/server.ts";

const TOKEN = "test-access-token";
const hosts: Array<ReturnType<typeof startWebHost>> = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});

async function host(
  policy: HostRuntime["policy"] = {},
  options: { snapshotDrainTimeoutMs?: number } = {},
) {
  const staticDir = mkdtempSync(join(tmpdir(), "clawtrate-static-"));
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Clawtrate</title>");
  const state = createStore(initialState);
  const interest = new Map<string, number>();
  // Tasks the client refuses to open, as with every task slot taken.
  const refusing = new Set<string>();
  const client = {
    store: state,
    get state() {
      return state.get();
    },
    openSession: (key: string) => {
      if (refusing.has(key)) throw new Error("At most 8 tasks can be open at once.");
      interest.set(key, (interest.get(key) ?? 0) + 1);
    },
    closeSession: (key: string) => interest.set(key, (interest.get(key) ?? 1) - 1),
    sendMessage: () => "m-1",
    withdraw: () => {},
  } as unknown as ClawtrateClient;
  const runtime: HostRuntime = {
    client,
    info: { kind: "web", version: "test", devGateway: null },
    policy,
  };
  const started = startWebHost({
    runtime,
    staticDir,
    host: "127.0.0.1",
    port: 0,
    accessToken: TOKEN,
    ...options,
  });
  hosts.push(started);
  await new Promise((resolve) => started.server.once("listening", resolve));
  const base = `http://127.0.0.1:${(started.server.address() as AddressInfo).port}`;
  return { base, interest, refusing, store: state };
}

const until = async (check: () => boolean, ms = 3_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("browser reconnect (F-104)", () => {
  it("restores this viewer's open tasks after the socket comes back", async () => {
    const { base, interest } = await host();
    const sockets: WebSocket[] = [];
    const bridge = await createRemoteBridge({
      open: () => {
        const socket = new WebSocket(`${base.replace("http", "ws")}/bridge`, {
          headers: { cookie: `${ACCESS_COOKIE}=${TOKEN}`, origin: base },
        });
        sockets.push(socket);
        return socket as unknown as WebSocketLike;
      },
      attach: async () => {
        throw new Error("unused");
      },
    });
    await bridge.send({ type: "openSession", key: "agent:otto:task" });
    expect(interest.get("agent:otto:task")).toBe(1);
    sockets[0]!.terminate();
    await until(() => interest.get("agent:otto:task") === 0);
    await until(() => sockets.length === 2 && interest.get("agent:otto:task") === 1);
    // The selected task's commands work again without the interface reopening it.
    await until(() => sockets[1]!.readyState === WebSocket.OPEN);
    const sent = await bridge.invoke({
      type: "sendMessage",
      key: "agent:otto:task",
      text: "hi",
      mode: "auto",
      attachmentIds: [],
    });
    expect(sent).toEqual({ messageId: "m-1" });
    sockets[1]!.close();
  });
});

describe("the tasks a browser asks to have open again", () => {
  it("are the ones the host accepted: a refused open is not asked again after a reconnect", async () => {
    const { base, interest } = await host();
    const sockets: WebSocket[] = [];
    const bridge = await createRemoteBridge({
      open: () => {
        const socket = new WebSocket(`${base.replace("http", "ws")}/bridge`, {
          headers: { cookie: `${ACCESS_COOKIE}=${TOKEN}`, origin: base },
        });
        sockets.push(socket);
        return socket as unknown as WebSocketLike;
      },
      attach: async () => {
        throw new Error("unused");
      },
    });
    const keys = Array.from({ length: MAX_VIEWER_OPEN_TASKS + 1 }, (_, i) => `agent:otto:t${i}`);
    for (const key of keys.slice(0, -1)) await bridge.send({ type: "openSession", key });
    // One more than a viewer may hold: the host refuses it.
    await expect(bridge.send({ type: "openSession", key: keys.at(-1)! })).rejects.toThrow(
      "open at once",
    );
    // A slot frees up before the socket drops: the refused task must not take it on its own.
    await bridge.send({ type: "closeSession", key: keys[0]! });
    sockets[0]!.terminate();
    await until(() => sockets.length === 2);
    await until(() => keys.slice(1, -1).every((key) => interest.get(key) === 1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The accepted ones are open again; the refused one was never asked for again.
    expect(interest.get(keys.at(-1)!)).toBeUndefined();
    sockets[1]!.close();
  });
});

describe("a task the host refuses to open again after a reconnect", () => {
  it("F-105: is told to the view with the host's reason, and not asked for again", async () => {
    const { base, interest, refusing } = await host();
    const sockets: WebSocket[] = [];
    const bridge = await createRemoteBridge({
      open: () => {
        const socket = new WebSocket(`${base.replace("http", "ws")}/bridge`, {
          headers: { cookie: `${ACCESS_COOKIE}=${TOKEN}`, origin: base },
        });
        sockets.push(socket);
        return socket as unknown as WebSocketLike;
      },
      attach: async () => {
        throw new Error("unused");
      },
    });
    const refused: Array<[string, string]> = [];
    const stop = bridge.onReopenRefused?.((key, error) => refused.push([key, error]));
    const statuses: string[] = [];
    bridge.subscribe((state) => statuses.push(state.connection.status));
    await bridge.send({ type: "openSession", key: "agent:otto:task" });
    refusing.add("agent:otto:task");
    sockets[0]!.terminate();
    await until(() => refused.length > 0);
    expect(refused).toEqual([["agent:otto:task", "At most 8 tasks can be open at once."]]);
    expect(interest.get("agent:otto:task")).toBe(0);

    stop?.();
    refusing.clear();
    const lostAt = statuses.length;
    sockets[1]!.terminate();
    // The new socket's hello is the first state after the lost one's "reconnecting", and the
    // bridge writes any reopen as it reads it; the host answers a later command after that.
    await until(() => {
      const lost = statuses.indexOf("reconnecting", lostAt);
      return lost >= 0 && statuses.slice(lost + 1).some((status) => status !== "reconnecting");
    });
    await bridge.send({ type: "closeSession", key: "agent:otto:other" }).catch(() => undefined);
    expect(interest.get("agent:otto:task")).toBe(0);
    sockets[2]!.close();
  });

  it("F-105: a late refusal of a reopen does not erase a newer open of the same task", async () => {
    const { base, interest, refusing } = await host();
    const sockets: WebSocket[] = [];
    // Hold the host's refusal frames so a reopen's refusal can be delivered after a fresh open
    // of the same task has already succeeded. `deliver` is each socket's bridge-side handler.
    let holdRefusals = false;
    const held: string[] = [];
    const deliver = new Map<WebSocket, (event: { data: unknown }) => void>();
    const bridge = await createRemoteBridge({
      open: () => {
        const socket = new WebSocket(`${base.replace("http", "ws")}/bridge`, {
          headers: { cookie: `${ACCESS_COOKIE}=${TOKEN}`, origin: base },
        });
        sockets.push(socket);
        const proxy = new Proxy(socket as unknown as WebSocketLike, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
          set(target, prop, value) {
            if (prop === "onmessage") {
              const handler = value as (event: { data: unknown }) => void;
              deliver.set(socket, handler);
              (socket as unknown as WebSocket).onmessage = (event) => {
                const data = String((event as { data: unknown }).data);
                let parsed: { type?: string; ok?: boolean } = {};
                try {
                  parsed = JSON.parse(data);
                } catch {
                  /* forward malformed frames as is */
                }
                if (holdRefusals && parsed.type === "result" && parsed.ok === false) {
                  held.push(data);
                  return;
                }
                handler(event);
              };
              return true;
            }
            return Reflect.set(target, prop, value);
          },
        });
        return proxy;
      },
      attach: async () => {
        throw new Error("unused");
      },
    });
    const refused: Array<[string, string]> = [];
    bridge.onReopenRefused?.((key, error) => refused.push([key, error]));
    const statuses: string[] = [];
    bridge.subscribe((state) => statuses.push(state.connection.status));
    await bridge.send({ type: "openSession", key: "agent:otto:task" });

    // The reconnect's reopen is refused, but its refusal is held at the socket.
    holdRefusals = true;
    refusing.add("agent:otto:task");
    const lostAt = statuses.length;
    sockets[0]!.terminate();
    await until(() => {
      const lost = statuses.indexOf("reconnecting", lostAt);
      return lost >= 0 && statuses.slice(lost + 1).some((status) => status !== "reconnecting");
    });
    await until(() => held.length > 0);

    // A fresh open of the same task arrives and the host accepts it.
    holdRefusals = false;
    refusing.clear();
    await bridge.send({ type: "openSession", key: "agent:otto:task" });
    expect(interest.get("agent:otto:task")).toBe(1);

    // Now the stale reopen refusal is delivered. It must not erase the newer open from `wanted`.
    const socket = sockets.at(-1)!;
    const handler = deliver.get(socket)!;
    for (const data of held.splice(0)) handler({ data });
    expect(refused).toEqual([]);

    // The next reconnect restores the task: the bridge kept the newer open in `wanted`.
    refusing.clear();
    const before = sockets.length;
    socket.terminate();
    await until(() => interest.get("agent:otto:task") === 0);
    await until(() => sockets.length > before);
    await until(() => interest.get("agent:otto:task") === 1);
    sockets.at(-1)!.close();
  });
});

describe("a second viewer of a task the host already follows", () => {
  it("gets the task's transcript when it opens it, with nothing else changing", async () => {
    const { base, interest, store } = await host();
    const sockets: WebSocket[] = [];
    const viewer = () =>
      createRemoteBridge({
        open: () => {
          const socket = new WebSocket(`${base.replace("http", "ws")}/bridge`, {
            headers: { cookie: `${ACCESS_COOKIE}=${TOKEN}`, origin: base },
          });
          sockets.push(socket);
          return socket as unknown as WebSocketLike;
        },
        attach: async () => {
          throw new Error("unused");
        },
      });
    const key = "agent:otto:already-loaded";
    const first = await viewer();
    await first.send({ type: "openSession", key });
    // Its history read lands: the one store update this task gets.
    const loaded = {
      sessionKey: key,
      status: "ready",
    } as (typeof initialState.transcripts)[string];
    store.set({ ...initialState, transcripts: { [key]: loaded } });
    await until(() => first.getState().transcripts[key] !== undefined);
    // A second tab opens it: the host follows it already, so the store does not change.
    const second = await viewer();
    expect(second.getState().transcripts[key]).toBeUndefined();
    await second.send({ type: "openSession", key });
    expect(interest.get(key)).toBe(2);
    await until(() => second.getState().transcripts[key] !== undefined);
    expect(second.getState().transcripts[key]).toEqual(loaded);
    for (const socket of sockets) socket.close();
  });
});

describe("slow viewers (one snapshot per viewer beyond what its socket accepted)", () => {
  const fakeSocket = (buffered = 0) => {
    const sent: string[] = [];
    const closed: number[] = [];
    return {
      sent,
      closed,
      socket: {
        readyState: 1,
        OPEN: 1,
        bufferedAmount: buffered,
        send(data: string) {
          sent.push(data);
          this.bufferedAmount += data.length;
        },
        close: (code?: number) => closed.push(code ?? 0),
      },
    };
  };
  const state = (marker: string) => ({
    ...initialState,
    discovery: { ...initialState.discovery, error: marker },
  });
  const markers = (sent: string[]) =>
    sent.map((each) => (JSON.parse(each) as { state: typeof initialState }).state.discovery.error);

  it("writes the next snapshot only once the socket accepted the last, and then only the newest", async () => {
    const viewer = fakeSocket();
    const channel = createViewerChannel(viewer.socket, createSnapshotGate());
    channel.sendState(state("first"));
    channel.sendState(state("second"));
    channel.sendState(state("third"));
    expect(markers(viewer.sent)).toEqual(["first"]);
    viewer.socket.bufferedAmount = 0;
    await until(() => viewer.sent.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(markers(viewer.sent)).toEqual(["first", "third"]);
    channel.stop();
  });

  it(`lets MAX_SNAPSHOTS_IN_FLIGHT (${MAX_SNAPSHOTS_IN_FLIGHT}) viewers hold an unaccepted snapshot, and makes one more wait`, async () => {
    const gate = createSnapshotGate();
    const viewers = Array.from({ length: MAX_SNAPSHOTS_IN_FLIGHT + 1 }, () => fakeSocket());
    const channels = viewers.map((viewer) => createViewerChannel(viewer.socket, gate));
    channels.forEach((channel) => channel.sendState(state("s")));
    expect(viewers.map((viewer) => viewer.sent.length)).toEqual([
      ...Array(MAX_SNAPSHOTS_IN_FLIGHT).fill(1),
      0,
    ]);
    viewers[0]!.socket.bufferedAmount = 0;
    await until(() => viewers.at(-1)!.sent.length === 1);
    channels.forEach((channel) => channel.stop());
  });

  it(`closes a viewer whose socket does not accept its snapshot within the drain time (SNAPSHOT_DRAIN_TIMEOUT_MS = ${SNAPSHOT_DRAIN_TIMEOUT_MS})`, async () => {
    const drain = 200;
    const kept = fakeSocket();
    const keptChannel = createViewerChannel(kept.socket, createSnapshotGate(), undefined, drain);
    keptChannel.sendState(state("s"));
    await new Promise((resolve) => setTimeout(resolve, drain / 2));
    kept.socket.bufferedAmount = 0;
    await new Promise((resolve) => setTimeout(resolve, drain));
    expect(kept.closed).toEqual([]);
    const slow = fakeSocket();
    const slowChannel = createViewerChannel(slow.socket, createSnapshotGate(), undefined, drain);
    slowChannel.sendState(state("s"));
    await until(() => slow.closed.length === 1);
    expect(slow.closed).toEqual([1013]);
    keptChannel.stop();
    slowChannel.stop();
  });

  it(`answers a result longer than MAX_RESULT_CHARS (${MAX_RESULT_CHARS}) with an error`, () => {
    const viewer = fakeSocket();
    const channel = createViewerChannel(viewer.socket, createSnapshotGate());
    channel.send({ type: "result", id: "c1", ok: true, value: "r".repeat(MAX_RESULT_CHARS) });
    channel.send({ type: "result", id: "c2", ok: true, value: "r".repeat(100) });
    const [long, short] = viewer.sent.map((each) => JSON.parse(each) as Record<string, unknown>);
    expect(long).toEqual({ type: "result", id: "c1", ok: false, error: "result too large" });
    expect(short).toMatchObject({ id: "c2", ok: true });
    expect(viewer.sent.every((each) => each.length <= MAX_RESULT_CHARS)).toBe(true);
    channel.stop();
  });

  it(`drops a viewer that leaves more than MAX_UNACCEPTED_RESULTS (${MAX_UNACCEPTED_RESULTS}) results unaccepted`, () => {
    const viewer = fakeSocket();
    const channel = createViewerChannel(viewer.socket, createSnapshotGate());
    for (let i = 0; i < MAX_UNACCEPTED_RESULTS; i += 1) {
      channel.send({ type: "result", id: `c${i}`, ok: true });
    }
    expect(viewer.closed).toEqual([]);
    channel.send({ type: "result", id: "one-more", ok: true });
    expect(viewer.closed).toEqual([1013]);
    expect(viewer.sent).toHaveLength(MAX_UNACCEPTED_RESULTS);
    // Accepted results free their room.
    const reading = fakeSocket();
    const readingChannel = createViewerChannel(reading.socket, createSnapshotGate());
    for (let i = 0; i < MAX_UNACCEPTED_RESULTS * 3; i += 1) {
      readingChannel.send({ type: "result", id: `c${i}`, ok: true });
      reading.socket.bufferedAmount = 0;
    }
    expect(reading.closed).toEqual([]);
    channel.stop();
    readingChannel.stop();
  });

  it("holds at most one unaccepted snapshot for a real paused viewer, and drops it after the drain time", async () => {
    const drain = 400;
    const { base, store } = await host({}, { snapshotDrainTimeoutMs: drain });
    // What the host writes to its sockets, counted where it writes them.
    const written: string[] = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: unknown, ...rest: unknown[]) {
      if (typeof data === "string" && data.startsWith('{"type":"state"')) written.push(data);
      return (send as (...args: unknown[]) => void).call(this, data, ...rest);
    } as typeof send;
    const socket = new WebSocket(`${base.replace("http", "ws")}/bridge`, {
      headers: { cookie: `${ACCESS_COOKIE}=${TOKEN}`, origin: base },
    });
    try {
      await once(socket, "message");
      // Anything the viewer receives once it stops reading would be a snapshot left to flush.
      let delivered = 0;
      socket.on("message", () => (delivered += 1));
      // The viewer stops reading.
      (socket as unknown as { _socket: { pause(): void } })._socket.pause();
      const big = "x".repeat(8 * 1024 * 1024);
      for (let i = 0; i < 10; i += 1) {
        store.update(() => state(`${i}:${big}`));
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      // One written and not accepted; the newer ones wait as one reference, not as copies.
      expect(written).toHaveLength(1);
      const closed = once(socket, "close") as Promise<[number, Buffer]>;
      await new Promise((resolve) => setTimeout(resolve, drain + 200));
      (socket as unknown as { _socket: { resume(): void } })._socket.resume();
      const [code] = await closed;
      expect(written).toHaveLength(1);
      // Dropped with what it left buffered: no close frame (1006), and nothing flushed to it after.
      // A graceful close would deliver the buffered snapshot and then a 1013 close frame.
      expect(code).toBe(1006);
      expect(delivered).toBe(0);
    } finally {
      WebSocket.prototype.send = send;
      socket.terminate();
    }
  }, 15_000);

  it("sends each viewer only the tasks it has open", () => {
    const transcripts = { a: { sessionKey: "a" }, b: { sessionKey: "b" } } as never;
    const shown = viewerState({ ...initialState, transcripts }, new Set(["b"]));
    expect(Object.keys(shown.transcripts)).toEqual(["b"]);
  });
});

describe("uploads arriving together (F-074)", () => {
  it("refuses an upload that would exceed the room held by one still arriving", async () => {
    let id = 0;
    const store = new AttachmentStore({ newId: () => `up-${(id += 1)}`, maxTotalBytes: 1_000 });
    const { base } = await host({ attachments: store });
    const cookie = `${ACCESS_COOKIE}=${TOKEN}`;
    const post = (length: number, body: Buffer | null) =>
      new Promise<{ status: number; finish: (rest: Buffer) => void; done: Promise<number> }>(
        (resolve) => {
          let settle!: (status: number) => void;
          const done = new Promise<number>((r) => (settle = r));
          const req = request(
            `${base}/attachments?name=a.bin&type=application%2Foctet-stream`,
            { method: "POST", headers: { cookie, origin: base, "content-length": String(length) } },
            (res) => {
              res.resume();
              res.on("end", () => settle(res.statusCode ?? 0));
              resolve({ status: res.statusCode ?? 0, finish: () => {}, done });
            },
          );
          req.on("error", () => settle(0));
          if (body) {
            req.write(body);
            // Hold the rest of the body.
            setTimeout(() => resolve({ status: -1, finish: (rest) => req.end(rest), done }), 50);
          } else req.end();
        },
      );
    const first = await post(800, Buffer.alloc(10));
    expect(first.status).toBe(-1);
    const second = await post(300, null);
    expect(second.status).toBe(400);
    first.finish(Buffer.alloc(790));
    expect(await first.done).toBe(200);
  });
});
