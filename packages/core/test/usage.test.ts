// Usage and warning budgets (docs/design/controls.md, sections 16 and 17), on
// the shapes OpenClaw 2026.10.6 returned on a development gateway: `usage.cost`,
// `sessions.usage`, `chat.history` rows and `usage.status`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBridgeCommand } from "../src/bridge.ts";
import {
  COUNT_AFTER_RUN_MS,
  COUNT_COUNTING_MS,
  COUNT_EVERY_MS,
  MAX_USAGE_REPORTS,
  MAX_WAITING_USAGE_REPORTS,
  UsageEngine,
  type UsageContext,
} from "../src/usage-engine.ts";
import {
  applyBudgetChange,
  BudgetError,
  budgetPercent,
  budgetTokens,
  BUDGETS_PREF_KEY,
  costOf,
  currentCount,
  dateIn,
  figureOf,
  initialUsage,
  isoWeekday,
  MAX_BUDGETS,
  parseBudgets,
  parseLimits,
  rangeFor,
  routineOfKey,
  routinesOf,
  runsOfHistory,
  sentRunIds,
  tasksOf,
  type BudgetInput,
  type UsageState,
} from "../src/usage.ts";

// Thursday 19 November 2026, 06:00 UTC: 01:00 in New York, 15:00 in Tokyo.
const NOW = Date.UTC(2026, 10, 19, 6, 0, 0);
const NY = "America/New_York";

const totals = (input: number, output: number, cost: Partial<Record<string, number>> = {}) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  totalCost: 0,
  inputCost: 0,
  outputCost: 0,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  missingCostEntries: 0,
  ...cost,
});
const fresh = { status: "fresh", cachedFiles: 4, pendingFiles: 0, staleFiles: 0 };

const assistant = (runId: string, at: number, tokens = 200) => ({
  role: "assistant",
  provider: "scripted",
  model: "dev-1",
  usage: {
    input: tokens * 0.6,
    output: tokens * 0.4,
    totalTokens: tokens,
    cacheRead: 0,
    cacheWrite: 0,
  },
  timestamp: at,
  __openclaw: { runId },
});
const person = (runId: string, at: number) => ({
  role: "user",
  timestamp: at,
  idempotencyKey: `${runId}:user`,
  __openclaw: { senderIdentity: { type: "profile", id: "gateway-owner" } },
  content: "Reply with a note on Saturday's plan.",
});
const fromBot = (runId: string, at: number, source: string) => ({
  role: "assistant",
  timestamp: at,
  idempotencyKey: `${runId}:user`,
  provenance: {
    kind: "inter_session",
    sourceSessionKey: source,
    sourceChannel: "webchat",
    sourceTool: "sessions_send",
  },
  content: "#reply Could you look over the plan?",
});
const sendResult = (recipient: string, runId: string | null, status = "ok") => ({
  role: "toolResult",
  toolName: "sessions_send",
  details: { sessionKey: recipient },
  isError: false,
  content: [
    {
      type: "text",
      text: JSON.stringify({ ...(runId ? { runId } : {}), sessionKey: recipient, status }),
    },
  ],
});

