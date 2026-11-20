// A link's preview, fetched by the host itself when the person chooses it
// (work-pane.md, section 12, F-116; docs/decisions.md, "Addresses a gateway
// hands the client"): the page's title, its description and its preview
// picture. Nothing calls this when a card is drawn or hovered; the interface
// asks for it only from the card's own Preview control, which names the host
// and the machine that fetches it.
//
// What it fetches is a bot's text, so it is untrusted: `https:` only, and
// every redirect and the picture only on the first page's origin (anything
// else is skipped), no cookies or credentials, and never an address on this machine or a
// network that is not the public internet, decided on the parsed address
// however it is written. A name is resolved once; if any address it resolves
// to is inward the preview is refused, and otherwise the connection goes to
// the address that was checked (the name is kept for TLS and the Host
// header), so a second lookup cannot answer differently. At most three
// redirects, each checked and pinned the same way before it is followed. What
// is read is bounded: the first 512 KB of the page, a picture of at most
// 512 KB, 8 seconds in all, the name's lookup included; and at most
// `MAX_OUTSTANDING_PREVIEWS` previews are under way at once.

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import type { LinkPreview, LinkPreviewer } from "../host.ts";

export const PREVIEW_PAGE_BYTES = 524_288;
export const PREVIEW_IMAGE_BYTES = 524_288;
export const PREVIEW_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
/** Previews one host has under way at once; another asked meanwhile has none. */
export const MAX_OUTSTANDING_PREVIEWS = 2;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

type Lookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

/** Where one request goes: its address, and the address it was checked at, to connect to. */
export type PinnedTarget = { url: URL; address: string; family: 4 | 6 };

/** A response as the previewer reads it. */
export type PreviewResponse = {
  status: number;
  header(name: string): string | null;
  body: AsyncIterable<Uint8Array>;
  close(): void;
};

/** One GET to a pinned target: it connects to `address`, never resolving the name again. */
export type PreviewGet = (
  target: PinnedTarget,
  accept: string,
  signal: AbortSignal,
) => Promise<PreviewResponse>;

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

/**
 * The address to connect to for a URL: its literal address, or the first
 * address its name resolves to, resolved once. Null when the URL is not a
 * plain web address, when the name is an inward one, or when any address it
 * resolves to is inward: a name that also answers inward is not trusted for
 * the rest.
 */
async function checkedTarget(url: URL, lookup: Lookup): Promise<PinnedTarget | null> {
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = plainName(url.hostname.replace(/^\[|\]$/g, ""));
  const literal = parseAddress(host);
  if (literal)
    return isPrivateAddress(host) ? null : { url, address: host, family: literal.family };
  if (!host || INWARD_NAMES.test(host)) return null;
  const addresses = await lookup(host);
  if (addresses.length === 0 || addresses.some((each) => isPrivateAddress(each.address)))
    return null;
  const first = addresses[0]!;
  const parsed = parseAddress(first.address)!;
  return { url, address: first.address.replace(/%.*$/, ""), family: parsed.family };
}

/**
 * The GET the previewer makes by default: Node's own HTTP and HTTPS, with the
 * connection's lookup answering the checked address, so the socket goes
 * there; the name stays in the Host header and in TLS (SNI and the
 * certificate's name). No agent is shared, nothing is decompressed.
 */
export function pinnedGet(): PreviewGet {
  return (target, accept, signal) =>
    new Promise((resolve, reject) => {
      const https = target.url.protocol === "https:";
      const host = target.url.hostname.replace(/^\[|\]$/g, "");
      const lookup: LookupFunction = (_name, options, callback) => {
        if (options.all) callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      };
      const request = (https ? httpsRequest : httpRequest)(
        {
          protocol: target.url.protocol,
          hostname: host,
          ...(target.url.port ? { port: Number(target.url.port) } : {}),
          path: `${target.url.pathname}${target.url.search}`,
          method: "GET",
          headers: {
            accept,
            "accept-encoding": "identity",
            "user-agent": "Clawtrate link preview",
          },
          lookup,
          agent: false,
          signal,
          ...(https && !parseAddress(host) ? { servername: plainName(host) } : {}),
        },
        (response: IncomingMessage) =>
          resolve({
            status: response.statusCode ?? 0,
            header: (name) => {
              const value = response.headers[name.toLowerCase()];
              return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
            },
            body: response,
            close: () => response.destroy(),
          }),
      );
      request.on("error", reject);
      request.end();
    });
}

