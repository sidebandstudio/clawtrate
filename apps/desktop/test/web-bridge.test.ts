// The browser's bridge against a real web host: interest survives a reconnect,
// slow viewers are bounded, and uploads arriving together cannot exceed the
// host's room for files.

import {
  AttachmentStore,
  createRemoteBridge,
  createStore,
  initialState,
  type ClawtrateClient,
  type WebSocketLike,
} from "@clawtrate/core";
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
  SNAPSHOT_HARD_BUFFER_BYTES,
  SNAPSHOT_SOFT_BUFFER_BYTES,
  startWebHost,
} from "../src/web-host/server.ts";

const TOKEN = "test-access-token";
const hosts: Array<ReturnType<typeof startWebHost>> = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});

async function host(policy: HostRuntime["policy"] = {}) {
  const staticDir = mkdtempSync(join(tmpdir(), "clawtrate-static-"));
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Clawtrate</title>");
  const state = createStore(initialState);
  const interest = new Map<string, number>();
  const client = {
    store: state,
    get state() {
      return state.get();
    },
    openSession: (key: string) => interest.set(key, (interest.get(key) ?? 0) + 1),
    closeSession: (key: string) => interest.set(key, (interest.get(key) ?? 1) - 1),
    sendMessage: () => "m-1",
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
  });
  hosts.push(started);
  await new Promise((resolve) => started.server.once("listening", resolve));
  const base = `http://127.0.0.1:${(started.server.address() as AddressInfo).port}`;
  return { base, interest };
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

describe("slow viewers", () => {
  const fakeSocket = (buffered: number) => {
    const sent: string[] = [];
    const closed: number[] = [];
    return {
      sent,
      closed,
      socket: {
        readyState: 1,
        OPEN: 1,
        bufferedAmount: buffered,
        send: (data: string) => sent.push(data),
        close: (code?: number) => closed.push(code ?? 0),
      },
    };
  };

  it(`sends snapshots at SNAPSHOT_SOFT_BUFFER_BYTES and holds them just past it, keeping only the latest`, async () => {
    const at = fakeSocket(SNAPSHOT_SOFT_BUFFER_BYTES);
    createViewerChannel(at.socket).sendState(initialState);
    expect(at.sent).toHaveLength(1);

    const past = fakeSocket(SNAPSHOT_SOFT_BUFFER_BYTES + 1);
    const channel = createViewerChannel(past.socket);
    channel.sendState(initialState);
    channel.sendState({ ...initialState, bots: [] });
    expect(past.sent).toHaveLength(0);
    past.socket.bufferedAmount = 0;
    await until(() => past.sent.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(past.sent).toHaveLength(1);
    channel.stop();
  });

  it(`keeps a viewer at SNAPSHOT_HARD_BUFFER_BYTES and closes one past it`, () => {
    const at = fakeSocket(SNAPSHOT_HARD_BUFFER_BYTES);
    createViewerChannel(at.socket).send({ type: "result", id: "1", ok: true });
    expect(at.closed).toEqual([]);
    const past = fakeSocket(SNAPSHOT_HARD_BUFFER_BYTES + 1);
    createViewerChannel(past.socket).send({ type: "result", id: "1", ok: true });
    expect(past.closed).toEqual([1013]);
    expect(past.sent).toEqual([]);
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
