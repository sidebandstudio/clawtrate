// Approval cards, the action cards behind them, and the rail, against a real
// development gateway: what the gateway's own requests carry (its warnings and
// the fields that say why it asked), a command that streams its output while
// it runs, Allow once taken at its word, and how a task's row reads once its
// run is over. Runs that ask for approval start from the host's own device
// (`createTask`), since the gateway shows a pending exec approval only to the
// device whose run asked for it; decisions are made by clicking the cards.
//
// The commands it asks approval for are its own: `sleep 7` and the scripted
// four-line count (`#count`), neither of which any other check saves a rule for.
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import { SHELL_COMMANDS } from "../tools/dev-gateway/src/scenarios.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { devGateway, startHost, stopChild } from "./global-setup.ts";
import { leaveIdle } from "./teardown.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
/** Where to save screenshots on a real gateway, when set. */
const SHOTS = process.env.CLAWTRATE_CARD_SHOTS;
const STAMP = Date.now().toString(36);

type Host = { child: ChildProcess; url: string; data: string };
const hosts: Host[] = [];
let page: Page;

async function startOwnHost(): Promise<Host> {
  const data = mkdtempSync(join(tmpdir(), "clawtrate-approvals-"));
  const started = startHost(INSTANCE, STATIC, data);
  started.gated.release();
  const host = { child: started.host, url: await started.url, data };
  hosts.push(host);
  return host;
}

/** The interface on a host, paired with the gateway as a new device. */
async function pairedPage(browser: Browser, host: Host): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: host.url });
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

/** One bridge command over the host's own bridge socket. */
async function hostCommand<T = unknown>(on: Page, command: Record<string, unknown>): Promise<T> {
  return on.evaluate(
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
          if (message.type === "hello") {
            socket.send(JSON.stringify({ type: "command", id: "do", command }));
          } else if (message.id === "do") {
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

/** Ask for interactive access from a viewer that stays until the owner approved. */
async function requestAccess(on: Page): Promise<void> {
  await on.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`ws://${location.host}/bridge`);
        (window as unknown as { accessSocket?: WebSocket }).accessSocket = socket;
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as { type: string };
          if (message.type !== "hello") return;
          socket.send(
            JSON.stringify({ type: "command", id: "access", command: { type: "requestAccess" } }),
          );
          resolve();
        };
        socket.onerror = () => reject(new Error("bridge socket error"));
      }),
  );
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  await on.keyboard.press("ControlOrMeta+,");
  const dialog = on.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Gateway", exact: true }).click();
  await expect(dialog.getByTestId("granted-scopes")).toContainText("operator.approvals", {
    timeout: 30_000,
  });
  await on.keyboard.press("Escape");
  await on.evaluate(() =>
    (window as unknown as { accessSocket?: WebSocket }).accessSocket?.close(),
  );
}

/** Open a bot's task in the rail. */
async function openTask(on: Page, bot: string, title: string): Promise<void> {
  const row = on.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${bot}\\b`) });
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  const list = on.getByRole("list", { name: `${bot}'s tasks` });
  const rows = list.getByTestId("task");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  const showAll = list.getByRole("button", { name: /^Show all/ });
  if ((await rows.filter({ hasText: title }).count()) === 0 && (await showAll.count()) > 0)
    await showAll.click();
  await rows.filter({ hasText: title }).first().click({ timeout: 20_000 });
  await expect(on.getByRole("heading", { level: 1, name: title })).toBeVisible({
    timeout: 20_000,
  });
}

/** A new task started by the host's own device, labelled; new on every call. */
let hostTasks = 0;
async function hostTask(
  botId: string,
  label: string,
  text: string,
): Promise<{ title: string; key: string }> {
  hostTasks += 1;
  const title = `${label} ${hostTasks} ${STAMP}`;
  const { key } = await hostCommand<{ key: string }>(page, {
    type: "createTask",
    botId,
    text,
    label: title,
  });
  created.push(key);
  return { title, key };
}

/** Every task this spec made: removed afterwards, so the checks after it find the seed as it was. */
const created: string[] = [];

/** A paired admin client: only an admin connection sees the host's approvals and its rules. */
let admin: OperatorSession | null = null;
async function adminClient(): Promise<OperatorSession> {
  admin ??= await openOperator(
    openInstance(INSTANCE),
    "Clawtrate approvals check (admin)",
    ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
    ["tool-events", "approvals", "exec-approvals"],
  );
  return admin;
}

type HistoryRow = {
  role?: string;
  toolCallId?: string;
  toolName?: string;
  content?: unknown;
  details?: Record<string, unknown>;
};

