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
