// The approval card's run-end closing and its "why the gateway asked" line,
// and the rail's task statuses for a finished run with failed actions and a
// blocked one, in the fixture mode at every size and in both themes
// (conversation.md sections 12 and 20; visual-language.md section 7).
import { expect, test, type Locator, type Page } from "@playwright/test";
import { contextFor, openFixture, settle, SIZES, THEMES } from "./fixture.ts";

const approvalCard = (page: Page) => page.getByTestId("approval-card");

/** Nothing inside reaches past its own right edge: no horizontal scroll at this width. */
async function fitsWidth(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  const width = page.viewportSize()!.width;
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
}

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));

      test("F-418: a run that completed while its request was pending closes the card as the run ended: nothing to answer, its command not run", async ({
        page,
      }) => {
        await openFixture(page, "scene=approval-withdrawn", theme);
        const card = approvalCard(page);
        await expect(card).toHaveAttribute("data-state", "denied");
        await expect(card.locator(".tag")).toHaveText("Closed: the run ended");
        for (const name of ["Allow once", "Always allow…", "Deny"]) {
          await expect(card.getByRole("button", { name, exact: true })).toHaveCount(0);
        }
        await card.locator("summary").first().click();
        await expect(card.locator(".request-resolved-body > p").first()).toHaveText(
          "The run ended before this was answered. The command was not run.",
        );
        // The run is over: no status line waits on it, and its run line follows it.
        await expect(page.getByTestId("status-line")).toHaveCount(0);
        await expect(page.getByTestId("run-line").last()).toBeVisible();
        await fitsWidth(page, card);
      });

      test("F-164 F-170: the full request says why the gateway asked, with Manage settings opening Permissions; closing it returns focus to the link", async ({
        page,
      }) => {
        await openFixture(page, "scene=approval-pending", theme);
        const card = approvalCard(page);
        const full = card.locator("details.request-full");
        await full.locator("summary").click();
        await expect(full.locator("summary")).toHaveText(/Hide full request/);
        await expect(full.locator(".command-line code")).toHaveText(
          "mv /srv/media/transcode-cache /srv/scratch/transcode-cache",
        );
        await expect(full.getByRole("button", { name: "Copy command" })).toBeVisible();
        await expect(full.locator(".request-why")).toHaveText(
          "The gateway asked because this command is not on media-box's allowlist. Manage settings",
        );
        await fitsWidth(page, card);
        const manage = full.getByRole("button", { name: "Manage settings" });
        await manage.click();
        const settings = page.getByRole("dialog", { name: "Settings" });
        await expect(settings.getByRole("heading", { name: "Permissions" })).toBeVisible();
        await expect(settings.getByTestId("permissions")).toContainText(
          "Changing a bot's policy, or reading the allowlist, needs admin access on the gateway.",
        );
        await page.keyboard.press("Escape");
        await expect(settings).toHaveCount(0);
        await expect(manage).toBeFocused();
        await full.locator("summary").click();
        await expect(full.locator("summary")).toHaveText(/Show full request/);
      });

      test("F-094: a stop note, a failed turn's card and the run line each have Raw with the event behind it", async ({
        page,
      }) => {
        const raw = (target: Locator) =>
          target.getByRole("region", { name: "What the gateway sent" });
        await openFixture(
          page,
          "scene=run-stopped&bot=otto&task=agent:otto:disk-space&panel=closed",
          theme,
        );
        const note = page.getByTestId("stop-note");
        await note.getByRole("button", { name: "Raw" }).click();
        await expect(raw(note)).toContainText(
          "The event, as the gateway sent it (agent (lifecycle end))",
        );
        await expect(raw(note)).toContainText('"aborted": true');
        await fitsWidth(page, note);
        const line = page.getByTestId("run-line").last();
        await line.locator("summary").click();
        await line.getByRole("button", { name: "Raw" }).click();
        await expect(raw(line)).toContainText("(agent (lifecycle start))");
        await openFixture(
          page,
          "scene=run-failed&bot=otto&task=agent:otto:disk-space&panel=closed",
          theme,
        );
        const error = page.getByTestId("turn-error");
        await error.getByRole("button", { name: "Raw" }).click();
        await expect(raw(error)).toContainText("(agent (lifecycle error))");
        await expect(raw(error)).toContainText("The model provider is overloaded.");
        await fitsWidth(page, error);
      });

      test("F-057 F-295: a task whose run finished with a failed action shows the failed mark and says so, and its bot says Finished with 1 failed action until it is opened; a blocked task says blocked", async ({
        page,
      }) => {
        await openFixture(page, "scene=task-states&bot=otto", theme);
        // In one pane the conversation is on screen: the rail is one step back.
        const back = async () => {
          if (size.phone) await page.getByRole("button", { name: "Back to bots" }).click();
        };
        await back();
        const otto = page
          .getByTestId("bot-list")
          .getByRole("button", { name: /^Otto\b/ })
          .first();
        await expect(otto).toHaveAccessibleName(/^Otto, done with failures, /);
        const line = otto.locator(".bot-preview");
        await expect(line).toHaveText("Finished with 1 failed action");
        await expect(line).toHaveAttribute("data-tone", "danger");
        const danger = await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--danger").trim(),
        );
        const color = await line.evaluate((element) => getComputedStyle(element).color);
        const probe = await page.evaluate((value) => {
          const el = document.createElement("span");
          el.style.color = value;
          document.body.append(el);
          const resolved = getComputedStyle(el).color;
          el.remove();
          return resolved;
        }, danger);
        expect(color).toBe(probe);
        const tasks = page.getByRole("list", { name: "Otto's tasks" }).getByTestId("task");
        const backup = tasks.filter({ hasText: "Weekly backup check" });
        await expect(backup.locator(".glyph")).toHaveAttribute("data-state", "failed");
        await expect(backup).toHaveAccessibleName(/, done with failures$/);
        // A task with no mark still says its state: idle or done.
        const quiet = tasks.filter({ hasNot: page.locator(".glyph") });
        const names = await quiet.evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("aria-label") ?? ""),
        );
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) expect(name).toMatch(/, (idle|done)(, unread)?$/);
        await settle(page);
        await fitsWidth(page, otto);
        // Opened, the task's mark and the bot's line give way.
        await backup.click();
        await back();
        await expect(backup.locator(".glyph")).toHaveCount(0);
        await expect(otto.locator(".bot-preview")).not.toHaveText("Finished with 1 failed action");
        await expect(otto).not.toHaveAccessibleName(/done with failures/);
        // Marlow's only task is blocked: the bot and its state say so.
        await expect(
          page.getByTestId("bot-list").getByRole("button", { name: /^Marlow\b/ }),
        ).toHaveAccessibleName(/^Marlow, blocked, /);
      });
    });
  }
}
