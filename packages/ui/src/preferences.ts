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

function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
}

/**
 * Theme preference: follows the OS until the viewer picks one. `?theme=`
 * overrides it. "system" stores nothing and removes `data-theme`, so the
 * stylesheet's `prefers-color-scheme` rules apply.
 */
export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    const fromUrl = new URLSearchParams(globalThis.location?.search ?? "").get("theme");
    const stored = fromUrl ?? readPreference("theme");
    return stored === "light" || stored === "dark" ? stored : "system";
  });

  useEffect(() => applyTheme(choice), [choice]);

  const choose = useCallback((next: ThemeChoice) => {
    writePreference("theme", next === "system" ? null : next);
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
