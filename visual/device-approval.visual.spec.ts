// F-550: approving a waiting device from inside Clawtrate (docs/design/setup-effortless.md §5).
// The sheet an admin connection opens by itself for the only waiting request, the waiting
// device's own code, the requests in Settings, Gateway, and the notice without admin; in light
// and dark, at 1440 px and the phone. Then, once, what a keyboard and a screen reader meet: the
// two refusals first, the codes read as codes, focus on the title, Escape as "Not now".
import { test, type Page } from "@playwright/test";
import type { ClawtrateState, DeviceRequestBlock } from "../packages/core/src/index.ts";
import {
  contextFor,
  expect,
  hold,
  openFixture,
  release,
  settle,
  SIZES,
  THEMES,
} from "./fixture.ts";

const CODE = "K7QF-2MXA";

type Sent = Array<Record<string, unknown>>;
const sent = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { clawtrateFixture: { sent: Sent } }).clawtrateFixture.sent
      .filter((each) => /Device$/.test(String(each.type)))
      .map(({ type, code, why }) => ({ type, ...(code ? { code } : {}), ...(why ? { why } : {}) })),
  );

/** The decisions sent, with the list each carried back, and the list reads asked for. */
const decisions = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { clawtrateFixture: { sent: Sent } }).clawtrateFixture.sent
      .filter((each) => /Device/.test(String(each.type)) && each.type !== "takeDevicePrompt")
      .map(({ type, code, why, listedOn }) => ({
        type,
        ...(code ? { code } : {}),
        ...(why ? { why } : {}),
        ...(listedOn !== undefined ? { listedOn } : {}),
      })),
  );

/**
 * Change the fixture host's waiting devices, as a read or a reconnect would: the connection the
 * list was read on, the prompt, or a block on every request.
 */
const setRequests = (
  page: Page,
  change: { listedOn?: number; prompt?: string | null; blocked?: DeviceRequestBlock },
) =>
  page.evaluate((change) => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
      }
    ).clawtrateFixture;
    fixture.setState((s) => {
      const { blocked, ...rest } = change;
      const listed = s.deviceRequests!;
      const requests = blocked
        ? listed.requests.map((r) => ({ ...r, blocked, choices: [] }))
        : listed.requests;
      return { ...s, deviceRequests: { ...listed, ...rest, requests } };
    });
  }, change);

const sheetOf = (page: Page) =>
  page.getByRole("dialog", { name: "A device is asking to use this gateway" });

async function openGatewaySettings(page: Page, phone: boolean) {
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  if (phone) await dialog.getByRole("button", { name: /^Gateway/ }).click();
  await expect(dialog.getByRole("heading", { name: "Devices asking" })).toBeVisible();
  return dialog;
}

for (const size of SIZES.filter((each) => each.name === "1440" || each.phone)) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));

      test("F-550: the sheet for the only waiting request", async ({ page }) => {
        await openFixture(page, "scene=device-request", theme);
        await expect(sheetOf(page)).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`device-request-${theme}-${size.name}.png`);
      });

      test("F-550: the waiting device's code", async ({ page }) => {
        await openFixture(page, "scene=pairing-code", theme);
        const code = page.getByTestId("pairing-code");
        await expect(code).toContainText(CODE);
        await settle(page);
        await expect(code).toHaveScreenshot(`device-waiting-code-${theme}-${size.name}.png`);
      });

      test("F-550: requests waiting in Settings, Gateway", async ({ page }) => {
        await openFixture(page, "scene=devices-asking", theme);
        const dialog = await openGatewaySettings(page, size.phone === true);
        await settle(page);
        await expect(dialog).toHaveScreenshot(`devices-asking-settings-${theme}-${size.name}.png`);
      });
    });
  }
}

