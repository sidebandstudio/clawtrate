// A file a bot handed over that isn't a picture, under its message (F-115): a
// row with a document icon, the file's name and size, and Save. Each state
// matches its baseline at 1440 and phone width in both themes: ready, too
// large, not handed over, failed, saving and saved. The scene is written in the
// gateway's own shapes (apps/desktop/src/fixture/bot-files.ts); the live check
// is e2e/ui-bot-files.spec.ts.
import { test, type Page } from "@playwright/test";
import { reviewsDraftPdf } from "../tools/dev-gateway/src/scripted-files.ts";
import {
  contextFor,
  expect,
  hold,
  openFixture,
  OTTO_DISK,
  release,
  settle,
  SIZES,
  THEMES,
} from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;

const open = (page: Page, theme: "light" | "dark") =>
  openFixture(page, `scene=bot-files&${OTTO_DISK}&panel=closed`, theme);
const row = (page: Page, name: string) =>
  page.getByTestId("bot-file").filter({ has: page.getByText(name, { exact: true }) });
type Connection = { gatewayId: string | null };
type Fixture = {
  clawtrateFixture: {
    sent: Array<{ type: string; stamp?: { gatewayId: string | null } }>;
    savedFiles: Array<{ name: string; data: string }>;
    getState(): { connection: Connection };
    setState(change: (state: { connection: Connection }) => { connection: Connection }): void;
  };
};
/** The same place whatever a click scrolled before: the PDF's row in the middle of the view. */
const centre = async (page: Page) => {
  // Nothing hovered or focused, so no message's actions show; the follow-to-end has settled.
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(page);
  await row(page, "reviews-draft.pdf").evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
};
const reads = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as Fixture).clawtrateFixture.sent.filter(
      (command) => command.type === "readChatFile",
    ),
  );
const saved = (page: Page) =>
  page.evaluate(() => (window as unknown as Fixture).clawtrateFixture.savedFiles);

