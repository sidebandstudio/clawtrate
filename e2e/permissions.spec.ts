// What a bot may do (docs/design/controls.md sections 2 to 5) against a real
// development gateway with Clawtrate's rules plugin loaded: an instance of
// this file's own, started only in the shard that runs this file, recorded
// before it starts and reset by its recorded identity afterwards. The
// interface runs on a preview host of its own and is driven as a person
// drives it; what landed is read back from the gateway and the plugin, and
// what a call did from its own result.
//
// With CLAWTRATE_PERMISSION_SHOTS=<folder outside the repository>, it also
// saves screenshots of what it checked there.
import { expect, test, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { RULES_CLIENTS } from "../tools/dev-gateway/src/rules-checks.ts";
import { newRunId, processIdentity } from "../tools/dev-gateway/src/state-guard.ts";
import { devGateway, startHost, stopChild } from "./global-setup.ts";
import { cleanUp, saveRecord, TEMP_PREFIX, type RunRecord } from "./run-record.ts";

const ROOT = join(import.meta.dirname, "..");
const RECORDS = join(ROOT, "tools/dev-gateway/.run/e2e");
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const SHOTS = process.env.CLAWTRATE_PERMISSION_SHOTS ?? null;
const RUN = randomBytes(4).toString("hex");
const NAME = `e2e-${RUN}-rules`;
const STAMP = Date.now().toString(36);

test.describe.configure({ mode: "serial" });

type Json = Record<string, unknown>;
let record: RunRecord | null = null;
let host: { child: ChildProcess; url: string } | null = null;
let page: Page;
let admin: OperatorSession;
let stateDir = "";

const reset = (name: string, runId: string) => {
  devGateway(name, "reset", "--run-id", runId);
};

async function approve(): Promise<void> {
  await expect
    .poll(() => devGateway(NAME, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
}

/** One bridge command, over the host's own bridge socket, as another viewer of the page sends it. */
async function hostCommand<T = unknown>(command: Json): Promise<T> {
  return page.evaluate(
    (command) =>
      new Promise<T>((resolve, reject) => {
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
          else if (message.id === "do") {
            socket.close();
            if (message.ok) resolve(message.value as T);
            else reject(new Error(message.error));
          }
        };
        socket.onerror = () => reject(new Error("bridge socket error"));
      }),
    command,
  );
}

async function config(): Promise<Json> {
  return ((await admin.request<{ config: Json }>("config.get", {})).config ?? {}) as Json;
}
const botTools = (cfg: Json, bot: string) =>
  ((((cfg.agents as Json).entries as Record<string, Json>)[bot] ?? {}).tools ?? {}) as Json;

/** A config change made by the gateway's owner, not through the page, waited for until applied. */
async function patch(raw: Json, replacePaths: string[]): Promise<void> {
  const before = await admin.request<Json>("config.get", {});
  await admin.request("config.patch", {
    raw: JSON.stringify(raw),
    baseHash: before.hash,
    replacePaths,
  });
  await expect
    .poll(
      async () => {
        const now = await admin.request<Json>("config.get", {});
        return (
          now.configRevisionHash !== before.configRevisionHash &&
          now.appliedConfigHash === now.configRevisionHash
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}

/** A scope of the rules plugin, replaced as the gateway's owner (the rules page is other work). */
async function setScope(scope: string, rules: Json[]): Promise<void> {
  const got = await admin.request<{ scopes: Record<string, { version: number }> }>(
    "clawtrate-tool-rules.get",
    { scope },
  );
  await admin.request("clawtrate-tool-rules.set", {
    scope,
    rules,
    fallback: false,
    expectedVersion: got.scopes[scope]?.version ?? 0,
  });
}
async function scopeRules(scope: string): Promise<Json[]> {
  const got = await admin.request<{ scopes: Record<string, { rules: Json[] }> }>(
    "clawtrate-tool-rules.get",
    { scope },
  );
  return got.scopes[scope]?.rules ?? [];
}

async function shots(name: string): Promise<void> {
  if (!SHOTS) return;
  const size = page.viewportSize()!;
  for (const [width, height, theme] of [
    [1440, 900, "light"],
    [1440, 900, "dark"],
    [390, 844, "light"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}-${width}.png`) });
  }
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: "light" });
}

const botRow = (name: string) =>
  page.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${name}\\b`) });

/** A bot's permissions page, in the Work pane's Settings tab, read anew. */
async function permissions(bot: string) {
  await botRow(bot).click();
  if (!(await page.getByTestId("work-panel").isVisible()))
    await page.keyboard.press("ControlOrMeta+\\");
  await page.getByRole("tab", { name: "Settings" }).click();
  const line = page.getByRole("button", { name: `Back to what ${bot} may do` });
  if (await line.isVisible()) await line.click();
  const back = page.getByRole("button", { name: "Back to settings" });
  if (await back.isVisible()) await back.click();
  await page.getByRole("button", { name: new RegExp(`^What ${bot} may do: \\d+ never`) }).click({
    timeout: 30_000,
  });
  const view = page.getByTestId("permissions");
  await expect(view.getByTestId("glance")).toBeVisible({ timeout: 30_000 });
  return view;
}
const lineRow = (id: string) => page.locator(`[data-c-line="${id}"]`);
async function openLine(id: string) {
  await lineRow(id).click();
  await expect(page.getByTestId("permission-line")).toBeVisible();
  return page.getByTestId("permission-line");
}

/** Choose on an open line, and wait for the saved value its read-back shows. */
async function choose(label: string, saved: RegExp) {
  const line = page.getByTestId("permission-line");
  await line.getByRole("radio", { name: label, exact: true }).click();
  await expect(line.getByTestId("choice-sentence")).toHaveText(saved, { timeout: 30_000 });
  await expect(line.getByRole("radio", { name: label, exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
}

/** A new task started by the host's own device, opened: the device whose message starts the run. */
let tasks = 0;
async function hostTask(botId: string, bot: string, label: string, text: string) {
  tasks += 1;
  const title = `${label} ${tasks} ${STAMP}`;
  const { key } = await hostCommand<{ key: string }>({
    type: "createTask",
    botId,
    text,
    label: title,
  });
  const row = botRow(bot);
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  const list = page.getByRole("list", { name: `${bot}'s tasks` });
  const rows = list.getByTestId("task");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  const showAll = list.getByRole("button", { name: /^Show all/ });
  if ((await rows.filter({ hasText: title }).count()) === 0 && (await showAll.count()) > 0)
    await showAll.click();
  await rows.filter({ hasText: title }).first().click({ timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible({
    timeout: 20_000,
  });
  return { key, title };
}
const transcript = () => page.getByTestId("transcript");
const approvalCard = () => page.getByTestId("approval-card");

/** A tool's results in a task's history, read from the gateway: what each call did. */
async function toolResults(key: string): Promise<Array<{ name: string; text: string }>> {
  const history = await admin.request<{ messages?: Json[] }>("chat.history", {
    sessionKey: key,
    limit: 200,
  });
  const out: Array<{ name: string; text: string }> = [];
  for (const message of history.messages ?? []) {
    if (message.role !== "toolResult") continue;
    const content = Array.isArray(message.content) ? (message.content as Json[]) : [];
    out.push({
      name: String(message.toolName ?? ""),
      text: content.map((c) => (typeof c.text === "string" ? c.text : "")).join(""),
    });
  }
  return out;
}
async function waitResult(key: string, tool: string, count = 1) {
  await expect
    .poll(async () => (await toolResults(key)).filter((r) => r.name === tool).length, {
      timeout: 60_000,
    })
    .toBeGreaterThanOrEqual(count);
  return (await toolResults(key)).filter((r) => r.name === tool);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  const self = processIdentity(process.pid);
  if (self.state !== "alive") throw new Error("could not determine this process's start time");
  const runId = newRunId();
  const data = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  // Registered before anything is started, so a run killed here is cleaned up by the next.
  record = {
    run: RUN,
    runner: { pid: process.pid, identity: self.identity },
    instances: [{ name: NAME, runId }],
    host: null,
    dirs: [data],
  };
  saveRecord(RECORDS, record);
  devGateway(NAME, "start", "--run-id", runId, "--with-plugin", "clawtrate-tool-rules");
  const inst = openInstance(NAME);
  stateDir = inst.stateDir;
  admin = await openOperator(
    inst,
    "Clawtrate permissions check",
    [...RULES_CLIENTS.admin.scopes],
    [...RULES_CLIENTS.admin.caps],
  );
  record.hostPending = true;
  saveRecord(RECORDS, record);
  const started = startHost(NAME, STATIC, data);
  const found = processIdentity(started.host.pid!);
  if (found.state !== "alive") {
    started.gated.abort();
    throw new Error("could not record the preview host");
  }
  record.host = { pid: started.host.pid!, identity: found.identity };
  delete record.hostPending;
  saveRecord(RECORDS, record);
  started.gated.release();
  host = { child: started.host, url: await started.url };

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  await page.goto(host.url);
  await page.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await approve();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
  await hostCommand({ type: "requestAccess" });
  await approve();
  await expect(page.getByTestId("plus")).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  await admin?.close();
  if (host) await stopChild(host.child);
  if (record) {
    const problems = cleanUp(RECORDS, record, reset);
    if (problems.length > 0) throw new Error(problems.join("\n"));
  }
});

test("F-176: the page shows the rules plugin's own state and the gateway's settings, locks what the gateway denies for every bot, and asks for admin only when asked", async () => {
  test.setTimeout(180_000);
  const view = await permissions("Juniper");
  await expect(view.getByTestId("rules-plugin")).toContainText(/^Rules plugin answered at /);
  // The development config denies the browser for every bot: Never, with the padlock.
  await expect(lineRow("browser")).toContainText("Never");
  await expect(lineRow("browser")).toContainText("Set on the gateway");
  await expect(lineRow("read")).toContainText("Allowed");
  await shots("permissions-read-only");
  const line = await openLine("browser");
  for (const label of ["Allow", "Ask", "Never"])
    await expect(line.getByRole("radio", { name: label, exact: true })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  await expect(line.getByTestId("choice-reason")).toContainText(
    "The gateway's settings deny this for every bot. Clawtrate can't change them.",
  );
  // Below admin nothing is changed, and admin access is asked for only by this request.
  const bar = page.getByTestId("admin-bar");
  await expect(bar).toContainText("Changing Juniper's permissions needs admin access.");
  await bar.getByRole("button", { name: "Request admin access" }).click();
  await approve();
  await expect(
    page.getByTestId("permission-line").or(page.getByTestId("permissions")),
  ).toBeVisible();
  await expect
    .poll(async () => (await hostCommand<Json>({ type: "readPermissions", botId: "main" })).botId, {
      timeout: 30_000,
    })
    .toBe("main");
  await expect(page.getByRole("radio", { name: "Allow", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
    { timeout: 30_000 },
  );
});

test("F-176 F-330: Never on one line and Ask on another, chosen on the page and read back: the denied write never runs, and the read pauses at a card that runs that one call once", async () => {
  test.setTimeout(240_000);
  await permissions("Pip");
  await openLine("files");
  await choose(
    "Never",
    /^Pip can't change files\. The gateway removes these tools from Pip\. If Pip tries one, the attempt fails as a tool that was not found\.$/,
  );
  expect(botTools(await config(), "pip").deny).toEqual(["write", "edit", "apply_patch"]);
  await page.getByRole("button", { name: "Back to what Pip may do" }).click();
  await openLine("read");
  await choose("Ask", /^Pip asks you first\. Only while Clawtrate's rules plugin runs\./);
  expect(await scopeRules("pip")).toEqual([
    expect.objectContaining({ action: "ask", tools: ["read", "ls"] }),
  ]);
  await page.getByRole("button", { name: "Back to what Pip may do" }).click();
  await expect(lineRow("files")).toContainText("The gateway enforces this");
  await expect(lineRow("read")).toContainText("Only while Clawtrate's rules plugin runs");
  await shots("permissions-pip");

  const { key } = await hostTask("pip", "Pip", "Deny and ask", "#write #read");
  // The write is refused by the gateway: the tool was removed from Pip's tools, and no file appears.
  const [write] = await waitResult(key, "write");
  expect(write!.text).toBe("Tool write not found");
  expect(existsSync(join(stateDir, "workspaces", "pip", "notes", "scratch.md"))).toBe(false);
  // The read waits at the rules plugin's card: Allow once and Deny, never Always allow.
  const card = approvalCard();
  await expect(card).toHaveCount(1, { timeout: 60_000 });
  await expect(card.getByRole("button", { name: /^Allow( once)?$/ })).toBeVisible();
  await expect(card.getByRole("button", { name: "Deny" })).toBeVisible();
  await expect(card.getByRole("button", { name: /Always allow/ })).toHaveCount(0);
  await shots("permissions-ask-card");
  await card.getByRole("button", { name: /^Allow( once)?$/ }).click();
  // The call's own result says it ran; the card's answer alone does not.
  const [read] = await waitResult(key, "read");
  expect(read!.text).not.toMatch(/not found|did not run|Denied/);
  // The same call again asks again: Allow once passed that one call.
  await page.getByTestId("composer-input").fill("#read");
  await page.getByTestId("composer-input").press("Enter");
  await expect(
    approvalCard().filter({ has: page.getByRole("button", { name: "Deny" }) }),
  ).toHaveCount(1, { timeout: 60_000 });
  await approvalCard()
    .filter({ has: page.getByRole("button", { name: "Deny" }) })
    .getByRole("button", { name: "Deny" })
    .click();
  const reads = await waitResult(key, "read", 2);
  expect(reads[1]!.text).toMatch(/Denied by user\. The tool call did not run\./);
});

// F-333 and F-336 name a fixture with the review on and returning allow; the development
// gateway has no review that answers (exec auto-review asks the model), so this check claims
// neither row.
test("a tool the gateway's settings deny for every bot stays Never and locked whatever the bot's own Allow or Ask, and its call is refused with no card to approve", async () => {
  test.setTimeout(240_000);
  const every = (await config()).tools as Json;
  const deny = [...(every.deny as string[])];
  await patch({ tools: { deny: [...deny, "web_search"] } }, ["tools.deny"]);
  try {
    for (const [variant, rules] of [
      ["allow", [{ action: "allow", tools: ["web_search"] }]],
      [
        "ask",
        [
          { action: "allow", tools: ["web_search"] },
          { action: "ask", tools: ["web_search"] },
        ],
      ],
    ] as const) {
      await setScope("main", [...rules]);
      await permissions("Juniper");
      await expect(lineRow("web")).toContainText("Never");
      await expect(lineRow("web")).toContainText("Set on the gateway");
      const line = await openLine("web");
      for (const label of ["Allow", "Ask", "Never"])
        await expect(line.getByRole("radio", { name: label, exact: true })).toHaveAttribute(
          "aria-disabled",
          "true",
        );
      if (variant === "ask") await shots("permissions-gateway-deny");
      const { key } = await hostTask("main", "Juniper", `Gateway deny ${variant}`, "#search");
      const [search] = await waitResult(key, "web_search");
      expect(search!.text).toMatch(/Tool web_search not found/);
      await expect(approvalCard()).toHaveCount(0);
      const pending = await admin.request<unknown[]>("plugin.approval.list", {});
      expect(Array.isArray(pending) ? pending : []).toEqual([]);
    }
  } finally {
    await setScope("main", []);
    await patch({ tools: { deny } }, ["tools.deny"]);
  }
});

test("F-222: a bot's settings choose whether it may use a tool server: Never writes the server's tools to its own deny list and its calls are refused; Allow takes them off and they run", async () => {
  test.setTimeout(240_000);
  await permissions("Marlow");
  await expect(lineRow("server:coder")).toContainText("Allowed");
  await openLine("server:coder");
  await choose(
    "Never",
    /^Marlow can't use the tool server coder\. The gateway removes these tools from Marlow\. If Marlow tries one, the attempt fails as a tool that was not found\.$/,
  );
  expect(botTools(await config(), "marlow").deny).toEqual(["coder__*"]);
  await shots("permissions-connector");
  const refused = await hostTask("marlow", "Marlow", "Connector off", "#mcp");
  const [call] = await waitResult(refused.key, "coder__send_message");
  expect(call!.text).toBe("Tool coder__send_message not found");
  // Allowed again from the same page: the gateway's list no longer names it, and the call runs.
  await permissions("Marlow");
  await openLine("server:coder");
  await choose("Allow", /^Marlow's own setting is Allow/);
  expect(botTools(await config(), "marlow").deny).toBeUndefined();
  const allowed = await hostTask("marlow", "Marlow", "Connector on", "#mcp");
  const [ran] = await waitResult(allowed.key, "coder__send_message");
  expect(ran!.text).not.toMatch(/not found/);
});

test("F-177: a rule for every bot applies to each bot on top of its own: Juniper's and Pip's pages show it, Pip's own Ask stays Pip's, and each call is decided by the rules that apply to its bot", async () => {
  test.setTimeout(240_000);
  await setScope("*", [{ action: "ask", tools: ["sessions_list"] }]);
  try {
    await permissions("Juniper");
    await expect(lineRow("tasks")).toContainText("Asks first");
    await expect(lineRow("tasks")).toContainText("a rule for every bot");
    await expect(lineRow("read")).toContainText("Allowed");
    await permissions("Pip");
    await expect(lineRow("tasks")).toContainText("a rule for every bot");
    await expect(lineRow("read")).toContainText("Pip's rule");
    await shots("permissions-every-bot");
    // Juniper's read runs without a card: Pip's Ask is Pip's alone.
    const juniper = await hostTask("main", "Juniper", "Own rules", "#read");
    const [read] = await waitResult(juniper.key, "read");
    expect(read!.text).not.toMatch(/not found|did not run/);
    await expect(approvalCard()).toHaveCount(0);
    // Juniper's look at its tasks asks: the rule for every bot.
    await hostTask("main", "Juniper", "Every bot's rule", "#sessions");
    const card = approvalCard();
    await expect(card).toHaveCount(1, { timeout: 60_000 });
    await card.getByRole("button", { name: "Deny" }).click();
  } finally {
    await setScope("*", []);
  }
});

test("F-414: Otto's command policy is Ask, read from its settings; a command the person asked for earlier in the task still shows the gateway's card, because earlier words never pass a call", async () => {
  test.setTimeout(240_000);
  await permissions("Otto");
  await expect(lineRow("exec")).toContainText("Asks first");
  await expect(lineRow("exec")).toContainText("Otto's setting: Ask");
  const { key } = await hostTask(
    "otto",
    "Otto",
    "Asked earlier",
    "Please run ls in your workspace.",
  );
  await expect(transcript()).toContainText("Please run ls in your workspace.", { timeout: 30_000 });
  await expect
    .poll(
      async () => {
        const history = await admin.request<{ messages?: Json[] }>("chat.history", {
          sessionKey: key,
          limit: 20,
        });
        return (history.messages ?? []).some((m) => m.role === "assistant");
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await page.getByTestId("composer-input").fill("#approve");
  await page.getByTestId("composer-input").press("Enter");
  const card = approvalCard();
  await expect(card).toHaveCount(1, { timeout: 60_000 });
  await expect(card).toContainText("Otto wants to run a command");
  await card.getByRole("button", { name: "Deny" }).click();
  const [exec] = await waitResult(key, "exec");
  expect(exec!.text).toMatch(/denied/i);
});

// The rules page for every bot (issue #36) is where a person makes this rule; that unit takes
// F-334 with this check. Here the rule is set as the gateway's owner, and no row is claimed.
test("a Never rule of the rules plugin: the call never runs, and its card reads Blocked by policy and names the rule", async () => {
  test.setTimeout(240_000);
  await setScope("marlow", [{ action: "never", tools: ["ls"] }]);
  try {
    await permissions("Marlow");
    await expect(lineRow("read")).toContainText("Never: ls (Marlow's rule, version 1)");
    await expect(lineRow("read")).toContainText("Limited");
    const { key } = await hostTask("marlow", "Marlow", "Plugin never", "#list");
    const [list] = await waitResult(key, "ls");
    expect(list!.text).toMatch(
      /^Blocked by Clawtrate's rules plugin: marlow's rule 'Never · ls', version 1 \(rule [0-9a-f]{12}\)\. The call did not run\.$/,
    );
    await expect(transcript()).toContainText("Blocked by policy", { timeout: 30_000 });
    await shots("permissions-blocked");
  } finally {
    await setScope("marlow", []);
  }
});
