// A bot's and a task's model and effort (docs/design/bots.md section 9 and
// docs/design/conversation.md section 25) against a real development gateway:
// this run's accounts instance, whose scripted provider `acme` serves `dev-1`,
// `dev-2` and `dev-lite` (tools/dev-gateway/README.md). The interface runs on a
// preview host of its own and is driven as a person drives it; what landed is
// read from the gateway, from a second connection, and from the scripted
// model's record of which model and account each request asked for.
//
// The checks make a bot of their own, Quill, on `acme:work`, and remove it at
// the end, so nothing they change reaches the bots of any other check. The
// task's checks come before the bot's: a write to a bot's entry makes the
// gateway reload once its running turns end, which would cut into a turn.
//
// With CLAWTRATE_MODEL_SHOTS=<folder outside the repository>, it also saves
// screenshots of what it checked there, at 1440 in both themes and 390 light.
import { expect, test, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_CLIENTS } from "../tools/dev-gateway/src/account-checks.ts";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { devGateway, listInstances, startHost, stopChild } from "./global-setup.ts";

const INSTANCE = process.env.CLAWTRATE_E2E_ACCOUNTS!;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const SHOTS = process.env.CLAWTRATE_MODEL_SHOTS ?? null;
const BOT = "quill";
const TASK = `agent:${BOT}:main`;

test.describe.configure({ mode: "serial" });

type Json = Record<string, unknown>;
type Host = { child: ChildProcess; url: string; data: string };
const hosts: Host[] = [];
let page: Page;
let admin: OperatorSession;
let reader: OperatorSession;
let providerUrl: string;

async function scripted<T = Json>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${providerUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await response.json()) as T;
}
type Request = { seq: number; account: string | null; model: string; session: string | null };
async function requestsFor(session: string): Promise<Request[]> {
  const all = await scripted<{ requests: Request[] }>("/scripted/requests");
  return all.requests.filter((each) => each.session === session);
}

/**
 * A change of the task from the second connection, sent again while the gateway answers it as
 * retryable, as it does while it settles a turn ("Session patch failed unexpectedly. Retry the request.").
 */
