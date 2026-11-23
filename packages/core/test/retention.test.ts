// What a viewer can make the host keep, at each bound and one past it. Every
// path into retained work counts: failed and cancelled messages and their
// files, operations waiting for access from viewers that went away, tasks being
// created, steps in one run and activity across tasks. Nothing accepted is
// dropped to make room; what is dropped from view is counted.

import { describe, expect, it } from "vitest";
import { MAX_VIEWER_OPEN_TASKS, createBridgeSession } from "../src/bridge.ts";
import {
  MAX_ACCESS_WAITERS,
  MAX_OUTBOX_PER_TASK,
  MAX_PENDING_APPROVALS_PER_TASK,
  MAX_RETAINED_ATTACHMENT_BYTES,
  MAX_TRACKED_TASKS,
  type OutgoingAttachment,
} from "../src/client.ts";
import {
  applyAgentEvent,
  emptyActivity,
  MAX_STEPS_PER_RUN,
  RawTable,
  retainActivity,
  type EngineContext,
  type TaskActivity,
} from "../src/runs.ts";
import { READ_SCOPES } from "../src/scopes.ts";
import { agentEvent, KEY, openTask, questionRecord, asShown } from "./client-harness.ts";
import { GatewayError, deferred, sleep, until } from "./fake-gateway.ts";

const refuse = () => {
  throw new GatewayError({ code: "INVALID_REQUEST", message: "refused" });
};

/** A file of exactly `bytes` decoded bytes, as the base64 the client counts. */
function file(bytes: number, name = "data.bin"): OutgoingAttachment {
  const padding = (3 - (bytes % 3)) % 3;
  const content = "A".repeat(4 * Math.ceil(bytes / 3) - padding) + "=".repeat(padding);
  return { type: "file", mimeType: "application/octet-stream", fileName: name, content };
}

describe("every message an outbox holds counts (A5, B2)", () => {
  it(`holds at most MAX_OUTBOX_PER_TASK (${MAX_OUTBOX_PER_TASK}) failed messages, and still lets each be retried or deleted`, async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["chat.send"] = refuse;
    for (let i = 0; i < MAX_OUTBOX_PER_TASK; i += 1) {
      client.sendMessage(KEY, `m${i}`, asShown(client));
      await until(() => transcript().outbox[i]?.status === "failed");
    }
    expect(transcript().outbox).toHaveLength(MAX_OUTBOX_PER_TASK);
    expect(() => client.sendMessage(KEY, "one more", asShown(client))).toThrow(/already holds/);
    expect(transcript().outbox).toHaveLength(MAX_OUTBOX_PER_TASK);
    // A retry adds nothing, so it is never refused for room.
    const first = transcript().outbox[0]!.id;
    client.retryMessage(KEY, first);
    await until(() => gateway.calls("chat.send").length === MAX_OUTBOX_PER_TASK + 1);
    await until(() => transcript().outbox[0]?.status === "failed");
    client.deleteMessage(KEY, first);
    expect(transcript().outbox).toHaveLength(MAX_OUTBOX_PER_TASK - 1);
    client.sendMessage(KEY, "room again", asShown(client));
    client.stop();
  });

  it("counts cancelled messages too", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.emit("agent", agentEvent("run-x", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.length === 1);
    for (let i = 0; i < MAX_OUTBOX_PER_TASK; i += 1) {
      const id = client.sendMessage(KEY, `q${i}`, { ...asShown(client), mode: "queue" });
      client.cancelQueued(KEY, id);
    }
    expect(() =>
      client.sendMessage(KEY, "one more", { ...asShown(client), mode: "queue" }),
    ).toThrow(/already holds/);
    client.stop();
  });
});

