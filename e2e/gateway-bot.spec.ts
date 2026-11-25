// The gateway's own bot (F-562) against this run's development gateways, through preview hosts
// of this spec's own that start with "Show the gateway's own bot" at its default, off. On the
// seeded instance Juniper is the gateway's own bot (`agents.list` `defaultId`) beside Otto, Marlow
// and Pip. Every development instance declares all four bots, and the gateway removes a bot only
// with `agents.delete`, so the check of a gateway whose only bot is its own starts an unseeded
// instance of its own and deletes the other three there. That instance is recorded in a run
// record of this file's own before it starts, as e2e/setup.spec.ts does, so a run killed outright
// is cleaned up by the next `pnpm e2e`. On the run's shared instances only what the app shows
// changes: the checks put back the arrangement, the config and every task they made.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapAgents } from "../packages/core/src/mapping.ts";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { newRunId, processIdentity } from "../tools/dev-gateway/src/state-guard.ts";
import {
  devGateway,
  FORBIDDEN_PORTS,
  listInstances,
  startHost,
  stopChild,
} from "./global-setup.ts";
import { cleanUp, saveRecord, type RunRecord } from "./run-record.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const STAMP = Date.now().toString(36);
const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "tools/dev-gateway/src/cli.ts");
const RECORDS = join(ROOT, "tools/dev-gateway/.run/e2e");
/** This file's own run, and the instance it starts for a gateway with only its own bot. */
const RUN = randomBytes(4).toString("hex");
const ALONE = `e2e-${RUN}-gwbot`;
const record: RunRecord = {
  run: RUN,
  runner: { pid: process.pid, identity: "" },
  instances: [],
  host: null,
  dirs: [],
};
const cli = (...args: string[]) =>
  execFileSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "CLAWTRATE_DEV_INSTANCE"),
    ),
    stdio: ["ignore", "inherit", "inherit"],
  });

type Host = { child: ChildProcess; url: string; data: string };
const hosts: Host[] = [];
const contexts: Array<{ close(): Promise<void> }> = [];
/** The page on the seeded instance, kept for the check that follows the first. */
let seeded: Page | null = null;

async function gatewayCall<T>(instance: string, method: string, params: unknown): Promise<T> {
  const result = await openInstance(instance).runner.run([
    "gateway",
    "call",
    method,
    "--params",
    JSON.stringify(params),
    "--json",
  ]);
  if (result.status !== 0)
    throw new Error(`gateway call ${method} failed:\n${result.stdout}${result.stderr}`);
  return parseJsonOutput<T>(result.stdout);
}

/** An admin connection of this spec's own to `instance`. */
function adminOf(instance: string): Promise<OperatorSession> {
  return openOperator(
    openInstance(instance),
    "Clawtrate gateway bot check",
    ["operator.read", "operator.write", "operator.admin"],
    [],
  );
}