async function patchTask(params: Json): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await admin.request("sessions.patch", { key: TASK, ...params });
      return;
    } catch (error) {
      if ((error as { retryable?: unknown }).retryable !== true || attempt >= 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/** The task's row as a second connection reads it. */
async function row(): Promise<Json> {
  const list = await reader.request<{ sessions: Json[] }>("sessions.list", {
    agentId: BOT,
    limit: 20,
  });
  return list.sessions.find((each) => each.key === TASK) ?? {};
}

/**
 * The effort each run of a task's session started with, in order: the gateway reports none for a
 * run (conversation.md 25.5), so a check reads its debug log (`embedded run start: … thinking=`),
 * as a read-only client reads the log.
 */
async function runStarts(sessionId: string): Promise<string[]> {
  const found: string[] = [];
  const pattern =
    /embedded run start: runId=\S+ sessionId=(\S+) provider=\S+ model=\S+ thinking=(\w+)/;
  let cursor: number | undefined;
  for (let page = 0; page < 50; page += 1) {
    const tail = await reader.request<{ lines?: string[]; cursor?: number; size?: number }>(
      "logs.tail",
      { ...(cursor === undefined ? {} : { cursor }), limit: 5000, maxBytes: 1_000_000 },
    );
    for (const line of tail.lines ?? []) {
      const match = pattern.exec(line);
      if (match && match[1] === sessionId) found.push(match[2]!);
    }
    if (tail.cursor === undefined || tail.cursor === cursor || tail.cursor >= (tail.size ?? 0))
      break;
    cursor = tail.cursor;
  }
  return found;
}

/** The gateway runs with its latest config. */
async function configApplied(): Promise<void> {
  await expect
    .poll(
      () =>
        admin.request<Json>("config.get", {}).then(
          (now) => now.appliedConfigHash === now.configRevisionHash,
          () => false,
        ),
      { timeout: 120_000, intervals: [1000] },
    )
    .toBe(true);
}

async function approve(): Promise<void> {
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
}

async function shots(target: Page, name: string, sizes: Array<[number, number, "light" | "dark"]>) {
  if (!SHOTS) return;
  const size = target.viewportSize()!;
  for (const [width, height, theme] of sizes) {
    await target.setViewportSize({ width, height });
    await target.emulateMedia({ colorScheme: theme });
    await target.waitForTimeout(300);
    await target.screenshot({ path: join(SHOTS, `${name}-${theme}-${width}.png`) });
  }
  await target.setViewportSize(size);
  await target.emulateMedia({ colorScheme: "light" });
}
const DESKTOP_AND_PHONE: Array<[number, number, "light" | "dark"]> = [
  [1440, 900, "light"],
  [1440, 900, "dark"],
  [390, 844, "light"],
];

const botRow = (target: Page, name: string) =>
  target.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${name}\\b`) });
const chip = (target: Page) => target.getByTestId("model-chip");
const modelLines = (target: Page) => target.getByTestId("model-line");

/** Open Quill's one task. */
async function openQuill(target: Page) {
  await botRow(target, "Quill").click();
  await expect(target.locator("h1.task-line")).toHaveText("Main", { timeout: 20_000 });
}

/** Send from the composer once the task is idle, and wait for the gateway to report the turn running. */
async function startTurn(text: string) {
  await expect.poll(async () => (await row()).status, { timeout: 90_000 }).not.toBe("running");
  const field = page.getByTestId("composer-input");
  await field.fill(text);
  await field.press("Enter");
  await expect.poll(async () => (await row()).status, { timeout: 60_000 }).toBe("running");
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  expect(INSTANCE, "this run's accounts instance").toMatch(/^e2e-[0-9a-f]{8}-acct$/);
  const instance = listInstances().find((each) => each.name === INSTANCE);
  expect(instance?.gatewayRunning, "the accounts instance runs").toBe(true);
  providerUrl = `http://127.0.0.1:${instance!.providerPort}`;
  admin = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate models check",
    [...ACCOUNT_CLIENTS.admin.scopes],
    [...ACCOUNT_CLIENTS.admin.caps],
  );
  reader = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate models reader",
    [...ACCOUNT_CLIENTS.reader.scopes],
    [...ACCOUNT_CLIENTS.reader.caps],
  );
  // Quill, on acme:work with an empty fallback list, as New bot makes one, and its first task.
  const state = (await admin.request<{ config: Json }>("config.get", {})).config;
  const workspace = join(
    String((((state.agents as Json).entries as Json).main as Json | undefined)?.workspace ?? ""),
    "..",
    "workspaces",
    BOT,
  );
  await admin.request("agents.create", {
    name: "Quill",
    workspace,
    model: "acme/dev-1@acme:work",
  });
  const hash = (await admin.request<{ hash: string }>("config.get", {})).hash;
  await admin.request("config.patch", {
    raw: JSON.stringify({
      agents: { entries: { [BOT]: { model: { primary: "acme/dev-1@acme:work", fallbacks: [] } } } },
      // The effort a run starts with is in the debug log only; set back in afterAll.
      logging: { level: "debug" },
    }),
    baseHash: hash,
    replacePaths: [`agents.entries.${BOT}.model.fallbacks`],
  });
  await admin.request("sessions.create", { key: TASK, agentId: BOT, label: "Main" });
  // The gateway applies the new entry, reloading if it must, before the interface pairs.
  await configApplied();

  const data = mkdtempSync(join(tmpdir(), "clawtrate-models-"));
  const started = startHost(INSTANCE, STATIC, data);
  started.gated.release();
  hosts.push({ child: started.host, url: await started.url, data });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  await page.goto(hosts[0]!.url);
  await page.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await approve();
  await expect(botRow(page, "Quill")).toBeVisible({ timeout: 30_000 });
  await openQuill(page);
  // The interactive tier, from the composer's access bar, as a person asks for it.
  await page
    .getByRole("region", { name: "Access" })
    .getByRole("button", { name: "Request access" })
    .click();
  await approve();
  await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  // Quill goes, with its task, and the log's level with it: the gateway is as the checks found it.
  await admin?.request("agents.delete", { agentId: BOT, deleteFiles: true }).catch(() => {});
  await admin
    ?.request<{ hash: string }>("config.get", {})
    .then(({ hash }) =>
      admin.request("config.patch", {
        raw: JSON.stringify({ logging: { level: null } }),
        baseHash: hash,
      }),
    )
    .catch(() => {});
  await admin?.close();
  await reader?.close();
  for (const host of hosts) {
    await stopChild(host.child);
    rmSync(host.data, { recursive: true, force: true });
  }
});

