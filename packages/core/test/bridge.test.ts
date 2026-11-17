import { describe, expect, it } from "vitest";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
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

describe("bridge session policy", () => {
  const calls: unknown[] = [];
  const client = {
    connect: async (options: unknown) => void calls.push(options),
  } as unknown as ClawtrateClient;

  it("connects to the development gateway with the host's token, never the renderer's", async () => {
    const session = createBridgeSession(client, {
      devGateway: { url: "ws://127.0.0.1:19001", token: "host-only" },
    });
    await session.apply({ type: "connectDevGateway" });
    expect(calls).toEqual([{ url: "ws://127.0.0.1:19001", token: "host-only" }]);
    await expect(
      createBridgeSession(client, {}).apply({ type: "connectDevGateway" }),
    ).rejects.toThrow();
  });

  it("refuses commands after the viewer is gone", async () => {
    const session = createBridgeSession(client);
    session.dispose();
    await expect(session.apply({ type: "retry" })).rejects.toThrow(/disconnected/);
  });
});
