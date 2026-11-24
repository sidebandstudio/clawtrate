// Your files on your own message (#451), and a picture opened larger (F-117's
// first slice): your message with a picture this app holds, with a text file,
// and with a picture sent from another device, then the picture opened over the
// app, at 1440 and phone width in both themes. The scene is written in the
// gateway's own shapes (apps/desktop/src/fixture/pictures.ts); the live check is
// e2e/ui-pictures.spec.ts.
import { test, type Page } from "@playwright/test";
import type { ClawtrateState } from "../packages/core/src/types.ts";
import {
  contextFor,
  expect,
  hold,
  release,
  openFixture,
  OTTO_DISK,
  settle,
  SIZES,
  THEMES,
} from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;
const MINE = "Your picture: calendar.png";
const BOTS = "Picture made from the description: A sun over a green hill, in flat solid colours";

const open = (page: Page, scene: string, theme: "light" | "dark") =>
  openFixture(page, `scene=${scene}&${OTTO_DISK}&panel=closed`, theme);
const sent = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: Array<{ type: string }> } }
    ).clawtrateFixture.sent.filter((command) => command.type.endsWith("Picture")),
  );
const preview = (page: Page) => page.getByRole("button", { name: MINE });
const viewer = (page: Page) => page.getByRole("dialog", { name: MINE });

/** A click on the backdrop halfway between the window's left edge and the picture, never the gutter. */
async function clickBeside(page: Page) {
  const box = (await viewer(page).getByRole("img", { name: MINE }).boundingBox())!;
  const x = box.x / 2;
  expect(x).toBeGreaterThan(40);
  await page.mouse.click(x, box.y + box.height / 2);
}

async function drawn(page: Page, name: string) {
  await expect
    .poll(() =>
      page
        .getByRole("img", { name })
        .first()
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true);
}