test("F-042 F-045: a task's model changed during a turn is held, saved when the turn ends, and the next turn runs on it; the line is there live and after a reload", async () => {
  test.setTimeout(240_000);
  await expect(chip(page)).toHaveAccessibleName(/^Model for this task: acme\/dev-1, /, {
    timeout: 30_000,
  });
  await startTurn("#slow 10");
  await chip(page).click();
  await page.getByRole("menuitemradio", { name: "dev-2" }).click();
  await expect(chip(page)).toHaveAccessibleName(/Held until this turn ends/);
  await shots(page, "task-chip-held", [[1440, 900, "light"]]);
  // Not written while the turn runs: the gateway still has dev-1, and the turn asks for dev-1 only.
  expect((await row()).model).toBe("dev-1");
  await expect.poll(async () => (await row()).status, { timeout: 90_000 }).not.toBe("running");
  await expect.poll(async () => (await row()).model, { timeout: 90_000 }).toBe("dev-2");
  const first = await requestsFor(TASK);
  expect(first.length).toBeGreaterThan(0);
  expect(first.every((each) => each.model === "dev-1")).toBe(true);
  await expect(modelLines(page).last()).toHaveText(
    "Model changed to acme/dev-2 · from the next turn",
    { timeout: 30_000 },
  );
  await expect(chip(page)).toHaveAccessibleName(/^Model for this task: acme\/dev-2, /);

  // The next turn is served by dev-2, on Quill's own account.
  const before = (await requestsFor(TASK)).length;
  const field = page.getByTestId("composer-input");
  // A turn with an action, so it ends with a run line and its record.
  await field.fill("#list");
  await field.press("Enter");
  await expect
    .poll(async () => (await requestsFor(TASK)).length, { timeout: 60_000 })
    .toBeGreaterThan(before);
  const next = (await requestsFor(TASK)).slice(before);
  expect(next.map((each) => each.model)).toEqual(next.map(() => "dev-2"));
  // Quill is bound to acme:work, not locked: the gateway may serve the turn on another account of
  // the provider (bots.md section 10, "Bound"); the annotation says which it was.
  expect(next.every((each) => each.account?.startsWith("acme:"))).toBe(true);
  test.info().annotations.push({
    type: "served by",
    description: next.map((each) => `${each.model} on ${each.account}`).join(", "),
  });
  await expect.poll(async () => (await row()).status, { timeout: 60_000 }).not.toBe("running");

  // The turn's run line states no effort: the gateway reported none for the run (25.5).
  const runLine = page.getByTestId("run-line").last();
  await expect(runLine).toBeVisible({ timeout: 30_000 });
  await runLine.locator("summary").click();
  await expect(runLine).not.toContainText(/effort/);
  await shots(page, "task-record", DESKTOP_AND_PHONE);
  await chip(page).click();
  await shots(page, "task-chip-menu", [
    [1440, 900, "light"],
    [1440, 900, "dark"],
  ]);
  await page.keyboard.press("Escape");

  // After a reload: the line is this device's record, read back.
  await page.reload();
  await openQuill(page);
  await expect(modelLines(page).first()).toHaveText(
    "Model changed to acme/dev-2 · from the next turn",
    { timeout: 30_000 },
  );
  await shots(page, "task-line", DESKTOP_AND_PHONE);
});

test("F-043 F-045: a held change of effort that the gateway refuses says why, and the chip shows what the gateway has", async () => {
  test.setTimeout(240_000);
  await startTurn("#slow 10");
  await chip(page).click();
  await page.getByRole("menuitemradio", { name: "High" }).click();
  await expect(chip(page)).toHaveAccessibleName(/High effort\. Held until this turn ends/);
  // Meanwhile another connection moves the task to dev-lite, which offers Off and Ultra only.
  await patchTask({ model: "acme/dev-lite@acme:work" });
  await expect.poll(async () => (await row()).status, { timeout: 90_000 }).not.toBe("running");
  const refused = modelLines(page).last();
  await expect(refused).toHaveText(
    /^Couldn't change the effort to High: thinkingLevel "high" is not supported for acme\/dev-lite/,
    { timeout: 30_000 },
  );
  await expect(refused).toHaveAttribute("data-tone", "warn");
  await expect(chip(page)).toHaveAccessibleName(
    "Model for this task: acme/dev-lite, Off effort. Change.",
    {
      timeout: 30_000,
    },
  );
  expect((await row()).thinkingLevel).toBeUndefined();
  await page.getByRole("button", { name: "Show work panel" }).click();
  await expect(page.getByTestId("task-model-line")).toContainText(
    `Couldn't change the effort: thinkingLevel "high" is not supported for acme/dev-lite`,
  );
  await shots(page, "task-refused", DESKTOP_AND_PHONE);
  await page.getByRole("button", { name: "Hide work panel" }).click();
  // Put back for any later check: dev-1, as the bot has it.
  await patchTask({ model: "acme/dev-1@acme:work" });
});

