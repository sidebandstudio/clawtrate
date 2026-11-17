import { expect, test, type Page } from "@playwright/test";
import { devGateway, FORBIDDEN_PORTS, listInstances, runningOthers } from "./global-setup.ts";

/** This run's own development gateway instance, created by global setup. */
const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;

async function openShell(page: Page) {
  await page.goto(process.env.CLAWTRATE_E2E_URL!);
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 20_000 });
}

async function openTask(page: Page, bot: string, task: string) {
  await page.getByTestId("bot").filter({ hasText: bot }).click();
  await page.getByTestId("task").filter({ hasText: task }).click();
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
  await expect(bots).toContainText(["Juniper", "Marlow", "Otto", "Pip"]);

  await bots.filter({ hasText: "Otto" }).click();
  const tasks = page.getByTestId("task");
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

  // Tool calls open to show their arguments and the gateway's result.
  const read = page.getByTestId("tool-call").filter({ hasText: "read" });
  await read.locator("summary").click();
  await expect(read).toContainText('"path": "AGENTS.md"');
  await expect(read).toContainText("You are Otto, the operator for a small home server.");

  await expect(page.getByRole("status").filter({ hasText: "Connected" })).toBeVisible();
});

test("a task stays read after it was opened", async ({ page }) => {
  await openShell(page);
  await openTask(page, "Otto", "Weekly backup check");
  await openTask(page, "Otto", "Disk almost full on the media box");
  const backup = page.getByTestId("task").filter({ hasText: "Weekly backup check" });
  await expect(backup).toHaveAttribute("data-unread", "false");
  await page.reload();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 20_000 });
  await page.getByTestId("bot").filter({ hasText: "Otto" }).click();
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
  // Narrow: Escape closes the drawer.
  await page.keyboard.press("Escape");
  await expect(page.locator(".shell")).toHaveAttribute("data-panel", "closed");

  // Narrowest: the task list and the conversation take turns.
  await page.setViewportSize({ width: 700, height: 600 });
  await page.getByRole("button", { name: "Back to tasks" }).click();
  await expect(page.getByTestId("task-list")).toBeVisible();
  await expect(page.locator(".conversation")).toBeHidden();
  await page.getByTestId("task").filter({ hasText: "Weekly backup check" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Weekly backup check" })).toBeVisible();
  await expect(page.getByTestId("task-list")).toBeHidden();
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
  await page.keyboard.press("Escape");
});

test("the compact rail names every bot", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await openShell(page);
  for (const name of ["Juniper", "Marlow", "Otto", "Pip"]) {
    await expect(
      page.getByRole("button", { name: new RegExp(`^${name}, \\d+ tasks?`) }),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: /^Marlow,/ }).focus();
  await expect(page.getByTestId("rail-tooltip")).toHaveText("Marlow");
  await expect(page.getByRole("img", { name: "Clawtrate" })).toBeVisible();
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

test("leaves every other instance's gateway as it found it", () => {
  // Same processes on the same ports as before this run's instance started.
  const before = JSON.parse(process.env.CLAWTRATE_E2E_OTHERS!) as string[];
  expect(before.some((row) => row.startsWith(`${process.env.CLAWTRATE_E2E_SENTINEL} `))).toBe(true);
  expect(runningOthers([INSTANCE])).toEqual(expect.arrayContaining(before));
});
