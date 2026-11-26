// The shell's behaviour on fixed state (visual-language.md, section 14, step 9).
// These need no gateway; e2e/preview.spec.ts checks the same shell against one.
import type { ClawtrateState } from "../packages/core/src/index.ts";
import { expect, test, type Page } from "@playwright/test";
import { DOCK_FROM } from "../packages/ui/src/layout.ts";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES } from "./fixture.ts";
import { markReadingLine, readingLineSamples, watchReadingLine } from "./reading-line.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;

/** A bot's row in the rail, by its name ("Otto, working, 14 tasks, unread"). */
const bot = (page: Page, name: string) =>
  page.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${name}\\b`) });

test.describe("the rail", () => {
  test.use(contextFor(WIDE, "light"));

  test("a bot with several tasks unfolds while open, shows six, then all fourteen", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    const otto = bot(page, "Otto");
    await expect(otto).toHaveAttribute("aria-expanded", "true");
    await expect(otto).toHaveAccessibleName(
      "Otto, working, 14 tasks, unread, home server operations",
    );
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
    await expect(bot(page, "Otto").locator(".presence[data-state='working']")).toBeVisible();
    await expect(bot(page, "Otto").locator(".unread-dot")).toBeVisible();
  });

  test("a task chosen in the rail stays open when a newer task of its bot appears", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    await bot(page, "Pip").click();
    // Nothing remembered for Pip: its newest task shows, and the person chooses that very task.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Plan the week");
    await page.getByRole("list", { name: "Pip's tasks" }).getByText("Plan the week").click();
    // Another task of Pip's starts, newer than every other.
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState(change: (state: never) => unknown): void };
        }
      ).clawtrateFixture;
      fixture.setState(((state: {
        tasksByBot: Record<string, Array<{ key: string; title: string; updatedAt: number | null }>>;
      }) => {
        const pip = state.tasksByBot.pip!;
        const newer = {
          ...pip[0]!,
          key: "agent:pip:newer",
          title: "A newer task",
          updatedAt: Date.now() + 60_000,
        };
        return { ...state, tasksByBot: { ...state.tasksByBot, pip: [newer, ...pip] } };
      }) as never);
    });
    await expect(page.getByRole("list", { name: "Pip's tasks" })).toContainText("A newer task");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Plan the week");
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
    // Recent activity first: Otto's run is the newest.
    await page.keyboard.press("Home");
    await expect(bot(page, "Otto")).toBeFocused();
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
    // Dark is also what an empty store gives, so the save itself is checked.
    expect(await page.evaluate(() => localStorage.getItem("clawtrate.theme"))).toBe("dark");
    await page.goto(`/?scene=main&${OTTO_DISK}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page
      .getByRole("button", { name: /Open the gateway menu\.$/ })
      .last()
      .click();
    await page.getByRole("menuitemradio", { name: "Match the system" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
    expect(await page.evaluate(() => localStorage.getItem("clawtrate.theme"))).toBe("system");
  });

  test("draws a stored Light before the bundle runs, even on a dark system", async ({
    browser,
  }) => {
    const context = await browser.newContext(contextFor(WIDE, "dark"));
    const page = await context.newPage();
    await page.goto(`/?scene=main&${OTTO_DISK}`);
    await page.evaluate(() => localStorage.setItem("clawtrate.theme", "light"));
    // Hold the app's bundle: until it runs, only the page's head and stylesheet draw.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/assets\/index-[^/]*\.js$/, async (route) => {
      await held;
      await route.continue();
    });
    await page.reload({ waitUntil: "commit" });
    const early = () =>
      page.evaluate(() => {
        const root = document.documentElement;
        return {
          theme: root.dataset.theme,
          scheme: getComputedStyle(root).colorScheme,
          ground: getComputedStyle(root).getPropertyValue("--bg").trim(),
          meta: document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')?.content,
          rendered: (document.getElementById("root")?.childElementCount ?? 0) > 0,
        };
      });
    // The stylesheet is in once the root's ground is set.
    await expect.poll(async () => (await early()).ground, { timeout: 5_000 }).not.toBe("");
    expect(await early()).toEqual({
      theme: "light",
      scheme: "light",
      ground: "#fff",
      meta: "light",
      rendered: false,
    });
    release();
    await page.locator(".app").waitFor();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await context.close();
  });

  test("opens dark with no theme chosen, even on a light system, and says Dark is the default", async ({
    page,
    browser,
  }) => {
    const scheme = (on: Page) =>
      on.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
    // Before any script runs, the stylesheet alone draws the dark theme.
    const noScript = await browser.newContext({
      ...contextFor(WIDE, "light"),
      javaScriptEnabled: false,
    });
    const bare = await noScript.newPage();
    await bare.goto(`/?scene=main&${OTTO_DISK}`);
    expect(await scheme(bare)).toBe("dark");
    await noScript.close();

    // The system is light here, the address names no theme and nothing is stored.
    await page.goto(`/?scene=main&${OTTO_DISK}`);
    await page.locator(".app").waitFor();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await scheme(page)).toBe("dark");
    await page
      .getByRole("button", { name: /Open the gateway menu\.$/ })
      .last()
      .click();
    const dark = page.getByRole("menuitemradio", { name: "Dark" });
    await expect(dark).toHaveAttribute("aria-checked", "true");
    await expect(dark).toHaveAccessibleDescription("The default");
    // Match the system follows this light system; Light is light anywhere.
    await page.getByRole("menuitemradio", { name: "Match the system" }).click();
    await expect.poll(() => scheme(page)).toBe("light");
  });

  test("shows nothing that would do nothing on a read-only connection", async ({ page }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    await expect(page.getByRole("button", { name: /^New/ })).toHaveCount(0);
    // Search exists, so it is shown; nothing that creates is.
    await expect(page.getByRole("button", { name: /Search/ })).toHaveCount(1);
    await expect(page.getByRole("textbox")).toHaveCount(0);
    // The access bar stands in the composer's place, and asking for access is its one action.
    await expect(page.getByRole("region", { name: "Access" })).toContainText("Read-only.");
    await expect(page.getByRole("button", { name: "Request access" })).toBeVisible();
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
    await expect(page.getByRole("tab", { name: "Settings" })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Details" })).toBeFocused();
  });

  // The reader is mid-transcript, above the follow threshold, with the text at
  // the reading line (100px down, just under the protected band) marked. Then
  // the reading width changes and the replies reflow. The marked character
  // must stay where it was.
  const readFrom = async (page: Page, scrollTop: number) => {
    const transcript = page.getByTestId("transcript");
    await transcript.evaluate((e, top) => (e.scrollTop = top), scrollTop);
    await settle(page);
    expect(
      await transcript.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight),
      "the reader is above the follow threshold",
    ).toBeGreaterThan(96);
    return transcript.evaluate((scroller) => {
      const box = scroller.getBoundingClientRect();
      const column = scroller.querySelector(".transcript-inner")!.getBoundingClientRect();
      const caret = document.caretRangeFromPoint(column.left + 40, box.top + 100)!;
      const length = caret.startContainer.textContent?.length ?? 0;
      const at = Math.max(0, Math.min(caret.startOffset, length - 1));
      const mark = document.createRange();
      mark.setStart(caret.startContainer, at);
      mark.setEnd(caret.startContainer, Math.min(at + 1, length));
      (window as unknown as { readingMark: Range }).readingMark = mark;
      return { text: mark.toString(), top: mark.getBoundingClientRect().top - box.top };
    });
  };
  const readingMarkTop = (page: Page) =>
    page.getByTestId("transcript").evaluate((scroller) => {
      const mark = (window as unknown as { readingMark: Range }).readingMark;
      return mark.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    });

  test("resizing across the docking width with Work open keeps the text at the reading line", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openFixture(page, `scene=main&${OTTO_DISK}&panel=open`, "light");
    const transcript = page.getByTestId("transcript");
    await transcript.evaluate((e) => (e.scrollTop = 450));
    await settle(page);
    expect(
      await transcript.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight),
      "the reader is above the follow threshold",
    ).toBeGreaterThan(96);
    // The place as the conversation itself holds it, not a point of the check's choosing.
    const before = await markReadingLine(page);
    expect(before.text.trim()).not.toBe("");
    const panel = page.getByTestId("work-panel");
    for (const width of [1240, 1100, 1440]) {
      await watchReadingLine(page);
      await page.setViewportSize({ width, height: 900 });
      // The pane's state for this width, established before anything is measured: docked beside
      // the conversation, or a modal drawer over it that holds focus. The layout (the
      // stylesheet's container query) and the semantics (the Shell's measured width) agree.
      const docked = await page
        .locator(".main-pane")
        .evaluate((main, from) => main.clientWidth >= from, DOCK_FROM);
      expect(docked, `docked at ${width}px`).toBe(width !== 1100);
      await expect
        .poll(() => panel.evaluate((element) => getComputedStyle(element).position))
        .toBe(docked ? "relative" : "absolute");
      if (docked) {
        await expect(panel).not.toHaveAttribute("role", "dialog");
        await expect(page.getByRole("region", { name: "Conversation" })).not.toHaveAttribute(
          "inert",
          "",
        );
      } else {
        await expect(panel).toHaveAttribute("role", "dialog");
        await expect(panel).toHaveAttribute("aria-modal", "true");
        await expect
          .poll(() => panel.evaluate((element) => element.contains(document.activeElement)))
          .toBe(true);
      }
      await settle(page);
      await settle(page);
      // Every painted frame of the change, and where it is now.
      const { samples, now } = await readingLineSamples(page);
      const worst = Math.max(...[...samples, now].map((top) => Math.abs(top - before.top)));
      expect(
        worst,
        `text at the reading line, ${width}px, from ${before.top}: ${[...samples, now].map((top) => top.toFixed(1)).join(" ")}`,
      ).toBeLessThanOrEqual(2);
    }
  });

  test("opening and closing Work at the docking width keeps the text at the reading line", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1240, height: 900 });
    await openFixture(page, `scene=main&${OTTO_DISK}&panel=closed`, "light");
    const before = await readFrom(page, 400);
    const width = await page.locator(".transcript-inner").evaluate((e) => e.clientWidth);
    await page.getByRole("button", { name: "Show work panel" }).click();
    await settle(page);
    // The reading width did change, so the replies reflowed.
    expect(await page.locator(".transcript-inner").evaluate((e) => e.clientWidth)).toBeLessThan(
      width,
    );
    expect(Math.abs((await readingMarkTop(page)) - before.top)).toBeLessThanOrEqual(2);
    await page.getByRole("button", { name: "Hide work panel" }).click();
    await settle(page);
    expect(Math.abs((await readingMarkTop(page)) - before.top)).toBeLessThanOrEqual(2);
  });

  test("a reader following the end stays at the end when the width changes", async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 900 });
    await openFixture(page, `scene=main&${OTTO_DISK}&panel=closed`, "light");
    const transcript = page.getByTestId("transcript");
    const atEnd = () =>
      transcript.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight < 2);
    expect(await atEnd()).toBe(true);
    await page.getByRole("button", { name: "Show work panel" }).click();
    await settle(page);
    expect(await atEnd()).toBe(true);
    await page.setViewportSize({ width: 1100, height: 900 });
    await settle(page);
    expect(await atEnd()).toBe(true);
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

  test("Synced waits for the open task to reload, and a failed reload is never called synced", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openFixture(page, `scene=sync-pending&${OTTO_DISK}`, "light");
    const strip = page.getByTestId("status-strip");
    // Bots and tasks are back; the open task's history has not reloaded.
    await expect(strip).toContainText("catching up");
    await page.waitForTimeout(500);
    await expect(strip).toContainText("catching up");
    await expect(strip).not.toContainText("Synced");

    // The reload fails: the strip says so, never Synced.
    await page.evaluate((key) => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState(change: (s: Record<string, unknown>) => unknown): void };
        }
      ).clawtrateFixture;
      fixture.setState((s) => {
        const transcripts = s.transcripts as Record<string, Record<string, unknown>>;
        return {
          ...s,
          transcripts: {
            ...transcripts,
            [key]: { ...transcripts[key], status: "error", error: "timed out" },
          },
        };
      });
    }, "agent:otto:disk-space");
    await expect(strip).toContainText("Couldn't sync this task");
    await expect(page.locator(".load-note")).toHaveCount(0);

    // Try again succeeds: now, and only now, Synced.
    await page.evaluate((key) => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState(change: (s: Record<string, unknown>) => unknown): void };
        }
      ).clawtrateFixture;
      fixture.setState((s) => {
        const transcripts = s.transcripts as Record<string, Record<string, unknown>>;
        return {
          ...s,
          transcripts: {
            ...transcripts,
            [key]: {
              ...transcripts[key],
              status: "ready",
              error: null,
              loadedAt: Date.now() + 1000,
            },
          },
        };
      });
    }, "agent:otto:disk-space");
    await expect(strip).toContainText("Synced");
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

