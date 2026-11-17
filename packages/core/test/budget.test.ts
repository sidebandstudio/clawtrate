// One accounting of what the host keeps (ruling 1). Each task's activity,
// history page, raw payloads and outgoing files are charged to its budget,
// and everything the host keeps to the host's: closed material goes first,
// then live work is reduced, each reduction saying so, then new retention is
// refused visibly. Open steps, active text and pending cards are bounded too
// (A3), and many tasks and many viewers together cannot pass the host total (A8).

import { describe, expect, it } from "vitest";
import { AttachmentStore, HostFullError } from "../src/attachments.ts";
import { createBridgeSession } from "../src/bridge.ts";
import { MAX_PENDING_APPROVALS_PER_TASK, type OutgoingAttachment } from "../src/client.ts";
import {
  base64Length,
  HostLedger,
  MAX_HOST_RETAINED,
  MAX_TASK_RETAINED,
} from "../src/retention.ts";
import {
  activitySize,
  applyAgentEvent,
  emptyActivity,
  MAX_STEPS_PER_RUN,
  newRun,
  RawTable,
  retainActivity,
  type TaskActivity,
} from "../src/runs.ts";
import { agentEvent, grantingGateway, KEY, openTask } from "./client-harness.ts";
import { sleep, until } from "./fake-gateway.ts";

const ctx = (raw = new RawTable()) => ({ sessionKey: KEY, now: 5_000, raw });

function openSteps(count: number, argChars: number): TaskActivity {
  const raw = new RawTable();
  let activity = emptyActivity;
  for (let i = 0; i < count; i += 1) {
    activity = retainActivity(
      applyAgentEvent(
        activity,
        agentEvent("r", i + 1, "tool", {
          phase: "start",
          name: "ls",
          toolCallId: `c${i}`,
          args: { input: "x".repeat(argChars) },
        }),
        ctx(raw),
      ).activity,
    );
  }
  return activity;
}

describe("open and live work is bounded too (A3)", () => {
  it(`open steps count against MAX_STEPS_PER_RUN (${MAX_STEPS_PER_RUN}): at the bound all kept, one past drops the oldest`, () => {
    const at = openSteps(MAX_STEPS_PER_RUN, 16_000).runs[0]!;
    expect(at.steps).toHaveLength(MAX_STEPS_PER_RUN);
    expect(at.omittedSteps).toBe(0);
    const past = openSteps(MAX_STEPS_PER_RUN + 1, 16_000).runs[0]!;
    expect(past.steps).toHaveLength(MAX_STEPS_PER_RUN);
    expect(past.omittedSteps).toBe(1);
    expect(past.steps[0]!.id).toBe("tool:c1");
  });

  it("over its budget, a task reduces open steps' bodies, saying so, and keeps their identity", () => {
    const activity = openSteps(40, 16_000);
    const size = activitySize(activity);
    expect(retainActivity(activity, size)).toBe(activity);
    const reduced = retainActivity(activity, size - 1);
    const run = reduced.runs[0]!;
    expect(run.steps).toHaveLength(40);
    expect(run.steps[0]).toMatchObject({
      id: "tool:c0",
      status: "running",
      bodyOmitted: true,
      argsText: null,
    });
    expect(run.steps[1]!.bodyOmitted).toBe(false);
    expect(activitySize(reduced)).toBeLessThanOrEqual(size - 1);
    // A result for a reduced step still finishes it.
    const finished = applyAgentEvent(
      reduced,
      agentEvent("r", 99, "tool", {
        phase: "result",
        name: "ls",
        toolCallId: "c0",
        isError: false,
        result: { content: [{ type: "text", text: "done" }] },
      }),
      ctx(),
    ).activity;
    expect(finished.runs[0]!.steps[0]).toMatchObject({ status: "done", bodyOmitted: true });
  });

  it(`active text at MAX_TASK_RETAINED (${MAX_TASK_RETAINED}) is kept; one character past it is cut, saying so`, () => {
    const withText = (length: number): TaskActivity => ({
      ...emptyActivity,
      runs: [newRun("r", { state: "running", origin: "gateway", text: "x".repeat(length) }, 1)],
    });
    const overhead = activitySize(withText(0));
    const at = withText(MAX_TASK_RETAINED - overhead);
    expect(activitySize(at)).toBe(MAX_TASK_RETAINED);
    expect(retainActivity(at)).toBe(at);
    const past = retainActivity(withText(MAX_TASK_RETAINED - overhead + 1));
    expect(past.runs[0]!.textTruncated).toBe(true);
    expect(activitySize(past)).toBeLessThanOrEqual(MAX_TASK_RETAINED);
    // Later deltas do not join text that was cut.
    const later = applyAgentEvent(
      past,
      agentEvent("r", 5, "assistant", { delta: "more" }),
      ctx(),
    ).activity;
    expect(later.runs[0]!.text).toBe(past.runs[0]!.text);
  });

  it(`a task shows MAX_PENDING_APPROVALS_PER_TASK (${MAX_PENDING_APPROVALS_PER_TASK}) pending approvals; the next waits, kept and visible, until one settles`, async () => {
    const { client, gateway, transcript } = await openTask();
    await until(() => transcript().approvalAccess === "ready");
    const request = (i: number) => ({
      id: `ap-${i}`,
      request: { command: "ls", sessionKey: KEY, allowedDecisions: ["allow-once", "deny"] },
      createdAtMs: 1,
      expiresAtMs: 9_000_000_000_000,
    });
    for (let i = 0; i <= MAX_PENDING_APPROVALS_PER_TASK; i += 1) {
      gateway.emit("exec.approval.requested", request(i));
    }
    await until(() => client.state.unroutedApprovals.length === 1);
    expect(transcript().approvals).toHaveLength(MAX_PENDING_APPROVALS_PER_TASK);
    expect(client.state.unroutedApprovals[0]).toMatchObject({
      id: `ap-${MAX_PENDING_APPROVALS_PER_TASK}`,
      parentSessionKey: null,
    });
    gateway.emit("exec.approval.resolved", { id: "ap-0", decision: "allow-once", ts: 2 });
    await until(() =>
      transcript().approvals.some((each) => each.id === `ap-${MAX_PENDING_APPROVALS_PER_TASK}`),
    );
    expect(client.state.unroutedApprovals).toEqual([]);
    client.stop();
  });
});

