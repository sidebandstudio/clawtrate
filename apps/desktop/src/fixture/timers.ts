/**
 * Delayed answers a test can hold. Each held answer keeps when it was due, so a release runs
 * them in the order their timers would have, whether they were held when asked for or when
 * their timer fired, and without waiting for a page timer.
 */
export function holdableTimers() {
  let held: Array<{ run: () => void; due: number }> | null = null;
  return {
    /** A delayed answer, run after `ms`, or once released if a test holds answers then. */
    deferred(run: () => void, ms: number) {
      const due = Date.now() + ms;
      if (held) held.push({ run, due });
      else setTimeout(() => (held ? held.push({ run, due }) : run()), ms);
    },
    hold() {
      held ??= [];
    },
    release() {
      const waiting = (held ?? []).sort((a, b) => a.due - b.due);
      held = null;
      for (const { run } of waiting) run();
    },
  };
}
