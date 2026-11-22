// Per-viewer conveniences kept in localStorage. Every access is guarded: storage
// can be missing or throw (private windows, blocked site data), and the app must
// work without it.

import { useCallback, useEffect, useState } from "react";

export function readPreference(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(`clawtrate.${key}`) ?? null;
  } catch {
    return null;
  }
}

export function writePreference(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(`clawtrate.${key}`);
    else globalThis.localStorage?.setItem(`clawtrate.${key}`, value);
  } catch {
    // Not persisted; the in-memory value still applies.
  }
}

export type ThemeChoice = "system" | "light" | "dark";

/** The theme for a viewer who has chosen none. */
export const DEFAULT_THEME: ThemeChoice = "dark";

/**
 * Theme preference: dark until the viewer picks one. `?theme=` overrides it.
 * The choice is stored and set as `data-theme`; the stylesheet's root is dark,
 * and "system" turns light only where the system asks for light.
 */
export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    const fromUrl = new URLSearchParams(globalThis.location?.search ?? "").get("theme");
    const stored = fromUrl ?? readPreference("theme");
    return stored === "system" || stored === "light" || stored === "dark" ? stored : DEFAULT_THEME;
  });

  useEffect(() => {
    document.documentElement.dataset.theme = choice;
  }, [choice]);

  const choose = useCallback((next: ThemeChoice) => {
    writePreference("theme", next);
    setChoice(next);
  }, []);

  return [choice, choose];
}

export type BubbleChoice = "accent" | "neutral";

/**
 * Your messages' fill: the accent, or neutral (`--bg-inverse`). `?bubbles=`
 * overrides the stored choice. Neutral sets `data-bubbles` on the root.
 */
export function useBubbles(): [BubbleChoice, (choice: BubbleChoice) => void] {
  const [choice, setChoice] = useState<BubbleChoice>(() => {
    const fromUrl = new URLSearchParams(globalThis.location?.search ?? "").get("bubbles");
    return (fromUrl ?? readPreference("bubbles")) === "neutral" ? "neutral" : "accent";
  });
  useEffect(() => {
    const root = document.documentElement;
    if (choice === "neutral") root.dataset.bubbles = "neutral";
    else delete root.dataset.bubbles;
  }, [choice]);
  const choose = useCallback((next: BubbleChoice) => {
    writePreference("bubbles", next === "accent" ? null : next);
    setChoice(next);
  }, []);
  return [choice, choose];
}

/** A set of ids kept as a JSON array in a preference. */
export function readIdSet(key: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readPreference(key) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeIdSet(key: string, ids: Set<string>): void {
  writePreference(key, JSON.stringify([...ids]));
}
