// Parity rows for connecting and pairing, on fixed state. The same flows run
// against a real development gateway in e2e/preview.spec.ts.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, SIZES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;

const steps = (page: Page) => page.getByTestId("setup-steps").locator("li");

const sent = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: Array<{ type: string }> } }
    ).clawtrateFixture.sent.map((command) => command.type),
  );

test.use(contextFor(WIDE, "light"));

test("F-002: the pending-approval screen lists exactly the scopes this device asks for", async ({
  page,
}) => {
  await openFixture(page, "scene=pairing", "light");
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible();
  const scopes = page.getByRole("list", { name: "This device asks to" }).locator("li");
  await expect(scopes).toHaveCount(1);
  await expect(scopes).toHaveAttribute("data-scope", "operator.read");
  await expect(scopes).toHaveText("Read bots, tasks and conversations");
  // Pairing happens here, in the app: the command to approve it, and the wait.
  await expect(page.locator(".command code")).toHaveText(/devices approve 5d2a90c4/);
});

test("F-003: a step list says connecting, then pairing, then loading bots", async ({ page }) => {
  await openFixture(page, "scene=connecting", "light");
  await expect(steps(page)).toHaveText([
    "Connecting to 127.0.0.1:18789",
    "Pair this device",
    "Load bots",
  ]);
  await expect(steps(page).nth(0)).toHaveAttribute("aria-current", "step");
  await expect(steps(page).nth(1)).toHaveAttribute("data-state", "pending");

  await openFixture(page, "scene=pairing", "light");
  await expect(steps(page)).toHaveText([
    "Connected to 127.0.0.1:18789",
    /^Waiting for approval, checking again/,
    "Load bots",
  ]);
  await expect(steps(page).nth(0)).toHaveAttribute("data-state", "done");
  await expect(steps(page).nth(1)).toHaveAttribute("aria-current", "step");

  // Connected, the bots still loading: the steps stay, and nothing else shows.
  await openFixture(page, "scene=discovering", "light");
  await expect(steps(page)).toHaveText([
    "Connected to 127.0.0.1:18789",
    "This device is paired",
    "Loading bots",
  ]);
  await expect(steps(page).nth(2)).toHaveAttribute("aria-current", "step");
  await expect(page.getByTestId("bot-list")).toHaveCount(0);
});

test("F-003: the app opens, read-only, as soon as the bots have loaded, before the tasks have", async ({
  page,
}) => {
  await openFixture(page, "scene=discovering", "light");
  await expect(page.getByTestId("setup-steps")).toBeVisible();
  await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: {
          setState(f: (s: { bots: unknown[]; tasksByBot: unknown }) => unknown): void;
        };
      }
    ).clawtrateFixture;
    fixture.setState((state) => ({
      ...state,
      bots: [
        {
          id: "otto",
          name: "Otto",
          emoji: null,
          avatarUrl: null,
          theme: null,
          model: null,
          isDefault: true,
        },
      ],
      tasksByBot: {},
    }));
  });
  await expect(page.getByTestId("setup-steps")).toHaveCount(0);
  await expect(page.getByTestId("bot")).toHaveCount(1);
  // Its tasks are still on their way, and it says so.
  await expect(page.getByTestId("bot")).toContainText("Loading tasks");
});

test("F-009: unreachable, and a pairing request that was rejected or expired, each show a titled message with a retry", async ({
  page,
}) => {
  const cases: Array<[string, string, RegExp]> = [
    ["connect-unreachable", "Could not connect", /Nothing answered at 127\.0\.0\.1:18789/],
    ["connect-error", "Could not connect", /Nothing answered at 127\.0\.0\.1:18789/],
    // The gateway does not tell this client whether its request was rejected or
    // expired, so both read the same, and say what to do.
    [
      "pairing-ended",
      "The pairing request is no longer pending",
      /It was rejected, or it expired before anyone approved it; the gateway does not say which\. Try again to send a new request/,
    ],
  ];
  for (const [scene, title, message] of cases) {
    await openFixture(page, `scene=${scene}`, "light");
    const alert = page.getByRole("alert");
    await expect(alert.locator("strong")).toHaveText(title);
    await expect(alert).toContainText(message);
    await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible();
  }
  // Try again asks for pairing again.
  await openFixture(page, "scene=pairing-ended", "light");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible();
  expect(await sent(page)).toContain("retry");
});

