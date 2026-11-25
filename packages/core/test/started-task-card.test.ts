// The "Started a task" card (F-587), from the rows a conversation keeps: the parent's
// `chat.history` rows around the gateway's `sessions_spawn`, as OpenClaw 2026.10.6 returns them on
// a development gateway (the result is the tool's JSON object as the row's only text, with no
// `details`), and the task list's row for the task it names.

import { describe, expect, it } from "vitest";
import { mapHistory, mapSessionRow } from "../src/mapping.ts";
import { RawTable, runsFromHistory, type Run } from "../src/runs.ts";
import {
  isTaskStart,
  MAX_BRIEF_LINE_CHARS,
  plainLine,
  selectStartedTasks,
  startedTaskOf,
  tasksShownHere,
  type StartedTaskCard,
} from "../src/started-task-card.ts";
import { MAX_TITLE_CHARS } from "../src/state-bounds.ts";
import {
  initialConnectionState,
  initialDiscoveryState,
  type Task,
  type TaskStatus,
} from "../src/types.ts";

const HERE = "agent:pip:probe-b";
const CHILD = "agent:pip:dashboard:f52b9e03-35fa-4ef9-ac37-a1d4c553fa55";
const CHILD_RUN = "78e0662c-d0fb-498c-a34a-23b4ea0f8c28";
const RUN = "ce96c4ae-0796-4868-8eca-d86405903c1b";
const CALL = "call_b83d3c968fc30636";
const T = 1_795_581_283_254;
const LABEL = "Compare trail maps";
const BRIEF =
  "Compare the lake loop and the ridge trail on the trail map, and say which suits a relaxed Saturday. Reply in plain text.";

const user = (text: string, at: number, run: string) => ({
  role: "user",
  content: text,
  timestamp: at,
  __openclaw: { id: `u-${at}`, idempotencyKey: `${run}:user` },
});

const call = (
  run: string,
  at: number,
  id: string,
  args: Record<string, unknown>,
  name = "sessions_spawn",
) => ({
  role: "assistant",
  timestamp: at,
  content: [{ type: "toolCall", id, name, arguments: args }],
  __openclaw: { id: `a-${at}`, runId: run },
});

const result = (
  run: string,
  at: number,
  id: string,
  body: unknown,
  isError = false,
  name = "sessions_spawn",
) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  isError,
  timestamp: at,
  content: [
    { type: "text", text: typeof body === "string" ? body : JSON.stringify(body, null, 2) },
  ],
  __openclaw: { id: `r-${at}`, runId: run },
});

const say = (run: string, at: number, text: string) => ({
  role: "assistant",
  timestamp: at,
  content: [{ type: "text", text }],
  __openclaw: { id: `s-${at}`, runId: run },
});

const ACCEPTED = {
  status: "accepted",
  childSessionKey: CHILD,
  runId: CHILD_RUN,
  mode: "run",
  expectsCompletionMessage: true,
  cleanup: "keep",
  publicRead: false,
  label: LABEL,
  owner: { type: "human", id: "gateway-owner", label: "Sam" },
};

const VISIBLE = { task: BRIEF, label: LABEL, visible: true };

/** One run of the conversation: the person's message, the call, its result, and the bot's words. */
function startRows(
  args: Record<string, unknown> = VISIBLE,
  body: unknown = ACCEPTED,
  isError = false,
) {
  return [
    user("#hand-off", T, RUN),
    call(RUN, T + 800, CALL, args),
    result(RUN, T + 1_000, CALL, body, isError),
    say(RUN, T + 1_040, "I started a task for it."),
  ];
}

/** The task list's row for the started task, as `sessions.list` gives it. */
function listed(status: string, extra: Record<string, unknown> = {}): Record<string, Task[]> {
  const task = mapSessionRow({
    key: CHILD,
    agentId: "pip",
    createdVia: "spawn",
    spawnedBy: HERE,
    label: LABEL,
    status,
    ...extra,
  })!;
  return { pip: [task] };
}