describe(`the host total, MAX_HOST_RETAINED (${MAX_HOST_RETAINED})`, () => {
  it("admits a message that fills it exactly and refuses one character more", async () => {
    const ledger = new HostLedger();
    let synthetic = 0;
    ledger.track("synthetic", () => synthetic);
    const { client } = await openTask({ client: { ledger } });
    const text = "y".repeat(100);
    const amount = 256 + text.length;
    synthetic = MAX_HOST_RETAINED - (ledger.used() - synthetic) - amount;
    expect(ledger.available()).toBe(amount);
    client.sendMessage(KEY, text, { mode: "queue" });
    synthetic = MAX_HOST_RETAINED - (ledger.used() - synthetic) - amount + 1;
    expect(ledger.available()).toBe(amount - 1);
    expect(() => client.sendMessage(KEY, text, { mode: "queue" })).toThrow(/host is holding/);
    expect(client.state.retention.full).toBe(true);
    client.stop();
  });

  it("admits an upload that fills it exactly and refuses one byte more", () => {
    const ledger = new HostLedger();
    let synthetic = 0;
    ledger.track("synthetic", () => synthetic);
    let n = 0;
    const store = new AttachmentStore({ newId: () => `u${(n += 1)}`, ledger });
    const meta = { fileName: "a.bin", mimeType: "application/octet-stream" };
    synthetic = MAX_HOST_RETAINED - base64Length(300);
    store.reserve(meta, 300).release();
    synthetic = MAX_HOST_RETAINED - base64Length(300) + 1;
    expect(() => store.reserve(meta, 300)).toThrow(HostFullError);
  });

  it("counts a file once as it moves from the upload store to a message", async () => {
    const { client } = await openTask();
    let n = 0;
    const store = new AttachmentStore({ newId: () => `u${(n += 1)}`, ledger: client.ledger });
    const info = store.add({ fileName: "a.txt", mimeType: "text/plain" }, 5, () => "aGVsbG8=");
    const before = client.ledger.usage();
    expect(before.uploads).toBe(8);
    const viewer = createBridgeSession(client, { attachments: store });
    await viewer.apply({ type: "openSession", key: KEY });
    await viewer.apply({
      type: "sendMessage",
      key: KEY,
      text: "file",
      mode: "auto",
      attachmentIds: [info.id],
    });
    const after = client.ledger.usage();
    expect(after.uploads).toBe(0);
    expect(after.tasks! - before.tasks!).toBeGreaterThanOrEqual(8);
    viewer.dispose();
    client.stop();
  });
});

