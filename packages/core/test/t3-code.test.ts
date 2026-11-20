// The reading of T3 Code calls and their thread cards (conversation.md,
// section 11). Results are shaped as the installed T3 Code build
// 0.1.8-nightly.20261109.4433 returns them (provider-accounts-and-t3-code.md,
// B.2), and as OpenClaw 2026.10.6 passes them on: live in
// `details.structuredContent`, in history rendered in the result's text as
// `structuredContent:` and its JSON with sorted keys. Every name is invented.

import { describe, expect, it } from "vitest";
import type { T3Call as T3CallLike } from "../src/index.ts";
import {
  applyAgentEvent,
  callFromBlock,
  callFromStep,
  emptyActivity,
  fitT3Facts,
  kindOf,
  lineOf,
  mapHistory,
  MAX_T3_FACTS_CHARS,
  placeT3,
  RawTable,
  readDimensions,
  readLines,
  runsFromHistory,
  structuredFromText,
  t3CallOf,
  t3ArgFacts,
  t3ResultFacts,
  latestSent,
  threadKey,
  threadStateOf,
  threadLink,
  statusWords,
  threadTitle,
  workMayContinue,
  type ActionCall,
  type ReadingContext,
  type T3Sequence,
} from "../src/index.ts";

type Rec = Record<string, unknown>;

const SERVER = "t3code";
const name = (tool: string, server = SERVER) => `${server}__${tool}`;
const MAP: ReadingContext = {
  toolServers: Object.fromEntries(
    [
      "t3_project_list",
      "t3_thread_launch",
      "t3_thread_send",
      "t3_thread_read",
      "t3_thread_wait",
      "t3_thread_list",
      "t3_thread_interrupt",
    ].map((tool) => [name(tool), { server: SERVER, tool }]),
  ),
};

/** JSON with sorted keys, two spaces: the gateway's rendering (`stableStringify`, then pretty). */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value as Rec)
        .sort()
        .map((key) => [key, sorted((value as Rec)[key])]),
    );
  return value;
}
const rendered = (structured: Rec) =>
  `structuredContent:\n${JSON.stringify(sorted(structured), null, 2)}`;

let seq = 0;
/** A call through the engine, live: its start and, unless open, its result as the gateway sends it. */
function live(
  tool: string,
  args: Rec,
  structured: Rec | null,
  opts: {
    isError?: boolean;
    open?: boolean;
    server?: string;
    resultTool?: string;
    ctx?: ReadingContext;
  } = {},
): ActionCall {
  seq += 1;
  const id = `call_${seq}`;
  const server = opts.server ?? SERVER;
  const ctx = { sessionKey: "agent:otto:backup", now: 9_000, raw: new RawTable() };
  let activity = emptyActivity;
  let n = 0;
  const send = (stream: string, data: Rec) => {
    n += 1;
    activity = applyAgentEvent(
      activity,
      { runId: "run-1", seq: n, stream, ts: 1_000 + n * 100, sessionKey: ctx.sessionKey, data },
      ctx,
    ).activity;
  };
  send("lifecycle", { phase: "start", startedAt: 1_000 });
  send("tool", { phase: "start", name: name(tool, server), toolCallId: id, args });
  if (!opts.open) {
    send("tool", {
      phase: "result",
      name: name(tool, server),
      toolCallId: id,
      isError: opts.isError === true,
      result: {
        content: [{ type: "text", text: structured ? rendered(structured) : "MCP tool failed." }],
        details: {
          mcpServer: server,
          mcpTool: opts.resultTool ?? tool,
          ...(structured ? { structuredContent: structured } : {}),
          ...(opts.isError ? { status: "error" } : {}),
        },
      },
    });
  }
  const run = activity.runs[0]!;
  return callFromStep(
    run.steps.find((s) => s.toolCallId === id)!,
    run,
  );
}

/** The same call from history alone: its rows, which keep no details for a tool server. */
function fromHistory(
  tool: string,
  args: Rec,
  structured: Rec | null,
  isError = false,
  opts: { text?: string; cut?: boolean } = {},
) {
  seq += 1;
  const id = `call_${seq}`;
  const rows = [
    { role: "user", content: "Go.", timestamp: 1_000, __openclaw: { id: "u1" } },
    {
      role: "assistant",
      content: [{ type: "toolCall", id, name: name(tool), arguments: args }],
      timestamp: 2_000,
      __openclaw: { id: "a1", runId: "run-h" },
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: name(tool),
      content: [
        {
          type: "text",
          text: opts.text ?? (structured ? rendered(structured) : "MCP tool failed."),
        },
      ],
      isError,
      timestamp: 2_400,
      __openclaw: { id: "r1", runId: "run-h", ...(opts.cut ? { truncated: true } : {}) },
    },
  ];
  const ctx = { sessionKey: "agent:otto:backup", now: 9_000, raw: new RawTable() };
  const block = mapHistory(rows)
    .flatMap((item) => item.blocks)
    .find((each) => each.kind === "tool-call")!;
  const run = runsFromHistory(rows, null, ctx)[0]!;
  const step = run.steps.find((s) => s.toolCallId === id)!;
  return {
    alone: callFromBlock(
      block as Extract<typeof block, { kind: "tool-call" }>,
      undefined,
      undefined,
    ),
    withStep: callFromBlock(block as Extract<typeof block, { kind: "tool-call" }>, step, run),
  };
}

const THREAD = "mcp:00000000-0000-4000-8000-000000000002";
const LAUNCH_ARGS = {
  projectId: "proj-backup-scripts",
  title: "Skip machines that are asleep",
  workspaceStrategy: { type: "root", branch: "main" },
  message: "Make the weekly check skip machines that are asleep.\nAdd a test.",
};
const LAUNCHED = {
  threadId: THREAD,
  link: `https://t3-code.example/threads/local/${THREAD}`,
  projectId: "proj-backup-scripts",
  modelSelection: { instanceId: "codex", model: "stand-in-model" },
  runId: "run-1",
  status: "running",
};
const readResult = (items: Rec[], hasMore = false, status = "completed") => ({
  thread: {
    threadId: THREAD,
    title: "Skip machines",
    status,
    latestRunId: "run-1",
    activeRunId: null,
  },
  recentRuns: [{ runId: "run-1", status }],
  items,
  nextPosition: items.length ? items.length - 1 : null,
  hasMore,
});
const item = (type: string, text: string, runId = "run-1", cut = false) => ({
  itemId: `item-${type}-${runId}`,
  runId,
  type,
  text,
  textTruncated: cut,
  ...(cut ? { nextTextOffset: text.length } : {}),
});

