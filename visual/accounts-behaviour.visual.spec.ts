// How the account screens behave (docs/design/bots.md, sections 2 to 11 and
// 19): the "+" menu and ⌘N, focus in and out of the dialogs, the radio groups'
// one tab stop and arrows, the selects, Escape that belongs to the innermost
// thing, the access bar for admin, and what a read-only connection shows.
import type { ClawtrateBridge, ClawtrateState } from "../packages/core/src/index.ts";
import { expect, test, type Page } from "@playwright/test";
import {
  contextFor,
  moveTarget,
  NOW,
  openFixture,
  OTTO_DISK,
  sentStamp,
  settle,
  SIZES,
} from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;
const ADMIN = `scene=main&${OTTO_DISK}&access=admin`;

test.use(contextFor(WIDE, "light"));

const newBot = (page: Page) => page.getByTestId("new-bot");
const sent = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: Array<Record<string, unknown>> } }
    ).clawtrateFixture.sent.map((each) => ({ ...each })),
  );

type Frames = { releaseFrames: () => void };
/** Animation frames asked for from now wait until `releaseFrames`: a slow frame, made certain. */
const holdFrames = (page: Page) =>
  page.evaluate(() => {
    const real = window.requestAnimationFrame.bind(window);
    const held: FrameRequestCallback[] = [];
    window.requestAnimationFrame = (callback) => (held.push(callback), 0);
    (window as unknown as Frames).releaseFrames = () => {
      window.requestAnimationFrame = real;
      for (const callback of held.splice(0)) real(callback);
    };
  });
/** Runs the held callbacks and waits until they have run. */
const releaseFrames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) => {
        (window as unknown as Frames).releaseFrames();
        requestAnimationFrame(() => done());
      }),
  );

