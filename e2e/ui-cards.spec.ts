// The conversation cards against a real development gateway: approvals,
// questions, messages between bots and tool-server calls, driven through the
// scenarios and watched by the interface on a preview host of its own.
//
// Runs that ask for an approval or a question start from the host's own
// device, with the bridge's createTask command (the composer's own path; the
// composer itself is not built yet): the gateway shows a pending exec approval
// only to the device whose run asked for it (`isApprovalRecordVisibleToClient`
// in OpenClaw 2026.10.6's approval-record-lookup), never to another client
// with the same scopes. Messages between bots and tool-server calls are sent by
// a paired test client with the official gateway client, as the scenario check
// sends them. Decisions and answers are made by clicking the cards.
//
// The commands it asks approval for (`sleep 2`, 3, 4 and 6) are its own: the
// scenario check saves an "Always allow" rule for `ls` and uses `sleep 1` and
// `sleep 5`, and this spec saves one for `sleep 6`.
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpToolMap } from "../packages/core/src/cards.ts";
import { MAX_MCP_TOOLS } from "../packages/core/src/state-bounds.ts";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { openCheckClients, type ClientName } from "../tools/dev-gateway/src/scenario-check.ts";
import { devGateway, startHost, stopChild } from "./global-setup.ts";
import { leaveIdle } from "./teardown.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
/** Where to save screenshots of each card on a real gateway, when set. */
const SHOTS = process.env.CLAWTRATE_CARD_SHOTS;
const STAMP = Date.now().toString(36);

// Not serial: one check failing on timing does not keep the rest from running. Each check
// stands alone: it makes the tasks, approvals and questions it reads, and reads no other
// check's. A new worker, after a failure, pairs fresh hosts in beforeAll.

type Host = { child: ChildProcess; url: string; data: string };
const hosts: Host[] = [];
let clients: Record<ClientName, OperatorSession>;
/** The interface with interactive access, and one that stays read-only. */
let page: Page;
let reader: Page;

async function startOwnHost(): Promise<Host> {
  const data = mkdtempSync(join(tmpdir(), "clawtrate-cards-"));
  const started = startHost(INSTANCE, STATIC, data);
  started.gated.release();
  const host = { child: started.host, url: await started.url, data };
  hosts.push(host);
  return host;
}

/** The interface on a host, paired with the gateway as a new device (operator.read). */
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

/** One bridge command, over the host's own bridge socket, as a viewer of `open` if given. */
async function hostCommand<T = unknown>(
  on: Page,
  command: Record<string, unknown>,
  open?: string,
): Promise<T> {
  return on.evaluate(
    ({ command, open }) =>
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
            if (open)
              socket.send(
                JSON.stringify({
                  type: "command",
                  id: "open",
                  command: { type: "openSession", key: open },
                }),
              );
            else socket.send(JSON.stringify({ type: "command", id: "do", command }));
          } else if (message.id === "open") {
            socket.send(JSON.stringify({ type: "command", id: "do", command }));
          } else if (message.id === "do") {
            socket.close();
            if (message.ok) resolve(message.value as T);
            else reject(new Error(message.error));
          }
        };
        socket.onerror = () => reject(new Error("bridge socket error"));
      }),
    { command, open },
  );
}

/**
 * Ask for interactive access as the access bar will (it comes with the
 * composer): the bridge's requestAccess, from a viewer that stays until the
 * owner has approved, since a viewer that goes takes its requests with it.
 */
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
  await expect(dialog.getByTestId("granted-scopes")).toContainText("operator.approvals", {
    timeout: 30_000,
  });
  await expect(dialog.getByTestId("granted-scopes")).toContainText("operator.questions");
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
  // The task's history read decides the heading: seconds on a loaded machine.
  await expect(on.getByRole("heading", { level: 1, name: title })).toBeVisible({
    timeout: 20_000,
  });
}

/**
 * A bot-to-bot send's identities, from the sending run's own events on the test client: the
 * `sessions_send` call id, and the recipient run its result names (in its details, or, where
 * those are empty, in its text object).
 */
function sendFacts(runId: string): { toolCallId: string; recipientRunId: string } {
  const result = clients.plain
    .runEvents(runId)
    .map((e) => e.payload as { stream?: string; data?: Record<string, unknown> })
    .find(
      (p) => p.stream === "tool" && p.data?.phase === "result" && p.data?.name === "sessions_send",
    );
  const sentResult = (result?.data?.result ?? {}) as {
    details?: { runId?: string };
    content?: Array<{ text?: string }>;
  };
  let fromText: string | undefined;
  try {
    fromText = (JSON.parse(sentResult.content?.[0]?.text ?? "{}") as { runId?: string }).runId;
  } catch {
    fromText = undefined;
  }
  return {
    toolCallId: typeof result?.data?.toolCallId === "string" ? result.data.toolCallId : "",
    recipientRunId: sentResult.details?.runId ?? fromText ?? "",
  };
}

/**
 * A new task the test clients follow, named for what it checks; its title is the key's last
 * part. New on every call, so a repeated check never meets an earlier one's task.
 */
let clientTasks = 0;
async function clientTask(botId: string, slug: string): Promise<{ key: string; title: string }> {
  clientTasks += 1;
  // The count before the stamp: no title is part of another's, as a row is found by its text.
  const title = `${slug}-${clientTasks}-${STAMP}`;
  const key = `agent:${botId}:${title}`;
  for (const op of Object.values(clients)) {
    await op.request("sessions.messages.subscribe", { key });
  }
  return { key, title };
}

/**
 * A new task started by the host's own device, labelled: its title and key. New on every call,
 * so a repeated check never meets an earlier one's task.
 */
let hostTasks = 0;
async function hostTask(
  botId: string,
  label: string,
  text: string,
): Promise<{ title: string; key: string }> {
  hostTasks += 1;
  // The count before the stamp: no title is part of another's, as a row is found by its text.
  const title = `${label} ${hostTasks} ${STAMP}`;
  const { key } = await hostCommand<{ key: string }>(page, {
    type: "createTask",
    botId,
    text,
    label: title,
  });
  return { title, key };
}

/** Reload the page: the host releases the task and reads it again from the gateway's history. */
async function reload(on: Page, bot: string, title: string): Promise<void> {
  await on.reload();
  await expect(on.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
  await openTask(on, bot, title);
}

async function shot(target: Locator | Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await target.screenshot({ path: join(SHOTS, `real-${name}.png`) });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  expect(INSTANCE, "a named instance").toMatch(/^[a-z0-9-]+$/);
  const inst = openInstance(INSTANCE);
  clients = await openCheckClients((name, scopes, caps) => openOperator(inst, name, scopes, caps));
  await clients.plain.request("sessions.subscribe", {});
  page = await pairedPage(browser, await startOwnHost());
  await requestAccess(page);
  reader = await pairedPage(browser, await startOwnHost());
});

