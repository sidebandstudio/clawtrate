// Usage and warning budgets (docs/design/controls.md, sections 16 to 18)
// against a real development gateway: this run's own instance, a preview host
// of its own with the interactive tier (the person's first device), and a
// second host pinned read-only (their second device). Every figure the
// interface shows is compared with what the gateway itself answers to the
// same question (`usage.cost`, `sessions.usage`, `chat.history`), read by a
// paired operator of this spec's own. The scripted model reports 120 input and
// 80 output tokens for each answer, at a configured price of zero.
//
// What the checks change is put back afterwards: every budget is removed and
// the routine this spec makes is deleted. Its own tasks stay, as other specs'
// tasks do; nothing here pins, hides or moves a bot.
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUDGETS_PREF_KEY,
  rangeFor,
  rangeParams,
  type UsagePeriod,
} from "../packages/core/src/usage.ts";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { devGateway, startHost, stopChild } from "./global-setup.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const STAMP = Date.now().toString(36);
/** Screenshots against the real gateway, into a folder outside the repository, when set. */
const SHOTS = process.env.CLAWTRATE_USAGE_SHOTS ?? null;

test.describe.configure({ mode: "serial" });

type Host = { child: ChildProcess; url: string; data: string };
const hosts: Host[] = [];
let page: Page;
let reader: Page;
let gateway: OperatorSession;
let routineId: string | null = null;
let sharedRoutineId: string | null = null;
let timeZone = "UTC";
/** The second device's time zone: far from any machine's, so its days differ from the budget's. */
const READER_ZONE = "Pacific/Kiritimati";

type Json = Record<string, unknown>;

