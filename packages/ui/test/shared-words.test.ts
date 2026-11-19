// The words the desktop and the iOS app share for what the connection is and
// what a list or a task shows: each rule here holds for both.

import { describe, expect, it } from "vitest";
import { readOnlyWords } from "../src/conversation-words.ts";

describe("the read-only explanation", () => {
  it("names the bot and what this connection does not show", () => {
    const words = readOnlyWords("Otto");
    expect(`${words.lead}${words.rest}`).toBe(
      "Read-only. You can follow Otto's work here. Approvals and questions aren't shown on this connection.",
    );
  });
});
