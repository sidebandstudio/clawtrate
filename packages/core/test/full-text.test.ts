// Values cut to their bound keep nothing more, and are read whole on demand.
// A cut approval offers only deny until its whole text was read and shown; a
// cut question option is answered with its whole label.

import { describe, expect, it } from "vitest";
import { createBridgeSession } from "../src/bridge.ts";
import {
  MAX_COMMAND_CHARS,
  MAX_OPTION_CHARS,
  MAX_STEP_BODY_CHARS,
  MAX_BLOCK_CHARS,
} from "../src/state-bounds.ts";
import { agentEvent, grantingGateway, KEY, openTask, questionRecord } from "./client-harness.ts";
import { until } from "./fake-gateway.ts";

const longCommand = `echo ${"x".repeat(MAX_COMMAND_CHARS * 3)}`;

function execItem(id: string, command: string) {
  return {
    id,
    request: {
      command,
      host: "gateway",
      agentId: "otto",
      sessionKey: KEY,
      runId: "run-1",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    createdAtMs: 2_000,
    expiresAtMs: 9_000_000_000_000,
  };
}

describe("an approval whose command was cut", () => {
  it("offers only deny until its whole text has been read", async () => {
    const gateway = grantingGateway();
    let listed = [execItem("ap-long", longCommand)];
    gateway.handlers["exec.approval.list"] = () => listed;
    gateway.handlers["exec.approval.resolve"] = () => ({ ok: true });
    const { client, transcript } = await openTask({ gateway });
    const viewer = createBridgeSession(client);
    try {
      await viewer.apply({ type: "openSession", key: KEY });
      await until(() => transcript().approvals.length === 1);
      const card = transcript().approvals[0]!;
      // Kept cut, and marked so.
      expect(JSON.stringify(card.exec!.command).length).toBeLessThanOrEqual(MAX_COMMAND_CHARS);
      expect(card.cut).toContain("exec.command");
      // Allowing it unseen is refused, through the client and the bridge alike.
      await expect(client.resolveApproval(KEY, "ap-long", "allow-once")).rejects.toThrow(
        "read it whole",
      );
      await expect(
        viewer.apply({
          type: "resolveApproval",
          key: KEY,
          approvalId: "ap-long",
          decision: "allow-once",
          expiresInDays: null,
          shownDigest: "not-the-digest",
        }),
      ).rejects.toThrow("read it whole");
      expect(gateway.calls("exec.approval.resolve")).toEqual([]);
      // Read whole: the full command, and the digest an allow must name. Nothing more is kept.
      const read = await viewer.apply({
        type: "readApprovalText",
        key: KEY,
        approvalId: "ap-long",
      });
      expect(read.text.command).toBe(longCommand);
      expect(read.digest).toBe(card.decisionDigest);
      expect(transcript().approvals[0]!.exec!.command).toBe(card.exec!.command);
      await viewer.apply({
        type: "resolveApproval",
        key: KEY,
        approvalId: "ap-long",
        decision: "allow-once",
        expiresInDays: null,
        shownDigest: read.digest,
      });
      expect(gateway.calls("exec.approval.resolve")).toEqual([
        { id: "ap-long", decision: "allow-once" },
      ]);
      // A changed approval under the same id is not read as the one shown.
      listed = [execItem("ap-long", `${longCommand} && rm -rf build`)];
      gateway.emit("exec.approval.requested", execItem("ap-other", longCommand));
      await until(() => transcript().approvals.length === 2);
      listed = [execItem("ap-other", `${longCommand}; true`)];
      await expect(client.readApprovalText(KEY, "ap-other")).rejects.toThrow("changed");
    } finally {
      viewer.dispose();
      client.stop();
    }
  });

  it("can still be denied unseen", async () => {
    const gateway = grantingGateway();
    gateway.handlers["exec.approval.list"] = () => [execItem("ap-long", longCommand)];
    gateway.handlers["exec.approval.resolve"] = () => ({ ok: true });
    const { client, transcript } = await openTask({ gateway });
    try {
      await until(() => transcript().approvals.length === 1);
      await client.resolveApproval(KEY, "ap-long", "deny");
      expect(gateway.calls("exec.approval.resolve")).toEqual([{ id: "ap-long", decision: "deny" }]);
    } finally {
      client.stop();
    }
  });

  it("is allowed as before when nothing was cut", async () => {
    const gateway = grantingGateway();
    gateway.handlers["exec.approval.list"] = () => [execItem("ap-short", "uname -s")];
    gateway.handlers["exec.approval.resolve"] = () => ({ ok: true });
    const { client, transcript } = await openTask({ gateway });
    try {
      await until(() => transcript().approvals.length === 1);
      expect(transcript().approvals[0]!.cut).toBeUndefined();
      await client.resolveApproval(KEY, "ap-short", "allow-once");
      expect(gateway.calls("exec.approval.resolve")).toHaveLength(1);
    } finally {
      client.stop();
    }
  });
});

describe("a question option cut to its bound", () => {
  it("is answered by its original place with its whole label", async () => {
    const gateway = grantingGateway();
    const long = `Blue ${"b".repeat(MAX_OPTION_CHARS * 2)}`;
    const record = questionRecord("ask-long", "run-q");
    record.questions[0]!.options = [{ label: long }, { label: "Red" }];
    gateway.handlers["question.list"] = () => ({ questions: [record] });
    gateway.handlers["question.resolve"] = () => ({ status: "answered" });
    const { client, transcript } = await openTask({ gateway });
    try {
      gateway.emit("agent", agentEvent("run-q", 1, "lifecycle", { phase: "start" }));
      gateway.emit("question.requested", record);
      await until(() => transcript().questions.length === 1);
      const option = transcript().questions[0]!.questions[0]!.options[0]!;
      expect(option.label.length).toBeLessThan(long.length);
      expect(option.index).toBe(0);
      await client.answerQuestion(KEY, "ask-long", { color: [{ option: 0 }] });
      const [params] = gateway.calls("question.resolve") as Array<{
        answers: { answers: Record<string, string[]> };
      }>;
      expect(params!.answers.answers.color).toEqual([long]);
    } finally {
      client.stop();
    }
  });

  it("sends the option the user chose when options were dropped and their labels share a cut prefix (D4)", async () => {
    const gateway = grantingGateway();
    const record = questionRecord("opts", "r");
    const prefix = "same".repeat(140);
    record.questions[0]!.options = Array.from({ length: 9 }, (_, i) => ({
      label: `${prefix}-${i}`,
    }));
    gateway.handlers["question.list"] = () => ({ questions: [record] });
    gateway.handlers["question.resolve"] = () => ({ status: "answered" });
    const { client, transcript } = await openTask({ gateway });
    try {
      gateway.emit("agent", agentEvent("r", 1, "lifecycle", { phase: "start" }));
      gateway.emit("question.requested", record);
      await until(() => transcript().questions.length === 1);
      const item = transcript().questions[0]!.questions[0]!;
      // Each option keeps its original place; the card says how many were not shown.
      expect(item.options.map((each) => each.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(item.optionsOmitted).toBe(1);
      // Every shown label is the same cut prefix.
      expect(new Set(item.options.map((each) => each.label)).size).toBe(1);
      await expect(client.answerQuestion(KEY, "opts", { color: [{ option: 8 }] })).rejects.toThrow(
        /no such option/,
      );
      await client.answerQuestion(KEY, "opts", { color: [{ option: 1 }] });
      const answer = (
        gateway.calls("question.resolve")[0] as { answers: { answers: Record<string, string[]> } }
      ).answers.answers.color;
      expect(answer).toEqual([record.questions[0]!.options[1]!.label]);
    } finally {
      client.stop();
    }
  });

  it("is sent as the gateway's own value when the option has one", async () => {
    const gateway = grantingGateway();
    const record = questionRecord("valued", "r");
    record.questions[0]!.options = [
      { label: "Blue", value: "colour-blue" },
      { label: "Blue", value: "colour-navy" },
    ] as never;
    gateway.handlers["question.list"] = () => ({ questions: [record] });
    gateway.handlers["question.resolve"] = () => ({ status: "answered" });
    const { client, transcript } = await openTask({ gateway });
    try {
      gateway.emit("agent", agentEvent("r", 1, "lifecycle", { phase: "start" }));
      gateway.emit("question.requested", record);
      await until(() => transcript().questions.length === 1);
      const lists = gateway.calls("question.list").length;
      await client.answerQuestion(KEY, "valued", { color: [{ option: 1 }] });
      // The option is read at its place, and sent by the gateway's own identity for it.
      expect(gateway.calls("question.list")).toHaveLength(lists + 1);
      const answer = (
        gateway.calls("question.resolve")[0] as { answers: { answers: Record<string, string[]> } }
      ).answers.answers.color;
      expect(answer).toEqual(["colour-navy"]);
    } finally {
      client.stop();
    }
  });
});

describe("history text cut to its bound", () => {
  it("is read whole on demand, and the kept item stays cut", async () => {
    const gateway = grantingGateway();
    const long = "h".repeat(MAX_BLOCK_CHARS * 4);
    gateway.handlers["chat.history"] = () => ({
      messages: [{ role: "user", content: long, __openclaw: { id: "u1", seq: 1 } }],
      hasMore: false,
    });
    const { client, transcript } = await openTask({ gateway });
    try {
      const item = transcript().items[0]!;
      expect(JSON.stringify(item).length).toBeLessThan(long.length);
      expect(item.cut?.length).toBeGreaterThan(0);
      const whole = await client.readHistoryItem(KEY, item.id);
      expect(JSON.stringify(whole)).toContain(long);
      expect(transcript().items[0]).toEqual(item);
    } finally {
      client.stop();
    }
  });
});

describe("a step's text", () => {
  it("is cut to its bound with the cut marked, and its raw payload read whole", async () => {
    const { client, gateway, transcript } = await openTask();
    try {
      const output = "o".repeat(MAX_STEP_BODY_CHARS * 8);
      gateway.emit(
        "agent",
        agentEvent("run-s", 1, "tool", {
          phase: "start",
          toolCallId: "c1",
          name: "exec",
          args: {},
        }),
      );
      gateway.emit(
        "agent",
        agentEvent("run-s", 2, "tool", {
          phase: "result",
          toolCallId: "c1",
          name: "exec",
          result: { content: [{ type: "text", text: output }] },
        }),
      );
      await until(() => transcript().runs[0]?.steps[0]?.status === "done");
      const step = transcript().runs[0]!.steps[0]!;
      expect(JSON.stringify(step.result!.text).length).toBeLessThanOrEqual(MAX_STEP_BODY_CHARS);
      expect(step.result!.totalChars).toBe(output.length);
      expect(JSON.stringify(client.stepRaw(KEY, step.id))).toContain(output);
    } finally {
      client.stop();
    }
  });
});

describe("a step whose text is too long for the raw table", () => {
  it("is marked cut at once, reads as not available yet, then whole once history holds it", async () => {
    const gateway = grantingGateway();
    const { client, transcript } = await openTask({ gateway });
    const viewer = createBridgeSession(client);
    try {
      await viewer.apply({ type: "openSession", key: KEY });
      const whole = "r".repeat(300_000);
      gateway.emit("agent", agentEvent("large", 1, "thinking", { text: whole }));
      gateway.emit("agent", agentEvent("large", 2, "thinking", { text: "second" }));
      await until(() => transcript().runs[0]?.steps.length === 2);
      const first = transcript().runs[0]!.steps[0]!;
      expect(first.output!.totalChars).toBe(whole.length);
      // Flagged at the first cut, whichever cap made it.
      expect(first.cut).toContain("output.text");
      // Too long for the raw table, and not yet in history: said so, never null.
      expect(client.stepRaw(KEY, first.id)).toBeNull();
      expect(await viewer.apply({ type: "readStepRaw", key: KEY, stepId: first.id })).toEqual({
        status: "not-available-yet",
        reason: expect.any(String),
      });
      // Once the run is in history, its whole text is read from there, and nothing is kept.
      gateway.handlers["chat.history"] = () => ({
        messages: [
          { role: "user", content: "think", __openclaw: { id: "u1", seq: 1 } },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: whole },
              { type: "thinking", thinking: "second" },
              { type: "text", text: "done" },
            ],
            stopReason: "stop",
            __openclaw: { id: "a1", seq: 2, runId: "large" },
          },
        ],
      });
      const read = await viewer.apply({ type: "readStepRaw", key: KEY, stepId: first.id });
      expect(read?.status).toBe("available");
      expect((read as { raw: { call: { thinking: string } } }).raw.call.thinking).toBe(whole);
      expect(client.stepRaw(KEY, first.id)).toBeNull();
      // A step the task does not have is null.
      expect(await viewer.apply({ type: "readStepRaw", key: KEY, stepId: "tool:none" })).toBeNull();
    } finally {
      viewer.dispose();
      client.stop();
    }
  });
});

