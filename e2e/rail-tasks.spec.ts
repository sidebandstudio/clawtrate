// The rail's task actions against a real development gateway: this run's own
// instance, two preview hosts of their own (two devices of the gateway's
// owner), one granted the interactive tier and one left read-only. Every check
// uses a task of its own; each asserts what the gateway holds afterwards, that
// it survives a reload, and what the second connection sees. What the checks
// create is removed, and the arrangement they changed put back, afterwards.
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { devGateway, startHost, stopChild } from "./global-setup.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const STAMP = Date.now().toString(36);
/** Where to save screenshots against the real gateway, when set. */
const SHOTS = process.env.CLAWTRATE_RAIL_SHOTS;

test.describe.configure({ mode: "serial" });

/** Reads of the gateway go through its command line, slow on a busy machine: each wait has its own deadline. */
const gateway = expect.configure({ timeout: 30_000 });

type Host = { child: ChildProcess; url: string; data: string };
const hosts: Host[] = [];
/** The interface with interactive access, and a second device that stays read-only. */
let page: Page;
let second: Page;
/** A paired operator that watches the gateway's events. */
let watcher: OperatorSession;
/** Tasks this spec made, removed afterwards. */
const made = new Set<string>();

async function openclaw(args: string[]): Promise<string> {
  const result = await openInstance(INSTANCE).runner.run(args);
  if (result.status !== 0)
    throw new Error(`openclaw ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

/** A gateway method with the instance's own operator credentials. */
async function gatewayCall<T>(method: string, params: unknown): Promise<T> {
  return parseJsonOutput<T>(
    await openclaw(["gateway", "call", method, "--params", JSON.stringify(params), "--json"]),
  );
}

type Row = {
  key: string;
  sessionId?: string;
  label?: string;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  hasActiveRun?: boolean;
};
const describe = async (key: string) =>
  (await gatewayCall<{ session: Row | null }>("sessions.describe", { key })).session;
const listed = async (botId: string, archived: boolean | "all" = false) =>
  (
    await gatewayCall<{ sessions: Row[] }>("sessions.list", {
      agentId: botId,
      archived,
      limit: 200,
      excludeCron: true,
      excludeSubagents: true,
    })
  ).sessions;

async function startOwnHost(): Promise<Host> {
  const data = mkdtempSync(join(tmpdir(), "clawtrate-rail-"));
  const started = startHost(INSTANCE, STATIC, data);
  started.gated.release();
  const host = { child: started.host, url: await started.url, data };
  hosts.push(host);
  return host;
}

async function pairedPage(browser: Browser, host: Host): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const next = await context.newPage();
  await next.goto(host.url);
  await next.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(next.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  await expect(next.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
  return next;
}

const botRow = (on: Page, name: string) =>
  on.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${name}\\b`) });
const taskRow = (on: Page, title: string) =>
  on.getByTestId("task").filter({ hasText: title }).first();

/** Show a bot's tasks, every one of them. */
async function unfold(on: Page, name: string): Promise<void> {
  const row = botRow(on, name).first();
  if ((await row.getAttribute("aria-expanded")) === "false") {
    await row.focus();
    await on.keyboard.press("ArrowRight");
  }
  const showAll = on
    .getByRole("list", { name: `${name}'s tasks` })
    .getByRole("button", { name: /^Show all/ });
  if (await showAll.count()) await showAll.click();
}

async function taskMenu(on: Page, title: string): Promise<void> {
  await taskRow(on, title).focus();
  await on.keyboard.press("Shift+F10");
  await expect(on.getByRole("menu")).toBeVisible();
}

/** A task of its own for one check, made on the gateway and listed by both pages. */
async function ownTask(
  botId: string,
  bot: string,
  label: string,
): Promise<{ key: string; title: string }> {
  const title = `${label} ${STAMP}`;
  const created = await gatewayCall<{ key: string }>("sessions.create", {
    agentId: botId,
    label: title,
  });
  made.add(created.key);
  for (const on of [page, second]) {
    await unfold(on, bot);
    await expect(taskRow(on, title)).toBeVisible({ timeout: 20_000 });
  }
  return { key: created.key, title };
}

