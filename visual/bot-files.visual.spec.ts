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
type Fixture = {
  clawtrateFixture: {
    sent: Array<{ type: string }>;
    savedFiles: Array<{ name: string; data: string }>;
  };
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
        await row(page, "reviews-draft.pdf").scrollIntoViewIfNeeded();
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
        await row(page, "reviews-draft.pdf").scrollIntoViewIfNeeded();
        await settle(page);
        await expect(page).toHaveScreenshot(`bot-files-failed-saving-${theme}-${size.name}.png`);
        await release(page);
        await expect(row(page, "reviews-draft.pdf")).toHaveAttribute("data-state", "saved");
        await settle(page);
        await expect(page).toHaveScreenshot(`bot-files-saved-${theme}-${size.name}.png`);
      });
    });
  }
}

test.describe("bot files behaviour", () => {
  test.use(contextFor(WIDE, "dark"));

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
    await hold(page);
    const save = pdf.getByRole("button", { name: "Save reviews-draft.pdf" });
    await save.focus();
    await page.keyboard.press("Enter");
    await expect(pdf.getByRole("status")).toHaveText("Saving…");
    await expect(save).toBeDisabled();
    expect(await saved(page)).toEqual([]);
    await release(page);
    await expect(pdf.getByRole("status")).toHaveText("Saved.");
    expect(await reads(page)).toEqual([
      {
        type: "readChatFile",
        key: "agent:otto:disk-space",
        artifactId: "artifact_managed_media_470797d5-f45d-444a-901d-21a6bd2c2f96",
      },
    ]);
    const [file] = await saved(page);
    expect(file!.name).toBe("reviews-draft.pdf");
    expect(Buffer.from(file!.data, "base64").toString("latin1")).toBe(reviewsDraftPdf());

    // A read that fails says why, as an alert, and Save stays to try again.
    const notes = row(page, "reviews.txt");
    await notes.getByRole("button", { name: "Save reviews.txt" }).click();
    await expect(notes.getByRole("alert")).toHaveText(
      "Couldn't save it. The gateway answered 404 for this file.",
    );
    await expect(notes.getByRole("button", { name: "Save reviews.txt" })).toBeEnabled();
    expect((await saved(page)).map((each) => each.name)).toEqual(["reviews-draft.pdf"]);
  });
});
