// Per-viewer conveniences kept in localStorage. Every access is guarded: storage
// can be missing or throw (private windows, blocked site data), and the app must
// work without it.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

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

/**
 * A switch kept on this device (conversation.md, 7.11), off by default, stored as
 * `clawtrate.<key>` = "show"; `?<key>=show` overrides the stored choice. One value
 * for the whole window, so Settings, the conversation and the Computer tab change together.
 */
function deviceSwitch(key: string): () => [boolean, (shown: boolean) => void] {
  const listeners = new Set<() => void>();
  let value: boolean | null = null;
  const read = (): boolean => {
    if (value === null) {
      const fromUrl = new URLSearchParams(globalThis.location?.search ?? "").get(key);
      value = (fromUrl ?? readPreference(key)) === "show";
    }
    return value;
  };
  return function useDeviceSwitch() {
    const shown = useSyncExternalStore((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }, read);
    const choose = useCallback((next: boolean) => {
      writePreference(key, next ? "show" : null);
      value = next;
      for (const listener of listeners) listener();
    }, []);
    return [shown, choose];
  };
}

/**
 * "Show commands": the action cards in the conversation, command lines and the
 * Raw view. `?commands=show` overrides the stored choice.
 */
export const useShowCommands = deviceSwitch("commands");

/**
 * "Show thinking": the "Thought" lines in the conversation and the thinking under
 * the status line. `?thinking=show` overrides the stored choice.
 */
export const useShowThinking = deviceSwitch("thinking");

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
