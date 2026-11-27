// A person's message from Clawtrate tells the bot so (#666), against this run's own development
// gateway: the app's `chat.send` carries `workContext {page: "Clawtrate"}`, which the gateway
// adds to the model's copy of the message after the person's words. What the person sees stays
// exactly what they typed: in the conversation, after a reload, on another device, in the rail,
// in search and in another client of the same gateway. A command and a stop word, which the
// gateway takes the field on only for ordinary messages, go without it and still work.
//
// Two preview hosts of its own, each a paired device of its own, and a paired operator that
// creates the spec's task, reads it as another client would, and removes it afterwards.
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instancePorts, openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import { SYSTEM_PROMPT_PATH } from "../tools/dev-gateway/src/fake-provider.ts";
import { plainPreview } from "../packages/core/src/mapping.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { WORK_CONTEXT_LINE } from "../tools/dev-gateway/src/scripts.ts";
import { approveDevice } from "./approve.ts";
import { startHost, stopChild } from "./global-setup.ts";
import { leaveIdle } from "./teardown.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const SINCE = Date.now();
const STAMP = SINCE.toString(36);
const KEY = `agent:marlow:e2e-marker-${STAMP}`;
const TITLE = `Marker check ${STAMP}`;
/** What the person types: a word of the run's own, so search finds this message alone. */
const WORDS = `Where are you today, ${STAMP}?`;
/**
 * A slow message of a length whose preview the gateway cuts inside the marker (240 characters
 * with "..."), so the rail's preview of it shows whether the marker comes off a cut.
 */
const SLOW = `Look over the photos folder and the backup, then tell me what changed since last week and what still needs doing, ${STAMP} #slow 30`;
/** What the gateway adds to the model's copy, on OpenClaw 2026.10.6 and 2026.11.10. */
const MARKER = `${WORK_CONTEXT_LINE}\n{"page":"Clawtrate"}`;

type Host = { child: ChildProcess; data: string };
const hosts: Host[] = [];
let page: Page;
let other: OperatorSession;
/** Tasks this spec made, removed afterwards. */
const made = new Set<string>([KEY]);

async function gatewayCall<T>(method: string, params: unknown): Promise<T> {
  const result = await openInstance(INSTANCE).runner.run([
    "gateway",
    "call",
    method,
    "--params",
    JSON.stringify(params),
    "--json",
  ]);
  if (result.status !== 0) throw new Error(`${method} failed:\n${result.stdout}${result.stderr}`);
  return parseJsonOutput<T>(result.stdout);
}

/** A preview host of its own, a device of its own, paired and showing the bots. */
async function pairedDevice(browser: Browser, name: string): Promise<Page> {
  const data = mkdtempSync(join(tmpdir(), `clawtrate-marker-${name}-`));
  const started = startHost(INSTANCE, STATIC, data);
  hosts.push({ child: started.host, data });
  started.gated.release();
  const url = await started.url;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const next = await context.newPage();
  await next.goto(url);
  await next.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(next.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await approveDevice(INSTANCE);
  await expect(next.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
  return next;
}

const botRow = (on: Page, name: string) =>
  on.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${name}\\b`) });
/** Marlow's task list, opened and shown in full, as the rail shows it to a person. */
async function unfoldMarlow(on: Page): Promise<void> {
  const row = botRow(on, "Marlow").first();
  await row.click();
  if ((await row.getAttribute("aria-expanded")) === "false") {
    await row.focus();
    await on.keyboard.press("ArrowRight");
  }
  const showAll = on
    .getByRole("list", { name: "Marlow's tasks" })
    .getByRole("button", { name: /^Show all/ });
  if (await showAll.count()) await showAll.click();
}
const openTask = async (on: Page, key = KEY) => {
  await unfoldMarlow(on);
  await on.locator(`.task[data-key="${key}"]`).click({ timeout: 30_000 });
};
const userMessages = (on: Page) => on.locator('.msg[data-role="user"]');

/** The model's copy of the latest user message in a task, the spec's own by default. */
async function modelCopy(key = KEY): Promise<string | null> {
  const provider = `http://127.0.0.1:${instancePorts(openInstance(INSTANCE)).providerPort}`;
  const answer = (await (
    await fetch(`${provider}${SYSTEM_PROMPT_PATH}?session=${encodeURIComponent(key)}`)
  ).json()) as { user: string | null };
  return answer.user;
}

/** Marlow's task keys as the gateway lists them. */
async function marlowTasks(): Promise<string[]> {
  const rows = await other.request<{ sessions: { key: string }[] }>("sessions.list", {
    limit: 200,
  });
  return rows.sessions.map((row) => row.key).filter((key) => key.startsWith("agent:marlow:"));
}

/** Every text a user message of the task's history holds, as another client reads it. */
async function historyTexts(): Promise<string[]> {
  const history = await other.request<{ messages: { role: string; content: unknown }[] }>(
    "chat.history",
    { sessionKey: KEY, limit: 50 },
  );
  return history.messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content as { text?: string }[]).map((part) => part.text ?? "").join(""),
    );
}

