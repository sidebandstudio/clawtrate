// "Bot voice" in Settings, Conversation, in the fixture mode (checklist row F-527):
// the setting as the gateway's voice plugin reads it back, a change reaching
// the host, what it says when the plugin's permission is missing, and nothing at
// all when the plugin isn't on the gateway (#796: no link out to set it up).
// The gateway's half is e2e/bot-voice.spec.ts.
import { readFileSync } from "node:fs";
import { test, type Page } from "@playwright/test";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.name === "phone")!;
const GUIDE = readFileSync(
  new URL("../plugins/clawtrate-voice/voice.md", import.meta.url),
  "utf8",
).trim();

async function openPane(page: Page, query = "", theme: "light" | "dark" = "light") {
  await openFixture(page, `scene=composer&${OTTO_DISK}&panel=closed${query}`, theme);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Conversation", level: 3 })).toBeVisible();
  return settings;
}

const sent = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: { type: string; on?: boolean }[] } }
    ).clawtrateFixture.sent.filter((command) => command.type === "setBotVoice"),
  );
const reads = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { clawtrateFixture: { sent: { type: string }[] } }
      ).clawtrateFixture.sent.filter((command) => command.type === "readBotVoice").length,
  );
const README =
  "https://github.com/sidebandstudio/clawtrate/blob/main/plugins/clawtrate-voice/README.md";
const LIMITS = `${README}#where-the-guide-doesnt-reach`;
type FixtureState = { connection: { target?: number }; voiceChanges?: number };
type FixtureWindow = {
  clawtrateFixture: { setState: (change: (state: FixtureState) => FixtureState) => void };
  voiceFails?: boolean;
  voiceReadsHeld?: boolean;
  voiceSaveRelease?: boolean;
  voiceSavesAnswered?: number;
  voiceServerSet?: (on: boolean) => void;
};
/** The host's state as it arrives again after the browser's link to the host drops and returns. */
const browserRelink = async (page: Page) => {
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).clawtrateFixture.setState((state) => ({
      ...state,
      connection: { ...state.connection, status: "reconnecting", retryAt: null },
    })),
  );
  // The host's own connection to the gateway never dropped: connectedAt is the same.
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).clawtrateFixture.setState((state) => ({
      ...state,
      connection: { ...state.connection, status: "connected" },
    })),
  );
};
/** The connected gateway's identity, as the client confirms it (null: it named none). */
const gatewayNames = (page: Page, gatewayId: string | null) =>
  page.evaluate(
    (id) =>
      (window as unknown as FixtureWindow).clawtrateFixture.setState((state) => ({
        ...state,
        connection: { ...state.connection, gatewayId: id },
      })),
    gatewayId,
  );
// The fixture's state changed as the client would change it.
const disconnect = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as FixtureWindow).clawtrateFixture.setState((state) => ({
      ...state,
      connection: { ...state.connection, status: "reconnecting", retryAt: null },
    })),
  );
const reconnect = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as FixtureWindow).clawtrateFixture.setState((state) => ({
      ...state,
      connection: { ...state.connection, status: "connected", connectedAt: Date.now() },
    })),
  );
/** The plugin's changed event, or plugins.changed: the client counts it in `voiceChanges`. */
const reportChange = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as FixtureWindow).clawtrateFixture.setState((state) => ({
      ...state,
      voiceChanges: (state.voiceChanges ?? 0) + 1,
    })),
  );
/** The host switches to another gateway, as another tab can make it do. */
const switchGateway = (page: Page, gatewayId: string) =>
  page.evaluate(
    (id) =>
      (window as unknown as FixtureWindow).clawtrateFixture.setState((state) => ({
        ...state,
        // A switch points the host at a gateway anew: its target moves on.
        connection: {
          ...state.connection,
          gatewayId: id,
          connectedAt: Date.now(),
          target: (state.connection.target ?? 0) + 1,
        },
      })),
    gatewayId,
  );
const saves = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        clawtrateFixture: {
          sent: {
            type: string;
            on?: boolean;
            stamp?: { gatewayId: string | null; target: number };
          }[];
        };
      }
    ).clawtrateFixture.sent.filter((command) => command.type === "setBotVoice"),
  );
