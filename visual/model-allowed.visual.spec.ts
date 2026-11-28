// A bot's model and the model list that limits it (#799), in Otto's settings: the line after
// Clawtrate put Otto's model on the list, with Undo, and the line for a bot whose own model the
// list refuses, with "Allow gpt-5.5" for a connection with admin access. Every name is invented.
import { test } from "@playwright/test";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const SETTINGS = `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=bound`;

const SCENES = [
  { name: "model-allowed-line", query: `${SETTINGS}&modellist=added` },
  { name: "model-refused-line", query: `${SETTINGS}&modellist=refused` },
];

for (const size of [SIZES[0]!, SIZES.at(-1)!]) {
  for (const theme of THEMES) {
    test.describe(`model list ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const scene of SCENES) {
        test(`F-042 #799: ${scene.name} matches its baseline, ${theme}, ${size.name}`, async ({
          page,
        }) => {
          await openFixture(page, scene.query, theme);
          const settings = page.getByTestId("bot-settings");
          await expect(settings).toBeVisible();
          // The Model group, where the line stands (and stood, without it, before #799).
          await settings.getByTestId("model-select").scrollIntoViewIfNeeded();
          await settle(page);
          await expect(page).toHaveScreenshot(`${scene.name}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}

test.describe("the model list's line", () => {
  test.use(contextFor(SIZES[0]!));

  test("F-042 #799: Allow puts the model on the list and says so, and Undo takes it out again", async ({
    page,
  }) => {
    await openFixture(page, `${SETTINGS}&modellist=refused`);
    const settings = page.getByTestId("bot-settings");
    await expect(settings.getByTestId("model-refused")).toHaveText(
      "Otto can't start tasks on OpenAI's gpt-5.5: this gateway's model list doesn't include it. Allow gpt-5.5",
    );
    await settings.getByRole("button", { name: "Allow OpenAI's gpt-5.5 for Otto's tasks" }).click();
    await expect(settings.getByTestId("model-allowed")).toHaveText(
      "Added OpenAI's gpt-5.5 to the models this gateway allows. · Undo",
    );
    await settings
      .getByRole("button", { name: "Undo: take OpenAI's gpt-5.5 out of the list again" })
      .click();
    await expect(settings.getByTestId("model-refused")).toBeVisible();
    await expect(settings.getByTestId("model-allowed")).toHaveCount(0);
  });

  test("F-042 #799: a failed Undo says so and stays offered; one the host refused says why", async ({
    page,
  }) => {
    await openFixture(page, `${SETTINGS}&modellist=added&undo=failed`);
    const line = page.getByTestId("bot-settings").getByTestId("model-allowed");
    const undo = line.getByRole("button", { name: /^Undo: take OpenAI's gpt-5\.5 out/ });
    await undo.click();
    await expect(line).toHaveText(
      "Couldn't take OpenAI's gpt-5.5 out of the models this gateway allows: gateway request timeout for config.patch · Undo",
    );
    await expect(undo).toBeEnabled();
    await openFixture(page, `${SETTINGS}&modellist=added&undo=refused`);
    await page
      .getByTestId("bot-settings")
      .getByTestId("model-allowed")
      .getByRole("button", { name: /^Undo/ })
      .click();
    await expect(page.getByTestId("bot-settings").getByTestId("model-allowed")).toHaveText(
      "Added OpenAI's gpt-5.5 to the models this gateway allows. · Undo Couldn't undo it: The gateway this screen showed is no longer connected.",
    );
  });

  test("F-042 #799: without admin access, the reason and no button", async ({ page }) => {
    await openFixture(
      page,
      `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=write&lock=bound&modellist=refused`,
    );
    const refused = page.getByTestId("bot-settings").getByTestId("model-refused");
    await expect(refused).toHaveText(
      "Otto can't start tasks on OpenAI's gpt-5.5: this gateway's model list doesn't include it.",
    );
    await expect(refused.getByRole("button")).toHaveCount(0);
  });
});
