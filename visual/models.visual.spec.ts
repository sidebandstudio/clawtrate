// A task's model and effort (docs/design/conversation.md, section 25) in the
// fixture: the model chip and its menu, a change held during a turn, a refused
// change, the read-only form, the line a change leaves and the turn's record,
// as baselines at every width in both themes, and the behaviour behind them.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, OTTO_DISK, openFixture, settle, SIZES, THEMES, type Size } from "./fixture.ts";

const chip = (page: Page) => page.getByTestId("model-chip");
const details = (page: Page) => page.getByTestId("task-model");
const runLine = (page: Page) => page.getByTestId("run-line").last();

/** At phone width the chip is not drawn: the task's Details hold the control. */
async function openDetails(page: Page) {
  await page.getByRole("button", { name: "Show work panel" }).click();
  await expect(details(page)).toBeVisible();
}

type Scene = {
  name: string;
  rows: string;
  scene: string;
  prepare: (page: Page, size: Size) => Promise<void>;
};

const SCENES: Scene[] = [
  {
    name: "model-chip-menu",
    rows: "F-042 F-043",
    scene: "model-set",
    prepare: async (page, size) => {
      if (size.phone) return openDetails(page);
      await chip(page).click();
      await expect(
        page.getByRole("menu", { name: "Model and effort for this task" }),
      ).toBeVisible();
    },
  },
  {
    name: "model-held",
    rows: "F-045",
    scene: "model-held",
    prepare: async (page, size) => {
      if (size.phone) await openDetails(page);
      else await expect(chip(page)).toHaveAccessibleName(/Held until this turn ends/);
    },
  },
  {
    name: "model-refused",
    rows: "F-043 F-045",
    scene: "model-refused",
    prepare: async (page) => {
      await page.getByTestId("model-line").last().scrollIntoViewIfNeeded();
      await openDetails(page);
    },
  },
  {
    name: "model-read",
    rows: "F-042 F-043",
    scene: "model-read",
    prepare: async (page, size) => {
      if (size.phone) await openDetails(page);
    },
  },
];

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const scene of SCENES) {
        test(`${scene.rows}: ${scene.name}`, async ({ page }) => {
          await openFixture(page, `scene=${scene.scene}&${OTTO_DISK}`, theme);
          await settle(page);
          await scene.prepare(page, size);
          await settle(page);
          await expect(page).toHaveScreenshot(`${scene.name}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}

test.describe("a task's model and effort, behaviour", () => {
  test.use(contextFor(SIZES[0]!, "light"));

  test("F-042 F-043: the chip names the task's model and effort, opens its menu from the keyboard and saves a choice at once", async ({
    page,
  }) => {
    await openFixture(page, `scene=model-set&${OTTO_DISK}`, "light");
    await expect(chip(page)).toHaveAccessibleName(
      "Model for this task: acme/dev-2, Low effort. Change.",
    );
    await expect(chip(page)).toHaveText(/dev-2·Low/);
    // Before the title pill in reading order, at the top left.
    const [chipBox, pillBox] = await Promise.all([
      chip(page).boundingBox(),
      page.locator(".title-pill").boundingBox(),
    ]);
    expect(chipBox!.x + chipBox!.width).toBeLessThan(pillBox!.x);
    await chip(page).focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Model and effort for this task" });
    await expect(menu.getByRole("group", { name: "Model" })).toBeVisible();
    await expect(menu.getByRole("group", { name: "Effort" })).toBeVisible();
    await expect(menu.getByRole("menuitemradio", { name: "dev-2" })).toBeFocused();
    await expect(menu.getByRole("menuitemradio", { name: "dev-old" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    // Arrows pass over the model the gateway marks unavailable.
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitemradio", { name: "dev-lite" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitemradio", { name: "Off" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(chip(page)).toBeFocused();
    // A model that lacks the task's effort takes its own default, and the line says both.
    await page.keyboard.press("Enter");
    await menu.getByRole("menuitemradio", { name: "dev-lite" }).click();
    await expect(page.getByTestId("model-line").last()).toHaveText(
      "Model changed to acme/dev-lite, effort to Off · from the next turn",
    );
    await expect(chip(page)).toHaveAccessibleName(
      "Model for this task: acme/dev-lite, Off effort. Change.",
    );
    await expect(chip(page)).toBeFocused();
    await expect(page.getByTestId("announcer")).toHaveText("Model changed for this task");
  });

  test("F-045: a change during a turn is held, says so, and Keep lets it go; no line is posted while it is held", async ({
    page,
  }) => {
    await openFixture(page, `scene=model-held&${OTTO_DISK}`, "light");
    await expect(chip(page)).toHaveAccessibleName(
      "Model for this task: acme/dev-2, Low effort. Held until this turn ends. Change.",
    );
    await expect(chip(page).locator(".model-chip-held")).toBeVisible();
    await chip(page).click();
    await page.getByRole("menuitemradio", { name: "High" }).click();
    await expect(page.getByTestId("announcer")).toHaveText("Held until this turn ends");
    await expect(page.getByTestId("model-line")).toHaveCount(0);
    await openDetails(page);
    await expect(page.getByTestId("task-model-line")).toContainText(
      "Held until Otto's turn ends, then saved. It applies from the next turn.",
    );
    await page.getByRole("button", { name: "Keep dev-1" }).click();
    await expect(chip(page)).toHaveAccessibleName(
      "Model for this task: acme/dev-1, Low effort. Change.",
    );
    await expect(chip(page).locator(".model-chip-held")).toHaveCount(0);
  });

  test("F-044: a turn's run line states no model and no effort the gateway did not report for it", async ({
    page,
  }) => {
    await openFixture(page, `scene=model-set&${OTTO_DISK}`, "light");
    const summary = runLine(page).locator("summary");
    await expect(summary).not.toHaveAttribute("title");
    await summary.press("Enter");
    await expect(runLine(page)).not.toContainText(/effort|acme\/dev/);
    await expect(runLine(page).getByRole("button", { name: "Raw" })).toHaveCount(0);
  });

  test("F-045: a refused change says why, in Details and as a line, and the chip shows what the gateway has", async ({
    page,
  }) => {
    await openFixture(page, `scene=model-refused&${OTTO_DISK}`, "light");
    await expect(chip(page)).toHaveAccessibleName(
      "Model for this task: acme/dev-lite, Off effort. Change.",
    );
    const refused = page.getByTestId("model-line").last();
    await expect(refused).toHaveAttribute("data-tone", "warn");
    await expect(refused).toHaveText(
      `Couldn't change the effort to High: thinkingLevel "high" is not supported for acme/dev-lite (use off|ultra)`,
    );
    await openDetails(page);
    await expect(page.getByTestId("task-model-line")).toHaveRole("alert");
    await expect(page.getByTestId("task-model-line")).toContainText(
      "Couldn't change the effort: thinkingLevel",
    );
  });

  test("F-042 F-043: a read-only connection sees the values and no control", async ({ page }) => {
    await openFixture(page, `scene=model-read&${OTTO_DISK}`, "light");
    await expect(chip(page)).toHaveRole("note");
    await expect(chip(page)).toHaveAccessibleName("Model for this task: acme/dev-2, Low effort.");
    await expect(page.getByRole("button", { name: /Model for this task/ })).toHaveCount(0);
    await openDetails(page);
    await expect(details(page).getByRole("button")).toHaveCount(0);
    await expect(details(page)).toContainText("acme/dev-2");
  });
});

test.describe("a task's model at phone width", () => {
  test.use(
    contextFor(
      SIZES.find((size) => size.phone)!,
      "light",
    ),
  );

  test("F-042: below 688 px there is no chip; Details holds Model over Effort, and a choice saves from there", async ({
    page,
  }) => {
    await openFixture(page, `scene=model-set&${OTTO_DISK}`, "light");
    await expect(chip(page)).toBeHidden();
    await openDetails(page);
    const model = page.getByTestId("task-model-select");
    const effort = page.getByTestId("task-effort-select");
    expect((await effort.boundingBox())!.y).toBeGreaterThan((await model.boundingBox())!.y);
    await effort.click();
    await page.getByRole("menuitemradio", { name: "High" }).click();
    await expect(page.getByTestId("work-announcer")).toHaveText("Effort changed for this task");
    await expect(effort).toHaveAccessibleName("Effort: High");
  });
});
