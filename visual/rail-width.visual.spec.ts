// The sidebar's width (#792): its edge is dragged, or moved by keyboard, between the rail of
// pictures and the widest width; a double-click or Enter goes back to the default; this device
// keeps the width. In the rail each bot is its picture, named by its tooltip and its accessible
// name, with the unread dot, and the buttons stack at the bottom. At phone width nothing changes.
import { test, type Page } from "@playwright/test";
import { contextFor, expect, openFixture, OTTO_DISK, showList, SIZES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.name === "phone")!;

const edge = (page: Page) => page.getByRole("separator", { name: "Sidebar width" });
const rail = (page: Page) => page.getByRole("navigation", { name: "Bots" });
const railWidth = async (page: Page) => Math.round((await rail(page).boundingBox())!.width);
const kept = (page: Page) => page.evaluate(() => localStorage.getItem("clawtrate.railWidth"));
const bot = (page: Page, name: string) =>
  page.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${name}\\b`) });

/** Press on the edge's middle and move the pointer to `to`, in steps, then let go there. */
async function drag(page: Page, to: number, { release = true, steps = 12 } = {}) {
  const box = (await edge(page).boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(to, y, { steps });
  if (release) await page.mouse.up();
}

test.describe("the sidebar's width, desktop", () => {
  test.use(contextFor(WIDE, "dark"));

  test("#792: the edge is a separator a screen reader can read: its name, limits and value", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`);
    await expect(edge(page)).toHaveAttribute("aria-orientation", "vertical");
    await expect(edge(page)).toHaveAttribute("aria-valuemin", "72");
    await expect(edge(page)).toHaveAttribute("aria-valuemax", "400");
    await expect(edge(page)).toHaveAttribute("aria-valuenow", "280");
    await expect(edge(page)).toHaveAttribute("aria-valuetext", "280 pixels");
    await expect(edge(page)).toHaveAttribute("aria-controls", "bots-rail");
    await expect(rail(page)).toHaveAttribute("id", "bots-rail");
    expect(await railWidth(page)).toBe(280);
  });

  test("#792: dragged, it follows the pointer over the conversation, selects no text, stops at 400 px, and the width is kept on this device", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`);
    await drag(page, 340, { release: false });
    await expect.poll(() => railWidth(page)).toBe(340);
    await expect(page.locator(".shell")).toHaveAttribute("data-resizing", "true");
    // Far over the conversation: the edge still has the pointer; the width stops at its widest.
    await page.mouse.move(900, 500, { steps: 8 });
    await expect.poll(() => railWidth(page)).toBe(400);
    expect(await page.evaluate(() => getSelection()?.toString() ?? "")).toBe("");
    await page.mouse.up();
    await expect(page.locator(".shell")).not.toHaveAttribute("data-resizing");
    await expect(edge(page)).toHaveAttribute("aria-valuenow", "400");
    expect(await kept(page)).toBe("400");
    // Opened again, the app has it.
    await page.reload();
    await page.locator(".app").waitFor();
    expect(await railWidth(page)).toBe(400);
    await expect(edge(page)).toHaveAttribute("aria-valuenow", "400");
  });

  test("#792: a double-click on the edge goes back to the default width and forgets the kept one", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`);
    await drag(page, 360);
    expect(await railWidth(page)).toBe(360);
    await edge(page).dblclick();
    expect(await railWidth(page)).toBe(280);
    expect(await kept(page)).toBeNull();
  });

  test("#792: by keyboard: arrows move it 8 px, Shift 32, Home to the rail, End to the widest, Enter back to the default", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`);
    await edge(page).focus();
    const now = async (width: number, words = `${width} pixels`) => {
      await expect(edge(page)).toHaveAttribute("aria-valuenow", String(width));
      await expect(edge(page)).toHaveAttribute("aria-valuetext", words);
      expect(await railWidth(page)).toBe(width);
      await expect(edge(page)).toBeFocused();
    };
    await page.keyboard.press("ArrowLeft");
    await now(272);
    await page.keyboard.press("Shift+ArrowRight");
    await now(304);
    await page.keyboard.press("End");
    await now(400);
    expect(await kept(page)).toBe("400");
    await page.keyboard.press("Home");
    await now(72, "Pictures only");
    await expect(rail(page)).toHaveAttribute("data-width", "pictures");
    await page.keyboard.press("ArrowRight");
    await now(208);
    await page.keyboard.press("ArrowLeft");
    await now(72, "Pictures only");
    await page.keyboard.press("Enter");
    await now(280);
    expect(await kept(page)).toBeNull();
  });

  test("#792: dragged under halfway to the narrowest width with names, it is the rail of pictures; it never stops in between", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`);
    await drag(page, 160, { release: false });
    await expect.poll(() => railWidth(page)).toBe(208);
    await page.mouse.move(120, 400, { steps: 4 });
    await expect.poll(() => railWidth(page)).toBe(72);
    await expect(rail(page)).toHaveAttribute("data-width", "pictures");
    await page.mouse.move(150, 400, { steps: 4 });
    await expect.poll(() => railWidth(page)).toBe(208);
    await page.mouse.move(20, 400, { steps: 4 });
    await page.mouse.up();
    expect(await railWidth(page)).toBe(72);
    expect(await kept(page)).toBe("72");
  });

  test("#792: in the rail of pictures each bot is its picture, named by its tooltip and its accessible name, with the unread dot; no task is listed; the buttons stack at the bottom", async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem("clawtrate.railWidth", "72"));
    await openFixture(page, `scene=main&${OTTO_DISK}`);
    expect(await railWidth(page)).toBe(72);
    const pip = bot(page, "Pip");
    await expect(pip).toHaveAccessibleName(/^Pip, .*unread/);
    await expect(pip).toHaveAttribute("title", "Pip");
    await expect(pip.locator(".bot-line")).toBeHidden();
    await expect(pip.locator(".presence")).toBeVisible();
    // The unread dot sits on the picture's top left.
    const dot = (await pip.locator(".rail-unread").boundingBox())!;
    const face = (await pip.locator(".presence").boundingBox())!;
    expect(dot.width).toBe(8);
    expect(dot.x).toBeLessThan(face.x + face.width / 2);
    expect(dot.y).toBeLessThan(face.y + face.height / 2);
    // No task rows and no folds: the open bot's tasks are reached from its picture and search.
    await expect(rail(page).getByTestId("task")).toHaveCount(0);
    await expect(bot(page, "Otto")).not.toHaveAttribute("aria-expanded");
    // Every row and button stays inside the rail.
    for (const each of await rail(page).locator(".bot, .icon-button:visible").all()) {
      const box = (await each.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(72);
    }
    // The buttons are below the bots, the gateway and Settings below them (on a connection that
    // writes, so "New" is there too).
    await openFixture(page, `scene=rail-write&${OTTO_DISK}`);
    expect(await railWidth(page)).toBe(72);
    const lastBot = (await rail(page).locator(".bot").last().boundingBox())!;
    let above = lastBot.y + lastBot.height;
    for (const name of ["Routines", /^Sort bots/, "Search", "New"]) {
      const button = rail(page).getByRole("button", { name, exact: typeof name === "string" });
      const box = (await button.boundingBox())!;
      expect(box.y, String(name)).toBeGreaterThanOrEqual(above);
      above = box.y + box.height;
    }
    const settings = (await rail(page).getByRole("button", { name: "Settings" }).boundingBox())!;
    expect(settings.y).toBeGreaterThanOrEqual(above);
    await expect(rail(page).getByRole("button", { name: /Open the gateway menu/ })).toHaveAttribute(
      "title",
      /Open the gateway menu/,
    );
  });

  test("#792: in the rail, a picture opens its bot, Search opens the search window, and a button's menu opens beside it on screen", async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem("clawtrate.railWidth", "72"));
    await openFixture(page, `scene=main&${OTTO_DISK}`);
    // Pip has several tasks: its picture opens it, rather than unfolding tasks there's no room for.
    await bot(page, "Pip").click();
    await expect(bot(page, "Pip")).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(
      "Disk almost full on the media box",
    );
    await bot(page, "Pip").press("ArrowRight");
    await expect(rail(page).getByTestId("task")).toHaveCount(0);
    // ⌘⇧F has no room for its field here: the search window opens.
    await page.keyboard.press("ControlOrMeta+Shift+F");
    await expect(page.getByRole("dialog", { name: /search/i })).toBeVisible();
    await page.keyboard.press("Escape");
    await rail(page)
      .getByRole("button", { name: /^Sort bots/ })
      .click();
    const menu = page.getByRole("menu", { name: "Sort bots" });
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(72);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(WIDE.height);
  });

  test("#792: a kept width leaves the conversation its room in a smaller window", async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem("clawtrate.railWidth", "400"));
    await page.setViewportSize({ width: 800, height: 700 });
    await openFixture(page, `scene=main&${OTTO_DISK}`);
    expect(await railWidth(page)).toBe(360);
    await expect(edge(page)).toHaveAttribute("aria-valuemax", "360");
    // The kept width is the person's; a wider window gives it back.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(() => railWidth(page)).toBe(400);
  });

  test("#792: a drag writes the width once a frame and renders the shell only where the rail begins and when it ends", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`);
    // Count the shell's style writes and long frames during a 120-step drag.
    await page.evaluate(() => {
      const shell = document.querySelector(".shell") as HTMLElement;
      const record = { writes: 0, frames: [] as number[], last: performance.now() };
      (window as unknown as { dragRecord: typeof record }).dragRecord = record;
      new MutationObserver((list) => (record.writes += list.length)).observe(shell, {
        attributes: true,
        attributeFilter: ["style"],
      });
      const tick = (now: number) => {
        record.frames.push(now - record.last);
        record.last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await drag(page, 400, { steps: 120 });
    const record = await page.evaluate(
      () => (window as unknown as { dragRecord: { writes: number; frames: number[] } }).dragRecord,
    );
    const sorted = [...record.frames].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const measured = `${record.writes} style writes for 120 moves; frame p95 ${p95.toFixed(1)} ms over ${sorted.length} frames`;
    test.info().annotations.push({ type: "drag", description: measured });
    console.log(`drag: ${measured}`);
    // At most one write a frame, never one per move.
    expect(record.writes).toBeLessThanOrEqual(sorted.length + 2);
    expect(record.writes).toBeLessThan(120);
  });
});

test.describe("the sidebar's width, phone", () => {
  test.use(contextFor(PHONE, "dark"));

  test("#792: at phone width the sidebar is the list pane, as before: no edge, and a kept width doesn't apply", async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem("clawtrate.railWidth", "72"));
    await openFixture(page, `scene=main&${OTTO_DISK}`);
    await showList(page);
    await expect(edge(page)).toHaveCount(0);
    expect(await railWidth(page)).toBe(PHONE.width);
    await expect(rail(page)).not.toHaveAttribute("data-width");
    await expect(bot(page, "Pip").locator(".bot-line")).toBeVisible();
  });
});
