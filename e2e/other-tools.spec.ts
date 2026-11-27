// Sessions other tools open with a bot, against a real development gateway (docs/parity.md
// F-563): this file's own instance (`e2e-<id>-tools`, started with `--with-http-api`), where
// an API client calls the gateway's OpenAI-compatible HTTP API and a scheduled routine runs in
// a session of its own. With "Show sessions from other tools" off, the default, neither is in
// the bot's task list, its preview, its unread mark or the sidebar's order; a task started in
// Clawtrate is unaffected; a routine's run opens from Routines; one of them shows while it waits
// on an approval. With the switch on, both are listed.
//
// The instance is this file's own, started and removed here, so a shard that does not run this
// file starts none. It and the preview host are recorded in a run record of this file's own
// before they start, so a run killed outright is cleaned up by the next `pnpm e2e`.
import { expect, test, type Page } from "@playwright/test";
import { execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance, openOperator, readDevConnection } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { newRunId, ownIdentity, processIdentity } from "../tools/dev-gateway/src/state-guard.ts";
import {
  devGateway,
  FORBIDDEN_PORTS,
  listInstances,
  startHost,
  stopChild,
} from "./global-setup.ts";
import { cleanUp, saveRecord, TEMP_PREFIX, type RunRecord } from "./run-record.ts";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "tools/dev-gateway/src/cli.ts");
const RECORDS = join(ROOT, "tools/dev-gateway/.run/e2e");
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const SHOTS = process.env.CLAWTRATE_OTHER_TOOLS_SHOTS ?? null;
const RUN = randomBytes(4).toString("hex");
const INSTANCE = `e2e-${RUN}-tools`;
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

test.describe.configure({ mode: "serial" });

let host: { child: ChildProcess; url: string; data: string } | null = null;
let page: Page;
let approver: OperatorSession | null = null;

type Json = Record<string, unknown>;
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

/** A turn through the gateway's HTTP API, as an API client sends one: its own session per `user`. */
function apiTurn(bot: string, user: string, message: string): Promise<Response> {
  const connection = readDevConnection(openInstance(INSTANCE).connectionFile)!;
  return fetch(`${connection.url.replace(/^ws/, "http")}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: `openclaw/${bot}`,
      user,
      messages: [{ role: "user", content: message }],
    }),
  });
}

async function approve(): Promise<void> {
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
}

/** One bridge command, over the host's own bridge socket, as another viewer of the page sends it. */
async function hostCommand(command: Json): Promise<unknown> {
  return page.evaluate(
    (command) =>
      new Promise<unknown>((resolve, reject) => {
        const socket = new WebSocket(`ws://${location.host}/bridge`);
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as {
            type: string;
            id?: string;
            ok?: boolean;
            value?: unknown;
            error?: string;
          };
          if (message.type === "hello")
            socket.send(JSON.stringify({ type: "command", id: "do", command }));
          else if (message.type === "result" && message.id === "do") {
            socket.close();
            if (message.ok) resolve(message.value);
            else reject(new Error(message.error ?? "the command failed"));
          }
        };
        socket.onerror = () => reject(new Error("bridge socket error"));
      }),
    command,
  );
}

/**
 * A preview host on this file's instance, recorded by PID in this file's run record before its
 * gate opens. A host that never becomes ready is stopped here.
 */
async function startRecordedHost(data: string): Promise<{ child: ChildProcess; url: string }> {
  record.hostPending = true;
  saveRecord(RECORDS, record);
  const started = startHost(INSTANCE, STATIC, data);
  const found = processIdentity(started.host.pid!);
  if (found.state !== "alive") {
    started.url.catch(() => {});
    started.gated.abort();
    throw new Error("could not record the preview host");
  }
  record.host = { pid: started.host.pid!, identity: found.identity };
  delete record.hostPending;
  saveRecord(RECORDS, record);
  started.gated.release();
  try {
    return { child: started.host, url: await started.url };
  } catch (error) {
    await stopChild(started.host);
    throw error;
  }
}

const botRow = (bot: string) => page.locator(`[data-testid="bot"][data-bot="${bot}"]`);
const taskRow = (key: string) => page.locator(`[data-testid="task"][data-key="${key}"]`);
const botOrder = () =>
  page
    .getByTestId("bot-list")
    .locator('[data-testid="bot"]')
    .evaluateAll((all) => all.map((each) => each.getAttribute("data-bot")));

/** Show a bot's tasks. */
async function unfold(bot: string): Promise<void> {
  const row = botRow(bot);
  if ((await row.getAttribute("aria-expanded")) === "false") {
    await row.focus();
    await page.keyboard.press("ArrowRight");
  }
}

