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
  // The pane stays open from one opening of the fixture to the next.
  const show = page.getByRole("button", { name: "Show work panel" });
  await expect(show.or(details(page))).toBeVisible();
  if (await show.isVisible()) await show.click();
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
  {
    name: "model-unlisted",
    rows: "F-043",
    scene: "model-unlisted",
    prepare: openDetails,
  },
  {
    name: "model-no-levels-kept",
    rows: "F-043",
    scene: "model-no-levels-kept",
    prepare: openDetails,
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
      "Held until Otto's turn ends. Clawtrate will then try to save it.",
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

  test("F-042: while a save is on its way the chip shows the chosen value as pending, with aria-busy", async ({
    page,
  }) => {
    await openFixture(page, `scene=model-saving&${OTTO_DISK}`, "light");
    await expect(chip(page)).toHaveAccessibleName(
      "Model for this task: acme/dev-2, High effort. Saving. Change.",
    );
    await expect(chip(page)).toHaveAttribute("aria-busy", "true");
    await expect(chip(page)).toHaveText(/dev-2·High/);
    // Both ways to choose wait for the answer: no second change is offered meanwhile.
    await expect(chip(page)).toBeDisabled();
    await openDetails(page);
    await expect(page.getByTestId("task-model-line")).toHaveText("Saving…");
    await expect(page.getByTestId("task-model-select")).toBeDisabled();
    await expect(page.getByTestId("task-effort-select")).toBeDisabled();
  });

  test("F-043: Not offered is said only for a model the gateway lists with no levels; a list not read, a failed read and a model the list lacks each say so, and the last effort stays", async ({
    page,
  }) => {
    const effort = page.getByTestId("task-effort-select");
    const line = page.getByTestId("task-model-line");
    const menu = page.getByRole("menu", { name: "Model and effort for this task" });
    const cases: Array<[string, string | RegExp]> = [
      ["model-list-loading", "Loading the models…"],
      ["model-list-failed", "Couldn't load the models: The gateway did not answer in time."],
      [
        "model-unlisted",
        "acme/dev-gone isn't in the list shown here, so its effort levels aren't known.",
      ],
    ];
    for (const [scene, words] of cases) {
      await openFixture(page, `scene=${scene}&${OTTO_DISK}`, "light");
      await expect(chip(page)).toHaveAccessibleName(/, Ultra effort\. Change\.$/);
      await chip(page).click();
      await expect(menu).toBeVisible();
      await expect(menu).not.toContainText("Not offered");
      await page.keyboard.press("Escape");
      await openDetails(page);
      await expect(effort).toHaveAccessibleName("Effort: Ultra");
      await expect(effort).toBeDisabled();
      await expect(line).toContainText(words);
      await expect(details(page)).not.toContainText("Not offered");
    }
    await expect(menu).toBeHidden();
    await chip(page).click();
    await expect(menu).toContainText("Effort: acme/dev-gone isn't in the list shown here");
    await expect(menu.getByRole("group", { name: "Effort" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    // A failed read is offered again.
    await openFixture(page, `scene=model-list-failed&${OTTO_DISK}`, "light");
    await openDetails(page);
    await expect(details(page).getByRole("button", { name: "Try again" })).toBeVisible();
    // Listed with no levels: Not offered, and only then.
    await openFixture(page, `scene=model-no-levels&${OTTO_DISK}`, "light");
    await expect(chip(page)).toHaveAccessibleName(
      "Model for this task: acme/dev-old, effort not offered. Change.",
    );
    await chip(page).click();
    await expect(
      menu
        .getByRole("group", { name: "Effort" })
        .getByRole("menuitemradio", { name: "Not offered" }),
    ).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await openDetails(page);
    await expect(effort).toHaveAccessibleName("Effort: Not offered");
    await expect(line).toHaveText("For this task. Otto's own model is in Settings.");
    // Listed with none, and an effort read for the task before: that effort stays.
    await openFixture(page, `scene=model-no-levels-kept&${OTTO_DISK}`, "light");
    await expect(chip(page)).toHaveAccessibleName(
      "Model for this task: acme/dev-old, High effort. Change.",
    );
    await openDetails(page);
    await expect(effort).toHaveAccessibleName("Effort: High");
    await expect(effort).toBeDisabled();
  });

  test("F-043: a catalogue entry without thinkingLevels does not establish an empty level list", async ({
    page,
  }) => {
    await openFixture(page, `scene=model-unreported&${OTTO_DISK}`, "light");
    await expect(chip(page)).toHaveAccessibleName(
      "Model for this task: acme/dev-quiet, effort not reported. Change.",
    );
    await openDetails(page);
    const effort = page.getByTestId("task-effort-select");
    await expect(effort).toHaveAccessibleName("Effort: Not reported");
    await expect(effort).toBeDisabled();
    await expect(page.getByTestId("task-model-line")).toHaveText(
      "The gateway didn't report this model's effort levels.",
    );
    await expect(details(page)).not.toContainText("Not offered");
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

test.describe("a bot's model and effort in its settings", () => {
  test.use(contextFor(SIZES[0]!, "light"));
  const settings = (more = "") =>
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=bound${more}`;
  const line = (page: Page) => page.locator("#b-model-line");
  const choose = async (page: Page, select: "model-select" | "effort-select", name: string) => {
    await page.getByTestId(select).click();
    await page.getByRole("menuitemradio", { name, exact: true }).click();
  };

  test("F-043: Bot Settings names the changed effort only after read-back confirms it", async ({
    page,
  }) => {
    await openFixture(page, settings("&botsave=slow"), "light");
    await choose(page, "effort-select", "High");
    await expect(page.getByTestId("work-announcer")).toHaveText("Effort saved");
    await choose(page, "model-select", "gpt-5.5-mini");
    // On its way: the line does not say the effort changed, and the pair waits for the answer.
    await expect(line(page)).not.toContainText("Effort is now");
    await expect(page.getByTestId("model-select")).toBeDisabled();
    await expect(page.getByTestId("effort-select")).toBeDisabled();
    await expect(page.getByTestId("work-announcer")).toHaveText("Model saved");
    await expect(line(page)).toHaveText("Effort is now Low: gpt-5.5-mini doesn't offer High.");

    // A change of model the gateway took and could not be read after: no effort is named.
    await openFixture(page, settings("&botsave=unread"), "light");
    await choose(page, "model-select", "gpt-5.5-mini");
    await expect(page.getByTestId("work-announcer")).toHaveText("Couldn't confirm the change");
    await expect(line(page)).toHaveText(
      "Couldn't confirm the change. Showing the last settings read.",
    );
    await expect(page.getByTestId("model-select")).toHaveAccessibleName("Model: gpt-5.5");
  });

  test("F-043: Bot Settings shows a gateway-reported effort or Not reported", async ({ page }) => {
    // Neither configured nor reported: no level is proposed in its place.
    await openFixture(page, settings().replace("lock=bound", "lock=noeffort"), "light");
    await expect(page.getByTestId("model-select")).toHaveAccessibleName("Model: gpt-5.5");
    await expect(page.getByTestId("effort-select")).toHaveAccessibleName("Effort: Not reported");
    // The effort agents.list reports for the bot.
    await openFixture(
      page,
      settings("&boteffort=high").replace("lock=bound", "lock=noeffort"),
      "light",
    );
    await expect(page.getByTestId("effort-select")).toHaveAccessibleName("Effort: High");
    // A configured effort is the bot's own.
    await openFixture(page, settings(), "light");
    await expect(page.getByTestId("effort-select")).toHaveAccessibleName("Effort: Medium");
  });

  test("F-042: a bot using the gateway default shows its model and reaches model selection from Settings", async ({
    page,
  }) => {
    await openFixture(page, settings().replace("lock=bound", "lock=default"), "light");
    await expect(page.getByTestId("account-word")).toHaveText("Gateway's default model");
    const model = page.getByTestId("model-select");
    await expect(model).toHaveAccessibleName("Model: gpt-5.5");
    await expect(model).toBeDisabled();
    await expect(page.getByTestId("default-model-line")).toContainText(
      "The gateway's default model. Choose an account to pick another.",
    );
    await page.getByRole("button", { name: "Choose an account" }).click();
    await expect(page.getByRole("heading", { name: "Change account", level: 3 })).toBeFocused();
    await page.getByRole("radio", { name: /^OpenAI · Work/ }).click();
    await expect(model).toBeEnabled();
    await model.click();
    await page.getByRole("menuitemradio", { name: "gpt-5.5-mini", exact: true }).click();
    await expect(model).toHaveAccessibleName("Model: gpt-5.5-mini");
    await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  test("F-043: Settings shows a gateway-default bot's reported effort beside its model", async ({
    page,
  }) => {
    await openFixture(
      page,
      settings("&boteffort=high").replace("lock=bound", "lock=default"),
      "light",
    );
    await expect(page.getByTestId("model-select")).toHaveAccessibleName("Model: gpt-5.5");
    const effort = page.getByTestId("effort-select");
    await expect(effort).toHaveAccessibleName("Effort: High");
    await expect(effort).toBeDisabled();
    // Not reported, and none proposed in its place.
    await openFixture(page, settings().replace("lock=bound", "lock=default"), "light");
    await expect(effort).toHaveAccessibleName("Effort: Not reported");
  });
});