for (const size of [WIDE, PHONE]) {
  for (const theme of THEMES) {
    test.describe(`bot files ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));

      test("F-115: ready, too large and not handed over match their baseline", async ({ page }) => {
        await open(page, theme);
        await expect(row(page, "reviews-draft.pdf")).toHaveAttribute("data-state", "ready");
        await centre(page);
        await settle(page);
        await expect(page).toHaveScreenshot(`bot-files-ready-${theme}-${size.name}.png`);
      });

      test("F-115: failed and saving match their baseline, then saved", async ({ page }) => {
        await open(page, theme);
        await row(page, "reviews.txt").getByRole("button", { name: "Save reviews.txt" }).click();
        await expect(row(page, "reviews.txt")).toHaveAttribute("data-state", "failed");
        await hold(page);
        await row(page, "reviews-draft.pdf")
          .getByRole("button", { name: "Save reviews-draft.pdf" })
          .click();
        await expect(row(page, "reviews-draft.pdf")).toHaveAttribute("data-state", "saving");
        await centre(page);
        await settle(page);
        await expect(page).toHaveScreenshot(`bot-files-failed-saving-${theme}-${size.name}.png`);
        await release(page);
        await expect(row(page, "reviews-draft.pdf")).toHaveAttribute("data-state", "saved");
        await centre(page);
        await settle(page);
        await expect(page).toHaveScreenshot(`bot-files-saved-${theme}-${size.name}.png`);
      });
    });
  }
}

test.describe("bot files behaviour", () => {
  test.use(contextFor(WIDE, "dark"));

  test("F-115: Save carries the stamp of the gateway that drew the row, not the one connected now", async ({
    page,
  }) => {
    await open(page, "dark");
    await expect(row(page, "reviews-draft.pdf")).toBeVisible();
    const drawn = await page.evaluate(
      () => (window as unknown as Fixture).clawtrateFixture.getState().connection.gatewayId,
    );
    await page.evaluate(() =>
      (window as unknown as Fixture).clawtrateFixture.setState((state) => ({
        ...state,
        connection: { ...state.connection, gatewayId: "another-gateway" },
      })),
    );
    await row(page, "reviews-draft.pdf")
      .getByRole("button", { name: "Save reviews-draft.pdf" })
      .click();
    await expect
      .poll(async () =>
        (
          await page.evaluate(() =>
            (window as unknown as Fixture).clawtrateFixture.sent.filter(
              (command) => command.type === "readChatFile",
            ),
          )
        ).map((command) => command.stamp?.gatewayId),
      )
      .toEqual([drawn]);
  });

  test("F-115: each file shows under the message that carried it, in its order, and nothing is read before Save", async ({
    page,
  }) => {
    const media: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/chat/media/")) media.push(request.url());
    });
    await open(page, "dark");
    const turn = page
      .getByTestId("transcript-turn")
      .filter({ hasText: "Both reviews are in this two-page draft." });
    await expect(turn.getByTestId("bot-file")).toHaveCount(5);
    expect(await turn.getByTestId("bot-file").locator(".bot-file-name").allTextContents()).toEqual([
      "reviews-draft.pdf",
      "reviews.txt",
      "trail-photos.zip",
      "voice-note.wav",
      "gps-track.bin",
    ]);
    // Under the bubble of the message that carried them.
    const bubble = (await turn
      .getByText("Both reviews are in this two-page draft.")
      .boundingBox())!;
    const first = (await row(page, "reviews-draft.pdf").boundingBox())!;
    expect(first.y).toBeGreaterThan(bubble.y);
    await expect(row(page, "reviews-draft.pdf")).toContainText("1 KB · application/pdf");
    await expect(row(page, "trail-photos.zip")).toHaveAttribute("data-state", "too-large");
    await expect(row(page, "trail-photos.zip")).toContainText(
      "Too large to save here: Clawtrate saves files up to 5 MB.",
    );
    await expect(row(page, "trail-photos.zip").getByRole("button")).toHaveCount(0);
    await expect(row(page, "gps-track.bin")).toHaveAttribute("data-state", "unreadable");
    await expect(row(page, "gps-track.bin")).toContainText(
      "The gateway didn't hand this file over, so it can't be saved.",
    );
    await expect(row(page, "voice-note.wav")).toHaveAttribute("data-state", "ready");
    // A message that is only a file still shows it.
    await expect(row(page, "route.csv")).toBeVisible();
    expect(await reads(page)).toEqual([]);
    expect(media).toEqual([]);
  });

  test("F-115: Save reads the file through the host, hands its exact bytes to the host's save under its name, and says Saved only once the host has", async ({
    page,
  }) => {
    await open(page, "dark");
    const pdf = row(page, "reviews-draft.pdf");
    // Each row's live region is in the page before anything is said, with one role throughout.
    const status = pdf.getByRole("status");
    await expect(status).toHaveText("");
    expect(await status.evaluate((element) => getComputedStyle(element).display)).not.toBe("none");
    await hold(page);
    const save = pdf.getByRole("button", { name: "Save reviews-draft.pdf" });
    await save.focus();
    await page.keyboard.press("Enter");
    await expect(status).toHaveText("Saving…");
    // Not disabled, so it keeps the focus; pressing it again does nothing.
    await expect(save).toHaveAttribute("aria-disabled", "true");
    await expect(save).toBeFocused();
    await page.keyboard.press("Enter");
    expect(await saved(page)).toEqual([]);
    await release(page);
    await expect(status).toHaveText("Saved.");
    await expect(save).toBeFocused();
    await expect(save).not.toHaveAttribute("aria-disabled");
    expect(await reads(page)).toEqual([
      {
        type: "readChatFile",
        key: "agent:otto:disk-space",
        artifactId: "artifact_managed_media_470797d5-f45d-444a-901d-21a6bd2c2f96",
        stamp: { gatewayId: expect.any(String), target: expect.any(Number) },
      },
    ]);
    const [file] = await saved(page);
    expect(file!.name).toBe("reviews-draft.pdf");
    expect(Buffer.from(file!.data, "base64").toString("latin1")).toBe(reviewsDraftPdf());

    // A read that fails says why in the same live region, and Save keeps the focus to try again.
    const notes = row(page, "reviews.txt");
    const retry = notes.getByRole("button", { name: "Save reviews.txt" });
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(notes.getByRole("status")).toHaveText(
      "Couldn't save it. The gateway answered 404 for this file.",
    );
    await expect(notes.getByRole("alert")).toHaveCount(0);
    await expect(retry).toBeFocused();
    await expect(retry).toBeEnabled();
    expect((await saved(page)).map((each) => each.name)).toEqual(["reviews-draft.pdf"]);
  });
});
