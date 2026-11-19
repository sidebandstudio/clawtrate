// The one connection made through a forward before it is called up, against
// loopback servers of the test's own: an HTTP answer, something else, and a
// connection closed while the forward reports why.

import { createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { probeHttp } from "../../src/main/ssh/http-probe.ts";
import { httpGateway } from "./harness.ts";

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of servers.splice(0)) await close();
});

function tcp(onConnect: (socket: Socket) => void): Promise<number> {
  return new Promise((resolve) => {
    const sockets = new Set<Socket>();
    const server: Server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      onConnect(socket);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      servers.push(
        () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      );
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

const quiet = () => ({ refused: false, connectFailed: false });

describe("the probe through a forward", () => {
  it("is an answer when an HTTP status line comes back, and sends no credential", async () => {
    const gateway = await httpGateway();
    servers.push(gateway.close);
    expect(await probeHttp(gateway.port, 18789, quiet)).toBe("http");
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]).toMatch(/^GET \/healthz /);
    expect(gateway.requests[0]).toContain('"host":"127.0.0.1:18789"');
    expect(gateway.requests[0]).not.toMatch(/authorization|cookie|token/i);
  });

  it("is no answer when something else answers, or nothing does in time", async () => {
    const other = await tcp((socket) => socket.end("SSH-2.0-OpenSSH_9.9\r\n"));
    expect(await probeHttp(other, 18789, quiet)).toBe("no-answer");
    const silent = await tcp(() => {});
    expect(await probeHttp(silent, 18789, quiet, 300)).toBe("no-answer");
  });

  it("tells a refused forwarding and a closed gateway port by what the forward reported", async () => {
    const closing = await tcp((socket) => socket.destroy());
    expect(await probeHttp(closing, 18789, () => ({ refused: true, connectFailed: false }))).toBe(
      "forwarding-refused",
    );
    expect(await probeHttp(closing, 18789, () => ({ refused: false, connectFailed: true }))).toBe(
      "gateway-closed",
    );
    expect(await probeHttp(closing, 18789, quiet)).toBe("no-answer");
  });
});
