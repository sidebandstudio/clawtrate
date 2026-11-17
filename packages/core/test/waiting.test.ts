import { describe, expect, it } from "vitest";
import { groupTasks } from "../src/mapping.ts";
import { MAX_WAITING_MARKERS, MAX_WAITING_SESSIONS, WaitingIndex } from "../src/waiting.ts";

const KEY = "agent:otto:disk";
const lifecycle = (phase: string, extra: Record<string, unknown> = {}, runId = "r1") => ({
  sessionKey: KEY,
  runId,
  stream: "lifecycle",
  data: { phase, ...extra },
});

describe("which tasks wait for the person", () => {
  it("F-021: a run waits for an approval from waiting-approval until approval-resolved", () => {
    const index = new WaitingIndex();
    expect(index.onAgent(lifecycle("waiting-approval"), 100)).toBe(true);
    expect(index.waitingFor(KEY)).toEqual({ kind: "approval", since: 100 });
    expect(index.onAgent(lifecycle("approval-resolved"), 200)).toBe(true);
    expect(index.waitingFor(KEY)).toBeNull();
  });

  it("F-021: the run's end clears what it waited on; another run's end does not", () => {
    const index = new WaitingIndex();
    index.onAgent(lifecycle("waiting-approval", { approvalId: "a1" }), 100);
    index.onQuestionRequested({ id: "q1", sessionKey: KEY, runId: "r2" }, 150);
    index.onAgent(lifecycle("end"), 200);
    expect(index.waitingFor(KEY)).toEqual({ kind: "question", since: 150 });
    index.onAgent(lifecycle("error", {}, "r2"), 300);
    expect(index.waitingFor(KEY)).toBeNull();
  });

  it("F-057: a run the lifecycle ends as aborted marks its task stopped until its next run starts", () => {
    const index = new WaitingIndex();
    index.onAgent(lifecycle("end", { aborted: true }), 100);
    expect(index.stoppedAt(KEY)).toBe(100);
    index.onAgent(lifecycle("start", {}, "r2"), 200);
    expect(index.stoppedAt(KEY)).toBeNull();
    index.onAgent(lifecycle("end", {}, "r2"), 300);
    expect(index.stoppedAt(KEY)).toBeNull();
    index.onAgent(lifecycle("end", { status: "cancelled" }, "r3"), 400);
    expect(index.stoppedAt(KEY)).toBe(400);
    index.clear();
    expect(index.stoppedAt(KEY)).toBeNull();
  });

  it("F-021: a question waits until question.resolved, found by its id alone", () => {
    const index = new WaitingIndex();
    index.onQuestionRequested({ id: "q1", sessionKey: KEY, createdAtMs: 42 }, 100);
    expect(index.waitingFor(KEY)).toEqual({ kind: "question", since: 42 });
    expect(index.onQuestionResolved("other")).toBe(false);
    expect(index.onQuestionResolved("q1")).toBe(true);
    expect(index.waitingFor(KEY)).toBeNull();
  });

  it("F-021: question.list at a connect replaces the questions kept, and keeps approvals", () => {
    const index = new WaitingIndex();
    index.onQuestionRequested({ id: "old", sessionKey: KEY }, 10);
    index.onAgent(lifecycle("waiting-approval"), 20);
    index.replaceQuestions(
      [
        { id: "new", sessionKey: "agent:pip:week", status: "pending" },
        { id: "done", sessionKey: "agent:pip:other", status: "answered" },
      ],
      30,
    );
    expect(index.waitingFor(KEY)).toEqual({ kind: "approval", since: 20 });
    expect(index.waitingFor("agent:pip:week")).toEqual({ kind: "question", since: 30 });
    expect(index.waitingFor("agent:pip:other")).toBeNull();
  });

  it(`keeps at most ${MAX_WAITING_SESSIONS} tasks and ${MAX_WAITING_MARKERS} markers each, the oldest giving way`, () => {
    const index = new WaitingIndex();
    for (let task = 0; task < MAX_WAITING_SESSIONS + 10; task += 1)
      index.onQuestionRequested({ id: `q${task}`, sessionKey: `agent:b:t${task}` }, task);
    expect(index.size).toBe(MAX_WAITING_SESSIONS);
    expect(index.waitingFor("agent:b:t0")).toBeNull();
    for (let marker = 0; marker < MAX_WAITING_MARKERS + 4; marker += 1)
      index.onQuestionRequested({ id: `m${marker}`, sessionKey: KEY }, 1000 + marker);
    expect(index.waitingFor(KEY)).toEqual({ kind: "question", since: 1004 });
  });

  it("ignores events with no session or of another stream, and ids past the id cap", () => {
    const index = new WaitingIndex();
    expect(
      index.onAgent({ runId: "r", stream: "lifecycle", data: { phase: "waiting-approval" } }, 1),
    ).toBe(false);
    expect(index.onAgent({ ...lifecycle("waiting-approval"), stream: "tool" }, 1)).toBe(false);
    expect(index.onQuestionRequested({ id: "x".repeat(2000), sessionKey: KEY }, 1)).toBe(false);
    expect(index.size).toBe(0);
  });

  it("F-057: a row maps the gateway's stopped and queued runs to their own states, and pinned tasks come first", () => {
    const grouped = groupTasks([
      { key: "agent:otto:a", updatedAt: 5, status: "interrupted" },
      { key: "agent:otto:b", updatedAt: 4, status: "killed" },
      { key: "agent:otto:c", updatedAt: 3, status: "queued" },
      { key: "agent:otto:d", updatedAt: 2, status: "queued", hasActiveRun: true },
      { key: "agent:otto:e", updatedAt: 1, status: "timeout" },
      { key: "agent:otto:f", updatedAt: 0, pinned: true },
    ]);
    expect(grouped.otto!.map((task) => [task.key.slice(11), task.status])).toEqual([
      ["f", "idle"],
      ["a", "stopped"],
      ["b", "stopped"],
      ["c", "queued"],
      ["d", "running"],
      ["e", "failed"],
    ]);
    expect(grouped.otto![0]!.pinned).toBe(true);
  });

  it("F-054 F-424: a task with no name is Main for the bot's main key, New task for one made empty", () => {
    const grouped = groupTasks([
      { key: "agent:otto:main" },
      { key: "agent:otto:dashboard:2cc23cbf-30e2-4416-837a-56d92c983588" },
      { key: "agent:otto:dashboard:abc", label: "Named" },
    ]);
    expect(grouped.otto!.map((task) => task.title).sort()).toEqual(["Main", "Named", "New task"]);
    // The main session is marked, from the row's own word when it gives one.
    expect(grouped.otto!.filter((task) => task.isMain).map((task) => task.key)).toEqual([
      "agent:otto:main",
    ]);
    expect(
      groupTasks([{ key: "agent:otto:main", isMain: false }]).otto![0]!.isMain,
    ).toBeUndefined();
  });
});
