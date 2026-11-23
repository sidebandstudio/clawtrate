// Replies (parity F-067): a reply is the gateway's reference to the message it answers, kept on
// every attempt, and history's references are the only thing that makes a row a reply.
import { describe, expect, it } from "vitest";
import { mapHistory } from "../src/mapping.ts";
import { agentEvent, KEY, openTask, asShown } from "./client-harness.ts";
import { until } from "./fake-gateway.ts";

describe("replies", () => {
  it("F-067: Try again on a failed reply sends it again as a reply to the same message", async () => {
    const { client, gateway, transcript } = await openTask();
    client.sendMessage(KEY, "Could you read the log another way?", {
      ...asShown(client),
      replyToId: "row-parent",
    });
    await until(() => transcript().outbox[0]?.status === "sent");
    const first = transcript().outbox[0]!;
    gateway.emit("agent", agentEvent(first.runId!, 1, "lifecycle", { phase: "start" }));
    gateway.emit(
      "agent",
      agentEvent(first.runId!, 2, "lifecycle", {
        phase: "error",
        error: "overloaded",
        executionSettled: true,
      }),
    );
    await until(() => transcript().runs.some((run) => run.state === "failed"));
    client.sendAgain(KEY, first.id);
    await until(() => gateway.calls("chat.send").length === 2);
    const replies = (gateway.calls("chat.send") as Array<{ replyToId?: string }>).map(
      (each) => each.replyToId ?? null,
    );
    expect(replies).toEqual(["row-parent", "row-parent"]);
    client.stop();
  });

  it("F-067: a row is a reply only by its own gateway reference: a user row's makes the item one, an assistant row's only that row's bubbles", () => {
    const items = mapHistory([
      { role: "assistant", content: "The disk is fine.", __openclaw: { id: "a1", runId: "r1" } },
      {
        role: "user",
        content: "Are you sure?",
        __openclaw: {
          id: "u2",
          idempotencyKey: "send-1:user",
          replyToId: "a1",
          replyToMessage: {
            ok: true,
            message: { role: "assistant", content: "The disk is fine." },
          },
        },
      },
      // The answer that follows the reply, with no reference: not a reply.
      { role: "assistant", content: "Checking again.", __openclaw: { id: "a3", runId: "r2" } },
      // One run: text beside a call, then an answer the gateway delivered as a reply, then one
      // it delivered as a reply to another message.
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me look." },
          { type: "toolCall", id: "c1", name: "ls", arguments: {} },
        ],
        __openclaw: { id: "a4", runId: "r3" },
      },
      { role: "toolResult", toolCallId: "c1", content: "notes/", __openclaw: { runId: "r3" } },
      {
        role: "assistant",
        content: "Yes: 61% used.",
        openclawDelivery: { replyToId: "u2" },
        __openclaw: { id: "a5", runId: "r3" },
      },
      {
        role: "assistant",
        content: "And it was fine before too.",
        openclawDelivery: { replyToId: "a1" },
        __openclaw: { id: "a6", runId: "r3" },
      },
    ]);
    expect(items.map((item) => [item.messageId, item.replyTo?.id ?? null])).toEqual([
      ["a1", null],
      ["u2", "a1"],
      ["a3", null],
      ["a6", null],
    ]);
    const bubbles = items[3]!.blocks.flatMap((block) =>
      block.kind === "text" ? [[block.messageId, block.replyToId ?? null]] : [],
    );
    expect(bubbles).toEqual([
      ["a4", null],
      ["a5", "u2"],
      ["a6", "a1"],
    ]);
    // With no stored preview, the text is the message history attached to the reference.
    expect(items[1]!.replyTo).toEqual({ id: "a1", text: "The disk is fine.", sender: null });
    // The key it was stored under ties it to the message this client sent.
    expect(items[1]!.idempotencyKey).toBe("send-1:user");
  });
});
