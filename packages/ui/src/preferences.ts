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

/** Theme preference: follows the OS until the viewer picks one. `?theme=` overrides it. */
export function useTheme(): [ThemeChoice, () => void] {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    const fromUrl = new URLSearchParams(globalThis.location?.search ?? "").get("theme");
    const stored = fromUrl ?? readPreference("theme");
    return stored === "light" || stored === "dark" ? stored : "system";
  });

  useEffect(() => applyTheme(choice), [choice]);

  const cycle = useCallback(() => {
    setChoice((current) => {
      const systemDark = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
      const effective = current === "system" ? (systemDark ? "dark" : "light") : current;
      const next: ThemeChoice = effective === "dark" ? "light" : "dark";
      writePreference("theme", next);
      return next;
    });
  }, []);

  return [choice, cycle];
}
