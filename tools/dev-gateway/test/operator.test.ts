// The operator connection the checks drive the gateway through (operator.ts),
// against a stand-in gateway on loopback that can drop the socket the way a
// loaded gateway does. A dropped connection must neither fail a request the
// gateway would answer nor turn a refusal into a pass.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClient } from "@openclaw/gateway-client";
import { WebSocketServer, type WebSocket } from "ws";
import { OperatorSession } from "../src/operator.ts";

type Req = { type: "req"; id: string; method: string; params?: unknown };

class StandIn {
  readonly server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  readonly sockets: WebSocket[] = [];
  readonly calls: string[] = [];
  connects = 0;
  refuseConnections = false;
  /** Each method's answer: a payload, or a refusal; "hold" never answers. */
  answers: Record<string, unknown> = { "config.get": { hash: "h1" } };

  constructor() {
    this.server.on("connection", (socket) => {
      if (this.refuseConnections) {
        socket.terminate();
        return;
      }
      this.sockets.push(socket);
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "nonce-1", ts: Date.now() },
        }),
      );
      socket.on("message", (data) => this.receive(socket, JSON.parse(String(data)) as Req));
    });
  }

  get url(): string {
    const address = this.server.address();
    if (typeof address !== "object" || !address) throw new Error("not listening");
    return `ws://127.0.0.1:${address.port}`;
  }

  private receive(socket: WebSocket, frame: Req): void {
    if (frame.type !== "req") return;
    if (frame.method === "connect") {
      this.connects += 1;
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: helloOk() }));
      return;
    }
    this.calls.push(frame.method);
    const answer = this.answers[frame.method];
    if (answer === "hold") return;
    const reply =
      answer instanceof Error
        ? { ok: false, error: { code: "INVALID_REQUEST", message: answer.message } }
        : { ok: true, payload: answer ?? {} };
    socket.send(JSON.stringify({ type: "res", id: frame.id, ...reply }));
  }

  /** Close every connection as the gateway closes a slow consumer; resolves once the client has answered the close. */
  drop(): Promise<void> {
    const closing = this.sockets.splice(0).map((socket) => {
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      socket.close(1008, "slow consumer");
      return closed;
    });
    return Promise.all(closing).then(() => {});
  }

  close(): Promise<void> {
    for (const socket of this.server.clients) socket.terminate();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

function helloOk() {
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: "2026.10.6", connId: "conn-1", bootId: "boot-1" },
    features: { methods: [], events: [] },
    snapshot: { uptimeMs: 1 },
    auth: { role: "operator", scopes: ["operator.admin"] },
    policy: { maxPayload: 26_214_400, maxBufferedBytes: 52_428_800, tickIntervalMs: 30_000 },
  };
}

