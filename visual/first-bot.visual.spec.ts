import { test, type Page } from "@playwright/test";
import type { BridgeCommand, ClawtrateState } from "../packages/core/src/index.ts";
import { contextFor, expect, hold, NOW, openFixture, release, settle, SIZES } from "./fixture.ts";

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

async function outsideAccounts(page: Page, connected: boolean, labels: string[]) {
  await page.evaluate(
    ({ connected, labels }) => {
      const { clawtrateFixture } = window as unknown as {
        clawtrateFixture: { setState(change: (state: ClawtrateState) => ClawtrateState): void };
      };
      clawtrateFixture.setState((state) => {
        const connectedAt = (state.connection.connectedAt ?? 0) + Number(connected);
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
            readOn: state.accounts.readOn && { ...state.accounts.readOn, connectedAt },
            accounts: labels.map((label, index) => ({
              id: `openai:outside-${index}`,
              label,
              provider: "openai",
              type: "api_key",
              status: "static",
              expiresAt: null,
              kind: "gateway",
              made: null,
              keptBy: null,
              logoutSupported: false,
            })),
          },
        };
      });
    },
    { connected, labels },
  );
}

/** A later read on the same connection: the accounts it found, or that it failed. */
async function readAgain(page: Page, labels: string[], failed = false) {
  await page.evaluate(
    ({ labels, failed }) => {
      const { clawtrateFixture } = window as unknown as {
        clawtrateFixture: { setState(change: (state: ClawtrateState) => ClawtrateState): void };
      };
      clawtrateFixture.setState((state) => ({
        ...state,
        accounts: {
          ...state.accounts,
          status: failed ? "error" : "ready",
          error: failed ? "models.authStatus is unavailable right now." : null,
          accounts: labels.map((label, index) => ({
            id: `openai:outside-${index}`,
            label,
            provider: "openai",
            type: "api_key",
            status: "static",
            expiresAt: null,
            kind: "gateway",
            made: null,
            keptBy: null,
            logoutSupported: false,
          })),
        },
      }));
    },
    { labels, failed },
  );
}

