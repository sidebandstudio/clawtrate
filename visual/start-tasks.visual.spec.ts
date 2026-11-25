// #532 in the fixture mode: a bot's settings say when the gateway doesn't give it the tool for
// starting a task (`sessions_spawn`), with the gateway's reason, and nothing else changes; and
// Settings says when the gateway's voice plugin is older than the task guide (F-566).
import { test, type Page } from "@playwright/test";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.name === "phone")!;
const PANE = `scene=main&${OTTO_DISK}&panel=open&tab=settings`;
const LINE = "Otto can't start tasks. The gateway says: Not included in tools.allow.";

async function conversationPane(page: Page, query: string, theme: "light" | "dark") {
  await openFixture(page, `scene=composer&${OTTO_DISK}&panel=closed${query}`, theme);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Conversation", level: 3 })).toBeVisible();
  return settings;
}

test.describe("whether a bot can start tasks", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-566: one line, with the gateway's reason, under its own heading, only when it can't", async ({
    page,
  }) => {
    await openFixture(page, `${PANE}&starttasks=no`, "light");
    const tab = page.getByTestId("bot-settings");
    await expect(tab.getByTestId("start-tasks")).toHaveText(LINE);
    // A screen reader reaches it under its own heading, as text, with nothing to press.
    await expect(tab.getByRole("heading", { name: "Tasks", level: 3 })).toBeVisible();
    await expect(tab.getByTestId("start-tasks").getByRole("button")).toHaveCount(0);
    await expect(tab.getByRole("switch", { name: /task/i })).toHaveCount(0);
    // Nothing was sent to the gateway for it.
    const sent = await page.evaluate(
      () =>
        (window as unknown as { clawtrateFixture: { sent: { type: string }[] } }).clawtrateFixture
          .sent,
    );
    expect(sent.filter((command) => /tool|config|Bot(?!Voice)/.test(command.type))).toEqual([]);
  });

  test("F-566: without a reason from the gateway, none is made up", async ({ page }) => {
    await openFixture(page, `${PANE}&starttasks=noreason`, "light");
    await expect(page.getByTestId("start-tasks")).toHaveText(
      "Otto can't start tasks: the gateway doesn't give it the tool for that.",
    );
  });

  test("F-566: says nothing while it can, or before its tools are read", async ({ page }) => {
    for (const query of ["&starttasks=yes", ""]) {
      await openFixture(page, `${PANE}${query}`, "light");
      await expect(page.getByTestId("bot-settings")).toBeVisible();
      await expect(page.getByTestId("start-tasks")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Tasks", level: 3 })).toHaveCount(0);
    }
  });

  test("F-566: the line is reached by keyboard order, after Memory", async ({ page }) => {
    await openFixture(page, `${PANE}&starttasks=no`, "light");
    const tab = page.getByTestId("bot-settings");
    const order = await tab.evaluate((root) => {
      const memory = root.querySelector('[data-bs="memory"]')!;
      const line = root.querySelector('[data-testid="start-tasks"]')!;
      return memory.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING;
    });
    expect(order).toBeTruthy();
    await tab.getByRole("button", { name: "Memory" }).focus();
    await page.keyboard.press("Tab");
    // Text takes no focus: the next stop is past it, and the line stays on screen.
    await expect(tab.getByTestId("start-tasks")).toBeInViewport();
  });

  test("F-566: an older voice plugin is named, with how to update it", async ({ page }) => {
    const settings = await conversationPane(page, "&voice=old", "light");
    const note = settings.getByTestId("bot-where-old");
    await expect(note).toContainText(
      "The gateway's voice plugin is version 0.1.0, from before the task guide, so the bots aren't told what a task is.",
    );
    await expect(note.getByRole("link", { name: "How to update it" })).toHaveAttribute(
      "href",
      "https://github.com/sidebandstudio/clawtrate/blob/main/plugins/clawtrate-voice/README.md#updating-it",
    );
    // A current plugin says nothing about it.
    const current = await conversationPane(page, "", "light");
    await expect(current.getByTestId("bot-voice-switch")).toBeVisible();
    await expect(current.getByTestId("bot-where-old")).toHaveCount(0);
  });
});

for (const size of [WIDE, PHONE]) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      test("F-566: the can't-start-tasks line", async ({ page }) => {
        await openFixture(page, `${PANE}&starttasks=no`, theme);
        const line = page.getByTestId("start-tasks");
        await line.scrollIntoViewIfNeeded();
        await expect(line).toHaveText(LINE);
        await settle(page);
        await expect(page).toHaveScreenshot(`start-tasks-${theme}-${size.name}.png`);
      });
      test("F-566: an older voice plugin", async ({ page }) => {
        const settings = await conversationPane(page, "&voice=old", theme);
        const note = settings.getByTestId("bot-where-old");
        await note.scrollIntoViewIfNeeded();
        await expect(note).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`voice-plugin-old-${theme}-${size.name}.png`);
      });
    });
  }
}
