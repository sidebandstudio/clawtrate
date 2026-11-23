// F-549: a device paired read-only before full control is offered it once
// (docs/design/setup-effortless.md §6): "Give this device full control" under the consent line,
// or "Keep current access"; afterwards it lives in Settings, Gateway, Access. In light and dark,
// at 1440 px and the phone; reached by keyboard and named for a screen reader.
import { test, type Page } from "@playwright/test";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const OFFER = `scene=access-offer&${OTTO_DISK}`;
const CONSENT =
  "Full control lets Clawtrate change gateway settings, approve devices and, when the gateway allows it, open a terminal on the computer running OpenClaw.";

type Sent = Array<Record<string, unknown>>;
const sent = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { clawtrateFixture: { sent: Sent } }).clawtrateFixture.sent
      .filter((each) => String(each.type).endsWith("FullControl"))
      .map((each) => ({ ...each })),
  );

async function openGatewaySettings(page: Page, phone: boolean) {
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  if (phone) await dialog.getByRole("button", { name: /^Gateway/ }).click();
  await expect(dialog.getByTestId("full-control-ask")).toBeVisible();
  return dialog;
}

for (const size of SIZES.filter((each) => each.name === "1440" || each.phone)) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));

      test("F-549: the offer, and its place in Settings once answered", async ({ page }) => {
        await openFixture(page, OFFER, theme);
        const offer = page.getByRole("dialog", { name: "Give this device full control" });
        await expect(offer).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`full-control-offer-${theme}-${size.name}.png`);
        await offer.getByRole("button", { name: "Keep current access" }).click();
        await expect(offer).toHaveCount(0);
        await openGatewaySettings(page, size.phone === true);
        await settle(page);
        await expect(page).toHaveScreenshot(
          `full-control-offer-settings-${theme}-${size.name}.png`,
        );
      });
    });
  }
}

test("F-549: the offer opens on Keep current access, keeps Tab inside, and Escape keeps current access once", async ({
  page,
}) => {
  await openFixture(page, OFFER, "dark");
  const offer = page.getByRole("dialog", { name: "Give this device full control" });
  const keep = offer.getByRole("button", { name: "Keep current access" });
  const give = offer.getByRole("button", { name: "Give this device full control" });
  const more = offer.getByRole("button", { name: "What this means" });
  await expect(keep).toBeFocused();
  await expect(offer.locator(".consent-line")).toHaveText(`${CONSENT} What this means`);
  // The consent line sits directly above the two choices.
  expect(
    await offer
      .getByTestId("full-control-consent")
      .evaluate((el) => el.nextElementSibling?.className),
  ).toBe("b-actions");
  await page.keyboard.press("Tab");
  await expect(give).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(more).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(offer.locator(".consent-points").getByRole("listitem")).toHaveCount(5);
  await page.keyboard.press("Escape");
  await expect(offer).toHaveCount(0);
  expect(await sent(page)).toEqual([
    {
      type: "dismissFullControl",
      gatewayUrl: "wss://gateway.example",
      deviceId: expect.any(String),
    },
  ]);
  // Nothing asks again by itself, and nothing was asked of the gateway.
  await page.waitForTimeout(200);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await sent(page)).filter((each) => each.type === "requestFullControl")).toEqual([]);
});

test("F-549: Give this device full control sends one request, says it waits, then what was granted", async ({
  page,
}) => {
  await openFixture(page, OFFER, "dark");
  const offer = page.getByRole("dialog", { name: "Give this device full control" });
  await offer.getByRole("button", { name: "Give this device full control" }).click();
  const status = offer.getByTestId("full-offer-status");
  await expect(status).toHaveText(
    "Waiting for the gateway's owner. They decide once; until then this device keeps its current access.",
  );
  await expect(offer.getByRole("button", { name: "Copy approve command" })).toBeVisible();
  await expect(offer.getByRole("button", { name: "Close" })).toBeFocused();
  const asked = await sent(page);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({
    type: "requestFullControl",
    gatewayUrl: "wss://gateway.example",
  });
  // The owner grants read and write only: the narrower grant is kept and said.
  await page.evaluate(() =>
    (
      window as unknown as {
        clawtrateFixture: {
          setState(change: (state: { connection: object }) => object): void;
        };
      }
    ).clawtrateFixture.setState((state) => ({
      ...state,
      connection: {
        ...state.connection,
        scopes: ["operator.read", "operator.write"],
        canWrite: true,
        fullPairing: true,
        fullOffer: null,
        upgrade: { ...(state.connection as { upgrade: object }).upgrade, status: "approved" },
      },
    })),
  );
  await expect(status).toHaveText(
    "OpenClaw granted less than full control. Not granted: deciding approvals, answering questions, changing gateway settings, approving devices. This device keeps what was granted.",
  );
  await offer.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await sent(page)).toHaveLength(1);
});

test("F-549: once answered, Settings keeps the offer under the consent line, and asks from there", async ({
  page,
}) => {
  await openFixture(page, OFFER, "dark");
  await page
    .getByRole("dialog", { name: "Give this device full control" })
    .getByRole("button", { name: "Keep current access" })
    .click();
  const settings = await openGatewaySettings(page, false);
  await expect(settings.getByTestId("gateway-access")).toHaveText("Less than full control");
  const ask = settings.getByTestId("full-control-ask");
  await expect(ask.locator(".consent-line")).toHaveText(`${CONSENT} What this means`);
  expect(
    await ask
      .getByTestId("full-control-consent")
      .evaluate((el) => el.nextElementSibling?.className),
  ).toBe("settings-repair-actions");
  await ask.getByRole("button", { name: "Give this device full control" }).click();
  await expect(settings.getByTestId("repair-pending")).toBeVisible();
  await expect(ask.getByRole("button")).toHaveCount(0);
  expect((await sent(page)).map((each) => each.type)).toEqual([
    "dismissFullControl",
    "requestFullControl",
  ]);
});

test("F-549: an offer answered in another window closes here, unasked", async ({ page }) => {
  await openFixture(page, OFFER, "dark");
  const offer = page.getByRole("dialog", { name: "Give this device full control" });
  await expect(offer).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as {
        clawtrateFixture: { setState(change: (state: { connection: object }) => object): void };
      }
    ).clawtrateFixture.setState((state) => ({
      ...state,
      connection: { ...state.connection, fullOffer: "settings" },
    })),
  );
  await expect(offer).toHaveCount(0);
  expect(await sent(page)).toEqual([]);
});

test("F-549: a device without the offer sees neither the dialog nor its place in Settings", async ({
  page,
}) => {
  await openFixture(page, `scene=access-narrowed&${OTTO_DISK}`, "dark");
  await page.waitForTimeout(200);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings.getByTestId("gateway-access")).toBeVisible();
  await expect(settings.getByTestId("full-control-ask")).toHaveCount(0);
});
