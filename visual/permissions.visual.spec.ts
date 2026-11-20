// Settings → Permissions (docs/design/controls.md sections 7 to 9) against
// approved baselines, in light and dark at 1440, 1100 and 800 px and at phone
// width: the rules plugin's state, Saved approvals and Activity in every state
// the design names; then how they behave. The fixture's grants, entries and
// records are made up (apps/desktop/src/fixture/permissions.ts).
import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { contextFor, NOW, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

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
    await settings(page).getByRole("radio", { name: part }).click();
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
    ready: permissions(
      "Rules",
      pluginSays(
        /^Rules plugin answered at .+: it isn't enforcing rules, because its hook isn't registered or its service isn't running\.$/,
      ),
    ),
  },
  {
    name: "rules-unchecked",
    query: `${ADMIN}&rules=unchecked`,
    ready: permissions("Rules", pluginSays("Checking Clawtrate's rules plugin…")),
  },
  {
    name: "rules-failed",
    query: `${ADMIN}&rules=failed`,
    ready: permissions(
      "Rules",
      pluginSays(
        "Couldn't read Clawtrate's rules plugin's status. The gateway didn't answer within 60 seconds.",
      ),
    ),
  },
  {
    name: "rules-lost",
    query: `${ADMIN}&rules=lost`,
    ready: permissions(
      "Rules",
      pluginSays(
        /Its rules file can't be read and it holds no earlier copy, so it asks before every tool call it sees, other than ask_user\.$/,
      ),
    ),
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
      expect(page.getByTestId("saved-empty")).toContainText(
        "Nothing in the two lists readThe gateway lists no routine's grant, and its machine's approvals file has no allowlist entry.",
      ),
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
      await expect(page.getByTestId("activity-end")).toHaveText("No older records available.");
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

  test("F-178: a refused revoke says the gateway still lists the grant, never Revoked", async ({
    page,
  }) => {
    await openFixture(page, `${ADMIN}&revoke=refused`, "light");
    await permissions("Saved approvals", grants)(page);
    const live = page.getByTestId("routine-grant").filter({ hasText: "Weekly cleanup" });
    await live.getByRole("button", { name: "Revoke" }).click();
    await expect(live).toContainText(
      "Couldn't revoke. The gateway refused the request: approval store unavailable. The gateway still lists this grant, not revoked.",
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
    await expect(live).toContainText(
      "Routine Weekly cleanup (Otto) · Saved command du -sh /srv/media in /srv/media",
    );
    await expect(page.getByTestId("saved-approvals")).not.toContainText("may run exactly");
    await expect(live).toContainText(/granted .+ · until .+ · used 4 times, last /);
    await expect(live.getByRole("button", { name: "Revoke" })).toBeVisible();
    await expect(ended).toContainText(/ · ended .+ · used 9 times/);
    await expect(ended.getByRole("button")).toHaveCount(0);
  });

  test("F-178: a grant whose routine is gone is said to be that, with no claim the gateway enforces it", async ({
    page,
  }) => {
    await openFixture(page, `${ADMIN}&saved=more`, "light");
    await permissions("Saved approvals")(page);
    const gone = page
      .getByTestId("routine-grant")
      .filter({ hasText: "A routine the gateway no longer has" });
    await expect(gone).toHaveCount(1);
    await expect(gone).toContainText("(Otto) · Saved command df -h /srv/disk3");
    await expect(gone).not.toContainText("The gateway enforces this");
  });

  test("F-178: a grant's end is judged against a clock that moves while the page is open", async ({
    page,
  }) => {
    await openFixture(page, `${ADMIN}&saved=expiring`, "light");
    await permissions("Saved approvals", grants)(page);
    const live = page.getByTestId("routine-grant").filter({ hasText: "Weekly cleanup" });
    await expect(live.getByRole("button", { name: "Revoke" })).toBeVisible();
    await expect(live).toContainText(" · until ");
    // Two minutes on, its end has passed: the page says so without being opened again.
    await page.clock.setFixedTime(NOW.getTime() + 2 * 60_000);
    await expect(live).toContainText(" · ended ", { timeout: 45_000 });
    await expect(live.getByRole("button", { name: "Revoke" })).toHaveCount(0);
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
    // The page names the lists it read, those it did not, and which entries it can remove.
    await expect(page.getByTestId("saved-read")).toHaveText(
      "Read here: the routines' grants the gateway lists, and the allowlist in the approvals file of the gateway's own machine. Clawtrate's rules plugin makes no standing approval.",
    );
    await expect(page.getByTestId("saved-not-listed")).toHaveText(
      "Not read here: placement grants, which the gateway keeps for some plugin commands on paired machines for up to 30 days and has no list for; the allowlists of paired machines; and any trust a plugin keeps for itself. Remove… is offered only for an allowlist entry with an id.",
    );
    const tool = page.getByTestId("allowlist-entry").filter({ hasText: "coder__send_message" });
    await expect(tool).toContainText("No last use recorded");
    await expect(tool).not.toContainText("Not used yet");
    await expect(tool.getByTestId("entry-not-removable")).toHaveText(
      "Clawtrate can't remove this entry: the file gives it no id.",
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
    await expect(
      page.getByText("Removed /bin/ls for Otto. The file read back no longer lists the entry."),
    ).toBeVisible();
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

  test("F-178: an entry edited in place after the confirmation opened is not removed; the person is asked again about it as it is now", async ({
    page,
  }) => {
    await openFixture(page, `${ADMIN}&remove=changed`, "light");
    await permissions("Saved approvals", grants)(page);
    const entry = page.getByTestId("allowlist-entry").filter({ hasText: "/bin/ls" });
    await entry.getByRole("button", { name: "Remove…" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    // Nothing removed: asked again, with the entry the file lists under that id now.
    const again = page.getByRole("alertdialog");
    await expect(again).toContainText(
      "The gateway's file changed since it was shown, and nothing was removed. It now lists this entry as: /usr/bin/true for Otto",
    );
    await expect(again.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expect(announced(page)).toHaveText("Nothing removed");
    await expect(page.getByText(/^Removed /)).toHaveCount(0);
    const removes = (await sent(page)).filter((each) => each.type === "removeAllowlistEntry");
    expect(removes).toEqual([expect.objectContaining({ shownHash: "fixture-hash" })]);
    // Confirmed again, it is written against the revision now shown, and names that entry.
    await again.getByRole("button", { name: "Remove" }).click();
    await expect(
      page.getByText(
        "Removed /usr/bin/true for Otto. The file read back no longer lists the entry.",
      ),
    ).toBeVisible();
    expect(
      (await sent(page)).filter((each) => each.type === "removeAllowlistEntry").at(-1),
    ).toMatchObject({ shownHash: "fixture-hash-2" });
  });

  test("F-178: a conflict whose entry is past the rows shown says it isn't shown, and removes nothing", async ({
    page,
  }) => {
    await openFixture(page, `${ADMIN}&remove=hidden`, "light");
    await permissions("Saved approvals", grants)(page);
    await page
      .getByTestId("allowlist-entry")
      .filter({ hasText: "/bin/ls" })
      .getByRole("button", { name: "Remove…" })
      .click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(
      page.getByText(
        "The gateway's file changed since it was shown, and nothing was removed. This entry isn't shown in the refreshed list.",
      ),
    ).toBeVisible();
    await expect(page.getByText(/^Removed /)).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });

  test("F-178: a confirmation open when a new connection arrives closes without a command; the new row sends its own revision and digest", async ({
    page,
  }) => {
    await openFixture(page, ADMIN, "light");
    await permissions("Saved approvals", grants)(page);
    const entry = () => page.getByTestId("allowlist-entry").filter({ hasText: "/bin/ls" });
    await entry().getByRole("button", { name: "Remove…" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    // A new hello while the dialog is open: the page reads the file again, as another revision.
    const helloAt = NOW.getTime() + 60_000;
    await page.evaluate((at) => {
      (
        window as unknown as {
          clawtrateFixture: {
            setState: (change: (state: { connection: object }) => { connection: object }) => void;
          };
        }
      ).clawtrateFixture.setState((state) => ({
        ...state,
        connection: { ...state.connection, connectedAt: at },
      }));
    }, helloAt);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect((await sent(page)).some((each) => each.type === "removeAllowlistEntry")).toBe(false);
    await entry().getByRole("button", { name: "Remove…" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText(/^Removed \/bin\/ls for Otto\./)).toBeVisible();
    const revision = `fixture-hash@${helloAt}`;
    expect((await sent(page)).filter((each) => each.type === "removeAllowlistEntry")).toEqual([
      expect.objectContaining({
        shownHash: revision,
        shownDigest: createHash("sha256").update(revision).digest("hex"),
        connectedAt: helloAt,
      }),
    ]);
  });

  test("F-178: two long patterns alike in all the page shows offer no Remove", async ({ page }) => {
    await openFixture(page, `${ADMIN}&saved=long`, "light");
    await permissions("Saved approvals", grants)(page);
    const long = page.getByTestId("allowlist-entry").filter({ hasText: "/opt/tools/report-" });
    await expect(long).toHaveCount(2);
    await expect(long.getByRole("button", { name: "Remove…" })).toHaveCount(0);
    await expect(long.first().getByTestId("entry-not-removable")).toHaveText(
      "Clawtrate can't remove this entry because its pattern is too long to show in full.",
    );
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
      "5:19 PM, Otto, A task not listed here, write, Blocked, Recorded: Otto's Never rule, version 1 (now version 2).",
    );
    await expect(all.nth(3)).toHaveAccessibleName(
      `2:40 AM, Pip, Plan the week, write, Failed, Recorded: asked because "Ask when nothing else decides", on for every bot; answered Deny.`,
    );
    // The bot's and the task's names are on the row, not only in its name.
    await expect(all.nth(0)).toContainText("Otto · Disk almost full on the media box");
    await expect(all.nth(3)).toContainText("Pip · Plan the week");
    // A routine's call no record joins: cause not recorded.
    await expect(all.nth(2)).toContainText("A routine's run");
    await expect(all.nth(2)).toContainText("Cause not recorded");
    // A cause whose source could not be read says so, and the tag is the audit record's own.
    await expect(all.nth(4)).toContainText("Started");
    await expect(all.nth(4)).toContainText("Cause not read.");
    await expect(all.nth(5)).toHaveAccessibleName(
      /^Yesterday, Otto, [^,]+, write, Ran, Recorded: asked by Otto's rule 'Ask first · notes\/\*\*', version 1; answered Allow once\.$/,
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

  test("F-324: an older page answered after the filter changed never replaces the newer answer", async ({
    page,
  }) => {
    const fixture = (method: "hold" | "release") =>
      page.evaluate(
        (name) =>
          (window as unknown as { clawtrateFixture: Record<string, () => void> }).clawtrateFixture[
            name
          ]!(),
        method,
      );
    await openFixture(page, ADMIN, "light");
    await permissions("Activity", rows)(page);
    await expect(page.getByTestId("activity-row")).toHaveCount(6);
    // The older page's answer is held back while the filter changes and is answered.
    await fixture("hold");
    await page.getByRole("button", { name: "Show older" }).click();
    await page.getByTestId("activity-outcome").click();
    await page.getByRole("menuitemradio", { name: "Blocked" }).click();
    await expect(page.getByTestId("activity-row")).toHaveCount(1);
    await fixture("release");
    // The older answer was for the earlier filter: it is dropped, and the newer answer stays.
    await expect(page.getByRole("status", { name: "Loading activity" })).toHaveCount(0);
    await expect(page.getByTestId("activity-row")).toHaveCount(1);
    await expect(page.getByTestId("activity-row")).toContainText("Blocked");
    await expect(page.getByRole("button", { name: "Loading…" })).toHaveCount(0);
  });

  test("F-324: each Activity read is its own: a held older page from an earlier read never adds its rows, and Show older continues the newest read", async ({
    page,
  }) => {
    const fixture = (method: "hold" | "release") =>
      page.evaluate(
        (name) =>
          (window as unknown as { clawtrateFixture: Record<string, () => void> }).clawtrateFixture[
            name
          ]!(),
        method,
      );
    const reconnect = (at: number) =>
      page.evaluate((helloAt) => {
        (
          window as unknown as {
            clawtrateFixture: {
              setState: (change: (state: { connection: object }) => { connection: object }) => void;
            };
          }
        ).clawtrateFixture.setState((state) => ({
          ...state,
          connection: { ...state.connection, connectedAt: helloAt },
        }));
      }, at);
    const outcomeTo = async (name: string) => {
      await page.getByTestId("activity-outcome").click();
      await page.getByRole("menuitemradio", { name }).click();
    };
    const older = page.getByRole("button", { name: "Show older" });
    const lastCursor = async () =>
      (await sent(page))
        .filter((each) => each.type === "readActivity")
        .map((each) => (each as unknown as { cursor: string | null }).cursor)
        .at(-1);

    // All → Blocked → All while the first All's older page is held, released after the second All.
    await openFixture(page, ADMIN, "light");
    await permissions("Activity", rows)(page);
    await expect(page.getByTestId("activity-row")).toHaveCount(6);
    await fixture("hold");
    await older.click();
    expect(await lastCursor()).toBe("older-1");
    await outcomeTo("Blocked");
    await expect(page.getByTestId("activity-row")).toHaveCount(1);
    await outcomeTo("All");
    await expect(page.getByTestId("activity-row")).toHaveCount(6);
    await fixture("release");
    await expect(page.getByTestId("activity-row")).toHaveCount(6);
    await expect(older).toBeEnabled();
    await older.click();
    expect(await lastCursor()).toBe("older-3");
    await expect(page.getByTestId("activity-row")).toHaveCount(7);

    // A new connection while an older page is held: its rows never arrive, and Show older is free.
    await openFixture(page, ADMIN, "light");
    await permissions("Activity", rows)(page);
    await fixture("hold");
    await older.click();
    await reconnect(NOW.getTime() + 60_000);
    await expect(page.getByTestId("activity-row")).toHaveCount(6);
    await fixture("release");
    await expect(page.getByTestId("activity-row")).toHaveCount(6);
    await expect(older).toBeEnabled();

    // The same with an older page that fails: no stale error, and Show older is free.
    await openFixture(page, `${ADMIN}&audit=older-error`, "light");
    await permissions("Activity", rows)(page);
    await fixture("hold");
    await older.click();
    await reconnect(NOW.getTime() + 60_000);
    await expect(page.getByTestId("activity-row")).toHaveCount(6);
    await fixture("release");
    await expect(page.getByText(/^Couldn't load older activity/)).toHaveCount(0);
    await expect(older).toBeEnabled();
  });

  test("F-324: after a failed first page, Try again shows the new rows with no stale error and Show older free", async ({
    page,
  }) => {
    await openFixture(page, `${ADMIN}&audit=fail-once`, "light");
    await permissions("Activity")(page);
    await expect(page.getByRole("heading", { name: "Couldn't load activity" })).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("activity-row")).toHaveCount(6);
    await expect(page.getByRole("heading", { name: "Couldn't load activity" })).toHaveCount(0);
    const older = page.getByRole("button", { name: "Show older" });
    await expect(older).toBeEnabled();
    await older.click();
    await expect(page.getByTestId("activity-row")).toHaveCount(7);
  });

  test("permissions: it opens on Saved approvals, and its parts are one radio group with one tab stop, moved by the arrows", async ({
    page,
  }) => {
    await openFixture(page, ADMIN, "light");
    await page.keyboard.press("ControlOrMeta+,");
    await settings(page).getByRole("button", { name: "Permissions", exact: true }).click();
    await expect(settings(page).getByRole("radio", { name: "Saved approvals" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
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
