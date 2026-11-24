// A screen's write sends the stamp of the screen as drawn. Only a screen drawn before the gateway
// named itself waits for the name, on the connection it was drawn on; once the target or the
// connection has moved on, it sends no name, and the host refuses it.

import { initialState, type ClawtrateState } from "@clawtrate/core";
import { afterEach, expect, it, vi } from "vitest";
import { screenStamp, type ShownStamp } from "../src/stamp.ts";

function host(gatewayId: string | null, target: number, connectedAt = 100) {
  let state: ClawtrateState = {
    ...initialState,
    connection: {
      ...initialState.connection,
      status: "connected",
      gatewayId,
      target,
      connectedAt,
    },
  };
  const listeners = new Set<(state: ClawtrateState) => void>();
  return {
    getState: () => state,
    subscribe: (listener: (state: ClawtrateState) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    connection: (patch: Partial<ClawtrateState["connection"]>) => {
      state = { ...state, connection: { ...state.connection, ...patch } };
      for (const listener of listeners) listener(state);
    },
    listening: () => listeners.size,
  };
}

const unnamed = (target: number, connectedAt = 100): ShownStamp => ({
  gatewayId: null,
  target,
  connectedAt,
});

afterEach(() => void vi.useRealTimers());

it("a screen that knew its gateway sends that gateway, whatever the host has now", async () => {
  const shown = { gatewayId: "gateway-a", target: 7, connectedAt: 100 };
  // Another gateway answers at the same address behind a reconnect: the host compares and refuses.
  expect(await screenStamp(host("gateway-x", 7, 200), shown)).toEqual({
    gatewayId: "gateway-a",
    target: 7,
  });
  expect(await screenStamp(host("gateway-a", 9), shown)).toEqual({
    gatewayId: "gateway-a",
    target: 7,
  });
});

it("a screen drawn before the gateway named itself waits for the name on that connection", async () => {
  const bridge = host(null, 7);
  let stamp: unknown = null;
  void screenStamp(bridge, unnamed(7)).then((value) => (stamp = value));
  await Promise.resolve();
  expect(stamp).toBeNull();
  bridge.connection({ gatewayId: "gateway-a" });
  await Promise.resolve();
  expect(stamp).toEqual({ gatewayId: "gateway-a", target: 7 });
  expect(bridge.listening()).toBe(0);
});

it("an unnamed screen whose connection has gone sends no name, though the target is kept", async () => {
  // Drawn on the connection of hello 100; the host has since reconnected, at hello 200.
  expect(await screenStamp(host("gateway-x", 7, 200), unnamed(7))).toEqual({
    gatewayId: null,
    target: 7,
  });
  const bridge = host(null, 7);
  const pending = screenStamp(bridge, unnamed(7));
  bridge.connection({ connectedAt: 200 });
  bridge.connection({ gatewayId: "gateway-x" });
  expect(await pending).toEqual({ gatewayId: null, target: 7 });
});

it("an unnamed screen whose host was pointed elsewhere keeps its target and sends no name", async () => {
  const bridge = host(null, 7);
  const pending = screenStamp(bridge, unnamed(7));
  bridge.connection({ target: 8, gatewayId: "gateway-b" });
  expect(await pending).toEqual({ gatewayId: null, target: 7 });
});

it("a gateway that never names itself: the write goes without a name after the wait, for the host to refuse", async () => {
  vi.useFakeTimers();
  const bridge = host(null, 7);
  const pending = screenStamp(bridge, unnamed(7), 1_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await pending).toEqual({ gatewayId: null, target: 7 });
  expect(bridge.listening()).toBe(0);
});