describe("periods", () => {
  it("F-234: a Daily budget counts today and a Weekly one Monday to today, in its own time zone", () => {
    expect(dateIn(NOW, NY)).toBe("2026-11-19");
    expect(dateIn(NOW, "Pacific/Pago_Pago")).toBe("2026-11-18");
    expect(isoWeekday("2026-11-16")).toBe(1);
    expect(isoWeekday("2026-11-22")).toBe(7);
    expect(rangeFor("daily", NOW, NY)).toEqual({
      startDate: "2026-11-19",
      endDate: "2026-11-19",
      timeZone: NY,
    });
    expect(rangeFor("weekly", NOW, NY)).toEqual({
      startDate: "2026-11-16",
      endDate: "2026-11-19",
      timeZone: NY,
    });
    // On a Monday the week is that one day; on a Sunday it runs back to Monday.
    expect(rangeFor("weekly", Date.UTC(2026, 10, 16, 12), NY).startDate).toBe("2026-11-16");
    expect(rangeFor("weekly", Date.UTC(2026, 10, 23, 3), NY)).toMatchObject({
      startDate: "2026-11-16",
      endDate: "2026-11-22",
    });
    expect(rangeFor("month", NOW, NY)).toMatchObject({
      startDate: "2026-10-21",
      endDate: "2026-11-19",
    });
    // The same moment is another day, and another week, somewhere else.
    expect(rangeFor("weekly", Date.UTC(2026, 10, 16, 3), NY).startDate).toBe("2026-11-09");
    expect(rangeFor("weekly", Date.UTC(2026, 10, 16, 3), "Asia/Tokyo").startDate).toBe(
      "2026-11-16",
    );
  });

  it("a run is in a period when its date in the period's time zone is one of the days asked of the gateway, across a change of the clocks", () => {
    const runAt = (at: number, range: { startDate: string; endDate: string; timeZone: string }) =>
      runsOfHistory([person("r", at - 1), assistant("r", at)], range).map((run) => run.tokens);
    // Cairo's 24 April 2026 has no midnight: the clocks go from 23:59 on the 23rd to 01:00.
    // The gateway's day starts at 22:00 UTC, so a run at 21:30 UTC (23:30 on the 23rd) is not in it.
    const cairo = { startDate: "2026-04-24", endDate: "2026-04-24", timeZone: "Africa/Cairo" };
    expect(runAt(Date.parse("2026-04-23T21:30:00Z"), cairo)).toEqual([]);
    expect(runAt(Date.parse("2026-04-23T22:00:00Z"), cairo)).toEqual([200]);
    // After the change it is UTC+3: the day has 23 hours and ends at 21:00 UTC.
    expect(runAt(Date.parse("2026-04-24T20:59:59Z"), cairo)).toEqual([200]);
    expect(runAt(Date.parse("2026-04-24T21:00:00Z"), cairo)).toEqual([]);
    // New York's 1 November 2026 has 25 hours, 04:00 UTC to 05:00 UTC the next day.
    const fall = { startDate: "2026-11-01", endDate: "2026-11-01", timeZone: NY };
    expect(runAt(Date.parse("2026-11-01T03:59:59Z"), fall)).toEqual([]);
    expect(runAt(Date.parse("2026-11-02T04:59:59Z"), fall)).toEqual([200]);
    expect(runAt(Date.parse("2026-11-02T05:00:00Z"), fall)).toEqual([]);
  });
});

describe("the gateway's figures", () => {
  it("F-232: tokens are the gateway's totals, and the cost is its estimate or a stated absence, never a zero", () => {
    const figure = figureOf({
      updatedAt: 1234,
      totals: totals(1080, 720, { totalCost: 0.42, inputCost: 0.3, outputCost: 0.12 }),
      cacheStatus: fresh,
    });
    expect(figure).toEqual({
      tokens: { input: 1080, output: 720, cacheRead: 0, cacheWrite: 0, total: 1800 },
      cost: { status: "estimate", usd: 0.42 },
      asOf: 1234,
      counting: false,
    });
    expect(costOf(totals(1, 1, { totalCost: 0.1, inputCost: 0.1, missingCostEntries: 2 }))).toEqual(
      { status: "partial", usd: 0.1, unpriced: 2 },
    );
    expect(costOf(totals(1, 1, { missingCostEntries: 3 }))).toEqual({
      status: "unavailable",
      unpriced: 3,
    });
    // A configured price of zero is an estimate of zero, not an absence.
    expect(costOf(totals(1, 1))).toEqual({ status: "estimate", usd: 0 });
  });

  it("F-232: says the figure is still being counted when the gateway's records are being read", () => {
    expect(
      figureOf({
        totals: totals(1, 1),
        cacheStatus: { status: "refreshing", pendingFiles: 8, staleFiles: 8 },
      }).counting,
    ).toBe(true);
    expect(figureOf({ totals: totals(1, 1), cacheStatus: fresh }).counting).toBe(false);
    expect(figureOf({ totals: totals(1, 1) }).asOf).toBeNull();
  });

  it("F-232: an answer without totals is a failed read, never zero tokens and an estimate of $0.00", async () => {
    expect(() => figureOf({ updatedAt: 1, cacheStatus: fresh })).toThrow("had no totals");
    expect(() => figureOf(null)).toThrow("had no totals");
    // In a report: the bot whose answer had none is unavailable, the others are read.
    const gateway = fakeGateway();
    const empty: typeof gateway.request = async (method, raw) =>
      method === "usage.cost" && (raw as { agentId?: string }).agentId === "otto"
        ? { updatedAt: 1, cacheStatus: fresh }
        : gateway.request(method, raw);
    const { engine } = engineOn({ ...gateway, request: empty });
    const report = await engine.readReport({
      botId: null,
      period: "today",
      timeZone: NY,
      detail: false,
      bots: ["marlow", "otto"],
    });
    expect(report.bots).toEqual([
      expect.objectContaining({ botId: "marlow", error: null }),
      { botId: "otto", figure: null, error: "The gateway's answer had no totals." },
    ]);
    await expect(
      engine.readReport({ botId: "otto", period: "today", timeZone: NY, detail: false, bots: [] }),
    ).rejects.toThrow("had no totals");
    engine.onClose();
  });

  it("lists each task's share, a routine's task by its routine, and still-counted tasks", () => {
    const tasks = tasksOf({
      sessions: [
        { key: "agent:otto:disk-space", label: "Disk almost full", usage: totals(600, 400) },
        {
          key: "agent:otto:cron:f3ab2dfd-4f99",
          label: "Automation: weekly-cleanup",
          usage: totals(120, 80),
        },
        { key: "agent:otto:cert-renewal", usage: totals(0, 0) },
        { key: "agent:otto:counting", usage: null, computing: true },
      ],
    });
    expect(tasks.map((t) => [t.key, t.total, t.routineId, t.computing])).toEqual([
      ["agent:otto:disk-space", 1000, null, false],
      ["agent:otto:cron:f3ab2dfd-4f99", 200, "f3ab2dfd-4f99", false],
      ["agent:otto:counting", 0, null, true],
    ]);
    expect(routineOfKey("agent:otto:cron:abc:run:1")).toBe("abc");
    expect(routineOfKey("agent:otto:main")).toBeNull();
  });

  it("F-235: keeps the limits providers report with their window, reset time and the gateway's time, and nothing else", () => {
    const limits = parseLimits({
      updatedAt: 99,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "Weekly", usedPercent: 62, resetAt: 1795600000000 }, { label: "Bad" }],
        },
        { provider: "xai", displayName: "xAI", windows: [], error: "Timeout" },
        { displayName: "no provider" },
      ],
    });
    expect(limits).toEqual({
      status: "ok",
      updatedAt: 99,
      refreshing: false,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "Weekly", usedPercent: 62, resetAt: 1795600000000 }],
          error: null,
        },
        { provider: "xai", displayName: "xAI", windows: [], error: "Timeout" },
      ],
    });
    // The development gateway's answer: a time and no providers.
    expect(parseLimits({ updatedAt: 5, providers: [] }).providers).toEqual([]);
  });
});