/** When the running check began: a check that fails leaves nothing it started after this. */
let checkStarted = 0;
test.beforeEach(() => {
  checkStarted = Date.now();
});
// Playwright reads its fixtures from the first argument's pattern; this hook needs none.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  test.setTimeout(testInfo.timeout + 120_000);
  if (testInfo.status === testInfo.expectedStatus) return;
  // The admin client sees the approvals of every device's runs, the host's included.
  const op = await adminClient();
  await leaveIdle((method, params) => op.request(method, params), checkStarted);
});

test.afterAll(async () => {
  for (const op of Object.values(clients ?? {})) await op.close();
  await admin?.close();
  for (const host of hosts) {
    await stopChild(host.child);
    rmSync(host.data, { recursive: true, force: true });
  }
});

const card = (on: Page, testId: string) => on.getByTestId(testId);
const transcript = (on: Page) => on.getByTestId("transcript");

/**
 * Another client that may settle this host's approvals: only an admin
 * connection sees an approval another device's run asked for.
 */
let admin: OperatorSession | null = null;
async function adminClient(): Promise<OperatorSession> {
  admin ??= await openOperator(
    openInstance(INSTANCE),
    "Clawtrate cards check (admin)",
    ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
    ["tool-events", "approvals", "exec-approvals"],
  );
  return admin;
}

/** The id of a task's pending exec approval, as the admin client sees it. */
async function pendingApprovalId(key: string): Promise<string> {
  const op = await adminClient();
  let id = "";
  await expect
    .poll(
      async () => {
        const list = await op.request<Array<{ id: string; request: { sessionKey?: string } }>>(
          "exec.approval.list",
          {},
        );
        id = list.find((each) => each.request.sessionKey === key)?.id ?? "";
        return id;
      },
      { timeout: 30_000 },
    )
    .not.toBe("");
  return id;
}

test.describe("tasks this app creates", () => {
  test("each is let go once its first message is confirmed and its run has ended, so more than eight can be made one after another", async () => {
    test.setTimeout(180_000);
    // The gateway records the message's row as `${runId}:user`; until that row confirms the
    // message, the host keeps the task followed, and it follows at most eight.
    for (let i = 1; i <= 9; i += 1) {
      const { key } = await hostTask("pip", `Created ${i}`, "reply with a note");
      await clients.plain.request("sessions.messages.subscribe", { key });
      await expect
        .poll(
          async () => {
            const history = await clients.plain.request<{ messages: unknown[] }>("chat.history", {
              sessionKey: key,
              limit: 10,
            });
            return history.messages.length;
          },
          { timeout: 30_000 },
        )
        .toBeGreaterThan(1);
    }
  });
});

test.describe("approval cards on a real gateway", () => {
  test("F-163: a command that needs approval, allowed once: the card, the decision, Raw, and read again from history on a host that never saw it", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const { title } = await hostTask("otto", "Approve once", "#sleep 2");
    await openTask(page, "Otto", title);
    const approval = card(page, "approval-card");
    await expect(approval).toHaveCount(1, { timeout: 30_000 });
    await expect(approval.locator(".request-title")).toHaveText("Otto wants to run a command");
    await expect(approval.locator(".tag")).toHaveText("Needs approval");
    await expect(approval).toContainText("Run sleep 2 on the gateway's machine.");
    for (const name of ["Allow once", "Always allow…", "Deny"]) {
      await expect(approval.getByRole("button", { name })).toBeVisible();
    }
    // The gateway's expiry is 30 minutes from the request; the card counts down from then, and
    // on a loaded machine a minute can pass before the card is first drawn.
    await expect(approval).toContainText(/Expires in (29|30) minutes/);
    await shot(approval, "approval-pending");
    // On a read-only connection the gateway sends no pending approvals: none is shown.
    await openTask(reader, "Otto", title);
    await expect(transcript(reader)).toContainText("#sleep 2", { timeout: 30_000 });
    await expect(card(reader, "approval-card")).toHaveCount(0);

    await approval.getByRole("button", { name: "Allow once" }).click();
    await expect(approval.locator(".tag")).toHaveText("Allowed once", { timeout: 30_000 });
    await expect(transcript(page)).toContainText("The slow command finished.", {
      timeout: 30_000,
    });
    await approval.locator("summary").first().click();
    await approval.getByRole("button", { name: "Raw" }).click();
    const raw = approval.getByRole("region", { name: "What the gateway sent" });
    await expect(raw.locator(".code-label")).toContainText([
      "The request record, as the gateway sent it (exec.approval.requested or exec.approval.list)",
    ]);
    await expect(raw).toContainText("What this app sent (exec.approval.resolve)");
    await expect(raw).toContainText('"decision": "allow-once"');
    await expect(raw).toContainText("(exec.approval.resolved)");
    await shot(approval, "approval-allowed-once");

    // Read again from history, which keeps no approval record (the gateway lists only pending
    // requests). A reload of this page would not show that: nothing makes this host let the task
    // go, and another viewer can keep it. A host of its own never saw the approval live.
    const fresh = await pairedPage(browser, await startOwnHost());
    await openTask(fresh, "Otto", title);
    await expect(transcript(fresh)).toContainText("The slow command finished.", {
      timeout: 30_000,
    });
    await expect(card(fresh, "approval-card")).toHaveCount(0);
    await fresh.context().close();
  });

  test("F-163 F-165: denied: the card says the command was not run", async () => {
    const { title } = await hostTask("otto", "Approve deny", "#sleep 3");
    await openTask(page, "Otto", title);
    const approval = card(page, "approval-card");
    await expect(approval).toHaveCount(1, { timeout: 30_000 });
    await approval.getByRole("button", { name: "Deny" }).click();
    await expect(approval.locator(".tag")).toHaveText("Denied", { timeout: 30_000 });
    await approval.locator("summary").first().click();
    await expect(approval).toContainText("Denied. The command was not run.");
    await shot(approval, "approval-denied");
  });

  test("F-329: a request that offers no reusable rule has no Always allow", async () => {
    const { title } = await hostTask("otto", "Approve each", "run a command I approve every time");
    await openTask(page, "Otto", title);
    const approval = card(page, "approval-card");
    await expect(approval).toHaveCount(1, { timeout: 30_000 });
    // "Allow" in place of "Allow once", Deny still offered, no Always allow.
    await expect(approval.locator('.request-actions[data-row="main"] button')).toHaveText([
      "Allow",
      "Deny",
    ]);
    await expect(approval.getByRole("button", { name: "Always allow…" })).toHaveCount(0);
    await shot(approval, "approval-allow-only");
    await approval.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(approval.locator(".tag")).toHaveText("Allowed once", { timeout: 30_000 });
  });

  test("F-163 F-168: resolved by another client: the card shows how it ended and offers nothing", async () => {
    const { title, key } = await hostTask("otto", "Approve elsewhere", "#sleep 4");
    await openTask(page, "Otto", title);
    const approval = card(page, "approval-card");
    await expect(approval).toHaveCount(1, { timeout: 30_000 });
    const id = await pendingApprovalId(key);
    await (await adminClient()).request("exec.approval.resolve", { id, decision: "deny" });
    await expect(approval.locator(".tag")).toHaveText("Denied", { timeout: 30_000 });
    await expect(approval.getByRole("button", { name: "Allow once" })).toHaveCount(0);
    await approval.locator("summary").first().click();
    await shot(approval, "approval-resolved-elsewhere");
  });

  test("F-167: allowed always: the form, the saved rule, and the same command no longer asking", async () => {
    const { title } = await hostTask("otto", "Approve always", "#sleep 6");
    await openTask(page, "Otto", title);
    const approval = card(page, "approval-card");
    await expect(approval).toHaveCount(1, { timeout: 30_000 });
    await approval.getByRole("button", { name: "Always allow…" }).click();
    const form = approval.getByRole("group", { name: "Always allow" });
    await expect(form.locator("dd").first()).toHaveText("sleep 6");
    await shot(approval, "approval-always-form");
    await form.getByRole("button", { name: "Allow and save" }).click();
    await expect(approval.locator(".tag")).toHaveText("Always allowed", { timeout: 30_000 });
    await shot(approval, "approval-always-allowed");
    // The gateway keeps the rule: the same command in Otto's workspace runs without asking.
    const again = await hostTask("otto", "Approve saved", "#sleep 6");
    await openTask(page, "Otto", again.title);
    await expect(transcript(page)).toContainText("The slow command finished.", {
      timeout: 30_000,
    });
    await expect(card(page, "approval-card")).toHaveCount(0);
  });
});

