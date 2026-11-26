// "Bots know how Clawtrate works" in the fixture mode (F-566, #544, #628): Clawtrate's guides as
// a marked section in each bot's AGENTS.md, on by default with nothing asked. One switch in
// Settings, Conversation, Read it, a row for each bot that isn't simply as Clawtrate keeps it,
// what a connection without admin access sees, and a sidebar with nothing to press. The gateway's
// half is the guide checks of `pnpm scenarios`.
import { test, type Page } from "@playwright/test";
import { GUIDES_SECTION } from "../packages/core/src/guides.ts";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.name === "phone")!;
const SWITCH = { name: "Bots know how Clawtrate works" };

/** Settings, Conversation, and its guides block, read or not. */
async function openPane(page: Page, query: string, theme: "light" | "dark" = "light") {
  await openFixture(page, `scene=composer&${OTTO_DISK}&panel=closed${query}`, theme);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Conversation", exact: true }).click();
  return settings.getByTestId("bot-guides");
}

/** The guides block once the files are read. */
async function guidesPane(page: Page, query: string, theme: "light" | "dark" = "light") {
  const pane = await openPane(page, query, theme);
  await expect(pane.getByText(SWITCH.name, { exact: true })).toBeVisible();
  return pane;
}

const changes = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: { type: string; change?: unknown }[] } }
    ).clawtrateFixture.sent
      .filter((command) => command.type === "changeBotGuides")
      .map((command) => command.change),
  );

