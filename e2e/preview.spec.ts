import { expect, test, type Page } from "@playwright/test";
import { devGateway, FORBIDDEN_PORTS, listInstances, runningOthers } from "./global-setup.ts";

/** This run's own development gateway instance, created by global setup. */
const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;

async function openShell(page: Page) {
  await page.goto(process.env.CLAWTRATE_E2E_URL!);
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 20_000 });
}

/**
 * A bot's row, by its accessible name: the name, then its number of tasks. The
 * title pill's name also starts with the bot's name, so the count is part of it.
 */
function botRow(page: Page, bot: string) {
  return page.getByRole("button", { name: new RegExp(`^${bot}, \\d+ tasks?`) });
}

/**
 * Open a bot without folding it: the open bot's row folds and unfolds, so it is
 * clicked only when its tasks are not showing and it is not a single-task row
 * that is already current.
 */
async function openBot(page: Page, bot: string) {
  const row = botRow(page, bot);
  const expanded = await row.getAttribute("aria-expanded");
  const current = await row.getAttribute("aria-current");
  if (expanded === "true" || (expanded === null && current === "true")) return;
  await row.click();
}

async function openTask(page: Page, bot: string, task: string) {
  await openBot(page, bot);
  // A bot with one task shows no task rows: opening the bot is the whole action.
  const rows = page.getByRole("list", { name: `${bot}'s tasks` }).getByTestId("task");
  if ((await rows.count()) > 0) await rows.filter({ hasText: task }).click();
  await expect(page.getByRole("heading", { level: 1, name: task })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("runs on its own instance while another instance's gateway is listening", () => {
  expect(INSTANCE, "global setup names this run's instance").toMatch(/^e2e-[0-9a-f]{8}$/);
  const rows = listInstances();
  const mine = rows.find((row) => row.name === INSTANCE)!;
  expect(mine.gatewayRunning).toBe(true);
  expect(mine.stateDir).toMatch(new RegExp(`\\.openclaw-clawtrate-dev-${INSTANCE}$`));
  for (const port of [mine.gatewayPort, mine.providerPort]) {
    expect(FORBIDDEN_PORTS).not.toContain(port);
  }
  expect(FORBIDDEN_PORTS).not.toContain(Number(new URL(process.env.CLAWTRATE_E2E_URL!).port));
  // The sentinel, and anything else that was running, is up and has its own ports.
  const sentinel = rows.find((row) => row.name === process.env.CLAWTRATE_E2E_SENTINEL);
  expect(sentinel?.gatewayRunning).toBe(true);
  for (const other of rows.filter((row) => row.gatewayRunning && row.name !== INSTANCE)) {
    expect(other.gatewayPort).not.toBe(mine.gatewayPort);
    expect(other.providerPort).not.toBe(mine.providerPort);
  }
});

test("pairs with the development gateway and shows bots, tasks and a transcript", async ({
  page,
}) => {
  expect(process.env.CLAWTRATE_E2E_URL, "global setup provides the preview URL").toBeTruthy();
  // Behave like the plain-http remote preview: no secure context, no clipboard API.
  await page.addInitScript(() => {
    Object.defineProperty(window, "isSecureContext", { get: () => false });
    Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined });
  });
  await page.goto(process.env.CLAWTRATE_E2E_URL!);

  await expect(page.getByRole("heading", { name: "Clawtrate" })).toBeVisible();
  await page.getByRole("button", { name: "Use the development gateway" }).click();

  // A fresh device identity must be approved on the gateway host, over the real protocol.
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible();
  // The pairing screen shows the product's mark alone, named for the product.
  await expect(page.getByRole("img", { name: "Clawtrate" })).toBeVisible();
  const pairing = page.locator(".panel");
  // The development gateway is approved with the dev tooling, never an unqualified
  // command that would address a default-profile gateway.
  await expect(pairing.locator(".command code")).toHaveText([
    `pnpm dev-gateway approve --instance ${INSTANCE}`,
  ]);
  await expect(pairing).not.toContainText("openclaw devices approve");

  // Copying works without the clipboard API.
  await pairing.getByRole("button", { name: "Copy approve command" }).click();
  await expect(pairing.locator(".copy-status")).toHaveText(/Copied\.|Press .+ to copy\./);

  devGateway(INSTANCE, "approve");

  // The pairing screen reconnects by itself once the request is approved.
  const bots = page.getByTestId("bot");
  await expect(bots).toHaveCount(4, { timeout: 20_000 });
  // The gateway's order: its default bot first.
  await expect(bots).toContainText(["Juniper", "Marlow", "Otto", "Pip"]);

  await openBot(page, "Otto");
  const tasks = page.getByRole("list", { name: "Otto's tasks" }).getByTestId("task");
  await expect(tasks).toHaveCount(3);
  await expect(tasks).toContainText([
    "Certificate renewal warning",
    "Weekly backup check",
    "Disk almost full on the media box",
  ]);

  await openTask(page, "Otto", "Disk almost full on the media box");
  const turns = page.getByTestId("transcript-turn");
  await expect(turns).toHaveCount(4);
  await expect(turns.nth(0)).toContainText("The media box says the disk is 94% full");
  await expect(turns.nth(1)).toContainText("The usual suspects on a media box");
  await expect(page.getByTestId("tool-call")).toHaveCount(3);

  // Thoughts and tool calls are folded into one line per run. Opened, a tool
  // call still shows its full arguments and the gateway's result.
  const read = page.getByTestId("tool-call").filter({ hasText: "read" });
  await page.locator("details.steps").filter({ has: read }).locator(":scope > summary").click();
  await read.locator("summary").click();
  await expect(read).toContainText('"path": "AGENTS.md"');
  await expect(read).toContainText("You are Otto, the operator for a small home server.");

  // The footer is the gateway menu's button; its name and dot carry the state.
  const gateway = page.getByRole("button", { name: /, connected\. Open the gateway menu\.$/ });
  await expect(gateway).toBeVisible();
  await expect(gateway.locator(".status-dot")).toHaveAttribute("data-status", "connected");
});

