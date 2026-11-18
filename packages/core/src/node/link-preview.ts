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
import { isIP } from "node:net";
import type { LinkPreview, LinkPreviewer } from "../host.ts";

export const PREVIEW_PAGE_BYTES = 524_288;
export const PREVIEW_IMAGE_BYTES = 524_288;
export const PREVIEW_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

type Lookup = (hostname: string) => Promise<{ address: string; family: number }[]>;
type Fetch = typeof globalThis.fetch;

function v4(address: string): number[] | null {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : null;
}

/** An address on this machine or a network that is not the public internet. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const four = v4(mapped ? mapped[1]! : address);
  if (four) {
    const [a, b] = four as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const lower = address.toLowerCase();
  return (
    lower === "::" ||
    lower === "::1" ||
    /^f[cd]/.test(lower) ||
    /^fe[89ab]/.test(lower) ||
    /^ff/.test(lower)
  );
}

async function publicTarget(url: URL, lookup: Lookup): Promise<boolean> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host);
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