const refreshes = (page: Page) =>
  page.evaluate(() => {
    const { clawtrateFixture } = window as unknown as {
      clawtrateFixture: { sent: BridgeCommand[] };
    };
    return clawtrateFixture.sent.filter((command) => command.type === "refreshAccounts").length;
  });

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

    test("F-504: reconnect reads an account saved elsewhere and advances without another press", async ({
      page,
    }) => {
      await openFixture(page, FIRST);
      const dialog = await providers(page);
      await outsideAccounts(page, false, ["Workshop"]);
      await expect(dialog.getByText(/Waiting for your gateway to reconnect/)).toBeVisible();
      await outsideAccounts(page, true, ["Workshop"]);
      await expect(dialog.getByRole("heading", { name: "Make your first bot" })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Create bot" })).toBeEnabled();
      await expect(dialog.getByText("Uses OpenAI · Workshop.")).toBeVisible();
    });

    test("F-504: after a reconnect, a later read that finds the account moves setup on", async ({
      page,
    }) => {
      await page.clock.install({ time: NOW });
      await openFixture(page, FIRST);
      const dialog = await providers(page);
      await outsideAccounts(page, false, []);
      await expect(dialog.getByText(/Waiting for your gateway to reconnect/)).toBeVisible();
      // The returned gateway's first read lists nothing yet, as one still starting may answer.
      await outsideAccounts(page, true, []);
      await providers(page);
      // Setup asks again on its own, and the next read has the account.
      const asked = await refreshes(page);
      await page.clock.fastForward(5_000);
      await expect.poll(() => refreshes(page)).toBeGreaterThan(asked);
      await readAgain(page, ["Workshop"]);
      await expect(dialog.getByRole("heading", { name: "Make your first bot" })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Create bot" })).toBeEnabled();
      await expect(dialog.getByText("Uses OpenAI · Workshop.")).toBeVisible();
    });

    test("F-504: the account read can land before the returned gateway names itself", async ({
      page,
    }) => {
      await openFixture(page, FIRST);
      const dialog = await providers(page);
      await outsideAccounts(page, false, []);
      // Back, and the account read lands while the gateway hasn't named itself on this connection.
      const named = await page.evaluate(() => {
        const { clawtrateFixture } = window as unknown as {
          clawtrateFixture: { setState(change: (state: ClawtrateState) => ClawtrateState): void };
        };
        let id: string | null = null;
        clawtrateFixture.setState((state) => {
          id = state.connection.gatewayId;
          const connectedAt = (state.connection.connectedAt ?? 0) + 1;
          return {
            ...state,
            connection: {
              ...state.connection,
              connectedAt,
              status: "connected",
              canAdmin: true,
              gatewayId: null,
            },
            accounts: {
              ...state.accounts,
              readOn: state.accounts.readOn && {
                ...state.accounts.readOn,
                connectedAt,
                gatewayId: null,
              },
              accounts: [
                {
                  id: "openai:outside-0",
                  label: "Workshop",
                  provider: "openai",
                  type: "api_key",
                  status: "static",
                  expiresAt: null,
                  kind: "gateway",
                  made: null,
                  keptBy: null,
                  logoutSupported: false,
                },
              ],
            },
          };
        });
        return id;
      });
      await expect(dialog.getByRole("heading", { name: "Make your first bot" })).toHaveCount(0);
      // Then it names itself, and the read already made counts.
      await page.evaluate((id) => {
        const { clawtrateFixture } = window as unknown as {
          clawtrateFixture: { setState(change: (state: ClawtrateState) => ClawtrateState): void };
        };
        clawtrateFixture.setState((state) => ({
          ...state,
          connection: { ...state.connection, gatewayId: id },
          accounts: {
            ...state.accounts,
            readOn: state.accounts.readOn && { ...state.accounts.readOn, gatewayId: id },
          },
        }));
      }, named);
      await expect(dialog.getByRole("heading", { name: "Make your first bot" })).toBeVisible();
      await expect(dialog.getByText("Uses OpenAI · Workshop.")).toBeVisible();
    });

    test("F-504: a failed account read after a reconnect waits and reads again instead of showing the tiles", async ({
      page,
    }) => {
      await page.clock.install({ time: NOW });
      await openFixture(page, FIRST);
      const dialog = await providers(page);
      await outsideAccounts(page, false, []);
      await outsideAccounts(page, true, []);
      await readAgain(page, [], true);
      await expect(dialog.getByText(/Waiting for your gateway to reconnect/)).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Show more" })).toHaveCount(0);
      const asked = await refreshes(page);
      await page.clock.fastForward(5_000);
      await expect.poll(() => refreshes(page)).toBeGreaterThan(asked);
      // Past the reconnect wait it still asks now and then: a slower gateway is found too.
      await page.clock.fastForward(45_000);
      const later = await refreshes(page);
      await page.clock.fastForward(30_000);
      await expect.poll(() => refreshes(page)).toBeGreaterThan(later);
      await readAgain(page, ["Workshop", "Studio"]);
      const account = dialog.getByRole("combobox", { name: "Account" });
      await expect(account).toHaveValue("");
      await account.selectOption({ label: "OpenAI · Workshop" });
      await expect(dialog.getByRole("button", { name: "Create bot" })).toBeEnabled();
    });

    test("F-504: reconnect leaves provider tiles for no account and asks when several arrive", async ({
      page,
    }) => {
      await openFixture(page, FIRST);
      const dialog = await providers(page);
      await outsideAccounts(page, false, []);
      await outsideAccounts(page, true, []);
      await providers(page);
      await outsideAccounts(page, false, ["Workshop", "Studio"]);
      await expect(dialog.getByText(/Waiting for your gateway to reconnect/)).toBeVisible();
      await outsideAccounts(page, true, ["Workshop", "Studio"]);
      const account = dialog.getByRole("combobox", { name: "Account" });
      await expect(account).toHaveValue("");
      const create = dialog.getByRole("button", { name: "Create bot" });
      await expect(create).toHaveCount(0);
      await account.selectOption({ label: "OpenAI · Studio" });
      await expect(create).toBeEnabled();
      await expect(dialog.getByText("Uses OpenAI · Studio.")).toBeVisible();
    });

    test("F-504: an ended sign-in leaves the chooser to several accounts found on reconnect", async ({
      page,
    }) => {
      await openFixture(page, FIRST);
      const dialog = await signIn(page);
      await expect(dialog.locator(".b-code code")).toBeVisible();
      // The sheet's own sign-in ends with its connection; two accounts arrive by another route.
      await page.evaluate(() => {
        const { clawtrateFixture } = window as unknown as {
          clawtrateFixture: { setState(change: (state: ClawtrateState) => ClawtrateState): void };
        };
        clawtrateFixture.setState((state) => ({
          ...state,
          accounts: {
            ...state.accounts,
            signIn: state.accounts.signIn && {
              ...state.accounts.signIn,
              stage: "ended",
              step: null,
            },
          },
        }));
      });
      await outsideAccounts(page, false, ["Workshop", "Studio"]);
      await outsideAccounts(page, true, ["Workshop", "Studio"]);
      const account = dialog.getByRole("combobox", { name: "Account" });
      await expect(account).toHaveValue("");
      await expect(dialog.getByText("The sign-in ended")).toHaveCount(0);
      await account.selectOption({ label: "OpenAI · Studio" });
      await expect(dialog.getByRole("button", { name: "Create bot" })).toBeEnabled();
      await expect(dialog.getByText("Uses OpenAI · Studio.")).toBeVisible();
    });

    test("F-504: an interrupted sign-in offers Try again after 45 seconds", async ({ page }) => {
      await page.clock.install({ time: NOW });
      await openFixture(page, FIRST);
      const dialog = await providers(page);
      await outsideAccounts(page, false, []);
      await expect(dialog.getByText(/Waiting for your gateway to reconnect/)).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Try again" })).toHaveCount(0);
      await page.clock.fastForward(45_000);
      await expect(
        dialog.getByText("Your gateway hasn’t reconnected. Try again to finish setup."),
      ).toBeVisible();
      await dialog.getByRole("button", { name: "Try again" }).click();
      const commands = await page.evaluate(() => {
        const { clawtrateFixture } = window as unknown as {
          clawtrateFixture: { sent: BridgeCommand[] };
        };
        return clawtrateFixture.sent.filter((command) => command.type === "retry");
      });
      expect(commands).toHaveLength(1);
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

    test("F-504: after failed checks every saved account stays in reach, and Create uses the one chosen", async ({
      page,
    }) => {
      await openFixture(page, `${FIRST}&signin=connected&create=account-unusable`);
      const dialog = await signIn(page);
      const create = dialog.getByRole("button", { name: "Create bot" });
      await expect(create).toBeEnabled();
      const info = dialog.getByRole("button", { name: "About checking this account" });
      await info.click();
      await expect(dialog.getByRole("note")).toHaveText(
        "When you press Create bot, Clawtrate asks your gateway to send one short test message through this account to check that it can run the model. It is a real request: your provider may bill it or count it against your account’s allowance, and a failed test can be noted on the account.",
      );
      await info.press("Escape");
      await expect(dialog.getByRole("note")).toHaveCount(0);
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
                { ...selected, id: "openai:unusable", label: "Work" },
                { ...selected, id: "openai:key", type: "api_key", kind: "key", label: "API key" },
              ],
            },
          };
        });
      });
      await hold(page);
      await create.click();
      await expect(
        dialog.locator(".b-body").getByText("Checking this account…", { exact: true }),
      ).toBeVisible();
      await release(page);
      await expect(dialog.getByText("This account can’t run a model here.")).toBeVisible();
      await expect(page.getByTestId("bot")).toHaveCount(1);
      await expect(page.getByTestId("composer-input")).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Connect another account" })).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`first-bot-account-unusable-dark-${size.name}.png`);
      // Every saved account is offered, not a toggle between two: a second failure still leaves
      // the third in reach, and Create uses it.
      const account = dialog.getByRole("combobox", { name: "Account" });
      await expect(account.locator("option")).toHaveText([
        "OpenAI openai:second",
        "OpenAI · Work",
        "OpenAI · API key",
      ]);
      await account.focus();
      await account.selectOption({ label: "OpenAI · Work" });
      // The list stays while the failed check stands: choosing keeps it, and focus with it.
      await expect(account).toBeFocused();
      await expect(account).toHaveValue("openai:unusable");
      await create.click();
      await expect(dialog.getByText("This account can’t run a model here.")).toBeVisible();
      await account.selectOption({ label: "OpenAI · API key" });
      await create.click();
      await expect(page.getByTestId("composer-input")).toBeFocused();
      const sent = await page.evaluate(() => {
        const { clawtrateFixture } = window as unknown as {
          clawtrateFixture: { sent: BridgeCommand[] };
        };
        return clawtrateFixture.sent.flatMap((command) =>
          command.type === "createBot" ? [command.account] : [],
        );
      });
      expect(sent).toEqual(["openai:second", "openai:unusable", "openai:key"]);
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