test("a task stays read after it was opened", async ({ page }) => {
  await openShell(page);
  await openTask(page, "Otto", "Weekly backup check");
  await openTask(page, "Otto", "Disk almost full on the media box");
  const backup = page.getByTestId("task").filter({ hasText: "Weekly backup check" });
  await expect(backup).toHaveAttribute("data-unread", "false");
  await page.reload();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 20_000 });
  // Otto is restored as the open bot and is already unfolded; a click would fold it.
  await openBot(page, "Otto");
  await expect(backup).toHaveAttribute("data-unread", "false");
});

test("the conversation keeps its width and the work panel becomes a drawer", async ({ page }) => {
  await openShell(page);
  await openTask(page, "Otto", "Disk almost full on the media box");
  await page.getByRole("button", { name: "Show work panel" }).click();
  for (const [width, height] of [
    [1440, 900],
    [1100, 700],
    [800, 600],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(page.getByTestId("work-panel")).toBeVisible();
    const conversation = await page.locator(".conversation").boundingBox();
    expect(conversation!.width, `conversation width at ${width}px`).toBeGreaterThanOrEqual(440);
  }

  // Work docks when the conversation keeps 600px: from a 1240px window.
  await page.setViewportSize({ width: 1240, height: 800 });
  await expect(page.getByTestId("work-panel")).not.toHaveAttribute("role", "dialog");
  const docked = await page.locator(".conversation").boundingBox();
  expect(docked!.width, "conversation beside docked Work").toBeGreaterThanOrEqual(600);
  await page.setViewportSize({ width: 1239, height: 800 });
  await expect(page.getByTestId("work-panel")).toHaveAttribute("role", "dialog");

  // Narrow: Escape closes the drawer.
  await page.setViewportSize({ width: 800, height: 600 });
  await page.keyboard.press("Escape");
  await expect(page.locator(".shell")).toHaveAttribute("data-panel", "closed");

  // At 688px both panes still show, and the conversation keeps 440px.
  await page.setViewportSize({ width: 688, height: 600 });
  await expect(page.locator(".rail")).toBeVisible();
  await expect(page.locator(".conversation")).toBeVisible();
  const narrow = await page.locator(".conversation").boundingBox();
  expect(narrow!.width, "conversation width at 688px").toBeGreaterThanOrEqual(440);

  // Narrowest: the rail and the conversation take turns.
  await page.setViewportSize({ width: 600, height: 600 });
  await page.getByRole("button", { name: "Back to bots" }).click();
  const ottoTasks = page.getByRole("list", { name: "Otto's tasks" });
  await expect(ottoTasks).toBeVisible();
  await expect(page.locator(".conversation")).toBeHidden();
  await ottoTasks.getByTestId("task").filter({ hasText: "Weekly backup check" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Weekly backup check" })).toBeVisible();
  await expect(ottoTasks).toBeHidden();
});

test("the overlay drawer takes keyboard focus and gives it back", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await openShell(page);
  await openTask(page, "Otto", "Disk almost full on the media box");
  if ((await page.locator(".shell").getAttribute("data-panel")) === "open") {
    await page.keyboard.press("Escape");
  }

  // Open by keyboard: focus moves into the drawer.
  await page.getByRole("button", { name: "Show work panel" }).focus();
  await page.keyboard.press("Enter");
  const close = page.getByRole("button", { name: "Close work panel" }).last();
  await expect(close).toBeFocused();

  // Tabbing never lands on anything the drawer covers.
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Tab");
    const placement = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body) return { inConversation: false, covered: false };
      const rect = active.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        inConversation: active.closest(".conversation") !== null,
        covered: rect.width > 0 && hit !== null && hit !== active && !active.contains(hit),
      };
    });
    expect(placement, `focus after ${i + 1} tabs`).toEqual({
      inConversation: false,
      covered: false,
    });
  }

  // Escape closes it and focus returns to the toggle.
  await page.keyboard.press("Escape");
  await expect(page.locator(".shell")).toHaveAttribute("data-panel", "closed");
  await expect(page.getByRole("button", { name: "Show work panel" })).toBeFocused();

  // The wide inline pane is ordinary page content: opening it keeps focus on the toggle.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Show work panel" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Hide work panel" })).toBeFocused();
  // Docked, Escape does not close Work; tidy up with the toggle.
  await page.getByRole("button", { name: "Hide work panel" }).click();
});

