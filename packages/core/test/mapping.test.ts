import { describe, expect, it } from "vitest";
import {
  groupTasks,
  isSessionRemoval,
  mapAgents,
  mapHistory,
  mapSessionRow,
  mergeSessionRow,
  plainPreview,
  safeAvatarUrl,
  sessionChangeRow,
  sessionRowsFromList,
} from "../src/mapping.ts";
import { agentsList, chatHistory, sessionsList } from "./fixtures.ts";

describe("mapAgents", () => {
  it("maps identities, puts the default bot first and hides system agents", () => {
    const bots = mapAgents(agentsList);
    expect(bots.map((bot) => bot.id)).toEqual(["main", "otto", "bare"]);
    expect(bots[0]).toMatchObject({ id: "main", name: "Juniper", emoji: "🌿", isDefault: true });
    expect(bots[1]).toEqual({
      id: "otto",
      name: "Otto",
      emoji: "⚙️",
      avatarUrl: "data:image/png;base64,iVBORw0KGgo=",
      theme: "operations",
      model: "scripted/dev-1",
      isDefault: false,
    });
  });

  it("falls back to the agent id and drops avatar URLs it cannot safely render", () => {
    const bare = mapAgents(agentsList).find((bot) => bot.id === "bare");
    expect(bare).toMatchObject({ name: "bare", avatarUrl: null, emoji: null, model: null });
  });

  it("tolerates malformed input", () => {
    expect(mapAgents(null)).toEqual([]);
    expect(mapAgents({ agents: [null, 4, { id: "" }, { name: "no id" }] })).toEqual([]);
  });
});

