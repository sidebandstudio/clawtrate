// The first bot and a new bot's command choice (docs/design/bots.md section 3,
// docs/design/controls.md section 10) against approved baselines, at 1440 and
// at phone width, dark first and light as its own case: New bot's Approvals
// step, Create's outcomes, the note a new bot's first task shows, and the
// first-bot prompt with and below admin. The fixture's data is made up.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES } from "./fixture.ts";

type Scene = { name: string; query: string; ready: (page: Page) => Promise<void> };

const ADMIN = `scene=main&${OTTO_DISK}&access=admin`;

/** New bot as far as its Approvals step, with an account chosen. */
async function approvalsStep(page: Page) {
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill("Viral");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
  await page.getByTestId("account-next").click();
  await expect(page.getByRole("heading", { name: "Approvals", level: 2 })).toBeVisible();
}

/** Create with a choice, then the new bot's first task. */
const created = (choice: string) => async (page: Page) => {
  await approvalsStep(page);
  await page.getByRole("radio", { name: choice }).click();
  await page.getByTestId("create").click();
  await expect(page.getByTestId("new-bot")).toHaveCount(0);
  await expect(page.getByTestId("policy-note")).toBeVisible();
};

const SCENES: Scene[] = [
  { name: "approvals-none-chosen", query: ADMIN, ready: approvalsStep },
  {
    name: "approvals-chosen",
    query: ADMIN,
    ready: async (page) => {
      await approvalsStep(page);
      await page.getByRole("radio", { name: "Ask before acting" }).click();
      await expect(page.getByTestId("inherits")).toBeVisible();
    },
  },
  {
    name: "approvals-file-blocks",
    query: `${ADMIN}&approvalsfile=blocks`,
    ready: async (page) => {
      await approvalsStep(page);
      await expect(page.getByTestId("approvals-file")).toHaveAttribute("data-tone", "warn");
    },
  },
  {
    name: "approvals-create-unconfirmed",
    query: `${ADMIN}&create=unconfirmed`,
    ready: async (page) => {
      await approvalsStep(page);
      await page.getByRole("radio", { name: "Ask before acting" }).click();
      await page.getByTestId("create").click();
      await expect(page.getByTestId("create-unconfirmed")).toBeVisible();
    },
  },
  { name: "created-ask", query: ADMIN, ready: created("Ask before acting") },
  {
    name: "created-full-no-label",
    query: `${ADMIN}&policy=nolabel`,
    ready: created("Run without routine approvals"),
  },
  {
    name: "created-unconfirmed",
    query: `${ADMIN}&policy=unconfirmed`,
    ready: created("Ask before acting"),
  },
  {
    name: "created-restrictive-unconfirmed",
    query: `${ADMIN}&policy=restrictive`,
    ready: created("Ask before acting"),
  },
  {
    name: "first-bot-admin",
    query: "scene=main&access=admin&firstbot=read-only",
    ready: async (page) => {
      await expect(page.getByTestId("first-bot")).toBeVisible();
    },
  },
  {
    name: "first-bot-below-admin",
    query: "scene=main&access=write&firstbot=read-only",
    ready: async (page) => {
      await expect(page.getByTestId("main-policy")).toBeVisible();
    },
  },
  {
    name: "first-bot-read-only",
    query: "scene=main&access=read&firstbot=guarded",
    ready: async (page) => {
      await expect(page.getByTestId("main-policy")).toBeVisible();
    },
  },
];

const SHOWN = SIZES.filter((size) => size.name === "1440" || size.phone);

for (const theme of ["dark", "light"] as const) {
  for (const size of SHOWN) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const scene of SCENES) {
        test(`first bot: ${scene.name}`, async ({ page }) => {
          await openFixture(page, scene.query, theme);
          await scene.ready(page);
          await settle(page);
          await expect(page).toHaveScreenshot(`${scene.name}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}