async function reload(on: Page): Promise<void> {
  await on.reload();
  await expect(on.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
}

async function shot(on: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await on.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  expect(INSTANCE, "a named instance").toMatch(/^[a-z0-9-]+$/);
  watcher = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate rail check",
    ["operator.read"],
    ["tool-events"],
  );
  await watcher.request("sessions.subscribe", {});
  page = await pairedPage(browser, await startOwnHost());
  // Interactive access, asked as the person asks it: Request access in the access bar.
  await botRow(page, "Pip").first().click();
  const bar = page.getByRole("region", { name: "Access" });
  await bar.getByRole("button", { name: "Request access" }).click();
  await expect(bar).toContainText("Waiting for the gateway's owner.");
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 });
  second = await pairedPage(browser, await startOwnHost());
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  // Put the arrangement back as it was: no pins, no sections.
  if (page) {
    await page
      .evaluate(
        async (changes) => {
          for (const change of changes) {
            await new Promise<void>((resolve) => {
              const socket = new WebSocket(`ws://${location.host}/bridge`);
              socket.onmessage = (event) => {
                const message = JSON.parse(String(event.data)) as { type: string; id?: string };
                if (message.type === "hello")
                  socket.send(
                    JSON.stringify({
                      type: "command",
                      id: "undo",
                      command: { type: "changeSidebar", change, base: null },
                    }),
                  );
                else if (message.id === "undo") {
                  socket.close();
                  resolve();
                }
              };
              socket.onerror = () => resolve();
            });
          }
        },
        [
          { op: "pin", botId: "pip", pinned: false },
          { op: "section", botId: "marlow", section: null },
        ],
      )
      .catch(() => {});
  }
  for (const key of made) {
    const row = await describe(key).catch(() => null);
    if (!row?.sessionId) continue;
    await gatewayCall("chat.abort", { sessionKey: key }).catch(() => {});
    if (!row.archived)
      await gatewayCall("sessions.patch", {
        key,
        archived: true,
        expectedSessionId: row.sessionId,
      }).catch(() => {});
    await gatewayCall("sessions.delete", {
      key,
      archivedOnly: true,
      deleteTranscript: true,
      expectedSessionId: row.sessionId,
    }).catch(() => {});
  }
  await watcher?.close();
  for (const host of hosts) {
    await stopChild(host.child);
    rmSync(host.data, { recursive: true, force: true });
  }
});

test("F-054 F-012: New task from the + at the top right creates an empty task on the gateway, selects it and focuses its composer", async () => {
  const before = new Set((await listed("pip")).map((row) => row.key));
  await botRow(page, "Pip").first().click();
  const plus = page.locator(".rail-top").getByRole("button", { name: "New", exact: true });
  await plus.click();
  await page.getByRole("menuitem", { name: "New task for Pip" }).click();
  await expect(page.getByTestId("composer-input")).toBeFocused({ timeout: 20_000 });
  await expect(page.locator(".title-pill-task")).toHaveText("New task");
  // One new task on the gateway, under Pip, with no run started.
  let created: Row | undefined;
  await expect
    .poll(
      async () => {
        created = (await listed("pip")).find((row) => !before.has(row.key));
        return created?.key ?? null;
      },
      { timeout: 20_000 },
    )
    .toMatch(/^agent:pip:dashboard:/);
  made.add(created!.key);
  expect(created!.hasActiveRun ?? false).toBe(false);
  await expect(page.locator(`.task[data-key="${created!.key}"]`)).toHaveAttribute(
    "aria-current",
    "true",
  );
  // The second device lists it too.
  await unfold(second, "Pip");
  await expect(second.locator(`.task[data-key="${created!.key}"]`)).toBeVisible({
    timeout: 20_000,
  });
});

test("F-055: two tasks of one bot never show each other's messages", async () => {
  const first = await ownTask("pip", "Pip", "Separate one");
  const other = await ownTask("pip", "Pip", "Separate two");
  await taskRow(page, first.title).click();
  const words = `Only in the first task ${STAMP}`;
  await page.getByTestId("composer-input").fill(words);
  await page.getByTestId("composer-input").press("Enter");
  await expect(page.getByTestId("transcript")).toContainText(words, { timeout: 30_000 });
  await taskRow(page, other.title).click();
  await expect(page.locator(".title-pill-task")).toHaveText(other.title);
  await expect(page.getByRole("region", { name: "Conversation" })).not.toContainText(words);
  // And on the gateway: each history is its own.
  const history = async (key: string) =>
    JSON.stringify(await gatewayCall("chat.history", { sessionKey: key, limit: 50 }));
  expect(await history(first.key)).toContain(words);
  expect(await history(other.key)).not.toContain(words);
});

