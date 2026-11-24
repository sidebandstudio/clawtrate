import { test, type Page } from "@playwright/test";
import { contextFor, expect, openFixture, settle, showList, SIZES, THEMES } from "./fixture.ts";

const states = [
  "not-checked",
  "checking",
  "nothing-newer",
  "offered",
  "downloading",
  "verified",
  "failcheck",
  "nofile",
  "faildl",
  "preferences",
  "storage",
  "history",
  "invalid",
  "unsupported",
  "pending",
  "prior-time",
  "only-nightly",
  "long-host",
  "dev",
  "no-source",
  "no-updater",
  "refused",
  "other-current",
  "nightly-build",
];
const actionable = new Set(["offered", "downloading", "verified", "failcheck", "nofile", "faildl"]);

for (const size of SIZES.filter((s) => s.name === "1440" || s.phone))
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const state of states)
        for (const tracks of ["one", "two"]) {
          if (["pending"].includes(state) && tracks === "one") continue;
          if (
            ["prior-time", "only-nightly", "long-host", "invalid", "unsupported"].includes(state) &&
            tracks === "two"
          )
            continue;
          if (state === "nightly-build" && tracks === "two") continue;
          if (tracks === "one" && ["refused", "other-current"].includes(state)) continue;
          if (tracks === "two" && ["dev", "no-source", "no-updater"].includes(state)) continue;
          test(`F-231 F-030: Updates ${state} ${tracks} tracks`, async ({ page }) => {
            const query =
              state === "only-nightly"
                ? "not-checked"
                : state === "long-host"
                  ? "not-checked&longhost=1"
                  : state === "prior-time"
                    ? "nothing-newer&lastTrack=nightly"
                    : state === "nightly-build"
                      ? "not-checked&buildTrack=nightly"
                      : state === "refused"
                        ? "not-checked&save=failed"
                        : state === "other-current"
                          ? "nothing-newer&track=nightly"
                          : state;
            await openFixture(
              page,
              `scene=main&updates=${query}&tracks=${state === "only-nightly" ? "nightly" : tracks}`,
              theme,
            );
            await showList(page);
            const footer = page.getByRole("button", { name: "Open Updates" });
            if (actionable.has(state)) {
              await expect(footer).toBeVisible();
              if (state === "offered" && tracks === "two")
                await expect(
                  page.locator(size.phone ? ".rail-top" : ".rail-footer"),
                ).toHaveScreenshot(`updates/footer-${size.name}-${theme}.png`);
              await expect(page.locator(".gateway-pill")).toBeVisible();
              await expect(footer).toHaveCount(1);
              if (size.phone) {
                const box = await footer.boundingBox();
                expect(box?.width).toBeGreaterThanOrEqual(44);
                expect(box?.height).toBeGreaterThanOrEqual(44);
              }
              await footer.click();
            } else {
              await expect(footer).toHaveCount(0);
              await page.keyboard.press("ControlOrMeta+,");
              await page.getByRole("button", { name: "Updates", exact: true }).click();
            }
            await expect(page.locator(".updates-section")).toBeVisible();
            if (state === "refused") {
              const stable = page.getByRole("radio", { name: "Stable" });
              await stable.focus();
              await page.keyboard.press("ArrowRight");
              await expect(stable).toBeChecked();
              await expect(page.getByRole("group", { name: "Update status" })).toContainText(
                "Couldn't save the track. Stable is still selected.",
              );
            }
            await settle(page);
            expect(
              await page
                .locator(".updates-section dd,.update-source")
                .evaluateAll((rows) => rows.every((row) => row.scrollWidth <= row.clientWidth)),
            ).toBe(true);
            await expect(page.getByRole("dialog")).toHaveScreenshot(
              `updates/${state}-${tracks}-${size.name}-${theme}.png`,
            );
          });
        }
    });
  }