describe("routines", () => {
  it("F-234: lists the routines that run in tasks of their own, and leaves out those whose runs share a task", () => {
    expect(
      routinesOf({
        jobs: [
          {
            id: "2d59561b",
            name: "heartbeat-main",
            agentId: "main",
            sessionTarget: "main",
            payload: { kind: "heartbeat" },
          },
          {
            id: "f3ab2dfd",
            name: "weekly-cleanup",
            displayName: "Weekly cleanup",
            agentId: "otto",
            sessionTarget: "isolated",
            payload: { kind: "agentTurn" },
          },
          {
            id: "c0ffee",
            name: "nightly",
            effectiveAgentId: "pip",
            sessionTarget: "current",
            sessionKey: "agent:pip:ask-marlow",
            payload: { kind: "agentTurn" },
          },
          // Runs in a task it names, beside everything else in that task (OpenClaw's cron
          // `session:` target): its use can't be told apart from the task's.
          {
            id: "notes",
            name: "daily-notes",
            agentId: "otto",
            sessionTarget: "session:agent:otto:daily-notes",
            payload: { kind: "agentTurn" },
          },
          // No target given: where it runs isn't established.
          { id: "unknown", name: "unknown", agentId: "otto", payload: { kind: "agentTurn" } },
          { id: "bad id!", agentId: "otto", sessionTarget: "isolated" },
        ],
      }),
    ).toEqual([
      { id: "f3ab2dfd", name: "Weekly cleanup", botId: "otto" },
      { id: "c0ffee", name: "nightly", botId: "pip" },
    ]);
  });
});

describe("where a bot's runs came from", () => {
  const T = Date.UTC(2026, 10, 19, 6);
  it("F-131: a run another bot's message started is told apart from a person's, by the row the gateway keyed to it", () => {
    const runs = runsOfHistory(
      [
        person("r1", T),
        assistant("r1", T + 1),
        fromBot("r2", T + 2, "agent:pip:ask-marlow"),
        assistant("r2", T + 3, 300),
        assistant("r2", T + 4, 100),
        assistant("r3", T + 5),
        assistant("r4", T - 10_000_000),
      ],
      { startDate: "2026-11-19", endDate: "2026-11-19", timeZone: NY },
    );
    expect(runs).toEqual([
      { runId: "r1", tokens: 200, trigger: "person", sourceKey: null },
      { runId: "r2", tokens: 400, trigger: "bot", sourceKey: "agent:pip:ask-marlow" },
      { runId: "r3", tokens: 200, trigger: "unknown", sourceKey: null },
    ]);
  });

  it("F-131: only runs a send's result names count as sent; a queued or refused send names none", () => {
    const named = sentRunIds([
      sendResult("agent:marlow:main", "r2"),
      sendResult("agent:marlow:main", null, "accepted"),
      sendResult("agent:otto:main", "r9", "forbidden"),
      { role: "toolResult", toolName: "read", content: "{}" },
      // Cut by the gateway to a display length: its first fields are still read.
      {
        role: "toolResult",
        toolName: "sessions_send",
        details: { sessionKey: "agent:pip:main" },
        content: [
          {
            type: "text",
            text: '{\n  "runId": "r7",\n  "sessionKey": "agent:pip:main",\n  "status": "ok",\n  "reply": "Happy to he…',
          },
        ],
      },
      // Cut before its status: whether it was refused is not known, so it names nothing.
      {
        role: "toolResult",
        toolName: "sessions_send",
        content: [{ type: "text", text: '{\n  "runId": "r8",\n  "sessionKey": "agent:otto:mai' }],
      },
    ]);
    expect([...named.entries()].map(([k, v]) => [k, [...v]])).toEqual([
      ["agent:marlow:main", ["r2"]],
      ["agent:pip:main", ["r7"]],
    ]);
  });
});