test("F-034: the one + menu offers New task and New bot with ⌘N; New bot opens on its name, and Escape gives focus back to +", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  const plus = page.getByTestId("plus");
  await expect(plus).toHaveCount(1);
  await plus.click();
  const menu = page.getByRole("menu", { name: "New" });
  await expect(menu.getByRole("menuitem")).toHaveText(["New task for Otto⌥T", "New bot⌘N"]);
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: /^New bot/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(newBot(page)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Name" })).toBeFocused();
  // The live picture follows the creature and colour chosen.
  await page.getByRole("radio", { name: "Shellfolk" }).click();
  await page.getByRole("radio", { name: "Sky" }).click();
  await expect(page.locator(".b-preview svg")).toHaveAttribute("data-family", "shellfolk");
  await expect(page.locator('.b-preview svg [data-part="shell"]')).toHaveAttribute(
    "fill",
    "#45bdf5",
  );
  await page.keyboard.press("Escape");
  await expect(newBot(page)).toHaveCount(0);
  await expect(plus).toBeFocused();
  // What was entered is kept: the dialog opens again with it, from ⌘N.
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByRole("radio", { name: "Shellfolk" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("F-034 F-035: the picker's groups are radio groups of one tab stop; arrows move and choose; Enter in the name is Next", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill("Viral");
  await page.keyboard.press("Tab");
  // A fresh dialog starts on a Clawling.
  await expect(page.getByRole("radio", { name: "Clawlings" })).toBeFocused();
  await expect(page.getByRole("radio", { name: "Clawlings" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Shellfolk" })).toBeFocused();
  await expect(page.getByRole("radio", { name: "Shellfolk" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByRole("radiogroup", { name: "Shell" })).toBeVisible();
  // Frames asked for from Home on run only after Tab: a focus move the key left for a later
  // frame lands after Tab and takes focus back from the colours.
  await holdFrames(page);
  await page.keyboard.press("Home");
  await expect(page.getByRole("radio", { name: "Clawlings" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // Read while the frames are held: Home itself moved focus to the family it chose.
  const homeFocusedFirst = await page
    .getByRole("radio", { name: "Clawlings" })
    .evaluate((radio) => radio === document.activeElement);
  // One tab stop: Tab leaves the group for the next, the Clawling's body.
  await page.keyboard.press("Tab");
  await releaseFrames(page);
  await expect(page.getByRole("radio", { name: "Dome" })).toBeFocused();
  expect(homeFocusedFirst).toBe(true);
  await page.getByRole("textbox", { name: "Name" }).press("Enter");
  await expect(page.getByRole("heading", { name: "Account", level: 2 })).toBeVisible();
  await expect(page.getByText("Choose the account Viral runs on.")).toBeVisible();
  // Back keeps everything.
  await page.getByRole("button", { name: "Back to the picture" }).click();
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Viral");
  await expect(page.getByRole("radio", { name: "Clawlings" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("F-472: the Account step: subscriptions first, the gateway's choice last; Create waits for a choice; arrows choose", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  const group = page.getByRole("radiogroup", { name: "Accounts" });
  await expect(group.locator(".b-group")).toHaveText(["Subscriptions", "API keys"]);
  const radios = group.getByRole("radio");
  await expect(radios.first()).toHaveAccessibleName(/^OpenAI · Work, Subscription, Marlow, Otto$/);
  await expect(radios.last()).toHaveAccessibleName(
    /^Let the gateway choose\. No fixed account\. The gateway picks one of OpenAI's accounts for each run, as its account order allows, with its default model, gpt-5\.5\.$/,
  );
  // An account kept by one bot is not offered to a bot that does not exist yet.
  await expect(group.getByRole("radio", { name: /Pip's key/ })).toHaveCount(0);
  // Nothing chosen: Create waits, and says why.
  await expect(page.getByTestId("create")).toBeDisabled();
  await expect(page.getByText("Choose an account, or let the gateway choose.")).toBeVisible();
  // One tab stop, the first row when none is chosen; arrows move and choose.
  await radios.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(radios.nth(1)).toBeFocused();
  await expect(radios.nth(1)).toHaveAttribute("aria-checked", "true");
  await expect(group.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press("End");
  await expect(radios.last()).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("create")).toBeEnabled();
  // The model and effort follow, for the default model's provider.
  await expect(page.getByTestId("model-select")).toHaveAccessibleName("Model: gpt-5.5");
  await expect(page.getByTestId("effort-select")).toHaveAccessibleName("Effort: Medium");
});

test("F-472: focus a person moves into the Account step at once stays there when the step's own focus move comes late", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await holdFrames(page);
  await page.getByRole("button", { name: "Next" }).click();
  const radios = page.getByRole("radiogroup", { name: "Accounts" }).getByRole("radio");
  await radios.first().focus();
  await releaseFrames(page);
  await expect(radios.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(radios.nth(1)).toBeFocused();
  await expect(radios.nth(1)).toHaveAttribute("aria-checked", "true");
});

test("F-472: with focus left alone, the Account step's heading takes it as the step changes", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await holdFrames(page);
  await page.getByRole("button", { name: "Next" }).click();
  await releaseFrames(page);
  await expect(page.getByRole("heading", { name: "Account", level: 2 })).toBeFocused();
});

test("F-472: when the gateway's default model names an account, that account is chosen at first, and the step says why", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&defacct=1`, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("radio", { name: /^OpenAI · Work/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(
    page.getByText("Chosen because the gateway's default model names it."),
  ).toBeVisible();
});

test("F-472: Create writes the bot on the account chosen, with its model and effort, then opens it", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill("Viral");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /^xAI · Personal/ }).click();
  await expect(page.getByTestId("model-select")).toHaveAccessibleName("Model: grok-4.7");
  // A model with no levels offers no effort.
  await page.getByTestId("model-select").click();
  await page.getByRole("menuitemradio", { name: "grok-build-0.1" }).click();
  await expect(page.getByTestId("effort-select")).toHaveAccessibleName("Effort: Not offered");
  await expect(page.getByTestId("effort-select")).toBeDisabled();
  await page.getByTestId("create").click();
  await expect(newBot(page)).toHaveCount(0);
  const create = (await sent(page)).find((each) => each.type === "createBot");
  expect(create).toMatchObject({
    name: "Viral",
    account: "xai:personal",
    provider: "xai",
    model: "grok-build-0.1",
    effort: null,
  });
  // The picture was left as it was: none is sent, and the bot's id chooses its Clawling.
  expect(create!.avatar).toBeNull();
  await expect(
    page.getByTestId("bot-list").getByRole("button", { name: /^Viral\b/ }),
  ).toBeVisible();
});

for (const first of ["pairing", "interactive"] as const) {
  test(`F-157: late ${first} answers leave a newer admin grant in place`, async ({ page }) => {
    await page.clock.install({ time: NOW });
    await openFixture(
      page,
      `scene=main&${OTTO_DISK}&access=read&admin=grant&pairing=grant`,
      "light",
    );
    await page.clock.pauseAt(new Date(NOW.getTime() + 60_000));
    await page.evaluate(async (first) => {
      const { clawtrateFixture: bridge } = window as unknown as {
        clawtrateFixture: ClawtrateBridge & { hold(): void; release(): void };
      };
      await bridge.send(
        first === "pairing"
          ? { type: "requestAccess", tier: "pairing" }
          : { type: "requestAccess" },
      );
      bridge.hold();
      await bridge.send({ type: "requestAccess", tier: "admin" });
      bridge.release();
    }, first);
    const connection = () =>
      page.evaluate(
        () =>
          (window as unknown as { clawtrateFixture: ClawtrateBridge }).clawtrateFixture.getState()
            .connection,
      );
    const granted = await connection();
    expect(granted.scopes).toContain("operator.admin");
    await page.clock.runFor(300);
    expect((await connection()).upgrade.status).toBe("approved");
    await page.clock.runFor(1_000);
    expect((await connection()).scopes).toEqual(granted.scopes);
  });
}

test("F-472: an approval released before the request turns pending stays approved", async ({
  page,
}) => {
  await page.clock.install({ time: NOW });
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write&admin=grant`, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill("Viral");
  await page.getByRole("button", { name: "Next" }).click();
  const bar = page.getByTestId("admin-bar");
  // Timers stop here, so the pending step cannot fire before the release, however slow the page.
  await page.clock.pauseAt(new Date(NOW.getTime() + 60_000));
  await page.evaluate(() =>
    (window as unknown as { clawtrateFixture: { hold(): void } }).clawtrateFixture.hold(),
  );
  await bar.getByRole("button", { name: "Request admin access" }).click();
  // Released before the fixture's 400 ms pending step: the approval comes first.
  await page.evaluate(() =>
    (window as unknown as { clawtrateFixture: { release(): void } }).clawtrateFixture.release(),
  );
  await expect(bar).toContainText("Admin access granted.");
  // The pending step's timer then fires, and must not take the approval back.
  await page.clock.runFor(1_500);
  const status = await page.evaluate(() => {
    let value = "";
    (
      window as unknown as {
        clawtrateFixture: { setState(f: (s: ClawtrateState) => ClawtrateState): void };
      }
    ).clawtrateFixture.setState((state) => {
      value = state.connection.upgrade.status;
      return state;
    });
    return value;
  });
  expect(status).toBe("approved");
  await expect(page.getByText("Choose the account Viral runs on.")).toBeVisible();
});

test("F-472: below admin the rows show but cannot be chosen, and the access bar takes Create's place; what was chosen survives the request", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write&admin=grant`, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill("Viral");
  await page.getByRole("button", { name: "Next" }).click();
  const work = page.getByRole("radio", { name: /^OpenAI openai:work/ });
  await expect(work).toHaveAttribute("aria-disabled", "true");
  await work.click({ force: true });
  await expect(work).toHaveAttribute("aria-checked", "false");
  const bar = page.getByTestId("admin-bar");
  await expect(bar).toContainText(
    "Admin access needed. Creating a bot changes the gateway's settings, which needs admin access. What you chose stays here while you ask.",
  );
  // The owner's approval is held until the check has seen the pending state: that state lasts
  // only until the approval, so a fixed delay is never long enough on a loaded machine.
  await page.evaluate(() =>
    (window as unknown as { clawtrateFixture: { hold(): void } }).clawtrateFixture.hold(),
  );
  await bar.getByRole("button", { name: "Request admin access" }).click();
  await expect(bar).toContainText("Waiting for the gateway's owner.");
  await expect(bar.getByTestId("command")).toContainText("openclaw devices approve");
  expect(
    (await sent(page)).some((each) => each.type === "requestAccess" && each.tier === "admin"),
  ).toBe(true);
  await page.evaluate(() =>
    (window as unknown as { clawtrateFixture: { release(): void } }).clawtrateFixture.release(),
  );
  await expect(page.getByTestId("admin-bar")).toContainText("Admin access granted.");
  // Granted: labels arrive, the name is kept, and the rows can be chosen.
  await expect(page.getByText("Choose the account Viral runs on.")).toBeVisible();
  await page.getByRole("radio", { name: /^OpenAI · Work/ }).click();
  await expect(page.getByRole("radio", { name: /^OpenAI · Work/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("F-474: a sign-in's stages: the code with its link; Back cancels; the API key path is folded and never chosen", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Connect another account" }).click();
  // One tile per provider; OpenRouter's says its sign-in is billed per token.
  await expect(newBot(page).getByRole("button", { name: /^OpenRouter/ })).toContainText(
    "Billed per token",
  );
  const disclosure = newBot(page).locator("details.b-disclosure");
  await expect(disclosure).not.toHaveAttribute("open", "");
  await expect(page.getByTestId("api-key")).toBeHidden();
  await newBot(page)
    .getByRole("button", { name: /^xAI\b/ })
    .click();
  await expect(page.getByRole("heading", { name: "Sign in to xAI", level: 2 })).toBeVisible();
  await expect(page.getByRole("group", { name: "Code QK4F 7PZD" })).toBeVisible();
  await expect(page.getByTestId("open-page")).toHaveAttribute("target", "_blank");
  await expect(page.getByText("Waiting for xAI. The code works for 15 minutes.")).toBeVisible();
  // Back returns to the methods and cancels the sign-in in progress.
  await page.getByRole("button", { name: "Back to sign-in methods" }).click();
  await expect(page.getByRole("heading", { name: "Connect an account", level: 2 })).toBeVisible();
  expect((await sent(page)).map((each) => each.type)).toEqual(
    expect.arrayContaining(["startSignIn", "cancelSignIn"]),
  );
});

test("F-474: Connect an account is a grid of providers, each named, reached by keyboard in reading order", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Connect another account" }).click();
  const grid = newBot(page).getByRole("list", { name: "Providers" });
  // The six most used first, each named by its provider; one the gateway has an account of says so.
  await expect(grid.getByRole("button")).toHaveText([
    /^OpenAI\s*Connected$/,
    /^Claude\s*Connected\s·\sAPI key\s·\sBilled per token$/,
    /^GitHub Copilot\s*Connected$/,
    /^xAI\s*Connected$/,
    /^OpenRouter\s*Billed per token$/,
    /^MiniMax$/,
  ]);
  await grid.getByRole("button", { name: /^OpenAI\b/ }).focus();
  for (const next of [/^Claude/, /^GitHub Copilot/, /^xAI\b/, /^OpenRouter/, /^MiniMax/]) {
    await page.keyboard.press("Tab");
    await expect(newBot(page).getByRole("button", { name: next })).toBeFocused();
  }
  await page.keyboard.press("Tab");
  await expect(newBot(page).getByRole("button", { name: "Show more" })).toBeFocused();
  // Show more goes once pressed; focus moves to the first tile it showed.
  await page.keyboard.press("Enter");
  await expect(newBot(page).getByRole("button", { name: "Show more" })).toHaveCount(0);
  await expect(grid.getByRole("button", { name: /^OpenCode Go/ })).toBeFocused();
  // A provider with several methods shows them in the same dialog, the usual one first; nothing
  // starts until one is chosen.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "MiniMax", level: 2 })).toBeVisible();
  const ways = newBot(page).getByRole("list", { name: "Ways to sign in to MiniMax" });
  await expect(ways.locator(".b-choice-title")).toHaveText(["Global account", "China account"]);
  expect((await sent(page)).filter((each) => each.type === "startSignIn")).toEqual([]);
  // Back gives focus to the tile it came from.
  await page.getByRole("button", { name: "Back to providers" }).click();
  await expect(grid.getByRole("button", { name: /^MiniMax/ })).toBeFocused();
  // A tile with one method starts it at once.
  await grid.getByRole("button", { name: /^OpenCode Go/ }).press("Enter");
  await expect(page.getByTestId("paste")).toBeVisible();
  expect((await sent(page)).find((each) => each.type === "startSignIn")).toMatchObject({
    methodId: "opencode-go/opencode-go-console",
  });
});

test("F-474: Claude's tile, second, says it takes an API key billed per token, and opens the key's fields for Anthropic", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Connect another account" }).click();
  const grid = newBot(page).getByRole("list", { name: "Providers" });
  const claude = grid.getByRole("button").nth(1);
  await expect(claude).toHaveText(/^Claude\s*Connected\s·\sAPI key\s·\sBilled per token$/);
  await expect(claude.locator('[data-logo="claude"] svg')).toBeVisible();
  // The key's provider list, folded, starts on another provider: the tile chooses Anthropic.
  await expect(newBot(page).locator("details.b-disclosure select")).toHaveValue("openai");
  await claude.press("Enter");
  await expect(newBot(page).locator("details.b-disclosure")).toHaveAttribute("open", "");
  await expect(newBot(page).getByRole("combobox", { name: "Provider" })).toHaveValue("anthropic");
  await expect(page.getByTestId("api-key")).toBeFocused();
  // Nothing starts until the key is saved.
  expect((await sent(page)).filter((each) => each.type === "startSignIn")).toEqual([]);
  await page.getByTestId("api-key").fill("made-up-key-for-a-check");
  await newBot(page).getByRole("button", { name: "Save key" }).click();
  await expect
    .poll(async () =>
      (await sent(page))
        .filter((each) => each.type === "saveApiKey")
        .map((each) => (each as { provider: string }).provider),
    )
    .toEqual(["anthropic"]);
  // Sent once, then the key's field is gone with it.
  await expect(page.getByTestId("api-key")).toHaveCount(0);
});

test("F-474: a sign-in chosen among a provider's methods and started again still goes back to them", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&signin=failed`, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Connect another account" }).click();
  await newBot(page)
    .getByRole("button", { name: /^OpenAI\b/ })
    .click();
  await newBot(page).getByRole("button", { name: "Use a device code" }).click();
  await expect(page.getByRole("heading", { name: "Couldn't connect" })).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Couldn't connect" })).toBeVisible();
  await page.getByRole("button", { name: "Back to sign-in methods" }).click();
  await expect(page.getByRole("heading", { name: "OpenAI", level: 2 })).toBeVisible();
});

test("F-474: a provider the app doesn't know shows under the gateway's name, and its sign-in works", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&plugin=1`, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Connect another account" }).click();
  await newBot(page).getByRole("button", { name: "Show more" }).click();
  const tile = newBot(page).getByRole("button", { name: "Nimbus Cloud" });
  await expect(tile.locator('[data-logo="none"]')).toHaveText("N");
  await tile.click();
  await expect(page.getByRole("heading", { name: "Nimbus Cloud", level: 2 })).toBeVisible();
  await newBot(page)
    .getByRole("button", { name: /^Nimbus device login/ })
    .click();
  await expect(page.locator(".b-code")).toBeVisible();
  expect((await sent(page)).find((each) => each.type === "startSignIn")).toMatchObject({
    methodId: "nimbus/nimbus-device",
  });
  // Back from a sign-in chosen among a provider's methods returns to them.
  await page.getByRole("button", { name: "Back to sign-in methods" }).click();
  await expect(page.getByRole("heading", { name: "Nimbus Cloud", level: 2 })).toBeVisible();
});

test("F-474: a pasted code is a password field, cleared as it is sent", async ({ page }) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Connect another account" }).click();
  await newBot(page)
    .getByRole("button", { name: /^OpenAI\b/ })
    .click();
  await newBot(page).getByRole("button", { name: "Sign in with a browser" }).click();
  const paste = page.getByTestId("paste");
  await expect(paste).toHaveAttribute("type", "password");
  await expect(paste).toHaveAttribute("autocomplete", "off");
  await paste.fill("made-up-code-0001");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Connected to OpenAI" })).toBeVisible();
  expect(await page.content()).not.toContain("made-up-code-0001");
  // The label step: another OpenAI account exists, so a label is required.
  await expect(page.getByRole("textbox", { name: "Label" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Done" })).toBeDisabled();
  await page.getByRole("textbox", { name: "Label" }).fill("Studio");
  await page.getByRole("button", { name: "Done" }).click();
  // Back on the Account step, the new account chosen.
  await expect(page.getByRole("radio", { name: /^OpenAI · Studio/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("F-490: the Account page: the lock command, Check now, and Back to the row that opened it", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=bound`,
    "light",
  );
  const row = page.getByRole("button", { name: /^Account: OpenAI · Work, Bound\. Open\.$/ });
  await row.click();
  await expect(page.getByRole("heading", { name: "Account", level: 3 })).toBeFocused();
  await expect(page.getByTestId("bound-note")).toContainText(
    "Bound. Otto runs on OpenAI · Work. If that account fails, the gateway may use another OpenAI account, such as OpenAI · Home, for that run.",
  );
  await expect(page.getByTestId("command")).toHaveText(
    "openclaw models auth order set --provider openai --agent otto openai:work",
  );
  // Copying the command: the page watches for the lock, every 4 seconds.
  await page.getByRole("button", { name: "Copy lock command" }).click();
  await expect(page.getByText("Checking the gateway for the lock, again in 4s")).toBeVisible();
  await page.getByRole("button", { name: "Check now" }).click();
  expect((await sent(page)).filter((each) => each.type === "checkLock").length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Back to settings" }).click();
  await expect(row).toBeFocused();
});

test("F-490: on OpenClaw 2026.11.10 the lock, the unlock and the clear are the gateway's steps: stop it, run the command, start it", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=bound&version=2026.11.10`,
    "light",
  );
  await page.getByRole("button", { name: /^Account: OpenAI · Work, Bound\. Open\.$/ }).click();
  await expect(
    page.getByText(
      "This version of OpenClaw changes a bot's account order only while the gateway is stopped. Stopping it gives work under way up to about five minutes to finish, then stops what is left. Until it starts again, none of your bots runs and Clawtrate can't reach the gateway.",
    ),
  ).toBeVisible();
  const steps = page.getByTestId("stopped-steps");
  await expect(steps.getByRole("listitem")).toHaveText([
    /^Stop the gateway, and wait until it has stopped; this can take a few minutes:openclaw gateway stop$/,
    /^Then run:openclaw models auth order set --provider openai --agent otto openai:work$/,
    /^Start the gateway again, even if the command above failed:openclaw gateway start$/,
  ]);
  // The steps act on the gateway's service; one run by hand is stopped and started where it runs.
  // That is said before the first step, which does nothing to such a gateway.
  const hint = page.getByTestId("unmanaged-hint");
  await expect(hint).toHaveText(
    "These steps stop and start the gateway's service. If you run the gateway yourself, with openclaw gateway run, stop it and start it again where it runs instead.",
  );
  expect(
    await hint.evaluate(
      (node, list) => !!(node.compareDocumentPosition(list!) & Node.DOCUMENT_POSITION_FOLLOWING),
      await steps.elementHandle(),
    ),
  ).toBe(true);
  await expect(
    page.getByText("Clawtrate reads the lock from the gateway when it is back."),
  ).toBeVisible();
  // Copying the order command starts the watch, as before; copying stop or start doesn't.
  await steps.getByRole("button", { name: "Copy stop command" }).click();
  await expect(page.getByText("Checking the gateway for the lock, again in 4s")).toHaveCount(0);
  await steps.getByRole("button", { name: "Copy lock command" }).click();
  await expect(page.getByText("Checking the gateway for the lock, again in 4s")).toBeVisible();

  // Locked, below admin: the unlock, folded, takes the same steps around the clear command.
  // With admin it is a button (F-592).
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=write&lock=locked&version=2026.11.10`,
    "light",
  );
  await page.getByRole("button", { name: /^Account: / }).click();
  const unlock = page.locator("details.b-disclosure", { hasText: "Unlock" });
  await unlock.locator("summary").click();
  await expect(unlock.getByTestId("command")).toHaveText([
    "openclaw gateway stop",
    "openclaw models auth order clear --provider openai --agent otto",
    "openclaw gateway start",
  ]);
  await expect(unlock).toContainText("Clawtrate sees the change when the gateway is back.");
  await expect(unlock.getByTestId("clear-needs-admin")).toHaveText(
    "With admin access, Clawtrate unlocks Otto from here, with the gateway running.",
  );

  // The gateway choosing, with a one-account order still kept: its clear, likewise.
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=write&lock=retained&version=2026.11.10`,
    "light",
  );
  await page.getByRole("button", { name: /^Account: OpenAI, Gateway chooses\. Open\.$/ }).click();
  await expect(page.getByTestId("retained-order").getByTestId("command")).toHaveText([
    "openclaw gateway stop",
    "openclaw models auth order clear --provider openai --agent otto",
    "openclaw gateway start",
  ]);
  await expect(page.getByTestId("retained-order").getByTestId("unmanaged-hint")).toHaveText(
    "These steps stop and start the gateway's service. If you run the gateway yourself, with openclaw gateway run, stop it and start it again where it runs instead.",
  );
  await expect(page.getByTestId("retained-order").getByTestId("clear-needs-admin")).toHaveText(
    "With admin access, Clawtrate clears it from here, with the gateway running.",
  );
  await expect(page.getByTestId("admin-bar")).toContainText("Admin access needed.");
  await expect(page.getByRole("button", { name: "Request admin access" })).toBeVisible();

  // On 2026.10.6 the same page keeps the one command.
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=bound`,
    "light",
  );
  await page.getByRole("button", { name: /^Account: / }).click();
  await expect(page.getByTestId("stopped-steps")).toHaveCount(0);
  await expect(page.getByTestId("command")).toHaveText(
    "openclaw models auth order set --provider openai --agent otto openai:work",
  );
});

test("F-490: what a lock doesn't cover is folded; the read that failed keeps the last confirmation, with its time", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=failed`,
    "light",
  );
  await page
    .getByRole("button", { name: /^Account: OpenAI · Work, Locked, as of 5:28 PM\. Open\.$/ })
    .click();
  await expect(page.getByTestId("locked-note")).toContainText("Locked, as of 5:28 PM.");
  await expect(page.getByTestId("evidence-failed")).toContainText(
    "Couldn't read the gateway's order for Otto. Last confirmed locked at 5:28 PM.",
  );
  const ways = page.locator("details.b-disclosure", { hasText: "What a lock doesn't cover" });
  await expect(ways).not.toHaveAttribute("open", "");
  await ways.locator("summary").click();
  await expect(ways.locator("li")).toHaveCount(8);
});

test("F-473: changing a locked bot's account: the note before saving, then the lock out of date with both commands", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=locked`,
    "light",
  );
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await expect(page.getByRole("heading", { name: "Change account", level: 3 })).toBeFocused();
  const save = page.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
  await expect(
    page.getByText(
      /Otto is locked to OpenAI · Work\. After saving, Otto runs on OpenAI · Home first/,
    ),
  ).toBeVisible();
  await save.click();
  await expect(page.getByTestId("stale-note")).toContainText(
    "The lock is out of date. Otto runs on OpenAI · Home first, but the gateway's order for Otto still lists only OpenAI · Work",
  );
  await expect(page.getByTestId("command").first()).toHaveText(
    "openclaw models auth order set --provider openai --agent otto openai:home",
  );
  await expect(page.getByRole("heading", { name: "Account", level: 3 })).toBeFocused();
});

test("F-478: changing to another provider's account asks for one of its models before saving, and the effort follows it", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=bound`,
    "light",
  );
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await page.getByRole("radio", { name: /^xAI · Personal/ }).click();
  await expect(page.getByText("Choose one of xAI's models for Otto.")).toBeVisible();
  await expect(page.getByTestId("model-select")).toHaveAccessibleName("Model: Choose");
  const save = page.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  // Down opens the select's menu; Escape closes the menu alone.
  await page.getByTestId("model-select").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menu", { name: "Model" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Model" })).toHaveCount(0);
  await expect(page.getByTestId("model-select")).toBeFocused();
  await expect(page.getByTestId("work-panel")).toBeVisible();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitemradio", { name: "grok-4.7" }).click();
  await expect(page.getByTestId("effort-select")).toHaveAccessibleName("Effort: Low");
  await expect(save).toBeEnabled();
  await save.click();
  const change = (await sent(page)).find((each) => each.type === "changeBotAccount");
  expect(change).toMatchObject({
    botId: "otto",
    account: "xai:personal",
    provider: "xai",
    model: "grok-4.7",
    effort: "low",
  });
});

test("F-472: Let the gateway choose for an existing bot, and the one-account order still stored, with Clear order", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=retained`,
    "light",
  );
  await page.getByRole("button", { name: /^Account: OpenAI, Gateway chooses\. Open\.$/ }).click();
  await expect(page.getByTestId("gateway-note")).toContainText("The gateway chooses.");
  await expect(page.getByTestId("retained-order")).toContainText(
    "The gateway still has an order for Otto that names only OpenAI · Work",
  );
  await expect(
    page.getByTestId("retained-order").getByRole("button", { name: "Clear order…" }),
  ).toBeVisible();
  await expect(page.getByTestId("retained-order").getByTestId("command")).toHaveCount(0);
  await page.getByRole("button", { name: "Bind to an account" }).click();
  await expect(page.getByRole("radio", { name: /^Let the gateway choose/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("F-476: below admin there are no labels: accounts are told apart by their ids; nothing that would do nothing is offered", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=read`, "light");
  // On the read tier there is no "+".
  await expect(page.getByTestId("plus")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+n");
  await expect(newBot(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(settings.getByRole("button", { name: /^OpenAI openai:work, / })).toBeVisible();
  await expect(settings.getByRole("button", { name: /^OpenAI openai:home, / })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Connect an account" })).toHaveCount(0);
  await expect(settings.getByTestId("admin-bar")).toContainText("Read-only.");
  await settings.getByRole("button", { name: /^OpenAI openai:work, / }).click();
  await expect(settings.getByRole("button", { name: "Disconnect…" })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Edit label" })).toHaveCount(0);
  // Escape closes Settings, and ⌘, opens it again on the section last shown.
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(settings.getByRole("heading", { name: "Accounts", level: 3 })).toBeVisible();
});

test("F-490: a read-only connection shows a bot's settings with every value, and changes nothing", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=read&lock=locked`,
    "light",
  );
  await expect(page.getByTestId("model-select")).toBeDisabled();
  await page
    .getByRole("button", { name: /^Account: OpenAI openai:work, Locked\. Open\.$/ })
    .click();
  await expect(page.getByTestId("locked-note")).toBeVisible();
  await expect(page.getByRole("button", { name: "Change account" })).toHaveCount(0);
  await expect(page.getByTestId("admin-bar")).toContainText(
    "Changing Otto's settings needs admin access.",
  );
});

test("#505: Change account sends the stamp of the accounts it shows, not the identity now connected", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=bound`,
    "light",
  );
  type Stamped = {
    clawtrateFixture: {
      setState(change: (state: ClawtrateState) => ClawtrateState): void;
    };
  };
  // The accounts shown were read on this connection; then another gateway answers a reconnect
  // at the same address and names itself before they are read again.
  const read = await page.evaluate(() => {
    let read = { gatewayId: null as string | null, target: 0 };
    (window as unknown as Stamped).clawtrateFixture.setState((state) => {
      read = { gatewayId: state.connection.gatewayId, target: state.connection.target };
      return {
        ...state,
        accounts: {
          ...state.accounts,
          readOn: { ...read, connectedAt: state.connection.connectedAt },
        },
        connection: { ...state.connection, gatewayId: "another-gateway" },
      };
    });
    return read;
  });
  expect(read.gatewayId).not.toBeNull();
  // The model, on the tab's first page.
  await page.getByTestId("model-select").click();
  await page.getByRole("menu", { name: "Model" }).getByRole("menuitemradio").nth(1).click();
  await expect.poll(() => sentStamp(page, "setBotModel")).toEqual(read);
  // Change account.
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => sentStamp(page, "changeBotAccount")).toEqual(read);
  // Disconnect… on Settings, Accounts.
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  await settings.getByRole("button", { name: /^OpenAI · Work, / }).click();
  await settings.getByRole("button", { name: "Disconnect…" }).click();
  await page
    .getByRole("alertdialog", { name: "Disconnect OpenAI · Work?" })
    .getByRole("button", { name: "Disconnect" })
    .click();
  await expect.poll(() => sentStamp(page, "disconnectAccount")).toEqual(read);
});

test("#505: a choice on Change account made before the accounts were read on another connection doesn't go with the new read", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=bound`,
    "light",
  );
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  const home = page.getByRole("radio", { name: /^OpenAI · Home/ });
  await home.click();
  await expect(home).toBeChecked();
  // The accounts are read again on another connection, answered by another gateway.
  const read = await page.evaluate(() => {
    let read = { gatewayId: "another-gateway", target: 0 };
    (
      window as unknown as {
        clawtrateFixture: { setState(change: (state: ClawtrateState) => ClawtrateState): void };
      }
    ).clawtrateFixture.setState((state) => {
      read = { gatewayId: "another-gateway", target: state.connection.target };
      return {
        ...state,
        connection: { ...state.connection, gatewayId: "another-gateway" },
        accounts: {
          ...state.accounts,
          readOn: { ...read, connectedAt: (state.connection.connectedAt ?? 0) + 1 },
        },
      };
    });
    return read;
  });
  // The choice made from the earlier read is let go: nothing is ready to save.
  await expect(home).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  // Made again from the new read, it goes with that read's stamp.
  await home.click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => sentStamp(page, "changeBotAccount")).toEqual(read);
});

test("#505: Remove fallbacks sends the stamp of the accounts it shows, not the identity now connected", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=differs`,
    "light",
  );
  const read = await page.evaluate(() => {
    let read = { gatewayId: null as string | null, target: 0 };
    (
      window as unknown as {
        clawtrateFixture: { setState(change: (state: ClawtrateState) => ClawtrateState): void };
      }
    ).clawtrateFixture.setState((state) => {
      read = { gatewayId: state.connection.gatewayId, target: state.connection.target };
      return {
        ...state,
        accounts: {
          ...state.accounts,
          readOn: { ...read, connectedAt: state.connection.connectedAt },
        },
        connection: { ...state.connection, gatewayId: "another-gateway" },
      };
    });
    return read;
  });
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Remove fallbacks" }).click();
  await expect.poll(() => sentStamp(page, "removeBotFallbacks")).toEqual(read);
});

test("#505: a key typed in Connect sends the stamp of the accounts it shows, not the identity now connected", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  const read = await page.evaluate(() => {
    let read = { gatewayId: null as string | null, target: 0 };
    (
      window as unknown as {
        clawtrateFixture: { setState(change: (state: ClawtrateState) => ClawtrateState): void };
      }
    ).clawtrateFixture.setState((state) => {
      read = { gatewayId: state.connection.gatewayId, target: state.connection.target };
      return {
        ...state,
        accounts: {
          ...state.accounts,
          readOn: { ...read, connectedAt: state.connection.connectedAt },
        },
        connection: { ...state.connection, gatewayId: "another-gateway" },
      };
    });
    return read;
  });
  await connectFromNewBot(page);
  await newBot(page).getByText("Use an API key instead").click();
  await newBot(page).getByRole("combobox", { name: "Provider" }).selectOption("xai");
  await page.getByTestId("api-key").fill("made-up-key-for-a-check");
  await newBot(page).getByRole("button", { name: "Save key" }).click();
  await expect.poll(() => sentStamp(page, "saveApiKey")).toEqual(read);
});

test("#450: Change account, a Disconnect confirmation and a typed key send the target they opened with", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=bound`,
    "light",
  );
  // Change account: the choice is made on the page as it opened.
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
  let before = await moveTarget(page);
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => sentStamp(page, "changeBotAccount")).toEqual(before);

  // Disconnect…: the confirmation keeps the target it was asked under.
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  await settings.getByRole("button", { name: /^OpenAI · Work, / }).click();
  await settings.getByRole("button", { name: "Disconnect…" }).click();
  before = await moveTarget(page);
  await page
    .getByRole("alertdialog", { name: "Disconnect OpenAI · Work?" })
    .getByRole("button", { name: "Disconnect" })
    .click();
  await expect.poll(() => sentStamp(page, "disconnectAccount")).toEqual(before);
});

test("#450: a key typed in Connect goes with the target Connect opened with", async ({ page }) => {
  await openFixture(page, ADMIN, "light");
  await connectFromNewBot(page);
  await newBot(page).getByText("Use an API key instead").click();
  await newBot(page).getByRole("combobox", { name: "Provider" }).selectOption("xai");
  await page.getByTestId("api-key").fill("made-up-key-for-a-check");
  const before = await moveTarget(page);
  await newBot(page).getByRole("button", { name: "Save key" }).click();
  await expect.poll(() => sentStamp(page, "saveApiKey")).toEqual(before);
});

test("#450: disconnecting the account a failed sign-in left sends the stamp Connect opened with", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&signin=failed&saved=1`, "light");
  await connectFromNewBot(page);
  await newBot(page)
    .getByRole("button", { name: /^xAI\b/ })
    .click();
  await expect(page.getByTestId("reread")).toContainText("It may not be ready to use.");
  await page.getByTestId("reread").getByRole("button", { name: "Disconnect it…" }).click();
  const before = await moveTarget(page);
  await newBot(page).getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect.poll(() => sentStamp(page, "disconnectAccount")).toEqual(before);
  // Refused, as the host refuses a confirmation from before the target moved: the screen says so.
  await expect(page.getByTestId("drop-error")).toHaveText(
    "The connection changed since this screen was read, so nothing was sent. Look again, then try again.",
  );
});

test("#450: a Disconnect confirmation is refused when another gateway names itself on the same target", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  await settings.getByRole("button", { name: /^OpenAI · Work, / }).click();
  await settings.getByRole("button", { name: "Disconnect…" }).click();
  // A reconnect answered by another gateway at the same address: same target, another identity.
  await page.evaluate(() =>
    (
      window as unknown as {
        clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
      }
    ).clawtrateFixture.setState((state) => ({
      ...state,
      connection: { ...state.connection, gatewayId: "another-gateway" },
    })),
  );
  await page
    .getByRole("alertdialog", { name: "Disconnect OpenAI · Work?" })
    .getByRole("button", { name: "Disconnect" })
    .click();
  await expect(settings.getByTestId("b-announcer")).toHaveText(
    "This change was made for another gateway, so nothing was sent.",
  );
  const accounts = await page.evaluate(() =>
    (window as unknown as { clawtrateFixture: { getState: () => ClawtrateState } }).clawtrateFixture
      .getState()
      .accounts.accounts.map((each) => each.id),
  );
  expect(accounts).toContain("openai:work");
});

test("F-476: Disconnect asks first, with focus on Cancel; Escape closes the confirmation alone", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  await settings.getByRole("button", { name: /^OpenAI · Work, / }).click();
  await expect(settings.getByTestId("account-facts")).toContainText("Used byMarlow, Otto (locked)");
  await settings.getByRole("button", { name: "Disconnect…" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Disconnect OpenAI · Work?" });
  await expect(confirm).toHaveAccessibleDescription(
    "Marlow and Otto use it. They show No account until you choose another, and Clawtrate doesn't start them until then. Your gateway removes the sign-in.",
  );
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(settings).toBeVisible();
  // A label already used by the provider is refused, and the field says why.
  await settings.getByRole("button", { name: "Edit label" }).click();
  await settings.getByRole("textbox", { name: "Label" }).fill("home");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings.getByRole("textbox", { name: "Label" })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(settings.locator("#b-relabel-error")).toHaveText(
    "Another OpenAI account is called Home. Choose a different label.",
  );
});

test.describe("phone", () => {
  test.use(contextFor(PHONE, "light"));
  test("F-034: on a phone New bot is a sheet over the screen, and Settings opens on its list", async ({
    page,
  }) => {
    await openFixture(page, ADMIN, "light");
    await page.keyboard.press("ControlOrMeta+n");
    const sheet = newBot(page);
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(388);
    expect(box.height).toBeGreaterThan(780);
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings.getByRole("navigation", { name: "Settings" })).toBeVisible();
    await settings.getByRole("button", { name: "Accounts", exact: true }).click();
    await expect(settings.getByRole("navigation", { name: "Settings" })).toBeHidden();
    await settings.getByRole("button", { name: "Back to settings" }).click();
    await expect(settings.getByRole("navigation", { name: "Settings" })).toBeVisible();
    await settle(page);
  });
});

/** Change the fixture's state, as the engine would. */
const change = (page: Page, run: string) =>
  page.evaluate((body) => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState: (change: (state: unknown) => unknown) => void };
      }
    ).clawtrateFixture;
    fixture.setState(new Function("state", body) as (state: unknown) => unknown);
  }, run);

const SETTINGS_TAB = `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin`;

test("F-490: an order from the gateway's settings is named as that, never as a lock", async ({
  page,
}) => {
  await openFixture(page, `${SETTINGS_TAB}&lock=configured`, "light");
  await page.getByRole("button", { name: /^Account: OpenAI · Work, Bound\. Open\.$/ }).click();
  await expect(page.getByTestId("bound-note")).toBeVisible();
  await expect(page.getByTestId("locked-note")).toHaveCount(0);
  await expect(page.getByTestId("evidence")).toContainText(
    "The gateway's settings order OpenAI's accounts as OpenAI · Work. That order is the gateway's, not Otto's own, so it is not a lock.",
  );
  await expect(
    page.getByText(/The gateway's settings also set an order for OpenAI accounts\./),
  ).toBeVisible();
});

test("F-490: an answer that account status is unavailable is stated as that, with the last confirmation and its time", async ({
  page,
}) => {
  await openFixture(page, `${SETTINGS_TAB}&lock=unavailable`, "light");
  await page
    .getByRole("button", { name: /^Account: OpenAI · Work, Locked, as of 5:28 PM\. Open\.$/ })
    .click();
  await expect(page.getByTestId("locked-note")).toContainText("Locked, as of 5:28 PM.");
  await expect(page.getByTestId("evidence-unavailable")).toContainText(
    "The gateway says its account status is unavailable (PREPARED_MODEL_AUTH_UNAVAILABLE), so Clawtrate can't read Otto's order now. Last confirmed locked at 5:28 PM.",
  );
  await expect(page.getByTestId("evidence-failed")).toHaveCount(0);
});

test("F-490: evidence ages: an open page that goes offline, or reconnects, says when it last checked", async ({
  page,
}) => {
  await openFixture(page, `${SETTINGS_TAB}&lock=locked`, "light");
  await page.getByRole("button", { name: /^Account: / }).click();
  await expect(page.getByTestId("evidence")).toContainText("Checked with the gateway at 5:40 PM.");
  await page.clock.setFixedTime(new Date("2026-11-16T17:47:00-05:00"));
  await change(
    page,
    `return { ...state, connection: { ...state.connection, status: "reconnecting" } };`,
  );
  await expect(page.getByTestId("evidence")).toHaveText(
    "Last checked at 5:40 PM. Clawtrate checks again when it reconnects.",
  );
  await expect(page.getByTestId("locked-note")).toContainText("Locked, as of 5:40 PM.");
  // Connected again: the page does not keep evidence from before this connection; it reads the order again.
  await change(
    page,
    `return { ...state, connection: { ...state.connection, status: "connected", connectedAt: Date.now() } };`,
  );
  await expect(page.getByTestId("evidence")).toHaveText("Checked with the gateway at 5:47 PM.");
  expect(
    (await sent(page)).filter((each) => each.type === "checkLock").length,
  ).toBeGreaterThanOrEqual(2);
});

test("F-490 F-476: an account only another bot keeps is no account for this bot, whatever its order", async ({
  page,
}) => {
  await openFixture(page, `${SETTINGS_TAB}&lock=elsewhere`, "light");
  await page.getByRole("button", { name: /^Account: .*No account\. Open\.$/ }).click();
  await expect(
    page.getByText(
      "No account. Otto's account, Anthropic · Pip's key, is kept by Pip only, so Otto can't use it.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(page.getByTestId("locked-note")).toHaveCount(0);
});

test("F-472: Create and Save take only a choice the list shows now: a failed read, or an account gone, disables them", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
  await expect(page.getByTestId("create")).toBeEnabled();
  await change(
    page,
    `return { ...state, accounts: { ...state.accounts, status: "error", error: "timed out" } };`,
  );
  await expect(page.getByText("Couldn't load the gateway's accounts.")).toBeVisible();
  await expect(page.getByRole("radio", { name: /^OpenAI · Home/ })).toHaveCount(0);
  await expect(page.getByTestId("create")).toBeDisabled();
  await expect(page.getByTestId("choice-gone")).toBeVisible();
  // Read again, and the account is gone from the gateway.
  await change(
    page,
    `return { ...state, accounts: { ...state.accounts, status: "ready", error: null, accounts: state.accounts.accounts.filter((a) => a.id !== "openai:home") } };`,
  );
  await expect(page.getByTestId("create")).toBeDisabled();
  await expect(page.getByTestId("choice-gone")).toHaveText(
    "The account chosen is no longer on the gateway. Choose another, or let the gateway choose.",
  );
  await page.getByRole("radio", { name: /^Let the gateway choose/ }).click();
  await expect(page.getByTestId("create")).toBeEnabled();
  await page.keyboard.press("Escape");
  // Change account: the same rule for Save.
  await page.keyboard.press("ControlOrMeta+\\");
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await page.getByRole("radio", { name: /^xAI · Personal/ }).click();
  await page.getByTestId("model-select").click();
  await page.getByRole("menuitemradio", { name: "grok-4.7" }).click();
  await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
  await change(
    page,
    `return { ...state, accounts: { ...state.accounts, status: "error", error: "timed out" } };`,
  );
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
});

/** The open Model menu's rows: name, whether disabled, and the note under each. */
const menuRows = (page: Page) =>
  page
    .getByRole("menu", { name: "Model" })
    .locator(".menu-item")
    .evaluateAll((items) =>
      items.map((i) => [
        i.getAttribute("aria-label") ?? i.textContent?.trim(),
        i.getAttribute("aria-disabled") === "true",
        i.getAttribute("aria-description") ?? "",
      ]),
    );
const releaseCatalog = (page: Page) =>
  page.evaluate(() => (window as unknown as { releaseCatalog: () => void }).releaseCatalog());

/** New bot's Account step with OpenAI · Work chosen. */
async function newBotOnWork(page: Page, query: string) {
  await openFixture(page, query, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Work/ }).click();
}

test("F-478: the Model menu is the gateway's picker, its unavailable models disabled as before, and View more reads the full list only when opened", async ({
  page,
}) => {
  await newBotOnWork(page, `${ADMIN}&catalog=slow`);
  const select = page.getByTestId("model-select");
  await select.click();
  const menu = page.getByRole("menu", { name: "Model" });
  // The picker as it was: the gateway's rows, the unavailable one disabled with its note.
  expect(await menuRows(page)).toEqual([
    ["gpt-5.5", false, ""],
    ["gpt-5.5-mini", false, ""],
    ["gpt-5.5-codex", false, "Not available"],
    ["Refresh", false, "Look for new models"],
    ["View more", false, ""],
    ["Use another model…", false, "Type its id"],
  ]);
  await menu.getByRole("menuitemradio", { name: "gpt-5.5-codex" }).click();
  await expect(menu).toBeVisible();
  expect((await sent(page)).filter((each) => each.type === "loadModelCatalog")).toEqual([]);
  // Opened: the full list is asked for, and View more says it is loading.
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  expect((await sent(page)).filter((each) => each.type === "loadModelCatalog")).toEqual([
    { type: "loadModelCatalog", provider: "openai" },
  ]);
  const loading = menu.getByRole("menuitem", { name: "View more" });
  await expect(loading).toHaveAccessibleDescription("Loading…");
  await expect(loading).toHaveAttribute("aria-disabled", "true");
  await releaseCatalog(page);
  // A section of its own: one line, then the models the picker lacks, in the gateway's order,
  // none of them disabled or marked, though the gateway marks gpt-5.5-pro unavailable.
  await expect(
    menu.getByText("Also listed for OpenAI. OpenAI decides which this account can use."),
  ).toBeVisible();
  await expect
    .poll(() => menuRows(page))
    .toEqual([
      ["gpt-5.5", false, ""],
      ["gpt-5.5-mini", false, ""],
      ["gpt-5.5-codex", false, "Not available"],
      ["Refresh", false, "Look for new models"],
      ["gpt-5.4", false, ""],
      ["gpt-5.4-mini", false, ""],
      ["gpt-5.5-pro", false, ""],
      ["Use another model…", false, "Type its id"],
    ]);
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true })).toBeFocused();
  await menu.getByRole("menuitemradio", { name: "gpt-5.5-pro" }).click();
  await expect(select).toHaveAccessibleName("Model: gpt-5.5-pro");
  // Its own levels decide the effort.
  await expect(page.getByTestId("effort-select")).toHaveAccessibleName("Effort: Medium");
  await page.getByTestId("create").click();
  expect((await sent(page)).find((each) => each.type === "createBot")).toMatchObject({
    account: "openai:work",
    model: "gpt-5.5-pro",
    effort: "medium",
  });
});

test("F-478: no text says a model is absent or unavailable, beyond the picker's own note", async ({
  page,
}) => {
  await newBotOnWork(page, ADMIN);
  await page.getByTestId("model-select").click();
  await page
    .getByRole("menu", { name: "Model" })
    .getByRole("menuitem", { name: "View more" })
    .click();
  await expect(page.getByRole("menuitemradio", { name: "gpt-5.5-pro" })).toBeVisible();
  const text = await page.getByTestId("new-bot").innerText();
  expect(text).not.toMatch(/isn't in|doesn't offer|not in the gateway|isn't available/i);
  expect(text.match(/Not available/g) ?? []).toHaveLength(1);
});

test("F-478: View more that failed says so and tries again; a refused one isn't offered; a long list says how many it shows", async ({
  page,
}) => {
  await newBotOnWork(page, `${ADMIN}&catalog=fail`);
  await page.getByTestId("model-select").click();
  const menu = page.getByRole("menu", { name: "Model" });
  await menu.getByRole("menuitem", { name: "View more" }).click();
  await expect(menu.getByText("Couldn't load more models.")).toBeVisible();
  await menu.getByRole("menuitem", { name: "Try again" }).click();
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await newBotOnWork(page, `${ADMIN}&catalog=unsupported`);
  await page.getByTestId("model-select").click();
  await menu.getByRole("menuitem", { name: "View more" }).click();
  // Refused: View more goes, and focus stays in the menu.
  await expect(menu.getByRole("menuitem", { name: "View more" })).toHaveCount(0);
  await expect(menu.locator(".menu-item:focus")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.getByTestId("model-select").click();
  await expect(menu.getByRole("menuitemradio")).toHaveCount(3);
  await expect(menu.getByRole("menuitem")).toHaveText([/^Refresh/, /^Use another model…/]);
  await page.keyboard.press("Escape");

  await newBotOnWork(page, `${ADMIN}&catalog=big`);
  await page.getByTestId("model-select").click();
  await menu.getByRole("menuitem", { name: "View more" }).click();
  await expect(menu.getByRole("menuitem", { name: "1,024 of 1,500 shown" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("Escape");

  // A picker cut at its bound says the same.
  await newBotOnWork(page, `${ADMIN}&catalog=pickercut`);
  await page.getByTestId("model-select").click();
  await expect(menu.getByRole("menuitem", { name: "3 of 140 shown" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("F-478: View more opened for one provider starts closed for the next, and reads that provider's list", async ({
  page,
}) => {
  await newBotOnWork(page, ADMIN);
  const select = page.getByTestId("model-select");
  const menu = page.getByRole("menu", { name: "Model" });
  await select.click();
  await menu.getByRole("menuitem", { name: "View more" }).click();
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("radio", { name: /^xAI · Personal/ }).click();
  await select.click();
  const more = menu.getByRole("menuitem", { name: "View more" });
  await expect(more).not.toHaveAttribute("aria-disabled", "true");
  await more.click();
  await expect(menu.getByText("The gateway lists no more models for xAI.")).toBeVisible();
  await page.keyboard.press("Escape");
  // Back on OpenAI, whose list is still kept: View more starts closed, and opens on that list
  // (the engine reads a list it has again only on a retry).
  await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
  await select.click();
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "View more" }).click();
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true })).toBeVisible();
  expect(
    (await sent(page))
      .filter((each) => each.type === "loadModelCatalog")
      .map((each) => each.provider),
  ).toEqual(["openai", "xai", "openai"]);
});

for (const [where, open] of [
  ["New bot", (page: Page) => newBotOnWork(page, `${ADMIN}&catalog=slow`)],
  [
    "Settings",
    (page: Page) => openFixture(page, `${ADMIN}&panel=open&tab=settings&catalog=slow`, "light"),
  ],
] as const)
  test(`F-478: focus never leaves the Model menu while View more's answer replaces its row, in ${where}`, async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId("model-select").click();
    const menu = page.getByRole("menu", { name: "Model" });
    await menu.getByRole("menuitem", { name: "View more" }).click();
    // Where focus is at the moment the answer's rows are in the page, before anything later runs:
    // a key pressed then (Escape) must reach the menu.
    await page.evaluate(() => {
      const probe = window as unknown as { focusWhenShown?: string };
      const seen = new MutationObserver(() => {
        const menu = document.querySelector('[role="menu"]');
        if (!menu?.querySelector('[role="menuitemradio"][aria-label="gpt-5.4"]')) return;
        seen.disconnect();
        probe.focusWhenShown = menu.contains(document.activeElement) ? "menu" : "outside";
      });
      seen.observe(document.body, { childList: true, subtree: true });
    });
    await releaseCatalog(page);
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { focusWhenShown?: string }).focusWhenShown),
      )
      .toBe("menu");
    // And Escape closes the menu alone.
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId("model-select")).toBeFocused();
  });

