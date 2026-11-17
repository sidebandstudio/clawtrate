import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
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
  // A task title truncated in the 248px rail shows in full on keyboard focus,
  // and each task row shows the time of its latest activity.
  await openBot(page, "Otto");
  const ottoTasks = page.getByRole("list", { name: "Otto's tasks" }).getByTestId("task");
  await ottoTasks.filter({ hasText: "Disk almost full on the media box" }).focus();
  await expect(page.getByTestId("rail-tooltip")).toHaveText("Disk almost full on the media box");
  await expect(ottoTasks.locator(".task-time")).toHaveCount(3);
  await expect(ottoTasks.first().locator(".task-time")).not.toHaveText("");
  // A title that fits shows no tooltip. Beside its time it fits the 280px rail.
  await page.setViewportSize({ width: 1440, height: 900 });
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

/** A run the engine would hold, for injected state: running, started elsewhere. */
const INJECTED_RUN = {
  id: "injected",
  bound: true,
  state: "running",
  origin: "gateway",
  messageId: null,
  anchorItemId: null,
  phase: null,
  model: null,
  textSource: "chat",
  textItemId: null,
  textComplete: false,
  steps: [],
  pendingCards: [],
  suspendedCards: [],
  closedCards: [],
  endedAt: null,
  error: null,
  stopRequestedAt: null,
  finishedBeforeStop: false,
  stopError: null,
  lastSeq: null,
  ending: null,
  outcomeKnown: true,
  attemptErrors: [],
  omittedSteps: 0,
  nextReasoning: 0,
};

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
    const transcripts = state.transcripts as Record<string, { runs: unknown[] }>;
    transcripts[key]!.runs.push({
      ...INJECTED_RUN,
      text: "Checking the disk again.",
      startedAt: Date.now(),
    });
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

// The live conversation against this run's real development gateway. The
// scripted model answers a message sent from the app with a short reply and
// a reasoning segment; it cannot yet stream slowly, ask or need approval.