test("F-056: a rename in place reaches the gateway, survives a reload and is seen by the second connection", async () => {
  const task = await ownTask("pip", "Pip", "Rename me");
  const renamed = `Renamed ${STAMP}`;
  await taskRow(page, task.title).dblclick();
  await page.getByRole("textbox", { name: `Rename ${task.title}` }).fill(renamed);
  await page.keyboard.press("Enter");
  await expect(taskRow(page, renamed)).toBeFocused({ timeout: 20_000 });
  await gateway.poll(async () => (await describe(task.key))?.label).toBe(renamed);
  await expect(taskRow(second, renamed)).toBeVisible({ timeout: 20_000 });
  await shot(page, "renamed-light-1440");
  await reload(page);
  await unfold(page, "Pip");
  await expect(taskRow(page, renamed)).toBeVisible({ timeout: 20_000 });
});

test("F-014: a task's pin reaches the gateway, survives a reload and is seen by the second connection", async () => {
  const task = await ownTask("pip", "Pip", "Pin me");
  await taskMenu(page, task.title);
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await gateway.poll(async () => (await describe(task.key))?.pinned).toBe(true);
  for (const on of [page, second]) {
    await expect(
      on.getByRole("list", { name: "Pip's tasks" }).getByTestId("task").first(),
    ).toHaveAccessibleName(new RegExp(`^${task.title}, pinned`), { timeout: 20_000 });
  }
  await reload(page);
  await unfold(page, "Pip");
  await expect(
    page.getByRole("list", { name: "Pip's tasks" }).getByTestId("task").first(),
  ).toHaveAccessibleName(new RegExp(`^${task.title}, pinned`));
  await taskMenu(page, task.title);
  await page.getByRole("menuitem", { name: "Unpin" }).click();
  await gateway.poll(async () => (await describe(task.key))?.pinned ?? false).toBe(false);
});

test("F-022: Mark as unread reaches the gateway, survives a reload and is seen by the second connection; opening reads it", async () => {
  const task = await ownTask("pip", "Pip", "Unread me");
  await gateway.poll(async () => (await describe(task.key))?.unread ?? false).toBe(false);
  await taskMenu(page, task.title);
  await page.getByRole("menuitem", { name: "Mark as unread" }).click();
  await gateway.poll(async () => (await describe(task.key))?.unread).toBe(true);
  await expect(taskRow(second, task.title).locator(".unread-dot")).toHaveCount(1, {
    timeout: 20_000,
  });
  await reload(page);
  await unfold(page, "Pip");
  await expect(taskRow(page, task.title).locator(".unread-dot")).toHaveCount(1, {
    timeout: 20_000,
  });
  // Opening it on the writing device reads it on the gateway, and the other device sees that.
  await taskRow(page, task.title).click();
  await expect
    .poll(async () => (await describe(task.key))?.unread, { timeout: 20_000 })
    .toBe(false);
  await expect(taskRow(second, task.title).locator(".unread-dot")).toHaveCount(0, {
    timeout: 20_000,
  });
});

test("F-277: Archive moves a task into the bot's Archived group on the gateway, survives a reload and leaves the second connection's list; Restore brings it back", async () => {
  const task = await ownTask("pip", "Pip", "Archive me");
  await taskMenu(page, task.title);
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await gateway.poll(async () => (await describe(task.key))?.archived).toBe(true);
  await expect(taskRow(second, task.title)).toHaveCount(0, { timeout: 20_000 });
  await reload(page);
  await unfold(page, "Pip");
  await expect(taskRow(page, task.title)).toHaveCount(0);
  await page
    .getByRole("list", { name: "Pip's tasks" })
    .getByRole("button", { name: "Archived" })
    .click();
  const archived = page.getByRole("list", { name: "Pip's archived tasks" });
  await expect(archived.getByTestId("archived-task").filter({ hasText: task.title })).toBeVisible({
    timeout: 20_000,
  });
  await shot(page, "archived-light-1440");
  await archived.getByTestId("archived-task").filter({ hasText: task.title }).click();
  await page.getByRole("menuitem", { name: "Restore" }).click();
  await gateway.poll(async () => (await describe(task.key))?.archived ?? false).toBe(false);
  await expect(taskRow(second, task.title)).toBeVisible({ timeout: 20_000 });
});

