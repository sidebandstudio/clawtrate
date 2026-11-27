// Provider accounts (docs/design/bots.md) against approved baselines, in light
// and dark at 1440, 1100 and 800 px and at phone width: New bot's two steps,
// each sign-in kind's stages and endings, Settings → Accounts, and a bot's
// Account page in each state. The fixture's accounts are made up
// (apps/desktop/src/fixture/accounts.ts).
import { test, type Page } from "@playwright/test";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

type Scene = { name: string; query: string; ready: (page: Page) => Promise<void> };

const ADMIN = `scene=main&${OTTO_DISK}&access=admin`;

const newBot = (page: Page) => page.getByTestId("new-bot");

/** New bot, on its Account step. */
async function accountStep(page: Page) {
  await page.keyboard.press("ControlOrMeta+n");
  await expect(newBot(page)).toBeVisible();
  await page.getByRole("textbox", { name: "Name" }).fill("Viral");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "Account", level: 2 })).toBeVisible();
}

/** New bot, connecting an account, on the sign-in methods. */
async function connectStep(page: Page) {
  await accountStep(page);
  await page.getByRole("button", { name: "Connect another account" }).click();
  await expect(page.getByRole("heading", { name: "Connect an account", level: 2 })).toBeVisible();
}

/**
 * A sign-in started from a provider's tile, and its method by name when the tile has several,
 * waiting for `ready`.
 */
const signIn =
  (provider: string, method: string | null, ready: (page: Page) => Promise<void>) =>
  async (page: Page) => {
    await connectStep(page);
    await newBot(page)
      .getByRole("button", { name: new RegExp(`^${provider}\\b`) })
      .click();
    if (method) await newBot(page).getByRole("button", { name: method }).click();
    await ready(page);
  };

/** Settings, on Accounts. */
async function accounts(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Accounts", level: 3 })).toBeVisible();
}

/** The open bot's Account page, in the Work pane's Settings tab. */
async function accountPage(page: Page) {
  await page.getByRole("button", { name: /^Account: / }).click();
  await expect(page.getByRole("heading", { name: "Account", level: 3 })).toBeVisible();
}

const PANE = `${OTTO_DISK}&panel=open&tab=settings`;
const page$ = (lock: string, access = "admin") =>
  `scene=main&${PANE}&access=${access}&lock=${lock}`;

