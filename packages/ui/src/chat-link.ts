// Clawtrate links in the interface (docs/design/links.md, F-248). The host has
// validated the link; here it is checked against what the app already knows of
// the connection, in the design's order, and either opens the bot's chat or
// says why it cannot. It adds no gateway calls and asks for no access.

import type { ChatLinkDelivery, ClawtrateState, HostInfo } from "@clawtrate/core";
import { canWrite } from "./access.ts";

/** Why a link cannot open, in the order they are checked, with the reason shown. */
export const LINK_REFUSALS = {
  invalid: "This Clawtrate link is invalid. Ask for a new link.",
  "no-gateway":
    "Clawtrate isn't connected to a gateway. Connect to the right gateway, then open the link again.",
  unavailable:
    "Clawtrate couldn't verify the gateway or load its bots and chats. Open the link again when they're available.",
  "other-gateway":
    "This link is for a different gateway. Connect to that gateway, then open the link again.",
  "unknown-bot": "This bot isn't on the connected gateway. Check the link or ask for a new one.",
  "no-chat": "This bot has no chat to open.",
  "read-only": "This device can read this chat. It can't edit the draft.",
} as const;

export type LinkRefusal = keyof typeof LINK_REFUSALS;

/** The status line above the composer once a link's text is in it. */
export const LINK_TEXT_ADDED = "Link text added to your draft. Nothing was sent.";

export type LinkOutcome =
  { kind: "wait" } | { kind: "refused"; refusal: LinkRefusal } | { kind: "open"; botId: string };

type LinkFacts = Pick<ClawtrateState, "connection" | "discovery" | "bots" | "tasksByBot">;

/**
 * Whether the connection has an outcome: connected with its bots and tasks read
 * or failed, an attempt that failed, or no attempt under way.
 */
export function connectionSettled({ connection, discovery }: LinkFacts): boolean {
  if (connection.status === "connecting" || connection.status === "reconnecting")
    return connection.error !== null;
  if (connection.status === "connected")
    return discovery.status === "ready" || discovery.status === "error";
  return true;
}

/**
 * What a link does now. While the bots and tasks of a connection are loading, and
 * while the app's first connection is under way (`starting`), it waits.
 */
export function resolveChatLink(
  delivery: ChatLinkDelivery,
  facts: LinkFacts,
  info: Pick<HostInfo, "readOnly">,
  starting: boolean,
): LinkOutcome {
  const refused = (refusal: LinkRefusal): LinkOutcome => ({ kind: "refused", refusal });
  if (delivery.status === "invalid") return refused("invalid");
  const { connection, discovery } = facts;
  if (!connectionSettled(facts) && (starting || connection.status === "connected"))
    return { kind: "wait" };
  if (connection.status !== "connected") return refused("no-gateway");
  if (discovery.status === "error" || connection.gatewayId === null) return refused("unavailable");
  if (connection.gatewayId !== delivery.link.gateway) return refused("other-gateway");
  const bot = facts.bots.find((each) => each.id === delivery.link.bot);
  if (!bot) return refused("unknown-bot");
  // A partial task list does not prove the bot has no chat.
  if (!facts.tasksByBot[bot.id]?.length)
    return refused(discovery.partial ? "unavailable" : "no-chat");
  if (!canWrite(connection, info)) return refused("read-only");
  return { kind: "open", botId: bot.id };
}
