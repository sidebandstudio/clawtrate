// What the reader opened in a task's action cards: a card or a fold, a row, the
// Readable or Raw view, a "Thought" line. It is the viewer's, kept here across
// scrolling, a switch to another task and back, and a reconnect, under the
// gateway's tool call ids (a fold under its first member's), never under a
// position (conversation.md 7.4, 19). A "Thought" line is kept under its
// derived reasoning id and its run's reasoning revision, so it closes when the
// revision changes (7.5).

import { useCallback, useSyncExternalStore } from "react";

/** Tasks whose view state is kept, and entries in each; the oldest give way. */
const MAX_TASKS = 16;
const MAX_ENTRIES = 512;

type Value = boolean | string;
const tasks = new Map<string, Map<string, Value>>();
const listeners = new Set<() => void>();
let version = 0;

function entries(task: string): Map<string, Value> {
  let map = tasks.get(task);
  if (!map) {
    map = new Map();
    tasks.set(task, map);
    while (tasks.size > MAX_TASKS) tasks.delete(tasks.keys().next().value as string);
  }
  return map;
}

export function readView(task: string, key: string): Value | undefined {
  return tasks.get(task)?.get(key);
}

export function writeView(task: string, key: string, value: Value): void {
  const map = entries(task);
  if (map.get(key) === value) return;
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as string);
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One value of a task's view state, and its setter. */
export function useView<T extends Value>(
  task: string,
  key: string,
  fallback: T,
): [T, (value: T) => void] {
  useSyncExternalStore(subscribe, () => version);
  const value = (readView(task, key) as T | undefined) ?? fallback;
  const set = useCallback((next: T) => writeView(task, key, next), [task, key]);
  return [value, set];
}

/** Keys of the view state. */
export const viewKeys = {
  /** A single card, or a row in a fold, by its tool call id. */
  call: (id: string) => `call:${id}`,
  /** A fold, by its first member's tool call id. */
  fold: (id: string) => `fold:${id}`,
  /** The fold a call was last drawn in, by its first member's id: a split's later part opens as it was. */
  member: (id: string) => `in:${id}`,
  /** A call's item on its T3 Code thread card, by its tool call id. */
  item: (id: string) => `t3item:${id}`,
  /** The Readable or Raw view of a call; on a thread card, whether its item's Raw is open. */
  view: (id: string) => `view:${id}`,
  /** A "Thought" line, valid only for its run's reasoning revision. */
  thought: (id: string, revision: number) => `thought:${id}@${revision}`,
  /** The run line. */
  run: (id: string) => `run:${id}`,
};