const t3 = (call: ActionCall, ctx: ReadingContext = MAP) => t3CallOf(call, ctx);

describe("which calls are T3 Code's (11.1)", () => {
  it("F-132: a call is T3 Code's when its result names one of the seven tools, on a server of any name", () => {
    const c = live("t3_thread_launch", LAUNCH_ARGS, LAUNCHED, { server: "my-coding-box" });
    expect(t3(c, {})?.tool).toBe("t3_thread_launch");
    expect(t3(c, {})?.server).toBe("my-coding-box");
    expect(kindOf(c, {}).kind).toBe("t3");
  });

  it("F-132: another tool on the same server is an ordinary tool-server call, not T3 Code's", () => {
    const c = live("deploy_preview", {}, { ok: true });
    expect(t3(c)).toBeNull();
    expect(kindOf(c, MAP).kind).toBe("server");
  });

  it("F-132: before its result, only the gateway's name map makes a call T3 Code's", () => {
    const open = live("t3_thread_send", { threadId: THREAD, message: "Also a test." }, null, {
      open: true,
    });
    expect(t3(open, {})).toBeNull();
    expect(kindOf(open, {}).kind).toBe("tool");
    expect(t3(open, MAP)?.state).toBe("started");
    expect(t3(open, MAP)?.mapped).toBe(true);
  });

  it("F-132 F-134: the result overrules the map: a call the map named T3 Code's whose result names another tool is not", () => {
    const c = live(
      "t3_thread_read",
      { threadId: THREAD },
      { notes: [] },
      { resultTool: "T3_thread_read" },
    );
    expect(t3(c, MAP)).toBeNull();
    expect(kindOf(c, MAP).kind).toBe("server");
  });

  it("F-132: a name that looks like T3 Code's tells nothing: without the map or a result it is the general card", () => {
    const c: ActionCall = { ...live("t3_thread_wait", { threadId: THREAD }, null, { open: true }) };
    expect(kindOf(c, {}).kind).toBe("tool");
    expect(t3(c, { toolServers: { [c.name]: { server: SERVER, tool: "notes_read" } } })).toBeNull();
  });

  it("F-132 F-134: from history, which keeps no tool server or tool, a call is not T3 Code's on the map; live, never Call made on the map alone", () => {
    // A reload places a call in a thread only when the stored result identifies it (11.4).
    const read = fromHistory("t3_thread_launch", LAUNCH_ARGS, LAUNCHED);
    expect(t3(read.alone)).toBeNull();
    expect(t3(read.withStep)).toBeNull();
    expect(t3(fromHistory("t3_thread_launch", LAUNCH_ARGS, null).alone)).toBeNull();
    // Live, a result that names no tool and carries nothing of T3 Code's is not T3 Code's by the map.
    const bare: ActionCall = {
      ...live("t3_thread_launch", LAUNCH_ARGS, null, { open: true }),
      status: "returned",
      text: "ok",
      t3: null,
    };
    expect(t3(bare)).toBeNull();
    const failed = fromHistory("t3_thread_send", { threadId: THREAD, message: "x" }, null, true);
    expect(t3(failed.alone)).toBeNull();
  });
});

describe("each call's state (11)", () => {
  it("F-134: Call started while open, Call made once returned without an error, which says nothing of the work", () => {
    expect(t3(live("t3_thread_launch", LAUNCH_ARGS, null, { open: true }))?.state).toBe("started");
    const made = t3(live("t3_thread_launch", LAUNCH_ARGS, LAUNCHED))!;
    expect(made.state).toBe("made");
    expect(lineOf(made.call, MAP).state).toMatchObject({ word: "Call made" });
  });

  it("F-314: an error result is Failed, with T3 Code's code and message", () => {
    const failure = {
      _tag: "OrchestratorMcpFailure",
      code: "thread_not_sendable",
      message: "Nothing to steer.",
    };
    const c = t3(
      live("t3_thread_send", { threadId: THREAD, message: "x", mode: "steer" }, failure, {
        isError: true,
      }),
    )!;
    expect(c.state).toBe("failed");
    expect(c.error).toEqual({ code: "thread_not_sendable", message: "Nothing to steer." });
    expect(lineOf(c.call, MAP).state).toMatchObject({ word: "Failed", tone: "danger" });
  });

  it("F-470: a stop before the result is Delivery unknown; a plugin's refusal is Not sent", () => {
    const open = live("t3_thread_send", { threadId: THREAD, message: "x" }, null, { open: true });
    const stopped: ActionCall = { ...open, status: "stopped", runStopped: true };
    expect(t3(stopped)?.state).toBe("unknown");
    expect(lineOf(stopped, MAP).state).toMatchObject({ word: "Delivery unknown" });
    const refused: ActionCall = {
      ...open,
      status: "returned",
      text: "Blocked by a rule.",
      details: { mcpServer: SERVER, mcpTool: "t3_thread_send", status: "blocked" },
    };
    expect(t3(refused)?.state).toBe("not-sent");
    expect(lineOf(refused, MAP).state).toMatchObject({ word: "Not sent" });
  });

  it("F-134: waiting for approval while an approval names the call", () => {
    const open = live("t3_thread_launch", LAUNCH_ARGS, null, { open: true });
    expect(t3({ ...open, status: "waiting" })?.state).toBe("waiting");
  });
});

