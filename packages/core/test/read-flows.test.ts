// Parity rows that the core decides for a read-only connection: what a task
// row carries, how live changes land, and what a transcript shows.
import { describe, expect, it } from "vitest";
import { ClawtrateClient } from "../src/client.ts";
import { mapHistory, mapSessionRow } from "../src/mapping.ts";
import { FakeGateway, memoryStorage, testHost, until } from "./fake-gateway.ts";

const URL = "ws://127.0.0.1:19001";
const FAST = { reconnect: { initialMs: 20, maxMs: 40 } };

/** A session row trimmed from what OpenClaw 2026.10.6's `sessions.list` returns. */
const row = {
  key: "agent:otto:disk-space",
  agentId: "otto",
  label: "Disk almost full on the media box",
  lastMessagePreview: "Done. The disk is now at **61%**.",
  updatedAt: 1_794_893_561_735,
  lastActivityAt: 1_794_893_561_700,
  status: "done",
  unread: true,
  totalTokens: 18_432,
  totalTokensFresh: true,
  contextTokens: 128_000,
};

async function connected(gateway: FakeGateway) {
  const client = new ClawtrateClient(testHost(gateway, memoryStorage()), FAST);
  await client.start();
  await client.connect({ url: URL, token: "bootstrap" });
  await until(() => client.state.discovery.status === "ready");
  return client;
}

describe("task rows", () => {
  it("F-059: carry context use as tokens used out of the context window, or nothing when either is missing", () => {
    expect(mapSessionRow(row)?.context).toEqual({ used: 18_432, window: 128_000, fresh: true });
    expect(mapSessionRow({ ...row, totalTokensFresh: false })?.context?.fresh).toBe(false);
    expect(mapSessionRow({ ...row, totalTokens: undefined })?.context).toBeUndefined();
    expect(mapSessionRow({ ...row, contextTokens: undefined })?.context).toBeUndefined();
    expect(mapSessionRow({ ...row, contextTokens: 0 })?.context).toBeUndefined();
  });

  it("F-017 F-425: carry the latest activity time from the row's updatedAt, then lastActivityAt", () => {
    expect(mapSessionRow(row)?.updatedAt).toBe(row.updatedAt);
    expect(mapSessionRow({ ...row, updatedAt: null })?.updatedAt).toBe(row.lastActivityAt);
  });

  it("F-017 F-059: a sessions.changed delta updates the preview, the time and the context use", async () => {
    const gateway = new FakeGateway();
    gateway.handlers["sessions.subscribe"] = () => ({
      subscribed: true,
      list: { sessions: [row], hasMore: false },
    });
    const client = await connected(gateway);
    expect(client.state.tasksByBot.otto?.[0]).toMatchObject({
      preview: "Done. The disk is now at 61%.",
      context: { used: 18_432 },
    });
    gateway.emit("sessions.changed", {
      sessionKey: row.key,
      session: {
        key: row.key,
        lastMessagePreview: "The disk is at 58% now.",
        updatedAt: row.updatedAt + 60_000,
        totalTokens: 19_100,
      },
    });
    await until(() => client.state.tasksByBot.otto?.[0]?.preview === "The disk is at 58% now.");
    expect(client.state.tasksByBot.otto?.[0]).toMatchObject({
      updatedAt: row.updatedAt + 60_000,
      context: { used: 19_100, window: 128_000 },
    });
    client.stop();
  });
});

describe("transcripts", () => {
  it("F-088: a bot that narrates between tool calls gets one bubble for each thing it says", () => {
    // One run, as chat.history returns it: text and a tool call in one
    // message, the tool's result, then the next round.
    const items = mapHistory([
      { role: "user", content: "Plan my week.", timestamp: 1, __openclaw: { id: "u" } },
      {
        role: "assistant",
        content: [
          { type: "text", text: "On it. Checking your calendar first." },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "calendar.md" } },
        ],
        timestamp: 2,
        __openclaw: { id: "a1", runId: "r" },
      },
      { role: "toolResult", toolCallId: "c1", content: "Mon: dentist", __openclaw: { runId: "r" } },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading Thursday now, the table is next." },
          { type: "toolCall", id: "c2", name: "read", arguments: { path: "thursday.md" } },
        ],
        timestamp: 3,
        __openclaw: { id: "a2", runId: "r" },
      },
      { role: "toolResult", toolCallId: "c2", content: "free", __openclaw: { runId: "r" } },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here is the week." }],
        timestamp: 4,
        __openclaw: { id: "a3", runId: "r" },
      },
    ]);
    expect(items).toHaveLength(2);
    expect(items[1]!.blocks.map((block) => block.kind)).toEqual([
      "text",
      "tool-call",
      "text",
      "tool-call",
      "text",
    ]);
    expect(items[1]!.blocks.filter((b) => b.kind === "text").map((b) => b.text)).toEqual([
      "On it. Checking your calendar first.",
      "Reading Thursday now, the table is next.",
      "Here is the week.",
    ]);
  });

  it("F-063: each message keeps its own time, from the message or else its record", () => {
    const items = mapHistory([
      { role: "user", content: "a", timestamp: 1_000, __openclaw: { id: "1" } },
      { role: "assistant", content: "b", __openclaw: { id: "2", recordTimestampMs: 2_000 } },
    ]);
    expect(items.map((item) => item.timestamp)).toEqual([1_000, 2_000]);
  });

  it("F-323: a client opened while a run is in progress shows the run's text and its running state", async () => {
    const gateway = new FakeGateway();
    gateway.handlers["sessions.subscribe"] = () => ({
      subscribed: true,
      list: { sessions: [{ ...row, status: "running", hasActiveRun: true }], hasMore: false },
    });
    gateway.handlers["chat.history"] = () => ({
      messages: [{ role: "user", content: "Rotate the logs.", timestamp: 1 }],
      hasMore: false,
      inFlightRun: { runId: "run-7", text: "Rack-1 is done. Rotating rack-2 now." },
    });
    // A new client, as after quitting and reopening the app.
    const client = await connected(gateway);
    expect(client.state.tasksByBot.otto?.[0]?.status).toBe("running");
    client.openSession(row.key);
    await until(() => client.state.transcripts[row.key]?.status === "ready");
    expect(client.state.transcripts[row.key]?.live).toEqual({
      runId: "run-7",
      text: "Rack-1 is done. Rotating rack-2 now.",
    });
    client.stop();
  });
});
