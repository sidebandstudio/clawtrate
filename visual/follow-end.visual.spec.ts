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
  return transcript.evaluate(
    (element, { shrink, grow, pin }) =>
      new Promise<Array<{ top: number; short: number }>>((resolve) => {
        const spacer = element.querySelector<HTMLElement>("[data-follow-spacer]")!;
        const steps = new ResizeObserver(() => {
          steps.disconnect();
          spacer.style.height = `${pin - shrink}px`;
          element.style.marginBottom = "";
          void element.scrollHeight;
          spacer.style.height = `${pin - shrink + grow}px`;
        });
        steps.observe(element.firstElementChild!);
        spacer.style.height = `${pin}px`;
        const seen: Array<{ top: number; short: number }> = [];
        const frame = () => {
          const top = element.scrollTop;
          seen.push({ top, short: element.scrollHeight - top - element.clientHeight });
          if (seen.length < 10) requestAnimationFrame(frame);
          else resolve(seen);
        };
        requestAnimationFrame(frame);
      }),
    { ...ordering, pin: PIN },
  );
}

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
          const frames = await drive(page, ordering);
          // Each sample is taken before its frame's resize observer runs, so the
          // first frames show the spacer and the steps before they are followed.
          // From then on the transcript stays at the end, frame after frame.
          const shorts = frames.map(({ short }) => short);
          expect(
            shorts.slice(4).every((short) => short <= 1),
            `px short of the end, frame by frame: ${shorts}`,
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
        const tops = (await drive(page, ordering)).map((frame) => frame.top);
        expect(tops, "the reader's scroll position, frame by frame").toEqual(tops.map(() => top));
      });
    }
  });
}
