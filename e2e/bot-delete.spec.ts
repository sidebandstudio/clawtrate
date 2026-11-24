// Delete bot… against a development gateway (docs/parity.md F-050, F-276,
// F-464): bots of this spec's own, deleted from their settings through a
// preview host of its own. The page pairs read-only, sees why it can't delete
// and asks for admin as the person does; then a delete that keeps the
// workspace folder, one that removes it, and one whose folder another bot uses.
// What is on disk and what the gateway lists is read from the gateway's side.
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { devGateway, startHost, stopChild } from "./global-setup.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const STAMP = Date.now().toString(36);

type Host = { child: ChildProcess; url: string; data: string };
let host: Host | null = null;
let page: Page;
/** A paired admin connection of this spec's own, for making bots and reading the gateway. */
let session: OperatorSession | null = null;
const openAdmin = () =>
  openOperator(
    openInstance(INSTANCE),
    "Clawtrate delete check (admin)",
    ["operator.read", "operator.write", "operator.admin"],
    [],
  );
/**
 * A gateway request on that connection. The gateway can drop an operator's socket while the
 * page's own access changes; a dropped one is opened again, once, and the request sent anew.
 */
const admin = {
  async request<T>(method: string, params: unknown): Promise<T> {
    session ??= await openAdmin();
    try {
      return await session.request<T>(method, params);
    } catch (error) {
      if (!/not connected/.test(String(error))) throw error;
      await session.close().catch(() => {});
      session = await openAdmin();
      return session.request<T>(method, params);
    }
  },
};
/** Bots this spec made, removed afterwards if a check left them. */
const made = new Set<string>();
/** Workspace folders this spec made, removed afterwards. */
const folders = new Set<string>();
/** Bots asked for, by name and folder, before the gateway answered: found and removed afterwards. */
const asked = new Map<string, string>();

const workspace = (label: string) =>
  join(openInstance(INSTANCE).stateDir, "workspaces", `delete-${label}-${STAMP}`);

async function listsBot(botId: string): Promise<boolean> {
  const listed = await admin.request<{ agents?: Array<{ id: string }> }>("agents.list", {});
  return (listed.agents ?? []).some((agent) => agent.id === botId);
}

/** A bot made on the gateway with this workspace folder, once the gateway lists it. */
async function ownBot(name: string, folder: string): Promise<string> {
  // Kept before the request: a create that applies with its answer lost is still cleaned up.
  asked.set(name, folder);
  folders.add(folder);
  const created = await admin.request<{ agentId: string }>("agents.create", {
    name,
    workspace: folder,
    model: "scripted/dev-1",
  });
  made.add(created.agentId);
  await expect.poll(() => listsBot(created.agentId), { timeout: 60_000 }).toBe(true);
  return created.agentId;
}

/** Write a bot's AGENTS.md through the gateway, so its workspace folder holds a file of ours. */
async function writeAgents(botId: string, content: string): Promise<void> {
  const { file } = await admin.request<{ file: { hash?: string; missing?: boolean } }>(
    "agents.files.get",
    { agentId: botId, name: "AGENTS.md" },
  );
  await admin.request("agents.files.set", {
    agentId: botId,
    name: "AGENTS.md",
    content,
    ...(file.hash && !file.missing ? { expectedHash: file.hash } : { expectedMissing: true }),
  });
}

const botRow = (name: string) =>
  page.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${name}\\b`) });

/** Ask the page's host to read the gateway's bots again (the bridge's `retry`). */
async function rereadBots(): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`ws://${location.host}/bridge`);
        let settled = false;
        // Settled once: by the reply, an error, a close before the reply, or a silent socket.
        const settle = (error: Error | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.close();
          if (error) reject(error);
          else resolve();
        };
        const timer = setTimeout(() => settle(new Error("bridge socket silent")), 10_000);
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as { type: string; id?: string };
          if (message.type === "hello")
            socket.send(
              JSON.stringify({ type: "command", id: "reread", command: { type: "retry" } }),
            );
          else if (message.id === "reread") settle(null);
        };
        socket.onerror = () => settle(new Error("bridge socket error"));
        socket.onclose = () => settle(new Error("bridge socket closed before the reply"));
      }),
  );
}

