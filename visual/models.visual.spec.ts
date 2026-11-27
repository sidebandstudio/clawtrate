// Settings › Models (docs/design/gateway-settings.md section 4.1): the default model every bot
// uses with the account it runs on, its backups and each bot's model; a change with its line and
// "Put back"; the line when another device changed it since; a change that waits for one press,
// in the words of each OpenClaw version; and the section read-only without admin. Dark first,
// then light for the section and a change, at the widest desktop size and at phone width.
import { test, type Page } from "@playwright/test";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES } from "./fixture.ts";

type Scene = { name: string; query: string; ready: (page: Page) => Promise<void> };

const ADMIN = `scene=main&${OTTO_DISK}&access=admin`;

/** Settings, on Models. */
async function models(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Models", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Models", level: 3 })).toBeVisible();
}

/** Models, after choosing another default model: the line with Put back. */
async function changed(page: Page) {
  await models(page);
  await page
    .getByRole("combobox", { name: /Default model/ })
    .selectOption("openai/gpt-5.5-mini@openai:home");
  await expect(page.getByRole("button", { name: /^Put back / })).toBeVisible();
}

const SCENES: Scene[] = [
  { name: "settings-models", query: ADMIN, ready: models },
  { name: "settings-models-changed", query: ADMIN, ready: changed },
  { name: "settings-models-since", query: `${ADMIN}&models=since`, ready: models },
  // OpenClaw 2026.10.6 restarts by itself after a change with reload off.
  { name: "settings-models-held", query: `${ADMIN}&models=held`, ready: models },
  // OpenClaw 2026.11.10 saves it and applies it at its next start.
  {
    name: "settings-models-held-next-start",
    query: `${ADMIN}&models=held&version=2026.11.10`,
    ready: models,
  },
  { name: "settings-models-read", query: `scene=main&${OTTO_DISK}&access=read`, ready: models },
];

/** Light too, for the section and a change: the others differ from dark only in colour. */
const LIGHT = new Set(["settings-models", "settings-models-changed"]);

for (const size of SIZES.filter((each) => each.name === "1440" || each.phone)) {
  for (const theme of ["dark", "light"] as const) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const scene of SCENES.filter((each) => theme === "dark" || LIGHT.has(each.name))) {
        test(`models: ${scene.name}`, async ({ page }) => {
          await openFixture(page, scene.query, theme);
          await scene.ready(page);
          await settle(page);
          await expect(page).toHaveScreenshot(`${scene.name}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}

test.describe("Settings › Models in the fixture", () => {
  test.use(contextFor(SIZES[0]!, "dark"));

  test("a change sends one command with the screen's stamp, and Put back the next", async ({
    page,
  }) => {
    await openFixture(page, ADMIN);
    await changed(page);
    await expect(page.getByText("Default model is now ", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: /^Put back / }).click();
    const sent = await page.evaluate(() =>
      (
        window as unknown as { clawtrateFixture: { sent: Array<Record<string, unknown>> } }
      ).clawtrateFixture.sent.filter((each) => String(each.type).includes("ModelDefaults")),
    );
    expect(sent.map((each) => each.type)).toEqual(["setModelDefaults", "putBackModelDefaults"]);
    expect(sent[0]).toMatchObject({
      values: { primary: "openai/gpt-5.5-mini@openai:home" },
      restart: false,
      stamp: { gatewayId: expect.any(String) },
    });
  });
});
