// The engine keeps, bounded, the records the gateway sent that settled an
// approval or a question, as it sent them, and the parameters this client
// sent (conversation.md sections 9, 12 and 13: Raw shows them). Nothing is
// made up: where no record arrived, none is kept.
import { describe, expect, it } from "vitest";
import { enforce, worstCase } from "../src/bounds.ts";
import {
  APPROVAL,
  APPROVAL_OUTCOME,
  MAX_RECORD_CHARS,
  MAX_SENT_DECISIONS,
  QUESTION,
} from "../src/state-bounds.ts";
import { grantingGateway, KEY, openTask, questionRecord } from "./client-harness.ts";
import { GatewayError, until } from "./fake-gateway.ts";

const FAR = 9_000_000_000_000;
const execItem = (id: string) => ({
  id,
  request: {
    command: "uname -s",
    host: "gateway",
    agentId: "otto",
    sessionKey: KEY,
    runId: "run-1",
    allowedDecisions: ["allow-once", "allow-always", "deny"],
  },
  createdAtMs: 1,
  expiresAtMs: FAR,
});

describe("settling records and what was sent", () => {
  it("keeps an exec decision as sent, the gateway's reply and its resolved event, each as sent", async () => {
    const gateway = grantingGateway();
    gateway.handlers["exec.approval.list"] = () => [execItem("ap-1")];
    gateway.handlers["exec.approval.resolve"] = () => ({ ok: true });
    const { client, transcript } = await openTask({ gateway });
    try {
      await until(() => transcript().approvals.length === 1);
      expect(transcript().approvals[0]).toMatchObject({ sent: [], settledBy: [] });
      await client.resolveApproval(KEY, "ap-1", "allow-always", { expiresInDays: 30 });
      const event = {
        id: "ap-1",
        decision: "allow-always",
        resolvedBy: "Pip's laptop",
        ts: 5_000,
        request: execItem("ap-1").request,
      };
      gateway.emit("exec.approval.resolved", event);
      await until(() => transcript().approvals[0]!.settledBy.length === 2);
      expect(transcript().approvals[0]).toMatchObject({
        status: "allowed",
        sent: [
          {
            method: "exec.approval.resolve",
            params: { id: "ap-1", decision: "allow-always", grantExpiresInDays: 30 },
          },
        ],
        settledBy: [
          { via: "exec.approval.resolve", record: { ok: true } },
          { via: "exec.approval.resolved", record: event },
        ],
      });
      // The same event again replaces, not repeats, its record.
      gateway.emit("exec.approval.resolved", event);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(transcript().approvals[0]!.settledBy).toHaveLength(2);
    } finally {
      client.stop();
    }
  });

  it("keeps a settled event that arrived for a request this client did not decide, and sent nothing", async () => {
    const gateway = grantingGateway();
    gateway.handlers["exec.approval.list"] = () => [execItem("ap-2")];
    const { client, transcript } = await openTask({ gateway });
    try {
      await until(() => transcript().approvals.length === 1);
      const event = { id: "ap-2", decision: "deny", ts: 6_000, request: execItem("ap-2").request };
      gateway.emit("exec.approval.resolved", event);
      await until(() => transcript().approvals[0]!.status !== "pending");
      expect(transcript().approvals[0]).toMatchObject({
        sent: [],
        settledBy: [{ via: "exec.approval.resolved", record: event }],
      });
    } finally {
      client.stop();
    }
  });

  it("keeps the generic method's reply, {applied, approval}, as the gateway sent it", async () => {
    const gateway = grantingGateway();
    gateway.handlers["openclaw.approval.list"] = () => [
      {
        id: "sa-1",
        request: {
          title: "Change a setting",
          description: "Turn on the nightly report",
          agentId: "otto",
          sessionKey: KEY,
          allowedDecisions: ["allow-once", "deny"],
        },
        createdAtMs: 1,
        expiresAtMs: FAR,
      },
    ];
    const reply = {
      applied: false,
      approval: {
        id: "sa-1",
        status: "denied",
        decision: "deny",
        reason: "user",
        createdAtMs: 1,
        expiresAtMs: FAR,
        resolvedAtMs: 7_000,
        presentation: { kind: "system-agent", title: "Change a setting" },
        source: { agentId: "otto", sessionKey: KEY },
      },
    };
    gateway.handlers["approval.resolve"] = () => reply;
    const { client, transcript } = await openTask({ gateway });
    try {
      await until(() => transcript().approvals.length === 1);
      await client.resolveApproval(KEY, "sa-1", "allow-once");
      expect(transcript().approvals[0]).toMatchObject({
        status: "denied",
        sent: [
          {
            method: "approval.resolve",
            params: { id: "sa-1", kind: "system-agent", decision: "allow-once" },
          },
        ],
        settledBy: [{ via: "approval.resolve", record: reply }],
      });
    } finally {
      client.stop();
    }
  });

  it("keeps a read-back that found the request settled, and both decisions sent", async () => {
    const gateway = grantingGateway();
    gateway.handlers["exec.approval.list"] = () => [execItem("ap-3")];
    gateway.handlers["exec.approval.resolve"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "approval resolve unavailable" });
    };
    const snapshot = {
      approval: {
        id: "ap-3",
        status: "allowed",
        decision: "allow-once",
        reason: "user",
        createdAtMs: 1,
        expiresAtMs: FAR,
        resolvedAtMs: 8_000,
        presentation: { kind: "exec", commandText: "uname -s" },
      },
    };
    let reads = 0;
    gateway.handlers["approval.get"] = () =>
      ++reads === 1
        ? {
            approval: {
              ...snapshot.approval,
              status: "pending",
              decision: undefined,
              resolvedAtMs: undefined,
            },
          }
        : snapshot;
    const { client, transcript } = await openTask({ gateway });
    try {
      await until(() => transcript().approvals.length === 1);
      await client.resolveApproval(KEY, "ap-3", "allow-once").catch(() => undefined);
      await until(() => transcript().approvals[0]!.decisionError === null);
      await client.resolveApproval(KEY, "ap-3", "allow-once").catch(() => undefined);
      await until(() => transcript().approvals[0]!.status === "allowed");
      expect(transcript().approvals[0]).toMatchObject({
        sent: [
          { method: "exec.approval.resolve", params: { id: "ap-3", decision: "allow-once" } },
          { method: "exec.approval.resolve", params: { id: "ap-3", decision: "allow-once" } },
        ],
        settledBy: [{ via: "approval.get", record: snapshot }],
      });
    } finally {
      client.stop();
    }
  });

  it("keeps a question's answer as sent, the reply and the question.resolved event", async () => {
    const { client, gateway, transcript } = await openTask();
    const reply = { status: "answered", answers: { answers: { color: ["Blue"] } } };
    gateway.handlers["question.resolve"] = () => reply;
    gateway.emit("question.requested", questionRecord("ask_1", "run-1"));
    await until(() => transcript().questions.length === 1);
    expect(transcript().questions[0]).toMatchObject({ sent: null, settledBy: [] });
    await client.answerQuestion(KEY, "ask_1", { color: ["Blue"] });
    const event = { id: "ask_1", status: "answered", answers: { answers: { color: ["Blue"] } } };
    gateway.emit("question.resolved", event);
    await until(() => transcript().questions[0]!.settledBy.length === 2);
    expect(transcript().questions[0]).toMatchObject({
      status: "answered",
      sent: {
        method: "question.resolve",
        params: { id: "ask_1", answers: { answers: { color: ["Blue"] } } },
      },
      settledBy: [
        { via: "question.resolve", record: reply },
        { via: "question.resolved", record: event },
      ],
    });
    client.stop();
  });

  it("keeps a dismissal as sent, and nothing made up when only the event arrives", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["question.resolve"] = () => ({ status: "cancelled" });
    gateway.emit("question.requested", questionRecord("ask_2", "run-1"));
    gateway.emit("question.requested", questionRecord("ask_3", "run-1"));
    await until(() => transcript().questions.length === 2);
    await client.dismissQuestion(KEY, "ask_2");
    gateway.emit("question.resolved", { id: "ask_3", status: "expired" });
    await until(() => transcript().questions[1]!.status === "expired");
    expect(transcript().questions[0]).toMatchObject({
      sent: { method: "question.resolve", params: { id: "ask_2", cancel: true } },
      settledBy: [{ via: "question.resolve", record: { status: "cancelled" } }],
    });
    expect(transcript().questions[1]).toMatchObject({
      sent: null,
      settledBy: [{ via: "question.resolved", record: { id: "ask_3", status: "expired" } }],
    });
    client.stop();
  });

  it("are bounded: records are cut to their bound, and only the newest decisions sent are kept", () => {
    const big = { id: "ap-9", note: "x".repeat(10 * MAX_RECORD_CHARS) };
    const card = enforce(APPROVAL, {
      id: "ap-9",
      settledBy: [{ via: "exec.approval.resolved", record: big }],
      sent: Array.from({ length: MAX_SENT_DECISIONS + 3 }, (_, i) => ({
        method: "exec.approval.resolve",
        params: { id: "ap-9", decision: "deny", n: i },
      })),
    } as never) as unknown as {
      settledBy: Array<{ record: unknown }>;
      sent: Array<{ params: { n: number } }>;
    };
    expect(JSON.stringify(card.settledBy[0]!.record ?? null).length).toBeLessThanOrEqual(
      MAX_RECORD_CHARS,
    );
    expect(card.sent.map((each) => each.params.n)).toEqual([3, 4, 5, 6]);
    // Every kept record is in the worst cases the documented totals are built from.
    for (const bound of [APPROVAL, APPROVAL_OUTCOME, QUESTION]) {
      expect(worstCase(bound)).toBeGreaterThan(3 * MAX_RECORD_CHARS);
    }
  });
});
