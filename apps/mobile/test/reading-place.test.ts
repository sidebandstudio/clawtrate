import { describe, expect, it } from "vitest";
import {
  finishesReturn,
  nextReturning,
  offsetFor,
  readingPlace,
  returnOffset,
  type RowBox,
} from "../src/presentation/reading-place.ts";

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
    expect(
      offsetFor(
        place,
        WIDE.filter((row) => row.key !== "bot:2"),
        1000,
      ),
    ).toBeNull();
  });
});

describe("going back to the reader's place", () => {
  const place = readingPlace(NARROW, 310)!;
  /** The chat changes from the narrow width to the wide one, the reader not at the end. */
  const widened = (following = false) =>
    nextReturning(null, { kind: "resized", from: 382, to: 669, following, place });

  it("after a new width, once the content is laid out at it, a row that grows does not move the reader", () => {
    let state = widened();
    // Going back: the long message's same quarter, at the new width.
    expect(state).toBe(669);
    expect(returnOffset(state, place, WIDE, 1000)).toBe(240);
    // Content still at the old width does not end the return; at the new width it does.
    expect(finishesReturn(state, 382)).toBe(false);
    expect(finishesReturn(state, 669)).toBe(true);
    state = nextReturning(state, { kind: "laid-out", width: 669 });
    expect(state).toBeNull();
    // Then the message being read grows at the same width: the view stays where it is.
    const grown = WIDE.map((row) => (row.key === "bot:2" ? { ...row, height: 320 } : row));
    expect(finishesReturn(state, 669)).toBe(false);
    expect(returnOffset(state, place, grown, 1000)).toBeNull();
    expect(
      nextReturning(state, { kind: "resized", from: 669, to: 669, following: false, place }),
    ).toBeNull();
  });

  it("does not start at the first layout, at the end of the chat, or with no place yet", () => {
    expect(
      nextReturning(null, { kind: "resized", from: 0, to: 669, following: false, place }),
    ).toBeNull();
    expect(widened(true)).toBeNull();
    expect(
      nextReturning(null, { kind: "resized", from: 382, to: 669, following: false, place: null }),
    ).toBeNull();
  });

  it("ends when the reader scrolls, before the content is laid out", () => {
    const state = nextReturning(widened(), { kind: "reader-scrolled" });
    expect(state).toBeNull();
    expect(returnOffset(state, place, WIDE, 1000)).toBeNull();
  });

  it("follows a second change of width, which the first one's layout does not end", () => {
    let state = nextReturning(widened(), {
      kind: "resized",
      from: 669,
      to: 382,
      following: false,
      place,
    });
    expect(state).toBe(382);
    state = nextReturning(state, { kind: "laid-out", width: 669 });
    expect(state).toBe(382);
    expect(nextReturning(state, { kind: "laid-out", width: 382 })).toBeNull();
  });
});
