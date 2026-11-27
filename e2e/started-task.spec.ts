// A task a bot started, against a real development gateway (docs/parity.md F-565): Juniper
// starts a visible task with the gateway's own sessions_spawn (`#hand-off`) from a task of its
// own; the interface lists it under Juniper by its label, opens it, says who started it and
// from where, shows the first message as Juniper's brief, and the person writes there and gets
// an answer. Then Otto, asked in the conversation, starts one, and the conversation shows it as a
// card (F-587) that reaches Done, opens that task, and says Otto reported back, and keeps that
// report as the task's later runs bring reports of their own. The brief is checked on both
// OpenClaw versions: 2026.11.10 also marks it as sent from the task it came from. The scenario check
// starts its `#hand-off` tasks under Pip and Marlow, and a label is unique among a bot's tasks, so
// this spec uses Juniper and Otto.
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { programVersion } from "../tools/dev-gateway/src/pinned.ts";
import { HAND_OFF } from "../tools/dev-gateway/src/scenarios.ts";
import { PINNED_OPENCLAW, shapeOf } from "../tools/dev-gateway/src/versions.ts";
import { devGateway, startHost, stopChild } from "./global-setup.ts";
import { leaveIdle } from "./teardown.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const SINCE = Date.now();
const STAMP = SINCE.toString(36);
const PARENT = `agent:main:e2e-started-${STAMP}`;
const PARENT_TITLE = "Plan the Saturday walk";
const ASKED = `agent:otto:e2e-card-${STAMP}`;
const ASKED_TITLE = "Saturday walk maps";
const PLAIN_REPLY = "Here is a plain reply, streamed in small pieces with no reasoning first.";
/** The forms of the run's gateway: `OPENCLAW_BIN`'s version, else the pin. */
const SHAPE = shapeOf(
  process.env.OPENCLAW_BIN
    ? (programVersion(resolve(process.env.OPENCLAW_BIN)) ?? "")
    : PINNED_OPENCLAW,
);

type Host = { child: ChildProcess; url: string; data: string };
let host: Host | null = null;
let page: Page;
let sender: OperatorSession;
/** Tasks this spec made, removed afterwards. */
const made = new Set<string>([PARENT, ASKED]);

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

async function pairedPage(browser: Browser, url: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const next = await context.newPage();
  await next.goto(url);
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

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  expect(INSTANCE, "a named instance").toMatch(/^[a-z0-9-]+$/);
  sender = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate started-task check",
    ["operator.read", "operator.write"],
    ["tool-events"],
  );
  const data = mkdtempSync(join(tmpdir(), "clawtrate-started-"));
  const started = startHost(INSTANCE, STATIC, data);
  // Kept before its address is awaited, so the host is stopped afterwards even if it never says.
  host = { child: started.host, url: "", data };
  started.gated.release();
  host.url = await started.url;
  page = await pairedPage(browser, host.url);
  // Interactive access, asked as the person asks it: Request access in the access bar.
  await botRow(page, "Juniper").first().click();
  const bar = page.getByRole("region", { name: "Access" });
  await bar.getByRole("button", { name: "Request access" }).click();
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  if (host) {
    await stopChild(host.child).catch(() => host!.child.kill("SIGKILL"));
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
  await sender?.close();
});

