// A Page a later message shows again (docs/design/library.md, section 5).
import type { TranscriptItem } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { shownAgainBelow } from "../src/artifacts/words.ts";

const message = (id: string, ...docIds: string[]): TranscriptItem =>
  ({
    id,
    role: "assistant",
    timestamp: 0,
    model: null,
    blocks: docIds.map((docId) => ({ kind: "page", docId, title: "Trail guide" })),
  }) as TranscriptItem;

describe("a Page shown again", () => {
  it("F-115: a duplicate within one message is not a later Page share", () => {
    expect([...shownAgainBelow([message("m1", "trail", "trail")])]).toEqual([]);
    expect([...shownAgainBelow([message("m1", "trail", "trail"), message("m2", "trail")])]).toEqual(
      ["m1:trail"],
    );
    expect([...shownAgainBelow([message("m1", "trail"), message("m2", "trail", "trail")])]).toEqual(
      ["m1:trail"],
    );
    expect([...shownAgainBelow([message("m1", " "), message("m2", " ")])]).toEqual([]);
  });
});