test.describe("question cards on a real gateway", () => {
  const asked = async (label: string, text: string) => {
    const { title } = await hostTask("pip", label, text);
    await openTask(page, "Pip", title);
    const question = card(page, "question-card");
    await expect(question).toHaveCount(1, { timeout: 30_000 });
    await expect(question).toHaveAttribute("data-state", "pending");
    return { title, question };
  };

  test("F-112 F-113: one question with options, answered by choosing one; read-only and history", async () => {
    const { title, question } = await asked("Ask one", "ask me a question");
    await expect(question.locator(".request-title")).toHaveText(
      "Which route should I plan for Saturday?",
    );
    await expect(question.getByRole("radio")).toHaveText([
      /^ALake loop3 miles, mostly flat$/,
      /^BRidge trail6 miles, one steep climb$/,
      /^CTown walk$/,
    ]);
    await shot(question, "question-pending");
    // On a read-only connection the gateway sends no question events: none is shown.
    await openTask(reader, "Pip", title);
    await expect(transcript(reader)).toContainText("ask me a question");
    await expect(card(reader, "question-card")).toHaveCount(0);

    await question.getByRole("radio", { name: /Lake loop/ }).click();
    await expect(question).toHaveAttribute("data-state", "answered", { timeout: 30_000 });
    await expect(question.locator(".answer")).toHaveText(["ALake loop"]);
    await expect(transcript(page)).toContainText("route: Lake loop", { timeout: 30_000 });
    await shot(question, "question-answered");
  });

  test("F-114 F-303: several questions in one card, answered together", async () => {
    const { question } = await asked("Ask many", "ask me several questions");
    await expect(question.locator(".request-title")).toHaveText("Pip has 3 questions");
    const items = question.locator(".question");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText("Which route should I plan for Saturday?");
    await expect(items.nth(1)).toContainText("When should we leave?");
    await expect(items.nth(2)).toContainText("Should I book lunch?");
    await shot(question, "question-several");
    await items
      .nth(0)
      .getByRole("radio", { name: /Ridge trail/ })
      .click();
    await items.nth(1).getByRole("radio", { name: /9:30/ }).click();
    await items.nth(2).getByRole("radio", { name: /^No/ }).click();
    await question.getByRole("button", { name: "Send answers" }).click();
    await expect(question).toHaveAttribute("data-state", "answered", { timeout: 30_000 });
    await expect(question.locator(".answer")).toHaveText(["BRidge trail", "B9:30", "BNo"]);
    await expect(transcript(page)).toContainText("start_time: 9:30", { timeout: 30_000 });
  });

  test("F-114: several answers to one question", async () => {
    const { question } = await asked("Ask multi", "let me pick several");
    await expect(question.getByText("Choose all that apply.")).toBeVisible();
    await question.getByRole("checkbox", { name: /Rain shell/ }).click();
    await question.getByRole("checkbox", { name: /Map/ }).click();
    await shot(question, "question-multi");
    await question.getByRole("button", { name: "Send answer" }).click();
    await expect(question).toHaveAttribute("data-state", "answered", { timeout: 30_000 });
    await expect(question.locator(".answer")).toHaveText(["ARain shell", "DMap"]);
    await expect(transcript(page)).toContainText("packing: Rain shell, Map", {
      timeout: 30_000,
    });
  });

  test("F-303: a typed answer is sent as typed", async () => {
    const { question } = await asked("Ask text", "ask me to type an answer");
    await question.getByPlaceholder("Type your own answer").fill("Coast weekend");
    await question.getByPlaceholder("Type your own answer").press("Enter");
    await expect(question).toHaveAttribute("data-state", "answered", { timeout: 30_000 });
    await expect(question.locator(".answer")).toHaveText(["Coast weekend"]);
    await expect(transcript(page)).toContainText("trip_name: Coast weekend", {
      timeout: 30_000,
    });
    await shot(question, "question-typed");
  });

  test("F-302: dismissed: no answer is sent and the bot carries on", async () => {
    const { question } = await asked("Ask dismiss", "ask me a question");
    await question.getByRole("button", { name: "Dismiss Pip's question" }).click();
    await expect(question.locator(".answer")).toHaveText(["Dismissed"], { timeout: 30_000 });
    // No answer was the last pending card's: the run goes on and ends.
    await expect(page.getByTestId("live-turn")).toHaveCount(0, { timeout: 30_000 });
    await shot(question, "question-dismissed");
  });
});