/** Nothing of the marker in what a page shows. */
async function expectNoMarker(on: Page) {
  const shown = await on.locator("body").innerText();
  expect(shown).not.toContain("Working context");
  expect(shown).not.toContain('"page"');
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  expect(INSTANCE, "a named instance").toMatch(/^[a-z0-9-]+$/);
  other = await openOperator(
    openInstance(INSTANCE),
    "Another client",
    ["operator.read", "operator.write"],
    [],
  );
  await other.request("sessions.create", { key: KEY, agentId: "marlow", label: TITLE });
  page = await pairedDevice(browser, "a");
  // Interactive access, asked as the person asks it: Request access in the access bar.
  await botRow(page, "Marlow").first().click();
  await page
    .getByRole("region", { name: "Access" })
    .getByRole("button", { name: "Request access" })
    .click();
  await approveDevice(INSTANCE);
  await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  for (const host of hosts) {
    await stopChild(host.child).catch(() => host.child.kill("SIGKILL"));
    rmSync(host.data, { recursive: true, force: true });
  }
  await leaveIdle(gatewayCall, SINCE).catch(() => {});
  for (const key of made) {
    const row = await gatewayCall<{ session: { sessionId?: string } | null }>("sessions.describe", {
      key,
    }).catch(() => null);
    const sessionId = row?.session?.sessionId;
    if (!sessionId) continue;
    await gatewayCall("sessions.patch", { key, archived: true, expectedSessionId: sessionId })
      .then(() =>
        gatewayCall("sessions.delete", {
          key,
          archivedOnly: true,
          deleteTranscript: true,
          expectedSessionId: sessionId,
        }),
      )
      .catch(() => {});
  }
  await other?.close();
});

test("#666: the model's copy of a message from Clawtrate says so, and what the person sees is what they typed", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  await openTask(page);
  await page.getByTestId("composer-input").fill(WORDS);
  await page.getByTestId("composer-input").press("Enter");
  // The scripted model answers an unscripted message by quoting it, as it reads it.
  await expect(page.getByTestId("transcript").getByText("It has no reply written for")).toBeVisible(
    {
      timeout: 60_000,
    },
  );

  // The model was given the words, then the marker.
  await expect.poll(modelCopy, { timeout: 30_000 }).toContain(`${WORDS}\n\n${MARKER}`);

  // The conversation shows the words alone.
  await expect(userMessages(page).filter({ hasText: STAMP })).toHaveCount(1);
  expect((await userMessages(page).filter({ hasText: STAMP }).innerText()).trim()).toBe(WORDS);
  await expectNoMarker(page);

  // Another client of the gateway reads the words alone.
  expect(await historyTexts()).toEqual([WORDS]);

  // The rail's preview, from the rows Clawtrate reads.
  const rows = await other.request<{ sessions: { key: string; lastMessagePreview?: string }[] }>(
    "sessions.list",
    { includeLastMessage: true, limit: 200 },
  );
  expect(rows.sessions.find((row) => row.key === KEY)?.lastMessagePreview ?? "").not.toContain(
    "Working context",
  );
  await expect(botRow(page, "Marlow").first()).not.toContainText("Working context");

  // Search finds the message by its words, and shows them without the marker; the marker's own
  // words find nothing of it.
  await page.keyboard.press("ControlOrMeta+K");
  const palette = page.getByTestId("search-palette");
  const box = palette.getByRole("combobox", { name: "Search" });
  await box.fill(STAMP);
  await expect(palette.getByTestId("search-announcer")).not.toHaveText("", { timeout: 20_000 });
  const found = palette.getByTestId("search-group-messages").getByRole("option");
  await expect(found.filter({ hasText: STAMP }).first()).toBeVisible({ timeout: 20_000 });
  for (const text of await found.allInnerTexts()) expect(text).not.toContain("Working context");
  await box.fill("Working context captured at send time");
  await expect(palette.getByTestId("search-announcer")).not.toHaveText("", { timeout: 20_000 });
  await expect(palette.getByRole("option").filter({ hasText: STAMP })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // After a reload, from the gateway's history.
  await page.reload();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
  await openTask(page);
  await expect(userMessages(page).filter({ hasText: STAMP })).toHaveCount(1, { timeout: 30_000 });
  expect((await userMessages(page).filter({ hasText: STAMP }).innerText()).trim()).toBe(WORDS);
  await expectNoMarker(page);

  // On another device.
  const second = await pairedDevice(browser, "b");
  await openTask(second);
  await expect(userMessages(second).filter({ hasText: STAMP })).toHaveCount(1, { timeout: 30_000 });
  expect((await userMessages(second).filter({ hasText: STAMP }).innerText()).trim()).toBe(WORDS);
  await expectNoMarker(second);
  await second.context().close();
});

