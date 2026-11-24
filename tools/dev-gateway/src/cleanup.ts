// Removing what a check made on a development gateway, by key, until the
// gateway shows none of it. A list can leave rows out, and a create that timed
// out on the client can still land, so each key is asked for itself, and the
// work is done only when two passes in a row find nothing. That narrows the
// window, and can't close it: the gateway keeps an accepted request alive, so a
// create can land after the last pass. A check whose leftovers would disturb
// others runs on a gateway of its own as well.

/** Whether the gateway has the item now: true, false, or "unknown" when it couldn't say. */
export type Presence = boolean | "unknown";

export type RemoveOptions = {
  present: (key: string) => Promise<Presence>;
  remove: (key: string) => Promise<void>;
  /** How long to keep trying. */
  deadlineMs?: number;
  /** The pause between passes, so a late create has time to show. */
  pauseMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Removes every key the gateway still has. `gone` is true only after two passes in a row found
 * none; at the deadline it is false, with the keys still there, or every key when the last
 * pass found none but no second pass confirmed it. The deadline holds for calls still on their
 * way as well: a look that hasn't answered by then counts as unknown, a removal still waiting
 * is left to finish on its own, and the pause between passes ends there.
 */
export async function removeUntilGone(
  keys: Iterable<string>,
  options: RemoveOptions,
): Promise<{ gone: boolean; left: string[] }> {
  const all = [...keys];
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const until = now() + (options.deadlineMs ?? 90_000);
  /** The work's answer, or `late` once the deadline passes first. */
  const inTime = async <T>(work: Promise<T>, late: T): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(late), Math.max(0, until - now()));
    });
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
    }
  };
  let clean = 0;
  let left = all;
  while (now() < until) {
    const found = await Promise.all(
      all.map(async (key) => ({
        key,
        is: await inTime(
          options.present(key).catch(() => "unknown" as const),
          "unknown" as const,
        ),
      })),
    );
    // Unknown is not gone: only an answer that says so counts.
    left = found.filter(({ is }) => is !== false).map(({ key }) => key);
    clean = left.length === 0 ? clean + 1 : 0;
    // A pass that ended at or after the deadline confirms nothing: it may have missed a late create.
    if (now() >= until) break;
    if (clean >= 2) return { gone: true, left: [] };
    await inTime(Promise.allSettled(left.map((key) => options.remove(key))), []);
    if (now() >= until) break;
    await inTime(sleep(Math.min(options.pauseMs ?? 1000, until - now())), undefined);
  }
  return { gone: false, left: left.length > 0 ? left : all };
}
