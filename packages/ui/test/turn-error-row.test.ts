// A turn that started and failed, after a reload, is said once: by its card, not also as a reply
// whose text is the error (#723).
import {
  emptyActivity,
  mapHistory,
  RawTable,
  runsFromHistory,
  type Bot,
  type Task,
  type Transcript,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { buildLive } from "../src/Conversation.tsx";

const KEY = "agent:otto:disk-space";
const T0 = 1_795_000_000_000;
const bot = { id: "otto", name: "Otto" } as Bot;
const task = { key: KEY, botId: "otto" } as Task;

function reloaded(rows: unknown[]): Transcript {
  const ctx = { raw: new RawTable(), sessionKey: KEY, now: T0 + 10_000 };
  return {
    ...emptyActivity,
    sessionKey: KEY,
    status: "ready",
    items: mapHistory(rows),
    runs: runsFromHistory(rows, null, ctx),
    error: null,
    hasMore: false,
  } as Transcript;
}

/** The history items drawn as a reply: the bot's items that don't only repeat a run's error. */
function replies(transcript: Transcript): string[] {
  const live = buildLive(bot, task, transcript, {
    connected: true,
    current: true,
    interactive: true,
    may: { canApprove: true, canAnswer: true },
    onRequestAccess: null,
    onShowAction: () => false,
    onReview: () => {},
    leaving: null,
  });
  return transcript.items
    .filter((item) => item.role === "assistant" && !live.echoes.has(item.id))
    .map((item) => item.id);
}

const user = (id: string, seq: number, key?: string) => ({
  role: "user",
  content: `message ${id}`,
  timestamp: T0 + seq,
  __openclaw: { id, seq, ...(key ? { idempotencyKey: key } : {}) },
});
const errorRow = (id: string, runId: string, seq: number) => ({
  role: "assistant",
  content: "provider down",
  stopReason: "error",
  errorMessage: "provider down",
  timestamp: T0 + seq,
  __openclaw: { id, seq, runId },
});

describe("#723: a failed turn's stored error, once", () => {
  it("no message known to have started the run: its card at the end, and its error row no reply", () => {
    const transcript = reloaded([
      user("u-1", 1),
      errorRow("a-2", "run-a", 2),
      user("u-3", 3, "run-b:user"),
      {
        role: "assistant",
        content: "Done.",
        stopReason: "stop",
        timestamp: T0 + 4,
        __openclaw: { id: "a-4", seq: 4, runId: "run-b" },
      },
    ]);
    expect(transcript.runs.find((run) => run.id === "run-a")!.anchorItemId).toBeNull();
    expect(replies(transcript)).toEqual(["a-4:3"]);
  });

  it("a run whose card sits under its message: its error row is no reply either", () => {
    const transcript = reloaded([user("u-1", 1, "run-a:user"), errorRow("a-2", "run-a", 2)]);
    expect(transcript.runs[0]!.anchorItemId).toBe("u-1:0");
    expect(replies(transcript)).toEqual([]);
  });
});
