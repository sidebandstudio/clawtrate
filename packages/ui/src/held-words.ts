// Which tasks' editors on this page hold unsent words: the composer's draft and each reply's. A task
// that leaves the list while one does stays on screen, so the words keep a place where they can be
// read and recovered (`keptOnScreen`, F-278, F-277).
import { useEffect, useSyncExternalStore } from "react";

const held = new Map<string, Set<symbol>>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

/** One editor of `taskKey` holds words while `holds` is true and it is mounted. */
export function useHoldsWords(taskKey: string, holds: boolean): void {
  useEffect(() => {
    if (!holds) return;
    const editor = Symbol(taskKey);
    const editors = held.get(taskKey) ?? new Set<symbol>();
    held.set(taskKey, editors.add(editor));
    changed();
    return () => {
      editors.delete(editor);
      if (editors.size === 0) held.delete(taskKey);
      changed();
    };
  }, [taskKey, holds]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether an editor of `taskKey` holds words now, drawn again when that changes. */
export function useWordsHeld(taskKey: string | null): boolean {
  return useSyncExternalStore(subscribe, () => taskKey !== null && held.has(taskKey));
}