test("F-042: a model chosen in the app keeps the account another client chose for the task, and the next turn is served on it", async () => {
  test.setTimeout(240_000);
  // The first client chooses acme:home for the task; Quill itself is bound to acme:work.
  await patchTask({ model: "acme/dev-1@acme:home" });
  const selected = async () =>
    (
      (await reader.request<Json>("models.list", { sessionKey: TASK })).accountSelection as
        Json | undefined
    )?.authProfileId;
  await expect.poll(selected, { timeout: 30_000 }).toBe("acme:home");
  await expect(chip(page)).toHaveAccessibleName(/^Model for this task: acme\/dev-1, /, {
    timeout: 30_000,
  });
  // The app, on the second client, changes only the model.
  await chip(page).click();
  await page.getByRole("menuitemradio", { name: "dev-2" }).click();
  await expect.poll(async () => (await row()).model, { timeout: 60_000 }).toBe("dev-2");
  // The account that remains is the first client's.
  expect(await selected()).toBe("acme:home");
  const before = (await requestsFor(TASK)).length;
  const field = page.getByTestId("composer-input");
  await field.fill("#text");
  await field.press("Enter");
  await expect
    .poll(async () => (await requestsFor(TASK)).length, { timeout: 60_000 })
    .toBeGreaterThan(before);
  const served = (await requestsFor(TASK)).slice(before);
  expect(served.map((each) => `${each.model} on ${each.account}`)).toEqual(
    served.map(() => "dev-2 on acme:home"),
  );
  await expect.poll(async () => (await row()).status, { timeout: 60_000 }).not.toBe("running");
  // Put back for any later check.
  await patchTask({ model: "acme/dev-1@acme:work" });
});

test("F-043 F-045: an effort chosen for the task during a turn is held, saved when it ends, read by a second connection, and the next turn starts with it, by the gateway's log", async () => {
  test.setTimeout(240_000);
  await expect(chip(page)).toHaveAccessibleName(
    "Model for this task: acme/dev-1, Low effort. Change.",
    { timeout: 30_000 },
  );
  const session = String((await row()).sessionId);
  const before = (await runStarts(session)).length;
  await startTurn("#slow 10");
  await chip(page).click();
  await page.getByRole("menuitemradio", { name: "High" }).click();
  await expect(chip(page)).toHaveAccessibleName(/High effort\. Held until this turn ends/);
  // Not written while the turn runs.
  expect((await row()).thinkingLevel).toBeUndefined();
  await expect.poll(async () => (await row()).status, { timeout: 90_000 }).not.toBe("running");
  await expect.poll(async () => (await row()).thinkingLevel, { timeout: 90_000 }).toBe("high");
  await expect(modelLines(page).last()).toHaveText("Effort changed to High · from the next turn", {
    timeout: 30_000,
  });
  await expect(chip(page)).toHaveAccessibleName(
    "Model for this task: acme/dev-1, High effort. Change.",
  );
  // The turn that ran while it was held started with the effort it had.
  const during = (await runStarts(session)).slice(before);
  expect(during.length).toBeGreaterThan(0);
  expect(during).not.toContain("high");
  // The next turn starts with High.
  const field = page.getByTestId("composer-input");
  await field.fill("#text");
  await field.press("Enter");
  await expect
    .poll(async () => (await runStarts(session)).length, { timeout: 60_000 })
    .toBeGreaterThan(before + during.length);
  const next = (await runStarts(session)).slice(before + during.length);
  expect(next).toEqual(next.map(() => "high"));
  await expect.poll(async () => (await row()).status, { timeout: 60_000 }).not.toBe("running");
  // Put back for any later check: the task's own effort removed.
  await patchTask({ thinkingLevel: null });
  await expect(chip(page)).toHaveAccessibleName(
    "Model for this task: acme/dev-1, Low effort. Change.",
    { timeout: 30_000 },
  );
});

