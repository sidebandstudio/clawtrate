import {
  emptyActivity,
  initialState,
  type ClawtrateState,
  type ConnectionStatus,
  type Transcript,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { rowTime, stampTime } from "../src/format.ts";
import { stripFor, taskInSync } from "../src/StatusStrip.tsx";

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
  ...emptyActivity,
  linkedRuns: {},
  interSession: [],
  sessionKey: "agent:otto:a",
  status: "error",
  items: [{ id: "1", role: "user", timestamp: 1, blocks: [], model: null }],
  error: "timed out",
  hasMore: false,
  live: null,
  loadedAt: 100,
};

const KEY = "agent:otto:a";

/** A state with the open task's transcript, connected at `connectedAt`. */
function withTask(base: ClawtrateState, transcript: Transcript, connectedAt = 500): ClawtrateState {
  return {
    ...base,
    connection: { ...base.connection, connectedAt },
    transcripts: { [KEY]: transcript },
  };
}

describe("the status strip (visual-language.md, section 11)", () => {
  it("counts down while reconnecting, for reconnecting and connecting alike", () => {
    for (const status of ["reconnecting", "connecting"] as const) {
      expect(stripFor(state(status), "dropped", null)).toMatchObject({
        tone: "warn",
        countdown: true,
        action: "retry",
      });
    }
  });

  it("names the gateway it cannot reach", () => {
    expect(stripFor(state("error"), "dropped", null)).toMatchObject({
      tone: "danger",
      text: "Can't reach 127.0.0.1:19001",
    });
  });

  it("says catching up, then synced, only after a drop", () => {
    expect(stripFor(state("connected", "loading"), "dropped", null)?.more).toBe("catching up");
    expect(stripFor(state("connected"), "synced", null)?.text).toBe("Synced");
    expect(stripFor(state("connected", "loading"), "none", null)).toBeNull();
    expect(stripFor(state("connected"), "none", null)).toBeNull();
  });

  it("reports a task that failed to sync after a drop, and leaves other failures to the conversation", () => {
    expect(stripFor(withTask(state("connected"), failed), "dropped", KEY)).toMatchObject({
      text: "Couldn't sync this task",
      action: "reload",
    });
    expect(stripFor(withTask(state("connected"), failed), "none", KEY)).toBeNull();
  });

  it("waits for the open task to reload after a drop before it can say Synced", () => {
    const cached: Transcript = { ...failed, status: "ready", error: null, loadedAt: 100 };
    // Loaded before the latest connect: still catching up, though bots and tasks are back.
    expect(taskInSync(withTask(state("connected"), cached, 500), KEY)).toBe(false);
    expect(stripFor(withTask(state("connected"), cached, 500), "dropped", KEY)?.more).toBe(
      "catching up",
    );
    // Reloaded since then: in sync.
    expect(taskInSync(withTask(state("connected"), { ...cached, loadedAt: 600 }, 500), KEY)).toBe(
      true,
    );
    // A transcript still loading is not in sync either.
    const loading: Transcript = { ...cached, status: "loading", loadedAt: null };
    expect(taskInSync(withTask(state("connected"), loading, 500), KEY)).toBe(false);
    // With no task open, bots and tasks are all there is to sync.
    expect(taskInSync(state("connected"), null)).toBe(true);
  });

  it("reports a failed discovery while connected", () => {
    expect(stripFor(state("connected", "error"), "none", null)).toMatchObject({
      tone: "danger",
      action: "retry",
    });
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
