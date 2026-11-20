import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { devGateway, startHost, stopChild } from "./global-setup.ts";

test("F-519 F-520: the sixth finished reply invites once and About keeps the browser link after restart", async () => {
  test.setTimeout(240_000);
  const instance = process.env.CLAWTRATE_DEV_INSTANCE!;
  expect(instance).toMatch(/^e2e-/);
  const outbound: string[] = [];
  const commands: string[] = [];
  const watch = async (context: BrowserContext) => {
    const page = context.pages()[0]!;
    await context.route(/https?:\/\/([^/]+\.)?github\.com\//, (route) => {
      outbound.push(route.request().url());
      return route.abort();
    });
    page.on("websocket", (socket) =>
      socket.on("framesent", (frame) => {
        const message = JSON.parse(String(frame.payload));
        if (message.command) commands.push(message.command.type);
      }),
    );
    await context.addInitScript(() => {
      window.open = (...args) => {
        document.documentElement.dataset.opened = JSON.stringify(args);
        return null;
      };
    });
    return page;
  };
  const data = mkdtempSync(join(tmpdir(), "clawtrate-invitation-"));
  const host = startHost(instance, process.env.CLAWTRATE_E2E_STATIC!, data);
  host.gated.release();
  const profile = join(data, "browser-profile");
  const launch = () =>
    chromium.launchPersistentContext(profile, { viewport: { width: 1440, height: 900 } });
  let context: BrowserContext | undefined;
  try {
    context = await launch();
    let page = await watch(context);
    await page.goto(await host.url);
    await page.getByRole("button", { name: "Use the development gateway" }).click();
    const approve = () =>
      expect
        .poll(() => devGateway(instance, "approve"), { timeout: 30_000 })
        .toMatch(/^Approved /m);
    await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible();
    await approve();
    await page
      .getByTestId("bot-list")
      .getByRole("button", { name: /^Pip\b/ })
      .first()
      .click();
    const bar = page.getByRole("region", { name: "Access" });
    await bar.getByRole("button", { name: "Request access" }).click();
    await expect(bar).toContainText("Waiting for the gateway's owner.");
    await approve();
    const field = (page: Page) => page.getByTestId("composer-input");
    const notice = (page: Page) => page.getByRole("region", { name: "GitHub invitation" });
    const replyText = "Here is a plain reply, streamed in small pieces with no reasoning first.";
    const replies = (page: Page) => page.locator(".bubble").filter({ hasText: replyText });
    await expect(field(page)).toBeVisible({ timeout: 30_000 });
    const initialReplies = await replies(page).count();
    const sent = async (n: number) => {
      await field(page).fill(n === 6 ? "Sixth reply #stream 3" : `Reply ${n} #text`);
      await field(page).press("Enter");
      if (n === 6) {
        await expect(page.locator(".bubble[data-streaming=true]")).toBeVisible();
        await expect(notice(page)).toHaveCount(0);
        await expect(
          page
            .getByTestId("transcript-turn")
            .filter({ hasText: "Here is a long answer, streamed slowly." })
            .last(),
        ).toBeVisible({ timeout: 30_000 });
      } else {
        await expect(replies(page)).toHaveCount(initialReplies + (n > 6 ? n - 1 : n), {
          timeout: 30_000,
        });
      }
      await expect(page.getByTestId("status-line")).toHaveCount(0, { timeout: 20_000 });
    };
    await page.evaluate(() => {
      const live = document.querySelector(".composer-inner > [role=status]")!;
      new MutationObserver(() => {
        if (live.textContent)
          document.documentElement.dataset.invitationAnnouncements =
            (document.documentElement.dataset.invitationAnnouncements ?? "") + live.textContent;
      }).observe(live, { childList: true, subtree: true, characterData: true });
    });
    commands.length = 0;
    for (let i = 1; i <= 6; i++) {
      await expect(notice(page)).toHaveCount(0);
      await sent(i);
      if (i < 6) await expect(notice(page)).toHaveCount(0);
    }
    await expect(notice(page)).toBeVisible();
    await expect(field(page)).toBeFocused();
    await expect(page.locator("html")).toHaveAttribute(
      "data-invitation-announcements",
      "Enjoying Clawtrate? Clawtrate is open source. If it helped, consider starring it on GitHub.",
    );

    expect(commands.filter((type) => type !== "markTask")).toEqual(Array(6).fill("sendMessage"));
    await expect(notice(page).getByRole("button", { name: "Star with GitHub CLI" })).toHaveCount(0);
    await notice(page).getByRole("button", { name: "Dismiss" }).focus();
    await page.keyboard.press("Escape");
    await expect(field(page)).toBeFocused();
    expect(commands.filter((type) => type !== "markTask")).toEqual(Array(6).fill("sendMessage"));
    await context.close();
    context = await launch();
    page = await watch(context);
    await page.goto(await host.url);
    await sent(7);
    await expect(notice(page)).toHaveCount(0);
    commands.length = 0;
    await page.keyboard.press("ControlOrMeta+,");
    await page.getByRole("button", { name: "About", exact: true }).click();
    const link = page.getByRole("link", { name: "Star Clawtrate on GitHub" });
    await expect(link).toHaveText("Star Clawtrate on GitHub");
    expect(await page.locator("html").getAttribute("data-opened")).toBeNull();
    await link.click();
    expect(JSON.parse((await page.locator("html").getAttribute("data-opened"))!)).toEqual([
      "https://github.com/sidebandstudio/clawtrate",
      "_blank",
      "noopener,noreferrer",
    ]);
    expect(commands).toEqual([]);
    expect(outbound).toEqual([]);
  } finally {
    await context?.close();
    await stopChild(host.host);
    rmSync(data, { recursive: true, force: true });
  }
});