describe(`file bytes kept for outgoing messages, within MAX_RETAINED_ATTACHMENT_BYTES (A5, B2)`, () => {
  it("counts the files of failed messages, refuses one byte past the bound, and frees them on delete", async () => {
    const { client, gateway } = await openTask();
    gateway.handlers["chat.send"] = refuse;
    const size = 16 * 1024 * 1024;
    const count = MAX_RETAINED_ATTACHMENT_BYTES / size;
    // One such file per task: each task's own budget holds one.
    const keys = Array.from({ length: count + 1 }, (_, i) => `agent:otto:files${i}`);
    for (const key of keys) client.openSession(key);
    // A view sends once it shows its task's session.
    await until(() => keys.every((key) => client.state.transcripts[key]?.sessionId));
    for (let i = 0; i < count; i += 1) {
      client.sendMessage(keys[i]!, `f${i}`, {
        ...asShown(client, keys[i]!),
        attachments: [file(size, `f${i}.bin`)],
      });
      await until(() => client.state.transcripts[keys[i]!]!.outbox[0]?.status === "failed");
    }
    expect(client.retainedAttachmentBytes).toBe(MAX_RETAINED_ATTACHMENT_BYTES);
    expect(() =>
      client.sendMessage(keys[count]!, "past", {
        ...asShown(client, keys[count]!),
        attachments: [file(1)],
      }),
    ).toThrow(/still waiting to go out/);
    // A message without files is still accepted.
    client.sendMessage(keys[count]!, "text only", asShown(client, keys[count]!));
    client.deleteMessage(keys[0]!, client.state.transcripts[keys[0]!]!.outbox[0]!.id);
    expect(client.retainedAttachmentBytes).toBe(MAX_RETAINED_ATTACHMENT_BYTES - size);
    client.sendMessage(keys[0]!, "fits again", {
      ...asShown(client, keys[0]!),
      attachments: [file(size)],
    });
    client.stop();
  }, 30_000);

  it("keeps a failed message's files for its retry, and drops a cancelled one's", async () => {
    const { client, gateway, transcript } = await openTask();
    let refusing = true;
    gateway.handlers["chat.send"] = () => (refusing ? refuse() : { runId: "run-9" });
    const id = client.sendMessage(KEY, "with a file", {
      ...asShown(client),
      attachments: [file(10, "a.txt")],
    });
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(client.retainedAttachmentBytes).toBe(10);
    refusing = false;
    client.retryMessage(KEY, id);
    await until(() => gateway.calls("chat.send").length === 2);
    expect((gateway.calls("chat.send")[1] as { attachments: unknown[] }).attachments).toHaveLength(
      1,
    );

    gateway.emit("agent", agentEvent("run-9", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.id === "run-9"));
    const queued = client.sendMessage(KEY, "later", {
      ...asShown(client),
      mode: "queue",
      attachments: [file(7)],
    });
    expect(client.retainedAttachmentBytes).toBe(17);
    client.cancelQueued(KEY, queued);
    expect(client.retainedAttachmentBytes).toBe(10);
    client.stop();
  });
});

describe("operations a viewer leaves waiting for access (A5, B2)", () => {
  it("are withdrawn when the viewer goes away, however often that is repeated", async () => {
    const { client, gateway } = await openTask({ held: READ_SCOPES });
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => new Promise(() => {});
    gateway.handlers["sessions.create"] = () => ({ key: "agent:otto:new", runId: "r" });
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const viewer = createBridgeSession(client);
      // As many creations as the viewer may hold.
      const creations = Array.from({ length: MAX_VIEWER_OPEN_TASKS }, (_, i) =>
        viewer
          .apply({ type: "createTask", botId: "otto", text: `New ${i}`, label: null })
          .catch((error: Error) => error.message),
      );
      await until(() => client.pendingAccessWaiters === MAX_VIEWER_OPEN_TASKS);
      viewer.dispose();
      expect(client.pendingAccessWaiters).toBe(0);
      expect(await Promise.all(creations)).toEqual(
        Array(MAX_VIEWER_OPEN_TASKS).fill("The request was withdrawn."),
      );
      // Nothing was asked of the gateway, so no creation is kept.
      expect(client.state.creations).toEqual([]);
    }
    await sleep(20);
    expect(gateway.calls("sessions.create")).toEqual([]);
    client.stop();
  });

  it(`are at most MAX_ACCESS_WAITERS (${MAX_ACCESS_WAITERS}) at once`, async () => {
    const { client, gateway } = await openTask({ held: READ_SCOPES });
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => new Promise(() => {});
    // Spread over tasks: each shows at most MAX_PENDING_APPROVALS_PER_TASK.
    // The task already open is the first.
    const where = (i: number) => {
      const n = Math.floor(i / MAX_PENDING_APPROVALS_PER_TASK);
      return n === 0 ? KEY : `agent:otto:w${n}`;
    };
    for (let i = MAX_PENDING_APPROVALS_PER_TASK; i < MAX_ACCESS_WAITERS; i += 1)
      client.openSession(where(i));
    for (let i = 0; i < MAX_ACCESS_WAITERS; i += 1) {
      gateway.emit("exec.approval.requested", {
        id: `ap-${i}`,
        request: { command: "ls", sessionKey: where(i), allowedDecisions: ["allow-once", "deny"] },
        createdAtMs: 1,
        expiresAtMs: 9_000_000_000_000,
      });
    }
    // One more operation, in a task already open: answering a question.
    gateway.emit("agent", agentEvent("asking", 1, "lifecycle", { phase: "start" }, where(0)));
    gateway.emit("question.requested", questionRecord("ask_more", "asking", where(0)));
    await until(
      () =>
        client.state.transcripts[where(MAX_ACCESS_WAITERS - 1)]!.approvals.some(
          (each) => each.id === `ap-${MAX_ACCESS_WAITERS - 1}`,
        ) && client.state.transcripts[where(0)]!.questions.length === 1,
    );
    const waiting = Array.from({ length: MAX_ACCESS_WAITERS }, (_, i) =>
      client.resolveApproval(where(i), `ap-${i}`, "deny").catch(() => {}),
    );
    void waiting;
    await until(() => client.pendingAccessWaiters === MAX_ACCESS_WAITERS);
    await expect(client.answerQuestion(where(0), "ask_more", { color: ["Blue"] })).rejects.toThrow(
      /Too many operations/,
    );
    client.stop();
  });
});