describe("a thread's identity (11.2)", () => {
  it("F-313 F-441: a thread is its server, environment and id together; the same id on two servers is two threads", () => {
    const a = t3(live("t3_thread_read", { threadId: THREAD }, readResult([])))!;
    const b = t3(
      live("t3_thread_read", { threadId: THREAD }, readResult([]), { server: "laptop-t3" }),
      {
        ...MAP,
      },
    )!;
    expect(a.thread!.key).toBe(threadKey(SERVER, null, THREAD));
    expect(b.thread!.key).not.toBe(a.thread!.key);
    const env = t3(
      live("t3_thread_read", { threadId: THREAD, environmentId: "env-2" }, readResult([])),
    )!;
    expect(env.thread!.key).toBe(threadKey(SERVER, "env-2", THREAD));
    expect(env.thread!.key).not.toBe(a.thread!.key);
  });

  it("F-441: a launch learns its thread from its result; one that failed has no thread and is a card of its own", () => {
    expect(t3(live("t3_thread_launch", LAUNCH_ARGS, null, { open: true }))!.thread).toBeNull();
    const failure = {
      _tag: "OrchestratorMcpFailure",
      code: "target_required",
      message: "Pass projectId.",
    };
    const failed = t3(live("t3_thread_launch", LAUNCH_ARGS, failure, { isError: true }))!;
    expect(failed.thread).toBeNull();
    const placed = placeT3([{ type: "t3", call: failed }]);
    expect(placed.get(failed.id)).toEqual({ type: "own", asked: null, head: null });
  });

  it("F-441: two launches to the same project are two threads, never matched by project or title", () => {
    const one = t3(live("t3_thread_launch", LAUNCH_ARGS, LAUNCHED))!;
    const two = t3(live("t3_thread_launch", LAUNCH_ARGS, { ...LAUNCHED, threadId: "mcp:other" }))!;
    const placed = placeT3([
      { type: "t3", call: one },
      { type: "t3", call: two },
    ]);
    expect(placed.get(one.id)?.type).toBe("card");
    expect(placed.get(two.id)?.type).toBe("card");
  });
});

describe("one card for each thread, and where each later call goes (11.2, 11.4)", () => {
  const launch = () => t3(live("t3_thread_launch", LAUNCH_ARGS, LAUNCHED))!;
  const wait = (open = false) =>
    t3(
      live(
        "t3_thread_wait",
        { threadId: THREAD, timeoutMs: 30000 },
        open ? null : { threadId: THREAD, runId: "run-1", status: "completed", timedOut: false },
        { open },
      ),
    )!;
  const send = () =>
    t3(
      live(
        "t3_thread_send",
        { threadId: THREAD, message: "Also a test." },
        { threadId: THREAD, runId: "run-2", status: "running", delivery: "started" },
      ),
    )!;

  it("F-313: a call whose result names the thread, directly under its card, joins it", () => {
    const l = launch();
    const w = wait();
    const placed = placeT3([
      { type: "t3", call: l },
      { type: "t3", call: w },
    ]);
    expect(placed.get(l.id)).toMatchObject({ type: "card", head: l.id });
    expect(placed.get(w.id)).toMatchObject({ type: "joined", head: l.id });
  });

  it("F-313: a call joins only after its result: open, it keeps its line", () => {
    const l = launch();
    const w = wait(true);
    expect(
      placeT3([
        { type: "t3", call: l },
        { type: "t3", call: w },
      ]).get(w.id)?.type,
    ).toBe("line");
  });

  it("F-313: after a bubble, or with its line held by the reader, a call keeps its line and is an item of the card too", () => {
    const l = launch();
    const s = send();
    const afterBubble = placeT3([
      { type: "t3", call: l },
      { type: "other" },
      { type: "t3", call: s },
    ]);
    expect(afterBubble.get(s.id)).toMatchObject({ type: "line", head: l.id });
    const held = placeT3(
      [
        { type: "t3", call: l },
        { type: "t3", call: s },
      ],
      (id) => id === s.id,
    );
    expect(held.get(s.id)?.type).toBe("line");
    const otherRecord = placeT3([
      { type: "t3", call: l },
      { type: "boundary" },
      { type: "t3", call: s },
    ]);
    expect(otherRecord.get(s.id)?.type).toBe("line");
  });

  it("F-313: calls that joined one by one keep joining: the card and its joined calls are one item above", () => {
    const l = launch();
    const s = send();
    const w = wait();
    const placed = placeT3([
      { type: "t3", call: l },
      { type: "t3", call: s },
      { type: "t3", call: w },
    ]);
    expect(placed.get(s.id)?.type).toBe("joined");
    expect(placed.get(w.id)?.type).toBe("joined");
  });

  it("F-313: a thread whose launch is not in the record has its card at its first call there", () => {
    const s = send();
    const w = wait();
    const placed = placeT3([{ type: "t3", call: s }, { type: "other" }, { type: "t3", call: w }]);
    expect(placed.get(s.id)).toMatchObject({ type: "card", head: s.id });
    expect(placed.get(w.id)).toMatchObject({ type: "line", head: s.id });
  });

  it("F-313: listings are lines of their own and fold with each other, never a thread's card", () => {
    const projects = live(
      "t3_project_list",
      {},
      { projects: [{ id: "a" }, { id: "b" }], nextCursor: null },
    );
    const threads = live(
      "t3_thread_list",
      { allProjects: true },
      { threads: [{ threadId: THREAD }], total: 1 },
    );
    const p = t3(projects)!;
    expect(placeT3([{ type: "t3", call: p }]).get(p.id)).toEqual({ type: "listing" });
    expect(kindOf(projects, MAP).key).toBe("t3:listing");
    expect(kindOf(projects, MAP).key).toBe(kindOf(threads, MAP).key);
    expect(lineOf(projects, MAP)).toMatchObject({
      verb: "Looked through",
      object: "T3 Code projects",
      detail: "2 projects",
    });
    expect(lineOf(threads, MAP).detail).toBe("1 thread");
  });

  it("F-313: a thread's calls never fold, and a listing known only from its result does not fold", () => {
    expect(kindOf(launch().call, MAP).key).toBeNull();
    expect(kindOf(send().call, MAP).key).toBeNull();
    const unmapped = live("t3_thread_list", { allProjects: true }, { threads: [], total: 0 });
    expect(kindOf(unmapped, {}).key).toBeNull();
  });
});

