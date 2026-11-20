// The scripted T3 Code stand-in, on its own: the seven tools' shapes as the
// installed T3 Code build returns them (provider-accounts-and-t3-code.md, B.2
// and B.6), without a gateway.

import { describe, expect, it } from "vitest";
import {
  createT3Code,
  DECOY_TOOL,
  MAX_CHARS_PER_ITEM,
  SEEDED_THREAD,
  TOOLS,
} from "../src/t3-code-mcp.ts";

type Rec = Record<string, unknown>;
const structured = (result: { structuredContent?: Rec }) => result.structuredContent ?? {};

describe("the scripted T3 Code stand-in", () => {
  it("offers the seven tools under their real names, and one ordinary tool beside them", () => {
    expect(TOOLS.map((tool) => tool.name).sort()).toEqual(
      [
        "t3_project_list",
        "t3_thread_launch",
        "t3_thread_send",
        "t3_thread_read",
        "t3_thread_wait",
        "t3_thread_list",
        "t3_thread_interrupt",
        DECOY_TOOL,
      ].sort(),
    );
  });

  it("launches a thread with an MCP id and its first run; an idle launch has no run", async () => {
    const t3 = createT3Code(() => 0);
    const launched = structured(
      await t3.callTool("t3_thread_launch", {
        projectId: "proj-backup-scripts",
        title: "x",
        message: "Go.",
      }),
    );
    expect(launched.threadId).toMatch(/^mcp:[0-9a-f-]{36}$/);
    expect([launched.status, typeof launched.runId]).toEqual(["running", "string"]);
    const idle = structured(
      await t3.callTool("t3_thread_launch", { projectId: "proj-backup-scripts", title: "y" }),
    );
    expect([idle.runId, idle.status]).toEqual([null, null]);
    const noTarget = await t3.callTool("t3_thread_launch", { title: "z" });
    expect([noTarget.isError, structured(noTarget).code]).toEqual([true, "target_required"]);
    const noModel = await t3.callTool("t3_thread_launch", {
      projectId: "proj-scratchpad",
      title: "z",
    });
    expect(structured(noModel).code).toBe("invalid_request");
    t3.close();
  });

  it("pages a read and cuts a long item's text, which itemId and textOffset read on", async () => {
    const t3 = createT3Code(() => 0);
    const { threadId } = structured(
      await t3.callTool("t3_thread_launch", {
        projectId: "proj-backup-scripts",
        title: "x",
        message: "a long report",
      }),
    );
    await t3.callTool("t3_thread_wait", { threadId });
    const read = structured(await t3.callTool("t3_thread_read", { threadId }));
    const items = read.items as Rec[];
    expect(read.hasMore).toBe(false);
    const reply = items.at(-1)!;
    expect([reply.type, reply.textTruncated, reply.nextTextOffset]).toEqual([
      "assistant_message",
      true,
      MAX_CHARS_PER_ITEM,
    ]);
    const rest = structured(
      await t3.callTool("t3_thread_read", {
        threadId,
        itemId: reply.itemId,
        textOffset: reply.nextTextOffset,
      }),
    );
    expect((rest.items as Rec[])[0]!.textTruncated).toBe(false);
    const page = structured(
      await t3.callTool("t3_thread_read", { threadId: SEEDED_THREAD, limit: 2 }),
    );
    expect([page.hasMore, (page.items as unknown[]).length]).toEqual([true, 2]);
    t3.close();
  });

  it("sends in each mode, refuses a steer on an idle thread, and stops a running run", async () => {
    const t3 = createT3Code(() => 0);
    const steer = await t3.callTool("t3_thread_send", {
      threadId: SEEDED_THREAD,
      message: "x",
      mode: "steer",
    });
    expect([steer.isError, structured(steer).code]).toEqual([true, "thread_not_sendable"]);
    const started = structured(
      await t3.callTool("t3_thread_send", { threadId: SEEDED_THREAD, message: "x" }),
    );
    expect(started.delivery).toBe("started");
    const steered = structured(
      await t3.callTool("t3_thread_send", { threadId: SEEDED_THREAD, message: "y" }),
    );
    expect(steered.delivery).toBe("steered");
    const queued = structured(
      await t3.callTool("t3_thread_send", { threadId: SEEDED_THREAD, message: "z", mode: "queue" }),
    );
    expect(queued.delivery).toBe("queued");
    const stop = structured(
      await t3.callTool("t3_thread_interrupt", { threadId: SEEDED_THREAD, stop: true }),
    );
    expect(stop.status).toBe("interrupt_requested");
    const again = structured(await t3.callTool("t3_thread_interrupt", { threadId: SEEDED_THREAD }));
    expect(again.status).toBe("no_active_run");
    t3.close();
  });

  it("refuses what it does not support rather than ignore it", async () => {
    const t3 = createT3Code(() => 0);
    for (const args of [{ environmentId: "e" }, { attachments: [] }, { interactionMode: "plan" }]) {
      const out = await t3.callTool("t3_thread_list", { allProjects: true, ...args });
      expect([out.isError, structured(out).code]).toEqual([true, "invalid_request"]);
    }
    t3.close();
  });

  it("refuses the listing's filter and paging rather than list what they would leave out", async () => {
    const t3 = createT3Code(() => 0);
    for (const args of [{ statuses: ["running"] }, { limit: 1 }, { cursor: 1 }]) {
      const out = await t3.callTool("t3_thread_list", { allProjects: true, ...args });
      expect([out.isError, structured(out).code]).toEqual([true, "invalid_request"]);
    }
    const all = await t3.callTool("t3_thread_list", { allProjects: true });
    expect(all.isError).not.toBe(true);
    t3.close();
  });

  it("keeps the model a thread was launched with: its read and the listing report it", async () => {
    const t3 = createT3Code(() => 0);
    const launched = structured(
      await t3.callTool("t3_thread_launch", { projectId: "proj-trail-guide", title: "x" }),
    );
    expect((launched.modelSelection as Rec).instanceId).toBe("claude");
    const read = structured(await t3.callTool("t3_thread_read", { threadId: launched.threadId }));
    expect((read.thread as Rec).providerInstanceId).toBe("claude");
    const listed = structured(await t3.callTool("t3_thread_list", { allProjects: true }));
    const byId = (id: unknown) =>
      (listed.threads as Rec[]).find((each) => each.threadId === id)!.providerInstanceId;
    expect(byId(launched.threadId)).toBe("claude");
    expect(byId(SEEDED_THREAD)).toBe("codex");
    t3.close();
  });

  it("interrupts only the run its runId names; stop: true interrupts whatever runs", async () => {
    const t3 = createT3Code(() => 0);
    const { threadId, runId: first } = structured(
      await t3.callTool("t3_thread_launch", {
        projectId: "proj-backup-scripts",
        title: "x",
        message: "Go.",
      }),
    );
    // The first run ends; a second runs.
    await t3.callTool("t3_thread_wait", { threadId, timeoutMs: 30_000 });
    const sent = structured(await t3.callTool("t3_thread_send", { threadId, message: "Again." }));
    const old = structured(await t3.callTool("t3_thread_interrupt", { threadId, runId: first }));
    expect([old.runId, old.status]).toEqual([first, "completed"]);
    const missing = await t3.callTool("t3_thread_interrupt", { threadId, runId: "run-none" });
    expect(structured(missing).code).toBe("run_not_found");
    const named = structured(
      await t3.callTool("t3_thread_interrupt", { threadId, runId: sent.runId }),
    );
    expect([named.runId, named.status]).toEqual([sent.runId, "interrupt_requested"]);
    const stopped = structured(
      await t3.callTool("t3_thread_interrupt", { threadId, runId: first, stop: true }),
    );
    expect(stopped.status).toBe("no_active_run");
    t3.close();
  });
});
