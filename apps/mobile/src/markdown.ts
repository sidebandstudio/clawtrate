// The bot's markdown, read by the same parser family the desktop's renderer
// uses (micromark and mdast, with GitHub's extensions: tables, strikethrough,
// autolinks), and reduced to the few blocks and inlines the iOS bubble draws.
// Raw HTML is shown as text and never interpreted. A link opens in the system
// browser, and only when it is an http or https address that parses with no
// user name or password; any other is its text. A link opens at once. One whose visible text is not its own
// address shows the address's host beside it, in ASCII, and one to this iPhone
// or the person's own network says so beside it too. Pure, so the unit tests
// cover it.

import { loopbackHost } from "@clawtrate/core";
import type { Nodes, PhrasingContent, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { REDACTED } from "./host/secrets.ts";
import { isLocalAddress } from "./local-network.ts";

export type Inline =
  | { t: "text"; text: string }
  | { t: "strong"; children: Inline[] }
  | { t: "em"; children: Inline[] }
  | { t: "del"; children: Inline[] }
  | { t: "code"; text: string }
  | {
      t: "link";
      url: string;
      /** The destination's host in ASCII, a look-alike's included, which the screen shows. */
      host: string;
      /** The visible text is the address itself, its host written as the screen would show it. */
      plain: boolean;
      /** Where the host is when it isn't out on the internet. */
      place: LinkPlace | null;
      children: Inline[];
    }
  | { t: "break" };

export type Block =
  | { t: "p"; children: Inline[] }
  | { t: "h"; depth: number; children: Inline[] }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "code"; text: string }
  | { t: "quote"; children: Block[] }
  | { t: "rule" }
  | { t: "table"; header: Inline[][]; rows: Inline[][][] };

/**
 * A link's address when it may open: http or https, it parses with a host, and it carries no
 * user name or password (docs/decisions.md, "User names and passwords in an address").
 */
export function openableUrl(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.host !== "" &&
    parsed.username === "" &&
    parsed.password === ""
    ? parsed
    : null;
}

/**
 * Whether a link's visible text is its own address (an autolink, or the address written out),
 * with the host written as the screen would show it. Text whose host is in other letters, a
 * look-alike's, or another spelling of the same address, is not its address.
 */
function shownAddress(text: string, destination: URL): boolean {
  const label = text.trim();
  const source =
    openableUrl(label) ??
    (/^www\./i.test(label) ? openableUrl(`${destination.protocol}//${label}`) : null);
  return source?.href === destination.href && writtenHost(label) === destination.hostname;
}

/**
 * The host as an address is written: after the scheme and any user name, before the port and
 * path. Only ASCII letters are lowered: any other letter, such as the Kelvin sign that the URL
 * parser and `toLowerCase` both turn into "k", stays as written, so it never matches a parsed host.
 */
function writtenHost(address: string): string {
  const authority = address.replace(/^[a-z][a-z\d+.-]*:\/\//i, "").split(/[/?#\\]/, 1)[0]!;
  return authority
    .slice(authority.lastIndexOf("@") + 1)
    .replace(/:\d*$/, "")
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** Where a link goes when it isn't out on the internet: this iPhone, or the person's own network. */
export type LinkPlace = "device" | "network";

/**
 * Where a link's host is, from the host as parsed and with no lookup (docs/decisions.md, "The
 * person's own network"): this iPhone for loopback, and the person's own network for a private,
 * shared or link-local IPv4 address, IPv4 written as IPv6 included, an IPv6 unique-local or
 * link-local one, a .local name and a name without a dot. One final dot is ignored.
 */
export function linkPlace(url: URL): LinkPlace | null {
  if (loopbackHost(url.hostname)) return "device";
  let host = url.hostname.toLowerCase().replace(/\.$/, "");
  // The parser writes IPv4 written as IPv6 (::ffff:a.b.c.d) in hex; it is judged as IPv4.
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(host);
  if (mapped) {
    const [high, low] = [Number.parseInt(mapped[1]!, 16), Number.parseInt(mapped[2]!, 16)];
    host = [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  // The shared range, 100.64/10, that a carrier or a private network such as a VPN hands out.
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  const shared = v4 !== null && v4[1] === "100" && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;
  const bare = !host.startsWith("[") && !host.includes(".");
  return isLocalAddress(`http://${host}/`) || shared || bare ? "network" : null;
}

/** The plain text of inlines. */
export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) =>
      node.t === "text" || node.t === "code"
        ? node.text
        : node.t === "break"
          ? " "
          : inlineText(node.children),
    )
    .join("");
}

function textOf(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node) return (node.children as Nodes[]).map(textOf).join("");
  return "";
}

