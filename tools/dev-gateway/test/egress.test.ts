import { request, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { devConfig, sandboxProblems } from "../src/cli.ts";
import { startFakeProvider } from "../src/fake-provider.ts";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

async function provider(log: string[]) {
  const server = startFakeProvider({ port: 0, chunkDelayMs: 0, log: (line) => log.push(line) });
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

describe("nothing beyond loopback", () => {
  it("sends the gateway's egress through the instance's own scripted model", () => {
    const ports = { gatewayPort: 19240, providerPort: 19250 };
    const config = devConfig("t", ports);
    expect(config.proxy).toEqual({ proxyUrl: "http://127.0.0.1:19250" });
    const { proxy: _, ...withoutProxy } = config;
    expect(sandboxProblems(withoutProxy, ports)).toContain("proxy is required");
  });

  it("refuses a tunnel and names its host", async () => {
    const log: string[] = [];
    const port = await provider(log);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port,
        method: "CONNECT",
        path: "catalog.example:443",
      });
      req.on("connect", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(log).toContain("refused a request beyond loopback: CONNECT catalog.example:443");
  });

  it("keeps serving when the client resets a refused tunnel", async () => {
    const log: string[] = [];
    const port = await provider(log);
    const server = servers.at(-1)!;
    // The reset reaches the tunnel's socket as Node delivers it: an 'error' event on that socket.
    server.once("connect", (_req, socket: Duplex) => {
      setImmediate(() =>
        socket.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })),
      );
    });
    await new Promise<void>((resolve) => {
      const req = request({ host: "127.0.0.1", port, method: "CONNECT", path: "api.example:443" });
      req.on("connect", (_res, socket) => {
        socket.destroy();
        resolve();
      });
      req.on("error", () => resolve());
      req.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(log).toContain("refused a request beyond loopback: CONNECT api.example:443");
  });

  it("keeps answering after a client resets a refused tunnel", async () => {
    const log: string[] = [];
    const port = await provider(log);
    const client = connect(port, "127.0.0.1");
    await new Promise((resolve) => client.once("connect", resolve));
    client.write("CONNECT telemetry.example:443 HTTP/1.1\r\nhost: telemetry.example:443\r\n\r\n");
    await expect.poll(() => log.length).toBeGreaterThan(0);
    client.resetAndDestroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await health.json()).toEqual({ ok: true });
  });

  it("refuses a proxied plain request and logs it without its query", async () => {
    const log: string[] = [];
    const port = await provider(log);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, method: "GET", path: "http://catalog.example/v1/feed?token=x" },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(log).toContain("refused a request beyond loopback: GET http://catalog.example/v1/feed");
  });
});
