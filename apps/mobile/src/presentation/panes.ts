// Where the iPhone app puts its screens (docs/decisions.md, The iOS app;
// visual-language.md, section 12). Every iPhone, and iPhone Duo folded, shows
// one screen at a time. iPhone Duo unfolded, its inner display, shows the list
// (Home or a bot's tasks) and the chat side by side. Pure, so the unit tests
// cover each shape of window.

/** A part of the window UIKit reserves: the fold is a division, the camera block an occlusion. */
export type Region = {
  kind: "division" | "occlusion";
  x: number;
  y: number;
  width: number;
  height: number;
};

/** What the app's native layout view reports (apps/mobile/modules/clawtrate-layout), in points. */
export type WindowShape = {
  width: number;
  height: number;
  /** The device folds: iPhone Duo, on either display. */
  hasHinge: boolean;
  sizeClass: "compact" | "regular";
  /** The edge where the system keeps a vertical bar, if it keeps one. */
  verticalBarEdge: "none" | "left" | "right";
  safeArea: { top: number; bottom: number; left: number; right: number };
  regions: Region[];
};

/** One pane's place across the window: from `x`, `width` points wide, the window's full height. */
export type Pane = { x: number; width: number };

export type Panes =
  | { kind: "stack" }
  | {
      kind: "split";
      list: Pane;
      chat: Pane;
      /** The panes meet at the fold, which lies between them; otherwise they share an edge. */
      atFold: boolean;
    };

/** The narrowest the list's content may be: a bot row's avatar, name and time. */
export const LIST_MIN = 280;
/** The widest the list column grows beside the chat. */
export const LIST_MAX = 360;
/** The narrowest the chat's content may be: an iPhone SE's width, less its margins. */
export const CHAT_MIN = 320;
/** The list column's share of the window when there is no fold to split at. */
const LIST_SHARE = 0.4;

const STACK: Panes = { kind: "stack" };

/**
 * A fold that runs from the top of the window to the bottom, inside it: the
 * inner display held so its fold is upright. A fold across the window (the
 * inner display turned the other way) is not one.
 */
export function uprightFold(shape: WindowShape): Region | null {
  const folds = shape.regions.filter(
    (r) =>
      r.kind === "division" &&
      r.height >= shape.height / 2 &&
      r.height > r.width &&
      r.x > 0 &&
      r.x + r.width < shape.width,
  );
  const middle = shape.width / 2;
  const distance = (r: Region) => Math.abs(r.x + r.width / 2 - middle);
  return folds.sort((a, b) => distance(a) - distance(b))[0] ?? null;
}

/**
 * The panes for a window. No shape yet, no hinge, or compact width (iPhone
 * Duo folded): the phone's stack, one screen at a time. Unfolded, with an
 * upright fold: the list fills the side before it and the chat the side after
 * it, so neither crosses it. Unfolded with no upright fold: the list takes a
 * column of 280 to 360 points, about two fifths of the window, beside the
 * chat. Either way, a pane that would leave its content less room than its
 * minimum gives the stack instead. The safe area is each screen's own to keep
 * clear; the panes only leave the room for it.
 */
export function panes(shape: WindowShape | null): Panes {
  if (!shape || !shape.hasHinge || shape.sizeClass !== "regular") return STACK;
  const { width, safeArea } = shape;
  const fold = uprightFold(shape);
  const list = fold
    ? fold.x
    : Math.min(LIST_MAX, Math.max(LIST_MIN, Math.round(width * LIST_SHARE))) + safeArea.left;
  const chatX = fold ? fold.x + fold.width : list;
  if (list - safeArea.left < LIST_MIN) return STACK;
  if (width - chatX - safeArea.right < CHAT_MIN) return STACK;
  return {
    kind: "split",
    list: { x: 0, width: list },
    chat: { x: chatX, width: width - chatX },
    atFold: fold !== null,
  };
}