test("F-042 F-043: a bot's model and effort chosen in its settings are saved on its account and seen by a second connection", async () => {
  test.setTimeout(180_000);
  await page.getByRole("button", { name: "Show work panel" }).click();
  await page.getByRole("tab", { name: "Settings" }).click();
  const settings = page.getByTestId("bot-settings");
  // Below admin the values are shown and the selects are disabled; admin is asked for, never taken.
  await expect(settings.getByTestId("model-select")).toBeDisabled({ timeout: 30_000 });
  await expect(settings.getByTestId("model-select")).toHaveAccessibleName("Model: dev-1");
  await settings.getByRole("button", { name: "Request admin access" }).click();
  await approve();
  await expect(settings.getByTestId("model-select")).toBeEnabled({ timeout: 30_000 });
  // Quill's latest task, from the checks above, carries Quill's own account: its catalogue is listed.
  await expect(settings).toContainText(
    "The models Acme · Work offers, as the gateway lists them for Quill's latest task.",
  );
  await settings.getByTestId("model-select").click();
  await page.getByRole("menuitemradio", { name: "dev-2" }).click();
  await expect(page.getByTestId("work-announcer")).toHaveText("Model saved", { timeout: 30_000 });
  await expect(settings.getByTestId("model-select")).toHaveAccessibleName("Model: dev-2");
  // A write to a bot's entry can make the gateway reload: the next choice waits for the connection.
  await expect(settings.getByTestId("effort-select")).toBeEnabled({ timeout: 60_000 });
  await settings.getByTestId("effort-select").click();
  await page.getByRole("menuitemradio", { name: "High" }).click();
  await expect(page.getByTestId("work-announcer")).toHaveText("Effort saved", { timeout: 30_000 });
  await shots(page, "bot-model-effort", DESKTOP_AND_PHONE);

  // Written with its account and the empty fallback list, and read so by a second connection.
  const config = (await admin.request<{ config: Json }>("config.get", {})).config;
  const entry = ((config.agents as Json).entries as Json)[BOT] as Json;
  expect(entry.model).toEqual({ primary: "acme/dev-2@acme:work", fallbacks: [] });
  expect(entry.thinkingDefault).toBe("high");
  const listed = await reader.request<{ agents: Json[] }>("agents.list", {});
  const quill = listed.agents.find((each) => each.id === BOT)!;
  // `agents.list` names a bot's model without its account (observed on 2026.10.6).
  expect((quill.model as Json).primary).toBe("acme/dev-2");
  expect(quill.thinkingDefault).toBe("high");

  // Put back as the task checks below expect it: dev-1 and Low, the gateway's default effort.
  await expect(settings.getByTestId("model-select")).toBeEnabled({ timeout: 60_000 });
  await settings.getByTestId("model-select").click();
  await page.getByRole("menuitemradio", { name: "dev-1" }).click();
  await expect(settings.getByTestId("model-select")).toHaveAccessibleName("Model: dev-1", {
    timeout: 30_000,
  });
  await expect(settings.getByTestId("effort-select")).toBeEnabled({ timeout: 60_000 });
  await settings.getByTestId("effort-select").click();
  await page.getByRole("menuitemradio", { name: "Low" }).click();
  await expect(settings.getByTestId("effort-select")).toHaveAccessibleName("Effort: Low", {
    timeout: 30_000,
  });
  await page.getByRole("tab", { name: "Details" }).click();
  await page.getByRole("button", { name: "Hide work panel" }).click();
  // The writes make the gateway reload: the next check starts once it answers again.
  await expect
    .poll(
      () =>
        reader.request("agents.list", {}).then(
          () => true,
          () => false,
        ),
      {
        timeout: 120_000,
      },
    )
    .toBe(true);
});

test("F-042 F-043: a read-only connection sees the task's model and effort, and no control", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const data = mkdtempSync(join(tmpdir(), "clawtrate-models-read-"));
  const started = startHost(INSTANCE, STATIC, data, { readOnly: true });
  started.gated.release();
  const host = { child: started.host, url: await started.url, data };
  hosts.push(host);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const read = await context.newPage();
  await read.goto(host.url);
  await read.getByRole("button", { name: "Use the development gateway" }).click();
  await approve();
  await expect(botRow(read, "Quill")).toBeVisible({ timeout: 30_000 });
  await openQuill(read);
  await expect(chip(read)).toHaveRole("note", { timeout: 30_000 });
  await expect(chip(read)).toHaveAccessibleName(/^Model for this task: acme\/dev-1, .* effort\.$/);
  await expect(read.getByRole("button", { name: /Model for this task/ })).toHaveCount(0);
  await read.getByRole("button", { name: "Show work panel" }).click();
  await expect(read.getByTestId("task-model")).toContainText("acme/dev-1");
  await expect(read.getByTestId("task-model").getByRole("button")).toHaveCount(0);
  await shots(read, "task-read", [[1440, 900, "light"]]);
  await context.close();
});
