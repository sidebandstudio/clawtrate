// F-522: the address form, on a host with secure storage, shows the consent line directly
// above Connect for a secure address, with "What this means" (docs/design/setup-effortless.md §2),
// and a full pairing the gateway granted less says so and asks for nothing (§2, §8). In light
// and dark, at 1440 px and the phone; reached by keyboard and named for a screen reader.
import { test, type Page } from "@playwright/test";
import { COMPUTER } from "./computer-helpers.ts";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const CONSENT =
  "Full control lets Clawtrate change gateway settings, approve devices and, when the gateway allows it, open a terminal on the computer running OpenClaw.";

for (const size of SIZES.filter((each) => each.name === "1440" || each.phone)) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));

      test("F-522: the consent line, closed and open", async ({ page }) => {
        await openFixture(page, "scene=connect-full", theme);
        await expect(page.getByTestId("full-control-consent")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`full-control-consent-${theme}-${size.name}.png`);
        await page.getByRole("button", { name: "What this means" }).click();
        await expect(page.locator(".consent-points")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`full-control-what-${theme}-${size.name}.png`);
      });

      test("F-002: a first pairing at a secure address waits for one approval, of all six in plain words", async ({
        page,
      }) => {
        await openFixture(page, "scene=pairing-full", theme);
        const asks = page.getByRole("list", { name: "This device asks to" }).getByRole("listitem");
        await expect(asks).toHaveText([
          "Read bots, tasks and conversations",
          "Send messages and stop runs",
          "Decide what a bot asks to run",
          "Answer a bot's questions",
          "Change the gateway's settings, bots and accounts",
          "Approve and remove other devices",
        ]);
        await settle(page);
        await expect(page).toHaveScreenshot(`pairing-full-${theme}-${size.name}.png`);
      });

      test("F-002: a plain ws:// address on another computer is warned about above Connect", async ({
        page,
      }) => {
        await openFixture(page, "scene=connect", theme);
        await page.getByPlaceholder("Gateway address").fill("ws://192.168.1.20:18789");
        await expect(page.getByTestId("plain-address-warning")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`connect-plain-ws-${theme}-${size.name}.png`);
      });

      test("F-522: a narrower grant, in Settings", async ({ page }) => {
        await openFixture(page, `scene=access-narrowed&${OTTO_DISK}`, theme);
        await page.keyboard.press("ControlOrMeta+,");
        const dialog = page.getByRole("dialog", { name: "Settings" });
        if (size.phone) await dialog.getByRole("button", { name: /^Gateway/ }).click();
        await expect(dialog.getByTestId("narrower-grant")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`full-control-narrowed-${theme}-${size.name}.png`);
      });
    });
  }
}

test("F-522: the consent line sits directly above Connect, and only for a secure address", async ({
  page,
}) => {
  await openFixture(page, "scene=connect-full", "dark");
  const consent = page.getByTestId("full-control-consent");
  await expect(consent.locator(".consent-line")).toHaveText(`${CONSENT} What this means`);
  // Nothing between it and the button.
  const next = await consent.evaluate((el) => el.nextElementSibling?.className);
  expect(next).toBe("actions");
  const address = page.getByPlaceholder("Gateway address");
  for (const url of ["ws://gateway.example", "wss://127.0.0.1:18789", "wss://localhost"]) {
    await address.fill(url);
    await expect(consent).toHaveCount(0);
  }
  await address.fill("wss://gateway.example.net");
  await expect(page.getByTestId("full-control-consent")).toBeVisible();
});

test("F-522: What this means opens and closes from the keyboard, and says whether it is open", async ({
  page,
}) => {
  await openFixture(page, "scene=connect-full", "dark");
  const more = page.getByRole("button", { name: "What this means" });
  const points = page.locator(".consent-points");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(points).toBeHidden();
  await expect(more).toHaveAttribute("aria-controls", (await points.getAttribute("id"))!);
  // From the token field, the next stop is the link, then Connect.
  await page.getByPlaceholder("Gateway token, for pairing").focus();
  await page.keyboard.press("Tab");
  await expect(more).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(points.getByRole("listitem")).toHaveCount(5);
  await expect(points).toContainText(
    "If this device is lost, remove it from another admin connection.",
  );
  await page.keyboard.press("Space");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(points).toBeHidden();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Connect a gateway" })).toBeFocused();
});

test("F-522: a full pairing the gateway granted less keeps it, says so, and offers no request for more", async ({
  page,
}) => {
  await openFixture(page, `scene=access-narrowed&${OTTO_DISK}`, "dark");
  const bar = page.getByTestId("access-bar");
  await expect(bar).toContainText("OpenClaw granted less than full control.");
  await expect(bar.getByRole("button")).toHaveCount(0);
  // Nor does anything else on the page: the transcript, the step panel or a card.
  await expect(page.getByRole("button", { name: /Request/ })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.getByTestId("gateway-access")).toHaveText("Less than full control");
  await expect(dialog.getByTestId("narrower-grant")).toHaveText(
    "OpenClaw granted less than full control. Not granted: sending and stopping, deciding approvals, answering questions, changing gateway settings, approving devices. This device keeps what was granted.",
  );
  await expect(dialog.getByRole("button", { name: "Re-pair" })).toHaveCount(0);
});

