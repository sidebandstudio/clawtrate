// The default view's feed and the Computer tab's Commands rows, with "Show
// commands" off (docs/design/conversation.md, 7.11). Every name and text is invented.

import {
  groupFeed,
  newRun,
  type ActionCall,
  type CommandRow,
  type FeedEntry,
  type Step,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { markRepeats, quietFeed, type FeedRef } from "../src/actions/feed.tsx";
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

describe("F-528: what needs the person, or went wrong, stays in the conversation", () => {
  const read = call("read", { path: "notes.md" }, { text: "one" });
  const failed = call("exec", { command: "mv a b" }, { isError: true, text: "No such file" });
  const waiting = call("exec", { command: "rm -rf /srv/cache" }, { status: "waiting", text: null });
  const blocked = call(
    "exec",
    { command: "curl x" },
    { isError: true, details: { status: "blocked" } },
  );

  it("a failed, waiting or blocked action keeps its card at level 0; the rest go to the run line", () => {
    for (const kept of [failed, waiting, blocked]) {
      const groups = groupFeed<FeedRef>(
        [action(read), bubble("b1", "Now the files."), action(kept)],
        QUIET,
      );
      const { shown, hidden } = quietFeed(groups, false, QUIET);
      expect(keys(shown)).toEqual(["bubble", "exec"]);
      expect(keys(hidden)).toEqual(["read"]);
    }
  });

  it("a fold with one such member stays whole, in view", () => {
    const ok = call("exec", { command: "du -sh x" }, { details: { exitCode: 0 } });
    const groups = groupFeed<FeedRef>([action(ok), action(failed)], QUIET);
    expect(groups.map((g) => g.type)).toEqual(["fold"]);
    const { shown, hidden } = quietFeed(groups, true, QUIET);
    expect(shown.map((g) => g.type)).toEqual(["fold"]);
    expect(hidden).toEqual([]);
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