test("F-278: Delete, confirmed, stops the task's active run first and removes its transcript", async () => {
  const task = await ownTask("pip", "Pip", "Delete me");
  await taskRow(page, task.title).click();
  await page.getByTestId("composer-input").fill("#slow 40");
  await page.getByTestId("composer-input").press("Enter");
  await expect
    .poll(async () => (await describe(task.key))?.hasActiveRun, { timeout: 30_000 })
    .toBe(true);
  await taskMenu(page, task.title);
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const dialog = page.getByRole("dialog", { name: `Delete “${task.title}”?` });
  await expect(dialog).toContainText("Its run is stopped first.");
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  // The run was stopped by an abort, not finished, before the task went.
  await expect
    .poll(
      () =>
        watcher.events.some(
          (event) =>
            event.event === "agent" &&
            (event.payload as { sessionKey?: string }).sessionKey === task.key &&
            (event.payload as { data?: { phase?: string } }).data?.phase === "end",
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
  const ended = watcher.events.filter(
    (event) =>
      event.event === "chat" && (event.payload as { sessionKey?: string }).sessionKey === task.key,
  );
  expect(ended.some((event) => (event.payload as { state?: string }).state === "aborted")).toBe(
    true,
  );
  await gateway.poll(async () => await describe(task.key)).toBeNull();
  expect((await listed("pip", "all")).some((row) => row.key === task.key)).toBe(false);
  await expect(taskRow(page, task.title)).toHaveCount(0);
  await expect(taskRow(second, task.title)).toHaveCount(0, { timeout: 20_000 });
});

test("F-014 F-016: a bot's pin and its section are kept on the gateway for the user: they survive a reload and the second device shows them", async () => {
  await botRow(page, "Pip").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect(page.getByRole("list", { name: "Pinned bots" }).locator(".pin")).toHaveCount(1, {
    timeout: 20_000,
  });
  await botRow(page, "Marlow").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  await page.getByRole("menuitem", { name: "New section…" }).click();
  await page.getByRole("textbox", { name: "Section name" }).fill("Writing");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("list", { name: "Writing" }).getByTestId("bot")).toHaveCount(1, {
    timeout: 20_000,
  });
  // The other device, a different browser and host with nothing of this one's, shows both.
  await expect(second.getByRole("list", { name: "Pinned bots" }).locator(".pin")).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(
    second.getByRole("list", { name: "Writing" }).getByTestId("bot"),
  ).toHaveAccessibleName(/^Marlow/);
  await shot(page, "pins-sections-light-1440");
  await reload(second);
  await expect(second.getByRole("list", { name: "Pinned bots" }).locator(".pin")).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(second.locator(".rail-section", { hasText: "Writing" })).toBeVisible();
  // On the read-only device the gateway's arrangement offers no change.
  await botRow(second, "Marlow").first().click({ button: "right" });
  const items = await second.getByRole("menu").getByRole("menuitem").allTextContents();
  expect(items).not.toContain("Pin");
  expect(items).not.toContain("Move to…");
  await second.keyboard.press("Escape");
});

test("F-021 F-057: while a bot's run waits for an approval its row says Waiting for you on both devices; stopped, the state clears and the task says stopped where it was not open", async () => {
  const task = await ownTask("otto", "Otto", "Wait for me");
  await taskRow(page, task.title).click();
  await page.getByTestId("composer-input").fill("#approve");
  await page.getByTestId("composer-input").press("Enter");
  for (const on of [page, second]) {
    const otto = botRow(on, "Otto").first();
    await expect(otto).toHaveAccessibleName(/^Otto, waiting for you/, { timeout: 30_000 });
    await expect(otto.locator(".presence")).toHaveAttribute("data-state", "waiting");
  }
  await expect(botRow(second, "Otto").first().locator(".bot-preview")).toHaveText(
    "Waiting for you: approve a command",
  );
  await expect(taskRow(second, task.title)).toHaveAccessibleName(/, needs you$/);
  await shot(second, "waiting-light-1440");
  // Stopped: nothing is pending, and the state clears everywhere.
  await gatewayCall("chat.abort", { sessionKey: task.key });
  for (const on of [page, second]) {
    await expect(botRow(on, "Otto").first()).not.toHaveAccessibleName(/waiting for you/, {
      timeout: 30_000,
    });
  }
  // The gateway's row keeps no status for a stopped run; the lifecycle's end said so.
  await expect(taskRow(second, task.title)).toHaveAccessibleName(/, stopped$/, { timeout: 20_000 });
  await expect(taskRow(second, task.title).locator(".glyph")).toHaveAttribute(
    "data-state",
    "stopped",
  );
});

test("F-424: the gateway keeps a bot's main session unarchived; a bot without one gets a new empty Main when its last task is archived", async () => {
  // A main session can be neither archived nor deleted, so a bot that has one always keeps a task.
  const main = await describe("agent:marlow:main");
  expect(main?.sessionId).toBeTruthy();
  const refused = await openInstance(INSTANCE).runner.run([
    "gateway",
    "call",
    "sessions.patch",
    "--params",
    JSON.stringify({
      key: "agent:marlow:main",
      archived: true,
      expectedSessionId: main!.sessionId,
    }),
    "--json",
  ]);
  expect(refused.stdout + refused.stderr).toContain("Cannot archive an agent's main session.");
  await unfold(page, "Marlow");
  await taskMenu(page, "Notes for Pip");
  const items = await page.getByRole("menu").getByRole("menuitem").allTextContents();
  expect(items).not.toContain("Archive");
  expect(items).not.toContain("Delete…");
  await page.keyboard.press("Escape");

  // A bot of this check's own, made on the gateway, has no main session: one task, then none.
  const state = openInstance(INSTANCE).stateDir;
  const name = `Scout${STAMP}`;
  const created = await gatewayCall<{ agentId: string }>("agents.create", {
    name,
    workspace: join(state, "workspaces", `scout-${STAMP}`),
    model: "scripted/dev-1",
  });
  const botId = created.agentId;
  try {
    // The gateway applies the new bot's config by itself, shortly after: wait until it lists it.
    await expect
      .poll(
        async () =>
          (await gatewayCall<{ agents: Array<{ id: string }> }>("agents.list", {})).agents.some(
            (agent) => agent.id === botId,
          ),
        { timeout: 60_000, intervals: [1000] },
      )
      .toBe(true);
    const only = await gatewayCall<{ key: string }>("sessions.create", {
      agentId: botId,
      label: `Only task ${STAMP}`,
    });
    made.add(only.key);
    await page.reload();
    await expect(page.getByTestId("bot")).toHaveCount(5, { timeout: 60_000 });
    const scout = botRow(page, name).first();
    await expect(scout).toHaveAccessibleName(new RegExp(`^${name}, 1 task`), { timeout: 20_000 });
    await scout.click();
    await scout.focus();
    await page.keyboard.press("Shift+F10");
    await page.getByRole("menuitem", { name: "Archive task" }).click();
    await expect(page.locator(".title-pill-task")).toHaveText("Main", { timeout: 20_000 });
    let unarchived: Row[] = [];
    await gateway
      .poll(async () => {
        unarchived = await listed(botId);
        return unarchived.map((row) => row.label);
      })
      .toEqual(["Main"]);
    made.add(unarchived[0]!.key);
    expect((await describe(only.key))?.archived).toBe(true);
    await expect(page.getByTestId("composer-input")).toBeVisible();
  } finally {
    await gatewayCall("agents.delete", { agentId: botId, deleteFiles: true }).catch(() => {});
    await expect
      .poll(
        async () =>
          (await gatewayCall<{ agents: Array<{ id: string }> }>("agents.list", {})).agents.some(
            (agent) => agent.id === botId,
          ),
        { timeout: 60_000, intervals: [1000] },
      )
      .toBe(false);
    await page.reload();
    await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 60_000 });
  }
});

test("a read-only connection offers none of the task actions on a real gateway", async () => {
  await expect(
    second.locator(".rail-top").getByRole("button", { name: "New", exact: true }),
  ).toHaveCount(0);
  await unfold(second, "Pip");
  await expect(second.getByTestId("new-task-row")).toHaveCount(0);
  await expect(second.getByTestId("archived-group")).toHaveCount(0);
  const first = second.getByRole("list", { name: "Pip's tasks" }).getByTestId("task").first();
  await first.focus();
  await second.keyboard.press("Shift+F10");
  await expect(second.getByRole("menu").getByRole("menuitem")).toHaveText(["Copy conversation ID"]);
  await second.keyboard.press("Escape");
  await second.keyboard.press("F2");
  await expect(second.getByTestId("task-rename")).toHaveCount(0);
});
