// The Settings check's rule for Reconnect (#611), and the proxy's view of the gateway's hello it
// rests on. The Simulator check only ever sees the rule pass, so its failing cases are proven here.

import { createServer, Socket, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeConnections,
  helloWatcher,
  Proxy,
  reconnectedOnce,
  type ProxiedConnection,
} from "../simulator/harness.ts";

const at = (hello: boolean, closed: boolean, openedAt = 0): ProxiedConnection => ({
  line: "GET / HTTP/1.1",
  upgrade: true,
  hello,
  closed,
  openedAt,
  closedAt: closed ? openedAt + 100 : null,
});

describe("reconnectedOnce", () => {
  it("passes one connection that got hello", () => {
    expect(reconnectedOnce([at(true, false)])).toBe(true);
  });

  it("fails one connection that got hello and has since closed: it dropped", () => {
    expect(reconnectedOnce([at(true, true)])).toBe(false);
  });

  it("passes a first connect closed without hello, then one with hello still open", () => {
    expect(reconnectedOnce([at(false, true), at(true, false)])).toBe(true);
  });

  it("fails two connections that each got hello: a drop and a reconnect", () => {
    expect(reconnectedOnce([at(true, true), at(true, false)])).toBe(false);
  });

  it("passes two connects closed without hello, then one with hello still open (#1032)", () => {
    expect(reconnectedOnce([at(false, true), at(false, true), at(true, false)])).toBe(true);
  });

  it("passes three connects closed without hello, then one with hello still open", () => {
    expect(
      reconnectedOnce([at(false, true), at(false, true), at(false, true), at(true, false)]),
    ).toBe(true);
  });

  it("fails two connects closed without hello, then one that got hello and closed: it dropped", () => {
    expect(reconnectedOnce([at(false, true), at(false, true), at(true, true)])).toBe(false);
  });

  it("fails a connect closed without hello, then two that each got hello: a drop and a reconnect", () => {
    expect(reconnectedOnce([at(false, true), at(true, true), at(true, false)])).toBe(false);
  });

  it("fails when the first connect without hello is still open", () => {
    expect(reconnectedOnce([at(false, false), at(true, false)])).toBe(false);
  });

  it("fails one connection that never got hello", () => {
    expect(reconnectedOnce([at(false, false)])).toBe(false);
  });

  it("fails no connection", () => {
    expect(reconnectedOnce([])).toBe(false);
  });
});

describe("describeConnections", () => {
  it("lists each connection's request, hello, state and times from the tap", () => {
    expect(describeConnections([at(false, true, 1_200), at(true, false, 1_500)], 1_000)).toBe(
      [
        "1. GET / HTTP/1.1: no hello, opened at +200 ms, closed at +300 ms",
        "2. GET / HTTP/1.1: hello, opened at +500 ms, open",
      ].join("\n"),
    );
  });
});

/** An unmasked text frame, as a server sends one. */
function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length);
  return Buffer.concat([Buffer.from([0x81, 126]), length, payload]);
}

const HELLO_FRAME = frame(
  JSON.stringify({ type: "res", id: "1", ok: true, payload: { type: "hello-ok", protocol: 4 } }),
);
const CHALLENGE_FRAME = frame(
  JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }),
);
const SWITCHING =
  "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n";

describe("helloWatcher", () => {
  it("finds hello split across two chunks", () => {
    const watch = helloWatcher();
    const cut = HELLO_FRAME.indexOf("hello-ok") + 3;
    expect(watch(Buffer.concat([Buffer.from(SWITCHING), HELLO_FRAME.subarray(0, cut)]))).toBe(
      false,
    );
    expect(watch(HELLO_FRAME.subarray(cut))).toBe(true);
  });

  it("finds hello split one byte at a time", () => {
    const watch = helloWatcher();
    let seen = false;
    for (const byte of HELLO_FRAME) seen = watch(Buffer.from([byte]));
    expect(seen).toBe(true);
  });

  it("does not take the challenge or another answer for hello", () => {
    const watch = helloWatcher();
    expect(watch(CHALLENGE_FRAME)).toBe(false);
    expect(watch(frame(JSON.stringify({ type: "res", id: "1", ok: false })))).toBe(false);
  });
});

describe("Proxy", () => {
  let gateway: Server | null = null;
  let proxy: Proxy | null = null;
  afterEach(async () => {
    await proxy?.stop();
    await new Promise<void>((resolve) => (gateway ? gateway.close(() => resolve()) : resolve()));
    gateway = proxy = null;
  });

  it("records hello the gateway sends in two parts, and the connection's close", async () => {
    const cut = HELLO_FRAME.indexOf("hello-ok") + 3;
    gateway = createServer((socket) => {
      socket.once("data", () => {
        socket.write(Buffer.concat([Buffer.from(SWITCHING), HELLO_FRAME.subarray(0, cut)]));
        setTimeout(() => socket.write(HELLO_FRAME.subarray(cut)), 50);
      });
    });
    await new Promise<void>((resolve) => gateway!.listen(0, "127.0.0.1", resolve));
    proxy = new Proxy((gateway.address() as { port: number }).port);
    const url = new URL(await proxy.start());

    const app = new Socket();
    const received: Buffer[] = [];
    app.on("data", (chunk) =>
      received.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
    );
    await new Promise<void>((resolve) => app.connect(Number(url.port), "127.0.0.1", resolve));
    app.write("GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    await expect.poll(() => proxy!.requests[0]?.hello, { timeout: 5_000 }).toBe(true);
    // The app still gets every byte.
    await expect
      .poll(() => Buffer.concat(received).length, { timeout: 5_000 })
      .toBe(SWITCHING.length + HELLO_FRAME.length);

    const [record] = proxy.requests;
    expect(record).toMatchObject({ line: "GET / HTTP/1.1", upgrade: true, closed: false });
    app.destroy();
    await expect.poll(() => record!.closed, { timeout: 5_000 }).toBe(true);
    expect(record!.closedAt).toBeGreaterThanOrEqual(record!.openedAt);
  });
});
