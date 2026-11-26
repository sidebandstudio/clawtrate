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
  MAX_REFUSAL_CHARS,
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
  /** The payload of a call is read: as the view reads a finished call's, never an open one's. */
  payload = true,
): StartedTaskCard[] {
  const raw = new RawTable();
  const runs: Run[] = runsFromHistory(rows, inFlight, { sessionKey: HERE, now: T + 60_000, raw });
  return selectStartedTasks(
    { runs, items: mapHistory(rows), taskKey: HERE, tasks },
    (step) => step.raw ?? (payload ? (raw.get(HERE, step.id) as never) : null),
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
      // A row that says nothing of a run: the sidebar shows no state, so neither does the card.
      idle: "idle",
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
    // Before its payload is read, from what the step keeps of the call.
    const [kept] = cards(rows, listed("running"), RUN, false);
    expect(kept).toMatchObject({ state: "starting", title: LABEL, brief: BRIEF });
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

  it("keeps what the step holds of an accepted start when its whole payload is not here", () => {
    const raw = new RawTable();
    const rows = startRows();
    const runs = runsFromHistory(rows, null, { sessionKey: HERE, now: T + 60_000, raw });
    // The whole payload could not be read, or was let go.
    const [card] = selectStartedTasks(
      { runs, items: mapHistory(rows), taskKey: HERE, tasks: listed("running") },
      () => null,
    );
    expect(card).toMatchObject({ state: "working", taskKey: CHILD, title: LABEL, brief: BRIEF });
    expect(card!.task?.key).toBe(CHILD);
    // A result the step kept only part of says nothing.
    const cut = runs.map((run) => ({
      ...run,
      steps: run.steps.map((step) =>
        step.result ? { ...step, result: { ...step.result, totalChars: 99_999 } } : step,
      ),
    }));
    // A result text the gateway cut when it stored the row says nothing, even if it parses.
    const gatewayCut = runs.map((run) => ({
      ...run,
      steps: run.steps.map((step) => (step.result ? { ...step, resultCut: true as const } : step)),
    }));
    const [cutByGateway] = selectStartedTasks(
      { runs: gatewayCut, items: mapHistory(rows), taskKey: HERE, tasks: listed("running") },
      () => null,
    );
    expect(cutByGateway).toMatchObject({ state: "unknown", taskKey: null, task: null });
    const [partial] = selectStartedTasks(
      { runs: cut, items: mapHistory(rows), taskKey: HERE, tasks: listed("running") },
      () => null,
    );
    expect(partial).toMatchObject({ state: "unknown", taskKey: null, task: null });
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
    const longBrief = { ...VISIBLE, task: "y".repeat(MAX_BRIEF_LINE_CHARS + 50) };
    expect(cards(startRows(longBrief, ACCEPTED), {})[0]!.brief).toHaveLength(MAX_BRIEF_LINE_CHARS);
  });

  it("drops the invisible formatting a bot could use to make its words read like the card's own", () => {
    const [rlo, lri, pdi, zwsp] = [0x202e, 0x2066, 0x2069, 0x200b].map((c) =>
      String.fromCodePoint(c),
    );
    const format = /[\p{Cf}]/u;
    // Reversed on screen, this label would read "Done · Open task" in the title's place.
    const tricky = {
      task: `Check ${lri}the${pdi} drive${zwsp}`,
      label: `${rlo}ksat nepO · enoD`,
      visible: true,
    };
    const [card] = cards(startRows(tricky, ACCEPTED), {});
    expect(card!.title).toBe("ksat nepO · enoD");
    expect(card!.brief).toBe("Check the drive");
    // The listed task's title, the gateway's copy of a label, is cleaned the same way.
    const listedTitle = listed("running", { label: `Line one\nDone · Open task${rlo}abc` });
    const [fromList] = cards(startRows(), listedTitle);
    expect(fromList!.title).toBe("Line one Done · Open task abc");
    // So is the gateway's reason for a refusal.
    const reason = `label already in use: ${rlo}x`;
    const [refused] = cards(startRows(VISIBLE, { status: "error", error: reason }, true));
    expect(refused!.reason).toBe("label already in use: x");
    for (const text of [card!.title, card!.brief, fromList!.title, refused!.reason])
      expect(format.test(text ?? "")).toBe(false);
  });

  it("keeps the joiners an emoji or a word needs, as the sidebar shows them", () => {
    const zwj = String.fromCodePoint(0x200d);
    const zwnj = String.fromCodePoint(0x200c);
    const coder = `${String.fromCodePoint(0x1f469)}${zwj}${String.fromCodePoint(0x1f4bb)}`;
    const word = `می${zwnj}خواهم`;
    const [card] = cards(
      startRows({ ...VISIBLE, label: `${coder} Review`, task: `${word} it` }, ACCEPTED),
      {},
    );
    expect(card!.title).toBe(`${coder} Review`);
    expect(card!.brief).toBe(`${word} it`);
    const [fromList] = cards(startRows(), listed("running", { label: `${coder} Review the PR` }));
    expect(fromList!.title).toBe(`${coder} Review the PR`);
  });

  it("bounds the gateway's reason for a refusal", () => {
    const error = `<b>no</b> ${"r".repeat(MAX_REFUSAL_CHARS * 2)}`;
    const [card] = cards(startRows(VISIBLE, { status: "forbidden", error }, true));
    expect(card!.reason).toHaveLength(MAX_REFUSAL_CHARS);
    expect(card!.reason!.startsWith("<b>no</b> rrr")).toBe(true);
  });

  it("opens each of two tasks started in one turn by the key its own result names", () => {
    const other = "agent:pip:dashboard:9c1e2a44-1c3d-4b55-9e7f-0a1b2c3d4e5f";
    const rows = [
      user("#hand-off", T, RUN),
      call(RUN, T + 800, CALL, VISIBLE),
      result(RUN, T + 1_000, CALL, ACCEPTED),
      call(RUN, T + 1_100, "call_second", { ...VISIBLE, label: "Check the forecast" }),
      result(RUN, T + 1_200, "call_second", {
        ...ACCEPTED,
        childSessionKey: other,
        runId: "child-run-2",
        label: "Check the forecast",
      }),
    ];
    const sibling = mapSessionRow({
      key: other,
      agentId: "pip",
      createdVia: "spawn",
      spawnedBy: HERE,
      label: "Check the forecast",
      status: "done",
    })!;
    // The sibling is listed first, so a match by the conversation alone would find it first.
    const tasks = { pip: [sibling, listed("running").pip![0]!] };
    const [first, second] = cards(rows, tasks);
    expect([first!.task?.key, first!.state]).toEqual([CHILD, "working"]);
    expect([second!.task?.key, second!.state]).toEqual([other, "done"]);
  });

  it("reads whether a start was for a visible task from what the step keeps, when the call's arguments are long", () => {
    // Many long arguments: the step keeps only the keys the reading reads, `visible` among them.
    const extra = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`note${i}`, "n".repeat(900)]),
    );
    const rows = [
      user("#hand-off", T, RUN),
      call(RUN, T + 800, CALL, { ...VISIBLE, task: "t".repeat(3_000), ...extra }),
    ];
    const [card] = cards(rows, {}, RUN, false);
    expect(card).toMatchObject({ state: "starting", title: LABEL });
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

  it("matches the report when the gateway's history redaction masked part of its run id", () => {
    // Recorded on CI (OpenClaw 2026.10.6): the live run id, and the same id as `chat.history`
    // gave it, a stretch from "893268" masked by the gateway's redaction.
    const key = "agent:otto:dashboard:3a4879b7-2b95-4de8-b9b3-893268271164";
    const child = "324ec28d-e155-4f7f-9cdb-ba28ed88723c";
    const masked = "announce:v1:agent:otto:dashboard:3a4879b7-2b95-4de8-b9b3-893268…723c";
    const accepted = { ...ACCEPTED, childSessionKey: key, runId: child };
    const task = mapSessionRow({
      key,
      agentId: "otto",
      createdVia: "spawn",
      spawnedBy: HERE,
      label: LABEL,
      status: "done",
    })!;
    const rows = [
      ...startRows(VISIBLE, accepted),
      say(masked, T + 2_500, "Compare trail maps finished."),
    ];
    const [card] = cards(rows, { otto: [task] });
    expect(card!.reportedBack).toBe(mapHistory(rows).at(-1)!.id);

    // A follow-up to the same task whose run id the same mask also fits: two reports could be
    // this one, so it is neither's.
    const followUp = [
      user("#follow-up", T + 3_000, "run-f"),
      call("run-f", T + 3_100, "call_f", { sessionKey: key, message: "More." }, "sessions_send"),
      result(
        "run-f",
        T + 3_200,
        "call_f",
        { runId: "9999aaaa-0000-4000-8000-00000000723c", status: "accepted", sessionKey: key },
        false,
        "sessions_send",
      ),
    ];
    const both = [
      ...startRows(VISIBLE, accepted),
      ...followUp,
      say(masked, T + 4_000, "Finished."),
    ];
    expect(cards(both, { otto: [task] })[0]!.reportedBack).toBeNull();

    // A mask that another start's id fits, not this one's, is not this card's.
    const other = "announce:v1:agent:otto:dashboard:0000aaaa-2b95-4de8-b9b3-893268…723c";
    expect(
      cards([...startRows(VISIBLE, accepted), say(other, T + 2_500, "Done.")], { otto: [task] })[0]!
        .reportedBack,
    ).toBeNull();
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
  const state = (
    read: { target: number; gatewayId: string | null; connectedAt?: number } | null,
  ) => ({
    tasksByBot: { pip: [task] },
    discovery: { ...initialDiscoveryState, tasksRead: read && { connectedAt: 1, ...read } },
    connection: { ...initialConnectionState, target: 3, gatewayId: "gw-a", connectedAt: 1 },
  });

  it("is the list in state only when it was read on the gateway the host is pointed at", () => {
    expect(tasksShownHere(state({ target: 3, gatewayId: "gw-a" })).pip).toHaveLength(1);
    expect(tasksShownHere(state({ target: 3, gatewayId: null })).pip).toHaveLength(1);
    expect(tasksShownHere(state(null)).pip).toHaveLength(1);
    // Read before a switch to another gateway, or from another gateway at the same address.
    expect(tasksShownHere(state({ target: 2, gatewayId: "gw-a" }))).toEqual({});
    expect(tasksShownHere(state({ target: 3, gatewayId: "gw-b" }))).toEqual({});
    // Read before the gateway named itself, on a connection since replaced: it may be another's.
    expect(tasksShownHere(state({ target: 3, gatewayId: null, connectedAt: 0 }))).toEqual({});
    // A named list after a reconnect, before the gateway names itself again: it may be another's.
    const reconnected = {
      ...state({ target: 3, gatewayId: "gw-a", connectedAt: 0 }),
      connection: { ...initialConnectionState, target: 3, gatewayId: null, connectedAt: 1 },
    };
    expect(tasksShownHere(reconnected)).toEqual({});
    // The same connection, its gateway's name not read yet: the list it read holds.
    expect(
      tasksShownHere({ ...reconnected, connection: { ...reconnected.connection, connectedAt: 0 } })
        .pip,
    ).toHaveLength(1);
  });

  it("finds a task only by its key and the conversation the list says it was started from", () => {
    const sibling = { ...task, key: "agent:pip:dashboard:sibling", title: "Another task" };
    expect(startedTaskOf({ pip: [sibling, task] }, CHILD, HERE)?.key).toBe(CHILD);
    expect(startedTaskOf({ pip: [sibling] }, CHILD, HERE)).toBeNull();
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

// The parent's rows as OpenClaw 2026.11.10 returns them on a development gateway (#636): each run
// of the started task that ends gives the parent the gateway's completion row (an assistant row
// with `phase: "commentary"`, a `subagent_completion` block, no text and no run), and a report
// turn follows for the task's first run and for each run a person's message started there, but
// not for one a follow-up started.
describe("a task a bot starts, with its reports as OpenClaw 2026.11.10 sends them (#636)", () => {
  const PERSON_RUN = "c9f93737-d68f-4739-a4b8-67224510941c";
  const FOLLOW_RUN = "729c74da-6ea1-4869-828a-a93ea7e1e6ce";
  const completion = (at: number, run: string, label?: string) => ({
    role: "assistant",
    phase: "commentary",
    display: true,
    timestamp: at,
    subagentCompletions: [{ runId: run, sessionKey: CHILD, ...(label ? { label } : {}) }],
    __openclaw: { id: `c-${at}`, seq: at - T },
    content: [{ type: "subagent_completion" }],
  });
  const followUp = [
    user("#follow-up", T + 40_000, "run-f"),
    call(
      "run-f",
      T + 40_900,
      "call_f",
      { sessionKey: CHILD, message: "More shade?" },
      "sessions_send",
    ),
    result(
      "run-f",
      T + 41_800,
      "call_f",
      { runId: FOLLOW_RUN, status: "accepted", sessionKey: CHILD, delivery: { status: "pending" } },
      false,
      "sessions_send",
    ),
    say("run-f", T + 42_000, "I added that to the task."),
  ];
  const rows = [
    ...startRows(),
    completion(T + 3_870, CHILD_RUN, LABEL),
    say(`announce:v1:${CHILD}:${CHILD_RUN}`, T + 4_620, "Compare trail maps finished."),
    completion(T + 22_270, PERSON_RUN, LABEL),
    say(`announce:v1:${CHILD}:${PERSON_RUN}`, T + 22_600, "Compare trail maps finished."),
    ...followUp,
    completion(T + 46_900, FOLLOW_RUN),
  ];

  it("ties the card to its own run's report, not to the one after the person's run", () => {
    const items = mapHistory(rows);
    const [card] = cards(rows, listed("done"));
    const first = items.find((item) => item.reportRunId === `announce:v1:${CHILD}:${CHILD_RUN}`);
    expect(card!.reportedBack).toBe(first!.id);
    // The report after the person's run is the bot's own turn, shown as one, with its own run.
    expect(items.filter((item) => item.reportRunId).map((item) => item.reportRunId)).toEqual([
      `announce:v1:${CHILD}:${CHILD_RUN}`,
      `announce:v1:${CHILD}:${PERSON_RUN}`,
    ]);
    // With only the later report, the card says nothing of a report.
    const later = rows.filter((row) => row !== rows[startRows().length + 1]);
    expect(cards(later, listed("done"))[0]!.reportedBack).toBeNull();
  });

  it("draws nothing for the gateway's completion rows, and makes no run of them", () => {
    const items = mapHistory(rows);
    expect(items.some((item) => item.id.startsWith("c-"))).toBe(false);
    // The same items and runs as without them; an item's id ends with its row's place.
    const without = rows.filter((row) => !("subagentCompletions" in row));
    const shown = (list: unknown[]) =>
      mapHistory(list).map(({ id, ...item }) => [id.replace(/:\d+$/, ""), item]);
    expect(shown(rows)).toEqual(shown(without));
    const runs = (list: unknown[]) =>
      runsFromHistory(list, null, { sessionKey: HERE, now: T + 60_000, raw: new RawTable() }).map(
        (run) => [run.id, run.state, run.anchorItemId?.replace(/:\d+$/, "")],
      );
    expect(runs(rows)).toEqual(runs(without));
  });
});
