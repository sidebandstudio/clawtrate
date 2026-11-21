// How the launch check times a quit: the deadline starts when the process is
// asked, and anything done alongside (closing a debugging client) never moves it.

/**
 * Calls `ask`, then reports whether `gone` settled within `ms` of that call.
 * `detach` runs at the same time and is awaited before returning, but the
 * answer is the one captured at the deadline: a process that exits after it
 * fails, even while `detach` is still pending.
 */
export async function quitWithin(
  ask: () => void,
  gone: () => Promise<unknown>,
  detach: () => Promise<unknown>,
  ms: number,
): Promise<boolean> {
  ask();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const quit = Promise.race([gone().then(() => true as const), deadline]);
  const [result] = await Promise.all([quit, detach().catch(() => undefined)]);
  clearTimeout(timer);
  return result;
}
