// The reader's place as the conversation itself holds it (`useHoldPlace` in
// packages/ui/src/Conversation.tsx): the first drawn text block at or below
// the reading line, just under the protected band (the column's top padding),
// and the character at that line. A check marks it, then records where it is
// drawn in every frame, after the conversation's own correction and before
// that frame is painted, so a jump that shows for one frame fails too.

import type { Locator, Page } from "@playwright/test";
import { TEXT_BLOCKS } from "../packages/ui/src/reading-line.ts";

type Watched = {
  mark: Range;
  samples: number[];
  heights: number[];
  /** The scroll position the transcript's last trusted scroll event was dispatched at. */
  told: number;
  stop: boolean;
};

/**
 * Mark the character at the reading line; returns its text and its top, relative to the
 * transcript. Given `within`, the mark must start inside it.
 */
export async function markReadingLine(
  page: Page,
  within?: Locator,
): Promise<{ text: string; top: number }> {
  const held = await page.getByTestId("transcript").evaluate((scroller, blocks) => {
    const box = scroller.getBoundingClientRect();
    const inner = scroller.firstElementChild as HTMLElement | null;
    const band = inner ? Number.parseFloat(getComputedStyle(inner).paddingTop) || 0 : 0;
    const line = box.top + band;
    const block = [...scroller.querySelectorAll(blocks)].find(
      (node) =>
        !node.querySelector(blocks) &&
        node.checkVisibility() &&
        node.getBoundingClientRect().bottom > line + 1,
    )!;
    const rect = block.getBoundingClientRect();
    // The same caret the conversation takes: the standard API first, as it does.
    const x = rect.left + 2;
    const y = Math.max(line + 2, rect.top + 2);
    const position = document.caretPositionFromPoint(x, y);
    const node = position?.offsetNode ?? document.caretRangeFromPoint(x, y)!.startContainer;
    const offset = position?.offset ?? document.caretRangeFromPoint(x, y)!.startOffset;
    if (!block.contains(node)) throw new Error("no text position at the reading line");
    const length = node.textContent?.length ?? 0;
    const at = Math.max(0, Math.min(offset, length - 1));
    const mark = document.createRange();
    mark.setStart(node, at);
    mark.setEnd(node, Math.min(at + 1, length));
    const top = mark.getBoundingClientRect().top - box.top;
    (window as unknown as { readingLine: Watched }).readingLine = {
      mark,
      samples: [],
      heights: [],
      told: scroller.scrollTop,
      stop: false,
    };
    return { text: mark.toString(), top };
  }, TEXT_BLOCKS);
  if (
    within &&
    !(await within.evaluate((element) =>
      element.contains(
        (window as unknown as { readingLine: Watched }).readingLine.mark.startContainer,
      ),
    ))
  )
    throw new Error(`the reading line is at "${held.text}", outside ${String(within)}`);
  return held;
}

/**
 * Start recording the mark's top in every frame. A hidden sentinel changes
 * size in each frame's animation callback, so its observer is told in every
 * frame, after layout. Made after the conversation's observer, it is told after
 * the conversation's own correction in the same frame, and before the frame is
 * painted: each sample is where the text is drawn in that frame, with the height
 * of the transcript's content in that frame. It also keeps the scroll position
 * each trusted scroll event of the transcript is dispatched at.
 */
