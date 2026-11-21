// The reader's place as the conversation itself holds it (`useHoldPlace` in
// packages/ui/src/Conversation.tsx): the first drawn text block at or below
// the reading line, just under the protected band (the column's top padding),
// and the character at that line. A check marks it, then records where it is
// drawn in every frame, after the conversation's own correction and before
// that frame is painted, so a jump that shows for one frame fails too.

import type { Page } from "@playwright/test";
import { TEXT_BLOCKS } from "../packages/ui/src/reading-line.ts";

type Watched = { mark: Range; samples: number[]; stop: boolean };

/** Mark the character at the reading line; returns its text and its top, relative to the transcript. */
export async function markReadingLine(page: Page): Promise<{ text: string; top: number }> {
  return page.getByTestId("transcript").evaluate((scroller, blocks) => {
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
      stop: false,
    };
    return { text: mark.toString(), top };
  }, TEXT_BLOCKS);
}

/**
 * Start recording the mark's top in every frame. A hidden sentinel changes
 * size in each frame's animation callback, so its observer is told in every
 * frame, after layout. Made after the conversation's observer, it is told after
 * the conversation's own correction in the same frame, and before the frame is
 * painted: each sample is where the text is drawn in that frame.
 */
export async function watchReadingLine(page: Page): Promise<void> {
  await page.evaluate(() => {
    const watched = (window as unknown as { readingLine: Watched }).readingLine;
    watched.samples = [];
    watched.stop = false;
    const scroller = document.querySelector<HTMLElement>("[data-testid=transcript]")!;
    const sentinel = document.createElement("div");
    sentinel.style.cssText =
      "position:fixed;left:0;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none";
    document.body.append(sentinel);
    const observer = new ResizeObserver(() => {
      if (watched.stop) return;
      watched.samples.push(
        watched.mark.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
      );
    });
    observer.observe(sentinel);
    let wide = false;
    const frame = () => {
      if (watched.stop) {
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

/**
 * Wait until the conversation has held the place through the layout as it is
 * now. Its correction runs when the browser delivers resize observations, after
 * that update's scroll events, and the browser can deliver them some frames after
 * a change is laid out, so frames alone do not say it has run. A new observer is
 * told in the next delivery, after the conversation's own observer.
 */
export async function placeHeld(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const content = document.querySelector("[data-testid=transcript]")!.firstElementChild!;
        const observer = new ResizeObserver(() => {
          observer.disconnect();
          resolve();
        });
        observer.observe(content);
      }),
  );
}

/** Stop recording; every top recorded since `watchReadingLine`, and where it is now. */
export async function readingLineSamples(page: Page): Promise<{ samples: number[]; now: number }> {
  return page.evaluate(() => {
    const watched = (window as unknown as { readingLine: Watched }).readingLine;
    watched.stop = true;
    const scroller = document.querySelector<HTMLElement>("[data-testid=transcript]")!;
    return {
      samples: watched.samples,
      now: watched.mark.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
    };
  });
}
