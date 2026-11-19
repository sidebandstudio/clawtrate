// A link's preview, fetched by the device itself on the person's gesture
// (work-pane.md, section 12, F-116): the page's title, its description and its
// preview picture. Nothing calls this when a card is drawn; the interface asks
// for it after a hover of 500 ms, or a touch and hold.
//
// What it fetches is a bot's text, so it is untrusted: `http:` and `https:`
// only, no cookies or credentials, at most three redirects, each address
// checked again, and never an address that resolves to this machine or a
// private network (loopback, private, link-local, shared and unique-local
// ranges), so a link cannot make the app reach a gateway or a router. What is
// read is bounded: the first 512 KB of the page, a picture of at most 512 KB,
// 8 seconds in all.

import { lookup as dnsLookup } from "node:dns/promises";
import type { LinkPreview, LinkPreviewer } from "../host.ts";

export const PREVIEW_PAGE_BYTES = 524_288;
export const PREVIEW_IMAGE_BYTES = 524_288;
export const PREVIEW_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

type Lookup = (hostname: string) => Promise<{ address: string; family: number }[]>;
type Fetch = typeof globalThis.fetch;

/** An address as numbers: four bytes, or eight 16-bit words. */
export type ParsedAddress = { family: 4; bytes: number[] } | { family: 6; words: number[] };

/**
 * An IPv4 address in any spelling the resolver and the URL parser accept: one
 * to four parts, each decimal, octal (leading 0) or hexadecimal (0x), the last
 * filling the bytes left. Null when it is not one.
 */
function parseIPv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length === 0 || parts.length > 4 || parts.some((part) => part === "")) return null;
  const values: number[] = [];
  for (const part of parts) {
    let value: number;
    if (/^0x[0-9a-f]*$/i.test(part))
      value = part.length === 2 ? 0 : Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part.slice(1), 8);
    else if (/^(0|[1-9][0-9]*)$/.test(part)) value = Number(part);
    else return null;
    if (!Number.isSafeInteger(value)) return null;
    values.push(value);
  }
  const last = values.pop()!;
  if (values.some((value) => value > 255)) return null;
  if (last >= 256 ** (4 - values.length)) return null;
  const bytes = [...values];
  for (let shift = 3 - values.length; shift >= 0; shift -= 1)
    bytes.push(Math.floor(last / 256 ** shift) % 256);
  return bytes;
}

/** An IPv6 address, with `::` and a dotted IPv4 tail, as eight words. Null when it is not one. */
function parseIPv6(text: string): number[] | null {
  let body = text;
  const tail: number[] = [];
  const dotted = /^(.*:)([^:]*\.[^:]*)$/.exec(body);
  if (dotted) {
    const four = /^\d+\.\d+\.\d+\.\d+$/.test(dotted[2]!) ? parseIPv4(dotted[2]!) : null;
    if (!four) return null;
    tail.push((four[0]! << 8) | four[1]!, (four[2]! << 8) | four[3]!);
    body = dotted[1]!.endsWith("::") ? dotted[1]! : dotted[1]!.slice(0, -1);
  }
  const halves = body.split("::");
  if (halves.length > 2) return null;
  const words = (half: string) => (half === "" ? [] : half.split(":"));
  const head = words(halves[0]!);
  const rest = halves.length === 2 ? words(halves[1]!) : [];
  const all = [...head, ...rest];
  if (all.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return null;
  const count = all.length + tail.length;
  if (halves.length === 1 ? count !== 8 : count > 7) return null;
  const fill = new Array<number>(8 - count).fill(0);
  const out = [
    ...head.map((w) => Number.parseInt(w, 16)),
    ...(halves.length === 2 ? fill : []),
    ...rest.map((w) => Number.parseInt(w, 16)),
    ...tail,
  ];
  return out.length === 8 ? out : null;
}

/**
 * An address written as text, in brackets or not, with or without a zone
 * (after a `%`), as the address it is; null when the text is not an address.
 */
export function parseAddress(text: string): ParsedAddress | null {
  const bare = text
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");
  if (bare.includes(":")) {
    const words = parseIPv6(bare);
    return words ? { family: 6, words } : null;
  }
  const bytes = parseIPv4(bare);
  return bytes ? { family: 4, bytes } : null;
}

function privateIPv4([a, b]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a! >= 224
  );
}

/** The IPv4 address an IPv6 one carries: mapped, compatible, NAT64 or 6to4. */
function embeddedIPv4(w: number[]): number[] | null {
  const four = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  const zeros = (n: number) => w.slice(0, n).every((word) => word === 0);
  if (zeros(5) && w[5] === 0xffff) return four(w[6]!, w[7]!); // IPv4-mapped
  if (zeros(6)) return four(w[6]!, w[7]!); // IPv4-compatible, and the unspecified and loopback addresses
  if (zeros(4) && w[4] === 0xffff && w[5] === 0) return four(w[6]!, w[7]!); // IPv4-translated
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((word) => word === 0))
    return four(w[6]!, w[7]!); // the well-known NAT64 prefix
  if (w[0] === 0x2002) return four(w[1]!, w[2]!); // 6to4
  return null;
}