describe("an approval whose decision text was cut cannot be allowed unseen", () => {
  it("stays deny-only when later cuts push the command out of the diagnostic cut list", async () => {
    const gateway = grantingGateway();
    gateway.handlers["exec.approval.resolve"] = () => ({ ok: true });
    const { client, transcript } = await openTask({ gateway });
    try {
      await until(() => transcript().approvalAccess === "ready");
      gateway.emit("exec.approval.requested", {
        id: "many-cuts",
        request: {
          sessionKey: KEY,
          command: "x".repeat(10_000),
          host: "h".repeat(1000),
          nodeId: "n".repeat(2000),
          security: "s".repeat(1000),
          ask: "a".repeat(1000),
          resolvedPath: "p".repeat(3000),
          warningText: "w".repeat(3000),
          systemRunPlan: {
            argv: ["z".repeat(3000)],
            cwd: null,
            commandText: "plan",
            agentId: null,
            sessionKey: KEY,
          },
          allowedDecisions: ["allow-once", "deny"],
        },
        createdAtMs: 1,
        expiresAtMs: 9e12,
      });
      await until(() => transcript().approvals.length === 1);
      const card = transcript().approvals[0]!;
      await expect(client.resolveApproval(KEY, card.id, "allow-once")).rejects.toThrow(
        /too long to show in full/,
      );
      // The diagnostic list lost the command's entry to later cuts; the flag did not.
      expect(card.cut).not.toContain("exec.command");
      expect(card.decisionCut).toBe(true);
      await expect(
        client.resolveApproval(KEY, card.id, "allow-once", { shownDigest: card.decisionDigest }),
      ).rejects.toThrow(/too long to show in full/);
      expect(gateway.calls("exec.approval.resolve")).toHaveLength(0);
      // Deny always works.
      await client.resolveApproval(KEY, card.id, "deny");
      expect(gateway.calls("exec.approval.resolve")).toEqual([
        { id: "many-cuts", decision: "deny" },
      ]);
    } finally {
      client.stop();
    }
  });

  it("is allowed only by the viewer the host gave the whole text to, never by echoing the state's digest", async () => {
    const gateway = grantingGateway();
    const item = execItem("echo", "c".repeat(10_000));
    gateway.handlers["exec.approval.list"] = () => [item];
    gateway.handlers["exec.approval.resolve"] = () => ({ ok: true });
    const { client, transcript } = await openTask({ gateway });
    const reader = createBridgeSession(client);
    const other = createBridgeSession(client);
    try {
      await reader.apply({ type: "openSession", key: KEY });
      await other.apply({ type: "openSession", key: KEY });
      await until(() => transcript().approvals.length === 1);
      const card = transcript().approvals[0]!;
      const allow = (viewer: typeof reader, shownDigest: string | null) =>
        viewer.apply({
          type: "resolveApproval",
          key: KEY,
          approvalId: "echo",
          decision: "allow-once",
          expiresInDays: null,
          shownDigest,
        });
      // The digest is in every snapshot; naming it without a read proves nothing.
      const reads = gateway.calls("exec.approval.list").length;
      await expect(allow(reader, card.decisionDigest)).rejects.toThrow(/too long to show in full/);
      await expect(
        client.resolveApproval(KEY, "echo", "allow-once", { shownDigest: card.decisionDigest }),
      ).rejects.toThrow(/too long to show in full/);
      expect(gateway.calls("exec.approval.list")).toHaveLength(reads);
      expect(gateway.calls("exec.approval.resolve")).toHaveLength(0);
      // One viewer reads it whole; another viewer's allow is still refused.
      const read = await reader.apply({ type: "readApprovalText", key: KEY, approvalId: "echo" });
      expect(read.text.command).toBe(item.request.command);
      await expect(allow(other, read.digest)).rejects.toThrow(/too long to show in full/);
      await expect(allow(reader, "another-digest")).rejects.toThrow(/too long to show in full/);
      expect(gateway.calls("exec.approval.resolve")).toHaveLength(0);
      await allow(reader, read.digest);
      expect(gateway.calls("exec.approval.resolve")).toEqual([
        { id: "echo", decision: "allow-once" },
      ]);
    } finally {
      reader.dispose();
      other.dispose();
      client.stop();
    }
  });

  it("is not recorded as read when the viewer's channel cannot carry the whole text", async () => {
    const gateway = grantingGateway();
    gateway.handlers["exec.approval.list"] = () => [execItem("huge", "h".repeat(400_000))];
    gateway.handlers["exec.approval.resolve"] = () => ({ ok: true });
    const { client, transcript } = await openTask({ gateway });
    const viewer = createBridgeSession(client, { maxResultChars: 262_144 });
    try {
      await viewer.apply({ type: "openSession", key: KEY });
      await until(() => transcript().approvals.length === 1);
      const digest = transcript().approvals[0]!.decisionDigest;
      await expect(
        viewer.apply({ type: "readApprovalText", key: KEY, approvalId: "huge" }),
      ).rejects.toThrow(/too long to show here/);
      await expect(
        viewer.apply({
          type: "resolveApproval",
          key: KEY,
          approvalId: "huge",
          decision: "allow-once",
          expiresInDays: null,
          shownDigest: digest,
        }),
      ).rejects.toThrow(/too long to show in full/);
      expect(gateway.calls("exec.approval.resolve")).toHaveLength(0);
    } finally {
      viewer.dispose();
      client.stop();
    }
  });
});

