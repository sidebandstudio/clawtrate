// The transition tables of docs/design/conversation.md, sections 15 and 16, one
// case each, driven through the engine against the fake gateway: what the run,
// the held and queued messages and the pending cards become, and what was sent.
// The interface's half (the status line, Send now) is in packages/ui/test/live.test.ts.

import { describe, expect, it } from "vitest";
import { isActive } from "../src/runs.ts";
import { agentEvent, KEY, openTask, questionRecord, sentTexts } from "./client-harness.ts";
import { deferred, sleep, until } from "./fake-gateway.ts";

type Opened = Awaited<ReturnType<typeof openTask>>;

const start = ({ gateway }: Opened, runId = "run-x") =>
  gateway.emit("agent", agentEvent(runId, 1, "lifecycle", { phase: "start" }));

async function asking(task: Opened, ids: string[] = ["ask_1"]) {
  start(task);
  for (const id of ids) task.gateway.emit("question.requested", questionRecord(id, "run-x"));
  await until(() => task.transcript().questions.length === ids.length);
  await until(() => task.transcript().runs[0]?.state === "waiting");
}

const resolved = (task: Opened, id: string, status: "answered" | "dismissed" | "expired") =>
  task.gateway.emit("question.resolved", { id, status, sessionKey: KEY, ts: Date.now() });

const statuses = (task: Opened) => task.transcript().outbox.map((m) => [m.text, m.status]);
const queueModes = (task: Opened) =>
  task.gateway.calls("chat.send").map((p) => (p as { queueMode: string }).queueMode);

