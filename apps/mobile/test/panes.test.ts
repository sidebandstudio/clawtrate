import { describe, expect, it } from "vitest";
import { HOME, panesFor, type Route } from "../src/navigation.ts";
import {
  CHAT_MIN,
  LIST_MIN,
  panes,
  uprightFold,
  type Region,
  type WindowShape,
} from "../src/presentation/panes.ts";

const NONE = { top: 0, bottom: 0, left: 0, right: 0 };

function shape(overrides: Partial<WindowShape>): WindowShape {
  return {
    width: 402,
    height: 874,
    hasHinge: false,
    sizeClass: "compact",
    verticalBarEdge: "none",
    safeArea: { top: 62, bottom: 34, left: 0, right: 0 },
    regions: [],
    ...overrides,
  };
}

/** The fold of the inner display held so it runs from top to bottom. */
const UPRIGHT_FOLD: Region = { kind: "division", x: 470, y: 0, width: 11, height: 669 };
/** The camera block in a top corner. */
const CAMERA: Region = { kind: "occlusion", x: 0, y: 0, width: 92, height: 38 };

const UNFOLDED_LANDSCAPE = shape({
  width: 951,
  height: 669,
  hasHinge: true,
  sizeClass: "regular",
  safeArea: { top: 24, bottom: 20, left: 0, right: 0 },
  regions: [UPRIGHT_FOLD, CAMERA],
});

const UNFOLDED_PORTRAIT = shape({
  width: 669,
  height: 951,
  hasHinge: true,
  sizeClass: "regular",
  safeArea: { top: 38, bottom: 20, left: 0, right: 0 },
  regions: [CAMERA],
});

describe("the iPhone app's panes", () => {
  it("are the phone's stack before the window's shape is known", () => {
    expect(panes(null)).toEqual({ kind: "stack" });
  });

  it("are the phone's stack on an iPhone without a hinge, at any size", () => {
    expect(panes(shape({}))).toEqual({ kind: "stack" });
    expect(panes(shape({ width: 440, height: 956 }))).toEqual({ kind: "stack" });
    // Even a regular-width window: only a hinged device splits.
    expect(panes(shape({ width: 956, height: 440, sizeClass: "regular" }))).toEqual({
      kind: "stack",
    });
  });

  it("are the phone's stack on iPhone Duo folded, whose outer display is compact", () => {
    const folded = shape({ width: 382, height: 644, hasHinge: true, sizeClass: "compact" });
    expect(panes(folded)).toEqual({ kind: "stack" });
    expect(panes({ ...folded, width: 644, height: 382 })).toEqual({ kind: "stack" });
  });

  it("put the list on the side before an upright fold and the chat after it, so neither crosses it", () => {
    expect(panes(UNFOLDED_LANDSCAPE)).toEqual({
      kind: "split",
      list: { x: 0, width: 470 },
      chat: { x: 481, width: 470 },
      atFold: true,
    });
  });

  it("split at the fold whichever side the camera block and the system's side bar are on", () => {
    const barLeft = {
      ...UNFOLDED_LANDSCAPE,
      verticalBarEdge: "left" as const,
      safeArea: { top: 24, bottom: 20, left: 64, right: 0 },
    };
    expect(panes(barLeft)).toMatchObject({
      list: { x: 0, width: 470 },
      chat: { x: 481, width: 470 },
    });
    const barRight = {
      ...UNFOLDED_LANDSCAPE,
      verticalBarEdge: "right" as const,
      safeArea: { top: 24, bottom: 20, left: 0, right: 64 },
    };
    expect(panes(barRight)).toMatchObject({
      list: { x: 0, width: 470 },
      chat: { x: 481, width: 470 },
    });
  });

  it("give the list a column beside the chat when the fold runs across the window", () => {
    const across: Region = { kind: "division", x: 0, y: 470, width: 669, height: 11 };
    for (const portrait of [UNFOLDED_PORTRAIT, { ...UNFOLDED_PORTRAIT, regions: [across] }]) {
      // Two fifths of 669 is under the list's minimum, so the list takes its minimum.
      expect(panes(portrait)).toEqual({
        kind: "split",
        list: { x: 0, width: LIST_MIN },
        chat: { x: LIST_MIN, width: 669 - LIST_MIN },
        atFold: false,
      });
    }
  });

  it("widen the list column with the window, to at most 360 points, leaving room for a left safe area", () => {
    const wide = { ...UNFOLDED_PORTRAIT, width: 1000, regions: [] };
    expect(panes(wide)).toMatchObject({ list: { x: 0, width: 360 }, chat: { x: 360 } });
    const inset = { ...wide, safeArea: { ...NONE, left: 40 } };
    expect(panes(inset)).toMatchObject({ list: { x: 0, width: 400 }, chat: { x: 400 } });
  });

  it("are the stack when a pane would leave its content less than its minimum", () => {
    // A narrow regular-width window: the chat would be under its minimum.
    const narrow = { ...UNFOLDED_PORTRAIT, width: LIST_MIN + CHAT_MIN - 1 };
    expect(panes(narrow)).toEqual({ kind: "stack" });
    // A fold too near one edge for the list's content beside the system's side bar.
    const nearEdge = {
      ...UNFOLDED_LANDSCAPE,
      safeArea: { ...NONE, left: 64 },
      regions: [{ ...UPRIGHT_FOLD, x: 300 }],
    };
    expect(panes(nearEdge)).toEqual({ kind: "stack" });
    // A fold too near the other edge for the chat beside it.
    const farEdge = { ...UNFOLDED_LANDSCAPE, regions: [{ ...UPRIGHT_FOLD, x: 640 }] };
    expect(panes(farEdge)).toEqual({ kind: "stack" });
  });
});

