import { expect, test, type Page } from "@playwright/test";
import { protocolMismatch } from "../packages/core/src/connect-errors.ts";
import { openInstance } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import { devGateway, FORBIDDEN_PORTS, listInstances, runningOthers } from "./global-setup.ts";

/** This run's own development gateway instance, created by global setup. */
const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;

/**
 * Run an OpenClaw command on this run's instance, through the dev tool's own
 * guarded runner, which adds the instance's profile and refuses any other state.
 */
async function openclaw(args: string[]): Promise<string> {
  const result = await openInstance(INSTANCE).runner.run(args);
  if (result.status !== 0) {
    throw new Error(`openclaw ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

/** A gateway method, called with the instance's own operator credentials. */
async function gatewayCall<T>(method: string, params: unknown): Promise<T> {
  return parseJsonOutput<T>(
    await openclaw(["gateway", "call", method, "--params", JSON.stringify(params), "--json"]),
  );
}

type SessionRow = {
  key: string;
  agentId?: string;
  updatedAt?: number | null;
  archived?: boolean;
  lastMessagePreview?: string;
  totalTokens?: number;
  contextTokens?: number;
};
type AgentRow = {
  id: string;
  kind?: string;
  name?: string;
  identity?: { name?: string; theme?: string };
};

const SESSION_LIST = {
  limit: 200,
  includeDerivedTitles: true,
  includeLastMessage: true,
  excludeCron: true,
  excludeSubagents: true,
};

async function openShell(page: Page) {
  await page.goto(process.env.CLAWTRATE_E2E_URL!);
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 20_000 });
}

/**
 * A bot's row, by its accessible name: the name, then its number of tasks. The
 * title pill's name also starts with the bot's name, so the count is part of it.
 */
function botRow(page: Page, bot: string) {
  return page.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${bot}\\b`) });
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

