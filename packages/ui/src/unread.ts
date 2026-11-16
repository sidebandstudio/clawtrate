import type { Task } from "@clawtrate/core";

/**
 * When this viewer last read each task, as the task's activity time at that
 * moment. Kept locally: marking a task read on the gateway needs write scope.
 */
export type SeenMap = Record<string, number>;

/** A task is unread when the gateway says so and nothing newer than this viewer's last read happened. */
export function isUnread(task: Task, seen: SeenMap): boolean {
  if (!task.unread) return false;
  const lastSeen = seen[task.key];
  return lastSeen === undefined || (task.updatedAt ?? 0) > lastSeen;
}

/** Record that the viewer has read a task as of its current activity. */
export function markSeen(seen: SeenMap, task: Task): SeenMap {
  const at = task.updatedAt ?? 0;
  return seen[task.key] === at ? seen : { ...seen, [task.key]: at };
}
