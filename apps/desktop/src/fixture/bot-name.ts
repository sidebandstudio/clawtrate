// A bot made in New bot with no name takes one in the chat (F-552). The
// history is written in the gateway's own shapes, as a development gateway
// recorded `#take-name`: the bot reads its IDENTITY.md and edits the
// `- Name:` line, and the gateway's config still names it "New bot". The card
// is the state the engine publishes then (`botNames`). In `bot-name-read-only`
// the connection lacks admin, so the card has no Rename.

import {
  mapHistory,
  RawTable,
  runsFromHistory,
  type BridgeCommand,
  type ClawtrateState,
  type EngineContext,
} from "@clawtrate/core";
import { OPEN_TASK } from "./data.ts";

export const BOT_NAME_SCENES = ["bot-name", "bot-name-read-only"] as const;
export type BotNameScene = (typeof BOT_NAME_SCENES)[number];

export const isBotNameScene = (value: string): value is BotNameScene =>
  (BOT_NAME_SCENES as readonly string[]).includes(value);

export const NAMED_BOT = "new-bot";
export const NAMED_TASK = "agent:new-bot:main";
const SECOND = 1000;
const FILE =
  "# IDENTITY.md - Who Am I?\n\n- **Name:** New bot\n\nYour name was chosen in Clawtrate when you were made. Keep it unless the person asks for another.\n\nWhen the person gives you a new name, write it on the `- Name:` line above, and Clawtrate asks them to confirm it.\n";

function rows(start: number) {
  const run = "3c1f4b7e-9a2d-4e51-8f0b-6d2a7c9e1b40";
  const meta = (id: string, runId: string | null, seq: number) => ({
    id,
    seq,
    ...(runId ? { runId } : {}),
  });
  const at = (n: number) => start + n * SECOND;
  return [
    { role: "user", content: "can i name u", timestamp: at(0), __openclaw: meta("n-1", null, 1) },
    {
      role: "assistant",
      content: [{ type: "text", text: "Yes. What would you like to call me?" }],
      timestamp: at(2),
      model: "scripted/dev-1",
      __openclaw: meta("n-2", "8e0d2f61-5b7a-4c3e-9d14-2f6b8a0c7e95", 2),
    },
    { role: "user", content: "Johnny", timestamp: at(30), __openclaw: meta("n-3", null, 3) },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_n_1", name: "read", arguments: { path: "IDENTITY.md" } }],
      timestamp: at(31),
      model: "scripted/dev-1",
      __openclaw: meta("n-4", run, 4),
    },
    {
      role: "toolResult",
      toolCallId: "call_n_1",
      toolName: "read",
      content: [{ type: "text", text: FILE }],
      isError: false,
      timestamp: at(31),
      __openclaw: meta("n-5", run, 5),
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_n_2",
          name: "edit",
          arguments: {
            path: "IDENTITY.md",
            edits: [{ oldText: "- **Name:** New bot", newText: "- **Name:** Johnny" }],
          },
        },
      ],
      timestamp: at(32),
      model: "scripted/dev-1",
      __openclaw: meta("n-6", run, 6),
    },
    {
      role: "toolResult",
      toolCallId: "call_n_2",
      toolName: "edit",
      content: [{ type: "text", text: "Successfully replaced 1 block(s) in IDENTITY.md." }],
      details: { diff: "-3 - **Name:** New bot\n+3 - **Name:** Johnny" },
      isError: false,
      timestamp: at(32),
      __openclaw: meta("n-7", run, 7),
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Johnny it is. Saved, so I'll remember." }],
      timestamp: at(33),
      model: "scripted/dev-1",
      __openclaw: meta("n-8", run, 8),
    },
  ];
}

export function botNameScene(name: BotNameScene, base: ClawtrateState, now: number): ClawtrateState {
  const start = now - 5 * 60 * SECOND;
  const history = rows(start);
  const ctx: EngineContext = { sessionKey: NAMED_TASK, now, raw: new RawTable() };
  const admin = name === "bot-name";
  return {
    ...base,
    connection: { ...base.connection, canAdmin: admin },
    bots: [
      ...base.bots,
      {
        id: NAMED_BOT,
        name: "New bot",
        emoji: null,
        avatarUrl: null,
        theme: null,
        model: "scripted/dev-1",
        isDefault: false,
      },
    ],
    tasksByBot: {
      ...base.tasksByBot,
      [NAMED_BOT]: [
        {
          key: NAMED_TASK,
          botId: NAMED_BOT,
          sessionId: "5f2c8e1a-7b3d-4a96-b0e4-1d9c6a2f8e37",
          title: "Main",
          preview: "Johnny it is. Saved, so I'll remember.",
          updatedAt: start + 33 * SECOND,
          status: "done",
          unread: false,
        },
      ],
    },
    transcripts: {
      ...base.transcripts,
      [NAMED_TASK]: {
        ...base.transcripts[OPEN_TASK]!,
        sessionKey: NAMED_TASK,
        items: mapHistory(history),
        runs: runsFromHistory(history, null, ctx),
        outbox: [],
        approvals: [],
        questions: [],
      },
    },
    botNames: [{ botId: NAMED_BOT, name: "Johnny", from: "New bot", status: "open", error: null }],
  };
}

/** Rename names the bot as the gateway's bot list then would; Not now drops the card. */
export function botNameCommand(
  command: BridgeCommand,
  get: () => ClawtrateState,
  set: (state: ClawtrateState) => void,
): Promise<void> | undefined {
  if (command.type !== "acceptBotName" && command.type !== "declineBotName") return undefined;
  const state = get();
  const botNames = (state.botNames ?? []).filter((each) => each.botId !== command.botId);
  if (command.type === "declineBotName") {
    set({ ...state, botNames });
    return Promise.resolve();
  }
  set({
    ...state,
    bots: state.bots.map((bot) => (bot.id === command.botId ? { ...bot, name: command.name } : bot)),
    botNames,
  });
  return Promise.resolve();
}
