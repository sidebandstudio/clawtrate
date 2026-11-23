// Which sessions are chats that reached a bot through an external channel
// (Discord, Telegram, Slack and the rest), from the fields OpenClaw 2026.10.6
// puts on session rows. A bot's main session is never one, whatever channel it
// last delivered to: with the gateway's default `dmScope: "main"` every
// channel's direct messages share it, and it stays the bot's own conversation.
// The rules and their evidence: docs/research/gateway-capabilities.md, "Channel
// sessions".

import type { RawRecord } from "./mapping.ts";

/** Labels for the channels the gateway names most; any other id is shown as it comes. */
const CHANNEL_LABELS: Record<string, string> = {
  discord: "Discord",
  imessage: "iMessage",
  signal: "Signal",
  slack: "Slack",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
};

/** Channels the gateway keeps for itself: never an external route. `webchat` is Clawtrate's own. */
const INTERNAL_CHANNEL = /^(?:webchat|heartbeat|cron|webhook|voice|sessions_send)$/;

/** Key segments that are not a channel: what follows `agent:<id>:` on native and peer-only keys. */
const NOT_A_CHANNEL = /^(?:main|dashboard|direct|dm|group|channel|subagent)$/;

const PEER_KINDS = "direct|dm|group|channel";

/** A channel id as the gateway reports it, or null for none, an internal one or no id at all. */
function channelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) || INTERNAL_CHANNEL.test(id)) return null;
  return id;
}

/**
 * The channel a session key names: the gateway's peer keys are
 * `agent:<id>:<channel>:<peer kind>:…` and `agent:<id>:<channel>:<account>:direct:…`.
 */
function channelOfKey(key: string): string | null {
  const match = new RegExp(`^agent:[^:]+:([^:]+):(?:(?:${PEER_KINDS}):|[^:]+:direct:)`, "i").exec(
    key,
  );
  const id = match ? channelId(match[1]) : null;
  return id && !NOT_A_CHANNEL.test(id) ? id : null;
}

/**
 * The bot's main session: `isMain` or `classification: "main"` when the row
 * says, else its `agent:<id>:main` key. The gateway decides main before any
 * channel rule, and so does this.
 */
export function isMainSession(row: RawRecord): boolean {
  if (row.isMain === true || row.classification === "main") return true;
  if (typeof row.isMain === "boolean" || typeof row.classification === "string") return false;
  const key = typeof row.key === "string" ? row.key : row.sessionKey;
  return typeof key === "string" && /^agent:[^:]+:main$/.test(key);
}

/**
 * The external channel a session's chat comes from, or null for a native one:
 * never a main session; otherwise the row's `channel` or `lastChannel`, or the
 * channel its key names.
 */
export function externalChannelOf(row: RawRecord): string | null {
  if (isMainSession(row)) return null;
  const key = typeof row.key === "string" ? row.key : row.sessionKey;
  return (
    channelId(row.channel) ??
    channelId(row.lastChannel) ??
    (typeof key === "string" ? channelOfKey(key) : null)
  );
}

/** A channel's name for people: the gateway's label for the ones it names most, else its id. */
export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

/** A line the gateway wrote ahead of a channel turn: `Sender: ⟦openclaw:ctx⟧`, `Conversation info (untrusted metadata):`. */
function isMetadataHeader(line: string): boolean {
  return (
    (line.length > 14 && line.endsWith("⟦openclaw:ctx⟧")) || /\(untrusted metadata\):$/.test(line)
  );
}

/**
 * Text of a channel turn without what the gateway wrote around the person's
 * words: a leading timestamp or `[Discord …]` envelope, `⟦openclaw:ctx⟧` and
 * "(untrusted metadata)" blocks with their fenced JSON, the `Context: ⟦openclaw:ctx⟧`
 * block that ends a turn, and `[message_id: …]` lines. Text with none of them
 * comes back unchanged.
 */
export function stripChannelMetadata(text: string): string {
  if (!/⟦openclaw:ctx⟧|\(untrusted metadata\)|\[message_id:|^\[/m.test(text)) return text;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    // A code block the person wrote is theirs, whatever it holds.
    if (line.startsWith("```")) fenced = !fenced;
    if (fenced || line.startsWith("```")) {
      kept.push(lines[index]!);
      continue;
    }
    // Everything after the closing context block is the gateway's, never the person's.
    if (line === "Context: ⟦openclaw:ctx⟧") break;
    if (isMetadataHeader(line)) {
      if (lines[index + 1]?.trim() === "```json") {
        // A preview may end inside the block; then nothing after the header is the person's.
        index += 2;
        while (index < lines.length && lines[index]!.trim() !== "```") index += 1;
      } else {
        while (index + 1 < lines.length && lines[index + 1]!.trim() !== "") index += 1;
      }
      continue;
    }
    if (/^\[message_id:\s*[^\]]+\]$/i.test(line)) continue;
    kept.push(lines[index]!);
  }
  return (
    kept
      .join("\n")
      .trim()
      // A bracket followed by `(` is a markdown link the person wrote, never an envelope.
      .replace(/^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\](?!\() */, "")
      .replace(/^\[([^\]]+)\](?!\()\s*/, (envelope, header: string) =>
        /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(header) ||
        /^(WebChat|WhatsApp|Telegram|Signal|Slack|Discord|Google Chat|iMessage|Teams|Matrix|Zalo) /.test(
          header,
        )
          ? ""
          : envelope,
      )
  );
}

/** Titles the gateway makes from a channel's raw ids (`discord:g-1234567890`), which read as nothing to a person. */
function isRawChannelTitle(title: string, channel: string): boolean {
  return title.toLowerCase().startsWith(`${channel}:`);
}

/**
 * A channel chat's title: its label, the group's subject or channel name,
 * then the gateway's derived title or display name unless it is a raw id,
 * else "<Channel> chat".
 */
export function channelChatTitle(row: RawRecord, channel: string): string {
  for (const value of [
    row.label,
    row.subject,
    row.groupChannel,
    row.derivedTitle,
    row.displayName,
  ]) {
    if (typeof value !== "string") continue;
    const title = stripChannelMetadata(value).trim();
    if (title && !isRawChannelTitle(title, channel)) return title;
  }
  return `${channelLabel(channel)} chat`;
}