describe("a thread's state (11.2)", () => {
  const open = (tool: string, args: Rec) =>
    t3(live(tool, { threadId: THREAD, ...args }, null, { open: true }))!;
  const done = (tool: string, structured: Rec, args: Rec = {}) =>
    t3(live(tool, { threadId: THREAD, ...args }, structured))!;
  const launch = () => t3(live("t3_thread_launch", LAUNCH_ARGS, LAUNCHED))!;

  it("F-134: an open call first: Waiting for approval, else Call started for a sending call, else Checking", () => {
    const l = launch();
    const read = open("t3_thread_read", {});
    expect(threadStateOf([l, read])).toEqual({ type: "open", word: "checking" });
    const send = open("t3_thread_send", { message: "x" });
    expect(threadStateOf([l, read, send])).toEqual({ type: "open", word: "call-started" });
    const waiting = { ...open("t3_thread_interrupt", {}), state: "waiting" as const };
    expect(threadStateOf([l, read, send, waiting])).toEqual({ type: "open", word: "waiting" });
  });

  it("F-134: else the one status T3 Code reported, with its time; several reports are Call made, each on its own item", () => {
    const l = launch();
    expect(threadStateOf([l])).toMatchObject({
      type: "reported",
      status: "running",
      callId: l.id,
      at: l.call.endedAt,
    });
    const w = done("t3_thread_wait", {
      threadId: THREAD,
      runId: "run-1",
      status: "completed",
      timedOut: false,
    });
    expect(threadStateOf([l, w])).toMatchObject({ type: "call", state: "made" });
    expect([l.reported, w.reported]).toEqual(["running", "completed"]);
  });

  it("F-134: a wait that timed out reports its run's status: Running, never Completed", () => {
    const w = done("t3_thread_wait", {
      threadId: THREAD,
      runId: "run-1",
      status: "running",
      timedOut: true,
    });
    expect(threadStateOf([w])).toMatchObject({ type: "reported", status: "running" });
  });

  it("F-134 F-314: a failed check or a refused follow-up shows on its own item and does not change the thread's word", () => {
    const l = launch();
    const failure = { _tag: "OrchestratorMcpFailure", code: "thread_not_sendable", message: "No." };
    const refused = t3(
      live("t3_thread_send", { threadId: THREAD, message: "x", mode: "steer" }, failure, {
        isError: true,
      }),
    )!;
    expect(refused.state).toBe("failed");
    expect(threadStateOf([l, refused])).toMatchObject({ type: "reported", status: "running" });
  });

  it("F-134: a stop asked for reports interrupt_requested, which is Stop requested, not proof that it stopped", () => {
    const i = done(
      "t3_thread_interrupt",
      { threadId: THREAD, runId: "run-1", status: "interrupt_requested" },
      { stop: true },
    );
    expect(threadStateOf([i])).toMatchObject({
      type: "reported",
      status: "interrupt_requested",
    });
  });

  it("F-134: a launch without a message reports no status, so the thread falls to its latest sending call's state", () => {
    const idle = t3(
      live(
        "t3_thread_launch",
        { ...LAUNCH_ARGS, message: undefined },
        { ...LAUNCHED, runId: null, status: null },
      ),
    )!;
    expect(idle.reported).toBeNull();
    expect(threadStateOf([idle])).toEqual({ type: "call", state: "made", callId: idle.id });
    const failure = {
      _tag: "OrchestratorMcpFailure",
      code: "thread_not_found",
      message: "No thread.",
    };
    const failed = t3(
      live("t3_thread_send", { threadId: THREAD, message: "x" }, failure, { isError: true }),
    )!;
    expect(threadStateOf([failed])).toEqual({ type: "call", state: "failed", callId: failed.id });
  });

  it("F-137: after a stop, a thread whose latest sending call was made may go on in T3 Code", () => {
    const l = launch();
    expect(workMayContinue([l])).toBe(false);
    expect(workMayContinue([{ ...l, call: { ...l.call, runStopped: true } }])).toBe(true);
    const unreturned = { ...l, state: "unknown" as const, call: { ...l.call, runStopped: true } };
    expect(workMayContinue([unreturned])).toBe(false);
    // A later call's "Aborted" alone is no observed stop of the handoff's run: no note.
    const aborted: T3CallLike = {
      ...l,
      id: "call_w",
      role: "wait",
      tool: "t3_thread_wait",
      state: "unknown",
      call: { ...l.call, status: "returned", isError: true, text: "Aborted" },
    };
    expect(workMayContinue([l, aborted])).toBe(false);
  });
});

describe("what a read read: its two dimensions (11.1, 11.3)", () => {
  const read = (structured: Rec) => t3(live("t3_thread_read", { threadId: THREAD }, structured))!;

  it("F-133: read to the end only when there are no more pages and no item of the run read is cut", () => {
    const r = read(readResult([item("user_message", "Go."), item("assistant_message", "Done.")]));
    expect(readDimensions(r.facts)).toMatchObject({ toEnd: true });
    expect(readLines(readDimensions(r.facts))).toEqual(["Read to the end"]);
    expect(r.facts?.reply).toBe("Done.");
  });

  it("F-133: more pages: first page only, the reply may continue", () => {
    const r = read(readResult([item("user_message", "Go.")], true));
    expect(readLines(readDimensions(r.facts))).toEqual(["First page only: the reply may continue"]);
  });

  it("F-133: the last page with the reply's text cut is not read to the end", () => {
    const r = read(readResult([item("assistant_message", "Done, and then", "run-1", true)], false));
    expect(readDimensions(r.facts)).toMatchObject({
      toEnd: false,
      morePages: false,
      replyCut: true,
    });
    expect(readLines(readDimensions(r.facts))).toEqual([
      "Part of the reply only: its text was cut, and the rest was not read",
    ]);
  });

  it("F-133: another item of the run cut, with more pages: both lines together", () => {
    const r = read(
      readResult([item("tool", "Ran", "run-1", true), item("assistant_message", "Done.")], true),
    );
    expect(readLines(readDimensions(r.facts))).toEqual([
      "First page only: the reply may continue",
      "Part of the run only: an item's text was cut, and the rest was not read",
    ]);
  });

  it("F-133: an item of an earlier run that was cut is not the latest run's", () => {
    const r = read(
      readResult([
        item("assistant_message", "Old", "run-0", true),
        item("assistant_message", "New."),
      ]),
    );
    expect(readDimensions(r.facts).toEnd).toBe(true);
    expect(r.facts?.reply).toBe("New.");
  });

  it("F-133: from history, a read is an ordinary call: the stored rendering alone does not make it T3 Code's", () => {
    const structured = readResult([item("assistant_message", "Done, and then", "run-1", true)]);
    const h = fromHistory("t3_thread_read", { threadId: THREAD }, structured);
    expect(t3(h.alone)).toBeNull();
    expect(t3(h.withStep)).toBeNull();
  });

  it("F-133: a rendering history cut is not read, and says only that it could not be read", () => {
    // The gateway's mark and the app's own cap set the same flag: neither is claimed as a cut.
    const whole = rendered(readResult([item("assistant_message", "x".repeat(9000))]));
    expect(structuredFromText(whole.slice(0, 8000))).toBeNull();
    expect(readLines(readDimensions(null, true))).toEqual([
      "This result could not be read here: what it reported is not known.",
    ]);
  });
});

