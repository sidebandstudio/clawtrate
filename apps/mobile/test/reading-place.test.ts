import { describe, expect, it } from "vitest";
import {
  finishesReturn,
  keptPlace,
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
  /** The chat is laid out at the wide width after the narrow one, the reader not at the end. */
  const resized = (contentWidth: number, following = false) =>
    nextReturning(null, { kind: "resized", from: 382, to: 669, contentWidth, following, place });

  it("after a new width, once the content is laid out at it, a row that grows does not move the reader", () => {
    let state = resized(382);
    // Going back: the long message's same quarter, at the new width.
    expect(state).toEqual({ width: 669, contentLaidOut: false });
    expect(returnOffset(state, place, WIDE, 1000)).toBe(240);
    // Content still at the old width does not end the return; at the new width it does.
    state = nextReturning(state, { kind: "content-laid-out", width: 382 });
    expect(finishesReturn(state)).toBe(false);
    state = nextReturning(state, { kind: "content-laid-out", width: 669 });
    expect(finishesReturn(state)).toBe(true);
    state = nextReturning(state, { kind: "settled" });
    expect(state).toBeNull();
    // Then the message being read grows at the same width: the view stays where it is.
    const grown = WIDE.map((row) => (row.key === "bot:2" ? { ...row, height: 320 } : row));
    state = nextReturning(state, { kind: "content-laid-out", width: 669 });
    expect(finishesReturn(state)).toBe(false);
    expect(returnOffset(state, place, grown, 1000)).toBeNull();
    expect(
      nextReturning(state, {
        kind: "resized",
        from: 669,
        to: 669,
        contentWidth: 669,
        following: false,
        place,
      }),
    ).toBeNull();
  });

  it("ends the same way when the content is laid out at the new width before the chat is", () => {
    // The content's layout comes first, while no return is under way: nothing to end yet.
    let state = nextReturning(null, { kind: "content-laid-out", width: 669 });
    expect(state).toBeNull();
    // Then the chat's own layout at that width: both have happened, so the return
    // goes back to the place once and ends when the rows have reported.
    state = resized(669);
    expect(state).toEqual({ width: 669, contentLaidOut: true });
    expect(returnOffset(state, place, WIDE, 1000)).toBe(240);
    expect(finishesReturn(state)).toBe(true);
    expect(nextReturning(state, { kind: "settled" })).toBeNull();
  });

  it("does not end on the frame after the chat's layout alone", () => {
    const state = resized(382);
    expect(finishesReturn(state)).toBe(false);
    expect(nextReturning(state, { kind: "settled" })).toEqual(state);
  });

  it("does not start at the first layout, at the end of the chat, or with no place yet", () => {
    const first = { kind: "resized", from: 0, to: 669, contentWidth: 0, following: false } as const;
    expect(nextReturning(null, { ...first, place })).toBeNull();
    expect(resized(382, true)).toBeNull();
    expect(
      nextReturning(null, {
        kind: "resized",
        from: 382,
        to: 669,
        contentWidth: 382,
        following: false,
        place: null,
      }),
    ).toBeNull();
  });

  it("ends when the reader scrolls, before the content is laid out", () => {
    const state = nextReturning(resized(382), { kind: "reader-scrolled" });
    expect(state).toBeNull();
    expect(returnOffset(state, place, WIDE, 1000)).toBeNull();
  });

  it("follows a second change of width, which a late layout at the first one does not end", () => {
    let state = nextReturning(resized(382), {
      kind: "resized",
      from: 669,
      to: 800,
      contentWidth: 382,
      following: false,
      place,
    });
    expect(state).toEqual({ width: 800, contentLaidOut: false });
    state = nextReturning(state, { kind: "content-laid-out", width: 669 });
    expect(finishesReturn(state)).toBe(false);
    state = nextReturning(state, { kind: "content-laid-out", width: 800 });
    expect(nextReturning(state, { kind: "settled" })).toBeNull();
  });
});

describe("keeping the reader's place up to date", () => {
  it("reads the place again when the message being read grows at the same width, so a later width goes back to the right share of it", () => {
    // A quarter of the way into the long message.
    const saved = readingPlace(NARROW, 310)!;
    expect(saved).toEqual({ key: "bot:2", into: 100, height: 400 });
    // The message grows to twice its height while the view stays at the same offset.
    const grown = NARROW.map((row) =>
      row.key === "bot:2"
        ? { ...row, height: 800 }
        : row.key === "user:3"
          ? { ...row, y: 1020 }
          : row,
    );
    const kept = keptPlace(null, saved, grown, 310)!;
    expect(kept).toEqual({ key: "bot:2", into: 100, height: 800 });
    // Then the width changes: an eighth of the way in, not the stale quarter.
    expect(offsetFor(kept, WIDE, 1000)).toBe(190 + 25);
    expect(offsetFor(saved, WIDE, 1000)).toBe(190 + 50);
  });

  it("keeps the place a return goes back to while the return is under way", () => {
    const saved = readingPlace(NARROW, 310)!;
    expect(keptPlace({ width: 669, contentLaidOut: false }, saved, WIDE, 500)).toBe(saved);
  });
});
