// openClawAtLeast (gateway-version.ts): the gateway's reported version against a release.

import { describe, expect, it } from "vitest";
import { openClawAtLeast } from "../src/gateway-version.ts";

describe("openClawAtLeast", () => {
  it("compares year, then month, then patch", () => {
    expect(openClawAtLeast("2026.10.10", 2026, 10, 10)).toBe(true);
    expect(openClawAtLeast("2026.11.10", 2026, 10, 10)).toBe(true);
    expect(openClawAtLeast("2027.1.1", 2026, 10, 10)).toBe(true);
    expect(openClawAtLeast("2026.10.9", 2026, 10, 10)).toBe(false);
    expect(openClawAtLeast("2026.10.6", 2026, 10, 10)).toBe(false);
    expect(openClawAtLeast("2025.12.31", 2026, 10, 10)).toBe(false);
    expect(openClawAtLeast("2026.9.33", 2026, 10)).toBe(false);
    expect(openClawAtLeast("2026.10.0", 2026, 10)).toBe(true);
  });

  it("reads a leading v and a prerelease as the release they belong to", () => {
    expect(openClawAtLeast("v2026.10.10", 2026, 10, 10)).toBe(true);
    expect(openClawAtLeast("2026.10.10-beta.1", 2026, 10, 10)).toBe(true);
    expect(openClawAtLeast("2026.10.9-beta.3", 2026, 10, 10)).toBe(false);
  });

  it("counts a missing or malformed version as older", () => {
    for (const version of [null, undefined, "", "dev", "2026.10", "2026.10.1000", "x2026.11.10"])
      expect(openClawAtLeast(version, 2026, 10, 10), String(version)).toBe(false);
  });
});