test("F-522: when a reconnect narrows a full pairing's grant, Settings says so once", async ({
  page,
}) => {
  await openFixture(page, `scene=access-narrowed&${OTTO_DISK}&access=write`, "dark");
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.getByTestId("gateway-access")).toHaveText("Less than full control");
  // Opening on it says nothing: the note is on screen.
  await expect(dialog.getByTestId("b-announcer")).toHaveText("");
  // The gateway grants read alone at the next connection.
  await page.evaluate(() => {
    const { clawtrateFixture } = window as unknown as {
      clawtrateFixture: {
        setState(f: (s: { connection: { scopes: string[] } }) => unknown): void;
      };
    };
    clawtrateFixture.setState((state) => ({
      ...state,
      connection: {
        ...state.connection,
        scopes: ["operator.read"],
        canWrite: false,
        canApprove: false,
        canAnswer: false,
      },
    }));
  });
  const note = dialog.getByTestId("narrower-grant");
  await expect(note).toContainText("Not granted: sending and stopping");
  await expect(dialog.getByTestId("b-announcer")).toHaveText(
    `Access: Less than full control. ${await note.textContent()}`,
  );
});

/** Everything the Settings announcer says from now on. */
const heard = async (page: Page) => {
  await page.getByTestId("b-announcer").evaluate((el) => {
    const said: string[] = [];
    Object.assign(window, { accessSaid: said });
    new MutationObserver(() => {
      if (el.textContent) said.push(el.textContent);
    }).observe(el, { subtree: true, childList: true, characterData: true });
  });
  return () => page.evaluate(() => (window as unknown as { accessSaid: string[] }).accessSaid);
};

const setConnection = (page: Page, change: Record<string, unknown>) =>
  page.evaluate((patch) => {
    const { clawtrateFixture } = window as unknown as {
      clawtrateFixture: { setState(f: (s: { connection: object }) => unknown): void };
    };
    clawtrateFixture.setState((state) => ({
      ...state,
      connection: { ...state.connection, ...patch },
    }));
  }, change);

test("F-522: Disconnect and Reconnect with the same grant say nothing about it again", async ({
  page,
}) => {
  await openFixture(page, `scene=access-narrowed&${OTTO_DISK}&access=read`, "dark");
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const note = dialog.getByTestId("narrower-grant");
  const before = await note.textContent();
  const said = await heard(page);
  await dialog.getByRole("button", { name: "Disconnect" }).click();
  await expect(dialog.getByTestId("gateway-state")).toHaveText("Disconnected");
  await expect(note).toHaveCount(0);
  await dialog.getByRole("button", { name: "Reconnect" }).click();
  await expect(dialog.getByTestId("gateway-state")).toHaveText("Connected");
  await expect(note).toHaveText(before!);
  await settle(page);
  expect(await said()).toEqual([]);
});

test("F-522: switching to another gateway clears what was said of the last one's access", async ({
  page,
}) => {
  await openFixture(page, `scene=access-narrowed&${OTTO_DISK}&access=write`, "dark");
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const announcer = dialog.getByTestId("b-announcer");
  const note = dialog.getByTestId("narrower-grant");
  const grant = { scopes: ["operator.read"], canWrite: false, canApprove: false, canAnswer: false };
  await setConnection(page, grant);
  await expect(announcer).toContainText("Not granted: sending and stopping");
  // The host moves to another gateway, one with no Access row, while Settings is open.
  await setConnection(page, {
    ...grant,
    status: "connecting",
    gatewayUrl: "wss://second-gateway.example.test",
    target: 57,
    gatewayId: null,
    fullPairing: false,
    fullOffer: null,
  });
  await setConnection(page, { status: "connected", gatewayId: "second-gateway" });
  await expect(dialog.getByTestId("gateway-facts")).toContainText("second-gateway.example.test");
  await expect(note).toHaveCount(0);
  await settle(page);
  await expect(announcer).toHaveText("");
});

test("F-522: a full pairing granted read, write, approvals and questions is offered admin and device access nowhere", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=access-narrowed&${OTTO_DISK}&access=write&panel=open&tab=settings`,
    "dark",
  );
  // Bot settings' admin bar says so and asks for nothing.
  const admin = page.getByTestId("admin-bar");
  await expect(admin).toContainText("OpenClaw granted less than full control.");
  await expect(admin.getByRole("button", { name: /Request/ })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  // Nor do Accounts' admin bar and Machines' device bar.
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(settings.getByTestId("admin-bar")).toContainText(
    "OpenClaw granted less than full control.",
  );
  await expect(settings.getByRole("button", { name: /Request/ })).toHaveCount(0);
  await settings.getByRole("button", { name: "Machines", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Machines", level: 3 })).toBeVisible();
  await expect(settings.getByTestId("device-bar")).toHaveText(
    "OpenClaw granted less than full control.",
  );
  await expect(settings.getByRole("button", { name: /Request/ })).toHaveCount(0);
});

// Each place a read-only connection is offered "Request access", opened as a full pairing (`full=1`).
const ASKS: Array<[string, string, string]> = [
  ["an approval card", "scene=approval-readonly", "approval-card"],
  ["a question card", "scene=question-readonly", "question-card"],
  ["the transcript's waiting note", `scene=read-wait&${OTTO_DISK}&panel=closed`, "read-only-wait"],
  ["the Computer tab", `${COMPUTER}&computer=watching&access=read`, "computer-readonly"],
];
for (const [where, query, testId] of ASKS) {
  test(`F-522: a full pairing the gateway granted less is offered no request for more in ${where}`, async ({
    page,
  }) => {
    await openFixture(page, `${query}&full=1`, "light");
    await expect(page.getByTestId(testId)).toBeVisible();
    await expect(page.getByRole("button", { name: "Request access" })).toHaveCount(0);
  });
}

test("F-522: Settings doesn't tell a full pairing holding admin that it asked for admin", async ({
  page,
}) => {
  await openFixture(page, `scene=access-narrowed&${OTTO_DISK}&access=admin`, "light");
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.getByTestId("gateway-access")).toHaveText("Less than full control");
  await expect(dialog).not.toContainText("which it asked for");
});
