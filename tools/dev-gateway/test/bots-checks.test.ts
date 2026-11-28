// The bots checks' own helpers that need no gateway.
import { describe, expect, it } from "vitest";
import { holds, restorePatch } from "../src/bots-checks.ts";

describe("putting a setting back after a check", () => {
  it("removes a key the check added, and an absent setting", () => {
    // tools.codeMode was {} before the check set { enabled: true }.
    expect(restorePatch({}, { enabled: true })).toEqual({ enabled: null });
    expect(restorePatch(null, { enabled: true })).toBeNull();
    expect(restorePatch(undefined, true)).toBeNull();
  });

  it("gives a changed key its old value, deep, and leaves keys the check didn't touch", () => {
    expect(restorePatch({ enabled: false, limit: 3 }, { enabled: true })).toEqual({
      enabled: false,
    });
    expect(restorePatch({ a: { b: 1 } }, { a: { b: 2, c: 3 } })).toEqual({ a: { b: 1, c: null } });
    expect(restorePatch(false, true)).toBe(false);
    expect(restorePatch([1], [2])).toEqual([1]);
  });
});

describe("waiting for a patched config", () => {
  it("takes only a config that holds what the patch set, not a later write's", () => {
    const patch = { tools: { codeMode: { enabled: true } }, plugins: { x: null } };
    expect(holds({ tools: { codeMode: { enabled: true, other: 1 } }, plugins: {} }, patch)).toBe(
      true,
    );
    // Another admin's later write turned it off again, or left the removed key there.
    expect(holds({ tools: { codeMode: { enabled: false } }, plugins: {} }, patch)).toBe(false);
    expect(holds({ tools: { codeMode: { enabled: true } }, plugins: { x: 1 } }, patch)).toBe(false);
  });
});
