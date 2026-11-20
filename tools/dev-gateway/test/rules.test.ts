// The rules plugin on a development instance: its contract addition passes
// the guard, it adds exactly its own entry and load path to the config, no
// tool and no setting, it keeps every bot's denies, and the default instance
// never loads it.

import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { devConfig, DENIED_TOOLS, loadPlugins, PLUGIN_RULE, sandboxProblems } from "../src/cli.ts";
import { loadDevPlugin, pluginCopy } from "../src/dev-plugins.ts";
import { CHECKOUT_DIR } from "../src/env.ts";
import type { OperatorSession } from "../src/operator.ts";
import {
  RULES_CHECKS,
  eventually,
  isResultOfCall,
  logSaysAfter,
  ranOk,
  runRulesChecks,
  toolCallsOf,
  withConfig,
} from "../src/rules-checks.ts";
import { SCENARIOS } from "../src/scenarios.ts";

const PORTS = { gatewayPort: 19400, providerPort: 19410 };
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "clawtrate-rules-")));
  temps.push(dir);
  return dir;
};
const plugin = () => loadDevPlugin("clawtrate-tool-rules", CHECKOUT_DIR, PLUGIN_RULE);

describe("the rules plugin on a development instance", () => {
  it("passes the guard, with no setting, no tool and no browsers", () => {
    expect(plugin()).toMatchObject({
      name: "clawtrate-tool-rules",
      id: "clawtrate-tool-rules",
      settings: {},
      tools: [],
      botBrowsers: null,
      providers: [],
    });
  });

  it("adds only its entry and its load path, inside the closed contract", () => {
    const state = temp();
    const loaded = plugin();
    const config = devConfig("tok", PORTS, state, [loaded]);
    const bare = devConfig("tok", PORTS, state);
    expect(
      config.plugins.entries["clawtrate-tool-rules" as keyof typeof config.plugins.entries],
    ).toEqual({
      enabled: true,
      config: {},
    });
    expect(config.plugins.load).toEqual({ paths: [pluginCopy(state, "clawtrate-tool-rules")] });
    expect(config.tools).toEqual(bare.tools);
    expect(config.agents).toEqual(bare.agents);
    expect(config.tools.deny).toEqual(expect.arrayContaining([...DENIED_TOOLS]));
    expect(config.tools.deny).toEqual(expect.arrayContaining(["gateway", "plugins"]));
    expect(sandboxProblems(config, PORTS, state, [loaded])).toEqual([]);
    // Turned off, as a check does for a while, the config is outside the contract.
    const off = structuredClone(config) as unknown as {
      plugins: { entries: Record<string, { enabled: boolean }> };
    };
    off.plugins.entries["clawtrate-tool-rules"]!.enabled = false;
    expect(sandboxProblems(off, PORTS, state, [loaded])).toEqual([
      "plugins.entries.clawtrate-tool-rules.enabled must be true, found false",
    ]);
  });

  it("is never loaded on the default instance", () => {
    expect(() =>
      loadPlugins({ checkout: CHECKOUT_DIR, name: null }, ["clawtrate-tool-rules"]),
    ).toThrow(/default instance never loads plugins/);
    expect(
      loadPlugins({ checkout: CHECKOUT_DIR, name: "rules" }, ["clawtrate-tool-rules"]),
    ).toHaveLength(1);
  });

  it("loads beside the computer plugin", () => {
    const state = temp();
    const both = loadPlugins({ checkout: CHECKOUT_DIR, name: "both" }, [
      "clawtrate-computer",
      "clawtrate-tool-rules",
    ]);
    const config = devConfig("tok", PORTS, state, both, {}, "/opt/chromium-for-tests/chrome");
    expect(
      sandboxProblems(config, PORTS, state, both, {}, "/opt/chromium-for-tests/chrome"),
    ).toEqual([]);
  });
});

describe("the rules checks", () => {
  it("send only directives the scripted model has", () => {
    const directives = new Set(SCENARIOS.map((s) => `#${s.name}`));
    for (const check of RULES_CHECKS) {
      for (const directive of check.covers) expect(directives, check.name).toContain(directive);
    }
    expect(RULES_CHECKS.flatMap((check) => check.covers)).toContain("#message-read");
  });
});

describe("the rules checks' log reading", () => {
  it("finds a line only after the position taken before the transition", () => {
    const log = Buffer.from("x Rules read; enforcing them.\ny later lines\n");
    expect(logSaysAfter(log, "Rules read; enforcing them.", 0)).toBe(true);
    // An earlier recovery's line does not satisfy a later one.
    expect(logSaysAfter(log, "Rules read; enforcing them.", 30)).toBe(false);
    expect(logSaysAfter(log, "later lines", 30)).toBe(true);
  });
});

