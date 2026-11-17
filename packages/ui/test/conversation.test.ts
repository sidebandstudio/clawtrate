import {
  initialState,
  type ClawtrateState,
  type ConnectionStatus,
  type Transcript,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { stepsLabel } from "../src/Conversation.tsx";
import { rowTime, stampTime } from "../src/format.ts";
import { stripFor } from "../src/StatusStrip.tsx";

function state(
  status: ConnectionStatus,
  discovery: ClawtrateState["discovery"]["status"] = "ready",
): ClawtrateState {
  return {
    ...initialState,
    connection: { ...initialState.connection, status, gatewayUrl: "ws://127.0.0.1:19001" },
    discovery: { status: discovery, error: null, partial: false },
  };
}

const failed: Transcript = {
  sessionKey: "agent:otto:a",
  status: "error",
  items: [{ id: "1", role: "user", timestamp: 1, blocks: [], model: null }],
  error: "timed out",
  hasMore: false,
  live: null,
};

describe("the status strip (visual-language.md, section 11)", () => {
  it("counts down while reconnecting, for reconnecting and connecting alike", () => {
    for (const status of ["reconnecting", "connecting"] as const) {
      expect(stripFor(state(status), "dropped", undefined)).toMatchObject({
        tone: "warn",
        countdown: true,
        action: "retry",
      });
    }
  });

  it("names the gateway it cannot reach", () => {
    expect(stripFor(state("error"), "dropped", undefined)).toMatchObject({
      tone: "danger",
      text: "Can't reach 127.0.0.1:19001",
    });
  });

  it("says catching up, then synced, only after a drop", () => {
    expect(stripFor(state("connected", "loading"), "dropped", undefined)?.more).toBe("catching up");
    expect(stripFor(state("connected"), "synced", undefined)?.text).toBe("Synced");
    expect(stripFor(state("connected", "loading"), "none", undefined)).toBeNull();
    expect(stripFor(state("connected"), "none", undefined)).toBeNull();
  });

  it("reports a task that failed to sync after a drop, and leaves other failures to the conversation", () => {
    expect(stripFor(state("connected"), "dropped", failed)).toMatchObject({
      text: "Couldn't sync this task",
      action: "reload",
    });
    expect(stripFor(state("connected"), "none", failed)).toBeNull();
  });

  it("reports a failed discovery while connected", () => {
    expect(stripFor(state("connected", "error"), "none", undefined)).toMatchObject({
      tone: "danger",
      action: "retry",
    });
  });
});

describe("folded work", () => {
  it("counts what is inside", () => {
    const thought = { kind: "reasoning", text: "x" } as const;
    const tool = {
      kind: "tool-call",
      callId: "c",
      name: "ls",
      argumentsText: "{}",
      result: null,
    } as const;
    expect(stepsLabel([thought, tool, tool])).toBe("Thought, used 2 tools");
    expect(stepsLabel([tool])).toBe("Used 1 tool");
    expect(stepsLabel([thought])).toBe("Thought");
  });
});

describe("times", () => {
  const now = new Date(2026, 10, 16, 17, 40).getTime();
  it("reads today, yesterday, the weekday and the date on a row", () => {
    expect(rowTime(new Date(2026, 10, 16, 17, 36).getTime(), now)).toMatch(/5:36\s?PM/);
    expect(rowTime(new Date(2026, 10, 15, 9, 2).getTime(), now)).toBe("Yesterday");
    expect(rowTime(new Date(2026, 10, 12, 9, 2).getTime(), now)).toMatch(/^\w{3}$/);
    expect(rowTime(new Date(2026, 10, 2, 9, 2).getTime(), now)).toMatch(/Nov\s2/);
  });

  it("stamps the transcript with the day and the time", () => {
    expect(stampTime(new Date(2026, 10, 16, 17, 36).getTime(), now)).toMatch(/^Today 5:36\s?PM$/);
    expect(stampTime(new Date(2026, 10, 15, 9, 2).getTime(), now)).toMatch(/^Yesterday 9:02\s?AM$/);
  });
});