test.describe("Messaged cards on a real gateway", () => {
  /** A message from Pip, sent by a test client; the page and the read-only page watch it. */
  const sent = async (slug: string, directive: string) => {
    const t = await clientTask("pip", slug);
    const run = await clients.plain.send(t.key, directive);
    return { ...t, runId: String(run.runId) };
  };
  const state = (on: Page) => card(on, "messaged-card").locator("summary .state");

  test("F-119 F-121: answered in the same call: Replied, live, read-only and from history", async () => {
    const t = await sent("message", "#message");
    await clients.plain.terminal(t.runId);
    await openTask(page, "Pip", t.title);
    const messaged = card(page, "messaged-card");
    await expect(messaged.locator(".messaged-who")).toContainText("Marlow");
    await expect(state(page)).toHaveText("Replied");
    await shot(messaged, "messaged-replied");
    await openTask(reader, "Pip", t.title);
    await expect(state(reader)).toHaveText("Replied");
    // Read again from history, where the send's status and reply are only in its text.
    await reload(page, "Pip", t.title);
    await expect(state(page)).toHaveText("Replied");
    await reload(reader, "Pip", t.title);
    await expect(state(reader)).toHaveText("Replied");
  });

  test("F-122 F-434: a failing recipient: Failed, live and from history", async () => {
    const t = await sent("message-fail", "#message-fail");
    await clients.plain.terminal(t.runId);
    await openTask(page, "Pip", t.title);
    await expect(state(page)).toHaveText("Failed");
    await shot(card(page, "messaged-card"), "messaged-failed");
    await reload(page, "Pip", t.title);
    await expect(state(page)).toHaveText("Failed");
  });

  test("F-122 F-469: a slow recipient: Sent, Working while its run is seen, then No reply yet, in that order, and its reply arrives in the task", async () => {
    test.setTimeout(180_000);
    const t = await sent("message-slow", "#message-slow");
    await clients.plain.terminal(t.runId);
    const { recipientRunId } = sendFacts(t.runId);
    expect(recipientRunId).not.toBe("");
    await openTask(page, "Pip", t.title);
    // The host follows every session (sessions.subscribe), so the recipient's run reaches it
    // whenever its events come. Every state the card shows is recorded, in order, until the
    // gateway has ended that run and its reply has arrived.
    const states: string[] = [];
    const sample = async () => {
      const now = (await state(page).count()) > 0 ? await state(page).innerText() : "";
      if (now && states.at(-1) !== now) states.push(now);
    };
    const recipientEnded = async () =>
      (
        await clients.plain.request<{ inFlightRun?: { runId?: string } }>("chat.history", {
          sessionKey: "agent:marlow:main",
          limit: 1,
        })
      ).inFlightRun?.runId !== recipientRunId;
    const incoming = page.getByTestId("incoming-line").or(page.getByTestId("received-card"));
    // The card is first read while the gateway still has the recipient working: the slow
    // recipient runs for about twenty seconds after the send ends.
    await sample();
    expect(await recipientEnded(), "the recipient still works when the card is first read").toBe(
      false,
    );
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await sample();
      if ((await incoming.count()) === 1 && (await recipientEnded())) break;
      await page.waitForTimeout(250);
    }
    // Then a moment more: a state lost after the end would show here.
    for (let i = 0; i < 8; i += 1) {
      await sample();
      await page.waitForTimeout(250);
    }
    await expect(incoming).toContainText("Marlow");
    // In lifecycle order only: Sent before the run is seen, Working while it is, No reply yet
    // once it ended without a reply. Never back to an earlier state, and never Sent again once
    // the run was seen: what was known of the recipient is not lost. The host follows every
    // session from before the send, so it sees the recipient's run: once the gateway has ended
    // it, the card says so, and a card still Sent has lost it.
    // Before the send's own result is read the card can say Unknown: the gateway sends a run's
    // tool results to other clients as session.tool, and this host reads them from history.
    const order = ["Unknown", "Sent", "Working", "No reply yet"];
    expect(
      states.every((each) => order.includes(each)),
      states.join(" → "),
    ).toBe(true);
    expect(
      states.every((each, k) => k === 0 || order.indexOf(each) > order.indexOf(states[k - 1]!)),
      states.join(" → "),
    ).toBe(true);
    // It was seen working: the card said so before it said how the run ended.
    expect(states, states.join(" → ")).toContain("Working");
    expect(states.at(-1), states.join(" → ")).toBe("No reply yet");
    await shot(page, "messaged-slow-reply-arrived");
  });

  test("F-122: a recipient that asks its own user: its question is answered in its task", async () => {
    const t = await sent("message-ask", "#message-ask");
    await clients.plain.terminal(t.runId);
    const { recipientRunId } = sendFacts(t.runId);
    expect(recipientRunId).not.toBe("");
    await openTask(page, "Pip", t.title);
    // The host follows every session (sessions.subscribe), so whether it has seen Marlow's run
    // yet, and so whether the card says Sent or how that run stands, depends only on when its
    // events arrive. Each of these is right.
    await expect(state(page)).toHaveText(/^(Sent|Working|Recipient waiting|No reply yet)$/);
    await shot(card(page, "messaged-card"), "messaged-recipient-asked");
    await openTask(page, "Marlow", "Notes for Pip");
    // Marlow's main task is shared by every check that messages Marlow: this check's question is
    // the one the gateway lists for the recipient's run, and its card is found by that id.
    let questionId = "";
    await expect
      .poll(
        async () => {
          const listed = await clients.questions.request<{
            questions?: Array<{ id: string; runId?: string; status?: string }>;
          }>("question.list", {});
          questionId =
            listed.questions?.find(
              (each) => each.runId === recipientRunId && each.status === "pending",
            )?.id ?? "";
          return questionId;
        },
        { timeout: 60_000 },
      )
      .not.toBe("");
    const question = page.locator(`#card-question-${questionId.replace(/[^\w-]/g, "_")}`);
    await expect(question).toHaveAttribute("data-state", "pending", { timeout: 30_000 });
    await shot(question, "messaged-recipient-asks");
    await question.getByRole("radio", { name: /Town walk/ }).click();
    await expect(question).toHaveAttribute("data-state", "answered", { timeout: 30_000 });
    await openTask(page, "Pip", t.title);
    await expect(
      page.getByTestId("incoming-line").or(page.getByTestId("received-card")),
    ).toHaveCount(1, { timeout: 60_000 });
    await expect(state(page)).toHaveText(/^(Sent|No reply yet)$/, { timeout: 30_000 });
  });
});

