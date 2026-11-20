// The update feed: one JSON document, read with JSON.parse and checked field
// by field. docs/decisions.md, "Updates and release signing", gives the format.
// Only the checked values leave this file; any other field is ignored.

import type { UpdateTrack } from "@clawtrate/core";
import { readable, type LoopbackHttpForTests } from "./address.ts";
import { parseVersion, versionTrack, type Version } from "./version.ts";

export const FEED_FORMAT = 1;

/** The artifacts a feed can name, as electron-builder names them: `<os>-<arch>`. */
export const FILE_KEYS = ["mac-arm64", "mac-x64", "win-x64"] as const;
export type FileKey = (typeof FILE_KEYS)[number];
/** Each artifact's extension: the macOS zip, and the NSIS installer. */
export const FILE_EXTENSION: Readonly<Record<FileKey, string>> = {
  "mac-arm64": "zip",
  "mac-x64": "zip",
  "win-x64": "exe",
};

/** A SHA-512 digest in base64, as electron-builder writes it: 64 bytes, 88 characters. */
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/;
/** An ISO 8601 time in UTC, as `Date.prototype.toISOString` writes it, milliseconds optional. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export interface FeedFile {
  readonly url: URL;
  readonly size: number;
  readonly sha512: string;
}

export interface Feed {
  readonly version: Version;
  /** Re-written by `Date`, never the feed's own text. */
  readonly releaseDate: string;
  /** The file for this system, or null when the feed has none. */
  readonly file: FeedFile | null;
}

export type FeedRead =
  | { readonly ok: true; readonly feed: Feed }
  | { readonly ok: false; readonly cause: "malformed-feed" | "address-refused" | "wrong-track" };

const MALFORMED = { ok: false, cause: "malformed-feed" } as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReleaseDate(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const canonical = new Date(time).toISOString();
  // Date.parse rolls some impossible dates (and 24:00) into the next day.
  return canonical.slice(0, 19) === value.slice(0, 19) ? canonical : null;
}

/**
 * Checks a feed's text. The file for `key` must be on the feed's own origin
 * and readable by the same rule as the feed.
 */
export function parseFeed(
  text: string,
  feedUrl: URL,
  key: FileKey | null,
  loopback?: LoopbackHttpForTests,
  track: UpdateTrack = "stable",
): FeedRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return MALFORMED;
  }
  if (!isObject(raw) || raw.format !== FEED_FORMAT) return MALFORMED;
  const version = parseVersion(raw.version);
  const releaseDate = parseReleaseDate(raw.releaseDate);
  if (!version || !releaseDate || !isObject(raw.files)) return MALFORMED;
  if (raw.track !== "stable" && raw.track !== "nightly") return MALFORMED;
  if (raw.track !== track || versionTrack(version) !== track)
    return { ok: false, cause: "wrong-track" };
  // Every entry is checked, not only this system's, so a feed is good or not
  // the same way on every system.
  let file: FeedFile | null = null;
  for (const [name, entry] of Object.entries(raw.files)) {
    if (!(FILE_KEYS as readonly string[]).includes(name) || !isObject(entry)) return MALFORMED;
    const { url: urlText, size, sha512 } = entry;
    if (typeof urlText !== "string" || typeof sha512 !== "string") return MALFORMED;
    if (!Number.isSafeInteger(size) || (size as number) <= 0 || !SHA512_BASE64.test(sha512)) {
      return MALFORMED;
    }
    let url: URL;
    try {
      url = new URL(urlText);
    } catch {
      return MALFORMED;
    }
    if (url.origin !== feedUrl.origin || !readable(url, loopback)) {
      return { ok: false, cause: "address-refused" };
    }
    if (name === key) file = { url, size: size as number, sha512 };
  }
  return { ok: true, feed: { version, releaseDate, file } };
}

/** The feed's key for a Node platform and architecture, or null for a system no build exists for. */
export function fileKeyFor(platform: string, arch: string): FileKey | null {
  const os = platform === "darwin" ? "mac" : platform === "win32" ? "win" : null;
  const key = os && `${os}-${arch}`;
  return (FILE_KEYS as readonly string[]).includes(key ?? "") ? (key as FileKey) : null;
}