describe("what the engine keeps (bounds)", () => {
  it("F-133: a read's facts fit their bound, its long reply cut and said to be, never an id", () => {
    const facts = t3ResultFacts(
      readResult([item("assistant_message", "y".repeat(30_000))]),
      false,
    )!;
    const fitted = fitT3Facts({ ...facts, argThread: THREAD })!;
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(MAX_T3_FACTS_CHARS);
    expect(fitted.replyShort).toBe(true);
    expect(fitted.argThread).toBe(THREAD);
    expect(fitted.threadId).toBe(THREAD);
  });

  it("F-132: the engine keeps facts only for a tool-server call, and from a result that names its server", () => {
    const c = live("t3_thread_launch", LAUNCH_ARGS, LAUNCHED);
    expect(c.t3).toMatchObject({ read: true, threadId: THREAD, status: "running" });
    expect(structuredFromText("plain text")).toBeNull();
  });
});

describe("the change in place (11.4)", () => {
  it("F-132 F-134: a call the map did not name is the general card while it runs, and its result makes it T3 Code's, under the same id", () => {
    const open = live("t3_thread_launch", LAUNCH_ARGS, null, { open: true });
    const done = live("t3_thread_launch", LAUNCH_ARGS, LAUNCHED);
    const ctx: ReadingContext = {};
    expect(lineOf(open, ctx).kind).toBe("tool");
    expect(lineOf(open, ctx).state).toMatchObject({ word: "Call started" });
    const before = { ...done, id: open.id };
    expect(lineOf(before, ctx).kind).toBe("t3");
    expect(lineOf(before, ctx).id).toBe(open.id);
    expect(lineOf(before, ctx)).toMatchObject({ verb: "Messaged", object: "T3 Code" });
  });

  it("F-132 F-134: a call the map named T3 Code's becomes the other tool's card in place when its result names another tool", () => {
    const open = live("t3_thread_read", { threadId: THREAD }, null, { open: true });
    expect(lineOf(open, MAP).kind).toBe("t3");
    const overruled = {
      ...live(
        "t3_thread_read",
        { threadId: THREAD },
        { notes: [] },
        { resultTool: "T3_thread_read" },
      ),
      id: open.id,
    };
    const l = lineOf(overruled, MAP);
    expect(l.kind).toBe("server");
    expect(l.id).toBe(open.id);
  });

  it("F-313: a call whose line was held keeps it when its result names the thread, so nothing the reader had moves", () => {
    const l = t3(live("t3_thread_launch", LAUNCH_ARGS, LAUNCHED))!;
    const w = t3(
      live(
        "t3_thread_wait",
        { threadId: THREAD },
        { threadId: THREAD, runId: "run-1", status: "completed", timedOut: false },
      ),
    )!;
    const seq: T3Sequence = [
      { type: "t3", call: l },
      { type: "t3", call: w },
    ];
    expect(placeT3(seq, () => true).get(w.id)?.type).toBe("line");
    expect(placeT3(seq, () => false).get(w.id)?.type).toBe("joined");
  });
});

describe("own lines' words (11.4)", () => {
  it("F-313: each later call's line in T3 Code's family, with the first line sent or the status it got back", () => {
    const s = live(
      "t3_thread_send",
      { threadId: THREAD, message: "Also a test.\nThanks." },
      { threadId: THREAD, status: "running", delivery: "steered" },
    );
    expect(lineOf(s, MAP)).toMatchObject({
      verb: "Followed up with",
      object: "T3 Code",
      detail: "Also a test.",
    });
    const r = live("t3_thread_read", { threadId: THREAD }, readResult([]));
    expect(lineOf(r, MAP)).toMatchObject({
      verb: "Read the thread in",
      object: "T3 Code",
      detail: "Completed",
    });
    const w = live(
      "t3_thread_wait",
      { threadId: THREAD },
      { threadId: THREAD, status: "running", timedOut: true },
    );
    expect(lineOf(w, MAP)).toMatchObject({ verb: "Waited for", detail: "Running" });
    const i = live(
      "t3_thread_interrupt",
      { threadId: THREAD },
      { threadId: THREAD, status: "interrupt_requested" },
    );
    expect(lineOf(i, MAP)).toMatchObject({
      verb: "Asked",
      object: "T3 Code to stop",
      detail: "Stop requested",
    });
    // A listing with no known delivery still says which listing was asked for.
    for (const [tool, object] of [
      ["t3_project_list", "T3 Code for its projects"],
      ["t3_thread_list", "T3 Code for its threads"],
    ] as const) {
      const listing = live(tool, {}, null, { open: true });
      expect(lineOf({ ...listing, status: "stopped", runStopped: true }, MAP)).toMatchObject({
        verb: "Asked",
        object,
      });
    }
    const open = live("t3_thread_read", { threadId: THREAD }, null, { open: true });
    expect(lineOf(open, MAP)).toMatchObject({
      verb: "Reading the thread in",
      running: "Reading the thread in T3 Code",
    });
  });
});