const cases: Array<[string, (task: Opened) => Promise<void>]> = [
  [
    "a successful run goes from running to completed, and nothing is left active",
    async (task) => {
      task.client.sendMessage(KEY, "check the disk");
      await until(() => task.gateway.calls("chat.send").length === 1);
      start(task, "run-1");
      await until(() => task.transcript().runs[0]?.state === "running");
      task.gateway.emit("agent", agentEvent("run-1", 2, "lifecycle", { phase: "end" }));
      await until(() => task.transcript().runs[0]?.state === "completed");
      expect(task.transcript().runs.filter((run) => isActive(run.state))).toEqual([]);
    },
  ],
  [
    "a steer sent while only an approval is pending joins the run, and the approval stays pending",
    async (task) => {
      start(task);
      task.gateway.emit(
        "agent",
        agentEvent("run-x", 2, "lifecycle", { phase: "waiting-approval" }),
      );
      task.gateway.emit("exec.approval.requested", {
        id: "approval-1",
        request: { command: "ls", sessionKey: KEY, runId: "run-x" },
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      });
      await until(() => task.transcript().runs[0]?.state === "waiting");
      task.client.sendMessage(KEY, "and look in /tmp too");
      await until(() => task.gateway.calls("chat.send").length === 1);
      expect(queueModes(task)).toEqual(["steer"]);
      expect(task.transcript().runs[0]!.state).toBe("waiting");
      expect(task.transcript().runs[0]!.pendingCards.map((card) => card.kind)).toContain(
        "approval",
      );
    },
  ],
  [
    "while a question is pending a typed message is held, in every mode, and nothing is sent",
    async (task) => {
      await asking(task);
      task.client.sendMessage(KEY, "typed");
      task.client.sendMessage(KEY, "queued with the modifier", { mode: "queue" });
      expect(statuses(task)).toEqual([
        ["typed", "held"],
        ["queued with the modifier", "held"],
      ]);
      await sleep(30);
      expect(task.gateway.calls("chat.send")).toEqual([]);
      expect(task.transcript().questions[0]!.status).toBe("pending");
      expect(task.transcript().runs[0]!.state).toBe("waiting");
    },
  ],
  [
    "one of two pending questions settled: the messages stay held",
    async (task) => {
      await asking(task, ["ask_1", "ask_2"]);
      task.client.sendMessage(KEY, "wait for both");
      resolved(task, "ask_1", "answered");
      await until(() => task.transcript().questions.some((q) => q.status === "answered"));
      await sleep(30);
      expect(statuses(task)).toEqual([["wait for both", "held"]]);
      expect(task.gateway.calls("chat.send")).toEqual([]);
    },
  ],
  ...(["answered", "dismissed", "expired"] as const).map(
    (how): [string, (task: Opened) => Promise<void>] => [
      `the last pending question ${how}: held messages are released in the order sent, as steers into the run, and one sent with Queue stays queued`,
      async (task) => {
        await asking(task);
        task.client.sendMessage(KEY, "first");
        task.client.sendMessage(KEY, "after the turn", { mode: "queue" });
        task.client.sendMessage(KEY, "second");
        resolved(task, "ask_1", how);
        await until(() => sentTexts(task.gateway).length === 2);
        await sleep(30);
        expect(sentTexts(task.gateway)).toEqual(["first", "second"]);
        expect(queueModes(task)).toEqual(["steer", "steer"]);
        expect(statuses(task).find(([text]) => text === "after the turn")![1]).toBe("queued");
      },
    ],
  ),
  [
    "the run ends by itself with messages held: they become queued and start in order, one run each",
    async (task) => {
      await asking(task);
      task.client.sendMessage(KEY, "one");
      task.client.sendMessage(KEY, "two");
      task.gateway.emit("agent", agentEvent("run-x", 3, "lifecycle", { phase: "end" }));
      await until(() => sentTexts(task.gateway).length === 1);
      expect(sentTexts(task.gateway)).toEqual(["one"]);
      expect(queueModes(task)).toEqual(["followup"]);
      expect(statuses(task).find(([text]) => text === "two")![1]).toBe("queued");
      task.gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
      task.gateway.emit("agent", agentEvent("run-1", 2, "lifecycle", { phase: "end" }));
      await until(() => sentTexts(task.gateway).length === 2);
      expect(sentTexts(task.gateway)).toEqual(["one", "two"]);
    },
  ],
  [
    "Stop confirmed: held and queued messages stay Not sent, and nothing starts by itself",
    async (task) => {
      await asking(task);
      task.client.sendMessage(KEY, "held");
      await task.client.stopRun(KEY, "run-x");
      task.client.sendMessage(KEY, "sent while stopping");
      task.gateway.emit("chat", { runId: "run-x", sessionKey: KEY, seq: 9, state: "aborted" });
      await until(() => task.transcript().outbox.every((m) => m.status === "not-sent"));
      await sleep(50);
      expect(task.gateway.calls("chat.send")).toEqual([]);
      expect(task.transcript().runs.filter((run) => isActive(run.state))).toEqual([]);
      expect(task.transcript().questions[0]!.status).not.toBe("pending");
    },
  ],
  [
    "a Stop whose outcome is not known: what was queued behind it stays Not sent, and nothing starts by itself",
    async (task) => {
      const answer = deferred<unknown>();
      task.gateway.handlers["chat.send"] = () => answer.promise;
      task.client.sendMessage(KEY, "first");
      await until(() => task.gateway.calls("chat.send").length === 1);
      const local = task.transcript().runs[0]!;
      // Stop before the gateway named the run, then a message behind it.
      await task.client.stopRun(KEY, local.id);
      task.client.sendMessage(KEY, "behind the stop");
      // Accepted with no run named, and history shows nothing of it: how it ended is not known.
      answer.resolve({ status: "started" });
      await until(() => task.transcript().runs.some((run) => run.state === "stopped"));
      const stopped = task.transcript().runs.find((run) => run.state === "stopped")!;
      expect(stopped.outcomeKnown).toBe(false);
      await until(() =>
        task
          .transcript()
          .outbox.some((m) => m.text === "behind the stop" && m.status === "not-sent"),
      );
      await sleep(50);
      expect(sentTexts(task.gateway)).toEqual(["first"]);
    },
  ],
  [
    "a reply typed in a thread while a question is pending is held, as any message, and keeps what it answers",
    async (task) => {
      await asking(task);
      task.client.sendMessage(KEY, "about that", { replyToId: "row-1" });
      expect(task.transcript().outbox[0]).toMatchObject({ status: "held", replyToId: "row-1" });
      await sleep(30);
      expect(task.gateway.calls("chat.send")).toEqual([]);
      resolved(task, "ask_1", "answered");
      await until(() => task.gateway.calls("chat.send").length === 1);
      expect(task.gateway.calls("chat.send")[0]).toMatchObject({ replyToId: "row-1" });
    },
  ],
  [
    "the stop request fails: the run goes back, the question stays pending and held messages stay held",
    async (task) => {
      task.gateway.handlers["chat.abort"] = () => {
        throw new Error("not now");
      };
      await asking(task);
      task.client.sendMessage(KEY, "held");
      await task.client.stopRun(KEY, "run-x").catch(() => {});
      await until(() => task.transcript().runs[0]?.stopError != null);
      expect(task.transcript().runs[0]!.state).toBe("waiting");
      expect(task.transcript().questions[0]!.status).toBe("pending");
      expect(statuses(task)).toEqual([["held", "held"]]);
      expect(task.gateway.calls("chat.send")).toEqual([]);
    },
  ],
];

