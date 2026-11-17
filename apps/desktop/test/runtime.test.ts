// A1 and A3: what a host connects to, and what it tells people to run.
import { createFileStore } from "@clawtrate/core/node";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  approvalInstructionsFor,
  DEV_GATEWAY_URL,
  devConnectionPath,
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

const devGateway = { url: DEV_GATEWAY_URL, token: "dev-token", instance: null };

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
    const read = (contents: unknown) => readDevConnection("", { path: fileWith(contents) });
    expect(read({ url: DEV_GATEWAY_URL, token: "t" })).toEqual({
      url: DEV_GATEWAY_URL,
      token: "t",
      instance: null,
    });
    expect(read({ url: "wss://gateway.example.com", token: "t" })).toBeNull();
    expect(read({ url: "ws://127.0.0.1:18789", token: "t" })).toBeNull();
    expect(read({ url: DEV_GATEWAY_URL, token: "" })).toBeNull();
    expect(read("not an object")).toBeNull();
    // A file written for a named instance is not the default instance's.
    expect(read({ url: DEV_GATEWAY_URL, token: "t", instance: "alpha" })).toBeNull();
  });
});

describe("a named development instance (A1)", () => {
  const NAMED_URL = "ws://127.0.0.1:19240";
  const named = { url: NAMED_URL, token: "named-token", instance: "alpha" };

  /** A checkout whose dev tooling wrote this connection file and run file for "alpha". */
  function checkoutWith(connection: unknown, record: unknown): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "clawtrate-checkout-"));
    const path = devConnectionPath(repoRoot, "alpha");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(connection));
    if (record !== undefined) writeFileSync(join(path, "..", "state.json"), JSON.stringify(record));
    return repoRoot;
  }

  it("reads the connection from the instance's own run folder", () => {
    const repoRoot = checkoutWith(
      { url: NAMED_URL, token: "t", instance: "alpha" },
      { gatewayPort: 19240 },
    );
    expect(devConnectionPath(repoRoot, "alpha")).toBe(
      join(repoRoot, "tools/dev-gateway/.run/instances/alpha/connection.json"),
    );
    expect(readDevConnection(repoRoot, { instance: "alpha" })).toEqual({
      url: NAMED_URL,
      token: "t",
      instance: "alpha",
    });
    // The default instance's file is elsewhere and absent here.
    expect(readDevConnection(repoRoot)).toBeNull();
  });

  it("accepts only the loopback port this checkout's tool recorded for it", () => {
    const read = (connection: object, record?: object) =>
      readDevConnection(checkoutWith(connection, record), { instance: "alpha" });
    const ok = { url: NAMED_URL, token: "t", instance: "alpha" };
    expect(read(ok, { gatewayPort: 19240 })).not.toBeNull();
    // Not what the run file recorded, or no run file at all.
    expect(read(ok, { gatewayPort: 19260 })).toBeNull();
    expect(read(ok)).toBeNull();
    // The default instance's port, the default profile's port and a remote host.
    expect(read({ ...ok, url: DEV_GATEWAY_URL }, { gatewayPort: 19001 })).toBeNull();
    expect(read({ ...ok, url: "ws://127.0.0.1:18789" }, { gatewayPort: 18789 })).toBeNull();
    expect(
      read({ ...ok, url: "ws://gateway.example.com:19240" }, { gatewayPort: 19240 }),
    ).toBeNull();
    expect(read({ ...ok, url: "wss://127.0.0.1:19240" }, { gatewayPort: 19240 })).toBeNull();
    // Written for another instance.
    expect(read({ ...ok, instance: "beta" }, { gatewayPort: 19240 })).toBeNull();
    expect(read({ ...ok, instance: null }, { gatewayPort: 19240 })).toBeNull();
  });

  it("rejects an instance name that is not one before reading anything", () => {
    for (const name of ["../alpha", "Alpha", "default", "dev", ""]) {
      expect(() => readDevConnection("/nonexistent", { instance: name })).toThrow(
        /refusing instance name/,
      );
    }
  });

  it("without a token opens nothing but the selected instance's gateway", async () => {
    // A saved default-instance gateway is refused like any other.
    await expect(
      startHostRuntime({
        kind: "web",
        displayName: "Clawtrate Web",
        dataDir: await dataDirRemembering(DEV_GATEWAY_URL),
        devGateway: named,
        devOnly: true,
      }),
    ).rejects.toBeInstanceOf(SavedGatewayRefusedError);

    const runtime = await startHostRuntime({
      kind: "web",
      displayName: "Clawtrate Web",
      dataDir: mkdtempSync(join(tmpdir(), "clawtrate-runtime-")),
      devGateway: named,
      devOnly: true,
    });
    const before = attempts;
    for (const url of [otherUrl, DEV_GATEWAY_URL]) {
      await expect(runtime.client.connect({ url, token: null })).rejects.toThrow(/not allowed/i);
    }
    expect(attempts).toBe(before);
    expect(runtime.info.devGateway).toEqual({ url: NAMED_URL });
    // The bridge's development command gets the URL and token only.
    expect(runtime.policy.devGateway).toEqual({ url: NAMED_URL, token: "named-token" });
    runtime.client.stop();
  });

  it("shows the approve command for the same instance", () => {
    expect(approvalInstructionsFor(named)(NAMED_URL, "req-1")).toEqual({
      command: "pnpm dev-gateway approve --instance alpha",
      note: null,
    });
    expect(approvalInstructionsFor(named)(DEV_GATEWAY_URL, "req-1").command).toBe(
      "openclaw devices approve req-1",
    );
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
