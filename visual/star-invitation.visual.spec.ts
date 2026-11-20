import { expect, test } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

for (const size of SIZES.filter((each) => each.name === "1440" || each.phone)) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const scene of ["browser", "cli", "success", "failure", "about"]) {
        test(`star invitation ${scene}`, async ({ page }) => {
          await openFixture(
            page,
            `scene=main&${OTTO_DISK}&panel=closed&access=write&star=${scene}`,
            theme,
          );
          if (scene === "about") {
            await page.keyboard.press("ControlOrMeta+,");
            await page.getByRole("button", { name: "About", exact: true }).click();
            await expect(
              page.getByRole("link", { name: "Open GitHub to star Clawtrate" }),
            ).toBeVisible();
          } else {
            const notice = page.getByRole("region", { name: "GitHub invitation" });
            await expect(notice).toBeVisible();
            await expect(notice.getByRole("button", { name: "Star with GitHub CLI" })).toHaveCount(
              scene === "cli" ? 1 : 0,
            );
            await expect(notice).toContainText(
              scene === "success"
                ? "Starred. Thank you."
                : scene === "failure"
                  ? "Couldn't star with the GitHub CLI."
                  : "Enjoying Clawtrate?",
            );
          }
          await settle(page);
          await expect(page).toHaveScreenshot(`star-${scene}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}

for (const works of [true, false]) {
  test(`F-521: the CLI button ${works ? "thanks on success" : "keeps the browser choice on failure"}`, async ({
    page,
  }) => {
    await openFixture(
      page,
      `scene=main&${OTTO_DISK}&access=write&star=${works ? "cli" : "cli-fails"}`,
      "light",
    );
    const notice = page.getByRole("region", { name: "GitHub invitation" });
    await notice.getByRole("button", { name: "Star with GitHub CLI" }).click();
    await expect(notice).toContainText(
      works ? "Starred. Thank you." : "Couldn't star with the GitHub CLI.",
    );
    await expect(notice.getByRole("link", { name: "Open GitHub to star Clawtrate" })).toHaveCount(
      works ? 0 : 1,
    );
    await expect(page.getByTestId("composer-input")).toBeFocused();
  });
}

test("F-520: a reported browser failure leaves the repository available in About", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write&star=open-fails`, "light");
  const link = page.getByRole("link", { name: "Open GitHub to star Clawtrate" });
  await link.click();
  const notice = page.getByRole("region", { name: "GitHub invitation" });
  await expect(notice).toContainText("Couldn't open GitHub. Try again from About.");
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("button", { name: "About", exact: true }).click();
  await link.click();
  await expect(page.getByRole("dialog")).toContainText(
    "Couldn't open GitHub. Try again from About.",
  );
  await expect(link).toBeVisible();
});