async function openclaw(args: string[]): Promise<string> {
  const result = await openInstance(INSTANCE).runner.run(args);
  if (result.status !== 0)
    throw new Error(`openclaw ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

/** A gateway method with the instance's own operator credentials. */
async function gatewayCall<T>(method: string, params: unknown): Promise<T> {
  return parseJsonOutput<T>(
    await openclaw(["gateway", "call", method, "--params", JSON.stringify(params), "--json"]),
  );
}

/**
 * The days a Daily or a Weekly budget covers today in `zone`, worked out here, apart from the
 * app's own date code: today, or Monday to today.
 */
function ownDays(period: "daily" | "weekly", zone: string) {
  const at = new Date();
  const today = at.toLocaleDateString("en-CA", { timeZone: zone });
  if (period === "daily") return { startDate: today, endDate: today, timeZone: zone };
  const sinceMonday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(
    at.toLocaleDateString("en-US", { weekday: "short", timeZone: zone }),
  );
  const monday = new Date(Date.parse(`${today}T12:00:00Z`) - sinceMonday * 86_400_000);
  return { startDate: monday.toISOString().slice(0, 10), endDate: today, timeZone: zone };
}

/** A date as the page names it: "Nov 16". */
const dayName = (date: string) =>
  `${"Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8))}`;

/**
 * What the gateway answers for a bot's (or every bot's) total over a period, in the page's time
 * zone, once it has finished counting: a cold gateway first answers with what it has read so
 * far and `cacheStatus.status: "refreshing"`, which the page shows as still being counted.
 */
async function gatewayTotal(
  botId: string | null,
  period:
    UsagePeriod | "daily" | "weekly" | { startDate: string; endDate: string; timeZone: string },
  zone = timeZone,
) {
  const range = typeof period === "string" ? rangeFor(period, Date.now(), zone) : period;
  const deadline = Date.now() + 90_000;
  for (;;) {
    const result = await gateway.request<{ totals: Json; updatedAt: number; cacheStatus?: Json }>(
      "usage.cost",
      { ...(botId ? { agentId: botId } : { agentScope: "all" }), ...rangeParams(range) },
    );
    const status = result.cacheStatus ?? {};
    const counting =
      (typeof status.status === "string" && status.status !== "fresh") ||
      Number(status.pendingFiles ?? 0) > 0 ||
      Number(status.staleFiles ?? 0) > 0;
    if (!counting || Date.now() > deadline)
      return {
        input: Number(result.totals.input),
        output: Number(result.totals.output),
        cacheRead: Number(result.totals.cacheRead),
        cacheWrite: Number(result.totals.cacheWrite),
        total: Number(result.totals.totalTokens),
        unpriced: Number(result.totals.missingCostEntries),
        cost: Number(result.totals.totalCost),
        asOf: Number(result.updatedAt),
        counting,
      };
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/**
 * Wait until the gateway's task aggregate (`sessions.usage` `totals`) and its total
 * (`usage.cost`) agree for a period: the page shows task and source figures only then.
 */
async function gatewayAgrees(botId: string | null, period: UsagePeriod) {
  const range = rangeFor(period, Date.now(), timeZone);
  const scope = botId ? { agentId: botId } : { agentScope: "all" };
  await expect
    .poll(
      async () => {
        const [cost, tasks] = await Promise.all([
          gateway.request<{ totals: Json }>("usage.cost", { ...scope, ...rangeParams(range) }),
          gateway.request<{ totals?: Json }>("sessions.usage", {
            ...scope,
            ...rangeParams(range),
            limit: 200,
          }),
        ]);
        return Number(tasks.totals?.totalTokens) === Number(cost.totals.totalTokens);
      },
      { timeout: 90_000, intervals: [2_000] },
    )
    .toBe(true);
}

/** A count as the page writes it ("1,080" or "1,080 tokens"); anything else, "Unavailable" too, is no number. */
const n = (text: string | null) => {
  const match = /^\s*([\d,]+)(?: tokens\b.*)?$/.exec(text ?? "");
  return match ? Number(match[1]!.replace(/,/g, "")) : Number.NaN;
};

async function startOwnHost(readOnly = false): Promise<Host> {
  const data = mkdtempSync(join(tmpdir(), "clawtrate-usage-"));
  const started = startHost(INSTANCE, STATIC, data, { readOnly });
  // Kept before it is waited for, so the teardown stops it and removes its folder even when it
  // never gives its address.
  const host = { child: started.host, url: "", data };
  hosts.push(host);
  started.gated.release();
  host.url = await started.url;
  return host;
}

/** A page on its own host, paired as the person pairs it, in its own time zone when given. */
async function pairedPage(browser: Browser, host: Host, timezoneId?: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    ...(timezoneId ? { timezoneId } : {}),
  });
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

const botRow = (on: Page, name: string) =>
  on.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${name}\\b`) });

/** A bot's Usage page, in the Work pane's Settings tab. */
async function usagePage(on: Page, bot: string): Promise<void> {
  await botRow(on, bot).first().click();
  if (await on.getByRole("button", { name: "Show work panel" }).count())
    await on.getByRole("button", { name: "Show work panel" }).click();
  await on.getByRole("tab", { name: "Settings" }).click();
  const back = on.getByTestId("usage-page").getByRole("button", { name: "Back to settings" });
  if (await back.count()) await back.click();
  await on.getByTestId("usage-row").click();
  await expect(on.getByTestId("usage-page")).toBeVisible();
  await expect(on.getByTestId("usage-total")).toBeVisible({ timeout: 30_000 });
}

/** The figures a Usage page shows, as numbers. */
async function shownTokens(on: Page) {
  const value = async (label: string) =>
    n(
      await on
        .getByTestId("usage-tokens")
        .locator("div", { has: on.locator("dt", { hasText: new RegExp(`^${label}$`) }) })
        .locator("dd")
        .textContent(),
    );
  return {
    input: await value("Input"),
    output: await value("Output"),
    cacheRead: await value("Cache read"),
    cacheWrite: await value("Cache write"),
    total: await value("Total"),
  };
}

/** A bar's figure, from its accessible name ("Messages from other bots: 200 tokens"). */
async function bar(on: Page, list: string, name: string): Promise<number> {
  const label = await on
    .getByTestId(list)
    .locator("li", { hasText: name })
    .first()
    .getAttribute("aria-label");
  // The digits just before "tokens": a bar's time ("as of 10:07 AM") is no part of its figure.
  return n(/([\d,]+) tokens/.exec(label ?? "")?.[1] ?? null);
}

/** The budget meter's count and tokens, from its accessible name. */
async function meter(on: Page): Promise<{ used: number; tokens: number; words: string }> {
  const label = (await on
    .getByTestId("budget-meter")
    .getByRole("meter")
    .getAttribute("aria-label"))!;
  const match = /: ([\d,]+) of ([\d,]+) tokens (today|this week)$/.exec(label)!;
  return { used: n(match[1]!), tokens: n(match[2]!), words: match[3]! };
}

/** Set the open bot's budget on its Usage page, as the person does. */
async function setBudget(on: Page, period: "Daily" | "Weekly", tokens: number): Promise<void> {
  const page = on.getByTestId("usage-page");
  const open = page.getByTestId("budget-edit").or(page.getByTestId("budget-new"));
  await open.click();
  const form = page.getByTestId("budget-form");
  await form.getByRole("radio", { name: period }).click();
  await form.getByTestId("budget-tokens").fill(String(tokens));
  await form.getByTestId("budget-save").click();
  await expect(page.getByTestId("budget-meter")).toBeVisible({ timeout: 30_000 });
}

/** The budgets the gateway keeps for the person, read back. */
async function keptBudgets(): Promise<Array<Json>> {
  const result = await gateway.request<{ entries?: Json }>("users.prefs.get", {
    keys: [BUDGETS_PREF_KEY],
  });
  const value = result.entries?.[BUDGETS_PREF_KEY] as { budgets?: Json[] } | null | undefined;
  return value?.budgets ?? [];
}

/** One bridge command, over the page's host's own socket, as another viewer sends it. */
async function hostCommand(
  on: Page,
  command: Json,
): Promise<{ ok: boolean; error: string | null }> {
  return await on.evaluate(
    (command) =>
      new Promise<{ ok: boolean; error: string | null }>((resolve, reject) => {
        const socket = new WebSocket(`ws://${location.host}/bridge`);
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as {
            type: string;
            id?: string;
            ok?: boolean;
            error?: string;
          };
          if (message.type === "hello")
            socket.send(JSON.stringify({ type: "command", id: "do", command }));
          else if (message.id === "do") {
            socket.close();
            resolve({ ok: message.ok === true, error: message.error ?? null });
          }
        };
        socket.onerror = () => reject(new Error("bridge socket error"));
        setTimeout(() => reject(new Error("no answer from the bridge")), 15_000);
      }),
    command,
  );
}