/**
 * `chat.history` as the gateway projects it (OpenClaw 2026.10.6,
 * `truncateChatHistoryText`): each text cut to `maxChars`, 8,000 when not
 * given, with "\n...(truncated)..." appended and the row flagged
 * `__openclaw.truncated` with reason `display-cap`.
 */
function displayProjected(rows: Array<Record<string, unknown>>, maxChars: number | undefined) {
  const limit = maxChars ?? 8_000;
  const cut = (text: string) =>
    text.length <= limit
      ? { text, cut: false }
      : { text: `${text.slice(0, limit)}\n...(truncated)...`, cut: true };
  return rows.map((row) => {
    let truncated = false;
    const content = Array.isArray(row.content)
      ? (row.content as Array<Record<string, unknown>>).map((block) => {
          for (const field of ["thinking", "text"]) {
            if (typeof block[field] === "string") {
              const projected = cut(block[field] as string);
              truncated ||= projected.cut;
              return { ...block, [field]: projected.text };
            }
          }
          return block;
        })
      : row.content;
    const meta = row.__openclaw as Record<string, unknown>;
    return {
      ...row,
      content,
      __openclaw: truncated ? { ...meta, truncated: true, reason: "display-cap" } : meta,
    };
  });
}

describe("a whole read from history (C2)", () => {
  const thinkingRun = (thinking: string) => [
    { role: "user", content: "think", __openclaw: { id: "u1", seq: 1 } },
    {
      role: "assistant",
      content: [{ type: "thinking", thinking }],
      stopReason: "stop",
      __openclaw: { id: "a1", seq: 2, runId: "large" },
    },
  ];

  it("asks for the length the step needs, so the gateway's preview is not taken for the whole text", async () => {
    const gateway = grantingGateway();
    const { client, transcript } = await openTask({ gateway });
    try {
      const whole = "r".repeat(300_000);
      gateway.emit("agent", agentEvent("large", 1, "thinking", { text: whole }));
      await until(() => transcript().runs[0]?.steps.length === 1);
      const step = transcript().runs[0]!.steps[0]!;
      gateway.handlers["chat.history"] = (params) => ({
        messages: displayProjected(thinkingRun(whole), (params as { maxChars?: number }).maxChars),
      });
      const read = await client.readStepRaw(KEY, step.id);
      const asked = gateway.calls("chat.history").at(-1) as { maxChars?: number };
      expect(asked.maxChars).toBeGreaterThanOrEqual(whole.length);
      expect(read?.status).toBe("available");
      expect((read as { raw: { call: { thinking: string } } }).raw.call.thinking).toBe(whole);
    } finally {
      client.stop();
    }
  });

  it("says the gateway cut it, with what came and its length, when even the longest read is cut", async () => {
    const gateway = grantingGateway();
    const { client, transcript } = await openTask({ gateway });
    try {
      const whole = "s".repeat(600_000);
      gateway.emit("agent", agentEvent("large", 1, "thinking", { text: whole }));
      await until(() => transcript().runs[0]?.steps.length === 1);
      const step = transcript().runs[0]!.steps[0]!;
      gateway.handlers["chat.history"] = (params) => ({
        messages: displayProjected(thinkingRun(whole), (params as { maxChars?: number }).maxChars),
      });
      const read = await client.readStepRaw(KEY, step.id);
      expect(read).toMatchObject({ status: "cut-by-gateway", reason: expect.any(String) });
      const cut = read as { raw: { call: { thinking: string } }; receivedChars: number };
      expect(cut.raw.call.thinking.length).toBe(cut.receivedChars);
      expect(cut.receivedChars).toBeLessThan(whole.length);
      expect(whole.startsWith(cut.raw.call.thinking.slice(0, 500_000))).toBe(true);
    } finally {
      client.stop();
    }
  });

  it("marks a reasoning step read from a cut row, and does not offer the kept preview as whole", async () => {
    const gateway = grantingGateway();
    const whole = "t".repeat(20_000);
    gateway.handlers["chat.history"] = (params) => ({
      messages: displayProjected(thinkingRun(whole), (params as { maxChars?: number }).maxChars),
    });
    const { client, transcript } = await openTask({ gateway });
    try {
      const step = transcript().runs[0]!.steps.find((each) => each.kind === "reasoning")!;
      // The ordinary history read takes the gateway's default; the step says it was cut.
      expect(step.truncated).toBe(true);
      expect(step.output!.totalChars).toBeLessThan(whole.length);
      const read = await client.readStepRaw(KEY, step.id);
      expect((gateway.calls("chat.history").at(-1) as { maxChars?: number }).maxChars).toBe(
        500_000,
      );
      expect(read?.status).toBe("available");
      expect((read as { raw: { call: { thinking: string } } }).raw.call.thinking).toBe(whole);
    } finally {
      client.stop();
    }
  });

  it("reads a history item at the longest length and says when the gateway still cut it", async () => {
    const gateway = grantingGateway();
    const rows = [
      {
        role: "user",
        content: [{ type: "text", text: "u".repeat(700_000) }],
        __openclaw: { id: "u1", seq: 1 },
      },
    ];
    gateway.handlers["chat.history"] = (params) => ({
      messages: displayProjected(rows, (params as { maxChars?: number }).maxChars),
    });
    const { client, transcript } = await openTask({ gateway });
    try {
      const item = transcript().items[0]!;
      expect(item.truncated).toBe(true);
      const whole = await client.readHistoryItem(KEY, item.id);
      expect((gateway.calls("chat.history").at(-1) as { maxChars?: number }).maxChars).toBe(
        500_000,
      );
      expect(whole?.truncated).toBe(true);
    } finally {
      client.stop();
    }
  });
});