/** Let the fixture's slow saves answer, and wait until their answers have reached the page. */
const releaseSaves = async (page: Page, answers: number) => {
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).voiceSaveRelease = true;
  });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as FixtureWindow).voiceSavesAnswered ?? 0))
    .toBe(answers);
};
/** Whether the fixture's gateway keeps every read of the setting waiting. */
const holdReads = (page: Page, held: boolean) =>
  page.evaluate((value) => {
    (window as unknown as FixtureWindow).voiceReadsHeld = value;
  }, held);
/** Whether the fixture's gateway fails every read of the setting from now on. */
const readsFail = (page: Page, fails: boolean) =>
  page.evaluate((value) => {
    (window as unknown as FixtureWindow).voiceFails = value;
  }, fails);

test.describe("bot voice", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-527: Bot voice shows the gateway's setting, on by default, and a change reaches the host", async ({
    page,
  }) => {
    const settings = await openPane(page);
    const voice = settings.getByRole("switch", { name: "Bot voice" });
    await expect(voice).toBeChecked();
    // It says where the guide goes, and what the guide asks, not what every bot will do.
    await expect(voice).toHaveAccessibleDescription(
      /a voice guide is added to a bot's system prompt each time the gateway runs the plugin's hook, if its config permits the hook\. The guide asks the bots to talk plainly and kindly, with no em dashes\./,
    );
    await expect(voice).not.toHaveAccessibleDescription(/every bot|wherever it builds/i);
    await expect(settings.getByTestId("bot-voice-state")).toHaveText(
      "On, as the gateway reads it, by default.",
    );
    // What the app knows is that the hook is permitted, not that every run got the guide,
    // and the limits are one link away.
    await expect(settings.getByText("Prompt hook permitted")).toBeVisible();
    await expect(settings.getByTestId("bot-voice-hook")).toHaveText("Yes");
    await expect(settings.getByText("Guide reaching the bots")).toHaveCount(0);
    await expect(
      settings.getByRole("link", { name: "Where the guide doesn't reach" }),
    ).toHaveAttribute("href", LIMITS);
    await expect(settings.getByTestId("bot-voice-blocked")).toHaveCount(0);
    // The guide is the plugin's own, as the gateway gave it.
    await settings.getByText("What the guide asks the bots to do").click();
    await expect(settings.locator(".bot-voice-guide")).toHaveText(GUIDE);
    await voice.click();
    await expect(voice).not.toBeChecked();
    await expect(settings.getByTestId("bot-voice-state")).toHaveText(
      "Off, as the gateway reads it.",
    );
    // The hook's permission is the gateway's config, not the preference.
    await expect(settings.getByTestId("bot-voice-hook")).toHaveText("Yes");
    expect(await sent(page)).toEqual([
      {
        type: "setBotVoice",
        on: false,
        stamp: { gatewayId: expect.any(String), target: expect.any(Number) },
      },
    ]);
    await voice.click();
    await expect(voice).toBeChecked();
    expect(await sent(page)).toEqual([
      {
        type: "setBotVoice",
        on: false,
        stamp: { gatewayId: expect.any(String), target: expect.any(Number) },
      },
      {
        type: "setBotVoice",
        on: true,
        stamp: { gatewayId: expect.any(String), target: expect.any(Number) },
      },
    ]);
  });

  test("F-527: a refused change leaves the switch as the gateway has it", async ({ page }) => {
    const settings = await openPane(page, "&voice=off&voicesave=fail");
    const voice = settings.getByRole("switch", { name: "Bot voice" });
    await expect(voice).not.toBeChecked();
    await voice.click();
    await expect(settings.getByRole("alert")).toHaveText("missing scope: operator.write");
    await expect(voice).not.toBeChecked();
    // What the gateway holds is read back after the refusal.
    await expect.poll(() => reads(page)).toBe(2);
    await expect(settings.getByTestId("bot-voice-state")).toHaveText(
      "Off, as the gateway reads it.",
    );
  });

  test("F-527: a change whose answer was lost is read back, not assumed", async ({ page }) => {
    const settings = await openPane(page, "&voicesave=lost");
    const voice = settings.getByRole("switch", { name: "Bot voice" });
    await expect(voice).toBeChecked();
    await voice.click();
    await expect(settings.getByRole("alert")).toHaveText("The gateway did not answer in time.");
    // The gateway stored it: the read back shows it off.
    await expect(voice).not.toBeChecked();
    await expect(settings.getByTestId("bot-voice-state")).toHaveText(
      "Off, as the gateway reads it.",
    );
    expect(await reads(page)).toBe(2);
  });

  test("F-527: while disconnected the setting is unconfirmed, and a reconnect reads it again", async ({
    page,
  }) => {
    const settings = await openPane(page);
    const voice = settings.getByRole("switch", { name: "Bot voice" });
    await expect(voice).toBeEnabled();
    expect(await reads(page)).toBe(1);
    await disconnect(page);
    await expect(settings.getByTestId("bot-voice-state")).toHaveText(
      "On when last read. Not connected, so it isn't confirmed.",
    );
    await expect(settings.getByTestId("bot-voice-hook")).toHaveText("Not confirmed yet.");
    await expect(voice).toBeDisabled();
    await reconnect(page);
    await expect.poll(() => reads(page)).toBe(2);
    await expect(settings.getByTestId("bot-voice-state")).toHaveText(
      "On, as the gateway reads it, by default.",
    );
    await expect(voice).toBeEnabled();
  });

  test("F-527: another device's change is read again when the gateway reports it", async ({
    page,
  }) => {
    const settings = await openPane(page);
    const voice = settings.getByRole("switch", { name: "Bot voice" });
    await expect(voice).toBeEnabled();
    await expect(voice).toBeChecked();
    expect(await reads(page)).toBe(1);
    // Another device turns it off, and the gateway reports the change.
    await page.evaluate(() => (window as unknown as FixtureWindow).voiceServerSet!(false));
    await reportChange(page);
    await expect.poll(() => reads(page)).toBe(2);
    await expect(settings.getByTestId("bot-voice-state")).toHaveText(
      "Off, as the gateway reads it.",
    );
    await expect(voice).not.toBeChecked();
  });

  test("F-527: a refusal read before a disconnect is not shown as current, and a missing plugin stays unshown", async ({
    page,
  }) => {
    const missing = await openPane(page, "&voice=missing");
    await expect(missing.getByTestId("bot-voice")).toHaveCount(0);
    await disconnect(page);
    await expect(missing.getByTestId("turn-limit")).toBeVisible();
    await expect(missing.getByTestId("bot-voice")).toHaveCount(0);
    for (const voice of ["refused"]) {
      const settings = await openPane(page, `&voice=${voice}`);
      await expect(settings.getByTestId("bot-voice")).toHaveAttribute("data-confirmed", "true");
      await expect(settings.getByTestId("bot-voice-freshness")).toHaveCount(0);
      await disconnect(page);
      await expect(settings.getByTestId("bot-voice")).toHaveAttribute("data-confirmed", "false");
      await expect(settings.getByTestId("bot-voice-freshness")).toHaveText(
        "Not connected. This is what the gateway said when last read.",
      );
    }
  });

  test("F-527: a read that fails after a reconnect keeps its error and its retry", async ({
    page,
  }) => {
    for (const voice of ["on", "refused"]) {
      const settings = await openPane(page, `&voice=${voice}`);
      await expect(settings.getByTestId("bot-voice")).toHaveAttribute("data-confirmed", "true");
      await disconnect(page);
      // The gateway stops answering, then the connection comes back.
      await readsFail(page, true);
      await reconnect(page);
      const freshness = settings.getByTestId("bot-voice-freshness");
      await expect(freshness.getByRole("alert")).toContainText(
        "Couldn't read the setting again. The gateway did not answer.",
      );
      await expect(freshness.getByRole("button", { name: "Try again" })).toBeVisible();
      await readsFail(page, false);
      await freshness.getByRole("button", { name: "Try again" }).click();
      await expect(settings.getByTestId("bot-voice")).toHaveAttribute("data-confirmed", "true");
    }
  });

  test("F-527: a change is sent for the gateway whose setting is shown", async ({ page }) => {
    const settings = await openPane(page);
    const voice = settings.getByRole("switch", { name: "Bot voice" });
    await voice.click();
    await expect(voice).not.toBeChecked();
    const [first] = await saves(page);
    expect(first).toMatchObject({
      on: false,
      stamp: { gatewayId: expect.any(String), target: expect.any(Number) },
    });
    // Another tab switches the host to gateway B: A's switch goes, and B's comes from B, which
    // is still on.
    await switchGateway(page, "gw-other");
    await expect(settings.getByTestId("bot-voice")).toHaveAttribute("data-confirmed", "true");
    await expect(settings.getByTestId("bot-voice-state")).toHaveText(
      "On, as the gateway reads it, by default.",
    );
    await expect(voice).toBeChecked();
    await voice.click();
    await expect.poll(async () => (await saves(page)).at(-1)?.stamp?.gatewayId).toBe("gw-other");
    // Sent for B's own target, not A's.
    const [, second] = await saves(page);
    expect(second!.stamp!.target).toBeGreaterThan(first!.stamp!.target);
  });

  test("F-527: after a switch to another gateway, a failed read shows no setting of the last one", async ({
    page,
  }) => {
    const settings = await openPane(page);
    await expect(settings.getByRole("switch", { name: "Bot voice" })).toBeChecked();
    await readsFail(page, true);
    await switchGateway(page, "gw-other");
    await expect(settings.getByRole("alert")).toContainText(
      "Couldn't read the bots' voice setting.",
    );
    await expect(settings.getByRole("switch", { name: "Bot voice" })).toHaveCount(0);
    await readsFail(page, false);
    await settings.getByRole("button", { name: "Try again" }).click();
    await expect(settings.getByRole("switch", { name: "Bot voice" })).toBeChecked();
  });

  test("F-527: a save's late answer doesn't undo a newer read", async ({ page }) => {
    const settings = await openPane(page, "&voicesave=slow");
    const voice = settings.getByRole("switch", { name: "Bot voice" });
    await voice.click();
    // The gateway stored it and said so to every device; the read that follows confirms it.
    await reportChange(page);
    await expect(settings.getByTestId("bot-voice-state")).toHaveText(
      "Off, as the gateway reads it.",
    );
    // Then the save's own answer arrives, late.
    await page.evaluate(() => {
      (window as unknown as FixtureWindow).voiceSaveRelease = true;
    });
    await expect(voice).not.toHaveAttribute("aria-busy", "true");
    await expect(settings.getByTestId("bot-voice")).toHaveAttribute("data-confirmed", "true");
    await expect(voice).toBeEnabled();
  });

  test("F-527: a failed read's error shows only until another read is asked for", async ({
    page,
  }) => {
    const settings = await openPane(page);
    await expect(settings.getByTestId("bot-voice")).toHaveAttribute("data-confirmed", "true");
    const freshness = settings.getByTestId("bot-voice-freshness");
    // A reported change, and its read fails.
    await readsFail(page, true);
    await reportChange(page);
    await expect(freshness.getByRole("alert")).toContainText("Couldn't read the setting again.");
    // Try again, while the gateway hasn't answered yet: the last read's error is gone.
    await readsFail(page, false);
    await holdReads(page, true);
    await freshness.getByRole("button", { name: "Try again" }).click();
    await expect(freshness).toHaveText(
      "Checking with the gateway. This is what it said when last read.",
    );
    await expect(settings.getByRole("alert")).toHaveCount(0);
    await holdReads(page, false);
    await expect(settings.getByTestId("bot-voice")).toHaveAttribute("data-confirmed", "true");
    // It fails again, then the host switches to gateway B, whose first read is on its way:
    // A's error isn't shown under B.
    await readsFail(page, true);
    await reportChange(page);
    await expect(freshness.getByRole("alert")).toContainText("Couldn't read the setting again.");
    await readsFail(page, false);
    await holdReads(page, true);
    await switchGateway(page, "gw-other");
    await expect(settings.getByTestId("bot-voice")).toHaveText(
      "Reading the bots' voice setting from the gateway…",
    );
    await expect(settings.getByRole("alert")).toHaveCount(0);
    await holdReads(page, false);
    await expect(settings.getByTestId("bot-voice")).toHaveAttribute("data-confirmed", "true");
  });

  test("F-527: a save whose answer is lost after a newer read still shows and is read back", async ({
    page,
  }) => {
    const settings = await openPane(page, "&voicesave=slowlost");
    const voice = settings.getByRole("switch", { name: "Bot voice" });
    await voice.click();
    // The gateway's plugins change while the save is on its way, and that read finishes first.
    await reportChange(page);
    await expect.poll(() => reads(page)).toBe(2);
    await expect(settings.getByTestId("bot-voice")).toHaveAttribute("data-confirmed", "true");
    // Then the save's answer is lost: it says so, and what the gateway holds is read back.
    await releaseSaves(page, 1);
    await expect(settings.getByRole("alert")).toHaveText("The gateway did not answer in time.");
    await expect.poll(() => reads(page)).toBe(3);
    await expect(settings.getByTestId("bot-voice-state")).toHaveText(
      "Off, as the gateway reads it.",
    );
  });

  test("F-527: a gateway that names no identity offers no switch, and one named later is read", async ({
    page,
  }) => {
    const settings = await openPane(page);
    await expect(settings.getByRole("switch", { name: "Bot voice" })).toBeChecked();
    const before = await reads(page);
    await gatewayNames(page, null);
    await expect(settings.getByTestId("bot-voice-unidentified")).toHaveText(
      "The gateway didn't say which gateway it is, so Clawtrate can't tie a change to it. Bot voice isn't available on this connection.",
    );
    await expect(settings.getByRole("switch", { name: "Bot voice" })).toHaveCount(0);
    await expect(settings.getByRole("button", { name: "Try again" })).toBeVisible();
    // The same connection names itself later: the setting is read again, for that gateway.
    await gatewayNames(page, "gw-late");
    await expect.poll(() => reads(page)).toBeGreaterThan(before + 1);
    await expect(settings.getByRole("switch", { name: "Bot voice" })).toBeEnabled();
    await expect(settings.getByTestId("bot-voice")).toHaveAttribute("data-confirmed", "true");
  });

  test("F-527: after the browser's link to the host returns, a failed read shows, not the old value as confirmed", async ({
    page,
  }) => {
    const settings = await openPane(page);
    await expect(settings.getByTestId("bot-voice")).toHaveAttribute("data-confirmed", "true");
    await readsFail(page, true);
    await browserRelink(page);
    const freshness = settings.getByTestId("bot-voice-freshness");
    await expect(freshness.getByRole("alert")).toContainText("Couldn't read the setting again.");
    await expect(freshness.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(settings.getByTestId("bot-voice")).toHaveAttribute("data-confirmed", "false");
  });

  test("F-527: a save's late answer isn't announced over a newer read", async ({ page }) => {
    const settings = await openPane(page, "&voicesave=slow");
    const voice = settings.getByRole("switch", { name: "Bot voice" });
    await voice.click();
    // Another device turns it back on before this save's answer comes, and every device hears.
    await page.evaluate(() => (window as unknown as FixtureWindow).voiceServerSet!(true));
    await reportChange(page);
    await expect(settings.getByTestId("bot-voice-state")).toHaveText(
      "On, as the gateway reads it.",
    );
    await releaseSaves(page, 1);
    await expect(voice).not.toHaveAttribute("aria-busy", "true");
    // The late "off" answer is dropped, and so is its announcement.
    await expect(page.getByTestId("b-announcer")).not.toHaveText("Bot voice off");
    await expect(voice).toBeChecked();
  });

  test("F-527: a save whose pane closed isn't announced over the reopened pane", async ({
    page,
  }) => {
    const settings = await openPane(page, "&voicesave=slow");
    await settings.getByRole("switch", { name: "Bot voice" }).click();
    // Leave Conversation while the save is on its way; another device turns it back on.
    await settings.getByRole("button", { name: "Gateway", exact: true }).click();
    await expect(settings.getByTestId("bot-voice")).toHaveCount(0);
    await page.evaluate(() => (window as unknown as FixtureWindow).voiceServerSet!(true));
    await settings.getByRole("button", { name: "Conversation", exact: true }).click();
    const voice = settings.getByRole("switch", { name: "Bot voice" });
    await expect(settings.getByTestId("bot-voice-state")).toHaveText(
      "On, as the gateway reads it.",
    );
    // The first pane's save answers "off" now, late: nothing on screen is about it.
    await releaseSaves(page, 1);
    await expect(page.getByTestId("b-announcer")).not.toHaveText("Bot voice off");
    await expect(voice).toBeChecked();
    await expect(settings.getByTestId("bot-voice")).toHaveAttribute("data-confirmed", "true");
  });

  test("F-527: while its change is on its way, the switch is unavailable and keeps focus", async ({
    page,
  }) => {
    const settings = await openPane(page, "&voicesave=slow");
    const voice = settings.getByRole("switch", { name: "Bot voice" });
    await voice.focus();
    await page.keyboard.press("Space");
    await expect(voice).toHaveAttribute("aria-busy", "true");
    await expect(voice).toHaveAttribute("aria-disabled", "true");
    await expect(voice).toBeFocused();
    // Pressing it again sends nothing more.
    await page.keyboard.press("Space");
    await page.waitForTimeout(100);
    expect(await saves(page)).toHaveLength(1);
    await releaseSaves(page, 1);
    await expect(voice).not.toHaveAttribute("aria-disabled", "true");
    await expect(voice).toBeFocused();
  });

  test("F-527: a save still on its way to one gateway doesn't hold back another's switch", async ({
    page,
  }) => {
    const settings = await openPane(page, "&voicesave=slow");
    const voice = settings.getByRole("switch", { name: "Bot voice" });
    await voice.click();
    await expect(voice).toHaveAttribute("aria-busy", "true");
    // Another tab switches the host to gateway B before A's save answers.
    await switchGateway(page, "gw-other");
    await expect(settings.getByTestId("bot-voice")).toHaveAttribute("data-confirmed", "true");
    await expect(voice).not.toHaveAttribute("aria-busy", "true");
    await expect(voice).toBeChecked();
    // B's switch works: its change is sent, for B.
    await voice.click();
    await expect.poll(async () => (await saves(page)).length).toBe(2);
    expect((await saves(page)).at(-1)).toMatchObject({
      on: false,
      stamp: { gatewayId: "gw-other" },
    });
    await expect(voice).toHaveAttribute("aria-busy", "true");
    await releaseSaves(page, 2);
    await expect(voice).not.toHaveAttribute("aria-busy", "true");
    await expect(voice).not.toBeChecked();
  });

  test("F-527: a save refused on one gateway shows no error under another's setting", async ({
    page,
  }) => {
    const settings = await openPane(page, "&voice=off&voicesave=fail");
    await settings.getByRole("switch", { name: "Bot voice" }).click();
    await expect(settings.getByRole("alert")).toHaveText("missing scope: operator.write");
    // Another tab switches the host to gateway B; this pane stays open and reads B.
    await switchGateway(page, "gw-other");
    await expect(settings.getByTestId("bot-voice")).toHaveAttribute("data-confirmed", "true");
    await expect(settings.getByRole("switch", { name: "Bot voice" })).toBeVisible();
    await expect(settings.getByRole("alert")).toHaveCount(0);
  });

  test("F-527: read-only, the switch shows the setting and can't change it", async ({ page }) => {
    const settings = await openPane(page, "&access=read");
    const voice = settings.getByRole("switch", { name: "Bot voice" });
    await expect(voice).toBeChecked();
    await expect(voice).toBeDisabled();
    await expect(voice).toHaveAccessibleDescription(/Changing it needs write access\./);
  });

  test("F-527: shows nothing when the gateway lacks the plugin, and says when it hasn't let its hook run", async ({
    page,
  }) => {
    // Every bot gets the same voice guide from Clawtrate's section in its instructions, and
    // there is nothing to do from here: no control, no line, no link out.
    let settings = await openPane(page, "&voice=missing");
    await expect(settings.getByTestId("turn-limit")).toBeVisible();
    await expect(settings.getByTestId("bot-voice")).toHaveCount(0);
    await expect(settings.getByRole("switch", { name: "Bot voice" })).toHaveCount(0);
    await expect(settings.getByText(/voice plugin/)).toHaveCount(0);
    await expect(settings.getByRole("link")).toHaveCount(0);
    settings = await openPane(page, "&voice=blocked");
    const blocked = settings.getByTestId("bot-voice-blocked");
    // Both settings are named, and the one that blocks it says so.
    await expect(blocked).toContainText("plugins.entries.clawtrate-voice.hooks");
    await expect(blocked.getByTestId("bot-voice-allowConversationAccess")).toHaveText(
      "allowConversationAccess must be true. It doesn't, so it blocks the hook.",
    );
    await expect(blocked.getByTestId("bot-voice-allowPromptInjection")).toHaveText(
      "allowPromptInjection must not be false. It does.",
    );
    await expect(blocked).toContainText(
      "The gateway's config doesn't permit the voice plugin's prompt hook, so the plugin adds its guide to no bot's system prompt.",
    );
    await expect(blocked).toContainText("Clawtrate doesn't change the gateway's config.");
    // The preference and whether the hook is permitted are separate facts.
    await expect(settings.getByRole("switch", { name: "Bot voice" })).toBeChecked();
    await expect(settings.getByTestId("bot-voice-hook")).toHaveText("No");
    // No link out to set it up (#796).
    await expect(settings.getByTestId("bot-voice-blocked").getByRole("link")).toHaveCount(0);
    settings = await openPane(page, "&voice=bothoff");
    const both = settings.getByTestId("bot-voice-blocked");
    await expect(both.getByTestId("bot-voice-allowConversationAccess")).toContainText(
      "blocks the hook",
    );
    await expect(both.getByTestId("bot-voice-allowPromptInjection")).toHaveText(
      "allowPromptInjection must not be false. It doesn't, so it blocks the hook.",
    );
    settings = await openPane(page, "&voice=fail");
    await expect(settings.getByRole("alert")).toContainText(
      "Couldn't read the bots' voice setting.",
    );
  });

  test("F-527: a scope refusal is about access, not a missing plugin", async ({ page }) => {
    let settings = await openPane(page, "&voice=refused");
    await expect(settings.getByTestId("bot-voice-refused")).toHaveText(
      "The gateway has Clawtrate's voice plugin, but it won't show this connection the setting. The plugin on the gateway may be a different version from the one this Clawtrate works with. The gateway said: missing scope: operator.admin",
    );
    await expect(settings.getByTestId("bot-voice")).not.toContainText(
      "needs Clawtrate's voice plugin",
    );
    await expect(settings.getByTestId("bot-voice").getByRole("link")).toHaveCount(0);
    await expect(settings.getByRole("link", { name: "How to set it up" })).toHaveCount(0);
    // A refusal from a gateway that lists no methods is how one without the plugin answers:
    // nothing is shown, as for a missing plugin.
    settings = await openPane(page, "&voice=unclear");
    await expect(settings.getByTestId("turn-limit")).toBeVisible();
    await expect(settings.getByTestId("bot-voice")).toHaveCount(0);
  });
});

for (const size of [WIDE, PHONE]) {
  for (const theme of THEMES) {
    test.describe(`bot voice ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      test("F-527: the gateway hasn't let the voice plugin's hook run", async ({ page }) => {
        const settings = await openPane(page, "&voice=blocked", theme);
        await settings.getByTestId("bot-voice-blocked").scrollIntoViewIfNeeded();
        await settle(page);
        await expect(page).toHaveScreenshot(`settings-bot-voice-blocked-${theme}-${size.name}.png`);
      });
    });
  }
}
