import { describe, expect, it } from "vitest";
import { applyUnreadBadge, dotBitmap, parseBadgeCount, type BadgeHost } from "../src/main/badge.ts";

function host(platform: string) {
  const calls: unknown[][] = [];
  const target: BadgeHost = {
    platform,
    setBadgeCount: (count) => calls.push(["count", count]),
    setOverlay: (icon, description) => calls.push(["overlay", icon, description]),
  };
  return { target, calls };
}

describe("F-023: the dock or taskbar badge", () => {
  it("F-023: shows the unread count on the dock (macOS and Linux) and clears it at zero", () => {
    for (const platform of ["darwin", "linux"]) {
      const { target, calls } = host(platform);
      applyUnreadBadge(target, 3);
      applyUnreadBadge(target, 0);
      expect(calls).toEqual([
        ["count", 3],
        ["count", 0],
      ]);
    }
  });

  it("F-023: shows an overlay dot on the Windows taskbar while anything is unread", () => {
    const { target, calls } = host("win32");
    applyUnreadBadge(target, 2);
    applyUnreadBadge(target, 0);
    expect(calls).toEqual([
      ["overlay", "dot", "2 unread"],
      ["overlay", null, ""],
    ]);
  });

  it("F-023: accepts only a whole number of unread tasks from the renderer", () => {
    expect(parseBadgeCount(4)).toBe(4);
    expect(parseBadgeCount(0)).toBe(0);
    for (const raw of [-1, 1.5, "3", null, undefined, 10_000, Number.NaN]) {
      expect(parseBadgeCount(raw)).toBe(null);
    }
  });

  it("F-023: draws the overlay as an opaque dot with transparent corners", () => {
    const pixels = dotBitmap(16, [10, 110, 92]);
    const at = (x: number, y: number) => [...pixels.slice((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
    expect(at(8, 8)).toEqual([92, 110, 10, 255]);
    expect(at(0, 0)[3]).toBe(0);
  });
});
