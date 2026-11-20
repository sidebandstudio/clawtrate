import { expect, test } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES } from "./fixture.ts";

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
