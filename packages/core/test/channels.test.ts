// Chats from external channels (F-519): which rows are one, what they are called,
// and that the task list leaves them out unless asked. The row shapes are the
// ones OpenClaw 2026.10.6 reported on a development gateway (docs/research/
// gateway-capabilities.md, "Channel sessions").

import { describe, expect, it } from "vitest";
import {
  channelChatTitle,
  externalChannelOf,
  isMainSession,
  stripChannelMetadata,
} from "../src/channels.ts";
import { groupTasks, mapSessionRow, plainPreview } from "../src/mapping.ts";

const discord = {
  key: "agent:pip:discord:channel:1234567890",
  agentId: "pip",
  channel: "discord",
  lastChannel: "discord",
  classification: "channel",
  displayName: "discord:g-1234567890",
  derivedTitle: "discord:g-1234567890",
  lastMessagePreview: "From the server",
  updatedAt: 300,
  unread: true,
};
const slackDirect = {
  key: "agent:pip:slack:direct:u0123",
  agentId: "pip",
  channel: "slack",
  classification: "direct",
  updatedAt: 250,
};
const native = {
  key: "agent:pip:dashboard:0f6c2a9e-1111",
  agentId: "pip",
  label: "Disk space",
  classification: "direct",
  lastMessagePreview: "Freed 4 GB",
  updatedAt: 100,
};
/** The bot's main session after a Telegram direct message and then a native turn: the channel sticks. */
const stickyMain = {
  key: "agent:pip:main",
  agentId: "pip",
  channel: "telegram",
  lastChannel: "telegram",
  classification: "main",
  isMain: true,
  updatedAt: 200,
};

describe("F-519: which sessions are chats from an external channel", () => {
  it("F-519: a row the gateway routes to a channel is one, by its channel, its last channel or its key", () => {
    expect(externalChannelOf(discord)).toBe("discord");
    expect(externalChannelOf(slackDirect)).toBe("slack");
    expect(externalChannelOf({ key: "agent:pip:direct:u1", lastChannel: "WhatsApp" })).toBe(
      "whatsapp",
    );
    // A key alone, as Routines opens a task: the gateway's channel-peer shapes.
    expect(externalChannelOf({ key: "agent:pip:telegram:group:-100200" })).toBe("telegram");
    expect(externalChannelOf({ key: "agent:pip:signal:work:direct:+15550100" })).toBe("signal");
    expect(externalChannelOf({ key: "agent:pip:devchat:group:g1" })).toBe("devchat");
    expect(externalChannelOf({ key: "agent:pip:discord:channel:1:thread:9" })).toBe("discord");
  });

  it("F-519: a native task, a peer key without a channel and the gateway's own channels are not", () => {
    expect(externalChannelOf(native)).toBeNull();
    expect(externalChannelOf({ key: "agent:pip:direct:u1" })).toBeNull();
    expect(externalChannelOf({ key: "agent:pip:dashboard:abc:direct:x" })).toBeNull();
    for (const channel of ["webchat", "heartbeat", "cron", "webhook", "voice", "sessions_send"])
      expect(externalChannelOf({ key: "agent:pip:x", channel })).toBeNull();
    expect(externalChannelOf({ key: "agent:pip:x", channel: { provider: "discord" } })).toBeNull();
  });

  it("F-519: a main session is never one, whatever channel it last delivered to", () => {
    expect(isMainSession(stickyMain)).toBe(true);
    expect(externalChannelOf(stickyMain)).toBeNull();
    // A `sessions.changed` payload names neither `isMain` nor `classification`: the key decides.
    expect(externalChannelOf({ key: "agent:pip:main", channel: "telegram" })).toBeNull();
    // A main key configured otherwise is main by what the row says.
    expect(externalChannelOf({ key: "agent:pip:home", isMain: true, channel: "slack" })).toBeNull();
    expect(isMainSession({ key: "agent:pip:main", isMain: false })).toBe(false);
  });

  it("F-519: a channel chat is named by its label, its subject or the channel, never a raw id", () => {
    expect(channelChatTitle(discord, "discord")).toBe("Discord chat");
    expect(channelChatTitle({ ...discord, subject: "#general" }, "discord")).toBe("#general");
    expect(channelChatTitle({ ...discord, label: "Release chat" }, "discord")).toBe("Release chat");
    expect(channelChatTitle({ key: "x", derivedTitle: "Where is the build?" }, "slack")).toBe(
      "Where is the build?",
    );
    expect(channelChatTitle({ key: "x" }, "devchat")).toBe("devchat chat");
    expect(mapSessionRow(discord)).toMatchObject({ title: "Discord chat", channel: "discord" });
    expect(mapSessionRow({ key: "agent:pip:telegram:direct:123" })).toMatchObject({
      title: "Telegram chat",
      channel: "telegram",
    });
    expect(mapSessionRow(native)).not.toHaveProperty("channel");
    expect(mapSessionRow(stickyMain)).toMatchObject({ title: "Main", isMain: true });
    expect(mapSessionRow(stickyMain)).not.toHaveProperty("channel");
  });
});

describe("F-519: the task list leaves channel chats out unless asked", () => {
  const rows = [discord, slackDirect, native, stickyMain];

  it("F-519: off, only the bot's own tasks are listed, in the order they had, main among them", () => {
    const tasks = groupTasks(rows).pip!;
    expect(tasks.map((task) => task.key)).toEqual([stickyMain.key, native.key]);
    expect(tasks.some((task) => task.unread)).toBe(false);
    expect(groupTasks(rows, { showChannelChats: false })).toEqual(groupTasks(rows));
    expect(groupTasks([native, stickyMain])).toEqual(groupTasks(rows));
  });

  it("F-519: on, the channel chats are listed with the rest, newest first", () => {
    expect(groupTasks(rows, { showChannelChats: true }).pip!.map((task) => task.key)).toEqual([
      discord.key,
      slackDirect.key,
      stickyMain.key,
      native.key,
    ]);
  });

  it("F-519: a bot with only channel chats has no list until they are shown", () => {
    expect(groupTasks([discord])).toEqual({});
    expect(groupTasks([discord], { showChannelChats: true }).pip).toHaveLength(1);
  });
});

describe("F-519: what the gateway wrote around a channel turn is not shown as its text", () => {
  it("F-519: context blocks, untrusted metadata JSON, message ids and the envelope are cut", () => {
    const turn = [
      "Conversation info: ⟦openclaw:ctx⟧",
      "```json",
      '{"message_id":"42","sender":"someone"}',
      "```",
      "",
      "Sender (untrusted metadata):",
      "```json",
      '{"label":"someone"}',
      "```",
      "",
      "[message_id: 42]",
      "Can you check the build?",
      "",
      "Context: ⟦openclaw:ctx⟧",
      "Recent channel history follows.",
    ].join("\n");
    expect(stripChannelMetadata(turn)).toBe("Can you check the build?");
    expect(plainPreview(turn)).toBe("Can you check the build?");
    expect(plainPreview("[Discord #general 2026-11-20 10:00] Ship it")).toBe("Ship it");
    expect(plainPreview("[Thu 2026-11-20 10:00 UTC] Ship it")).toBe("Ship it");
  });

  it("F-519: a preview cut inside a metadata block shows nothing of it", () => {
    expect(plainPreview('Conversation info (untrusted metadata):\n```json\n{"chat_id": "1')).toBe(
      null,
    );
  });

  it("F-519: ordinary text, brackets and links included, is left as it is", () => {
    for (const text of ["[link](https://example.com) here", "[draft] notes", "Plain words"])
      expect(stripChannelMetadata(text)).toBe(text);
  });
});