/**
 * Embeddings, overrides and isolates (U+202A to U+202E, U+2066 to U+2069). A link's own words
 * carry none, so no direction the bot set in them runs on into the host shown beside them.
 */
const DIRECTION_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

function withoutDirectionControls(nodes: Inline[]): Inline[] {
  return nodes.map((node): Inline => {
    switch (node.t) {
      case "text":
      case "code":
        return { ...node, text: node.text.replace(DIRECTION_CONTROLS, "") };
      case "strong":
      case "em":
      case "del":
      case "link":
        return { ...node, children: withoutDirectionControls(node.children) };
      default:
        return node;
    }
  });
}

/** A word joiner: no width, and no line break where it stands. */
export const LINK_JOINER = "\u2060";

/**
 * A word joiner between two links with nothing between them. iOS makes one VoiceOver element of
 * each run of text with the link role, so two links side by side would be one element naming
 * both; text without the role between them keeps each its own, and the joiner shows nothing.
 */
function linksApart(nodes: Inline[]): Inline[] {
  let afterLink = false;
  const walk = (list: Inline[]): Inline[] =>
    list.flatMap((node): Inline[] => {
      switch (node.t) {
        case "link": {
          const out: Inline[] = afterLink ? [{ t: "text", text: LINK_JOINER }, node] : [node];
          afterLink = true;
          return out;
        }
        case "strong":
        case "em":
        case "del":
          return [{ ...node, children: walk(node.children) }];
        case "text":
          if (node.text !== "") afterLink = false;
          return [node];
        default:
          afterLink = false;
          return [node];
      }
    });
  return walk(nodes);
}

/** A block's inlines: links side by side kept apart for VoiceOver. */
function blockInlines(nodes: PhrasingContent[]): Inline[] {
  return linksApart(inlines(nodes));
}

function inlines(nodes: PhrasingContent[]): Inline[] {
  return nodes.flatMap((node): Inline[] => {
    switch (node.type) {
      case "text":
        return [{ t: "text", text: node.value }];
      case "strong":
        return [{ t: "strong", children: inlines(node.children) }];
      case "emphasis":
        return [{ t: "em", children: inlines(node.children) }];
      case "delete":
        return [{ t: "del", children: inlines(node.children) }];
      case "inlineCode":
        return [{ t: "code", text: node.value }];
      case "break":
        return [{ t: "break" }];
      case "link": {
        const url = openableUrl(node.url);
        if (!url) return inlines(node.children);
        const children = withoutDirectionControls(inlines(node.children));
        return [
          {
            t: "link",
            url: url.href,
            host: url.host,
            plain: shownAddress(inlineText(children), url),
            place: linkPlace(url),
            children,
          },
        ];
      }
      case "image":
        return node.alt ? [{ t: "text", text: node.alt }] : [];
      default:
        // Raw HTML, footnote references and anything else: their text, never markup.
        return [{ t: "text", text: textOf(node) }];
    }
  });
}

