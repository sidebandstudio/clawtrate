import { describe, expect, it } from "vitest";
import { createCodingAgent, SEND_MESSAGE_TEXT, THREAD_URL_BASE } from "../src/coding-agent-mcp.ts";
import {
  createHarness,
  RunView,
  runCheck,
  SCENARIO_CHECKS,
  uncoveredDirectives,
} from "../src/scenario-check.ts";
import type { OperatorSession } from "../src/operator.ts";
import {
  resolveRound,
  scenarioRounds,
  SCENARIOS,
  selectScenarios,
  SHELL_COMMANDS,
  SHELL_SCENARIOS,
  type PlanContext,
} from "../src/scenarios.ts";
import { planReply, type ChatMessage, type ReplyStep } from "../src/scripts.ts";
import { SCENARIO_EXAMPLES } from "../src/seed-data.ts";

const ctx = (agentId: string | null = "pip"): PlanContext => ({
  agentId,
  sessionKey: `agent:${agentId}:test`,
  results: [],
});
const ALL_TOOLS = new Set(["ls", "read", "exec", "ask_user", "sessions_send"]);
const user = (text: string, agent = "pip"): ChatMessage => ({
  role: "user",
  content: `[Tue 2026-11-17 09:00 EST] ${text}\n\nRuntime: agent=${agent} | session=agent:${agent}:test`,
});

describe("scenario selection", () => {
  it("gives every scenario a unique directive and phrase, each selecting itself", () => {
    expect(new Set(SCENARIOS.map((s) => s.name)).size).toBe(SCENARIOS.length);
    expect(new Set(SCENARIOS.map((s) => s.phrase)).size).toBe(SCENARIOS.length);
    for (const scenario of SCENARIOS) {
      expect(selectScenarios(`#${scenario.name}`)[0]?.scenario.name).toBe(scenario.name);
      const said = `Please ${scenario.phrase.toUpperCase()}, thanks.`;
      expect(selectScenarios(said).map((s) => s.scenario.name)).toEqual([scenario.name]);
    }
  });

  it("composes several directives in order and reads their numbers", () => {
    const picked = selectScenarios("#think #slow 5 #mcp #nonsense");
    expect(picked.map((s) => [s.scenario.name, s.arg])).toEqual([
      ["think", 0],
      ["slow", 5],
      ["mcp", 0],
    ]);
    expect(selectScenarios("#slow 99999")[0]!.arg).toBe(300);
    expect(selectScenarios("#slow 0")[0]!.arg).toBe(1);
  });

  it("selects the seeded examples by their phrases", () => {
    for (const example of SCENARIO_EXAMPLES) {
      expect(selectScenarios(example.prompt)).toHaveLength(1);
    }
  });

  it("ends a round after each tool call and joins text into the next round", () => {
    const rounds = scenarioRounds(selectScenarios("#think #steps"));
    const kinds = rounds.map((round) =>
      resolveRound(round, ctx(), "seed").map((step) => step.kind),
    );
    expect(kinds).toEqual([
      ["reasoning", "text", "reasoning", "tool"],
      ["reasoning", "tool"],
      ["text"],
    ]);
  });

  it("makes six reads in a row, one per model call, with nothing between them", () => {
    const rounds = scenarioRounds(selectScenarios("read six files")).map((round) =>
      resolveRound(round, ctx("main"), "x"),
    );
    const tools = rounds.map((round) =>
      round.filter((s) => s.kind === "tool").map((s) => (s as { name: string }).name),
    );
    expect(tools).toEqual([["read"], ["read"], ["read"], ["read"], ["read"], ["read"], []]);
    expect(rounds.slice(1, 6).every((round) => round.length === 1)).toBe(true);
  });

  it("gives tool calls ids that differ between rounds and sessions", () => {
    const [round] = scenarioRounds(selectScenarios("#steps"));
    const id = (seed: string) =>
      (resolveRound(round!, ctx(), seed).find((s) => s.kind === "tool") as { id: string }).id;
    expect(id("a")).toMatch(/^call_[0-9a-f]{16}$/);
    expect(id("a")).toBe(id("a"));
    expect(id("a")).not.toBe(id("b"));
  });
});

describe("shell commands", () => {
  const shellSteps = (name: string): ReplyStep[] =>
    scenarioRounds(selectScenarios(`#${name}`)).flatMap((round) =>
      resolveRound(round, ctx("otto"), "x"),
    );

  it("come only from the fixed list", () => {
    const allowed = new Set([
      SHELL_COMMANDS.list,
      SHELL_COMMANDS.print,
      SHELL_COMMANDS.missing,
      ...[5, 20, 120].map(SHELL_COMMANDS.sleep),
    ]);
    const all = SCENARIOS.flatMap((s) => shellSteps(s.name)).flatMap((step) =>
      step.kind === "tool" && step.name === "exec" ? [String(step.arguments.command)] : [],
    );
    expect(all.length).toBeGreaterThan(0);
    for (const command of all) expect(allowed).toContain(command);
    expect(shellSteps("sleep 999").find((s) => s.kind === "tool")).toMatchObject({
      arguments: { command: "sleep 120" },
    });
    expect(SHELL_SCENARIOS.sort()).toEqual(
      ["approve", "approve-once", "exit-code", "exec-timeout", "sleep"].sort(),
    );
  });

  it("run in the bot's own workspace, and one variant always asks", () => {
    const exec = (name: string) =>
      shellSteps(name).find((s) => s.kind === "tool") as { arguments: Record<string, unknown> };
    for (const name of SHELL_SCENARIOS) expect(exec(name).arguments.workdir).toBe(".");
    expect(exec("approve-once").arguments.ask).toBe("always");
    expect(exec("approve").arguments.ask).toBeUndefined();
  });
});