describe("tasks being created count before the gateway is asked (A5, B2)", () => {
  it(`a viewer holding MAX_VIEWER_OPEN_TASKS (${MAX_VIEWER_OPEN_TASKS}) tasks cannot create another`, async () => {
    const { client, gateway } = await openTask();
    gateway.handlers["sessions.create"] = () => ({
      key: `agent:otto:new-${Math.random()}`,
      runId: "r",
    });
    const viewer = createBridgeSession(client);
    for (let i = 0; i < MAX_VIEWER_OPEN_TASKS - 1; i += 1) {
      await viewer.apply({ type: "openSession", key: `agent:otto:v${i}` });
    }
    // At the bound: the 32nd is a creation.
    await viewer.apply({ type: "createTask", botId: "otto", text: "New", label: null });
    await expect(
      viewer.apply({ type: "createTask", botId: "otto", text: "Again", label: null }),
    ).rejects.toThrow(/at once/);
    expect(gateway.calls("sessions.create")).toHaveLength(1);
    viewer.dispose();
    client.stop();
  });

  it("a creation in flight holds its viewer's slot", async () => {
    const { client, gateway } = await openTask();
    const slow = deferred<unknown>();
    gateway.handlers["sessions.create"] = () => slow.promise;
    const viewer = createBridgeSession(client);
    for (let i = 0; i < MAX_VIEWER_OPEN_TASKS - 1; i += 1) {
      await viewer.apply({ type: "openSession", key: `agent:otto:v${i}` });
    }
    const creating = viewer.apply({ type: "createTask", botId: "otto", text: "New", label: null });
    await until(() => gateway.calls("sessions.create").length === 1);
    await expect(viewer.apply({ type: "openSession", key: "agent:otto:one-more" })).rejects.toThrow(
      /at once/,
    );
    slow.resolve({ key: "agent:otto:made", runId: "r" });
    await creating;
    viewer.dispose();
    client.stop();
  });

  it(`reserves a slot within MAX_TRACKED_TASKS (${MAX_TRACKED_TASKS}) before sessions.create, and gives it back on failure`, async () => {
    const { client, gateway } = await openTask();
    for (let i = 1; i < MAX_TRACKED_TASKS - 1; i += 1) client.openSession(`agent:otto:t${i}`);
    const slow = deferred<unknown>();
    gateway.handlers["sessions.create"] = () => slow.promise;
    // One slot is left: this creation takes it while the gateway works.
    const creating = client.createTask("otto", "New");
    await until(() => gateway.calls("sessions.create").length === 1);
    await expect(client.createTask("otto", "Another")).rejects.toThrow(/at once/);
    expect(() => client.openSession("agent:otto:one-more")).toThrow(/at once/);
    expect(gateway.calls("sessions.create")).toHaveLength(1);
    slow.reject(new GatewayError({ code: "INVALID_REQUEST", message: "no such bot" }));
    await expect(creating).rejects.toThrow(/no such bot/);
    // Given back: the slot can be used again.
    client.openSession("agent:otto:one-more");
    client.stop();
  });
});

describe("steps and activity a task keeps (A6)", () => {
  let raw: RawTable;
  const ctx = (): EngineContext => ({ sessionKey: KEY, now: 5_000, raw });

  function runWithTools(count: number, text = "ok"): TaskActivity {
    raw = new RawTable();
    let activity = emptyActivity;
    let seq = 0;
    const event = (stream: string, data: Record<string, unknown>) =>
      (activity = applyAgentEvent(
        activity,
        agentEvent("run-1", (seq += 1), stream, data),
        ctx(),
      ).activity);
    event("lifecycle", { phase: "start" });
    for (let i = 1; i <= count; i += 1) {
      event("tool", { phase: "start", name: "ls", toolCallId: `c${i}`, args: {} });
      event("tool", {
        phase: "result",
        name: "ls",
        toolCallId: `c${i}`,
        isError: false,
        result: { content: [{ type: "text", text }], details: {} },
      });
    }
    event("lifecycle", { phase: "end" });
    return activity;
  }

  it(`keeps MAX_STEPS_PER_RUN (${MAX_STEPS_PER_RUN}) steps per run and counts what it drops`, () => {
    const atBound = retainActivity(runWithTools(MAX_STEPS_PER_RUN));
    expect(atBound.runs[0]!.steps).toHaveLength(MAX_STEPS_PER_RUN);
    expect(atBound.runs[0]!.omittedSteps).toBe(0);
    const past = retainActivity(runWithTools(MAX_STEPS_PER_RUN + 1));
    expect(past.runs[0]!.steps).toHaveLength(MAX_STEPS_PER_RUN);
    expect(past.runs[0]!.omittedSteps).toBe(1);
    expect(past.runs[0]!.steps[0]!.id).toBe("tool:c2");
    expect(retainActivity(past)).toBe(past);
  });
});
