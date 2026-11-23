// #300's strict picture reader, as merged (043501bb, packages/core/src/avatar.ts
// lines 182-467), copied unchanged but for this header, its imports and #300's
// lists, inlined below so a later change to the spec can't change this reader: only
// `readPicture` is exported, and `toBase64`, which only the writer used, is left out. It stands in for an older Clawtrate in the
// interoperability checks: what it makes of a picture this build writes is what
// every client released before version 2 shows. Do not edit; it is a fixed point.
import type { AvatarChoice } from "../src/avatar.ts";

// #300's own lists, inlined so a later change to the spec can't change this reader.
const AVATAR_FAMILIES = ["clawling", "shellfolk", "lantern"] as const;
const AVATAR_COLOR_NAMES = ["green", "blue", "orchid", "violet", "yellow", "pink", "sky", "lime"];
const AVATAR_PARTS = {
  clawling: {
    body: ["dome", "tall", "wide", "round"],
    eyes: ["pair", "splayed", "short", "single"],
    claws: ["even", "fiddler", "big"],
  },
  shellfolk: { shell: ["spiral", "turret", "dome", "spotted"] },
  lantern: {
    body: ["round", "bell", "oval", "box"],
    lure: ["hook", "flick", "wave", "reach"],
    eyes: ["two", "one"],
  },
} as const;

/** The choice in a text form, or null when anything in it is unknown, repeated or missing. */
function decodeAvatarChoice(text: string): AvatarChoice | null {
  if (text.length > MAX_CHOICE_CHARS) return null;
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  const pairs = text.split("&");
  // `v` and `family`, the family's parts (three at most) and `color`.
  if (pairs.length > 6) return null;
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) return null;
    const key = pair.slice(0, at);
    if (Object.hasOwn(fields, key)) return null;
    fields[key] = pair.slice(at + 1);
  }
  if (fields.v !== "1") return null;
  delete fields.v;
  return parseAvatarChoice(fields);
}

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

/**
 * A choice from untrusted input, such as a bot asking to change its own avatar:
 * an object with `family`, exactly that family's parts and `color`, each one of
 * the names above. Null for anything else, an inherited or extra field included.
 */
function parseAvatarChoice(input: unknown): AvatarChoice | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const own = (key: string) => (Object.hasOwn(value, key) ? value[key] : undefined);
  const family = own("family");
  const color = own("color");
  if (!oneOf(AVATAR_FAMILIES, family) || !oneOf(AVATAR_COLOR_NAMES, color)) return null;
  const parts = AVATAR_PARTS[family] as Record<string, readonly string[]>;
  const partKeys = Object.keys(parts);
  const keys = Object.keys(value);
  if (keys.length !== partKeys.length + 2) return null;
  const choice: Record<string, string> = Object.create(null) as Record<string, string>;
  choice.family = family;
  for (const key of partKeys) {
    const part = own(key);
    if (!Object.hasOwn(parts, key) || !oneOf(parts[key]!, part)) return null;
    choice[key] = part;
  }
  choice.color = color;
  return { ...choice } as AvatarChoice;
}

// Kept with the bot: inside its picture -------------------------------------------------

/**
 * The gateway keeps a bot's picture in its identity (`agents.create` and
 * `agents.update`, `avatar`). A chosen creature is kept there too: a PNG of
 * its still pose, which any other client shows as a picture, carrying the
 * choice in a text chunk under this keyword, which Clawtrate reads back.
 */
const AVATAR_PNG_KEYWORD = "clawtrate-avatar";
/**
 * The longest picture Clawtrate writes, or reads a choice from: the data URL,
 * prefix included. Within what the gateway keeps.
 */
const MAX_PICTURE_CHARS = 32_768;
/** The longest text form of a choice. */
const MAX_CHOICE_CHARS = 200;
/** Chunks a picture may have before it is refused. */
const MAX_PNG_CHUNKS = 128;
/** The widest and tallest picture taken. */
const MAX_PNG_SIDE = 8192;
const PNG_PREFIX = "data:image/png;base64,";
/** A PNG data URL's prefix, in any case, as the bot list takes it (`safeAvatarUrl`). */
const isPngUrl = (url: string) => /^data:image\/png;base64,/i.test(url);
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const KEYWORD_BYTES = [...AVATAR_PNG_KEYWORD].map((char) => char.charCodeAt(0));

