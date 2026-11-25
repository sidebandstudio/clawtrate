// "How bots work in Clawtrate" in the fixture mode (F-566, #544): Clawtrate's guides as a
// marked section in each bot's AGENTS.md. The yes in Settings, Conversation and the one-time
// card in the rail; each bot's state; Show, Replace and Remove; and what a connection without
// admin access sees. The gateway's half is the guide checks of `pnpm scenarios`.
import { test, type Page } from "@playwright/test";
import { GUIDES_SECTION } from "../packages/core/src/guides.ts";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.name === "phone")!;

async function guidesPane(page: Page, query: string, theme: "light" | "dark" = "light") {
  await openFixture(page, `scene=composer&${OTTO_DISK}&panel=closed${query}`, theme);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Conversation", exact: true }).click();
  const pane = settings.getByTestId("bot-guides");
  await expect(pane.getByText("How bots work in Clawtrate")).toBeVisible();
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

test.describe("how bots work in Clawtrate", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-566: the yes says what is added, where, its size, and lists the bots to choose", async ({
    page,
  }) => {
    const pane = await guidesPane(page, "&access=admin&guides=offer");
    await expect(pane.getByTestId("bot-guides-summary")).toHaveText(
      "Your bots aren't told what a task is in Clawtrate, so a bot asked to put something in a task may not start one.",
    );
    const offer = pane.getByTestId("bot-guides-offer");
    await expect(offer).toContainText("to the top of each bot's instructions file (AGENTS.md)");
    await expect(offer).toContainText(
      "Your bots get it in every conversation, task and routine, including outside Clawtrate.",
    );
    await expect(offer).toContainText(/It adds about [\d,]+ characters to each prompt\./);
    await expect(offer).toContainText("changes nothing else in the file");
    // Read it shows the exact text that goes in.
    await pane.getByText("Read it").click();
    // Read it shows exactly what is written: the marker lines and the notice too.
    await expect(pane.getByTestId("bot-guides-text").locator("pre")).toHaveText(
      GUIDES_SECTION.trimEnd(),
    );
    // Every bot is ticked, and so is "New bots too".
    for (const name of ["Juniper", "Marlow", "Otto", "Pip", "Quartermaster"])
      await expect(pane.getByRole("checkbox", { name: new RegExp(`^${name}`) })).toBeChecked();
    await expect(pane.getByRole("checkbox", { name: /^New bots too/ })).toBeChecked();
    await pane.getByRole("checkbox", { name: /^Pip/ }).uncheck();
    await pane.getByRole("button", { name: "Add to 4 bots" }).click();
    await expect(pane.getByTestId("bot-guide-otto")).toHaveAttribute("data-state", "current");
    await expect(pane.getByTestId("bot-guide-pip")).toHaveAttribute("data-state", "none");
    expect(await changes(page)).toEqual([
      { action: "add", bots: ["main", "marlow", "otto", "quartermaster"], newBots: true },
    ]);
    // What the files hold now is what the gateway answered: Pip still isn't told.
    await expect(pane.getByTestId("bot-guides-summary")).toHaveText(
      "Pip isn't told what a task is in Clawtrate, so a bot asked to put something in a task may not start one.",
    );
    await pane.getByRole("button", { name: "Remove from all bots" }).click();
    await expect(pane.getByTestId("bot-guide-otto")).toHaveAttribute("data-state", "none");
    expect((await changes(page)).at(-1)).toEqual({ action: "remove" });
  });

  test("F-566: a section changed outside Clawtrate is shown and left, and replaced only when asked", async ({
    page,
  }) => {
    const pane = await guidesPane(page, "&access=admin&guides=mixed");
    await expect(pane.getByTestId("bot-guide-otto")).toContainText(
      "Changed outside Clawtrate, so Clawtrate leaves it as it is.",
    );
    await expect(pane.getByTestId("bot-guide-pip")).toContainText(
      "Removed outside Clawtrate. Clawtrate won't add it again unless you ask.",
    );
    // This device added Marlow's, so it brings it up to date by itself.
    await expect(pane.getByTestId("bot-guide-marlow")).toContainText(
      "An older version. Clawtrate updates it when it connects with admin access.",
    );
    // Removed outside Clawtrate: not ticked. Never added, or older: ticked.
    await expect(pane.getByRole("checkbox", { name: /^Pip/ })).not.toBeChecked();
    await expect(pane.getByRole("checkbox", { name: /^Quartermaster/ })).toBeChecked();
    await expect(pane.getByRole("checkbox", { name: /^Marlow/ })).toBeChecked();
    await expect(pane.getByRole("button", { name: "Add to 2 bots" })).toBeEnabled();
    const otto = pane.getByTestId("bot-guide-otto");
    await otto.getByRole("button", { name: "Show" }).click();
    await expect(otto.getByTestId("bot-guide-changed")).toContainText("Lead with a short joke");
    expect(await changes(page)).toEqual([]);
    await otto.getByRole("button", { name: "Replace" }).click();
    await expect(otto).toHaveAttribute("data-state", "current");
    expect(await changes(page)).toEqual([
      { action: "replace", bot: "otto", shown: expect.stringContaining("Lead with a short joke") },
    ]);
  });

  test("F-566: what another device sees: an older section to tick, markers out of shape, a long file", async ({
    page,
  }) => {
    const pane = await guidesPane(page, "&access=admin&guides=odd");
    const marlow = pane.getByTestId("bot-guide-marlow");
    await expect(marlow).toContainText("An older version. Add brings it up to date.");
    await expect(pane.getByRole("checkbox", { name: /^Marlow/ })).toBeChecked();
    // Markers out of shape: Show only, and a plain sentence on what to do.
    const otto = pane.getByTestId("bot-guide-otto");
    await expect(otto).toContainText(
      "Its markers aren't as Clawtrate wrote them, so Clawtrate can't tell where its section ends. Edit the file, or remove the section's text yourself.",
    );
    await expect(otto.getByRole("button", { name: "Show" })).toBeVisible();
    await expect(otto.getByRole("button", { name: "Replace" })).toHaveCount(0);
    // A long file: unticked, and said.
    await expect(
      pane.getByTestId("bot-guide-quartermaster").getByTestId("bot-guide-long"),
    ).toHaveText(
      "Its instructions are long: with this section, the gateway may leave part of them out of Quartermaster of the Family Calendar and Errands's prompt.",
    );
    await expect(pane.getByRole("checkbox", { name: /^Quartermaster/ })).not.toBeChecked();
    await expect(pane.getByRole("checkbox", { name: /^Pip/ })).toBeChecked();
    await expect(pane.getByRole("button", { name: "Add to 2 bots" })).toBeEnabled();
  });

  test("F-566: New bots too can be taken back with every bot added, writing nothing to the bots", async ({
    page,
  }) => {
    const pane = await guidesPane(page, "&access=admin&guides=added");
    // Nothing to add, and still the yes for new bots is shown, as saved, and can be changed.
    await expect(pane.getByRole("button", { name: /^Add to/ })).toHaveCount(0);
    const newBots = pane.getByRole("checkbox", { name: /^New bots too/ });
    await expect(newBots).toBeChecked();
    await newBots.click();
    await expect(newBots).not.toBeChecked();
    await expect(page.getByText("New bots don't get this section")).toBeAttached();
    await newBots.click();
    await expect(newBots).toBeChecked();
    await expect(page.getByText("New bots get this section")).toBeAttached();
    // Only this device's answer changed: no file was added to or taken from.
    expect(await changes(page)).toEqual([
      { action: "newBots", on: false },
      { action: "newBots", on: true },
    ]);
    for (const bot of ["main", "marlow", "otto", "pip", "quartermaster"])
      await expect(pane.getByTestId(`bot-guide-${bot}`)).toHaveAttribute("data-state", "current");
  });

  test("F-566: on a device that hasn't answered, a section from elsewhere leaves New bots too off, and on says it's for new bots only", async ({
    page,
  }) => {
    const pane = await guidesPane(page, "&access=admin&guides=voice");
    const newBots = pane.getByRole("checkbox", { name: /^New bots too/ });
    await expect(newBots).not.toBeChecked();
    await expect(pane.getByTestId("bot-guides-new-here")).toHaveText(
      "For bots made from this device. Turning it on adds or updates nothing else.",
    );
    await newBots.click();
    await expect(newBots).toBeChecked();
    expect(await changes(page)).toEqual([{ action: "newBots", on: true }]);
    await expect(pane.getByTestId("bot-guide-otto")).toHaveAttribute("data-state", "none");
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
    await expect(page.getByText(/Guides replaced/)).toHaveCount(0);
  });

  test("F-566: a file that isn't plain UTF-8 still shows its section, says what to do, and offers nothing that writes", async ({
    page,
  }) => {
    const pane = await guidesPane(page, "&access=admin&guides=utf8");
    const otto = pane.getByTestId("bot-guide-otto");
    await expect(otto).toHaveAttribute("data-state", "current");
    await expect(otto).toContainText("Added");
    await expect(otto.getByTestId("bot-guide-utf8")).toHaveText(
      "Otto's AGENTS.md isn't plain UTF-8 text, so Clawtrate can't change it. Save it as UTF-8 and Clawtrate can add, update or remove its section again.",
    );
    await expect(pane.getByTestId("bot-guide-marlow").getByTestId("bot-guide-utf8")).toBeVisible();
    for (const name of [/^Otto/, /^Marlow/])
      await expect(pane.getByRole("checkbox", { name })).toHaveCount(0);
    // Otto's section is the only one, and Clawtrate can't take it out: no Remove is offered.
    await expect(pane.getByRole("button", { name: "Remove from all bots" })).toHaveCount(0);
    // Otto has the section, so it isn't among the bots not told.
    await expect(pane.getByTestId("bot-guides-summary")).not.toContainText("Otto");
  });

  test("F-566: nothing is announced when the files, read back, don't hold what was asked", async ({
    page,
  }) => {
    const pane = await guidesPane(page, "&access=admin&guides=mixed&guidesave=race");
    await pane.getByTestId("bot-guide-otto").getByRole("button", { name: "Replace" }).click();
    await pane.getByRole("button", { name: /^Add to/ }).click();
    await expect.poll(() => changes(page)).toHaveLength(2);
    await expect(pane.getByTestId("bot-guide-otto")).toHaveAttribute("data-state", "changed");
    await expect(page.getByText(/Guides replaced|Guides added/)).toHaveCount(0);
  });

  test("F-566: no voice-plugin sentence while no bot has the section and none is ticked", async ({
    page,
  }) => {
    const pane = await guidesPane(page, "&access=admin&guides=voicenone");
    await expect(pane.getByTestId("bot-guides-voice")).toBeVisible();
    for (const name of [/^Juniper/, /^Marlow/, /^Otto/, /^Pip/, /^Quartermaster/])
      await pane.getByRole("checkbox", { name }).uncheck();
    await expect(pane.getByTestId("bot-guides-voice")).toHaveCount(0);
  });

  test("F-566: a section that isn't at the top, where Clawtrate put it, is shown and nothing writes to it", async ({
    page,
  }) => {
    const pane = await guidesPane(page, "&access=admin&guides=moved");
    const otto = pane.getByTestId("bot-guide-otto");
    await expect(otto).toContainText(
      "Its section isn't at the top, where Clawtrate put it, so Clawtrate leaves it as it is. Move it back to the top, or remove it yourself.",
    );
    await expect(otto.getByRole("button", { name: "Show" })).toBeVisible();
    await expect(otto.getByRole("button", { name: "Replace" })).toHaveCount(0);
    await expect(pane.getByRole("checkbox", { name: /^Otto/ })).toHaveCount(0);
    // Its section is in the file the gateway gives Otto, so Otto isn't among the bots not told.
    await expect(pane.getByTestId("bot-guides-summary")).not.toContainText("Otto");
    expect(await changes(page)).toEqual([]);
  });

  test("F-566: without admin access New bots too can be turned off, and not on again", async ({
    page,
  }) => {
    const pane = await guidesPane(page, "&guides=added");
    const box = pane.getByRole("checkbox", { name: /^New bots too/ });
    await expect(box).toBeChecked();
    await expect(box).toBeEnabled();
    await expect(pane.getByTestId("bot-guides-new-admin")).toHaveText(
      "Turning it on again needs admin access.",
    );
    await box.uncheck();
    await expect(box).not.toBeChecked();
    await expect(box).toBeDisabled();
    await expect(pane.getByTestId("bot-guides-new-admin")).toHaveText(
      "Turning it on needs admin access.",
    );
    expect(await changes(page)).toEqual([{ action: "newBots", on: false }]);
  });

  test("F-566: without admin access the states are shown and nothing can be sent", async ({
    page,
  }) => {
    const pane = await guidesPane(page, "&guides=mixed");
    await expect(pane.getByText("Adding or removing it needs admin access.")).toBeVisible();
    // No bot's checkbox: only New bots too, saved on here, which can be turned off.
    await expect(pane.getByRole("checkbox")).toHaveCount(1);
    await expect(pane.getByRole("checkbox", { name: /^New bots too/ })).toBeChecked();
    for (const name of ["Replace", /^Add to/, "Remove from all bots"])
      await expect(pane.getByRole("button", { name })).toHaveCount(0);
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
    // Adding sends nothing to the plugin: only the guides change.
    await voice.getByRole("button", { name: /^Add to/ }).click();
    await expect(voice.getByTestId("bot-guide-otto")).toHaveAttribute("data-state", "current");
    const sent = await page.evaluate(() =>
      (
        window as unknown as { clawtrateFixture: { sent: { type: string }[] } }
      ).clawtrateFixture.sent.map((command) => command.type),
    );
    expect(sent.filter((type) => type === "setBotVoice")).toEqual([]);
    // Without the plugin's guide on, nothing is said about it.
    const plain = await guidesPane(page, "&access=admin&guides=mixed");
    await expect(plain.getByTestId("bot-guides-voice")).toHaveCount(0);
    const failed = await guidesPane(page, "&access=admin&guides=fail");
    await expect(failed.getByRole("alert")).toContainText(
      "Couldn't read the bots' instructions. The gateway did not answer.",
    );
    await expect(failed.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("F-566: the rail offers it once with admin access; Not now writes nothing to the gateway", async ({
    page,
  }) => {
    await openFixture(page, `scene=composer&${OTTO_DISK}&access=admin&guides=offer`, "light");
    const card = page.getByTestId("bot-guides-offer-card");
    await expect(card).toContainText("Teach your bots how Clawtrate works");
    await card.getByRole("button", { name: "Not now" }).click();
    await expect(card).toHaveCount(0);
    expect(await changes(page)).toEqual([{ action: "decline" }]);
    // Review opens Settings, Conversation, at the guides.
    await openFixture(page, `scene=composer&${OTTO_DISK}&access=admin&guides=offer`, "light");
    await page.getByTestId("bot-guides-offer-card").getByRole("button", { name: "Review" }).click();
    await expect(
      page.getByRole("dialog", { name: "Settings" }).getByTestId("bot-guides-offer"),
    ).toBeVisible();
    // Answered before on this device, or without admin access: no card.
    for (const query of ["&access=admin", "&guides=offer"]) {
      await openFixture(page, `scene=composer&${OTTO_DISK}${query}`, "light");
      await expect(page.getByTestId("bot-guides-offer-card")).toHaveCount(0);
    }
  });
});

for (const size of [WIDE, PHONE]) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const [name, query] of [
        ["offer", "&access=admin&guides=offer"],
        ["mixed", "&access=admin&guides=mixed"],
        ["odd", "&access=admin&guides=odd"],
      ] as const) {
        test(`F-566: the guides, ${name}`, async ({ page }) => {
          const pane = await guidesPane(page, query, theme);
          await pane.scrollIntoViewIfNeeded();
          await pane.getByText("How bots work in Clawtrate").scrollIntoViewIfNeeded();
          await settle(page);
          await expect(page).toHaveScreenshot(`bot-guides-${name}-${theme}-${size.name}.png`);
        });
      }
      test("F-566: the rail's offer", async ({ page }) => {
        await openFixture(page, `scene=composer&${OTTO_DISK}&access=admin&guides=offer`, theme);
        // At phone width the rail is the list a task opens from.
        if (size.phone) await page.getByRole("button", { name: "Back to bots" }).click();
        const card = page.getByTestId("bot-guides-offer-card");
        await card.scrollIntoViewIfNeeded();
        await expect(card).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`bot-guides-card-${theme}-${size.name}.png`);
      });
    });
  }
}