test("F-263: a gateway on another protocol gets a full-window notice naming both versions, with Retry and Choose another gateway", async ({
  page,
}) => {
  // Even with bots saved from before, the notice covers the window.
  await openFixture(page, `scene=protocol-mismatch&${OTTO_DISK}`, "light");
  const notice = page.getByTestId("protocol-notice");
  await expect(notice.getByRole("heading")).toHaveText("This gateway speaks another protocol");
  await expect(notice).toContainText("127.0.0.1:18789 speaks protocol 5");
  await expect(notice).toContainText("This version of Clawtrate speaks protocol 4");
  await expect(page.getByTestId("bot-list")).toHaveCount(0);
  await expect(page.locator(".conversation")).toHaveCount(0);
  // Retry repeats the handshake; the gateway still speaks protocol 5.
  await notice.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("protocol-notice")).toBeVisible();
  expect((await sent(page)).filter((type) => type === "retry")).toHaveLength(1);
  await page.getByRole("button", { name: "Choose another gateway" }).click();
  await expect(page.getByRole("button", { name: "Connect a gateway" })).toBeVisible();
});

test("F-227: Cmd/Ctrl+, opens Settings, whose Gateway pane shows the address, the state, this device and the granted scopes", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
  const opener = page.locator(".transcript");
  await opener.focus();
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close settings" })).toBeFocused();
  const facts = dialog.getByTestId("gateway-facts");
  await expect(facts).toContainText("Addressws://127.0.0.1:18789");
  await expect(dialog.getByTestId("gateway-state")).toHaveText("Connected");
  await expect(facts).toContainText("This deviceClawtrate Web · a41c9e02");
  await expect(dialog.getByTestId("granted-scopes")).toHaveText("operator.read");
  // Behind it, nothing can take focus; Tab stays inside, and Escape gives focus back.
  await expect(page.locator(".shell")).toHaveAttribute("inert", "");
  for (let i = 0; i < 6; i += 1) await page.keyboard.press("Tab");
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  // It also opens from the gateway menu.
  await page
    .getByRole("button", { name: /Open the gateway menu\.$/ })
    .last()
    .click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(dialog).toBeVisible();
});

test("F-227: the Gateway pane shows Pairing pending, Connecting and Offline, and the errors for rejected, unreachable and another protocol", async ({
  page,
}) => {
  const cases: Array<[string, string, string | null]> = [
    ["pairing", "Pairing pending", null],
    ["connecting", "Connecting", null],
    [`offline-unreachable&${OTTO_DISK}`, "Offline", "Can't reach the gateway"],
    [`offline&${OTTO_DISK}`, "Offline", "Can't reach the gateway"],
    ["pairing-ended", "Offline", "The pairing request is no longer pending"],
    [`protocol-mismatch&${OTTO_DISK}`, "Offline", "This gateway speaks another protocol"],
  ];
  for (const [scene, state, problem] of cases) {
    await openFixture(page, `scene=${scene}`, "light");
    await page.keyboard.press("ControlOrMeta+,");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog.getByTestId("gateway-state")).toHaveText(state);
    if (problem)
      await expect(dialog.getByTestId("gateway-problem").locator("strong")).toHaveText(problem);
    else await expect(dialog.getByTestId("gateway-problem")).toHaveCount(0);
    await expect(dialog.getByTestId("granted-scopes")).toHaveText("None while not connected");
  }
});