/** Change the config and wait until the gateway runs the change. */
async function patchConfig(admin: OperatorSession, raw: unknown): Promise<void> {
  const before = await admin.request<{ hash: string; configRevisionHash?: string }>(
    "config.get",
    {},
  );
  await admin.request("config.patch", { raw: JSON.stringify(raw), baseHash: before.hash });
  await expect
    .poll(
      async () => {
        const now = await admin.request<{
          configRevisionHash?: string;
          appliedConfigHash?: string;
        }>("config.get", {});
        return (
          now.configRevisionHash !== before.configRevisionHash &&
          now.appliedConfigHash === now.configRevisionHash
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

/** A page on a preview host of its own, paired with `instance`, the switch at its default. */
async function pairedPage(browser: Browser, instance: string): Promise<Page> {
  const data = mkdtempSync(join(tmpdir(), "clawtrate-gateway-bot-"));
  const started = startHost(instance, STATIC, data, { gatewayBot: "default" });
  started.gated.release();
  const host = { child: started.host, url: await started.url, data };
  hosts.push(host);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(host.url);
  await page.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => devGateway(instance, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  await expect(page.getByTestId("bot").first()).toBeVisible({ timeout: 30_000 });
  return page;
}

const rail = (page: Page) => page.getByTestId("bot-list");
const botRow = (page: Page, name: string) =>
  rail(page).getByRole("button", { name: new RegExp(`^${name}\\b`) });

async function setShown(page: Page, on: boolean): Promise<void> {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Advanced", exact: true }).click();
  const toggle = settings.getByRole("switch", { name: "Show the gateway's own bot" });
  if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(on));
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
}

async function menu(page: Page, name: string, item: string): Promise<void> {
  await botRow(page, name).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

test.afterAll(async () => {
  test.setTimeout(120_000);
  for (const context of contexts) await context.close().catch(() => {});
  for (const host of hosts) {
    await stopChild(host.child).catch(() => host.child.kill("SIGKILL"));
    rmSync(host.data, { recursive: true, force: true });
  }
});
process.once("exit", () => hosts.forEach((host) => host.child.kill("SIGKILL")));
test.afterAll(() => {
  if (record.instances.length === 0) return;
  const problems = cleanUp(RECORDS, record, (name, runId) =>
    cli("reset", "--run-id", runId, "--instance", name),
  );
  expect(problems).toEqual([]);
});

test("F-562: with other bots, the gateway's own bot is absent from the sidebar, Hidden bots and search; the switch brings it back, and it shows while it waits on the person", async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const { defaultId } = await gatewayCall<{ defaultId: string }>(INSTANCE, "agents.list", {});
  const own = mapAgents(await gatewayCall(INSTANCE, "agents.list", {})).find(
    (bot) => bot.id === defaultId,
  )!;
  expect(own.name, "the seeded gateway's own bot").toBe("Juniper");
  const page = await pairedPage(browser, INSTANCE);
  seeded = page;

  // Off, the default: the other bots, and no bot starred.
  for (const name of ["Otto", "Marlow", "Pip"]) await expect(botRow(page, name)).toBeVisible();
  await expect(botRow(page, "Juniper")).toHaveCount(0);
  await expect(rail(page).getByTestId("primary-star")).toHaveCount(0);
  // Not in the rail's search.
  await page.keyboard.press("ControlOrMeta+Shift+F");
  await page.getByRole("textbox", { name: "Search bots" }).fill("i");
  await expect(botRow(page, "Pip")).toBeVisible();
  await expect(botRow(page, "Juniper")).toHaveCount(0);
  await page.keyboard.press("Escape");
  // Not among the search palette's bots.
  await page.keyboard.press("ControlOrMeta+K");
  const palette = page.getByTestId("search-palette");
  await palette.getByRole("combobox", { name: "Search" }).fill("i");
  const paletteBots = palette.getByTestId("search-group-bots").getByRole("option");
  await expect(paletteBots.filter({ hasText: "Pip" })).toHaveCount(1);
  await expect(paletteBots.filter({ hasText: "Juniper" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // On: an ordinary bot again, starred as the gateway's default.
  await setShown(page, true);
  await expect(botRow(page, "Juniper")).toHaveAccessibleName(/, primary bot/);
  await expect(botRow(page, "Juniper").getByTestId("primary-star")).toHaveCount(1);

  // Hidden by the person, it is under Hidden bots only while the switch is on.
  await menu(page, "Juniper", "Hide from sidebar");
  await menu(page, "Marlow", "Hide from sidebar");
  const hiddenToggle = page.getByRole("button", { name: /^Hidden bots/ });
  if ((await hiddenToggle.getAttribute("aria-expanded")) !== "true") await hiddenToggle.click();
  const hidden = page.getByRole("list", { name: "Hidden bots" });
  await expect(hidden.getByTestId("bot")).toHaveCount(2);
  await setShown(page, false);
  await expect(hidden.getByTestId("bot")).toHaveCount(1);
  await expect(hidden.getByRole("button", { name: /^Marlow\b/ })).toBeVisible();
  await expect(rail(page).getByRole("button", { name: /^Juniper\b/ })).toHaveCount(0);
  // Put back as found.
  await setShown(page, true);
  for (const name of ["Juniper", "Marlow"]) {
    await hidden.getByRole("button", { name: new RegExp(`^${name}\\b`) }).click({
      button: "right",
    });
    await page.getByRole("menuitem", { name: "Show in sidebar", exact: true }).click();
  }
  await expect(page.getByRole("button", { name: /^Hidden bots/ })).toHaveCount(0);
  await setShown(page, false);
  await expect(botRow(page, "Juniper")).toHaveCount(0);

  // A question from one of its runs brings it into the sidebar until it is answered. A
  // read-only connection is not sent questions, so this device asks for interactive access first,
  // as a person does: Request access in the access bar.
  await botRow(page, "Pip").first().click();
  const bar = page.getByRole("region", { name: "Access" });
  await bar.getByRole("button", { name: "Request access" }).click();
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 });
  await expect(botRow(page, "Juniper")).toHaveCount(0);
  // A task of its own, with a question asked in it. The gateway asks a run's question of the
  // client that started the run, so this page starts it: with the switch on for that moment,
  // in the task opened from the sidebar, then another bot opened and the switch off again.
  const title = `Ask me ${STAMP}`;
  const { key } = await gatewayCall<{ key: string }>(INSTANCE, "sessions.create", {
    agentId: defaultId,
    label: title,
  });
  type Pending = { questions: Array<{ id: string; sessionKey?: string }> };
  const asked = async () =>
    (await gatewayCall<Pending>(INSTANCE, "question.list", {})).questions.find(
      (each) => each.sessionKey === key,
    );
  try {
    await setShown(page, true);
    const juniper = botRow(page, "Juniper").first();
    if ((await juniper.getAttribute("aria-expanded")) !== "true") await juniper.click();
    const task = page.getByTestId("task").filter({ hasText: title }).first();
    await expect(task).toBeVisible({ timeout: 30_000 });
    await task.click();
    await page.getByTestId("composer-input").fill("#ask");
    await page.getByTestId("composer-input").press("Enter");
    await expect
      .poll(async () => (await asked()) !== undefined, { timeout: 60_000, intervals: [1000] })
      .toBe(true);
    await botRow(page, "Pip").first().click();
    await setShown(page, false);
    await expect(botRow(page, "Juniper")).toHaveAccessibleName(/^Juniper, waiting for you/, {
      timeout: 60_000,
    });
    await expect(botRow(page, "Juniper").getByTestId("primary-star")).toHaveCount(1);
    // Answered (dismissed) on the gateway by another client: nothing waits, and it leaves.
    await gatewayCall(INSTANCE, "question.resolve", { id: (await asked())!.id, cancel: true });
    await expect(botRow(page, "Juniper")).toHaveCount(0, { timeout: 60_000 });
  } finally {
    await gatewayCall(INSTANCE, "chat.abort", { sessionKey: key }).catch(() => {});
    await gatewayCall(INSTANCE, "sessions.delete", { key, deleteTranscript: true }).catch(() => {});
  }
  // The gateway still lists it, as before: only the app's view changed.
  const after = await gatewayCall<{ defaultId: string; agents: Array<{ id: string }> }>(
    INSTANCE,
    "agents.list",
    {},
  );
  expect(after.defaultId).toBe(defaultId);
  expect(after.agents.map((each) => each.id)).toContain(defaultId);
});

/**
 * Ask the page's host to read the gateway's bots again (the bridge's `retry`): the host lists
 * bots when it connects, and a reload of the page keeps that connection.
 */
async function rereadBots(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`ws://${location.host}/bridge`);
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as { type: string; id?: string };
          if (message.type === "hello")
            socket.send(
              JSON.stringify({ type: "command", id: "reread", command: { type: "retry" } }),
            );
          else if (message.id === "reread") {
            socket.close();
            resolve();
          }
        };
        socket.onerror = () => reject(new Error("bridge socket error"));
      }),
  );
}

