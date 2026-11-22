// The picture picker (docs/design/bots.md, sections 3 and 8): New bot sends
// the chosen creature inside its picture and the new bot is drawn as it; the
// person's own picture instead; and Edit picture from the Work pane on admin.
import { choiceFromPicture } from "../packages/core/src/avatar.ts";
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, SIZES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const ADMIN = `scene=main&${OTTO_DISK}&access=admin`;

test.use(contextFor(WIDE, "dark"));

const sent = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: Array<Record<string, unknown>> } }
    ).clawtrateFixture.sent.map((each) => ({ ...each })),
  );
const row = (page: Page, name: string) =>
  page.getByTestId("bot").filter({ has: page.getByText(name, { exact: true }) });

/** A small PNG, drawn in the page. */
const pngFile = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 200;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#3f6f8f";
    ctx.fillRect(0, 0, 300, 200);
    ctx.fillStyle = "#f3d9a4";
    ctx.fillRect(100, 50, 100, 100);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });

test("F-035: New bot picks a family, its parts and a colour, and the new bot is drawn as that creature", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "dark");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill("Viral");
  // Each family offers its own parts.
  await expect(page.getByRole("radiogroup", { name: "Claws" })).toBeVisible();
  await page.getByRole("radio", { name: "Lanterns" }).click();
  await expect(page.getByRole("radiogroup", { name: "Claws" })).toHaveCount(0);
  for (const group of ["Body", "Lure", "Eyes", "Colour"])
    await expect(page.getByRole("radiogroup", { name: group })).toBeVisible();
  await page.getByRole("radio", { name: "Wave" }).click();
  await page.getByRole("radio", { name: "One eye" }).click();
  await page.getByRole("radio", { name: "Lime" }).click();
  // The live picture follows every choice.
  const preview = page.getByRole("img", { name: "Viral's picture" });
  await expect(preview.locator("svg")).toHaveAttribute("data-family", "lantern");
  await expect(preview.locator('[data-part="body"]')).toHaveAttribute("fill", "#a5d955");
  await expect(preview.locator('[data-part="eye"]')).toHaveCount(1);
  await page
    .getByTestId("new-bot")
    .locator(".b-body")
    .evaluate((body) => (body.scrollTop = 0));
  await expect(page).toHaveScreenshot("avatar-picker-new-bot-dark.png");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Work/ }).click();
  await page.getByTestId("create").click();
  await expect(page.getByTestId("new-bot")).toHaveCount(0);
  // The picture sent carries the choice, and the bot comes back drawn as that creature.
  const create = (await sent(page)).find((each) => each.type === "createBot")!;
  expect(String(create.avatar)).toMatch(/^data:image\/png;base64,/);
  expect(choiceFromPicture(String(create.avatar))).toEqual({
    family: "lantern",
    body: "round",
    lure: "wave",
    eyes: "one",
    color: "lime",
  });
  await expect(row(page, "Viral").locator('svg.creature[data-family="lantern"]')).toBeVisible();
  await expect(row(page, "Viral").locator("img")).toHaveCount(0);
});

test("F-035: the person's own picture replaces the creature; a file of 25 MB or more is refused", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "dark");
  await page.keyboard.press("ControlOrMeta+n");
  const file = page.getByTestId("picture-file");
  await file.setInputFiles({
    name: "huge.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(25 * 1024 * 1024),
  });
  await expect(page.getByRole("alert")).toHaveText("Choose an image under 25 MB.");
  await expect(page.getByTestId("picture-preview").locator("svg")).toBeVisible();
  await file.setInputFiles({
    name: "mine.png",
    mimeType: "image/png",
    buffer: Buffer.from(await pngFile(page), "base64"),
  });
  const picture = page.getByTestId("picture-preview").locator("img");
  await expect(picture).toHaveAttribute("src", /^data:image\/png;base64,/);
  expect(choiceFromPicture(await picture.getAttribute("src"))).toBeNull();
  // Choosing a creature again puts the creature back.
  await page.getByRole("button", { name: "Use the creature" }).click();
  await expect(page.getByTestId("picture-preview").locator("svg")).toBeVisible();
});

test("F-037: on admin the Work pane's picture opens Edit picture; Save sends it and the bot is drawn anew", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&panel=open`, "dark");
  const change = page.getByRole("button", { name: "Change Otto's picture" });
  await change.click();
  const dialog = page.getByTestId("edit-picture");
  await expect(dialog.getByRole("heading", { name: "Otto's picture" })).toBeFocused();
  // It starts from the bot's picture as it is: its own Clawling.
  await expect(dialog.getByRole("radio", { name: "Clawlings" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await dialog.getByRole("radio", { name: "Shellfolk" }).click();
  await dialog.getByRole("radio", { name: "Turret" }).click();
  await dialog.getByRole("radio", { name: "Pink" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  const saved = (await sent(page)).find((each) => each.type === "setBotPicture")!;
  expect(saved.botId).toBe("otto");
  expect(choiceFromPicture(String(saved.avatar))).toEqual({
    family: "shellfolk",
    shell: "turret",
    color: "pink",
  });
  await expect(row(page, "Otto").locator('svg.creature[data-family="shellfolk"]')).toBeVisible();
  await expect(page.locator('.work-hero svg.creature[data-family="shellfolk"]')).toBeVisible();
  // Escape focus returns to the picture it opened from.
  await change.click();
  await page.keyboard.press("Escape");
  await expect(change).toBeFocused();
});

test("F-037: below admin the Work pane's picture is not a button", async ({ page }) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&panel=open`, "dark");
  await expect(page.locator(".work-hero .avatar")).toBeVisible();
  await expect(page.getByRole("button", { name: /picture/ })).toHaveCount(0);
});
