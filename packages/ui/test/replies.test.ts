// What a thread counts and what "Try again" sends (parity F-067).
import { emptyActivity, type OutgoingMessage, type Run, type Transcript } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { messageReplyOf } from "../src/LiveTurn.tsx";
import { repliesTo } from "../src/Messages.tsx";

const KEY = "agent:otto:disk-space";

function transcript(change: Partial<Transcript>): Transcript {
  return {
    ...emptyActivity,
    sessionKey: KEY,
    status: "ready",
    items: [],
    error: null,
    hasMore: false,
    ...change,
  } as Transcript;
}

const reply = (id: string, status: OutgoingMessage["status"]): OutgoingMessage => ({
  id,
  text: "A reply",
  mode: "new",
  status,
  runId: null,
  messageSeq: null,
  leftAt: null,
  createdAt: 1,
  error: null,
  attachments: [],
  replyToId: "parent",
});

describe("replies in a thread", () => {
  it("F-067: a reply counts only once the gateway has it; held, queued, not sent and failed ones do not", () => {
    const all = transcript({
      outbox: [
        reply("held", "held"),
        reply("queued", "queued"),
        reply("not-sent", "not-sent"),
        reply("failed", "failed"),
        reply("sending", "sending"),
        reply("sent", "sent"),
      ],
    });
    const { pending, count } = repliesTo(all, "parent");
    expect(pending.map((each) => each.id)).toEqual([
      "held",
      "queued",
      "not-sent",
      "failed",
      "sending",
      "sent",
    ]);
    expect(count).toBe(1);
  });

  it("F-067: Try again on a failed reply that only history holds goes as a reply to the same message", () => {
    const run = { messageId: "gone", anchorItemId: "item-1" } as Run;
    const t = transcript({
      items: [
        {
          id: "item-1",
          role: "user",
          timestamp: 1,
          blocks: [{ kind: "text", text: "A reply" }],
          model: null,
          replyTo: { id: "parent", text: null, sender: null },
        },
      ],
    });
    expect(messageReplyOf(run, t)).toBe("parent");
    expect(messageReplyOf({ ...run, anchorItemId: null } as Run, t)).toBeNull();
  });
});