test("F-002 F-003 F-009: pairs with the development gateway in steps, says when pairing was rejected, and shows bots, tasks and a transcript", async ({
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

  // F-003: setting up is a list of steps; this one is connected and waiting for approval.
  const steps = page.getByTestId("setup-steps").locator("li");
  await expect(steps.nth(0)).toHaveText(/^Connected to 127\.0\.0\.1:\d+$/);
  await expect(steps.nth(1)).toHaveText(/^Waiting for approval/);
  await expect(steps.nth(2)).toHaveText("Load bots");
  // F-002: the request lists exactly the scope the device asked for.
  const scopes = pairing.getByRole("list", { name: "This device asks to" }).locator("li");
  await expect(scopes).toHaveCount(1);
  await expect(scopes).toHaveAttribute("data-scope", "operator.read");
  type Pending = { requestId: string; displayName?: string; scopes?: string[] };
  const listed = parseJsonOutput<{ pending?: Pending[] }>(
    await openclaw(["devices", "list", "--json"]),
  );
  const request = (listed.pending ?? []).find((r) => r.displayName?.startsWith("Clawtrate"))!;
  expect(request.scopes).toEqual(["operator.read"]);
  await expect(page.locator(".connect-foot")).toContainText(request.requestId.slice(0, 8));

  // F-009: the gateway's owner rejects the request; the app says so and offers to try again.
  await openclaw(["devices", "reject", request.requestId]);
  const alert = page.getByRole("alert");
  await expect(alert.locator("strong")).toHaveText("Pairing was rejected", { timeout: 15_000 });
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible();
  await expect(page.locator(".connect-foot")).not.toContainText(request.requestId.slice(0, 8));

  devGateway(INSTANCE, "approve");

  // The pairing screen reconnects by itself once the request is approved.
  const bots = page.getByTestId("bot");
  await expect(bots).toHaveCount(4, { timeout: 20_000 });
  await expect(page.getByTestId("setup-steps")).toHaveCount(0);
  // Every seeded bot; their order is checked against the gateway's activity below.
  expect((await page.locator(".bot-list .bot-name").allTextContents()).sort()).toEqual([
    "Juniper",
    "Marlow",
    "Otto",
    "Pip",
  ]);

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

test("F-015 F-017 F-019 F-031 F-425: the rail lists the gateway's bots by recent activity, with the primary bot's star, labels, previews and times", async ({
  page,
}) => {
  await openShell(page);
  const [{ sessions }, agents] = await Promise.all([
    gatewayCall<{ sessions: SessionRow[] }>("sessions.list", SESSION_LIST),
    gatewayCall<{ defaultId: string; agents: AgentRow[] }>("agents.list", {}),
  ]);
  const latest = new Map<string, number>();
  for (const row of sessions) {
    if (row.archived || !row.agentId) continue;
    latest.set(row.agentId, Math.max(latest.get(row.agentId) ?? 0, row.updatedAt ?? 0));
  }
  const bots = agents.agents.filter((agent) => agent.kind !== "system");
  const name = (agent: AgentRow) => agent.identity?.name ?? agent.name ?? agent.id;
  // F-031: recent activity, the default order: the latest message in any task, newest first.
  const expected = [...bots]
    .sort((a, b) => (latest.get(b.id) ?? -Infinity) - (latest.get(a.id) ?? -Infinity))
    .map(name);
  await expect(page.locator(".bot-list > .bot-group > .bot .bot-name")).toHaveText(expected);
  await expect(page.getByRole("button", { name: /^Sort bots/ })).toHaveAccessibleName(
    "Sort bots: Recent activity",
  );

  for (const agent of bots) {
    const row = botRow(page, name(agent));
    // F-015: the gateway's default bot carries the star, and only it.
    await expect(row.getByTestId("primary-star")).toHaveCount(
      agent.id === agents.defaultId ? 1 : 0,
    );
    // F-019: the label is the agent's identity theme.
    await expect(row.locator(".bot-label")).toHaveText(agent.identity!.theme!);
    // F-017: a preview of the latest message and the time of the latest activity.
    const newest = sessions
      .filter((s) => s.agentId === agent.id && !s.archived)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]!;
    const words = newest
      .lastMessagePreview!.replace(/[*_`#|]/g, "")
      .split(/\s+/)
      .slice(0, 3);
    await expect(row.locator(".bot-preview")).toContainText(words.join(" "));
    await expect(row.locator(".bot-time")).toHaveText(/^(\d{1,2}:\d{2}\s[AP]M|Yesterday)$/);
  }
  expect(agents.defaultId).toBe("main");
  await expect(page.getByTestId("primary-star")).toHaveCount(1);

  // F-425: a bot's tasks show their titles and times, and its fold is remembered.
  await openBot(page, "Otto");
  const ottoTasks = page.getByRole("list", { name: "Otto's tasks" }).getByTestId("task");
  await expect(ottoTasks.locator(".task-time")).toHaveText(
    Array(3).fill(/^(\d{1,2}:\d{2}\s[AP]M|Yesterday)$/),
  );
  await botRow(page, "Pip").focus();
  await page.keyboard.press("ArrowRight");
  await page.reload();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 20_000 });
  await expect(botRow(page, "Pip")).toHaveAttribute("aria-expanded", "true");
});

test("F-059 F-063: a task's header shows the gateway's context use, and stamps separate its blocks", async ({
  page,
}) => {
  await openShell(page);
  await openTask(page, "Otto", "Disk almost full on the media box");
  const { sessions } = await gatewayCall<{ sessions: SessionRow[] }>("sessions.list", SESSION_LIST);
  const row = sessions.find((s) => s.key === "agent:otto:disk-space")!;
  expect(row.totalTokens).toBeGreaterThan(0);
  expect(row.contextTokens).toBe(128_000);
  await expect(page.getByTestId("task-context")).toHaveText(
    `Context: ${row.totalTokens!.toLocaleString("en-US")} of ${row.contextTokens!.toLocaleString("en-US")} tokens`,
  );
  // The seeded messages are seconds apart: one stamp, before the first message.
  await expect(page.locator(".transcript .stamp")).toHaveText([
    /^(Today|Yesterday) \d{1,2}:\d{2}\s[AP]M$/,
  ]);
  await expect(page.locator(".msg .bubble").first()).toHaveAttribute("title", /\d:\d\d/);
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
    // Focus starts on the checked theme, the menu's first checked item.
    await expect(page.getByRole("menuitemradio", { checked: true }).first()).toBeFocused();
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

test("F-227 F-387 F-457: Settings shows the gateway, this device and its granted scopes; Disconnect keeps the pairing until Reconnect", async ({
  page,
}) => {
  await openShell(page);
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const state = dialog.getByTestId("gateway-state");
  await expect(state).toHaveText("Connected");
  await expect(dialog.getByTestId("gateway-facts")).toContainText(
    `Address${process.env.CLAWTRATE_E2E_GATEWAY ?? "ws://127.0.0.1:"}`,
  );
  await expect(dialog.getByTestId("gateway-facts")).toContainText("This deviceClawtrate Web · ");
  // The scopes the gateway granted, from its hello.
  await expect(dialog.getByTestId("granted-scopes")).toHaveText("operator.read");
  await expect(dialog.getByTestId("gateway-facts")).toContainText(
    "OpenClaw 2026.10.6 · protocol 4",
  );

  await dialog.getByRole("button", { name: "Disconnect" }).click();
  await expect(state).toHaveText("Disconnected");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("status-strip")).toContainText("Disconnected");
  await expect(page.getByTestId("bot")).toHaveCount(4);
  // It stays disconnected, and reconnects with its own device token: no new pairing request.
  await page.waitForTimeout(1500);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(state).toHaveText("Disconnected");
  await dialog.getByRole("button", { name: "Reconnect" }).click();
  await expect(state).toHaveText("Connected", { timeout: 15_000 });
  const listed = parseJsonOutput<{ pending?: unknown[] }>(
    await openclaw(["devices", "list", "--json"]),
  );
  expect(listed.pending ?? []).toEqual([]);
});

test("F-017 F-020: a run started on the gateway shows its bot working, then the row shows the reply", async ({
  page,
}) => {
  // Every state the host sends the page, to see the run while it lasts.
  const seen: Array<{
    tasksByBot?: Record<string, Array<{ key: string; status: string; preview: string | null }>>;
  }> = [];
  await page.routeWebSocket(/\/bridge$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const parsed = JSON.parse(String(message)) as { state?: (typeof seen)[number] };
      if (parsed.state) seen.push(parsed.state);
      ws.send(message);
    });
  });
  await openShell(page);
  const key = "agent:marlow:newsletter-intro";
  const prompt = "A note from the end-to-end run: is anything new?";
  await openclaw([
    "agent",
    "--agent",
    "marlow",
    "--session-key",
    key,
    "--message",
    prompt,
    "--thinking",
    "low",
    "--json",
  ]);
  const task = (state: (typeof seen)[number]) =>
    state.tasksByBot?.marlow?.find((t) => t.key === key);
  await expect.poll(() => seen.some((state) => task(state)?.status === "running")).toBe(true);
  // The row says the bot worked while it did, and shows the reply once it finished.
  await expect(botRow(page, "Marlow")).not.toHaveAccessibleName(/working/);
  await expect(botRow(page, "Marlow").locator(".bot-preview")).toContainText(
    "This is the scripted development model",
  );
  await expect(botRow(page, "Marlow")).toHaveAccessibleName(/^Marlow, 2 tasks/);
});

test("F-323: work goes on after the page is closed, and reopening shows where it got to", async ({
  page,
}) => {
  await openShell(page);
  await openTask(page, "Pip", "Saturday errands route");
  const before = await page.getByTestId("transcript-turn").count();
  const context = page.context();
  // Ask the gateway for a run, and leave the preview while it works.
  const run = openclaw([
    "agent",
    "--agent",
    "pip",
    "--session-key",
    "agent:pip:errands-saturday",
    "--message",
    "One more stop: the post office.",
    "--thinking",
    "low",
    "--json",
  ]);
  await page.close();
  await run;
  const again = await context.newPage();
  await again.goto(process.env.CLAWTRATE_E2E_URL!);
  await expect(again.getByTestId("bot")).toHaveCount(4, { timeout: 20_000 });
  await expect(
    again.getByRole("heading", { level: 1, name: "Saturday errands route" }),
  ).toBeVisible();
  await expect(again.getByTestId("transcript-turn")).toHaveCount(before + 2);
  await expect(again.getByTestId("transcript-turn").last()).toContainText(
    "This is the scripted development model",
  );
  await expect(botRow(again, "Pip")).not.toHaveAccessibleName(/working/);
});

test("F-263: a real gateway's protocol mismatch names the protocol it speaks", async () => {
  const mine = listInstances().find((row) => row.name === INSTANCE)!;
  const socket = new WebSocket(`ws://127.0.0.1:${mine.gatewayPort}`);
  const reply = await new Promise<{ ok: boolean; error?: { details?: unknown } }>(
    (resolve, reject) => {
      socket.onerror = () => reject(new Error("socket error"));
      socket.onmessage = (event) => {
        const frame = JSON.parse(String(event.data)) as {
          type: string;
          event?: string;
          id?: string;
        };
        if (frame.type === "event" && frame.event === "connect.challenge") {
          socket.send(
            JSON.stringify({
              type: "req",
              id: "probe",
              method: "connect",
              params: {
                minProtocol: 99,
                maxProtocol: 99,
                client: { id: "gateway-client", version: "0.0.0", platform: "test", mode: "ui" },
                role: "operator",
                scopes: ["operator.read"],
                caps: [],
              },
            }),
          );
        } else if (frame.type === "res" && frame.id === "probe") {
          resolve(frame as never);
        }
      };
    },
  );
  socket.close();
  expect(reply.ok).toBe(false);
  expect(protocolMismatch(reply.error?.details)).toEqual({ gateway: 4, client: 4 });
});

test("leaves every other instance's gateway as it found it", () => {
  // Same processes on the same ports as before this run's instance started.
  const before = JSON.parse(process.env.CLAWTRATE_E2E_OTHERS!) as string[];
  expect(before.some((row) => row.startsWith(`${process.env.CLAWTRATE_E2E_SENTINEL} `))).toBe(true);
  expect(runningOthers([INSTANCE], [process.env.CLAWTRATE_E2E_SENTINEL!])).toEqual(
    expect.arrayContaining(before),
  );
});