test("#666: a command and a stop word, which can't carry the marker, still work", async () => {
  test.setTimeout(240_000);
  await openTask(page);
  // A command: the gateway answers it itself.
  await page.getByTestId("composer-input").fill("/status");
  await page.getByTestId("composer-input").press("Enter");
  await expect(
    page
      .getByTestId("transcript")
      .getByText(/OpenClaw 2026\.\d+\.\d+/)
      .first(),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("transcript").getByText("Couldn't start")).toHaveCount(0);

  // A stop word stops the run that is going.
  await page.getByTestId("composer-input").fill(SLOW);
  await page.getByTestId("composer-input").press("Enter");
  await expect(page.getByRole("button", { name: "Stop Marlow" })).toBeVisible({ timeout: 30_000 });
  // The person's slow message reached the model with the marker.
  await expect.poll(modelCopy, { timeout: 30_000 }).toContain(`${SLOW}\n\n${MARKER}`);
  // While it runs, the gateway's preview of the task is the start of the model's copy, cut inside
  // the marker; the task's preview, as Clawtrate reads the row, is the words alone.
  const listed = async () =>
    (
      await other.request<{ sessions: { key: string; lastMessagePreview?: string }[] }>(
        "sessions.list",
        { includeLastMessage: true, limit: 200 },
      )
    ).sessions.find((row) => row.key === KEY)?.lastMessagePreview ?? "";
  await expect.poll(listed, { timeout: 20_000 }).toMatch(/^Look over the photos folder/);
  const preview = await listed();
  expect(preview).toContain("Working context");
  expect(preview).toMatch(/\.\.\.$/);
  expect(plainPreview(preview)).toBe(SLOW);
  await page.getByTestId("composer-input").fill("stop");
  await page.getByTestId("composer-input").press("Enter");
  await expect(page.getByRole("button", { name: "Stop Marlow" })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.getByTestId("transcript").getByText("Couldn't start")).toHaveCount(0);
  // Neither the command nor the stop word was asked of the model.
  expect(await modelCopy()).toContain(`${SLOW}\n\n${MARKER}`);
  await expectNoMarker(page);
});

test("#666 #743: a task's first message carries the marker, from New task and from Start as new task, and each shows as typed", async () => {
  test.setTimeout(240_000);
  // New task from the rail: created empty, its first message sent as any other.
  const before = new Set(await marlowTasks());
  await botRow(page, "Marlow").first().click();
  await page.locator(".rail-top").getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "New task for Marlow" }).click();
  await expect(page.getByTestId("composer-input")).toBeFocused({ timeout: 20_000 });
  const first = `First words, ${STAMP}`;
  await page.getByTestId("composer-input").fill(first);
  await page.getByTestId("composer-input").press("Enter");
  let created = "";
  await expect
    .poll(async () => (created = (await marlowTasks()).find((key) => !before.has(key)) ?? ""), {
      timeout: 30_000,
    })
    .not.toBe("");
  made.add(created);
  await expect
    .poll(() => modelCopy(created), { timeout: 60_000 })
    .toContain(`${first}\n\n${MARKER}`);
  await expect(userMessages(page).filter({ hasText: first })).toHaveCount(1, { timeout: 30_000 });
  expect((await userMessages(page).filter({ hasText: first }).innerText()).trim()).toBe(first);

  // Start as new task: created without the words, which follow by `chat.send`, marked (#743).
  const known = new Set(await marlowTasks());
  await openTask(page);
  const started = `Started apart, ${STAMP}`;
  await page.getByTestId("composer-input").fill(started);
  await page.getByTestId("composer-input").press("Shift+ControlOrMeta+Enter");
  let apart = "";
  await expect
    .poll(async () => (apart = (await marlowTasks()).find((key) => !known.has(key)) ?? ""), {
      timeout: 30_000,
    })
    .not.toBe("");
  made.add(apart);
  await expect
    .poll(() => modelCopy(apart), { timeout: 60_000 })
    .toContain(`${started}\n\n${MARKER}`);
  await openTask(page, apart);
  await expect(userMessages(page).filter({ hasText: started })).toHaveCount(1, { timeout: 30_000 });
  expect((await userMessages(page).filter({ hasText: started }).innerText()).trim()).toBe(started);
  await expectNoMarker(page);
  // Another client of the gateway reads the words alone, once.
  const apartHistory = await other.request<{ messages: { role: string; content: unknown }[] }>(
    "chat.history",
    { sessionKey: apart, limit: 50 },
  );
  const apartWords = apartHistory.messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content as { text?: string }[]).map((part) => part.text ?? "").join(""),
    );
  expect(apartWords).toEqual([started]);
  // The rail's title for it shows none of the marker.
  await expect(page.locator(`.task[data-key="${apart}"]`)).not.toContainText("Working context");
});