test("the rail names every bot", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await openShell(page);
  for (const name of ["Juniper", "Marlow", "Otto", "Pip"]) {
    await expect(botRow(page, name)).toBeVisible();
    await expect(botRow(page, name)).toContainText(name);
  }
  // A task title truncated in the 248px rail shows in full on keyboard focus.
  await openBot(page, "Otto");
  const ottoTasks = page.getByRole("list", { name: "Otto's tasks" }).getByTestId("task");
  await ottoTasks.filter({ hasText: "Disk almost full on the media box" }).focus();
  await expect(page.getByTestId("rail-tooltip")).toHaveText("Disk almost full on the media box");
  await ottoTasks.filter({ hasText: "Weekly backup check" }).focus();
  await expect(page.getByTestId("rail-tooltip")).toHaveCount(0);
});

test("on one pane a bot unfolds in place, and folding never changes the conversation", async ({
  page,
}) => {
  await openShell(page);
  await openTask(page, "Otto", "Disk almost full on the media box");
  // One pane shows the conversation first; Back shows the list.
  await page.setViewportSize({ width: 600, height: 700 });
  await page.getByRole("button", { name: "Back to bots" }).click();
  await openBot(page, "Juniper");
  await expect(botRow(page, "Juniper")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".conversation")).toBeHidden();
  const juniperTasks = page.getByRole("list", { name: "Juniper's tasks" }).getByTestId("task");
  await juniperTasks.first().click();
  await expect(page.locator(".conversation")).toBeVisible();
  await page.getByRole("button", { name: "Back to bots" }).click();
  await expect(botRow(page, "Juniper")).toHaveAttribute("aria-expanded", "true");

  // Two panes: folding the open bot keeps its conversation.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTask(page, "Otto", "Weekly backup check");
  await botRow(page, "Otto").click();
  await expect(botRow(page, "Otto")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("heading", { level: 1, name: "Weekly backup check" })).toBeVisible();
});

