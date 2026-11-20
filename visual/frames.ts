// A slow frame, made certain: animation frames held across two keys, so a focus move a key
// left for a later frame lands after the next key (Tab) and shows if it takes focus back.
import { expect, type Page } from "@playwright/test";

type Frames = { releaseFrames: () => void; tabbedTo?: Element | null };

/** Animation frames asked for from now wait until `releaseFrames`. */
export const holdFrames = (page: Page) =>
  page.evaluate(() => {
    const real = window.requestAnimationFrame.bind(window);
    const held: FrameRequestCallback[] = [];
    window.requestAnimationFrame = (callback) => (held.push(callback), 0);
    (window as unknown as Frames).releaseFrames = () => {
      window.requestAnimationFrame = real;
      for (const callback of held.splice(0)) real(callback);
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

/**
 * Tab (or `key`) with the frames held since `holdFrames`, then release them: focus must stay
 * on the element the key reached. Where it went is for the check to say.
 */
export async function tabThenRelease(page: Page, key = "Tab"): Promise<void> {
  await page.keyboard.press(key);
  await page.evaluate(() => {
    (window as unknown as Frames).tabbedTo = document.activeElement;
  });
  await releaseFrames(page);
  expect(
    await page.evaluate(() => document.activeElement === (window as unknown as Frames).tabbedTo),
    `focus stays where ${key} put it once the held frames run`,
  ).toBe(true);
}