describe("one report shows its status; several show Call made (11.2)", () => {
  // The record gives no order for results that tie or carry no time: the card claims none.
  const args = { threadId: THREAD };
  const wait = { threadId: THREAD, status: "completed", timedOut: false };
  const read = readResult([], false, "running");

  it("F-134: live, two results in the same millisecond: Call made, each status on its own item", () => {
    const ctx = { sessionKey: "agent:otto:backup", now: 9_000, raw: new RawTable() };
    let activity = emptyActivity;
    let serial = 0;
    const ingest = (data: Rec, ts: number) => {
      activity = applyAgentEvent(
        activity,
        { runId: "one-run", seq: ++serial, stream: "tool", ts, sessionKey: ctx.sessionKey, data },
        ctx,
      ).activity;
    };
    const ingestTool = (id: string, tool: string, result?: Rec) =>
      ingest(
        result
          ? {
              phase: "result",
              name: name(tool),
              toolCallId: id,
              isError: false,
              result: {
                content: [{ type: "text", text: rendered(result) }],
                details: { mcpServer: SERVER, mcpTool: tool },
              },
            }
          : { phase: "start", name: name(tool), toolCallId: id, args },
        result ? 2_400 : 2_000,
      );
    ingestTool("a", "t3_thread_wait");
    ingestTool("b", "t3_thread_read");
    ingestTool("b", "t3_thread_read", read);
    ingestTool("a", "t3_thread_wait", wait);
    const run = activity.runs[0]!;
    const calls = run.steps.map((step) => t3(callFromStep(step, run))!);
    expect(calls.map((c) => c.id)).toEqual(["a", "b"]);
    expect(threadStateOf(calls)).toMatchObject({ type: "call", state: "made" });
    expect(calls.map((c) => c.reported)).toEqual(["completed", "running"]);
  });

  it.each([2_400, undefined])(
    "F-134: from history, two results at timestamp %s: no thread status, the calls are not T3 Code's",
    (timestamp) => {
      const calls = [
        { id: "a", tool: "t3_thread_wait", result: wait },
        { id: "b", tool: "t3_thread_read", result: read },
      ];
      const rows = [
        { role: "user", content: "Go.", __openclaw: { id: "u" } },
        {
          role: "assistant",
          content: calls.map((c) => ({
            type: "toolCall",
            id: c.id,
            name: name(c.tool),
            arguments: args,
          })),
          __openclaw: { id: "a", runId: "history" },
        },
        ...[calls[1]!, calls[0]!].map((c) => ({
          role: "toolResult",
          toolCallId: c.id,
          content: [{ type: "text", text: rendered(c.result) }],
          isError: false,
          timestamp,
          __openclaw: { id: c.id, runId: "history" },
        })),
      ];
      const ctx = { sessionKey: "agent:otto:backup", now: 9_000, raw: new RawTable() };
      const run = runsFromHistory(rows, null, ctx)[0]!;
      // History keeps no tool server or tool: neither call is T3 Code's after a reload (11.4).
      const history = run.steps.map((step) => t3(callFromStep(step, run)));
      expect(history).toEqual([null, null]);
    },
  );
});

describe("a call joins a thread only by its own result naming it (11.1)", () => {
  const launch = () => t3(live("t3_thread_launch", LAUNCH_ARGS, LAUNCHED))!;
  const attempt = () =>
    live("t3_thread_send", { threadId: THREAD, message: "This never went." }, null, { open: true });

  it("F-313: in flight, a call is shown with the thread its arguments name", () => {
    const open = t3(attempt())!;
    expect(open.thread?.threadId).toBe(THREAD);
    expect(
      placeT3([
        { type: "t3", call: launch() },
        { type: "t3", call: open },
      ]).get(open.id)?.type,
    ).toBe("line");
  });

  it("F-313: an aborted, a refused and a failed follow-up have cards of their own, with the thread they asked for", () => {
    const head = launch();
    const unknown = t3({ ...attempt(), status: "stopped", runStopped: true })!;
    const blocked = t3({
      ...attempt(),
      status: "returned",
      text: "Blocked.",
      details: { mcpServer: SERVER, mcpTool: "t3_thread_send", status: "blocked" },
    })!;
    const failure = {
      _tag: "OrchestratorMcpFailure",
      code: "thread_not_found",
      message: "No thread.",
    };
    const failed = t3(
      live("t3_thread_send", { threadId: THREAD, message: "x" }, failure, { isError: true }),
    )!;
    for (const call of [unknown, blocked, failed]) {
      expect(call.thread).toBeNull();
      expect(call.asked?.threadId).toBe(THREAD);
      const placed = placeT3([
        { type: "t3", call: head },
        { type: "t3", call },
      ]);
      expect(placed.get(call.id)).toEqual({ type: "own", asked: call.asked, head: head.id });
    }
    expect(lineOf(unknown.call, MAP)).toMatchObject({
      verb: "Asked",
      object: "T3 Code to take a follow-up",
    });
    expect(lineOf(failed.call, MAP)).toMatchObject({
      verb: "Couldn't follow up with",
      detail: "thread_not_found: No thread.",
    });
  });

  it("F-132: a structured result of another shape is never enough to make a call T3 Code's", () => {
    // Live, when the gateway's details are not there to name the tool.
    const read = live("t3_thread_read", { threadId: THREAD }, readResult([]));
    expect(t3({ ...read, details: null })?.mapped).toBe(true);
    const notes = live("t3_thread_read", { threadId: THREAD }, { notes: [], threadId: THREAD });
    expect(t3({ ...notes, details: null })).toBeNull();
  });

  it("F-132: after a reload the current map does not re-attribute a call against its recorded result", () => {
    // Live, the result named another tool than the map: it is not T3 Code's.
    const decoy = live(
      "t3_thread_read",
      { threadId: THREAD },
      { notes: [], threadId: THREAD },
      { resultTool: "T3_thread_read" },
    );
    expect(t3(decoy)).toBeNull();
    // From history the result's tool is not kept, and the map still says T3 Code's read: the
    // result's shape is another tool's, so it stays not T3 Code's.
    const reloaded = fromHistory(
      "t3_thread_read",
      { threadId: THREAD },
      { notes: [], threadId: THREAD },
    );
    expect(t3(reloaded.alone)).toBeNull();
    expect(t3(reloaded.withStep)).toBeNull();
  });

  it("F-132 F-313: a result that could not be read says what is not known", () => {
    expect(readLines(readDimensions(null, false))).toEqual([
      "This result could not be read here: what it reported is not known.",
    ]);
  });

  it("F-441: ids too long to keep whole leave the thread unknown, never joined by a clipped prefix", () => {
    const shared = "a".repeat(2300);
    const a = t3(
      live("t3_thread_read", { threadId: THREAD, environmentId: `${shared}x` }, readResult([])),
    )!;
    const b = t3(
      live("t3_thread_read", { threadId: THREAD, environmentId: `${shared}y` }, readResult([])),
    )!;
    expect([a.thread, b.thread]).toEqual([null, null]);
  });
});