test("F-550: the two refusals come first, the codes are read as codes, and focus starts on the title", async ({
  page,
}) => {
  await openFixture(page, "scene=device-request", "dark");
  const sheet = sheetOf(page);
  await expect(
    sheet.getByRole("heading", { name: "A device is asking to use this gateway" }),
  ).toBeFocused();
  const names = await sheet
    .getByRole("group", { name: "Which code does the waiting device show?" })
    .getByRole("button")
    .evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label") ?? b.textContent));
  expect(names).toEqual([
    "I didn't start this",
    "None of these match",
    "Code 4 C 7 R, M Z 2 D",
    "Code 9 H 3 K, T Q 8 B",
    "Code K 7 Q F, 2 M X A",
    "Code W X 5 N, 0 P J 6",
  ]);
  // Tab reaches the refusals before any code.
  await page.keyboard.press("Tab");
  await expect(sheet.getByRole("button", { name: "I didn't start this" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(sheet.getByRole("button", { name: "None of these match" })).toBeFocused();
  await expect(sheet.getByText("Clawtrate Desktop (reported)")).toBeVisible();
  await expect(sheet.getByText("From 203.0.113.7")).toBeVisible();
  // Escape is Not now: nothing is decided.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  expect(await sent(page)).toEqual([]);
});

for (const [pick, decision, words] of [
  [
    `Code ${"K 7 Q F, 2 M X A"}`,
    { type: "approveDevice", code: CODE },
    "Approved. The device connects in a moment.",
  ],
  [
    "Code 9 H 3 K, T Q 8 B",
    { type: "approveDevice", code: "9H3K-TQ8B" },
    "That isn't this request's code, so nothing was approved.",
  ],
  ["None of these match", { type: "refuseDevice", why: "none-match" }, "Nothing was approved."],
  [
    "I didn't start this",
    { type: "refuseDevice", why: "not-mine" },
    "Denied. The device can ask again.",
  ],
] as const) {
  test(`F-550: ${pick} says what it did`, async ({ page }) => {
    await openFixture(page, "scene=device-request", "dark");
    const sheet = sheetOf(page);
    await sheet.getByRole("button", { name: pick, exact: true }).click();
    await expect(sheet.getByTestId("device-outcome")).toContainText(words);
    await expect(sheet.getByRole("button", { name: "Close" })).toBeFocused();
    expect(await sent(page)).toEqual([decision]);
    // A pick that approved nothing offers a Deny, so the device can ask again.
    await expect(sheet.getByRole("button", { name: "Deny it" })).toHaveCount(
      decision.type === "approveDevice"
        ? decision.code === CODE
          ? 0
          : 1
        : decision.why === "none-match"
          ? 1
          : 0,
    );
  });
}

test("F-550: more than one waiting request is one quiet line, and each opens the same sheet", async ({
  page,
}) => {
  await openFixture(page, "scene=devices-asking", "dark");
  await expect(sheetOf(page)).toHaveCount(0);
  const line = page.getByTestId("devices-asking");
  await expect(line).toContainText("3 devices are asking to use this gateway.");
  await line.getByRole("button", { name: "Review" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: /^Work laptop \(reported\)/ }).click();
  await expect(sheetOf(page).getByText("Work laptop (reported)")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheetOf(page)).toHaveCount(0);
  await expect(settings).toBeVisible();
});

test("F-550: a connection without admin shows only where to approve", async ({ page }) => {
  await openFixture(page, "scene=device-notice", "dark");
  await expect(page.getByTestId("devices-notice")).toHaveText(
    "A device is asking to connect. Approve it in Clawtrate on a device with full control.",
  );
  await expect(sheetOf(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Code / })).toHaveCount(0);
});

test("F-550: while a decision is under way nothing else on the request can be pressed, and it says so", async ({
  page,
}) => {
  await openFixture(page, "scene=device-request", "dark");
  const sheet = sheetOf(page);
  await hold(page);
  await sheet.getByRole("button", { name: "Code K 7 Q F, 2 M X A", exact: true }).click();
  await expect(sheet.getByTestId("device-deciding")).toHaveText(
    "Deciding this request. Nothing else can be picked for it until it ends.",
  );
  for (const name of [
    "I didn't start this",
    "None of these match",
    "Code 9 H 3 K, T Q 8 B",
    "Code K 7 Q F, 2 M X A",
  ])
    await expect(sheet.getByRole("button", { name, exact: true })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  // A second press, None of these match and Deny send nothing while it is under way (forced:
  // a held control refuses an ordinary click).
  for (const name of [
    "Code K 7 Q F, 2 M X A",
    "Code 9 H 3 K, T Q 8 B",
    "None of these match",
    "I didn't start this",
  ])
    await sheet.getByRole("button", { name, exact: true }).click({ force: true });
  expect(await decisions(page)).toEqual([{ type: "approveDevice", code: CODE, listedOn: 1 }]);
  await release(page);
  await expect(sheet.getByTestId("device-outcome")).toHaveText(
    "Approved. The device connects in a moment.",
  );
  await expect(sheet.getByTestId("device-deciding")).toHaveCount(0);
});

test("F-550: a sheet from an earlier connection decides nothing; the list is read again and shown as it is now", async ({
  page,
}) => {
  await openFixture(page, "scene=device-request", "dark");
  const sheet = sheetOf(page);
  await expect(sheet).toBeVisible();
  // The connection changed under the open sheet, and the new one read its own list.
  await setRequests(page, { listedOn: 2 });
  // The read again is held: until it is applied the sheet says it is reading, and takes nothing.
  await hold(page);
  await sheet.getByRole("button", { name: "Code K 7 Q F, 2 M X A", exact: true }).click();
  await expect(sheet.getByTestId("device-reread")).toHaveText(
    "Nothing was approved or denied. Clawtrate is reading the waiting devices again.",
  );
  await expect(
    sheet.getByRole("button", { name: "Code K 7 Q F, 2 M X A", exact: true }),
  ).toHaveAttribute("aria-disabled", "true");
  await expect(
    sheet.getByRole("heading", { name: "A device is asking to use this gateway" }),
  ).toBeFocused();
  await sheet
    .getByRole("button", { name: "Code K 7 Q F, 2 M X A", exact: true })
    .click({ force: true });
  await release(page);
  await expect(sheet.getByTestId("device-reread")).toHaveText(
    "Nothing was approved or denied. Clawtrate read the waiting devices again; this is the request as it is now.",
  );
  await expect(sheet.getByTestId("device-outcome")).toHaveCount(0);
  // The pick again carries the list it was shown from now, and approves.
  await sheet.getByRole("button", { name: "Code K 7 Q F, 2 M X A", exact: true }).click();
  await expect(sheet.getByTestId("device-outcome")).toHaveText(
    "Approved. The device connects in a moment.",
  );
  expect(await decisions(page)).toEqual([
    { type: "approveDevice", code: CODE, listedOn: 1 },
    { type: "readDeviceRequests" },
    { type: "approveDevice", code: CODE, listedOn: 2 },
  ]);
});

test("F-550: a request that comes to share a code while open takes no pick, says why, and can be denied", async ({
  page,
}) => {
  await openFixture(page, "scene=device-request", "dark");
  const sheet = sheetOf(page);
  await expect(sheet.locator(".device-code")).toHaveCount(4);
  await setRequests(page, { blocked: "same-code" });
  await expect(sheet.getByTestId("device-blocked")).toHaveText(
    "Another waiting device shows the same code, so neither is approved here. Deny both, then ask again from the new device.",
  );
  await expect(sheet.locator(".device-code")).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "None of these match" })).toHaveCount(0);
  await sheet.getByRole("button", { name: "I didn't start this" }).click();
  await expect(sheet.getByTestId("device-outcome")).toHaveText("Denied. The device can ask again.");
  expect(await decisions(page)).toEqual([{ type: "refuseDevice", why: "not-mine", listedOn: 1 }]);
});