/** At most `limit` bytes of a body; `whole` says whether that was all of it. */
async function readBounded(
  response: PreviewResponse,
  limit: number,
): Promise<{ data: Uint8Array; whole: boolean }> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    if (total + chunk.length > limit) {
      // A page's head is enough for its title; a picture must be whole.
      parts.push(chunk.subarray(0, limit - total));
      response.close();
      return { data: Buffer.concat(parts), whole: false };
    }
    total += chunk.length;
    parts.push(chunk);
  }
  return { data: Buffer.concat(parts), whole: true };
}

/**
 * GET an address on `origin`, following redirects within it while `hops`
 * allows (the page and its picture share three), each hop checked and pinned
 * before it is made. A hop to another origin is not followed.
 */
async function getPublic(
  start: string,
  origin: string,
  accept: string,
  get: PreviewGet,
  lookup: Lookup,
  signal: AbortSignal,
  hops: { left: number },
): Promise<{ response: PreviewResponse; url: URL } | null> {
  let url = new URL(start);
  for (;;) {
    if (url.origin !== origin) return null;
    // A preview past its deadline starts nothing more: not a lookup, and not a request after one.
    signal.throwIfAborted();
    const target = await checkedTarget(url, lookup);
    signal.throwIfAborted();
    if (!target) return null;
    const response = await get(target, accept, signal);
    const location = response.header("location");
    if (response.status >= 300 && response.status < 400 && location) {
      response.close();
      if (hops.left === 0) return null;
      hops.left -= 1;
      url = new URL(location, url);
      continue;
    }
    if (response.status >= 200 && response.status < 300) return { response, url };
    response.close();
    return null;
  }
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
  options: { get?: PreviewGet; lookup?: Lookup; timeoutMs?: number } = {},
): LinkPreviewer {
  const get = options.get ?? pinnedGet();
  const lookup: Lookup = options.lookup ?? ((host) => dnsLookup(host, { all: true }));
  let outstanding = 0;
  return async (link: string): Promise<LinkPreview> => {
    const none: LinkPreview = { status: "none", url: link };
    if (outstanding >= MAX_OUTSTANDING_PREVIEWS) return none;
    outstanding += 1;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The deadline ends the preview, wherever it is: a lookup that never answers included.
    const deadline = new Promise<LinkPreview>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(none);
      }, options.timeoutMs ?? PREVIEW_TIMEOUT_MS);
    });
    // The slot is the work's, not the caller's: it is held until the work itself settles, a
    // lookup still running after the deadline included.
    const work = preview(link, none, controller.signal).finally(() => {
      outstanding -= 1;
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };

  async function preview(link: string, none: LinkPreview, signal: AbortSignal) {
    try {
      let origin: string;
      try {
        origin = new URL(link).origin;
      } catch {
        return none;
      }
      const hops = { left: MAX_REDIRECTS };
      const page = await getPublic(link, origin, "text/html", get, lookup, signal, hops);
      if (!page || !/text\/html/i.test(page.response.header("content-type") ?? "")) {
        page?.response.close();
        return none;
      }
      const { data: bytes } = await readBounded(page.response, PREVIEW_PAGE_BYTES);
      const found = readPreviewMeta(new TextDecoder().decode(bytes));
      let image: { mimeType: string; data: string } | null = null;
      if (found.image) {
        const got = await getPublic(
          new URL(found.image, page.url).toString(),
          origin,
          IMAGE_TYPES.join(","),
          get,
          lookup,
          signal,
          hops,
        ).catch(() => null);
        const type = got?.response.header("content-type")?.split(";")[0]?.trim() ?? "";
        if (got && IMAGE_TYPES.includes(type)) {
          const { data, whole } = await readBounded(got.response, PREVIEW_IMAGE_BYTES);
          if (whole) image = { mimeType: type, data: Buffer.from(data).toString("base64") };
        } else got?.response.close();
      }
      if (!found.title && !found.description && !image) return none;
      const ok: LinkPreview = {
        status: "ok",
        url: link,
        title: found.title,
        description: found.description,
        image,
      };
      return ok;
    } catch {
      return none;
    }
  }
}