describe("an upright fold", () => {
  it("is a division that runs most of the window's height, inside it", () => {
    expect(uprightFold(UNFOLDED_LANDSCAPE)).toEqual(UPRIGHT_FOLD);
    // A short division, one across the window, one on its edge and an occlusion are not.
    const others: Region[] = [
      { kind: "division", x: 470, y: 0, width: 11, height: 200 },
      { kind: "division", x: 0, y: 330, width: 951, height: 11 },
      { kind: "division", x: 0, y: 0, width: 11, height: 669 },
      { kind: "occlusion", x: 470, y: 0, width: 11, height: 669 },
    ];
    expect(uprightFold({ ...UNFOLDED_LANDSCAPE, regions: others })).toBeNull();
  });

  it("is the one nearest the middle when there are two", () => {
    const off: Region = { ...UPRIGHT_FOLD, x: 200 };
    expect(uprightFold({ ...UNFOLDED_LANDSCAPE, regions: [off, UPRIGHT_FOLD] })).toEqual(
      UPRIGHT_FOLD,
    );
  });
});

describe("what a route shows", () => {
  const bot: Route = { name: "bot", botId: "otto" };
  const task: Route = { name: "task", botId: "otto", key: "agent:otto:disk" };

  it("one screen at a time: Home, the bot's tasks, or the task's chat", () => {
    expect(panesFor(HOME, false)).toEqual({ list: "home", chat: null });
    expect(panesFor(bot, false)).toEqual({ list: "bot", chat: null });
    expect(panesFor(task, false)).toEqual({ list: null, chat: "task" });
  });

  it("side by side: the list beside the chat, which says when no task is open", () => {
    expect(panesFor(HOME, true)).toEqual({ list: "home", chat: "none" });
    expect(panesFor(bot, true)).toEqual({ list: "bot", chat: "none" });
    expect(panesFor(task, true)).toEqual({ list: "bot", chat: "task" });
  });

  it("keeps the open task's chat when the window folds or unfolds, from the same route", () => {
    // Folding shows the chat alone, with Back to the bot's tasks; unfolding puts it beside them.
    expect(panesFor(task, false).chat).toBe("task");
    expect(panesFor(task, true).chat).toBe("task");
    expect(panesFor(task, true).list).toBe("bot");
  });
});
