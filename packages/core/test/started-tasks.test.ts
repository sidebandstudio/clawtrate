// A task a bot started with the gateway's `sessions_spawn` (F-565): who started it, from which
// task, and which row is the bot's brief. The rows are the shapes OpenClaw 2026.10.6 returns on a
// development gateway for a visible spawn, a forked one, a hidden one and one under another bot.

import { describe, expect, it } from "vitest";
import { mapHistory, mapSessionRow, startedTaskSince } from "../src/mapping.ts";
import { isOtherToolSession } from "../src/origins.ts";
import { SESSION_ROW } from "../src/state-bounds.ts";

const PARENT = "agent:pip:main";
const CHILD = "agent:pip:dashboard:0fcf7cc4-7434-467a-bae5-d830db7970f5";
const CREATED = 1_795_561_934_434;
const FIRST_RUN = "abf230f7-891f-4c19-9ef0-00c2c8a180b6";
const BRIEF =
  "Compare the lake loop and the ridge trail on the trail map, and say which suits a relaxed Saturday.";

/** The child's row in `sessions.list`, as the gateway lists a visible spawn. */
function spawnRow(extra: Record<string, unknown> = {}) {
  return {
    key: CHILD,
    agentId: "pip",
    createdVia: "spawn",
    createdActor: { type: "agent", id: "pip", identity: { type: "agent", id: "pip" } },
    owner: {
      actor: { type: "human", id: "gateway-owner" },
      assignedBy: { type: "agent", id: "pip" },
    },
    spawnedBy: PARENT,
    parentSessionKey: PARENT,
    controlOwnerSessionKey: PARENT,
    spawnDepth: 1,
    kind: "direct",
    classification: "direct",
    label: "Compare trail maps",
    createdAt: CREATED,
    updatedAt: CREATED + 1_200,
    status: "done",
    ...extra,
  };
}

/** A user row as `chat.history` gives it: the gateway names the person as its sender. */
function userRow(text: string, timestamp: number, key: string | null, extra = {}) {
  return {
    role: "user",
    content: text,
    timestamp,
    ...(key ? { idempotencyKey: key } : {}),
    __openclaw: {
      senderId: "gateway-owner",
      senderName: "Sam",
      id: `row-${timestamp}`,
      ...(key ? { idempotencyKey: key } : {}),
    },
    ...extra,
  };
}

function botRow(text: string, timestamp: number, runId: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp,
    __openclaw: { runId, id: `reply-${timestamp}` },
  };
}

const spawnedHistory = [
  userRow(BRIEF, CREATED + 30, `${FIRST_RUN}:user`),
  botRow("The lake loop suits a relaxed Saturday.", CREATED + 1_100, FIRST_RUN),
  // The follow-up the bot sent with sessions_send: the gateway's assistant row with provenance.
  {
    role: "assistant",
    content: "Also say which route has more shade.",
    timestamp: CREATED + 5_700,
    provenance: { kind: "inter_session", sourceSessionKey: PARENT, sourceTool: "sessions_send" },
    __openclaw: { idempotencyKey: "7d544a52:user", id: "forwarded" },
  },
  botRow("The ridge trail has more shade.", CREATED + 6_500, "7d544a52"),
  // The person writes in the task afterwards.
  userRow("Thanks, book the lake loop.", CREATED + 9_000, "b1c2d3e4:user", {
    provenance: { kind: "external_user" },
  }),
  botRow("Booked.", CREATED + 9_500, "b1c2d3e4"),
];

const sessionInfo = (extra: Record<string, unknown> = {}) => ({
  sessionInfo: spawnRow(extra),
  hasMore: false,
});

