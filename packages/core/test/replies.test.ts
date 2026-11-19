// Replies (parity F-067): a reply is the gateway's reference to the message it answers, kept on
// every attempt, and history's references are the only thing that makes a row a reply.
import { describe, expect, it } from "vitest";
import { mapHistory } from "../src/mapping.ts";
import { agentEvent, KEY, openTask } from "./client-harness.ts";
import { until } from "./fake-gateway.ts";

describe("replies", () => {
  it("F-067: Try again on a failed reply sends it again as a reply to the same message", async () => {
    const { client, gateway, transcript } = await openTask();
    client.sendMessage(KEY, "Could you read the log another way?", { replyToId: "row-parent" });
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

  it("F-067: only a user row's own gateway reference makes it a reply; an assistant row's is not read until each bubble carries its own", () => {
    const items = mapHistory([
      { role: "assistant", content: "The disk is fine.", __openclaw: { id: "a1", runId: "r1" } },
      {
        role: "user",
        content: "Are you sure?",
        __openclaw: {
          id: "u2",
          replyToId: "a1",
          replyToMessage: {
            ok: true,
            message: { role: "assistant", content: "The disk is fine." },
          },
        },
      },
      // The answer that follows the reply, with no reference: not a reply.
      { role: "assistant", content: "Checking again.", __openclaw: { id: "a3", runId: "r2" } },
      // An answer the gateway delivered as a reply.
      {
        role: "assistant",
        content: "Yes: 61% used.",
        openclawDelivery: { replyToId: "u2" },
        __openclaw: { id: "a4", runId: "r3" },
      },
    ]);
    expect(items.map((item) => [item.messageId, item.replyTo?.id ?? null])).toEqual([
      ["a1", null],
      ["u2", "a1"],
      ["a3", null],
      ["a4", null],
    ]);
    // With no stored preview, the text is the message history attached to the reference.
    expect(items[1]!.replyTo).toEqual({ id: "a1", text: "The disk is fine.", sender: null });
  });
});
