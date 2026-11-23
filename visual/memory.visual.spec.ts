import type { ClawtrateState } from "../packages/core/src/index.ts";
import { test } from "@playwright/test";
import { contextFor, expect, NOW, openFixture, OTTO_DISK, settle, SIZES } from "./fixture.ts";

for (const size of SIZES.filter((size) => size.name === "1440" || size.phone)) {
  test.describe(size.name, () => {
    test.use(contextFor(size, "light"));

    test("F-211: a bot's memory shows where text is stored and what loads", async ({ page }) => {
      await openFixture(
        page,
        `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=read`,
        "light",
      );
      await page.getByRole("button", { name: "Memory", exact: true }).click();
      const memory = page.getByTestId("memory-page");
      await expect(memory.getByText("Run the checks before opening a pull request.")).toBeVisible();
      await expect(memory.getByText(/MEMORY.md · Otto only/).first()).toBeVisible();
      await expect(
        memory.getByText(/Who saved this revision isn't recorded/).first(),
      ).toBeVisible();
      await expect(memory.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
      await settle(page);
      await expect(page).toHaveScreenshot(`memory-read-${size.name}.png`);
    });

    test("F-212: an admin can edit a stored memory item", async ({ page }) => {
      await openFixture(
        page,
        `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin`,
        "light",
      );
      await page.getByRole("button", { name: "Memory", exact: true }).click();
      const memory = page.getByTestId("memory-page");
      const original = "Run the checks before opening a pull request.";
      await memory
        .getByRole("listitem")
        .filter({ hasText: original })
        .getByRole("button", { name: "Edit", exact: true })
        .click();
      const editor = memory.getByLabel("Memory text");
      await expect(editor).toHaveValue(original);
      await expect(editor).toBeFocused();
      await settle(page);
      await expect(page).toHaveScreenshot(`memory-edit-${size.name}.png`);
      await editor.fill("Run the checks before merging a pull request.");
      await memory.getByRole("button", { name: "Save memory" }).click();
      await expect(
        memory.getByText("Run the checks before merging a pull request.", { exact: true }),
      ).toBeVisible();
    });
  });
}

test("F-211: replacing the gateway at the same address closes its note and reloads memory", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin`, "light");
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  const memory = page.getByTestId("memory-page");
  const note = memory.getByRole("button", { name: "memory/meeting-notes.md" });
  await note.click();
  const text = memory.getByText("Discuss the next release at the weekly meeting.");
  await expect(text).toBeVisible();

  await page.evaluate(() => {
    const { clawtrateFixture } = window as unknown as {
      clawtrateFixture: { setState(change: (state: { connection: object }) => unknown): void };
    };
    clawtrateFixture.setState((state) => ({
      ...state,
      connection: { ...state.connection, gatewayId: "replacement-gateway" },
    }));
  });
  await expect(text).toHaveCount(0);
  await expect(note).toBeVisible();
  const listReads = await page.evaluate(() => {
    const { clawtrateFixture } = window as unknown as {
      clawtrateFixture: { sent: Array<{ type: string }> };
    };
    return clawtrateFixture.sent.filter((command) => command.type === "listMemory").length;
  });
  expect(listReads).toBeGreaterThan(1);
});

test("F-212: the memory page says admin access was granted when the reconnect that brings it reads the gateway's identity again", async ({
  page,
}) => {
  await page.clock.install({ time: NOW });
  await openFixture(page, `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=read`, "light");
  // Paused, so the granted bar cannot time out before the check reads it, however slow the page.
  await page.clock.pauseAt(new Date(NOW.getTime() + 60_000));
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  const memory = page.getByTestId("memory-page");
  const bar = memory.getByTestId("admin-bar");
  await memory.getByRole("button", { name: "Request admin access" }).click();
  await expect(bar).toContainText("Asking the gateway");

  type Fixture = {
    clawtrateFixture: {
      getState(): ClawtrateState;
      setState(change: (state: ClawtrateState) => ClawtrateState): void;
    };
  };
  const { gatewayId, upgrade } = await page.evaluate(
    () => (window as unknown as Fixture).clawtrateFixture.getState().connection,
  );
  const patch = (change: Partial<ClawtrateState["connection"]>) =>
    page.evaluate((change) => {
      (window as unknown as Fixture).clawtrateFixture.setState((state) => ({
        ...state,
        connection: { ...state.connection, ...change },
      }));
    }, change);
  // The client's order on a grant: the approval, then the reconnect's hello with admin while the
  // gateway's id is cleared, then the identity read, each its own snapshot.
  await patch({ upgrade: { ...upgrade, status: "approved" } });
  await expect(bar).toContainText("Approved.");
  await patch({ scopes: upgrade.scopes, canAdmin: true, gatewayId: null });
  await expect(memory.getByRole("button", { name: "Edit", exact: true }).first()).toBeVisible();
  await patch({ gatewayId });
  await expect(bar).toContainText("Admin access granted.");
});
