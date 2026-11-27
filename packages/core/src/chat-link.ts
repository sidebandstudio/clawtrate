// Clawtrate's own links, `clawtrate://chat?bot=…&gateway=…&text=…`: they open a
// bot's chat and put editable text in its composer (docs/design/links.md, F-248).
// A link is untrusted input. The host validates it and gives the interface only
// these values, or that the link was invalid, never the raw URL. A link cannot
// send, change settings, approve, connect or ask for access.

/** The scheme of Clawtrate's links. */
export const CHAT_LINK_SCHEME = "clawtrate";
/** The longest raw link accepted, in ASCII bytes. */
export const MAX_CHAT_LINK_BYTES = 8192;
/** The most text a link may put in the composer, in Unicode code points. */
export const MAX_CHAT_LINK_TEXT = 2000;

const PREFIX = `${CHAT_LINK_SCHEME}://chat?`;
/** One field: a known name, matched before decoding, and a value of unreserved characters and UTF-8 escapes. */
const FIELD = /^(bot|gateway|text)=((?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})*)$/;
const BOT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const GATEWAY_ID = /^[0-9a-f]{64}$/;
/** Control characters other than a line feed, line and paragraph separators, and bidi controls. */
const REFUSED_TEXT = /[\p{Cc}\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

/** A validated link: the bot's id, the gateway identity it is for, and the text for the composer. */
export type ChatLink = { bot: string; gateway: string; text: string };

/**
 * What a host hands the interface for each link it receives. `id` tells two
 * deliveries of the same link apart: each gets its own validation and choice.
 */
export type ChatLinkDelivery =
  { id: number; status: "valid"; link: ChatLink } | { id: number; status: "invalid" };

/** The link's values, or null when any rule of docs/design/links.md section 1 fails. */
export function parseChatLink(raw: string): ChatLink | null {
  if (raw.length > MAX_CHAT_LINK_BYTES || !raw.startsWith(PREFIX)) return null;
  const values = new Map<string, string>();
  for (const field of raw.slice(PREFIX.length).split("&")) {
    const match = FIELD.exec(field);
    if (!match || values.has(match[1]!)) return null;
    try {
      values.set(match[1]!, decodeURIComponent(match[2]!));
    } catch {
      // A malformed escape or invalid UTF-8.
      return null;
    }
  }
  const bot = values.get("bot");
  const gateway = values.get("gateway");
  const given = values.get("text");
  if (!bot || !BOT_ID.test(bot) || !gateway || !GATEWAY_ID.test(gateway) || given === undefined)
    return null;
  const normalized = given.replace(/\r\n?/g, "\n").replace(/\t/g, " ");
  if (REFUSED_TEXT.test(normalized.replaceAll("\n", ""))) return null;
  const text = normalized.trim();
  const length = [...text].length;
  if (length < 1 || length > MAX_CHAT_LINK_TEXT) return null;
  return { bot, gateway, text };
}

/** A link as the interface receives it, numbered by the host. */
export function deliverChatLink(id: number, raw: string): ChatLinkDelivery {
  const link = parseChatLink(raw);
  return link ? { id, status: "valid", link } : { id, status: "invalid" };
}
