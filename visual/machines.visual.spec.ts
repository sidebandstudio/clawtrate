// Where a bot runs and Settings, Machines (docs/design/controls.md sections 14,
// 15 and 19) against approved baselines. The main states at 1440, 1100, 800 and
// 390 px in light and dark; the rest at 1440 and 390 in light. The fixture's
// machines and devices are made up (apps/desktop/src/fixture/machines.ts).
import { expect, test, type Page } from "@playwright/test";
import {
  contextFor,
  hold,
  openFixture,
  OTTO_DISK,
  release,
  settle,
  SIZES,
  THEMES,
  type Size,
} from "./fixture.ts";

type Scene = { name: string; rows: string; query: string; ready: (page: Page) => Promise<void> };

const PANE = `scene=main&${OTTO_DISK}&panel=open&tab=settings`;

async function runsOn(page: Page) {
  await page.getByRole("button", { name: /^Where Otto runs: / }).click();
  await expect(page.getByTestId("runs-on-page")).toBeVisible();
  await expect(page.getByTestId("runs-on-loading")).toHaveCount(0);
}
const runsOnReady = (page: Page) =>
  runsOn(page).then(() => expect(page.getByTestId("runs-on-workspace")).toBeVisible());

async function saveGatewayMachine(page: Page) {
  await runsOnReady(page);
  await page.getByTestId("runs-on-machine").click();
  await hold(page);
  await page.getByRole("menuitemradio", { name: "The gateway's machine" }).click();
  await release(page);
}

async function machines(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Machines", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Machines", level: 3 })).toBeVisible();
}
const machinesReady = (page: Page) =>
  machines(page).then(() => expect(page.getByTestId("machine-list")).toBeVisible());

/** Shown at every size and in both themes. */
const MAIN: Scene[] = [
  {
    name: "tab-row",
    rows: "F-046 F-272",
    query: `${PANE}&access=admin&machine=shared`,
    ready: (page) =>
      expect(page.getByTestId("runs-on-value")).toHaveText(
        "Command setting: media-box · Same setting as Pip",
      ),
  },
  {
    name: "runs-on",
    rows: "F-046 F-047 F-273 F-274",
    query: `${PANE}&access=admin`,
    ready: runsOnReady,
  },
  { name: "runs-on-read", rows: "F-046 F-047", query: `${PANE}&access=read`, ready: runsOnReady },
  { name: "machines", rows: "F-156 F-157", query: `${PANE}&access=admin`, ready: machinesReady },
  {
    name: "machines-read",
    rows: "F-156 F-157",
    query: `${PANE}&access=read`,
    ready: async (page) => {
      await machinesReady(page);
      await expect(page.getByTestId("device-bar")).toBeVisible();
    },
  },
];