/** Canonical base64 only: the right alphabet, length and padding, and zero pad bits. */
function fromBase64(text: string): Uint8Array | null {
  if (
    text.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
  )
    return null;
  const clean = text.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const char of clean) {
    value = ((value << 6) | B64.indexOf(char)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 0xff;
    }
  }
  // Bits left over from the last character must be zero.
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) return null;
  return out.subarray(0, at);
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

type PngChunk = { type: string; start: number; end: number; data: Uint8Array };

const u32 = (bytes: Uint8Array, at: number) =>
  ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
const isLetter = (byte: number) => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
/** Known ancillary chunks that must come before PLTE and the image data (the PNG specification's ordering). */
const BEFORE_PALETTE = new Set(["cHRM", "gAMA", "iCCP", "sBIT", "sRGB", "cICP", "mDCV", "cLLI"]);
/** Known ancillary chunks that must come before the image data; the last three also after any PLTE. */
const BEFORE_DATA = new Set(["pHYs", "sPLT", "eXIf", "bKGD", "hIST", "tRNS"]);
const AFTER_PALETTE = new Set(["bKGD", "hIST", "tRNS"]);

/** Whether a colour type allows a bit depth (the PNG specification's table). */
function depthAllowed(colour: number, depth: number): boolean {
  switch (colour) {
    case 0:
      return depth === 1 || depth === 2 || depth === 4 || depth === 8 || depth === 16;
    case 3:
      return depth === 1 || depth === 2 || depth === 4 || depth === 8;
    case 2:
    case 4:
    case 6:
      return depth === 8 || depth === 16;
    default:
      return false;
  }
}

/**
 * The chunks of a well-formed PNG, or null. At most `MAX_PNG_CHUNKS`; every
 * length within the file and every CRC right; type bytes letters with the
 * reserved bit clear; one 13-byte IHDR first with supported fields and sides
 * of 1 to `MAX_PNG_SIDE`; at most one PLTE, before the image data; one run of
 * IDAT; a zero-length IEND last, with nothing after it; no other critical chunk.
 */
function pngChunks(bytes: Uint8Array): PngChunk[] | null {
  if (bytes.length < 8 || PNG_SIGNATURE.some((byte, i) => bytes[i] !== byte)) return null;
  const chunks: PngChunk[] = [];
  let at = 8;
  let idat: "before" | "in" | "after" = "before";
  let palette = false;
  let paletteClosed = false;
  let colour = -1;
  let depth = 0;
  // The first two bytes of the image data, across however many IDAT chunks they span.
  const stream: number[] = [];
  while (at < bytes.length) {
    if (chunks.length >= MAX_PNG_CHUNKS || at + 12 > bytes.length) return null;
    const length = u32(bytes, at);
    const end = at + 12 + length;
    if (length > bytes.length || end > bytes.length) return null;
    const typeBytes = bytes.subarray(at + 4, at + 8);
    if (!typeBytes.every(isLetter) || (typeBytes[2]! & 0x20) !== 0) return null;
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== u32(bytes, at + 8 + length)) return null;
    const type = String.fromCharCode(typeBytes[0]!, typeBytes[1]!, typeBytes[2]!, typeBytes[3]!);
    const data = bytes.subarray(at + 8, at + 8 + length);
    const critical = (typeBytes[0]! & 0x20) === 0;
    if (chunks.length === 0 && type !== "IHDR") return null;
    if (type === "IHDR") {
      if (chunks.length !== 0 || length !== 13) return null;
      const width = u32(data, 0);
      const height = u32(data, 4);
      const [d, c, compression, filter, interlace] = data.subarray(8);
      if (width < 1 || height < 1 || width > MAX_PNG_SIDE || height > MAX_PNG_SIDE) return null;
      if (!depthAllowed(c!, d!) || compression !== 0 || filter !== 0) return null;
      if (interlace !== 0 && interlace !== 1) return null;
      [colour, depth] = [c!, d!];
    } else if (type === "PLTE") {
      // Not for greyscale; at most 256 entries, and no more than an indexed image's depth can name.
      const entries = length / 3;
      if (palette || idat !== "before" || length === 0 || length % 3 !== 0) return null;
      if (colour === 0 || colour === 4 || entries > 256) return null;
      if (colour === 3 && entries > 2 ** depth) return null;
      // tRNS and bKGD come after a palette when there is one, so a palette after them is out of order.
      if (paletteClosed) return null;
      palette = true;
    } else if (type === "IDAT") {
      if (idat === "after" || (colour === 3 && !palette)) return null;
      idat = "in";
      for (let k = 0; k < data.length && stream.length < 2; k++) stream.push(data[k]!);
    } else if (type === "IEND") {
      if (length !== 0 || idat === "before" || end !== bytes.length) return null;
      if (!zlibHeader(stream)) return null;
      chunks.push({ type, start: at, end, data });
      return chunks;
    } else if (critical) {
      return null;
    } else if (BEFORE_PALETTE.has(type)) {
      if (palette || idat !== "before") return null;
    } else if (BEFORE_DATA.has(type)) {
      if (idat !== "before") return null;
      if (AFTER_PALETTE.has(type) && colour === 3 && !palette) return null;
      // A histogram describes a palette, so it needs one before it.
      if (type === "hIST" && !palette) return null;
      if (AFTER_PALETTE.has(type) && !palette) paletteClosed = true;
    }
    if (type !== "IDAT" && idat === "in") idat = "after";
    chunks.push({ type, start: at, end, data });
    at = end;
  }
  return null;
}

