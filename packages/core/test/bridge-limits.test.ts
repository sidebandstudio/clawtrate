// The host survives anything a viewer sends: every bound is a named constant,
// tested at the bound and one past it; task commands act only on tasks the
// viewer has open; and work a viewer started but the gateway never saw goes
// away with the viewer.

import { describe, expect, it } from "vitest";
import {
  AttachmentStore,
  MAX_PENDING_ATTACHMENTS,
  MAX_PENDING_ATTACHMENT_BYTES,
} from "../src/attachments.ts";
import {
  createBridgeSession,
  MAX_VIEWER_OPEN_TASKS,
  MAX_VIEWER_PENDING_COMMANDS,
  type BridgeCommand,
} from "../src/bridge.ts";
import { ClawtrateClient, MAX_TRACKED_TASKS, MAX_OUTBOX_PER_TASK } from "../src/client.ts";
import {
  encodeBridgeFrame,
  MAX_BRIDGE_FRAME_BYTES,
  BridgeFrameTooLargeError,
} from "../src/remote-bridge.ts";
import { READ_SCOPES } from "../src/scopes.ts";
import { agentEvent, KEY, openTask } from "./client-harness.ts";
import { deferred, FakeGateway, memoryStorage, sleep, testHost, until } from "./fake-gateway.ts";

/** A client stand-in that records what reaches it. */
function stubClient(overrides: Partial<Record<string, (...args: never[]) => unknown>> = {}) {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const client = {
    openSession: (key: string) => {
      calls.push(`open ${key}`);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    },
    closeSession: (key: string) => {
      calls.push(`close ${key}`);
      counts.set(key, (counts.get(key) ?? 1) - 1);
    },
    retryNow: () => new Promise(() => {}),
    withdraw: () => {},
    ...overrides,
  } as unknown as ClawtrateClient;
  return { client, calls, counts };
}

describe("per-viewer bounds", () => {
  it(`holds at most MAX_VIEWER_OPEN_TASKS (${MAX_VIEWER_OPEN_TASKS}) tasks open`, async () => {
    const { client } = stubClient();
    const viewer = createBridgeSession(client);
    for (let i = 0; i < MAX_VIEWER_OPEN_TASKS; i += 1) {
      await viewer.apply({ type: "openSession", key: `agent:a:t${i}` });
    }
    await expect(viewer.apply({ type: "openSession", key: "agent:a:one-more" })).rejects.toThrow(
      /at once/,
    );
    // Re-opening one it holds is not a new task.
    await viewer.apply({ type: "openSession", key: "agent:a:t0" });
  });

  it(`has at most MAX_VIEWER_PENDING_COMMANDS (${MAX_VIEWER_PENDING_COMMANDS}) commands in flight`, async () => {
    const { client } = stubClient();
    const viewer = createBridgeSession(client);
    const inFlight = Array.from({ length: MAX_VIEWER_PENDING_COMMANDS }, () =>
      viewer.apply({ type: "retry" }),
    );
    void inFlight;
    await expect(viewer.apply({ type: "retry" })).rejects.toThrow(/Too many requests/);
  });

  it("refuses every task command for a task this viewer has not opened, including another viewer's", async () => {
    const calls: string[] = [];
    const record = (name: string) => () => {
      calls.push(name);
    };
    const { client } = stubClient({
      sendMessage: record("sendMessage") as never,
      retryMessage: record("retryMessage") as never,
      deleteMessage: record("deleteMessage") as never,
      cancelQueued: record("cancelQueued") as never,
      sendQueuedNow: record("sendQueuedNow") as never,
      stopRun: record("stopRun") as never,
      answerQuestion: record("answerQuestion") as never,
      dismissQuestion: record("dismissQuestion") as never,
      resolveApproval: record("resolveApproval") as never,
      readStepRaw: record("readStepRaw") as never,
    });
    const owner = createBridgeSession(client);
    const other = createBridgeSession(client);
    await owner.apply({ type: "openSession", key: KEY });
    const commands: BridgeCommand[] = [
      { type: "sendMessage", key: KEY, text: "hi", mode: "auto", attachmentIds: [] },
      { type: "retryMessage", key: KEY, messageId: "m1" },
      { type: "deleteMessage", key: KEY, messageId: "m1" },
      { type: "cancelQueued", key: KEY, messageId: "m1" },
      { type: "sendQueuedNow", key: KEY, messageId: "m1" },
      { type: "stopRun", key: KEY, runId: "run-1" },
      { type: "answerQuestion", key: KEY, questionId: "ask_1", answers: { color: ["Blue"] } },
      { type: "dismissQuestion", key: KEY, questionId: "ask_1" },
      {
        type: "resolveApproval",
        key: KEY,
        approvalId: "ap-1",
        decision: "deny",
        expiresInDays: null,
      },
      { type: "readStepRaw", key: KEY, stepId: "tool:call_1|fc_2" },
    ];
    for (const command of commands) {
      await expect(other.apply(command)).rejects.toThrow(/not open in this view/);
    }
    expect(calls).toEqual([]);
    // Closing in another viewer does nothing to the owner's interest.
    await other.apply({ type: "closeSession", key: KEY });
    for (const command of commands) await owner.apply(command);
    expect(calls).toHaveLength(commands.length);
  });

  it("withdraws a task creation still waiting for access when its viewer goes away", async () => {
    const wait = deferred<unknown>();
    const { client, gateway } = await openTask({ held: READ_SCOPES });
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    gateway.handlers["sessions.create"] = () => ({
      ok: true,
      key: "agent:otto:dashboard:x",
      runId: "r",
    });
    const viewer = createBridgeSession(client);
    const creating = viewer.apply({ type: "createTask", botId: "otto", text: "New", label: null });
    await until(() => client.state.connection.upgrade.status === "pending");
    viewer.dispose();
    wait.resolve({
      status: "approved",
      requestId: "up-1",
      deviceToken: "rotated",
      scopes: ["operator.read", "operator.write"],
    });
    await expect(creating).rejects.toThrow(/withdrawn/);
    await sleep(30);
    expect(gateway.calls("sessions.create")).toEqual([]);
    client.stop();
  });
});

