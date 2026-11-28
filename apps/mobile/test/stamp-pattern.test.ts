// The stamp F-063 expects before a seeded message (#640): built from the message's stored time, so
// it matches what the app shows when the seed wrote it before the device's midnight and the check
// opens it after.

import { afterEach, describe, expect, it, vi } from "vitest";
import { stampTime } from "../../../packages/ui/src/format.ts";
import { stampPattern } from "../simulator/harness.ts";

// Maestro matches a whole text.
const matches = (pattern: string, text: string) => new RegExp(`^(?:${pattern})$`).test(text);
const storedAt = new Date(2026, 10, 26, 23, 53).getTime();

describe("stampPattern", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches the app's Yesterday stamp when the check runs after midnight", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 27, 0, 18) });
    const shown = stampTime(storedAt, Date.now());
    expect(shown).toMatch(/^Yesterday /);
    expect(matches(stampPattern(storedAt), shown)).toBe(true);
    // What the check used to expect.
    expect(matches("Today \\d{1,2}:\\d{2}.(AM|PM)", shown)).toBe(false);
  });

  it("matches the app's Today stamp when the check runs before midnight", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 26, 23, 58) });
    const shown = stampTime(storedAt, Date.now());
    expect(shown).toMatch(/^Today /);
    expect(matches(stampPattern(storedAt), shown)).toBe(true);
  });

  it("does not match another minute's stamp", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 27, 0, 18) });
    expect(matches(stampPattern(storedAt), stampTime(storedAt + 60_000, Date.now()))).toBe(false);
  });
});