describe("many tasks and many viewers cannot pass the host total (A8)", () => {
  it("history pages, live work, messages and uploads through four viewers stay within it, and say what they dropped", async () => {
    const limit = 3_000_000;
    const ledger = new HostLedger(limit);
    const gateway = grantingGateway();
    // A page near the gateway's response ceiling, for every task.
    gateway.handlers["chat.history"] = (params) => ({
      messages: Array.from({ length: 200 }, (_, i) => ({
        role: "user",
        content: `${(params as { sessionKey: string }).sessionKey} ${"x".repeat(2_400)}`,
        __openclaw: { id: `u${i}`, seq: i },
      })),
      hasMore: false,
    });
    const { client } = await openTask({ gateway, client: { ledger } });
    let n = 0;
    const store = new AttachmentStore({ newId: () => `u${(n += 1)}`, ledger });
    const viewers = Array.from({ length: 4 }, () =>
      createBridgeSession(client, { attachments: store }),
    );
    const keys = Array.from({ length: 32 }, (_, i) => `agent:otto:many${i}`);
    for (const [i, key] of keys.entries()) {
      await viewers[Math.floor(i / 8)]!.apply({ type: "openSession", key });
      expect(ledger.used()).toBeLessThanOrEqual(limit);
    }
    await until(() => keys.every((key) => client.state.transcripts[key]?.status === "ready"));
    // Live work in several tasks at once.
    let seq = 0;
    for (const key of keys.slice(-4)) {
      for (let i = 0; i < 30; i += 1) {
        gateway.emit(
          "agent",
          agentEvent(
            `run-${key}`,
            (seq += 1),
            "tool",
            {
              phase: "start",
              name: "ls",
              toolCallId: `${key}-c${i}`,
              args: { input: "z".repeat(16_000) },
            },
            key,
          ),
        );
      }
    }
    await sleep(100);
    expect(ledger.used()).toBeLessThanOrEqual(limit);
    // More input once it is full is refused, visibly, not kept.
    const attempts = [];
    for (const key of keys) {
      attempts.push(
        viewers[0]!
          .apply({
            type: "sendMessage",
            key,
            text: "q".repeat(30_000),
            mode: "queue",
            attachmentIds: [],
          })
          .then(
            () => "kept",
            (error: Error) => error.message,
          ),
      );
    }
    const outcomes = await Promise.all(attempts);
    expect(ledger.used()).toBeLessThanOrEqual(limit);
    expect(outcomes.some((each) => /holding as much as it can/.test(each))).toBe(true);
    let refusedUpload = false;
    try {
      for (let i = 0; i < 64; i += 1)
        store.reserve({ fileName: `f${i}.bin`, mimeType: "application/octet-stream" }, 200_000);
    } catch (error) {
      refusedUpload = error instanceof HostFullError;
    }
    expect(refusedUpload).toBe(true);
    expect(ledger.used()).toBeLessThanOrEqual(limit);
    // What was dropped is said: older tasks' pages give way first, and the live tasks say they were reduced.
    const transcripts = keys.map((key) => client.state.transcripts[key]!);
    expect(transcripts.some((each) => each.retention.itemsOmitted > 0 && each.hasMore)).toBe(true);
    expect(transcripts.every((each) => each.retention.used <= MAX_TASK_RETAINED)).toBe(true);
    const live = keys.slice(-4).map((key) => client.state.transcripts[key]!);
    expect(
      live.some((each) => each.runs.some((run) => run.steps.some((step) => step.bodyOmitted))),
    ).toBe(true);
    for (const viewer of viewers) viewer.dispose();
    client.stop();
  }, 30_000);
});

describe("files kept for outgoing messages count in their task's budget", () => {
  it("a task that cannot take a message's files refuses it, keeping nothing", async () => {
    const { client, transcript } = await openTask();
    const big: OutgoingAttachment = {
      type: "file",
      mimeType: "application/octet-stream",
      fileName: "big.bin",
      // Within the gateway's per-file ceiling, over the task's budget.
      content: "A".repeat(MAX_TASK_RETAINED),
    };
    expect(() => client.sendMessage(KEY, "too much", { attachments: [big] })).toThrow();
    expect(transcript().outbox).toEqual([]);
    expect(client.retainedAttachmentBytes).toBe(0);
    client.stop();
  });
});

describe("a mapped history page is charged to its task (ruling 1)", () => {
  it("counts the page's items in the task's retention and the host's", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({
      messages: Array.from({ length: 200 }, (_, i) => ({
        role: "user",
        content: "x".repeat(2_450),
        __openclaw: { id: `u${i}`, seq: i },
      })),
    });
    const { client, transcript } = await openTask({ gateway });
    const items = JSON.stringify(transcript().items).length;
    expect(transcript().retention.used).toBeGreaterThanOrEqual(items);
    expect(client.ledger.usage().tasks).toBeGreaterThanOrEqual(items);
    client.stop();
  });
});