describe("the rules checks' bounded wait", () => {
  it("returns what appears before its deadline, and fails naming what never did", async () => {
    let tries = 0;
    expect(
      await eventually("a record", async () => (++tries >= 3 ? "found" : undefined), 5_000, 10),
    ).toBe("found");
    await expect(eventually("Pip's record", async () => undefined, 50, 10)).rejects.toThrow(
      /Pip's record did not appear within 50 ms/,
    );
  });
});

describe("the rules checks' tool calls", () => {
  const tool = (phase: string, toolCallId: string, extra: Record<string, unknown> = {}) => ({
    at: 0,
    seq: 0,
    event: "agent",
    payload: { stream: "tool", data: { phase, name: "write", toolCallId, ...extra } },
  });
  const ok = { isError: false, result: {} };
  const error = { isError: true, result: {} };

  it("count a call as having run only once its result arrived without an error", () => {
    const [started] = toolCallsOf([tool("start", "a")]);
    expect(started).toMatchObject({ name: "write", result: false });
    expect(ranOk(started)).toBe(false);
    const [done] = toolCallsOf([tool("start", "a"), tool("result", "a", ok)]);
    expect(ranOk(done)).toBe(true);
    const [failed] = toolCallsOf([tool("start", "a"), tool("result", "a", error)]);
    expect(ranOk(failed)).toBe(false);
    expect(ranOk(undefined)).toBe(false);
  });

  it("join each result to its own start, by call id", () => {
    const starts = [tool("start", "a", { name: "read" }), tool("start", "b")];
    const okA = toolCallsOf([...starts, tool("result", "a", ok)]);
    expect(okA.map((call) => [call.name, call.result, ranOk(call)])).toEqual([
      ["read", true, true],
      ["write", false, false],
    ]);
    const failedA = toolCallsOf([...starts, tool("result", "a", error)]);
    expect(failedA.map((call) => [call.name, call.result, ranOk(call)])).toEqual([
      ["read", true, false],
      ["write", false, false],
    ]);
    const unknown = toolCallsOf([...starts, tool("result", "c", ok)]);
    expect(unknown.map((call) => call.result)).toEqual([false, false]);
  });
});

describe("the rules checks' temporary settings", () => {
  const context = () =>
    ({ clients: {}, gatewayLog: "", stateDir: "" }) as unknown as Parameters<typeof withConfig>[0];

  it("are restored when the check's assertion fails, and when the change itself fails", async () => {
    const steps: string[] = [];
    const ctx = context();
    await expect(
      withConfig(
        ctx,
        async () => void steps.push("apply"),
        async () => void steps.push("restore"),
        async () => {
          steps.push("body");
          throw new Error("assertion");
        },
      ),
    ).rejects.toThrow("assertion");
    expect(steps).toEqual(["apply", "body", "restore"]);
    expect(ctx.restoreSettings).toBeUndefined();
    steps.length = 0;
    // The gateway took the change but the wait for it timed out.
    await expect(
      withConfig(
        ctx,
        async () => {
          steps.push("apply");
          throw new Error("not applied within 30 seconds");
        },
        async () => void steps.push("restore"),
        async () => void steps.push("body"),
      ),
    ).rejects.toThrow("not applied");
    expect(steps).toEqual(["apply", "restore"]);
  });

  it("say both failures when the check and its rollback both fail, and keep the rollback pending", async () => {
    const ctx = context();
    const restore = async () => {
      throw new Error("config.patch refused");
    };
    const failed = withConfig(
      ctx,
      async () => {},
      restore,
      async () => {
        throw new Error("timed out waiting for the card");
      },
    );
    await expect(failed).rejects.toThrow(
      "timed out waiting for the card; and the rollback of its temporary setting failed: config.patch refused",
    );
    expect(ctx.restoreSettings).toBe(restore);
  });

  /**
   * The check that turns the plugin off, on a fake gateway whose rollback
   * (`enabled: true`) is refused `refusals` times, then a check that notes
   * whether the plugin was on when it started.
   */
  const drive = async (refusals: number) => {
    let enabled = true;
    let revision = 1;
    let left = refusals;
    const seenAtNext: boolean[] = [];
    const answer = async (method: string, params: Record<string, unknown> = {}) => {
      switch (method) {
        case "config.get":
          return {
            hash: `h${revision}`,
            configRevisionHash: `r${revision}`,
            appliedConfigHash: `r${revision}`,
            config: { plugins: { entries: { "clawtrate-tool-rules": { enabled } } } },
          };
        case "config.patch": {
          const raw = JSON.parse(String(params.raw)) as {
            plugins: { entries: Record<string, { enabled: boolean }> };
          };
          const next = raw.plugins.entries["clawtrate-tool-rules"]!.enabled;
          if (next && left > 0) {
            left -= 1;
            throw new Error("config.patch refused");
          }
          enabled = next;
          revision += 1;
          return { ok: true };
        }
        case "clawtrate-tool-rules.status":
          if (!enabled) throw new Error("unknown method");
          return { hook: { registered: true } };
        case "clawtrate-tool-rules.get":
          return { scopes: {} };
        case "plugin.approval.list":
          return [];
        case "chat.send":
          return { runId: "run-1" };
        default:
          return {};
      }
    };
    const op = {
      events: [],
      lastSeq: 0,
      request: answer,
      send: () => answer("chat.send"),
      // The slow tool started; the card never comes, so the check fails with the plugin off.
      waitFor: async (label: string) => {
        if (label === "the slow tool") return { seq: 1, event: "agent", payload: {} };
        throw new Error(`timed out waiting for ${label}`);
      },
    } as unknown as OperatorSession;
    const off = RULES_CHECKS.find((c) => c.name.startsWith("the plugin turned off mid-run"))!;
    const held = RULES_CHECKS.splice(0);
    RULES_CHECKS.push(off, {
      name: "the next check",
      covers: [],
      run: async () => void seenAtNext.push(enabled),
    });
    const lines: string[] = [];
    vi.useFakeTimers();
    try {
      const outcome = runRulesChecks(
        {
          clients: { admin: op, interactive: op, approver: op, writer: op, reader: op },
          gatewayLog: "",
          stateDir: "",
        },
        (line) => lines.push(line),
      );
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      return { result: await outcome, lines, seenAtNext, enabled };
    } finally {
      vi.useRealTimers();
      RULES_CHECKS.splice(0, RULES_CHECKS.length, ...held);
    }
  };

  it("are restored by settling when the check's own rollback was refused, before the next check", async () => {
    const run = await drive(1);
    expect(run.lines[0]).toMatch(/^FAIL {2}the plugin turned off mid-run.*config\.patch refused/);
    expect(run.seenAtNext).toEqual([true]);
    expect(run.result).toEqual({ passed: 1, failed: 1 });
  });

  it("keep the next check unstarted, and fail the final clean-up, while the rollback is refused", async () => {
    const run = await drive(Number.POSITIVE_INFINITY);
    expect(run.seenAtNext).toEqual([]);
    expect(run.enabled).toBe(false);
    expect(run.lines[1]).toMatch(/^FAIL {2}the next check: not started/);
    expect(run.lines.at(-1)).toMatch(/^FAIL {2}the final clean-up/);
    expect(run.result).toEqual({ passed: 0, failed: 3 });
  });
});

