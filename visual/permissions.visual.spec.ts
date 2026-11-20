// What a bot may do (docs/design/controls.md sections 2 to 5) against approved
// baselines, in light and dark at 1440, 1100 and 800 px and at phone width:
// the row in a bot's settings, the page in each state of the rules plugin and
// of its read, and a line's page with its choice. The fixture's facts are made
// up and shaped like the development gateway's
// (apps/desktop/src/fixture/permissions.ts).
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

type Scene = { name: string; ids: string; query: string; ready: (page: Page) => Promise<void> };

const PANE = `scene=main&${OTTO_DISK}&panel=open&tab=settings`;
const q = (extra: string, access = "admin") =>
  `${PANE}&access=${access}${extra ? `&${extra}` : ""}`;

async function page$(page: Page) {
  await page.getByRole("button", { name: /^What Otto may do: / }).click();
  await expect(page.getByTestId("permissions")).toBeVisible();
}
async function ready(page: Page) {
  await page$(page);
  await expect(page.getByTestId("glance")).toBeVisible();
}
const line = (id: string) => async (page: Page) => {
  await ready(page);
  await page.locator(`[data-c-line="${id}"]`).click();
  await expect(page.getByTestId("permission-line")).toBeVisible();
};

const SCENES: Scene[] = [
  {
    name: "row",
    ids: "F-176",
    query: q(""),
    ready: async (page) => {
      await expect(page.getByTestId("permission-counts")).toHaveText(
        /^\d+ never · \d+ ask first · \d+ without asking$/,
      );
    },
  },
  { name: "page", ids: "F-176 F-177 F-222", query: q(""), ready },
  { name: "page-read-only", ids: "F-176", query: q("", "read"), ready },
  { name: "page-stopped", ids: "F-176", query: q("rules=stopped"), ready },
  { name: "page-never-read", ids: "F-176", query: q("rules=stopped&read=none"), ready },
  { name: "page-no-plugin", ids: "F-176", query: q("rules=noplugin"), ready },
  { name: "page-lost", ids: "F-176", query: q("rules=lost"), ready },
  { name: "page-gateway-deny", ids: "F-176", query: q("override=1"), ready },
  {
    name: "page-loading",
    ids: "F-176",
    query: q("perm=loading"),
    ready: async (page) => {
      await page$(page);
      await expect(page.getByTestId("permissions-loading")).toBeVisible();
    },
  },
  {
    name: "page-error",
    ids: "F-176",
    query: q("perm=error"),
    ready: async (page) => {
      await page$(page);
      await expect(page.getByText("What Otto may do: Unavailable")).toBeVisible();
    },
  },
  { name: "line-files", ids: "F-176 F-177", query: q(""), ready: line("files") },
  { name: "line-exec", ids: "F-176 F-414", query: q(""), ready: line("exec") },
  { name: "line-connector", ids: "F-222", query: q(""), ready: line("server:coder") },
  { name: "line-locked", ids: "F-176", query: q("override=1"), ready: line("web") },
  { name: "line-read-only", ids: "F-176", query: q("", "read"), ready: line("files") },
  {
    name: "line-saved-never",
    ids: "F-176 F-330",
    query: q(""),
    ready: async (page) => {
      await line("read")(page);
      await page.getByRole("radio", { name: "Never", exact: true }).click();
      await expect(page.getByTestId("choice-sentence")).toHaveText(/^Otto can't read files\./);
    },
  },
  {
    name: "line-conflict",
    ids: "F-176",
    query: q("write=conflict"),
    ready: async (page) => {
      await line("read")(page);
      await page.getByRole("radio", { name: "Never", exact: true }).click();
      await expect(page.getByTestId("save-note")).toContainText(
        "Someone else changed Otto's settings. This shows what the gateway has now.",
      );
    },
  },
  {
    name: "line-unconfirmed",
    ids: "F-176",
    query: q("write=lost"),
    ready: async (page) => {
      await line("read")(page);
      await page.getByRole("radio", { name: "Never", exact: true }).click();
      await expect(page.getByTestId("save-note")).toContainText(
        "Sent, but whether it was saved couldn't be confirmed: The gateway did not answer in time. This shows what the gateway has now.",
      );
    },
  },
];

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const scene of SCENES) {
        test(`${scene.ids}: what a bot may do, ${scene.name}`, async ({ page }) => {
          await openFixture(page, scene.query, theme);
          await scene.ready(page);
          await settle(page);
          await expect(page).toHaveScreenshot(
            `permissions-${scene.name}-${theme}-${size.name}.png`,
          );
        });
      }
    });
  }
}

test.describe("keyboard and screen reader", () => {
  test.use(contextFor(SIZES[0]!, "light"));
  test("F-176: a choice is one radio group with one tab stop, arrows choose and save, Back returns to the line that opened it", async ({
    page,
  }) => {
    await openFixture(page, q(""), "light");
    await ready(page);
    const row = page.locator('[data-c-line="tasks"]');
    // A line reads its words, value, exceptions and mark.
    await expect(row).toHaveAccessibleName(
      /^Look at its tasks, Allowed, Not offered: sessions_history\. Open\.$/,
    );
    await row.click();
    const group = page.getByRole("radiogroup", { name: "Otto may:" });
    await expect(group.locator('[tabindex="0"]')).toHaveCount(1);
    await group.getByRole("radio", { name: "Allow", exact: true }).focus();
    await page.keyboard.press("End");
    await expect(page.getByTestId("choice-sentence")).toHaveText(/^Otto can't look at its tasks\./);
    await expect(group.getByRole("radio", { name: "Never", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(
      page.getByRole("status").filter({ hasText: "Saved. Look at its tasks: never" }),
    ).toHaveCount(1);
    await page.getByRole("button", { name: "Back to what Otto may do" }).click();
    await expect(page.locator('[data-c-line="tasks"]')).toBeFocused();
  });
});
