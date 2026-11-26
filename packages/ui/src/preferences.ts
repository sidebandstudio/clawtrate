// Per-viewer conveniences kept in localStorage. Every access is guarded: storage
// can be missing or throw (private windows, blocked site data), and the app must
// work without it.

import {
  gatewayStamp,
  shownChoice,
  type ChoiceId,
  type ChoiceSet,
  type ClawtrateBridge,
} from "@clawtrate/core";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useOptionalBridge } from "./bridge.tsx";

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
 * A switch of how conversations are shown (conversation.md, 7.11), off by default. On when this
 * device turned it on, stored as `clawtrate.<key>` = "show", or when the gateway holds it on for
 * this user (`state.choices`, `shownChoice`; #639): the gateway's value only ever shows more.
 * `?<key>=show` overrides both. One value for the whole window, so Settings, the conversation and
 * the Computer tab change together.
 */
function deviceSwitch(
  key: string,
  choice: ChoiceId,
): () => [boolean, (shown: boolean) => Promise<void>] {
  const listeners = new Set<() => void>();
  let value: boolean | null = null;
  const fromUrl = () => new URLSearchParams(globalThis.location?.search ?? "").get(key);
  const read = (): boolean => {
    if (value === null) value = (fromUrl() ?? readPreference(key)) === "show";
    return value;
  };
  const keep = (next: boolean) => {
    writePreference(key, next ? "show" : null);
    value = next;
    for (const listener of listeners) listener();
  };
  return function useDeviceSwitch() {
    const local = useSyncExternalStore((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }, read);
    const bridge = useOptionalBridge();
    const choices = useSyncExternalStore(
      useCallback((listener) => bridge?.subscribe(listener) ?? (() => {}), [bridge]),
      () => bridge?.getState().choices,
    );
    const url = fromUrl();
    const choose = useCallback(
      (next: boolean) => pressSwitch(choice, next, keep, bridge),
      [bridge],
    );
    return [url === null ? shownChoice(choices, local, choice) : local, choose];
  };
}

/**
 * A press of a conversation switch: kept on this device first, whatever the gateway answers, so
 * the press always changes what this device keeps and an "on" shows at once. The engine then tells
 * the gateway, and keeps an "on" it couldn't send for later; only an "off" the gateway still holds
 * on for every device can be refused, and then it still shows by the gateway's "on".
 */
export async function pressSwitch(
  choice: ChoiceId,
  next: boolean,
  keep: (next: boolean) => void,
  bridge: Pick<ClawtrateBridge, "getState" | "invoke"> | null,
): Promise<void> {
  keep(next);
  const state = bridge?.getState();
  if (!bridge || !state || state.choices?.status === "unavailable") return;
  await bridge.invoke({
    type: "changeChoices",
    change: { [choice]: next },
    stamp: gatewayStamp(state.connection),
  });
}

/** This device's own conversation switches, for the first-time merge: only those turned on here. */
export function ownChoices(): ChoiceSet {
  return {
    ...(readPreference("commands") === "show" ? { commands: true } : {}),
    ...(readPreference("thinking") === "show" ? { thinking: true } : {}),
  };
}

/**
 * "Show commands": the action cards in the conversation, command lines and the
 * Raw view. `?commands=show` overrides the stored choice.
 */
export const useShowCommands = deviceSwitch("commands", "commands");

/**
 * "Show thinking": the "Thought" lines in the conversation and the thinking under
 * the status line. `?thinking=show` overrides the stored choice.
 */
export const useShowThinking = deviceSwitch("thinking", "thinking");

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
