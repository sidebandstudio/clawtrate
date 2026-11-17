// Everything the host keeps outside its state is named in one registry
// (`owners.ts`) with its bound. These tests reflect over the live client, a
// viewer's bridge session and the waiting files, fail for any map, set or
// array the registry does not name, and drive the client with the inputs that
// grew private owners before (round 5's A8 reproductions) to check each one
// stays within its count and size.

import { describe, expect, it } from "vitest";
import { AttachmentStore } from "../src/attachments.ts";
import { createBridgeSession } from "../src/bridge.ts";
import { worstCase } from "../src/bounds.ts";
import {
  ATTACHMENT_FOREIGN,
  ATTACHMENT_OWNERS,
  CLIENT_FOREIGN,
  CLIENT_OWNERS,
  VIEWER_FOREIGN,
  VIEWER_OWNERS,
  type Owner,
} from "../src/owners.ts";
import { APPROVAL, MAX_ID_CHARS, MAX_RUN_TEXT_CHARS, MAX_UNROUTED } from "../src/state-bounds.ts";
import { agentEvent, grantingGateway, KEY, openTask } from "./client-harness.ts";
import { sleep, until } from "./fake-gateway.ts";

type Found = { path: string; size: number | null };

/** Every map, set, array, weak map and weak set reachable through own properties, by path. */
function collections(root: object, foreign: readonly string[]): Found[] {
  const found: Found[] = [];
  const seen = new Set<object>([root]);
  const walk = (value: object, prefix: string) => {
    for (const name of Reflect.ownKeys(value)) {
      if (typeof name !== "string") continue;
      const path = prefix ? `${prefix}.${name}` : name;
      if (foreign.includes(path)) continue;
      const child = (value as Record<string, unknown>)[name];
      if (child instanceof Map || child instanceof Set) found.push({ path, size: child.size });
      else if (Array.isArray(child)) found.push({ path, size: child.length });
      else if (child instanceof WeakMap || child instanceof WeakSet)
        found.push({ path, size: null });
      else if (child !== null && typeof child === "object" && !seen.has(child)) {
        seen.add(child);
        walk(child, path);
      }
    }
  };
  walk(root, "");
  return found;
}

/** Fails for a collection the registry does not name, or one past its count. */
function expectRegistered(
  root: object,
  owners: Record<string, Owner>,
  foreign: readonly string[],
): Found[] {
  const found = collections(root, foreign);
  const unnamed = found.filter((each) => !(each.path in owners)).map((each) => each.path);
  expect(unnamed, "collections the registry does not name").toEqual([]);
  for (const each of found) {
    const owner = owners[each.path]!;
    if (owner.weak) expect(each.size, each.path).toBeNull();
    else expect(each.size, each.path).toBeLessThanOrEqual(owner.max);
  }
  // Nothing named that no longer exists.
  expect(Object.keys(owners).sort()).toEqual(found.map((each) => each.path).sort());
  return found;
}

const size = (value: unknown) => JSON.stringify(value).length;

describe("the registry of what the host keeps", () => {
  it("names every collection of a client in use, and each is within its count", async () => {
    const gateway = grantingGateway();
    const { client, transcript } = await openTask({ gateway });
    const viewer = createBridgeSession(client);
    try {
      await viewer.apply({ type: "openSession", key: KEY });
      await until(() => transcript().approvalAccess === "ready");
      // Streams, runs, unrouted approvals, outcomes, foreign runs and spawn links.
      gateway.emit("chat", {
        sessionKey: KEY,
        runId: "streaming",
        seq: 1,
        state: "delta",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      });
      gateway.emit("exec.approval.requested", {
        id: "elsewhere",
        request: { sessionKey: "agent:otto:unopened", command: "ls" },
        createdAtMs: 1,
        expiresAtMs: 9e12,
      });
      gateway.emit("exec.approval.resolved", { id: "gone", decision: "deny" });
      gateway.emit(
        "agent",
        agentEvent("other", 1, "lifecycle", { phase: "start" }, "agent:otto:other"),
      );
      gateway.emit("agent", {
        ...agentEvent("helper", 1, "lifecycle", { phase: "start" }, "agent:otto:helper"),
        spawnedBy: KEY,
      });
      client.sendMessage(KEY, "hello");
      await until(() => client.state.unroutedApprovals.length === 1);
      await sleep(50);
      expectRegistered(client, CLIENT_OWNERS, CLIENT_FOREIGN);
      expectRegistered(viewer, VIEWER_OWNERS, VIEWER_FOREIGN);
    } finally {
      viewer.dispose();
      client.stop();
    }
  });

  it("names the waiting files' collections", () => {
    const store = new AttachmentStore({ newId: () => "a" });
    expectRegistered(store, ATTACHMENT_OWNERS, ATTACHMENT_FOREIGN);
  });

  it("fails for a collection added without a bound", async () => {
    const { client } = await openTask();
    try {
      (client as unknown as { added: Map<string, string> }).added = new Map();
      const unnamed = collections(client, CLIENT_FOREIGN).filter(
        (each) => !(each.path in CLIENT_OWNERS),
      );
      expect(unnamed.map((each) => each.path)).toEqual(["added"]);
    } finally {
      client.stop();
    }
  });
});