/** The gateway's own command line, on this run's instance profile only. */
function openclaw(...args: string[]): string {
  return execFileSync(
    process.env.OPENCLAW_BIN ?? "openclaw",
    ["--profile", `clawtrate-dev-${INSTANCE}`, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
}

/** Pending device requests on this run's gateway, newest last. */
function pendingRequests(): string[] {
  const listed = JSON.parse(openclaw("devices", "list", "--json")) as {
    pending?: Array<{ requestId: string }>;
  };
  return (listed.pending ?? []).map((request) => request.requestId);
}

/** Record, on every change, what the live turn and the status line show. */
async function watchRun(page: Page) {
  await page.evaluate(() => {
    const seen: Array<Record<string, unknown>> = [];
    (window as unknown as { __seen: unknown }).__seen = seen;
    new MutationObserver(() => {
      const live = document.querySelector("[data-testid=live-turn] .bubble");
      seen.push({
        at: performance.now(),
        live: live?.textContent ?? null,
        caret: !!live?.querySelector(".stream-caret"),
        busy: live?.getAttribute("aria-busy") ?? null,
        status: !!document.querySelector("[data-testid=status-line]"),
        phrase: document.querySelector("[data-testid=status-phrase]")?.textContent ?? null,
        steer: [...document.querySelectorAll("[data-testid=outgoing] .msg-caption")].some(
          (caption) => caption.textContent === "Steer",
        ),
      });
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  return () =>
    page.evaluate(
      () =>
        (window as unknown as { __seen: Array<Record<string, unknown>> }).__seen as Array<{
          at: number;
          live: string | null;
          caret: boolean;
          busy: string | null;
          status: boolean;
          phrase: string | null;
          steer: boolean;
        }>,
    );
}

const composer = (page: Page) => page.getByTestId("composer-input");

test("F-456: a refused request leaves the read tier as it was; an approved one gives the composer", async ({
  page,
}) => {
  await openShell(page);
  await openTask(page, "Otto", "Disk almost full on the media box");
  const bar = page.getByRole("region", { name: "Access" });
  await expect(bar).toContainText("Read-only.");
  await expect(composer(page)).toHaveCount(0);

  // Asked only when the person chooses to; the owner refuses it on the gateway's machine.
  expect(pendingRequests()).toEqual([]);
  await bar.getByRole("button", { name: "Request access" }).click();
  await expect(bar).toContainText("Waiting for the gateway's owner.");
  await expect(bar.locator(".command code")).toHaveText(
    `pnpm dev-gateway approve --instance ${INSTANCE}`,
  );
  const [refused] = pendingRequests();
  expect(refused).toBeTruthy();
  await expect(bar).toContainText(`Request ${refused!.slice(0, 8)}`);
  openclaw("devices", "reject", refused!);
  await expect(bar).toContainText(
    "The request was denied. Nothing changed. This device can still read.",
  );
  // The old authorization stays: the conversation still reads.
  await expect(page.getByTestId("transcript-turn").first()).toBeVisible();

  // Asked again and approved: the composer takes the bar's place.
  await bar.getByRole("button", { name: "Request again" }).click();
  await expect(bar).toContainText("Waiting for the gateway's owner.");
  devGateway(INSTANCE, "approve");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("region", { name: "Access" })).toHaveCount(0);
  await expect(page.getByTestId("status-strip")).toContainText("Access granted");
  const gateway = page.getByRole("button", { name: /, connected\. Open the gateway menu\.$/ });
  await expect(gateway).toBeVisible();
});

test("F-081 F-082 F-085 F-089 F-095 F-433: a sent message shows the status line within a second, its reply streams in, and the line leaves when the run completes", async ({
  page,
}) => {
  await openShell(page);
  await openTask(page, "Otto", "Weekly backup check");
  const seen = await watchRun(page);
  await composer(page).fill("How full is the backup disk this week?");
  const sent = Date.now();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-line")).toBeVisible({ timeout: 1000 });
  expect(Date.now() - sent).toBeLessThan(1000);
  await expect(page.getByTestId("status-line")).toHaveCount(0, { timeout: 30_000 });

  const samples = await seen();
  // The phrase was never empty, never named the bot, and started at Thinking.
  const phrases = samples.flatMap((sample) => (sample.phrase === null ? [] : [sample.phrase]));
  expect(phrases[0]).toBe("Thinking");
  expect(phrases.every((phrase) => phrase.trim().length > 0 && !/Otto/.test(phrase))).toBe(true);
  // The reply was on screen, streaming with its caret, while the run was still going.
  expect(
    samples.some(
      (sample) => sample.live && sample.caret && sample.busy === "true" && sample.status,
    ),
  ).toBe(true);
  // Once complete, history holds the message and its reply once each.
  await expect(
    page.getByText("How full is the backup disk this week?", { exact: true }),
  ).toHaveCount(2);
  await expect(page.getByTestId("outgoing")).toHaveCount(0);
  await expect(page.getByTestId("live-turn")).toHaveCount(0);
});

test("F-097: Stop during a real run shows Stopping…, and the gateway's confirmation ends it as stopped", async ({
  page,
}) => {
  await openShell(page);
  await openTask(page, "Otto", "Weekly backup check");
  const seen = await watchRun(page);
  await composer(page).fill("Check the backup disk once more, slowly.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-line")).toBeVisible();
  await expect(page.getByRole("button", { name: "Steer this turn" })).toBeVisible();
  await page.getByRole("button", { name: "Stop Otto" }).click();
  await expect(page.getByTestId("stop-note").last()).toContainText(
    "Completed steps are not undone.",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("stop-note").last()).toContainText(/^Stopped/);
  await expect(page.getByTestId("status-line")).toHaveCount(0);
  const samples = await seen();
  expect(samples.some((sample) => sample.phrase === "Stopping…")).toBe(true);
});

test("F-061: Queue after this turn holds a message on the shelf and runs it once the turn ends", async ({
  page,
}) => {
  await openShell(page);
  await openTask(page, "Otto", "Certificate renewal warning");
  await composer(page).fill("Which certificate is it?");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-line")).toBeVisible();
  await composer(page).fill("And when does it renew?");
  await page.keyboard.press("Alt+Enter");
  const row = page.getByTestId("shelf-row");
  await expect(row).toContainText("Queued");
  await expect(row).toContainText("And when does it renew?");
  await expect(row).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("status-line")).toHaveCount(0, { timeout: 30_000 });
  const turns = page.getByTestId("transcript-turn");
  await expect(turns.filter({ hasText: "And when does it renew?" })).toHaveCount(2);
  // In the order sent: the queued message came after the first one's reply.
  const order = await turns.evaluateAll((all) => all.map((turn) => turn.textContent ?? ""));
  const first = order.findIndex((text) => text.includes("Which certificate is it?"));
  const queued = order.findIndex((text) => text === "And when does it renew?");
  expect(first).toBeGreaterThan(-1);
  expect(queued).toBeGreaterThan(first + 1);
});

test("F-096: a message sent while the run works is steered into it and captioned Steer once accepted", async ({
  page,
}) => {
  await openShell(page);
  await openTask(page, "Otto", "Weekly backup check");
  const seen = await watchRun(page);
  await composer(page).fill("Start on the backup report.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-line")).toBeVisible();
  await composer(page).fill("Only the photos set, please.");
  await expect(page.getByRole("button", { name: "How to send: Steer" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-line")).toHaveCount(0, { timeout: 30_000 });
  expect((await seen()).some((sample) => sample.steer)).toBe(true);
  await expect(
    page.getByTestId("transcript-turn").filter({ hasText: "Only the photos set, please." }),
  ).not.toHaveCount(0);
});

test("F-058: two tasks of one bot run at the same time", async ({ page }) => {
  await openShell(page);
  await openTask(page, "Otto", "Disk almost full on the media box");
  await composer(page).fill("First of two at once.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-line")).toBeVisible();
  await openTask(page, "Otto", "Certificate renewal warning");
  await composer(page).fill("Second of two at once.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-line")).toHaveCount(0, { timeout: 30_000 });
  await openTask(page, "Otto", "Disk almost full on the media box");
  await expect(page.getByTestId("status-line")).toHaveCount(0, { timeout: 30_000 });
  // The gateway's own record: the second task's run began before the first's ended.
  const rows = (key: string) =>
    (
      JSON.parse(
        openclaw(
          "gateway",
          "call",
          "chat.history",
          "--params",
          JSON.stringify({ sessionKey: key, limit: 20 }),
          "--json",
        ),
      ) as { messages: Array<{ role: string; __openclaw?: { recordTimestampMs?: number } }> }
    ).messages;
  const at = (row: { __openclaw?: { recordTimestampMs?: number } } | undefined) =>
    row?.__openclaw?.recordTimestampMs ?? Number.NaN;
  const first = rows("agent:otto:disk-space");
  const second = rows("agent:otto:cert-renewal");
  const firstReplied = at(first.findLast((row) => row.role === "assistant"));
  const secondAsked = at(second.findLast((row) => row.role === "user"));
  expect(secondAsked).toBeLessThan(firstReplied);
  await expect(
    page.getByTestId("transcript-turn").filter({ hasText: "First of two at once." }),
  ).toHaveCount(2);
});

test("F-282: Start as new task runs the message in a new task under the same bot", async ({
  page,
}) => {
  await openShell(page);
  await openTask(page, "Otto", "Weekly backup check");
  const tasks = page.getByRole("list", { name: "Otto's tasks" }).getByTestId("task");
  const before = await tasks.count();
  await composer(page).fill("Plan the next restore test.");
  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  await expect(page.getByTestId("announcer")).toHaveText("Started as a new task");
  await expect(composer(page)).toHaveValue("");
  await expect(page.getByRole("heading", { level: 1, name: "Weekly backup check" })).toBeVisible();
  await expect(tasks).toHaveCount(before + 1, { timeout: 20_000 });
});

test("leaves every other instance's gateway as it found it", () => {
  // Same processes on the same ports as before this run's instance started.
  const before = JSON.parse(process.env.CLAWTRATE_E2E_OTHERS!) as string[];
  expect(before.some((row) => row.startsWith(`${process.env.CLAWTRATE_E2E_SENTINEL} `))).toBe(true);
  expect(runningOthers([INSTANCE], [process.env.CLAWTRATE_E2E_SENTINEL!])).toEqual(
    expect.arrayContaining(before),
  );
});