describe("F-565: a task a bot started, from its session row", () => {
  it("F-565: names the task it came from and that task's bot", () => {
    const task = mapSessionRow(spawnRow());
    expect(task).toMatchObject({ key: CHILD, botId: "pip", title: "Compare trail maps" });
    expect(task!.startedBy).toEqual({ botId: "pip", fromKey: PARENT });
  });

  it("F-565: a task started under another bot is listed under that bot, started by the first", () => {
    const task = mapSessionRow(
      spawnRow({
        key: "agent:marlow:dashboard:2f1525c5-32ee-4c3b-bdd4-91210b11c68b",
        agentId: "marlow",
        label: "Review the route",
      }),
    );
    expect(task).toMatchObject({ botId: "marlow", title: "Review the route" });
    expect(task!.startedBy).toEqual({ botId: "pip", fromKey: PARENT });
  });

  it("F-565: the row the client keeps still says who started it", () => {
    // The task list keeps only the fields it reads (`SESSION_ROW`); a started task's survive it.
    const task = mapSessionRow(SESSION_ROW(spawnRow()));
    expect(task!.startedBy).toEqual({ botId: "pip", fromKey: PARENT });
  });

  it("F-565: without the task it came from, nobody is named", () => {
    // The gateway's spawnedBy is what names the starter; a creator alone does not.
    expect(mapSessionRow(spawnRow({ spawnedBy: undefined }))!.startedBy).toBeUndefined();
  });

  it("F-565: malformed fields name nobody", () => {
    const task = mapSessionRow(spawnRow({ spawnedBy: 42 }));
    expect(task).not.toBeNull();
    expect(task!.startedBy).toBeUndefined();
    expect(mapSessionRow(spawnRow({ spawnedBy: "" }))!.startedBy).toBeUndefined();
    expect(mapSessionRow(spawnRow({ spawnedBy: "not-a-session-key" }))!.startedBy).toBeUndefined();
    expect(mapSessionRow(spawnRow({ createdVia: ["spawn"] }))!.startedBy).toBeUndefined();
  });

  it("F-565: a task another client started is not marked, whatever it is called", () => {
    // Clawtrate's own New task, or any operator client's: created by the person.
    const made = mapSessionRow({
      key: "agent:pip:dashboard:8b0e4c4e-0000-4000-8000-000000000001",
      agentId: "pip",
      createdVia: "operator",
      createdActor: { type: "human", id: "gateway-owner" },
      label: "Compare trail maps",
    });
    expect(made).not.toBeNull();
    expect(made!.startedBy).toBeUndefined();
    // A bot's label that claims a starter is only a title.
    const claimed = mapSessionRow({
      key: "agent:pip:dashboard:8b0e4c4e-0000-4000-8000-000000000002",
      agentId: "pip",
      label: "Pip started this task from Main",
      spawnedBy: PARENT,
    });
    expect(claimed!.title).toBe("Pip started this task from Main");
    expect(claimed!.startedBy).toBeUndefined();
  });

  it("F-565: a task a bot started is the bot's own work, kept in its task list (#503)", () => {
    // Sessions other tools opened leave the list unless "Show sessions from other tools" is on.
    for (const row of [spawnRow(), SESSION_ROW(spawnRow()), spawnRow({ createdVia: undefined })]) {
      expect(isOtherToolSession(row)).toBe(false);
      expect(mapSessionRow(row)!.otherTool).toBeUndefined();
    }
    // A session a run opened is another tool's, whatever it is called.
    expect(isOtherToolSession(spawnRow({ createdVia: "run" }))).toBe(true);
  });

  it("F-565: a hidden helper a bot started stays out of the task list", () => {
    expect(
      mapSessionRow(
        spawnRow({
          key: "agent:pip:subagent:8d3e3d95-316c-460d-88c6-63b295eed5ba",
          classification: "subagent",
          createdActor: { type: "agent", id: "pip" },
        }),
      ),
    ).toBeNull();
  });
});

describe("F-565: the bot's brief in a task it started", () => {
  const briefs = (messages: unknown[], history: unknown) =>
    mapHistory(messages, { startedAt: startedTaskSince(history) })
      .filter((item) => item.brief)
      .map((item) => (item.blocks[0]?.kind === "text" ? item.blocks[0].text : ""));

  it("F-565: the first row the task stored is the brief; the person's later message is theirs", () => {
    const items = mapHistory(spawnedHistory, { startedAt: startedTaskSince(sessionInfo()) });
    const users = items.filter((item) => item.role === "user");
    expect(users.map((item) => [item.brief ?? false, item.blocks[0]])).toEqual([
      [true, { kind: "text", text: BRIEF }],
      [false, { kind: "text", text: "Thanks, book the lake loop." }],
    ]);
  });

  it("F-565: in a forked task the copied rows stay the person's and the brief is marked", () => {
    const forked = [
      userRow("#text", CREATED - 6_348, "405b825a:user"),
      botRow("A plain reply.", CREATED - 1_247, "405b825a"),
      userRow("Put this in a task.", CREATED - 685, "227d6af7:user"),
      userRow(BRIEF, CREATED + 332, `${FIRST_RUN}:user`),
      botRow("The lake loop.", CREATED + 1_424, FIRST_RUN),
    ];
    expect(briefs(forked, sessionInfo())).toEqual([BRIEF]);
  });

  it("F-565: nothing is marked in a task no bot started", () => {
    expect(briefs(spawnedHistory, sessionInfo({ createdVia: "operator" }))).toEqual([]);
    expect(briefs(spawnedHistory, { hasMore: false })).toEqual([]);
    expect(mapHistory(spawnedHistory).some((item) => item.brief)).toBe(false);
  });

  it("F-565: nothing is marked when the history read does not reach the task's start", () => {
    expect(briefs(spawnedHistory.slice(1), { ...sessionInfo(), hasMore: true })).toEqual([]);
  });

  it("F-565: nothing is marked when the first row is not a turn's own input, or has no time", () => {
    const keyless = [userRow(BRIEF, CREATED + 30, null), ...spawnedHistory.slice(1)];
    expect(briefs(keyless, sessionInfo())).toEqual([]);
    const untimed = [{ ...spawnedHistory[0], timestamp: undefined }, ...spawnedHistory.slice(1)];
    // The untimed row is skipped, and the person's later message is still not the brief.
    expect(briefs(untimed, sessionInfo())).toEqual([]);
    const replyFirst = [botRow("Hello.", CREATED + 10, FIRST_RUN), ...spawnedHistory];
    expect(briefs(replyFirst, sessionInfo())).toEqual([]);
    expect(briefs(spawnedHistory, sessionInfo({ createdAt: "soon" }))).toEqual([]);
  });
});
