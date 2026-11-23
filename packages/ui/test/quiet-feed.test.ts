// The default view's feed and the Computer tab's Commands rows, with "Show
// commands" off (docs/design/conversation.md, 7.11). Every name and text is invented.

import {
  actionsLineOf,
  callFromBlock,
  callsOf,
  groupFeed,
  mapHistory,
  newRun,
  runLineOf,
  type ActionCall,
  type CommandRow,
  type FeedEntry,
  type Step,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { markRepeats, quietFeed, viewGroups, type FeedRef } from "../src/actions/feed.tsx";
import { commandRowWords } from "../src/work/command-row.ts";

const QUIET = { quiet: true };
let n = 0;
function call(name: string, args: Record<string, unknown>, more: Partial<ActionCall> = {}) {
  n += 1;
  return {
    id: `call_${n}`,
    name,
    args,
    status: "returned",
    isError: false,
    text: "ok",
    details: null,
    commandBearing: false,
    startedAt: 1_000,
    endedAt: 1_600,
    fromHistory: false,
    ...more,
  } satisfies ActionCall;
}
const action = (c: ActionCall): FeedEntry<FeedRef> => ({ type: "action", call: c });
const bubble = (id: string, text: string): FeedEntry<FeedRef> => ({
  type: "bubble",
  id,
  ref: { t: "text", text },
});
const keys = (groups: ReturnType<typeof groupFeed<FeedRef>>) =>
  groups.map((g) => (g.type === "action" ? g.call.name : g.type));

describe("F-528 F-551: only what needs the person stays in the conversation", () => {
  const read = call("read", { path: "notes.md" }, { text: "one" });
  const failed = call("exec", { command: "mv a b" }, { isError: true, text: "No such file" });
  const waiting = call("exec", { command: "rm -rf /srv/cache" }, { status: "waiting", text: null });
  const blocked = call(
    "exec",
    { command: "curl x" },
    { isError: true, details: { status: "blocked" } },
  );

  it("a waiting action keeps its card at level 0; a failed or blocked one goes to the run line like the rest", () => {
    for (const [last, shownKeys, hiddenKeys] of [
      [waiting, ["bubble", "exec"], ["read"]],
      [failed, ["bubble"], ["read", "exec"]],
      [blocked, ["bubble"], ["read", "exec"]],
    ] as const) {
      const groups = groupFeed<FeedRef>(
        [action(read), bubble("b1", "Now the files."), action(last)],
        QUIET,
      );
      const { shown, hidden } = quietFeed(groups, false, QUIET);
      expect(keys(shown)).toEqual(shownKeys);
      expect(keys(hidden)).toEqual(hiddenKeys);
    }
  });

  it("a fold with a waiting member stays whole, in view; a fold with a failed one goes whole", () => {
    const ok = () => call("exec", { command: "du -sh x" }, { details: { exitCode: 0 } });
    for (const [member, inView] of [
      [waiting, true],
      [failed, false],
    ] as const) {
      const groups = groupFeed<FeedRef>([action(ok()), action(member)], QUIET);
      expect(groups.map((g) => g.type)).toEqual(["fold"]);
      const { shown, hidden } = quietFeed(groups, true, QUIET);
      expect(shown.map((g) => g.type)).toEqual(inView ? ["fold"] : []);
      expect(hidden.map((g) => g.type)).toEqual(inView ? [] : ["fold"]);
    }
  });
});

describe("F-528: reasoning stays on its side of the bot's words", () => {
  const segment = (id: string, text: string): FeedEntry<FeedRef> => ({
    type: "reasoning",
    segment: { id, text, startedAt: null, endedAt: null },
  });
  it("without commands shown, reasoning before a bubble is that bubble's Thought line, not the next action's", () => {
    const entries = [
      segment("r1", "first the plan"),
      bubble("b", "Starting now."),
      segment("r2", "then the read"),
      action(call("read", { path: "a.md" })),
    ];
    const { shown } = quietFeed(groupFeed<FeedRef>(entries, QUIET), false, QUIET);
    expect(shown.map((g) => (g.type === "thought" ? `thought:${g.thought.id}` : g.type))).toEqual([
      "thought:r1",
      "bubble",
      "thought:r2",
    ]);
    // With commands shown, reasoning still belongs to the action it led to (7.5).
    const cards = groupFeed<FeedRef>(entries, {});
    expect(cards.map((g) => g.type)).toEqual(["bubble", "action"]);
  });
});

describe("F-551: thinking and failures, by the two switches", () => {
  const segment = (id: string, text: string): FeedEntry<FeedRef> => ({
    type: "reasoning",
    segment: { id, text, startedAt: null, endedAt: null },
  });
  const failed = () => call("exec", { command: "mv a b" }, { isError: true, text: "No such file" });
  const waiting = () =>
    call("exec", { command: "rm -rf /srv/cache" }, { status: "waiting", text: null });
  const OFF = { commands: false, thinking: false, live: false };
  /** Every group, and the reasoning any of them carries, by the id of its first segment. */
  const thoughts = (groups: ReturnType<typeof groupFeed<FeedRef>>) =>
    groups.flatMap((g) =>
      g.type === "thought"
        ? [`line:${g.thought.id}`]
        : g.type === "action" && g.thought
          ? [`in:${g.thought.id}`]
          : [],
    );
  const record = () => [
    segment("r1", "first the plan"),
    bubble("b1", "Starting now."),
    segment("r2", "then the read"),
    action(call("read", { path: "a.md" })),
    bubble("b2", "Done."),
  ];

  it("by default no reasoning is drawn; with Show thinking on, its Thought lines are back", () => {
    const groups = groupFeed<FeedRef>(record(), QUIET);
    const off = viewGroups(groups, OFF, QUIET);
    expect(thoughts(off.shown)).toEqual([]);
    expect(off.shown.map((g) => g.type)).toEqual(["bubble", "bubble"]);
    const on = viewGroups(groups, { ...OFF, thinking: true }, QUIET);
    expect(thoughts(on.shown)).toEqual(["line:r1", "line:r2"]);
  });

  it("with commands shown and thinking hidden, a card carries no reasoning", () => {
    const groups = groupFeed<FeedRef>(record(), {});
    expect(thoughts(groups)).toEqual(["in:r1"]);
    const { shown } = viewGroups(groups, { ...OFF, commands: true }, {});
    expect(thoughts(shown)).toEqual([]);
    expect(keys(shown)).toEqual(["bubble", "read", "bubble"]);
  });

  it("with commands hidden, a failed action takes the path a successful one takes: in the run line, live and after the run", () => {
    const outcomes = [
      call("read", { path: "a.md" }, { isError: true, text: "ENOENT" }),
      call("exec", { command: "curl x" }, { isError: true, details: { status: "blocked" } }),
      call("memory_search", { query: "x" }, { details: { results: [], unavailable: true } }),
    ];
    for (const live of [true, false])
      for (const bad of outcomes) {
        const good = { ...bad, isError: false, text: "ok", details: null };
        const view = (c: ActionCall) =>
          viewGroups(
            groupFeed<FeedRef>([bubble("b1", "On it."), action(c), bubble("b2", "Done.")], QUIET),
            { ...OFF, live },
            QUIET,
          );
        const failing = view(bad);
        expect(keys(failing.shown)).toEqual(["bubble", "bubble"]);
        expect(callsOf(failing.hidden).map((c) => c.id)).toEqual([bad.id]);
        // The same groups, in the same places, as the successful call.
        const succeeding = view(good);
        expect(keys(failing.shown)).toEqual(keys(succeeding.shown));
        expect(keys(failing.hidden)).toEqual(keys(succeeding.hidden));
      }
  });

  it("the run line counts the failures its list holds", () => {
    const bad = [failed(), failed()];
    const { hidden } = viewGroups(
      groupFeed<FeedRef>([action(bad[0]!), action(bad[1]!), bubble("b", "Both failed.")], QUIET),
      OFF,
      QUIET,
    );
    expect(callsOf(hidden)).toHaveLength(2);
    const run = { state: "completed" as const, startedAt: 0, endedAt: 4_000, reportedStartAt: 0 };
    expect(runLineOf(run, callsOf(hidden), QUIET)?.text).toMatch(/· 2 actions · 2 failed$/);
  });

  it("history with no run: its failed action goes behind a line that counts it as a run line would", () => {
    // A call and its failed result, with no run id and no text from the bot.
    const items = mapHistory([
      {
        role: "user",
        content: "Look for my old notes.",
        timestamp: 1_000,
        __openclaw: { id: "u1" },
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_x", name: "read", arguments: { path: "old.md" } }],
        timestamp: 2_000,
        __openclaw: { id: "a1" },
      },
      {
        role: "toolResult",
        toolCallId: "call_x",
        toolName: "read",
        content: [{ type: "text", text: "ENOENT: no such file" }],
        isError: true,
        timestamp: 3_000,
        __openclaw: { id: "r1" },
      },
    ]);
    const block = items.flatMap((item) => item.blocks).find((b) => b.kind === "tool-call");
    if (block?.kind !== "tool-call") throw new Error("no call in history");
    const failedCall = callFromBlock(block, undefined, undefined);
    const { shown, hidden } = viewGroups(
      groupFeed<FeedRef>([action(failedCall)], QUIET),
      OFF,
      QUIET,
    );
    expect(shown).toEqual([]);
    expect(actionsLineOf(callsOf(hidden), QUIET)).toBe("1 action · 1 failed");
  });

  it("an action waiting for the person stays, whatever follows it", () => {
    const { shown, hidden } = viewGroups(
      groupFeed<FeedRef>([action(waiting()), bubble("b", "Waiting on you.")], QUIET),
      OFF,
      QUIET,
    );
    expect(keys(shown)).toEqual(["exec", "bubble"]);
    expect(hidden).toEqual([]);
  });

  it("with Show commands on, a failed action is drawn in place", () => {
    const bad = failed();
    const groups = groupFeed<FeedRef>(
      [bubble("b1", "On it."), action(bad), bubble("b2", "It failed.")],
      {},
    );
    const { shown, hidden } = viewGroups(groups, { ...OFF, commands: true }, {});
    expect(keys(shown)).toEqual(["bubble", "exec", "bubble"]);
    expect(hidden).toEqual([]);
  });

  it("a fold whose actions all failed, between the bot's words, is only in the run line", () => {
    const browse = (url: string) =>
      call("browser", { action: "open", url }, { isError: true, text: "Navigation timed out." });
    const groups = groupFeed<FeedRef>(
      [
        bubble("b1", "Looking that up."),
        bubble("b2", "Opening the office's page."),
        bubble("b3", "One moment."),
        action(browse("https://office.example/hours")),
        action(browse("https://office.example/contact")),
        bubble("b4", "The office's page timed out, so I could not read its hours."),
      ],
      QUIET,
    );
    expect(groups.map((g) => g.type)).toEqual(["bubble", "bubble", "bubble", "fold", "bubble"]);
    for (const live of [true, false]) {
      const view = viewGroups(groups, { ...OFF, live }, QUIET);
      expect(view.shown.map((g) => g.type)).toEqual(["bubble", "bubble", "bubble", "bubble"]);
      expect(view.hidden.map((g) => g.type)).toEqual(["fold"]);
      expect(callsOf(view.hidden)).toHaveLength(2);
    }
  });

  it("with both switches on, every action and thought is drawn where it was", () => {
    const entries = [...record(), action(failed()), segment("r3", "after the failure")];
    const groups = groupFeed<FeedRef>(entries, {});
    const both = viewGroups(groups, { commands: true, thinking: true, live: false }, {});
    expect(both.shown).toBe(groups);
    expect(both.hidden).toEqual([]);
  });

  it("with both switches on, a run still going leaves its latest thinking to the status line; once it ends the Thought line is back", () => {
    const groups = groupFeed<FeedRef>(
      [bubble("b1", "Checking the disk."), segment("r9", "The cache is the likely culprit.")],
      {},
    );
    const end = (shown: typeof groups) =>
      shown.filter((g) => g.type === "thought" && g.place === "end").length;
    expect(end(groups)).toBe(1);
    const BOTH = { commands: true, thinking: true };
    expect(end(viewGroups(groups, { ...BOTH, live: true }, {}).shown)).toBe(0);
    expect(keys(viewGroups(groups, { ...BOTH, live: true }, {}).shown)).toEqual(["bubble"]);
    expect(end(viewGroups(groups, { ...BOTH, live: false }, {}).shown)).toBe(1);
  });
});

describe("F-532: a message repeats a reply only when the text is the same", () => {
  const send = (message: string) =>
    call("conversations_send", { message }, { details: { status: "sent" } });
  const marked = (message: string, reply: string) => {
    const list = [action(send(message)), bubble("r", reply)];
    markRepeats([list], {});
    return (list[0] as { call: ActionCall }).call.repeatsReply === true;
  };
  it("its ends may differ; its line breaks and indents may not", () => {
    expect(marked("Booked for Tuesday.", "  Booked for Tuesday.\n")).toBe(true);
    expect(marked("Line one\nline two", "Line one line two")).toBe(false);
    expect(marked("- a\n  - b", "- a\n- b")).toBe(false);
  });
});

describe("F-531: a Commands row says what the gateway established", () => {
  const run = newRun("run-1", { state: "completed", origin: "local", bound: true }, 0);
  const step = (change: Partial<Step>): Step => ({
    id: "tool:c1",
    kind: "tool",
    title: "exec",
    toolName: "exec",
    toolCallId: "c1",
    args: { command: "rm -rf /srv/cache" },
    status: "done",
    startedAt: 1_000,
    endedAt: 1_400,
    argsText: null,
    output: null,
    result: null,
    error: null,
    approvalId: null,
    failureKind: null,
    truncated: false,
    replaceable: false,
    correction: 0,
    continuation: null,
    raw: null,
    rawSize: null,
    ...change,
  });
  const row = (change: Partial<CommandRow> = {}): CommandRow => ({
    stepId: "tool:c1",
    command: "rm -rf /srv/cache",
    end: null,
    durationMs: 400,
    running: false,
    ...change,
  });
  const live = { ...run, state: "running" as const };

  it("a denied command did not run, in either mode", () => {
    const denied = step({
      status: "failed",
      result: {
        text: "Exec denied (gateway id=a, user-denied): rm -rf /srv/cache",
        totalChars: 60,
      },
    });
    const quiet = commandRowWords(row(), { step: denied, run }, false);
    expect(quiet.label).toBe("Didn't run a command");
    expect(quiet.state).not.toMatch(/Done|Ran/);
    expect(commandRowWords(row(), { step: denied, run }, true).label).toBe("rm -rf /srv/cache");
  });

  it("each row's Show in chat is named by its own words and when it started", () => {
    const at = (startedAt: number, durationMs: number) =>
      commandRowWords(
        row({ durationMs, end: { kind: "exit", code: 0 } }),
        { step: step({ startedAt, details: { exitCode: 0 } }), run },
        false,
      ).showName;
    const first = at(Date.UTC(2026, 10, 16, 17, 21), 400);
    const second = at(Date.UTC(2026, 10, 16, 17, 26), 6200);
    expect(first).toMatch(/^Show Ran a command, Done · 0\.4s, .+, in the chat$/);
    expect(second).not.toBe(first);
    expect(commandRowWords(row(), { step: step({}), run }, true).showName).toBe(
      "Show rm -rf /srv/cache in the chat",
    );
  });

  it("a command waiting for approval is waiting, not running", () => {
    const waiting = step({ status: "waiting", endedAt: null });
    const words = commandRowWords(row({ running: true }), { step: waiting, run: live }, false);
    expect(words).toMatchObject({ state: "Waiting for you", running: false });
    expect(words.label).toBe("Wants to run a command");
  });

  it("without commands shown, a non-zero exit is 'Done', with no code", () => {
    const done = step({ details: { exitCode: 2 }, result: { text: "", totalChars: 0 } });
    const r = row({ end: { kind: "exit", code: 2 } });
    expect(commandRowWords(r, { step: done, run }, false)).toMatchObject({
      label: "Ran a command",
      state: "Done · 0.4s",
      running: false,
    });
    expect(commandRowWords(r, { step: done, run }, true).state).toBe("exit 2 · 0.4s");
  });
});