describe("F-468: the transition tables of the conversation design, sections 15 and 16", () => {
  it.each(cases)("F-468: %s", async (_name, play) => {
    const task = await openTask();
    task.gateway.handlers["question.resolve"] = () => ({ status: "answered" });
    try {
      await play(task);
    } finally {
      task.client.stop();
    }
  });
});

describe("F-421: a message sent while the run is stopping", () => {
  it("F-421: is kept on the shelf, queued; a confirmed Stop leaves it Not sent, and Send then starts a run with it", async () => {
    const task = await openTask();
    start(task);
    await until(() => task.transcript().runs[0]?.state === "running");
    await task.client.stopRun(KEY, "run-x");
    const id = task.client.sendMessage(KEY, "then do this");
    expect(task.transcript().outbox[0]).toMatchObject({ id, status: "queued", mode: "queue" });
    task.gateway.emit("chat", { runId: "run-x", sessionKey: KEY, seq: 2, state: "aborted" });
    await until(() => task.transcript().outbox[0]?.status === "not-sent");
    await sleep(30);
    expect(task.gateway.calls("chat.send")).toEqual([]);
    task.client.retryMessage(KEY, id);
    await until(() => sentTexts(task.gateway).length === 1);
    expect(sentTexts(task.gateway)).toEqual(["then do this"]);
    task.client.stop();
  });

  it("F-421: Send on a Not sent row while another run is going sends it as a message sent then would: a steer into that run", async () => {
    const task = await openTask();
    start(task);
    await until(() => task.transcript().runs[0]?.state === "running");
    await task.client.stopRun(KEY, "run-x");
    const id = task.client.sendMessage(KEY, "then do this", { mode: "queue" });
    task.gateway.emit("chat", { runId: "run-x", sessionKey: KEY, seq: 2, state: "aborted" });
    await until(() => task.transcript().outbox[0]?.status === "not-sent");
    // The person has started another run since.
    start(task, "run-y");
    await until(() =>
      task.transcript().runs.some((run) => run.id === "run-y" && run.state === "running"),
    );
    task.client.retryMessage(KEY, id);
    await until(() => task.gateway.calls("chat.send").length === 1);
    expect(queueModes(task)).toEqual(["steer"]);
    expect(task.transcript().outbox[0]).toMatchObject({ mode: "steer", runId: "run-y" });
    task.client.stop();
  });

  it("F-421: when completion wins the race with Stop, the messages queued while stopping start in order, one run each", async () => {
    const task = await openTask();
    task.gateway.handlers["chat.abort"] = () => ({ ok: true, aborted: false, runIds: [] });
    start(task);
    await until(() => task.transcript().runs[0]?.state === "running");
    await task.client.stopRun(KEY, "run-x");
    task.client.sendMessage(KEY, "first after");
    task.client.sendMessage(KEY, "second after");
    expect(statuses(task)).toEqual([
      ["first after", "queued"],
      ["second after", "queued"],
    ]);
    task.gateway.emit(
      "agent",
      agentEvent("run-x", 2, "lifecycle", { phase: "end", aborted: false }),
    );
    await until(() => task.transcript().runs[0]?.state === "completed");
    expect(task.transcript().runs[0]!.finishedBeforeStop).toBe(true);
    await until(() => sentTexts(task.gateway).length === 1);
    expect(sentTexts(task.gateway)).toEqual(["first after"]);
    task.gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    task.gateway.emit("agent", agentEvent("run-1", 2, "lifecycle", { phase: "end" }));
    await until(() => sentTexts(task.gateway).length === 2);
    expect(sentTexts(task.gateway)).toEqual(["first after", "second after"]);
    task.client.stop();
  });
});