/** Whether image data starts with a zlib header PNG allows: deflate, a window up to 32 KiB, no preset dictionary. */
function zlibHeader([cmf, flg]: number[]): boolean {
  if (cmf === undefined || flg === undefined) return false;
  return (cmf & 0x0f) === 8 && cmf >> 4 <= 7 && (cmf * 256 + flg) % 31 === 0 && (flg & 0x20) === 0;
}

/** Whether a tEXt chunk is Clawtrate's: the keyword's bytes, then the NUL at its exact length. */
function isChoiceChunk(chunk: PngChunk): boolean {
  return (
    chunk.type === "tEXt" &&
    chunk.data.length > KEYWORD_BYTES.length &&
    KEYWORD_BYTES.every((byte, i) => chunk.data[i] === byte) &&
    chunk.data[KEYWORD_BYTES.length] === 0
  );
}

/** The choice text a chunk carries: at most 200 printable ASCII bytes, or null. */
function choiceText(chunk: PngChunk): string | null {
  const value = chunk.data.subarray(KEYWORD_BYTES.length + 1);
  if (value.length === 0 || value.length > MAX_CHOICE_CHARS) return null;
  let text = "";
  for (const byte of value) {
    if (byte < 0x20 || byte > 0x7e) return null;
    text += String.fromCharCode(byte);
  }
  return text;
}

/** What a PNG data URL from the gateway is: someone's own picture, a creature, or not a picture to show. */
type PictureRead =
  { kind: "plain" } | { kind: "creature"; choice: AvatarChoice } | { kind: "invalid" };

type ReadPng = { read: PictureRead; bytes: Uint8Array; chunks: PngChunk[] };

function readPng(url: string): ReadPng | null {
  if (url.length > MAX_PICTURE_CHARS || !isPngUrl(url)) return null;
  const bytes = fromBase64(url.slice(PNG_PREFIX.length));
  const chunks = bytes && pngChunks(bytes);
  if (!bytes || !chunks) return null;
  const marked = chunks.filter(isChoiceChunk);
  if (marked.length === 0) return { read: { kind: "plain" }, bytes, chunks };
  if (marked.length > 1) return null;
  const text = choiceText(marked[0]!);
  const choice = text === null ? null : decodeAvatarChoice(text);
  return choice ? { read: { kind: "creature", choice }, bytes, chunks } : null;
}

/**
 * Read a PNG data URL: a plain picture, a creature picture with its choice, or
 * invalid (too long, not canonical base64, not a well-formed PNG, or carrying
 * a choice that is not one). The whole file is checked before a choice is returned.
 */
export function readPicture(url: string): PictureRead {
  return readPng(url)?.read ?? { kind: "invalid" };
}
