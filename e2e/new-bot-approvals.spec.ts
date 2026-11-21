// A new bot's command choice (docs/design/bots.md section 3,
// docs/design/controls.md section 10) against a real development gateway: an
// instance of this file's own, started unseeded (its configured bots, Otto
// asking before every command and every other bot denied), driven through
// the interface on a preview host of its own, and reset when the file ends.
// One bot is created with each choice; the gateway's config is read back for
// that bot alone, every other bot's entry, the settings for every bot and the
// machine's approvals file are compared with what they were, and under "Ask
// before acting" a harmless command no allowlist lists raises the gateway's
// own approval, which is then denied. No command runs under "Run without
// routine approvals" here.
import { expect, test, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { devGateway, listInstances, startHost, stopChild } from "./global-setup.ts";

const RUN = process.env.CLAWTRATE_E2E_RUN!;
/** This file's own instance, named for the run; nothing else uses it. */
const INSTANCE = `e2e-${RUN}-nbot`;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;

test.describe.configure({ mode: "serial" });

type Json = Record<string, unknown>;
let host: { child: ChildProcess; url: string; data: string } | null = null;
let started = false;
let page: Page;
let admin: OperatorSession;
let approver: OperatorSession;

async function config(): Promise<Json> {
  return ((await admin.request<{ config: Json }>("config.get", {})).config ?? {}) as Json;
}
const entries = (cfg: Json) =>
  ((cfg.agents as Json | undefined)?.entries ?? {}) as Record<string, Json>;
/**
 * Everything in the config but one bot's entry, and the gateway's own record
 * of when it last wrote the file (`meta`): what Create must leave as it was.
 */
const allBut = (cfg: Json, bot: string) => {
  const { [bot]: _, ...others } = entries(cfg);
  const { entries: __, ...agents } = (cfg.agents ?? {}) as Json;
  const { meta: ___, ...rest } = cfg;
  return { ...rest, agents: { ...agents, entries: others } };
};
async function approvalsHash(): Promise<string> {
  return String((await admin.request<{ hash: string }>("exec.approvals.get", {})).hash);
}
async function reported(bot: string): Promise<string | undefined> {
  const list = await admin.request<{
    agents: Array<{ id: string; defaultPermissionMode?: string }>;
  }>("agents.list", {});
  return list.agents.find((each) => each.id === bot)?.defaultPermissionMode;
}

async function approve(): Promise<void> {
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
}

/** One bridge command, over the host's own bridge socket. */
async function hostCommand(command: Json): Promise<void> {
  await page.evaluate(
    (command) =>
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`ws://${location.host}/bridge`);
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as { type: string; id?: string };
          if (message.type === "hello")
            socket.send(JSON.stringify({ type: "command", id: "do", command }));
          else if (message.id === "do") {
            socket.close();
            resolve();
          }
        };
        socket.onerror = () => reject(new Error("bridge socket error"));
      }),
    command,
  );
}

/** New bot through the interface: a name, the gateway's choice of account, then a command choice. */
async function create(name: string, choice: "Ask before acting" | "Run without routine approvals") {
  await page.keyboard.press("ControlOrMeta+n");
  const dialog = page.getByTestId("new-bot");
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await dialog.getByRole("button", { name: "Next" }).click();
  await dialog.getByRole("radio", { name: /^Let the gateway choose/ }).click();
  await dialog.getByTestId("account-next").click();
  const group = dialog.getByRole("radiogroup", { name: "Approvals" });
  // Nothing is chosen at first, and Create waits.
  await expect(group.getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(dialog.getByTestId("create")).toBeDisabled();
  await group.getByRole("radio", { name: choice }).click();
  await dialog.getByTestId("create").click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  expect(INSTANCE).toMatch(/^e2e-[0-9a-f]{8}-nbot$/);
  expect(listInstances().some((row) => row.name === INSTANCE)).toBe(false);
  started = true;
  devGateway(INSTANCE, "start", "--no-seed");
  admin = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate new bot check",
    ["operator.admin", "operator.read", "operator.write"],
    ["tool-events"],
  );
  // Only an admin connection sees an approval another device's run asked for.
  approver = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate approvals check",
    ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
    ["tool-events", "approvals", "exec-approvals"],
  );
  const data = mkdtempSync(join(tmpdir(), "clawtrate-new-bot-"));
  const spawned = startHost(INSTANCE, STATIC, data);
  spawned.gated.release();
  host = { child: spawned.host, url: await spawned.url, data };
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(host.url);
  await page.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await approve();
  await expect(page.getByTestId("bot").first()).toBeVisible({ timeout: 30_000 });
  // The interactive tier, then admin, each approved by the instance's owner.
  await hostCommand({ type: "requestAccess" });
  await approve();
  await expect(page.getByTestId("plus")).toBeVisible({ timeout: 30_000 });
  await hostCommand({ type: "requestAccess", tier: "admin" });
  await approve();
});