type Roster = { defaultId: string; selectionRequired?: boolean; agents: Array<{ id: string }> };

test("F-562: on a gateway that names no owner (selectionRequired), the bot named as defaultId is an ordinary one and stays in the sidebar", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const page = seeded ?? (await pairedPage(browser, INSTANCE));
  const admin = await adminOf(INSTANCE);
  const patch = (raw: unknown) => patchConfig(admin, raw);
  const roster = () => admin.request<Roster>("agents.list", {});
  expect((await roster()).selectionRequired).toBe(false);
  await expect(botRow(page, "Juniper")).toHaveCount(0);
  try {
    // The development gateway's explicit roster names its owner in `agents.defaults.systemAgent`.
    // Without it the gateway still answers a `defaultId`: its first configured bot.
    await patch({ agents: { defaults: { systemAgent: null } } });
    await expect.poll(async () => (await roster()).selectionRequired).toBe(true);
    const ownerless = await roster();
    expect(ownerless.agents.length).toBeGreaterThan(1);
    const first = mapAgents(ownerless).find((bot) => bot.id === ownerless.defaultId)!;
    expect(first.ownerless).toBe(true);
    await rereadBots(page);
    await expect(botRow(page, first.name)).toBeVisible({ timeout: 30_000 });
    for (const name of ["Otto", "Marlow", "Pip"]) await expect(botRow(page, name)).toBeVisible();
  } finally {
    await patch({ agents: { defaults: { systemAgent: { agentId: "main" } } } });
    await expect.poll(async () => (await roster()).selectionRequired).toBe(false);
    await admin.close();
  }
  await rereadBots(page);
  await expect(botRow(page, "Juniper")).toHaveCount(0, { timeout: 30_000 });
});

