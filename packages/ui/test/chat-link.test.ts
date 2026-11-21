import {
  initialState,
  type ChatLinkDelivery,
  type ClawtrateState,
  type ConnectionState,
  type DiscoveryState,
  type Task,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { connectionSettled, resolveChatLink } from "../src/chat-link.ts";

const GATEWAY = "ab".repeat(32);
const LINK: ChatLinkDelivery = {
  id: 1,
  status: "valid",
  link: { bot: "marlow", gateway: GATEWAY, text: "Review the intro" },
};
const bot = (id: string) => ({
  id,
  name: id,
  emoji: null,
  avatarUrl: null,
  theme: null,
  model: null,
  isDefault: false,
});
const FAILED = { code: "UNREACHABLE", message: "Nothing answered.", hint: null };

function facts(
  connection: Partial<ConnectionState> = {},
  discovery: Partial<DiscoveryState> = {},
  more: Partial<ClawtrateState> = {},
): ClawtrateState {
  return {
    ...initialState,
    connection: {
      ...initialState.connection,
      status: "connected",
      gatewayId: GATEWAY,
      canWrite: true,
      ...connection,
    },
    discovery: { ...initialState.discovery, status: "ready", ...discovery },
    bots: [bot("otto"), bot("marlow")],
    tasksByBot: { marlow: [{ key: "agent:marlow:1" } as Task] },
    ...more,
  };
}

const resolve = (state: ClawtrateState, starting = false, readOnly = false) =>
  resolveChatLink(LINK, state, { readOnly }, starting);

describe("a Clawtrate link in the interface", () => {
  it("F-248: opens the bot's chat on the matching connected gateway", () => {
    expect(resolve(facts())).toEqual({ kind: "open", botId: "marlow" });
  });

  it("F-248: says the link is invalid first, whatever else is true", () => {
    for (const state of [facts(), facts({ status: "idle" }), facts({}, { status: "loading" })]) {
      expect(resolveChatLink({ id: 2, status: "invalid" }, state, {}, true)).toEqual({
        kind: "refused",
        refusal: "invalid",
      });
    }
  });

  it("F-248: waits while startup connects and while a connection's bots and tasks load", () => {
    expect(resolve(facts({ status: "connecting" }), true)).toEqual({ kind: "wait" });
    expect(resolve(facts({ status: "reconnecting" }), true)).toEqual({ kind: "wait" });
    expect(resolve(facts({}, { status: "loading" }), true)).toEqual({ kind: "wait" });
    expect(resolve(facts({}, { status: "loading" }), false)).toEqual({ kind: "wait" });
    expect(resolve(facts({}, { status: "idle" }), false)).toEqual({ kind: "wait" });
  });

  it("F-248: refuses in the design's order once the connection has an outcome", () => {
    const cases: Array<[ClawtrateState, boolean, string]> = [
      [facts({ status: "idle" }), true, "no-gateway"],
      [facts({ status: "disconnected" }), true, "no-gateway"],
      [facts({ status: "pairing" }), true, "no-gateway"],
      [facts({ status: "error" }), true, "no-gateway"],
      [facts({ status: "connecting", error: FAILED }), true, "no-gateway"],
      // After startup, a dropped connection is not waited for.
      [facts({ status: "reconnecting" }), false, "no-gateway"],
      [facts({ gatewayId: null }), false, "unavailable"],
      [facts({}, { status: "error" }), false, "unavailable"],
      [facts({ gatewayId: "cd".repeat(32) }), false, "other-gateway"],
      [facts({ gatewayId: "cd".repeat(32) }, {}, { bots: [] }), false, "other-gateway"],
      [facts({}, {}, { bots: [bot("otto")] }), false, "unknown-bot"],
      [facts({}, {}, { tasksByBot: { marlow: [] } }), false, "no-chat"],
      [facts({}, {}, { tasksByBot: {} }), false, "no-chat"],
      [facts({}, { partial: true }, { tasksByBot: {} }), false, "unavailable"],
      [facts({ canWrite: false }), false, "read-only"],
    ];
    for (const [state, starting, refusal] of cases) {
      expect(resolve(state, starting), refusal).toEqual({ kind: "refused", refusal });
    }
    expect(resolve(facts(), false, true), "a host pinned read-only").toEqual({
      kind: "refused",
      refusal: "read-only",
    });
  });

  it("F-248: knows when the first connection has an outcome", () => {
    expect(connectionSettled(facts({ status: "connecting" }))).toBe(false);
    expect(connectionSettled(facts({}, { status: "loading" }))).toBe(false);
    expect(connectionSettled(facts())).toBe(true);
    expect(connectionSettled(facts({}, { status: "error" }))).toBe(true);
    expect(connectionSettled(facts({ status: "idle" }))).toBe(true);
    expect(connectionSettled(facts({ status: "reconnecting", error: FAILED }))).toBe(true);
  });
});
