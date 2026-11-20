import { emptyActivity, newRun, type Transcript, type Run } from "@clawtrate/core";
import { expect, it, vi } from "vitest";
import { countReply, InvitationReplies } from "../src/support/invitation.ts";
const make = (change: Partial<Run> = {}) =>
  newRun(
    "bound",
    {
      messageId: "mine",
      origin: "local",
      bound: true,
      state: "completed",
      text: "Reply",
      textComplete: true,
      ...change,
    },
    1,
  );
const task = (runs: Run[]): Transcript => ({
  ...emptyActivity,
  sessionKey: "task",
  runs,
  items: [],
  status: "ready",
  error: null,
  hasMore: false,
  live: null,
  loadedAt: 1,
  linkedRuns: {},
  interSession: [],
  mcpTools: {},
});
function storage() {
  let value: string | null = null;
  return {
    getItem: () => value,
    setItem: (_key: string, v: string) => {
      value = v;
    },
  };
}
it("F-519: only a finished reply rendered for the sending viewer counts", () => {
  for (const [change, open, rendered] of [
    [{ state: "running" }, "task", true],
    [{ origin: "history" }, "task", true],
    [{ origin: "gateway" }, "task", true],
    [{ messageId: "someone-else" }, "task", true],
    [{ state: "failed" }, "task", true],
    [{ state: "stopped" }, "task", true],
    [{ text: "  " }, "task", true],
    [{ outcomeKnown: false }, "task", true],
    [{ endFromRows: true }, "task", true],
    [{}, null, true],
    [{}, "other-task", true],
    [{}, "task", false],
  ] as Array<[Partial<Run>, string | null, boolean]>) {
    const watch = new InvitationReplies();
    const count = vi.fn(() => true);
    watch.sent("task", "mine");
    watch.observe({ task: task([make(change)]) }, open, () => rendered, count);
    expect(count).not.toHaveBeenCalled();
  }
});
it("F-519: the sixth distinct reply claims the invitation before dismissal or either action, including after restart", () => {
  const store = storage();
  for (let i = 1; i <= 7; i++) {
    const watch = new InvitationReplies();
    watch.sent("task", "mine");
    const observe = () =>
      watch.observe(
        { task: task([make()]) },
        "task",
        () => true,
        () => countReply(() => store),
      );
    expect(observe()).toBe(i === 6);
    expect(observe()).toBe(false);
  }
  expect(store.getItem()).toBe("6");
});
it("F-519: unreadable, unwritable or unconfirmed preferences suppress the invitation", () => {
  const fail = () => {
    throw new Error("unavailable");
  };
  for (const store of [
    { getItem: fail, setItem: vi.fn() },
    { getItem: () => "5", setItem: fail },
    { getItem: () => "5", setItem: vi.fn() },
  ])
    expect(countReply(() => store)).toBe(false);
});

it("F-519: a new task keeps its first message through run binding and a foreground dialog", () => {
  const watch = new InvitationReplies();
  const count = vi.fn(() => true);
  watch.sent("task", "mine");
  watch.sent("task", "mine");
  watch.observe({ task: task([make({ state: "running" })]) }, "task", () => true, count);
  const transcripts = { task: task([make({ messageId: null })]) };
  watch.observe(transcripts, "task", () => true, count, true);
  expect(count).not.toHaveBeenCalled();
  expect(watch.observe(transcripts, "task", () => true, count)).toBe(true);
  expect(count).toHaveBeenCalledTimes(1);
});

it("F-519: returning to a task cannot claim a reply that completed in the background", () => {
  const watch = new InvitationReplies();
  const count = vi.fn(() => true);
  watch.sent("task", "mine");
  const transcripts = { task: task([make()]) };
  watch.observe(transcripts, null, () => true, count);
  watch.observe(transcripts, "task", () => true, count);
  expect(count).not.toHaveBeenCalled();
});