/** A task's history rows, read by the admin client. */
async function historyOf(key: string): Promise<HistoryRow[]> {
  const history = await (
    await adminClient()
  ).request<{ messages: HistoryRow[] }>("chat.history", { sessionKey: key, limit: 50 });
  return history.messages;
}

/**
 * Wait for the gateway to hold the task's pending exec request (as the admin client lists it),
 * then for its card: the card's wait starts from the gateway's own state, not from the send.
 */
async function pendingRequest(key: string): Promise<void> {
  const op = await adminClient();
  await expect
    .poll(
      async () =>
        (
          await op.request<Array<{ request: { sessionKey?: string } }>>("exec.approval.list", {})
        ).some((each) => each.request.sessionKey === key),
      { timeout: 120_000, intervals: [1000] },
    )
    .toBe(true);
  await expect(approvalCard(page)).toHaveCount(1, { timeout: 30_000 });
}

/** Every warning a request record carries, as the gateway words them: its warning text, then its analysis. */
function gatewayWarnings(request: Record<string, unknown>): string[] {
  const analysis = request.commandAnalysis as { warningLines?: unknown[] } | null | undefined;
  const lines = [
    ...String(request.warningText ?? "").split("\n"),
    ...(analysis?.warningLines ?? []).map(String),
  ];
  return [...new Set(lines.map((line) => line.trim()).filter((line) => line !== ""))];
}

async function shot(target: Page | ReturnType<Page["locator"]>, name: string): Promise<void> {
  if (!SHOTS) return;
  await target.screenshot({ path: join(SHOTS, `real-${name}.png`) });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(420_000);
  expect(INSTANCE, "a named instance").toMatch(/^[a-z0-9-]+$/);
  page = await pairedPage(browser, await startOwnHost());
  await requestAccess(page);
  // Paired up front: each pairing is a gateway command, slow on a loaded machine.
  await adminClient();
  await questionsClient();
});

let checkStarted = 0;
test.beforeEach(() => {
  checkStarted = Date.now();
});
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  test.setTimeout(testInfo.timeout + 120_000);
  if (testInfo.status === testInfo.expectedStatus) return;
  const op = await adminClient();
  await leaveIdle((method, params) => op.request(method, params), checkStarted);
});

test.afterAll(async () => {
  test.setTimeout(240_000);
  // Each deleted the way the rail deletes it (stopped, archived, then deleted with its transcript),
  // through the host's own bridge, which names the session the gateway's guards ask for.
  for (const key of created) {
    await hostCommand(page, { type: "deleteTask", key }).catch(() => undefined);
  }
  // Nothing of this spec's is left in the gateway's list for the checks after it.
  const op = await adminClient();
  const { sessions } = await op.request<{ sessions: Array<{ key: string }> }>("sessions.list", {
    limit: 500,
  });
  expect(sessions.filter((row) => created.includes(row.key)).map((row) => row.key)).toEqual([]);
  await admin?.close();
  await asker?.close();
  for (const host of hosts) {
    await stopChild(host.child);
    rmSync(host.data, { recursive: true, force: true });
  }
});

const approvalCard = (on: Page) => on.getByTestId("approval-card");
const transcript = (on: Page) => on.getByTestId("transcript");

