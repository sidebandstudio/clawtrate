// A task let go keeps its settled approval cards, so the task read again from
// history shows each where it was, linked to its action, with the request and
// what settled it: the gateway's lists hold only pending requests and its
// history keeps no approval record (F-091, F-165).

import { describe, expect, it } from "vitest";
import { agentEvent, grantingGateway, KEY, openTask } from "./client-harness.ts";
import { sleep, until } from "./fake-gateway.ts";

const request = (id: string) => ({
  id,
  request: {
    command: "sleep 2",
    host: "gateway",
    agentId: "otto",
    sessionKey: KEY,
    runId: "run-1",
    toolCallId: "call_s",
    allowedDecisions: ["allow-once", "allow-always", "deny"],
  },
  createdAtMs: 1,
  expiresAtMs: 9_000_000_000_000,
});

/** History as the gateway keeps it: the call and its result, no approval record. */
const history = {
  sessionKey: KEY,
  messages: [
    { role: "user", content: [{ type: "text", text: "#sleep 2" }], __openclaw: { id: "u1" } },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_s",
          name: "exec",
          arguments: { command: "sleep 2", workdir: "." },
        },
      ],
      __openclaw: { id: "a1", runId: "run-1" },
    },
    {
      role: "toolResult",
      toolCallId: "call_s",
      toolName: "exec",
      content: [{ type: "text", text: "(no output)" }],
      details: { status: "completed", exitCode: 0 },
      isError: false,
      __openclaw: { id: "t1", runId: "run-1" },
    },
  ],
};

describe("F-091 F-165: settled approvals across a task's release", () => {
  it("a task opened again shows its settled approval as it ended, linked to its action, with the request and its resolution", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["chat.history"] = () => history;
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    gateway.emit("exec.approval.requested", request("ap-1"));
    await until(() => transcript().approvals.length === 1);
    gateway.emit("exec.approval.resolved", {
      id: "ap-1",
      decision: "allow-once",
      resolvedBy: "Clawtrate",
      request: request("ap-1").request,
    });
    await until(() => transcript().approvals[0]!.status === "allowed");
    const before = transcript().approvals[0]!;

    client.closeSession(KEY);
    expect(client.state.transcripts[KEY]).toBeUndefined();
    client.openSession(KEY);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    const again = transcript().approvals;
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({
      id: "ap-1",
      status: "allowed",
      decision: "allow-once",
      toolCallId: "call_s",
      stepId: "tool:call_s",
    });
    // What Raw shows: the request as received and the event that settled it.
    expect(again[0]!.raw).toEqual(before.raw);
    expect(again[0]!.settledBy.map((each) => each.via)).toEqual(["exec.approval.resolved"]);
    // The action is in history's run, once.
    const steps = transcript().runs.flatMap((run) => run.steps.filter((s) => s.kind === "tool"));
    expect(steps.map((s) => s.id)).toEqual(["tool:call_s"]);
    client.stop();
  });

  it("a pending approval is not kept: the gateway's list gives it back, still answerable", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["exec.approval.list"] = () => [request("ap-2")];
    gateway.emit("exec.approval.requested", request("ap-2"));
    await until(() => transcript().approvals.length === 1);
    client.closeSession(KEY);
    gateway.handlers["exec.approval.list"] = () => [];
    client.openSession(KEY);
    await until(() => client.state.transcripts[KEY]?.approvalAccess === "ready");
    expect(transcript().approvals.filter((card) => card.status === "pending")).toEqual([]);
    client.stop();
  });
  it("the gateway's outcome read back while the task is let go reaches its kept card, with who decided and the read in Raw", async () => {
    const gateway = grantingGateway();
    let complete!: (value: unknown) => void;
    gateway.handlers["approval.get"] = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    const { client, transcript } = await openTask({ gateway });
    try {
      const held = request("ap-late");
      gateway.emit("exec.approval.requested", held);
      await until(() => transcript().approvals[0]?.status === "pending");
      // The exec event says only deny: the card is closed until approval.get says how.
      gateway.emit("exec.approval.resolved", {
        id: held.id,
        decision: "deny",
        ts: 2000,
        request: held.request,
      });
      await until(() => transcript().approvals[0]?.status === "closed" && !!complete);
      client.closeSession(KEY);
      complete({
        approval: {
          id: held.id,
          status: "denied",
          decision: "deny",
          reason: "user",
          resolvedAtMs: 2000,
          presentation: { kind: "exec" },
          resolver: { kind: "runtime", id: "Other reviewer" },
        },
      });
      await sleep(50);
      client.openSession(KEY);
      await until(() => client.state.transcripts[KEY]?.approvalAccess === "ready");
      expect(transcript().approvals[0]).toMatchObject({
        status: "denied",
        outcomeUnknown: false,
        resolver: { kind: "runtime", id: "Other reviewer" },
      });
      expect(transcript().approvals[0]!.settledBy.map((each) => each.via)).toContain(
        "approval.get",
      );
    } finally {
      client.stop();
    }
  });

  it("a task the gateway deletes keeps no settled card, whether it was let go before or after", async () => {
    for (const order of ["closed first", "deleted first"] as const) {
      const { client, gateway, transcript } = await openTask();
      gateway.handlers["chat.history"] = () => history;
      gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
      gateway.emit("exec.approval.requested", request("ap-1"));
      await until(() => transcript().approvals.length === 1);
      gateway.emit("exec.approval.resolved", {
        id: "ap-1",
        decision: "allow-once",
        resolvedBy: "Clawtrate",
        request: request("ap-1").request,
      });
      await until(() => transcript().approvals[0]!.status === "allowed");
      if (order === "closed first") client.closeSession(KEY);
      gateway.emit("sessions.changed", { sessionKey: KEY, reason: "delete" });
      await sleep(30);
      if (order === "deleted first") client.closeSession(KEY);
      client.openSession(KEY);
      await until(() => client.state.transcripts[KEY]?.status === "ready");
      expect(transcript().approvals, order).toEqual([]);
      client.stop();
    }
  });
});