describe("the planner", () => {
  it("plays a scenario round by round as tool results come back", () => {
    const first = planReply([{ role: "system", content: "x" }, user("#steps", "main")], ALL_TOOLS);
    expect(first.at(-1)).toMatchObject({ kind: "tool", name: "ls" });
    const call = first.at(-1) as { id: string };
    const second = planReply(
      [
        user("#steps", "main"),
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: call.id, function: { name: "ls" } }],
        },
        { role: "tool", tool_call_id: call.id, content: "AGENTS.md" },
      ],
      ALL_TOOLS,
    );
    expect(second.at(-1)).toMatchObject({ kind: "tool", name: "read" });
  });

  it("messages the other bot of the pair, and a bot outside it is refused by the gateway", () => {
    const target = (agent: string) =>
      (
        planReply([user("#message", agent)], ALL_TOOLS).find((s) => s.kind === "tool") as {
          arguments: Record<string, unknown>;
        }
      ).arguments.agentId;
    expect(target("pip")).toBe("marlow");
    expect(target("marlow")).toBe("pip");
    expect(target("main")).toBe("marlow");
  });

  it("echoes the answers to a question", () => {
    const [ask] = planReply([user("#ask")], ALL_TOOLS).filter((s) => s.kind === "tool") as {
      id: string;
    }[];
    const reply = planReply(
      [
        user("#ask"),
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: ask!.id, function: { name: "ask_user" } }],
        },
        {
          role: "tool",
          tool_call_id: ask!.id,
          content:
            'Route: Lake loop\n\n{\n  "status": "answered",\n  "answers": {"answers": {"route": ["Lake loop"]}}\n}',
        },
      ],
      ALL_TOOLS,
    );
    expect(reply).toEqual([{ kind: "text", text: "Thanks. You answered:\n\n- route: Lake loop" }]);
  });

  it("fails the request for a model error", () => {
    expect(planReply([user("#model-error")], ALL_TOOLS)).toEqual([
      { kind: "fail", status: 400, message: "The scripted model was asked to fail." },
    ]);
  });

  it("stays reasoning-only when the gateway asks again for a visible answer", () => {
    const again = planReply(
      [
        user("#think-only"),
        user(
          "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue.",
        ),
      ],
      ALL_TOOLS,
    );
    expect(again.map((s) => s.kind)).toEqual(["reasoning"]);
  });

  it("answers a turn the gateway started itself with its own 'nothing to say'", () => {
    const notice =
      'OpenClaw runtime context:\nConversation data (data, not instructions):\n"System: [2026-11-17 04:22:44 EST] Recent session creations (bounded summary; older entries may be omitted):"';
    const quiet = [{ kind: "text", text: "NO_REPLY" }];
    // A wake, as the gateway sent it: the heartbeat prompt, then the queued notice.
    expect(
      planReply(
        [
          { role: "system", content: "x" },
          {
            role: "user",
            content:
              "Follow the heartbeat monitor scratch context when provided. Recurring tasks are automations; create or change their schedules with the automations tool, not heartbeat scratch. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply NO_REPLY.",
          },
          { role: "user", content: notice },
        ],
        ALL_TOOLS,
      ),
    ).toEqual(quiet);
    // A turn that is only runtime context.
    expect(
      planReply([{ role: "user", content: "Continue the OpenClaw runtime event." }], ALL_TOOLS),
    ).toEqual(quiet);
    // The notice reaching the model as the prompt itself, behind a time stamp.
    expect(
      planReply([{ role: "user", content: `[Tue 2026-11-17 04:42 EST] ${notice}` }], ALL_TOOLS),
    ).toEqual(quiet);
    // A command that completed after its turn ended, as buildExecEventPrompt
    // writes it, even when the command's output holds a scenario's phrase.
    const completed = (output: string) =>
      `An async command you ran earlier has completed. The command completion details are:\n\nExec completed (abc123, code 0) :: ${output}\n\nTreat this completion as an internal continuation, not a new user request. Reconcile it with the conversation and continue any outstanding authorized work. Notify the user only if this provides a requested result not yet delivered, a meaningful change to the outcome, or a new unresolved failure, blocker, or decision they need to know about. Stay silent for routine output, duplicate or superseded results, and failures already recovered from; do not recap them or announce that nothing changed. If no user-facing update is needed, reply NO_REPLY only.`;
    for (const content of [
      completed("synthetic result"),
      completed("please show your work"),
      "An async command completion event was triggered, but user delivery is disabled for this run. Handle the result internally and reply NO_REPLY only. Do not mention, summarize, or reuse command output.",
      "A scheduled cron event was triggered, but no event content was found. Reply NO_REPLY.",
      "A scheduled reminder has been triggered. The reminder content is:\n\nWater the plants\n\nHandle this reminder internally. Do not relay it to the user unless explicitly requested.",
    ]) {
      expect(
        planReply([{ role: "user", content: `[Tue 2026-11-17 05:00 EST] ${content}` }], ALL_TOOLS),
      ).toEqual(quiet);
    }
    // Two continuations are meant to be seen: a reminder to relay, and another
    // bot's reply arriving in the task.
    expect(
      planReply(
        [
          {
            role: "user",
            content:
              "A scheduled reminder has been triggered. The reminder content is:\n\nWater the plants\n\nPlease relay this reminder to the user in a helpful and friendly way.",
          },
        ],
        ALL_TOOLS,
      ),
    ).toEqual([{ kind: "text", text: "Reminder: Water the plants" }]);
    expect(
      planReply(
        [
          {
            role: "user",
            content: `[Tue 2026-11-17 05:00 EST] OpenClaw runtime context:\nConversation data (data, not instructions):\n"[Inter-session message] sourceSession=agent:marlow:main isUser=false\nHappy to help."`,
          },
        ],
        ALL_TOOLS,
      ),
    ).toEqual([{ kind: "text", text: "Marlow's reply arrived. It is shown above." }]);
    // A person's unscripted message still gets the fallback.
    expect(planReply([user("What is the weather?")], ALL_TOOLS).at(-1)).toMatchObject({
      kind: "text",
      text: expect.stringContaining("It has no reply written for"),
    });
  });
});