function cards(
  rows: unknown[],
  tasks: Record<string, Task[]> = {},
  inFlight: string | null = null,
): StartedTaskCard[] {
  const raw = new RawTable();
  const runs: Run[] = runsFromHistory(rows, inFlight, { sessionKey: HERE, now: T + 60_000, raw });
  return selectStartedTasks(
    { runs, items: mapHistory(rows), taskKey: HERE, tasks },
    (step) => step.raw ?? (raw.get(HERE, step.id) as never),
  );
}

describe("a task a bot starts shows as a card where it was asked (F-587)", () => {
  it("names the task the gateway's result names, under the bot doing the work, with its title and brief line", () => {
    const [card] = cards(startRows(), listed("running"));
    expect(card).toMatchObject({
      toolCallId: CALL,
      runId: RUN,
      agentId: "pip",
      taskKey: CHILD,
      title: LABEL,
      label: LABEL,
      brief: BRIEF,
      state: "working",
      reason: null,
      resultStatus: "accepted",
    });
    expect(card!.task?.key).toBe(CHILD);
  });

  it("takes each state from the task's own row in the list, the one the sidebar shows", () => {
    const expected: Record<TaskStatus, StartedTaskCard["state"]> = {
      running: "working",
      queued: "queued",
      waiting: "waiting",
      blocked: "blocked",
      done: "done",
      idle: "done",
      "done-with-failures": "done-with-failures",
      failed: "failed",
      stopped: "stopped",
    };
    for (const [status, state] of Object.entries(expected)) {
      const tasks = listed("done");
      tasks.pip![0] = { ...tasks.pip![0]!, status: status as TaskStatus };
      expect([status, cards(startRows(), tasks)[0]!.state]).toEqual([status, state]);
    }
    // The gateway's own row: a run going, and a run ended.
    expect(cards(startRows(), listed("running"))[0]!.state).toBe("working");
    expect(cards(startRows(), listed("done"))[0]!.state).toBe("done");
    expect(cards(startRows(), listed("failed"))[0]!.state).toBe("failed");
  });

  it("is Starting while the call is open, whatever the list says", () => {
    const rows = [user("#hand-off", T, RUN), call(RUN, T + 800, CALL, VISIBLE)];
    const [card] = cards(rows, listed("running"), RUN);
    expect(card).toMatchObject({ state: "starting", taskKey: null, task: null, title: LABEL });
  });

  it("is Couldn't start with the gateway's own words for each refusal, and opens nothing", () => {
    const refusals = [
      // Two starts with one label under one bot.
      [
        {
          status: "error",
          tool: "sessions_spawn",
          error: "label already in use: Compare trail maps",
        },
      ],
      // A task for another bot this bot may not start.
      [
        {
          status: "forbidden",
          error: "agentId is not allowed for sessions_spawn (allowed: main)",
          role: "marlow",
        },
      ],
      // The limit of running tasks per conversation.
      [
        {
          status: "forbidden",
          error:
            "sessions_spawn has reached max active children for this session (5/5; agents.defaults.subagents.maxChildrenPerAgent).",
          role: "pip",
        },
      ],
    ] as const;
    for (const [body] of refusals) {
      const [card] = cards(startRows(VISIBLE, body, true), listed("running"));
      expect(card).toMatchObject({
        state: "couldnt-start",
        reason: body.error,
        resultStatus: body.status,
        taskKey: null,
        task: null,
        reportedBack: null,
      });
    }
    // A plain error: the tool failed with text that is not the gateway's object.
    const [plain] = cards(
      startRows(VISIBLE, "Error: the gateway could not create the session", true),
    );
    expect(plain).toMatchObject({
      state: "couldnt-start",
      reason: "Error: the gateway could not create the session",
      task: null,
    });
  });

  it("for a task under another bot, names the bot the refusal or the result names", () => {
    const partner = { ...VISIBLE, label: "Review the route", agentId: "marlow" };
    const [refused] = cards(
      startRows(
        partner,
        { status: "forbidden", error: "agentId is not allowed for sessions_spawn (allowed: main)" },
        true,
      ),
    );
    expect(refused).toMatchObject({ agentId: "marlow", state: "couldnt-start" });
    const marlowKey = "agent:marlow:dashboard:344e8385-55dd-4150-86de-2b4970b8c1a2";
    const task = mapSessionRow({
      key: marlowKey,
      agentId: "marlow",
      createdVia: "spawn",
      spawnedBy: HERE,
      label: "Review the route",
      status: "running",
    })!;
    const [accepted] = cards(
      startRows({ ...partner, agentId: "pip" }, { ...ACCEPTED, childSessionKey: marlowKey }),
      { marlow: [task] },
    );
    // The result's key decides, not what the call asked for.
    expect(accepted).toMatchObject({ agentId: "marlow", taskKey: marlowKey, state: "working" });
    expect(accepted!.task?.botId).toBe("marlow");
  });

  it("is Unknown for a call that closed with no result, or a result that says nothing", () => {
    const noResult = [
      user("#hand-off", T, RUN),
      call(RUN, T + 800, CALL, VISIBLE),
      say(RUN, T + 1_040, "Stopped."),
    ];
    expect(cards(noResult)[0]).toMatchObject({ state: "unknown", task: null });
    const malformed = cards(startRows(VISIBLE, "not the gateway's object"), listed("running"));
    expect(malformed[0]).toMatchObject({ state: "unknown", taskKey: null, task: null });
    const accepted = cards(startRows(VISIBLE, { status: "accepted" }), listed("running"));
    // Accepted, but no task named: nothing to open, and no state of a task.
    expect(accepted[0]).toMatchObject({ state: "started", taskKey: null, task: null });
  });

  it("makes no card from a result of another tool with the same shape, or from text in a message", () => {
    const sameShape = [
      user("#sessions", T, RUN),
      call(RUN, T + 800, CALL, VISIBLE, "sessions_list"),
      result(RUN, T + 1_000, CALL, ACCEPTED, false, "sessions_list"),
      say(RUN, T + 1_040, JSON.stringify(ACCEPTED)),
    ];
    expect(cards(sameShape, listed("running"))).toEqual([]);
    const inText = [
      user(JSON.stringify(ACCEPTED), T, RUN),
      say(RUN, T + 1_000, JSON.stringify(ACCEPTED)),
    ];
    expect(cards(inText, listed("running"))).toEqual([]);
  });

  it("leaves a hidden helper a step line", () => {
    const hiddenKey = "agent:pip:subagent:7a1e3a52-4c84-4e0f-9a7b-1c0d2a9a1f11";
    const hidden = { task: "Check the forecast for Saturday.", label: "Check the forecast" };
    expect(cards(startRows(hidden, { ...ACCEPTED, childSessionKey: hiddenKey }))).toEqual([]);
    // Even when the call asked for a visible task: the gateway made a hidden helper.
    expect(cards(startRows(VISIBLE, { ...ACCEPTED, childSessionKey: hiddenKey }))).toEqual([]);
    // A hidden helper refused, or still open, is a line too.
    expect(cards(startRows(hidden, { status: "error", error: "no" }, true))).toEqual([]);
    expect(cards([user("#x", T, RUN), call(RUN, T + 800, CALL, hidden)], {}, RUN)).toEqual([]);
  });

  it("shows a task the list does not hold as started from here as text only: no task, no state of it", () => {
    // Not listed: deleted, archived, hidden by a switch, or not listed yet.
    expect(cards(startRows(), {})[0]).toMatchObject({
      state: "started",
      task: null,
      title: LABEL,
      brief: BRIEF,
    });
    // Listed, but started from another conversation.
    const elsewhere = listed("running", { spawnedBy: "agent:pip:main" });
    expect(cards(startRows(), elsewhere)[0]).toMatchObject({ state: "started", task: null });
    // Listed, and not a started task at all.
    const plain = listed("running", { createdVia: "operator", spawnedBy: undefined });
    expect(cards(startRows(), plain)[0]).toMatchObject({ state: "started", task: null });
  });

  it("calls the task by its listed title, and the bot's label only as cleaned, bounded text", () => {
    const renamed = listed("done", { label: "Saturday maps" });
    expect(cards(startRows(), renamed)[0]!.title).toBe("Saturday maps");
    const long = "x".repeat(MAX_TITLE_CHARS + 40);
    const messy = {
      task: `\n\n  First line\twith\u0007bell  \nsecond line`,
      label: `  <b>Trail</b>\n\nmaps ${long}`,
      visible: true,
    };
    const [card] = cards(startRows(messy, ACCEPTED), {});
    expect(card!.brief).toBe("First line with bell");
    expect(card!.title).toBe(card!.label);
    expect(card!.label!.startsWith("<b>Trail</b> maps xxx")).toBe(true);
    expect(card!.label!.length).toBe(MAX_TITLE_CHARS);
    expect(card!.label!.endsWith("…")).toBe(true);
    expect(plainLine("y".repeat(MAX_BRIEF_LINE_CHARS + 1), MAX_BRIEF_LINE_CHARS)).toHaveLength(
      MAX_BRIEF_LINE_CHARS,
    );
  });

  it("says the bot reported back only for the reply whose run is that start's own report", () => {
    const report = `announce:v1:${CHILD}:${CHILD_RUN}`;
    const rows = [...startRows(), say(report, T + 2_500, "Compare trail maps finished.")];
    const [card] = cards(rows, listed("done"));
    const items = mapHistory(rows);
    expect(card!.reportedBack).toBe(items.at(-1)!.id);
    expect(items.at(-1)!.reportRunId).toBe(report);
    // A follow-up's report names the follow-up's run, and another task's names that task.
    const followUp = `announce:v1:${CHILD}:34fc6031-1ddb-45b5-93a8-70864702daa5`;
    const other = `announce:v1:agent:pip:dashboard:0000:${CHILD_RUN}`;
    for (const run of [followUp, other]) {
      const [unmatched] = cards([...startRows(), say(run, T + 2_500, "Done.")], listed("done"));
      expect(unmatched!.reportedBack).toBeNull();
    }
    // Words that look like a report are not one.
    const looksLike = [...startRows(), say(RUN, T + 2_500, report)];
    expect(cards(looksLike, listed("done"))[0]!.reportedBack).toBeNull();
  });

  it("marks only a report turn with its run id", () => {
    const items = mapHistory([
      ...startRows(),
      say(`announce:v1:${CHILD}:${CHILD_RUN}`, T + 2_500, "Finished."),
    ]);
    expect(items.filter((item) => item.reportRunId !== undefined)).toHaveLength(1);
  });
});

