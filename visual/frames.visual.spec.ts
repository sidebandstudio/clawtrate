// The held-frames helper the focus checks rest on (visual/frames.ts): what it holds, what it
// drops, and what it sees.
import { expect, test } from "@playwright/test";
import { holdFrames, releaseFrames, tabThenRelease } from "./frames.ts";

type Ran = { ran: string[] };

test("held frames: a frame cancelled while held, or after release before it runs, never runs", async ({
  page,
}) => {
  await page.setContent("<p>Frames</p>");
  await holdFrames(page);
  await page.evaluate(() => {
    const w = window as unknown as Ran & { late: number };
    w.ran = [];
    const early = requestAnimationFrame(() => w.ran.push("cancelled while held"));
    requestAnimationFrame(() => w.ran.push("kept"));
    w.late = requestAnimationFrame(() => w.ran.push("cancelled after release"));
    // Each held frame has its own id.
    if (early === w.late) throw new Error("two held frames share an id");
    cancelAnimationFrame(early);
  });
  // Released, and cancelled again before the browser runs it.
  await page.evaluate(() => {
    const w = window as unknown as { releaseFrames: () => void; late: number };
    w.releaseFrames();
    cancelAnimationFrame(w.late);
  });
  await releaseFrames(page);
  expect(await page.evaluate(() => (window as unknown as Ran).ran)).toEqual(["kept"]);
});

test("held frames: Tab then release fails when a frame moves focus away and back", async ({
  page,
}) => {
  await page.setContent('<button id="start">Start</button><button id="next">Next</button>');
  await page.locator("#start").focus();
  await holdFrames(page);
  // A late focus move that ends where Tab put it: away to Start, then back to Next.
  await page.evaluate(() =>
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      requestAnimationFrame(() => {
        document.getElementById("start")!.focus();
        requestAnimationFrame(() => document.getElementById("next")!.focus());
      });
    }),
  );
  await page.keyboard.press("Enter");
  await expect(tabThenRelease(page, page.locator("#next"))).rejects.toThrow(
    /the held frames move focus nowhere/,
  );
  await expect(page.locator("#next")).toBeFocused();
});
