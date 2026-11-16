import { describe, expect, it } from "vitest";
import { applyBridgeCommand, parseBridgeCommand } from "../src/bridge.ts";
import type { ClawtrateClient } from "../src/client.ts";

describe("parseBridgeCommand", () => {
  it("accepts the known commands", () => {
    expect(parseBridgeCommand({ type: "connect", url: "ws://127.0.0.1:19001" })).toEqual({
      type: "connect",
      url: "ws://127.0.0.1:19001",
      token: null,
    });
    expect(parseBridgeCommand({ type: "openSession", key: "agent:otto:disk-space" })).toEqual({
      type: "openSession",
      key: "agent:otto:disk-space",
    });
    expect(parseBridgeCommand({ type: "retry", extra: 1 })).toEqual({ type: "retry" });
  });

  it("rejects malformed input from a renderer", () => {
    expect(() => parseBridgeCommand(null)).toThrow();
    expect(() => parseBridgeCommand({ type: "eval", code: "1" })).toThrow("unknown command");
    expect(() => parseBridgeCommand({ type: "connect", url: 4 })).toThrow("invalid url");
    expect(() => parseBridgeCommand({ type: "openSession", key: "../../etc" })).toThrow();
    expect(() => parseBridgeCommand({ type: "connect", url: "ws://x", token: {} })).toThrow();
  });
});

describe("applyBridgeCommand policy", () => {
  const calls: unknown[] = [];
  const client = {
    connect: async (options: unknown) => void calls.push(options),
  } as unknown as ClawtrateClient;

  it("refuses gateways outside the host's allowlist", async () => {
    await expect(
      applyBridgeCommand(
        client,
        { type: "connect", url: "wss://elsewhere.example" },
        { allowGatewayUrl: (url) => url === "ws://127.0.0.1:19001" },
      ),
    ).rejects.toThrow(/only connects to the development gateway/);
    expect(calls).toEqual([]);
  });

  it("connects to the development gateway with the host's token, never the renderer's", async () => {
    await applyBridgeCommand(
      client,
      { type: "connectDevGateway" },
      { devGateway: { url: "ws://127.0.0.1:19001", token: "host-only" } },
    );
    expect(calls).toEqual([{ url: "ws://127.0.0.1:19001", token: "host-only" }]);
    await expect(applyBridgeCommand(client, { type: "connectDevGateway" }, {})).rejects.toThrow();
  });
});
