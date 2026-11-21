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
  {
    name: "line-exec",
    ids: "F-176 F-414",
    query: q(""),
    ready: async (page) => {
      await line("exec")(page);
      await expect(page.getByTestId("choice-sentence")).toHaveText(
        "Otto's command setting: Ask. Clawtrate's rules plugin checks its rules before it. A task's own settings and the machine's approvals file can also ask or refuse; this page doesn't read them.",
      );
    },
  },
  {
    name: "line-exec-no-plugin",
    ids: "F-176",
    query: q("rules=noplugin"),
    ready: async (page) => {
      await line("exec")(page);
      await expect(page.getByTestId("choice-sentence")).toContainText(
        "Clawtrate's rules plugin isn't on this gateway.",
      );
      await expect(page.getByText(/Two checks/)).toHaveCount(0);
    },
  },
  { name: "line-connector", ids: "F-222", query: q(""), ready: line("server:coder") },
  {
    name: "line-long-server",
    ids: "F-176",
    query: q("long=1"),
    ready: async (page) => {
      await line(`server:Review.ServerLong${"x".repeat(64)}`)(page);
      // The heading wraps inside the panel: nothing is wider than the page.
      const heading = page.getByRole("heading", { level: 3, name: /^Tool server Review/ });
      const tab = page.getByTestId("permission-line");
      const [h, t] = await Promise.all([heading.boundingBox(), tab.boundingBox()]);
      expect(h!.x + h!.width).toBeLessThanOrEqual(t!.x + t!.width + 0.5);
      expect(await tab.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    },
  },
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
  {
    name: "page-stored",
    ids: "F-176",
    query: q("write=stored"),
    ready: async (page) => {
      await line("read")(page);
      await page.getByRole("radio", { name: "Never", exact: true }).click();
      await expect(page.getByTestId("save-note")).toBeVisible();
      await page.getByRole("button", { name: "Back to what Otto may do" }).click();
      // No in-force counts while the gateway doesn't confirm the settings in use.
      await expect(page.getByTestId("not-applied")).toHaveText(
        "Stored permissions. The gateway did not confirm which settings it is using.",
      );
      await expect(page.getByTestId("glance").locator(".c-glance-n")).toHaveCount(0);
    },
  },
  {
    name: "line-stored",
    ids: "F-176",
    query: q("write=stored"),
    ready: async (page) => {
      await line("read")(page);
      await page.getByRole("radio", { name: "Never", exact: true }).click();
      await expect(page.getByTestId("save-note")).toContainText(
        "Saved in the gateway's settings, and not confirmed in use: the gateway reports it isn't using the stored revision yet. This shows the stored settings.",
      );
      // Stored settings the gateway doesn't use yet are never said as in force.
      const lineView = page.getByTestId("permission-line");
      await expect(page.getByTestId("choice-sentence")).toHaveText(
        "Otto's stored settings say Never. The gateway reports it isn't using its stored settings yet, so this may not be in force.",
      );
      await expect(lineView).toContainText(
        "Stored in the gateway's settings, not confirmed in use",
      );
      await expect(lineView).not.toContainText("The gateway enforces this");
      await expect(lineView).not.toContainText("The gateway removes");
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
      /^Look at its tasks, Allowed, Not offered: sessions_history \(set on the gateway\)\. Open\.$/,
    );
    await row.click();
    // The line's heading takes focus on the next frame; a person moves on from there.
    await expect(page.getByTestId("permission-line").locator("[data-bs-focus]")).toBeFocused();
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
    // Opened from its link in the glance, Back returns to that link.
    await page.locator('[data-c-glance="read"]').click();
    await expect(page.getByTestId("permission-line")).toBeVisible();
    await page.getByRole("button", { name: "Back to what Otto may do" }).click();
    await expect(page.locator('[data-c-glance="read"]')).toBeFocused();
  });

  test("Back takes focus to the overview heading when the line vanishes from its summary", async ({
    page,
  }) => {
    await openFixture(page, q("entry=1"), "light");
    await ready(page);
    // An entry of Otto's deny list that names no tool, opened from its link in the glance.
    await page.locator('[data-c-glance="deny:retired_tool"]').click();
    const line = page.getByTestId("permission-line");
    await expect(line.locator("[data-bs-focus]")).toBeFocused();
    await line.getByRole("radio", { name: "Allow", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved. retired_tool: allowed" }),
    ).toHaveCount(1);
    // The entry and its link are gone: the overview's heading takes focus, not Back to settings.
    await expect(page.locator('[data-c-glance="deny:retired_tool"]')).toHaveCount(0);
    await expect(page.getByTestId("permissions").locator("[data-bs-focus]")).toBeFocused();
    await expect(page.getByRole("button", { name: "Back to settings" })).not.toBeFocused();
  });
});

test.describe("the page's own read", () => {
  test.use(contextFor(SIZES[0]!, "light"));
  test("F-176: while the account read has failed, Tools is still drawn from its own read and opens", async ({
    page,
  }) => {
    await openFixture(page, q("accounts=error"), "light");
    await expect(page.getByText("Couldn't load Otto's settings")).toBeVisible();
    await expect(page.getByTestId("permission-counts")).toBeVisible();
    await ready(page);
    await page.locator('[data-c-line="read"]').click();
    await expect(page.getByRole("radiogroup", { name: "Otto may:" })).toBeVisible();
  });

  test("F-176: after a reconnect the page shows nothing read on the old connection while it reads again", async ({
    page,
  }) => {
    await openFixture(page, q(""), "light");
    await line("read")(page);
    await expect(page.getByRole("radiogroup", { name: "Otto may:" })).toBeVisible();
    // The read on the new connection doesn't land: nothing from the old one may stand in for it.
    await page.evaluate(() => {
      type Fixture = {
        invoke: (command: { type: string }) => Promise<unknown>;
        setState: (change: (state: { connection: object }) => { connection: object }) => void;
      };
      const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
      const original = fixture.invoke.bind(fixture);
      fixture.invoke = (command) =>
        command.type === "readPermissions" ? new Promise(() => {}) : original(command);
      fixture.setState((state) => ({
        ...state,
        connection: {
          ...state.connection,
          connectedAt: ((state.connection as { connectedAt?: number }).connectedAt ?? 0) + 1,
        },
      }));
    });
    await expect(page.getByTestId("permissions-loading")).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Otto may:" })).toHaveCount(0);
  });
});