test.describe("Messaged cards sent from this app on a real gateway", () => {
  // Sent by the host's own device, the recipient's run streams on the host's connection, so the
  // card follows it: the gateway sends it only to the connection whose run made the send.
  const seen = async (until: RegExp, timeoutMs = 60_000): Promise<string[]> => {
    const state = card(page, "messaged-card").locator("summary .state");
    const states: string[] = [];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const now = (await state.count()) > 0 ? await state.innerText() : "";
      if (now && states.at(-1) !== now) states.push(now);
      if (until.test(now)) return states;
      await page.waitForTimeout(250);
    }
    return states;
  };

  test("F-122 F-438 F-469: a slow recipient: Working while its run is seen, then No reply yet; its later reply arrives as a message from Marlow", async () => {
    const { title } = await hostTask("pip", "Slow from here", "message your slow partner");
    await openTask(page, "Pip", title);
    const states = await seen(/^No reply yet$/);
    expect(states).toContain("Working");
    expect(states.at(-1)).toBe("No reply yet");
    await shot(card(page, "messaged-card"), "messaged-no-reply-yet");
    // Nothing in the late reply names this message: it arrives on its own, and the card stays.
    await expect(
      page.getByTestId("incoming-line").or(page.getByTestId("received-card")),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(card(page, "messaged-card").locator("summary .state")).toHaveText("No reply yet");
  });

  test("F-122 F-434: a recipient whose run is stopped while it works: Recipient stopped", async () => {
    const { title } = await hostTask("pip", "Stopped from here", "message your slow partner");
    await openTask(page, "Pip", title);
    await seen(/^Working$/);
    await clients.plain.request("chat.abort", { sessionKey: "agent:marlow:main" });
    const states = await seen(/^Recipient stopped$/, 30_000);
    expect(states.at(-1)).toBe("Recipient stopped");
    await shot(card(page, "messaged-card"), "messaged-recipient-stopped");
  });

  test("F-122: a recipient that asks its own user: Recipient waiting, and after the answer its run goes on", async () => {
    const { title } = await hostTask("pip", "Asks from here", "message your partner who asks");
    await openTask(page, "Pip", title);
    const states = await seen(/^Recipient waiting$/);
    expect(states.at(-1)).toBe("Recipient waiting");
    await shot(card(page, "messaged-card"), "messaged-recipient-waiting");
    await openTask(page, "Marlow", "Notes for Pip");
    // Marlow's main task is shared: this check's question is the one the gateway lists as
    // pending there, asked since this check began, and its card is found by that id.
    let questionId = "";
    await expect
      .poll(
        async () => {
          const listed = await clients.questions.request<{
            questions?: Array<{
              id: string;
              sessionKey?: string;
              status?: string;
              createdAtMs?: number;
            }>;
          }>("question.list", {});
          questionId =
            listed.questions?.find(
              (each) =>
                each.sessionKey === "agent:marlow:main" &&
                each.status === "pending" &&
                (each.createdAtMs ?? 0) >= checkStarted,
            )?.id ?? "";
          return questionId;
        },
        { timeout: 60_000 },
      )
      .not.toBe("");
    const question = page.locator(`#card-question-${questionId.replace(/[^\w-]/g, "_")}`);
    await expect(question).toHaveAttribute("data-state", "pending", { timeout: 30_000 });
    await question.getByRole("radio", { name: /Lake loop/ }).click();
    await expect(question).toHaveAttribute("data-state", "answered", { timeout: 30_000 });
    await openTask(page, "Pip", title);
    const after = await seen(/^(No reply yet|Replied)$/);
    expect(after.at(-1)).toMatch(/^(No reply yet|Replied)$/);
  });
});

test.describe("Messaged cards' actions on a real gateway", () => {
  test("F-124: Open in Marlow goes to its Message from Pip card in Marlow's task; Open in Pip comes back with the card still open", async () => {
    const t = await clientTask("pip", "message-open");
    const run = await clients.plain.send(t.key, "#message");
    await clients.plain.terminal(String(run.runId));
    // This message's identities: the send's call id (its card here) and the recipient run.
    const { toolCallId, recipientRunId } = sendFacts(String(run.runId));
    expect(toolCallId).not.toBe("");
    expect(recipientRunId).not.toBe("");
    const sender = page.locator(
      `#card-bot-message-${`tool:${toolCallId}`.replace(/[^\w-]/g, "_")}`,
    );
    await openTask(page, "Pip", t.title);
    // The card's own line: its body may hold the Thought line of the reasoning that led to it.
    await sender.locator(":scope > summary").click();
    await sender.getByRole("button", { name: "Open this message in Marlow's task" }).click();
    await expect(page.locator(".title-pill")).toContainText("Notes for Pip");
    // Marlow's task, at the Message from Pip card of the run this message started, open and
    // focused: that card by its run, among the cards other checks left in this shared task.
    const received = page.locator(`[data-testid="received-card"][data-run-id="${recipientRunId}"]`);
    await expect(received).toHaveCount(1);
    await expect(received).toHaveAttribute("open", "");
    await expect(received.locator(":scope > summary")).toBeFocused();
    await expect(page.locator('[data-testid="received-card"][open]')).toHaveCount(1);
    await shot(received, "received-card");
    await received.getByRole("button", { name: "Open this message in Pip's task" }).click();
    await expect(page.getByRole("heading", { level: 1, name: t.title })).toBeVisible();
    // Back at this message's own card, still open.
    await expect(sender).toHaveAttribute("open", "");
  });

  test("two messages to Marlow in one task, its whole history loaded: Show full exchange shows both and the replies, read-only", async () => {
    const t = await clientTask("pip", "message-twice");
    for (let i = 0; i < 2; i += 1) {
      const run = await clients.plain.send(t.key, "#message");
      await clients.plain.terminal(String(run.runId));
    }
    await openTask(page, "Pip", t.title);
    const messaged = card(page, "messaged-card").last();
    await messaged.locator(":scope > summary").click();
    await messaged
      .getByRole("button", { name: "Show every message between Pip and Marlow in this task" })
      .click();
    const list = messaged.getByRole("list", {
      name: "Every message between Pip and Marlow in this task",
    });
    await expect(list.locator(".exchange-text")).toHaveCount(4);
    await expect(list.getByRole("textbox")).toHaveCount(0);
    await shot(messaged, "messaged-full-exchange");
    await messaged.getByRole("button", { name: "Show only this message" }).click();
    await expect(list).toHaveCount(0);
  });
});