const SCENES: Scene[] = [
  // New bot
  {
    name: "newbot-look",
    query: ADMIN,
    ready: async (page) => {
      await page.keyboard.press("ControlOrMeta+n");
      await expect(page.getByRole("textbox", { name: "Name" })).toBeFocused();
    },
  },
  {
    name: "newbot-account",
    query: ADMIN,
    ready: async (page) => {
      await accountStep(page);
      await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
    },
  },
  { name: "newbot-account-none-chosen", query: ADMIN, ready: accountStep },
  { name: "newbot-account-unlabelled", query: `${ADMIN}&labels=none`, ready: accountStep },
  {
    name: "newbot-account-default",
    query: `${ADMIN}&defacct=1`,
    ready: async (page) => {
      await accountStep(page);
      await expect(
        page.getByText("Chosen because the gateway's default model names it."),
      ).toBeVisible();
    },
  },
  {
    name: "newbot-account-admin-needed",
    query: `scene=main&${OTTO_DISK}&access=write`,
    ready: accountStep,
  },
  {
    name: "newbot-account-requested",
    query: `scene=main&${OTTO_DISK}&access=write`,
    ready: async (page) => {
      await accountStep(page);
      await page.getByRole("button", { name: "Request admin access" }).click();
      await expect(page.getByTestId("admin-bar")).toContainText("Waiting for the gateway's owner.");
    },
  },
  { name: "newbot-account-empty", query: `${ADMIN}&accounts=none`, ready: accountStep },
  {
    name: "newbot-account-loading",
    query: `${ADMIN}&accounts=loading`,
    ready: async (page) => {
      await accountStep(page);
      await expect(page.getByTestId("accounts-loading")).toBeVisible();
    },
  },
  {
    name: "newbot-account-failed",
    query: `${ADMIN}&accounts=error`,
    ready: async (page) => {
      await accountStep(page);
      await expect(page.getByText("Couldn't load the gateway's accounts.")).toBeVisible();
    },
  },
  {
    name: "newbot-create-failed",
    query: `${ADMIN}&create=failed`,
    ready: async (page) => {
      await accountStep(page);
      await page.getByRole("radio", { name: /^OpenAI · Work/ }).click();
      await page.getByTestId("create").click();
      await expect(page.getByTestId("create-failed")).toBeVisible();
    },
  },
  {
    name: "newbot-create-partial",
    query: `${ADMIN}&create=partial`,
    ready: async (page) => {
      await accountStep(page);
      await page.getByRole("radio", { name: /^OpenAI · Work/ }).click();
      await page.getByTestId("create").click();
      await expect(page.getByTestId("create-partial")).toBeVisible();
    },
  },
  {
    name: "newbot-create-slow",
    query: `${ADMIN}&create=slow`,
    ready: async (page) => {
      await accountStep(page);
      await page.getByRole("radio", { name: /^Let the gateway choose/ }).click();
      await page.getByTestId("create").click();
      await expect(page.getByText("Still creating. What you entered is kept.")).toBeVisible();
    },
  },
  // Connecting an account
  { name: "connect-methods", query: ADMIN, ready: connectStep },
  {
    name: "connect-more",
    query: ADMIN,
    ready: async (page) => {
      await connectStep(page);
      await newBot(page).getByRole("button", { name: "Show more" }).click();
      await expect(newBot(page).getByRole("button", { name: /^MiniMax/ })).toBeFocused();
    },
  },
  {
    name: "connect-provider",
    query: ADMIN,
    ready: async (page) => {
      await connectStep(page);
      await newBot(page)
        .getByRole("button", { name: /^OpenAI\b/ })
        .click();
      await expect(page.getByRole("heading", { name: "OpenAI", level: 2 })).toBeVisible();
    },
  },
  {
    name: "connect-plugin",
    query: `${ADMIN}&plugin=1`,
    ready: async (page) => {
      await connectStep(page);
      await newBot(page).getByRole("button", { name: "Show more" }).click();
      await expect(newBot(page).getByRole("button", { name: /^Nimbus Cloud/ })).toBeVisible();
    },
  },
  {
    name: "connect-kept",
    query: `${ADMIN}&kept=1`,
    ready: async (page) => {
      await connectStep(page);
      await expect(page.getByTestId("kept-note")).toBeVisible();
    },
  },
  {
    name: "connect-api-key",
    query: ADMIN,
    ready: async (page) => {
      await connectStep(page);
      await page.getByText("Use an API key instead").click();
      await page.getByRole("combobox", { name: "Provider" }).selectOption("anthropic");
      await expect(page.getByText(/This replaces the Anthropic key/)).toBeVisible();
    },
  },
  {
    name: "signin-starting",
    query: `${ADMIN}&signin=starting`,
    ready: signIn("xAI", null, (page) =>
      expect(page.getByText("Asking the gateway to start the sign-in…")).toBeVisible(),
    ),
  },
  {
    name: "signin-code",
    query: ADMIN,
    ready: signIn("xAI", null, (page) => expect(page.locator(".b-code")).toBeVisible()),
  },
  {
    name: "signin-saving",
    query: `${ADMIN}&signin=saving`,
    ready: signIn("OpenAI", "Use a device code", async (page) => {
      await expect(page.locator(".b-code")).toBeVisible();
      await expect(
        page.getByText("Too late to cancel: the gateway is saving the sign-in."),
      ).toBeVisible();
    }),
  },
  {
    name: "signin-paste",
    query: ADMIN,
    ready: signIn("OpenAI", "Sign in with a browser", (page) =>
      expect(page.getByTestId("paste")).toBeVisible(),
    ),
  },
  {
    name: "signin-checking",
    query: `${ADMIN}&signin=checking`,
    ready: signIn("OpenAI", "Sign in with a browser", async (page) => {
      await page.getByTestId("paste").fill("made-up-code");
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByText(/Finishing the sign-in with OpenAI/)).toBeVisible();
    }),
  },
  {
    name: "signin-host",
    query: ADMIN,
    ready: signIn("OpenAI", "Sign in with ChatGPT", (page) =>
      expect(
        page.getByText(/Waiting for OpenAI to send your browser back to the gateway/),
      ).toBeVisible(),
    ),
  },
  {
    name: "signin-domain",
    query: ADMIN,
    ready: signIn("GitHub Copilot", "GitHub Enterprise", (page) =>
      expect(page.getByText("GitHub Enterprise address")).toBeVisible(),
    ),
  },
  {
    name: "signin-label",
    query: `${ADMIN}&signin=connected`,
    ready: signIn("OpenAI", "Use a device code", (page) =>
      expect(page.getByRole("heading", { name: "Connected to OpenAI" })).toBeVisible(),
    ),
  },
  {
    name: "signin-label-clash",
    query: `${ADMIN}&signin=connected`,
    ready: signIn("OpenAI", "Use a device code", async (page) => {
      await page.getByRole("textbox", { name: "Label" }).fill("work");
      await expect(
        page.getByText("Another OpenAI account is called Work. Choose a different label."),
      ).toBeVisible();
    }),
  },
  {
    name: "signin-failed",
    query: `${ADMIN}&signin=failed`,
    ready: signIn("xAI", null, (page) => expect(page.getByTestId("reread")).toBeVisible()),
  },
  {
    name: "signin-failed-saved",
    query: `${ADMIN}&signin=failed&saved=1`,
    ready: signIn("xAI", null, (page) =>
      expect(page.getByTestId("reread")).toContainText("It may not be ready to use."),
    ),
  },
  {
    name: "signin-expired",
    query: `${ADMIN}&signin=expired`,
    ready: signIn("xAI", null, (page) =>
      expect(page.getByRole("heading", { name: "The sign-in expired" })).toBeVisible(),
    ),
  },
  {
    name: "signin-cancelled",
    query: ADMIN,
    ready: signIn("xAI", null, async (page) => {
      await expect(page.locator(".b-code")).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("heading", { name: "Sign-in cancelled" })).toBeVisible();
    }),
  },
  {
    name: "signin-ended",
    query: `${ADMIN}&signin=ended`,
    ready: signIn("xAI", null, (page) =>
      expect(page.getByRole("heading", { name: "The sign-in ended" })).toBeVisible(),
    ),
  },
  {
    name: "signin-busy",
    query: `${ADMIN}&signin=busy`,
    ready: signIn("xAI", null, (page) =>
      expect(page.getByRole("heading", { name: "The gateway is busy" })).toBeVisible(),
    ),
  },
  {
    name: "signin-unverified",
    query: `${ADMIN}&signin=unverified`,
    ready: signIn("xAI", null, (page) =>
      expect(page.getByRole("heading", { name: "Signed in, not confirmed" })).toBeVisible(),
    ),
  },
  {
    name: "signin-several",
    query: `${ADMIN}&signin=several`,
    ready: signIn("xAI", null, (page) =>
      expect(page.getByTestId("several").getByRole("button")).toHaveCount(2),
    ),
  },
  {
    name: "connect-key-unverified",
    query: `${ADMIN}&keyread=fail`,
    ready: async (page) => {
      await connectStep(page);
      await page.getByText("Use an API key instead").click();
      await page.getByRole("combobox", { name: "Provider" }).selectOption("openai");
      await page.getByTestId("api-key").fill("made-up-key-for-a-check");
      await page.getByRole("button", { name: "Save key" }).click();
      await expect(page.getByRole("heading", { name: "Key sent, not confirmed" })).toBeVisible();
    },
  },
  {
    name: "signin-cancel-unknown",
    query: `${ADMIN}&signin=cancel-unknown`,
    ready: signIn("xAI", null, (page) => expect(page.getByTestId("cancel-unknown")).toBeVisible()),
  },
  {
    name: "bot-connect",
    query: `${page$("bound")}&kept=1`,
    ready: async (page) => {
      await accountPage(page);
      await page.getByRole("button", { name: "Change account" }).click();
      await page.getByRole("button", { name: /^Connect an account/ }).click();
      await expect(page.getByTestId("kept-note")).toBeVisible();
    },
  },
  {
    name: "signin-unconfirmed",
    query: `${ADMIN}&signin=unconfirmed`,
    ready: signIn("xAI", null, (page) =>
      expect(page.getByRole("heading", { name: "Saved, not confirmed" })).toBeVisible(),
    ),
  },
  // Settings → Accounts
  { name: "settings-accounts", query: ADMIN, ready: accounts },
  { name: "settings-accounts-unlabelled", query: `${ADMIN}&labels=none`, ready: accounts },
  { name: "settings-accounts-read", query: `scene=main&${OTTO_DISK}&access=read`, ready: accounts },
  { name: "settings-accounts-empty", query: `${ADMIN}&accounts=none`, ready: accounts },
  {
    name: "settings-account-page",
    query: ADMIN,
    ready: async (page) => {
      await accounts(page);
      await page.getByRole("button", { name: /^OpenAI · Work, / }).click();
      await expect(page.getByTestId("account-facts")).toBeVisible();
    },
  },
  {
    name: "settings-account-kept",
    query: ADMIN,
    ready: async (page) => {
      await accounts(page);
      await page.getByRole("button", { name: /^Anthropic · Pip's key, / }).click();
      await expect(page.getByTestId("account-facts")).toBeVisible();
    },
  },
  {
    name: "settings-disconnect",
    query: ADMIN,
    ready: async (page) => {
      await accounts(page);
      await page.getByRole("button", { name: /^OpenAI · Work, / }).click();
      await page.getByRole("button", { name: "Disconnect…" }).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
    },
  },
  // A bot's settings
  {
    name: "bot-settings",
    query: page$("bound"),
    ready: (page) => expect(page.getByTestId("account-word")).toHaveText("Bound"),
  },
  { name: "bot-account-bound", query: page$("bound"), ready: accountPage },
  { name: "bot-account-locked", query: page$("locked"), ready: accountPage },
  { name: "bot-account-stale", query: page$("stale"), ready: accountPage },
  { name: "bot-account-gone", query: page$("gone"), ready: accountPage },
  { name: "bot-account-read-failed", query: page$("failed"), ready: accountPage },
  { name: "bot-account-multi", query: page$("multi"), ready: accountPage },
  { name: "bot-account-gateway", query: page$("gateway"), ready: accountPage },
  { name: "bot-account-retained", query: page$("retained"), ready: accountPage },
  { name: "bot-account-lost", query: page$("lost"), ready: accountPage },
  { name: "bot-account-none", query: page$("none"), ready: accountPage },
  { name: "bot-account-differs", query: page$("differs"), ready: accountPage },
  { name: "bot-account-configured", query: page$("configured"), ready: accountPage },
  { name: "bot-account-unavailable", query: page$("unavailable"), ready: accountPage },
  { name: "bot-account-elsewhere", query: page$("elsewhere"), ready: accountPage },
  { name: "bot-account-unwritten", query: page$("unwritten"), ready: accountPage },
  { name: "bot-account-read-only", query: page$("locked", "read"), ready: accountPage },
  // OpenClaw 2026.10.10 on changes a bot's account order only while the gateway is stopped.
  {
    name: "bot-account-bound-stopped",
    query: `${page$("bound")}&version=2026.11.10`,
    ready: accountPage,
  },
  {
    name: "bot-account-stale-stopped",
    query: `${page$("stale")}&version=2026.11.10`,
    ready: accountPage,
  },
  // Below admin the unlock and the clear stay the gateway's steps; with admin they are buttons.
  {
    name: "bot-account-unlock-stopped",
    query: `${page$("locked", "write")}&version=2026.11.10`,
    ready: async (page) => {
      await accountPage(page);
      await page.locator("details.b-disclosure", { hasText: "Unlock" }).locator("summary").click();
      await expect(page.getByTestId("stopped-steps")).toBeVisible();
    },
  },
  {
    name: "bot-account-retained-stopped",
    query: `${page$("retained", "write")}&version=2026.11.10`,
    ready: accountPage,
  },
  // Unlock with a button (F-592): its confirmation, and the page after the gateway's read.
  {
    name: "bot-account-unlock-confirm",
    query: `${page$("locked")}&version=2026.11.10`,
    ready: async (page) => {
      await accountPage(page);
      await page.getByRole("button", { name: "Unlock…" }).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
    },
  },
  {
    name: "bot-account-unlocked",
    query: page$("locked"),
    ready: async (page) => {
      await accountPage(page);
      await page.getByRole("button", { name: "Unlock…" }).click();
      await page.getByRole("button", { name: "Unlock", exact: true }).click();
      await expect(page.getByTestId("clear-outcome")).toBeVisible();
    },
  },
  {
    name: "bot-change-account",
    query: page$("locked"),
    ready: async (page) => {
      await accountPage(page);
      await page.getByRole("button", { name: "Change account" }).click();
      await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
      await expect(page.getByText(/Otto is locked to OpenAI · Work\. After saving/)).toBeVisible();
    },
  },
  {
    name: "bot-change-provider",
    query: page$("bound"),
    ready: async (page) => {
      await accountPage(page);
      await page.getByRole("button", { name: "Change account" }).click();
      await page.getByRole("radio", { name: /^xAI · Personal/ }).click();
      await expect(page.getByText("Choose one of xAI's models for Otto.")).toBeVisible();
    },
  },
];

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const scene of SCENES) {
        test(`accounts: ${scene.name}`, async ({ page }) => {
          await openFixture(page, scene.query, theme);
          await scene.ready(page);
          await settle(page);
          await expect(page).toHaveScreenshot(`${scene.name}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}
