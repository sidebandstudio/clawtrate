// Bot avatars (docs/design/visual-language.md, section 5): Clawtrate's three
// creature families on one 40-unit grid, Clawlings, Shellfolk and Lanterns.
//
// Platform-neutral on purpose. Shapes are plain data (path data, circles,
// ellipses, rects and groups), motion is keyframe data, and the choice a person
// makes is a small record with a text encoding. The desktop and web renderer
// (`packages/ui/src/Avatar.tsx`) turns a scene into SVG and the keyframes into
// CSS; the iOS app can turn the same scene into `react-native-svg` elements.
//
// This file imports nothing, so the design prototype can load it with its
// types stripped (`docs/design/prototype/js/creatures.js`).

// Families, parts and colours ----------------------------------------------------------

export const AVATAR_FAMILIES = ["clawling", "shellfolk", "lantern"] as const;
export type AvatarFamily = (typeof AVATAR_FAMILIES)[number];

/**
 * The bot colours. Their order is the order the previous characters hashed
 * into, so a bot keeps its colour; orange gave way to orchid (the palette
 * guard, `isGuardedColor`).
 */
export const AVATAR_COLORS = {
  green: "#58c26f",
  blue: "#5b8dff",
  orchid: "#cf7ee8",
  violet: "#a98bff",
  yellow: "#f6bd3b",
  pink: "#ff6f9c",
  sky: "#45bdf5",
  lime: "#a5d955",
} as const;
export type AvatarColor = keyof typeof AVATAR_COLORS;
export const AVATAR_COLOR_NAMES = Object.keys(AVATAR_COLORS) as AvatarColor[];

export const CLAWLING_BODIES = ["dome", "tall", "wide", "round"] as const;
export const CLAWLING_EYES = ["pair", "splayed", "short", "single"] as const;
export const CLAWLING_CLAWS = ["even", "fiddler", "big"] as const;
export const SHELLFOLK_SHELLS = ["spiral", "turret", "dome", "spotted"] as const;
export const LANTERN_BODIES = ["round", "bell", "oval", "box"] as const;
export const LANTERN_LURES = ["hook", "flick", "wave", "reach"] as const;
export const LANTERN_EYES = ["two", "one"] as const;

export type ClawlingBody = (typeof CLAWLING_BODIES)[number];
export type ClawlingEyes = (typeof CLAWLING_EYES)[number];
export type ClawlingClaws = (typeof CLAWLING_CLAWS)[number];
export type ShellfolkShell = (typeof SHELLFOLK_SHELLS)[number];
export type LanternBody = (typeof LANTERN_BODIES)[number];
export type LanternLure = (typeof LANTERN_LURES)[number];
export type LanternEyes = (typeof LANTERN_EYES)[number];

/**
 * What a person, or a bot editing itself, chooses: a family, its parts and a
 * colour, and what it wears. Every field is one of the names above.
 */
export type AvatarChoice = (
  | {
      family: "clawling";
      body: ClawlingBody;
      eyes: ClawlingEyes;
      claws: ClawlingClaws;
      color: AvatarColor;
    }
  | { family: "shellfolk"; shell: ShellfolkShell; color: AvatarColor }
  | {
      family: "lantern";
      body: LanternBody;
      lure: LanternLure;
      eyes: LanternEyes;
      color: AvatarColor;
    }
) &
  AvatarAccessories;

// Accessories (docs/design/avatar-studio.md, section 4): one per slot, each slot optional.

export const AVATAR_HEADWEAR = ["beanie", "beret", "party", "crown", "headphones"] as const;
export const AVATAR_FACEWEAR = ["glasses", "shades"] as const;
export const AVATAR_NECKWEAR = ["bowtie"] as const;
export type AvatarHeadwear = (typeof AVATAR_HEADWEAR)[number];
export type AvatarFacewear = (typeof AVATAR_FACEWEAR)[number];
export type AvatarNeckwear = (typeof AVATAR_NECKWEAR)[number];
/** The three lists by slot, in picker order. */
export const AVATAR_ACCESSORIES = {
  head: AVATAR_HEADWEAR,
  face: AVATAR_FACEWEAR,
  neck: AVATAR_NECKWEAR,
} as const;
const SLOTS = ["head", "face", "neck"] as const;

/** What a Claw wears, and in which colour; without `trim` it is `AVATAR_TRIM_DEFAULT`. */
export type AvatarAccessories = {
  head?: AvatarHeadwear;
  face?: AvatarFacewear;
  neck?: AvatarNeckwear;
  trim?: AvatarColor;
};

/** The accessories' colour when a choice names none: one of the eight, never the body's own. */
export const AVATAR_TRIM_DEFAULT: Record<AvatarColor, AvatarColor> = {
  green: "violet",
  blue: "yellow",
  orchid: "sky",
  violet: "lime",
  yellow: "blue",
  pink: "sky",
  sky: "pink",
  lime: "violet",
};
/** The crown's colour whatever the trim: the palette's yellow, rimmed with `shade(gold, 0.3)`. */
export const AVATAR_GOLD = AVATAR_COLORS.yellow;

const wears = (choice: AvatarChoice) => SLOTS.some((slot) => choice[slot] !== undefined);
const trimOf = (choice: AvatarChoice) => choice.trim ?? AVATAR_TRIM_DEFAULT[choice.color];

/** Each family's parts, in picker order. `color` is common to all three. */
export const AVATAR_PARTS = {
  clawling: { body: CLAWLING_BODIES, eyes: CLAWLING_EYES, claws: CLAWLING_CLAWS },
  shellfolk: { shell: SHELLFOLK_SHELLS },
  lantern: { body: LANTERN_BODIES, lure: LANTERN_LURES, eyes: LANTERN_EYES },
} as const;

/** The first choice of each family, used when the person switches family. */
export function firstChoice(family: AvatarFamily, color: AvatarColor): AvatarChoice {
  if (family === "shellfolk") return { family, shell: "spiral", color };
  if (family === "lantern") return { family, body: "round", lure: "hook", eyes: "two", color };
  return { family, body: "dome", eyes: "pair", claws: "even", color };
}

// Fixed inks ---------------------------------------------------------------------------

/** Pupils and mouths. */
export const AVATAR_INK = "#16181b";
/** Eye whites. */
export const AVATAR_WHITE = "#ffffff";
/** The white ball from the Clawtrate logo: a Clawling's done, a Lantern's lure. */
export const AVATAR_BALL = "#f6f5f2";
/** The ball's rim, so it holds on a light page as well as a dark one. */
export const AVATAR_BALL_RIM = "#c9c6bf";
/** A Lantern's ball gone dark when it is blocked. */
export const AVATAR_BALL_DIM = "#7d8085";
/** The Shellfolk critter, the same on every bot; the shell carries the colour. */
export const SHELLFOLK_CREAM = "#ecd8bd";

/** Below this rendered size the fine details are dropped (`AvatarShape.fine`). */
export const AVATAR_FINE_MIN_PX = 21;

// States -------------------------------------------------------------------------------

export const AVATAR_STATES = ["idle", "thinking", "working", "waiting", "blocked", "done"] as const;
export type AvatarState = (typeof AVATAR_STATES)[number];

/** A presence state to its pose: failed looks blocked, stopped looks idle. */
export function avatarPose(state: string): AvatarState {
  if (state === "failed") return "blocked";
  if ((AVATAR_STATES as readonly string[]).includes(state)) return state as AvatarState;
  return "idle";
}

// Choosing from a bot's id ------------------------------------------------------------