test.describe("tool-server calls on a real gateway", () => {
  /** A call from Juniper to the stand-in coding agent, sent by a test client. */
  const called = async (slug: string, directive: string) => {
    const t = await clientTask("main", slug);
    const run = await clients.plain.send(t.key, directive);
    return { ...t, runId: String(run.runId) };
  };
  /** The stand-in names its own tools (`coder__send_message`, …), none of T3 Code's: no card. */
  const ordinaryStep = async (on: Page, text: string) => {
    await expect(card(on, "t3-card")).toHaveCount(0);
    // Its action card: a tool server's call (by the gateway's map or its result), else the general card.
    const step = on.getByTestId("tool-call").first();
    await expect(step).toHaveAttribute("data-kind", /^(server|tool)$/);
    await step.locator(":scope > summary").click();
    await expect(step).toContainText(text);
    await step.getByRole("tab", { name: "Raw" }).click();
    await expect(step.locator(".tool-name")).toHaveText(/^coder__/);
    await step.getByRole("tab", { name: "Readable" }).click();
    return step;
  };

  test("F-132 F-138: a call with a link is an ordinary tool step: the stand-in is not T3 Code", async () => {
    const t = await called("mcp", "#mcp");
    await clients.plain.terminal(t.runId);
    await openTask(page, "Juniper", t.title);
    await ordinaryStep(page, "https://coding-agent.example/threads/");
    await shot(page, "tool-server-link");
    await openTask(reader, "Juniper", t.title);
    await ordinaryStep(reader, "https://coding-agent.example/threads/");
    await reload(page, "Juniper", t.title);
    await ordinaryStep(page, "https://coding-agent.example/threads/");
  });

  test("the gateway's map from tools.effective names the stand-in's tools by their own names, as the engine reads it", async () => {
    const t = await called("mcp-map", "#mcp");
    await clients.plain.terminal(t.runId);
    const answer = await clients.plain.request("tools.effective", { sessionKey: t.key });
    const map = mcpToolMap(answer, MAX_MCP_TOOLS);
    expect(map["coder__send_message"]).toEqual({ server: "coder", tool: "send_message" });
    expect(map["coder__run_checks"]).toEqual({ server: "coder", tool: "run_checks" });
    // Built-in tools are not tool-server tools: every entry is one of the two stand-ins'.
    expect(Object.keys(map).every((name) => /^(coder|t3code)__/.test(name))).toBe(true);
  });

  test("F-314: an error result is an ordinary failed step", async () => {
    const t = await called("mcp-error", "#mcp-error");
    await clients.plain.terminal(t.runId);
    await openTask(page, "Juniper", t.title);
    const step = await ordinaryStep(page, "Error");
    await expect(step.locator(":scope > summary .action-state")).toHaveText("Failed");
  });

  test("F-134: a slow call, and a call stopped mid-way, stay ordinary steps", async () => {
    const slow = await called("mcp-slow", "#mcp-slow 5");
    await openTask(page, "Juniper", slow.title);
    await expect(card(page, "t3-card")).toHaveCount(0);
    await clients.plain.terminal(slow.runId);
    await ordinaryStep(page, "structuredContent");
    const stop = await called("mcp-stop", "#mcp-stop");
    await openTask(page, "Juniper", stop.title);
    // Stopped once its long call has started on the gateway, not after a fixed wait.
    await clients.plain.waitFor("the long call's start", (e) => {
      const p = e.payload as { runId?: string; stream?: string; data?: { phase?: string } };
      return p.runId === stop.runId && p.stream === "tool" && p.data?.phase === "start";
    });
    await clients.plain.request("chat.abort", { sessionKey: stop.key });
    await clients.plain.terminal(stop.runId);
    await expect(card(page, "t3-card")).toHaveCount(0);
    await expect(page.getByTestId("live-turn")).toHaveCount(0, { timeout: 15_000 });
    // Read from history on the read-only page: history keeps the call and no result for it.
    await openTask(reader, "Juniper", stop.title);
    // Its arguments, as label and value rows; nothing establishes what the server did: Unknown.
    const step = await ordinaryStep(reader, "3600");
    await expect(step.locator(":scope > summary .action-state")).toHaveText("Unknown");
  });
});

test.describe("cards read again from history", () => {
  test("F-165 F-113: on a host that never saw them live, a settled approval and an answered question show only their step and the reply: the gateway lists only pending requests, and history keeps no approval or question record", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    // A settled approval and an answered question of this check's own, settled on this host.
    const approved = await hostTask("otto", "Approve then read", "#sleep 2");
    await openTask(page, "Otto", approved.title);
    const approval = card(page, "approval-card");
    await expect(approval).toHaveCount(1, { timeout: 30_000 });
    await approval.getByRole("button", { name: "Allow once" }).click();
    await expect(approval.locator(".tag")).toHaveText("Allowed once", { timeout: 30_000 });
    await expect(transcript(page)).toContainText("The slow command finished.", {
      timeout: 30_000,
    });
    const asked = await hostTask("pip", "Answer then read", "ask me a question");
    await openTask(page, "Pip", asked.title);
    const question = card(page, "question-card");
    await expect(question).toHaveCount(1, { timeout: 30_000 });
    await question.getByRole("radio", { name: /Lake loop/ }).click();
    await expect(question).toHaveAttribute("data-state", "answered", { timeout: 30_000 });
    await expect(transcript(page)).toContainText("route: Lake loop", { timeout: 30_000 });
    // A host that never saw either live reads them from history alone.
    const fresh = await pairedPage(browser, await startOwnHost());
    await requestAccess(fresh);
    for (const task of [
      { bot: "Otto", title: approved.title, reply: "The slow command finished." },
      { bot: "Pip", title: asked.title, reply: "route: Lake loop" },
    ]) {
      await openTask(fresh, task.bot, task.title);
      await expect(transcript(fresh)).toContainText(task.reply, { timeout: 30_000 });
      await expect(card(fresh, "approval-card")).toHaveCount(0);
      await expect(card(fresh, "question-card")).toHaveCount(0);
    }
    await fresh.context().close();
  });
});