test("F-565: a task a bot started opens under the bot with its label, says who started it and from where, shows the bot's brief, and takes the person's message", async () => {
  test.setTimeout(180_000);
  // Juniper, in a task of its own, starts a task with a brief: the gateway's sessions_spawn.
  const sent = (await sender.send(PARENT, "#hand-off")) as { runId: string };
  await sender.terminal(sent.runId, 60_000);
  await gatewayCall("sessions.patch", { key: PARENT, label: PARENT_TITLE });
  const listed = await gatewayCall<{ sessions: Array<Record<string, unknown>> }>("sessions.list", {
    agentId: "main",
    excludeCron: true,
    excludeSubagents: true,
    limit: 200,
  });
  const child = listed.sessions.find((row) => row.spawnedBy === PARENT);
  expect(child, "the gateway lists the started task").toBeTruthy();
  made.add(String(child!.key));
  expect([child!.label, child!.createdVia]).toEqual([HAND_OFF.label, "spawn"]);

  // Listed under Juniper by the label it gave, and opened.
  await botRow(page, "Juniper").first().click();
  await expect(taskRow(page, HAND_OFF.label)).toBeVisible({ timeout: 30_000 });
  await taskRow(page, HAND_OFF.label).click();
  await expect(page.locator(".task-line")).toHaveText(HAND_OFF.label);
  await expect(page.getByTestId("started-by")).toHaveText(
    `Juniper started this task from ${PARENT_TITLE} · Open ${PARENT_TITLE}`,
    { timeout: 30_000 },
  );
  // Its first message is Juniper's brief, not the person's.
  const brief = page.getByTestId("task-brief");
  await expect(brief).toBeVisible({ timeout: 30_000 });
  await expect(brief.locator("figcaption")).toHaveText("Juniper's brief");
  await expect(brief).toContainText(HAND_OFF.task);
  await expect(page.locator('.msg[data-role="user"]')).toHaveCount(0);

  // The person writes in it and gets an answer; their message is theirs.
  await page.getByTestId("composer-input").fill("#text");
  await page.getByTestId("composer-input").press("Enter");
  await expect(page.locator('.msg[data-role="user"]').filter({ hasText: "#text" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("transcript").getByText(PLAIN_REPLY)).toHaveCount(2, {
    timeout: 60_000,
  });
  await expect(brief).toHaveCount(1);

  // Open goes to the task it was started from.
  await page.getByRole("button", { name: `Open ${PARENT_TITLE}` }).click();
  await expect(page.locator(".task-line")).toHaveText(PARENT_TITLE);
});

test("F-587: a task a bot starts shows as a card where it was asked, reaches Done, opens that task, and says the bot reported back", async () => {
  test.setTimeout(300_000);
  // A conversation of Otto's, opened in the app, where the person asks for a task.
  const first = (await sender.send(ASKED, "#text")) as { runId: string };
  await sender.terminal(first.runId, 60_000);
  await gatewayCall("sessions.patch", { key: ASKED, label: ASKED_TITLE });
  await botRow(page, "Otto").first().click();
  await expect(taskRow(page, ASKED_TITLE)).toBeVisible({ timeout: 30_000 });
  await taskRow(page, ASKED_TITLE).click();
  await expect(page.locator(".task-line")).toHaveText(ASKED_TITLE);
  await page.getByTestId("composer-input").fill("#hand-off");
  await page.getByTestId("composer-input").press("Enter");

  // The start is a card where it was asked, not a step line, and reaches Done.
  const card = page.getByRole("group", { name: `Started a task: ${HAND_OFF.label}` });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.locator(".messaged-verb")).toHaveText("Started a task");
  await expect(card.locator(".messaged-who")).toHaveText("Otto");
  await expect(card.locator(".started-title")).toHaveText(HAND_OFF.label);
  await expect(card.getByTestId("started-task-brief")).toHaveText(HAND_OFF.task);
  await expect(card.locator(".state")).toHaveText("Done", { timeout: 60_000 });
  await expect(page.getByTestId("transcript").getByText("Started a helper")).toHaveCount(0);
  const listed = await gatewayCall<{ sessions: Array<Record<string, unknown>> }>("sessions.list", {
    agentId: "otto",
    excludeCron: true,
    excludeSubagents: true,
    limit: 200,
  });
  const child = listed.sessions.find((row) => row.spawnedBy === ASKED);
  expect(child, "the gateway lists the started task").toBeTruthy();
  made.add(String(child!.key));

  // Open task opens that task.
  await card.getByRole("button", { name: `Open ${HAND_OFF.label}` }).click();
  await expect(page.locator(".task-line")).toHaveText(HAND_OFF.label);
  await expect(page.getByTestId("started-by")).toHaveText(
    `Otto started this task from ${ASKED_TITLE} · Open ${ASKED_TITLE}`,
    { timeout: 30_000 },
  );

  // Back where it was asked, the card says Otto reported back, and goes to that reply.
  await page.getByRole("button", { name: `Open ${ASKED_TITLE}` }).click();
  await expect(page.locator(".task-line")).toHaveText(ASKED_TITLE);
  await expect(card.getByTestId("started-task-reported")).toHaveText("Otto reported back.", {
    timeout: 60_000,
  });
  await expect(card.locator(".state")).toHaveText("Done");
  const show = card.getByRole("button", { name: `Show Otto's report on ${HAND_OFF.label}` });
  await show.click();
  await expect(page.locator(":focus")).toContainText(`${HAND_OFF.label} finished.`);
  const reports = page
    .getByTestId("transcript-turn")
    .filter({ hasText: `${HAND_OFF.label} finished.` });
  await expect(reports).toHaveCount(1);
  const own = await reports.first().getAttribute("data-item");

  // The person writes in the started task, and the bot sends it a follow-up. Each later run of
  // that task may bring a report of its own (2026.11.10 sends one after the person's run, 2026.10.6
  // after the follow-up's): each shows as Otto's turn, and the card keeps its own start's report.
  await card.getByRole("button", { name: `Open ${HAND_OFF.label}` }).click();
  await expect(page.locator(".task-line")).toHaveText(HAND_OFF.label);
  await page.getByTestId("composer-input").fill("#text");
  await page.getByTestId("composer-input").press("Enter");
  await expect(page.getByTestId("transcript").getByText(PLAIN_REPLY)).toHaveCount(2, {
    timeout: 60_000,
  });
  await page.getByRole("button", { name: `Open ${ASKED_TITLE}` }).click();
  await expect(page.locator(".task-line")).toHaveText(ASKED_TITLE);
  const afterPerson = 1 + (SHAPE.reportsPersonsRun ? 1 : 0);
  await expect(reports).toHaveCount(afterPerson, { timeout: 60_000 });
  await page.getByTestId("composer-input").fill("#follow-up");
  await page.getByTestId("composer-input").press("Enter");
  const follow = page.getByTestId("messaged-card");
  await expect(follow.locator(".messaged-verb")).toHaveText("Sent to", { timeout: 60_000 });
  // The follow-up's run in the task has ended.
  await expect(follow).toHaveAttribute("data-state", "finished", { timeout: 60_000 });
  await expect(reports).toHaveCount(afterPerson + (SHAPE.reportsFollowUpRun ? 1 : 0), {
    timeout: 60_000,
  });
  // The gateway's completion rows (2026.11.10) draw no turn of their own.
  await expect(page.getByTestId("transcript-turn").filter({ hasText: /^\s*$/ })).toHaveCount(0);
  await expect(card.getByTestId("started-task-reported")).toHaveText("Otto reported back.");
  await show.click();
  await expect(page.locator(":focus")).toHaveAttribute("data-item", own!);
});
