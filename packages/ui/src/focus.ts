// Focus that follows a key to a view the key is about to show. It moves in a layout effect
// once that view is committed, so it lands before the person's next key: a frame later it
// could land after a Tab and take focus back from where Tab put it.

import { useCallback, useLayoutEffect, useState } from "react";

// Every key and pointer press the person makes, counted before any handler sees it.
let presses = 0;
if (typeof window !== "undefined") {
  const count = () => void (presses += 1);
  window.addEventListener("keydown", count, true);
  window.addEventListener("pointerdown", count, true);
}

/** A mark of the person's presses so far, read as work that ends later starts. */
export function pressMark(): number {
  return presses;
}

/** The person has pressed a key or a pointer since `mark`: focus is theirs, not the work's. */
export function movedOn(mark: number): boolean {
  return presses !== mark;
}

type Find = () => HTMLElement | null | undefined;

/** Ask for focus on the element `find` gives once the update made with the ask is committed. */
export function useFocusOnCommit(): (find: Find) => void {
  const [asked, ask] = useState<{ find: Find } | null>(null);
  useLayoutEffect(() => {
    asked?.find()?.focus();
  }, [asked]);
  return useCallback((find: Find) => ask({ find }), []);
}
