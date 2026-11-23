// Your files on your own message (#451), and a picture opened larger (F-117's
// first slice): your message with a picture this app holds, with a text file,
// and with a picture sent from another device, then the picture opened over the
// app, at 1440 and phone width in both themes. The scene is written in the
// gateway's own shapes (apps/desktop/src/fixture/pictures.ts); the live check is
// e2e/ui-pictures.spec.ts.
import { test, type Page } from "@playwright/test";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

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

      test("#451: your message with a picture, a file and a picture from elsewhere matches its baseline", async ({
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

  test("#451: your picture is drawn from the app's own copy, a file is its name and size, and a picture this app doesn't hold says so; your words stay as written", async ({
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
    await expect(notes.getByTestId("sent-file")).toHaveText(/notes\.txt\s*2 KB/);
    await expect(notes.getByRole("img")).toHaveCount(0);
    const elsewhere = page.getByTestId("transcript-turn").filter({ hasText: "from my phone" });
    await expect(elsewhere.getByTestId("sent-picture")).toHaveAttribute("data-state", "not-kept");
    await expect(elsewhere.getByTestId("sent-picture")).toContainText(
      "receipt.jpg47 KBPicture sent with this message. The gateway doesn't give it back to show here.",
    );
    expect(await sent(page)).toEqual([
      {
        type: "readSentPicture",
        key: "agent:otto:disk-space",
        messageKey: "sent-1:user",
        index: 0,
      },
      {
        type: "readSentPicture",
        key: "agent:otto:disk-space",
        messageKey: "elsewhere-1:user",
        index: 0,
      },
    ]);
    expect(media).toEqual([]);
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
    await page.keyboard.press("Escape");
    await expect(viewer(page)).toHaveCount(0);
    await expect(preview(page)).toBeFocused();
    // Close, the visible button, does the same; so does the backdrop.
    await preview(page).click();
    await close.click();
    await expect(viewer(page)).toHaveCount(0);
    await expect(preview(page)).toBeFocused();
    await preview(page).click();
    await page.getByTestId("picture-viewer").click({ position: { x: 8, y: 400 } });
    await expect(viewer(page)).toHaveCount(0);
    // Opening it larger asks for nothing more.
    expect((await sent(page)).length).toBe(2);
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
