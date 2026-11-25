// #532 in the fixture mode: a bot's settings say when the gateway doesn't give it the tool for
// starting a task (`sessions_spawn`), with the gateway's reason, and nothing else changes (F-566).
import { test, type Page } from "@playwright/test";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.name === "phone")!;
const PANE = `scene=main&${OTTO_DISK}&panel=open&tab=settings`;
const LINE = "Otto can't start tasks. The gateway says: Not included in tools.allow.";

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
    });
  }
}