test("F-478: a menu that lost focus to the page never takes it back from the control Tab moved to", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&panel=open&tab=settings`, "light");
  await page.getByTestId("model-select").click();
  const menu = page.getByRole("menu", { name: "Model" });
  await page.keyboard.press("End");
  await expect(menu.locator(".menu-item").last()).toBeFocused();
  // Focus goes from the row to the page with no blur reaching the menu, as when its focused row
  // is removed.
  await page.evaluate(() => {
    window.addEventListener("focusout", (event) => event.stopImmediatePropagation(), {
      capture: true,
      once: true,
    });
    (document.activeElement as HTMLElement).blur();
  });
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
  // Tab moves focus to another control; then the menu's rows change.
  await page.keyboard.press("Tab");
  const moved = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement;
    active.dataset.movedHere = "1";
    return active !== document.body && !active.closest('[role="menu"]');
  });
  expect(moved).toBe(true);
  await change(
    page,
    `return { ...state, accounts: { ...state.accounts, models: state.accounts.models.filter((m) => m.id !== "gpt-5.5-mini") } };`,
  );
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.5-mini" })).toHaveCount(0);
  await expect(page.locator('[data-moved-here="1"]')).toBeFocused();
});

test("F-478: View more's answer belongs to its dialog: closing the dialog drops it, and opening View more again reads again", async ({
  page,
}) => {
  await newBotOnWork(page, ADMIN);
  const select = page.getByTestId("model-select");
  const menu = page.getByRole("menu", { name: "Model" });
  await select.click();
  await menu.getByRole("menuitem", { name: "View more" }).click();
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(newBot(page)).toHaveCount(0);
  // Opened again: nothing is kept from before, and View more reads the list again.
  await page.keyboard.press("ControlOrMeta+n");
  await select.click();
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "View more" }).click();
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true })).toBeVisible();
  expect(
    (await sent(page))
      .filter((each) => each.type === "loadModelCatalog")
      .map((each) => each.provider),
  ).toEqual(["openai", "openai"]);
});

test("F-478: an answer still on its way when the Model page is left is never shown: coming back shows View more closed", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&panel=open&tab=settings&catalog=slow`, "light");
  const select = page.getByTestId("model-select");
  const menu = page.getByRole("menu", { name: "Model" });
  await select.click();
  await menu.getByRole("menuitem", { name: "View more" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Account: / }).click();
  await releaseCatalog(page);
  await page.getByRole("button", { name: "Back to settings" }).click();
  await select.click();
  const more = menu.getByRole("menuitem", { name: "View more" });
  await expect(more).toBeVisible();
  await expect(more).not.toHaveAttribute("aria-disabled", "true");
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true })).toHaveCount(0);
});