test("F-550: a block a new connection lists takes the codes away at once", async ({ page }) => {
  await openFixture(page, "scene=device-request", "dark");
  const sheet = sheetOf(page);
  await expect(sheet.locator(".device-code")).toHaveCount(4);
  await setRequests(page, { listedOn: 2, blocked: "same-code" });
  await expect(sheet.getByTestId("device-blocked")).toHaveText(
    "Another waiting device shows the same code, so neither is approved here. Deny both, then ask again from the new device.",
  );
  await expect(sheet.locator(".device-code")).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "None of these match" })).toHaveCount(0);
});

for (const [answer, words] of [
  [
    "unknown",
    "Clawtrate didn't get the gateway's answer, so it can't say whether the device was approved.",
  ],
  ["undone", "Clawtrate removed that pairing at once. Nothing stays approved."],
  [
    "undo-failed",
    "Clawtrate couldn't remove it: The gateway is busy. Remove it in Settings, Machines.",
  ],
] as const) {
  test(`F-550: an approval that ends ${answer} says so, and never "Approved"`, async ({ page }) => {
    await openFixture(page, `scene=device-request&device=${answer}`, "dark");
    const sheet = sheetOf(page);
    await sheet.getByRole("button", { name: "Code K 7 Q F, 2 M X A", exact: true }).click();
    const outcome = sheet.getByTestId("device-outcome");
    await expect(outcome).toContainText(words);
    await expect(outcome).not.toContainText("Approved.");
  });
}