test.afterAll(async () => {
  await approver?.close();
  await admin?.close();
  if (host) {
    await stopChild(host.child);
    rmSync(host.data, { recursive: true, force: true });
  }
  if (started) devGateway(INSTANCE, "reset");
});

test("F-051 F-034: Ask before acting writes ask for that bot alone, says what was read, and a command no allowlist lists raises the gateway's own approval", async () => {
  test.setTimeout(240_000);
  const before = await config();
  const fileBefore = await approvalsHash();
  const others = Object.fromEntries(
    await Promise.all(
      Object.keys(entries(before)).map(async (id) => [id, await reported(id)] as const),
    ),
  );
  await create("Asker", "Ask before acting");

  const after = await config();
  expect(entries(after).asker).toMatchObject({
    tools: { exec: { mode: "ask" }, deny: ["gateway", "plugins", "t3code__*"] },
    model: { primary: "scripted/dev-1", fallbacks: [] },
  });
  // No other bot's entry, no setting for every bot and not the approvals file changed.
  expect(allBut(after, "asker")).toEqual(allBut(before, "asker"));
  expect(await approvalsHash()).toBe(fileBefore);
  for (const [id, label] of Object.entries(others)) expect(await reported(id), id).toBe(label);
  expect(await reported("asker")).toBe("guarded");

  // The page names the saved setting and the reported label, separately, then opens the composer.
  const note = page.getByTestId("policy-note");
  await expect(note).toHaveText(
    "Asker's saved command setting is Ask before acting.The gateway reports that the default command policy asks on an allowlist miss.",
    { timeout: 30_000 },
  );
  const field = page.getByTestId("composer-input");
  await expect(field).toBeEnabled();
  await expect(field).toHaveAttribute("placeholder", "Message Asker");

  // `ls` in its own workspace, which no allowlist lists: the gateway asks, and is told no.
  // The gateway's own card in the page, and its pending request as an admin client reads it.
  await field.fill("#approve");
  await field.press("Enter");
  const approval = page.getByTestId("approval-card");
  await expect(approval).toHaveCount(1, { timeout: 60_000 });
  await expect(approval.locator(".request-title")).toHaveText("Asker wants to run a command");
  await expect(approval).toContainText("Run ls on the gateway's machine.");
  let pending:
    { id: string; request: { command?: string; agentId?: string; ask?: string } } | undefined;
  await expect
    .poll(
      async () => {
        const list = await approver.request<
          Array<{
            id: string;
            request: { sessionKey?: string; command?: string; agentId?: string; ask?: string };
          }>
        >("exec.approval.list", {});
        pending = list.find((each) => each.request.sessionKey === "agent:asker:main");
        return pending?.id ?? "";
      },
      { timeout: 30_000 },
    )
    .not.toBe("");
  expect(pending!.request).toMatchObject({ command: "ls", agentId: "asker", ask: "on-miss" });
  // Told no: nothing runs.
  await approval.getByRole("button", { name: "Deny" }).click();
  await expect(approval.locator(".tag")).toHaveText("Denied", { timeout: 30_000 });
  await expect(note).toHaveCount(0);
});

test("F-051: Run without routine approvals writes full for that bot alone, and Asker keeps ask", async () => {
  test.setTimeout(180_000);
  const before = await config();
  const fileBefore = await approvalsHash();
  await create("Runner", "Run without routine approvals");
  const after = await config();
  expect(entries(after).runner).toMatchObject({
    tools: { exec: { mode: "full" }, deny: ["gateway", "plugins", "t3code__*"] },
    model: { primary: "scripted/dev-1", fallbacks: [] },
  });
  expect(allBut(after, "runner")).toEqual(allBut(before, "runner"));
  expect(entries(after).asker).toMatchObject({ tools: { exec: { mode: "ask" } } });
  expect(await approvalsHash()).toBe(fileBefore);
  const label = await reported("runner");
  const note = page.getByTestId("policy-note");
  await expect(note).toContainText(
    "Runner's saved command setting is Run without routine approvals.",
    {
      timeout: 30_000,
    },
  );
  // The label is said only as the gateway reported it, and nothing is claimed beyond it.
  if (label === "full")
    await expect(note).toContainText(
      "The gateway reports no routine approval in the default command policy.",
    );
  else if (label === undefined)
    await expect(note).toContainText(
      "The gateway didn't report a default command policy for Runner.",
    );
  await expect(note).not.toContainText(/effective/i);
  await expect(page.getByTestId("composer-input")).toBeEnabled();
});
