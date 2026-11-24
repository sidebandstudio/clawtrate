// Where the reader is in a chat, kept while the chat changes width: folding or
// unfolding iPhone Duo, or turning its inner display, rewraps every message,
// so the same scroll offset no longer shows the same words. The place is the
// row at the top of the view and how far into it the view starts; after the
// rows move, the view goes back to that row and that share of it. Pure, so the
// unit tests cover it. So does when the return ends: once the content has
// been laid out at the new width, so that later growth does not move the reader.

/** A row of the chat as laid out: its key, its top and its height, in the scroll content's points. */
export type RowBox = { key: string; y: number; height: number };

/**
 * The reader's place: the row at the top of the view, and how far below that
 * row's top the view starts. `into` is negative when the view starts in the
 * space above the row.
 */
export type ReadingPlace = { key: string; into: number; height: number };

/** The place for a scroll offset, from the rows in order; null at the very start or with no rows. */
export function readingPlace(rows: readonly RowBox[], scrollY: number): ReadingPlace | null {
  if (scrollY <= 0) return null;
  const row = rows.find((r) => r.y + r.height > scrollY);
  return row ? { key: row.key, into: scrollY - row.y, height: row.height } : null;
}

/**
 * The scroll offset that shows a place again once the rows have moved: the
 * same share of its row when the view started inside it, the same distance
 * above it otherwise, within 0 and the furthest the view can scroll. Null when
 * the row is gone.
 */
export function offsetFor(
  place: ReadingPlace,
  rows: readonly RowBox[],
  maxScroll: number,
): number | null {
  const row = rows.find((r) => r.key === place.key);
  if (!row) return null;
  const into =
    place.into >= 0 && place.height > 0 ? (place.into / place.height) * row.height : place.into;
  return Math.min(Math.max(0, maxScroll), Math.max(0, row.y + into));
}

/**
 * While the chat goes back to the reader's place after its width changed, the
 * width it goes back at; null otherwise, and then nothing moves the view but
 * the reader.
 */
export type Returning = number | null;

export type ReturnEvent =
  /** The chat was laid out `to` points wide, after `from` (0 before its first layout). */
  | { kind: "resized"; from: number; to: number; following: boolean; place: ReadingPlace | null }
  /** The frame after the content was laid out `width` points wide: its rows have reported. */
  | { kind: "laid-out"; width: number }
  /** The reader scrolled, or chose Jump to latest. */
  | { kind: "reader-scrolled" };

const sameWidth = (a: number, b: number) => Math.abs(a - b) < 0.5;

/**
 * A new width starts a return to the reader's place, unless the reader follows
 * the end or has no place yet. The return ends once the content has been laid
 * out at that width, or when the reader scrolls; a later change at the same
 * width leaves the view alone.
 */
export function nextReturning(state: Returning, event: ReturnEvent): Returning {
  switch (event.kind) {
    case "resized":
      if (event.from === 0 || sameWidth(event.from, event.to)) return state;
      return !event.following && event.place !== null ? event.to : null;
    case "laid-out":
      return state !== null && sameWidth(event.width, state) ? null : state;
    case "reader-scrolled":
      return null;
  }
}

/** Whether content laid out at this width finishes the return, once its rows have reported. */
export function finishesReturn(state: Returning, contentWidth: number): boolean {
  return state !== null && sameWidth(contentWidth, state);
}

/** Where the view goes after a layout: back to the place while returning, else nowhere (null). */
export function returnOffset(
  state: Returning,
  place: ReadingPlace | null,
  rows: readonly RowBox[],
  maxScroll: number,
): number | null {
  return state === null || place === null ? null : offsetFor(place, rows, maxScroll);
}