describe("private owners hold only what is bounded (A8)", () => {
  it("unrouted approvals keep the bounded card, not the one received", async () => {
    const { client, gateway, transcript } = await openTask();
    try {
      await until(() => transcript().approvalAccess === "ready");
      for (let i = 0; i < 16; i += 1) {
        gateway.emit("exec.approval.requested", {
          id: `u${i}`,
          request: { sessionKey: "agent:otto:unopened", command: `${i}:${"x".repeat(2_100_000)}` },
          createdAtMs: 1,
          expiresAtMs: 9e12,
        });
      }
      await until(() => client.state.unroutedApprovals.length === 16);
      const held = [...(client as unknown as { unrouted: Map<string, unknown> }).unrouted.values()];
      expect(size(held)).toBeLessThanOrEqual(MAX_UNROUTED * (worstCase(APPROVAL) + 1) + 2);
      // The very objects the state shows: nothing whole is kept beside them.
      expect(held).toEqual(client.state.unroutedApprovals);
      held.forEach((card, i) => expect(card).toBe(client.state.unroutedApprovals[i]));
    } finally {
      client.stop();
    }
  }, 30_000);

  it("stream baselines have a count per task and leave with their runs", async () => {
    const { client, gateway, transcript } = await openTask();
    const streams = () => (client as unknown as { streams: { size: number } }).streams.size;
    try {
      for (let i = 0; i < 100; i += 1) {
        gateway.emit("chat", {
          sessionKey: KEY,
          runId: `baseline-${i}`,
          seq: 1,
          state: "delta",
          message: { role: "assistant", content: [{ type: "text", text: "a".repeat(1000) }] },
        });
      }
      await until(() => transcript().runs.length === 32);
      expect(streams()).toBeLessThanOrEqual(2);
      // A run's lifecycle end, on the agent stream, retires its text.
      gateway.emit("agent", agentEvent("baseline-99", 2, "lifecycle", { phase: "end" }));
      await until(
        () => transcript().runs.find((run) => run.id === "baseline-99")?.state !== "running",
      );
      expect(streams()).toBeLessThanOrEqual(1);
    } finally {
      client.stop();
    }
  });

  it("a short reply cannot keep a large message beside it", async () => {
    const { client, gateway } = await openTask();
    const runs = () => [
      ...(client as unknown as { streams: { runs: Map<string, unknown> } }).streams.runs.values(),
    ];
    try {
      gateway.emit("chat", {
        sessionKey: KEY,
        runId: "extra",
        seq: 1,
        state: "delta",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            { type: "image", data: "y".repeat(1_000_000) },
          ],
          extra: "x".repeat(1_000_000),
        },
      });
      await until(() => runs().length === 1);
      expect(size(runs()[0])).toBeLessThanOrEqual(3 * MAX_ID_CHARS + MAX_RUN_TEXT_CHARS + 64);
      expect(runs()[0]).toMatchObject({ text: "ok" });
    } finally {
      client.stop();
    }
  });

  it("an appended delta builds on the text kept, and a resync starts again", async () => {
    const gateway = grantingGateway();
    const { client, transcript } = await openTask({ gateway });
    try {
      const delta = (seq: number, extra: Record<string, unknown>) =>
        gateway.emit("chat", { sessionKey: KEY, runId: "appended", seq, state: "delta", ...extra });
      delta(1, { message: { role: "assistant", content: [{ type: "text", text: "Hel" }] } });
      delta(2, { deltaText: "lo" });
      await until(() => transcript().runs[0]?.text === "Hello");
      delta(3, { deltaText: "!", replace: true });
      await until(() => transcript().runs[0]?.text === "!");
    } finally {
      client.stop();
    }
  });

  it("session pages are bounded as they arrive, not after they accumulate", async () => {
    const gateway = grantingGateway();
    let pages = 0;
    const page = (offset: number) => {
      pages += 1;
      return {
        sessions: Array.from({ length: 200 }, (_, i) => ({
          key: `agent:otto:page-${offset + i}`,
          agentId: "otto",
          updatedAt: offset + i,
          derivedTitle: "t".repeat(100_000),
          unrelated: "u".repeat(100_000),
        })),
        hasMore: offset < 2_000,
        nextOffset: offset + 200,
      };
    };
    gateway.handlers["sessions.subscribe"] = () => ({ list: page(0) });
    gateway.handlers["sessions.list"] = (params) => page((params as { offset: number }).offset);
    const { client } = await openTask({ gateway });
    try {
      expect(pages).toBeGreaterThan(5);
      const rows = (client as unknown as { rows: Map<string, Record<string, unknown>> }).rows;
      expect(rows.size).toBeLessThanOrEqual(CLIENT_OWNERS.rows!.max);
      for (const row of rows.values()) {
        expect(row.unrelated).toBeUndefined();
        expect(size(row)).toBeLessThanOrEqual(CLIENT_OWNERS.rows!.each);
      }
      // The newest are kept.
      expect(rows.has("agent:otto:page-2199")).toBe(true);
    } finally {
      client.stop();
    }
  }, 30_000);

  it("keys of the client's maps pass the id cap", async () => {
    const { client, gateway, transcript } = await openTask();
    try {
      await until(() => transcript().approvalAccess === "ready");
      const long = `agent:otto:${"k".repeat(5_000)}`;
      gateway.emit("agent", {
        ...agentEvent("far", 1, "lifecycle", { phase: "start" }, long),
        spawnedBy: long + "x",
      });
      gateway.emit("exec.approval.resolved", { id: "i".repeat(5_000), decision: "deny" });
      await sleep(50);
      const keysOf = (name: string) => [
        ...(client as unknown as Record<string, Map<string, unknown>>)[name]!.keys(),
      ];
      for (const name of ["foreign", "spawnedBy", "approvalOutcomes"]) {
        for (const key of keysOf(name))
          expect(JSON.stringify(key).length).toBeLessThanOrEqual(MAX_ID_CHARS);
      }
      for (const value of (
        client as unknown as { spawnedBy: Map<string, string> }
      ).spawnedBy.values())
        expect(JSON.stringify(value).length).toBeLessThanOrEqual(MAX_ID_CHARS);
      expect(() => client.openSession(long)).toThrow("too long");
    } finally {
      client.stop();
    }
  });
});