describe("the rules checks' history matching", () => {
  it("takes a tool result as this run's only when its call id hashes to the decision record's", () => {
    const callId = `sha256:${createHash("sha256").update("call_this_run").digest("hex")}`;
    const result = (toolCallId: string) => ({ role: "toolResult", toolName: "read", toolCallId });
    expect(isResultOfCall(result("call_this_run"), callId)).toBe(true);
    expect(isResultOfCall(result("call_an_earlier_run"), callId)).toBe(false);
    expect(isResultOfCall({ role: "toolResult", toolName: "read" }, callId)).toBe(false);
    expect(isResultOfCall(result("call_this_run"), null)).toBe(false);
  });
});

describe("the rules checks' final clean-up", () => {
  it("counts as a failure when it cannot leave the gateway with no rules", async () => {
    const held = RULES_CHECKS.splice(0);
    try {
      const op = (answer: (method: string) => unknown) =>
        ({
          request: async (method: string) => answer(method),
          events: [],
          lastSeq: 0,
        }) as unknown as OperatorSession;
      const admin = op((method) => {
        if (method === "plugin.approval.list") return [];
        throw new Error("refused");
      });
      // The plugin answers, but its rules cannot be read back to empty them.
      const reader = op((method) => {
        if (method === "clawtrate-tool-rules.status") return { hook: { registered: true } };
        throw new Error("refused");
      });
      const lines: string[] = [];
      const result = await runRulesChecks(
        {
          clients: { admin, interactive: admin, approver: admin, writer: admin, reader },
          gatewayLog: "",
          stateDir: "",
        },
        (line) => lines.push(line),
      );
      expect(result).toEqual({ passed: 0, failed: 1 });
      expect(lines.some((line) => line.startsWith("FAIL  the final clean-up"))).toBe(true);
    } finally {
      RULES_CHECKS.push(...held);
    }
  }, 30_000);
});

