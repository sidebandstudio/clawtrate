// A screen's write right after a connect, before the gateway has named itself: it waits for the
// identity on the screen's target, and keeps the screen's target when the host moved on.

import { initialState, type ClawtrateState } from "@clawtrate/core";
import { afterEach, expect, it, vi } from "vitest";
import { screenStamp } from "../src/stamp.ts";

function host(gatewayId: string | null, target: number) {
  let state: ClawtrateState = {
    ...initialState,
    connection: { ...initialState.connection, status: "connected", gatewayId, target },
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

afterEach(() => void vi.useRealTimers());

it("a write made before the gateway names itself waits for the name, then carries it with the screen's target", async () => {
  const bridge = host(null, 7);
  let stamp: unknown = null;
  void screenStamp(bridge, 7).then((value) => (stamp = value));
  await Promise.resolve();
  expect(stamp).toBeNull();
  bridge.connection({ gatewayId: "gateway-a" });
  await Promise.resolve();
  expect(stamp).toEqual({ gatewayId: "gateway-a", target: 7 });
  expect(bridge.listening()).toBe(0);
});

it("a write whose gateway is already named goes at once, with the screen's target, not the host's", async () => {
  expect(await screenStamp(host("gateway-a", 7), 7)).toEqual({ gatewayId: "gateway-a", target: 7 });
  expect(await screenStamp(host("gateway-a", 9), 7)).toEqual({ gatewayId: null, target: 7 });
});

it("a write waiting when the host is pointed elsewhere keeps the screen's target, so the host refuses it", async () => {
  const bridge = host(null, 7);
  const pending = screenStamp(bridge, 7);
  bridge.connection({ target: 8, gatewayId: "gateway-b" });
  expect(await pending).toEqual({ gatewayId: null, target: 7 });
});

it("a gateway that never names itself: the write goes without a name after the wait, for the host to refuse", async () => {
  vi.useFakeTimers();
  const bridge = host(null, 7);
  const pending = screenStamp(bridge, 7, 1_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await pending).toEqual({ gatewayId: null, target: 7 });
  expect(bridge.listening()).toBe(0);
});
