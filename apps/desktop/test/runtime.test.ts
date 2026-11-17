// A1 and A3: what a host connects to, and what it tells people to run.
import { createFileStore } from "@clawtrate/core/node";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  approvalInstructionsFor,
  DEV_GATEWAY_URL,
  readDevConnection,
  SavedGatewayRefusedError,
  startHostRuntime,
} from "../src/host/runtime.ts";
import { startWebHost } from "../src/web-host/server.ts";

// A stand-in for some other, private gateway. It only counts connection attempts.
let other: WebSocketServer;
let otherUrl = "";
let attempts = 0;

beforeAll(async () => {
  other = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  other.on("connection", (socket) => {
    attempts += 1;
    socket.close();
  });
  await new Promise((resolve) => other.once("listening", resolve));
  otherUrl = `ws://127.0.0.1:${(other.address() as AddressInfo).port}`;
});

afterAll(() => other.close());

async function dataDirRemembering(url: string): Promise<string> {
  const dataDir = mkdtempSync(join(tmpdir(), "clawtrate-runtime-"));
  await createFileStore(join(dataDir, "state.json")).set(
    "connection",
    JSON.stringify({ url, token: null }),
  );
  return dataDir;
}

const devGateway = { url: DEV_GATEWAY_URL, token: "dev-token" };

describe("token-free development mode (A1)", () => {
  it("refuses to start when the data directory remembers another gateway", async () => {
    const dataDir = await dataDirRemembering(otherUrl);
    await expect(
      startHostRuntime({
        kind: "web",
        displayName: "Clawtrate Web",
        dataDir,
        devGateway,
        autoConnectDev: true,
        devOnly: true,
      }),
    ).rejects.toBeInstanceOf(SavedGatewayRefusedError);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(attempts).toBe(0);
  });

  it("never serves another gateway's data to an unauthenticated bridge", async () => {
    // Even if a runtime were built around a saved private gateway, the client
    // refuses it before opening a socket.
    const dataDir = await dataDirRemembering(otherUrl);
    const runtime = await startHostRuntime({
      kind: "web",
      displayName: "Clawtrate Web",
      dataDir,
      devGateway,
    });
    expect(runtime.client.state.connection.status).not.toBe("idle");
    runtime.client.stop();
    const { ClawtrateClient } = await import("@clawtrate/core");
    const { createNodeHost } = await import("@clawtrate/core/node");
    const guarded = new ClawtrateClient(
      createNodeHost({
        dataDir,
        client: { displayName: "Clawtrate Web", version: "test", platform: "test" },
      }),
      { allowGatewayUrl: (url) => url === DEV_GATEWAY_URL },
    );
    await guarded.start();
    const before = attempts;
    const staticDir = mkdtempSync(join(tmpdir(), "clawtrate-static-"));
    writeFileSync(join(staticDir, "index.html"), "<!doctype html>");
    const host = startWebHost({
      runtime: { client: guarded, info: runtime.info, policy: {} },
      staticDir,
      host: "127.0.0.1",
      port: 0,
      accessToken: null,
    });
    await new Promise((resolve) => host.server.once("listening", resolve));
    const port = (host.server.address() as AddressInfo).port;
    const hello = await new Promise<{
      state: { connection: { status: string; error: { code: string } | null }; bots: unknown[] };
    }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
      socket.once("message", (data) => {
        resolve(JSON.parse(String(data)));
        socket.close();
      });
      socket.once("error", reject);
    });
    expect(hello.state.bots).toEqual([]);
    expect(hello.state.connection.status).toBe("error");
    expect(hello.state.connection.error?.code).toBe("GATEWAY_NOT_ALLOWED");
    expect(attempts).toBe(before);
    guarded.stop();
    await host.close();
  });
});

describe("development connection file (A1)", () => {
  function fileWith(contents: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "clawtrate-devconn-"));
    const path = join(dir, "connection.json");
    writeFileSync(path, JSON.stringify(contents));
    return path;
  }

  it("accepts only the fixed loopback endpoint", () => {
    expect(readDevConnection("", fileWith({ url: DEV_GATEWAY_URL, token: "t" }))).toEqual({
      url: DEV_GATEWAY_URL,
      token: "t",
    });
    expect(
      readDevConnection("", fileWith({ url: "wss://gateway.example.com", token: "t" })),
    ).toBeNull();
    expect(readDevConnection("", fileWith({ url: "ws://127.0.0.1:18789", token: "t" }))).toBeNull();
    expect(readDevConnection("", fileWith({ url: DEV_GATEWAY_URL, token: "" }))).toBeNull();
    expect(readDevConnection("", fileWith("not an object"))).toBeNull();
  });
});

describe("pairing instructions (A3)", () => {
  it("shows only the dev tooling's command for the development gateway", () => {
    expect(approvalInstructionsFor(devGateway)(DEV_GATEWAY_URL, "req-1")).toEqual({
      command: "pnpm dev-gateway approve",
      note: null,
    });
  });

  it("shows the owner's command, with where to run it, for any other gateway", () => {
    for (const instructions of [
      approvalInstructionsFor(devGateway)("wss://gateway.example.com", "req-1"),
      approvalInstructionsFor(null)(DEV_GATEWAY_URL, "req-1"),
    ]) {
      expect(instructions.command).toBe("openclaw devices approve req-1");
      expect(instructions.note).toMatch(/gateway's owner .* machine where the gateway runs/);
    }
  });
});