test("F-562: the gateway's own bot shows when it is the only bot, and leaves once another bot exists", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  // An unseeded instance of this file's own, recorded before it starts.
  const self = processIdentity(process.pid);
  if (self.state !== "alive") throw new Error("could not determine this process's start time");
  record.runner.identity = self.identity;
  const runId = newRunId();
  record.instances.push({ name: ALONE, runId });
  saveRecord(RECORDS, record);
  cli("start", "--run-id", runId, "--instance", ALONE, "--no-seed");
  const mine = listInstances().find((row) => row.name === ALONE);
  if (!mine?.gatewayRunning) throw new Error(`instance ${ALONE} is not running`);
  for (const port of [mine.gatewayPort, mine.providerPort])
    if (port === null || FORBIDDEN_PORTS.includes(port))
      throw new Error(`instance ${ALONE} is on port ${port}, which e2e never uses`);

  const admin = await adminOf(ALONE);
  try {
    const roster = () => admin.request<Roster>("agents.list", {});
    const { defaultId, agents } = await roster();
    // Only the gateway's own bot left: a gateway nobody has made a bot on.
    for (const { id } of agents)
      if (id !== defaultId)
        await admin.request("agents.delete", { agentId: id, deleteFiles: true });
    await expect
      .poll(async () => (await roster()).agents.map((each) => each.id))
      .toEqual([defaultId]);
    const own = mapAgents(await roster())[0]!;
    const page = await pairedPage(browser, ALONE);
    await expect(rail(page).getByTestId("bot")).toHaveCount(1);
    await expect(botRow(page, own.name)).toHaveAccessibleName(/, primary bot/);
    await expect(botRow(page, own.name).getByTestId("primary-star")).toHaveCount(1);

    // Another bot made: the gateway's own leaves, and the new one opens in its place.
    const name = `Wren ${STAMP}`;
    await admin.request("agents.create", {
      name,
      workspace: join(openInstance(ALONE).stateDir, "workspaces", `wren-${STAMP}`),
      model: "scripted/dev-1",
    });
    await expect.poll(async () => (await roster()).agents.length).toBe(2);
    await rereadBots(page);
    await expect(botRow(page, "Wren")).toBeVisible({ timeout: 30_000 });
    await expect(botRow(page, own.name)).toHaveCount(0);
    await expect(rail(page).getByTestId("bot")).toHaveCount(1);
    // A bot just made has no tasks yet: its empty conversation names it.
    await expect(page.getByTestId("transcript")).toContainText(`Conversations with ${name}`);
    await expect(rail(page).getByTestId("primary-star")).toHaveCount(0);
  } finally {
    await admin.close();
  }
});