test("F-231: focusing a track as Updates opens keeps the next arrow key on that track", async ({
  page,
}) => {
  await openFixture(page, "scene=main&updates=not-checked&save=failed&tracks=two", "light");
  await page.keyboard.press("ControlOrMeta+,");
  // Move focus at the first opportunity after the section's controls enter the document.
  await page
    .getByRole("button", { name: "Updates", exact: true })
    .evaluate((button: HTMLButtonElement) => {
      const observer = new MutationObserver(() => {
        const track = document.querySelector<HTMLInputElement>(".updates-section input:checked");
        if (!track) return;
        observer.disconnect();
        track.focus();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      button.click();
    });
  await settle(page);
  await expect(page.getByRole("radio", { name: "Stable" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("group", { name: "Update status" })).toContainText(
    "Couldn't save the track. Stable is still selected.",
  );
});

test("F-030: opens Updates from the footer and keeps keyboard focus on the chosen track", async ({
  page,
}) => {
  await openFixture(page, "scene=main&updates=offered", "light");
  const entry = page.getByRole("button", { name: "Open Updates" });
  await entry.click();
  await page.keyboard.press("Escape");
  await expect(entry).toBeFocused();
  await entry.click();
  const group = page.getByRole("radiogroup", { name: "Update track" });
  await group.getByRole("radio", { name: "Stable" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Download", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(group.getByRole("radio", { name: "Stable" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  const nightly = group.getByRole("radio", { name: "Beta" });
  await expect(nightly).toBeChecked();
  await expect(nightly).toBeFocused();
  await expect(page.locator(".update-result dd")).toHaveText("Not checked yet.");
  await page.keyboard.press("Escape");
  await expect(entry).toHaveCount(0);
  await expect(page.locator(".gateway-pill")).toBeFocused();
});

/** Settings → Updates on a Beta build, as the fixture's address chooses it. */
async function openBetaUpdates(page: Page, state: string, extra = "") {
  await openFixture(page, `scene=main&updates=${state}&buildTrack=nightly&tracks=two${extra}`);
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("button", { name: "Updates", exact: true }).click();
  await expect(page.locator(".updates-section")).toBeVisible();
}
const sections = (page: Page) => page.getByTestId("whats-new");

test.describe("what an update adds", () => {
  test.use(contextFor(SIZES[0]!));

  test("F-554: nothing before a check; after it, the offer's list open, a skipped build's and this build's closed, as plain text", async ({
    page,
  }) => {
    await openBetaUpdates(page, "not-checked");
    await expect(sections(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Check for Updates" }).click();
    await expect(page.getByRole("group", { name: "Update status" })).toContainText("0.2.0");
    await expect(sections(page).locator(":scope > summary")).toHaveText([
      "What's new in this build",
      "What's new in 0.2.0-beta.20261116.1",
      "What's new in 0.1.1-beta.20261115.4",
    ]);
    const [running, offered, skipped] = await sections(page).all();
    await expect(offered!).toHaveAttribute("open", "");
    await expect(skipped!).not.toHaveAttribute("open");
    await expect(running!).not.toHaveAttribute("open");
    await expect(offered!.getByRole("listitem")).toHaveText([
      "Settings shows what an update adds (#457)",
      "The download page lists what each beta added (#456)",
      "Conversations hide a bot's thinking unless you turn it on (#447)",
    ]);
    await skipped!.locator(":scope > summary").click();
    await expect(skipped!.getByRole("listitem")).toHaveText([
      "iPhone Settings can show chats from Discord, Telegram and others (#441)",
      "Holding a message on a touch screen opens its actions (#380)",
    ]);
    await expect(page.locator(".updates-section").getByRole("link")).toHaveCount(0);
  });

  test("F-554: with nothing newer only this build's list shows; no lists, or the Stable source, show none", async ({
    page,
  }) => {
    await openBetaUpdates(page, "nothing-newer", "&track=nightly");
    await expect(sections(page).locator(":scope > summary")).toHaveText([
      "What's new in this build",
    ]);
    await openBetaUpdates(page, "offered", "&track=nightly&whatsNew=none");
    await expect(page.getByRole("group", { name: "Update status" })).toContainText("0.2.0");
    await expect(sections(page)).toHaveCount(0);
    await openBetaUpdates(page, "offered", "&track=stable");
    await expect(page.getByRole("group", { name: "Update status" })).toContainText("0.2.0");
    await expect(sections(page)).toHaveCount(0);
  });
});

for (const size of SIZES)
  test.describe(`what an update adds at ${size.name}`, () => {
    test.use(contextFor(size));
    test(`F-554: an offer's lists at ${size.name}`, async ({ page }) => {
      await openBetaUpdates(page, "offered", "&track=nightly");
      await expect(sections(page)).toHaveCount(3);
      await settle(page);
      await expect(page.getByRole("dialog")).toHaveScreenshot(
        `updates/whats-new-offered-${size.name}.png`,
      );
    });
    test(`F-554: this build's list, opened, at ${size.name}`, async ({ page }) => {
      await openBetaUpdates(page, "nothing-newer", "&track=nightly");
      await sections(page).locator(":scope > summary").click();
      await expect(sections(page).getByRole("listitem").first()).toBeVisible();
      await settle(page);
      await expect(page.getByRole("dialog")).toHaveScreenshot(
        `updates/whats-new-running-${size.name}.png`,
      );
    });
  });

test.describe("what this build added, by keyboard", () => {
  test.use(contextFor(SIZES[0]!, "light"));

  test("F-554: this build's list opens from the keyboard, light, at 1440", async ({ page }) => {
    await openFixture(
      page,
      "scene=main&updates=nothing-newer&buildTrack=nightly&tracks=two&track=nightly",
      "light",
    );
    await page.keyboard.press("ControlOrMeta+,");
    await page.getByRole("button", { name: "Updates", exact: true }).click();
    const summary = sections(page).locator(":scope > summary");
    await summary.focus();
    await expect(summary).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(sections(page)).toHaveAttribute("open", "");
    await expect(sections(page).getByRole("listitem").first()).toBeVisible();
    await settle(page);
    await expect(page.getByRole("dialog")).toHaveScreenshot(
      "updates/whats-new-keyboard-light-1440.png",
    );
  });
});