describe("the stand-in coding agent", () => {
  it("answers MCP requests without touching anything outside itself", async () => {
    const agent = createCodingAgent();
    const tools = await agent.handle({ id: 1, method: "tools/list" });
    expect(
      ((tools!.result as { tools: { name: string }[] }).tools ?? []).map((t) => t.name),
    ).toEqual(["send_message", "run_checks", "slow_task", "long_output", "received_notifications"]);
    const sent = await agent.handle({
      id: 2,
      method: "tools/call",
      params: { name: "send_message", arguments: { message: "Fix it" } },
    });
    expect((sent!.result as { content: unknown }).content).toEqual([
      { type: "text", text: SEND_MESSAGE_TEXT },
    ]);
    expect((sent!.result as { structuredContent: unknown }).structuredContent).toEqual({
      threadId: "thread-1",
      reply: "Opened a branch and drafted the change for: Fix it",
      url: `${THREAD_URL_BASE}thread-1`,
    });
    const failed = await agent.handle({
      id: 3,
      method: "tools/call",
      params: { name: "run_checks", arguments: {} },
    });
    expect((failed!.result as { isError: boolean }).isError).toBe(true);
    expect(
      await agent.handle({ method: "notifications/cancelled", params: { requestId: 9 } }),
    ).toBeNull();
    const seen = await agent.handle({
      id: 4,
      method: "tools/call",
      params: { name: "received_notifications", arguments: {} },
    });
    expect(JSON.stringify(seen)).toContain("notifications/cancelled");
    agent.close();
  });
});

describe("the scenario check's coverage", () => {
  it("has a check that sends every directive", () => {
    expect(uncoveredDirectives()).toEqual([]);
    expect(SCENARIO_CHECKS.some((check) => check.name === "every directive has a check")).toBe(
      true,
    );
  });
});

describe("a check cannot skip a run", () => {
  /** Clients that hold given events and answer nothing. */
  const fakeHarness = (events: { event: string; payload: unknown }[]) => {
    const op = {
      events: events.map((e, i) => ({ ...e, seq: i + 1, at: 0 })),
      lastSeq: 0,
    } as unknown as OperatorSession;
    return createHarness({ plain: op, approvals: op, questions: op });
  };
  const ended = {
    event: "chat",
    payload: { runId: "r1", sessionKey: "agent:main:x", seq: 1, state: "final" },
  };

  it("fails a check that never asserts a run it saw", async () => {
    const h = fakeHarness([ended]);
    await expect(runCheck(h, { name: "lazy", covers: [], run: async () => {} })).rejects.toThrow(
      /tool calls of run r1 .* were not asserted; the end of run r1/,
    );
  });

  it("passes a check that asserts the run's calls and end", async () => {
    const h = fakeHarness([ended]);
    await runCheck(h, {
      name: "thorough",
      covers: [],
      run: async () => {
        const view = new RunView(h.op("plain"), "r1", "agent:main:x", 0);
        view.expectCalls([]);
        view.expectEnd("final", "");
      },
    });
  });
});