describe("the words follow the record", () => {
  it("F-314: a refused follow-up is not the thread's latest message", () => {
    const head = t3(live("t3_thread_launch", LAUNCH_ARGS, LAUNCHED))!;
    const failure = {
      _tag: "OrchestratorMcpFailure",
      code: "thread_not_sendable",
      message: "Cannot steer idle.",
    };
    const refused = t3(
      live("t3_thread_send", { threadId: THREAD, message: "The rejected text." }, failure, {
        isError: true,
      }),
    )!;
    expect(latestSent([head, refused])).toBe(
      "Make the weekly check skip machines that are asleep.",
    );
  });

  it("F-133: a result without the fields could not be read; a later page says it is one", () => {
    const fieldless = t3(live("t3_thread_read", { threadId: THREAD }, {}))!;
    expect(
      readLines(readDimensions(fieldless.facts, fieldless.call.cut === true)).join(" "),
    ).not.toContain("stored result was cut");
    const later = t3(
      live(
        "t3_thread_read",
        { threadId: THREAD, afterPosition: 2 },
        readResult([item("assistant_message", "x")], true),
      ),
    )!;
    expect(readLines(readDimensions(later.facts))).toEqual([
      "More pages after this one: the reply may continue",
    ]);
  });

  it("F-133: a sent text is kept whole up to its bound, and marked when shortened", () => {
    const sent = `${"x".repeat(600)}END`;
    const launch = t3(live("t3_thread_launch", { ...LAUNCH_ARGS, message: sent }, LAUNCHED))!;
    expect([launch.sent, launch.sentShort]).toEqual([sent, false]);
    const long = t3(
      live("t3_thread_launch", { ...LAUNCH_ARGS, message: "y".repeat(1500) }, LAUNCHED),
    )!;
    expect([long.sent!.length < 1500, long.sentShort]).toEqual([true, true]);
  });
});

describe("work that may continue is the stopped run's (11, F-137)", () => {
  it("F-137: an abort alone, in another gateway run or the one that handed off, adds no note; the handoff's run seen to stop does", () => {
    const head = t3(live("t3_thread_launch", LAUNCH_ARGS, LAUNCHED))!;
    const wait = t3(live("t3_thread_wait", { threadId: THREAD }, null, { open: true }))!;
    const cut = (runId: string): T3CallLike => ({
      ...wait,
      state: "unknown",
      call: { ...wait.call, status: "returned", isError: true, text: "Aborted", runId },
    });
    expect(head.call.runId).toBe("run-1");
    expect(workMayContinue([head, cut("run-other")])).toBe(false);
    expect(workMayContinue([head, cut("run-1")])).toBe(false);
    const stopped = { ...head, call: { ...head.call, runStopped: true } };
    expect(workMayContinue([stopped, cut("run-1")])).toBe(true);
  });
});

describe("the folded line says what the thread is for (11.2)", () => {
  it("F-132: the launch's title, else a result's title, else the launch's message, else the latest message sent", () => {
    const launch = t3(live("t3_thread_launch", LAUNCH_ARGS, LAUNCHED))!;
    const send = t3(
      live(
        "t3_thread_send",
        { threadId: THREAD, message: "Also a test." },
        { threadId: THREAD, status: "running", delivery: "started" },
      ),
    )!;
    expect(threadTitle([launch, send])).toBe("Skip machines that are asleep");
    const read = t3(live("t3_thread_read", { threadId: THREAD }, readResult([])))!;
    expect(threadTitle([send, read])).toBe("Skip machines");
    const untitled = t3(live("t3_thread_launch", { ...LAUNCH_ARGS, title: undefined }, LAUNCHED))!;
    expect(threadTitle([untitled, send])).toBe(
      "Make the weekly check skip machines that are asleep.",
    );
    expect(threadTitle([send])).toBe("Also a test.");
    // A retained title of more than 256 characters is visibly shortened.
    const long = "t".repeat(257);
    const titled = t3(live("t3_thread_launch", { ...LAUNCH_ARGS, title: long }, LAUNCHED))!;
    expect(threadTitle([titled])).toBe(`${"t".repeat(255)}…`);
  });

  it("F-133: a launch with a title and no message sent no text: the title stays a launch field", () => {
    const titleOnly = t3(
      live("t3_thread_launch", { ...LAUNCH_ARGS, message: undefined }, LAUNCHED),
    )!;
    expect(titleOnly.facts?.argTitle).toBe("Skip machines that are asleep");
    expect(titleOnly.sent).toBeNull();
  });
});

describe("Open thread goes to the one address the record supplies (11.3)", () => {
  it("F-135: two different addresses with no proven order give no link", () => {
    const args = { threadId: THREAD };
    const a = t3(
      live("t3_thread_wait", args, {
        threadId: THREAD,
        status: "completed",
        timedOut: false,
        link: "https://new.example/thread",
      }),
    )!;
    const b = t3(
      live("t3_thread_read", args, {
        ...readResult([], false, "running"),
        link: "https://old.example/thread",
      }),
    )!;
    expect(
      threadLink([
        { ...a, call: { ...a.call, resultAt: 4_000 } },
        { ...b, call: { ...b.call, resultAt: 3_000 } },
      ]),
    ).toBeNull();
  });
});

describe("a reload keeps a call in a thread only on the stored result's own attribution (11.4)", () => {
  it("F-132 F-313: a same-shaped result from another tool stays an ordinary call after reload", () => {
    const args = { threadId: THREAD };
    const read = readResult([], false, "running");
    const other = live("t3_thread_read", args, read, { resultTool: "an_unrelated_tool" });
    expect(t3(other)).toBeNull();
    // History keeps no tool server or tool: the map and a matching shape do not make it T3 Code's.
    expect(t3(fromHistory("t3_thread_read", args, read).alone)).toBeNull();
  });

  it("F-132 F-313: a call of a run read from history that is still in flight is T3 Code's by the map, before any result", () => {
    // A host that did not start the run knows it from history; until a result is stored, the
    // gateway's name map is the evidence before the result (11.1).
    const open = {
      ...live("t3_thread_wait", { threadId: THREAD }, null, { open: true }),
      fromHistory: true,
    };
    expect(t3(open)?.tool).toBe("t3_thread_wait");
    expect(t3(open)?.state).toBe("started");
  });
});

