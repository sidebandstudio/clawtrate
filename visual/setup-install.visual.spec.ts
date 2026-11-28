// F-501 F-502 F-505: setting OpenClaw up on this computer (docs/design/
// setup.md §10, §16) on fixed state: every install screen matches its
// approved baseline at 1440 px and the phone, in the default dark theme.
// The interaction checks cover what the screens say, where the buttons lead and what the host is asked.
import { test, type Page } from "@playwright/test";
import { contextFor, expect, openFixture, settle, SIZES } from "./fixture.ts";

const STATES = [
  "install-first",
  "install-ready",
  "not-found-leftover",
  "installing",
  "installing-node",
  "installing-gateway",
  "installing-check",
  "install-download",
  "install-download-short",
  "install-download-space",
  "install-fingerprint",
  "install-unpack",
  "install-installer-changed",
  "install-no-program",
  "install-installer",
  "install-node",
  "install-unproven",
  "install-onboard",
  "install-service",
  "install-service-removed",
  "install-service-appeared",
  "install-not-answering",
  "install-exists",
  "install-recovery",
  "install-recovery-inspect",
  "install-replaced",
  "install-removal-staged",
  "install-removal-finish",
  "install-trash-refused",
  "install-user-service",
  "install-changed",
  "install-unchecked",
  "install-expired",
  "found-installed",
];
const theme = "dark";
const SHOWN = SIZES.filter((size) => size.name === "1440" || size.phone);

const sent = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: Array<{ type: string }> } }
    ).clawtrateFixture.sent.map((command) => command.type),
  );

for (const size of SHOWN) {
  test.describe(`${size.name} dark`, () => {
    test.use(contextFor(size, theme));
    for (const state of STATES) {
      test(`F-501 F-502 F-505: setup ${state}`, async ({ page }) => {
        await openFixture(page, `setup=${state}`, theme);
        await expect(page.getByTestId("setup")).toBeVisible();
        await settle(page);
        const name = state.replace(/^install-/, "");
        await expect(page).toHaveScreenshot(`install-${name}-${theme}-${size.name}.png`);
      });
    }
    test("F-501: about setting up OpenClaw", async ({ page }) => {
      await openFixture(page, "setup=install-ready", theme);
      await page.getByRole("button", { name: "About setting up OpenClaw" }).focus();
      await expect(page.getByRole("note")).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`install-about-${theme}-${size.name}.png`);
    });
    test("F-505: the new gateway is connected", async ({ page }) => {
      await openFixture(page, "setup=install-ready", theme);
      await page.getByRole("button", { name: "Set up OpenClaw here" }).click();
      await expect(page.getByTestId("setup")).toHaveCount(0);
      await settle(page);
      await expect(page).toHaveScreenshot(`install-connected-${theme}-${size.name}.png`);
    });
  });
}

