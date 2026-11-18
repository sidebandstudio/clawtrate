import {
  callFromBlock,
  emptyActivity,
  foldLineOf,
  initialState,
  lineOf,
  type Bot,
  type ClawtrateState,
  type Task,
  type Transcript,
  type TranscriptBlock,
  type TranscriptItem,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { homeModel, taskRows } from "../src/lists.ts";
import { back, connectView, current, HOME, inShell, keptMismatch } from "../src/navigation.ts";
import { chatRows } from "../src/transcript.ts";

const NOW = new Date(2026, 10, 18, 9, 30).getTime();

function bot(id: string, extra: Partial<Bot> = {}): Bot {
  return {
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    emoji: null,
    avatarUrl: null,
    theme: null,
    model: null,
    isDefault: false,
    ...extra,
  };
}

function task(key: string, updatedAt: number | null, extra: Partial<Task> = {}): Task {
  const botId = key.split(":")[1]!;
  return {
    key,
    botId,
    sessionId: null,
    title: key.split(":")[2]!,
    preview: null,
    updatedAt,
    status: "idle",
    unread: false,
    ...extra,
  };
}

function state(extra: Partial<ClawtrateState> = {}): ClawtrateState {
  return {
    ...initialState,
    connection: {
      ...initialState.connection,
      status: "connected",
      gatewayUrl: "ws://127.0.0.1:19201",
    },
    discovery: { status: "ready", error: null, partial: false },
    ...extra,
  };
}

describe("the iPhone app's screens", () => {
  it("F-003: opens Home as soon as the bots have loaded, before their tasks, and shows the steps until then", () => {
    const loading = state({ discovery: { status: "loading", error: null, partial: false } });
    expect(inShell(loading, null)).toBe(false);
    expect(connectView(loading, null, true)).toBe("setup");
    const withBots = { ...loading, bots: [bot("otto")] };
    expect(inShell(withBots, null)).toBe(true);
    // Until its tasks arrive the row says so.
    expect(homeModel(withBots, {}, NOW).rows[0]!.preview).toBe("Loading tasks");
  });

  it("chooses the welcome screen first, then the address, the steps, the pairing and the protocol notice", () => {
    const idle = { ...initialState };
    expect(connectView(idle, null, false)).toBe("welcome");
    expect(connectView(idle, null, true)).toBe("address");
    const connecting = state({
      connection: {
        ...initialState.connection,
        status: "connecting",
        gatewayUrl: "ws://127.0.0.1:1",
      },
    });
    expect(connectView(connecting, null, true)).toBe("setup");
    const failed = state({
      connection: {
        ...initialState.connection,
        status: "error",
        gatewayUrl: "ws://127.0.0.1:1",
        error: { code: "UNREACHABLE", message: "x", hint: null },
      },
    });
    expect(connectView(failed, null, false)).toBe("address");
    const pairing = state({
      connection: {
        ...initialState.connection,
        status: "pairing",
        gatewayUrl: "ws://127.0.0.1:1",
        pairing: {
          requestId: "r",
          deviceId: "d",
          message: "",
          approveCommand: "c",
          approveNote: null,
          requestedScopes: ["operator.read"],
        },
      },
    });
    expect(connectView(pairing, null, true)).toBe("pairing");
    const mismatch = {
      code: "PROTOCOL_MISMATCH",
      message: "m",
      hint: null,
      protocol: { gateway: 5, client: 4 },
    };
    // A mismatch stays while Retry repeats the handshake, and goes once a pairing starts.
    expect(
      keptMismatch({ ...failed, connection: { ...failed.connection, error: mismatch } }, null),
    ).toBe(mismatch);
    expect(keptMismatch(connecting, mismatch)).toBe(mismatch);
    expect(keptMismatch(pairing, mismatch)).toBeNull();
    expect(connectView(connecting, mismatch, true)).toBe("protocol");
    expect(inShell(state({ bots: [bot("otto")] }), mismatch)).toBe(false);
  });

  it("F-427: Back goes from a task's chat to its bot's task list, and from there to Home", () => {
    const chat = { name: "task", botId: "otto", key: "agent:otto:a" } as const;
    expect(back(chat)).toEqual({ name: "bot", botId: "otto" });
    expect(back(back(chat))).toEqual(HOME);
    // A bot or task the gateway no longer lists falls back to what is there.
    const s = state({ bots: [bot("otto")], tasksByBot: { otto: [task("agent:otto:b", 1)] } });
    expect(current(chat, s)).toEqual({ name: "bot", botId: "otto" });
    expect(current({ name: "bot", botId: "pip" }, s)).toEqual(HOME);
    expect(current(chat, { ...s, tasksByBot: { otto: [task("agent:otto:a", 1)] } })).toEqual(chat);
  });

  it("lists pinned bots first, then the rest by their latest activity, without hidden bots, in the rail's words", () => {
    const bots = [
      bot("main", { name: "Juniper", isDefault: true, theme: "research" }),
      bot("otto"),
      bot("pip"),
      bot("marlow"),
    ];
    const s = state({
      bots,
      tasksByBot: {
        main: [task("agent:main:a", NOW - 3 * 86_400_000, { preview: "A summary of the week" })],
        otto: [
          task("agent:otto:disk", NOW - 60_000, { status: "running" }),
          task("agent:otto:old", NOW - 86_400_000, { unread: true }),
        ],
        pip: [task("agent:pip:plan", NOW - 120_000, { preview: "Saturday's route" })],
        marlow: [],
      },
      sidebar: {
        status: "ok",
        prefs: { pins: ["pip"], sections: [], hidden: ["marlow"], order: [] },
      },
    });
    const model = homeModel(s, {}, NOW);
    expect(model.pinned.map((row) => row.bot.id)).toEqual(["pip"]);
    expect(model.rows.map((row) => row.bot.id)).toEqual(["otto", "main"]);
    const [otto, juniper] = model.rows;
    expect(otto).toMatchObject({ time: "now", state: "working", unread: true, preview: "disk" });
    expect(otto!.spoken).toBe("Otto, working, 2 tasks, unread");
    expect(juniper).toMatchObject({
      label: "research",
      primary: true,
      preview: "A summary of the week",
      unread: false,
    });
    expect(juniper!.spoken).toBe("Juniper, 1 task, research, primary bot");
    // Read on this device, the dot goes.
    expect(homeModel(s, { "agent:otto:old": NOW - 86_400_000 }, NOW).rows[0]!.unread).toBe(false);
  });

  it("gives each task row its title, time and one mark, newest first as the engine orders them", () => {
    const rows = taskRows(
      [
        task("agent:otto:disk", NOW - 60_000, { status: "running" }),
        task("agent:otto:old", new Date(2026, 10, 9).getTime(), { unread: true }),
        task("agent:otto:none", null),
      ],
      {},
      NOW,
    );
    expect(rows.map((row) => [row.title, row.time, row.state, row.unread])).toEqual([
      ["disk", "now", "working", false],
      ["old", "Nov 9", null, true],
      ["none", "", null, false],
    ]);
    expect(rows[0]!.spoken).toBe("disk, working");
    expect(rows[1]!.spoken).toBe("old, unread");
  });
});

function transcript(items: TranscriptItem[]): Transcript {
  return {
    ...emptyActivity,
    linkedRuns: {},
    interSession: [],
    mcpTools: {},
    sessionKey: "agent:otto:disk",
    status: "ready",
    items,
    error: null,
    hasMore: false,
    live: null,
    loadedAt: 1,
  };
}

const read = (id: string, path: string): Extract<TranscriptBlock, { kind: "tool-call" }> => ({
  kind: "tool-call",
  callId: id,
  name: "read",
  argumentsText: JSON.stringify({ path }),
  result: { isError: false, text: `contents of ${path}` },
});

describe("the iPhone chat's rows", () => {
  const at = new Date(2026, 10, 18, 9, 0).getTime();
  const items: TranscriptItem[] = [
    {
      id: "u1",
      role: "user",
      timestamp: at,
      blocks: [{ kind: "text", text: "What is eating the space?" }],
      model: null,
    },
    {
      id: "a1",
      role: "assistant",
      timestamp: at + 60_000,
      model: null,
      blocks: [
        { kind: "reasoning", text: "Look at the files first." },
        read("c1", "AGENTS.md"),
        { kind: "text", text: "On it: the **media** folder." },
        read("c2", "notes/a.md"),
        read("c3", "notes/b.md"),
        { kind: "text", text: "Done." },
      ],
    },
    {
      id: "s1",
      role: "system",
      timestamp: at + 30 * 60_000,
      blocks: [{ kind: "text", text: "Session reset" }],
      model: null,
    },
  ];

  it("puts stamps before the first message and after ten quiet minutes, bubbles in order, and each action as a line in the engine's words", () => {
    const rows = chatRows(task("agent:otto:disk", at), transcript(items), "Otto", NOW, true);
    expect(rows.map((row) => row.kind)).toEqual([
      "stamp",
      "user",
      "action",
      "bot",
      "action",
      "bot",
      "stamp",
      "event",
    ]);
    expect(rows[0]).toMatchObject({
      kind: "stamp",
      text: expect.stringMatching(/^Today 9:00\sAM$/),
    });
    expect(rows[1]).toMatchObject({ text: "What is eating the space?" });
    // One read is one line; two reads in a row share one, as the desktop folds them.
    const ctx = {};
    expect(rows[2]).toMatchObject({
      kind: "action",
      text: lineOf(callFromBlock(read("c1", "AGENTS.md"), undefined, undefined), ctx).title,
    });
    expect(rows[2]!.kind === "action" && rows[2]!.text).toContain("AGENTS.md");
    expect(rows[4]).toMatchObject({
      kind: "action",
      text: foldLineOf(
        [read("c2", "notes/a.md"), read("c3", "notes/b.md")].map((b) =>
          callFromBlock(b, undefined, undefined),
        ),
        ctx,
      ).title,
    });
    expect(rows[3]).toMatchObject({ kind: "bot", text: "On it: the **media** folder." });
    expect(rows[7]).toMatchObject({ kind: "event", text: "Session reset" });
    // Reasoning stays folded away.
    expect(JSON.stringify(rows)).not.toContain("Look at the files first.");
  });

  it("says a task runs while the gateway reports it running, and says nothing of it once it ends", () => {
    const running = chatRows(
      task("agent:otto:disk", at, { status: "running" }),
      transcript(items),
      "Otto",
      NOW,
      true,
    );
    expect(running.at(-1)).toEqual({ kind: "running", id: "running", text: "Otto, working" });
    const done = chatRows(
      task("agent:otto:disk", at, { status: "done" }),
      transcript(items),
      "Otto",
      NOW,
      true,
    );
    expect(done.some((row) => row.kind === "running")).toBe(false);
  });
});