async function shot(on: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  const size = on.viewportSize()!;
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    for (const theme of ["light", "dark"] as const) {
      await on.setViewportSize({ width, height });
      await on.emulateMedia({ colorScheme: theme });
      await on.waitForTimeout(300);
      await on.screenshot({ path: join(SHOTS, `${name}-${theme}-${width}.png`) });
    }
  }
  await on.setViewportSize(size);
  await on.emulateMedia({ colorScheme: "light" });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  expect(INSTANCE, "a named instance").toMatch(/^[a-z0-9-]+$/);
  gateway = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate usage check",
    ["operator.read"],
    [],
  );
  page = await pairedPage(browser, await startOwnHost());
  timeZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  // Interactive access, asked as the person asks it: Request access in the access bar.
  await botRow(page, "Pip").first().click();
  const bar = page.getByRole("region", { name: "Access" });
  await bar.getByRole("button", { name: "Request access" }).click();
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 });
  reader = await pairedPage(browser, await startOwnHost(true), READER_ZONE);
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  // Put it back: no budget is left for later checks, and the routines go. Each step is tried
  // whatever the others did, and what failed is said once all have run.
  const failures: unknown[] = [];
  const attempt = async (step: () => Promise<unknown>) => {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  };
  await attempt(async () => {
    for (const budget of await keptBudgets())
      await hostCommand(page, { type: "changeBudget", change: { op: "remove", id: budget.id } });
    expect(await keptBudgets()).toEqual([]);
  });
  if (routineId) await attempt(() => openclaw(["cron", "rm", routineId!]));
  if (sharedRoutineId) await attempt(() => openclaw(["cron", "rm", sharedRoutineId!]));
  await attempt(async () => gateway?.close());
  for (const host of hosts.splice(0))
    await attempt(async () => {
      await stopChild(host.child);
      rmSync(host.data, { recursive: true, force: true });
    });
  if (failures.length > 0) throw new AggregateError(failures, "Putting the gateway back failed");
});