for (const [route, away, back] of [
  [
    "the Computer tab",
    (page: Page) => page.getByRole("tab", { name: "Computer" }).click(),
    (page: Page) => page.getByRole("tab", { name: "Settings" }).click(),
  ],
  [
    "Usage",
    (page: Page) => page.getByTestId("usage-row").click(),
    (page: Page) => page.getByRole("button", { name: "Back to settings" }).click(),
  ],
] as const)
  test(`F-478: an answer that lands while ${route} hides Settings' Model pair is never shown there`, async ({
    page,
  }) => {
    await openFixture(page, `${ADMIN}&panel=open&tab=settings&catalog=slow`, "light");
    const select = page.getByTestId("model-select");
    const menu = page.getByRole("menu", { name: "Model" });
    await select.click();
    await menu.getByRole("menuitem", { name: "View more" }).click();
    await page.keyboard.press("Escape");
    await away(page);
    await expect(select).toBeHidden();
    await releaseCatalog(page);
    await back(page);
    await select.click();
    await expect(menu.getByRole("menuitem", { name: "View more" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true })).toHaveCount(0);
  });

test("F-478: an answer asked on one connection is dropped after another, though its address and gateway are the same", async ({
  page,
}) => {
  await newBotOnWork(page, `${ADMIN}&catalog=slow`);
  const select = page.getByTestId("model-select");
  const menu = page.getByRole("menu", { name: "Model" });
  await select.click();
  await menu.getByRole("menuitem", { name: "View more" }).click();
  await page.keyboard.press("Escape");
  // A new connection to the same address and gateway: another target, connected again.
  await change(
    page,
    `return { ...state, connection: { ...state.connection, target: state.connection.target + 1, connectedAt: (state.connection.connectedAt ?? 0) + 1 } };`,
  );
  await releaseCatalog(page);
  await select.click();
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "View more" })).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("F-478: an answer that arrives after the provider or the gateway changed is dropped", async ({
  page,
}) => {
  await newBotOnWork(page, `${ADMIN}&catalog=slow`);
  const select = page.getByTestId("model-select");
  const menu = page.getByRole("menu", { name: "Model" });
  await select.click();
  await menu.getByRole("menuitem", { name: "View more" }).click();
  await page.keyboard.press("Escape");
  // OpenAI's list is out; another provider's account is chosen before it arrives.
  await page.getByRole("radio", { name: /^xAI · Personal/ }).click();
  await releaseCatalog(page);
  await select.click();
  await expect(menu.getByRole("menuitem", { name: "View more" })).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // Back on OpenAI, a new read is out when the gateway changes: its answer is not shown.
  await page.getByRole("radio", { name: /^OpenAI · Work/ }).click();
  await select.click();
  await menu.getByRole("menuitem", { name: "View more" }).click();
  await page.keyboard.press("Escape");
  await change(
    page,
    `return { ...state, connection: { ...state.connection, gatewayId: "another-gateway" } };`,
  );
  await releaseCatalog(page);
  await select.click();
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "View more" })).toBeVisible();
});

