// A picture a bot made, in the conversation (F-535): it matches its baseline at
// 1440 and phone width in both themes, loaded and failed, and it is drawn only
// from what the host read through the gateway's download. The scene is written
// in the gateway's own shapes (apps/desktop/src/fixture/pictures.ts); the live
// check is e2e/ui-pictures.spec.ts.
import { test, type Page } from "@playwright/test";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;
const ALT = "Picture made from the description: A sun over a green hill, in flat solid colours";

const open = (page: Page, scene: string, theme: "light" | "dark") =>
  openFixture(page, `scene=${scene}&${OTTO_DISK}&panel=closed`, theme);
const picture = (page: Page) => page.getByTestId("picture");
const sent = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: Array<{ type: string }> } }
    ).clawtrateFixture.sent.filter((command) => command.type === "readChatPicture"),
  );

for (const size of [WIDE, PHONE]) {
  for (const theme of THEMES) {
    test.describe(`pictures ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      const scenes =
        size === WIDE
          ? ["pictures", "pictures-failed", "pictures-message"]
          : ["pictures", "pictures-message"];
      for (const scene of scenes) {
        test(`F-535: ${scene} matches its baseline`, async ({ page }) => {
          await open(page, scene, theme);
          await expect(picture(page)).toHaveAttribute(
            "data-state",
            scene === "pictures-failed" ? "failed" : "shown",
          );
          if (scene !== "pictures-failed")
            await expect
              .poll(() =>
                picture(page)
                  .getByRole("img")
                  .evaluate((img: HTMLImageElement) => img.complete),
              )
              .toBe(true);
          await picture(page).scrollIntoViewIfNeeded();
          await settle(page);
          await expect(page).toHaveScreenshot(`pictures-${scene}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}

test.describe("pictures behaviour", () => {
  test.use(contextFor(WIDE, "dark"));

  test("F-535: the picture is drawn under the gateway's turn from the host's read, with its description as its text, and the address its message names is never loaded", async ({
    page,
  }) => {
    const media: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/chat/media/")) media.push(request.url());
    });
    await open(page, "pictures", "dark");
    const turn = page
      .getByTestId("transcript-turn")
      .filter({ hasText: "Here is the picture you asked for." });
    const img = turn.getByRole("img", { name: ALT });
    await expect(img).toBeVisible();
    expect(await img.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(256);
    expect(await img.getAttribute("src")).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
    expect(await sent(page)).toEqual([
      {
        type: "readChatPicture",
        key: "agent:otto:disk-space",
        artifactId: "artifact_managed_image_2de197ca-510c-4299-bd7a-ded7fe92de0c",
      },
    ]);
    expect(media).toEqual([]);
    // The turn that asked for it shows its card and no picture.
    await expect(
      page
        .getByTestId("transcript-turn")
        .filter({ hasText: "I asked for the picture" })
        .getByTestId("picture"),
    ).toHaveCount(0);
  });

  test("F-535: a picture sent with the message tool is drawn under that message's bubble, before the bot's next words, once", async ({
    page,
  }) => {
    await open(page, "pictures-message", "dark");
    const turn = page.getByTestId("transcript-turn").filter({ hasText: "Here is the picture." });
    const img = turn.getByRole("img", { name: "A picture the bot handed over" });
    await expect(img).toBeVisible();
    await expect(turn.getByTestId("picture")).toHaveCount(1);
    // Under the message's bubble, and above the line the bot said after sending it.
    const bubble = (await turn.getByText("Here is the picture.").boundingBox())!;
    const shown = (await img.boundingBox())!;
    const after = (await turn.getByText("It fits the top of the newsletter.").boundingBox())!;
    expect(shown.y).toBeGreaterThan(bubble.y);
    expect(shown.y + shown.height).toBeLessThan(after.y);
    expect(await sent(page)).toEqual([
      {
        type: "readChatPicture",
        key: "agent:otto:disk-space",
        artifactId: "artifact_managed_image_fbabd0fe-ab39-4db6-88ba-6bb4bb348ea3",
      },
    ]);
  });

  test("F-535: a picture that can't be loaded says why, and Try again shows it", async ({
    page,
  }) => {
    await open(page, "pictures-failed", "dark");
    const alert = picture(page).getByRole("alert");
    await expect(alert).toHaveText(
      "Couldn't show the picture. The gateway refused this picture's download ticket.Try again",
    );
    await expect(page.getByRole("img", { name: ALT })).toHaveCount(0);
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("img", { name: ALT })).toBeVisible();
    expect(await sent(page)).toHaveLength(2);
  });
});
