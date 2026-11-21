// What a screen keeps until the app quits, outside React's state: New bot's
// draft and the Settings section last shown (bots.md sections 3 and 7).

const kept = new Map<string, unknown>();

export function remember(key: string, value: unknown): void {
  if (value === null) kept.delete(key);
  else kept.set(key, value);
}

export function recall<T>(key: string): T | null {
  return (kept.get(key) as T | undefined) ?? null;
}

/** Forget every value kept under a key that starts with `prefix`. */
export function forgetAll(prefix: string): void {
  for (const key of [...kept.keys()]) if (key.startsWith(prefix)) kept.delete(key);
}