test("F-478: a full list the gateway hasn't finished says it may not be complete, and Check again reads it again", async ({
  page,
}) => {
  await newBotOnWork(page, `${ADMIN}&catalog=partial`);
  await page.getByTestId("model-select").click();
  const menu = page.getByRole("menu", { name: "Model" });
  await menu.getByRole("menuitem", { name: "View more" }).click();
  await expect(
    menu.getByText(
      "The gateway is still listing OpenAI's models, so this list may not be complete.",
    ),
  ).toBeVisible();
  await expect(menu.getByText(/lists no more models/)).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Check again" }).click();
  await expect(menu.getByText(/^Also listed for OpenAI\./)).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Check again" })).toHaveCount(0);
});

test("F-478: a full list cut short never says there are no more models: it says how many weren't shown", async ({
  page,
}) => {
  await newBotOnWork(page, `${ADMIN}&catalog=trimmed`);
  await page.getByTestId("model-select").click();
  const menu = page.getByRole("menu", { name: "Model" });
  await menu.getByRole("menuitem", { name: "View more" }).click();
  await expect(
    menu.getByText("The gateway lists 70 more of OpenAI's models that can't be shown here."),
  ).toBeVisible();
  await expect(menu.getByText(/lists no more models/)).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "3 of 73 shown" })).toBeVisible();
});

for (const size of [WIDE, PHONE])
  test(`F-478: the Model menu stays inside New bot's dialog at ${size.name}, and scrolls`, async ({
    browser,
  }) => {
    const context = await browser.newContext(contextFor(size, "light"));
    const page = await context.newPage();
    await newBotOnWork(page, ADMIN);
    await page.getByTestId("model-select").click();
    const menu = page.getByRole("menu", { name: "Model" });
    await menu.getByRole("menuitem", { name: "View more" }).click();
    await expect(menu.getByRole("menuitemradio", { name: "gpt-5.5-pro" })).toBeAttached();
    const dialog = (await newBot(page).boundingBox())!;
    const box = (await menu.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(dialog.y);
    expect(box.y + box.height).toBeLessThanOrEqual(dialog.y + dialog.height);
    expect(box.x + box.width).toBeLessThanOrEqual(dialog.x + dialog.width);
    // Every row is reachable by scrolling the menu.
    await menu.getByRole("menuitemradio", { name: "gpt-5.5-pro" }).scrollIntoViewIfNeeded();
    await expect(menu.getByRole("menuitemradio", { name: "gpt-5.5-pro" })).toBeInViewport();
    await context.close();
  });

test("F-478: a bot's model neither list has keeps a checked row at the top, whatever arrives", async ({
  page,
}) => {
  await openFixture(
    page,
    `${ADMIN}&panel=open&tab=settings&model=gpt-9-preview&catalog=fail`,
    "light",
  );
  const select = page.getByTestId("model-select");
  await expect(select).toHaveAccessibleName("Model: gpt-9-preview");
  // No row has it, so no level is known for it.
  await expect(page.getByTestId("effort-select")).toHaveAccessibleName("Effort: Not offered");
  await select.click();
  const menu = page.getByRole("menu", { name: "Model" });
  const pinned = menu.getByRole("menuitemradio", { name: "gpt-9-preview" });
  await expect(pinned).toHaveAttribute("aria-checked", "true");
  expect((await menuRows(page))[0]![0]).toBe("gpt-9-preview");
  // The full list fails, then arrives without it: the row stays, checked, once.
  await menu.getByRole("menuitem", { name: "View more" }).click();
  await expect(menu.getByText("Couldn't load more models.")).toBeVisible();
  await expect(pinned).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitem", { name: "Try again" }).click();
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: "gpt-9-preview" })).toHaveCount(1);
  await expect(pinned).toHaveAttribute("aria-checked", "true");
  await expect(select).toHaveAccessibleName("Model: gpt-9-preview");
});

test("F-478: a model only the full list has is checked in its section, never pinned twice, when the list arrives first", async ({
  page,
}) => {
  await openFixture(
    page,
    `${ADMIN}&panel=open&tab=settings&model=gpt-5.4&catalog=latepicker`,
    "light",
  );
  const select = page.getByTestId("model-select");
  await select.click();
  const menu = page.getByRole("menu", { name: "Model" });
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await menu.getByRole("menuitem", { name: "View more" }).click();
  await expect(menu.getByText(/^Also listed for OpenAI\./)).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true })).toHaveCount(1);
  // Then the picker arrives: still one checked row.
  await page.evaluate(() => (window as unknown as { releasePicker: () => void }).releasePicker());
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.5", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true })).toHaveCount(1);
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(select).toHaveAccessibleName("Model: gpt-5.4");
  // Effort from the row the full list carries.
  await expect(page.getByTestId("effort-select")).toBeEnabled();
});

test("F-478: a model chosen from View more stays when the bot moves to another account of its provider", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&panel=open&tab=settings`, "light");
  await page.getByTestId("model-select").click();
  const menu = page.getByRole("menu", { name: "Model" });
  await menu.getByRole("menuitem", { name: "View more" }).click();
  await menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true }).click();
  await expect(page.getByTestId("model-select")).toHaveAccessibleName("Model: gpt-5.4");
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
  await expect(page.getByTestId("model-select")).toHaveCount(0);
  await page.getByRole("button", { name: "Save" }).click();
  expect((await sent(page)).find((each) => each.type === "changeBotAccount")).toMatchObject({
    account: "openai:home",
    model: "gpt-5.4",
  });
});

test("F-478: a late list for the other provider never replaces the model the person chose there", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&panel=open&tab=settings&catalog=slow`, "light");
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await page.getByRole("radio", { name: /^xAI · Personal/ }).click();
  const select = page.getByTestId("model-select");
  await select.click();
  const menu = page.getByRole("menu", { name: "Model" });
  await menu.getByRole("menuitem", { name: "View more" }).click();
  await menu.getByRole("menuitemradio", { name: "grok-4.7" }).click();
  // xAI's full list arrives late, and it lists Otto's OpenAI model too.
  await releaseCatalog(page);
  await select.click();
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.5", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(select).toHaveAccessibleName("Model: grok-4.7");
  await page.getByRole("button", { name: "Save" }).click();
  expect((await sent(page)).find((each) => each.type === "changeBotAccount")).toMatchObject({
    account: "xai:personal",
    provider: "xai",
    model: "grok-4.7",
  });
});

test("F-034 F-478: an account chosen before its models arrive gets the menu's first model when they do, and Create is enabled", async ({
  page,
}) => {
  await newBotOnWork(page, `${ADMIN}&catalog=latepicker`);
  await expect(page.getByTestId("model-select")).toHaveAccessibleName("Model: Choose");
  await expect(page.getByTestId("create")).toBeDisabled();
  await page.evaluate(() => (window as unknown as { releasePicker: () => void }).releasePicker());
  await expect(page.getByTestId("model-select")).toHaveAccessibleName("Model: gpt-5.5");
  await expect(page.getByTestId("effort-select")).toHaveAccessibleName("Effort: Medium");
  await expect(page.getByTestId("create")).toBeEnabled();
});

/** Type a model id through "Use another model…". */
async function typeModel(page: Page, id: string) {
  await page.getByTestId("model-select").click();
  await page.getByRole("menuitem", { name: "Use another model…" }).click();
  await page.getByRole("textbox", { name: "Model id" }).fill(id);
  await page.getByRole("button", { name: "Use", exact: true }).click();
}