test.describe("a failed history", () => {
  test.use(contextFor(WIDE, "light"));

  const KEY = "agent:otto:disk-space";
  const BACKUP = "agent:otto:backup-check";
  const CERT = "agent:otto:cert-renewal";
  type Command = { type: string; key: string };
  /** The fixture bridge's controls for these checks (apps/desktop/src/fixture/bridge-fixture.ts). */
  type Fixture = {
    setState(change: (state: ClawtrateState) => ClawtrateState): void;
    send(command: Command): Promise<unknown>;
    sendFrom(view: string, command: Command): Promise<unknown>;
    refuseReopen(key: string, error: string): void;
    hold(): void;
    release(): void;
    holdSnapshots(): void;
    releaseSnapshots(): void;
    reads: string[];
    sent: Command[];
    holds(key: string): number;
  };
  type Refusal = { type: string; key: string; error: string; afterMs?: number; held?: boolean };
  type Refusing = Fixture & { refusals: Refusal[]; held: Array<() => void> };

  const holds = (page: Page, key = KEY) =>
    page.evaluate(
      (key) => (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.holds(key),
      key,
    );
  const reads = (page: Page, key = KEY) =>
    page.evaluate(
      (key) =>
        (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.reads.filter(
          (each) => each === key,
        ).length,
      key,
    );
  const reloads = (page: Page, key = KEY) =>
    page.evaluate(
      (key) =>
        (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.sent.filter(
          (each) => each.type === "reloadSession" && each.key === key,
        ).length,
      key,
    );
  /** What another view, such as a second web tab, asks of the same host. */
  const otherView = (page: Page, type: "openSession" | "closeSession") =>
    page.evaluate(
      ([type, key]) =>
        (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.sendFrom("other", {
          type,
          key,
        }),
      [type, KEY] as const,
    );
  /**
   * The host refuses each of these commands once, after `afterMs` if given or once `answer` is
   * called if `held`, as it refuses an open with every task slot taken or a reread from a view
   * that no longer holds the task.
   */
  const refuse = (page: Page, refusals: Refusal[]) =>
    page.evaluate((refusals) => {
      const fixture = (window as unknown as { clawtrateFixture: Refusing }).clawtrateFixture;
      if (!fixture.refusals) {
        fixture.refusals = [];
        fixture.held = [];
        const send = fixture.send.bind(fixture);
        fixture.send = async (command) => {
          const at = fixture.refusals.findIndex(
            (each) => each.type === command.type && each.key === command.key,
          );
          if (at < 0) return send(command);
          const [refusal] = fixture.refusals.splice(at, 1);
          if (refusal!.held) await new Promise<void>((resolve) => fixture.held.push(resolve));
          else if (refusal!.afterMs)
            await new Promise((resolve) => setTimeout(resolve, refusal!.afterMs));
          throw new Error(refusal!.error);
        };
      }
      fixture.refusals.push(...refusals);
    }, refusals);
  /** Send every held refusal. */
  const answer = (page: Page) =>
    page.evaluate(() => {
      for (const send of (
        window as unknown as { clawtrateFixture: Refusing }
      ).clawtrateFixture.held.splice(0))
        send();
    });
  /** Drop a task's loaded history, as the engine has none for a task nobody holds. */
  const unload = (page: Page, keys: string[]) =>
    page.evaluate(
      (keys) =>
        (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.setState((s) => {
          const transcripts = { ...s.transcripts };
          for (const key of keys) delete transcripts[key];
          return { ...s, transcripts };
        }),
      keys,
    );
  /** The gateway fails to read the open task's history; `keepItems` keeps what was shown. */
  const fail = (page: Page, keepItems: boolean, key = KEY) =>
    page.evaluate(
      ([key, keepItems]) =>
        (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.setState((s) => ({
          ...s,
          transcripts: {
            ...s.transcripts,
            [key]: {
              ...s.transcripts[key]!,
              status: "error",
              error: "chat.history timed out after 15 seconds.",
              items: keepItems ? s.transcripts[key]!.items : [],
              live: null,
            },
          },
        })),
      [key, keepItems] as const,
    );
  const otto = (page: Page, title: string) =>
    page.getByRole("list", { name: "Otto's tasks" }).getByText(title).click();
  const SLOTS = "At most 8 tasks can be open at once.";

  test("F-105: Try again reads a task that another view also holds once, and both views can still let it go", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    await expect(page.getByTestId("transcript-turn")).not.toHaveCount(0);
    await otherView(page, "openSession");
    expect(await holds(page)).toBe(2);
    await fail(page, false);
    await expect(page.getByText("Could not load this conversation")).toBeVisible();
    const before = await reads(page);

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("transcript-turn")).not.toHaveCount(0);
    expect(await reads(page)).toBe(before + 1);
    expect(await holds(page)).toBe(2);

    await otherView(page, "closeSession");
    expect(await holds(page)).toBe(1);
    await otto(page, "Weekly backup check");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Weekly backup check");
    await expect.poll(() => holds(page)).toBe(0);
  });

  test("F-105: a duplicate open from the same view reads a failed task no more than once", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    await expect(page.getByTestId("transcript-turn")).not.toHaveCount(0);
    await fail(page, false);
    await expect(page.getByText("Could not load this conversation")).toBeVisible();
    const before = await reads(page);
    // The same view opens the task it already holds, as the real ViewerSession has it: a no-op.
    await page.evaluate(
      (key) =>
        (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.send({
          type: "openSession",
          key,
        }),
      KEY,
    );
    await page.waitForTimeout(150);
    expect(await reads(page)).toBe(before);
    expect(await holds(page)).toBe(1);
  });

  test("F-105: Try again opens a task whose open was refused once a slot frees up, and reads it once", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    // Every task slot is taken, and this task's history isn't loaded.
    await refuse(page, [{ type: "openSession", key: BACKUP, error: SLOTS }]);
    await unload(page, [BACKUP]);
    await otto(page, "Weekly backup check");
    await expect(page.getByText("Could not load this conversation")).toBeVisible();
    await expect(page.getByText(SLOTS)).toBeVisible();

    // A slot has freed up: the next open is taken.
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("transcript-turn")).not.toHaveCount(0);
    expect(await reads(page, BACKUP)).toBe(1);
    expect(await holds(page, BACKUP)).toBe(1);
  });

  test("F-105: a late refusal of the task left behind doesn't hide the open task's own refusal", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    await refuse(page, [
      { type: "openSession", key: BACKUP, error: SLOTS, held: true },
      { type: "openSession", key: CERT, error: SLOTS },
    ]);
    await unload(page, [BACKUP, CERT]);
    await otto(page, "Weekly backup check");
    await otto(page, "Certificate renewal warning");
    await expect(page.locator(".title-pill-task")).toHaveText("Certificate renewal warning");
    await expect(page.getByText(SLOTS)).toBeVisible();
    // The task left behind is refused after the open one.
    await answer(page);
    await settle(page);
    await expect(page.getByText(SLOTS)).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("transcript-turn")).not.toHaveCount(0);
    expect(await reads(page, CERT)).toBe(1);
  });

  test("F-105: Try again in a view the host no longer counts as holding the task opens it again and reads it once", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    await expect(page.getByTestId("transcript-turn")).not.toHaveCount(0);
    // Another view holds the task; the host dropped this view's hold, as after a reconnect
    // whose reopen it refused, so it refuses this view's reread.
    await otherView(page, "openSession");
    await page.evaluate(
      (key) =>
        (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.send({
          type: "closeSession",
          key,
        }),
      KEY,
    );
    expect(await holds(page)).toBe(1);
    await fail(page, false);
    const before = await reads(page);

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("transcript-turn")).not.toHaveCount(0);
    expect(await reads(page)).toBe(before + 1);
    expect(await holds(page)).toBe(2);
    expect(errors).toEqual([]);
  });

  test("F-105: a task the host refuses to open again after a reconnect says why and offers Try again", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    await expect(page.getByTestId("transcript-turn")).not.toHaveCount(0);
    const before = await reads(page);
    await page.evaluate(
      ([key, error]) =>
        (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.refuseReopen(
          key,
          error,
        ),
      [KEY, SLOTS] as const,
    );
    await expect(page.getByText("Could not load this conversation")).toBeVisible();
    await expect(page.getByText(SLOTS)).toBeVisible();
    expect(await holds(page)).toBe(0);

    // A slot has freed up: Try again, refused as a reread, opens the task again.
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("transcript-turn")).not.toHaveCount(0);
    expect(await reads(page)).toBe(before + 1);
    expect(await holds(page)).toBe(1);
  });

  test("F-105: refusing a reopen while another view holds the task shows why without crashing the page", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    await expect(page.getByTestId("transcript-turn")).not.toHaveCount(0);
    await otherView(page, "openSession");
    expect(await holds(page)).toBe(2);

    await page.evaluate(
      ([key, error]) =>
        (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.refuseReopen(
          key,
          error,
        ),
      [KEY, SLOTS] as const,
    );
    await expect(page.getByText("Could not load this conversation")).toBeVisible();
    await expect(page.getByText(SLOTS)).toBeVisible();
    expect(await holds(page)).toBe(1);
    expect(errors).toEqual([]);

    // Once a slot frees up, Try again opens the task again without re-reading the shared history.
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("transcript-turn")).not.toHaveCount(0);
    expect(await holds(page)).toBe(2);
    expect(errors).toEqual([]);
  });

  test("F-105: a refusal of Try again that comes after the task was left doesn't open it again", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    await expect(page.getByTestId("transcript-turn")).not.toHaveCount(0);
    await refuse(page, [
      {
        type: "reloadSession",
        key: KEY,
        error: "That task isn't open in this view.",
        held: true,
      },
    ]);
    await fail(page, false);
    await page.getByRole("button", { name: "Try again" }).click();
    await otto(page, "Weekly backup check");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Weekly backup check");
    await expect.poll(() => holds(page)).toBe(0);
    await answer(page);
    expect(await holds(page)).toBe(0);
  });

  test("F-105: Try again reads a task again once the host reopened it after an open lost the host", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    // The web preview's link to its host is down when the Shell opens the task.
    await refuse(page, [
      { type: "openSession", key: BACKUP, error: "Not connected to the preview host" },
    ]);
    await otto(page, "Weekly backup check");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Weekly backup check");
    // The next hello opens the task again on the host, outside the Shell.
    await page.evaluate(
      (key) =>
        (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.send({
          type: "openSession",
          key,
        }),
      BACKUP,
    );
    expect(await holds(page, BACKUP)).toBe(1);
    await fail(page, true, BACKUP);
    const note = page.locator(".load-note");
    await expect(note).toContainText("Couldn't refresh this conversation.");
    const before = await reads(page, BACKUP);

    await note.getByRole("button", { name: "Try again" }).click();
    await expect(note).toHaveCount(0);
    expect(await reads(page, BACKUP)).toBe(before + 1);
    expect(await holds(page, BACKUP)).toBe(1);
  });

  test("F-105: Try again on a refresh that failed keeps what was shown while the task is read again, once", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    const turns = await page.getByTestId("transcript-turn").count();
    expect(turns).toBeGreaterThan(0);
    await fail(page, true);
    const note = page.locator(".load-note");
    await expect(note).toContainText("Couldn't refresh this conversation.");
    const before = await reads(page);

    // The read is held, so what shows until it answers can be seen.
    await page.evaluate(() =>
      (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.hold(),
    );
    await note.getByRole("button", { name: "Try again" }).click();
    await expect(note).toHaveCount(0);
    await expect(page.getByTestId("transcript-turn")).toHaveCount(turns);
    await page.evaluate(() =>
      (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.release(),
    );
    await expect.poll(() => reads(page)).toBe(before + 1);
    await expect(page.getByTestId("transcript-turn")).toHaveCount(turns);
    expect(await holds(page)).toBe(1);
  });

  test("F-105: two quick clicks on Try again read a failed task once, not twice", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    const turns = await page.getByTestId("transcript-turn").count();
    expect(turns).toBeGreaterThan(0);
    await fail(page, true);
    const note = page.locator(".load-note");
    await expect(note).toContainText("Couldn't refresh this conversation.");
    const reloadsBefore = await reloads(page);

    // The read is held, so a second click lands while the first reload is still in flight.
    await page.evaluate(() =>
      (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.hold(),
    );
    // Two clicks in one turn, before React removes the button: only the first sends a command.
    await page.evaluate(() => {
      const button = [...document.querySelectorAll(".load-note button")].find(
        (each) => each.textContent?.trim() === "Try again",
      ) as HTMLButtonElement | undefined;
      button?.click();
      button?.click();
    });
    await page.evaluate(() =>
      (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.release(),
    );
    await page.waitForTimeout(150);
    expect(await reloads(page)).toBe(reloadsBefore + 1);
    expect(await holds(page)).toBe(1);
  });

  test("F-105: clicking Try again a second time before the loading snapshot arrives still reads once", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    const turns = await page.getByTestId("transcript-turn").count();
    expect(turns).toBeGreaterThan(0);
    await fail(page, true);
    const note = page.locator(".load-note");
    await expect(note).toContainText("Couldn't refresh this conversation.");
    const before = await reads(page);
    const reloadsBefore = await reloads(page);

    // Hold both the read's answer and state snapshots so the first command settles while Try again
    // is still visible, then send a second click in a later turn.
    await page.evaluate(() => {
      const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
      fixture.hold();
      fixture.holdSnapshots();
    });
    await note.getByRole("button", { name: "Try again" }).click();
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    await note.getByRole("button", { name: "Try again" }).click();

    await page.evaluate(() => {
      const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
      fixture.releaseSnapshots();
      fixture.release();
    });
    await expect(note).toHaveCount(0);
    await expect.poll(() => reads(page)).toBe(before + 1);
    expect(await reloads(page)).toBe(reloadsBefore + 1);
    await expect(page.getByTestId("transcript-turn")).toHaveCount(turns);
    expect(await holds(page)).toBe(1);
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

/** The state each strip scene ends in. */
const STRIP_STATES: Record<string, RegExp> = {
  "discovery-error": /Couldn't load/,
  "offline-long-address": /Can't reach/,
  offline: /Can't reach/,
  "sync-failed": /Couldn't sync this task/,
};

for (const width of [320, 390]) {
  test.describe(`the strip on a ${width}px phone`, () => {
    test.use(contextFor({ ...PHONE, width, height: 700 }, "light"));
    for (const scene of ["discovery-error", "offline-long-address", "offline", "sync-failed"]) {
      test(`keeps its state clear of its action: ${scene}`, async ({ page }) => {
        await openFixture(page, `scene=${scene}&${OTTO_DISK}`, "light");
        const strip = page.getByTestId("status-strip");
        // The scene's own state, once it has reached it: sync-failed passes through Reconnecting.
        await expect(strip.locator("strong")).toContainText(STRIP_STATES[scene]!);
        const retry = strip.getByRole("button", { name: /^(Retry now|Reconnect|Try again)$/ });
        await expect(retry).toBeVisible();
        if (scene === "discovery-error") {
          // The gateway's message is behind its disclosure, and the state still reads in full.
          await expect(strip.getByRole("button", { name: "Gateway's message" })).toBeVisible();
          expect(
            await strip.locator("strong").evaluate((el) => el.scrollWidth <= el.clientWidth),
          ).toBe(true);
        }
        const state = (await strip.locator("strong").boundingBox())!;
        const action = (await strip.getByRole("button").first().boundingBox())!;
        const box = (await strip.boundingBox())!;
        expect(state.x + state.width, "the state ends before the action").toBeLessThanOrEqual(
          action.x,
        );
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        // The whole line stays reachable: in the strip's text and its tooltip.
        expect(await strip.getAttribute("title")).toMatch(/·|Couldn't sync/);
      });
    }
  });
}

/** The focused element, and whether it can be seen. */
async function focused(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return { tag: "BODY", text: "", visible: false };
    const rect = active.getBoundingClientRect();
    return {
      tag: active.tagName,
      text: (active.getAttribute("aria-label") ?? active.textContent ?? "").trim(),
      visible: rect.width > 0 && rect.height > 0 && active.getClientRects().length > 0,
    };
  });
}

test.describe("focus across the phone's two panes", () => {
  test.use(contextFor(PHONE, "light"));

  test("Back puts focus on the row that opened the conversation, and a task puts it on its heading", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    await page.getByRole("button", { name: "Back to bots" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".conversation")).toBeHidden();
    expect(await focused(page)).toMatchObject({
      tag: "BUTTON",
      text: "Disk almost full on the media box",
      visible: true,
    });

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.locator(".conversation")).toBeVisible();
    expect(await focused(page)).toMatchObject({
      tag: "H1",
      text: "Weekly backup check",
      visible: true,
    });
  });
});