test.describe("behaviour", () => {
  test.use(contextFor(SIZES[0]!, "dark"));

  test("F-501: setup details stay behind the info button and the main button asks the host directly", async ({
    page,
  }) => {
    await openFixture(page, "setup=install-ready", "dark");
    await expect(page.getByRole("button", { name: /Advanced/ })).toHaveCount(1);
    const details = page.getByRole("note");
    await expect(details).toHaveCount(0);
    const info = page.getByRole("button", { name: "About setting up OpenClaw" });
    await info.focus();
    await expect(details).toHaveText(
      "Clawtrate downloads OpenClaw 2026.11.10 from npm and Node.js 24.22.1 from nodejs.org. It checks both against fingerprints built into this version. OpenClaw's installer then fetches dependencies from npm. Clawtrate doesn't verify those downloads. Their code runs with your account's permissions. The program goes in the openclaw folder in Clawtrate's app data. The gateway uses the clawtrate profile in your home folder and starts when you log in. Clawtrate connects this Mac with full control. The gateway listens only on this Mac, with network discovery and Tailscale access off. Other devices won't find it automatically unless you enable discovery. To remove OpenClaw, run bin/openclaw --profile clawtrate uninstall from the openclaw folder in Clawtrate's app data. By default, the command removes only the gateway service. Your bots' files stay in the .openclaw-clawtrate folder in your home folder, and the program stays in the openclaw folder in Clawtrate's app data. You can move those folders and the openclaw-install.json file in Clawtrate's app data to the Trash yourself.",
    );
    await expect(info).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(details).toHaveCount(0);
    expect(await sent(page)).toEqual([]);
    await page.getByRole("button", { name: "Set up OpenClaw here" }).click();
    await expect(page.getByRole("heading", { name: "Setting up OpenClaw" })).toBeVisible();
    expect(await sent(page)).toEqual(["setupInstall"]);
  });

  test("F-501 F-602: the first screen, when the look at start found nothing, is the setup card with one Advanced", async ({
    page,
  }) => {
    await openFixture(page, "setup=install-first", "dark");
    await expect(page.getByRole("button", { name: "Set up OpenClaw here" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Advanced/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0);
    await page.getByRole("button", { name: "Set up OpenClaw here" }).click();
    await expect(page.getByRole("heading", { name: "Setting up OpenClaw" })).toBeVisible();
    expect(await sent(page)).toEqual(["setupInstall"]);
  });

  test("F-502 F-505: the four steps lead to the app without a second Connect", async ({ page }) => {
    await openFixture(page, "setup=install-ready", "dark");
    await page.getByRole("button", { name: "Set up OpenClaw here" }).click();
    await expect(page.getByRole("list", { name: "Steps" }).getByRole("listitem")).toHaveText([
      "Download and check OpenClaw 2026.11.10",
      "Install Node.js and OpenClaw",
      "Set up the gateway",
      "Start and check",
    ]);
    await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Connecting" })).toBeVisible();
    await expect(page.getByTestId("setup")).toHaveCount(0);
    expect(await sent(page)).toContain("setupInstall");
    expect(await sent(page)).not.toContain("setupConnect");
    // Full control: what the six scopes allow is allowed in the app.
    const connection = await page.evaluate(
      () =>
        (
          window as unknown as {
            clawtrateFixture: { getState(): { connection: Record<string, unknown> } };
          }
        ).clawtrateFixture.getState().connection,
    );
    expect(connection).toMatchObject({
      canWrite: true,
      canAnswer: true,
      canApprove: true,
      canAdmin: true,
      fullPairing: true,
    });
  });

  test("F-505: the recovery panel offers the recorded setup actions", async ({ page }) => {
    await openFixture(page, "setup=install-recovery", "dark");
    await expect(page.getByRole("heading", { name: "Finish setting up OpenClaw" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove and start again" })).toBeVisible();
    await expect(page.getByRole("listitem", { name: "Set up the gateway, waiting" })).toBeVisible();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const action = await page.evaluate(
      () =>
        (
          window as unknown as {
            clawtrateFixture: { sent: Array<{ type: string; action?: string }> };
          }
        ).clawtrateFixture.sent.find((entry) => entry.type === "setupInstall")?.action,
    );
    expect(action).toBe("continue");
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

  test("F-502: after onboarding begins, Try again rechecks the gateway before continuing", async ({
    page,
  }) => {
    await openFixture(page, "setup=install-onboard", "dark");
    await expect(page.getByRole("alert")).toHaveText(
      "Set up the gateway failed. OpenClaw couldn't start the gateway. Clawtrate kept the gateway files in the clawtrate profile and its app data.",
    );
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    expect(await sent(page)).toEqual(["setupLook"]);
  });

  test("F-505: a service failure with confirmed cleanup can start a fresh attempt", async ({
    page,
  }) => {
    await openFixture(page, "setup=install-service-removed", "dark");
    await expect(page.getByText("The unfinished setup folders are in the Trash.")).toBeVisible();
    await expect(page.getByRole("alert")).toContainText(
      "Clawtrate removed this attempt's program files and install record.",
    );
    await page.getByRole("button", { name: "Try again" }).click();
    expect(await sent(page)).toEqual(["setupInstall"]);
  });

  test("F-502: a cleanup that couldn't be proven says so, and does a fresh look", async ({
    page,
  }) => {
    await openFixture(page, "setup=install-unproven", "dark");
    await expect(page.getByRole("alert")).toContainText(
      "Check the clawtrate profile and Clawtrate’s app data. Some setup files may still be there.",
    );
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("F-501: a confirmation answered too late says it expired, and offers Try again", async ({
    page,
  }) => {
    await openFixture(page, "setup=install-expired", "dark");
    await expect(page.getByRole("alert")).toHaveText("This setup confirmation expired. Try again.");
    await page.getByRole("button", { name: "Try again" }).click();
    expect(await sent(page)).toEqual(["setupLook"]);
  });

  test("F-502: an earlier attempt of Clawtrate's own is named on the card, and setting up is still offered", async ({
    page,
  }) => {
    await openFixture(page, "setup=not-found-leftover", "dark");
    await expect(
      page.getByText(
        "An earlier setup attempt didn't finish. Clawtrate checks its files before trying again.",
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
      "Set up the gateway failed. A Clawtrate service appeared on this computer while setting up; Clawtrate left it as it is. Clawtrate kept the gateway files in the clawtrate profile and its app data.",
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
