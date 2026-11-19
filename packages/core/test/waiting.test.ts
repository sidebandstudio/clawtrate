import { describe, expect, it } from "vitest";
import { groupTasks } from "../src/mapping.ts";
import { jsonLength } from "../src/bounds.ts";
import {
  fromActivity,
  MAX_WAITING_ID_CHARS,
  MAX_WAITING_MARKERS,
  MAX_WAITING_SESSIONS,
  WAITING_MARKER_CHARS,
  WAITING_RUN_CHARS,
  WaitingIndex,
} from "../src/waiting.ts";

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
    index.onAgent(lifecycle("error", { executionSettled: true }, "r2"), 300);
    expect(index.waitingFor(KEY)).toBeNull();
  });

  it("F-057: a run the lifecycle ends as aborted marks its task stopped until its next run starts", () => {
    const index = new WaitingIndex();
    index.onAgent(lifecycle("start", {}, "r1"), 50);
    index.onAgent(lifecycle("end", { aborted: true }, "r1"), 100);
    expect(index.stoppedAt(KEY)).toBe(100);
    index.onAgent(lifecycle("start", {}, "r2"), 200);
    expect(index.stoppedAt(KEY)).toBeNull();
    index.onAgent(lifecycle("end", {}, "r2"), 300);
    expect(index.stoppedAt(KEY)).toBeNull();
    index.onAgent(lifecycle("start", {}, "r3"), 350);
    index.onAgent(lifecycle("end", { status: "cancelled" }, "r3"), 400);
    expect(index.stoppedAt(KEY)).toBe(400);
    index.clear();
    expect(index.stoppedAt(KEY)).toBeNull();
  });

  it("F-057: an older run's abort arriving after a newer run started leaves the task as the newer run says", () => {
    const index = new WaitingIndex();
    index.onAgent(lifecycle("start", {}, "old"), 10);
    index.onAgent(lifecycle("start", {}, "new"), 20);
    expect(index.onAgent(lifecycle("end", { aborted: true }, "old"), 30)).toBe(false);
    expect(index.stoppedAt(KEY)).toBeNull();
    index.onAgent(lifecycle("end", {}, "new"), 40);
    expect(index.stoppedAt(KEY)).toBeNull();
  });

  it("F-277: says how a task's latest run ended from its own end, naming the archive only when the end does", () => {
    const index = new WaitingIndex();
    index.onAgent(lifecycle("start", {}, "r1"), 10);
    expect(index.runEnd(KEY, "r1")).toBeNull();
    index.onAgent(lifecycle("end", { aborted: true, stopReason: "rpc" }, "r1"), 20);
    expect(index.runEnd(KEY, "r1")).toBe("other");
    index.onAgent(lifecycle("start", {}, "r2"), 30);
    expect(index.runEnd(KEY, "r1")).toBeNull();
    expect(index.runEnd(KEY, "r2")).toBeNull();
    // An older run's end after a newer start says nothing of the newer run.
    index.onAgent(lifecycle("end", { aborted: true, stopReason: "archive" }, "r1"), 40);
    expect(index.runEnd(KEY, "r2")).toBeNull();
    index.onAgent(
      lifecycle("end", { aborted: true, status: "cancelled", stopReason: "archive" }, "r2"),
      50,
    );
    expect(index.runEnd(KEY, "r2")).toBe("archive");
    // An end that names the archive but was not stopped is not a stop by it.
    index.onAgent(lifecycle("start", {}, "r3"), 60);
    index.onAgent(lifecycle("end", { stopReason: "archive" }, "r3"), 70);
    expect(index.runEnd(KEY, "r3")).toBe("other");
  });

  it("F-021 F-057: a task the engine follows is described by its runs, not by the events", () => {
    const index = new WaitingIndex();
    index.onAgent(lifecycle("start", {}, "r1"), 10);
    index.onAgent(lifecycle("end", { aborted: true }, "r1"), 20);
    index.onAgent(lifecycle("waiting-approval", {}, "r2"), 30);
    const run = (state: string, extra: Record<string, unknown> = {}) =>
      ({
        state,
        pendingCards: [],
        startedAt: 0,
        reportedStartAt: 0,
        endedAt: null,
        ...extra,
      }) as never;
    // Its runs say a newer run finished: no waiting, no stopped, whatever the events kept.
    expect(
      index.hold(
        KEY,
        fromActivity({
          runs: [
            run("stopped", { endedAt: 20 }),
            run("completed", { startedAt: 25, reportedStartAt: 25 }),
          ],
        }),
      ),
    ).toBe(true);
    expect(index.waitingFor(KEY)).toBeNull();
    expect(index.stoppedAt(KEY)).toBeNull();
    expect(
      index.hold(
        KEY,
        fromActivity({
          runs: [
            run("stopped", { endedAt: 20 }),
            run("completed", { startedAt: 25, reportedStartAt: 25 }),
          ],
        }),
      ),
    ).toBe(false);
    // A run waiting on a question card waits, since the card.
    index.hold(
      KEY,
      fromActivity({
        runs: [run("waiting", { pendingCards: [{ id: "q", kind: "question", since: 44 }] })],
      }),
    );
    expect(index.waitingFor(KEY)).toEqual({ kind: "question", since: 44 });
    // Let go: the events describe it again.
    index.unhold(KEY);
    expect(index.waitingFor(KEY)).toEqual({ kind: "approval", since: 30 });
  });

  it("F-021: a row the gateway lists as idle clears only what waited before it; a newer marker stays", () => {
    const index = new WaitingIndex();
    index.onAgent({ ...lifecycle("waiting-approval"), ts: 500 }, 1);
    expect(index.settle(KEY, 400)).toBe(false);
    expect(index.waitingFor(KEY)).toEqual({ kind: "approval", since: 500 });
    expect(index.settle(KEY, 600)).toBe(true);
    expect(index.waitingFor(KEY)).toBeNull();
  });

  it("F-021: an approval's own resolved event clears it", () => {
    const index = new WaitingIndex();
    index.onAgent(lifecycle("waiting-approval", { approvalId: "a1" }), 10);
    expect(index.onApprovalResolved("a1")).toBe(true);
    expect(index.waitingFor(KEY)).toBeNull();
  });

  it("keeps every entry within the budget the registry counts, however its ids are escaped", () => {
    const index = new WaitingIndex();
    // The longest id kept: 1,024 JSON characters, nearly all of them escapes.
    const longest = (seed: string) =>
      `${seed}${'"'.repeat((MAX_WAITING_ID_CHARS - 2 - seed.length) / 2)}`;
    const key = longest("agent:o:");
    expect(
      index.onAgent(
        { sessionKey: key, runId: "x".repeat(2000), stream: "lifecycle", data: { phase: "start" } },
        1,
      ),
    ).toBe(false);
    for (let marker = 0; marker < MAX_WAITING_MARKERS; marker += 1) {
      const run = longest(`r${marker}:`);
      index.onAgent(
        {
          sessionKey: key,
          runId: run,
          stream: "lifecycle",
          data: { phase: "waiting-approval" },
          ts: Number.MAX_SAFE_INTEGER,
        },
        1,
      );
    }
    index.onAgent(
      {
        sessionKey: key,
        runId: longest("s"),
        stream: "lifecycle",
        data: { phase: "start" },
        ts: Number.MAX_SAFE_INTEGER,
      },
      1,
    );
    // An id within 1,024 characters whose JSON is longer than that is not kept, as a key or a run.
    const escaped = '"'.repeat(1_000);
    for (const [sessionKey, runId] of [
      [escaped, "r"],
      [key, escaped],
    ])
      expect(
        index.onAgent(
          { sessionKey, runId, stream: "lifecycle", data: { phase: "waiting-approval" } },
          1,
        ),
      ).toBe(false);
    const kept = index as unknown as {
      sessions: Map<string, Map<string, unknown>>;
      runs: Map<string, unknown>;
    };
    for (const [entryKey, markers] of kept.sessions) {
      expect(jsonLength(entryKey)).toBeLessThanOrEqual(MAX_WAITING_ID_CHARS);
      for (const entry of markers)
        expect(jsonLength(entry)).toBeLessThanOrEqual(WAITING_MARKER_CHARS);
    }
    expect(kept.sessions.get(key)?.size).toBe(MAX_WAITING_MARKERS);
    for (const entry of kept.runs) expect(jsonLength(entry)).toBeLessThanOrEqual(WAITING_RUN_CHARS);
    expect(kept.runs.size).toBe(1);
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
