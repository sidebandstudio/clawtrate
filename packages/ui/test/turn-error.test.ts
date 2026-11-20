// A failed turn is said once (parity F-301): the gateway's own row of the error is not a reply.
import type { Run, TranscriptItem } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { echoesError } from "../src/Conversation.tsx";

const row = (text: string): TranscriptItem => ({
  id: "a:1",
  role: "assistant",
  timestamp: 1,
  blocks: [{ kind: "text", text }],
  model: null,
});
const failed = (message: string) =>
  ({ state: "failed", error: { message, kind: null } }) as unknown as Run;

describe("a failed turn's error, once", () => {
  it("F-301: the gateway's row of a failed run's error repeats it; a reply that had begun does not", () => {
    const error = "LLM request rejected: The scripted model was asked to fail.";
    expect(
      echoesError(
        row("LLM request rejected: The scripted model was asked to fail\\."),
        failed(error),
      ),
    ).toBe(true);
    expect(echoesError(row("Here is the first part of the"), failed(error))).toBe(false);
    expect(echoesError(row(""), failed(""))).toBe(false);
  });
});