describe("client-wide bounds", () => {
  it("follow the host's own counts, which may be lower, never higher", async () => {
    const { client } = await openTask({ client: { limits: { trackedTasks: 2 } } });
    const viewer = createBridgeSession(client, { maxOpenTasks: 1 });
    try {
      client.openSession("agent:otto:t1");
      expect(() => client.openSession("agent:otto:t2")).toThrow("At most 2 tasks");
      await viewer.apply({ type: "openSession", key: KEY });
      await expect(viewer.apply({ type: "openSession", key: "agent:otto:t1" })).rejects.toThrow(
        "1 tasks open",
      );
    } finally {
      viewer.dispose();
      client.stop();
    }
    const host = testHost(new FakeGateway(), memoryStorage({}));
    expect(
      () => new ClawtrateClient(host, { limits: { trackedTasks: MAX_TRACKED_TASKS + 1 } }),
    ).toThrow(RangeError);
    expect(() =>
      createBridgeSession(new ClawtrateClient(host), { maxOpenTasks: MAX_VIEWER_OPEN_TASKS + 1 }),
    ).toThrow(RangeError);
  });

  it(`follows at most MAX_TRACKED_TASKS (${MAX_TRACKED_TASKS}) tasks`, async () => {
    const { client } = await openTask();
    for (let i = 1; i < MAX_TRACKED_TASKS; i += 1) client.openSession(`agent:otto:t${i}`);
    expect(() => client.openSession("agent:otto:one-more")).toThrow(/at once/);
    client.stop();
  });

  it(`holds at most MAX_OUTBOX_PER_TASK (${MAX_OUTBOX_PER_TASK}) unsent messages per task`, async () => {
    const { client, gateway } = await openTask();
    gateway.emit("agent", agentEvent("run-x", 1, "lifecycle", { phase: "start" }));
    await until(() => client.state.transcripts[KEY]!.runs.length === 1);
    for (let i = 0; i < MAX_OUTBOX_PER_TASK; i += 1)
      client.sendMessage(KEY, `m${i}`, { mode: "queue" });
    expect(() => client.sendMessage(KEY, "one more", { mode: "queue" })).toThrow(
      /waiting to be sent/,
    );
    client.stop();
  });
});

describe("bridge frames", () => {
  const frame = (text: string) => ({
    type: "command" as const,
    id: "1",
    command: {
      type: "sendMessage" as const,
      key: KEY,
      text,
      mode: "auto" as const,
      attachmentIds: [],
    },
  });

  it("refuses a command too large in UTF-8 before it reaches the socket", () => {
    // 24,000 CJK characters are within the message character limit but 72,000 bytes.
    expect(() => encodeBridgeFrame(frame("字".repeat(24_000)))).toThrow(BridgeFrameTooLargeError);
    const overhead = encodeBridgeFrame(frame("")).length;
    expect(encodeBridgeFrame(frame("a".repeat(MAX_BRIDGE_FRAME_BYTES - overhead))).length).toBe(
      MAX_BRIDGE_FRAME_BYTES,
    );
    expect(() =>
      encodeBridgeFrame(frame("a".repeat(MAX_BRIDGE_FRAME_BYTES - overhead + 1))),
    ).toThrow(BridgeFrameTooLargeError);
  });
});

describe("files arriving at the same time", () => {
  it(`hold room before their bytes, within MAX_PENDING_ATTACHMENT_BYTES and MAX_PENDING_ATTACHMENTS (${MAX_PENDING_ATTACHMENTS})`, () => {
    let n = 0;
    const store = new AttachmentStore({ newId: () => `a-${(n += 1)}` });
    const half = MAX_PENDING_ATTACHMENT_BYTES / 2;
    const meta = { fileName: "a.bin", mimeType: "application/octet-stream" };
    // Each file is checked against the gateway's per-file ceiling; use many smaller files to reach the total.
    const chunk = 16 * 1024 * 1024;
    const reservations = Array.from({ length: (half / chunk) * 2 }, () =>
      store.reserve(meta, chunk),
    );
    expect(store.available()).toBe(0);
    expect(() => store.reserve(meta, 1)).toThrow(/waiting/);
    reservations[0]!.release();
    const info = store.reserve(meta, chunk).commit(() => "");
    expect(info.sizeBytes).toBe(chunk);
    for (const each of reservations.slice(1)) each.release();

    const counted = new AttachmentStore({ newId: () => `b-${(n += 1)}` });
    for (let i = 0; i < MAX_PENDING_ATTACHMENTS; i += 1)
      counted.reserve({ fileName: "x.txt", mimeType: "text/plain" }, 1);
    expect(() => counted.reserve({ fileName: "x.txt", mimeType: "text/plain" }, 1)).toThrow(
      /waiting/,
    );
  });
});
