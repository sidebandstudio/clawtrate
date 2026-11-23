import { describe, expect, it } from "vitest";
import { offsetFor, readingPlace, type RowBox } from "../src/presentation/reading-place.ts";

/** A chat at phone width: the title, then three messages with gaps between them. */
const NARROW: RowBox[] = [
  { key: "task-line", y: 98, height: 24 },
  { key: "user:1", y: 130, height: 60 },
  { key: "bot:2", y: 210, height: 400 },
  { key: "user:3", y: 620, height: 60 },
];
/** The same chat beside the list or turned: wider, so each message takes fewer lines. */
const WIDE: RowBox[] = [
  { key: "task-line", y: 98, height: 24 },
  { key: "user:1", y: 130, height: 40 },
  { key: "bot:2", y: 190, height: 200 },
  { key: "user:3", y: 400, height: 40 },
];

describe("a chat's reading place", () => {
  it("is none at the very start, where the chat opens", () => {
    expect(readingPlace(NARROW, 0)).toBeNull();
    expect(readingPlace([], 120)).toBeNull();
  });

  it("is the row at the top of the view and how far into it the view starts", () => {
    expect(readingPlace(NARROW, 310)).toEqual({ key: "bot:2", into: 100, height: 400 });
  });

  it("is the row below when the view starts in the space between two rows", () => {
    expect(readingPlace(NARROW, 200)).toEqual({ key: "bot:2", into: -10, height: 400 });
  });

  it("comes back to the same share of its row after the rows rewrap", () => {
    const place = readingPlace(NARROW, 310)!;
    // A quarter of the way into the long message, before and after.
    expect(offsetFor(place, WIDE, 1000)).toBe(190 + 50);
  });

  it("comes back to the same distance above its row from the space between rows", () => {
    const place = readingPlace(NARROW, 200)!;
    expect(offsetFor(place, WIDE, 1000)).toBe(180);
  });

  it("stays within what the view can scroll", () => {
    const place = readingPlace(NARROW, 650)!;
    expect(offsetFor(place, WIDE, 300)).toBe(300);
    expect(offsetFor(place, WIDE, -20)).toBe(0);
  });

  it("is lost when its row is gone", () => {
    const place = readingPlace(NARROW, 310)!;
    expect(offsetFor(place, WIDE.filter((row) => row.key !== "bot:2"), 1000)).toBeNull();
  });
});
