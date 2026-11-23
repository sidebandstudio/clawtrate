// How the launch check times a quit: the deadline starts when the process is
// asked, and anything done alongside (closing a debugging client) never moves it.

/**
 * Calls `ask`, then reports whether `gone` settled within `ms` of that call.
 * `detach` runs at the same time and is awaited until it settles or the
 * deadline passes, whichever is first, so a stuck debugging client never holds
 * the caller past the deadline; the answer is the one captured at the deadline:
 * a process that exits after it fails, even while `detach` is still pending.
 * The exit is judged by the clock when `gone` settles, not by which callback
 * runs first: a synchronous poll that straddles the deadline can settle `gone`
 * before the overdue timer gets to run.
 */
export async function quitWithin(
  ask: () => void,
  gone: () => Promise<unknown>,
  detach: () => Promise<unknown>,
  ms: number,
): Promise<boolean> {
  const end = performance.now() + ms;
  ask();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    const quit = Promise.race([gone().then(() => performance.now() < end), deadline]);
    const detached = Promise.race([detach().catch(() => undefined), deadline]);
    const [result] = await Promise.all([quit, detached]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
