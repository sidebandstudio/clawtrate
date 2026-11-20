// A slow frame, made certain: animation frames held across two keys, so a focus move a key
// left for a later frame lands after the next key (Tab) and shows if it takes focus back.
import { expect, type Locator, type Page } from "@playwright/test";

type Frames = {
  releaseFrames: () => void;
  heldId?: number;
  focusTrace?: Element[];
};

/**
 * Animation frames asked for from now wait until `releaseFrames`. Each gets its own id, and a
 * frame cancelled while held, or after release before it runs, never runs.
 */
export const holdFrames = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as Frames;
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    const held = new Map<number, FrameRequestCallback>();
    // A held frame's id, and the browser's id for it once released, until it runs.
    const released = new Map<number, number>();
    window.requestAnimationFrame = (callback) => {
      // Far above the browser's own ids, so a cancel can tell them apart.
      w.heldId = (w.heldId ?? 2 ** 30) + 1;
      held.set(w.heldId, callback);
      return w.heldId;
    };
    window.cancelAnimationFrame = (id) => {
      if (held.delete(id)) return;
      const native = released.get(id);
      released.delete(id);
      cancel(native ?? id);
    };
    w.releaseFrames = () => {
      window.requestAnimationFrame = request;
      for (const [id, callback] of held) {
        released.set(
          id,
          request((time) => {
            released.delete(id);
            callback(time);
          }),
        );
      }
      held.clear();
    };
  });

/** Runs the held callbacks and waits until they, and the frames they ask for, have run. */
export const releaseFrames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) => {
        (window as unknown as Frames).releaseFrames();
        // A few frames more: some waits are two frames long, or try again for a few.
        let left = 4;
        const next = () => (--left > 0 ? requestAnimationFrame(next) : done());
        requestAnimationFrame(next);
      }),
  );

/** Every focus move from now on, in order, for `focusMoves`. */
export const traceFocus = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as Frames;
    if (!w.focusTrace)
      document.addEventListener("focusin", (event) => w.focusTrace!.push(event.target as Element));
    w.focusTrace = [];
  });

/** How many focus moves `traceFocus` has seen. */
export const focusMoves = (page: Page) =>
  page.evaluate(() => (window as unknown as Frames).focusTrace!.length);

/**
 * Tab (or `key`, such as Shift+Tab where Tab would leave the page) with the frames held since
 * `holdFrames`: focus must reach `expected`, and nothing after (the outcome `until` waits for,
 * when the work ends later, then the held frames) may move it anywhere else, even for a moment.
 */
export async function tabThenRelease(
  page: Page,
  expected: Locator,
  key = "Tab",
  until?: () => Promise<unknown>,
): Promise<void> {
  await traceFocus(page);
  await page.keyboard.press(key);
  await expect(expected, `${key} reaches its next control`).toBeFocused();
  const moves = await focusMoves(page);
  expect(moves, `${key} moved focus`).toBeGreaterThan(0);
  await until?.();
  await releaseFrames(page);
  expect(await focusMoves(page), "the held frames move focus nowhere").toBe(moves);
  await expect(expected, `focus stays where ${key} put it`).toBeFocused();
}