test("the gateway menu opens from the keyboard and keeps the theme", async ({ page }) => {
  await openShell(page);
  const trigger = page.getByRole("button", { name: /Open the gateway menu\.$/ });
  for (const key of ["ArrowUp", "ArrowDown"]) {
    await trigger.focus();
    await page.keyboard.press(key);
    await expect(page.getByRole("menuitemradio", { checked: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  }
  await trigger.click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 20_000 });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await trigger.click();
  await page.getByRole("menuitemradio", { name: "Match the system" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");
});

test("the drawer is modal, and focus follows it across the docking width", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await openShell(page);
  await openTask(page, "Otto", "Disk almost full on the media box");
  await page.getByRole("button", { name: "Show work panel" }).click();
  const work = page.getByTestId("work-panel");
  await expect(work).toHaveAttribute("role", "dialog");
  await expect(page.locator(".rail")).toHaveAttribute("inert", "");
  // Tab from the pane's last control returns to its first.
  const close = page.getByRole("button", { name: "Close work panel" }).last();
  await page.getByRole("tabpanel").focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");

  // Docked at 1440px with focus in the conversation; narrowing moves focus to Close.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Show work panel" }).click();
  await expect(work).not.toHaveAttribute("role", "dialog");
  await page.getByTestId("transcript").focus();
  await page.setViewportSize({ width: 1100, height: 700 });
  await expect(close).toBeFocused();
  // Widening again keeps the pane open, removes the role and moves nothing.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(work).toBeVisible();
  await expect(work).not.toHaveAttribute("role", "dialog");
  await expect(close).toBeFocused();
  await page.getByRole("button", { name: "Hide work panel" }).click();
});

/** Proxy the bridge socket so a test can inject host state into the page. */
async function proxyBridge(page: Page) {
  let lastState: Record<string, unknown> | null = null;
  let toPage: ((message: string) => void) | null = null;
  let frozen = false;
  await page.routeWebSocket(/\/bridge$/, (ws) => {
    const server = ws.connectToServer();
    toPage = (message) => ws.send(message);
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const parsed = JSON.parse(String(message)) as { state?: Record<string, unknown> };
      if (parsed.state) lastState = parsed.state;
      if (!frozen || !parsed.state) ws.send(message);
    });
  });
  return {
    /** Hold back the host's own snapshots, so injected state is not overwritten. */
    freeze() {
      frozen = true;
    },
    inject(change: (state: Record<string, unknown>) => Record<string, unknown>) {
      expect(lastState, "the host sent state").not.toBeNull();
      toPage!(JSON.stringify({ type: "state", state: change(structuredClone(lastState!)) }));
    },
  };
}

test("a streamed reply does not pull a reader away from older messages", async ({ page }) => {
  const bridge = await proxyBridge(page);
  await page.setViewportSize({ width: 1440, height: 700 });
  await openShell(page);
  await openTask(page, "Otto", "Disk almost full on the media box");
  const transcript = page.getByTestId("transcript");
  await expect(page.getByTestId("transcript-turn")).toHaveCount(4);
  await transcript.evaluate((element) => (element.scrollTop = 0));
  await page.waitForTimeout(100);

  const key = "agent:otto:disk-space";
  bridge.freeze();
  bridge.inject((state) => {
    const transcripts = state.transcripts as Record<string, Record<string, unknown>>;
    transcripts[key]!.live = { runId: "injected", text: "Checking the disk again." };
    return state;
  });
  await expect(page.getByTestId("live-turn")).toHaveCount(1);
  expect(await transcript.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(page.getByTestId("jump-latest")).toBeVisible();

  await page.getByTestId("jump-latest").click();
  await expect(page.getByTestId("jump-latest")).toBeHidden();
  const atEnd = await transcript.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight < 2,
  );
  expect(atEnd).toBe(true);
});

test("a dropped connection keeps the shell and shows one status strip", async ({ page }) => {
  const bridge = await proxyBridge(page);
  await openShell(page);
  await openTask(page, "Otto", "Disk almost full on the media box");
  await expect(page.getByTestId("transcript-turn")).toHaveCount(4);
  const before = await page.locator(".rail").boundingBox();
  bridge.freeze();

  for (const status of ["reconnecting", "connecting", "reconnecting"]) {
    bridge.inject((state) => ({
      ...state,
      connection: {
        ...(state.connection as object),
        status,
        retryAt: Date.now() + 4000,
      },
    }));
    await expect(page.getByTestId("status-strip")).toContainText(/Reconnecting in [1-5]s/);
    await expect(page.getByTestId("transcript-turn")).toHaveCount(4);
  }
  // The strip floats; nothing moves.
  expect(await page.locator(".rail").boundingBox()).toEqual(before);
  await expect(page.getByRole("heading", { name: "Connect to your gateway" })).toHaveCount(0);
});

