// The sidebar's width (#792): its limits, the snap to the rail of pictures, the keyboard's
// moves, the fit to the window, and what this device keeps.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RAIL_DEFAULT,
  RAIL_DEFAULT_COMPACT,
  RAIL_NARROWEST,
  RAIL_PICTURES,
  RAIL_WIDEST,
  railDefault,
  railWidthAfterKey,
  railWidthAt,
  railWidthShown,
  railWidthWords,
  readRailWidth,
  writeRailWidth,
} from "../src/rail-width.ts";

describe("the sidebar's width", () => {
  it("#792: is the rail of pictures, or a width with names between the narrowest and the widest, and nothing between the two", () => {
    expect([RAIL_PICTURES, RAIL_NARROWEST, RAIL_DEFAULT, RAIL_WIDEST]).toEqual([72, 208, 280, 400]);
    expect(railWidthAt(0)).toBe(72);
    expect(railWidthAt(-50)).toBe(72);
    expect(railWidthAt(Number.NaN)).toBe(72);
    // Under halfway between the rail and the narrowest width with names: the rail.
    expect(railWidthAt(139)).toBe(72);
    expect(railWidthAt(140)).toBe(208);
    expect(railWidthAt(190)).toBe(208);
    expect(railWidthAt(208)).toBe(208);
    expect(railWidthAt(311.6)).toBe(312);
    expect(railWidthAt(400)).toBe(400);
    expect(railWidthAt(900)).toBe(400);
  });

  it("#792: leaves the conversation its 440 px, and the rail always fits", () => {
    expect(railWidthShown(400, 1440)).toBe(400);
    expect(railWidthShown(400, 800)).toBe(360);
    expect(railWidthShown(300, 688)).toBe(248);
    expect(railWidthShown(RAIL_PICTURES, 688)).toBe(72);
    expect(railWidthShown(280, null)).toBe(280);
  });

  it("#792: defaults to 280 px, and to 248 px in a window under 900 px", () => {
    expect(railDefault(1440)).toBe(RAIL_DEFAULT);
    expect(railDefault(900)).toBe(RAIL_DEFAULT);
    expect(railDefault(899)).toBe(RAIL_DEFAULT_COMPACT);
    expect(railDefault(null)).toBe(RAIL_DEFAULT);
  });

  it("#792: arrows move it 8 px (32 with Shift) and step over the gap; Home and End go to the limits", () => {
    expect(railWidthAfterKey(280, "ArrowLeft", false)).toBe(272);
    expect(railWidthAfterKey(280, "ArrowRight", false)).toBe(288);
    expect(railWidthAfterKey(280, "ArrowLeft", true)).toBe(248);
    expect(railWidthAfterKey(212, "ArrowLeft", false)).toBe(208);
    expect(railWidthAfterKey(208, "ArrowLeft", false)).toBe(72);
    expect(railWidthAfterKey(72, "ArrowLeft", false)).toBe(72);
    expect(railWidthAfterKey(72, "ArrowRight", false)).toBe(208);
    expect(railWidthAfterKey(396, "ArrowRight", false)).toBe(400);
    expect(railWidthAfterKey(280, "Home", false)).toBe(72);
    expect(railWidthAfterKey(280, "End", false)).toBe(400);
    expect(railWidthAfterKey(280, "ArrowUp", false)).toBeNull();
    expect(railWidthAfterKey(280, "a", false)).toBeNull();
  });

  it("#792: is announced in words", () => {
    expect(railWidthWords(72)).toBe("Pictures only");
    expect(railWidthWords(280)).toBe("280 pixels");
  });
});

describe("the width this device keeps", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    globalThis.localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    } as Storage;
  });
  afterEach(() => {
    // @ts-expect-error -- the test's own stand-in, removed again
    delete globalThis.localStorage;
  });

  it("#792: is kept, read back, and forgotten for the default", () => {
    expect(readRailWidth()).toBeNull();
    writeRailWidth(312);
    expect(store.get("clawtrate.railWidth")).toBe("312");
    expect(readRailWidth()).toBe(312);
    writeRailWidth(RAIL_PICTURES);
    expect(readRailWidth()).toBe(72);
    writeRailWidth(null);
    expect(store.has("clawtrate.railWidth")).toBe(false);
    expect(readRailWidth()).toBeNull();
  });

  it("#792: a kept value that isn't a width the sidebar takes is ignored", () => {
    for (const bad of ["", "abc", "100", "150", "401", "9999", "280px", "-1", "12.5"]) {
      store.set("clawtrate.railWidth", bad);
      expect(readRailWidth(), bad).toBeNull();
    }
  });

  it("#792: storage that throws leaves the default", () => {
    globalThis.localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(readRailWidth()).toBeNull();
    expect(() => writeRailWidth(300)).not.toThrow();
  });
});