describe("the rules checks' recipient run", () => {
  const hashed = (id: string) => `sha256:${createHash("sha256").update(id).digest("hex")}`;
  const denied = "Plugin approval required (gateway unavailable)";
  const decision = (runId: string, callId: string, at: number) => ({
    id: runId,
    agentId: "pip",
    runId,
    callId: hashed(callId),
    at,
    tool: "read",
    decision: "ask",
    answer: "cancelled",
    source: null,
  });
  const toolResult = (toolCallId: string, text: string) => ({
    role: "toolResult",
    toolName: "read",
    toolCallId,
    content: [{ type: "text", text }],
  });
  /** Marlow's send started run pip-1; pip-2, a moment later, is another run of Pip's. */
  const drive = async (history: Record<string, unknown>[]) => {
    // Both after the send; the other run's a moment later, so newest first it comes first.
    const sent = Date.now();
    const records = [
      decision("pip-2", "call_other", sent + 2_000),
      decision("pip-1", "call_sent", sent + 1_000),
    ];
    const tool = (phase: string, extra: Record<string, unknown>) => ({
      at: 0,
      seq: 0,
      event: "agent",
      payload: {
        stream: "tool",
        data: { phase, name: "sessions_send", toolCallId: "send_1", ...extra },
      },
    });
    const op = {
      events: [],
      lastSeq: 0,
      send: async () => ({ runId: "marlow-1" }),
      terminal: async () => ({ state: "final" }),
      runEvents: () => [
        tool("start", {}),
        tool("result", { isError: false, result: { details: { status: "ok", runId: "pip-1" } } }),
      ],
      request: async (method: string, params: Record<string, unknown> = {}) => {
        if (method === "clawtrate-tool-rules.get") return { scopes: {} };
        if (method === "clawtrate-tool-rules.decisions.list") {
          return {
            records: records.filter(
              (r) =>
                r.agentId === params.agentId &&
                (params.runId === undefined || r.runId === params.runId),
            ),
          };
        }
        if (method === "chat.history") return { messages: history };
        return {};
      },
    } as unknown as OperatorSession;
    const check = RULES_CHECKS.find((c) => c.covers.includes("#message-read"))!;
    const clients = { admin: op, interactive: op, approver: op, writer: op, reader: op };
    vi.useFakeTimers();
    try {
      const outcome = check
        .run({ clients, gatewayLog: "", stateDir: "" }, { stamp: "t", keys: new Set(), counter: 0 })
        .then(
          () => "passed",
          (error: Error) => error.message,
        );
      await vi.advanceTimersByTimeAsync(60_000);
      return await outcome;
    } finally {
      vi.useRealTimers();
    }
  };

  it("takes the decision of the run the send started, not a later one of the same bot", async () => {
    expect(await drive([toolResult("call_sent", denied), toolResult("call_other", "notes")])).toBe(
      "passed",
    );
  });

  it("fails when only another run's refused read is in the history", async () => {
    expect(await drive([toolResult("call_other", denied)])).toMatch(
      /Pip's read result in its history did not appear/,
    );
  });
});

describe("the rules checks' approval clean-up", () => {
  /** One check that passes, on a fake gateway; `list` answers each pending-approvals request. */
  const drive = async (list: (final: boolean) => unknown) => {
    let final = false;
    const op = {
      events: [],
      lastSeq: 0,
      request: async (method: string) => {
        if (method === "plugin.approval.list") return list(final);
        if (method === "clawtrate-tool-rules.status") return { hook: { registered: true } };
        if (method === "clawtrate-tool-rules.get") return { scopes: {} };
        return {};
      },
    } as unknown as OperatorSession;
    const held = RULES_CHECKS.splice(0);
    RULES_CHECKS.push({ name: "a check", covers: [], run: async () => void (final = true) });
    const lines: string[] = [];
    vi.useFakeTimers();
    try {
      const outcome = runRulesChecks(
        {
          clients: { admin: op, interactive: op, approver: op, writer: op, reader: op },
          gatewayLog: "",
          stateDir: "",
        },
        (line) => lines.push(line),
      );
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      return { result: await outcome, lines };
    } finally {
      vi.useRealTimers();
      RULES_CHECKS.splice(0, RULES_CHECKS.length, ...held);
    }
  };

  it("fails the final clean-up when the pending approvals cannot be listed", async () => {
    const run = await drive((final) => {
      if (final) throw new Error("plugin.approval.list refused");
      return [];
    });
    expect(run.result).toEqual({ passed: 1, failed: 1 });
    expect(run.lines.at(-1)).toMatch(/^FAIL {2}the final clean-up/);
  });

  it("fails the final clean-up when a card is still pending after the runs were stopped", async () => {
    let finalLists = 0;
    const run = await drive((final) => {
      if (!final) return [];
      finalLists += 1;
      // None at the sweep; one listed again after the drain.
      return finalLists === 1 ? [] : [{ id: "late" }];
    });
    expect(run.result).toEqual({ passed: 1, failed: 1 });
    expect(run.lines.at(-1)).toMatch(/^FAIL {2}the final clean-up/);
  });
});
