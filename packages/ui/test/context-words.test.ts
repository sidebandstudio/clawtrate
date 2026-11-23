// The task header's context line (F-059): the gateway's two figures, or no line.

import { describe, expect, it } from "vitest";
import { contextWords } from "../src/format.ts";

describe("the task header's context line", () => {
  it("F-059: says the gateway's count out of the model's window", () => {
    expect(contextWords({ used: 41_776, window: 475_000, fresh: true })).toBe(
      `Context: ${(41_776).toLocaleString(undefined)} of ${(475_000).toLocaleString(undefined)} tokens`,
    );
  });

  it("F-059: marks a count from before the latest run with about", () => {
    expect(contextWords({ used: 21_050, window: 128_000, fresh: false })).toBe(
      `Context: about ${(21_050).toLocaleString(undefined)} of ${(128_000).toLocaleString(undefined)} tokens`,
    );
  });

  it("F-059: is no line at all when the gateway reports no figure, never unavailable", () => {
    expect(contextWords(undefined)).toBeNull();
  });
});
