// Exec and plugin resolutions read `deny` whether a reviewer denied the
// approval or the gateway cancelled it when its run was stopped (OpenClaw
// 2026.10.6 `cancelMatchingApprovals` publishes a cancellation as
// `{decision: "deny"}` with no terminal status). Such an approval shows closed
// with its cause unknown until its own snapshot says how it ended (C1).

import { describe, expect, it } from "vitest";
import { agentEvent, grantingGateway, KEY, openTask } from "./client-harness.ts";
import { GatewayError, deferred, sleep, until } from "./fake-gateway.ts";

const kinds = [
  {
    kind: "exec",
    requested: "exec.approval.requested",
    resolved: "exec.approval.resolved",
    item: {
      id: "ap-1",
      request: {
        command: "rm -rf cache",
        sessionKey: KEY,
        runId: "run-1",
        toolCallId: "call_1",
        allowedDecisions: ["allow-once", "deny"],
      },
      createdAtMs: 1,
      expiresAtMs: 9_000_000_000_000,
    },
    presentation: {
      kind: "exec",
      commandText: "rm -rf cache",
      allowedDecisions: ["allow-once", "deny"],
    },
  },
  {
    kind: "plugin",
    requested: "plugin.approval.requested",
    resolved: "plugin.approval.resolved",
    item: {
      id: "ap-1",
      request: { title: "Post", description: "Post it", sessionKey: KEY, runId: "run-1" },
      createdAtMs: 1,
      expiresAtMs: 9_000_000_000_000,
    },
    presentation: {
      kind: "plugin",
      title: "Post",
      description: "Post it",
      severity: "warning",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
  },
] as const;

/** `publishAppliedApprovalResolution` for an exec or plugin record: `{id, decision, resolvedBy, ts, request}`. */
const published = (item: (typeof kinds)[number]["item"], resolvedBy: string | null) => ({
  id: item.id,
  decision: "deny",
  resolvedBy,
  ts: 3_000,
  request: item.request,
});

const snapshot = (
  presentation: (typeof kinds)[number]["presentation"],
  fields: Record<string, unknown>,
) => ({
  approval: {
    id: "ap-1",
    urlPath: "/approve/ap-1",
    createdAtMs: 1,
    expiresAtMs: 9_000_000_000_000,
    resolvedAtMs: 3_000,
    presentation,
    ...fields,
  },
});

for (const source of kinds) {
  describe(`${source.kind} approvals settled by the gateway (C1)`, () => {
    async function pendingApproval() {
      const gateway = grantingGateway();
      gateway.handlers["chat.history"] = () => ({ messages: [], inFlightRun: { runId: "run-1" } });
      const opened = await openTask({ gateway });
      await until(() => opened.transcript().approvalAccess === "ready");
      gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
      gateway.emit(source.requested, source.item);
      await until(() => opened.transcript().approvals.length === 1);
      return opened;
    }

    it("a run stopped and its approval cancelled shows cancelled, never denied", async () => {
      const { client, gateway, transcript } = await pendingApproval();
      const lookup = deferred<unknown>();
      gateway.handlers["approval.get"] = () => lookup.promise;
      await client.stopRun(KEY, "run-1");
      // The cancellation as the gateway publishes it.
      gateway.emit(source.resolved, published(source.item, null));
      await until(() => transcript().approvals[0]!.status !== "pending");
      expect(transcript().approvals[0]).toMatchObject({
        status: "closed",
        decision: null,
        outcomeUnknown: true,
        reason: "settled-cause-unknown",
      });
      expect(gateway.calls("approval.get")).toEqual([{ id: "ap-1" }]);
      lookup.resolve(
        snapshot(source.presentation, {
          status: "cancelled",
          reason: "run-aborted",
          resolver: { kind: "system" },
          source: { sessionKey: KEY },
        }),
      );
      await until(() => transcript().approvals[0]!.status === "cancelled");
      expect(transcript().approvals[0]).toMatchObject({
        status: "cancelled",
        reason: "run-aborted",
        decision: null,
        outcomeUnknown: false,
        resolver: { kind: "system", id: null },
      });
      client.stop();
    });

    it("when the snapshot cannot be read, it stays closed with its cause unknown", async () => {
      const { client, gateway, transcript } = await pendingApproval();
      gateway.handlers["approval.get"] = () => {
        throw new GatewayError({ code: "INVALID_REQUEST", message: "approval not found" });
      };
      gateway.emit(source.resolved, published(source.item, null));
      await until(() => gateway.calls("approval.get").length === 1);
      await sleep(30);
      expect(transcript().approvals[0]).toMatchObject({
        status: "closed",
        outcomeUnknown: true,
        decision: null,
      });
      client.stop();
    });

    it("a reviewer's genuine denial shows denied once the snapshot says so", async () => {
      const { client, gateway, transcript } = await pendingApproval();
      gateway.handlers["approval.get"] = () =>
        snapshot(source.presentation, {
          status: "denied",
          decision: "deny",
          reason: "user",
          resolver: { kind: "device", id: "device-9" },
        });
      gateway.emit(source.resolved, published(source.item, "Ops laptop"));
      await until(() => transcript().approvals[0]!.status === "denied");
      expect(transcript().approvals[0]).toMatchObject({
        decision: "deny",
        reason: "user",
        resolvedBy: "Ops laptop",
        resolver: { kind: "device", id: "device-9" },
        outcomeUnknown: false,
      });
      client.stop();
    });

    it("this client's own denial shows denied at once, and the later publication does not change it", async () => {
      const { client, gateway, transcript } = await pendingApproval();
      gateway.handlers[`${source.kind}.approval.resolve`] = () => ({ ok: true });
      await client.resolveApproval(KEY, "ap-1", "deny");
      expect(transcript().approvals[0]).toMatchObject({ status: "denied", decision: "deny" });
      gateway.emit(source.resolved, published(source.item, "Clawtrate Test"));
      await sleep(30);
      expect(transcript().approvals[0]).toMatchObject({ status: "denied", outcomeUnknown: false });
      expect(gateway.calls("approval.get")).toEqual([]);
      client.stop();
    });
  });
}
