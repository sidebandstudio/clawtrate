// The transcript follows its end through the ordering that left it short in
// F-068, F-456 and F-471's failing frames (#219), driven step by step rather
// than left to the machine's timing. The end is followed: the resize observer
// puts the scroll at the end, which queues a scroll event for the next frame.
// Before that frame, the end moves up (the content shrinks, or the view grows),
// a layout runs, and the content grows. Had the browser clamped the scroll to
// the smaller end, the queued event would report the clamped place against the
// grown content, ahead of the resize observer, and read as the reader moving up.
import { test, expect, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const PHONE = SIZES.find((size) => size.phone)!;

const SCENES = [
  { rows: "F-068", scene: "composer" },
  { rows: "F-456", scene: "access-denied" },
  { rows: "F-471", scene: "queued-refused" },
];

/**
 * The recorded steps: the content 24 px shorter, then 167 px taller (F-068's
 * 2058, 2034, 2201), or the view 30 px taller and the content 177 px taller,
 * as when a composer note leaves while a card arrives.
 */
const ORDERINGS = {
  "the content shrinks, then grows": { shrink: 24, view: 0, grow: 167 },
  "the view grows, then the content grows": { shrink: 0, view: 30, grow: 177 },
};
type Ordering = (typeof ORDERINGS)[keyof typeof ORDERINGS];

/** The growth that the resize observer follows, queueing the scroll event. */
const PIN = 24;

/**
 * Runs the ordering and returns each following frame's scroll position and how
 * far it sits above the end. The view starts shorter by the ordering's growth,
 * and a spacer at the end of the content grows by PIN. The resize observer
 * follows that; a second observer, created after the transcript's so it runs
 * after it in the same frame, then takes the steps. Its changes reach the
 * transcript's observer only in the next frame, after the queued scroll event.
 */
async function drive(page: Page, ordering: Ordering) {
  const transcript = page.getByTestId("transcript");
  await transcript.evaluate((element, view) => {
    const spacer = document.createElement("div");
    spacer.dataset.followSpacer = "";
    element.firstElementChild!.append(spacer);
    element.style.marginBottom = `${view}px`;
  }, ordering.view);
  await settle(page);
  return afterGrowth(page, PIN, ordering);
}

type Frame = { top: number; short: number };

/** Sample throughout the change and for ten frames after the observer receives the final size. */
const afterGrowth = (page: Page, px: number, ordering: Ordering | null = null) =>
  page.getByTestId("transcript").evaluate(
    (element, { px, ordering }) =>
      new Promise<{ frames: Frame[]; afterResize: Frame[] }>((resolve) => {
        const inner = element.firstElementChild!;
        let spacer = inner.querySelector<HTMLElement>("[data-follow-spacer]");
        if (!spacer) {
          spacer = document.createElement("div");
          spacer.dataset.followSpacer = "";
          inner.append(spacer);
        }
        const height = (Number.parseFloat(spacer.style.height) || 0) + px;
        const frames: Frame[] = [];
        let resizedAt: number | null = null;
        const observer = new ResizeObserver(() => {
          if (ordering) {
            spacer.style.height = `${height - ordering.shrink}px`;
            element.style.marginBottom = "";
            void element.scrollHeight;
            spacer.style.height = `${height - ordering.shrink + ordering.grow}px`;
            ordering = null;
            return;
          }
          // The transcript's observer was registered first and has now seen the final size.
          observer.disconnect();
          resizedAt = frames.length;
        });
        observer.observe(inner);
        spacer.style.height = `${height}px`;
        const frame = () => {
          const top = element.scrollTop;
          frames.push({ top, short: element.scrollHeight - top - element.clientHeight });
          if (resizedAt !== null && frames.length - resizedAt === 10) {
            resolve({ frames, afterResize: frames.slice(resizedAt) });
          } else {
            requestAnimationFrame(frame);
          }
        };
        requestAnimationFrame(frame);
      }),
    { px, ordering },
  );

const atEnd = (page: Page) =>
  expect
    .poll(() =>
      page
        .getByTestId("transcript")
        .evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
    )
    .toBeLessThanOrEqual(1);

for (const theme of THEMES) {
  test.describe(`following the end, phone ${theme}`, () => {
    test.use(contextFor(PHONE, theme));

    for (const { rows, scene } of SCENES) {
      for (const [name, ordering] of Object.entries(ORDERINGS)) {
        test(`${rows}: ${scene}, ${name}`, async ({ page }) => {
          await openFixture(page, `scene=${scene}&${OTTO_DISK}&panel=closed`, theme);
          await atEnd(page);
          const { afterResize } = await drive(page, ordering);
          const shorts = afterResize.map(({ short }) => short);
          expect(
            shorts.every((short) => short <= 1),
            `px short of the end after the resize, frame by frame: ${shorts}`,
          ).toBe(true);
        });
      }
    }

    for (const [name, ordering] of Object.entries(ORDERINGS)) {
      test(`a reader who scrolls up keeps their place when ${name}`, async ({ page }) => {
        await openFixture(page, `scene=composer&${OTTO_DISK}&panel=closed`, theme);
        await atEnd(page);
        const transcript = page.getByTestId("transcript");
        const top = await transcript.evaluate((element) => {
          element.scrollTop -= 200;
          return element.scrollTop;
        });
        await settle(page);
        const tops = (await drive(page, ordering)).frames.map((frame) => frame.top);
        expect(tops, "the reader's scroll position, frame by frame").toEqual(tops.map(() => top));
      });
    }

    // CodeRabbit's case on #222: the held line stops following, the reader comes
    // back to the end, then scrolls up. Nothing left from the earlier following
    // interval may take that scroll for the browser's and pull the reader back.
    test("a reader who scrolls up after a held line and a return to the end stays there", async ({
      page,
    }) => {
      await openFixture(page, `scene=composer&${OTTO_DISK}&panel=closed&commands=show`, theme);
      await atEnd(page);
      const transcript = page.getByTestId("transcript");
      const tops = (frames: Array<{ top: number }>) => frames.map(({ top }) => top);

      // The reader opens a card in view, and the content grows under it: its
      // line is held at the top and following stops (section 18).
      await transcript
        .locator("details.card.action > summary")
        .filter({ hasText: "Edited disk-2026-11-16.md" })
        .click();
      await settle(page);
      const { frames: held } = await afterGrowth(page, 1500);
      const heldTop = held.at(-1)!.top;
      expect(held.at(-1)!.short, "the held line stops following").toBeGreaterThan(96);
      const { frames: grown } = await afterGrowth(page, 300);
      expect(tops(grown), "the held place, while the content grows").toEqual(
        grown.map(() => heldTop),
      );

      // Back at the end, following resumes; the reader then scrolls up past
      // the follow distance, still below where the line was held.
      await transcript.evaluate((element) => (element.scrollTop = element.scrollHeight));
      await atEnd(page);
      const top = await transcript.evaluate((element) => {
        element.scrollTop -= 150;
        return element.scrollTop;
      });
      expect(top).toBeGreaterThan(heldTop);
      const { frames: watched } = await afterGrowth(page, 0);
      expect(tops(watched), "the reader's scroll position, frame by frame").toEqual(
        watched.map(() => top),
      );
      const { frames: growing } = await afterGrowth(page, 100);
      expect(tops(growing), "the reader's place while the content grows").toEqual(
        growing.map(() => top),
      );

      // Only once the reader is back at the end is the end followed again.
      await transcript.evaluate((element) => (element.scrollTop = element.scrollHeight));
      await atEnd(page);
      const followed = (await afterGrowth(page, 100)).afterResize.map(({ short }) => short);
      expect(
        followed.every((short) => short <= 1),
        `px short of the end, frame by frame: ${followed}`,
      ).toBe(true);
    });
  });
}
