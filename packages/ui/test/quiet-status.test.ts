// The status line with "Show commands" off (docs/design/conversation.md, 7.11):
// the kind of work in plain words, and what the bot is thinking as it thinks.

import { emptyActivity, newRun, type Run, type Step, type Transcript } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { liveThought, statusLineFor } from "../src/live.ts";

const NOW = 1_800_000_000_000;

function transcript(runs: Run[]): Transcript {
  return {
    ...emptyActivity,
    linkedRuns: {},
    interSession: [],
    mcpTools: {},
    sessionKey: "agent:otto:a",
    status: "ready",
    items: [],
    error: null,
    hasMore: false,
    live: null,
    loadedAt: NOW,
    runs,
  };
}

const run = (change: Partial<Run> = {}): Run =>
  newRun(
    "run-1",
    { state: "running", origin: "local", bound: true, reportedStartAt: NOW - 42_000, ...change },
    NOW - 42_000,
  );

function step(kind: Step["kind"], change: Partial<Step> = {}): Step {
  return {
    id: kind === "tool" ? "tool:call-1" : "reasoning:run-1:0",
    kind,
    title: kind,
    toolName: kind === "tool" ? "exec" : null,
    toolCallId: kind === "tool" ? "call-1" : null,
    status: "running",
    startedAt: NOW,
    endedAt: null,
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
  };
}

const command = step("tool", { args: { command: "/bin/zsh -lc 'du -sh /srv/media/*'" } });
const thinking = (text: string) => step("reasoning", { output: { text, totalChars: text.length } });
const live = { connected: true, interactive: true };
const quiet = { ...live, quiet: true };

describe("F-529: the status line without commands shown", () => {
  it("names the kind of work, never the command, and has no card to bring into view", () => {
    const working = run({ steps: [command] });
    expect(statusLineFor(working, transcript([working]), live)).toMatchObject({
      phrase: "Running zsh",
      callId: "call-1",
    });
    expect(statusLineFor(working, transcript([working]), quiet)).toMatchObject({
      state: "working",
      phrase: "Using the computer",
      callId: null,
      thought: null,
    });
  });

  it("a message to another bot keeps its card's words and brings that card into view", () => {
    const messaging = run({
      steps: [
        step("tool", {
          toolName: "sessions_send",
          args: { sessionKey: "agent:juniper:main", message: "Check the shelf list." },
        }),
      ],
    });
    const view = statusLineFor(messaging, transcript([messaging]), {
      ...quiet,
      reading: { botName: (id) => (id === "juniper" ? "Juniper" : null) },
    });
    expect(view).toMatchObject({ phrase: "Messaging Juniper", callId: "call-1" });
  });

  it("shows what the bot is thinking while it thinks, and only then", () => {
    const text = "The log ends cleanly. The disk is the open question.";
    const reasoning = run({ steps: [thinking(text)] });
    expect(statusLineFor(reasoning, transcript([reasoning]), quiet)).toMatchObject({
      phrase: "Thinking",
      thought: text,
    });
    // With commands shown it stays folded away, as before.
    expect(statusLineFor(reasoning, transcript([reasoning]), live).thought).toBeUndefined();
    // Once the reply streams, the thinking is the Thought line over it.
    const replying = run({ steps: [thinking(text)], text: "Both logs are fine." });
    expect(statusLineFor(replying, transcript([replying]), quiet).thought).toBeNull();
    // Once an action starts, the phrase says it.
    const acting = run({ steps: [thinking(text), command] });
    expect(statusLineFor(acting, transcript([acting]), quiet).thought).toBeNull();
  });

  it("long thinking shows its end, from a word's start", () => {
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const shown = liveThought(run({ steps: [thinking(words)] }))!;
    expect(shown.startsWith("…word")).toBe(true);
    expect(shown.endsWith("word119")).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(281);
  });
});