async function setOthersShown(on: boolean): Promise<void> {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Advanced", exact: true }).click();
  const toggle = settings.getByRole("switch", { name: "Show sessions from other tools" });
  if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(on));
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
}

/** Screenshots of the page as it is, at 1440 and 390, when asked for. */
async function shots(name: string): Promise<void> {
  if (!SHOTS) return;
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, `${name}-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  const self = ownIdentity();
  record.runner.identity = self;
  const runId = newRunId();
  record.instances.push({ name: INSTANCE, runId });
  saveRecord(RECORDS, record);
  cli("start", "--run-id", runId, "--instance", INSTANCE, "--with-http-api", "--no-seed");
  const mine = listInstances().find((each) => each.name === INSTANCE);
  expect(mine?.gatewayRunning, "this file's instance runs").toBe(true);
  for (const port of [mine!.gatewayPort, mine!.providerPort]) {
    expect(port !== null && !FORBIDDEN_PORTS.includes(port), `port ${port}`).toBe(true);
  }
  // The person's approvals, answered from here as another device of theirs would.
  approver = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate approvals check",
    ["operator.read", "operator.write", "operator.approvals"],
    ["tool-events", "approvals", "exec-approvals"],
  );
  const data = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  record.dirs.push(data);
  saveRecord(RECORDS, record);
  host = { ...(await startRecordedHost(data)), data };
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(host.url);
  await page.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await approve();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
  // Full access, so this viewer starts tasks and sees what waits for the person.
  await hostCommand({ type: "requestAccess" });
  await approve();
  await expect(page.getByTestId("plus")).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  await approver?.close();
  if (host) await stopChild(host.child);
  // This file's host, folder and instance, stopped by their recorded processes and removed.
  const problems = cleanUp(RECORDS, record, (name, runId) =>
    cli("reset", "--run-id", runId, "--instance", name),
  );
  expect(problems).toEqual([]);
});

test("F-563: an API client's session and a scheduled run stay out of a bot's task list, unread mark and order; with the switch on both are listed; one shows while it waits on an approval, and while open after it is answered; a task started in Clawtrate is unaffected", async () => {
  test.setTimeout(420_000);
  // A task started in Clawtrate, under Marlow.
  const created = (await hostCommand({
    type: "createTask",
    botId: "marlow",
    text: "#text",
    label: "Notes from Clawtrate",
  })) as { key: string };
  expect(created.key).toMatch(/^agent:marlow:dashboard:/);
  // Marlow's one task: his row opens it, once its reply has come.
  await expect
    .poll(
      async () => {
        const { sessions } = await gatewayCall<{ sessions: Json[] }>("sessions.list", {
          agentId: "marlow",
          includeLastMessage: true,
        });
        return String(sessions.find((each) => each.key === created.key)?.lastMessagePreview ?? "");
      },
      { timeout: 60_000, intervals: [2_000] },
    )
    .toContain("plain reply");
  await expect(botRow("marlow")).toHaveAccessibleName(/^marlow, 1 task\b/i, { timeout: 30_000 });

  // An API client's session with Pip, through the gateway's HTTP API.
  const api = "agent:pip:openai-user:e2e-client";
  expect((await apiTurn("pip", "e2e-client", "#text")).status).toBe(200);
  // A routine of Pip's in a session of its own, run now.
  const scheduled = "agent:pip:nightly-sync";
  const routine = await gatewayCall<{ id: string }>("cron.add", {
    name: "Nightly sync",
    agentId: "pip",
    schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
    sessionTarget: "session:nightly-sync",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "#text" },
    delivery: { mode: "none" },
  });
  await gatewayCall("cron.run", { id: routine.id, mode: "force" });
  // Both are on the gateway, as another tool opened them.
  await expect
    .poll(
      async () => {
        const { sessions } = await gatewayCall<{ sessions: Json[] }>("sessions.list", {
          agentId: "pip",
          includeLastMessage: true,
        });
        const row = (key: string) => sessions.find((each) => each.key === key);
        return [row(api)?.lastMessagePreview !== undefined, row(scheduled)?.createdVia];
      },
      { timeout: 60_000, intervals: [2_000] },
    )
    .toEqual([true, "cron"]);

  // Live, before any fresh read: the app holds both (the switch lists them) and hides them.
  await setOthersShown(true);
  await expect(botRow("pip")).toHaveAccessibleName(/, 2 tasks\b/, { timeout: 30_000 });
  await setOthersShown(false);
  await expect(botRow("pip")).toHaveAccessibleName(/^pip(?!.*\d+ tasks?\b)/i);
  await expect(botRow("pip").locator(".unread-dot")).toHaveCount(0);
  await expect(taskRow(api)).toHaveCount(0);
  await expect(taskRow(scheduled)).toHaveCount(0);
  const live = await botOrder();
  expect(live.indexOf("marlow")).toBeLessThan(live.indexOf("pip"));

  // The app opened again reads the list fresh; nothing from the other tools is in Pip's list,
  // its unread mark or the order, and Marlow's task is as it was.
  await page.reload();
  await expect(botRow("marlow")).toBeVisible({ timeout: 30_000 });
  await expect(botRow("pip").locator(".unread-dot")).toHaveCount(0);
  await expect(botRow("pip")).not.toHaveAccessibleName(/, unread/);
  const order = await botOrder();
  expect(order.indexOf("marlow")).toBeLessThan(order.indexOf("pip"));
  await expect(botRow("marlow")).toHaveAccessibleName(/, 1 task\b/);
  await expect(botRow("pip")).toHaveAccessibleName(/^pip(?!.*\d+ tasks?\b)/i);
  await expect(taskRow(api)).toHaveCount(0);
  await expect(taskRow(scheduled)).toHaveCount(0);
  await shots("after-hidden");

  // The routine's run opens from Routines.
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  const view = page.getByTestId("routines-view");
  await view
    .getByRole("button", { name: /Nightly sync/ })
    .first()
    .click();
  await view.getByTestId("run-row").first().click();
  await view.getByRole("button", { name: "Open conversation" }).click();
  await expect(page.getByTestId("transcript")).toContainText("Here is a plain reply", {
    timeout: 30_000,
  });

  // With the switch on, both are listed, Pip shows the newer one and moves up, with its unread mark.
  await setOthersShown(true);
  await unfold("pip");
  await expect(taskRow(api)).toBeVisible();
  await expect(taskRow(scheduled)).toBeVisible();
  await expect(botRow("pip")).toHaveAccessibleName(/, 2 tasks\b/);
  const shown = await botOrder();
  expect(shown.indexOf("pip")).toBeLessThan(shown.indexOf("marlow"));
  await expect(botRow("marlow")).toHaveAccessibleName(/, 1 task\b/);
  await shots("shown");

  // Off again: an API client's session that waits on an approval shows until it is answered. The
  // gateway lets no headless run wait (the HTTP API's, the CLI's, a routine's: "Headless runs
  // cannot wait for interactive exec approval"), so the session the API client opened is waiting
  // once a person continues it from another device: an operator's turn there asks.
  await setOthersShown(false);
  await expect(taskRow(api)).toHaveCount(0);
  await expect(botRow("otto")).toHaveAccessibleName(/^otto, 0 tasks\b/i);
  const waiting = "agent:otto:openai-user:e2e-approver";
  expect((await apiTurn("otto", "e2e-approver", "#text")).status).toBe(200);
  const before = approver!.lastSeq;
  const sent = await approver!.send(waiting, "#approve");
  const asked = await approver!.waitFor(
    "the approval in the API client's session",
    (event) =>
      event.event === "exec.approval.requested" &&
      (event.payload as { request?: { sessionKey?: string } }).request?.sessionKey === waiting,
    90_000,
    before,
  );
  // Otto's one task while it waits: his row says so, and it is listed under him.
  await expect(botRow("otto")).toHaveAccessibleName(/^otto, waiting for you, 1 task\b/i, {
    timeout: 30_000,
  });
  await shots("waiting");
  // Open while it is answered, it stays listed until the person opens another task. Otto's row
  // opens his main conversation, and the task is listed under it.
  await botRow("otto").click();
  await taskRow(waiting).click();
  await expect(page.getByTestId("transcript")).toContainText("#approve", { timeout: 30_000 });
  await approver!.request("exec.approval.resolve", {
    id: String((asked.payload as { id: unknown }).id),
    decision: "allow-once",
  });
  await approver!.terminal(String(sent.runId));
  await expect(botRow("otto")).toHaveAccessibleName(/^otto, 1 task\b/i, { timeout: 30_000 });
  await expect(page.getByTestId("transcript")).toContainText("#approve");
  await botRow("marlow").click();
  await expect(botRow("otto")).toHaveAccessibleName(/^otto(?!.*\d+ tasks?\b)/i, {
    timeout: 30_000,
  });
  // The task started in Clawtrate was there throughout.
  await expect(botRow("marlow")).toHaveAccessibleName(/, 1 task\b/);
});