test.describe("T3 Code thread cards on a real gateway, with the scripted T3 Code stand-in", () => {
  /** A run of Juniper's that calls the stand-in, sent by a test client into a task of its own. */
  const called = async (slug: string, directive: string) => {
    const t = await clientTask("main", slug);
    const run = await clients.plain.send(t.key, directive);
    return { ...t, runId: String(run.runId) };
  };
  /** The run's tool events on the test client, by phase and tool. */
  const toolEvent = (runId: string, phase: string, tool: string) =>
    clients.plain.waitFor(
      `${tool} ${phase} in ${runId}`,
      (e) => {
        const p = e.payload as { runId?: string; stream?: string; data?: Record<string, unknown> };
        return (
          p.runId === runId &&
          p.stream === "tool" &&
          p.data?.phase === phase &&
          p.data?.name === `t3code__${tool}`
        );
      },
      60_000,
    );
  /**
   * Every tool call id the run made, in order, as the gateway reported their items' starts,
   * which every client following the session receives, whoever started the run.
   */
  const callIds = (runId: string) =>
    clients.plain
      .runEvents(runId)
      .map(
        (e) =>
          e.payload as {
            stream?: string;
            data?: { kind?: string; phase?: string; toolCallId?: string };
          },
      )
      .filter((p) => p.stream === "item" && p.data?.kind === "tool" && p.data?.phase === "start")
      .map((p) => String(p.data?.toolCallId));
  /** History holds the run's last result: the read again sees what the live run saw. */
  const inHistory = async (key: string, count: number) =>
    expect
      .poll(
        async () => {
          const history = await clients.plain.request<{ messages: Array<{ role?: string }> }>(
            "chat.history",
            { sessionKey: key, limit: 50 },
          );
          return history.messages.filter((m) => m.role === "toolResult").length;
        },
        { timeout: 30_000 },
      )
      .toBe(count);
  const thread = (on: Page) => card(on, "t3-card").first();
  const word = (on: Page) => thread(on).locator(":scope > summary .state");
  const openCard = async (on: Page) => {
    const c = thread(on);
    if ((await c.getAttribute("open")) === null) await c.locator(":scope > summary").click();
    await expect(c).toHaveAttribute("open", "");
    return c;
  };
  /** Each call's item on the card carries its own Raw, naming its own call. */
  const eachRaw = async (on: Page, ids: string[]) => {
    const c = await openCard(on);
    for (const id of ids) {
      const item = c.locator(`[data-item-call="${id}"]`);
      await item.getByRole("button", { name: "Raw for this call" }).click();
      await expect(item.getByRole("region", { name: "What the gateway sent" })).toContainText(id);
    }
  };

  test("F-132 F-134 F-313: a thread launched and waited on, live: the wait's line closes up into the thread's card, which reads Call made, each status on its own item", async () => {
    test.setTimeout(180_000);
    const t = await called("t3-live", "#t3-start #t3-wait");
    // Open while the wait runs: its line, and the card's Checking, as the gateway's events say.
    await toolEvent(t.runId, "start", "t3_thread_wait");
    await openTask(page, "Juniper", t.title);
    const [launch, wait] = callIds(t.runId);
    const line = page.locator(`.card.action[data-call="${wait}"]`);
    await expect(line).toHaveCount(1);
    await expect(line.locator(":scope > summary")).toContainText("Waiting for");
    await expect(word(page)).toHaveText("Checking");
    await shot(page, "t3-checking");
    await clients.plain.terminal(t.runId);
    await expect(line).toHaveCount(0);
    // The launch and the wait each reported a status: Call made, each on its own item.
    await expect(word(page)).toHaveText("Call made");
    await expect(thread(page).locator(":scope > summary")).toContainText("· 2 calls");
    await expect(thread(page)).toHaveAttribute("data-call", launch!);
    await eachRaw(page, [launch!, wait!]);
    await shot(thread(page), "t3-thread-live");
  });

  test("F-132 F-133 F-313: after a reload from history, and on a read-only connection, the same card: the thread from the gateway's rendering, every call's Raw", async () => {
    test.setTimeout(180_000);
    const t = await called("t3-history", "#t3");
    await clients.plain.terminal(t.runId);
    await inHistory(t.key, 2);
    const [launch, wait] = callIds(t.runId);
    for (const on of [page, reader]) {
      await reload(on, "Juniper", t.title);
      await expect(card(on, "t3-card")).toHaveCount(1);
      await expect(word(on)).toHaveText("Call made");
      await expect(on.locator(`.card.action[data-call="${wait}"]`)).toHaveCount(0);
      await eachRaw(on, [launch!, wait!]);
      const item = thread(on).locator(`[data-item-call="${launch}"]`);
      await expect(item).toContainText("T3 Code made the thread mcp:");
      await expect(
        thread(on).getByRole("link", { name: "Open the T3 Code thread in your browser" }),
      ).toHaveAttribute("href", /^https:\/\/t3-code\.example\/threads\/local\//);
    }
    await shot(thread(reader), "t3-thread-history-readonly");
  });

  test("F-133 F-313: a read with its reply cut never says it read to the end; a follow-up after a bubble keeps its line, with Show the thread", async () => {
    test.setTimeout(180_000);
    // Started by the host's own device: its run's tool events, results included, reach the host
    // as they happen. (A host that did not start a run gets only its item events, and the result
    // from history, where the gateway cut this read's rendering; see below.)
    const { title, key } = await hostTask("main", "T3 long read", "#t3-long #t3-read #t3-send");
    await clients.plain.request("sessions.messages.subscribe", { key });
    const run = await clients.plain.waitFor(
      "the long read's run",
      (e) => {
        const p = e.payload as { sessionKey?: string; stream?: string; data?: { name?: string } };
        return (
          p.sessionKey === key && p.stream === "item" && p.data?.name === "t3code__t3_thread_wait"
        );
      },
      60_000,
    );
    const t = { key, title, runId: String((run.payload as { runId: string }).runId) };
    await openTask(page, "Juniper", t.title);
    await clients.plain.terminal(t.runId);
    const [, , read, send] = callIds(t.runId);
    const c = await openCard(page);
    await expect(c.locator(`[data-item-call="${read}"]`)).toContainText(
      "Part of the reply only: its text was cut, and the rest was not read",
    );
    await expect(c).not.toContainText("Read to the end");
    await shot(c, "t3-read-cut");
    const line = page.locator(`.card.action[data-call="${send}"]`);
    await expect(line.locator(":scope > summary")).toContainText("Followed up with");
    await line.locator(":scope > summary").click();
    await line.getByRole("button", { name: "Show this thread's card" }).click();
    await expect(c.locator(`[data-item-call="${send}"] > summary`)).toBeFocused();
    // From history the read's rendering is cut by the gateway: what it read is not known, and
    // it still never says it read to the end.
    await inHistory(t.key, 4);
    await reload(page, "Juniper", t.title);
    const again = await openCard(page);
    await expect(again).not.toContainText("Read to the end");
  });

  test("F-134 F-137 F-470: the bot stopped during a wait: the wait is Delivery unknown, the launch keeps Call made, and the card says work may continue", async () => {
    test.setTimeout(180_000);
    // Started and stopped by the host's own device, as the composer's Stop does: the host sees
    // its own run stop. (History alone cannot say so: the gateway keeps no result for a call a
    // stop cut short, and no end for its run.)
    const { title, key } = await hostTask("main", "T3 stopped", "#t3-start #t3-wait");
    await clients.plain.request("sessions.messages.subscribe", { key });
    const waiting = await clients.plain.waitFor(
      "the wait's start",
      (e) => {
        const p = e.payload as { sessionKey?: string; stream?: string; data?: { name?: string } };
        return (
          p.sessionKey === key && p.stream === "item" && p.data?.name === "t3code__t3_thread_wait"
        );
      },
      60_000,
    );
    const t = { key, title, runId: String((waiting.payload as { runId: string }).runId) };
    await openTask(page, "Juniper", t.title);
    await hostCommand(page, { type: "stopRun", key: t.key, runId: t.runId }, t.key);
    await clients.plain.terminal(t.runId);
    const [launch, wait] = callIds(t.runId);
    await openTask(page, "Juniper", t.title);
    const c = await openCard(page);
    await expect(c.locator(`[data-item-call="${launch}"] > summary .state`)).toHaveText(
      "Call made",
    );
    // The wait ended with no result naming the thread: it joins none, and is a card of its own,
    // Delivery unknown, that can bring the reader to the thread its arguments name.
    const own = page.locator(`.card.action[data-call="${wait}"]`);
    await expect(own.locator(":scope > summary .action-state")).toHaveText("Delivery unknown");
    await expect(c.locator(`[data-item-call="${wait}"]`)).toHaveCount(0);
    await own.locator(":scope > summary").click();
    await expect(own.getByRole("button", { name: "Show this thread's card" })).toBeVisible();
    await expect(
      c.getByText("The call was made. Work handed to T3 Code may continue there."),
    ).toBeVisible();
    // The note is added; the thread's last reported status stays its word.
    await expect(word(page)).toHaveText("Running");
    await shot(c, "t3-stopped");
  });

  test("F-313: a held occurrence keeps the reader's focus on its Raw through the result and the run's end; reloaded, the record's own placement shows the call in its thread with its Raw", async () => {
    test.setTimeout(240_000);
    // Started by the host, so its results reach the host live; the wait takes six seconds.
    const { title, key } = await hostTask("main", "T3 held", "#t3-start #t3-wait");
    await clients.plain.request("sessions.messages.subscribe", { key });
    const waiting = await clients.plain.waitFor(
      "the wait's start",
      (e) => {
        const p = e.payload as { sessionKey?: string; stream?: string; data?: { name?: string } };
        return (
          p.sessionKey === key && p.stream === "item" && p.data?.name === "t3code__t3_thread_wait"
        );
      },
      60_000,
    );
    const runId = String((waiting.payload as { runId: string }).runId);
    await openTask(page, "Juniper", title);
    const [, wait] = callIds(runId);
    const line = page.locator(`.card.action[data-call="${wait}"]`);
    await line.locator(":scope > summary").click();
    const raw = line.getByRole("tab", { name: "Raw" });
    await raw.click();
    await expect(raw).toBeFocused();
    // The result comes and the run ends: the line the reader holds stays, open, Raw still focused.
    await clients.plain.terminal(runId);
    await expect(word(page)).toHaveText("Call made", { timeout: 45_000 });
    await expect(line).toHaveCount(1);
    await expect(line).toHaveAttribute("open", "");
    await expect(raw).toBeFocused();
    // A view rebuilt from the record shows the record's own placement: the wait joined its thread,
    // its Raw on the thread's card.
    await inHistory(key, 2);
    await reload(page, "Juniper", title);
    await expect(word(page)).toHaveText("Call made");
    await expect(line).toHaveCount(0);
    const c = await openCard(page);
    const item = c.locator(`[data-item-call="${wait}"]`);
    await item.getByRole("button", { name: "Raw for this call" }).click();
    await expect(item.getByRole("region", { name: "What the gateway sent" })).toContainText(wait!);
  });

  test("F-134: a slow run waited on briefly, then asked to stop: the stop's item reads Stop requested, and the wait says it ended first", async () => {
    test.setTimeout(120_000);
    const t = await called("t3-interrupt", "#t3-start #t3-wait-short #t3-stop");
    await clients.plain.terminal(t.runId);
    const [, wait, stop] = callIds(t.runId);
    await openTask(page, "Juniper", t.title);
    // Three calls reported a status: Call made, each status on its own item.
    await expect(word(page)).toHaveText("Call made");
    const c = await openCard(page);
    await expect(c.locator(`[data-item-call="${stop}"]`)).toContainText("Stop requested");
    await expect(c.locator(`[data-item-call="${wait}"]`)).toContainText(
      "The wait ended before the run finished",
    );
    await expect(c).toContainText("A stop was asked for. That is not proof that T3 Code stopped.");
  });

  test("F-314 F-313: a follow-up T3 Code refuses is Failed on its own call, with T3 Code's code; its thread's launch is not in the record", async () => {
    test.setTimeout(120_000);
    const t = await called("t3-refused", "#t3-refused");
    await clients.plain.terminal(t.runId);
    const [send] = callIds(t.runId);
    await openTask(page, "Juniper", t.title);
    // Its result names no thread, so it joins none: a card of its own, saying what was asked,
    // that it failed and T3 Code's reason. No thread is said to exist before the record.
    const check = async () => {
      const own = page.locator(`.card.action[data-call="${send}"]`);
      await expect(own).toHaveAttribute("data-kind", "t3");
      await expect(own.locator(":scope > summary .action-state")).toHaveText("Failed");
      await expect(own.locator(":scope > summary")).toContainText("Couldn't follow up with");
      await expect(own.locator(":scope > summary .action-detail")).toContainText(
        "thread_not_sendable",
      );
      await expect(card(page, "t3-card")).toHaveCount(0);
      await expect(page.getByText("started before this conversation's record")).toHaveCount(0);
      return own;
    };
    await shot(await check(), "t3-refused");
    await reload(page, "Juniper", t.title);
    await check();
  });

  test("F-313: T3 Code's listings are lines of their own that fold, never a thread's card", async () => {
    const t = await called("t3-list", "#t3-list");
    await clients.plain.terminal(t.runId);
    await openTask(page, "Juniper", t.title);
    await expect(card(page, "t3-card")).toHaveCount(0);
    const fold = page.locator(".card.action[data-fold]");
    await expect(fold).toHaveAttribute("data-fold", "2");
    await expect(fold.locator(":scope > summary")).toContainText(
      "Looked through T3 Code · 2 times",
    );
  });

  test("F-132: a call whose name suggests T3 Code's read and whose result names another tool of the same server is an ordinary tool-server card", async () => {
    const t = await called("t3-decoy", "#t3-decoy");
    await clients.plain.terminal(t.runId);
    const result = await toolEvent(t.runId, "result", "t3_thread_read-2");
    expect(
      (result.payload as { data: { result: { details: { mcpTool: string } } } }).data.result.details
        .mcpTool,
    ).toBe("T3_thread_read");
    await openTask(page, "Juniper", t.title);
    await expect(card(page, "t3-card")).toHaveCount(0);
    await expect(page.getByTestId("tool-call")).toHaveAttribute("data-kind", "server");
    await reload(page, "Juniper", t.title);
    await expect(card(page, "t3-card")).toHaveCount(0);
  });
});

test.describe("a bot-to-bot message as an action card on a real gateway", () => {
  test("F-439 F-122: a Messaged card sits in its run's column between actions, never folds, and its message is shown nowhere else, live and after a reload", async () => {
    test.setTimeout(180_000);
    const t = await clientTask("pip", "message-column");
    const run = await clients.plain.send(t.key, "#message-column");
    await clients.plain.terminal(String(run.runId));
    const check = async (on: Page) => {
      const column = transcript(on);
      const messaged = card(on, "messaged-card");
      // Two sends in a row are two cards: they never fold.
      await expect(messaged).toHaveCount(2);
      await expect(messaged.first().locator("summary .state")).toHaveText("Replied");
      // One column: the read, the two Messaged cards and the listing, with nothing between them.
      const order = await column.evaluate((element) =>
        [...element.querySelectorAll(".card.action, .card.messaged")].map((each) => {
          const next = each.nextElementSibling;
          return [
            each.classList.contains("messaged") ? "messaged" : (each as HTMLElement).dataset.kind,
            next?.matches(".card.action, .card.messaged") ?? false,
          ];
        }),
      );
      expect(order).toEqual([
        ["read", true],
        ["messaged", true],
        ["messaged", true],
        ["list", false],
      ]);
      // The message's words appear once for each card and nowhere else in the run.
      // Each message is in its own card, and in no other element of the transcript.
      for (const [i, text] of [
        "Could you look over the plan?",
        "And the route for Saturday?",
      ].entries()) {
        await expect(messaged.nth(i)).toContainText(text);
        const elsewhere = await column.evaluate((element, text) => {
          const copy = element.cloneNode(true) as HTMLElement;
          for (const each of copy.querySelectorAll(".card.messaged")) each.remove();
          return copy.textContent?.split(text).length ?? 1;
        }, text);
        expect(elsewhere - 1, text).toBe(0);
      }
    };
    await openTask(page, "Pip", t.title);
    await check(page);
    await shot(transcript(page), "messaged-column");
    await reload(page, "Pip", t.title);
    await check(page);
  });
});