describe("budgets kept with the gateway", () => {
  const otto: BudgetInput = {
    botId: "otto",
    routineId: null,
    routineName: null,
    period: "weekly",
    tokens: 2_000_000,
    timeZone: NY,
  };

  it("S17: a budget is a whole number of 1,000 tokens or more, said in the form's words", () => {
    expect(budgetTokens("2,500,000")).toBe(2_500_000);
    expect(budgetTokens("900")).toBe("Enter a whole number of 1,000 or more.");
    expect(budgetTokens("1.5")).toBe("Enter a whole number of 1,000 or more.");
    expect(budgetTokens("")).toBe("Enter a whole number of 1,000 or more.");
    expect(() =>
      applyBudgetChange({ budgets: [] }, { op: "set", budget: { ...otto, tokens: 999 } }, NOW),
    ).toThrow(BudgetError);
  });

  it("F-234: one budget per bot and per routine, replaced when set again, at most 16", () => {
    let prefs = applyBudgetChange({ budgets: [] }, { op: "set", budget: otto }, NOW);
    prefs = applyBudgetChange(
      prefs,
      { op: "set", budget: { ...otto, period: "daily", tokens: 400_000 } },
      NOW + 1,
    );
    prefs = applyBudgetChange(
      prefs,
      {
        op: "set",
        budget: {
          ...otto,
          routineId: "f3ab2dfd",
          routineName: "weekly-cleanup",
          period: "daily",
          tokens: 200_000,
        },
      },
      NOW,
    );
    expect(prefs.budgets.map((b) => [b.id, b.period, b.tokens])).toEqual([
      ["bot:otto", "daily", 400_000],
      ["routine:f3ab2dfd", "daily", 200_000],
    ]);
    expect(
      applyBudgetChange(prefs, { op: "remove", id: "bot:otto" }, NOW).budgets.map((b) => b.id),
    ).toEqual(["routine:f3ab2dfd"]);
    let full = { budgets: [] as ReturnType<typeof parseBudgets>["budgets"] };
    for (let i = 0; i < MAX_BUDGETS; i += 1)
      full = applyBudgetChange(full, { op: "set", budget: { ...otto, botId: `bot${i}` } }, NOW);
    expect(() =>
      applyBudgetChange(full, { op: "set", budget: { ...otto, botId: "one-more" } }, NOW),
    ).toThrow("At most 16 budgets");
    // Replacing one of the sixteen is not one more.
    expect(
      applyBudgetChange(full, { op: "set", budget: { ...otto, botId: "bot3", tokens: 5000 } }, NOW)
        .budgets,
    ).toHaveLength(MAX_BUDGETS);
  });

  it("reads what the gateway holds as budgets, dropping what is not one", () => {
    const prefs = parseBudgets({
      rev: 3,
      budgets: [
        {
          botId: "otto",
          period: "weekly",
          tokens: 2_000_000,
          timeZone: NY,
          setAt: 1,
          extra: "dropped",
        },
        { botId: "otto", period: "daily", tokens: 1_000, timeZone: NY },
        { botId: "pip", period: "monthly", tokens: 5_000, timeZone: NY },
        { botId: "pip", period: "daily", tokens: 5_000, timeZone: "Not/AZone" },
        { botId: "bad id!", period: "daily", tokens: 5_000, timeZone: NY },
        "nonsense",
      ],
    });
    expect(prefs).toEqual({
      rev: 3,
      budgets: [
        {
          id: "bot:otto",
          botId: "otto",
          routineId: null,
          routineName: null,
          period: "weekly",
          tokens: 2_000_000,
          timeZone: NY,
          setAt: 1,
        },
      ],
    });
    expect(parseBudgets(null)).toEqual({ budgets: [] });
  });

  it("F-396: a budget's share is its count over its tokens, and a count from another period is not shown as this one's", () => {
    const budget = parseBudgets({
      budgets: [{ botId: "otto", period: "weekly", tokens: 2_000_000, timeZone: NY }],
    }).budgets[0]!;
    expect(budgetPercent(budget, 1_640_000)).toBe(82);
    expect(budgetPercent(budget, null)).toBeNull();
    const usage: UsageState = {
      ...initialUsage,
      budgets: [budget],
      counts: [
        {
          budgetId: "bot:otto",
          range: rangeFor("weekly", NOW, NY),
          used: 1_640_000,
          asOf: NOW,
          counting: false,
          partial: false,
          error: null,
        },
      ],
    };
    expect(currentCount(usage, budget, NOW)?.used).toBe(1_640_000);
    // A week later the same count belongs to last week.
    expect(currentCount(usage, budget, NOW + 7 * 86_400_000)).toBeNull();
  });
});