it("F-313: an unreturned call can link to the named thread card later in the column", () => {
  const open = live("t3_thread_wait", { threadId: THREAD }, null, { open: true });
  const ended = t3({ ...open, status: "stopped", runStopped: true })!;
  const later = t3(live("t3_thread_read", { threadId: THREAD }, readResult([])))!;
  const placement = placeT3([
    { type: "t3", call: ended },
    { type: "t3", call: later },
  ]);
  expect(placement.get(ended.id)).toMatchObject({ type: "own", head: later.id });
});

it("F-314: text cut only in the app does not say the gateway stored a cut result", () => {
  const call = fromHistory("t3_thread_read", { threadId: THREAD }, null, false, {
    text: "x".repeat(25_000),
  }).alone;
  expect(readLines(readDimensions(null, call.cut === true))[0]).not.toContain(
    "stored result was cut",
  );
});

it("F-137: a stopped run that only asked T3 Code to stop did not hand off work", () => {
  const args = { threadId: THREAD };
  const interruption = t3(
    live("t3_thread_interrupt", { ...args, stop: true }, { ...args, status: "no_active_run" }),
  )!;
  expect(
    workMayContinue([{ ...interruption, call: { ...interruption.call, runStopped: true } }]),
  ).toBe(false);
});

describe("a viewer sent only a call's item events", () => {
  it("F-313: a running call shows with the thread its history row's arguments name", () => {
    const id = "call_items_only";
    const ctx = { sessionKey: "agent:otto:backup", now: 9_000, raw: new RawTable() };
    let activity = emptyActivity;
    const events: Array<[string, Rec]> = [
      ["lifecycle", { phase: "start", startedAt: 1_000 }],
      // The item's start alone: no arguments reach this viewer.
      [
        "item",
        {
          kind: "tool",
          phase: "start",
          toolCallId: id,
          name: name("t3_thread_wait"),
          startedAt: 1_100,
        },
      ],
    ];
    events.forEach(([stream, data], i) => {
      activity = applyAgentEvent(
        activity,
        {
          runId: "run-1",
          seq: i + 1,
          stream,
          ts: 1_000 + i * 100,
          sessionKey: ctx.sessionKey,
          data,
        },
        ctx,
      ).activity;
    });
    const run = activity.runs[0]!;
    const step = run.steps.find((s) => s.toolCallId === id)!;
    expect(step.t3).toBeUndefined();
    const rows = [
      { role: "user", content: "Go.", timestamp: 1_000, __openclaw: { id: "u1" } },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id,
            name: name("t3_thread_wait"),
            arguments: { threadId: THREAD, timeoutMs: 30_000 },
          },
        ],
        timestamp: 2_000,
        __openclaw: { id: "a1", runId: "run-1" },
      },
    ];
    const block = mapHistory(rows)
      .flatMap((each) => each.blocks)
      .find((each) => each.kind === "tool-call")!;
    const call = t3(
      callFromBlock(block as Extract<typeof block, { kind: "tool-call" }>, step, run),
    );
    expect(call?.state).toBe("started");
    expect(call?.thread?.threadId).toBe(THREAD);
  });
});

describe("a result replaced by the gateway", () => {
  it("F-313 F-134: the replacement's facts stand alone: a superseded result's thread and status do not stay", () => {
    const id = "call_replaced";
    const ctx = { sessionKey: "agent:otto:backup", now: 9_000, raw: new RawTable() };
    let activity = emptyActivity;
    const result = (text: string, structured: Rec | null, more: Rec) => ({
      phase: "result",
      name: name("t3_thread_wait"),
      toolCallId: id,
      isError: false,
      result: {
        content: [{ type: "text", text }],
        details: {
          mcpServer: SERVER,
          mcpTool: "t3_thread_wait",
          ...(structured ? { structuredContent: structured } : {}),
        },
      },
      ...more,
    });
    const first = { threadId: THREAD, runId: "run-a", status: "running", timedOut: false };
    const events: Array<[string, Rec]> = [
      ["lifecycle", { phase: "start", startedAt: 1_000 }],
      [
        "tool",
        {
          phase: "start",
          name: name("t3_thread_wait"),
          toolCallId: id,
          args: { threadId: THREAD },
        },
      ],
      ["tool", result(rendered(first), first, { replaceable: true })],
      ["tool", result("The wait's answer could not be shown.", null, { replace: true })],
    ];
    events.forEach(([stream, data], i) => {
      activity = applyAgentEvent(
        activity,
        {
          runId: "run-1",
          seq: i + 1,
          stream,
          ts: 1_000 + i * 100,
          sessionKey: ctx.sessionKey,
          data,
        },
        ctx,
      ).activity;
    });
    const run = activity.runs[0]!;
    const step = run.steps.find((s) => s.toolCallId === id)!;
    expect(step.correction).toBe(1);
    // The arguments' thread stays; nothing of the first result's does.
    expect(step.t3).toEqual({ argThread: THREAD });
    const call = t3(callFromStep(step, run));
    expect(call?.unread).toBe(true);
    expect(call?.reported).toBeNull();
  });
});

describe("the arguments' facts within their bound", () => {
  it("F-441: the longest ids, title and message fit MAX_T3_FACTS_CHARS, and the thread is kept whole", () => {
    const thread = "t".repeat(512);
    const facts = t3ArgFacts({
      threadId: thread,
      environmentId: "e".repeat(512),
      title: "T".repeat(256),
      message: '"'.repeat(1_000),
    });
    expect(JSON.stringify(facts).length).toBeLessThanOrEqual(MAX_T3_FACTS_CHARS);
    expect(facts?.argThread).toBe(thread);
    expect(facts?.argMessageShort).toBe(true);
  });
});

describe("a status this design does not name", () => {
  it("F-134: is said as received, even when it names a property every object inherits", () => {
    for (const status of ["constructor", "toString", "__proto__"]) {
      const w = live(
        "t3_thread_wait",
        { threadId: THREAD },
        { threadId: THREAD, status, timedOut: false },
      );
      expect(typeof lineOf(w, MAP).detail).toBe("string");
      expect(statusWords(status)).toBe(status.replace(/_/g, " "));
    }
  });
});