test.describe("bots know how Clawtrate works", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-566: on by default: one switch, one sentence, Read it, and no row while every bot has it", async ({
    page,
  }) => {
    const pane = await guidesPane(page, "&access=admin");
    const toggle = pane.getByRole("switch", SWITCH);
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(toggle).toBeEnabled();
    await expect(pane.locator("#bot-guides-note")).toHaveText(
      "Clawtrate keeps a short section at the top of the AGENTS.md of each bot on this gateway that tells it how to talk to you and what a task is in Clawtrate.",
    );
    // Read it shows exactly what is written: the marker lines and the notice too.
    await pane.getByText("Read it").click();
    await expect(pane.getByTestId("bot-guides-text").locator("pre")).toHaveText(
      GUIDES_SECTION.trimEnd(),
    );
    // Nothing to choose and nothing to approve: no rows, no checkboxes, no Add.
    await expect(pane.getByRole("listitem")).toHaveCount(0);
    await expect(pane.getByRole("checkbox")).toHaveCount(0);
    await expect(pane.getByRole("button", { name: /^Add/ })).toHaveCount(0);
    expect(await changes(page)).toEqual([]);
  });

  test("F-566: turning it off takes it out of every bot with no confirmation, and on adds it again", async ({
    page,
  }) => {
    const pane = await guidesPane(page, "&access=admin");
    const toggle = pane.getByRole("switch", SWITCH);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(pane.getByTestId("bot-guides-state")).toHaveText("Off");
    await expect(page.getByText('"Bots know how Clawtrate works" is off')).toBeAttached();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    // Off: no bot is listed, since none holds a section now.
    await expect(pane.getByRole("listitem")).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText('"Bots know how Clawtrate works" is on')).toBeAttached();
    expect(await changes(page)).toEqual([
      { action: "switch", on: false },
      { action: "switch", on: true },
    ]);
  });

  test("F-566: each bot that needs a look says why, with its one action", async ({ page }) => {
    const pane = await guidesPane(page, "&access=admin&guides=mixed");
    // Juniper has it as Clawtrate keeps it: no row.
    await expect(pane.getByTestId("bot-guide-main")).toHaveCount(0);
    const marlow = pane.getByTestId("bot-guide-marlow");
    await expect(marlow).toContainText(
      "An older version. Its instructions are long, so Clawtrate doesn't update it by itself.",
    );
    await expect(marlow.getByRole("button")).toHaveText(["Update"]);
    const quartermaster = pane.getByTestId("bot-guide-quartermaster");
    await expect(quartermaster).toContainText(
      "Its instructions are long: with this section, the gateway may leave part of them out of Quartermaster of the Family Calendar and Errands's prompt, so Clawtrate doesn't add it by itself.",
    );
    await expect(quartermaster.getByRole("button")).toHaveText(["Add"]);
    const pip = pane.getByTestId("bot-guide-pip");
    await expect(pip).toContainText(
      "Removed outside Clawtrate, so Clawtrate doesn't add it again by itself.",
    );
    await expect(pip.getByRole("button")).toHaveText(["Add"]);
    const otto = pane.getByTestId("bot-guide-otto");
    await expect(otto).toContainText("Changed outside Clawtrate, so Clawtrate leaves it as it is.");
    await expect(otto.getByRole("button")).toHaveText(["Show", "Replace"]);
    await otto.getByRole("button", { name: "Show" }).click();
    await expect(otto.getByTestId("bot-guide-changed")).toContainText("Lead with a short joke");
    expect(await changes(page)).toEqual([]);
    // Add puts Pip's back, and its row goes once the file holds it.
    await pip.getByRole("button", { name: "Add" }).click();
    await expect(pip).toHaveCount(0);
    await expect(page.getByText("Added to Pip")).toBeAttached();
    await otto.getByRole("button", { name: "Replace" }).click();
    await expect(otto).toHaveCount(0);
    expect(await changes(page)).toEqual([
      { action: "add", bots: ["pip"] },
      { action: "replace", bot: "otto", shown: expect.stringContaining("Lead with a short joke") },
    ]);
  });

  test("F-566: markers out of shape, a moved section, a file that isn't UTF-8 and one that can't be read are shown, and nothing writes to them", async ({
    page,
  }) => {
    const pane = await guidesPane(page, "&access=admin&guides=odd");
    const otto = pane.getByTestId("bot-guide-otto");
    await expect(otto).toContainText(
      "Its markers aren't as Clawtrate wrote them, so Clawtrate can't tell where its section ends. Edit the file, or remove the section's text yourself.",
    );
    await expect(otto.getByRole("button")).toHaveText(["Show"]);
    const marlow = pane.getByTestId("bot-guide-marlow");
    await expect(marlow).toContainText(
      "Its section isn't at the top, where Clawtrate put it, so Clawtrate leaves it as it is. Move it back to the top, or remove it yourself.",
    );
    await expect(marlow.getByRole("button")).toHaveText(["Show"]);
    const pip = pane.getByTestId("bot-guide-pip");
    await expect(pip).toContainText(
      "Pip's AGENTS.md isn't plain UTF-8 text, so Clawtrate can't change it. Save it as UTF-8 and Clawtrate can add, update or remove its section again.",
    );
    await expect(pip.getByRole("button")).toHaveCount(0);
    await expect(pane.getByTestId("bot-guide-quartermaster")).toContainText(
      "Couldn't read its instructions file. The gateway did not answer.",
    );
    expect(await changes(page)).toEqual([]);
  });

  test("F-566: off, a file that still holds a section has a row, and its Remove takes it out of that bot only", async ({
    page,
  }) => {
    const pane = await guidesPane(page, "&access=admin&guides=offleft");
    await expect(pane.getByRole("switch", SWITCH)).toHaveAttribute("aria-checked", "false");
    const otto = pane.getByTestId("bot-guide-otto");
    await expect(otto).toContainText("Still has Clawtrate's section.");
    // Off wins: a changed section is shown, never replaced.
    await expect(pane.getByTestId("bot-guide-marlow").getByRole("button")).toHaveText(["Show"]);
    // The row's button says which bot it is for.
    const remove = otto.getByRole("button", { name: "Remove" });
    await expect(remove).toHaveAccessibleDescription("Otto");
    await remove.click();
    await expect(otto).toHaveCount(0);
    expect(await changes(page)).toEqual([{ action: "remove", bots: ["otto"] }]);
    await expect(page.getByText("Taken out of Otto")).toBeAttached();
  });

  test("F-566: a file that doesn't exist yet waits for the gateway, and a refused write says why, each with Add", async ({
    page,
  }) => {
    const pane = await guidesPane(page, "&access=admin&guides=new");
    const pip = pane.getByTestId("bot-guide-pip");
    await expect(pip).toContainText(
      "Pip's AGENTS.md doesn't exist yet. The gateway makes it on Pip's next run, and Clawtrate adds the section after that.",
    );
    const otto = pane.getByTestId("bot-guide-otto");
    await expect(otto).toContainText(
      "The gateway refused Clawtrate's change to Otto's AGENTS.md, so Clawtrate doesn't try again by itself. The gateway said: Workspace document exceeds its write bound",
    );
    await expect(otto.getByRole("button", { name: "Add" })).toHaveAccessibleDescription("Otto");
    await pip.getByRole("button", { name: "Add" }).click();
    await expect(pip).toHaveCount(0);
    expect(await changes(page)).toEqual([{ action: "add", bots: ["pip"] }]);
  });

  test("F-566: when this device's record can't be read, the switch isn't shown as on or off, and nothing can be changed", async ({
    page,
  }) => {
    const pane = await guidesPane(page, "&access=admin&guides=unreadable");
    // No switch at all: neither on nor off, and nothing to press. The words say what it is.
    await expect(pane.getByRole("switch")).toHaveCount(0);
    await expect(pane.getByTestId("bot-guides-state")).toHaveText(
      "Not known: this device couldn't read whether it's on or off for this gateway.",
    );
    await expect(pane.locator("#bot-guides-note")).toContainText(
      "Clawtrate changes nothing in the bots' files until this device can read it again.",
    );
    // Only the rows whose words hold either way: Otto's changed section, with Show. The bots
    // that hold Clawtrate's section get no "Still has" row.
    await expect(pane.getByRole("listitem")).toHaveCount(1);
    await expect(pane.getByTestId("bot-guide-otto").getByRole("button")).toHaveText(["Show"]);
    await expect(pane.getByText("Still has Clawtrate's section.")).toHaveCount(0);
    for (const name of ["Add", "Update", "Replace", "Remove"])
      await expect(pane.getByRole("button", { name, exact: true })).toHaveCount(0);
  });

  test("F-566: a gateway that is off only because of another gateway on this device says so, and On changes it alone", async ({
    page,
  }) => {
    const pane = await guidesPane(page, "&access=admin&guides=inherited");
    const toggle = pane.getByRole("switch", SWITCH);
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(pane.locator("#bot-guides-note")).toContainText(
      "It's off here because you turned it off for another gateway on this device. Turning it on here changes this gateway only.",
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(pane.locator("#bot-guides-note")).not.toContainText("another gateway");
    // Turned off again here, it is this gateway's own Off now, not the default's.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(pane.locator("#bot-guides-note")).not.toContainText("another gateway");
    expect(await changes(page)).toEqual([
      { action: "switch", on: true },
      { action: "switch", on: false },
    ]);
  });

  test("F-566: without admin access, one sentence says so, and nothing can be sent", async ({
    page,
  }) => {
    const pane = await guidesPane(page, "&guides=mixed");
    await expect(pane.getByRole("switch", SWITCH)).toBeDisabled();
    await expect(pane.locator("#bot-guides-note")).toContainText(
      "This connection doesn't have admin access, so Clawtrate can't add or remove it from here.",
    );
    for (const name of ["Add", "Update", "Replace", "Remove"])
      await expect(pane.getByRole("button", { name, exact: true })).toHaveCount(0);
    // Show is reading, so it stays.
    await expect(pane.getByRole("button", { name: "Show" })).toBeVisible();
  });

  test("F-566: says when the voice plugin adds its own guide, and when the files can't be read", async ({
    page,
  }) => {
    const voice = await guidesPane(page, "&access=admin&guides=voice");
    await expect(voice.getByTestId("bot-guides-voice")).toHaveText(
      "The voice plugin also adds the voice guide to every bot, so a bot with this section gets it twice. You can turn the plugin's guide off with the Bot voice switch above. Bots without this section then get no voice guide.",
    );
    // The switch sends nothing to the plugin: only the guides change.
    await voice.getByRole("switch", SWITCH).click();
    await expect(voice.getByTestId("bot-guides-voice")).toHaveCount(0);
    const sent = await page.evaluate(() =>
      (
        window as unknown as { clawtrateFixture: { sent: { type: string }[] } }
      ).clawtrateFixture.sent.map((command) => command.type),
    );
    expect(sent.filter((type) => type === "setBotVoice")).toEqual([]);
    const failed = await openPane(page, "&access=admin&guides=fail");
    await expect(failed.getByRole("alert")).toContainText(
      "Couldn't read the bots' instructions. The gateway did not answer.",
    );
    await expect(failed.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(failed.getByRole("switch")).toHaveCount(0);
  });

  test("F-566: Replace says nothing was done when the gateway's files didn't take it", async ({
    page,
  }) => {
    const pane = await guidesPane(page, "&access=admin&guides=mixed&guidesave=fail");
    const otto = pane.getByTestId("bot-guide-otto");
    await otto.getByRole("button", { name: "Replace" }).click();
    await expect(pane.getByTestId("bot-guides-error")).toHaveText(
      "otto: AGENTS.md kept changing while Clawtrate wrote it, so it was left as it is.",
    );
    await expect(otto).toHaveAttribute("data-state", "changed");
    // Nothing that wasn't read back is announced.
    await expect(page.getByText(/^Added to/)).toHaveCount(0);
  });

  test("F-566: nothing is announced when the files, read back, don't hold what was asked", async ({
    page,
  }) => {
    const pane = await guidesPane(page, "&access=admin&guides=mixed&guidesave=race");
    await pane.getByTestId("bot-guide-otto").getByRole("button", { name: "Replace" }).click();
    await pane.getByTestId("bot-guide-pip").getByRole("button", { name: "Add" }).click();
    await expect.poll(() => changes(page)).toHaveLength(2);
    await expect(pane.getByTestId("bot-guide-otto")).toHaveAttribute("data-state", "changed");
    await expect(page.getByText(/^Added to/)).toHaveCount(0);
  });

  test("F-566: the sidebar asks nothing: no card and nothing to press, with admin access", async ({
    page,
  }) => {
    for (const guides of ["", "&guides=off"]) {
      await openFixture(page, `scene=composer&${OTTO_DISK}&access=admin${guides}`, "light");
      await expect(page.getByText("Teach your bots how Clawtrate works")).toHaveCount(0);
      await expect(page.getByTestId("bot-guides-offer-card")).toHaveCount(0);
      expect(await changes(page)).toEqual([]);
    }
  });
});