/** Open a bot's settings and its Delete bot… dialog. */
async function openDelete(name: string) {
  await expect
    .poll(
      async () => {
        await rereadBots().catch(() => {});
        return botRow(name).count();
      },
      { timeout: 90_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBeGreaterThan(0);
  await botRow(name).first().click();
  if (!(await page.getByTestId("work-panel").isVisible()))
    await page.keyboard.press("ControlOrMeta+\\");
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Delete bot…" }).click();
  const dialog = page.getByTestId("delete-bot");
  await expect(dialog.getByRole("heading", { name: `Delete ${name}?` })).toBeVisible();
  await expect(dialog.getByTestId("delete-goes")).toContainText(
    `${name}, with its settings and its place in your sidebar`,
    { timeout: 20_000 },
  );
  return dialog;
}

async function pairedPage(browser: Browser): Promise<Page> {
  const data = mkdtempSync(join(tmpdir(), "clawtrate-delete-"));
  const started = startHost(INSTANCE, STATIC, data);
  // Kept before its address is awaited, so the host is stopped afterwards even if it never says.
  host = { child: started.host, url: "", data };
  started.gated.release();
  host.url = await started.url;
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
  await expect
    .poll(() => next.getByTestId("bot").count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(4);
  return next;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  expect(INSTANCE, "a named instance").toMatch(/^[a-z0-9-]+$/);
  session = await openAdmin();
  page = await pairedPage(browser);
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  // A bot asked for whose answer was lost is found by its run's own name and folder.
  const listed = await admin
    .request<{ agents?: Array<{ id: string; name?: string; workspace?: string }> }>(
      "agents.list",
      {},
    )
    .catch(() => ({ agents: [] }));
  for (const agent of listed.agents ?? [])
    // Only a bot this run asked for by name, listed with the folder it was given: a name it never
    // asked for reads undefined, and so does a bot listed with no folder, which must not match.
    if (
      agent.name !== undefined &&
      agent.workspace !== undefined &&
      asked.has(agent.name) &&
      asked.get(agent.name) === agent.workspace
    )
      made.add(agent.id);
  for (const botId of made)
    await admin.request("agents.delete", { agentId: botId, deleteFiles: true }).catch(() => {});
  await session?.close();
  if (host) {
    await stopChild(host.child).catch(() => host?.child.kill("SIGKILL"));
    rmSync(host.data, { recursive: true, force: true });
  }
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

test("F-050: a read-only connection sees what goes and why it can't delete, then asks for admin", async () => {
  test.setTimeout(180_000);
  const name = `Fern ${STAMP}`;
  await ownBot(name, workspace("fern"));
  const dialog = await openDelete(name);
  await expect(dialog.getByTestId("admin-bar")).toContainText(
    `Deleting ${name} needs admin access.`,
  );
  await expect(dialog.getByRole("button", { name: `Delete ${name}` })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Request admin access" }).click();
  await expect(dialog.getByTestId("admin-bar")).toContainText("Waiting for the gateway's owner.");
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  await expect(dialog.getByRole("button", { name: `Delete ${name}` })).toBeVisible({
    timeout: 30_000,
  });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});

test("F-276: deleting with the folder kept removes the bot and leaves its workspace folder", async () => {
  test.setTimeout(180_000);
  const name = `Heron ${STAMP}`;
  const folder = workspace("heron");
  const botId = await ownBot(name, folder);
  await writeAgents(botId, "Heron's instructions.");
  expect(existsSync(join(folder, "AGENTS.md"))).toBe(true);
  const dialog = await openDelete(name);
  const box = dialog.getByRole("checkbox", { name: "Also remove this bot's workspace folder" });
  await expect(box).not.toBeChecked();
  await dialog.getByTestId("delete-type").fill(name);
  await dialog.getByRole("button", { name: `Delete ${name}` }).click();
  await expect(dialog.getByRole("heading", { name: `${name} was deleted` })).toBeVisible({
    timeout: 60_000,
  });
  await expect(dialog.getByTestId("delete-result")).toContainText(
    `The gateway no longer lists ${name}.`,
  );
  await expect(dialog.getByTestId("delete-result")).toContainText(
    "Clawtrate asked the gateway to keep its folders.",
  );
  await expect(botRow(name)).toHaveCount(0);
  expect(await listsBot(botId)).toBe(false);
  made.delete(botId);
  expect(existsSync(join(folder, "AGENTS.md"))).toBe(true);
  await dialog.getByRole("button", { name: "Close" }).last().click();
  await expect(dialog).toHaveCount(0);
});

test("F-276: deleting with the folder ticked moves the workspace folder away, as the gateway reports", async () => {
  test.setTimeout(180_000);
  const name = `Wren ${STAMP}`;
  const folder = workspace("wren");
  const botId = await ownBot(name, folder);
  await writeAgents(botId, "Wren's instructions.");
  expect(existsSync(folder)).toBe(true);
  const dialog = await openDelete(name);
  await dialog.getByRole("checkbox", { name: "Also remove this bot's workspace folder" }).check();
  await expect(dialog.getByTestId("delete-goes")).toContainText(folder);
  await dialog.getByTestId("delete-type").fill(name);
  await dialog.getByRole("button", { name: `Delete ${name}` }).click();
  await expect(dialog.getByRole("heading", { name: `${name} was deleted` })).toBeVisible({
    timeout: 60_000,
  });
  await expect(dialog.getByTestId("delete-result")).toContainText(`Moved to the Trash: ${folder}`);
  expect(await listsBot(botId)).toBe(false);
  made.delete(botId);
  expect(existsSync(folder)).toBe(false);
  await expect(botRow(name)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).last().click();
});

test("F-464: a workspace folder another bot uses can't be removed, and stays readable by that bot", async () => {
  test.setTimeout(180_000);
  const name = `Ivy ${STAMP}`;
  const partner = `Moss ${STAMP}`;
  const folder = workspace("shared");
  const botId = await ownBot(name, folder);
  const partnerId = await ownBot(partner, folder);
  await writeAgents(partnerId, "Shared instructions.");
  const dialog = await openDelete(name);
  const box = dialog.getByRole("checkbox", { name: "Also remove this bot's workspace folder" });
  await expect(box).toBeDisabled();
  await expect(box).not.toBeChecked();
  await expect(dialog.getByText(`Also used by ${partner}`, { exact: true })).toBeVisible();
  await dialog.getByTestId("delete-type").fill(name);
  await dialog.getByRole("button", { name: `Delete ${name}` }).click();
  await expect(dialog.getByRole("heading", { name: `${name} was deleted` })).toBeVisible({
    timeout: 60_000,
  });
  expect(await listsBot(botId)).toBe(false);
  made.delete(botId);
  // The folder and its file are intact, and the other bot still reads them through the gateway.
  expect(existsSync(join(folder, "AGENTS.md"))).toBe(true);
  const { file } = await admin.request<{ file: { content?: string } }>("agents.files.get", {
    agentId: partnerId,
    name: "AGENTS.md",
  });
  expect(file.content).toBe("Shared instructions.");
  await expect(botRow(partner)).toHaveCount(1);
  await dialog.getByRole("button", { name: "Close" }).last().click();
});
