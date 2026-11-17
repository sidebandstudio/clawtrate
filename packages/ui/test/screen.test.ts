import { initialState, type ClawtrateState, type ConnectionStatus } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { screenFor } from "../src/screen.ts";

function state(status: ConnectionStatus, bots: number): ClawtrateState {
  return {
    ...initialState,
    connection: { ...initialState.connection, status },
    bots: Array.from({ length: bots }, (_, i) => ({
      id: `b${i}`,
      name: `Bot ${i}`,
      emoji: null,
      avatarUrl: null,
      theme: null,
      model: null,
      isDefault: i === 0,
    })),
  };
}

describe("screenFor (C2)", () => {
  it("keeps the shell up through every automatic retry while data is cached", () => {
    for (const status of ["connected", "reconnecting", "connecting", "error"] as const) {
      expect(screenFor(state(status, 4))).toBe("shell");
    }
  });

  it("shows the connection screen for first connects and pairing", () => {
    expect(screenFor(state("idle", 0))).toBe("connect");
    expect(screenFor(state("connecting", 0))).toBe("connect");
    expect(screenFor(state("pairing", 0))).toBe("connect");
    expect(screenFor(state("pairing", 4))).toBe("connect");
  });

  it("shows the shell for a connected gateway with no bots, so its error or empty state is visible", () => {
    expect(screenFor(state("connected", 0))).toBe("shell");
  });
});
