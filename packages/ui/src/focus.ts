// Focus that follows a key to a view the key is about to show. It moves in a layout effect
// once that view is committed, so it lands before the person's next key: a frame later it
// could land after a Tab and take focus back from where Tab put it.

import { useCallback, useLayoutEffect, useState } from "react";

/**
 * The person has not moved on since `from` was read: focus is still there, or it was lost
 * with the view it was in.
 */
export function stillAt(from: Element | null): boolean {
  const now = document.activeElement;
  return now === from || now === null || now === document.body;
}

type Find = () => HTMLElement | null | undefined;

/**
 * Ask for focus on the element `find` gives once the update made with the ask is committed.
 * With `from`, for work that finished after its key, only if the person has not moved on
 * since `from` was read.
 */
export function useFocusOnCommit(): (find: Find, from?: Element | null) => void {
  const [asked, ask] = useState<{ find: Find; from: Element | null | undefined } | null>(null);
  useLayoutEffect(() => {
    if (!asked || (asked.from !== undefined && !stillAt(asked.from))) return;
    asked.find()?.focus();
  }, [asked]);
  return useCallback((find: Find, from?: Element | null) => ask({ find, from }), []);
}