describe("the task list a card may use", () => {
  const task = listed("running").pip![0]!;
  const state = (read: { target: number; gatewayId: string | null } | null) => ({
    tasksByBot: { pip: [task] },
    discovery: { ...initialDiscoveryState, tasksRead: read && { ...read, connectedAt: 1 } },
    connection: { ...initialConnectionState, target: 3, gatewayId: "gw-a" },
  });

  it("is the list in state only when it was read on the gateway the host is pointed at", () => {
    expect(tasksShownHere(state({ target: 3, gatewayId: "gw-a" })).pip).toHaveLength(1);
    expect(tasksShownHere(state({ target: 3, gatewayId: null })).pip).toHaveLength(1);
    expect(tasksShownHere(state(null)).pip).toHaveLength(1);
    // Read before a switch to another gateway, or from another gateway at the same address.
    expect(tasksShownHere(state({ target: 2, gatewayId: "gw-a" }))).toEqual({});
    expect(tasksShownHere(state({ target: 3, gatewayId: "gw-b" }))).toEqual({});
  });

  it("finds a task only by its key and the conversation the list says it was started from", () => {
    expect(startedTaskOf({ pip: [task] }, CHILD, HERE)?.key).toBe(CHILD);
    expect(startedTaskOf({ pip: [task] }, CHILD, "agent:pip:main")).toBeNull();
    expect(startedTaskOf({ pip: [task] }, null, HERE)).toBeNull();
  });

  it("knows a start only by the gateway's tool", () => {
    const rows = startRows();
    const raw = new RawTable();
    const [run] = runsFromHistory(rows, null, { sessionKey: HERE, now: T, raw });
    const step = run!.steps[0]!;
    expect(isTaskStart(step, step.raw)).toBe(true);
    expect(isTaskStart({ ...step, toolName: "sessions_send" }, step.raw)).toBe(false);
  });
});
