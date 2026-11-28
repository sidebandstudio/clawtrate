import { test, type Page } from "@playwright/test";
import type { BridgeCommand, ClawtrateState } from "../packages/core/src/index.ts";
import { contextFor, expect, openFixture, settle, SIZES } from "./fixture.ts";

const FIRST = "scene=first-bot&access=admin&accounts=none&gatewayName=New%20gateway";

async function providers(page: Page) {
  const dialog = page.getByTestId("new-bot");
  await expect(dialog.getByRole("heading", { name: "Connect an account" })).toBeVisible();
  return dialog;
}

async function signIn(page: Page) {
  const dialog = await providers(page);
  await dialog.getByRole("button", { name: /^OpenAI$/ }).click();
  await dialog.getByRole("button", { name: "Use a device code", exact: false }).click();
  return dialog;
}

for (const size of SIZES.filter(({ name }) => name === "1440" || name === "phone")) {
  test.describe(`first bot at ${size.name}`, () => {
    test.use(contextFor(size));

    test("F-504: the empty state leads straight to the provider tiles", async ({ page }) => {
      await openFixture(page, FIRST);
      const dialog = await providers(page);
      await dialog.getByRole("button", { name: "Close" }).click();
      await expect(page.getByRole("heading", { name: "Set up your first bot" })).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`first-bot-empty-dark-${size.name}.png`);
      await page.getByRole("button", { name: "Get started" }).click();
      await providers(page);
      await settle(page);
      await expect(page).toHaveScreenshot(`first-bot-providers-dark-${size.name}.png`);
    });

    test("F-504: the gateway's sign-in steps stay in the setup dialog", async ({ page }) => {
      await openFixture(page, FIRST);
      const dialog = await signIn(page);
      await expect(dialog.locator(".b-code code")).toHaveText("QK4F-7PZD");
      await settle(page);
      await expect(page).toHaveScreenshot(`first-bot-sign-in-dark-${size.name}.png`);
    });

    test("F-504: sign-in offers a name and one press to create the bot", async ({ page }) => {
      await openFixture(page, `${FIRST}&signin=connected`);
      const dialog = await signIn(page);
      await expect(dialog.getByRole("heading", { name: "Make your first bot" })).toBeFocused();
      await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("Juniper");
      await expect(dialog.getByText("Uses OpenAI.")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Create bot" })).toBeEnabled();
      await settle(page);
      await expect(page).toHaveScreenshot(`first-bot-ready-dark-${size.name}.png`);
      await dialog.getByRole("button", { name: "Create bot" }).click();
      await expect(page.getByTestId("composer-input")).toBeFocused();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Send a message to start" })).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`first-bot-conversation-dark-${size.name}.png`);
    });

    test("F-504: a saved sign-in carries on after the gateway reconnects", async ({ page }) => {
      await openFixture(page, `${FIRST}&signin=reconnected`);
      const dialog = await signIn(page);
      await expect(
        dialog.getByText(
          "Waiting for your gateway to reconnect. Clawtrate will check your account when it returns.",
        ),
      ).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Create bot" })).toBeEnabled();
    });

    test("F-504: create keeps the confirmed account after an empty gateway reconnects", async ({
      page,
    }) => {
      await openFixture(page, "scene=first-bot-zero&access=admin&accounts=none&signin=connected");
      const dialog = await signIn(page);
      await expect(dialog.getByRole("button", { name: "Create bot" })).toBeEnabled();
      const changeConnection = (connected: boolean) =>
        page.evaluate((connected) => {
          const { clawtrateFixture } = window as unknown as {
            clawtrateFixture: { setState(change: (state: ClawtrateState) => ClawtrateState): void };
          };
          clawtrateFixture.setState((state) => {
            const connectedAt = (state.connection.connectedAt ?? 0) + Number(connected);
            const selected = state.accounts.accounts.find(
              (account) => account.id === "openai:second",
            );
            if (!selected || !state.accounts.readOn) throw new Error("The fixture has no sign-in.");
            return {
              ...state,
              connection: {
                ...state.connection,
                connectedAt,
                status: connected ? "connected" : "reconnecting",
                canAdmin: connected,
              },
              accounts: {
                ...state.accounts,
                readOn: { ...state.accounts.readOn, connectedAt },
                accounts: [{ ...selected, id: "openai:work" }, selected],
              },
            };
          });
        }, connected);
      await changeConnection(false);
      await expect(
        dialog.getByText(
          "Waiting for your gateway to reconnect. Setup will continue when it returns.",
        ),
      ).toBeVisible();
      await changeConnection(true);
      await dialog.getByRole("button", { name: "Close" }).click();
      await page.getByRole("button", { name: "Get started" }).click();
      await dialog.getByRole("button", { name: "Create bot" }).click();
      const created = await page.evaluate(() => {
        const { clawtrateFixture } = window as unknown as {
          clawtrateFixture: { sent: BridgeCommand[] };
        };
        return clawtrateFixture.sent.find((command) => command.type === "createBot");
      });
      expect(created?.account).toBe("openai:second");
    });

    test("F-504: only a saved private sign-in leads to the existing bot", async ({ page }) => {
      await openFixture(page, `${FIRST}&kept=1&signin=connected`);
      const dialog = await providers(page);
      await expect(dialog.getByText(/keeps this sign-in for/)).toHaveCount(0);
      await signIn(page);
      await expect(
        dialog.getByText(
          "This gateway keeps the sign-in for its own bot. You can use it with that bot.",
          { exact: true },
        ),
      ).toBeVisible();
      await dialog.getByRole("button", { name: "Start a conversation with this bot" }).click();
      await expect(page.getByTestId("composer-input")).toBeFocused();
    });

    test("F-504: a subscription without a usable model offers the saved API key", async ({
      page,
    }) => {
      await openFixture(page, `${FIRST}&signin=connected&create=account-unusable`);
      const dialog = await signIn(page);
      const create = dialog.getByRole("button", { name: "Create bot" });
      await expect(create).toBeEnabled();
      await dialog.getByRole("button", { name: "About checking this account" }).click();
      await expect(dialog.getByRole("note")).toContainText(
        "uses a little of your account’s allowance",
      );
      await page.evaluate(() => {
        const { clawtrateFixture } = window as unknown as {
          clawtrateFixture: { setState(change: (state: ClawtrateState) => ClawtrateState): void };
        };
        clawtrateFixture.setState((state) => {
          const selected = state.accounts.accounts.find(
            (account) => account.id === "openai:second",
          );
          if (!selected) throw new Error("The fixture has no sign-in.");
          return {
            ...state,
            accounts: {
              ...state.accounts,
              accounts: [
                selected,
                { ...selected, id: "openai:key", type: "api_key", kind: "key", label: "API key" },
              ],
            },
          };
        });
      });
      await create.click();
      await expect(
        dialog.locator(".b-body").getByText("Checking this account…", { exact: true }),
      ).toBeVisible();
      await expect(dialog.getByText("This account can’t run a model here.")).toBeVisible();
      await expect(page.getByTestId("bot")).toHaveCount(1);
      await expect(page.getByTestId("composer-input")).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Connect another account" })).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`first-bot-account-unusable-dark-${size.name}.png`);
      await dialog.getByRole("button", { name: "Use OpenAI · API key" }).click();
      await create.click();
      await expect(page.getByTestId("composer-input")).toBeFocused();
    });

    test("F-504: the typed name survives closing first bot setup", async ({ page }) => {
      await openFixture(page, `${FIRST}&signin=connected`);
      const dialog = await signIn(page);
      await dialog.getByRole("textbox", { name: "Name" }).fill("Iris");
      await dialog.getByRole("button", { name: "Close" }).click();
      await page.getByRole("button", { name: "Get started" }).click();
      await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("Iris");
    });

    test("F-504: an uncertain creation keeps its original name after reopening", async ({
      page,
    }) => {
      await openFixture(page, `${FIRST}&signin=connected&create=uncertain`);
      const dialog = await signIn(page);
      await dialog.getByRole("textbox", { name: "Name" }).fill("Iris");
      await dialog.getByRole("button", { name: "Create bot" }).click();
      await expect(
        dialog.getByText(
          "The gateway didn’t confirm whether it made your bot. Create bot checks before trying again.",
        ),
      ).toBeVisible();
      await dialog.getByRole("button", { name: "Close" }).click();
      await page.getByRole("button", { name: "Get started" }).click();
      await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("Iris");
      await expect(dialog.getByRole("textbox", { name: "Name" })).toBeDisabled();
    });

    test("F-504: a gateway with zero bots can create the first one from an existing account", async ({
      page,
    }) => {
      await openFixture(page, "scene=first-bot-zero&access=admin");
      await page.getByRole("button", { name: "Get started" }).click();
      await expect(
        page.getByTestId("new-bot").getByRole("button", { name: "Create bot" }),
      ).toBeEnabled();
    });
  });
}
