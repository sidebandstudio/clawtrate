// The web preview's network links are plain HTTP, which is not a secure context, so the
// browser leaves out `crypto.randomUUID` (#1007). The fixture runs on loopback, which is one,
// so these checks take it away before the page loads. A panel that throws anyway shows its
// own message, and the rail and the rest of the app stay.
import type { CheckInsState, ClawtrateState } from "../packages/core/src/index.ts";
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, SIZES } from "./fixture.ts";
import { checkIns } from "./check-ins-helpers.ts";

test.use(
  contextFor(
    SIZES.find((size) => size.name === "1440")!,
    "light",
  ),
);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    delete (Crypto.prototype as Partial<Crypto>).randomUUID;
  });
});

async function routines(page: Page, query: string) {
  await openFixture(page, query, "light");
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(page.getByTestId("routines-view")).toBeVisible();
}

test("F-189: without crypto.randomUUID, as over plain HTTP, New routine opens and saves", async ({
  page,
}) => {
  await routines(page, "scene=main&routines=on&access=admin");
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");
  const editor = page.getByTestId("routine-editor");
  await page.getByTestId("routines-view").getByTestId("new-routine").click();
  await expect(editor.getByRole("heading", { name: "New routine" })).toBeVisible();
  await editor.getByLabel("Bot").selectOption({ label: "Pip" });
  await editor.getByLabel("Name").fill("Weekly reading list");
  await editor.getByLabel("Instruction").fill("List the three articles worth reading first.");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByTestId("b-announcer")).toHaveText("Routine created");
});

test("F-201: without crypto.randomUUID, as over plain HTTP, a bot's check-ins save", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=admin`, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  const dialog = page.getByRole("dialog", { name: "Marlow's check-ins" });
  await dialog.getByRole("radio", { name: /^Daily/ }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("b-announcer")).toHaveText("Check-ins saved");
});

const breakJobs = (page: Page, broken: boolean) =>
  page.evaluate((broken) => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
      }
    ).clawtrateFixture;
    const kept = window as unknown as { keptJobs?: unknown };
    fixture.setState((state) => {
      if (broken) kept.keptJobs = state.checkIns!.jobs;
      const jobs = (broken ? null : kept.keptJobs) as CheckInsState["jobs"];
      return { ...state, checkIns: { ...state.checkIns!, jobs } };
    });
  }, broken);

test("a panel that fails shows its own message, the rail stays, and Try again draws it afresh", async ({
  page,
}) => {
  await routines(page, "scene=main&routines=on&access=admin");
  const view = page.getByTestId("routines-view");
  await expect(view.getByTestId("check-in-summary").first()).toBeVisible();
  // A list only the Routines view reads, made unreadable as a bug would.
  await breakJobs(page, true);
  const failed = page.getByTestId("panel-failed");
  await expect(failed).toContainText("Couldn't show this part");
  await expect(failed).toContainText("The rest of Clawtrate still works.");
  await expect(view).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Routines", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Otto/ }).first()).toBeVisible();
  await breakJobs(page, false);
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(failed).toHaveCount(0);
  await expect(view.getByTestId("check-in-summary").first()).toBeVisible();
});

test("a failure in Routines stays there: the conversation opened next draws as usual", async ({
  page,
}) => {
  await routines(page, "scene=main&routines=on&access=admin");
  await breakJobs(page, true);
  await expect(page.getByTestId("panel-failed")).toBeVisible();
  await breakJobs(page, false);
  await page
    .getByRole("button", { name: /^Disk almost full/ })
    .first()
    .click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await expect(page.getByTestId("panel-failed")).toHaveCount(0);
});

test("a Settings section that fails while Settings draws shows its message, and Settings stays", async ({
  page,
}) => {
  await openFixture(page, "scene=main&routines=on&access=admin", "light");
  await breakJobs(page, true);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Check-ins", exact: true }).click();
  await expect(settings.getByTestId("panel-failed")).toContainText("Couldn't show this part");
  await settings.getByRole("button", { name: "Gateway", exact: true }).click();
  await expect(settings.getByTestId("panel-failed")).toHaveCount(0);
});

test("a conversation that failed to draw marks nothing read while it shows its message", async ({
  page,
}) => {
  const KEY = "agent:otto:disk-space";
  await openFixture(page, `scene=main&${OTTO_DISK}&panel=closed`, "light");
  await expect(page.getByTestId("transcript")).toBeVisible();
  const reads = () =>
    page.evaluate(
      (key) =>
        (
          window as unknown as {
            clawtrateFixture: { sent: Array<{ type: string; key?: string }> };
          }
        ).clawtrateFixture.sent.filter((each) => each.type === "markTask" && each.key === key)
          .length,
      KEY,
    );
  const change = (body: string) =>
    page.evaluate((source) => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
        }
      ).clawtrateFixture;
      fixture.setState(new Function("state", source) as (s: ClawtrateState) => ClawtrateState);
    }, body);
  // The open task's history made unreadable as a bug would.
  await change(
    `const t = state.transcripts["${KEY}"]; return { ...state, transcripts: { ...state.transcripts, "${KEY}": { ...t, runs: null } } };`,
  );
  await expect(page.getByTestId("panel-failed")).toBeVisible();
  const before = await reads();
  // A new reply marks the task unread while its conversation can't be drawn.
  await change(
    `return { ...state, tasksByBot: { ...state.tasksByBot, otto: state.tasksByBot.otto.map((task) => task.key === "${KEY}" ? { ...task, unread: true, unreadMarker: null } : task) } };`,
  );
  await page.waitForTimeout(300);
  expect(await reads()).toBe(before);
});

test("a Work drawer that fails keeps its Try again in reach of the pointer", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await openFixture(page, `scene=main&${OTTO_DISK}&panel=open`, "light");
  await expect(page.locator("aside.work-panel")).toBeVisible();
  const change = (body: string) =>
    page.evaluate((source) => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
        }
      ).clawtrateFixture;
      fixture.setState(new Function("state", source) as (s: ClawtrateState) => ClawtrateState);
    }, body);
  // The accounts made unreadable as a bug would: Work's settings fail with them.
  await change(`window.keptAccounts = state.accounts; return { ...state, accounts: null };`);
  // Work's fallback comes after the conversation's and the drawer's scrim.
  const failed = page.getByTestId("panel-failed").last();
  await expect(failed).toBeVisible();
  await change(`return { ...state, accounts: window.keptAccounts };`);
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("aside.work-panel")).toBeVisible();
});
