// Settings → Permissions (docs/design/controls.md sections 7 to 9) against
// approved baselines, in light and dark at 1440, 1100 and 800 px and at phone
// width: the rules plugin's state, Saved approvals and Activity in every state
// the design names; then how they behave. The fixture's grants, entries and
// records are made up (apps/desktop/src/fixture/permissions.ts).
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

type Scene = { name: string; query: string; ready: (page: Page) => Promise<void> };

const ADMIN = `scene=main&${OTTO_DISK}&access=admin`;
const settings = (page: Page) => page.getByRole("dialog", { name: "Settings" });

/** Settings, on Permissions, on one of its parts. */
const permissions =
  (
    part: "Rules" | "Saved approvals" | "Activity" = "Rules",
    ready?: (page: Page) => Promise<void>,
  ) =>
  async (page: Page) => {
    await page.keyboard.press("ControlOrMeta+,");
    await settings(page).getByRole("button", { name: "Permissions", exact: true }).click();
    await expect(
      settings(page).getByRole("heading", { name: "Permissions", level: 3 }),
    ).toBeVisible();
    if (part !== "Rules") await settings(page).getByRole("radio", { name: part }).click();
    await expect(settings(page).getByRole("radio", { name: part })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await ready?.(page);
  };

const pluginSays = (text: string | RegExp) => (page: Page) =>
  expect(page.getByTestId("rules-plugin-state")).toHaveText(text);
const grants = (page: Page) => expect(page.getByTestId("routine-grant")).toHaveCount(2);
const rows = (page: Page) => expect(page.getByTestId("activity-row").first()).toBeVisible();

const SCENES: Scene[] = [
  // The section's first line and its Rules part
  {
    name: "rules",
    query: ADMIN,
    ready: permissions("Rules", pluginSays(/^Rules plugin answered at /)),
  },
  {
    name: "rules-stopped",
    query: `${ADMIN}&rules=stopped`,
    ready: permissions("Rules", pluginSays("Clawtrate's rules plugin isn't answering.")),
  },
  {
    name: "rules-unchecked",
    query: `${ADMIN}&rules=unchecked`,
    ready: permissions("Rules", pluginSays("Checking Clawtrate's rules plugin…")),
  },
  // Saved approvals
  { name: "F-178-saved", query: ADMIN, ready: permissions("Saved approvals", grants) },
  {
    name: "F-178-saved-approvals-only",
    query: `scene=main&${OTTO_DISK}&access=write`,
    ready: permissions("Saved approvals", grants),
  },
  {
    name: "F-178-saved-read",
    query: `scene=main&${OTTO_DISK}&access=read`,
    ready: permissions("Saved approvals", (page) =>
      expect(
        page.getByTestId("admin-bar").getByRole("button", { name: "Request access" }),
      ).toBeVisible(),
    ),
  },
  {
    name: "F-178-saved-empty",
    query: `${ADMIN}&saved=empty`,
    ready: permissions("Saved approvals", (page) =>
      expect(page.getByTestId("saved-empty")).toBeVisible(),
    ),
  },
  {
    name: "F-178-saved-error",
    query: `${ADMIN}&saved=error`,
    ready: permissions("Saved approvals", (page) =>
      expect(page.getByText("Couldn't load saved approvals")).toBeVisible(),
    ),
  },
  {
    name: "F-178-saved-loading",
    query: `${ADMIN}&saved=loading`,
    ready: permissions("Saved approvals", (page) =>
      expect(page.getByRole("status", { name: "Loading saved approvals" })).toBeVisible(),
    ),
  },
  {
    name: "F-178-saved-more",
    query: `${ADMIN}&saved=more`,
    ready: permissions("Saved approvals", (page) =>
      expect(page.getByText(/lists more grants than the 80 shown/)).toBeVisible(),
    ),
  },
  {
    name: "F-178-saved-revoked",
    query: ADMIN,
    ready: permissions("Saved approvals", async (page) => {
      await page.getByRole("button", { name: "Revoke" }).click();
      await expect(page.getByTestId("grant-revoked")).toBeVisible();
    }),
  },
  {
    name: "F-178-saved-remove",
    query: ADMIN,
    ready: permissions("Saved approvals", async (page) => {
      await page.getByRole("button", { name: "Remove…" }).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
    }),
  },
  // Activity
  { name: "F-324-activity", query: ADMIN, ready: permissions("Activity", rows) },
  {
    name: "F-324-activity-open",
    query: ADMIN,
    ready: permissions("Activity", async (page) => {
      await page.getByTestId("activity-row").nth(5).click();
      await expect(page.getByRole("button", { name: "Show in chat" })).toBeVisible();
    }),
  },
  {
    name: "F-324-activity-empty",
    query: `${ADMIN}&audit=empty`,
    ready: permissions("Activity", (page) =>
      expect(page.getByTestId("activity-empty")).toBeVisible(),
    ),
  },
  {
    name: "F-324-activity-off",
    query: `${ADMIN}&audit=off`,
    ready: permissions("Activity", (page) =>
      expect(page.getByTestId("activity-off")).toBeVisible(),
    ),
  },
  {
    name: "F-324-activity-error",
    query: `${ADMIN}&audit=error`,
    ready: permissions("Activity", (page) =>
      expect(page.getByText("Couldn't load activity")).toBeVisible(),
    ),
  },
  {
    name: "F-324-activity-loading",
    query: `${ADMIN}&audit=loading`,
    ready: permissions("Activity", (page) =>
      expect(page.getByRole("status", { name: "Loading activity" })).toBeVisible(),
    ),
  },
  {
    name: "F-324-activity-end",
    query: ADMIN,
    ready: permissions("Activity", async (page) => {
      await page.getByRole("button", { name: "Show older" }).click();
      await expect(page.getByTestId("activity-end")).toBeVisible();
    }),
  },
];

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const scene of SCENES) {
        const rowsOf = scene.name.match(/^(F-\d+)-/)?.[1];
        test(`${rowsOf ? `${rowsOf}: ` : ""}permissions: ${scene.name}`, async ({ page }) => {
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

// Behaviour --------------------------------------------------------------------------------

test.describe("behaviour", () => {
  test.use(contextFor(SIZES[0]!, "light"));
  const announced = (page: Page) => page.getByTestId("b-announcer");
  const sent = (page: Page) =>
    page.evaluate(
      () =>
        (window as unknown as { clawtrateFixture: { sent: Array<{ type: string }> } })
          .clawtrateFixture.sent,
    );

  test("F-178: Revoke says Revoked only once the grant read back shows its revoked time", async ({
    page,
  }) => {
    await openFixture(page, ADMIN, "light");
    await permissions("Saved approvals", grants)(page);
    const live = page.getByTestId("routine-grant").filter({ hasText: "Weekly cleanup" });
    await expect(live.getByTestId("grant-revoked")).toHaveCount(0);
    await live.getByRole("button", { name: "Revoke" }).click();
    await expect(live.getByTestId("grant-revoked")).toHaveText(
      /^Revoked .+\. The routine's next matching command no longer runs under this grant\.$/,
    );
    await expect(live.getByRole("button", { name: "Revoke" })).toHaveCount(0);
    await expect(announced(page)).toHaveText("Revoked");
    expect((await sent(page)).filter((each) => each.type === "revokeGrant")).toHaveLength(1);
  });

  test("F-178: a refused revoke says the gateway still lists the grant as active, never Revoked", async ({
    page,
  }) => {
    await openFixture(page, `${ADMIN}&revoke=refused`, "light");
    await permissions("Saved approvals", grants)(page);
    const live = page.getByTestId("routine-grant").filter({ hasText: "Weekly cleanup" });
    await live.getByRole("button", { name: "Revoke" }).click();
    await expect(live).toContainText(
      "Couldn't revoke. The gateway refused the request: approval store unavailable. The gateway lists this grant as still active.",
    );
    await expect(live.getByTestId("grant-revoked")).toHaveCount(0);
    await expect(live.getByRole("button", { name: "Revoke" })).toBeVisible();
    await expect(announced(page)).toHaveText("Couldn't revoke");
  });

  test("F-178: a grant the gateway no longer has is said to be gone, from its answer", async ({
    page,
  }) => {
    await openFixture(page, `${ADMIN}&revoke=gone`, "light");
    await permissions("Saved approvals", grants)(page);
    await page.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("The gateway has no such grant now.")).toBeVisible();
    await expect(page.getByTestId("routine-grant")).toHaveCount(1);
  });

  test("F-178: an expired grant is shown ended beside a live one, and only the live one offers Revoke", async ({
    page,
  }) => {
    await openFixture(page, ADMIN, "light");
    await permissions("Saved approvals", grants)(page);
    const [live, ended] = [
      page.getByTestId("routine-grant").filter({ hasText: "Weekly cleanup" }),
      page.getByTestId("routine-grant").filter({ hasText: "Nightly backup check" }),
    ];
    await expect(live).toContainText("may run exactly du -sh /srv/media in /srv/media");
    await expect(live).toContainText(/granted .+ · until .+ · used 4 times, last /);
    await expect(live.getByRole("button", { name: "Revoke" })).toBeVisible();
    await expect(ended).toContainText(/ · ended .+ · used 9 times/);
    await expect(ended.getByRole("button")).toHaveCount(0);
  });

  test("F-178: Remove asks first with focus on Cancel, and says Removed from the file read back", async ({
    page,
  }) => {
    await openFixture(page, ADMIN, "light");
    await permissions("Saved approvals", grants)(page);
    const entry = page.getByTestId("allowlist-entry").filter({ hasText: "/bin/ls" });
    await expect(page.getByTestId("allowlist-no-time")).toHaveText(
      "The gateway records no time for these commands being added, so none is shown.",
    );
    await expect(entry).not.toContainText("Added");
    await expect(
      page.getByTestId("allowlist-entry").filter({ hasText: "coder__send_message" }),
    ).toContainText("Added ");
    await expect(page.getByTestId("saved-not-listed")).toContainText(
      "Not here, because the gateway has no list for them: placement grants",
    );
    await expect(entry).toContainText("which can be wider than the command that saved it");
    await entry.getByRole("button", { name: "Remove…" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(entry).toBeVisible();
    expect((await sent(page)).some((each) => each.type === "removeAllowlistEntry")).toBe(false);
    await entry.getByRole("button", { name: "Remove…" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText(/^Removed \/bin\/ls for Otto\. Read back at /)).toBeVisible();
    await expect(page.getByTestId("allowlist-entry").filter({ hasText: "/bin/ls" })).toHaveCount(0);
    await expect(announced(page)).toHaveText("Removed");
    // The entry the file keeps without an id offers no Remove.
    await expect(
      page
        .getByTestId("allowlist-entry")
        .filter({ hasText: "coder__send_message" })
        .getByRole("button"),
    ).toHaveCount(0);
  });

  test("F-178: below approvals the page reads nothing and asks for approvals access alone", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}&access=read`, "light");
    await permissions("Saved approvals")(page);
    await expect(page.getByTestId("routine-grant")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Access" }).first()).toContainText(
      "Seeing saved approvals needs approvals access.",
    );
    expect((await sent(page)).some((each) => each.type === "readSavedApprovals")).toBe(false);
    await settings(page).getByRole("button", { name: "Request access" }).click();
    const asked = (await sent(page)).filter((each) => each.type === "requestAccess");
    expect(asked).toEqual([{ type: "requestAccess", tier: "approvals" }]);
  });

  test("F-178: with approvals and without admin, grants show and the allowlist says it needs admin", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}&access=write`, "light");
    await permissions("Saved approvals", grants)(page);
    await expect(
      page.getByText("Seeing the gateway machine's allowlist needs admin access."),
    ).toBeVisible();
    await expect(page.getByTestId("allowlist-entry")).toHaveCount(0);
    await expect(page.getByTestId("admin-bar")).toContainText(
      "Removing an allowlist entry needs admin access.",
    );
  });

  test("F-324: a row reads its time, bot, action, the audit record's outcome and its recorded cause", async ({
    page,
  }) => {
    await openFixture(page, ADMIN, "light");
    await permissions("Activity", rows)(page);
    const all = page.getByTestId("activity-row");
    await expect(all).toHaveCount(6);
    await expect(all.nth(1)).toHaveAccessibleName(
      "5:19 PM, Otto, write, Blocked, Recorded: Otto's Never rule, version 1 (now version 2).",
    );
    await expect(all.nth(3)).toHaveAccessibleName(
      `2:40 AM, Pip, write, Failed, Recorded: asked because "Ask when nothing else decides", on for every bot; answered Deny.`,
    );
    // A routine's call no record joins: cause not recorded.
    await expect(all.nth(2)).toContainText("A routine's run");
    await expect(all.nth(2)).toContainText("Cause not recorded");
    // A cause whose source could not be read says so, and the tag is the audit record's own.
    await expect(all.nth(4)).toContainText("Started");
    await expect(all.nth(4)).toContainText("Cause not read.");
    await expect(all.nth(5)).toHaveAccessibleName(
      /^Yesterday, Otto, write, Ran, Recorded: asked by Otto's rule 'Ask first · notes\/\*\*', version 1; answered Allow once\.$/,
    );
  });

  test("F-324: Show in chat opens the task with that call in view and focused", async ({
    page,
  }) => {
    await openFixture(page, ADMIN, "light");
    await permissions("Activity", rows)(page);
    const blocked = page.getByTestId("activity-row").nth(1);
    await blocked.click();
    await expect(page.getByText("This step isn't in a task this device has loaded.")).toBeVisible();
    await blocked.click();
    await page.getByTestId("activity-row").nth(5).click();
    await page.getByRole("button", { name: "Show in chat" }).click();
    await expect(settings(page)).toHaveCount(0);
    const step = page.locator('.transcript [data-call="c3"]');
    await expect(step).toBeInViewport();
    await expect(step.locator(":scope > summary")).toBeFocused();
  });

  test("F-324: the filters ask the gateway for that bot and outcome, and Show older adds the next page", async ({
    page,
  }) => {
    await openFixture(page, ADMIN, "light");
    await permissions("Activity", rows)(page);
    await page.getByTestId("activity-outcome").click();
    await page.getByRole("menuitemradio", { name: "Blocked" }).click();
    await expect(page.getByTestId("activity-row")).toHaveCount(1);
    await page.getByTestId("activity-bot").click();
    await page.getByRole("menuitemradio", { name: "Pip" }).click();
    await expect(page.getByTestId("activity-empty")).toContainText(
      "No tool activity matches these filters.",
    );
    const reads = (await sent(page)).filter((each) => each.type === "readActivity").slice(-2);
    expect(reads).toEqual([
      { type: "readActivity", cursor: null, agentId: null, status: "blocked" },
      { type: "readActivity", cursor: null, agentId: "pip", status: "blocked" },
    ]);
    await page.getByTestId("activity-bot").click();
    await page.getByRole("menuitemradio", { name: "Every bot" }).click();
    await page.getByTestId("activity-outcome").click();
    await page.getByRole("menuitemradio", { name: "All" }).click();
    await expect(page.getByTestId("activity-row")).toHaveCount(6);
    await page.getByRole("button", { name: "Show older" }).click();
    await expect(page.getByTestId("activity-row")).toHaveCount(7);
    await expect(page.getByRole("button", { name: "Show older" })).toHaveCount(0);
  });

  test("permissions: its parts are one radio group with one tab stop, moved by the arrows", async ({
    page,
  }) => {
    await openFixture(page, ADMIN, "light");
    await permissions("Rules")(page);
    const group = settings(page).getByRole("radiogroup", { name: "Permissions" });
    await expect(group.locator('[tabindex="0"]')).toHaveCount(1);
    await group.getByRole("radio", { name: "Rules" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(group.getByRole("radio", { name: "Saved approvals" })).toBeFocused();
    await expect(group.getByRole("radio", { name: "Saved approvals" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.keyboard.press("End");
    await expect(group.getByRole("radio", { name: "Activity" })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(group.getByRole("radio", { name: "Rules" })).toBeFocused();
    await expect(page.getByTestId("rules-later")).toHaveText(
      "Rules for every bot aren't in this version of Clawtrate yet.",
    );
  });
});
