import { describe, expect, it } from "vitest";
import { isStopNow } from "../src/stop-words.ts";

describe("typed stop requests", () => {
  it("F-097: Stop now, in any case and with trailing punctuation, is a request to stop; other words are not", () => {
    for (const text of [
      "Stop now",
      "stop now.",
      "  STOP   NOW!! ",
      "Please stop now",
      "stop now, please",
    ]) {
      expect(isStopNow(text), text).toBe(true);
    }
    for (const text of [
      "Stop now and summarise",
      "don't stop now",
      "stop",
      "now",
      "",
      "Stop nowhere",
    ]) {
      expect(isStopNow(text), text).toBe(false);
    }
  });
});