test("F-237: usage by bot and source agrees with the gateway for the selected period", async () => {
  // Three periods, each waiting up to 90 s for the gateway's answers to agree, 60 s for its
  // counting and 30 s for the figures, then Settings: more than the default deadline.
  test.setTimeout(600_000);
  await usagePage(page, "Otto");
  for (const [choice, period] of [
    ["This week", "week"],
    ["Today", "today"],
    ["30 days", "month"],
  ] as const) {
    await gatewayAgrees("otto", period);
    await page.getByTestId("usage-page").getByRole("radio", { name: choice }).click();
    const expected = await gatewayTotal("otto", period);
    expect(expected.counting, "the gateway finished counting").toBe(false);
    // The page reads again while the gateway is still counting, and then shows what it settled on.
    await expect(page.getByTestId("usage-source")).not.toContainText("still being counted", {
      timeout: 60_000,
    });
    await expect
      .poll(() => shownTokens(page), { timeout: 30_000 })
      .toEqual({
        input: expected.input,
        output: expected.output,
        cacheRead: expected.cacheRead,
        cacheWrite: expected.cacheWrite,
        total: expected.total,
      });
    expect(expected.total).toBeGreaterThan(0);
  }
  await expect(page.getByTestId("usage-source")).toHaveText(
    /^From the gateway's usage records for Otto the last 30 days \([A-Z][a-z]{2} \d{1,2} to [A-Z][a-z]{2} \d{1,2}, your time\), as of \d{1,2}:\d{2} [AP]M\./,
  );
  // The development gateway configures a price of zero: an estimate of zero, named as the gateway's.
  await expect(page.getByTestId("usage-cost")).toHaveText("About $0.00");
  await expect(page.getByTestId("usage-cost-hint")).toContainText(
    "The gateway's estimate from its configured prices, in US dollars, as of",
  );
  // By task: each listed task's share is the gateway's, for the period.
  const sessions = await gateway.request<{ sessions: Array<{ label?: string; usage?: Json }> }>(
    "sessions.usage",
    { agentId: "otto", ...rangeParams(rangeFor("month", Date.now(), timeZone)), limit: 200 },
  );
  const largest = sessions.sessions
    .filter((each) => Number(each.usage?.totalTokens ?? 0) > 0)
    .sort((a, b) => Number(b.usage!.totalTokens) - Number(a.usage!.totalTokens))[0]!;
  await expect(
    page
      .getByTestId("usage-tasks")
      .locator("div", { hasText: largest.label! })
      .first()
      .locator("dd"),
  ).toHaveText(`${Number(largest.usage!.totalTokens).toLocaleString("en-US")} tokens`);
  // Settings → Usage: every bot's bar is that bot's own total, and the sum the gateway's.
  await gatewayAgrees(null, "week");
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(settings.getByTestId("usage-all")).toBeVisible({ timeout: 30_000 });
  for (const [bot, id] of [
    ["Juniper", "main"],
    ["Marlow", "marlow"],
    ["Otto", "otto"],
    ["Pip", "pip"],
  ] as const) {
    const expected = (await gatewayTotal(id, "week")).total;
    // The section reads again while any bot's figure is still being counted.
    await expect.poll(() => bar(page, "usage-bots", bot), { timeout: 60_000 }).toBe(expected);
  }
  await expect(settings.getByTestId("usage-all")).not.toContainText("still being counted", {
    timeout: 60_000,
  });
  // Every bot's figure was read: none is Unavailable, and the total is settled, with its time.
  await expect(
    settings.getByTestId("usage-bots").getByRole("listitem", { name: /: Unavailable$/ }),
  ).toHaveCount(0);
  await expect(settings.getByTestId("usage-all-total")).toHaveText(
    new RegExp(
      `^Every bot: ${(await gatewayTotal(null, "week")).total.toLocaleString("en-US")} tokens · about \\$0\\.00, as of \\d{1,2}:\\d{2} [AP]M\\.$`,
    ),
  );
  // By source, for every bot: the parts add up to the gateway's total, nothing charged twice.
  await expect(settings.getByTestId("usage-sources")).toBeVisible();
  const parts = await Promise.all(
    ["Messages from people", "Routines", "Messages from other bots", "Not attributed"].map((name) =>
      bar(page, "usage-sources", name),
    ),
  );
  expect(parts.reduce((sum, each) => sum + each, 0)).toBe((await gatewayTotal(null, "week")).total);
  // The development gateway reports no provider's limits, and says when.
  await expect(settings.getByTestId("limits-none")).toHaveText(/^No limits reported, as of /);
  await shot(page, "settings-usage");
  await page.keyboard.press("Escape");
});

/** A task's history rows, as the gateway gives them. */
async function historyOf(sessionKey: string): Promise<Json[]> {
  return (await gateway.request<{ messages: Json[] }>("chat.history", { sessionKey, limit: 1000 }))
    .messages;
}

/** The tokens of one run's model answers in a history, and when its last one came. */
function runIn(messages: Json[], runId: string, within: (at: number) => boolean = () => true) {
  const rows = messages.filter(
    (each) =>
      each.role === "assistant" &&
      (each.__openclaw as Json | undefined)?.runId === runId &&
      within(Number(each.timestamp)),
  );
  return {
    tokens: rows.reduce(
      (sum, each) => sum + Number((each.usage as Json | undefined)?.totalTokens ?? 0),
      0,
    ),
    at: Math.max(0, ...rows.map((each) => Number(each.timestamp))),
  };
}

/**
 * Another bot's runs in a bot's tasks this week, worked out here from the gateway's own records
 * and apart from the app's code: a turn another bot's message started (`inter_session`), counted
 * as `expected` when the sending task's `sessions_send` result names its run, and as
 * `unconfirmed` when none does.
 */
