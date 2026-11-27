// Parity rows for the bots list: pinned tiles, the primary bot, what a row
// shows, a working bot, hidden bots, the sort order and the manual order.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, showList, SIZES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;

/** A bot's row or tile in the rail, by the start of its accessible name. */
const bot = (page: Page, name: string) =>
  page.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${name}\\b`) });

const rect = async (page: Page, locator: ReturnType<Page["locator"]>) =>
  (await locator.boundingBox())!;

const style = (locator: ReturnType<Page["locator"]>, property: string) =>
  locator.evaluate((el, name) => getComputedStyle(el).getPropertyValue(name), property);

/** A colour token, resolved the way the browser resolves a colour. */
const tokenColor = (page: Page, token: string) =>
  page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.querySelector(".rail")!.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);

/** A colour token used as a fill, resolved the way the browser resolves it. */
const tokenBackground = (page: Page, token: string) =>
  page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = `var(${name})`;
    document.querySelector(".rail")!.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, token);

/** The bots in the list below the pins, in the order shown. */
const listOrder = (page: Page) =>
  page.locator(".bot-list > .bot-group > .bot .bot-name").allTextContents();

async function menuItem(page: Page, name: string, item: string) {
  await bot(page, name).click({ button: "right" });
  await page.getByRole("menuitem", { name: item }).click();
}

test.use(contextFor(WIDE, "light"));

test("F-013: pinned bots are large tiles, three per row, the name centred and truncated, the open one filled", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
  // "Pin" in a bot's menu moves it into the pinned area.
  for (const name of ["Juniper", "Otto", "Pip", "Quartermaster"]) await menuItem(page, name, "Pin");
  const grid = page.getByRole("list", { name: "Pinned bots" });
  const tiles = grid.locator(".pin");
  await expect(tiles).toHaveCount(4);
  const boxes = await Promise.all([0, 1, 2, 3].map((i) => rect(page, tiles.nth(i))));
  // Three to a row: the first three share a row, the fourth starts the next.
  expect(new Set(boxes.slice(0, 3).map((b) => Math.round(b.y))).size).toBe(1);
  expect(boxes[3]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.height - 1);
  expect(Math.abs(boxes[3]!.x - boxes[0]!.x)).toBeLessThan(1);
  const rail = await rect(page, page.locator(".bot-list"));
  expect(boxes[0]!.width * 3).toBeGreaterThan(rail.width - 30);
  for (let i = 0; i < 4; i += 1) {
    const tile = tiles.nth(i);
    const avatar = await rect(page, tile.locator(".presence"));
    expect(avatar.width).toBe(56);
    const name = await rect(page, tile.locator(".pin-name"));
    const box = boxes[i]!;
    expect(name.y).toBeGreaterThan(avatar.y + avatar.height - 1);
    expect(Math.abs(name.x + name.width / 2 - (box.x + box.width / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(avatar.x + avatar.width / 2 - (box.x + box.width / 2))).toBeLessThanOrEqual(1);
  }
  const long = tiles.nth(3).locator(".pin-name > span").first();
  await expect(long).toHaveText("Quartermaster of the Family Calendar and Errands");
  expect(await style(long, "text-overflow")).toBe("ellipsis");
  expect(await long.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  // The open bot's tile has the lighter rounded fill; the others have none.
  await expect(tiles.nth(1)).toHaveAttribute("aria-current", "true");
  expect(await style(tiles.nth(1), "background-color")).not.toBe("rgba(0, 0, 0, 0)");
  expect(await style(tiles.nth(1), "border-radius")).toBe("18px");
  expect(await style(tiles.nth(2), "background-color")).toBe("rgba(0, 0, 0, 0)");
  await tiles.nth(2).click();
  await expect(tiles.nth(2)).toHaveAttribute("aria-current", "true");
  expect(await style(tiles.nth(1), "background-color")).toBe("rgba(0, 0, 0, 0)");
  // "Unpin" moves it back to the list; the pins keep their order after a restart.
  await menuItem(page, "Otto", "Unpin");
  await expect(tiles).toHaveCount(3);
  await page.reload();
  await expect(
    page.getByRole("list", { name: "Pinned bots" }).locator(".pin-name > span:first-child"),
  ).toHaveText(["Juniper", "Pip", "Quartermaster of the Family Calendar and Errands"]);
});

test("F-015: the primary bot's avatar carries a small round badge with a star at its lower right", async ({
  page,
}) => {
  // The gateway's default bot, `main`, shown by the switch; no other bot has the badge.
  await openFixture(page, `scene=main&${OTTO_DISK}&pins=otto&gatewaybot=on`, "light");
  await expect(page.getByTestId("primary-star")).toHaveCount(1);
  const own = bot(page, "main");
  await expect(own).toHaveAccessibleName(/, primary bot$/);
  await expect(bot(page, "Juniper")).not.toHaveAccessibleName(/primary/);
  await expect(bot(page, "Otto")).not.toHaveAccessibleName(/primary/);
  const check = async () => {
    const avatar = await rect(page, own.locator(".avatar"));
    const star = own.getByTestId("primary-star");
    const badge = await rect(page, star);
    expect(badge.width).toBeLessThanOrEqual(avatar.width * 0.45);
    expect(badge.width).toBe(badge.height);
    expect(await style(star, "border-radius")).toBe("50%");
    // Lower right: its centre is in the avatar's lower-right quarter.
    expect(badge.x + badge.width / 2).toBeGreaterThan(avatar.x + avatar.width * 0.75);
    expect(badge.y + badge.height / 2).toBeGreaterThan(avatar.y + avatar.height * 0.75);
    await expect(star.locator("svg path")).toHaveCount(1);
    // The shape is a five-pointed star: walking its outline, the distance from
    // its centre peaks five times, and the dips between are deep.
    const shape = await star.locator("svg path").evaluate((path: SVGPathElement) => {
      const length = path.getTotalLength();
      const points = Array.from({ length: 400 }, (_, i) =>
        path.getPointAtLength((length * i) / 400),
      );
      // The centre of the outline, which for a regular star is its own centre.
      const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
      const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
      const radii = points.map((point) => Math.hypot(point.x - cx, point.y - cy));
      const max = Math.max(...radii);
      const peaks = radii.filter((r, i) => {
        const before = radii[(i + radii.length - 1) % radii.length]!;
        const after = radii[(i + 1) % radii.length]!;
        return r > 0.9 * max && r >= before && r > after;
      }).length;
      return { peaks, depth: Math.min(...radii) / max };
    });
    expect(shape.peaks).toBe(5);
    expect(shape.depth).toBeLessThan(0.6);
    // Drawn in a colour that stands out from the badge.
    expect(await style(star.locator("svg"), "color")).not.toBe(
      await style(star, "background-color"),
    );
  };
  await check();
  // The same on a pinned tile.
  await menuItem(page, "main", "Pin");
  await expect(page.locator(".pin").filter({ has: page.getByTestId("primary-star") })).toHaveCount(
    1,
  );
  await check();
});

test("F-017: a row shows a small avatar, the name, one grey line of the latest message, truncated, and its time", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
  const rows = page.locator(".bot-list > .bot-group > .bot");
  await expect(rows).toHaveCount(5);
  const times: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const row = rows.nth(i);
    const box = await rect(page, row);
    const avatar = await rect(page, row.locator(".avatar"));
    expect(avatar.width).toBe(40);
    expect(avatar.width).toBeLessThan(box.width / 6);
    await expect(row.locator(".bot-name")).not.toBeEmpty();
    const preview = row.locator(".bot-preview");
    await expect(preview).not.toBeEmpty();
    // One line, and it gives way with an ellipsis.
    expect((await rect(page, preview)).height).toBeLessThanOrEqual(20);
    expect(await style(preview, "white-space")).toBe("nowrap");
    expect(await style(preview, "text-overflow")).toBe("ellipsis");
    expect(await style(preview, "color")).toBe(await tokenColor(page, "--text-muted"));
    // Desktop rows show the time too, at the right of the first line.
    const time = row.locator(".bot-time");
    times.push((await time.textContent()) ?? "");
    const at = await rect(page, time);
    expect(box.x + box.width - (at.x + at.width)).toBeLessThanOrEqual(13);
  }
  // Otto works now; the rest are today, today, today and two days ago.
  expect(times).toEqual(["now", "5:24 PM", "4:58 PM", "3:10 PM", "Sat"]);
  // The preview is the latest message, cut short with an ellipsis.
  const quartermaster = rows.nth(4).locator(".bot-preview");
  await expect(quartermaster).toHaveText(
    "Both are on Saturday's route, pharmacy first because it closes at noon.",
  );
  expect(await quartermaster.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});

test("F-019: a bot's label is a small grey pill beside its name", async ({ page }) => {
  await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
  const pip = bot(page, "Pip");
  const label = pip.locator(".bot-label");
  await expect(label).toHaveText("planning");
  await expect(pip).toHaveAccessibleName(/, planning$/);
  const name = await rect(page, pip.locator(".bot-name"));
  const pill = await rect(page, label);
  expect(pill.x).toBeGreaterThanOrEqual(name.x + name.width);
  expect(pill.x - (name.x + name.width)).toBeLessThanOrEqual(8);
  expect(Math.abs(pill.y + pill.height / 2 - (name.y + name.height / 2))).toBeLessThanOrEqual(1);
  expect(await style(label, "border-radius")).toBe("999px");
  expect(await style(label, "font-size")).toBe("12px");
  // Grey: the neutral code fill, with muted text, in both themes.
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    const fill = await style(label, "background-color");
    expect(fill).toBe(await tokenBackground(page, "--bg-code"));
    const [r, g, b, a] = fill.match(/[\d.]+/g)!.map(Number);
    expect(
      Math.max(r!, g!, b!) - Math.min(r!, g!, b!),
      `${theme} fill ${fill} is grey`,
    ).toBeLessThanOrEqual(2);
    expect(a).toBeGreaterThan(0);
    expect(await style(label, "color")).toBe(await tokenColor(page, "--text-muted"));
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  // A bot without a label has no pill.
  await page.evaluate(() => {
    (
      window as unknown as {
        clawtrateFixture: {
          setState(f: (s: { bots: Array<{ id: string; theme: string | null }> }) => unknown): void;
        };
      }
    ).clawtrateFixture.setState((state) => ({
      ...state,
      bots: state.bots.map((b) => (b.id === "pip" ? { ...b, theme: null } : b)),
    }));
  });
  await expect(pip.locator(".bot-label")).toHaveCount(0);
});

test("F-019: a short name stays whole beside its label at every rail width; the label gives way first", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
  // Around the rail's narrowing below 900, the drawer widths and one pane.
  for (const width of [1440, 1240, 1100, 901, 899, 800, 760, 700, 600, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await showList(page);
    await settle(page);
    const rows = await page.locator(".bot-list .bot").evaluateAll((elements) =>
      elements.map((element) => {
        const name = element.querySelector<HTMLElement>(".bot-name")!;
        const label = element.querySelector<HTMLElement>(".bot-label");
        return {
          name: name.textContent!,
          nameCut: name.scrollWidth > name.clientWidth,
          labelWidth: label?.getBoundingClientRect().width ?? null,
          labelCut: label ? label.scrollWidth > label.clientWidth : false,
          fontSize: label ? parseFloat(getComputedStyle(label).fontSize) : null,
        };
      }),
    );
    for (const row of rows) {
      expect(row.labelWidth, `${width}: ${row.name} keeps its label`).not.toBeNull();
      const long = row.name.startsWith("Quartermaster");
      // A short name is never cut; a long one is cut only once its label is down to a few letters.
      if (!long) expect(row.nameCut, `${width}: ${row.name} is whole`).toBe(false);
      if (row.nameCut) {
        expect(row.labelWidth!, `${width}: ${row.name}'s label gave way first`).toBeLessThanOrEqual(
          row.fontSize! * 3.5 + 0.5,
        );
      }
    }
  }
});