test("F-533: New bot takes a model id typed in, says only that it was typed in, and creates the bot on it", async ({
  page,
}) => {
  await newBotOnWork(page, ADMIN);
  const select = page.getByTestId("model-select");
  await select.click();
  const menu = page.getByRole("menu", { name: "Model" });
  const other = menu.getByRole("menuitem", { name: "Use another model…" });
  await expect(other).toHaveAccessibleDescription("Type its id");
  await other.click();
  await expect(menu).toHaveCount(0);
  const field = page.getByRole("textbox", { name: "Model id" });
  await expect(field).toBeFocused();
  // Nothing typed, and an account named with @, are refused where they are typed.
  await page.getByRole("button", { name: "Use", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Type a model id.");
  await field.fill("gpt-9@openai:work");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toHaveText("A model id has no spaces and no @.");
  // Escape leaves the field alone, not the dialog.
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(newBot(page)).toBeVisible();
  await expect(select).toBeFocused();
  await expect(select).toHaveAccessibleName("Model: gpt-5.5");
  // The provider's own prefix is dropped.
  await typeModel(page, "openai/gpt-9-preview");
  await expect(select).toHaveAccessibleName("Model: gpt-9-preview");
  await expect(select).toBeFocused();
  await expect(page.getByTestId("model-typed-line")).toHaveText("gpt-9-preview was typed in.");
  await expect(page.getByTestId("effort-select")).toHaveAccessibleName("Effort: Not offered");
  // It has a checked row of its own.
  await select.click();
  await expect(menu.getByRole("menuitemradio", { name: "gpt-9-preview" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");
  expect(await page.getByTestId("new-bot").innerText()).not.toMatch(
    /isn't in|doesn't offer|not in the gateway|isn't available/i,
  );
  await page.getByTestId("create").click();
  expect((await sent(page)).find((each) => each.type === "createBot")).toMatchObject({
    account: "openai:work",
    provider: "openai",
    model: "gpt-9-preview",
    effort: null,
  });
});

test("F-533: a typed id the menu lists is that row: usable rows are chosen, a row the picker disables is refused", async ({
  page,
}) => {
  await newBotOnWork(page, ADMIN);
  const select = page.getByTestId("model-select");
  // A usable picker row: chosen as that row, with its levels and no typed-in line.
  await typeModel(page, "gpt-5.5-mini");
  await expect(select).toHaveAccessibleName("Model: gpt-5.5-mini");
  await expect(page.getByTestId("effort-select")).toHaveAccessibleName("Effort: Medium");
  await expect(page.getByTestId("model-typed-line")).toHaveCount(0);
  // A row the picker disables: refused with the picker's own words, the field stays open.
  await typeModel(page, "gpt-5.5-codex");
  await expect(page.getByRole("alert")).toHaveText("Not available");
  await expect(page.getByRole("textbox", { name: "Model id" })).toBeVisible();
  await expect(select).toHaveAccessibleName("Model: gpt-5.5-mini");
  await page.getByRole("button", { name: "Cancel" }).click();
  // A row of "View more", once it is read: chosen as that row, marked or not.
  await select.click();
  await page
    .getByRole("menu", { name: "Model" })
    .getByRole("menuitem", { name: "View more" })
    .click();
  await expect(page.getByRole("menuitemradio", { name: "gpt-5.5-pro" })).toBeVisible();
  await page
    .getByRole("menu", { name: "Model" })
    .getByRole("menuitem", { name: "Use another model…" })
    .click();
  await page.getByRole("textbox", { name: "Model id" }).fill("gpt-5.5-pro");
  await page.getByRole("button", { name: "Use", exact: true }).click();
  await expect(select).toHaveAccessibleName("Model: gpt-5.5-pro");
  await expect(page.getByTestId("effort-select")).toHaveAccessibleName("Effort: Medium");
  await expect(page.getByTestId("model-typed-line")).toHaveCount(0);
});

test("F-533: a bot's Settings saves a typed model id, says no level is known for it, and keeps it across an account change", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&panel=open&tab=settings`, "light");
  await typeModel(page, "gpt-9-preview");
  await expect
    .poll(async () => (await sent(page)).find((each) => each.type === "setBotModel"))
    .toMatchObject({ botId: "otto", model: "gpt-9-preview", effort: null });
  await expect(page.getByTestId("model-select")).toHaveAccessibleName("Model: gpt-9-preview");
  // No row has it: no level is known, whatever the gateway keeps, and none was sent.
  await expect(page.getByTestId("effort-select")).toHaveAccessibleName("Effort: Not offered");
  await expect(page.getByTestId("effort-select")).toBeDisabled();
  await expect(page.getByTestId("model-typed-line")).toBeVisible();
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
  await expect(page.getByTestId("model-select")).toHaveCount(0);
  await page.getByRole("button", { name: "Save" }).click();
  expect((await sent(page)).find((each) => each.type === "changeBotAccount")).toMatchObject({
    account: "openai:home",
    model: "gpt-9-preview",
  });
});

test("F-533: a model typed in before a list has it takes that row's effort once it does, and Create sends what Effort shows", async ({
  page,
}) => {
  await newBotOnWork(page, ADMIN);
  await typeModel(page, "gpt-5.4");
  const effort = page.getByTestId("effort-select");
  await expect(effort).toHaveAccessibleName("Effort: Not offered");
  // View more's list has gpt-5.4, with its levels: Effort shows one, and Create sends it.
  await page.getByTestId("model-select").click();
  const menu = page.getByRole("menu", { name: "Model" });
  await menu.getByRole("menuitem", { name: "View more" }).click();
  await expect(menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(effort).toHaveAccessibleName("Effort: Medium");
  await expect(page.getByTestId("model-typed-line")).toHaveCount(0);
  await page.getByTestId("create").click();
  expect((await sent(page)).find((each) => each.type === "createBot")).toMatchObject({
    model: "gpt-5.4",
    effort: "medium",
  });
});

test("F-533: in Settings, a bot that keeps no effort on a model only a later list has shows that row's effort, the one saved", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&panel=open&tab=settings&model=gpt-5.4&effort=none`, "light");
  const effort = page.getByTestId("effort-select");
  await expect(effort).toHaveAccessibleName("Effort: Not offered");
  await page.getByTestId("model-select").click();
  const menu = page.getByRole("menu", { name: "Model" });
  await menu.getByRole("menuitem", { name: "View more" }).click();
  await menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  // The row's own level, though the bot keeps none.
  await expect(effort).toHaveAccessibleName("Effort: Medium");
  // Choosing that row again saves the effort Effort shows.
  await page.getByTestId("model-select").click();
  await menu.getByRole("menuitemradio", { name: "gpt-5.4", exact: true }).click();
  await expect
    .poll(async () => (await sent(page)).filter((each) => each.type === "setBotModel").at(-1))
    .toMatchObject({ model: "gpt-5.4", effort: "medium" });
});

test("F-533: what was typed for one provider goes when another provider's account is chosen", async ({
  page,
}) => {
  await newBotOnWork(page, ADMIN);
  await page.getByTestId("model-select").click();
  await page.getByRole("menuitem", { name: "Use another model…" }).click();
  const field = page.getByRole("textbox", { name: "Model id" });
  await field.fill("gpt 9");
  await page.getByRole("button", { name: "Use", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("A model id has no spaces and no @.");
  await field.fill("gpt-9-preview");
  // Another provider's account, with the field still open: the field, its text and its error go.
  await page.getByRole("radio", { name: /^xAI · Personal/ }).click();
  await expect(field).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByTestId("model-select")).toHaveAccessibleName("Model: grok-4.7");
  await page.getByTestId("model-select").click();
  await page.getByRole("menuitem", { name: "Use another model…" }).click();
  await expect(field).toHaveValue("");
  await page.getByRole("button", { name: "Cancel" }).click();
  // A note for an id typed under one provider goes too.
  await page.getByRole("radio", { name: /^OpenAI · Work/ }).click();
  await typeModel(page, "gpt-9-preview");
  await expect(page.getByTestId("model-typed-line")).toBeVisible();
  await page.getByRole("radio", { name: /^xAI · Personal/ }).click();
  await expect(page.getByTestId("model-typed-line")).toHaveCount(0);
  await page.getByTestId("create").click();
  expect((await sent(page)).find((each) => each.type === "createBot")).toMatchObject({
    provider: "xai",
    model: "grok-4.7",
  });
});

test("F-533: Change account saves the effort it shows for a typed model another list has", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&panel=open&tab=settings&catalog=xaimore`, "light");
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await page.getByRole("radio", { name: /^xAI · Personal/ }).click();
  await typeModel(page, "grok-4.8");
  const effort = page.getByTestId("effort-select");
  await expect(effort).toHaveAccessibleName("Effort: Not offered");
  await page.getByTestId("model-select").click();
  const menu = page.getByRole("menu", { name: "Model" });
  await menu.getByRole("menuitem", { name: "View more" }).click();
  await expect(menu.getByRole("menuitemradio", { name: "grok-4.8" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(effort).toHaveAccessibleName("Effort: Medium");
  await page.getByRole("button", { name: "Save" }).click();
  expect((await sent(page)).find((each) => each.type === "changeBotAccount")).toMatchObject({
    provider: "xai",
    model: "grok-4.8",
    effort: "medium",
  });
});

test("F-533: Change account sends the effort it shows, never a level chosen for a row that has gone", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&panel=open&tab=settings&catalog=xaimore`, "light");
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await page.getByRole("radio", { name: /^xAI · Personal/ }).click();
  const select = page.getByTestId("model-select");
  const menu = page.getByRole("menu", { name: "Model" });
  await select.click();
  await menu.getByRole("menuitem", { name: "View more" }).click();
  await menu.getByRole("menuitemradio", { name: "grok-4.8" }).click();
  const effort = page.getByTestId("effort-select");
  await effort.click();
  await page.getByRole("menuitemradio", { name: "High" }).click();
  await expect(effort).toHaveAccessibleName("Effort: High");
  // A reconnect drops the dialog's list, and with it grok-4.8's row: no level is known now.
  await change(
    page,
    `return { ...state, connection: { ...state.connection, status: "reconnecting" } };`,
  );
  await change(
    page,
    `return { ...state, connection: { ...state.connection, status: "connected" } };`,
  );
  await expect(select).toHaveAccessibleName("Model: grok-4.8");
  await expect(effort).toHaveAccessibleName("Effort: Not offered");
  await page.getByRole("button", { name: "Save" }).click();
  expect((await sent(page)).find((each) => each.type === "changeBotAccount")).toMatchObject({
    model: "grok-4.8",
    effort: null,
  });
});

test("F-533: an id the bridge would refuse is refused where it is typed, and nothing is sent", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&panel=open&tab=settings`, "light");
  await page.getByTestId("model-select").click();
  await page.getByRole("menuitem", { name: "Use another model…" }).click();
  const field = page.getByRole("textbox", { name: "Model id" });
  await field.fill("gpt\u007f9");
  await page.getByRole("button", { name: "Use", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("A model id can't hold control characters.");
  await expect(field).toBeVisible();
  expect((await sent(page)).filter((each) => each.type === "setBotModel")).toEqual([]);
});

test("F-534: when the gateway reports a newer OpenClaw, New bot and Settings say so under the model, with a link to Settings › Updates and no command", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&openclaw=behind`, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Work/ }).click();
  const note = page.getByTestId("openclaw-update");
  await expect(note).toContainText(
    "Your gateway runs OpenClaw 2026.10.6, and 2026.11.6 is out. Updating the gateway is how newer models get listed.",
  );
  // The update is made in Settings › Updates; the note links there.
  await expect(note.getByRole("button", { name: "Settings › Updates" })).toBeVisible();
  // No command: the step differs by install, a container's included.
  await expect(note.getByTestId("command")).toHaveCount(0);
  await expect(note).not.toContainText("openclaw update");
  await page.keyboard.press("Escape");
  await openFixture(page, `${ADMIN}&openclaw=behind&panel=open&tab=settings`, "light");
  await expect(page.getByTestId("openclaw-update")).toBeVisible();
  // A beta is named as one, never as a stable release.
  await openFixture(page, `${ADMIN}&openclaw=beta&panel=open&tab=settings`, "light");
  await expect(page.getByTestId("openclaw-update")).toContainText(
    "Your gateway runs OpenClaw 2026.10.6, and 2026.11.10-beta.1 is out on its beta channel, not as a stable release. Updating the gateway is how newer models get listed.",
  );
  // Without the gateway's report, nothing is said.
  await openFixture(page, `${ADMIN}&panel=open&tab=settings`, "light");
  await expect(page.getByTestId("model-select")).toBeVisible();
  await expect(page.getByTestId("openclaw-update")).toHaveCount(0);
});

/** New bot, connecting an account, on the sign-in methods. */
async function connectFromNewBot(page: Page) {
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Connect another account" }).click();
}

test("F-474: a sign-in whose read afterwards failed says so, and Check again reads it", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&signin=unverified`, "light");
  await connectFromNewBot(page);
  await newBot(page)
    .getByRole("button", { name: /^xAI\b/ })
    .click();
  await expect(page.getByRole("heading", { name: "Signed in, not confirmed" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Connected to/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("heading", { name: "Connected to xAI" })).toBeVisible();
  expect((await sent(page)).some((each) => each.type === "recheckSignIn")).toBe(true);
});

test("F-474: a cancel the gateway did not confirm stays on screen and says so; Back does not let it go", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&signin=cancel-unknown`, "light");
  await connectFromNewBot(page);
  await newBot(page)
    .getByRole("button", { name: /^xAI\b/ })
    .click();
  await expect(page.getByTestId("cancel-unknown")).toContainText(
    "Clawtrate couldn't tell whether the gateway cancelled the sign-in",
  );
  await page.getByRole("button", { name: "Back to sign-in methods" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to xAI", level: 2 })).toBeVisible();
  await expect(page.getByText("Sign-in cancelled")).toHaveCount(0);
});

test("F-474: where the gateway keeps sign-ins per bot, a bot connects an account from its own Change account page", async ({
  page,
}) => {
  await openFixture(page, `${SETTINGS_TAB}&lock=bound&kept=1&signin=connected`, "light");
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  const connect = page.getByRole("button", { name: /^Connect an account/ });
  await expect(connect).toContainText("A sign-in here is kept for Otto.");
  await connect.click();
  await expect(page.getByTestId("kept-note")).toContainText(
    "This gateway keeps this sign-in for Otto only.",
  );
  await page.getByRole("button", { name: /^xAI\b/ }).click();
  await expect(page.getByRole("heading", { name: "Connected to xAI" })).toBeVisible();
  await expect(page.getByTestId("landed")).toHaveText(
    "Saved for Otto only. Other bots can't use it.",
  );
  const start = (await sent(page)).find((each) => each.type === "startSignIn");
  expect(start).toMatchObject({ botId: "otto" });
  await page.getByRole("textbox", { name: "Label" }).fill("Side");
  await page.getByRole("button", { name: "Done" }).click();
  // Back on the choice, with the new account chosen, kept by Otto.
  await expect(page.getByRole("heading", { name: "Change account", level: 3 })).toBeVisible();
  await expect(
    page.getByRole("radio", { name: /^xAI · Side, Subscription, Only Otto can use it/ }),
  ).toHaveAttribute("aria-checked", "true");
});

test("F-034: a bot written whose first task did not land is said to exist, unfinished; Finish completes it by its id and opens it", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&create=partial`, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill("Viral");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
  await page.getByTestId("create").click();
  const note = page.getByTestId("create-partial");
  await expect(note).toContainText(
    "Viral exists, and isn't finished. Viral was created, but its first task was not made",
  );
  // It is not offered as something to create again.
  await expect(page.getByTestId("create")).toBeDisabled();
  await note.getByRole("button", { name: "Finish Viral" }).click();
  await expect(newBot(page)).toHaveCount(0);
  const types = (await sent(page)).map((each) => each.type);
  expect(types.filter((type) => type === "createBot")).toHaveLength(1);
  expect(types).toContain("finishBot");
  await expect(
    page.getByTestId("bot-list").getByRole("button", { name: /^Viral\b/ }),
  ).toBeVisible();
});

test("F-520: a bot whose first-run questions were not turned off is not offered to open as it is, only to finish", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&create=partial-identity`, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill("Viral");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
  await page.getByTestId("create").click();
  const note = page.getByTestId("create-partial");
  await expect(note).toContainText(
    "Viral exists, and isn't finished. Viral was created, but OpenClaw's first-run questions were not turned off",
  );
  await expect(note.getByRole("button", { name: "Finish Viral" })).toBeVisible();
  await expect(note.getByRole("button", { name: "Open Viral as it is" })).toHaveCount(0);
  // Finish is what turns them off, and it completes the bot by its id.
  await note.getByRole("button", { name: "Finish Viral" }).click();
  await expect(newBot(page)).toHaveCount(0);
  const types = (await sent(page)).map((each) => each.type);
  expect(types.filter((type) => type === "createBot")).toHaveLength(1);
  expect(types.indexOf("finishBot")).toBeGreaterThan(types.indexOf("createBot"));
});

