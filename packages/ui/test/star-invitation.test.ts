import {
  MAX_OUTBOX,
  MAX_TRACKED_TASKS,
  emptyActivity,
  newRun,
  type Transcript,
  type Run,
} from "@clawtrate/core";
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

it.each(["reconciled", "retried"])("F-519: a %s reply never invites early or twice", (kind) => {
  const store = storage();
  const watch = new InvitationReplies();
  let finished = 0;
  let shown = 0;
  function see(run: Run) {
    const show = watch.observe(
      { task: task([run]) },
      "task",
      () => true,
      () => countReply(() => store),
    );
    if (show) shown++;
    expect(Number(store.getItem())).toBeLessThanOrEqual(finished);
    expect(shown).toBeLessThanOrEqual(1);
    if (finished < 6) expect(shown).toBe(0);
  }
  function reply(id: string) {
    watch.sent("task", id);
    finished++;
    see(make({ id, messageId: id }));
  }
  for (let i = 0; i < 5; i++) reply(String(i));
  watch.sent("task", "original");
  if (kind === "reconciled") {
    see(make({ id: "original", messageId: "original", bound: false, state: "running" }));
  } else {
    see(make({ id: "original", messageId: "original", state: "failed" }));
  }
  finished++;
  const confirmed = make({ id: "confirmed", messageId: kind === "retried" ? "original" : null });
  see(confirmed);
  see(confirmed);
  reply("next");
  reply("last");
  expect(shown).toBe(1);
});

it("F-519: two preview tabs reading five can each claim six", () => {
  const store = storage();
  store.setItem("", "5");
  const interleaved = {
    ...store,
    setItem: (key: string, value: string) => {
      expect(countReply(() => store)).toBe(true);
      store.setItem(key, value);
    },
  };
  expect(countReply(() => interleaved)).toBe(true);
  expect(countReply(() => store)).toBe(false);
  expect(countReply(() => interleaved)).toBe(false);
});

it("F-519: a stale preview tab can restore five after another tab shows the invitation", () => {
  const store = storage();
  store.setItem("", "4");
  const stale = {
    ...store,
    setItem(key: string, value: string) {
      expect([countReply(() => store), countReply(() => store)]).toEqual([false, true]);
      store.setItem(key, value);
    },
  };
  expect(countReply(() => stale)).toBe(false);
  expect(store.getItem()).toBe("5");
  expect(countReply(() => store)).toBe(true);
});

it("F-519: a consumed preference stops collecting sends, including pending acknowledgements", () => {
  let collect = true;
  const watch = new InvitationReplies(() => collect);
  watch.sent("task", "mine");
  collect = false;
  watch.sent("task", "next");
  expect(watch.revision).toBe(1);
  collect = true;
  expect(
    watch.observe(
      { task: task([make()]) },
      "task",
      () => true,
      () => true,
    ),
  ).toBe(false);
});

it("F-519: a full viewer tracker drops the oldest unmatched send", () => {
  const watch = new InvitationReplies();
  for (let i = 0; i <= MAX_OUTBOX * MAX_TRACKED_TASKS; i++) watch.sent("task", String(i));
  const see = (id: string) =>
    watch.observe(
      { task: task([make({ messageId: id })]) },
      "task",
      () => true,
      () => true,
    );
  expect(see("0")).toBe(false);
  expect(see("1")).toBe(true);
});

it("F-519: a claim whose write commits but cannot be read back stays consumed", () => {
  const store = storage();
  store.setItem("", "5");
  let written = false;
  const unavailable = {
    getItem: () => {
      if (written) throw new Error("unavailable");
      return store.getItem();
    },
    setItem: (key: string, value: string) => {
      store.setItem(key, value);
      written = true;
    },
  };
  expect(countReply(() => unavailable)).toBe(false);
  expect(countReply(() => store)).toBe(false);
});

it("F-519: a queued send counts on its own run, and a steer does not add another reply", () => {
  const watch = new InvitationReplies();
  const count = vi.fn(() => false);
  watch.sent("task", "mine");
  watch.sent("task", "steer");
  watch.sent("task", "queued");
  const show = (runs: Run[]) => watch.observe({ task: task(runs) }, "task", () => true, count);
  const queued = make({ id: "queued", messageId: "queued", state: "queued", bound: false });
  show([make({ state: "running" }), queued]);
  expect(count).toHaveBeenCalledTimes(0);
  show([make(), queued]);
  expect(count).toHaveBeenCalledTimes(1);
  show([
    make(),
    make({ id: "second", messageId: "queued" }),
    make({ id: "steer", messageId: "steer", origin: "history" }),
  ]);
  expect(count).toHaveBeenCalledTimes(2);
});
