// The bot's markdown, read by the same parser family the desktop's renderer
// uses (micromark and mdast, with GitHub's extensions: tables, strikethrough,
// autolinks), and reduced to the few blocks and inlines the iOS bubble draws.
// Raw HTML is shown as text and never interpreted; a link opens in the system
// browser only when it is http, https or mailto. Pure, so the unit tests cover it.

import type { Nodes, PhrasingContent, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export type Inline =
  | { t: "text"; text: string }
  | { t: "strong"; children: Inline[] }
  | { t: "em"; children: Inline[] }
  | { t: "del"; children: Inline[] }
  | { t: "code"; text: string }
  | { t: "link"; url: string; children: Inline[] }
  | { t: "break" };

export type Block =
  | { t: "p"; children: Inline[] }
  | { t: "h"; depth: number; children: Inline[] }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "code"; text: string }
  | { t: "quote"; children: Block[] }
  | { t: "rule" }
  | { t: "table"; header: Inline[][]; rows: Inline[][][] };

/** The schemes a link may open. */
const OPENABLE = /^(https?:|mailto:)/i;

export function openableUrl(url: string): string | null {
  return OPENABLE.test(url.trim()) ? url.trim() : null;
}

function textOf(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node) return (node.children as Nodes[]).map(textOf).join("");
  return "";
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
        const children = inlines(node.children);
        return url ? [{ t: "link", url, children }] : children;
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
        return [{ t: "p", children: inlines(node.children) }];
      case "heading":
        return [{ t: "h", depth: node.depth, children: inlines(node.children) }];
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
          row ? row.children.map((cell) => inlines(cell.children)) : [];
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