test("F-476: on admin two unlabelled accounts of one provider read differently, by their ids, in New bot and Settings", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&labels=none`, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  const group = page.getByRole("radiogroup", { name: "Accounts" });
  const work = group.getByRole("radio", { name: /^OpenAI openai:work, / });
  const home = group.getByRole("radio", { name: /^OpenAI openai:home, / });
  await expect(work).toContainText("openai:work");
  await expect(home).toContainText("openai:home");
  await expect(page.getByTestId("unlabelled-hint")).toContainText("named by its id");
  const titles = await group.locator(".b-choice-title").allInnerTexts();
  expect(new Set(titles).size).toBe(titles.length);
  await page.keyboard.press("Escape");
  // Settings → Accounts: the rows read differently too, and each offers a label.
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  const rows = await settings.locator(".b-choice-title").allInnerTexts();
  expect(new Set(rows).size).toBe(rows.length);
  await settings.getByRole("button", { name: "Add a label to OpenAI openai:home" }).click();
  const field = settings.getByRole("textbox", { name: "Label" });
  await expect(field).toBeFocused();
  await field.fill("Home");
  await field.press("Enter");
  await expect(settings.getByRole("heading", { name: "OpenAI · Home", level: 3 })).toBeVisible();
});

test("F-476: two accounts that share a label, whatever its case, are told apart by their ids", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&labels=same`, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  const group = page.getByRole("radiogroup", { name: "Accounts" });
  await expect(group.getByRole("radio", { name: /^OpenAI · Work openai:work, / })).toBeVisible();
  await expect(group.getByRole("radio", { name: /^OpenAI · work openai:home, / })).toBeVisible();
  // xAI's label is its own: no id.
  await expect(group.getByRole("radio", { name: /^xAI · Personal, / })).toBeVisible();
});

test("F-474: a key the gateway refused is tried again where a key is typed, for the same provider", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&keyfails=1`, "light");
  await connectFromNewBot(page);
  await newBot(page).getByText("Use an API key instead").click();
  await newBot(page).getByRole("combobox", { name: "Provider" }).selectOption("xai");
  await page.getByTestId("api-key").fill("made-up-key-for-a-check");
  await newBot(page).getByRole("button", { name: "Save key" }).click();
  await expect(newBot(page).getByRole("heading", { name: "Couldn't connect" })).toBeVisible();
  await newBot(page).getByRole("button", { name: "Try again" }).click();
  // Back where a key is typed: the disclosure open, xAI chosen, the field empty and focused.
  await expect(newBot(page).locator("details.b-disclosure")).toHaveAttribute("open", "");
  await expect(newBot(page).getByRole("combobox", { name: "Provider" })).toHaveValue("xai");
  await expect(page.getByTestId("api-key")).toBeFocused();
  await expect(page.getByTestId("api-key")).toHaveValue("");
  expect((await sent(page)).filter((each) => each.type === "startSignIn")).toEqual([]);
});

test.describe("phone, a key", () => {
  test.use(contextFor(PHONE, "light"));
  test("F-474: on a phone, opening the API key path brings its fields into view", async ({
    page,
  }) => {
    await openFixture(page, ADMIN, "light");
    await connectFromNewBot(page);
    await newBot(page).getByText("Use an API key instead").click();
    await expect(page.getByTestId("api-key")).toBeInViewport();
  });
});

test("F-476: a label step closed before Done comes back, in New bot and in Settings → Accounts, until Done", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&signin=connected`, "light");
  await connectFromNewBot(page);
  await newBot(page)
    .getByRole("button", { name: /^xAI\b/ })
    .click();
  await expect(page.getByRole("heading", { name: "Connected to xAI" })).toBeVisible();
  // Closed before Done: New bot opens on the label step again.
  await page.keyboard.press("Escape");
  await expect(newBot(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByRole("heading", { name: "Connected to xAI" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Label" })).toBeVisible();
  await page.keyboard.press("Escape");
  // Settings → Accounts opens on it too.
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Connected to xAI" })).toBeVisible();
  await settings.getByRole("textbox", { name: "Label" }).fill("Travel");
  await settings.getByRole("button", { name: "Done" }).click();
  await expect(settings.getByRole("heading", { name: "Accounts", level: 3 })).toBeVisible();
  // Done lets it go: Settings opens on the list.
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+,");
  await expect(settings.getByRole("heading", { name: "Accounts", level: 3 })).toBeVisible();
});

test("F-490: every place that names a lock words it from its evidence: Used by, Change account and the sign-in's result", async ({
  page,
}) => {
  await openFixture(page, `${SETTINGS_TAB}&lock=failed`, "light");
  // Change account: a lock last confirmed before a failed read is spoken of in the past, with its time.
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
  await expect(page.getByTestId("locked-change-note")).toContainText(
    /^Otto was locked to OpenAI · Work when Clawtrate last checked, at \d+:\d\d [AP]M\. If it still is, after saving/,
  );
  await expect(page.getByText(/Otto is locked to/)).toHaveCount(0);
  // Settings → Accounts: Used by gives the same lock with its time.
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  await settings.getByRole("button", { name: /^OpenAI · Work,/ }).click();
  await expect(settings.getByTestId("account-facts")).toContainText(
    /Otto \(locked as of \d+:\d\d [AP]M\)/,
  );
  await expect(settings.getByTestId("account-facts")).not.toContainText("Otto (locked)");
});

test("F-474 F-490: a sign-in's result says a lock widened only from a read that shows it, and says when it couldn't check", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&signin=connected`, "light");
  await connectFromNewBot(page);
  await newBot(page)
    .getByRole("button", { name: /^xAI\b/ })
    .click();
  await expect(page.getByRole("heading", { name: "Connected to xAI" })).toBeVisible();
  await change(
    page,
    `return { ...state, accounts: { ...state.accounts, signIn: { ...state.accounts.signIn, result: { ...state.accounts.signIn.result, locks: [{ botId: "otto", account: "openai:work", outcome: "unchecked" }] } } } };`,
  );
  await expect(page.getByTestId("lock-unchecked")).toHaveText(
    "Clawtrate couldn't check Otto's lock after this sign-in, so it can't say whether the sign-in changed it. Otto's Account page checks it again.",
  );
  await expect(page.getByText(/added the new account to Otto's lock/)).toHaveCount(0);
});

test("F-474: a key saved directly is called saved only when the read after it shows the account; Check again reads it", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&keyread=fail`, "light");
  await connectFromNewBot(page);
  await newBot(page).getByText("Use an API key instead").click();
  await newBot(page).getByRole("combobox", { name: "Provider" }).selectOption("openai");
  await page.getByTestId("api-key").fill("made-up-key-for-a-check");
  await newBot(page).getByRole("button", { name: "Save key" }).click();
  await expect(
    newBot(page).getByRole("heading", { name: "Key sent, not confirmed" }),
  ).toBeVisible();
  await expect(newBot(page).getByRole("heading", { name: "Key saved" })).toHaveCount(0);
  await expect(newBot(page).getByRole("textbox", { name: "Label" })).toHaveCount(0);
  await newBot(page).getByRole("button", { name: "Check again" }).click();
  await newBot(page).getByRole("button", { name: "Continue" }).click();
  await expect(newBot(page).getByRole("heading", { name: "Key saved" })).toBeVisible();
  await expect(newBot(page).getByRole("textbox", { name: "Label" })).toBeVisible();
});

test("F-474: when two new accounts appear during a sign-in, the person chooses which is theirs before it is labelled", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&signin=several`, "light");
  await connectFromNewBot(page);
  await newBot(page)
    .getByRole("button", { name: /^xAI\b/ })
    .click();
  const several = newBot(page).getByTestId("several");
  await expect(several.getByRole("button")).toHaveCount(2);
  await expect(newBot(page).getByRole("textbox", { name: "Label" })).toHaveCount(0);
  await expect(
    newBot(page).getByText(/2 new xAI accounts appeared while this sign-in ran/),
  ).toBeVisible();
  await several
    .getByRole("button", { name: /^xAI xai:second: this is the account I signed in to$/ })
    .click();
  await expect(newBot(page).getByRole("heading", { name: "Connected to xAI" })).toBeVisible();
  await expect(
    newBot(page).getByText("You have another xAI account", { exact: false }),
  ).toBeVisible();
  expect((await sent(page)).filter((each) => each.type === "chooseSignInAccount")).toEqual([
    { type: "chooseSignInAccount", profileId: "xai:second" },
  ]);
});

/** Gives OpenAI's two accounts these labels. */
const labelsOf = (page: Page, home: string, work: string) =>
  change(
    page,
    `return { ...state, accounts: { ...state.accounts, accounts: state.accounts.accounts.map((a) => a.id === "openai:home" ? { ...a, label: ${JSON.stringify(home)} } : a.id === "openai:work" ? { ...a, label: ${JSON.stringify(work)} } : a) } };`,
  );

/** Each OpenAI id in the Account step: its own line, wholly inside its title. */
const idsShown = (page: Page) =>
  newBot(page)
    .locator('[data-value^="openai:"] .b-choice-id')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const id = node.getBoundingClientRect();
        const title = node.closest(".b-choice-title")!.getBoundingClientRect();
        return {
          text: node.textContent,
          inside: id.left >= title.left - 0.5 && id.right <= title.right + 0.5,
        };
      }),
    );

for (const size of [WIDE, PHONE]) {
  test.describe(`names at ${size.name}`, () => {
    test.use(contextFor(size, "light"));

    test("F-476: labels that read the same, in spaces or case, show each account's id", async ({
      page,
    }) => {
      await openFixture(page, ADMIN, "light");
      await labelsOf(page, "My  plan", "my plan");
      await page.keyboard.press("ControlOrMeta+n");
      await page.getByRole("button", { name: "Next" }).click();
      expect(await idsShown(page)).toEqual([
        { text: "openai:work", inside: true },
        { text: "openai:home", inside: true },
      ]);
      // Settings → Accounts reads them the same way.
      await page.keyboard.press("Escape");
      await page.keyboard.press("ControlOrMeta+,");
      const settings = page.getByRole("dialog", { name: "Settings" });
      if (await settings.getByRole("button", { name: "Accounts", exact: true }).isVisible())
        await settings.getByRole("button", { name: "Accounts", exact: true }).click();
      await expect(
        settings.getByRole("button", { name: /^OpenAI · My plan openai:home, / }),
      ).toBeVisible();
      await expect(
        settings.getByRole("button", { name: /^OpenAI · my plan openai:work, / }),
      ).toBeVisible();
    });

    test("F-476: a long shared label gives way; each id stays whole on its own line", async ({
      page,
    }) => {
      await openFixture(page, ADMIN, "light");
      await labelsOf(page, "W".repeat(32), "W".repeat(32));
      await page.keyboard.press("ControlOrMeta+n");
      await page.getByRole("button", { name: "Next" }).click();
      expect(await idsShown(page)).toEqual([
        { text: "openai:work", inside: true },
        { text: "openai:home", inside: true },
      ]);
    });
  });
}

// Unlock and Clear order with a button (#660, F-592): one confirmation, then the gateway's call,
// and the page shows the state only from the gateway's read after it.
const LOCKED = (more = "") =>
  `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=locked${more}`;

test("F-592: Unlock is a button with admin: one confirmation, Escape keeps everything, then the gateway's read", async ({
  page,
}) => {
  await openFixture(page, LOCKED("&version=2026.11.10"), "light");
  await page.getByRole("button", { name: /^Account: / }).click();
  // No terminal, and no stopped gateway: the steps are gone from this page.
  await expect(page.getByTestId("stopped-steps")).toHaveCount(0);
  await expect(page.locator("details.b-disclosure", { hasText: "Unlock" })).toHaveCount(0);
  const unlock = page.getByRole("button", { name: "Unlock…" });
  await unlock.click();
  const dialog = page.getByRole("alertdialog", { name: "Unlock Otto?" });
  await expect(dialog).toHaveAccessibleDescription(
    "Otto's ordinary runs use OpenAI · Work only. After this, Otto follows the gateway's other orders, and when OpenAI · Work fails the gateway may use another OpenAI account. Locking Otto again needs the gateway stopped and a command on its machine.",
  );
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  // Escape: nothing sent, focus back on Unlock.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(unlock).toBeFocused();
  expect((await sent(page)).filter((each) => each.type === "clearBotOrder")).toEqual([]);
  // Then the press, by keyboard.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Unlock", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  const press = (await sent(page)).filter((each) => each.type === "clearBotOrder");
  expect(press).toMatchObject([
    { botId: "otto", provider: "openai", account: "openai:work", kind: "unlock" },
  ]);
  const outcome = page.getByTestId("clear-outcome");
  await expect(outcome).toHaveText(
    /^Unlocked\. The gateway no longer keeps an order for Otto that names only OpenAI · Work, so Otto follows its other orders\. Checked with the gateway at \d{1,2}:\d{2} [AP]M\.$/,
  );
  await expect(outcome.getByRole("status")).toBeFocused();
  await expect(page.getByTestId("bound-note")).toBeVisible();
  await expect(page.getByText("The lock is gone")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Unlock…" })).toHaveCount(0);
});

test("F-592: the press carries the stamp of the page it was confirmed on", async ({ page }) => {
  await openFixture(page, LOCKED(), "light");
  const read = await page.evaluate(() => {
    let read = { gatewayId: null as string | null, target: 0 };
    (
      window as unknown as {
        clawtrateFixture: { setState(change: (state: ClawtrateState) => ClawtrateState): void };
      }
    ).clawtrateFixture.setState((state) => {
      read = { gatewayId: state.connection.gatewayId, target: state.connection.target };
      return {
        ...state,
        accounts: {
          ...state.accounts,
          readOn: { ...read, connectedAt: state.connection.connectedAt },
        },
        connection: { ...state.connection, gatewayId: "another-gateway" },
      };
    });
    return read;
  });
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Unlock…" }).click();
  // On OpenClaw 2026.10.6 locking again takes only the command.
  await expect(page.getByRole("alertdialog")).toContainText(
    "Locking Otto again needs a command on the gateway's machine.",
  );
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect.poll(() => sentStamp(page, "clearBotOrder")).toEqual(read);
});

for (const [end, words, word] of [
  [
    "refused",
    "The gateway refused to unlock Otto: auth profile order is temporarily unavailable.",
    "locked",
  ],
  [
    "unanswered",
    "The gateway didn't answer, so Clawtrate can't tell yet whether Otto's order was cleared. Check now reads it again.",
    "locked",
  ],
  [
    "kept",
    "The gateway answered, but its order for Otto still names only OpenAI · Work. Check now reads it again.",
    "locked",
  ],
  [
    "unread",
    "The gateway answered, but Clawtrate couldn't read Otto's order back, so it can't say yet whether it was cleared. Check now reads it again.",
    "locked",
  ],
  [
    "moved",
    "Otto's order changed on the gateway while this was open, so Clawtrate sent nothing. The page shows the order as the gateway has it now.",
    "stale",
  ],
  ["unsent", "Nothing was sent. The gateway says its account status is unavailable.", "locked"],
] as const)
  test(`F-592: an Unlock that ends ${end} says so, and the page keeps the gateway's read`, async ({
    page,
  }) => {
    await openFixture(page, LOCKED(`&clear=${end}`), "light");
    await page.getByRole("button", { name: /^Account: / }).click();
    await page.getByRole("button", { name: "Unlock…" }).click();
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    const outcome = page.getByTestId("clear-outcome");
    await expect(outcome).toHaveText(words);
    await expect(outcome.getByRole("alert")).toHaveCount(1);
    await expect(page.getByTestId("bot-settings")).toHaveAttribute("data-word", word);
  });

