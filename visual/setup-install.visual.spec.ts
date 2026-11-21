// F-501 F-502 F-505: setting OpenClaw up on this computer (docs/design/
// setup.md §10, §16) on fixed state: every install screen matches its
// approved baseline at 1440 px and the phone, dark first (the default) and
// light as explicit cases; and what the screens say, where each button
// leads and what the host is asked.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, settle, SIZES, type Theme } from "./fixture.ts";

const STATES = [
  "not-found",
  "not-found-leftover",
  "installing",
  "installing-node",
  "installing-check",
  "install-download",
  "install-download-space",
  "install-fingerprint",
  "install-installer",
  "install-node",
  "install-unproven",
  "install-onboard",
  "install-service",
  "install-not-answering",
  "install-exists",
  "install-user-service",
  "install-changed",
  "install-expired",
  "found-installed",
];
const THEMES_DARK_FIRST: Theme[] = ["dark", "light"];
const SHOWN = SIZES.filter((size) => size.name === "1440" || size.phone);

const sent = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: Array<{ type: string }> } }
    ).clawtrateFixture.sent.map((command) => command.type),
  );

for (const size of SHOWN) {
  for (const theme of THEMES_DARK_FIRST) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const state of STATES) {
        test(`F-501 F-502 F-505: setup ${state}`, async ({ page }) => {
          await openFixture(page, `setup=${state}`, theme);
          await expect(page.getByTestId("setup")).toBeVisible();
          await settle(page);
          await expect(page).toHaveScreenshot(`install-${state}-${theme}-${size.name}.png`);
        });
      }
      test("F-501: setup install-review", async ({ page }) => {
        await openFixture(page, "setup=not-found", theme);
        await page.getByRole("button", { name: "Set up OpenClaw here" }).click();
        await expect(
          page.getByRole("heading", { name: "Set up OpenClaw on this computer" }),
        ).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`install-review-${theme}-${size.name}.png`);
      });
    });
  }
}