/**
 * An address on this machine or a network that is not the public internet:
 * loopback, unspecified, private, shared (carrier-grade), link-local,
 * unique-local, site-local, multicast and the like, in IPv4 or IPv6, including
 * an IPv4 address an IPv6 one carries. Decided on the parsed address; text
 * that is not an address counts as private, so nothing unread is reached.
 */
export function isPrivateAddress(text: string): boolean {
  const parsed = parseAddress(text);
  if (!parsed) return true;
  if (parsed.family === 4) return privateIPv4(parsed.bytes);
  const w = parsed.words;
  const embedded = embeddedIPv4(w);
  if (embedded) return privateIPv4(embedded) || w.every((word, i) => i === 7 || word === 0);
  return (
    (w[0]! & 0xfe00) === 0xfc00 || // unique-local (the first 7 bits 1111110)
    (w[0]! & 0xffc0) === 0xfe80 || // link-local (the first 10 bits 1111111010)
    (w[0]! & 0xffc0) === 0xfec0 || // site-local (the first 10 bits 1111111011)
    (w[0]! & 0xff00) === 0xff00 || // multicast (the first byte all ones)
    (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) || // the local NAT64 prefix
    (w[0] === 0x2001 && w[1] === 0) || // Teredo: carries an address it does not show
    (w[0] === 0x100 && w.slice(1, 4).every((word) => word === 0)) // the discard prefix
  );
}

/** A host name as names compare: lower case, without the trailing dots of a rooted name. */
const plainName = (name: string) => name.toLowerCase().replace(/\.+$/, "");

const INWARD_NAMES = /(^|\.)(localhost|local|internal|home\.arpa|localdomain)$/;

async function publicTarget(url: URL, lookup: Lookup): Promise<boolean> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = plainName(url.hostname.replace(/^\[|\]$/g, ""));
  const literal = parseAddress(host);
  if (literal) return !isPrivateAddress(host);
  if (!host || INWARD_NAMES.test(host)) return false;
  const addresses = await lookup(host);
  return addresses.length > 0 && addresses.every((each) => !isPrivateAddress(each.address));
}

/** At most `limit` bytes of a body; `whole` says whether that was all of it. */
async function readBounded(
  response: Response,
  limit: number,
): Promise<{ data: Uint8Array; whole: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { data: new Uint8Array(0), whole: true };
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { data: Buffer.concat(parts), whole: true };
    if (total + value.length > limit) {
      // A page's head is enough for its title; a picture must be whole.
      parts.push(value.subarray(0, limit - total));
      await reader.cancel();
      return { data: Buffer.concat(parts), whole: false };
    }
    total += value.length;
    parts.push(value);
  }
}

/** GET an address, following at most three redirects, every hop a public address. */
async function getPublic(
  start: string,
  accept: string,
  fetch: Fetch,
  lookup: Lookup,
  signal: AbortSignal,
): Promise<{ response: Response; url: URL } | null> {
  let url = new URL(start);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!(await publicTarget(url, lookup))) return null;
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { accept },
      signal,
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    return response.ok ? { response, url } : null;
  }
  return null;
}

const decodeEntities = (text: string) =>
  text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** The title, description and picture a page names in its head. */
export function readPreviewMeta(html: string): {
  title: string | null;
  description: string | null;
  image: string | null;
} {
  const meta = (name: string) => {
    for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
      const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
      const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
      if (key === name && content) return decodeEntities(content);
    }
    return null;
  };
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];
  return {
    title: meta("og:title") ?? (title ? decodeEntities(title) || null : null),
    description: meta("og:description") ?? meta("description"),
    image: meta("og:image"),
  };
}

export function createLinkPreviewer(
  options: { fetch?: Fetch; lookup?: Lookup; timeoutMs?: number } = {},
): LinkPreviewer {
  const fetch = options.fetch ?? globalThis.fetch;
  const lookup: Lookup = options.lookup ?? ((host) => dnsLookup(host, { all: true }));
  return async (link: string): Promise<LinkPreview> => {
    const none: LinkPreview = { status: "none", url: link };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PREVIEW_TIMEOUT_MS);
    try {
      const page = await getPublic(link, "text/html", fetch, lookup, controller.signal);
      if (!page || !/text\/html/i.test(page.response.headers.get("content-type") ?? "")) {
        await page?.response.body?.cancel();
        return none;
      }
      const { data: bytes } = await readBounded(page.response, PREVIEW_PAGE_BYTES);
      const found = readPreviewMeta(new TextDecoder().decode(bytes));
      let image: { mimeType: string; data: string } | null = null;
      if (found.image) {
        const got = await getPublic(
          new URL(found.image, page.url).toString(),
          IMAGE_TYPES.join(","),
          fetch,
          lookup,
          controller.signal,
        ).catch(() => null);
        const type = got?.response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
        if (got && IMAGE_TYPES.includes(type)) {
          const { data, whole } = await readBounded(got.response, PREVIEW_IMAGE_BYTES);
          if (whole) image = { mimeType: type, data: Buffer.from(data).toString("base64") };
        } else await got?.response.body?.cancel();
      }
      if (!found.title && !found.description && !image) return none;
      return { status: "ok", url: link, title: found.title, description: found.description, image };
    } catch {
      return none;
    } finally {
      clearTimeout(timer);
    }
  };
}