test("F-171 F-164 F-432: a command the gateway warns about: its warnings on the card in its words, the full request with the exact command to copy and the host's policy as policy, then its output while it streams", async () => {
  test.setTimeout(300_000);
  const { title, key } = await hostTask("otto", "Count", "#count");
  await openTask(page, "Otto", title);
  const card = approvalCard(page);
  await pendingRequest(key);
  // Every warning the gateway attached to the request, in its words, each on a line of its own
  // with the warning mark, and none of Clawtrate's own.
  const command = SHELL_COMMANDS.count;
  const pending = await (
    await adminClient()
  ).request<Array<{ id: string; request: Record<string, unknown> }>>("exec.approval.list", {});
  const request = pending.find((each) => each.request.sessionKey === key)!.request;
  const warnings = card.locator(".request-warnings li");
  await expect(warnings).toHaveText(gatewayWarnings(request));
  expect(gatewayWarnings(request)).toContain("Contains inline-eval: perl -e");
  for (const line of await warnings.all()) await expect(line.locator("svg")).toHaveCount(1);
  await shot(card, "approval-warning");

  // The full request: the exact command in mono, its copy button, why the gateway asked.
  const full = card.locator("details.request-full");
  await full.locator("summary").click();
  await expect(full.locator("summary")).toHaveText(/Hide full request/);
  await expect(full.locator(".command-line code")).toHaveText(command);
  await full.getByRole("button", { name: "Copy command" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(command);
  // The host's policy, from the request's own fields, as policy: the gateway records no cause.
  expect([request.host, request.security, request.ask]).toEqual([
    "gateway",
    "allowlist",
    "on-miss",
  ]);
  await expect(full.locator(".request-why")).toHaveText(
    "Request policy: security allowlist, ask on-miss.",
  );
  await expect(full.getByRole("button", { name: "Manage settings" })).toHaveCount(0);
  await shot(card, "approval-full-request");
  await full.locator("summary").click();
  await expect(full.locator("summary")).toHaveText(/Show full request/);

  // Inline code offers no reusable rule: the card offers Allow and Deny only.
  await expect(card.locator('.request-actions[data-row="main"] button')).toHaveText([
    "Allow",
    "Deny",
  ]);
  // Allowed once, the command runs: its card, opened while it runs, shows each line as the
  // gateway streams it, before the call completes.
  await card.getByRole("button", { name: "Allow", exact: true }).click({ timeout: 15_000 });
  await expect(card.locator(".tag")).toHaveText("Allowed once", { timeout: 30_000 });
  const action = page.locator(".transcript details.card.action[data-kind='command']").last();
  await expect(action).toHaveAttribute("data-status", "running", { timeout: 30_000 });
  // The line is redrawn with each output update; open it without waiting for it to hold still.
  await action.locator(":scope > summary").click({ force: true, timeout: 15_000 });
  await expect(action).toHaveAttribute("open", "");
  await expect(action.locator("pre").first()).toContainText("Step 1 of 4", { timeout: 15_000 });
  await expect(action).toHaveAttribute("data-status", "running");
  await expect(action.locator("pre").first()).toContainText("Step 2 of 4", { timeout: 15_000 });
  await shot(action, "action-streaming");
  // The call ends with all four lines, and the run with its reply.
  await expect(transcript(page)).toContainText("The command printed four lines.", {
    timeout: 60_000,
  });
  await expect(action).not.toHaveAttribute("data-status", "running");
  await expect(action.locator("pre").first()).toContainText("Step 4 of 4");
});

test("F-325: Allow once runs the command exactly once and saves no rule; the same command asks again", async () => {
  test.setTimeout(300_000);
  const first = await hostTask("otto", "Once", "#sleep 7");
  await openTask(page, "Otto", first.title);
  const card = approvalCard(page);
  await pendingRequest(first.key);
  await card.getByRole("button", { name: "Allow once" }).click();
  await expect(card.locator(".tag")).toHaveText("Allowed once", { timeout: 30_000 });
  await card.locator("summary").first().click();
  // What was answered and by whom, as the gateway recorded it; what became of the command only
  // from the call's own result, and no forecast.
  await expect(card.locator(".request-resolved-body > p").first()).toHaveText(
    /^Allowed once( by .+)? at \d+:\d\d [AP]M\.$/,
  );
  await expect(card).not.toContainText(/can run now|will ask again|next time/);
  await expect(transcript(page)).toContainText("The slow command finished.", { timeout: 60_000 });
  await expect(card.getByTestId("approval-then")).toHaveText(
    "The command ran. Its result is on its card above.",
  );
  // It ran exactly once: one call, one result, the command's own.
  const rows = await historyOf(first.key);
  const calls = rows.flatMap((row) =>
    Array.isArray(row.content)
      ? (row.content as Array<{ type?: string; name?: string; arguments?: { command?: string } }>)
          .filter((block) => block.type === "toolCall" && block.name === "exec")
          .map((block) => block.arguments?.command)
      : [],
  );
  expect(calls).toEqual(["sleep 7"]);
  const results = rows.filter((row) => row.role === "toolResult" && row.toolName === "exec");
  expect(results).toHaveLength(1);
  // History keeps the result's exit code (and not its live status).
  expect(results[0]!.details).toMatchObject({ exitCode: 0 });
  // No rule was saved: Otto's allowlist on the gateway has no entry for the command.
  const policy = await (
    await adminClient()
  ).request<{ file?: { agents?: Record<string, { allowlist?: Array<{ pattern?: string }> }> } }>(
    "exec.approvals.get",
    {},
  );
  const entries = Object.values(policy.file?.agents ?? {}).flatMap((agent) =>
    (agent.allowlist ?? []).map((entry) => JSON.stringify(entry)),
  );
  expect(entries.filter((entry) => entry.includes("sleep 7"))).toEqual([]);
  // The same command again asks again.
  const again = await hostTask("otto", "Once again", "#sleep 7");
  await openTask(page, "Otto", again.title);
  await pendingRequest(again.key);
  await expect(approvalCard(page)).toHaveAttribute("data-state", "pending");
  await approvalCard(page).getByRole("button", { name: "Deny" }).click();
  await expect(approvalCard(page).locator(".tag")).toHaveText("Denied", { timeout: 30_000 });
});

test("F-091: an approval is its action's waiting state and a card of its own after it, counted once, with its request and resolution in Raw, and so again once the task is read anew", async () => {
  test.setTimeout(300_000);
  const { title, key } = await hostTask("otto", "Linked", "#sleep 8");
  await openTask(page, "Otto", title);
  const card = approvalCard(page);
  await pendingRequest(key);
  // While it waits, the action card is in its waiting state, and the approval card follows it.
  const action = page.locator(".transcript details.card.action[data-kind='command']").last();
  await expect(action).toHaveAttribute("data-status", "waiting");
  const follows = () =>
    page.getByTestId("transcript").evaluate((element) => {
      const nodes = [
        ...element.querySelectorAll(
          "details.card.action[data-kind='command'], [data-testid='approval-card']",
        ),
      ];
      return nodes.map((node) =>
        node.matches("[data-testid='approval-card']") ? "approval" : "action",
      );
    });
  expect((await follows()).slice(-2)).toEqual(["action", "approval"]);
  await card.getByRole("button", { name: "Allow once" }).click();
  await expect(card.locator(".tag")).toHaveText("Allowed once", { timeout: 30_000 });
  await expect(transcript(page)).toContainText("The slow command finished.", { timeout: 60_000 });
  // One action: the approval is not counted as another.
  await expect(page.getByTestId("run-line").last().locator("summary")).toHaveAccessibleName(
    /^Worked for \d+s · 1 action$/,
  );
  const rawHas = async () => {
    const approval = approvalCard(page);
    await approval.locator("summary").first().click();
    await approval.getByRole("button", { name: "Raw" }).click();
    const raw = approval.getByRole("region", { name: "What the gateway sent" });
    await expect(raw.locator(".code-label")).toContainText([
      "The request record, as the gateway sent it (exec.approval.requested or exec.approval.list)",
    ]);
    await expect(raw).toContainText("(exec.approval.resolved)");
    await expect(raw).toContainText('"command": "sleep 8"');
  };
  await rawHas();

  // The page reloaded: its viewer goes, the host lets the task go, and the task is read again
  // from history, which keeps no approval record. The settled card is back after its action.
  await page.reload();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
  await openTask(page, "Otto", title);
  await expect(transcript(page)).toContainText("The slow command finished.", { timeout: 30_000 });
  await expect(approvalCard(page)).toHaveCount(1);
  await expect(approvalCard(page).locator(".tag")).toHaveText("Allowed once");
  await expect.poll(async () => (await follows()).slice(-2)).toEqual(["action", "approval"]);
  await expect(page.getByTestId("run-line").last().locator("summary")).toHaveAccessibleName(
    /^Worked( for \d+s)? · 1 action$/,
  );
  await rawHas();
  await shot(approvalCard(page), "approval-kept");
});

test("F-057 F-295: a task whose run completed with a failed action shows the failed mark and says done with failures until it is opened", async () => {
  test.setTimeout(300_000);
  const { title } = await hostTask("pip", "Fails", "#tool-fail");
  // Another task on screen, so the failing one is not opened when its run ends.
  const other = await hostTask("pip", "Elsewhere", "reply with a note");
  await openTask(page, "Pip", other.title);
  const row = page
    .getByRole("list", { name: "Pip's tasks" })
    .getByTestId("task")
    .filter({ hasText: title });
  await expect(row).toHaveAttribute("data-state", "done-with-failures", { timeout: 60_000 });
  await expect(row.locator(".glyph")).toHaveAttribute("data-state", "failed");
  await expect(row).toHaveAccessibleName(/, done with failures$/);
  await shot(page.getByTestId("bot-list"), "rail-done-with-failures");
  // Opened, the mark goes.
  await row.click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible({
    timeout: 20_000,
  });
  await expect(row.locator(".glyph")).toHaveCount(0);
  await expect(row).toHaveAccessibleName(/, done$/);
});

/** A paired client that may raise and answer questions: the gateway sends questions to all such. */
let asker: OperatorSession | null = null;
async function questionsClient(): Promise<OperatorSession> {
  asker ??= await openOperator(
    openInstance(INSTANCE),
    "Clawtrate approvals check (questions)",
    ["operator.read", "operator.write", "operator.questions"],
    ["tool-events"],
  );
  return asker;
}

test("F-112: a question record outside the ordinary subset is shown readable, with its raw record, and cannot be answered here", async () => {
  test.setTimeout(300_000);
  const { title, key } = await hostTask("pip", "Form", "reply with a note");
  await openTask(page, "Pip", title);
  await expect(page.getByTestId("status-line")).toHaveCount(0, { timeout: 60_000 });
  // A form, which the card's ordinary subset leaves out, raised on this task.
  const op = await questionsClient();
  const { id } = await op.request<{ id: string }>("question.request", {
    sessionKey: key,
    agentId: "pip",
    timeoutMs: 120_000,
    questions: [
      {
        questionId: "details",
        header: "Details",
        question: "Fill in your delivery details.",
        options: [{ label: "Home" }, { label: "Work" }],
        presentation: "form",
      },
    ],
  });
  const card = page.getByTestId("question-card").last();
  await expect(
    card.getByRole("heading", { name: "Pip asked something this app can't answer yet" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText("Fill in your delivery details.")).toBeVisible();
  await expect(card.getByText("Options: Home · Work")).toBeVisible();
  await expect(card.getByRole("radio")).toHaveCount(0);
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  await expect(card.getByRole("textbox")).toHaveCount(0);
  await expect(card.getByRole("button", { name: /Dismiss/ })).toHaveCount(0);
  await card.getByRole("button", { name: "Raw" }).click();
  const raw = card.getByRole("region", { name: "What the gateway sent" });
  await expect(raw).toContainText('"presentation": "form"');
  await expect(raw).toContainText(id);
  await shot(card, "question-unanswerable");
  // Nothing was sent for it from here: the gateway still lists it pending.
  const pending = await op.request<{ questions: Array<{ id: string; status: string }> }>(
    "question.list",
    {},
  );
  expect(pending.questions.find((each) => each.id === id)?.status).toBe("pending");
  await op.request("question.resolve", { id, answers: { answers: { details: ["Home"] } } });
  await expect(card).not.toHaveAttribute("data-state", "unanswerable", { timeout: 30_000 });
});

test("F-169: a message sent while an approval is pending is accepted as a steer into the run and leaves the card pending; Stop aborts that run, and the card closes as Cancelled once the gateway cancels that run's request", async () => {
  test.setTimeout(300_000);
  const { title, key } = await hostTask("otto", "Steer and stop", "#sleep 9");
  const op = await adminClient();
  await op.request("sessions.messages.subscribe", { key });
  const from = op.lastSeq;
  await openTask(page, "Otto", title);
  const card = approvalCard(page);
  await pendingRequest(key);
  const asked = (
    await op.request<Array<{ id: string; request: { sessionKey?: string; runId?: string } }>>(
      "exec.approval.list",
      {},
    )
  ).find((each) => each.request.sessionKey === key)!;
  const runId = asked.request.runId!;
  expect(runId).toBeTruthy();
  const lifecycle = (phase: string) =>
    op.events.filter((event) => {
      const payload = event.payload as {
        stream?: string;
        runId?: string;
        data?: { phase?: string };
      };
      return (
        event.seq > from &&
        event.event === "agent" &&
        payload.stream === "lifecycle" &&
        payload.data?.phase === phase &&
        (payload as { sessionKey?: string }).sessionKey === key
      );
    });
  const composer = page.getByTestId("composer-input");
  await composer.fill("Keep going once you can.");
  await page.keyboard.press("Enter");
  await expect(transcript(page)).toContainText("Keep going once you can.", { timeout: 30_000 });
  // The message joined the run: the request is still pending, here and on the gateway.
  await expect(card).toHaveAttribute("data-state", "pending");
  const listed = async () =>
    (
      await (
        await adminClient()
      ).request<Array<{ id: string; request: { sessionKey?: string } }>>("exec.approval.list", {})
    ).find((each) => each.request.sessionKey === key)?.id ?? null;
  const id = await listed();
  expect(id).not.toBeNull();
  // The steer was accepted into the run that asked: the gateway started no run of its own for it.
  expect(
    new Set(lifecycle("start").map((event) => (event.payload as { runId?: string }).runId)),
  ).toEqual(new Set([runId]));
  // Stop: the abort names that run, and the card closes only when the gateway has cancelled
  // that same run's request.
  await page.getByRole("button", { name: "Stop Otto" }).click();
  await expect(card.locator(".tag")).toHaveText("Cancelled", { timeout: 60_000 });
  const ended = lifecycle("end").concat(lifecycle("error"));
  expect(ended.map((event) => (event.payload as { runId?: string }).runId)).toEqual([runId]);
  expect((ended[0]!.payload as { data?: { aborted?: boolean } }).data?.aborted).toBe(true);
  await card.locator("summary").first().click();
  await expect(card.locator(".request-resolved-body > p").first()).toHaveText(
    /^The gateway cancelled it at \d+:\d\d [AP]M, when its run was stopped\.$/,
  );
  await expect(card).not.toContainText(/can run now|was not run|You stopped/);
  // The request the gateway cancelled is the one it listed for that run (its snapshot names
  // the session, not the run).
  expect(id).toBe(asked.id);
  const snapshot = await op.request<Record<string, unknown>>("approval.get", { id });
  const record = (snapshot.approval ?? snapshot) as {
    status?: string;
    reason?: string;
    source?: { sessionKey?: string };
  };
  expect([record.status, record.reason, record.source?.sessionKey]).toEqual([
    "cancelled",
    "run-aborted",
    key,
  ]);
  await expect.poll(listed).toBeNull();
  // The stop note's Raw holds the frame that ended the run, as the engine took it: the chat's
  // abort or the lifecycle end, whichever came first.
  const note = page.getByTestId("stop-note").last();
  await note.getByRole("button", { name: "Raw" }).click();
  await expect(note.getByRole("region", { name: "What the gateway sent" })).toContainText(
    /The event, as the gateway sent it \((agent \(lifecycle end\)|chat \(aborted\))\)/,
  );
});

test("F-094: a failed turn's card, its run line and a line the gateway wrote itself each have Raw with the event or row behind them", async () => {
  test.setTimeout(300_000);
  const { title, key } = await hostTask("pip", "Raw lines", "#read #model-error");
  await openTask(page, "Pip", title);
  const raw = (target: ReturnType<Page["locator"]>) =>
    target.getByRole("region", { name: "What the gateway sent" });
  const error = page.getByTestId("turn-error").last();
  await expect(error).toBeVisible({ timeout: 60_000 });
  await error.getByRole("button", { name: "Raw" }).click();
  await expect(raw(error)).toContainText(
    /The event, as the gateway sent it \((agent \(lifecycle error\)|chat \(error\))\)/,
  );
  const line = page.getByTestId("run-line").last();
  await line.locator("summary").click();
  await line.getByRole("button", { name: "Raw" }).click();
  await expect(raw(line)).toContainText("(agent (lifecycle start))");
  await expect(raw(line)).toContainText(key);
  await shot(page.getByTestId("transcript"), "raw-run-line");
  // Read anew from history once the page reloads: the run line shows the history row its end
  // was read from, said to be that, and no event this host did not receive again.
  await page.reload();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
  await openTask(page, "Pip", title);
  const reread = page.getByTestId("run-line").last();
  await reread.locator("summary").click();
  await reread.getByRole("button", { name: "Raw" }).click();
  await expect(raw(reread)).toContainText(
    "The row its end was read from, as the gateway's history keeps it (chat.history)",
  );
  await expect(raw(reread)).not.toContainText("(agent (lifecycle");
  // The gateway's own boundary row after a reset is a line of its own, with that row in Raw.
  await (await adminClient()).request("sessions.reset", { key });
  await page.reload();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
  await openTask(page, "Pip", title);
  const system = page.locator(".event-row").filter({ hasText: "Session was reset" }).last();
  await expect(system).toBeVisible({ timeout: 30_000 });
  await system.getByRole("button", { name: "Raw" }).click();
  await expect(raw(system)).toContainText("The history row, as the gateway sent it (chat.history)");
  await expect(raw(system)).toContainText('"reset"');
});

/**
 * Admin access for a page's device: only an admin connection sees a request another client
 * registered (`exec.approval.request`), as these last checks do. Asked once per device, after
 * every check that relies on the approvals tier alone.
 */
async function adminAccess(on: Page): Promise<void> {
  await on.evaluate(() => {
    const socket = new WebSocket(`ws://${location.host}/bridge`);
    (window as unknown as { adminSocket?: WebSocket }).adminSocket = socket;
    socket.onmessage = (event) => {
      if ((JSON.parse(String(event.data)) as { type: string }).type === "hello")
        socket.send(
          JSON.stringify({
            type: "command",
            id: "admin",
            command: { type: "requestAccess", tier: "admin" },
          }),
        );
    };
  });
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  await on.keyboard.press("ControlOrMeta+,");
  const dialog = on.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Gateway", exact: true }).click();
  await expect(dialog.getByTestId("granted-scopes")).toContainText("operator.admin", {
    timeout: 30_000,
  });
  await on.keyboard.press("Escape");
  await on.evaluate(() => (window as unknown as { adminSocket?: WebSocket }).adminSocket?.close());
}
let pageIsAdmin = false;

/** A `#slow` run started by the admin client in a task, followed by its events; its run id. */
async function slowRun(key: string, seconds: number): Promise<string> {
  const op = await adminClient();
  await op.request("sessions.messages.subscribe", { key });
  // The task's first run has replied and the gateway holds nothing running in it: a send
  // into a working task would join that run, and this run would never start of its own.
  await expect
    .poll(
      async () => {
        const replied = (await historyOf(key)).some((row) => row.role === "assistant");
        const { session } = await op.request<{ session?: Record<string, unknown> | null }>(
          "sessions.describe",
          { key },
        );
        const active =
          session?.hasActiveRun === true ||
          session?.status === "running" ||
          session?.status === "queued";
        return replied && !active;
      },
      { timeout: 90_000, intervals: [1000] },
    )
    .toBe(true);
  const runId = randomUUID();
  await op.request("chat.send", {
    sessionKey: key,
    message: `#slow ${seconds}`,
    idempotencyKey: runId,
  });
  await op.waitFor("the slow run's start", (event) => isLifecycle(event, runId, "start"), 60_000);
  return runId;
}

function isLifecycle(event: { event: string; payload: unknown }, runId: string, phase: string) {
  const payload = event.payload as { stream?: string; runId?: string; data?: { phase?: string } };
  return (
    event.event === "agent" &&
    payload.stream === "lifecycle" &&
    payload.runId === runId &&
    payload.data?.phase === phase
  );
}

/** A request the gateway registers and analyses itself, bound to a run; it starts no program. */
async function registerRequest(
  key: string,
  runId: string,
  command: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const registered = await (
    await adminClient()
  ).request<{ id: string }>("exec.approval.request", {
    command,
    host: "gateway",
    sessionKey: key,
    agentId: "otto",
    runId,
    timeoutMs: 120_000,
    twoPhase: true,
    security: "allowlist",
    ask: "on-miss",
    ...extra,
  });
  return registered.id;
}

/** The gateway's record of a request: its status, decision and who decided. */
async function approvalRecord(id: string): Promise<Record<string, unknown>> {
  const answer = await (
    await adminClient()
  ).request<Record<string, unknown>>("approval.get", {
    id,
  });
  return (answer.approval ?? answer) as Record<string, unknown>;
}

const clockPattern = String.raw`\d+:\d\d [AP]M`;
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("F-418: a run that ends while its approval is pending: the card says so and stays answerable; it closes only with the gateway's own outcome and who decided, the same after a reload and on another device, and Clawtrate answers nothing", async ({
  browser,
}) => {
  test.setTimeout(420_000);
  if (!pageIsAdmin) await adminAccess(page);
  pageIsAdmin = true;
  const { title, key } = await hostTask("otto", "Run end", "reply with a note");
  await openTask(page, "Otto", title);
  await expect(page.getByTestId("status-line")).toHaveCount(0, { timeout: 60_000 });
  const runId = await slowRun(key, 14);
  const id = await registerRequest(key, runId, "sleep 2");
  const card = approvalCard(page);
  await expect(card).toHaveAttribute("data-state", "pending", { timeout: 30_000 });
  await expect(card.locator(".request-ended")).toHaveCount(0);
  // The run ends on its own; the gateway still holds the request.
  await (
    await adminClient()
  ).waitFor("the run's end", (event) => isLifecycle(event, runId, "end"), 60_000);
  await expect(card.locator(".request-ended")).toHaveText(
    "Otto's run has ended. The last gateway record shows this request pending.",
    { timeout: 30_000 },
  );
  for (const name of ["Allow once", "Deny"])
    await expect(card.getByRole("button", { name, exact: true })).toBeVisible();
  expect((await approvalRecord(id)).status).toBe("pending");
  await shot(card, "approval-run-ended");

  // Another device opens the task while the gateway holds the request: the same.
  const other = await pairedPage(browser, await startOwnHost());
  try {
    await requestAccess(other);
    await adminAccess(other);
    await openTask(other, "Otto", title);
    await expect(approvalCard(other)).toHaveAttribute("data-state", "pending", { timeout: 30_000 });

    // Decided by another client: both devices close the card with the gateway's own outcome
    // and the decider the gateway names, and nothing of Clawtrate's is sent.
    await (await adminClient()).request("exec.approval.resolve", { id, decision: "deny" });
    const settled = await approvalRecord(id);
    expect([settled.status, settled.decision]).toEqual(["denied", "deny"]);
    const decider =
      (settled.resolvedBy as string | undefined) ??
      ((settled.resolver as { id?: string } | undefined)?.id as string | undefined);
    const sentence = new RegExp(
      `^Denied${decider ? ` by ${escaped(decider)}` : ""} at ${clockPattern}\\.$`,
    );
    for (const on of [page, other]) {
      const settledCard = approvalCard(on);
      await expect(settledCard.locator(".tag")).toHaveText("Denied", { timeout: 30_000 });
      await settledCard.locator("summary").first().click();
      await expect(settledCard.locator(".request-resolved-body > p").first()).toHaveText(sentence);
    }
    // The same once the page reloads and the task is read again.
    await page.reload();
    await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
    await openTask(page, "Otto", title);
    await expect(approvalCard(page).locator(".tag")).toHaveText("Denied", { timeout: 30_000 });
    await approvalCard(page).locator("summary").first().click();
    await expect(approvalCard(page).locator(".request-resolved-body > p").first()).toHaveText(
      sentence,
    );
  } finally {
    await other.context().close();
  }
});

test("F-171: every kind of warning the gateway's analysis attaches reaches the card in its words, with the warning mark, and a request's warning text before them", async () => {
  test.setTimeout(420_000);
  if (!pageIsAdmin) await adminAccess(page);
  pageIsAdmin = true;
  const { title, key } = await hostTask("otto", "Warnings", "reply with a note");
  await openTask(page, "Otto", title);
  await expect(page.getByTestId("status-line")).toHaveCount(0, { timeout: 60_000 });
  const runId = await slowRun(key, 90);
  // One command for each kind OpenClaw 2026.10.6's analysis can find in a gateway request.
  const commands: Array<[string, string, Record<string, unknown>?]> = [
    ["inline-eval", "python3 -c 'print(1)'"],
    ["shell-wrapper", "bash -c 'ls'"],
    ["command-carrier", "sudo ls"],
    ["dynamic-argument", "ls $HOME"],
    ["eval", "eval ls"],
    ["source", "source ./env.sh"],
    ["alias", "alias ll=ls"],
    ["shell-wrapper-through-carrier", "env bash -c 'ls'"],
    ["line-continuation", "ls \\\n -la"],
    ["function-definition", "f() { ls; }"],
    ["command-substitution", "echo $(date)"],
    ["process-substitution", "diff <(ls a) <(ls b)"],
    ["here-string", "cat <<< hi"],
    ["redirect", "ls > out.txt"],
    ["syntax-error", "ls ("],
    ["dynamic-executable", "$CMD ls"],
    [
      "heredoc",
      "cat <<EOF\nhi\nEOF",
      {
        warningText:
          "Warning: heredoc execution requires reviewer or explicit approval in allowlist mode.",
      },
    ],
  ];
  const ids: string[] = [];
  try {
    for (const [kind, command, extra] of commands) {
      const id = await registerRequest(key, runId, command, extra);
      ids.push(id);
      // One pending at a time: each is settled once checked, under the task's pending bound.
      const pendingCards = page.locator("[data-testid='approval-card'][data-state='pending']");
      await expect(pendingCards).toHaveCount(1, { timeout: 30_000 });
      const listed = (
        await (
          await adminClient()
        ).request<Array<{ id: string; request: Record<string, unknown> }>>("exec.approval.list", {})
      ).find((each) => each.id === id)!;
      const expected = gatewayWarnings(listed.request);
      // The gateway found the kind, and says so in its own words.
      expect(
        (listed.request.commandAnalysis as { riskKinds?: string[] }).riskKinds,
        kind,
      ).toContain(kind);
      const card = pendingCards.first();
      const lines = card.locator(".request-warnings li");
      await expect(lines, kind).toHaveText(expected);
      for (const line of await lines.all()) await expect(line.locator("svg")).toHaveCount(1);
      if (extra?.warningText) {
        expect(expected[0]).toBe(extra.warningText);
        await shot(card, "approval-warning-text");
      }
      await (await adminClient()).request("exec.approval.resolve", { id, decision: "deny" });
      await expect(pendingCards).toHaveCount(0, { timeout: 30_000 });
    }
  } finally {
    const op = await adminClient();
    for (const id of ids)
      await op.request("exec.approval.resolve", { id, decision: "deny" }).catch(() => undefined);
    await op.request("chat.abort", { sessionKey: key, runId }).catch(() => undefined);
  }
});