for (const size of [WIDE, PHONE]) {
  for (const theme of THEMES) {
    test.describe(`sent pictures ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));

      test("F-557: your message with a picture, a file and a picture from elsewhere matches its baseline", async ({
        page,
      }) => {
        await open(page, "pictures-sent", theme);
        await drawn(page, MINE);
        await page.getByTestId("sent-files").last().scrollIntoViewIfNeeded();
        await settle(page);
        await expect(page).toHaveScreenshot(`sent-pictures-${theme}-${size.name}.png`);
      });

      test("F-117: your picture opened larger matches its baseline", async ({ page }) => {
        await open(page, "pictures-sent", theme);
        await drawn(page, MINE);
        await preview(page).click();
        await expect(viewer(page)).toBeVisible();
        await drawn(page, MINE);
        await settle(page);
        await expect(page).toHaveScreenshot(`sent-pictures-viewer-${theme}-${size.name}.png`);
      });
    });
  }
}

test.describe("sent pictures behaviour", () => {
  test.use(contextFor(WIDE, "dark"));

  test("F-557: your picture is drawn from the app's own copy, a file is its name and size, and a picture this app doesn't hold says so; your words stay as written", async ({
    page,
  }) => {
    const media: string[] = [];
    page.on("request", (request) => {
      if (/\/api\/chat\/media\/|media:\/\//.test(request.url())) media.push(request.url());
    });
    await open(page, "pictures-sent", "dark");
    const mine = page
      .getByTestId("transcript-turn")
      .filter({ hasText: "can u add this to my calendar?" });
    await expect(mine.getByTestId("sent-picture")).toHaveAttribute("data-state", "shown");
    expect(await mine.getByRole("img", { name: MINE }).getAttribute("src")).toMatch(
      /^data:image\/png;base64,iVBORw0KGgo/,
    );
    // The bubble holds exactly the words typed.
    await expect(mine.locator(".bubble")).toHaveText("can u add this to my calendar?");
    const notes = page.getByTestId("transcript-turn").filter({ hasText: "here are my notes" });
    // A text file, and a file named as a picture whose bytes aren't one: each a named file.
    await expect(notes.getByTestId("sent-file")).toHaveText([
      /notes\.txt\s*2 KB/,
      /scan\.png\s*3 KB/,
    ]);
    await expect(notes.getByRole("img")).toHaveCount(0);
    const elsewhere = page.getByTestId("transcript-turn").filter({ hasText: "from my phone" });
    await expect(elsewhere.getByTestId("sent-picture")).toHaveAttribute("data-state", "not-kept");
    await expect(elsewhere.getByTestId("sent-picture")).toContainText(
      "receipt.jpg47 KBPicture sent with this message. It shows only on the device that sent it, while the task is open.",
    );
    expect(await sent(page)).toEqual([
      {
        type: "readSentPicture",
        key: "agent:otto:disk-space",
        messageKey: "sent-1:user",
        sessionId: "otto-disk-space",
        index: 0,
      },
      {
        type: "readSentPicture",
        key: "agent:otto:disk-space",
        messageKey: "sent-2:user",
        sessionId: "otto-disk-space",
        index: 1,
      },
      {
        type: "readSentPicture",
        key: "agent:otto:disk-space",
        messageKey: "elsewhere-1:user",
        sessionId: "otto-disk-space",
        index: 0,
      },
    ]);
    expect(media).toEqual([]);
  });

  test("F-557: replacing the session drops the drawn picture even when the history row has the same id", async ({
    page,
  }) => {
    await open(page, "pictures-sent", "dark");
    await drawn(page, MINE);
    await hold(page);
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: {
            setState: (change: (state: ClawtrateState) => ClawtrateState) => void;
          };
        }
      ).clawtrateFixture;
      const key = "agent:otto:disk-space";
      fixture.setState((state) => ({
        ...state,
        transcripts: {
          ...state.transcripts,
          [key]: { ...state.transcripts[key]!, sessionId: "replacement" },
        },
      }));
    });
    const picture = page.getByTestId("sent-picture").filter({ hasText: "calendar.png" });
    await expect
      .poll(
        async () =>
          (await sent(page)).filter(
            (command) => "sessionId" in command && command.sessionId === "replacement",
          ).length,
      )
      .toBeGreaterThan(0);
    await expect(page.getByRole("img", { name: MINE })).toHaveCount(0);
    await expect(picture).toHaveAttribute("data-state", "loading");
    await release(page);
    await expect(picture).toHaveAttribute("data-state", "not-kept");
  });

  test("F-117: Tab reaches the preview, Enter opens it over the app with its text, focus stays inside, and Escape closes it back to the preview", async ({
    page,
  }) => {
    await open(page, "pictures-sent", "dark");
    await drawn(page, MINE);
    let reached = false;
    for (let presses = 0; presses < 60 && !reached; presses += 1) {
      await page.keyboard.press("Tab");
      reached = await preview(page).evaluate((element) => element === document.activeElement);
    }
    expect(reached).toBe(true);
    await page.keyboard.press("Enter");
    await expect(viewer(page)).toBeVisible();
    await expect(viewer(page).getByRole("img", { name: MINE })).toBeVisible();
    const close = viewer(page).getByRole("button", { name: "Close", exact: true });
    await expect(close).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();
    // The app's shortcuts don't act behind the open view: no switch of bot, no search, no sheet.
    for (const shortcut of [
      "Control+Tab",
      "Alt+ArrowDown",
      "ControlOrMeta+2",
      "ControlOrMeta+Shift+F",
      "ControlOrMeta+/",
    ]) {
      await page.keyboard.press(shortcut);
      await expect(viewer(page), shortcut).toBeVisible();
      await expect(close, shortcut).toBeFocused();
    }
    await page.keyboard.press("Escape");
    await expect(viewer(page)).toHaveCount(0);
    await expect(preview(page)).toBeFocused();
    // Close, the visible button, does the same; so does the backdrop.
    await preview(page).click();
    await close.click();
    await expect(viewer(page)).toHaveCount(0);
    await expect(preview(page)).toBeFocused();
    await preview(page).click();
    await clickBeside(page);
    await expect(viewer(page)).toHaveCount(0);
    // Opening it larger asks for nothing more.
    expect((await sent(page)).length).toBe(3);
  });

  test("F-117: a click on the picture keeps the view open, and Escape still closes it back to the preview", async ({
    page,
  }) => {
    await open(page, "pictures-sent", "dark");
    await drawn(page, MINE);
    await preview(page).click();
    await viewer(page).getByRole("img", { name: MINE }).click();
    await expect(viewer(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewer(page)).toHaveCount(0);
    await expect(preview(page)).toBeFocused();
  });

  test("F-117: a click on the backdrop beside the picture closes the view", async ({ page }) => {
    await open(page, "pictures-sent", "dark");
    await drawn(page, MINE);
    await preview(page).click();
    await expect(viewer(page)).toBeVisible();
    await clickBeside(page);
    await expect(viewer(page)).toHaveCount(0);
    await expect(preview(page)).toBeFocused();
  });

  test("F-117: a small picture is shown at its own size, not enlarged", async ({ page }) => {
    await open(page, "pictures-sent", "dark");
    await drawn(page, MINE);
    await preview(page).click();
    const img = viewer(page).getByRole("img", { name: MINE });
    await expect(img).toBeVisible();
    expect(
      await img.evaluate((element: HTMLImageElement) => [
        element.clientWidth,
        element.clientHeight,
        element.naturalWidth,
        element.naturalHeight,
      ]),
    ).toEqual([240, 160, 240, 160]);
  });

  test("F-117: a bot's picture opens larger the same way", async ({ page }) => {
    await open(page, "pictures", "dark");
    await drawn(page, BOTS);
    await page.getByRole("button", { name: BOTS }).press("Enter");
    const dialog = page.getByRole("dialog", { name: BOTS });
    await expect(dialog.getByRole("img", { name: BOTS })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: BOTS })).toBeFocused();
  });
});