async function otherBots(botId: string) {
  const days = ownDays("weekly", timeZone);
  const within = (at: number) => {
    const date = new Date(at).toLocaleDateString("en-CA", { timeZone });
    return date >= days.startDate && date <= days.endDate;
  };
  // The task list once the gateway has finished counting it: a task still being counted has
  // no usage yet (`computing`), and would be left out.
  let tasks: {
    sessions: Array<{ key: string; usage?: Json; computing?: boolean }>;
    cacheStatus?: Json;
  };
  const deadline = Date.now() + 90_000;
  for (;;) {
    tasks = await gateway.request("sessions.usage", {
      agentId: botId,
      ...rangeParams(days),
      limit: 200,
    });
    const status = tasks.cacheStatus ?? {};
    const counting =
      (typeof status.status === "string" && status.status !== "fresh") ||
      tasks.sessions.some((each) => each.computing === true);
    if (!counting) break;
    expect(Date.now(), `${botId}'s tasks are still being counted`).toBeLessThan(deadline);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const named = new Map<string, Set<string>>();
  const sendersRead = new Set<string>();
  let expected = 0;
  let unconfirmed = 0;
  for (const task of tasks.sessions.filter((each) => Number(each.usage?.totalTokens ?? 0) > 0)) {
    const history = await historyOf(task.key);
    for (const row of history) {
      const provenance = row.provenance as Json | undefined;
      const key = row.idempotencyKey;
      if (provenance?.kind !== "inter_session" || typeof key !== "string" || !key.endsWith(":user"))
        continue;
      const source = String(provenance.sourceSessionKey);
      if (!sendersRead.has(source)) {
        sendersRead.add(source);
        for (const each of await historyOf(source)) {
          if (each.role !== "toolResult" || each.toolName !== "sessions_send") continue;
          const text = (each.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
          const result = JSON.parse(text) as {
            runId?: string;
            sessionKey?: string;
            status?: string;
          };
          if (!result.runId || !result.sessionKey || result.status === "forbidden") continue;
          named.set(
            result.sessionKey,
            (named.get(result.sessionKey) ?? new Set()).add(result.runId),
          );
        }
      }
      const runId = key.slice(0, -":user".length);
      const { tokens } = runIn(history, runId, within);
      if (named.get(task.key)?.has(runId)) expected += tokens;
      else unconfirmed += tokens;
    }
  }
  return { expected, unconfirmed };
}

/** A bot's Usage page for this week, once the gateway's total includes what happened by `since`. */
async function settledWeek(bot: string, botId: string, since: number) {
  await expect
    .poll(async () => (await gatewayTotal(botId, "week")).asOf > since, {
      timeout: 90_000,
      intervals: [2_000],
    })
    .toBe(true);
  await gatewayAgrees(botId, "week");
  await usagePage(page, bot);
  await page.getByTestId("usage-page").getByRole("radio", { name: "This week" }).click();
  await expect(page.getByTestId("usage-source")).not.toContainText("still being counted", {
    timeout: 60_000,
  });
  await expect(page.getByTestId("usage-sources")).toBeVisible({ timeout: 30_000 });
}

/**
 * The open page's Messages from other bots line against the figure worked out from the
 * gateway's records. On a gateway many checks have used (a runner's shard), a bot's task
 * histories can be longer than the page reads, or have more sending tasks: the page then says
 * "Partial: some tasks weren't read in full", and its line is a part of the figure, never
 * more and never less than the run the check made sure of. Otherwise it is the figure exactly.
 */
async function otherBotsLine(expected: number, atLeast: number) {
  const partial = page.getByTestId("usage-page").getByText(/Partial: some tasks weren't read/);
  const line = () => bar(page, "usage-sources", "Messages from other bots");
  if (await partial.count()) {
    const shown = await line();
    expect(shown).toBeLessThanOrEqual(expected);
    expect(shown).toBeGreaterThanOrEqual(atLeast);
  } else await expect.poll(line, { timeout: 30_000 }).toBe(expected);
}

test("F-131: the Messages from other bots line counts only the run a send's result names", async () => {
  test.setTimeout(300_000);
  // Marlow's main task holds a run a person started and a run Pip's send started (the seed's
  // "Ask Marlow about the plan"); Pip's task holds the send's result, which names that run.
  const named = (await historyOf("agent:pip:ask-marlow"))
    .filter((each) => each.role === "toolResult" && each.toolName === "sessions_send")
    .map((each) => {
      const text = (each.content as Array<{ text?: string }>)
        .map((block) => block.text ?? "")
        .join("");
      return JSON.parse(text) as { runId?: string; sessionKey?: string };
    })
    .filter((each) => each.sessionKey === "agent:marlow:main" && each.runId);
  expect(named).toHaveLength(1);
  const recipient = await historyOf("agent:marlow:main");
  const runs = [
    ...new Set(
      recipient.flatMap((each) => {
        const runId = (each.__openclaw as Json | undefined)?.runId;
        return each.role === "assistant" && typeof runId === "string" ? [runId] : [];
      }),
    ),
  ];
  // The recipient task has runs the send does not name: the person's.
  expect(runs.length).toBeGreaterThan(1);
  const sent = runIn(recipient, named[0]!.runId!).tokens;
  expect(sent).toBeGreaterThan(0);
  const taskTotal = runs.reduce((sum, runId) => sum + runIn(recipient, runId).tokens, 0);
  expect(taskTotal).toBeGreaterThan(sent);
  // A send whose call returns before Marlow answers (`accepted`, naming Marlow's run): when
  // Marlow answers, the gateway delivers the reply into Pip's task as another bot's message
  // (`inter_session` from `sessions_send`, its source Marlow's task), and the run it starts
  // there is one that no send's result names. The line must leave it out.
  const slow = await gatewayCall<{ key: string }>("sessions.create", {
    agentId: "pip",
    label: `Slow send ${STAMP}`,
  });
  await gatewayCall("chat.send", {
    sessionKey: slow.key,
    message: "Message your slow partner about the plan.",
    idempotencyKey: `${slow.key}-slow`,
  });
  const lateReply = async () => {
    const history = await historyOf(slow.key);
    const started = history.find(
      (each) =>
        (each.provenance as Json | undefined)?.kind === "inter_session" &&
        (each.provenance as Json | undefined)?.sourceSessionKey === "agent:marlow:main",
    );
    const key = started?.idempotencyKey;
    if (typeof key !== "string" || !key.endsWith(":user")) return { tokens: 0, at: 0 };
    return runIn(history, key.slice(0, -":user".length));
  };
  // Marlow takes 15 seconds to answer; then Pip answers the reply.
  await expect
    .poll(async () => (await lateReply()).tokens, { timeout: 150_000, intervals: [2_000] })
    .toBeGreaterThan(0);
  const reply = await lateReply();
  // Marlow: the seed's send and the slow one each name their run.
  const marlow = await otherBots("marlow");
  expect(marlow.expected).toBeGreaterThanOrEqual(sent);
  await settledWeek("Marlow", "marlow", reply.at);
  // Never the recipient task's whole total charged to the send, never the person's run:
  // exactly the runs the results name.
  await otherBotsLine(marlow.expected, sent);
  const sum = async () =>
    (
      await Promise.all(
        ["Messages from people", "Routines", "Messages from other bots", "Not attributed"].map(
          (name) => bar(page, "usage-sources", name),
        ),
      )
    ).reduce((total, each) => total + each, 0);
  const marlowTotal = (await gatewayTotal("marlow", "week")).total;
  await expect.poll(sum, { timeout: 30_000 }).toBe(marlowTotal);
  // Pip: the late reply's run is another bot's message no result names, and is left out.
  const pip = await otherBots("pip");
  expect(pip.unconfirmed).toBeGreaterThanOrEqual(reply.tokens);
  await settledWeek("Pip", "pip", reply.at);
  await otherBotsLine(pip.expected, 0);
  const pipTotal = (await gatewayTotal("pip", "week")).total;
  await expect.poll(sum, { timeout: 30_000 }).toBe(pipTotal);
});

test("F-234: a weekly budget set on one device is shown with the same value after a reload and on the second device", async () => {
  await usagePage(page, "Otto");
  const week = (await gatewayTotal("otto", "week")).total;
  const tokens = Math.max(1_000, week * 3);
  await setBudget(page, "Weekly", tokens);
  await expect
    .poll(() => meter(page), { timeout: 60_000 })
    .toEqual({ used: week, tokens, words: "this week" });
  const shown = await meter(page);
  await expect(page.getByTestId("usage-page")).toContainText("Shown only");
  // The gateway keeps it, as the person's preference.
  expect(await keptBudgets()).toEqual([
    expect.objectContaining({ botId: "otto", routineId: null, period: "weekly", tokens, timeZone }),
  ]);
  // After a reload.
  await page.reload();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
  await usagePage(page, "Otto");
  await expect.poll(() => meter(page), { timeout: 60_000 }).toEqual(shown);
  // On the second device, which only reads and is in another time zone: the same value,
  // counted over the budget's own days in its own zone, named as that zone, and no way to change it.
  await usagePage(reader, "Otto");
  await expect.poll(() => meter(reader), { timeout: 60_000 }).toEqual(shown);
  const days = ownDays("weekly", timeZone);
  await expect(reader.getByTestId("budget-window")).toContainText(
    `this week (${days.startDate === days.endDate ? dayName(days.endDate) : `${dayName(days.startDate)} to ${dayName(days.endDate)}`}, ${timeZone})`,
  );
  await expect(reader.getByTestId("budget")).toContainText(`Resets Monday at 00:00, ${timeZone}.`);
  await expect(reader.getByTestId("budget-edit")).toHaveCount(0);
  await expect(reader.getByTestId("budget-new")).toHaveCount(0);
  await shot(page, "usage-page");
});

test("F-234: a routine's budget counts that routine's runs, from its own tasks", async () => {
  test.setTimeout(180_000);
  const added = parseJsonOutput<{ id: string }>(
    await openclaw([
      "cron",
      "add",
      "--agent",
      "otto",
      "--every",
      "7d",
      "--display-name",
      `Weekly cleanup ${STAMP}`,
      "--message",
      "Routine check-in.",
      "--session",
      "isolated",
      `weekly-cleanup-${STAMP}`,
      "--json",
    ]),
  );
  routineId = added.id;
  // A routine that runs in a task it names, beside everything else there: its use can't be told
  // apart from the task's, so it is not offered.
  const shared = parseJsonOutput<{ id: string }>(
    await openclaw([
      "cron",
      "add",
      "--agent",
      "otto",
      "--every",
      "7d",
      "--display-name",
      `Shared notes ${STAMP}`,
      "--message",
      "Routine check-in.",
      "--session",
      `session:agent:otto:budget-notes-${STAMP}`,
      `shared-notes-${STAMP}`,
      "--json",
    ]),
  );
  sharedRoutineId = shared.id;
  await openclaw(["cron", "run", routineId]);
  const routineKey = `agent:otto:cron:${routineId}`;
  const routineTotal = async () => {
    const result = await gateway.request<{ sessions: Array<{ key: string; usage?: Json }> }>(
      "sessions.usage",
      { agentId: "otto", ...rangeParams(rangeFor("daily", Date.now(), timeZone)), limit: 200 },
    );
    return result.sessions
      .filter((each) => each.key === routineKey || each.key.startsWith(`${routineKey}:`))
      .reduce((sum, each) => sum + Number(each.usage?.totalTokens ?? 0), 0);
  };
  await expect.poll(routineTotal, { timeout: 90_000, intervals: [2_000] }).toBeGreaterThan(0);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Usage", exact: true }).click();
  await settings.getByTestId("budget-add").click();
  const target = settings.getByTestId("budget-target");
  await expect(target.locator("option", { hasText: `Weekly cleanup ${STAMP}` })).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(target.locator("option", { hasText: `Shared notes ${STAMP}` })).toHaveCount(0);
  await target.selectOption({ label: `Routine Weekly cleanup ${STAMP} (Otto)` });
  const form = settings.getByTestId("budget-form");
  await form.getByRole("radio", { name: "Daily" }).click();
  await form.getByTestId("budget-tokens").fill("1000");
  await form.getByTestId("budget-save").click();
  const row = settings.locator(`[data-budget="routine:${routineId}"]`);
  const expected = await routineTotal();
  await expect(row).toContainText(
    new RegExp(
      `Routine Weekly cleanup ${STAMP} \\(Otto\\) · daily · ${expected.toLocaleString("en-US")} of 1,000 tokens today`,
    ),
    { timeout: 60_000 },
  );
  expect(await keptBudgets()).toContainEqual(
    expect.objectContaining({ botId: "otto", routineId, period: "daily", tokens: 1000 }),
  );
  await page.keyboard.press("Escape");
});

test("F-234: a Daily and a Weekly budget are each counted over their own days, as the gateway counts them", async () => {
  // The days are worked out here, apart from the app's date code, and the gateway is asked for
  // its own total over them.
  const daily = ownDays("daily", timeZone);
  const weekly = ownDays("weekly", timeZone);
  expect(weekly.endDate).toBe(daily.startDate);
  await usagePage(page, "Otto");
  await setBudget(page, "Daily", 1_000_000);
  const today = await gatewayTotal("otto", daily);
  await expect
    .poll(() => meter(page))
    .toEqual({ used: today.total, tokens: 1_000_000, words: "today" });
  await expect(page.getByTestId("budget-window")).toContainText(
    `today (${dayName(daily.startDate)}, your time)`,
  );
  await expect(page.getByTestId("budget")).toContainText("Resets at 00:00, your time.");
  await setBudget(page, "Weekly", 1_000_000);
  const week = await gatewayTotal("otto", weekly);
  await expect
    .poll(() => meter(page))
    .toEqual({ used: week.total, tokens: 1_000_000, words: "this week" });
  await expect(page.getByTestId("budget-window")).toContainText(
    `this week (${weekly.startDate === weekly.endDate ? dayName(weekly.endDate) : `${dayName(weekly.startDate)} to ${dayName(weekly.endDate)}`}, your time)`,
  );
  await expect(page.getByTestId("budget")).toContainText("Resets Monday at 00:00, your time.");
  expect(week.total).toBeGreaterThanOrEqual(today.total);
  // Changing only the amount keeps the budget's time zone.
  expect(await keptBudgets()).toContainEqual(
    expect.objectContaining({ botId: "otto", period: "weekly", timeZone }),
  );
});

test("F-396: the warning appears in the bot's task once the gateway's figure passes 80 percent, and a send still works", async () => {
  test.setTimeout(420_000);
  // A task of Juniper's own for this check.
  const label = `Budget check ${STAMP}`;
  const created = await gatewayCall<{ key: string }>("sessions.create", { agentId: "main", label });
  await botRow(page, "Juniper").first().click();
  await expect(page.getByTestId("task").filter({ hasText: label })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId("task").filter({ hasText: label }).first().click();
  // Enough use this week that one more run passes 80 percent of the first budget, and that
  // the smallest budget, 1,000 tokens, is reached afterwards: at least 900 tokens before it.
  let before = (await gatewayTotal("main", "week")).total;
  for (let run = 0; before < 900 && run < 6; run += 1) {
    await gatewayCall("chat.send", {
      sessionKey: created.key,
      message: "Warm-up for the budget check.",
      idempotencyKey: `${created.key}-warm-${run}`,
    });
    const was = before;
    await expect
      .poll(async () => (await gatewayTotal("main", "week")).total, { timeout: 120_000 })
      .toBeGreaterThan(was);
    before = (await gatewayTotal("main", "week")).total;
  }
  expect(before).toBeGreaterThanOrEqual(900);
  // A weekly budget the next run passes 80 percent of, and not 100.
  const tokens = Math.max(1_000, Math.ceil((before + 100) / 0.8));
  await usagePage(page, "Juniper");
  await setBudget(page, "Weekly", tokens);
  await expect.poll(async () => (await meter(page)).used, { timeout: 60_000 }).toBe(before);
  await expect(page.getByTestId("budget-line")).toHaveCount(0);
  await expect(page.getByTestId("budget-warned")).toHaveCount(0);
  // The person sends; the run goes ahead and answers.
  await page.getByTestId("composer-input").fill("Hello from the budget check.");
  await page.getByTestId("composer-input").press("Enter");
  await expect(page.getByTestId("transcript")).toContainText("Hello from the budget check.", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("transcript")).toContainText(
    "This is the scripted development model",
    {
      timeout: 60_000,
    },
  );
  // Once the gateway's own figure includes the run, the line says what it reports.
  await expect
    .poll(async () => (await gatewayTotal("main", "week")).total, { timeout: 120_000 })
    .toBeGreaterThan(before);
  const after = (await gatewayTotal("main", "week")).total;
  const percent = Math.floor((after / tokens) * 100);
  expect(percent).toBeGreaterThanOrEqual(80);
  expect(percent).toBeLessThan(100);
  const line = page.getByTestId("budget-line");
  await expect(line).toBeVisible({ timeout: 180_000 });
  await expect(line).toHaveText(new RegExp(`^Juniper has used ${percent}% of its weekly budget: `));
  await expect(page.getByTestId("budget-warned")).toContainText(
    `Juniper has used ${percent}% of its weekly budget.`,
  );
  await shot(page, "conversation-warned");
  // Lowered below what was used: reached, said as a warning, and a send still goes ahead.
  await setBudget(page, "Weekly", 1_000);
  const note = page.getByTestId("budget-reached-note");
  await expect(note).toHaveText(
    /^Juniper has reached its weekly warning budget\. Runs continue when this warning appears: nothing stops Juniper, here or in other apps, channels or routines\.Raise budget$/,
    { timeout: 60_000 },
  );
  await page.getByTestId("composer-input").fill("Still there?");
  await page.getByTestId("composer-input").press("Enter");
  await expect(page.getByTestId("transcript")).toContainText("Still there?", { timeout: 30_000 });
  await expect
    .poll(
      async () =>
        (await page.getByTestId("transcript").innerText()).split(
          "This is the scripted development model",
        ).length - 1,
      { timeout: 60_000 },
    )
    .toBe(2);
  await expect(page.getByText(/won't send|didn't start|was stopped/)).toHaveCount(0);
  await shot(page, "composer-reached");
  // The second device, which only reads, sees the same note and no Raise budget.
  await botRow(reader, "Juniper").first().click();
  await reader.getByTestId("task").filter({ hasText: label }).first().click();
  await expect(reader.getByTestId("budget-reached-note")).toContainText(
    "Juniper has reached its weekly warning budget.",
    { timeout: 90_000 },
  );
  await expect(reader.getByTestId("raise-from-composer")).toHaveCount(0);
});

test("a read-only connection sees the figures and every budget, and cannot set or change one", async () => {
  await usagePage(reader, "Otto");
  // The page's week is the reader's own, in its own time zone.
  const expected = await gatewayTotal("otto", "week", READER_ZONE);
  await expect.poll(() => shownTokens(reader)).toMatchObject({ total: expected.total });
  await expect(reader.getByTestId("budget-meter")).toBeVisible();
  await expect(reader.getByTestId("budget-edit")).toHaveCount(0);
  await reader.keyboard.press("ControlOrMeta+,");
  const settings = reader.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(settings.getByTestId("budgets")).toContainText("Otto · weekly");
  await expect(settings.getByTestId("budget-add")).toHaveCount(0);
  // The host refuses the command even when a viewer sends it, because it only reads.
  await expect(
    hostCommand(reader, {
      type: "changeBudget",
      change: {
        op: "set",
        budget: { botId: "pip", routineId: null, period: "daily", tokens: 5_000, timeZone },
      },
    }),
  ).resolves.toEqual({
    ok: false,
    error: "This host only reads; it does not change budgets.",
  });
  expect((await keptBudgets()).some((each) => each.botId === "pip")).toBe(false);
  await reader.keyboard.press("Escape");
});