test("F-550: a request kept from opening by itself is still in the rail and Settings, Gateway", async ({
  page,
}) => {
  // The quiet minutes after a refusal: the host offers no prompt for the only request.
  await openFixture(page, "scene=device-request", "dark");
  await expect(sheetOf(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheetOf(page)).toHaveCount(0);
  await setRequests(page, { prompt: null });
  const line = page.getByTestId("devices-asking");
  await expect(line).toHaveText(/A device is asking to use this gateway\./);
  await line.getByRole("button", { name: "Review" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: /^Clawtrate Desktop \(reported\)/ }).click();
  await expect(sheetOf(page).locator(".device-code")).toHaveCount(4);
});

test("F-550: a read again that fails says so, and shows the last list as the last that worked", async ({
  page,
}) => {
  await openFixture(page, "scene=device-request&deviceread=fail", "dark");
  const sheet = sheetOf(page);
  await expect(sheet).toBeVisible();
  await setRequests(page, { listedOn: 2 });
  await sheet.getByRole("button", { name: "Code K 7 Q F, 2 M X A", exact: true }).click();
  await expect(sheet.getByTestId("device-reread")).toHaveText(
    "Nothing was approved or denied. Clawtrate couldn't read the waiting devices again: The gateway didn't answer. What is listed here is from the last read that worked.",
  );
  await expect(sheet.getByTestId("device-outcome")).toHaveCount(0);
  // The last list stays, and its request can be decided.
  await expect(
    sheet.getByRole("button", { name: "Code K 7 Q F, 2 M X A", exact: true }),
  ).not.toHaveAttribute("aria-disabled", "true");
});

for (const [answer, pick, words, check] of [
  [
    "lost",
    "Code K 7 Q F, 2 M X A",
    "Clawtrate didn't get the gateway's answer, so it can't say whether the device was approved.",
    true,
  ],
  [
    "unknown",
    "I didn't start this",
    "Clawtrate didn't get the gateway's answer, so it can't say whether the request was denied.",
    true,
  ],
  [
    "host-error",
    "Code K 7 Q F, 2 M X A",
    "Clawtrate couldn't send this: Clawtrate is connected to another gateway now. Nothing was approved.",
    false,
  ],
  [
    "undo-unknown",
    "Code K 7 Q F, 2 M X A",
    "Clawtrate asked to remove that pairing but couldn't confirm it is gone.",
    false,
  ],
] as const) {
  test(`F-550: ${answer} after "${pick}" says only what is known`, async ({ page }) => {
    await openFixture(page, `scene=device-request&device=${answer}`, "dark");
    const sheet = sheetOf(page);
    await sheet.getByRole("button", { name: pick, exact: true }).click();
    const outcome = sheet.getByTestId("device-outcome");
    await expect(outcome).toContainText(words);
    await expect(outcome).not.toContainText(/refused|Approved\./);
    if (check) {
      // Not known: the list is read again, and the sheet says when it was.
      await expect(sheet.getByTestId("device-check")).toHaveText(
        "Clawtrate read the waiting devices again: Settings, Gateway and Settings, Machines show what the gateway holds now.",
      );
      expect((await decisions(page)).at(-1)).toEqual({ type: "readDeviceRequests" });
    } else await expect(sheet.getByTestId("device-check")).toHaveCount(0);
  });
}

const ONLY = "0c4f7a2e-91d3-4b6e-8a5f-000000000003";
const takes = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { clawtrateFixture: { sent: Sent } }).clawtrateFixture.sent.filter(
        (each) => each.type === "takeDevicePrompt",
      ).length,
  );

test("F-550: the sheet opens by itself when nothing else has the person", async ({ page }) => {
  await openFixture(page, "scene=devices-asking", "dark");
  await expect(page.getByTestId("devices-asking")).toBeVisible();
  await setRequests(page, { prompt: ONLY });
  await expect(sheetOf(page)).toBeVisible();
});