describe("safeAvatarUrl", () => {
  it("allows image data URIs and https only", () => {
    expect(safeAvatarUrl("data:image/png;base64,AAAA")).not.toBeNull();
    expect(safeAvatarUrl("https://example.com/a.png")).not.toBeNull();
    expect(safeAvatarUrl("http://example.com/a.png")).toBeNull();
    expect(safeAvatarUrl("data:text/html;base64,AAAA")).toBeNull();
    expect(safeAvatarUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("sessions to tasks", () => {
  const rows = sessionRowsFromList(sessionsList);

  it("prefers label, then derived title, then display name", () => {
    const titles = rows.map((row) => mapSessionRow(row)?.title);
    expect(titles).toEqual(["Disk almost full", "Weekly backup check", "heat-pump", undefined]);
  });

  it("derives status from active runs, errors and the stored status", () => {
    const statuses = rows.map((row) => mapSessionRow(row)?.status);
    expect(statuses.slice(0, 3)).toEqual(["done", "running", "failed"]);
  });

  it("takes the bot from the session key when the row has no agentId", () => {
    expect(mapSessionRow(rows[2]!)?.botId).toBe("main");
  });

  it("strips markdown from previews", () => {
    expect(mapSessionRow(rows[0]!)?.preview).toBe("Done. The disk is now at 61%.");
  });

  it("groups by bot, newest first, and skips archived rows", () => {
    const grouped = groupTasks(rows);
    expect(Object.keys(grouped).sort()).toEqual(["main", "otto"]);
    expect(grouped.otto!.map((task) => task.key)).toEqual([
      "agent:otto:backup-check",
      "agent:otto:disk-space",
    ]);
    expect(grouped.main).toHaveLength(1);
  });
});

describe("sessions.changed deltas", () => {
  it("reads the nested row and keeps the event's key and agent", () => {
    const row = sessionChangeRow({
      sessionKey: "agent:otto:disk-space",
      agentId: "otto",
      reason: "send",
      session: { label: "Renamed", hasActiveRun: true },
    });
    expect(row).toEqual({
      label: "Renamed",
      hasActiveRun: true,
      key: "agent:otto:disk-space",
      agentId: "otto",
    });
    expect(mapSessionRow(row!)?.title).toBe("Renamed");
  });

  it("clears a field the nested row leaves out and the flat payload sets to null", () => {
    // As 2026.10.6 sends a task's effort taken away.
    const row = sessionChangeRow({
      sessionKey: "agent:otto:x",
      reason: "patch",
      thinkingLevel: null,
      label: "Kept",
      session: { key: "agent:otto:x", label: "Kept", thinkingDefault: "low" },
    });
    expect(row).toEqual({
      key: "agent:otto:x",
      label: "Kept",
      thinkingDefault: "low",
      thinkingLevel: null,
    });
    const base = { key: "agent:otto:x", thinkingLevel: "high", thinkingDefault: "low" };
    expect(mergeSessionRow(base, row!).thinkingLevel).toBeNull();
  });

  it("falls back to the flat payload on older gateways", () => {
    const row = sessionChangeRow({ sessionKey: "agent:otto:x", status: "done" });
    expect(row).toMatchObject({ key: "agent:otto:x", status: "done" });
  });

  it("merges present fields, clears on null and keeps omitted fields", () => {
    const base = { key: "k", label: "Old", lastMessagePreview: "hi", activeRunIds: ["r1"] };
    const merged = mergeSessionRow(base, { label: null, activeRunIds: [] });
    expect(merged).toEqual({ key: "k", label: null, lastMessagePreview: "hi", activeRunIds: [] });
  });

  it("recognizes removals", () => {
    expect(isSessionRemoval({ sessionKey: "k", reason: "delete" })).toBe(true);
    expect(isSessionRemoval({ sessionKey: "k", reason: "send" })).toBe(false);
  });
});

describe("mapHistory", () => {
  const items = mapHistory(chatHistory.messages);

  it("merges one run's assistant rounds into a single turn", () => {
    expect(items.map((item) => item.role)).toEqual([
      "user",
      "assistant",
      "system",
      "user",
      "assistant",
    ]);
    expect(items[1]!.blocks.map((block) => block.kind)).toEqual(["reasoning", "tool-call", "text"]);
  });

  it("attaches each tool result to its call and pretty-prints arguments", () => {
    const call = items[1]!.blocks[1]!;
    expect(call).toEqual({
      kind: "tool-call",
      callId: "call_1",
      name: "ls",
      argumentsText: '{\n  "path": "."\n}',
      result: { isError: false, text: '"AGENTS.md"\n"notes/"' },
    });
    const failed = items[4]!.blocks[0]!;
    expect(failed).toMatchObject({
      name: "write",
      argumentsText: '{\n  "path": "log.md"\n}',
      result: { isError: true, text: "permission denied" },
    });
  });

  it("renders compaction boundaries as system rows", () => {
    expect(items[2]!.blocks).toEqual([{ kind: "text", text: "Earlier messages were compacted" }]);
  });

  it("reads string and block content for user messages", () => {
    expect(items[0]!.blocks).toEqual([{ kind: "text", text: "The disk is 94% full." }]);
    expect(items[3]!.blocks).toEqual([{ kind: "text", text: "Clear it." }]);
  });

  it("produces unique display keys even when entry ids repeat", () => {
    const repeated = mapHistory([
      { role: "user", content: "a", __openclaw: { id: "same" } },
      { role: "user", content: "b", __openclaw: { id: "same" } },
    ]);
    expect(new Set(repeated.map((item) => item.id)).size).toBe(2);
  });

  it("truncates very long tool output", () => {
    const [item] = mapHistory([
      { role: "assistant", content: [{ type: "toolCall", id: "c", name: "read", arguments: {} }] },
      { role: "toolResult", toolCallId: "c", content: "x".repeat(9000) },
    ]);
    const call = item!.blocks[0]!;
    expect(call.kind === "tool-call" && call.result!.text.length).toBeLessThan(8100);
  });
});

describe("plainPreview", () => {
  it("turns tables, lists and emphasis into one readable line", () => {
    expect(plainPreview("Done **now**.\n\n| Set | Size |\n| --- | ---: |\n| Photos | 1 GB |")).toBe(
      "Done now. · Set · Size · Photos · 1 GB",
    );
    expect(plainPreview("## Saturday\n\n- **8:30** Leave")).toBe("Saturday 8:30 Leave");
    expect(plainPreview("")).toBeNull();
  });
});

describe("a task's requested effort", () => {
  it("is the session row's thinkingLevel, as the gateway names it, and absent without one", () => {
    const row = { key: "agent:otto:disk-space", agentId: "otto", label: "Disk" };
    expect(mapSessionRow({ ...row, thinkingLevel: "high" })?.effort).toBe("high");
    expect(mapSessionRow(row)).not.toHaveProperty("effort");
  });
});
