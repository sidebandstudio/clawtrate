// The sidebar's width (#792): dragged by its edge, or moved with the keyboard, between a rail of
// pictures only and a widest width, and kept on this device. The widths are the ones
// docs/design/bot-opens-main.md section 2 names: the rail, the narrowest with names, the default.

import { readPreference, writePreference } from "./preferences.ts";

/** The rail of pictures only. */
export const RAIL_PICTURES = 72;
/** The narrowest sidebar that still shows names. */
export const RAIL_NARROWEST = 208;
/** The default width (tokens.css `--rail-width`). */
export const RAIL_DEFAULT = 280;
/** The default below a 900 px window (app.css, the compact layout). */
export const RAIL_DEFAULT_COMPACT = 248;
/** The widest the sidebar goes. */
export const RAIL_WIDEST = 400;
/** What the conversation keeps beside the sidebar (tokens.css `--conversation-min`). */
export const CONVERSATION_MIN = 440;
/** One arrow key's move; with Shift, four of them. */
export const RAIL_STEP = 8;

const KEY = "railWidth";

/**
 * A width the sidebar can take, from where the pointer is: under halfway between the rail and the
 * narrowest width with names it is the rail; above it, at least that narrowest width. There is no
 * width in between, where names would be cut to a letter or two.
 */
export function railWidthAt(x: number): number {
  if (!Number.isFinite(x) || x < (RAIL_PICTURES + RAIL_NARROWEST) / 2) return RAIL_PICTURES;
  return Math.min(RAIL_WIDEST, Math.max(RAIL_NARROWEST, Math.round(x)));
}

/** The width shown in a window this wide: the conversation keeps its room; the rail always fits. */
export function railWidthShown(width: number, windowWidth: number | null): number {
  if (width === RAIL_PICTURES || windowWidth === null) return width;
  return Math.max(RAIL_NARROWEST, Math.min(width, windowWidth - CONVERSATION_MIN));
}

/** The default for a window this wide, when the person has set none. */
export function railDefault(windowWidth: number | null): number {
  return windowWidth !== null && windowWidth < 900 ? RAIL_DEFAULT_COMPACT : RAIL_DEFAULT;
}

/** The width a key moves the edge to, or null for a key the edge doesn't take. */
export function railWidthAfterKey(width: number, key: string, shift: boolean): number | null {
  const step = shift ? RAIL_STEP * 4 : RAIL_STEP;
  switch (key) {
    case "Home":
      return RAIL_PICTURES;
    case "End":
      return RAIL_WIDEST;
    case "ArrowLeft":
      return width <= RAIL_NARROWEST ? RAIL_PICTURES : Math.max(RAIL_NARROWEST, width - step);
    case "ArrowRight":
      return width === RAIL_PICTURES ? RAIL_NARROWEST : Math.min(RAIL_WIDEST, width + step);
    default:
      return null;
  }
}

/** What a screen reader hears for the edge's value. */
export function railWidthWords(width: number): string {
  return width === RAIL_PICTURES ? "Pictures only" : `${width} pixels`;
}

/** The width this device keeps, or null when none is kept or what is kept isn't a width. */
export function readRailWidth(): number | null {
  const stored = readPreference(KEY);
  if (stored === null || !/^\d{2,3}$/.test(stored)) return null;
  const width = Number(stored);
  return width === RAIL_PICTURES || (width >= RAIL_NARROWEST && width <= RAIL_WIDEST)
    ? width
    : null;
}

/** Keep a width on this device; null goes back to the default. */
export function writeRailWidth(width: number | null): void {
  writePreference(KEY, width === null ? null : String(width));
}