const until = async (check: () => boolean) => {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

let gateway: StandIn;
let session: OperatorSession;

beforeEach(async () => {
  gateway = new StandIn();
  await new Promise((resolve) => gateway.server.once("listening", resolve));
  session = await OperatorSession.open({
    url: gateway.url,
    token: "test-token",
    scopes: ["operator.admin"],
    caps: [],
    displayName: "Clawtrate operator test",
    approvePairing: () => Promise.reject(new Error("no pairing in this test")),
  });
});

afterEach(async () => {
  await session.close();
  await gateway.close();
});

describe("an operator connection the gateway drops", () => {
  it("answers a request made while the socket is closing, once the client has reconnected", async () => {
    await gateway.drop();
    expect(gateway.connects).toBe(1);
    const got = await session.request<{ hash: string }>("config.get", {}, 10_000);
    expect(got.hash).toBe("h1");
    expect(gateway.connects).toBe(2);
    expect(gateway.calls).toEqual(["config.get"]);
  });

  it("answers a request made while the client waits to reconnect, once it has", async () => {
    await gateway.drop();
    // The client's first reconnect comes a second or so after the close.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(gateway.connects).toBe(1);
    const got = await session.request<{ hash: string }>("config.get", {}, 10_000);
    expect(got.hash).toBe("h1");
    expect(gateway.connects).toBe(2);
    expect(gateway.calls).toEqual(["config.get"]);
  });

  it("gives the request only the time its wait for the reconnect left", async () => {
    let sent: number | undefined;
    let waited = 0;
    let started = 0;
    const original = GatewayClient.prototype.request;
    const spy = vi.spyOn(GatewayClient.prototype, "request").mockImplementation(function (
      this: GatewayClient,
      ...args: Parameters<GatewayClient["request"]>
    ) {
      waited = Date.now() - started;
      sent = args[2]?.timeoutMs ?? undefined;
      return original.apply(this, args);
    });
    try {
      await gateway.drop();
      started = Date.now();
      await session.request("config.get", {}, 10_000);
    } finally {
      spy.mockRestore();
    }
    expect(waited).toBeGreaterThan(200);
    expect(sent).toBeLessThanOrEqual(10_000 - waited + 50);
  });

  it("still fails a request the gateway refuses after the reconnect, and sends it once", async () => {
    gateway.answers["config.patch"] = new Error("config changed since last load");
    await gateway.drop();
    await expect(session.request("config.patch", { raw: "{}" }, 10_000)).rejects.toThrow(
      "config changed since last load",
    );
    expect(gateway.calls).toEqual(["config.patch"]);
  });

  it("fails a refusal whose words are the client's own, and sends it once", async () => {
    gateway.answers["config.patch"] = new Error("gateway not connected");
    await expect(session.request("config.patch", { raw: "{}" }, 3_000)).rejects.toThrow(
      "gateway not connected",
    );
    expect(gateway.calls).toEqual(["config.patch"]);
  });

  it("does not resend a request that was in flight when the socket closed", async () => {
    gateway.answers["config.patch"] = "hold";
    const pending = session.request("config.patch", { raw: "{}" }, 10_000);
    await until(() => gateway.calls.length === 1);
    // Handle the rejection before the drop: it can land before the drop resolves.
    const failed = expect(pending).rejects.toThrow(/gateway closed \(1008\): slow consumer/);
    await gateway.drop();
    await failed;
    await until(() => gateway.connects === 2);
    expect(gateway.calls).toEqual(["config.patch"]);
  });

  it("names the close when the client cannot reconnect in time", async () => {
    gateway.refuseConnections = true;
    await gateway.drop();
    await expect(session.request("config.get", {}, 1_500)).rejects.toThrow(
      "not reconnected within 1500 ms after the gateway closed (1008 slow consumer)",
    );
    expect(gateway.calls).toEqual([]);
  });
});

describe("a request's limit when it names none", () => {
  /** The `timeoutMs` the client was given for one `config.get` on `on`. */
  async function limitOf(on: OperatorSession): Promise<number | undefined> {
    let sent: number | undefined;
    const original = GatewayClient.prototype.request;
    const spy = vi.spyOn(GatewayClient.prototype, "request").mockImplementation(function (
      this: GatewayClient,
      ...args: Parameters<GatewayClient["request"]>
    ) {
      sent = args[2]?.timeoutMs ?? undefined;
      return original.apply(this, args);
    });
    try {
      await on.request("config.get");
    } finally {
      spy.mockRestore();
    }
    return sent;
  }

  it("is 60 s, or the one the session was opened with (the seed's 180 s, #883)", async () => {
    expect(await limitOf(session)).toBeGreaterThan(59_000);
    expect(await limitOf(session)).toBeLessThanOrEqual(60_000);
    const seedLike = await OperatorSession.open({
      url: gateway.url,
      token: "test-token",
      scopes: ["operator.admin"],
      caps: [],
      displayName: "Clawtrate operator test (seed)",
      approvePairing: () => Promise.reject(new Error("no pairing in this test")),
      requestTimeoutMs: 180_000,
    });
    try {
      expect(await limitOf(seedLike)).toBeGreaterThan(179_000);
      expect(await limitOf(seedLike)).toBeLessThanOrEqual(180_000);
    } finally {
      await seedLike.close();
    }
  });
});