for (const [busy, start] of [
  [
    "typing in the composer",
    async (page: Page) => {
      await page.getByTestId("composer-input").click();
      await page.keyboard.type("Rotate the");
    },
  ],
  [
    "words left in the composer",
    async (page: Page) => {
      await page.getByTestId("composer-input").fill("Rotate the");
      await page
        .getByTestId("devices-asking")
        .getByText(/asking/)
        .click();
    },
  ],
  [
    "Search",
    async (page: Page) => {
      await page.keyboard.press("ControlOrMeta+K");
      await expect(page.getByRole("dialog", { name: /search/i })).toBeVisible();
      // Its own text field aside: the dialog alone keeps the sheet away.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    },
  ],
  [
    "New bot",
    async (page: Page) => {
      await page.keyboard.press("ControlOrMeta+N");
      await expect(page.getByRole("dialog", { name: /new bot/i })).toBeVisible();
      // Its own text field aside: the dialog alone keeps the sheet away.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    },
  ],
] as const) {
  test(`F-550: no sheet opens by itself over ${busy}; the request waits in the rail line`, async ({
    page,
  }) => {
    await openFixture(page, "scene=devices-asking", "dark");
    await start(page);
    await setRequests(page, { prompt: ONLY });
    await settle(page);
    await expect(sheetOf(page)).toHaveCount(0);
    expect(await takes(page)).toBe(0);
    await expect(page.getByTestId("devices-asking")).toContainText("devices are asking");
  });
}

test("F-550: a sheet taken while nothing was busy doesn't open if Settings opened before the answer", async ({
  page,
}) => {
  // The take goes out on load and its answer is held.
  await openFixture(page, "scene=device-request&hold", "dark");
  await expect.poll(() => takes(page)).toBe(1);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await release(page);
  await settle(page);
  await expect(sheetOf(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
  // Taken here, it isn't opened later by itself: it waits in the rail line.
  await settle(page);
  await expect(sheetOf(page)).toHaveCount(0);
  await expect(page.getByTestId("devices-asking")).toContainText("A device is asking");
});

test("F-550: a sheet taken while nothing was busy doesn't open if typing started before the answer", async ({
  page,
}) => {
  await openFixture(page, "scene=device-request&hold", "dark");
  await expect.poll(() => takes(page)).toBe(1);
  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Rotate");
  await release(page);
  await settle(page);
  await expect(sheetOf(page)).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toHaveValue("Rotate");
});

test("F-550: the sheet keeps Tab while the Work drawer is open", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await openFixture(page, "scene=device-request&panel=open", "dark");
  const sheet = sheetOf(page);
  await expect(sheet).toBeVisible();
  await expect(
    sheet.getByRole("heading", { name: "A device is asking to use this gateway" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(sheet.getByRole("button", { name: "I didn't start this" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(sheet.getByRole("button", { name: "None of these match" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(sheet.getByRole("button", { name: "I didn't start this" })).toBeFocused();
});

test("F-550: focus returns to the list when the row that opened the sheet is gone", async ({
  page,
}) => {
  await openFixture(page, "scene=devices-asking", "dark");
  await page.getByTestId("devices-asking").getByRole("button", { name: "Review" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: /^Work laptop \(reported\)/ }).click();
  const sheet = sheetOf(page);
  await sheet.getByRole("button", { name: "I didn't start this" }).click();
  await expect(sheet.getByTestId("device-outcome")).toHaveText("Denied. The device can ask again.");
  await expect(settings.getByRole("button", { name: /^Work laptop/ })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(settings.locator(".device-requests-place")).toBeFocused();
});

test("F-550: a held decision still answers when the fixture's state is replaced under it", async ({
  page,
}) => {
  await openFixture(page, "scene=device-request", "dark");
  const sheet = sheetOf(page);
  await hold(page);
  await sheet.getByRole("button", { name: "Code K 7 Q F, 2 M X A", exact: true }).click();
  await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
      }
    ).clawtrateFixture;
    fixture.setState((s) => {
      const { deviceRequests: _gone, ...rest } = s;
      return rest;
    });
  });
  await release(page);
  await expect(sheet.getByTestId("device-outcome")).toHaveText(
    "The connection changed before Clawtrate could approve it. Nothing was approved.",
  );
});

/** A waiting request published on a scene that has none, offered to open by itself. */
const offerRequest = (page: Page) =>
  page.evaluate(() => {
    const id = "0c4f7a2e-91d3-4b6e-8a5f-000000000009";
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
      }
    ).clawtrateFixture;
    fixture.setState((s) => ({
      ...s,
      deviceRequests: {
        access: "admin",
        requests: [
          {
            requestId: id,
            deviceId: "9".repeat(64),
            publicKey: "q3J8bW2xR5tY7uN0kP4sV6aD9fG1hL3zX8cB5nM2vQw",
            name: "Work laptop",
            platform: "win32",
            app: null,
            remoteIp: null,
            origin: null,
            roles: ["operator"],
            scopes: ["operator.read"],
            at: 1,
            blocked: null,
            choices: ["4C7R-MZ2D", "9H3K-TQ8B", "K7QF-2MXA", "WX5N-0PJ6"],
            spent: false,
          },
        ],
        omitted: 0,
        noticed: 0,
        prompt: id,
        error: null,
        listedOn: 1,
      },
    }));
  });

test("F-550: no sheet opens by itself over Delete bot, and nothing of the shell's opens over Delete bot", async ({
  page,
}) => {
  await openFixture(page, "scene=main&bot=pip&panel=open&tab=settings", "dark");
  await page.getByRole("button", { name: "Delete bot…" }).click();
  const dialog = page.getByTestId("delete-bot");
  await expect(dialog.getByRole("heading", { name: "Delete Pip?" })).toBeVisible();
  // Its own text field aside: the dialog alone keeps the sheet away.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await offerRequest(page);
  await settle(page);
  await expect(sheetOf(page)).toHaveCount(0);
  expect(await takes(page)).toBe(0);
  // ⌘K and ⌘N open nothing over it.
  await page.keyboard.press("ControlOrMeta+K");
  await page.keyboard.press("ControlOrMeta+N");
  await settle(page);
  await expect(page.getByRole("dialog", { name: /search/i })).toHaveCount(0);
  await expect(page.getByTestId("new-bot")).toHaveCount(0);
  await expect(dialog).toBeVisible();
});

for (const [key, opened] of [
  ["ControlOrMeta+K", (page: Page) => page.getByRole("dialog", { name: /search/i })],
  ["ControlOrMeta+N", (page: Page) => page.getByTestId("new-bot")],
] as const) {
  test(`F-550: ${key} opens nothing over the device sheet`, async ({ page }) => {
    await openFixture(page, "scene=device-request", "dark");
    const sheet = sheetOf(page);
    await expect(sheet).toBeVisible();
    await page.keyboard.press(key);
    await settle(page);
    await expect(opened(page)).toHaveCount(0);
    await expect(sheet).toBeVisible();
  });
}

test("F-550: from Settings with Work as a drawer, the sheet keeps Tab, and Escape closes the sheet, then Settings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await openFixture(page, "scene=devices-asking&panel=open", "dark");
  const drawer = page.getByTestId("work-panel");
  await expect(drawer).toBeVisible();
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  const row = settings.getByRole("button", { name: /^Work laptop \(reported\)/ });
  if (!(await row.isVisible())) await settings.getByRole("button", { name: /^Gateway/ }).click();
  await row.click();
  const sheet = sheetOf(page);
  await expect(
    sheet.getByRole("heading", { name: "A device is asking to use this gateway" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(sheet.getByRole("button", { name: "I didn't start this" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(sheet.getByRole("button", { name: "None of these match" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(sheet.getByRole("button", { name: "I didn't start this" })).toBeFocused();
  // Escape: the sheet, then Settings; the drawer underneath stays.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(drawer).toBeVisible();
});

test("F-550: the fixture keeps a request whose approval's answer was lost taken, as the host does", async ({
  page,
}) => {
  await openFixture(page, "scene=device-request&device=unknown", "dark");
  const sheet = sheetOf(page);
  await sheet.getByRole("button", { name: "Code K 7 Q F, 2 M X A", exact: true }).click();
  await expect(sheet.getByTestId("device-outcome")).toContainText("can't say whether");
  // A second approval of the same request, as another window would send it: not allowed.
  const again = await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: {
          getState: () => ClawtrateState;
          invoke: (command: Record<string, unknown>) => Promise<{ kind: string }>;
        };
      }
    ).clawtrateFixture;
    const listed = fixture.getState().deviceRequests!;
    return fixture.invoke({
      type: "approveDevice",
      requestId: listed.requests[0]!.requestId,
      code: "K7QF-2MXA",
      scopes: listed.requests[0]!.scopes,
      listedOn: listed.listedOn,
      stamp: { gatewayUrl: null, gatewayId: null },
    });
  });
  expect(again).toEqual({ kind: "not-allowed" });
});