test("F-592: while the press is under way the page says so and Unlock waits", async ({ page }) => {
  await openFixture(page, LOCKED("&clear=hold"), "light");
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Unlock…" }).click();
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByText("Unlocking Otto…")).toBeVisible();
  // The page's Unlock waits (the confirmation's own button reads "Unlock…" while it is busy).
  await expect(page.locator("[data-bs='unlock']")).toBeDisabled();
  // Cancel while busy closes the confirmation, not the press: Unlock still waits, nothing more goes.
  await page.getByTestId("confirm").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("confirm")).toHaveCount(0);
  await expect(page.locator("[data-bs='unlock']")).toBeDisabled();
  expect((await sent(page)).filter((each) => each.type === "clearBotOrder")).toHaveLength(1);
  await page.evaluate(() => (window as unknown as { releaseClear: () => void }).releaseClear());
  await expect(page.getByTestId("clear-outcome")).toContainText("Unlocked.");
});

test("F-592: Clear order for a bot the gateway chooses for, with its own confirmation", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=retained&version=2026.11.10`,
    "light",
  );
  await page.getByRole("button", { name: /^Account: OpenAI, Gateway chooses\. Open\.$/ }).click();
  await expect(page.getByTestId("retained-order")).toContainText(
    "Clear it to let the gateway choose among OpenAI's accounts.",
  );
  await page.getByRole("button", { name: "Clear order…" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Clear Otto's order?" });
  await expect(dialog).toHaveAccessibleDescription(
    "The gateway still has an order for Otto that names only OpenAI · Work. After this, the gateway chooses among OpenAI's accounts for each of Otto's runs, by its other orders. Keeping Otto on one account again needs the gateway stopped and a command on its machine.",
  );
  await dialog.getByRole("button", { name: "Clear order" }).click();
  expect((await sent(page)).filter((each) => each.type === "clearBotOrder")).toMatchObject([
    { botId: "otto", provider: "openai", account: "openai:work", kind: "clear" },
  ]);
  await expect(page.getByTestId("clear-outcome")).toHaveText(
    /^Cleared\. The gateway no longer keeps an order for Otto that names only OpenAI · Work, so it chooses among OpenAI's accounts for Otto\. Checked with the gateway at /,
  );
  await expect(page.getByTestId("retained-order")).toHaveCount(0);
});

test("F-592: Change account names the button, with admin, where it named the command", async ({
  page,
}) => {
  await openFixture(page, LOCKED(), "light");
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await page.getByRole("radio", { name: /^Let the gateway choose/ }).click();
  await expect(page.getByTestId("locked-change-note")).toContainText(
    "goes on using that account alone until the order is cleared. Account then has Clear order.",
  );
  await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
  await expect(page.getByTestId("locked-change-note")).toContainText(
    "Account then shows the lock command, and Unlock.",
  );
});

test("F-592: an unsure Clear order says Check now, and its line has the button the page lacks", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=retained&clear=unread`,
    "light",
  );
  await page.getByRole("button", { name: /^Account: OpenAI, Gateway chooses\. Open\.$/ }).click();
  await page.getByRole("button", { name: "Clear order…" }).click();
  await page.getByTestId("confirm").getByRole("button", { name: "Clear order" }).click();
  const outcome = page.getByTestId("clear-outcome");
  await expect(outcome).toContainText("Check now reads it again.");
  const before = (await sent(page)).filter((each) => each.type === "checkLock").length;
  await outcome.getByRole("button", { name: "Check now" }).click();
  await expect
    .poll(async () => (await sent(page)).filter((each) => each.type === "checkLock").length)
    .toBeGreaterThan(before);
});

test("F-480: Change model settled as the person moves to another bot leaves focus with them, not on that bot's model", async ({
  page,
}) => {
  await openFixture(page, `scene=not-run-api-key&${OTTO_DISK}&access=admin`, "light");
  await holdFrames(page);
  await page.getByTestId("turn-error").getByRole("button", { name: "Change model" }).click();
  const model = page.getByTestId("model-select");
  await expect(model).toBeEnabled();
  const pip = page.getByTestId("bot-list").getByRole("button", { name: /^Pip\b/ });
  await pip.click();
  await expect(page.getByTestId("bot-settings")).toContainText("Pip");
  await releaseFrames(page);
  await expect(pip).toBeFocused();
  await expect(model).not.toBeFocused();
});

type Reply = {
  clawtrateFixture: ClawtrateBridge;
  held: { resolve: () => void; reject: (failure: Error) => void }[];
};
/** The fixture's answers to `type` commands wait, oldest first, until `releaseReply`. */
const holdReply = (page: Page, type: string) =>
  page.evaluate((type) => {
    const w = window as unknown as Reply;
    w.held = [];
    const invoke = w.clawtrateFixture.invoke.bind(w.clawtrateFixture);
    w.clawtrateFixture.invoke = ((command: { type: string }) =>
      command.type !== type
        ? invoke(command as never)
        : new Promise<void>((resolve, reject) => {
            w.held.push({ resolve, reject });
          }).then(() => invoke(command as never))) as ClawtrateBridge["invoke"];
  }, type);
const releaseReply = (page: Page) =>
  page.evaluate(() => (window as unknown as Reply).held.shift()!.resolve());
const rejectReply = (page: Page, message: string) =>
  page.evaluate(
    (message) => (window as unknown as Reply).held.shift()!.reject(new Error(message)),
    message,
  );

test("F-473: a Change account saved as the person moves to another bot leaves that bot's page on its first view", async ({
  page,
}) => {
  await openFixture(page, `${SETTINGS_TAB}&lock=bound`, "light");
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
  await holdReply(page, "changeBotAccount");
  await page.getByRole("button", { name: "Save" }).click();
  const pip = page.getByTestId("bot-list").getByRole("button", { name: /^Pip\b/ });
  await pip.click();
  await expect(page.getByTestId("bot-settings")).toContainText("Pip");
  await releaseReply(page);
  await expect(page.getByTestId("work-announcer")).toHaveText("Otto now runs on OpenAI · Home");
  await settle(page);
  await expect(page.getByTestId("model-select")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account", level: 3 })).toHaveCount(0);
  await expect(pip).toBeFocused();
});

test("F-473: a Change account refused after the person moved to another bot shows nothing on that bot's page", async ({
  page,
}) => {
  await openFixture(page, `${SETTINGS_TAB}&lock=bound`, "light");
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
  await holdReply(page, "changeBotAccount");
  await page.getByRole("button", { name: "Save" }).click();
  const pip = page.getByTestId("bot-list").getByRole("button", { name: /^Pip\b/ });
  await pip.click();
  await expect(page.getByTestId("bot-settings")).toContainText("Pip");
  // Otto's save still out: Pip's own Change account isn't waiting on it.
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await expect(page.getByRole("button", { name: "Saving…" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
  await rejectReply(page, "The gateway refused Otto's change.");
  await settle(page);
  await expect(page.getByTestId("bot-settings")).not.toContainText(
    "The gateway refused Otto's change.",
  );
});

test("F-473: a Change account refused after the person went to another bot and back leaves the next save waiting", async ({
  page,
}) => {
  await openFixture(page, `${SETTINGS_TAB}&lock=bound`, "light");
  const bots = page.getByTestId("bot-list");
  const changeTo = async (account: RegExp) => {
    await page.getByRole("button", { name: /^Account: / }).click();
    await page.getByRole("button", { name: "Change account" }).click();
    await page.getByRole("radio", { name: account }).click();
    await page.getByRole("button", { name: "Save" }).click();
  };
  await holdReply(page, "changeBotAccount");
  await changeTo(/^OpenAI · Home/);
  await bots.getByRole("button", { name: /^Pip\b/ }).click();
  await expect(page.getByTestId("bot-settings")).toContainText("Pip");
  await bots.getByRole("button", { name: /^Otto\b/ }).click();
  await expect(page.getByTestId("bot-settings")).toContainText("Otto");
  await changeTo(/^OpenAI · Home/);
  await expect(page.getByRole("button", { name: "Saving…" })).toBeVisible();
  await rejectReply(page, "The gateway refused the first change.");
  await settle(page);
  await expect(page.getByRole("button", { name: "Saving…" })).toBeVisible();
  await expect(page.getByTestId("bot-settings")).not.toContainText(
    "The gateway refused the first change.",
  );
});

test("F-473: a Change account saved after the person went to another bot and back leaves the next save on its page", async ({
  page,
}) => {
  await openFixture(page, `${SETTINGS_TAB}&lock=bound`, "light");
  const bots = page.getByTestId("bot-list");
  const changeTo = async (account: RegExp) => {
    await page.getByRole("button", { name: /^Account: / }).click();
    await page.getByRole("button", { name: "Change account" }).click();
    await page.getByRole("radio", { name: account }).click();
    await page.getByRole("button", { name: "Save" }).click();
  };
  await holdReply(page, "changeBotAccount");
  await changeTo(/^OpenAI · Home/);
  await bots.getByRole("button", { name: /^Pip\b/ }).click();
  await expect(page.getByTestId("bot-settings")).toContainText("Pip");
  await bots.getByRole("button", { name: /^Otto\b/ }).click();
  await expect(page.getByTestId("bot-settings")).toContainText("Otto");
  await changeTo(/^OpenAI · Home/);
  await expect(page.getByRole("button", { name: "Saving…" })).toBeVisible();
  await releaseReply(page);
  await settle(page);
  // The first save's answer moves no page: the second is still waiting on Change account.
  await expect(page.getByRole("heading", { name: "Change account", level: 3 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Saving…" })).toBeVisible();
});

test("F-474: an account connected with a label as the person moves to another bot leaves that bot's page on its first view", async ({
  page,
}) => {
  await openFixture(page, `${SETTINGS_TAB}&lock=bound&kept=1&signin=connected`, "light");
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await page.getByRole("button", { name: /^Connect an account/ }).click();
  await page.getByRole("button", { name: /^xAI\b/ }).click();
  await page.getByRole("textbox", { name: "Label" }).fill("Side");
  await holdReply(page, "setAccountLabel");
  await page.getByRole("button", { name: "Done" }).click();
  const pip = page.getByTestId("bot-list").getByRole("button", { name: /^Pip\b/ });
  await pip.click();
  await expect(page.getByTestId("bot-settings")).toContainText("Pip");
  const dismissals = async () =>
    (await sent(page)).filter((each) => each.type === "dismissSignIn").length;
  const before = await dismissals();
  await releaseReply(page);
  await expect(page.getByTestId("work-announcer")).toHaveText("Label saved");
  // Otto's Connect has gone: it ends no sign-in, which by now could be one Pip started.
  expect(await dismissals()).toBe(before);
  await settle(page);
  await expect(page.getByTestId("model-select")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Change account", level: 3 })).toHaveCount(0);
  await expect(pip).toBeFocused();
});

test("F-474: a label saved after its Connect has gone leaves the next Connect on its sign-in methods", async ({
  page,
}) => {
  await openFixture(page, `${SETTINGS_TAB}&lock=bound&kept=1&signin=connected`, "light");
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await page.getByRole("button", { name: /^Connect an account/ }).click();
  await page.getByRole("button", { name: /^xAI\b/ }).click();
  await page.getByRole("textbox", { name: "Label" }).fill("Side");
  await holdReply(page, "setAccountLabel");
  await page.getByRole("button", { name: "Done" }).click();
  await page
    .getByTestId("bot-list")
    .getByRole("button", { name: /^Pip\b/ })
    .click();
  await expect(page.getByTestId("bot-settings")).toContainText("Pip");
  await releaseReply(page);
  await expect(page.getByTestId("work-announcer")).toHaveText("Label saved");
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await page.getByRole("button", { name: /^Connect an account/ }).click();
  await expect(page.getByRole("textbox", { name: "Label" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^xAI\b/ })).toBeVisible();
});
