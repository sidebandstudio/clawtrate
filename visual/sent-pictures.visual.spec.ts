// Your files on your own message (#451), and a picture opened larger (F-117's
// first slice): your message with a picture this app holds, with a text file,
// and with a picture sent from another device that this loopback connection
// can't load back, then the picture opened over the app; and, on another device
// of yours, pictures read back from the gateway (#469): shown, no longer kept,
// failed with Try again, and loading. At 1440 and phone width in both themes.
// The scenes are written in the gateway's own shapes
// (apps/desktop/src/fixture/pictures.ts); the live check is e2e/ui-pictures.spec.ts.
import { test, type Page } from "@playwright/test";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;
const MINE = "Your picture: calendar.png";
const BOTS = "Picture made from the description: A sun over a green hill, in flat solid colours";

const open = (page: Page, scene: string, theme: "light" | "dark") =>
  openFixture(page, `scene=${scene}&${OTTO_DISK}&panel=closed`, theme);
/** The picture commands the page sent, each with the stamp it carried set apart. */
const sent = async (page: Page) => {
  const commands = await page.evaluate(() =>
    (
      window as unknown as {
        clawtrateFixture: {
          sent: Array<{ type: string; messageKey?: string; stamp?: { gatewayId: string } }>;
        };
      }
    ).clawtrateFixture.sent.filter((command) => command.type.endsWith("Picture")),
  );
  // Each read of your picture names the gateway its conversation was drawn for.
  for (const command of commands)
    if (command.type === "readSentPicture")
      // The fixture gateway's identity (apps/desktop/src/fixture/bridge-fixture.ts).
      expect(command.stamp?.gatewayId).toMatch(/^6f3b0d2e[0-9a-f]{56}$/);
  return commands.map(({ stamp: _stamp, ...command }) => command);
};
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

      test("F-557: on another device, pictures read back, no longer kept, failed and loading match their baseline", async ({
        page,
      }) => {
        await open(page, "pictures-sent-back", theme);
        await drawn(page, MINE);
        await expect(page.getByTestId("sent-picture")).toHaveCount(4);
        await expect(page.locator('[data-testid="sent-picture"][data-state="failed"]')).toHaveCount(
          1,
        );
        await page.getByTestId("sent-files").last().scrollIntoViewIfNeeded();
        await settle(page);
        await expect(page).toHaveScreenshot(`sent-pictures-back-${theme}-${size.name}.png`);
      });
    });
  }
}

test.describe("sent pictures behaviour", () => {
  test.use(contextFor(WIDE, "dark"));

  test("F-557: your picture is drawn from the app's own copy, a file is its name and size, and a picture this connection can't load back says so; your words stay as written", async ({
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
    await expect(elsewhere.getByTestId("sent-picture")).toHaveAttribute(
      "data-state",
      "cannot-load",
    );
    await expect(elsewhere.getByTestId("sent-picture")).toContainText(
      "receipt.jpg47 KBThis connection can't load the picture back from the gateway.",
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
        messageKey: "sent-2:user",
        index: 1,
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

  test("F-557: on another device, a picture read back shows and opens larger; one the gateway no longer keeps says so; a failed read shows after Try again; one on its way is a quiet placeholder", async ({
    page,
  }) => {
    await open(page, "pictures-sent-back", "dark");
    const turn = (text: string) =>
      page.getByTestId("transcript-turn").filter({ hasText: text }).getByTestId("sent-picture");
    await expect(turn("the calendar from this morning")).toHaveAttribute("data-state", "shown");
    await expect(turn("the flyer from last month")).toHaveAttribute("data-state", "gone");
    await expect(turn("the flyer from last month")).toContainText(
      "flyer.png1 KBThe gateway no longer keeps this picture.",
    );
    await expect(turn("the flyer from last month").getByRole("button")).toHaveCount(0);
    const failed = turn("my boarding pass");
    await expect(failed).toHaveAttribute("data-state", "failed");
    await expect(failed).toContainText("pass.png1 KBThe picture didn't load.Try again");
    const late = turn("and the map");
    await expect(late).toHaveAttribute("data-state", "loading");
    await expect(late).toHaveAttribute("aria-busy", "true");
    await expect(late).toHaveText("Loading Your picture: map.png");
    await expect(late.locator(".sent-file-note")).toHaveCount(0);
    await failed.getByRole("button", { name: "Try again" }).click();
    await expect(turn("my boarding pass")).toHaveAttribute("data-state", "shown");
    await expect(page.getByRole("img", { name: "Your picture: pass.png" })).toBeVisible();
    // A picture read back opens larger the same way.
    await page.getByRole("button", { name: MINE }).click();
    await expect(viewer(page).getByRole("img", { name: MINE })).toBeVisible();
    await page.keyboard.press("Escape");
    // Each read once it came on screen, in whatever order; the boarding pass twice: Try again.
    expect((await sent(page)).map((command) => command.messageKey).sort()).toEqual([
      "back-1:user",
      "failed-1:user",
      "failed-1:user",
      "gone-1:user",
      "late-1:user",
    ]);
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