/** A gateway that answers the usage methods and `users.prefs` from fixed records. */
function fakeGateway(options: { identity?: boolean; meddle?: number; counting?: boolean } = {}) {
  let prefs: unknown = undefined;
  let meddle = options.meddle ?? 0;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const T = Date.UTC(2026, 10, 19, 6);
  const histories: Record<string, unknown[]> = {
    "agent:marlow:main": [
      person("m1", T),
      assistant("m1", T + 1),
      fromBot("m2", T + 2, "agent:pip:ask-marlow"),
      assistant("m2", T + 3),
    ],
    "agent:marlow:other": [person("m3", T), assistant("m3", T + 1, 500)],
    "agent:pip:ask-marlow": [
      person("p1", T),
      assistant("p1", T + 1),
      sendResult("agent:marlow:main", "m2"),
      assistant("p1", T + 4),
    ],
  };
  const request = async (method: string, raw: unknown): Promise<unknown> => {
    const params = (raw ?? {}) as Record<string, unknown>;
    calls.push({ method, params });
    switch (method) {
      case "users.prefs.get":
        if (options.identity === false) return { status: "no_durable_identity" };
        return { status: "ok", entries: prefs === undefined ? {} : { [BUDGETS_PREF_KEY]: prefs } };
      case "users.prefs.set": {
        if (options.identity === false) return { status: "no_durable_identity" };
        if (meddle > 0) {
          meddle -= 1;
          prefs = {
            rev: 7,
            budgets: [{ botId: "pip", period: "daily", tokens: 9_000, timeZone: NY }],
          };
          return { status: "conflict" };
        }
        const expected = (params.expectedEntries as Record<string, unknown>)[BUDGETS_PREF_KEY];
        if (JSON.stringify(expected ?? null) !== JSON.stringify(prefs ?? null))
          return { status: "conflict" };
        prefs = (params.entries as Record<string, unknown>)[BUDGETS_PREF_KEY];
        return { status: "ok" };
      }
      case "usage.cost": {
        const agent = params.agentId ?? "all";
        const week = params.startDate !== params.endDate;
        const byAgent: Record<string, number> = {
          marlow: week ? 1700 : 900,
          otto: week ? 1800 : 1800,
          pip: 600,
          all: 4100,
        };
        return {
          updatedAt: 4242,
          totals: totals(byAgent[agent as string] ?? 0, 0),
          cacheStatus: options.counting ? { status: "refreshing", pendingFiles: 3 } : fresh,
        };
      }
      case "sessions.usage":
        return {
          updatedAt: 4343,
          sessions:
            params.agentId === "otto"
              ? [
                  { key: "agent:otto:cron:job1", usage: totals(120, 80) },
                  { key: "agent:otto:disk-space", usage: totals(1000, 600) },
                ]
              : [
                  { key: "agent:marlow:main", usage: totals(400, 0) },
                  { key: "agent:marlow:other", usage: totals(500, 0) },
                ],
          cacheStatus: fresh,
        };
      case "chat.history":
        return { messages: histories[params.sessionKey as string] ?? [], hasMore: false };
      case "usage.status":
        return { updatedAt: 77, providers: [] };
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  return { request, calls, prefs: () => prefs };
}

function engineOn(gateway: ReturnType<typeof fakeGateway>, now = () => NOW) {
  let usage: UsageState = initialUsage;
  const ctx: UsageContext = {
    request: gateway.request,
    get: () => usage,
    update: (change) => {
      usage = change(usage);
    },
    connected: () => true,
    now,
    log: () => {},
  };
  return { engine: new UsageEngine(ctx), usage: () => usage };
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe("the usage engine", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("F-234: a budget set on one device is read back by another, with the same value", async () => {
    const gateway = fakeGateway();
    const one = engineOn(gateway);
    const two = engineOn(gateway);
    await one.engine.changeBudget({
      op: "set",
      budget: {
        botId: "otto",
        routineId: null,
        routineName: null,
        period: "weekly",
        tokens: 2_500_000,
        timeZone: NY,
      },
    });
    expect(one.usage().budgets.map((b) => [b.id, b.period, b.tokens])).toEqual([
      ["bot:otto", "weekly", 2_500_000],
    ]);
    two.engine.onHello();
    await flush();
    expect(two.usage()).toMatchObject({
      budgetsStatus: "ok",
      rev: 1,
      budgets: [{ id: "bot:otto", period: "weekly", tokens: 2_500_000 }],
    });
    // A change on the first device reaches the second on the gateway's change event.
    await one.engine.changeBudget({
      op: "set",
      budget: {
        botId: "otto",
        routineId: null,
        routineName: null,
        period: "weekly",
        tokens: 3_000_000,
        timeZone: NY,
      },
    });
    two.engine.onPrefsChanged([BUDGETS_PREF_KEY]);
    await flush();
    expect(two.usage().budgets[0]?.tokens).toBe(3_000_000);
    one.engine.onClose();
    two.engine.onClose();
  });

  it("applies a change again to what another device wrote meanwhile, and keeps both", async () => {
    const gateway = fakeGateway({ meddle: 1 });
    const { engine, usage } = engineOn(gateway);
    await engine.changeBudget({
      op: "set",
      budget: {
        botId: "otto",
        routineId: null,
        routineName: null,
        period: "daily",
        tokens: 5_000,
        timeZone: NY,
      },
    });
    expect(usage().budgets.map((b) => b.id)).toEqual(["bot:pip", "bot:otto"]);
    expect(usage().rev).toBe(8);
    engine.onClose();
  });

  it("refuses a budget when the gateway keeps no preferences for this connection", async () => {
    const { engine, usage } = engineOn(fakeGateway({ identity: false }));
    await expect(
      engine.changeBudget({
        op: "set",
        budget: {
          botId: "otto",
          routineId: null,
          routineName: null,
          period: "daily",
          tokens: 5_000,
          timeZone: NY,
        },
      }),
    ).rejects.toThrow("keeps no preferences");
    engine.onHello();
    await flush();
    expect(usage().budgetsStatus).toBe("unavailable");
    engine.onClose();
  });

  it("F-234 F-396: counts a Daily and a Weekly budget over their own days, with the same request the Usage page makes", async () => {
    const gateway = fakeGateway();
    const { engine, usage } = engineOn(gateway);
    await engine.changeBudget({
      op: "set",
      budget: {
        botId: "marlow",
        routineId: null,
        routineName: null,
        period: "daily",
        tokens: 1_000,
        timeZone: NY,
      },
    });
    await engine.changeBudget({
      op: "set",
      budget: {
        botId: "otto",
        routineId: null,
        routineName: null,
        period: "weekly",
        tokens: 2_000,
        timeZone: NY,
      },
    });
    await engine.countBudgets();
    const counts = Object.fromEntries(usage().counts.map((c) => [c.budgetId, c]));
    expect(counts["bot:marlow"]).toMatchObject({
      used: 900,
      asOf: 4242,
      range: { startDate: "2026-11-19", endDate: "2026-11-19" },
    });
    expect(counts["bot:otto"]).toMatchObject({
      used: 1800,
      range: { startDate: "2026-11-16", endDate: "2026-11-19" },
    });
    const counted = gateway.calls.filter((c) => c.method === "usage.cost").map((c) => c.params);
    const report = await engine.readReport({
      botId: "otto",
      period: "week",
      timeZone: NY,
      detail: false,
      bots: [],
    });
    // The page's week and the Weekly budget are one request, so one number.
    expect(gateway.calls.at(-1)!.params).toEqual(counted.find((p) => p.agentId === "otto"));
    expect(report.figure.tokens.total).toBe(counts["bot:otto"]!.used);
    engine.onClose();
  });

  it("F-234: a routine's budget counts that routine's tasks only", async () => {
    const gateway = fakeGateway();
    const { engine, usage } = engineOn(gateway);
    await engine.changeBudget({
      op: "set",
      budget: {
        botId: "otto",
        routineId: "job1",
        routineName: "Weekly cleanup",
        period: "daily",
        tokens: 1_000,
        timeZone: NY,
      },
    });
    await engine.countBudgets();
    expect(usage().counts).toMatchObject([
      { budgetId: "routine:job1", used: 200, asOf: 4343, partial: false },
    ]);
    engine.onClose();
  });

  it("F-234: a routine's count read from a list the gateway capped is partial, never a settled figure", async () => {
    const gateway = fakeGateway();
    // The gateway lists at most `limit` tasks, the most recently updated first; its totals cover
    // every task. Here the routine's task is past the cap.
    const capped: typeof gateway.request = async (method, raw) => {
      if (method !== "sessions.usage") return gateway.request(method, raw);
      const params = raw as { limit: number };
      return {
        updatedAt: 4343,
        cacheStatus: fresh,
        sessions: Array.from({ length: params.limit }, (_, i) => ({
          key: `agent:otto:task-${i}`,
          usage: totals(1, 0),
        })),
        totals: totals(params.limit + 1200, 0),
      };
    };
    const { engine, usage } = engineOn({ ...gateway, request: capped });
    await engine.changeBudget({
      op: "set",
      budget: {
        botId: "otto",
        routineId: "job1",
        routineName: "Weekly cleanup",
        period: "daily",
        tokens: 1_000,
        timeZone: NY,
      },
    });
    await engine.countBudgets();
    expect(usage().counts).toMatchObject([{ budgetId: "routine:job1", used: 0, partial: true }]);
    engine.onClose();
  });

  it("F-396: counts again after a budgeted bot's run ends, once the gateway's total can include it, and every minute", async () => {
    vi.useFakeTimers();
    const gateway = fakeGateway();
    const { engine } = engineOn(gateway, () => Date.now());
    await engine.changeBudget({
      op: "set",
      budget: {
        botId: "otto",
        routineId: null,
        routineName: null,
        period: "daily",
        tokens: 1_000,
        timeZone: NY,
      },
    });
    await vi.advanceTimersByTimeAsync(10);
    const counted = () => gateway.calls.filter((c) => c.method === "usage.cost").length;
    const first = counted();
    expect(first).toBe(1);
    engine.onRunEnded("pip");
    engine.onRunEnded("otto");
    await vi.advanceTimersByTimeAsync(COUNT_AFTER_RUN_MS - 100);
    expect(counted()).toBe(first);
    await vi.advanceTimersByTimeAsync(200);
    expect(counted()).toBe(first + 1);
    await vi.advanceTimersByTimeAsync(COUNT_EVERY_MS + 10);
    expect(counted()).toBe(first + 2);
    engine.onClose();
    await vi.advanceTimersByTimeAsync(COUNT_EVERY_MS * 3);
    expect(counted()).toBe(first + 2);
  });

  it("F-131 F-237: a bot's sources count a sent run only when the sending task's result names it", async () => {
    const gateway = fakeGateway();
    const { engine } = engineOn(gateway);
    const report = await engine.readReport({
      botId: "marlow",
      period: "week",
      timeZone: NY,
      detail: true,
      bots: [],
    });
    expect(report.figure.tokens.total).toBe(1700);
    expect(report.tasks?.map((t) => [t.key, t.total])).toEqual([
      ["agent:marlow:other", 500],
      ["agent:marlow:main", 400],
    ]);
    // m1 (a person's, 200) and m3 (500) are people's; m2 (200) is the run Pip's send names.
    expect(report.sources).toEqual({
      people: 700,
      routines: 0,
      bots: 200,
      unattributed: 800,
      partial: false,
    });
    engine.onClose();
  });

  it("counts a budget again within seconds while the gateway is still counting it", async () => {
    vi.useFakeTimers();
    const gateway = fakeGateway({ counting: true });
    const { engine, usage } = engineOn(gateway, () => Date.now());
    await engine.changeBudget({
      op: "set",
      budget: {
        botId: "otto",
        routineId: null,
        routineName: null,
        period: "daily",
        tokens: 1_000,
        timeZone: NY,
      },
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(usage().counts[0]?.counting).toBe(true);
    const counted = () => gateway.calls.filter((c) => c.method === "usage.cost").length;
    const first = counted();
    await vi.advanceTimersByTimeAsync(COUNT_COUNTING_MS + 10);
    expect(counted()).toBe(first + 1);
    engine.onClose();
  });

  it("F-232: while the gateway is still counting, the sources are marked partial and the figure says so", async () => {
    const { engine } = engineOn(fakeGateway({ counting: true }));
    const report = await engine.readReport({
      botId: "marlow",
      period: "week",
      timeZone: NY,
      detail: true,
      bots: [],
    });
    expect(report.figure.counting).toBe(true);
    expect(report.sources?.partial).toBe(true);
    engine.onClose();
  });

  it("F-237: every bot's figures, each read the same way as its own page", async () => {
    const gateway = fakeGateway();
    const { engine } = engineOn(gateway);
    const report = await engine.readReport({
      botId: null,
      period: "today",
      timeZone: NY,
      detail: false,
      bots: ["marlow", "otto", "pip"],
    });
    expect(report.figure.tokens.total).toBe(4100);
    expect(report.bots?.map((b) => [b.botId, b.figure?.tokens.total])).toEqual([
      ["marlow", 900],
      ["otto", 1800],
      ["pip", 600],
    ]);
    expect(gateway.calls.find((c) => c.method === "usage.cost")?.params).toMatchObject({
      agentScope: "all",
      mode: "specific",
      timeZone: NY,
    });
    engine.onClose();
  });

  it("F-234: reads at most two reports at once; a third waits its turn and is answered, not refused", async () => {
    const gateway = fakeGateway();
    // The gateway answers usage.cost only when told, so the first two reads stay in flight.
    const held: Array<() => void> = [];
    let inFlight = 0;
    let most = 0;
    const slow: typeof gateway.request = async (method, params) => {
      if (method !== "usage.cost") return gateway.request(method, params);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise<void>((resolve) => held.push(resolve));
      inFlight -= 1;
      return gateway.request(method, params);
    };
    const { engine } = engineOn({ ...gateway, request: slow });
    const read = () =>
      engine.readReport({ botId: "otto", period: "today", timeZone: NY, detail: false, bots: [] });
    const reads = [read(), read(), read()];
    await flush();
    expect(held).toHaveLength(MAX_USAGE_REPORTS);
    while (held.length > 0) {
      held.shift()!();
      await flush();
    }
    const settled = await Promise.allSettled(reads);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(most).toBe(MAX_USAGE_REPORTS);
    engine.onClose();
  });

  it("refuses a report only when the line of waiting reports is full", async () => {
    const gateway = fakeGateway();
    const held: Array<() => void> = [];
    const slow: typeof gateway.request = async (method, params) => {
      if (method === "usage.cost") await new Promise<void>((resolve) => held.push(resolve));
      return gateway.request(method, params);
    };
    const { engine } = engineOn({ ...gateway, request: slow });
    const reads = Array.from({ length: MAX_USAGE_REPORTS + MAX_WAITING_USAGE_REPORTS + 1 }, () =>
      engine.readReport({ botId: "otto", period: "today", timeZone: NY, detail: false, bots: [] }),
    );
    await flush();
    // The two in flight and the eight waiting are answered in turn; the eleventh was refused.
    await expect(reads.at(-1)).rejects.toThrow("Usage is already being read");
    for (let turn = 0; turn < MAX_USAGE_REPORTS + MAX_WAITING_USAGE_REPORTS; turn += 1) {
      while (held.length > 0) held.shift()!();
      await flush();
    }
    const settled = await Promise.allSettled(reads.slice(0, -1));
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
    engine.onClose();
  });

  it("F-235: reads the providers' limits at a hello", async () => {
    const { engine, usage } = engineOn(fakeGateway());
    engine.onHello();
    await flush();
    expect(usage().limits).toEqual({
      status: "ok",
      updatedAt: 77,
      providers: [],
      refreshing: false,
    });
    engine.onClose();
  });
});

describe("the bridge's usage commands", () => {
  it("checks every field before a command reaches the client", () => {
    expect(
      parseBridgeCommand({
        type: "readUsage",
        botId: "otto",
        period: "week",
        timeZone: NY,
        detail: true,
      }),
    ).toEqual({
      type: "readUsage",
      botId: "otto",
      period: "week",
      timeZone: NY,
      detail: true,
    });
    expect(() =>
      parseBridgeCommand({
        type: "readUsage",
        botId: null,
        period: "year",
        timeZone: NY,
        detail: false,
      }),
    ).toThrow("invalid period");
    expect(() =>
      parseBridgeCommand({
        type: "readUsage",
        botId: null,
        period: "week",
        timeZone: "Mars/Base",
        detail: false,
      }),
    ).toThrow("invalid time zone");
    const set = {
      op: "set",
      budget: { botId: "otto", routineId: null, period: "weekly", tokens: 5000, timeZone: NY },
    };
    expect(parseBridgeCommand({ type: "changeBudget", change: set })).toEqual({
      type: "changeBudget",
      change: {
        op: "set",
        budget: {
          botId: "otto",
          routineId: null,
          routineName: null,
          period: "weekly",
          tokens: 5000,
          timeZone: NY,
        },
      },
    });
    expect(() =>
      parseBridgeCommand({
        type: "changeBudget",
        change: { ...set, budget: { ...set.budget, tokens: 1.5 } },
      }),
    ).toThrow("invalid tokens");
    expect(() =>
      parseBridgeCommand({ type: "changeBudget", change: { op: "remove", id: "bot:../x" } }),
    ).toThrow("invalid budget id");
    expect(
      parseBridgeCommand({ type: "changeBudget", change: { op: "remove", id: "routine:job1" } }),
    ).toEqual({
      type: "changeBudget",
      change: { op: "remove", id: "routine:job1" },
    });
  });
});