test("F-020: a working bot's avatar animates, and its row is named <Bot>, working", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
  const otto = bot(page, "Otto");
  await expect(otto).toHaveAccessibleName(/^Otto, working,/);
  const presence = otto.locator(".presence");
  await expect(presence).toHaveAttribute("data-state", "working");
  // The rail holds a presence still until its observer reports it in view.
  await expect(presence).toHaveAttribute("data-onscreen", "");
  // The ring travels round the avatar, and the creature bobs and snaps its claws.
  expect(await presence.evaluate((el) => getComputedStyle(el, "::before").animationName)).toBe(
    "orbit",
  );
  expect(await presence.evaluate((el) => getComputedStyle(el, "::before").opacity)).toBe("1");
  expect(
    await presence
      .locator('[data-part="creature"]')
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("av-bob");
  expect(
    await presence
      .locator('[data-part="claw"]')
      .evaluateAll((claws) => claws.map((el) => getComputedStyle(el).animationName)),
  ).toEqual(["av-snap", "av-snap"]);
  // A bot whose task failed acts it out in the rail too: drooping, its colour faded.
  await expect(bot(page, "Pip").locator("svg.creature")).toHaveAttribute("data-state", "blocked");
  await expect(bot(page, "Pip").locator("svg.creature")).toHaveAttribute("data-muted", "");
  // An idle bot is still.
  const marlow = bot(page, "Marlow").locator(".presence");
  await expect(marlow).toHaveAttribute("data-onscreen", "");
  expect(await marlow.evaluate((el) => getComputedStyle(el, "::before").opacity)).toBe("0");
  expect(
    await marlow
      .locator('[data-part="creature"]')
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("none");
  // When the run ends, the row and the avatar say so.
  await page.evaluate(() => {
    (
      window as unknown as {
        clawtrateFixture: {
          setState(
            f: (s: { tasksByBot: Record<string, Array<{ status: string }>> }) => unknown,
          ): void;
        };
      }
    ).clawtrateFixture.setState((state) => ({
      ...state,
      tasksByBot: {
        ...state.tasksByBot,
        otto: state.tasksByBot.otto!.map((t) => ({
          ...t,
          status: t.status === "running" ? "done" : t.status,
        })),
      },
    }));
  });
  await expect(otto).not.toHaveAccessibleName(/working/);
  await expect(presence).toHaveAttribute("data-state", "idle");
});

test("F-020: with reduced motion the working ring holds still", async ({ page }) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&motion=reduce`, "light");
  const presence = bot(page, "Otto").locator(".presence");
  // In view, so only reduced motion holds it still.
  await expect(presence).toHaveAttribute("data-onscreen", "");
  expect(await presence.evaluate((el) => getComputedStyle(el, "::before").animationName)).toBe(
    "none",
  );
  expect(await presence.evaluate((el) => getComputedStyle(el, "::before").opacity)).toBe("1");
});

test("F-027: Hide from sidebar moves a bot into a collapsible Hidden bots section, where Show in sidebar returns it; it keeps working", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
  const sentBefore = await page.evaluate(
    () =>
      (window as unknown as { clawtrateFixture: { sent: unknown[] } }).clawtrateFixture.sent.length,
  );
  await page.getByRole("heading", { level: 1 }).click();
  await bot(page, "Marlow").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Hide from sidebar" }).click();
  await expect(listOrder(page)).resolves.toEqual([
    "Otto",
    "Juniper",
    "Pip",
    "Quartermaster of the Family Calendar and Errands",
  ]);
  const toggle = page.getByRole("button", { name: /^Hidden bots/ });
  await expect(toggle).toHaveText(/Hidden bots\s*1/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // Focus is not left on the row that went away.
  await expect(toggle).toBeFocused();
  // It sits at the foot of the list, after the last bot.
  const last = await rect(page, bot(page, "Quartermaster"));
  expect((await rect(page, toggle)).y).toBeGreaterThan(last.y + last.height - 1);
  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const hidden = page.getByRole("list", { name: "Hidden bots" });
  await expect(hidden.getByTestId("bot")).toHaveCount(1);

  // A hidden bot keeps working: hiding asks nothing of the gateway, and its state still shows.
  await menuItem(page, "Otto", "Hide from sidebar");
  await expect(hidden.getByTestId("bot")).toHaveCount(2);
  await expect(hidden.locator(".bot[data-bot='otto'] .presence")).toHaveAttribute(
    "data-state",
    "working",
  );
  const sent = await page.evaluate(
    (from) =>
      (
        window as unknown as { clawtrateFixture: { sent: Array<{ type: string }> } }
      ).clawtrateFixture.sent
        .slice(from)
        .map((c) => c.type),
    sentBefore,
  );
  expect(sent.filter((type) => type !== "openSession" && type !== "closeSession")).toEqual([]);

  // Hidden bots stay hidden after a restart.
  await page.reload();
  await expect(page.getByRole("button", { name: /^Hidden bots/ })).toHaveText(/Hidden bots\s*2/);
  await page.getByRole("button", { name: /^Hidden bots/ }).click();
  await bot(page, "Marlow").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Hide from sidebar" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Show in sidebar" }).click();
  await expect(page.getByRole("list", { name: "Hidden bots" }).getByTestId("bot")).toHaveCount(1);
  await expect(listOrder(page)).resolves.toContain("Marlow");
  await menuItem(page, "Otto", "Show in sidebar");
  await expect(page.getByRole("button", { name: /^Hidden bots/ })).toHaveCount(0);
});

test("F-031: a sort control offers Recent activity, the default, Name and Manual, and the choice persists", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
  // Pinned bots come first, whatever the order below them.
  await menuItem(page, "Quartermaster", "Pin");
  const sort = page.getByRole("button", { name: /^Sort bots/ });
  await expect(sort).toHaveAccessibleName("Sort bots: Recent activity");
  await expect(listOrder(page)).resolves.toEqual(["Otto", "Juniper", "Marlow", "Pip"]);
  await sort.click();
  const menu = page.getByRole("menu", { name: "Sort bots" });
  await expect(menu.getByRole("menuitemradio")).toHaveText([
    /^Recent activity/,
    /^Name/,
    /^Manual/,
  ]);
  await expect(menu.getByRole("menuitemradio", { name: "Recent activity" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(menu.getByRole("menuitemradio", { name: "Recent activity" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(sort).toHaveAccessibleName("Sort bots: Name");
  await expect(sort).toBeFocused();
  await expect(listOrder(page)).resolves.toEqual(["Juniper", "Marlow", "Otto", "Pip"]);
  await expect(page.locator(".pin .pin-name > span").first()).toHaveText(/^Quartermaster/);
  await page.reload();
  await expect(page.getByRole("button", { name: /^Sort bots/ })).toHaveAccessibleName(
    "Sort bots: Name",
  );
  await expect(listOrder(page)).resolves.toEqual(["Juniper", "Marlow", "Otto", "Pip"]);
});

test("F-266: in Manual, a dragged bot keeps its place after a restart, and the control says This device only", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
  const sort = page.getByRole("button", { name: /^Sort bots/ });
  await sort.click();
  const manual = page.getByRole("menuitemradio", { name: "Manual" });
  // A read-only connection cannot store the order on the gateway, so it is this device's.
  await expect(manual).toHaveAccessibleDescription("This device only");
  await expect(manual).toContainText("This device only");
  await manual.click();
  await expect(sort).toHaveAccessibleName("Sort bots: Manual, this device only");
  // Switching to Manual starts from the gateway's order.
  await expect(listOrder(page)).resolves.toEqual([
    "Juniper",
    "Marlow",
    "Otto",
    "Pip",
    "Quartermaster of the Family Calendar and Errands",
  ]);
  await bot(page, "Pip").dragTo(bot(page, "Juniper"), { targetPosition: { x: 40, y: 6 } });
  await expect(listOrder(page)).resolves.toEqual([
    "Pip",
    "Juniper",
    "Marlow",
    "Otto",
    "Quartermaster of the Family Calendar and Errands",
  ]);
  // From the keyboard: Alt+Shift+Down moves the focused bot.
  await bot(page, "Juniper").focus();
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await expect(listOrder(page)).resolves.toEqual([
    "Pip",
    "Marlow",
    "Juniper",
    "Otto",
    "Quartermaster of the Family Calendar and Errands",
  ]);
  await expect(bot(page, "Juniper")).toBeFocused();
  // And from the bot's menu.
  await menuItem(page, "Otto", "Move up");
  await page.reload();
  await expect(page.getByRole("button", { name: /^Sort bots/ })).toHaveAccessibleName(
    "Sort bots: Manual, this device only",
  );
  await expect(listOrder(page)).resolves.toEqual([
    "Pip",
    "Marlow",
    "Otto",
    "Juniper",
    "Quartermaster of the Family Calendar and Errands",
  ]);
});

test("F-013 F-027 F-266: after a menu action moves a bot, keyboard focus is on the bot where it now is", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&sort=manual`, "light");
  await settle(page);
  const row = (id: string) => page.locator(`.bot-list .bot[data-bot="${id}"]`);
  const tile = (id: string) => page.locator(`.bot-list .pin[data-bot="${id}"]`);
  // Open the bot's menu from the keyboard and choose an item with Enter.
  const choose = async (target: ReturnType<Page["locator"]>, item: string) => {
    await target.focus();
    await page.keyboard.press("Shift+F10");
    await page.getByRole("menuitem", { name: item }).press("Enter");
    await expect(page.getByRole("menu")).toHaveCount(0);
  };
  const focusIsOnPage = () =>
    page.evaluate(
      () => document.activeElement !== null && document.activeElement !== document.body,
    );

  const before = await listOrder(page);
  await choose(row("marlow"), "Move down");
  expect((await listOrder(page)).indexOf("Marlow")).toBe(before.indexOf("Marlow") + 1);
  await expect(row("marlow")).toBeFocused();
  await choose(row("marlow"), "Move up");
  expect(await listOrder(page)).toEqual(before);
  await expect(row("marlow")).toBeFocused();

  await choose(row("otto"), "Pin");
  await expect(tile("otto")).toBeFocused();
  await choose(tile("otto"), "Unpin");
  await expect(row("otto")).toBeFocused();

  // Hidden: focus goes to the folded section's toggle; shown again, to the row.
  await choose(row("pip"), "Hide from sidebar");
  await expect(page.locator(".hidden-toggle")).toBeFocused();
  await page.keyboard.press("Enter");
  await choose(row("pip"), "Show in sidebar");
  await expect(row("pip")).toBeFocused();
  expect(await focusIsOnPage()).toBe(true);

  // The section is still open, so a bot hidden now keeps focus on its row there.
  await choose(row("marlow"), "Hide from sidebar");
  await expect(page.getByRole("list", { name: "Hidden bots" }).locator(".bot")).toBeFocused();
  // Opening a hidden bot from search with the section folded: focus goes to the toggle.
  await page.locator(".hidden-toggle").press("Enter");
  await expect(page.locator(".hidden-toggle")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ControlOrMeta+Shift+F");
  await page.getByRole("textbox", { name: "Search bots" }).fill("marl");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator(".hidden-toggle")).toBeFocused();
});