/** FNV-1a with a final mix: the hash the previous characters used, so choices stay put. */
export function avatarHash(text: string): number {
  let h = 0x811c9dc5;
  for (const char of text) {
    h ^= char.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function pick<T>(list: readonly T[], id: string, salt: string): T {
  return list[avatarHash(`${id}:${salt}`) % list.length]!;
}

/** The Clawling a bot without a chosen avatar gets. Stable across devices and restarts. */
export function defaultAvatar(id: string): AvatarChoice {
  return {
    family: "clawling",
    body: pick(CLAWLING_BODIES, id, "body"),
    eyes: pick(CLAWLING_EYES, id, "eyes"),
    claws: pick(CLAWLING_CLAWS, id, "claws"),
    color: pick(AVATAR_COLOR_NAMES, id, "colour"),
  };
}

/** What makes two bots with the same choice still differ: where they look, and when they blink. */
export type AvatarVariation = {
  /** The pupils' offset at rest, in grid units. */
  gaze: [number, number];
  /** Milliseconds before the first blink. */
  blink: number;
};

// Adding 0 turns a negative zero into zero, so equal values compare and print equal.
const round2 = (n: number) => Math.round(n * 100) / 100 + 0;

export function avatarVariation(id: string): AvatarVariation {
  const angle = ((avatarHash(`${id}:look`) % 8) / 8) * Math.PI * 2;
  return {
    gaze: [round2(Math.cos(angle) * 0.82), round2(0.25 + Math.sin(angle) * 0.45)],
    blink: (avatarHash(`${id}:blink`) % 7) * 800,
  };
}

// The text form ------------------------------------------------------------------------

/** The newest version of the text form: version 2 adds what the Claw wears. */
export const AVATAR_CHOICE_VERSION = 2;

/**
 * The text form of a choice, as kept with the bot. Fields in a fixed order;
 * values are the part names. A Claw wearing nothing is version 1, exactly as
 * before: `v=1&family=clawling&body=dome&…&color=blue`. One wearing anything
 * is version 2, the same fields, then `head`, `face` and `neck` as worn, then
 * `trim`, always: `v=2&…&color=blue&head=beret&trim=yellow`.
 */
export function encodeAvatarChoice(choice: AvatarChoice): string {
  const fields: string[] = [`family=${choice.family}`];
  if (choice.family === "clawling")
    fields.push(`body=${choice.body}`, `eyes=${choice.eyes}`, `claws=${choice.claws}`);
  else if (choice.family === "shellfolk") fields.push(`shell=${choice.shell}`);
  else fields.push(`body=${choice.body}`, `lure=${choice.lure}`, `eyes=${choice.eyes}`);
  fields.push(`color=${choice.color}`);
  if (!wears(choice)) return ["v=1", ...fields].join("&");
  for (const slot of SLOTS) if (choice[slot]) fields.push(`${slot}=${choice[slot]}`);
  // A crown alone is gold whatever the trim, so it always carries the default (section 4).
  const crownAlone = choice.head === "crown" && !choice.face && !choice.neck;
  fields.push(`trim=${crownAlone ? AVATAR_TRIM_DEFAULT[choice.color] : trimOf(choice)}`);
  return [`v=${AVATAR_CHOICE_VERSION}`, ...fields].join("&");
}

/** The choice in either version's text form, or null when anything in it is unknown, repeated or missing. */
export function decodeAvatarChoice(text: string): AvatarChoice | null {
  return text.startsWith("v=2&") ? decodeV2(text) : decodeV1(text);
}

const alt = (list: readonly string[]) => `(?:${list.join("|")})`;
const COLOR = alt(AVATAR_COLOR_NAMES);
/**
 * Version 2, exactly: the family's fields in order, then any of head, face
 * and neck in that order, then trim. Literal characters and case, so no
 * repeats, extras, empties, `none`, spaces, escapes or bytes outside ASCII.
 */
const V2_GRAMMAR = new RegExp(
  "^v=2&(?:" +
    [
      `family=clawling&body=${alt(CLAWLING_BODIES)}&eyes=${alt(CLAWLING_EYES)}&claws=${alt(CLAWLING_CLAWS)}&color=${COLOR}`,
      `family=shellfolk&shell=${alt(SHELLFOLK_SHELLS)}&color=${COLOR}`,
      `family=lantern&body=${alt(LANTERN_BODIES)}&lure=${alt(LANTERN_LURES)}&eyes=${alt(LANTERN_EYES)}&color=${COLOR}`,
    ].join("|") +
    `)(?:&head=${alt(AVATAR_HEADWEAR)})?(?:&face=${alt(AVATAR_FACEWEAR)})?(?:&neck=${alt(AVATAR_NECKWEAR)})?&trim=${COLOR}$`,
);

/** A version 2 text, matching the grammar (so at most 123 bytes), wearing something and written as this build writes it, as a fresh choice; otherwise null. */
function decodeV2(text: string): AvatarChoice | null {
  if (!V2_GRAMMAR.test(text)) return null;
  const fields: Record<string, string> = {};
  for (const pair of text.split("&").slice(1)) {
    const at = pair.indexOf("=");
    fields[pair.slice(0, at)] = pair.slice(at + 1);
  }
  if (!SLOTS.some((slot) => Object.hasOwn(fields, slot))) return null;
  const choice = parseAvatarChoice(fields);
  // One text per Claw: only the text this build writes for it is read.
  return choice && encodeAvatarChoice(choice) === text ? choice : null;
}

/** A version 1 text, read by #300's rules: nothing worn, nothing else. */
function decodeV1(text: string): AvatarChoice | null {
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
  return parseBase(fields, 0);
}

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

const WEAR_KEYS = [...SLOTS, "trim"] as const;

/**
 * A choice from untrusted input, such as a bot asking to change its own avatar:
 * an object with `family`, exactly that family's parts and `color`, and any of
 * `head`, `face`, `neck` and `trim`, each one of the names above. A trim needs
 * something worn to colour. Null for anything else, `"none"`, null and an
 * inherited or extra field included.
 */
export function parseAvatarChoice(input: unknown): AvatarChoice | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (WEAR_KEYS.some((key) => key in value && !Object.hasOwn(value, key))) return null;
  const worn = WEAR_KEYS.filter((key) => Object.hasOwn(value, key));
  const base = parseBase(value, worn.length);
  if (!base) return null;
  const choice: Record<string, string> = { ...base };
  for (const key of worn) {
    const part = value[key];
    if (!oneOf(key === "trim" ? AVATAR_COLOR_NAMES : AVATAR_ACCESSORIES[key], part)) return null;
    choice[key] = part;
  }
  if (worn.length > 0 && !wears(choice as AvatarChoice)) return null;
  return choice as AvatarChoice;
}

/** `family`, exactly that family's parts and `color`, and `extra` other own keys, or null. */
function parseBase(value: Record<string, unknown>, extra: number): AvatarChoice | null {
  const own = (key: string) => (Object.hasOwn(value, key) ? value[key] : undefined);
  const family = own("family");
  const color = own("color");
  if (!oneOf(AVATAR_FAMILIES, family) || !oneOf(AVATAR_COLOR_NAMES, color)) return null;
  const parts = AVATAR_PARTS[family] as Record<string, readonly string[]>;
  const partKeys = Object.keys(parts);
  const keys = Object.keys(value);
  if (keys.length !== partKeys.length + 2 + extra) return null;
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
export const AVATAR_PNG_KEYWORD = "clawtrate-avatar";
/**
 * The keyword of a choice that wears something (version 2). A Clawtrate that
 * knows only the first keyword sees no tag of its own and shows the picture,
 * accessories and all, still; under the first keyword it would refuse it.
 */
export const AVATAR_PNG_KEYWORD_V2 = "clawtrate-avatar-v2";
/**
 * The longest picture Clawtrate writes, or reads a choice from: the data URL,
 * prefix included. Within what the gateway keeps.
 */
export const MAX_PICTURE_CHARS = 32_768;
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
const KEYWORD_V2_BYTES = [...AVATAR_PNG_KEYWORD_V2].map((char) => char.charCodeAt(0));

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

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : "=";
    out += i + 2 < bytes.length ? B64[n & 63]! : "=";
  }
  return out;
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

/**
 * Which of Clawtrate's tags a chunk is: version 1 (#300's rule, unchanged),
 * version 2 (its keyword and the NUL), or a broken version 2 tag (its keyword
 * with no separator anywhere), which no reader may pass over. Null otherwise.
 */
function tagOf(chunk: PngChunk): "v1" | "v2" | "broken" | null {
  if (isChoiceChunk(chunk)) return "v1";
  if (chunk.type !== "tEXt" || !KEYWORD_V2_BYTES.every((byte, i) => chunk.data[i] === byte))
    return null;
  if (chunk.data[KEYWORD_V2_BYTES.length] === 0) return "v2";
  return chunk.data.includes(0) ? null : "broken";
}

/** The choice text after a keyword: at most 200 printable ASCII bytes, or null. */
function choiceText(chunk: PngChunk, keyword: number[]): string | null {
  const value = chunk.data.subarray(keyword.length + 1);
  if (value.length === 0 || value.length > MAX_CHOICE_CHARS) return null;
  let text = "";
  for (const byte of value) {
    if (byte < 0x20 || byte > 0x7e) return null;
    text += String.fromCharCode(byte);
  }
  return text;
}

/** What a PNG data URL from the gateway is: someone's own picture, a creature, or not a picture to show. */
export type PictureRead =
  { kind: "plain" } | { kind: "creature"; choice: AvatarChoice } | { kind: "invalid" };

/** A well-formed PNG data URL within the limit as its bytes and chunks, whatever tags it carries; or null. */
function pngOf(url: string): { bytes: Uint8Array; chunks: PngChunk[] } | null {
  if (url.length > MAX_PICTURE_CHARS || !isPngUrl(url)) return null;
  const bytes = fromBase64(url.slice(PNG_PREFIX.length));
  const chunks = bytes && pngChunks(bytes);
  return bytes && chunks ? { bytes, chunks } : null;
}

function readPng(url: string): PictureRead | null {
  const marked = pngOf(url)?.chunks.filter((chunk) => tagOf(chunk) !== null);
  if (!marked) return null;
  if (marked.length === 0) return { kind: "plain" };
  // Two tags, of either keyword or both, are not one choice.
  if (marked.length > 1) return null;
  const tag = tagOf(marked[0]!);
  if (tag === "broken") return null;
  const text = choiceText(marked[0]!, tag === "v1" ? KEYWORD_BYTES : KEYWORD_V2_BYTES);
  const choice = text === null ? null : tag === "v1" ? decodeV1(text) : decodeV2(text);
  return choice ? { kind: "creature", choice } : null;
}

/**
 * Read a PNG data URL: a plain picture, a creature picture with its choice, or
 * invalid (too long, not canonical base64, not a well-formed PNG, or carrying
 * a choice that is not one). The whole file is checked before a choice is returned.
 */
export function readPicture(url: string): PictureRead {
  return readPng(url) ?? { kind: "invalid" };
}

/** The choice a picture carries, or null for any other picture. */
export function choiceFromPicture(url: string | null): AvatarChoice | null {
  if (!url) return null;
  const read = readPicture(url);
  return read.kind === "creature" ? read.choice : null;
}

/** Whether a picture may be sent to the gateway: a well-formed PNG data URL within the limit. */
export function isKeepablePicture(url: string): boolean {
  return readPicture(url).kind !== "invalid";
}

/**
 * A PNG data URL with the choice written into it, right after its header,
 * replacing every tag it carried, either keyword's or a broken one: under
 * `AVATAR_PNG_KEYWORD` when nothing is worn, under `AVATAR_PNG_KEYWORD_V2`
 * when anything is. Null when the URL is not a well-formed PNG, the choice's
 * text would not read back, or the result would be longer than `MAX_PICTURE_CHARS`.
 */
export function pictureWithChoice(url: string, choice: AvatarChoice): string | null {
  const png = pngOf(url);
  if (!png) return null;
  const { bytes, chunks } = png;
  const keyword = wears(choice) ? AVATAR_PNG_KEYWORD_V2 : AVATAR_PNG_KEYWORD;
  const text = `${keyword}\0${encodeAvatarChoice(choice)}`;
  // Never write a tag this reader refuses: the bot would show its id's Clawling instead.
  if (!decodeAvatarChoice(encodeAvatarChoice(choice))) return null;
  const body = new Uint8Array(4 + text.length);
  for (let i = 0; i < text.length; i++) body[4 + i] = text.charCodeAt(i);
  body.set([0x74, 0x45, 0x58, 0x74], 0); // "tEXt"
  const chunk = new Uint8Array(12 + text.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, text.length);
  chunk.set(body, 4);
  view.setUint32(8 + text.length, crc32(body));
  const kept = chunks.filter((each) => tagOf(each) === null);
  // The choice is one chunk more: a picture already at the reader's limit can't take it.
  if (kept.length + 1 > MAX_PNG_CHUNKS) return null;
  const parts = [bytes.subarray(0, 8), bytes.subarray(kept[0]!.start, kept[0]!.end), chunk];
  for (const each of kept.slice(1)) parts.push(bytes.subarray(each.start, each.end));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  const result = PNG_PREFIX + toBase64(out);
  return result.length <= MAX_PICTURE_CHARS ? result : null;
}

/** What a bot's avatar is: its chosen or default creature, or its own picture. */
export type BotAvatar =
  { kind: "creature"; choice: AvatarChoice; chosen: boolean } | { kind: "image"; url: string };

const read = new Map<string, PictureRead>();

/**
 * A bot's avatar from its id and the picture its gateway identity carries. A
 * PNG is read: a creature's picture draws the creature, a plain one is shown,
 * and one that is not well formed gets the Clawling the id gives. Pictures of
 * other kinds are shown as they are.
 */
export function avatarFor(bot: { id: string; avatarUrl: string | null }): BotAvatar {
  const url = bot.avatarUrl;
  const fallback: BotAvatar = { kind: "creature", choice: defaultAvatar(bot.id), chosen: false };
  if (!url) return fallback;
  if (!isPngUrl(url)) return { kind: "image", url };
  if (url.length > MAX_PICTURE_CHARS) return fallback;
  let result = read.get(url);
  if (result === undefined) {
    result = readPicture(url);
    if (read.size >= 64) read.delete(read.keys().next().value!);
    read.set(url, result);
  }
  if (result.kind === "creature") return { kind: "creature", choice: result.choice, chosen: true };
  return result.kind === "plain" ? { kind: "image", url } : fallback;
}

// The palette guard --------------------------------------------------------------------

function hsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

/**
 * True for a colour that would read as a red lobster (OpenClaw's mascot) or an
 * orange crab (Rust's Ferris): a saturated, mid-light hue from red through
 * orange, 345° to 38°. No creature is drawn in one.
 */
export function isGuardedColor(hex: string): boolean {
  const [h, s, l] = hsl(hex);
  return (h >= 345 || h <= 38) && s >= 0.4 && l >= 0.25 && l <= 0.75;
}

/** A colour darkened toward black by `amount` (0 to 1): shell patterns and openings. */
export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const channel = (c: number) =>
    Math.round(c * (1 - amount))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(n >> 16)}${channel((n >> 8) & 255)}${channel(n & 255)}`;
}

// Motion -------------------------------------------------------------------------------

export type AvatarMotionName =
  | "blink"
  | "blink-large"
  | "sway"
  | "bob"
  | "lean"
  | "hop"
  | "snap"
  | "wave"
  | "crawl"
  | "tilt"
  | "lure-sway"
  | "conduct"
  | "ping"
  | "glow"
  | "tip";

/** One keyframe. Transforms are about the shape's `origin`, in grid units and degrees. */
export type AvatarKeyframe = {
  /** 0 to 1 through the loop. */
  at: number;
  rotate?: number;
  translate?: [number, number];
  scale?: number;
  opacity?: number;
  /** A claw's stroke dash, of a path length of 100. */
  dash?: [number, number];
  dashOffset?: number;
};

export type AvatarMotion = {
  /** One loop, in milliseconds. Every motion loops for as long as the state lasts. */
  duration: number;
  /** A cubic Bézier, as CSS `cubic-bezier()` takes it. */
  easing: [number, number, number, number];
  frames: AvatarKeyframe[];
};

const SMOOTH: [number, number, number, number] = [0.45, 0, 0.55, 1];
const swing = (from: number, to: number) => [
  { at: 0, rotate: from },
  { at: 0.5, rotate: to },
  { at: 1, rotate: from },
];
const blink = (by: number): AvatarKeyframe[] => [
  { at: 0, translate: [0, 0] },
  { at: 0.91, translate: [0, 0] },
  { at: 0.935, translate: [0, by] },
  { at: 0.96, translate: [0, 0] },
  { at: 1, translate: [0, 0] },
];

export const AVATAR_MOTIONS: Record<AvatarMotionName, AvatarMotion> = {
  blink: { duration: 5600, easing: [0.25, 0.1, 0.25, 1], frames: blink(6.7) },
  "blink-large": { duration: 5600, easing: [0.25, 0.1, 0.25, 1], frames: blink(7.3) },
  sway: { duration: 2600, easing: SMOOTH, frames: swing(-4, 4) },
  bob: {
    duration: 600,
    easing: SMOOTH,
    frames: [
      { at: 0, translate: [0, 0] },
      { at: 0.5, translate: [0, -1.4] },
      { at: 1, translate: [0, 0] },
    ],
  },
  lean: {
    duration: 2600,
    easing: SMOOTH,
    frames: [
      { at: 0, scale: 1 },
      { at: 0.45, scale: 1.07 },
      { at: 0.6, scale: 1.07 },
      { at: 1, scale: 1 },
    ],
  },
  hop: {
    duration: 3200,
    easing: [0.3, 0, 0.2, 1],
    frames: [
      { at: 0, translate: [0, 0] },
      { at: 0.04, translate: [0, 0] },
      { at: 0.1, translate: [0, -2.8] },
      { at: 0.16, translate: [0, 0] },
      { at: 0.2, translate: [0, -0.9] },
      { at: 0.24, translate: [0, 0] },
      { at: 1, translate: [0, 0] },
    ],
  },
  snap: {
    duration: 600,
    easing: [0.5, 0, 0.3, 1],
    frames: [
      { at: 0, dash: [78, 22], dashOffset: 0 },
      { at: 0.5, dash: [97, 3], dashOffset: 9.5 },
      { at: 1, dash: [78, 22], dashOffset: 0 },
    ],
  },
  wave: { duration: 900, easing: SMOOTH, frames: swing(-30, -78) },
  crawl: {
    duration: 600,
    easing: SMOOTH,
    frames: [
      { at: 0, translate: [0, 0] },
      { at: 0.5, translate: [-1, -0.6] },
      { at: 1, translate: [0, 0] },
    ],
  },
  tilt: { duration: 2600, easing: SMOOTH, frames: swing(-7, 5) },
  "lure-sway": { duration: 2600, easing: SMOOTH, frames: swing(-9, 9) },
  conduct: { duration: 600, easing: SMOOTH, frames: swing(-16, 14) },
  ping: {
    duration: 2600,
    easing: [0.2, 0, 0.4, 1],
    frames: [
      { at: 0, scale: 1, opacity: 0.85 },
      // Twice the ball at most: wider, it would leave the crop circle while still faintly showing.
      { at: 0.6, scale: 2, opacity: 0 },
      { at: 1, scale: 2, opacity: 0 },
    ],
  },
  glow: {
    duration: 2600,
    easing: [0.42, 0, 0.58, 1],
    frames: [
      { at: 0, opacity: 1 },
      { at: 0.5, opacity: 0.55 },
      { at: 1, opacity: 1 },
    ],
  },
  // A hat lifting and tipping on the done hop: the hop's loop and easing, so the two peak together.
  tip: {
    duration: 3200,
    easing: [0.3, 0, 0.2, 1],
    frames: [
      { at: 0, translate: [0, 0], rotate: 0 },
      { at: 0.05, translate: [0, 0], rotate: 0 },
      { at: 0.11, translate: [0, -1.6], rotate: -12 },
      { at: 0.18, translate: [0, 0], rotate: 0 },
      { at: 1, translate: [0, 0], rotate: 0 },
    ],
  },
};

// Scenes -------------------------------------------------------------------------------

type ShapeCommon = {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  /** Round caps and joins. */
  round?: boolean;
  opacity?: number;
  /** A stroke dash of a path length of 100 (a claw's open pincer). */
  dash?: [number, number];
  /** The stroke keeps its width whatever the scale. */
  fixedStroke?: boolean;
  /** A static SVG transform attribute. */
  transform?: string;
  /** Where pose rotation and motion turn and scale about, in grid units. */
  origin?: [number, number];
  /** A pose rotation in degrees about `origin`. */
  rotate?: number;
  /** The motion this shape plays in this state, and its delay in milliseconds. */
  motion?: AvatarMotionName;
  delay?: number;
  /** The rotation it holds in place of its motion when motion is reduced. */
  still?: number;
  /** Clipped to an eye's white: a lid. */
  clip?: "eye" | "eye-large";
  /** Dropped below `AVATAR_FINE_MIN_PX`. */
  fine?: boolean;
  /** What the shape is, for tests and readers: "arm", "claw", "ball", "lure", "mouth"… */
  part?: string;
};

export type AvatarShape =
  | ({ kind: "path"; d: string } & ShapeCommon)
  | ({ kind: "circle"; cx: number; cy: number; r: number } & ShapeCommon)
  | ({ kind: "ellipse"; cx: number; cy: number; rx: number; ry: number } & ShapeCommon)
  | ({
      kind: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      rx?: number;
    } & ShapeCommon)
  | ({ kind: "group"; children: AvatarShape[] } & ShapeCommon);

export type AvatarScene = {
  choice: AvatarChoice;
  state: AvatarState;
  /** Desaturated and darkened: blocked and failed. */
  muted: boolean;
  /** The creature: one group holding everything, which carries the whole-body motion. */
  root: AvatarShape & { kind: "group" };
  /**
   * How much the renderer shrinks the creature about the grid's centre (20, 20)
   * so every part, in every pose its motions reach, stays inside the circle an
   * avatar is cropped to: `translate(20 20) scale(fit) translate(-20 -20)`
   * around `root`.
   */
  fit: number;
  /** Then moved by this much, in grid units, so the creature sits in the circle's middle. */
  shift: [number, number];
  /** Where this pose wears its accessories; the scene already draws what the choice wears there. */
  sockets: AvatarSockets;
};

/**
 * Where in the drawing order an accessory goes: after the body, on a
 * Shellfolk's shell before the opening it hides in, on top of everything, just
 * before the eyes, inside each eye, after the mouth, or in a Shellfolk's neck.
 */
export type AvatarLayer =
  "after-body" | "before-opening" | "on-top" | "before-eyes" | "in-eye" | "after-mouth" | "in-neck";

/** Where an accessory's own origin goes, its size, its turn in degrees, and its layer. */
export type AvatarSocket = {
  x: number;
  y: number;
  scale: number;
  tilt: number;
  layer: AvatarLayer;
};

/**
 * One eye: its centre and scale in the group the eyes share, `k` (1, or
 * 3.7 / 3.1 for a large eye), and the round glasses' radius in the eye's own
 * units, fitted to the room between the eyes so rims never cross.
 */
export type AvatarEyeSocket = { x: number; y: number; scale: number; k: number; ring: number };

/**
 * A pose's sockets, on the grid in the frame each is drawn in: a hat's brim
 * middle (`scale` = brim width / 10), the headphones' cup centres and the
 * band's top, each eye, and the bow tie's centre. Null where that pose has
 * nowhere to wear it: a Shellfolk hiding in its shell has no neck and no band.
 */
export type AvatarSockets = {
  head: AvatarSocket | null;
  band: { left: Point; right: Point; apex: number; layer: AvatarLayer } | null;
  eyes: AvatarEyeSocket[];
  neck: AvatarSocket | null;
};

/** A creature's parts without its colour, which its fit depends on: `clawling/dome/pair/even`. */
export function avatarFitKey(choice: AvatarChoice): string {
  if (choice.family === "clawling") return `clawling/${choice.body}/${choice.eyes}/${choice.claws}`;
  if (choice.family === "shellfolk") return `shellfolk/${choice.shell}`;
  return `lantern/${choice.body}/${choice.lure}/${choice.eyes}`;
}

/**
 * What an equipped Claw's fit depends on: its parts, its hat and what is over
 * its eyes (`clawling/dome/pair/even/beret/none`). Colour and trim don't change
 * it, and nor does the bow tie: each outfit's fit is measured with it on, so
 * putting one on never moves or shrinks a Claw that already wears something.
 * On a Claw that wears nothing, a bow tie is its first accessory: the Claw
 * takes its `none/none` outfit's fit, where that entry exists, in place of its
 * bare one.
 */
export function avatarOutfitKey(choice: AvatarChoice): string {
  return `${avatarFitKey(choice)}/${choice.head ?? "none"}/${choice.face ?? "none"}`;
}

/**
 * Each creature's fit and shift (`AvatarScene`): the same in every state, so a
 * creature keeps its size and place while it acts, as "scale dx dy". Written
 * by `node packages/core/test/make-avatar-fit.ts`.
 */
const AVATAR_FIT: Record<string, string> = {
  "clawling/dome/pair/even": "0.858 -1.114 -2.327",
  "clawling/dome/pair/fiddler": "0.808 -3.284 -2.467",
  "clawling/dome/pair/big": "0.821 -0.866 -3.216",
  "clawling/dome/splayed/even": "0.856 -1.16 -1.96",
  "clawling/dome/splayed/fiddler": "0.8 -3.34 -1.98",
  "clawling/dome/splayed/big": "0.817 -0.979 -2.809",
  "clawling/dome/short/even": "0.882 -0.305 -5.738",
  "clawling/dome/short/fiddler": "0.827 -2.352 -5.885",
  "clawling/dome/short/big": "0.833 -0.261 -5.498",
  "clawling/dome/single/even": "0.857 -1.155 -2.011",
  "clawling/dome/single/fiddler": "0.81 -3.235 -2.651",
  "clawling/dome/single/big": "0.816 -0.985 -2.755",
  "clawling/tall/pair/even": "1 -1.573 -0.457",
  "clawling/tall/pair/fiddler": "0.927 -4.259 -0.576",
  "clawling/tall/pair/big": "0.956 -1.42 -1.378",
  "clawling/tall/splayed/even": "0.987 -1.59 -0.045",
  "clawling/tall/splayed/fiddler": "0.912 -4.305 0.002",
  "clawling/tall/splayed/big": "0.951 -1.453 -0.999",
  "clawling/tall/short/even": "1 -1.043 -3.454",
  "clawling/tall/short/fiddler": "0.982 -3.598 -3.856",
  "clawling/tall/short/big": "1 -0.586 -4.688",
  "clawling/tall/single/even": "0.987 -1.589 -0.059",
  "clawling/tall/single/fiddler": "0.93 -4.246 -0.709",
  "clawling/tall/single/big": "0.949 -1.457 -0.918",
  "clawling/wide/pair/even": "0.844 -1.031 -2.655",
  "clawling/wide/pair/fiddler": "0.794 -2.903 -2.75",
  "clawling/wide/pair/big": "0.809 -0.737 -3.551",
  "clawling/wide/splayed/even": "0.833 -1.09 -2.178",
  "clawling/wide/splayed/fiddler": "0.787 -3.046 -2.128",
  "clawling/wide/splayed/big": "0.805 -0.862 -3.077",
  "clawling/wide/short/even": "0.864 -0.217 -6.151",
  "clawling/wide/short/fiddler": "0.815 -2.094 -6.17",
  "clawling/wide/short/big": "0.812 -0.169 -5.921",
  "clawling/wide/single/even": "0.844 -1.033 -2.646",
  "clawling/wide/single/fiddler": "0.796 -2.755 -3.293",
  "clawling/wide/single/big": "0.804 -0.776 -3.371",
  "clawling/round/pair/even": "0.864 -1.119 -2.272",
  "clawling/round/pair/fiddler": "0.808 -3.157 -2.521",
  "clawling/round/pair/big": "0.823 -0.747 -3.273",
  "clawling/round/splayed/even": "0.858 -1.159 -1.899",
  "clawling/round/splayed/fiddler": "0.806 -3.326 -1.962",
  "clawling/round/splayed/big": "0.824 -0.869 -2.883",
  "clawling/round/short/even": "0.88 -0.283 -5.451",
  "clawling/round/short/fiddler": "0.83 -2.301 -5.799",
  "clawling/round/short/big": "0.827 -0.281 -5.036",
  "clawling/round/single/even": "0.858 -1.16 -1.891",
  "clawling/round/single/fiddler": "0.809 -3.137 -2.597",
  "clawling/round/single/big": "0.823 -0.917 -2.72",
  "shellfolk/spiral": "0.832 0.71 0.701",
  "shellfolk/turret": "0.832 0.71 0.701",
  "shellfolk/dome": "0.832 0.71 0.701",
  "shellfolk/spotted": "0.832 0.71 0.701",
  "lantern/round/hook/two": "0.981 -4.359 1.802",
  "lantern/round/hook/one": "0.981 -4.359 1.802",
  "lantern/round/flick/two": "0.918 -0.918 4.116",
  "lantern/round/flick/one": "0.918 -0.918 4.116",
  "lantern/round/wave/two": "0.912 -0.293 4.261",
  "lantern/round/wave/one": "0.912 -0.293 4.261",
  "lantern/round/reach/two": "0.897 -4.944 2.894",
  "lantern/round/reach/one": "0.897 -4.944 2.894",
  "lantern/bell/hook/two": "0.898 -1.352 1.91",
  "lantern/bell/hook/one": "0.898 -1.352 1.91",
  "lantern/bell/flick/two": "0.874 -0.497 3.143",
  "lantern/bell/flick/one": "0.874 -0.497 3.143",
  "lantern/bell/wave/two": "0.869 -0.5 3.249",
  "lantern/bell/wave/one": "0.869 -0.5 3.249",
  "lantern/bell/reach/two": "0.822 -2.118 2.894",
  "lantern/bell/reach/one": "0.822 -2.118 2.894",
  "lantern/oval/hook/two": "1 -2.828 1.789",
  "lantern/oval/hook/one": "1 -2.828 1.789",
  "lantern/oval/flick/two": "0.995 0.037 4.046",
  "lantern/oval/flick/one": "0.995 0.037 4.046",
  "lantern/oval/wave/two": "0.936 0.047 4.901",
  "lantern/oval/wave/one": "0.936 0.047 4.901",
  "lantern/oval/reach/two": "0.895 -3.49 3.518",
  "lantern/oval/reach/one": "0.895 -3.49 3.518",
  "lantern/box/hook/two": "0.896 -1.829 0.037",
  "lantern/box/hook/one": "0.896 -1.829 0.037",
  "lantern/box/flick/two": "0.872 -0.364 1.799",
  "lantern/box/flick/one": "0.872 -0.364 1.799",
  "lantern/box/wave/two": "0.841 -0.39 2.539",
  "lantern/box/wave/one": "0.841 -0.39 2.539",
  "lantern/box/reach/two": "0.802 -2.437 1.799",
  "lantern/box/reach/one": "0.802 -2.437 1.799",
};

/**
 * The fit and shift of each outfit whose accessories would take its bare
 * creature's fit outside the circle, keyed by `avatarOutfitKey`, as "scale dx
 * dy": one fit for the outfit in every state, measured with the bow tie on. Written by
 * `node packages/core/test/make-avatar-fit.ts` beside `AVATAR_FIT`.
 */
const AVATAR_FIT_INSET: Record<string, string> = {
  "clawling/dome/pair/even/headphones/none": "0.804 -1.336 0.659",
  "clawling/dome/pair/even/headphones/glasses": "0.804 -1.336 0.659",
  "clawling/dome/pair/even/headphones/shades": "0.804 -1.336 0.659",
  "clawling/dome/pair/fiddler/headphones/none": "0.738 -3.083 0.681",
  "clawling/dome/pair/fiddler/headphones/glasses": "0.738 -3.083 0.681",
  "clawling/dome/pair/fiddler/headphones/shades": "0.738 -3.083 0.681",
  "clawling/dome/pair/big/headphones/none": "0.773 -1.216 -0.047",
  "clawling/dome/pair/big/headphones/glasses": "0.773 -1.216 -0.047",
  "clawling/dome/pair/big/headphones/shades": "0.773 -1.216 -0.047",
  "clawling/dome/splayed/even/headphones/none": "0.791 -1.366 1.144",
  "clawling/dome/splayed/even/headphones/glasses": "0.791 -1.366 1.144",
  "clawling/dome/splayed/even/headphones/shades": "0.791 -1.366 1.144",
  "clawling/dome/splayed/fiddler/headphones/none": "0.729 -3.13 1.214",
  "clawling/dome/splayed/fiddler/headphones/glasses": "0.729 -3.13 1.214",
  "clawling/dome/splayed/fiddler/headphones/shades": "0.729 -3.13 1.214",
  "clawling/dome/splayed/big/headphones/none": "0.766 -1.254 0.423",
  "clawling/dome/splayed/big/headphones/glasses": "0.766 -1.254 0.423",
  "clawling/dome/splayed/big/headphones/shades": "0.766 -1.254 0.423",
  "clawling/dome/short/even/party/none": "0.87 -1.089 -2.703",
  "clawling/dome/short/even/party/glasses": "0.87 -1.089 -2.703",
  "clawling/dome/short/even/party/shades": "0.87 -1.089 -2.703",
  "clawling/dome/short/even/headphones/none": "0.852 -1.164 -1.697",
  "clawling/dome/short/even/headphones/glasses": "0.852 -1.164 -1.697",
  "clawling/dome/short/even/headphones/shades": "0.852 -1.164 -1.697",
  "clawling/dome/short/fiddler/party/none": "0.807 -2.76 -3.094",
  "clawling/dome/short/fiddler/party/glasses": "0.807 -2.76 -3.094",
  "clawling/dome/short/fiddler/party/shades": "0.807 -2.76 -3.094",
  "clawling/dome/short/fiddler/headphones/none": "0.781 -2.919 -1.524",
  "clawling/dome/short/fiddler/headphones/glasses": "0.781 -2.919 -1.524",
  "clawling/dome/short/fiddler/headphones/shades": "0.781 -2.919 -1.524",
  "clawling/dome/short/big/party/none": "0.824 -0.953 -3.272",
  "clawling/dome/short/big/party/glasses": "0.824 -0.953 -3.272",
  "clawling/dome/short/big/party/shades": "0.824 -0.953 -3.272",
  "clawling/dome/short/big/headphones/none": "0.813 -1.037 -2.345",
  "clawling/dome/short/big/headphones/glasses": "0.813 -1.037 -2.345",
  "clawling/dome/short/big/headphones/shades": "0.813 -1.037 -2.345",
  "clawling/dome/single/even/none/glasses": "0.836 -1.219 -0.924",
  "clawling/dome/single/even/beanie/none": "0.758 -1.462 2.531",
  "clawling/dome/single/even/beanie/glasses": "0.758 -1.462 2.531",
  "clawling/dome/single/even/beanie/shades": "0.758 -1.462 2.531",
  "clawling/dome/single/even/beret/none": "0.773 -1.428 1.98",
  "clawling/dome/single/even/beret/glasses": "0.773 -1.428 1.98",
  "clawling/dome/single/even/beret/shades": "0.773 -1.428 1.98",
  "clawling/dome/single/even/party/none": "0.734 -1.505 3.319",
  "clawling/dome/single/even/party/glasses": "0.734 -1.505 3.319",
  "clawling/dome/single/even/party/shades": "0.734 -1.505 3.319",
  "clawling/dome/single/even/crown/none": "0.771 -1.434 2.073",
  "clawling/dome/single/even/crown/glasses": "0.771 -1.434 2.073",
  "clawling/dome/single/even/crown/shades": "0.771 -1.434 2.073",
  "clawling/dome/single/even/headphones/none": "0.79 -1.368 1.185",
  "clawling/dome/single/even/headphones/glasses": "0.79 -1.368 1.185",
  "clawling/dome/single/even/headphones/shades": "0.79 -1.368 1.185",
  "clawling/dome/single/fiddler/none/glasses": "0.78 -2.925 -1.44",
  "clawling/dome/single/fiddler/beanie/none": "0.711 -3.168 1.931",
  "clawling/dome/single/fiddler/beanie/glasses": "0.711 -3.168 1.931",
  "clawling/dome/single/fiddler/beanie/shades": "0.711 -3.168 1.931",
  "clawling/dome/single/fiddler/beret/none": "0.726 -3.137 1.337",
  "clawling/dome/single/fiddler/beret/glasses": "0.726 -3.137 1.337",
  "clawling/dome/single/fiddler/beret/shades": "0.726 -3.137 1.337",
  "clawling/dome/single/fiddler/party/none": "0.693 -3.224 2.735",
  "clawling/dome/single/fiddler/party/glasses": "0.693 -3.224 2.735",
  "clawling/dome/single/fiddler/party/shades": "0.693 -3.224 2.735",
  "clawling/dome/single/fiddler/crown/none": "0.723 -3.145 1.475",
  "clawling/dome/single/fiddler/crown/glasses": "0.723 -3.145 1.475",
  "clawling/dome/single/fiddler/crown/shades": "0.723 -3.145 1.475",
  "clawling/dome/single/fiddler/headphones/none": "0.736 -3.089 0.758",
  "clawling/dome/single/fiddler/headphones/glasses": "0.736 -3.089 0.758",
  "clawling/dome/single/fiddler/headphones/shades": "0.736 -3.089 0.758",
  "clawling/dome/single/big/beanie/none": "0.729 -1.353 1.93",
  "clawling/dome/single/big/beanie/glasses": "0.729 -1.353 1.93",
  "clawling/dome/single/big/beanie/shades": "0.729 -1.353 1.93",
  "clawling/dome/single/big/beret/none": "0.743 -1.314 1.38",
  "clawling/dome/single/big/beret/glasses": "0.743 -1.314 1.38",
  "clawling/dome/single/big/beret/shades": "0.743 -1.314 1.38",
  "clawling/dome/single/big/party/none": "0.712 -1.411 2.736",
  "clawling/dome/single/big/party/glasses": "0.712 -1.411 2.736",
  "clawling/dome/single/big/party/shades": "0.712 -1.411 2.736",
  "clawling/dome/single/big/crown/none": "0.741 -1.321 1.47",
  "clawling/dome/single/big/crown/glasses": "0.741 -1.321 1.47",
  "clawling/dome/single/big/crown/shades": "0.741 -1.321 1.47",
  "clawling/dome/single/big/headphones/none": "0.763 -1.263 0.572",
  "clawling/dome/single/big/headphones/glasses": "0.763 -1.263 0.572",
  "clawling/dome/single/big/headphones/shades": "0.763 -1.263 0.572",
  "clawling/tall/pair/even/headphones/none": "0.909 -1.317 2.292",
  "clawling/tall/pair/even/headphones/glasses": "0.909 -1.317 2.292",
  "clawling/tall/pair/even/headphones/shades": "0.909 -1.317 2.292",
  "clawling/tall/pair/fiddler/headphones/none": "0.824 -3.045 1.925",
  "clawling/tall/pair/fiddler/headphones/glasses": "0.824 -3.045 1.925",
  "clawling/tall/pair/fiddler/headphones/shades": "0.824 -3.045 1.925",
  "clawling/tall/pair/big/party/none": "0.928 -1.462 0.004",
  "clawling/tall/pair/big/party/glasses": "0.928 -1.462 0.004",
  "clawling/tall/pair/big/party/shades": "0.928 -1.462 0.004",
  "clawling/tall/pair/big/headphones/none": "0.875 -1.575 1.835",
  "clawling/tall/pair/big/headphones/glasses": "0.875 -1.575 1.835",
  "clawling/tall/pair/big/headphones/shades": "0.875 -1.575 1.835",
  "clawling/tall/splayed/even/headphones/none": "0.891 -1.226 2.679",
  "clawling/tall/splayed/even/headphones/glasses": "0.891 -1.226 2.679",
  "clawling/tall/splayed/even/headphones/shades": "0.891 -1.226 2.679",
  "clawling/tall/splayed/fiddler/headphones/none": "0.807 -2.466 1.886",
  "clawling/tall/splayed/fiddler/headphones/glasses": "0.807 -2.466 1.886",
  "clawling/tall/splayed/fiddler/headphones/shades": "0.807 -2.466 1.886",
  "clawling/tall/splayed/big/headphones/none": "0.858 -1.597 2.325",
  "clawling/tall/splayed/big/headphones/glasses": "0.858 -1.597 2.325",
  "clawling/tall/splayed/big/headphones/shades": "0.858 -1.597 2.325",
  "clawling/tall/short/even/beanie/none": "1 -1.461 -1.12",
  "clawling/tall/short/even/beanie/glasses": "1 -1.461 -1.12",
  "clawling/tall/short/even/beanie/shades": "1 -1.461 -1.12",
  "clawling/tall/short/even/party/none": "0.975 -1.594 0.557",
  "clawling/tall/short/even/party/glasses": "0.975 -1.594 0.557",
  "clawling/tall/short/even/party/shades": "0.975 -1.594 0.557",
  "clawling/tall/short/even/headphones/none": "0.985 -1.586 0.346",
  "clawling/tall/short/even/headphones/glasses": "0.985 -1.586 0.346",
  "clawling/tall/short/even/headphones/shades": "0.985 -1.586 0.346",
  "clawling/tall/short/fiddler/beanie/none": "0.937 -3.561 -1.613",
  "clawling/tall/short/fiddler/beanie/glasses": "0.937 -3.561 -1.613",
  "clawling/tall/short/fiddler/beanie/shades": "0.937 -3.561 -1.613",
  "clawling/tall/short/fiddler/party/none": "0.896 -3.676 0.056",
  "clawling/tall/short/fiddler/party/glasses": "0.896 -3.676 0.056",
  "clawling/tall/short/fiddler/party/shades": "0.896 -3.676 0.056",
  "clawling/tall/short/fiddler/headphones/none": "0.887 -3.563 0.359",
  "clawling/tall/short/fiddler/headphones/glasses": "0.887 -3.563 0.359",
  "clawling/tall/short/fiddler/headphones/shades": "0.887 -3.563 0.359",
  "clawling/tall/short/big/beanie/none": "0.97 -1.333 -1.85",
  "clawling/tall/short/big/beanie/glasses": "0.97 -1.333 -1.85",
  "clawling/tall/short/big/beanie/shades": "0.97 -1.333 -1.85",
  "clawling/tall/short/big/beret/none": "0.99 -1.273 -2.767",
  "clawling/tall/short/big/beret/glasses": "0.99 -1.273 -2.767",
  "clawling/tall/short/big/beret/shades": "0.99 -1.273 -2.767",
  "clawling/tall/short/big/party/none": "0.932 -1.454 -0.155",
  "clawling/tall/short/big/party/glasses": "0.932 -1.454 -0.155",
  "clawling/tall/short/big/party/shades": "0.932 -1.454 -0.155",
  "clawling/tall/short/big/crown/none": "0.99 -1.273 -2.767",
  "clawling/tall/short/big/crown/glasses": "0.99 -1.273 -2.767",
  "clawling/tall/short/big/crown/shades": "0.99 -1.273 -2.767",
  "clawling/tall/short/big/headphones/none": "0.942 -1.438 -0.466",
  "clawling/tall/short/big/headphones/glasses": "0.942 -1.438 -0.466",
  "clawling/tall/short/big/headphones/shades": "0.942 -1.438 -0.466",
  "clawling/tall/single/even/beanie/none": "0.832 -0.931 4.006",
  "clawling/tall/single/even/beanie/glasses": "0.832 -0.931 4.006",
  "clawling/tall/single/even/beanie/shades": "0.832 -0.931 4.006",
  "clawling/tall/single/even/beret/none": "0.854 -1.034 3.552",
  "clawling/tall/single/even/beret/glasses": "0.854 -1.034 3.552",
  "clawling/tall/single/even/beret/shades": "0.854 -1.034 3.552",
  "clawling/tall/single/even/party/none": "0.803 -0.785 4.685",
  "clawling/tall/single/even/party/glasses": "0.803 -0.785 4.685",
  "clawling/tall/single/even/party/shades": "0.803 -0.785 4.685",
  "clawling/tall/single/even/crown/none": "0.851 -1.018 3.622",
  "clawling/tall/single/even/crown/glasses": "0.851 -1.018 3.622",
  "clawling/tall/single/even/crown/shades": "0.851 -1.018 3.622",
  "clawling/tall/single/even/headphones/none": "0.883 -1.186 2.85",
  "clawling/tall/single/even/headphones/glasses": "0.883 -1.186 2.85",
  "clawling/tall/single/even/headphones/shades": "0.883 -1.186 2.85",
  "clawling/tall/single/fiddler/none/glasses": "0.885 -3.699 0.447",
  "clawling/tall/single/fiddler/beanie/none": "0.78 -3.215 3.402",
  "clawling/tall/single/fiddler/beanie/glasses": "0.78 -3.215 3.402",
  "clawling/tall/single/fiddler/beanie/shades": "0.78 -3.215 3.402",
  "clawling/tall/single/fiddler/beret/none": "0.802 -3.336 2.894",
  "clawling/tall/single/fiddler/beret/glasses": "0.802 -3.336 2.894",
  "clawling/tall/single/fiddler/beret/shades": "0.802 -3.336 2.894",
  "clawling/tall/single/fiddler/party/none": "0.755 -3.07 4.086",
  "clawling/tall/single/fiddler/party/glasses": "0.755 -3.07 4.086",
  "clawling/tall/single/fiddler/party/shades": "0.755 -3.07 4.086",
  "clawling/tall/single/fiddler/crown/none": "0.797 -3.307 3.017",
  "clawling/tall/single/fiddler/crown/glasses": "0.797 -3.307 3.017",
  "clawling/tall/single/fiddler/crown/shades": "0.797 -3.307 3.017",
  "clawling/tall/single/fiddler/headphones/none": "0.818 -3.426 2.428",
  "clawling/tall/single/fiddler/headphones/glasses": "0.818 -3.426 2.428",
  "clawling/tall/single/fiddler/headphones/shades": "0.818 -3.426 2.428",
  "clawling/tall/single/big/none/glasses": "0.918 -1.482 0.348",
  "clawling/tall/single/big/beanie/none": "0.811 -1.676 3.743",
  "clawling/tall/single/big/beanie/glasses": "0.811 -1.676 3.743",
  "clawling/tall/single/big/beanie/shades": "0.811 -1.676 3.743",
  "clawling/tall/single/big/beret/none": "0.831 -1.647 3.211",
  "clawling/tall/single/big/beret/glasses": "0.831 -1.647 3.211",
  "clawling/tall/single/big/beret/shades": "0.831 -1.647 3.211",
  "clawling/tall/single/big/party/none": "0.785 -1.613 4.463",
  "clawling/tall/single/big/party/glasses": "0.785 -1.613 4.463",
  "clawling/tall/single/big/party/shades": "0.785 -1.613 4.463",
  "clawling/tall/single/big/crown/none": "0.828 -1.653 3.307",
  "clawling/tall/single/big/crown/glasses": "0.828 -1.653 3.307",
  "clawling/tall/single/big/crown/shades": "0.828 -1.653 3.307",
  "clawling/tall/single/big/headphones/none": "0.858 -1.611 2.476",
  "clawling/tall/single/big/headphones/glasses": "0.858 -1.611 2.476",
  "clawling/tall/single/big/headphones/shades": "0.858 -1.611 2.476",
  "clawling/wide/pair/even/headphones/none": "0.786 -1.287 0.452",
  "clawling/wide/pair/even/headphones/glasses": "0.786 -1.287 0.452",
  "clawling/wide/pair/even/headphones/shades": "0.786 -1.287 0.452",
  "clawling/wide/pair/fiddler/headphones/none": "0.73 -2.864 0.529",
  "clawling/wide/pair/fiddler/headphones/glasses": "0.73 -2.864 0.529",
  "clawling/wide/pair/fiddler/headphones/shades": "0.73 -2.864 0.529",
  "clawling/wide/pair/big/headphones/none": "0.761 -1.178 -0.215",
  "clawling/wide/pair/big/headphones/glasses": "0.761 -1.178 -0.215",
  "clawling/wide/pair/big/headphones/shades": "0.761 -1.178 -0.215",
  "clawling/wide/splayed/even/headphones/none": "0.777 -1.328 0.988",
  "clawling/wide/splayed/even/headphones/glasses": "0.777 -1.328 0.988",
  "clawling/wide/splayed/even/headphones/shades": "0.777 -1.328 0.988",
  "clawling/wide/splayed/fiddler/headphones/none": "0.717 -2.901 1.098",
  "clawling/wide/splayed/fiddler/headphones/glasses": "0.717 -2.901 1.098",
  "clawling/wide/splayed/fiddler/headphones/shades": "0.717 -2.901 1.098",
  "clawling/wide/splayed/big/headphones/none": "0.751 -1.218 0.304",
  "clawling/wide/splayed/big/headphones/glasses": "0.751 -1.218 0.304",
  "clawling/wide/splayed/big/headphones/shades": "0.751 -1.218 0.304",
  "clawling/wide/short/even/headphones/none": "0.834 -1.116 -1.908",
  "clawling/wide/short/even/headphones/glasses": "0.834 -1.116 -1.908",
  "clawling/wide/short/even/headphones/shades": "0.834 -1.116 -1.908",
  "clawling/wide/short/fiddler/headphones/none": "0.77 -2.695 -1.684",
  "clawling/wide/short/fiddler/headphones/glasses": "0.77 -2.695 -1.684",
  "clawling/wide/short/fiddler/headphones/shades": "0.77 -2.695 -1.684",
  "clawling/wide/short/big/headphones/none": "0.8 -0.988 -2.599",
  "clawling/wide/short/big/headphones/glasses": "0.8 -0.988 -2.599",
  "clawling/wide/short/big/headphones/shades": "0.8 -0.988 -2.599",
  "clawling/wide/single/even/none/glasses": "0.829 -1.137 -1.616",
  "clawling/wide/single/even/beanie/none": "0.752 -1.393 1.977",
  "clawling/wide/single/even/beanie/glasses": "0.752 -1.393 1.977",
  "clawling/wide/single/even/beanie/shades": "0.752 -1.393 1.977",
  "clawling/wide/single/even/beret/none": "0.767 -1.354 1.407",
  "clawling/wide/single/even/beret/glasses": "0.767 -1.354 1.407",
  "clawling/wide/single/even/beret/shades": "0.767 -1.354 1.407",
  "clawling/wide/single/even/party/none": "0.73 -1.446 2.797",
  "clawling/wide/single/even/party/glasses": "0.73 -1.446 2.797",
  "clawling/wide/single/even/party/shades": "0.73 -1.446 2.797",
  "clawling/wide/single/even/crown/none": "0.764 -1.36 1.502",
  "clawling/wide/single/even/crown/glasses": "0.764 -1.36 1.502",
  "clawling/wide/single/even/crown/shades": "0.764 -1.36 1.502",
  "clawling/wide/single/even/headphones/none": "0.787 -1.301 0.562",
  "clawling/wide/single/even/headphones/glasses": "0.787 -1.301 0.562",
  "clawling/wide/single/even/headphones/shades": "0.787 -1.301 0.562",
  "clawling/wide/single/fiddler/beanie/none": "0.712 -2.935 1.443",
  "clawling/wide/single/fiddler/beanie/glasses": "0.712 -2.935 1.443",
  "clawling/wide/single/fiddler/beanie/shades": "0.712 -2.935 1.443",
  "clawling/wide/single/fiddler/beret/none": "0.723 -2.884 0.83",
  "clawling/wide/single/fiddler/beret/glasses": "0.723 -2.884 0.83",
  "clawling/wide/single/fiddler/beret/shades": "0.723 -2.884 0.83",
  "clawling/wide/single/fiddler/party/none": "0.692 -2.981 2.264",
  "clawling/wide/single/fiddler/party/glasses": "0.692 -2.981 2.264",
  "clawling/wide/single/fiddler/party/shades": "0.692 -2.981 2.264",
  "clawling/wide/single/fiddler/crown/none": "0.72 -2.893 0.965",
  "clawling/wide/single/fiddler/crown/glasses": "0.72 -2.893 0.965",
  "clawling/wide/single/fiddler/crown/shades": "0.72 -2.893 0.965",
  "clawling/wide/single/fiddler/headphones/none": "0.737 -2.842 0.181",
  "clawling/wide/single/fiddler/headphones/glasses": "0.737 -2.842 0.181",
  "clawling/wide/single/fiddler/headphones/shades": "0.737 -2.842 0.181",
  "clawling/wide/single/big/beanie/none": "0.729 -1.297 1.432",
  "clawling/wide/single/big/beanie/glasses": "0.729 -1.297 1.432",
  "clawling/wide/single/big/beanie/shades": "0.729 -1.297 1.432",
  "clawling/wide/single/big/beret/none": "0.738 -1.254 0.857",
  "clawling/wide/single/big/beret/glasses": "0.738 -1.254 0.857",
  "clawling/wide/single/big/beret/shades": "0.738 -1.254 0.857",
  "clawling/wide/single/big/party/none": "0.708 -1.355 2.258",
  "clawling/wide/single/big/party/glasses": "0.708 -1.355 2.258",
  "clawling/wide/single/big/party/shades": "0.708 -1.355 2.258",
  "clawling/wide/single/big/crown/none": "0.736 -1.26 0.948",
  "clawling/wide/single/big/crown/glasses": "0.736 -1.26 0.948",
  "clawling/wide/single/big/crown/shades": "0.736 -1.26 0.948",
  "clawling/wide/single/big/headphones/none": "0.757 -1.195 -0.002",
  "clawling/wide/single/big/headphones/glasses": "0.757 -1.195 -0.002",
  "clawling/wide/single/big/headphones/shades": "0.757 -1.195 -0.002",
  "clawling/round/pair/even/headphones/none": "0.811 -1.359 0.755",
  "clawling/round/pair/even/headphones/glasses": "0.811 -1.359 0.755",
  "clawling/round/pair/even/headphones/shades": "0.811 -1.359 0.755",
  "clawling/round/pair/fiddler/headphones/none": "0.745 -3.102 0.758",
  "clawling/round/pair/fiddler/headphones/glasses": "0.745 -3.102 0.758",
  "clawling/round/pair/fiddler/headphones/shades": "0.745 -3.102 0.758",
  "clawling/round/pair/big/headphones/none": "0.78 -1.232 0.029",
  "clawling/round/pair/big/headphones/glasses": "0.78 -1.232 0.029",
  "clawling/round/pair/big/headphones/shades": "0.78 -1.232 0.029",
  "clawling/round/splayed/even/headphones/none": "0.799 -1.389 1.244",
  "clawling/round/splayed/even/headphones/glasses": "0.799 -1.389 1.244",
  "clawling/round/splayed/even/headphones/shades": "0.799 -1.389 1.244",
  "clawling/round/splayed/fiddler/headphones/none": "0.732 -3.137 1.292",
  "clawling/round/splayed/fiddler/headphones/glasses": "0.732 -3.137 1.292",
  "clawling/round/splayed/fiddler/headphones/shades": "0.732 -3.137 1.292",
  "clawling/round/splayed/big/headphones/none": "0.769 -1.268 0.504",
  "clawling/round/splayed/big/headphones/glasses": "0.769 -1.268 0.504",
  "clawling/round/splayed/big/headphones/shades": "0.769 -1.268 0.504",
  "clawling/round/short/even/party/none": "0.877 -0.817 -3.755",
  "clawling/round/short/even/party/glasses": "0.877 -0.817 -3.755",
  "clawling/round/short/even/party/shades": "0.877 -0.817 -3.755",
  "clawling/round/short/even/headphones/none": "0.858 -1.184 -1.62",
  "clawling/round/short/even/headphones/glasses": "0.858 -1.184 -1.62",
  "clawling/round/short/even/headphones/shades": "0.858 -1.184 -1.62",
  "clawling/round/short/fiddler/party/none": "0.813 -2.369 -4.158",
  "clawling/round/short/fiddler/party/glasses": "0.813 -2.369 -4.158",
  "clawling/round/short/fiddler/party/shades": "0.813 -2.369 -4.158",
  "clawling/round/short/fiddler/headphones/none": "0.788 -2.93 -1.5",
  "clawling/round/short/fiddler/headphones/glasses": "0.788 -2.93 -1.5",
  "clawling/round/short/fiddler/headphones/shades": "0.788 -2.93 -1.5",
  "clawling/round/short/big/headphones/none": "0.819 -1.052 -2.27",
  "clawling/round/short/big/headphones/glasses": "0.819 -1.052 -2.27",
  "clawling/round/short/big/headphones/shades": "0.819 -1.052 -2.27",
  "clawling/round/single/even/beanie/none": "0.764 -1.49 2.699",
  "clawling/round/single/even/beanie/glasses": "0.764 -1.49 2.699",
  "clawling/round/single/even/beanie/shades": "0.764 -1.49 2.699",
  "clawling/round/single/even/beret/none": "0.775 -1.446 2.131",
  "clawling/round/single/even/beret/glasses": "0.775 -1.446 2.131",
  "clawling/round/single/even/beret/shades": "0.775 -1.446 2.131",
  "clawling/round/single/even/party/none": "0.74 -1.534 3.494",
  "clawling/round/single/even/party/glasses": "0.74 -1.534 3.494",
  "clawling/round/single/even/party/shades": "0.74 -1.534 3.494",
  "clawling/round/single/even/crown/none": "0.777 -1.46 2.237",
  "clawling/round/single/even/crown/glasses": "0.777 -1.46 2.237",
  "clawling/round/single/even/crown/shades": "0.777 -1.46 2.237",
  "clawling/round/single/even/headphones/none": "0.796 -1.395 1.343",
  "clawling/round/single/even/headphones/glasses": "0.796 -1.395 1.343",
  "clawling/round/single/even/headphones/shades": "0.796 -1.395 1.343",
  "clawling/round/single/fiddler/beanie/none": "0.716 -3.195 2.083",
  "clawling/round/single/fiddler/beanie/glasses": "0.716 -3.195 2.083",
  "clawling/round/single/fiddler/beanie/shades": "0.716 -3.195 2.083",
  "clawling/round/single/fiddler/beret/none": "0.731 -3.163 1.482",
  "clawling/round/single/fiddler/beret/glasses": "0.731 -3.163 1.482",
  "clawling/round/single/fiddler/beret/shades": "0.731 -3.163 1.482",
  "clawling/round/single/fiddler/party/none": "0.695 -3.234 2.88",
  "clawling/round/single/fiddler/party/glasses": "0.695 -3.234 2.88",
  "clawling/round/single/fiddler/party/shades": "0.695 -3.234 2.88",
  "clawling/round/single/fiddler/crown/none": "0.728 -3.171 1.623",
  "clawling/round/single/fiddler/crown/glasses": "0.728 -3.171 1.623",
  "clawling/round/single/fiddler/crown/shades": "0.728 -3.171 1.623",
  "clawling/round/single/fiddler/headphones/none": "0.742 -3.112 0.901",
  "clawling/round/single/fiddler/headphones/glasses": "0.742 -3.112 0.901",
  "clawling/round/single/fiddler/headphones/shades": "0.742 -3.112 0.901",
  "clawling/round/single/big/none/glasses": "0.808 -1.126 -1.414",
  "clawling/round/single/big/beanie/none": "0.735 -1.377 2.082",
  "clawling/round/single/big/beanie/glasses": "0.735 -1.377 2.082",
  "clawling/round/single/big/beanie/shades": "0.735 -1.377 2.082",
  "clawling/round/single/big/beret/none": "0.749 -1.339 1.526",
  "clawling/round/single/big/beret/glasses": "0.749 -1.339 1.526",
  "clawling/round/single/big/beret/shades": "0.749 -1.339 1.526",
  "clawling/round/single/big/party/none": "0.717 -1.438 2.898",
  "clawling/round/single/big/party/glasses": "0.717 -1.438 2.898",
  "clawling/round/single/big/party/shades": "0.717 -1.438 2.898",
  "clawling/round/single/big/crown/none": "0.747 -1.345 1.618",
  "clawling/round/single/big/crown/glasses": "0.747 -1.345 1.618",
  "clawling/round/single/big/crown/shades": "0.747 -1.345 1.618",
  "clawling/round/single/big/headphones/none": "0.768 -1.288 0.714",
  "clawling/round/single/big/headphones/glasses": "0.768 -1.288 0.714",
  "clawling/round/single/big/headphones/shades": "0.768 -1.288 0.714",
  "shellfolk/spiral/party/none": "0.82 -0.21 1.824",
  "shellfolk/spiral/party/glasses": "0.82 -0.21 1.824",
  "shellfolk/spiral/party/shades": "0.82 -0.21 1.824",
  "shellfolk/spiral/headphones/none": "0.749 1.519 1.677",
  "shellfolk/spiral/headphones/glasses": "0.749 1.519 1.677",
  "shellfolk/spiral/headphones/shades": "0.749 1.519 1.677",
  "shellfolk/turret/beanie/none": "0.827 0.32 1.164",
  "shellfolk/turret/beanie/glasses": "0.827 0.32 1.164",
  "shellfolk/turret/beanie/shades": "0.827 0.32 1.164",
  "shellfolk/turret/beret/none": "0.823 0.703 0.694",
  "shellfolk/turret/beret/glasses": "0.823 0.703 0.694",
  "shellfolk/turret/beret/shades": "0.823 0.703 0.694",
  "shellfolk/turret/party/none": "0.816 -0.202 2.077",
  "shellfolk/turret/party/glasses": "0.816 -0.202 2.077",
  "shellfolk/turret/party/shades": "0.816 -0.202 2.077",
  "shellfolk/turret/crown/none": "0.827 0.574 0.857",
  "shellfolk/turret/crown/glasses": "0.827 0.574 0.857",
  "shellfolk/turret/crown/shades": "0.827 0.574 0.857",
  "shellfolk/turret/headphones/none": "0.749 1.519 1.677",
  "shellfolk/turret/headphones/glasses": "0.749 1.519 1.677",
  "shellfolk/turret/headphones/shades": "0.749 1.519 1.677",
  "shellfolk/dome/headphones/none": "0.749 1.519 1.677",
  "shellfolk/dome/headphones/glasses": "0.749 1.519 1.677",
  "shellfolk/dome/headphones/shades": "0.749 1.519 1.677",
  "shellfolk/spotted/headphones/none": "0.749 1.519 1.677",
  "shellfolk/spotted/headphones/glasses": "0.749 1.519 1.677",
  "shellfolk/spotted/headphones/shades": "0.749 1.519 1.677",
  "lantern/round/hook/two/none/none": "0.937 -4.935 0.131",
  "lantern/round/hook/two/none/glasses": "0.937 -4.935 0.131",
  "lantern/round/hook/two/none/shades": "0.937 -4.935 0.131",
  "lantern/round/hook/two/beanie/none": "0.932 -3.252 1.054",
  "lantern/round/hook/two/beanie/glasses": "0.932 -3.252 1.054",
  "lantern/round/hook/two/beanie/shades": "0.932 -3.252 1.054",
  "lantern/round/hook/two/beret/none": "0.937 -4.598 0.315",
  "lantern/round/hook/two/beret/glasses": "0.937 -4.598 0.315",
  "lantern/round/hook/two/beret/shades": "0.937 -4.598 0.315",
  "lantern/round/hook/two/party/none": "0.915 -1.773 1.869",
  "lantern/round/hook/two/party/glasses": "0.915 -1.773 1.869",
  "lantern/round/hook/two/party/shades": "0.915 -1.773 1.869",
  "lantern/round/hook/two/crown/none": "0.932 -3.846 0.713",
  "lantern/round/hook/two/crown/glasses": "0.932 -3.846 0.713",
  "lantern/round/hook/two/crown/shades": "0.932 -3.846 0.713",
  "lantern/round/hook/two/headphones/none": "0.932 -3.749 0.768",
  "lantern/round/hook/two/headphones/glasses": "0.932 -3.749 0.768",
  "lantern/round/hook/two/headphones/shades": "0.932 -3.749 0.768",
  "lantern/round/hook/one/none/none": "0.937 -4.935 0.131",
  "lantern/round/hook/one/none/glasses": "0.937 -4.935 0.131",
  "lantern/round/hook/one/none/shades": "0.937 -4.935 0.131",
  "lantern/round/hook/one/beanie/none": "0.932 -3.252 1.054",
  "lantern/round/hook/one/beanie/glasses": "0.932 -3.252 1.054",
  "lantern/round/hook/one/beanie/shades": "0.932 -3.252 1.054",
  "lantern/round/hook/one/beret/none": "0.937 -4.598 0.315",
  "lantern/round/hook/one/beret/glasses": "0.937 -4.598 0.315",
  "lantern/round/hook/one/beret/shades": "0.937 -4.598 0.315",
  "lantern/round/hook/one/party/none": "0.915 -1.773 1.869",
  "lantern/round/hook/one/party/glasses": "0.915 -1.773 1.869",
  "lantern/round/hook/one/party/shades": "0.915 -1.773 1.869",
  "lantern/round/hook/one/crown/none": "0.932 -3.846 0.713",
  "lantern/round/hook/one/crown/glasses": "0.932 -3.846 0.713",
  "lantern/round/hook/one/crown/shades": "0.932 -3.846 0.713",
  "lantern/round/hook/one/headphones/none": "0.932 -3.749 0.768",
  "lantern/round/hook/one/headphones/glasses": "0.932 -3.749 0.768",
  "lantern/round/hook/one/headphones/shades": "0.932 -3.749 0.768",
  "lantern/round/flick/two/none/none": "0.873 -0.446 2.968",
  "lantern/round/flick/two/none/glasses": "0.873 -0.446 2.968",
  "lantern/round/flick/two/none/shades": "0.873 -0.446 2.968",
  "lantern/round/flick/two/beanie/none": "0.873 -0.446 2.968",
  "lantern/round/flick/two/beanie/glasses": "0.873 -0.446 2.968",
  "lantern/round/flick/two/beanie/shades": "0.873 -0.446 2.968",
  "lantern/round/flick/two/beret/none": "0.873 -0.446 2.968",
  "lantern/round/flick/two/beret/glasses": "0.873 -0.446 2.968",
  "lantern/round/flick/two/beret/shades": "0.873 -0.446 2.968",
  "lantern/round/flick/two/party/none": "0.873 -0.446 2.968",
  "lantern/round/flick/two/party/glasses": "0.873 -0.446 2.968",
  "lantern/round/flick/two/party/shades": "0.873 -0.446 2.968",
  "lantern/round/flick/two/crown/none": "0.873 -0.446 2.968",
  "lantern/round/flick/two/crown/glasses": "0.873 -0.446 2.968",
  "lantern/round/flick/two/crown/shades": "0.873 -0.446 2.968",
  "lantern/round/flick/two/headphones/none": "0.873 -0.446 2.968",
  "lantern/round/flick/two/headphones/glasses": "0.873 -0.446 2.968",
  "lantern/round/flick/two/headphones/shades": "0.873 -0.446 2.968",
  "lantern/round/flick/one/none/none": "0.873 -0.446 2.968",
  "lantern/round/flick/one/none/glasses": "0.873 -0.446 2.968",
  "lantern/round/flick/one/none/shades": "0.873 -0.446 2.968",
  "lantern/round/flick/one/beanie/none": "0.873 -0.446 2.968",
  "lantern/round/flick/one/beanie/glasses": "0.873 -0.446 2.968",
  "lantern/round/flick/one/beanie/shades": "0.873 -0.446 2.968",
  "lantern/round/flick/one/beret/none": "0.873 -0.446 2.968",
  "lantern/round/flick/one/beret/glasses": "0.873 -0.446 2.968",
  "lantern/round/flick/one/beret/shades": "0.873 -0.446 2.968",
  "lantern/round/flick/one/party/none": "0.873 -0.446 2.968",
  "lantern/round/flick/one/party/glasses": "0.873 -0.446 2.968",
  "lantern/round/flick/one/party/shades": "0.873 -0.446 2.968",
  "lantern/round/flick/one/crown/none": "0.873 -0.446 2.968",
  "lantern/round/flick/one/crown/glasses": "0.873 -0.446 2.968",
  "lantern/round/flick/one/crown/shades": "0.873 -0.446 2.968",
  "lantern/round/flick/one/headphones/none": "0.873 -0.446 2.968",
  "lantern/round/flick/one/headphones/glasses": "0.873 -0.446 2.968",
  "lantern/round/flick/one/headphones/shades": "0.873 -0.446 2.968",
  "lantern/round/wave/two/none/none": "0.868 -0.447 3.059",
  "lantern/round/wave/two/none/glasses": "0.868 -0.447 3.059",
  "lantern/round/wave/two/none/shades": "0.868 -0.447 3.059",
  "lantern/round/wave/two/beanie/none": "0.868 -0.447 3.059",
  "lantern/round/wave/two/beanie/glasses": "0.868 -0.447 3.059",
  "lantern/round/wave/two/beanie/shades": "0.868 -0.447 3.059",
  "lantern/round/wave/two/beret/none": "0.868 -0.447 3.059",
  "lantern/round/wave/two/beret/glasses": "0.868 -0.447 3.059",
  "lantern/round/wave/two/beret/shades": "0.868 -0.447 3.059",
  "lantern/round/wave/two/party/none": "0.868 -0.447 3.059",
  "lantern/round/wave/two/party/glasses": "0.868 -0.447 3.059",
  "lantern/round/wave/two/party/shades": "0.868 -0.447 3.059",
  "lantern/round/wave/two/crown/none": "0.868 -0.447 3.059",
  "lantern/round/wave/two/crown/glasses": "0.868 -0.447 3.059",
  "lantern/round/wave/two/crown/shades": "0.868 -0.447 3.059",
  "lantern/round/wave/two/headphones/none": "0.868 -0.447 3.059",
  "lantern/round/wave/two/headphones/glasses": "0.868 -0.447 3.059",
  "lantern/round/wave/two/headphones/shades": "0.868 -0.447 3.059",
  "lantern/round/wave/one/none/none": "0.868 -0.447 3.059",
  "lantern/round/wave/one/none/glasses": "0.868 -0.447 3.059",
  "lantern/round/wave/one/none/shades": "0.868 -0.447 3.059",
  "lantern/round/wave/one/beanie/none": "0.868 -0.447 3.059",
  "lantern/round/wave/one/beanie/glasses": "0.868 -0.447 3.059",
  "lantern/round/wave/one/beanie/shades": "0.868 -0.447 3.059",
  "lantern/round/wave/one/beret/none": "0.868 -0.447 3.059",
  "lantern/round/wave/one/beret/glasses": "0.868 -0.447 3.059",
  "lantern/round/wave/one/beret/shades": "0.868 -0.447 3.059",
  "lantern/round/wave/one/party/none": "0.868 -0.447 3.059",
  "lantern/round/wave/one/party/glasses": "0.868 -0.447 3.059",
  "lantern/round/wave/one/party/shades": "0.868 -0.447 3.059",
  "lantern/round/wave/one/crown/none": "0.868 -0.447 3.059",
  "lantern/round/wave/one/crown/glasses": "0.868 -0.447 3.059",
  "lantern/round/wave/one/crown/shades": "0.868 -0.447 3.059",
  "lantern/round/wave/one/headphones/none": "0.868 -0.447 3.059",
  "lantern/round/wave/one/headphones/glasses": "0.868 -0.447 3.059",
  "lantern/round/wave/one/headphones/shades": "0.868 -0.447 3.059",
  "lantern/round/reach/two/none/none": "0.859 -5.442 1.314",
  "lantern/round/reach/two/none/glasses": "0.859 -5.442 1.314",
  "lantern/round/reach/two/none/shades": "0.859 -5.442 1.314",
  "lantern/round/reach/two/beanie/none": "0.858 -4.985 1.57",
  "lantern/round/reach/two/beanie/glasses": "0.858 -4.985 1.57",
  "lantern/round/reach/two/beanie/shades": "0.858 -4.985 1.57",
  "lantern/round/reach/two/beret/none": "0.859 -5.442 1.314",
  "lantern/round/reach/two/beret/glasses": "0.859 -5.442 1.314",
  "lantern/round/reach/two/beret/shades": "0.859 -5.442 1.314",
  "lantern/round/reach/two/party/none": "0.852 -3.547 2.372",
  "lantern/round/reach/two/party/glasses": "0.852 -3.547 2.372",
  "lantern/round/reach/two/party/shades": "0.852 -3.547 2.372",
  "lantern/round/reach/two/crown/none": "0.859 -5.318 1.384",
  "lantern/round/reach/two/crown/glasses": "0.859 -5.318 1.384",
  "lantern/round/reach/two/crown/shades": "0.859 -5.318 1.384",
  "lantern/round/reach/two/headphones/none": "0.858 -4.622 1.771",
  "lantern/round/reach/two/headphones/glasses": "0.858 -4.622 1.771",
  "lantern/round/reach/two/headphones/shades": "0.858 -4.622 1.771",
  "lantern/round/reach/one/none/none": "0.859 -5.442 1.314",
  "lantern/round/reach/one/none/glasses": "0.859 -5.442 1.314",
  "lantern/round/reach/one/none/shades": "0.859 -5.442 1.314",
  "lantern/round/reach/one/beanie/none": "0.858 -4.985 1.57",
  "lantern/round/reach/one/beanie/glasses": "0.858 -4.985 1.57",
  "lantern/round/reach/one/beanie/shades": "0.858 -4.985 1.57",
  "lantern/round/reach/one/beret/none": "0.859 -5.442 1.314",
  "lantern/round/reach/one/beret/glasses": "0.859 -5.442 1.314",
  "lantern/round/reach/one/beret/shades": "0.859 -5.442 1.314",
  "lantern/round/reach/one/party/none": "0.852 -3.547 2.372",
  "lantern/round/reach/one/party/glasses": "0.852 -3.547 2.372",
  "lantern/round/reach/one/party/shades": "0.852 -3.547 2.372",
  "lantern/round/reach/one/crown/none": "0.859 -5.318 1.384",
  "lantern/round/reach/one/crown/glasses": "0.859 -5.318 1.384",
  "lantern/round/reach/one/crown/shades": "0.859 -5.318 1.384",
  "lantern/round/reach/one/headphones/none": "0.858 -4.622 1.771",
  "lantern/round/reach/one/headphones/glasses": "0.858 -4.622 1.771",
  "lantern/round/reach/one/headphones/shades": "0.858 -4.622 1.771",
  "lantern/oval/hook/two/none/none": "0.956 -3.484 -0.425",
  "lantern/oval/hook/two/none/glasses": "0.956 -3.484 -0.425",
  "lantern/oval/hook/two/none/shades": "0.956 -3.484 -0.425",
  "lantern/oval/hook/two/beanie/none": "0.956 -3.246 -0.288",
  "lantern/oval/hook/two/beanie/glasses": "0.956 -3.246 -0.288",
  "lantern/oval/hook/two/beanie/shades": "0.956 -3.246 -0.288",
  "lantern/oval/hook/two/beret/none": "0.956 -3.484 -0.425",
  "lantern/oval/hook/two/beret/glasses": "0.956 -3.484 -0.425",
  "lantern/oval/hook/two/beret/shades": "0.956 -3.484 -0.425",
  "lantern/oval/hook/two/party/none": "0.937 -1.794 0.547",
  "lantern/oval/hook/two/party/glasses": "0.937 -1.794 0.547",
  "lantern/oval/hook/two/party/shades": "0.937 -1.794 0.547",
  "lantern/oval/hook/two/crown/none": "0.956 -3.484 -0.425",
  "lantern/oval/hook/two/crown/glasses": "0.956 -3.484 -0.425",
  "lantern/oval/hook/two/crown/shades": "0.956 -3.484 -0.425",
  "lantern/oval/hook/two/headphones/none": "0.932 -1.581 0.668",
  "lantern/oval/hook/two/headphones/glasses": "0.932 -1.581 0.668",
  "lantern/oval/hook/two/headphones/shades": "0.932 -1.581 0.668",
  "lantern/oval/hook/one/none/none": "0.956 -3.484 -0.425",
  "lantern/oval/hook/one/none/glasses": "0.956 -3.484 -0.425",
  "lantern/oval/hook/one/none/shades": "0.956 -3.484 -0.425",
  "lantern/oval/hook/one/beanie/none": "0.956 -3.246 -0.288",
  "lantern/oval/hook/one/beanie/glasses": "0.956 -3.246 -0.288",
  "lantern/oval/hook/one/beanie/shades": "0.956 -3.246 -0.288",
  "lantern/oval/hook/one/beret/none": "0.956 -3.484 -0.425",
  "lantern/oval/hook/one/beret/glasses": "0.956 -3.484 -0.425",
  "lantern/oval/hook/one/beret/shades": "0.956 -3.484 -0.425",
  "lantern/oval/hook/one/party/none": "0.937 -1.794 0.547",
  "lantern/oval/hook/one/party/glasses": "0.937 -1.794 0.547",
  "lantern/oval/hook/one/party/shades": "0.937 -1.794 0.547",
  "lantern/oval/hook/one/crown/none": "0.956 -3.484 -0.425",
  "lantern/oval/hook/one/crown/glasses": "0.956 -3.484 -0.425",
  "lantern/oval/hook/one/crown/shades": "0.956 -3.484 -0.425",
  "lantern/oval/hook/one/headphones/none": "0.932 -1.581 0.668",
  "lantern/oval/hook/one/headphones/glasses": "0.932 -1.581 0.668",
  "lantern/oval/hook/one/headphones/shades": "0.932 -1.581 0.668",
  "lantern/oval/flick/two/none/none": "0.897 -0.544 1.607",
  "lantern/oval/flick/two/none/glasses": "0.897 -0.544 1.607",
  "lantern/oval/flick/two/none/shades": "0.897 -0.544 1.607",
  "lantern/oval/flick/two/beanie/none": "0.897 -0.544 1.607",
  "lantern/oval/flick/two/beanie/glasses": "0.897 -0.544 1.607",
  "lantern/oval/flick/two/beanie/shades": "0.897 -0.544 1.607",
  "lantern/oval/flick/two/beret/none": "0.897 -0.544 1.607",
  "lantern/oval/flick/two/beret/glasses": "0.897 -0.544 1.607",
  "lantern/oval/flick/two/beret/shades": "0.897 -0.544 1.607",
  "lantern/oval/flick/two/party/none": "0.897 -0.544 1.607",
  "lantern/oval/flick/two/party/glasses": "0.897 -0.544 1.607",
  "lantern/oval/flick/two/party/shades": "0.897 -0.544 1.607",
  "lantern/oval/flick/two/crown/none": "0.897 -0.544 1.607",
  "lantern/oval/flick/two/crown/glasses": "0.897 -0.544 1.607",
  "lantern/oval/flick/two/crown/shades": "0.897 -0.544 1.607",
  "lantern/oval/flick/two/headphones/none": "0.897 -0.544 1.607",
  "lantern/oval/flick/two/headphones/glasses": "0.897 -0.544 1.607",
  "lantern/oval/flick/two/headphones/shades": "0.897 -0.544 1.607",
  "lantern/oval/flick/one/none/none": "0.897 -0.544 1.607",
  "lantern/oval/flick/one/none/glasses": "0.897 -0.544 1.607",
  "lantern/oval/flick/one/none/shades": "0.897 -0.544 1.607",
  "lantern/oval/flick/one/beanie/none": "0.897 -0.544 1.607",
  "lantern/oval/flick/one/beanie/glasses": "0.897 -0.544 1.607",
  "lantern/oval/flick/one/beanie/shades": "0.897 -0.544 1.607",
  "lantern/oval/flick/one/beret/none": "0.897 -0.544 1.607",
  "lantern/oval/flick/one/beret/glasses": "0.897 -0.544 1.607",
  "lantern/oval/flick/one/beret/shades": "0.897 -0.544 1.607",
  "lantern/oval/flick/one/party/none": "0.897 -0.544 1.607",
  "lantern/oval/flick/one/party/glasses": "0.897 -0.544 1.607",
  "lantern/oval/flick/one/party/shades": "0.897 -0.544 1.607",
  "lantern/oval/flick/one/crown/none": "0.897 -0.544 1.607",
  "lantern/oval/flick/one/crown/glasses": "0.897 -0.544 1.607",
  "lantern/oval/flick/one/crown/shades": "0.897 -0.544 1.607",
  "lantern/oval/flick/one/headphones/none": "0.897 -0.544 1.607",
  "lantern/oval/flick/one/headphones/glasses": "0.897 -0.544 1.607",
  "lantern/oval/flick/one/headphones/shades": "0.897 -0.544 1.607",
  "lantern/oval/wave/two/none/none": "0.846 -0.542 2.538",
  "lantern/oval/wave/two/none/glasses": "0.846 -0.542 2.538",
  "lantern/oval/wave/two/none/shades": "0.846 -0.542 2.538",
  "lantern/oval/wave/two/beanie/none": "0.846 -0.542 2.538",
  "lantern/oval/wave/two/beanie/glasses": "0.846 -0.542 2.538",
  "lantern/oval/wave/two/beanie/shades": "0.846 -0.542 2.538",
  "lantern/oval/wave/two/beret/none": "0.846 -0.542 2.538",
  "lantern/oval/wave/two/beret/glasses": "0.846 -0.542 2.538",
  "lantern/oval/wave/two/beret/shades": "0.846 -0.542 2.538",
  "lantern/oval/wave/two/party/none": "0.846 -0.542 2.538",
  "lantern/oval/wave/two/party/glasses": "0.846 -0.542 2.538",
  "lantern/oval/wave/two/party/shades": "0.846 -0.542 2.538",
  "lantern/oval/wave/two/crown/none": "0.846 -0.542 2.538",
  "lantern/oval/wave/two/crown/glasses": "0.846 -0.542 2.538",
  "lantern/oval/wave/two/crown/shades": "0.846 -0.542 2.538",
  "lantern/oval/wave/two/headphones/none": "0.846 -0.542 2.538",
  "lantern/oval/wave/two/headphones/glasses": "0.846 -0.542 2.538",
  "lantern/oval/wave/two/headphones/shades": "0.846 -0.542 2.538",
  "lantern/oval/wave/one/none/none": "0.846 -0.542 2.538",
  "lantern/oval/wave/one/none/glasses": "0.846 -0.542 2.538",
  "lantern/oval/wave/one/none/shades": "0.846 -0.542 2.538",
  "lantern/oval/wave/one/beanie/none": "0.846 -0.542 2.538",
  "lantern/oval/wave/one/beanie/glasses": "0.846 -0.542 2.538",
  "lantern/oval/wave/one/beanie/shades": "0.846 -0.542 2.538",
  "lantern/oval/wave/one/beret/none": "0.846 -0.542 2.538",
  "lantern/oval/wave/one/beret/glasses": "0.846 -0.542 2.538",
  "lantern/oval/wave/one/beret/shades": "0.846 -0.542 2.538",
  "lantern/oval/wave/one/party/none": "0.846 -0.542 2.538",
  "lantern/oval/wave/one/party/glasses": "0.846 -0.542 2.538",
  "lantern/oval/wave/one/party/shades": "0.846 -0.542 2.538",
  "lantern/oval/wave/one/crown/none": "0.846 -0.542 2.538",
  "lantern/oval/wave/one/crown/glasses": "0.846 -0.542 2.538",
  "lantern/oval/wave/one/crown/shades": "0.846 -0.542 2.538",
  "lantern/oval/wave/one/headphones/none": "0.846 -0.542 2.538",
  "lantern/oval/wave/one/headphones/glasses": "0.846 -0.542 2.538",
  "lantern/oval/wave/one/headphones/shades": "0.846 -0.542 2.538",
  "lantern/oval/reach/two/none/none": "0.853 -4.49 1.163",
  "lantern/oval/reach/two/none/glasses": "0.853 -4.49 1.163",
  "lantern/oval/reach/two/none/shades": "0.853 -4.49 1.163",
  "lantern/oval/reach/two/beanie/none": "0.853 -4.49 1.163",
  "lantern/oval/reach/two/beanie/glasses": "0.853 -4.49 1.163",
  "lantern/oval/reach/two/beanie/shades": "0.853 -4.49 1.163",
  "lantern/oval/reach/two/beret/none": "0.853 -4.49 1.163",
  "lantern/oval/reach/two/beret/glasses": "0.853 -4.49 1.163",
  "lantern/oval/reach/two/beret/shades": "0.853 -4.49 1.163",
  "lantern/oval/reach/two/party/none": "0.851 -4.184 1.329",
  "lantern/oval/reach/two/party/glasses": "0.851 -4.184 1.329",
  "lantern/oval/reach/two/party/shades": "0.851 -4.184 1.329",
  "lantern/oval/reach/two/crown/none": "0.853 -4.49 1.163",
  "lantern/oval/reach/two/crown/glasses": "0.853 -4.49 1.163",
  "lantern/oval/reach/two/crown/shades": "0.853 -4.49 1.163",
  "lantern/oval/reach/two/headphones/none": "0.838 -2.653 2.148",
  "lantern/oval/reach/two/headphones/glasses": "0.838 -2.653 2.148",
  "lantern/oval/reach/two/headphones/shades": "0.838 -2.653 2.148",
  "lantern/oval/reach/one/none/none": "0.853 -4.49 1.163",
  "lantern/oval/reach/one/none/glasses": "0.853 -4.49 1.163",
  "lantern/oval/reach/one/none/shades": "0.853 -4.49 1.163",
  "lantern/oval/reach/one/beanie/none": "0.853 -4.49 1.163",
  "lantern/oval/reach/one/beanie/glasses": "0.853 -4.49 1.163",
  "lantern/oval/reach/one/beanie/shades": "0.853 -4.49 1.163",
  "lantern/oval/reach/one/beret/none": "0.853 -4.49 1.163",
  "lantern/oval/reach/one/beret/glasses": "0.853 -4.49 1.163",
  "lantern/oval/reach/one/beret/shades": "0.853 -4.49 1.163",
  "lantern/oval/reach/one/party/none": "0.851 -4.184 1.329",
  "lantern/oval/reach/one/party/glasses": "0.851 -4.184 1.329",
  "lantern/oval/reach/one/party/shades": "0.851 -4.184 1.329",
  "lantern/oval/reach/one/crown/none": "0.853 -4.49 1.163",
  "lantern/oval/reach/one/crown/glasses": "0.853 -4.49 1.163",
  "lantern/oval/reach/one/crown/shades": "0.853 -4.49 1.163",
  "lantern/oval/reach/one/headphones/none": "0.838 -2.653 2.148",
  "lantern/oval/reach/one/headphones/glasses": "0.838 -2.653 2.148",
  "lantern/oval/reach/one/headphones/shades": "0.838 -2.653 2.148",
};

/** Clip radii of the two eye sizes, for the renderer's clip paths. */
export const AVATAR_EYE_CLIP = { eye: 3.1, "eye-large": 3.7 } as const;

type Point = [number, number];
const fmt = (n: number) => String(round2(n));

function circle(cx: number, cy: number, r: number, extra: ShapeCommon = {}): AvatarShape {
  return { kind: "circle", cx: round2(cx), cy: round2(cy), r: round2(r), ...extra };
}

function group(children: AvatarShape[], extra: ShapeCommon = {}): AvatarShape & { kind: "group" } {
  return { kind: "group", children, ...extra };
}

// Eyes, shared by the three families.

type EyeOptions = {
  at: Point;
  large: boolean;
  /** The rim round the white, and the lid. */
  socket: string | null;
  lid: string;
  state: AvatarState;
  /** The pupil's offset, already chosen for the state. */
  pupil: Point;
  blink: number;
  /** -1 on the left, 1 on the right, 0 for a single eye: the way a blocked lid slants. */
  side: -1 | 0 | 1;
  scale?: number;
  /** Glasses or shades, drawn inside the eye's own group so they follow it. */
  wear?: AvatarShape | undefined;
};

function eye(o: EyeOptions): AvatarShape {
  const k = o.large ? 3.7 / 3.1 : 1;
  const white = 3.1 * k;
  const children: AvatarShape[] = [];
  if (o.socket) children.push(circle(0, 0, 4.35 * k + (o.large ? -0.24 : 0), { fill: o.socket }));
  children.push(circle(0, 0, white, { fill: AVATAR_WHITE }));
  if (o.state === "done") {
    children.push({
      kind: "path",
      d: `M${fmt(-1.92 * k)} ${fmt(0.93 * k)}Q0 ${fmt(-2.23 * k)} ${fmt(1.92 * k)} ${fmt(0.93 * k)}`,
      stroke: AVATAR_INK,
      strokeWidth: round2(1.3 * k),
      round: true,
      fill: "none",
    });
  } else {
    const pupil = 1.67 * k;
    children.push(
      circle(o.pupil[0] * k, o.pupil[1] * k, pupil, { fill: AVATAR_INK, part: "pupil" }),
    );
    if (o.state === "waiting")
      children.push(
        circle(-0.64 * k, -0.63 * k, 0.57 * k, { fill: AVATAR_WHITE, fine: true, part: "glint" }),
      );
    const top = -(white + 2);
    const lidFor = (height: number) => 2 + (height - 2) * k;
    let lid: AvatarShape;
    if (o.state === "idle" || o.state === "waiting") {
      lid = {
        kind: "rect",
        x: -6,
        y: round2(-(white + 7)),
        width: 12,
        height: 7,
        motion: o.large ? "blink-large" : "blink",
        delay: o.blink,
        origin: [0, 0],
        part: "lid",
      };
    } else {
      const height = o.state === "thinking" ? 3.3 : o.state === "working" ? 3.92 : 5.26;
      lid = {
        kind: "rect",
        x: -6,
        y: round2(top),
        width: 12,
        height: round2(lidFor(height)),
        part: "lid",
        ...(o.state === "blocked" && o.side !== 0 ? { transform: `rotate(${12 * o.side})` } : {}),
      };
    }
    children.push(group([lid], { clip: o.large ? "eye-large" : "eye", fill: o.lid }));
  }
  if (o.wear) children.push(o.wear);
  const scale = o.scale && o.scale !== 1 ? ` scale(${o.scale})` : "";
  return group(children, {
    transform: `translate(${fmt(o.at[0])} ${fmt(o.at[1])})${scale}`,
    part: "eye",
  });
}

/** The pupil for a state, from the bot's gaze. `up` is where thinking looks. */
function pupilFor(state: AvatarState, gaze: Point, up: (x: number) => number, down: number): Point {
  if (state === "thinking") return [round2(up(gaze[0])), -1.3];
  if (state === "working") return [down, 0.75];
  if (state === "waiting") return [0, 0.07];
  if (state === "blocked") return [down, 1.02];
  return gaze;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The mouth, centred on x = 20 at the body's mouth line. */
function mouth(state: AvatarState, y: number): AvatarShape {
  const line = {
    stroke: AVATAR_INK,
    strokeWidth: 1.3,
    round: true,
    fill: "none",
    fine: true,
    part: "mouth",
  };
  switch (state) {
    case "thinking":
      return circle(21, y + 0.5, 0.95, { fill: AVATAR_INK, fine: true, part: "mouth" });
    case "working":
      return { kind: "path", d: `M18.4 ${fmt(y + 0.6)}H21.6`, ...line };
    case "waiting":
      return {
        kind: "path",
        d: `M17.8 ${fmt(y - 0.2)}H22.2Q22.2 ${fmt(y + 2.8)} 20 ${fmt(y + 2.8)}Q17.8 ${fmt(y + 2.8)} 17.8 ${fmt(y - 0.2)}Z`,
        fill: AVATAR_INK,
        fine: true,
        part: "mouth",
      };
    case "blocked":
      return {
        kind: "path",
        d: `M18.2 ${fmt(y + 1.2)}Q20 ${fmt(y - 0.4)} 21.8 ${fmt(y + 1.2)}`,
        ...line,
      };
    case "done":
      return {
        kind: "path",
        d: `M17.4 ${fmt(y - 0.4)}Q20 ${fmt(y + 3)} 22.6 ${fmt(y - 0.4)}`,
        ...line,
        strokeWidth: 1.4,
      };
    default:
      return { kind: "path", d: `M18.2 ${fmt(y)}Q20 ${fmt(y + 1.7)} 21.8 ${fmt(y)}`, ...line };
  }
}

/** The whole-body motion and pose each family plays per state. */
function rootFor(
  family: AvatarFamily,
  state: AvatarState,
  children: AvatarShape[],
): AvatarShape & { kind: "group" } {
  // Shellfolk and Lanterns think with their head and lure, not the whole body.
  const name: AvatarMotionName | null =
    state === "thinking"
      ? family === "clawling"
        ? "sway"
        : null
      : state === "working"
        ? family === "shellfolk"
          ? "crawl"
          : "bob"
        : state === "waiting"
          ? "lean"
          : state === "done"
            ? "hop"
            : null;
  return group(children, {
    origin: [20, 35],
    part: "creature",
    ...(state === "blocked" ? { rotate: 6 } : {}),
    ...(name ? { motion: name } : {}),
  });
}

// Accessories, drawn by each family at its sockets (avatar-studio.md, section 4).

/** A socket's place, size and turn, without its layer, which the family decides. */
type Seat = { x: number; y: number; scale: number; tilt?: number };

/**
 * Hats' brims, as x, y, brim width / 10 and tilt: on a two-eyed Clawling's
 * body between the stalks, on a Shellfolk's shell (which stays put while the
 * critter acts and hides), and left of a Lantern's crown, clear of the lure.
 * A one-eyed Clawling wears its hat on the eye's rim instead.
 */
export const HEAD_SOCKETS = {
  clawling: {
    dome: { x: 20, y: 18, scale: 1.1 },
    tall: { x: 20, y: 16.5, scale: 1.06 },
    wide: { x: 20, y: 22, scale: 1.16 },
    round: { x: 20, y: 19.5, scale: 1.1 },
  },
  shellfolk: {
    spiral: { x: 24.6, y: 9, scale: 1, tilt: 4 },
    turret: { x: 30.2, y: 8.6, scale: 0.7, tilt: 30 },
    dome: { x: 25.2, y: 13.9, scale: 1 },
    spotted: { x: 24.8, y: 11.9, scale: 1, tilt: 3 },
  },
  lantern: {
    round: { x: 13.4, y: 17, scale: 0.9, tilt: -32 },
    bell: { x: 13.9, y: 17, scale: 0.86, tilt: -32 },
    oval: { x: 13.4, y: 18.8, scale: 0.9, tilt: -26 },
    box: { x: 13.4, y: 16.8, scale: 0.92, tilt: -18 },
  },
} satisfies Record<AvatarFamily, Record<string, Seat>>;

/**
 * The bow tie, below the lowest mouth any state draws (the open waiting mouth
 * reaches the mouth line + 2.8), in one place in every state. A Shellfolk
 * wears it at the front of its neck.
 */
export const NECK_SOCKETS = {
  clawling: {
    dome: { x: 20, y: 32.8, scale: 0.85 },
    tall: { x: 20, y: 31.8, scale: 0.8 },
    wide: { x: 20, y: 33.6, scale: 0.85 },
    round: { x: 20, y: 32.8, scale: 0.85 },
  },
  shellfolk: { x: 10.4, y: 28.6, scale: 0.9 },
  lantern: {
    round: { x: 20, y: 34.4, scale: 0.85 },
    bell: { x: 20, y: 35, scale: 0.85 },
    oval: { x: 20.3, y: 35.6, scale: 0.8 },
    box: { x: 20, y: 34.8, scale: 0.85 },
  },
} satisfies Record<AvatarFamily, Seat | Record<string, Seat>>;

/** Headphones on a Lantern: the cups at the body's sides, and the top of the band. */
export const LANTERN_HEADPHONES: Record<LanternBody, { left: Point; right: Point; apex: number }> =
  {
    round: { left: [8.4, 23.4], right: [31.6, 23.4], apex: 12.2 },
    bell: { left: [8.6, 25.2], right: [31.4, 25.2], apex: 12.4 },
    oval: { left: [7.4, 26.2], right: [32.6, 24.2], apex: 14 },
    box: { left: [8, 24.4], right: [32, 24.4], apex: 13.4 },
  };

const seat = ({ x, y, scale, tilt = 0 }: Seat, layer: AvatarLayer): AvatarSocket => ({
  x,
  y,
  scale,
  tilt,
  layer,
});

/** The eyes' sockets, left to right: each ring as large as the room between the two eyes allows. */
function eyeSockets(at: Point[], large: boolean, scale: number): AvatarEyeSocket[] {
  const k = large ? 3.7 / 3.1 : 1;
  const gap = at.length === 2 ? Math.abs(at[1]![0] - at[0]![0]) : Infinity;
  const ring = round2(Math.min(3.75 * k, (gap / 2 - 0.6) / scale));
  return at.map(([x, y]) => ({ x: round2(x), y: round2(y), scale, k, ring }));
}

/** Headphones over the eyes: a cup 1.2 units outside each outer eye's socket, the band's top 1.6 above the higher one. */
function eyeBand(eyes: AvatarEyeSocket[]): AvatarSockets["band"] {
  const reach = (e: AvatarEyeSocket) => 4.35 * e.k * e.scale + 1.2;
  const [first, last] = [eyes[0]!, eyes.at(-1)!];
  return {
    left: [round2(first.x - reach(first)), first.y],
    right: [round2(last.x + reach(last)), last.y],
    apex: round2(Math.min(...eyes.map((e) => e.y - reach(e))) - 1.6),
    layer: "before-eyes",
  };
}

/** A silhouette's edge, a darker shade of its own colour, so a trim in the body's colour still reads. */
const edge = (trim: string): ShapeCommon => ({
  stroke: shade(trim, 0.38),
  strokeWidth: 0.5,
  round: true,
});
const pom = (cx: number, cy: number, r: number) =>
  circle(cx, cy, r, { fill: AVATAR_BALL, stroke: AVATAR_BALL_RIM, strokeWidth: 0.5, part: "pom" });
/** A line of detail, dropped at small sizes. */
const detail = (d: string, stroke: string, strokeWidth: number, part: string): AvatarShape => ({
  kind: "path",
  d,
  stroke,
  strokeWidth,
  round: true,
  fill: "none",
  fine: true,
  part,
});

/** A hat on a 10-unit brim, its middle at 0,0, the crown upward. */
function hatShapes(name: Exclude<AvatarHeadwear, "headphones">, trim: string): AvatarShape[] {
  switch (name) {
    case "beanie":
      return [
        {
          kind: "path",
          d: "M-5 0.2C-5.2 -3.9 -2.6 -6 0 -6S5.2 -3.9 5 0.2Z",
          fill: trim,
          ...edge(trim),
        },
        detail("M-2.6 -1.2V-4.1M0 -1.2V-5.2M2.6 -1.2V-4.1", shade(trim, 0.22), 0.7, "ribs"),
        {
          kind: "rect",
          x: -5.6,
          y: -1.5,
          width: 11.2,
          height: 3,
          rx: 1.5,
          fill: shade(trim, 0.18),
          ...edge(trim),
        },
        pom(0, -6.2, 1.5),
      ];
    case "beret":
      return [
        detail("M0.8 -4.3L1.3 -6", shade(trim, 0.2), 1.3, "beret-stalk"),
        {
          kind: "path",
          d: "M-5.6 0.2C-6.6 -2.4 -3.4 -4.6 1 -4.4C5.4 -4.2 7.4 -2 6.2 0.2C3.4 1.2 -2.8 1.2 -5.6 0.2Z",
          fill: trim,
          ...edge(trim),
        },
        detail("M-5 0.3C-2.4 0.9 3 0.9 5.6 0.3", shade(trim, 0.28), 0.9, "beret-band"),
      ];
    case "party":
      return [
        { kind: "path", d: "M-4 0.2L0 -8.6L4 0.2Q0 1.3 -4 0.2Z", fill: trim, ...edge(trim) },
        detail("M-2.7 -2.8Q0 -1.9 2.7 -2.8M-1.6 -5.6Q0 -5 1.6 -5.6", AVATAR_BALL, 0.9, "stripes"),
        pom(0, -8.7, 1.4),
      ];
    case "crown":
      return [
        {
          kind: "path",
          d: "M-4.8 0.2V-5.2L-2.4 -2.6L0 -6.4L2.4 -2.6L4.8 -5.2V0.2Q0 1 -4.8 0.2Z",
          fill: AVATAR_GOLD,
          stroke: shade(AVATAR_GOLD, 0.3),
          strokeWidth: 0.6,
          round: true,
        },
        circle(0, -1.6, 0.95, { fill: AVATAR_BALL, fine: true, part: "jewel" }),
      ];
  }
}

/**
 * A hat at its socket, as three groups: the socket's place and turn, then the
 * motion about the brim's own middle (the done hop's `tip`), then the brim's scale.
 */
function hat(
  name: Exclude<AvatarHeadwear, "headphones">,
  trim: string,
  at: AvatarSocket,
  state: AvatarState,
) {
  const scaled = group(hatShapes(name, trim), { transform: `scale(${fmt(at.scale)})` });
  const moving = group([scaled], {
    part: "hat-motion",
    ...(state === "done" ? { motion: "tip" as const, origin: [0, 0] as Point } : {}),
  });
  return group([moving], {
    transform: `translate(${fmt(at.x)} ${fmt(at.y)}) rotate(${fmt(at.tilt)})`,
    part: `wear-${name}`,
  });
}

function headphones(trim: string, band: NonNullable<AvatarSockets["band"]>): AvatarShape {
  const { left, right, apex } = band;
  const [xl, ly, xr, ry] = [left[0], left[1] - 2, right[0], right[1] - 2];
  const xm = (xl + xr) / 2;
  // An arch from cup to cup, two quarter ellipses meeting level at the band's top, so every
  // handle stays between the cups and the top.
  const q = 0.552;
  const d =
    `M${fmt(xl)} ${fmt(ly)}C${fmt(xl)} ${fmt(ly - q * (ly - apex))} ${fmt(xm - q * (xm - xl))} ${fmt(apex)} ${fmt(xm)} ${fmt(apex)}` +
    `C${fmt(xm + q * (xr - xm))} ${fmt(apex)} ${fmt(xr)} ${fmt(ry - q * (ry - apex))} ${fmt(xr)} ${fmt(ry)}`;
  const cup = ([x, y]: Point): AvatarShape => ({
    kind: "rect",
    x: round2(x - 1.6),
    y: round2(y - 2.6),
    width: 3.2,
    height: 5.2,
    rx: 1.6,
    fill: trim,
    ...edge(trim),
  });
  const line = { stroke: shade(trim, 0.3), strokeWidth: 1.5, round: true, fill: "none" };
  return group([{ kind: "path", d, ...line, part: "headband" }, cup(left), cup(right)], {
    part: "wear-headphones",
  });
}

/** The part of a circle of radius r about 0,0 below the line y = top, as a closed path of cubic arcs. */
function segment(r: number, top: number): string {
  const from = Math.asin(top / r);
  const step = (Math.PI - 2 * from) / 3;
  const h = (4 / 3) * Math.tan(step / 4) * r;
  let d = `M${fmt(-r * Math.cos(from))} ${fmt(top)}H${fmt(r * Math.cos(from))}`;
  for (let a = from, n = 0; n < 3; n++, a += step) {
    const b = a + step;
    const [c, s, cb, sb] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)];
    d += `C${fmt(r * c - h * s)} ${fmt(r * s + h * c)} ${fmt(r * cb + h * sb)} ${fmt(r * sb - h * cb)} ${fmt(r * cb)} ${fmt(r * sb)}`;
  }
  return `${d}Z`;
}

/**
 * Where a sunglass lens starts below the eye's centre. Thinking, working,
 * blocked and done carry their look in the lids and the happy eye, so there
 * the lens drops and lets them through.
 */
const lensTop = (state: AvatarState, k: number) =>
  (state === "idle" || state === "waiting" ? -0.75 : 0.6) * k;

/** What goes inside one eye's own group, so it follows the eye: a ring for glasses, a lens for shades. */
function lens(face: AvatarFacewear, trim: string, eye: AvatarEyeSocket, state: AvatarState) {
  if (face === "glasses")
    return group([circle(0, 0, eye.ring, { fill: "none", stroke: trim, strokeWidth: 1.05 })], {
      fine: true,
      part: "wear-glasses",
    });
  const { k } = eye;
  const top = lensTop(state, k);
  const glint = Math.max(0.5 * k, top + 0.9 * k);
  return group(
    [
      {
        kind: "path",
        d: segment(3.55 * k, top),
        fill: AVATAR_INK,
        stroke: trim,
        strokeWidth: 0.85,
        round: true,
        ...(top > 0 ? { opacity: 0.72 } : {}),
      },
      {
        ...detail(
          `M${fmt(-1.9 * k)} ${fmt(glint)}L${fmt(-0.9 * k)} ${fmt(glint + k)}`,
          AVATAR_WHITE,
          0.6,
          "glint",
        ),
        opacity: 0.7,
      },
    ],
    { part: "wear-shades" },
  );
}

/** The bridge between two eyes' rims or lenses, in the group the eyes share, unless the rims already meet. */
function bridge(face: AvatarFacewear, trim: string, eyes: AvatarEyeSocket[], state: AvatarState) {
  if (eyes.length !== 2) return null;
  // Where it meets each rim: glasses at the ring's side, shades at the lens's upper corner.
  const at = (e: AvatarEyeSocket, side: -1 | 1): Point => {
    if (face === "glasses") return [e.x + side * e.ring * e.scale, e.y];
    const r = 3.55 * e.k;
    const y = Math.max(0, lensTop(state, e.k));
    return [e.x + side * Math.sqrt(r * r - y * y) * e.scale, e.y + y * e.scale - 0.2];
  };
  const [from, to] = [at(eyes[0]!, 1), at(eyes[1]!, -1)];
  if (to[0] - from[0] < 0.6) return null;
  const mid: Point = [(from[0] + to[0]) / 2, Math.min(from[1], to[1]) - 1.1];
  return detail(
    `M${fmt(from[0])} ${fmt(from[1])}Q${fmt(mid[0])} ${fmt(mid[1])} ${fmt(to[0])} ${fmt(to[1])}`,
    trim,
    1,
    "wear-bridge",
  );
}

function bowtie(trim: string, at: AvatarSocket): AvatarShape {
  const wings =
    "M-0.9 -0.7L-3.6 -2.3Q-4.3 -2.5 -4.3 -1.8V1.8Q-4.3 2.5 -3.6 2.3L-0.9 0.7Z" +
    "M0.9 -0.7L3.6 -2.3Q4.3 -2.5 4.3 -1.8V1.8Q4.3 2.5 3.6 2.3L0.9 0.7Z";
  const knot = { kind: "rect", x: -1.2, y: -1.2, width: 2.4, height: 2.4, rx: 0.9 } as const;
  return group(
    [
      { kind: "path", d: wings, fill: trim, ...edge(trim) },
      { ...knot, fill: shade(trim, 0.22), part: "knot" },
    ],
    {
      transform: `translate(${fmt(at.x)} ${fmt(at.y)}) scale(${fmt(at.scale)})`,
      part: "wear-bowtie",
    },
  );
}

/** What a choice wears in a pose, ready to put in: each shape with its layer, the lenses by eye, and the bridge. */
function wornAt(choice: AvatarChoice, state: AvatarState, sockets: AvatarSockets) {
  const trim = AVATAR_COLORS[trimOf(choice)];
  const { head, face } = choice;
  const placed: Array<{ layer: AvatarLayer; shape: AvatarShape }> = [];
  if (head === "headphones" && sockets.band)
    placed.push({ layer: sockets.band.layer, shape: headphones(trim, sockets.band) });
  else if (head && head !== "headphones" && sockets.head)
    placed.push({ layer: sockets.head.layer, shape: hat(head, trim, sockets.head, state) });
  if (choice.neck && sockets.neck)
    placed.push({ layer: sockets.neck.layer, shape: bowtie(trim, sockets.neck) });
  const across = face ? bridge(face, trim, sockets.eyes, state) : null;
  return {
    at: (layer: AvatarLayer) =>
      placed.filter((each) => each.layer === layer).map((each) => each.shape),
    lens: (index: number) => (face ? lens(face, trim, sockets.eyes[index]!, state) : undefined),
    bridge: across ? [across] : [],
  };
}

/** A family's scene: the creature, and where it wears its accessories in this pose. */
type Built = { root: AvatarShape & { kind: "group" }; sockets: AvatarSockets };

// Clawlings.

type ClawlingBodySpec = {
  shape: AvatarShape;
  /** Where the arms join, left and right, and their height. */
  shoulders: [number, number, number];
  /** Where the stalks rise from, left and right, and their height. */
  stalks: [number, number, number];
  /** The height the eyes rest at. */
  eyeY: number;
  mouthY: number;
  /** Scales the arms and claws to the body's width. */
  reach: number;
};

const CLAWLING_BODY: Record<ClawlingBody, ClawlingBodySpec> = {
  dome: {
    shape: {
      kind: "path",
      d: "M8.5 30.5C8.5 22 13.5 17.5 20 17.5S31.5 22 31.5 30.5C31.5 32.7 30.2 34 28 34H12C9.8 34 8.5 32.7 8.5 30.5Z",
    },
    shoulders: [10.1, 29.9, 27.5],
    stalks: [16.6, 23.4, 21.5],
    eyeY: 9.6,
    mouthY: 27.4,
    reach: 1,
  },
  tall: {
    shape: { kind: "rect", x: 12.5, y: 16, width: 15, height: 18.5, rx: 7.5 },
    shoulders: [14.1, 25.9, 26],
    stalks: [17.6, 22.4, 20],
    eyeY: 10.4,
    mouthY: 26.4,
    reach: 1,
  },
  wide: {
    shape: { kind: "rect", x: 7, y: 21.5, width: 26, height: 13, rx: 6.5 },
    shoulders: [8.6, 31.4, 28],
    stalks: [15.4, 24.6, 25],
    eyeY: 10,
    mouthY: 28.4,
    reach: 0.92,
  },
  round: {
    shape: { kind: "ellipse", cx: 20, cy: 27, rx: 11.5, ry: 8 },
    shoulders: [10.1, 29.9, 27],
    stalks: [16.8, 23.2, 22.5],
    eyeY: 9.6,
    mouthY: 27.4,
    reach: 1,
  },
};

/** Each claw pair's arm length and claw size, left and right, as factors. */
const CLAWLING_CLAW: Record<ClawlingClaws, { left: [number, number]; right: [number, number] }> = {
  even: { left: [1, 1], right: [1, 1] },
  fiddler: { left: [0.95, 0.85], right: [1.35, 1.35] },
  big: { left: [1.1, 1.15], right: [1.1, 1.15] },
};

/** Where each eye setup puts the eyes, from the body's stalks. */
function clawlingEyeTips(
  body: ClawlingBodySpec,
  eyes: ClawlingEyes,
): Array<{ base: Point; tip: Point; side: -1 | 0 | 1 }> {
  const [lx, rx, y] = body.stalks;
  if (eyes === "single") return [{ base: [20, y], tip: [20, body.eyeY - 1], side: 0 }];
  const [dl, dr, yl, yr] =
    eyes === "splayed"
      ? [2.8, 2.6, 0, 1.4]
      : eyes === "short"
        ? [1, 1, 3.6, 3.6]
        : [1.6, 1.6, 0, 0];
  return [
    { base: [lx, y], tip: [lx - dl, body.eyeY + yl], side: -1 },
    { base: [rx, y], tip: [rx + dr, body.eyeY + yr], side: 1 },
  ];
}

function clawlingScene(
  choice: Extract<AvatarChoice, { family: "clawling" }>,
  state: AvatarState,
  v: AvatarVariation,
): Built {
  const color = AVATAR_COLORS[choice.color];
  const body = CLAWLING_BODY[choice.body];
  const claws = CLAWLING_CLAW[choice.claws];
  const children: AvatarShape[] = [];

  // Arms and claws.
  const armPose: Record<AvatarState, [number, number]> = {
    idle: [0, 0],
    thinking: [0, -18],
    working: [0, 0],
    waiting: [0, 0],
    blocked: [-62, 62],
    done: [42, -42],
  };
  for (const side of [-1, 1] as const) {
    const [armScale, clawScale] = side < 0 ? claws.left : claws.right;
    const sx = side < 0 ? body.shoulders[0] : body.shoulders[1];
    const sy = body.shoulders[2];
    const cx = round2(sx + side * 4.8 * body.reach * armScale);
    const cy = round2(sy - 4.6 * body.reach * armScale);
    const r = round2(3.2 * body.reach * clawScale);
    const arm: AvatarShape[] = [
      {
        kind: "path",
        d: `M${fmt(sx)} ${fmt(sy)}L${fmt(cx)} ${fmt(cy)}`,
        stroke: color,
        strokeWidth: 2.5,
        round: true,
      },
      circle(cx, cy, r, {
        fill: "none",
        stroke: color,
        strokeWidth: round2(r * 1.0625),
        dash: [78, 22],
        transform: `rotate(${side < 0 ? -92.4 : -8.4} ${fmt(cx)} ${fmt(cy)})`,
        part: "claw",
        ...(state === "working" ? { motion: "snap" as const, delay: side < 0 ? 0 : -300 } : {}),
      }),
    ];
    if (state === "done" && side > 0)
      arm.push(
        circle(cx + r * 0.634, cy - r * 0.706, r * 0.844, {
          fill: AVATAR_BALL,
          stroke: AVATAR_BALL_RIM,
          strokeWidth: 0.7,
          part: "ball",
        }),
      );
    const waving = state === "waiting" && side > 0;
    children.push(
      group(arm, {
        origin: [sx, sy],
        part: "arm",
        rotate: armPose[state][side < 0 ? 0 : 1],
        ...(waving ? { motion: "wave" as const, still: -54 } : {}),
      }),
    );
  }

  // Stalks.
  const eyes = clawlingEyeTips(body, choice.eyes);
  const shift: Point =
    state === "thinking"
      ? [1.8, -0.2]
      : state === "waiting"
        ? [0, -1.2]
        : state === "done"
          ? [0, -0.6]
          : [0, 0];
  const tips: Point[] = [];
  for (const { base, tip, side } of eyes) {
    let end: Point = [tip[0] + shift[0], tip[1] + shift[1]];
    let control: Point = [(base[0] + end[0]) / 2, (base[1] + end[1]) / 2];
    if (state === "blocked") {
      const lean = side === 0 ? -1 : side;
      end = [tip[0] + lean * 2.4, tip[1] + 4];
      control = [end[0] - lean * 0.4, base[1] - (base[1] - tip[1]) * 0.45];
    }
    tips.push(end);
    children.push({
      kind: "path",
      d: `M${fmt(base[0])} ${fmt(base[1])}Q${fmt(control[0])} ${fmt(control[1])} ${fmt(end[0])} ${fmt(end[1])}`,
      stroke: color,
      strokeWidth: 2.4,
      round: true,
      fill: "none",
      part: "stalk",
    });
  }

  const large = choice.eyes === "single";
  const eyeAt = eyeSockets(tips, large, state === "waiting" ? 1.1 : 1);
  const top = eyeAt[0]!;
  const sockets: AvatarSockets = {
    // One eye wears its hat on the socket's rim, riding the stalk; two eyes, on the body between them.
    head: large
      ? seat({ x: top.x, y: round2(top.y - 4.35 * top.k * top.scale + 0.5), scale: 0.8 }, "on-top")
      : seat(HEAD_SOCKETS.clawling[choice.body], "after-body"),
    band: eyeBand(eyeAt),
    eyes: eyeAt,
    neck: seat(NECK_SOCKETS.clawling[choice.body], "after-mouth"),
  };
  const worn = wornAt(choice, state, sockets);

  children.push(group([body.shape], { fill: color, part: "body" }), ...worn.at("after-body"));
  children.push(mouth(state, body.mouthY), ...worn.at("after-mouth"), ...worn.at("before-eyes"));
  eyes.forEach(({ side }, index) => {
    children.push(
      eye({
        at: tips[index]!,
        large,
        socket: color,
        lid: color,
        state,
        pupil: pupilFor(state, v.gaze, (x) => clamp(x + 0.2, -0.82, 0.82), 0.25),
        blink: v.blink + index * 50,
        side,
        ...(state === "waiting" ? { scale: 1.1 } : {}),
        wear: worn.lens(index),
      }),
    );
  });
  children.push(...worn.bridge, ...worn.at("on-top"));
  return { root: rootFor("clawling", state, children), sockets };
}

// Shellfolk.

function shellShapes(shell: ShellfolkShell, color: string, ink: string): AvatarShape[] {
  const pattern = { fill: "none", stroke: ink, round: true, fine: true, part: "pattern" };
  switch (shell) {
    case "turret":
      return [
        {
          kind: "path",
          d: "M14.5 30.2C14.4 22.6 20.4 12.6 30.6 6.4C32.9 5 35.3 6.7 34.8 9.4C33.3 17.6 33.4 23.6 34.6 28.8C34.9 30.2 34 31 32.6 31H15.3C14.8 31 14.5 30.7 14.5 30.2Z",
          fill: color,
          part: "shell",
        },
        {
          kind: "path",
          d: "M17.6 23.6C22.4 22.2 28.4 22.2 33.2 23.4M22.2 16C26 14.8 30 14.6 33.4 15.2",
          strokeWidth: 2,
          ...pattern,
        },
      ];
    case "dome":
      return [
        {
          kind: "path",
          d: "M13.6 30.6C13.6 20.8 18.6 13.6 25.2 13.6S36.8 20.8 36.8 30.6Z",
          fill: color,
          part: "shell",
        },
        {
          kind: "path",
          d: "M25.2 30V15.6M19.2 29.6C19.4 23 20.8 19 22.6 16.4M31.2 29.6C31 23 29.6 19 27.8 16.4",
          strokeWidth: 1.9,
          ...pattern,
        },
      ];
    case "spotted":
      return [
        { kind: "ellipse", cx: 24.8, cy: 21.4, rx: 11.4, ry: 9.8, fill: color, part: "shell" },
        group(
          [
            circle(21, 16.6, 2.3),
            circle(29.2, 18.4, 1.8),
            circle(25.6, 25.2, 2),
            circle(31.4, 25.6, 1.2),
          ],
          { fill: AVATAR_BALL, opacity: 0.9, part: "spots" },
        ),
      ];
    default:
      return [
        circle(24.6, 19.8, 11.2, { fill: color, part: "shell" }),
        {
          kind: "path",
          d: "M19.6 24.73L18.13 21.25L18.56 17.67L20.61 14.91L23.59 13.59L26.66 13.9L29.03 15.6L30.17 18.09L29.93 20.65L28.56 22.6L26.54 23.54L24.5 23.35L22.97 22.26L22.27 20.71L22.45 19.18L23.28 18.1L24.39 17.66L25.41 17.86L26.03 18.46L26.17 19.16",
          strokeWidth: 2.1,
          ...pattern,
        },
      ];
  }
}

function shellfolkScene(
  choice: Extract<AvatarChoice, { family: "shellfolk" }>,
  state: AvatarState,
  v: AvatarVariation,
): Built {
  const color = AVATAR_COLORS[choice.color];
  const shell = shellShapes(choice.shell, color, shade(color, 0.27));
  const pupil = pupilFor(state, v.gaze, (x) => x, 0.25);
  // The hat stays on the shell, whatever the critter does.
  const head = seat(HEAD_SOCKETS.shellfolk[choice.shell], "before-opening");
  if (state === "blocked") {
    // Hidden in the shell: its opening, and the eyes peeking out of it. No neck, so no band or bow tie.
    const dark = shade(color, 0.47);
    const peeks: Point[] = [
      [13.2, 29.4],
      [18.4, 29.4],
    ];
    const sockets: AvatarSockets = {
      head,
      band: null,
      eyes: eyeSockets(peeks, false, 1),
      neck: null,
    };
    const worn = wornAt(choice, state, sockets);
    const peek = (at: Point, index: number) =>
      eye({
        at,
        large: false,
        socket: null,
        lid: dark,
        state,
        pupil: [0, 1.02],
        blink: v.blink + index * 50,
        side: -1,
        wear: worn.lens(index),
      });
    const root = rootFor("shellfolk", state, [
      ...shell,
      ...worn.at("before-opening"),
      { kind: "ellipse", cx: 15.8, cy: 29.4, rx: 5.8, ry: 3.8, fill: dark, part: "opening" },
      group([...peeks.map(peek), ...worn.bridge], {
        transform: "translate(15.8 29.4) scale(.8) translate(-15.8 -29.4)",
      }),
    ]);
    return { root, sockets };
  }
  const rise = state === "waiting" ? -3 : state === "done" ? -1 : 0;
  const reach = state === "waiting" ? -4.2 : state === "done" ? -1.4 : 0;
  const tips: Point[] = [
    [6.2, 13.4 + reach],
    [13.4, 12.6 + reach],
  ];
  const eyeAt = eyeSockets(tips, false, state === "waiting" ? 1.1 : 1);
  const sockets: AvatarSockets = {
    head,
    band: eyeBand(eyeAt),
    eyes: eyeAt,
    neck: seat(NECK_SOCKETS.shellfolk, "in-neck"),
  };
  const worn = wornAt(choice, state, sockets);
  const neck: AvatarShape[] = [
    {
      kind: "path",
      d: `M5.6 33C4.8 27 6.2 ${fmt(21.6 + rise)} 9.8 ${fmt(20.6 + rise)}C13.2 ${fmt(19.8 + rise)} 15 23 15 27V33Z`,
      fill: SHELLFOLK_CREAM,
      part: "head",
    },
    ...worn.at("in-neck"),
    {
      kind: "path",
      d: `M8.4 ${fmt(22 + rise)}L6.2 ${fmt(tips[0]![1])}`,
      stroke: SHELLFOLK_CREAM,
      strokeWidth: 2.2,
      round: true,
      part: "stalk",
    },
    {
      kind: "path",
      d: `M12.2 ${fmt(22 + rise)}L13.4 ${fmt(tips[1]![1])}`,
      stroke: SHELLFOLK_CREAM,
      strokeWidth: 2.2,
      round: true,
      part: "stalk",
    },
    ...worn.at("before-eyes"),
    ...tips.map((at, index) =>
      eye({
        at,
        large: false,
        socket: SHELLFOLK_CREAM,
        lid: SHELLFOLK_CREAM,
        state,
        pupil,
        blink: v.blink + index * 50,
        side: index === 0 ? -1 : 1,
        ...(state === "waiting" ? { scale: 1.1 } : {}),
        wear: worn.lens(index),
      }),
    ),
    ...worn.bridge,
  ];
  const root = rootFor("shellfolk", state, [
    {
      kind: "path",
      d: "M4.6 33.2C4.6 30.6 6.4 29.2 8.8 29.2H32.4C34.6 29.2 36 30.6 36 32.6C36 34.1 34.9 35 33.4 35H6.4C5.4 35 4.6 34.2 4.6 33.2Z",
      fill: SHELLFOLK_CREAM,
      part: "foot",
    },
    group(neck, {
      origin: [10, 31],
      part: "neck",
      ...(state === "thinking" ? { motion: "tilt" as const } : {}),
    }),
    ...shell,
    ...worn.at("before-opening"),
  ]);
  return { root, sockets };
}

// Lanterns.

type LanternBodySpec = {
  shape: AvatarShape;
  /** The top of the body, where a lure grows from. */
  top: number;
  /** Eye centres for two eyes, left and right x, and the eyes' height. */
  eyes: [number, number, number];
  mouthY: number;
};

const LANTERN_BODY: Record<LanternBody, LanternBodySpec> = {
  round: {
    shape: { kind: "circle", cx: 20, cy: 25, r: 11.4 },
    top: 13.6,
    eyes: [16, 24, 23.4],
    mouthY: 29,
  },
  bell: {
    shape: {
      kind: "path",
      d: "M20 13.6C24.6 13.6 27.4 17.6 28.6 21.4C31.8 22.8 33 25.8 33 28.6C33 33 29.4 35.6 25 35.6H15C10.6 35.6 7 33 7 28.6C7 25.8 8.2 22.8 11.4 21.4C12.6 17.6 15.4 13.6 20 13.6Z",
    },
    top: 13.6,
    eyes: [16.4, 23.6, 24.2],
    mouthY: 29.8,
  },
  oval: {
    shape: { kind: "ellipse", cx: 20, cy: 25.4, rx: 13, ry: 9.8, transform: "rotate(-7 20 25)" },
    top: 15.6,
    eyes: [16, 24, 24.2],
    mouthY: 30.6,
  },
  box: {
    shape: { kind: "rect", x: 8, y: 15, width: 24, height: 20.5, rx: 9.5 },
    top: 15,
    eyes: [15.8, 24.2, 23.8],
    mouthY: 29.4,
  },
};

/** Each lure: its stem from where it leaves the body, and its ball. */
const LANTERN_LURE: Record<LanternLure, { d: string; base: number; ball: Point }> = {
  hook: {
    d: "M19.4 13.8C18.8 8.4 21.8 4.6 26.2 4.8C28.8 4.9 30.6 6.8 30.6 9.4",
    base: 13.8,
    ball: [30.6, 10.2],
  },
  flick: { d: "M20 13.8C20.2 10.4 20.8 7.8 22.2 5.2", base: 13.8, ball: [22.6, 4.6] },
  wave: {
    d: "M20.6 15.8C20.6 12.4 24.4 12.6 24.4 9.8C24.4 7.2 20.8 7.4 20.6 4.8",
    base: 15.8,
    ball: [20.6, 4.2],
  },
  reach: { d: "M21 15.2C22.4 10.2 26.6 7 32 7.4", base: 15.2, ball: [32.6, 7.6] },
};

function lanternScene(
  choice: Extract<AvatarChoice, { family: "lantern" }>,
  state: AvatarState,
  v: AvatarVariation,
): Built {
  const color = AVATAR_COLORS[choice.color];
  const body = LANTERN_BODY[choice.body];
  const lure = LANTERN_LURE[choice.lure];
  // A lure that would start above a lower body moves down to it; one that starts inside stays.
  const drop = Math.max(0, round2(body.top + 0.2 - lure.base));
  const [bx, by] = lure.ball;
  const ball = AVATAR_BALL;
  const lureChildren: AvatarShape[] = [
    {
      kind: "path",
      d: lure.d,
      stroke: color,
      strokeWidth: 2.2,
      round: true,
      fill: "none",
      part: "stem",
    },
  ];
  if (state === "waiting")
    lureChildren.push(
      circle(bx, by, 2.9, {
        fill: "none",
        stroke: ball,
        strokeWidth: 1.4,
        fixedStroke: true,
        origin: [bx, by],
        motion: "ping",
        part: "ping",
      }),
    );
  lureChildren.push(
    circle(bx, by, 2.9, {
      fill: state === "blocked" ? AVATAR_BALL_DIM : ball,
      stroke: state === "blocked" ? AVATAR_BALL_DIM : AVATAR_BALL_RIM,
      strokeWidth: 0.7,
      part: "ball",
      ...(state === "thinking" ? { motion: "glow" as const } : {}),
    }),
  );
  const lureMotion: AvatarMotionName | null =
    state === "thinking" ? "lure-sway" : state === "working" ? "conduct" : null;
  const lureGroup = group(lureChildren, {
    origin: [20, lure.base + 1],
    part: "lure",
    ...(state === "blocked" ? { rotate: -58 } : {}),
    ...(lureMotion ? { motion: lureMotion } : {}),
  });
  const single = choice.eyes === "one";
  const [lx, rx, ey] = body.eyes;
  const spots: Array<{ at: Point; side: -1 | 0 | 1 }> = single
    ? [{ at: [20, ey], side: 0 }]
    : [
        { at: [lx, ey], side: -1 },
        { at: [rx, ey], side: 1 },
      ];
  const hatSeat = seat(HEAD_SOCKETS.lantern[choice.body], "after-body");
  // Blocked, the lure droops to the left, where the hat sits: the hat slips down the body's side.
  if (state === "blocked")
    Object.assign(hatSeat, { x: hatSeat.x - 2.4, y: hatSeat.y + 3.2, tilt: hatSeat.tilt - 30 });
  const sockets: AvatarSockets = {
    head: hatSeat,
    band: { ...LANTERN_HEADPHONES[choice.body], layer: "after-body" },
    eyes: eyeSockets(
      spots.map(({ at }) => at),
      single,
      state === "waiting" ? 1.1 : 1,
    ),
    neck: seat(NECK_SOCKETS.lantern[choice.body], "after-mouth"),
  };
  const worn = wornAt(choice, state, sockets);
  const root = rootFor("lantern", state, [
    drop ? group([lureGroup], { transform: `translate(0 ${fmt(drop)})` }) : lureGroup,
    group([body.shape], { fill: color, part: "body" }),
    ...worn.at("after-body"),
    ...spots.map(({ at, side }, index) =>
      eye({
        at,
        large: single,
        socket: color,
        lid: color,
        state,
        // Thinking, it looks up and right, at its lure.
        pupil: pupilFor(state, v.gaze, (x) => clamp(Math.max(x, 0) + 0.68, 0.68, 1.02), 0.1),
        blink: v.blink + index * 50,
        side,
        ...(state === "waiting" ? { scale: 1.1 } : {}),
        wear: worn.lens(index),
      }),
    ),
    ...worn.bridge,
    mouth(state, body.mouthY),
    ...worn.at("after-mouth"),
  ]);
  return { root, sockets };
}

/**
 * A creature in a state, ready to draw: everything on the 40-unit grid, with
 * each moving part naming its motion. The pose without motion is the state's
 * still pose, which is what reduced motion shows.
 */
function fitOf(choice: AvatarChoice): { fit: number; shift: [number, number] } {
  // An outfit that would leave the circle has its own fit; any other uses its bare creature's.
  const entry =
    (wears(choice) ? AVATAR_FIT_INSET[avatarOutfitKey(choice)] : undefined) ??
    AVATAR_FIT[avatarFitKey(choice)];
  const [fit, dx, dy] = (entry ?? "1 0 0").split(" ").map(Number) as [number, number, number];
  return { fit, shift: [dx, dy] };
}

export function avatarScene(
  choice: AvatarChoice,
  state: AvatarState,
  variation: AvatarVariation,
): AvatarScene {
  const { root, sockets } =
    choice.family === "clawling"
      ? clawlingScene(choice, state, variation)
      : choice.family === "shellfolk"
        ? shellfolkScene(choice, state, variation)
        : lanternScene(choice, state, variation);
  return { choice, state, muted: state === "blocked", root, ...fitOf(choice), sockets };
}