export async function watchReadingLine(page: Page): Promise<void> {
  await page.evaluate(() => {
    const watched = (window as unknown as { readingLine: Watched }).readingLine;
    watched.samples = [];
    watched.heights = [];
    watched.stop = false;
    const scroller = document.querySelector<HTMLElement>("[data-testid=transcript]")!;
    const onScroll = (event: Event) => {
      if (event.isTrusted) watched.told = scroller.scrollTop;
    };
    scroller.addEventListener("scroll", onScroll);
    const sentinel = document.createElement("div");
    sentinel.style.cssText =
      "position:fixed;left:0;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none";
    document.body.append(sentinel);
    const observer = new ResizeObserver(() => {
      if (watched.stop) return;
      watched.samples.push(
        watched.mark.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
      );
      watched.heights.push(scroller.firstElementChild!.getBoundingClientRect().height);
    });
    observer.observe(sentinel);
    let wide = false;
    const frame = () => {
      if (watched.stop) {
        scroller.removeEventListener("scroll", onScroll);
        observer.disconnect();
        sentinel.remove();
        return;
      }
      wide = !wide;
      sentinel.style.width = wide ? "2px" : "1px";
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

/** The border-box height of the transcript's content, as laid out now. */
export function transcriptHeight(page: Page): Promise<number> {
  return page
    .getByTestId("transcript")
    .evaluate((scroller) => scroller.firstElementChild!.getBoundingClientRect().height);
}

/**
 * Wait for the browser to report the transcript's content at a height other than
 * `beforeHeight`, the height when `phase` began; returns the reported height. The
 * conversation holds the place when the browser delivers resize observations, after
 * that update's scroll events, and the browser can deliver them some frames after a
 * change is laid out, so frames alone do not say it has run. This observer is made
 * after the conversation's, so it is told after the conversation's own correction.
 * A transcript that does not change, or a report that never comes, fails after 5 s.
 */
export async function waitForTranscriptResize(
  page: Page,
  beforeHeight: number,
  phase: string,
): Promise<number> {
  return page.evaluate(
    ([from, name]) =>
      new Promise<number>((resolve, reject) => {
        const content = document.querySelector("[data-testid=transcript]")!.firstElementChild!;
        let last: number | null = null;
        const observer = new ResizeObserver((entries) => {
          last = entries[0]!.borderBoxSize[0]!.blockSize;
          if (last === from) return;
          clearTimeout(timer);
          observer.disconnect();
          resolve(last);
        });
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(
            new Error(
              `${name}: no resize of the transcript within 5 s; it began at ${from}px, last reported ${last ?? "nothing"}`,
            ),
          );
        }, 5000);
        observer.observe(content);
      }),
    [beforeHeight, phase] as const,
  );
}

/**
 * While `watchReadingLine` records: wait for a frame recorded with the content at
 * `height`, and for the browser to have dispatched a scroll event at the transcript's
 * current position, so a correction the conversation made has been told to it before
 * the next update (a scroll event in the same update as a resize is #269). Fails after 5 s.
 */
export async function waitForFrameAt(page: Page, height: number, phase: string): Promise<void> {
  await page.evaluate(
    ([at, name]) =>
      new Promise<void>((resolve, reject) => {
        const watched = (window as unknown as { readingLine: Watched }).readingLine;
        const scroller = document.querySelector<HTMLElement>("[data-testid=transcript]")!;
        const started = performance.now();
        const check = () => {
          const drawn = watched.heights.some((each) => Math.abs(each - at) < 0.5);
          if (drawn && watched.told === scroller.scrollTop) resolve();
          else if (performance.now() - started > 5000)
            reject(
              new Error(
                `${name}: ${drawn ? "" : `no frame recorded at ${at}px; `}last scroll event at ${watched.told}, scrollTop ${scroller.scrollTop}, after 5 s`,
              ),
            );
          else setTimeout(check, 16);
        };
        check();
      }),
    [height, phase] as const,
  );
}

/**
 * Stop recording; every top recorded since `watchReadingLine`, the content height in
 * each of those frames, and where the mark is now.
 */
export async function readingLineSamples(
  page: Page,
): Promise<{ samples: number[]; heights: number[]; now: number }> {
  return page.evaluate(() => {
    const watched = (window as unknown as { readingLine: Watched }).readingLine;
    watched.stop = true;
    const scroller = document.querySelector<HTMLElement>("[data-testid=transcript]")!;
    return {
      samples: watched.samples,
      heights: watched.heights,
      now: watched.mark.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
    };
  });
}