/** Shown at 1440 and 390, light. */
const MORE: Scene[] = [
  {
    name: "runs-on-shared",
    rows: "F-272",
    query: `${PANE}&access=admin&machine=shared`,
    ready: async (page) => {
      await runsOnReady(page);
      await expect(page.getByTestId("runs-on-shared")).toBeVisible();
    },
  },
  {
    name: "runs-on-offline",
    rows: "F-046",
    query: `${PANE}&access=admin&machine=offline`,
    ready: async (page) => {
      await runsOnReady(page);
      await expect(page.getByTestId("runs-on-offline")).toBeVisible();
    },
  },
  {
    name: "runs-on-gateway",
    rows: "F-046 F-274",
    query: `${PANE}&access=admin&machine=gatewayhost`,
    ready: runsOnReady,
  },
  {
    name: "runs-on-own-browser",
    rows: "F-273",
    query: `${PANE}&access=admin&machine=ownbrowser`,
    ready: runsOnReady,
  },
  {
    name: "runs-on-unlisted",
    rows: "F-046",
    query: `${PANE}&access=admin&machine=unlisted`,
    ready: runsOnReady,
  },
  {
    name: "runs-on-unsupported",
    rows: "F-046",
    query: `${PANE}&access=admin&machine=unsupported`,
    ready: async (page) => {
      await runsOnReady(page);
      await expect(page.getByTestId("runs-on-unsupported")).toBeVisible();
    },
  },
  {
    name: "runs-on-not-applied",
    rows: "F-046",
    query: `${PANE}&access=admin&mwrite=pending`,
    ready: async (page) => {
      await runsOnReady(page);
      await page.getByTestId("runs-on-machine").click();
      await page.getByRole("menuitemradio", { name: "The gateway's machine" }).click();
      await expect(page.getByTestId("runs-on-not-applied")).toBeVisible();
    },
  },
  {
    name: "runs-on-loading",
    rows: "F-046",
    query: `${PANE}&access=admin&machine=loading`,
    ready: async (page) => {
      await page.getByRole("button", { name: /^Where Otto runs: / }).click();
      await expect(page.getByTestId("runs-on-loading")).toBeVisible();
    },
  },
  {
    name: "runs-on-error",
    rows: "F-046",
    query: `${PANE}&access=admin&machine=error`,
    ready: async (page) => {
      await page.getByRole("button", { name: /^Where Otto runs: / }).click();
      await expect(page.getByTestId("runs-on-error")).toBeVisible();
    },
  },
  {
    name: "runs-on-workspace-form",
    rows: "F-274",
    query: `${PANE}&access=admin&machine=gatewayhost&mwrite=refused`,
    ready: async (page) => {
      await runsOnReady(page);
      await page.getByRole("button", { name: "Change…" }).click();
      await page
        .getByRole("textbox", { name: /path on the gateway's machine/ })
        .fill("workspaces/otto");
      await page.getByRole("button", { name: "Save folder" }).click();
      await expect(page.locator("#m-workspace-error")).toBeVisible();
    },
  },
  {
    name: "runs-on-refused",
    rows: "F-046",
    query: `${PANE}&access=admin&mwrite=refused`,
    ready: async (page) => {
      await saveGatewayMachine(page);
      await expect(page.getByTestId("runs-on-error-line")).toBeVisible();
    },
  },
  {
    name: "runs-on-unanswered",
    rows: "F-046",
    query: `${PANE}&access=admin&mwrite=unanswered`,
    ready: async (page) => {
      await saveGatewayMachine(page);
      await expect(page.getByTestId("runs-on-save-note")).toBeVisible();
      await expect(page.getByTestId("runs-on-machine")).toHaveAccessibleName(
        "Otto's command machine: The gateway's machine",
      );
    },
  },
  {
    name: "runs-on-unreadable",
    rows: "F-046",
    query: `${PANE}&access=admin&mwrite=unreadable`,
    ready: async (page) => {
      await saveGatewayMachine(page);
      await expect(page.getByTestId("runs-on-error")).toBeVisible();
      await expect(page.getByTestId("runs-on-save-note")).toBeVisible();
    },
  },
  {
    name: "machines-override",
    rows: "F-156",
    query: `${PANE}&access=admin&override=1&machine=shared`,
    ready: machinesReady,
  },
  {
    name: "machines-offline",
    rows: "F-156 F-157",
    query: `${PANE}&access=admin&machine=offline`,
    ready: machinesReady,
  },
  {
    name: "machines-none",
    rows: "F-157",
    query: `${PANE}&access=admin&machine=none`,
    ready: async (page) => {
      await machinesReady(page);
      await expect(page.getByTestId("machines-none")).toBeVisible();
    },
  },
  {
    name: "machines-device-access",
    rows: "F-157",
    query: `${PANE}&access=write&devices=noscope`,
    ready: async (page) => {
      await machinesReady(page);
      await page.getByRole("button", { name: "Request access" }).click();
      await expect(page.getByTestId("device-bar")).toContainText(
        "Waiting for the gateway's owner.",
      );
    },
  },
  {
    name: "machines-remove",
    rows: "F-157",
    query: `${PANE}&access=admin`,
    ready: async (page) => {
      await machinesReady(page);
      await page.getByRole("button", { name: "Remove studio-mac…" }).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
    },
  },
  {
    name: "machines-loading",
    rows: "F-157",
    query: `${PANE}&access=admin&machine=loading`,
    ready: async (page) => {
      await machines(page);
      await expect(page.getByTestId("machines-loading")).toBeVisible();
    },
  },
];

function shoot(scene: Scene, size: Size, theme: (typeof THEMES)[number]) {
  test(`${scene.rows}: machines: ${scene.name}`, async ({ page }) => {
    await openFixture(page, scene.query, theme);
    await scene.ready(page);
    await settle(page);
    await expect(page).toHaveScreenshot(`machines-${scene.name}-${theme}-${size.name}.png`);
  });
}

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const scene of MAIN) shoot(scene, size, theme);
      if (theme === "light" && (size.name === "1440" || size.phone))
        for (const scene of MORE) shoot(scene, size, theme);
    });
  }
}