test.describe("behaviour", () => {
  test.use(contextFor(SIZES[0]!, "dark"));

  test("F-501: Set up OpenClaw here says what, where, checked and then before anything is asked of the host, and Cancel goes back", async ({
    page,
  }) => {
    await openFixture(page, "setup=not-found", "dark");
    await page.getByRole("button", { name: "Set up OpenClaw here" }).click();
    const title = page.getByRole("heading", { name: "Set up OpenClaw on this computer" });
    await expect(title).toBeFocused();
    const facts = page.getByTestId("setup-install-facts");
    await expect(facts.locator("dt")).toHaveText(["What", "Where", "Checked", "Then"]);
    await expect(facts.locator("dd").nth(0)).toHaveText(
      "OpenClaw 2026.10.6, the version this Clawtrate is tested with, with its own copy of Node.js 24.22.1",
    );
    await expect(facts.locator("dd").nth(1)).toHaveText(
      "Clawtrate puts the program in its app data and gateway data in the clawtrate profile. OpenClaw also adds a user service and can write service logs.",
    );
    await expect(facts.locator("dd").nth(2)).toHaveText(
      "Clawtrate checks the OpenClaw and Node.js downloads against fingerprints built into this version before extracting either archive. Setup also installs code from npm that Clawtrate hasn't pinned or verified. That code can run with your account's permissions.",
    );
    await expect(facts.locator("dd").nth(3)).toHaveText(
      "OpenClaw sets up a gateway configured for this computer only, with token sign-in and no AI provider. Its user service is configured to start when you log in.",
    );
    await expect(page.getByText("Setup asks for no provider account or model key.")).toBeVisible();
    await expect(
      page.getByText(
        "OpenClaw runs as a separate user service. Removing the Clawtrate app does not remove that service. Clawtrate does not offer OpenClaw removal in this version.",
      ),
    ).toBeVisible();
    // Nothing promises a Settings action the app doesn't have.
    await expect(page.getByText(/Settings/)).toHaveCount(0);
    expect(await sent(page)).toEqual([]);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByRole("heading", { name: "Clawtrate didn't find OpenClaw here" }),
    ).toBeVisible();
    expect(await sent(page)).toEqual([]);
  });

  test("F-502 F-505: Set up OpenClaw… asks the host, the steps run in order, and the gateway set up is found with Connect", async ({
    page,
  }) => {
    await openFixture(page, "setup=not-found", "dark");
    await page.getByRole("button", { name: "Set up OpenClaw here" }).click();
    await page.getByRole("button", { name: "Set up OpenClaw…" }).click();
    expect(await sent(page)).toEqual(["setupInstall"]);
    await expect(page.getByRole("heading", { name: "Setting up OpenClaw" })).toBeVisible();
    const steps = page.getByRole("list", { name: "Steps" }).getByRole("listitem");
    await expect(steps).toHaveText([
      "Download and check OpenClaw 2026.10.6",
      "Install Node.js and OpenClaw",
      "Set up the gateway",
      "Start and check",
    ]);
    // An install runs to its end: no Back while it runs.
    await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "OpenClaw is running" })).toBeVisible();
    await expect(page.getByTestId("setup-found")).toContainText("clawtrate");
    // Nothing says who installed it until the service manager's effective command proves it.
    await expect(page.getByTestId("setup-found")).not.toContainText("Installed by");
    await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();
  });

  test("F-502: the Node.js line appears once the installer used the checked Node.js", async ({
    page,
  }) => {
    await openFixture(page, "setup=installing-node", "dark");
    const steps = page.getByRole("list", { name: "Steps" }).getByRole("listitem");
    await expect(steps.nth(1)).toHaveText("Install Node.js and OpenClawNode.js 24.22.1, checked");
    await expect(steps.nth(1)).toHaveAttribute("aria-current", "step");
  });

  test("F-502: a failed step is named with its cause and typed details, and Try again asks the host again", async ({
    page,
  }) => {
    await openFixture(page, "setup=install-installer", "dark");
    const steps = page.getByRole("list", { name: "Steps" }).getByRole("listitem");
    await expect(steps.nth(1)).toHaveAttribute("data-state", "failed");
    await expect(steps.nth(2)).toHaveAttribute("data-state", "waiting");
    await expect(page.getByRole("alert")).toHaveText(
      "Install Node.js and OpenClaw failed. The installer didn't finish successfully. Clawtrate removed this attempt's program files and install record.",
    );
    await page.getByText("Show details").click();
    const details = page.getByTestId("setup-install-details").locator("dd");
    await expect(details).toHaveText(["Install Node.js and OpenClaw", "Installer", "1"]);
    await page.getByRole("button", { name: "Try again" }).click();
    expect(await sent(page)).toEqual(["setupInstall"]);
  });

  test("F-502: once the gateway's setup began, trying again isn't offered, and Back returns to the card", async ({
    page,
  }) => {
    await openFixture(page, "setup=install-onboard", "dark");
    await expect(page.getByRole("alert")).toHaveText(
      "Set up the gateway failed. The gateway reported a problem when starting. Clawtrate can't remove a gateway it began to set up in this version, so trying again isn't offered.",
    );
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await page.getByRole("button", { name: "Back" }).first().click();
    expect(await sent(page)).toEqual(["setupCancel"]);
  });

  test("F-502: a cleanup that couldn't be proven says so, and offers no Try again", async ({
    page,
  }) => {
    await openFixture(page, "setup=install-unproven", "dark");
    await expect(page.getByRole("alert")).toContainText(
      "Clawtrate couldn't confirm what this attempt left. Trying again is unavailable.",
    );
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  });

  test("F-501: a confirmation answered too late says it expired, and offers a look again", async ({
    page,
  }) => {
    await openFixture(page, "setup=install-expired", "dark");
    await expect(page.getByRole("alert")).toHaveText(
      "This setup confirmation expired. Look again.",
    );
    await page.getByRole("button", { name: "Look again" }).click();
    expect(await sent(page)).toEqual(["setupLook"]);
  });

  test("F-502: an earlier attempt of Clawtrate's own is named on the card, and setting up is still offered", async ({
    page,
  }) => {
    await openFixture(page, "setup=not-found-leftover", "dark");
    await expect(
      page.getByText(
        "An earlier setup attempt of Clawtrate's didn't finish. Setting up checks whether those files can be removed first.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Set up OpenClaw here" })).toBeVisible();
  });

  test("F-501: a clawtrate folder, service or record already there is refused in the design's words", async ({
    page,
  }) => {
    await openFixture(page, "setup=install-exists", "dark");
    await expect(page.getByRole("alert")).toHaveText(
      "A clawtrate folder, service or install record already exists. Clawtrate won't replace it.",
    );
    await expect(page.locator(".s-steps [data-state='failed']")).toHaveCount(0);
  });

  test("F-501 F-505: a service that appeared during its install, the service install's own result, and a check that couldn't be made each say only what was seen", async ({
    page,
  }) => {
    await openFixture(page, "setup=install-service-appeared", "dark");
    await expect(page.getByRole("alert")).toHaveText(
      "Set up the gateway failed. A Clawtrate service appeared on this computer while setting up; Clawtrate left it as it is. Clawtrate can't remove a gateway it began to set up in this version, so trying again isn't offered.",
    );
    await openFixture(page, "setup=install-service", "dark");
    await expect(page.getByRole("alert")).toContainText(
      "Clawtrate couldn't confirm the gateway's user service was installed.",
    );
    await openFixture(page, "setup=install-unchecked", "dark");
    await expect(page.getByRole("alert")).toHaveText(
      "Clawtrate couldn't check whether OpenClaw was already set up. Look again.",
    );
    await expect(page.locator(".s-steps [data-state='failed']")).toHaveCount(0);
  });

  test("F-502: a fingerprint that didn't match says setup stopped before extracting either archive", async ({
    page,
  }) => {
    await openFixture(page, "setup=install-fingerprint", "dark");
    await expect(page.getByRole("alert")).toContainText(
      "A download didn't match its expected fingerprint. Setup stopped before extracting either archive.",
    );
  });
});