test("F-013 F-027 F-266: pins, hidden bots and the manual order belong to the gateway they were made on", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&pins=otto&hidden=marlow`, "light");
  await settle(page);
  const pins = page.locator(".pin-grid .pin");
  const hidden = page.locator(".hidden-list .bot, .hidden-toggle");
  await expect(pins).toHaveCount(1);
  await expect(page.locator(".hidden-toggle")).toBeVisible();
  // Another gateway, whose bots have the same ids.
  const switchTo = (gatewayId: string, gatewayUrl: string) =>
    page.evaluate(
      ([id, url]) =>
        (
          window as unknown as {
            clawtrateFixture: {
              setState: (change: (state: { connection: object }) => object) => void;
            };
          }
        ).clawtrateFixture.setState((state) => ({
          ...state,
          connection: { ...state.connection, gatewayId: id, gatewayUrl: url },
        })),
      [gatewayId, gatewayUrl],
    );
  const first = await page.evaluate(
    () =>
      (
        window as unknown as {
          clawtrateFixture: {
            getState: () => { connection: { gatewayId: string; gatewayUrl: string } };
          };
        }
      ).clawtrateFixture.getState().connection,
  );
  await switchTo(
    "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9",
    "ws://127.0.0.1:28789",
  );
  await expect(pins).toHaveCount(0);
  await expect(hidden).toHaveCount(0);
  await expect(bot(page, "Marlow")).toBeVisible();
  // Pinning there keeps to that gateway.
  await menuItem(page, "Pip", "Pin");
  await expect(page.locator('.pin-grid .pin[data-bot="pip"]')).toBeVisible();
  // Back on the first gateway: its own pin and hidden bot, and not the other's pin.
  await switchTo(first.gatewayId, first.gatewayUrl);
  await expect(pins).toHaveCount(1);
  await expect(page.locator('.pin-grid .pin[data-bot="otto"]')).toBeVisible();
  await expect(page.locator(".hidden-toggle")).toBeVisible();
  // The same gateway at another address is still the same gateway.
  await switchTo(first.gatewayId, "ws://127.0.0.1:38789");
  await expect(page.locator('.pin-grid .pin[data-bot="otto"]')).toBeVisible();
});

test("F-013 F-027 F-266: old saved state that names no gateway is ignored: the gateway opens with no pins, nothing hidden and the default order", async ({
  page,
}) => {
  const before = JSON.stringify({
    pinned: ["pip"],
    hidden: ["marlow"],
    sort: "manual",
    manual: ["quartermaster", "pip"],
  });
  await page.addInitScript((value) => localStorage.setItem("clawtrate.roster", value), before);
  await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
  await settle(page);
  await expect(page.locator(".pin-grid")).toHaveCount(0);
  await expect(page.locator(".hidden-toggle")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Sort bots/ })).toHaveAccessibleName(
    /^Sort bots: Recent activity/,
  );
  await expect(listOrder(page)).resolves.toEqual([
    "Otto",
    "Juniper",
    "Marlow",
    "Pip",
    "Quartermaster of the Family Calendar and Errands",
  ]);
  // Nothing reads it and nothing deletes it.
  expect(await page.evaluate(() => localStorage.getItem("clawtrate.roster"))).toBe(before);
});

test("F-426: a bot row shows the most urgent state of its tasks; opening a done-with-failures task clears it", async ({
  page,
}) => {
  await openFixture(page, "scene=task-states&bot=pip", "light");
  await settle(page);
  // Juniper: one task waiting for you and one working shows waiting.
  const juniper = bot(page, "Juniper");
  await expect(juniper).toHaveAccessibleName(/^Juniper, waiting for you,/);
  await expect(juniper.locator(".presence")).toHaveAttribute("data-state", "waiting");
  await expect(juniper.locator(".presence > .glyph")).toHaveAttribute("data-state", "waiting");
  // Otto: one done with failures and one working shows done with failures, with its failure marker.
  const otto = bot(page, "Otto");
  await expect(otto).toHaveAccessibleName(/^Otto, done with failures,/);
  await expect(otto.locator(".presence > .glyph")).toHaveAttribute("data-state", "failed");
  // Marlow's only task is blocked; Pip's failed task outranks nothing waiting.
  await expect(bot(page, "Marlow").locator(".presence > .glyph")).toHaveAttribute(
    "data-state",
    "blocked",
  );
  await expect(bot(page, "Pip")).toHaveAccessibleName(/^Pip, a run failed,/);
  // Opening the done-with-failures task clears it, and Otto's row shows working.
  await otto.click();
  const backup = page
    .getByRole("list", { name: "Otto's tasks" })
    .getByTestId("task")
    .filter({ hasText: "Weekly backup check" });
  await expect(backup).toHaveAttribute("data-state", "done-with-failures");
  await expect(backup.locator(".glyph")).toHaveAttribute("data-state", "failed");
  await backup.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Weekly backup check");
  await expect(otto).toHaveAccessibleName(/^Otto, working,/);
  await expect(otto.locator(".presence")).toHaveAttribute("data-state", "working");
  await expect(backup).not.toHaveAttribute("data-state");
  // Leaving it keeps it cleared.
  await page.getByRole("list", { name: "Otto's tasks" }).getByText("Router firmware").click();
  await expect(otto).toHaveAccessibleName(/^Otto, working,/);
});

test("F-023: the shell gives the host the number of unread tasks for the dock badge", async ({
  page,
}) => {
  const badge = () =>
    page.evaluate(
      () =>
        (window as unknown as { clawtrateFixture: { badge: number | null } }).clawtrateFixture
          .badge,
    );
  await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
  // Unread: Juniper's e-book apps, Otto's backup check and Pip's week.
  await expect.poll(badge).toBe(3);
  // Opening one reads it; it stays read after it is left.
  await page.getByRole("list", { name: "Otto's tasks" }).getByText("Weekly backup check").click();
  await expect.poll(badge).toBe(2);
  await page.getByRole("list", { name: "Otto's tasks" }).getByText("Router firmware").click();
  await expect.poll(badge).toBe(2);
  // New activity in a read task makes it unread again.
  await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: {
          setState(
            f: (s: {
              tasksByBot: Record<
                string,
                Array<{ key: string; updatedAt: number; unread: boolean }>
              >;
            }) => unknown,
          ): void;
        };
      }
    ).clawtrateFixture;
    fixture.setState((state) => ({
      ...state,
      tasksByBot: {
        ...state.tasksByBot,
        otto: state.tasksByBot.otto!.map((t) =>
          t.key === "agent:otto:backup-check"
            ? { ...t, unread: true, updatedAt: t.updatedAt + 60_000 }
            : t,
        ),
      },
    }));
  });
  await expect.poll(badge).toBe(3);
  // Disconnecting clears it.
  await page
    .getByRole("button", { name: /Open the gateway menu\.$/ })
    .last()
    .click();
  await page.getByRole("menuitem", { name: "Disconnect" }).click();
  await expect.poll(badge).toBe(0);
});

test("F-558: the sidebar, open conversation and open dialogs follow renamed, new and deleted bots", async ({
  page,
}) => {
  await openFixture(page, `scene=rail-write&${OTTO_DISK}`, "light");
  await expect(page.locator(".title-pill-name")).toHaveText("Otto");

  // A renamed bot updates in the sidebar and in its open conversation header.
  await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: {
          setState(
            f: (s: {
              bots: Array<{
                id: string;
                name: string;
                emoji: string | null;
                avatarUrl: string | null;
                theme: string | null;
                model: string | null;
                isDefault: boolean;
              }>;
            }) => unknown,
          ): void;
        };
      }
    ).clawtrateFixture;
    fixture.setState((state) => ({
      ...state,
      bots: state.bots.map((entry) =>
        entry.id === "otto" ? { ...entry, name: "Otto Prime" } : entry,
      ),
    }));
  });
  await expect(bot(page, "Otto Prime")).toBeVisible();
  await expect(page.locator(".title-pill-name")).toHaveText("Otto Prime");

  // A new bot appears in the sidebar.
  await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: {
          setState(
            f: (s: {
              bots: Array<{
                id: string;
                name: string;
                emoji: string | null;
                avatarUrl: string | null;
                theme: string | null;
                model: string | null;
                isDefault: boolean;
              }>;
            }) => unknown,
          ): void;
        };
      }
    ).clawtrateFixture;
    fixture.setState((state) => ({
      ...state,
      bots: [
        ...state.bots,
        {
          id: "nora",
          name: "Nora",
          emoji: null,
          avatarUrl: null,
          theme: null,
          model: null,
          isDefault: false,
        },
      ],
    }));
  });
  await expect(bot(page, "Nora")).toBeVisible();

  // Open a dialog for Otto Prime, then delete Otto from the gateway's bot list.
  await menuItem(page, "Otto Prime", "Move to");
  await page.getByRole("menuitem", { name: "New section…" }).click();
  await expect(page.getByTestId("rail-dialog")).toBeVisible();

  await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: {
          setState(
            f: (s: { bots: Array<{ id: string }>; tasksByBot: Record<string, unknown> }) => unknown,
          ): void;
        };
      }
    ).clawtrateFixture;
    fixture.setState((state) => {
      const { otto: _gone, ...restTasks } = state.tasksByBot;
      return {
        ...state,
        bots: state.bots.filter((entry) => entry.id !== "otto"),
        tasksByBot: restTasks,
      };
    });
  });

  // The deleted bot leaves the sidebar, its open dialog closes and the conversation moves on.
  await expect(bot(page, "Otto Prime")).toHaveCount(0);
  await expect(page.getByTestId("rail-dialog")).toHaveCount(0);
  await expect(page.locator(".title-pill-name")).toHaveText("Juniper");

  // When every bot is gone, the conversation shows the empty state.
  await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: {
          setState(f: (s: Record<string, unknown>) => unknown): void;
        };
      }
    ).clawtrateFixture;
    fixture.setState((state) => ({ ...state, bots: [], tasksByBot: {} }));
  });
  await expect(page.getByText("No bots to show")).toBeVisible();
});