test("the status strip is centred on the conversation beside a docked Work pane", async ({
  page,
}) => {
  const bridge = await proxyBridge(page);
  await page.setViewportSize({ width: 1240, height: 800 });
  await openShell(page);
  await openTask(page, "Otto", "Disk almost full on the media box");
  await page.getByRole("button", { name: "Show work panel" }).click();
  await expect(page.getByTestId("work-panel")).not.toHaveAttribute("role", "dialog");
  bridge.freeze();
  bridge.inject((state) => ({
    ...state,
    connection: {
      ...(state.connection as object),
      status: "reconnecting",
      retryAt: Date.now() + 4000,
    },
  }));
  const strip = page.getByTestId("status-strip");
  await expect(strip).toContainText(/Reconnecting/);
  const s = (await strip.boundingBox())!;
  const c = (await page.locator(".conversation").boundingBox())!;
  expect(Math.abs(s.x + s.width / 2 - (c.x + c.width / 2))).toBeLessThanOrEqual(1);
  const retry = (await page.getByRole("button", { name: "Retry now" }).boundingBox())!;
  const hit = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x!, y!)?.textContent,
    [retry.x + retry.width / 2, retry.y + retry.height / 2],
  );
  expect(hit).toBe("Retry now");

  // With the transcript scrolled, nothing shows at the strip's height.
  await page.getByTestId("transcript").evaluate((element) => (element.scrollTop = 200));
  const mask = await page
    .getByTestId("transcript")
    .evaluate((element) => getComputedStyle(element).maskImage);
  expect(mask).toMatch(/rgba\(0, 0, 0, 0\) 90px, rgb\(0, 0, 0\) 98px/);
});

test("tool calls open to their arguments, result and error", async ({ page }) => {
  const bridge = await proxyBridge(page);
  await openShell(page);
  await openTask(page, "Otto", "Disk almost full on the media box");
  const read = page.getByTestId("tool-call").filter({ hasText: "read" });
  await page.locator("details.steps").filter({ has: read }).locator(":scope > summary").click();
  await read.locator("summary").click();
  await expect(read).toContainText("Arguments");
  await expect(read).toContainText("Result");

  // The seed's calls all succeed; inject a failed one to see its state.
  const key = "agent:otto:disk-space";
  bridge.freeze();
  bridge.inject((state) => {
    const transcripts = state.transcripts as Record<
      string,
      { items: Array<Record<string, unknown>> }
    >;
    transcripts[key]!.items.push({
      id: "injected-failure",
      role: "assistant",
      timestamp: Date.now(),
      model: null,
      blocks: [
        {
          kind: "tool-call",
          callId: "injected",
          name: "write",
          argumentsText: '{\n  "path": "/etc/hosts"\n}',
          result: { isError: true, text: "Permission denied" },
        },
      ],
    });
    return state;
  });
  const failed = page.getByTestId("tool-call").filter({ hasText: "/etc/hosts" });
  await page.locator("details.steps").filter({ has: failed }).locator(":scope > summary").click();
  await expect(failed).toContainText("failed");
  await failed.locator("summary").click();
  await expect(failed).toContainText("Error");
  await expect(failed).toContainText("Permission denied");
});

test("leaves every other instance's gateway as it found it", () => {
  // Same processes on the same ports as before this run's instance started.
  const before = JSON.parse(process.env.CLAWTRATE_E2E_OTHERS!) as string[];
  expect(before.some((row) => row.startsWith(`${process.env.CLAWTRATE_E2E_SENTINEL} `))).toBe(true);
  expect(runningOthers([INSTANCE], [process.env.CLAWTRATE_E2E_SENTINEL!])).toEqual(
    expect.arrayContaining(before),
  );
});
