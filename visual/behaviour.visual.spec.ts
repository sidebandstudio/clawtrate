// The shell's behaviour on fixed state (visual-language.md, section 14, step 9).
// These need no gateway; e2e/preview.spec.ts checks the same shell against one.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;

/** A bot's row: its name, then its number of tasks ("Otto, 14 tasks, working"). */
const bot = (page: Page, name: string) =>
  page.getByRole("button", { name: new RegExp(`^${name}[^,]*, \\d+ tasks?`) });

test.describe("the rail", () => {
  test.use(contextFor(WIDE, "light"));

  test("a bot with several tasks unfolds while open, shows six, then all fourteen", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    const otto = bot(page, "Otto");
    await expect(otto).toHaveAttribute("aria-expanded", "true");
    await expect(otto).toHaveAccessibleName("Otto, 14 tasks, working, unread");
    const tasks = page.getByRole("list", { name: "Otto's tasks" }).getByTestId("task");
    await expect(tasks).toHaveCount(6);
    await page.getByRole("button", { name: "Show all 14" }).click();
    await expect(tasks).toHaveCount(14);
    await page.getByRole("button", { name: "Show fewer" }).click();
    await expect(tasks).toHaveCount(6);
  });

  test("folding the open bot keeps the selection and the summary", async ({ page }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    await bot(page, "Otto").click();
    await expect(bot(page, "Otto")).toHaveAttribute("aria-expanded", "false");
    await expect(bot(page, "Otto")).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Disk almost full on the media box",
    );
    await expect(bot(page, "Otto").locator(".glyph[data-state='working']")).toBeVisible();
    await expect(bot(page, "Otto").locator(".unread-dot")).toBeVisible();
  });

  test("selecting a bot opens its remembered task; a bot with one task is a plain row", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    await bot(page, "Pip").click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Plan the week");
    await page.getByRole("list", { name: "Pip's tasks" }).getByText("Birthday dinner").click();
    await bot(page, "Marlow").click();
    await expect(bot(page, "Marlow")).not.toHaveAttribute("aria-expanded");
    await expect(bot(page, "Marlow")).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("list", { name: "Pip's tasks" })).toHaveCount(0);
    await bot(page, "Pip").click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Birthday dinner");
  });

  test("arrow keys move through the rail, Right unfolds and Left folds", async ({ page }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    await bot(page, "Juniper").focus();
    await page.keyboard.press("ArrowRight");
    await expect(bot(page, "Juniper")).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("list", { name: "Juniper's tasks" }).getByTestId("task").first(),
    ).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(bot(page, "Juniper")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(bot(page, "Juniper")).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("End");
    await expect(bot(page, "Quartermaster")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(bot(page, "Juniper")).toBeFocused();
  });

  test("a truncated task title shows in full on keyboard focus", async ({ page }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    const long = page.getByTestId("task").filter({ hasText: "Rotate the logs" });
    await long.focus();
    await expect(page.getByTestId("rail-tooltip")).toHaveText(
      "Rotate the logs on every machine in the rack before the disks fill up again",
    );
    await page.getByTestId("task").filter({ hasText: "Router firmware" }).focus();
    await expect(page.getByTestId("rail-tooltip")).toHaveCount(0);
  });

  test("the gateway menu opens from the keyboard and sets the theme", async ({ page }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    // The address asks for light, so Light is the checked theme.
    const trigger = page
      .getByRole("button", { name: /, connected\. Open the gateway menu\.$/ })
      .last();
    for (const key of ["ArrowUp", "ArrowDown"]) {
      await trigger.focus();
      await page.keyboard.press(key);
      await expect(page.getByRole("menuitemradio", { name: "Light" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    }
    await page.keyboard.press("Enter");
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.goto(`/?scene=main&${OTTO_DISK}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page
      .getByRole("button", { name: /Open the gateway menu\.$/ })
      .last()
      .click();
    await page.getByRole("menuitemradio", { name: "Match the system" }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme");
  });

  test("shows nothing that would do nothing on a read-only connection", async ({ page }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    await expect(page.getByRole("button", { name: /^New/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Search/ })).toHaveCount(0);
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.locator(".composer")).toContainText("Read-only connection.");
  });
});

test.describe("the Work pane", () => {
  test("docks from a 1240px window and is a modal drawer below it", async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 800 });
    await openFixture(page, `scene=main&${OTTO_DISK}&panel=open`, "light");
    const work = page.getByTestId("work-panel");
    await expect(work).toBeVisible();
    await expect(work).not.toHaveAttribute("role", "dialog");
    const width = (await page.locator(".conversation").boundingBox())!.width;
    expect(width).toBeGreaterThanOrEqual(600);

    await page.locator(".transcript").focus();
    await page.setViewportSize({ width: 1239, height: 800 });
    await expect(work).toHaveAttribute("role", "dialog");
    await expect(page.locator(".rail")).toHaveAttribute("inert", "");
    await expect(page.getByRole("button", { name: "Close work panel" }).last()).toBeFocused();

    // Tab stays inside the drawer.
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest(".work-panel"))).toBe(
        true,
      );
    }

    await page.setViewportSize({ width: 1440, height: 800 });
    await expect(work).not.toHaveAttribute("role", "dialog");
    await expect(work).toBeVisible();
    await expect(page.locator(".rail")).not.toHaveAttribute("inert", "");
  });

  test("Escape closes the drawer and gives focus back to the toggle", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await openFixture(page, `scene=main&${OTTO_DISK}&panel=closed`, "light");
    await page.getByRole("button", { name: "Show work panel" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Close work panel" }).last()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(".shell")).toHaveAttribute("data-panel", "closed");
    await expect(page.getByRole("button", { name: "Show work panel" })).toBeFocused();
  });

  test("tabs move with the arrow keys", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openFixture(page, `scene=main&${OTTO_DISK}&panel=open`, "light");
    await page.getByRole("tab", { name: "Details" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toContainText("No files yet");
    await page.keyboard.press("End");
    await expect(page.getByRole("tab", { name: "Computer" })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Details" })).toBeFocused();
  });

  test("toggling it keeps the reader's place", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openFixture(page, `scene=main&${OTTO_DISK}&panel=closed`, "light");
    const transcript = page.getByTestId("transcript");
    await transcript.evaluate((element) => (element.scrollTop = 300));
    await settle(page);
    const anchor = () =>
      transcript.evaluate((element) => {
        const top = element.getBoundingClientRect().top;
        const first = [...element.querySelectorAll(".transcript-inner > *")].find(
          (node) => node.getBoundingClientRect().bottom > top + 1,
        )!;
        return { text: first.textContent?.slice(0, 30), top: first.getBoundingClientRect().top };
      });
    const before = await anchor();
    await page.getByRole("button", { name: "Show work panel" }).click();
    await settle(page);
    const after = await anchor();
    expect(after.text).toBe(before.text);
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2);
  });
});

test.describe("the status strip", () => {
  test("is centred on the conversation beside a docked Work pane, and its action is reachable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1240, height: 800 });
    await openFixture(page, `scene=reconnecting&${OTTO_DISK}&panel=open`, "light");
    const strip = page.getByTestId("status-strip");
    await expect(strip).toContainText(/Reconnecting in [1-5]s/);
    const s = (await strip.boundingBox())!;
    const c = (await page.locator(".conversation").boundingBox())!;
    expect(Math.abs(s.x + s.width / 2 - (c.x + c.width / 2))).toBeLessThanOrEqual(1);
    const retry = page.getByRole("button", { name: "Retry now" });
    const r = (await retry.boundingBox())!;
    const hit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x!, y!)?.textContent,
      [r.x + r.width / 2, r.y + r.height / 2],
    );
    expect(hit).toBe("Retry now");
    // The strip, the footer and the composer agree.
    await expect(page.locator(".rail-footer")).toContainText("Reconnecting…");
    await expect(page.locator(".rail-footer .status-dot")).toHaveAttribute(
      "data-status",
      "reconnecting",
    );
  });

  test("hides transcript text at its height", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openFixture(page, `scene=reconnecting&${OTTO_DISK}`, "light");
    const mask = await page
      .getByTestId("transcript")
      .evaluate((element) => getComputedStyle(element).maskImage);
    // Transparent down to 90px (the strip's foot and a 2px gap), opaque from 98px.
    expect(mask).toMatch(/rgba\(0, 0, 0, 0\) 90px, rgb\(0, 0, 0\) 98px/);
  });

  test("Retry now catches up, then says Synced", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openFixture(page, `scene=reconnecting&${OTTO_DISK}`, "light");
    const before = await page.locator(".rail").boundingBox();
    await page.getByRole("button", { name: "Retry now" }).click();
    await expect(page.getByTestId("status-strip")).toContainText("catching up");
    await expect(page.getByTestId("status-strip")).toContainText("Synced");
    await expect(page.getByTestId("transcript-turn")).not.toHaveCount(0);
    expect(await page.locator(".rail").boundingBox()).toEqual(before);
  });

  test("a task with nothing saved waits for the gateway instead of loading forever", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openFixture(page, `scene=reconnecting-unloaded&${OTTO_DISK}`, "light");
    await expect(page.getByTestId("status-strip")).toContainText(/Reconnecting/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Waiting for the gateway");
    await expect(page.locator(".skeleton")).toHaveCount(0);
  });

  test("a task that failed to sync is the strip's news while the footer stays connected", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1240, height: 800 });
    await openFixture(page, `scene=sync-failed&${OTTO_DISK}`, "light");
    await expect(page.getByTestId("status-strip")).toContainText("Couldn't sync this task");
    await expect(page.locator(".rail-footer .status-dot")).toHaveAttribute(
      "data-status",
      "connected",
    );
    await expect(page.locator(".load-note")).toHaveCount(0);
  });
});

test.describe("the phone", () => {
  test.use(contextFor(PHONE, "light"));

  test("tapping a bot with several tasks unfolds it in place; a task opens; Back returns", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    await page.getByRole("button", { name: "Back to bots" }).click();
    await bot(page, "Pip").tap();
    await expect(bot(page, "Pip")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".conversation")).toBeHidden();
    await page.getByRole("list", { name: "Pip's tasks" }).getByText("Birthday dinner").tap();
    await expect(page.getByRole("heading", { level: 1, name: "Birthday dinner" })).toBeVisible();
    await page.getByRole("button", { name: "Back to bots" }).tap();
    await expect(bot(page, "Pip")).toHaveAttribute("aria-expanded", "true");
  });

  test("Work is a full-width sheet", async ({ page }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}&panel=open`, "light");
    const box = (await page.getByTestId("work-panel").boundingBox())!;
    expect(box.width).toBe(390);
    await expect(page.getByTestId("work-panel")).toHaveAttribute("role", "dialog");
  });
});