test("F-457 F-387: Disconnect keeps the pairing and what is on screen until Reconnect, which connects again", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.getByRole("button", { name: "Reconnect" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Disconnect" }).click();
  await expect(dialog.getByTestId("gateway-state")).toHaveText("Disconnected");
  expect(await sent(page)).toContain("suspend");
  expect(await sent(page)).not.toContain("disconnect");
  await page.keyboard.press("Escape");
  // The shell stays, with its saved messages, and the strip and footer say so.
  await expect(page.getByTestId("transcript-turn").first()).toBeVisible();
  await expect(page.getByTestId("status-strip")).toContainText("Disconnected");
  await expect(
    page.getByRole("button", { name: /, disconnected\. Open the gateway menu\.$/ }).last(),
  ).toBeVisible();
  // Reconnect: Connecting, then Connected.
  await page.keyboard.press("ControlOrMeta+,");
  // The gateway's answer is held while the check looks: Connecting lasts only until it comes.
  await page.evaluate(() =>
    (window as unknown as { clawtrateFixture: { hold(): void } }).clawtrateFixture.hold(),
  );
  await dialog.getByRole("button", { name: "Reconnect" }).click();
  await expect(dialog.getByTestId("gateway-state")).toHaveText("Connecting");
  await page.evaluate(() =>
    (window as unknown as { clawtrateFixture: { release(): void } }).clawtrateFixture.release(),
  );
  await expect(dialog.getByTestId("gateway-state")).toHaveText("Connected");
  await expect(dialog.getByRole("button", { name: "Disconnect" })).toBeVisible();
});

test("a gateway that could not be forgotten keeps Settings open and says so", async ({ page }) => {
  await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
  await page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { refuse(type: string): void } }
    ).clawtrateFixture.refuse("disconnect"),
  );
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Use another gateway" }).click();
  await expect(dialog.getByTestId("forget-problem")).toHaveText("Could not forget this gateway.");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("gateway-state")).toHaveText("Connected");
  // The command names the gateway Settings showed.
  const forgets = await page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: Array<{ type: string }> } }
    ).clawtrateFixture.sent.filter((command) => command.type === "disconnect"),
  );
  expect(forgets).toEqual([
    { type: "disconnect", gatewayUrl: expect.stringMatching(/^wss?:\/\//) },
  ]);
});

test("F-227 F-387 F-457: focus stays in Settings when Disconnect and Reconnect replace each other, and goes back to the gateway button", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
  // Opened from the gateway menu, from the keyboard.
  const gatewayButton = page.getByRole("button", { name: /Open the gateway menu\.$/ }).last();
  await gatewayButton.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Settings" }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.getByRole("button", { name: "Close settings" })).toBeFocused();
  // Tab to Disconnect and press it: Reconnect takes its place, and focus.
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Disconnect" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog.getByTestId("gateway-state")).toHaveText("Disconnected");
  await expect(dialog.getByRole("button", { name: "Reconnect" })).toBeFocused();
  // And back: Disconnect takes Reconnect's place.
  await page.keyboard.press("Enter");
  await expect(dialog.getByTestId("gateway-state")).toHaveText("Connected");
  await expect(dialog.getByRole("button", { name: "Disconnect" })).toBeFocused();
  // Escape still reaches the dialog, and focus returns to the gateway button.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(gatewayButton).toBeFocused();
});

test("F-387: Reconnect from Offline is offered, and the pane shows the error while offline", async ({
  page,
}) => {
  await openFixture(page, `scene=offline-unreachable&${OTTO_DISK}`, "light");
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.getByTestId("gateway-state")).toHaveText("Offline");
  await expect(dialog.getByTestId("gateway-problem")).toContainText("Nothing answered");
  await dialog.getByRole("button", { name: "Reconnect" }).click();
  expect(await sent(page)).toContain("retry");
});

test("F-387: Reconnect to a gateway that still does not answer goes to Connecting, then back to Offline with the error", async ({
  page,
}) => {
  await openFixture(page, `scene=offline-down&${OTTO_DISK}`, "light");
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const state = dialog.getByTestId("gateway-state");
  await expect(state).toHaveText("Offline");
  // The gateway's answer is held while the check looks: Connecting lasts only until it comes.
  await page.evaluate(() =>
    (window as unknown as { clawtrateFixture: { hold(): void } }).clawtrateFixture.hold(),
  );
  await dialog.getByRole("button", { name: "Reconnect" }).click();
  await expect(state).toHaveText("Connecting");
  await expect(dialog.getByTestId("gateway-problem")).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { clawtrateFixture: { release(): void } }).clawtrateFixture.release(),
  );
  await expect(state).toHaveText("Offline");
  const problem = dialog.getByTestId("gateway-problem");
  await expect(problem.locator("strong")).toHaveText("Can't reach the gateway");
  await expect(problem).toContainText("Nothing answered at 127.0.0.1:18789.");
  // Reconnect is offered again.
  await expect(dialog.getByRole("button", { name: "Reconnect" })).toBeVisible();
  expect((await sent(page)).filter((type) => type === "retry")).toHaveLength(1);
});