for (const size of [WIDE, PHONE]) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const [name, query] of [
        ["on", "&access=admin"],
        ["off", "&access=admin&guides=off"],
        ["mixed", "&access=admin&guides=mixed"],
        ["odd", "&access=admin&guides=odd"],
        ["new", "&access=admin&guides=new"],
        ["unreadable", "&access=admin&guides=unreadable"],
        ["inherited", "&access=admin&guides=inherited"],
      ] as const) {
        test(`F-566: the guides, ${name}`, async ({ page }) => {
          const pane = await guidesPane(page, query, theme);
          await pane.scrollIntoViewIfNeeded();
          await pane.getByText(SWITCH.name, { exact: true }).scrollIntoViewIfNeeded();
          await settle(page);
          await expect(page).toHaveScreenshot(`bot-guides-${name}-${theme}-${size.name}.png`);
        });
      }
      test("F-566: the sidebar, with nothing to press", async ({ page }) => {
        await openFixture(page, `scene=composer&${OTTO_DISK}&access=admin`, theme);
        // At phone width the rail is the list a task opens from.
        if (size.phone) await page.getByRole("button", { name: "Back to bots" }).click();
        await settle(page);
        await expect(page).toHaveScreenshot(`bot-guides-rail-${theme}-${size.name}.png`);
      });
    });
  }
}
