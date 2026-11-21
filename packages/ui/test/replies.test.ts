// What a thread counts and what "Try again" sends (parity F-067).
import {
  emptyActivity,
  MAX_OUTBOX,
  mapHistory,
  type OutgoingMessage,
  type Run,
  type Transcript,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { messageReplyOf } from "../src/LiveTurn.tsx";
import { reconcileReplyReceipts, repliesTo } from "../src/Messages.tsx";

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
  it("F-067: discarding replies retains only bounded identity records without evicting a live send", () => {
    const live = reply("live", "sending");
    const receipts = new Map([[live.id, { id: live.id, mode: live.mode, runId: live.runId }]]);
    for (let i = 0; i <= MAX_OUTBOX; i += 1) {
      const failed = reply(`failed-${i}`, "failed");
      receipts.set(failed.id, { id: failed.id, mode: failed.mode, runId: failed.runId });
      expect(reconcileReplyReceipts(receipts, { outbox: [live, failed], items: [] })).toEqual([]);
      expect(reconcileReplyReceipts(receipts, { outbox: [live], items: [] })).toEqual([]);
      expect(receipts.get(failed.id)).toStrictEqual({ id: failed.id, mode: "new", runId: null });
    }
    expect(receipts.size).toBe(MAX_OUTBOX + 1);
    expect(receipts.has("failed-0")).toBe(false);
    expect(receipts.has(live.id)).toBe(true);
  });

  it("F-067: delayed history confirms removed replies and a steer only matches its own key", () => {
    const steer = { ...reply("steer", "sent"), mode: "steer" as const, runId: "joined" };
    const created = { ...reply("created", "sent"), runId: "created-run" };
    const receipts = new Map(
      [steer, created].map(({ id }) => [
        id,
        { id, mode: "new" as OutgoingMessage["mode"], runId: null },
      ]),
    );
    const row = (idempotencyKey: string): Transcript["items"][number] => ({
      id: idempotencyKey,
      role: "user",
      blocks: [],
      timestamp: 1,
      model: null,
      idempotencyKey,
    });

    expect(reconcileReplyReceipts(receipts, { outbox: [steer, created], items: [] })).toEqual([]);
    expect(reconcileReplyReceipts(receipts, { outbox: [], items: [row("joined:user")] })).toEqual(
      [],
    );
    const items = [row("joined:user"), row("steer:user"), row("created-run:user")];
    expect(reconcileReplyReceipts(receipts, { outbox: [], items })).toEqual(["steer", "created"]);
    expect(reconcileReplyReceipts(receipts, { outbox: [], items })).toEqual([]);
  });

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

  it("F-067: a progress row and two assistant rows for distinct parents each appear only in their own thread", () => {
    // One run of the bot's: a progress row, an answer the gateway delivered to A, one to B.
    const items = mapHistory([
      { role: "user", content: "Root A", __openclaw: { id: "A" } },
      { role: "user", content: "Root B", __openclaw: { id: "B" } },
      { role: "assistant", content: "Unrelated progress", __openclaw: { id: "m0", runId: "r" } },
      {
        role: "assistant",
        content: "A only",
        openclawDelivery: { replyToId: "A" },
        __openclaw: { id: "m1", runId: "r" },
      },
      {
        role: "assistant",
        content: "B only",
        openclawDelivery: { replyToId: "B" },
        __openclaw: { id: "m2", runId: "r" },
      },
    ]);
    const t = transcript({ items });
    const thread = (parent: string) => repliesTo(t, parent).history.map((reply) => reply.text);
    expect(thread("A")).toEqual(["A only"]);
    expect(thread("B")).toEqual(["B only"]);
    expect(thread("m0")).toEqual([]);
    expect(repliesTo(t, "A").count).toBe(1);
  });
});