function blocks(nodes: RootContent[]): Block[] {
  return nodes.flatMap((node): Block[] => {
    switch (node.type) {
      case "paragraph":
        return [{ t: "p", children: blockInlines(node.children) }];
      case "heading":
        return [{ t: "h", depth: node.depth, children: blockInlines(node.children) }];
      case "list":
        return [
          {
            t: "list",
            ordered: node.ordered === true,
            start: node.start ?? 1,
            items: node.children.map((item) => blocks(item.children)),
          },
        ];
      case "code":
        return [{ t: "code", text: node.value }];
      case "blockquote":
        return [{ t: "quote", children: blocks(node.children) }];
      case "thematicBreak":
        return [{ t: "rule" }];
      case "table": {
        const [head, ...body] = node.children;
        const cells = (row: typeof head) =>
          row ? row.children.map((cell) => blockInlines(cell.children)) : [];
        return [{ t: "table", header: cells(head), rows: body.map(cells) }];
      }
      case "html":
        return node.value.trim() ? [{ t: "p", children: [{ t: "text", text: node.value }] }] : [];
      default: {
        const text = textOf(node);
        return text.trim() ? [{ t: "p", children: [{ t: "text", text }] }] : [];
      }
    }
  });
}

export function parseMarkdown(text: string): Block[] {
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return blocks(tree.children);
}

/** A table column's width bounds, in points: a narrow column still reads, a wide one wraps. */
export const COLUMN_WIDTH = { min: 72, max: 240 } as const;

/**
 * Each column's width, the same in every row: its longest cell's text at an
 * average glyph width of the font size's 0.55, plus the cell's 16 points of
 * padding, within COLUMN_WIDTH. Every cell of a column gets that width, so
 * the columns line up and nothing is measured against an unbounded width.
 */
export function columnWidths(table: Extract<Block, { t: "table" }>, fontSize: number): number[] {
  const rows = [table.header, ...table.rows];
  const columns = Math.max(0, ...rows.map((row) => row.length));
  return Array.from({ length: columns }, (_, k) => {
    const longest = Math.max(0, ...rows.map((row) => inlineText(row[k] ?? []).length));
    const width = Math.ceil(longest * fontSize * 0.55) + 16;
    return Math.min(COLUMN_WIDTH.max, Math.max(COLUMN_WIDTH.min, width));
  });
}

/** The words beside a link, and on the sheet a long press shows. */
export const LINK_WORDS = {
  /** Beside a link to this iPhone or to the person's own network, read before it is chosen. */
  place: { device: "this iPhone", network: "your network" },
  /** The sheet's title, over the full address. */
  outside: "Opens outside Clawtrate",
  copy: "Copy",
  close: "Close",
} as const;

/**
 * What the screen shows in parentheses after a link's text, as part of the link, so VoiceOver
 * names it with the link: the host when the text isn't the address, and where the host is when
 * it is this iPhone or the person's network. Null when there is nothing to add.
 */
export function besideLink(link: Extract<Inline, { t: "link" }>): string | null {
  const parts = [link.plain ? null : link.host, link.place ? LINK_WORDS.place[link.place] : null];
  const shown = parts.filter((part) => part !== null);
  return shown.length > 0 ? shown.join(", ") : null;
}

/**
 * What follows a link's text on the screen: a space, then what `besideLink` says in parentheses,
 * isolated left to right (U+2066 to U+2069), so a direction set before it, in the link's words or
 * the text around them, can't reverse the host it shows.
 */
export function besideShown(link: Extract<Inline, { t: "link" }>): string | null {
  const beside = besideLink(link);
  return beside === null ? null : ` \u2066(${beside})\u2069`;
}

/**
 * Whether an address carries a credential this device holds, or one already scrubbed, as written
 * or decoded: by `decodeURI`, and by `decodeURIComponent`, which also decodes `%40`, `%2F`, `%3A`
 * and the other reserved characters. Such a link is never handed to the system.
 */
export function carriesCredential(url: string, redact: (text: string) => string): boolean {
  const forms = [url];
  for (const decode of [decodeURI, decodeURIComponent]) {
    try {
      forms.push(decode(url));
    } catch {
      // An address that doesn't decode is judged as written.
    }
  }
  return forms.some((form) => redact(form) !== form || form.includes(REDACTED));
}
