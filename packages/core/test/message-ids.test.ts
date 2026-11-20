// What a message action names (parity F-066): the gateway's id of the row whose text the
// bubble shows, also when one turn of the bot's shows several bubbles.
import { describe, expect, it } from "vitest";
import { mapHistory } from "../src/mapping.ts";

describe("message ids", () => {
  it("F-066: a turn of a progress row and a final row keeps each bubble's own row id", () => {
    const items = mapHistory([
      { role: "user", content: "Tidy the logs.", __openclaw: { id: "u1" } },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking at the logs first." },
          { type: "toolCall", id: "c1", name: "ls", arguments: { path: "." } },
        ],
        __openclaw: { id: "a1", runId: "r1" },
      },
      { role: "toolResult", toolCallId: "c1", content: "notes/", __openclaw: { id: "t1" } },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done: nothing to tidy." }],
        __openclaw: { id: "a2", runId: "r1" },
      },
    ]);
    expect(items).toHaveLength(2);
    const bubbles = items[1]!.blocks.flatMap((block) =>
      block.kind === "text" ? [[block.text, block.messageId]] : [],
    );
    expect(bubbles).toEqual([
      ["Looking at the logs first.", "a1"],
      ["Done: nothing to tidy.", "a2"],
    ]);
    expect(items[0]!.messageId).toBe("u1");
  });
});