test.describe("focus when Work closes", () => {
  test.use(contextFor(WIDE, "light"));

  test("closing the docked pane returns focus to the control that opened it", async ({ page }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}&panel=closed`, "light");
    // Opened from the title pill, closed from inside the pane.
    await page.locator(".title-pill").focus();
    await page.keyboard.press("Enter");
    const close = page.getByRole("button", { name: "Close work panel" }).last();
    await close.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("work-panel")).toHaveCount(0);
    await expect(page.locator(".title-pill")).toBeFocused();

    // Opened by the address, so with no opener: focus goes to the Work toggle.
    await openFixture(page, `scene=main&${OTTO_DISK}&panel=open`, "light");
    await page.getByRole("button", { name: "Close work panel" }).last().focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Show work panel" })).toBeFocused();
  });
});

test.describe("the connection screens", () => {
  test.use(contextFor(WIDE, "light"));

  test("a pairing check that finds nothing keeps focus on Check now", async ({ page }) => {
    await openFixture(page, "scene=pairing", "light");
    const check = page.getByRole("button", { name: /Check now|Checking…/ });
    await check.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "Not approved yet" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Check now" })).toBeFocused();
    // Enter checks again; the fixture's second check is approved.
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("bot").first()).toBeVisible();
  });
});

test.describe("the connection screen on a phone", () => {
  test.use(contextFor(PHONE, "light"));

  test("fields take the touch text size", async ({ page }) => {
    await openFixture(page, "scene=connect", "light");
    for (const field of await page.locator(".input").all()) {
      expect(await field.evaluate((e) => getComputedStyle(e).fontSize)).toBe("17px");
      expect(await field.evaluate((e) => getComputedStyle(e, "::placeholder").fontSize)).toBe(
        "17px",
      );
    }
  });
});

test.describe("a task row's time", () => {
  test.use(contextFor(WIDE, "light"));

  test("each row shows its latest activity, aligned, without growing the row", async ({ page }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    const rows = page.getByRole("list", { name: "Otto's tasks" }).getByTestId("task");
    await expect(rows).toHaveCount(6);
    const measured = await rows.evaluateAll((buttons) =>
      buttons.map((button) => ({
        height: button.getBoundingClientRect().height,
        time: button.querySelector(".task-time")?.textContent ?? "",
        size: getComputedStyle(button.querySelector(".task-time")!).fontSize,
        right: button.querySelector(".task-time")!.getBoundingClientRect().right,
        description: button.getAttribute("aria-description") ?? "",
      })),
    );
    expect(measured.map((row) => row.time)).toEqual([
      "now",
      "5:36 PM",
      "2:34 PM",
      "Yesterday",
      "Sat",
      "Fri",
    ]);
    for (const row of measured) {
      expect(row.height).toBe(34);
      expect(row.size).toBe("12px");
      // Rows with a mark (running, unread) and without one share the time's edge.
      expect(Math.abs(row.right - measured[0]!.right)).toBeLessThan(0.5);
      expect(row.description).toBe(`Last activity ${row.time}`);
    }
  });
});

test.describe("the strip at twice the pixel density", () => {
  test.use({ ...contextFor(PHONE, "light"), deviceScaleFactor: 2 });

  test("the state is not shortened while the explanation can give way", async ({ page }) => {
    await openFixture(page, `scene=offline&${OTTO_DISK}`, "light");
    await page.evaluate(() =>
      (
        window as unknown as {
          clawtrateFixture: { setState(f: (s: { connection: object }) => object): void };
        }
      ).clawtrateFixture.setState((s) => ({
        ...s,
        connection: {
          ...s.connection,
          error: {
            code: "GATEWAY_NOT_ALLOWED",
            message: "This host is not allowed to connect to ws://127.0.0.1:19580.",
            hint: null,
          },
        },
      })),
    );
    const state = page.getByTestId("status-strip").locator("strong");
    await expect(state).toContainText("Can't reach the gateway");
    // Fractional widths: the shown text fits its box, so no ellipsis is drawn.
    const fit = await state.evaluate((e) => {
      const shown = [...e.children].find((c) => getComputedStyle(c).display !== "none")!;
      const range = document.createRange();
      range.selectNodeContents(shown);
      return { text: range.getBoundingClientRect().width, box: e.getBoundingClientRect().width };
    });
    expect(fit.text).toBeLessThanOrEqual(fit.box + 0.01);
  });
});
