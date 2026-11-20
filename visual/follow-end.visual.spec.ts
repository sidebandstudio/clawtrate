// The transcript follows its end during the conversation's first layout
// (conversation.md section 18, F-468's traces): a first layout that settles
// while cards and notes are still arriving must end at the end, at every
// width, with or without the composer's menus. The phone, where the same
// content meets the narrowest view, is the case.
import { test, expect, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const PHONE = SIZES.find((size) => size.phone)!;

/** How far the transcript sits above its end. */
const shortOf = (page: Page) =>
  page.getByTestId("transcript").evaluate((element) => {
    const short = element.scrollHeight - element.scrollTop - element.clientHeight;
    return `${short} (scrollTop ${element.scrollTop} of ${element.scrollHeight - element.clientHeight})`;
  });

const SCENES: Array<{
  name: string;
  query: string;
  ready: (page: Page) => Promise<void>;
}> = [
  {
    name: "the held message and the question pending (F-468)",
    query: `scene=run-question&${OTTO_DISK}&panel=closed`,
    ready: (page) => expect(page.getByTestId("shelf-row")).toContainText("Held until you answer"),
  },
  {
    name: "the budget reached and a provider limit near",
    query: `scene=main&${OTTO_DISK}&access=write&budget=reached&plimit=near`,
    ready: async (page) => {
      await expect(page.getByTestId("budget-reached-note")).toBeVisible();
      await expect(page.getByTestId("limit-note")).toBeVisible();
    },
  },
];

for (const theme of THEMES) {
  test.describe(`first layout follows the end, phone ${theme}`, () => {
    test.use(contextFor(PHONE, theme));

    for (const scene of SCENES) {
      for (const throttle of [1, 12]) {
        test(`${scene.name}, ${throttle}× throttled`, async ({ page }) => {
          // Slowing the renderer spreads the layout over more frames, where a
          // shrink and a growth of the content can interleave with the scroll
          // events the browser reports for them.
          if (throttle > 1) {
            const session = await page.context().newCDPSession(page);
            await session.send("Emulation.setCPUThrottlingRate", { rate: throttle });
          }
          await openFixture(page, scene.query, theme);
          await scene.ready(page);
          await expect
            .poll(
              async () => (await shortOf(page)).startsWith("0"),
              `the transcript at its end: ${scene.name}, phone ${theme}, ${throttle}×`,
            )
            .toBe(true);
        });
      }
    }

    test("a reader who leaves after following is not dragged back", async ({ page }) => {
      await openFixture(page, `scene=run-question&${OTTO_DISK}&panel=closed`, theme);
      await expect(page.getByTestId("shelf-row")).toContainText("Held until you answer");
      await expect.poll(async () => (await shortOf(page)).startsWith("0")).toBe(true);
      // The reader follows the end again after the first layout has settled.
      await page.getByTestId("composer-input").click();
      await page.keyboard.type("Answering, one moment.");
      await page.keyboard.press("Backspace");
      await page.waitForTimeout(400);
      await expect.poll(async () => (await shortOf(page)).startsWith("0")).toBe(true);
      // The reader scrolls up a little and stays: a scroll the reader made is
      // never taken for a clamp under a followed end.
      const transcript = page.getByTestId("transcript");
      const top = await transcript.evaluate((element) => {
        element.scrollTop -= 30;
        return element.scrollTop;
      });
      await settle(page);
      expect(
        await transcript.evaluate((element) => element.scrollTop),
        "the reader's scroll-up holds",
      ).toBe(top);
      expect(await transcript.evaluate((element) => element.scrollTop)).toBeLessThan(
        await transcript.evaluate((element) => element.scrollHeight - element.clientHeight),
      );
    });
  });
}
