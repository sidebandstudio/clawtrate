// The stamp the iPhone checks expect above a message (#640): its exact stored time under "Today"
// or "Yesterday". A check can straddle the device's midnight, and the app redraws its stamps only
// every 30 s, so near midnight either day word can be on screen. `stampTime`'s own tests in
// packages/ui pin which day word is right.

import { describe, expect, it } from "vitest";
import { stampTime } from "../../../packages/ui/src/format.ts";
import { stampPattern } from "../simulator/harness.ts";

// Maestro matches a whole text.
const matches = (pattern: string, text: string) => new RegExp(`^(?:${pattern})$`).test(text);
const storedAt = new Date(2026, 10, 26, 23, 53).getTime();
const beforeMidnight = new Date(2026, 10, 26, 23, 59, 45).getTime();
const afterMidnight = new Date(2026, 10, 27, 0, 18).getTime();

describe("stampPattern", () => {
  it("matches the app's Yesterday stamp, seen after midnight", () => {
    const shown = stampTime(storedAt, afterMidnight);
    expect(shown).toMatch(/^Yesterday /);
    expect(matches(stampPattern(storedAt), shown)).toBe(true);
  });

  it("matches the app's Today stamp, drawn before midnight and still shown after it", () => {
    const shown = stampTime(storedAt, beforeMidnight);
    expect(shown).toMatch(/^Today /);
    expect(matches(stampPattern(storedAt), shown)).toBe(true);
  });

  it("does not match another minute's stamp, on either day", () => {
    const pattern = stampPattern(storedAt);
    expect(matches(pattern, stampTime(storedAt + 60_000, beforeMidnight))).toBe(false);
    expect(matches(pattern, stampTime(storedAt - 60_000, afterMidnight))).toBe(false);
  });

  it("does not match the stamp of a message from two days before", () => {
    const shown = stampTime(storedAt, storedAt + 2 * 86_400_000);
    expect(shown).not.toMatch(/^(Today|Yesterday) /);
    expect(matches(stampPattern(storedAt), shown)).toBe(false);
  });
});
