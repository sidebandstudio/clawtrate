// Where the reader is in a chat, kept while the chat changes width: folding or
// unfolding iPhone Duo, or turning its inner display, rewraps every message,
// so the same scroll offset no longer shows the same words. The place is the
// row at the top of the view and how far into it the view starts; after the
// rows move, the view goes back to that row and that share of it. Pure, so the
// unit tests cover it.

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
