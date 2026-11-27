// A name a bot wrote for itself, applied at once with Undo ("Doing, not asking" in
// docs/decisions.md; F-552).
//
// A bot asked to take a name edits the `- Name:` line of its own IDENTITY.md.
// The name Clawtrate shows is the bot's identity in the gateway's config,
// which takes precedence over the file, so the edit changes nothing a person
// sees. After each finished run of a bot whose task is open, Clawtrate reads
// that one file. When its name line differs from the bot's name, one device
// renames the bot with `agents.update`, keeps the name before in the record of
// changes on the gateway (`users.prefs`, `NAME_RECORD_KEY`), and the
// conversation says what happened, with Undo. Whose ask it was is judged
// silently: the line says the person's only when the run shows it, and Undo
// is always there. A rename that isn't made is said in the same place.
//
// The record is one preference any of the person's paired devices can
// replace, so nothing in it is believed beyond what it can be checked
// against: a name in it passes the rules a new name does, Undo names the name
// it puts back and reads the bot's name back after, and the device that
// applied a rename keeps its own copy of it. One claim per bot in the record
// keeps Clawtrate's own writers to one at a time; a writer outside Clawtrate
// isn't held by it.

import { sha256Hex, utf8Bytes } from "./bytes.ts";
import { utf8Length } from "./encoding.ts";
import type { KeyValueStore } from "./host.ts";
import { asRecord } from "./mapping.ts";
import {
  CONNECTION_CHANGED_AFTER_SEND,
  sameStamp,
  type Bot,
  type GatewayStamp,
  type NameLine,
  type NameRecordChange,
  type NameSource,
  type NameWhose,
} from "./types.ts";

/** A name as long as New bot's Name field takes. */
export const MAX_BOT_NAME_CHARS = 40;
/** An IDENTITY.md longer than this is not read for a name. */
export const MAX_IDENTITY_CHARS = 16_384;
/** Lines, and bots skipped, at most: one per bot the state lists (`MAX_BOTS`). */
export const MAX_NAME_CARDS = 32;
/** Runs whose end was checked, the latest kept: a repeated end of one of them reads nothing. */
export const MAX_CHECKED_RUNS = 64;
/** A run id longer than this isn't kept: its end is checked each time it comes. */
export const MAX_CHECKED_RUN_CHARS = 256;
/** What a line says of a rename that didn't land, at most. */
export const MAX_NAME_ERROR_CHARS = 512;
/** Runs this device started, the latest kept, with the text sent (the first characters). */
export const MAX_SENT_RUNS = 64;
export const MAX_SENT_TEXT_CHARS = 4_000;
/** The record of changes: one user preference on the gateway, its bound the gateway's own. */
export const NAME_RECORD_KEY = "clawtrate.changes";
export const MAX_RECORD_BYTES = 4_096;
export const MAX_RECORD_CHANGES = 8;
export const MAX_RECORD_DECLINED = 8;
/** Bots whose renames the record counts today: one per bot the state lists (`MAX_BOTS`). */
export const MAX_RECORD_COUNTS = 32;
/** Claims on a bot's name under way at once, one per bot. */
export const MAX_RECORD_CLAIMS = 8;
/** How long Undo is offered, how long a change is kept, and how long an Undo declines its edit. */
export const UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many renames of one bot are applied in a UTC day. */
export const MAX_RENAMES_PER_DAY = 3;
/** A device that didn't send the run waits this long, so the one that did applies it first. */
export const CLAIM_DELAY_MS = 5_000;
/**
 * A claim older than this was abandoned: the device that took it stopped, or its answers were
 * lost. Longer than the client's own 60-second request timeout (`REQUEST_TIMEOUT_MS`), so a claim
 * whose rename is still on its way is never taken over.
 */
export const CLAIM_EXPIRY_MS = 120_000;
/**
 * A claim older than this sends nothing; it is taken again first. Its rename, answered or given up
 * within the client's 60-second request timeout, then ends before the claim could expire and be
 * settled by another device as a rename that never landed.
 */
export const CLAIM_SEND_MS = CLAIM_EXPIRY_MS - 60_000;
/** Times a record write is tried again after another device's write came first. */
export const RECORD_WRITE_ATTEMPTS = 4;
/** Times a claim is taken again because the connection changed before its rename was sent. */
export const CLAIM_ATTEMPTS = 3;
/** A change dated this far ahead of this device's clock is not believed. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_RECORD_BOT_CHARS = 128;
/** The host storage key the earlier card kept Not now under; removed, it no longer counts. */
export const NAME_DECLINES_KEY = "clawtrate.bot-name-declines";

const PLACEHOLDERS = new Set(["not set yet", "pick something you like"]);
/** A picture `agents.update` copied into IDENTITY.md from the config (R38). */
const PICTURE_LINE = /^- Avatar: data:[^\n]*(\n|$)/gm;
/**
 * The tools whose result is no outside content: asking the person, a progress card, and handing
 * work to a task (its acceptance only). Any other tool, Clawtrate's own read aside, counts as
 * reading something, a tool this list doesn't know included.
 */
const QUIET_TOOLS = new Set(["ask_user", "progress_card", "sessions_spawn"]);
const WEB_TOOLS = /^(web_search|web_fetch|browser)/;
/** Tools whose result is a file's content, the edits included: their result shows the file's lines. */
const FILE_TOOLS = new Set(["read", "ls", "find", "grep", "glob", "edit", "write", "apply_patch"]);
/** Tools whose result is another conversation's history or results. */
const CONVERSATION_TOOLS = new Set([
  "sessions_send",
  "sessions_history",
  "sessions_list",
  "subagents",
]);
const NAME_WRITES = new Set(["edit", "write", "apply_patch"]);

/**
 * The name an IDENTITY.md gives, read as the gateway reads it: the last line labelled `Name`,
 * with or without a list marker and emphasis (`- **Name:** Johnny`, `- Name: Johnny`), and not
 * the template's placeholder. Null when it gives none.
 */
export function identityName(content: string): string | null {
  let found: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    const cleaned = line.trim().replace(/^-\s*/, "");
    const colon = cleaned.indexOf(":");
    if (colon === -1) continue;
    if (cleaned.slice(0, colon).replace(/[*_`]/g, "").trim().toLowerCase() !== "name") continue;
    const value = cleaned
      .slice(colon + 1)
      .replace(/^[*_`\s]+|[*_`\s]+$/g, "")
      .trim();
    const bare = value
      .replace(/^\((.*)\)$/, "$1")
      .trim()
      .toLowerCase();
    if (value && !PLACEHOLDERS.has(bare)) found = value;
  }
  return found;
}

/**
 * A bot's name as a rename saves it, from text a bot wrote: control characters and line breaks
 * become spaces, direction controls and invisible spaces go, runs of space one, the ends trimmed,
 * as both gateway versions store a name (`sanitizeAgentIdentityLine`); then cut to
 * `MAX_BOT_NAME_CHARS` characters. Null when nothing is left.
 */
export function plainName(raw: string): string | null {
  const spaced = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    // Direction controls and invisible spaces: a name reads as the characters it has. U+200C and
    // U+200D stay, as emoji sequences and some scripts need them.
    .replace(/[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, "");
  const name = Array.from(spaced.replace(/\s+/g, " ").trim())
    .slice(0, MAX_BOT_NAME_CHARS)
    .join("")
    // Emphasis marks the gateway strips when it reads the line back, which a cut can leave at an end.
    .replace(/^[*_`\s]+|[*_`\s]+$/g, "");
  return name || null;
}

/** A name as names are compared: spaces collapsed and case ignored. */
const folded = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Whether a name is one a rename may set, and Undo may put back: exactly what `plainName` leaves
 * of it, so the gateway stores it as it is and reads it back the same.
 */
export const isPlainName = (value: unknown): value is string =>
  typeof value === "string" && plainName(value) === value;

/** Whether another bot than `botId` has `name`, compared as names are. */
export const nameTaken = (bots: readonly Bot[], botId: string, name: string) =>
  bots.some((each) => each.id !== botId && folded(each.name) === folded(name));

/** The record's tag for a run, or for a file's text: the first 16 hex digits of its SHA-256. */
export const runTag = (runId: string) => sha256Hex(utf8Bytes(runId)).slice(0, 16);

const WORD = /[\p{L}\p{N}\p{M}_]/u;
/** Hyphens join words: "juniper-berry" is one word, not Juniper. */
const HYPHEN = /[-‐‑]/;

/**
 * Whether `name` is in `text` as whole words, both compared as names are: "call yourself Juniper!"
 * names Juniper; "Junipers", "my juniper-berry" and "Pip" in "Pippa" don't. When `cut`, the text
 * stops where the device stopped keeping it, so its end is no word's end.
 */
export function namesInText(text: string, name: string, cut = false): boolean {
  const haystack = folded(text);
  const needle = folded(name);
  if (!needle) return false;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = Array.from(haystack.slice(Math.max(0, at - 2), at)).at(-1) ?? "";
    const after = Array.from(haystack.slice(at + needle.length, at + needle.length + 2))[0] ?? "";
    const edge = (inner: string, outer: string) =>
      !(WORD.test(inner) && WORD.test(outer)) && !HYPHEN.test(outer);
    const first = Array.from(needle)[0]!;
    const last = Array.from(needle).at(-1)!;
    if (cut && at + needle.length === haystack.length) continue;
    if (edge(first, before) && edge(last, after)) return true;
  }
  return false;
}

/** One step of a run, as the engine has it: the tool, the text of its arguments, and whether it succeeded. */
export type RunStepFacts = { toolName: string | null; args: string | null; ok: boolean };

/** What this device knows of the run that wrote a name, to judge whose ask it was. */
export type RunFacts = {
  /** This device sent the message that started the run, in this conversation. */
  sentHere: boolean;
  /** What that message said (its first characters), or null. */
  text: string | null;
  /** The text was longer than the device keeps: its end is not the message's. */
  cut?: boolean;
  /** That message carried files. */
  attachments: boolean;
  /** A steer joined the run: one this device sent, or another message seen within it. */
  steered: boolean;
  /** The run's steps, or null when they aren't all held here. */
  steps: RunStepFacts[] | null;
};

/**
 * Whose a rename was (`NameWhose`), and what the run read first, when known. The person's only
 * when all of these hold: this device sent the run's message in this conversation, with no files;
 * no steer joined the run; a successful write of the bot's own IDENTITY.md is among its steps; no
 * step before the last such write read outside content (a read of any file, the bot's own
 * IDENTITY.md included, the web, another conversation, or a tool this doesn't know); and the name
 * is in the person's message as whole words. A run with such a write that fails any of the rest is
 * the bot's. A run with no such write seen (its steps aren't all held, or the file changed some
 * other way) is the file's: never shown as the person's, nor as the bot renaming itself.
 */
export function judgeRename(
  facts: RunFacts,
  name: string,
): { whose: NameWhose; source: NameSource } {
  const steps = facts.steps;
  if (steps === null) return { whose: "file", source: null };
  const write = steps.findLastIndex(
    (step) =>
      step.ok &&
      step.toolName !== null &&
      NAME_WRITES.has(step.toolName) &&
      ownIdentityFile(step.toolName, step.args),
  );
  if (write === -1) return { whose: "file", source: null };
  let source: NameSource = null;
  for (const step of steps.slice(0, write)) {
    const tool = step.toolName;
    if (!tool || QUIET_TOOLS.has(tool) || tool.startsWith("clawtrate_")) continue;
    source = WEB_TOOLS.test(tool)
      ? "web"
      : FILE_TOOLS.has(tool)
        ? "file"
        : CONVERSATION_TOOLS.has(tool)
          ? "conversation"
          : "tool";
    break;
  }
  // Files sent with the message are outside content too: the person's words aren't all of it.
  if (source === null && facts.sentHere && facts.attachments) source = "attachment";
  const person =
    facts.sentHere &&
    !facts.steered &&
    source === null &&
    facts.text !== null &&
    namesInText(facts.text, name, facts.cut ?? false);
  return { whose: person ? "person" : "bot", source };
}

/**
 * Whether a step acts on the bot's own `IDENTITY.md` and nothing else: its path argument names
 * exactly that file at the top of its folder, or, for a patch, every file it names is that one.
 * Text that merely mentions the file, or `notes/IDENTITY.md`, isn't it.
 */
function ownIdentityFile(tool: string, args: string | null): boolean {
  let parsed: Record<string, unknown> | null;
  try {
    parsed = asRecord(JSON.parse(args ?? "null"));
  } catch {
    return false;
  }
  const isOwn = (path: unknown) =>
    typeof path === "string" && path.trim().replace(/^\.\//, "") === "IDENTITY.md";
  if (tool === "apply_patch") {
    const files = [
      ...String(parsed?.input ?? parsed?.patch ?? "").matchAll(
        /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm,
      ),
    ].map((match) => match[1]);
    return files.length > 0 && files.every(isOwn);
  }
  return isOwn(parsed?.path ?? parsed?.file_path);
}

/** An Undo's decline: that edit (the bot, the name and the file as it was), until it expires. */
export type NameDecline = { bot: string; name: string; file: string; at: number };

/**
 * One writer's hold on a bot's name: a rename or an Undo (`undo`) of the change `run` names, by
 * the operation `op`, taken at `at`. Fresh for `CLAIM_EXPIRY_MS`.
 */
export type NameClaim = { bot: string; op: string; run: string; at: number; undo?: true };

/** A record as the gateway holds it, checked entry by entry: anything malformed is dropped. */
export type NameRecord = {
  rev: number;
  changes: NameRecordChange[];
  declined: NameDecline[];
  /** Confirmed renames per bot and UTC day, kept apart from the changes, which other bots' can push out. */
  counts: Array<{ bot: string; day: string; n: number }>;
  claims: NameClaim[];
};

/** The UTC day a time falls on, as `YYYY-MM-DD`: what the day's limit counts by. */
export const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);
/**
 * The first UTC day whose counts a record keeps when written on `day`: the day before too, which
 * a device whose clock hasn't passed midnight yet still counts on.
 */
const keptFrom = (day: string) => dayOf(Date.parse(`${day}T00:00:00Z`) - 1);

const isBot = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_RECORD_BOT_CHARS;
const isTag = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
/** A time a `Date` can hold: past its range, `dayOf` would throw. */
const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8.64e15;
const SOURCES = new Set(["web", "file", "conversation", "tool", "attachment"]);
const WHOSE = new Set(["person", "bot", "file"]);

/**
 * The record read from `users.prefs`, believed only as far as each entry passes the checks a new
 * name would: any of the person's paired devices can write that store (on OpenClaw 2026.11.10
 * with read access alone), so a forged or malformed entry, a name before that a rename couldn't
 * set, one older than Undo's window or dated in the future, offers nothing.
 */
export function parseNameRecord(raw: unknown, now: number): NameRecord {
  const value = asRecord(raw);
  const rev = typeof value?.rev === "number" && Number.isSafeInteger(value.rev) ? value.rev : 0;
  const recent = (at: unknown): at is number =>
    isTime(at) && at <= now + CLOCK_SKEW_MS && now - at <= UNDO_WINDOW_MS;
  const listOf = (key: string, max: number) =>
    (Array.isArray(value?.[key]) ? (value[key] as unknown[]).slice(-max) : []).map(asRecord);
  const changes: NameRecordChange[] = [];
  for (const entry of listOf("changes", MAX_RECORD_CHANGES)) {
    if (!entry || !isBot(entry.bot) || entry.field !== "name") continue;
    if (!isPlainName(entry.from) || !isPlainName(entry.to) || entry.from === entry.to) continue;
    if (!recent(entry.at) || !isTag(entry.run) || !isTag(entry.file)) continue;
    if (typeof entry.whose !== "string" || !WHOSE.has(entry.whose)) continue;
    const { done, undone, source } = entry;
    if (done !== undefined && !isTime(done)) continue;
    if (undone !== undefined && !isTime(undone)) continue;
    changes.push({
      bot: entry.bot,
      field: "name",
      from: entry.from,
      to: entry.to,
      at: entry.at,
      run: entry.run,
      whose: entry.whose as NameWhose,
      source: typeof source === "string" && SOURCES.has(source) ? (source as NameSource) : null,
      file: entry.file,
      ...(done === undefined ? {} : { done }),
      ...(undone === undefined ? {} : { undone }),
    });
  }
  const declined: NameDecline[] = [];
  for (const entry of listOf("declined", MAX_RECORD_DECLINED))
    if (
      entry &&
      isBot(entry.bot) &&
      isPlainName(entry.name) &&
      isTag(entry.file) &&
      recent(entry.at)
    )
      declined.push({ bot: entry.bot, name: entry.name, file: entry.file, at: entry.at });
  const counts: NameRecord["counts"] = [];
  for (const entry of listOf("counts", MAX_RECORD_COUNTS))
    if (
      entry &&
      isBot(entry.bot) &&
      typeof entry.day === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(entry.day) &&
      typeof entry.n === "number" &&
      Number.isSafeInteger(entry.n) &&
      entry.n > 0
    )
      counts.push({ bot: entry.bot, day: entry.day, n: entry.n });
  const claims: NameClaim[] = [];
  for (const entry of listOf("claims", MAX_RECORD_CLAIMS))
    if (entry && isBot(entry.bot) && isTag(entry.op) && isTag(entry.run) && recent(entry.at))
      claims.push({
        bot: entry.bot,
        op: entry.op,
        run: entry.run,
        at: entry.at,
        ...(entry.undo === true ? { undo: true as const } : {}),
      });
  return { rev, changes, declined, counts, claims };
}

/**
 * The record cut to what the gateway keeps: the newest entries that fit in `MAX_RECORD_BYTES`.
 * Claims are never dropped; a write whose claims alone don't fit isn't made (`writeRecord`).
 */
export function fitNameRecord(record: NameRecord): NameRecord {
  const claims = record.claims.slice(-MAX_RECORD_CLAIMS);
  const next = {
    rev: record.rev,
    changes: record.changes.slice(),
    declined: record.declined.slice(-MAX_RECORD_DECLINED),
    counts: record.counts.slice(-MAX_RECORD_COUNTS),
    claims,
  };
  // The oldest change no claim holds goes first: a claim's rename keeps its entry to confirm.
  while (next.changes.length > MAX_RECORD_CHANGES) {
    const at = unheld(next.changes, claims);
    if (at === -1) break;
    next.changes.splice(at, 1);
  }
  // The counts are small and outlast the changes: the day's limit holds while history goes.
  while (utf8Length(JSON.stringify(next)) > MAX_RECORD_BYTES) {
    const at = unheld(next.changes, claims);
    if (next.declined.length > next.changes.length) next.declined.shift();
    else if (at !== -1) next.changes.splice(at, 1);
    else if (next.counts.length > 0) next.counts.shift();
    else break;
  }
  return next;
}

/** The first change no claim holds, or -1. */
function unheld(changes: readonly NameRecordChange[], claims: readonly NameClaim[]): number {
  return changes.findIndex(
    (change) => !claims.some((claim) => claim.run === change.run && claim.bot === change.bot),
  );
}

/** How many renames of a bot the record counts on a day. */
export const renamesOn = (record: NameRecord, bot: string, day: string) =>
  record.counts.find((each) => each.bot === bot && each.day === day)?.n ?? 0;

/** A claim on `bot` by another operation than `op`, taken within `CLAIM_EXPIRY_MS`. */
const otherClaim = (record: NameRecord, bot: string, op: string, now: number) =>
  record.claims.find(
    (each) => each.bot === bot && each.op !== op && now - each.at < CLAIM_EXPIRY_MS,
  );

/**
 * Whether Undo can be offered for a change: kept, not undone, the latest change of its bot's name,
 * within Undo's window, the bot still called what the change made it, and the name it puts back
 * not another bot's. Where it is offered also takes a connection that may change bots.
 */
export function canUndoName(
  change: NameRecordChange,
  changes: readonly NameRecordChange[],
  bots: readonly Bot[],
  now: number,
): boolean {
  if (change.undone !== undefined || now - change.at > UNDO_WINDOW_MS) return false;
  const latest = changes.filter((each) => each.bot === change.bot).at(-1);
  if (latest?.run !== change.run) return false;
  if (bots.find((bot) => bot.id === change.bot)?.name !== change.to) return false;
  return isPlainName(change.from) && !nameTaken(bots, change.bot, change.from);
}

/**
 * Whether a change landed, as far as Clawtrate can tell: marked done, or its bot's latest change
 * while the bot has its name (a rename whose mark couldn't be written).
 */
const landed = (
  change: NameRecordChange,
  changes: readonly NameRecordChange[],
  bots: readonly Bot[],
) =>
  change.done !== undefined ||
  (changes.filter((other) => other.bot === change.bot).at(-1)?.run === change.run &&
    bots.find((bot) => bot.id === change.bot)?.name === change.to);

/**
 * The changes a bot's settings list: those that landed, or were undone. A claim whose rename was
 * never confirmed, left by a lost answer or a device that stopped, is not a rename.
 */
export const shownChanges = (changes: readonly NameRecordChange[], bots: readonly Bot[]) =>
  changes.filter((each) => each.undone !== undefined || landed(each, changes, bots));

export type BotNamesContext = {
  request: (method: string, params: unknown) => Promise<unknown>;
  bots: () => Bot[];
  /** Connected, with `operator.admin`, on a host that writes. */
  canRename: () => boolean;
  /** Where a read is made now: the gateway's identity and the host's target (`gatewayStamp`). */
  stamp: () => GatewayStamp;
  /**
   * The connection's own key, new with each connection and each socket, an automatic reconnect to
   * the same gateway included.
   */
  generation: () => string;
  /** Refuse unless `stamp` is still where the host is connected, as every bot write does. */
  sameGateway: (stamp: GatewayStamp) => Promise<void>;
  /** The host's storage: only to forget what the earlier card kept there. */
  storage: KeyValueStore;
  /** Take one of the client's file reads, or null when they are all in use. */
  takeRead: () => (() => void) | null;
  refreshBots: () => Promise<void>;
  /**
   * The steps of a run in a task as the engine holds them, or null when it doesn't hold them
   * all, and whether a message other than the run's own was seen within it (a steer).
   */
  runFacts: (
    sessionKey: string,
    runId: string,
  ) => { steps: RunStepFacts[] | null; steered: boolean };
  /** Read a task's history now, so what it holds covers a run that just ended. Whether it did. */
  readHistory: (sessionKey: string) => Promise<boolean>;
  /** Whether an error is the gateway refusing for a missing scope (and note it). */
  missingScope: (error: unknown) => boolean;
  /** Whether an error is the gateway's own refusal, so nothing was written (`isCertainRefusal`). */
  certainRefusal: (error: unknown) => boolean;
  now: () => number;
  /** The wait of a device that didn't send the run before it applies a name (`CLAIM_DELAY_MS`). */
  waitToClaim: () => Promise<void>;
  publishLines: (lines: NameLine[]) => void;
  publishRecord: (record: { stamp: GatewayStamp; changes: NameRecordChange[] } | null) => void;
  log: (text: string) => void;
};

/**
 * Whether two stamps name the same preference store: the same verified gateway, whatever the
 * host's target, which a reconnect to the same gateway changes. Requests still go only on the
 * connection the operation began on.
 */
const sameStore = (a: GatewayStamp, b: GatewayStamp) =>
  a.gatewayId !== null && a.gatewayId === b.gatewayId;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Where a record operation began: the gateway and the very connection it is bound to. */
type RecordOp = { stamp: GatewayStamp; generation: string };

/** What a rename's line says of whose it was, its run, and the file as it was read. */
export type RenameOrigin = { whose: NameWhose; source: NameSource; run: string; file: string };

/** A change this device applied, kept here: its own Undo prefers it to the shared record. */
type Applied = {
  gatewayId: GatewayStamp["gatewayId"];
  botId: string;
  run: string;
  from: string;
  to: string;
  file: string;
};

const NOTHING_SENT = "The connection changed, so nothing was sent.";
const NO_LONGER = "That change can no longer be undone.";
const UNCONFIRMED = "Clawtrate couldn't read the bot list again, so this isn't confirmed.";
const UNRECORDED =
  "Clawtrate couldn't save this rename to the gateway's record yet, so its Undo and count may be missing.";

export class BotNames {
  /** Each bot's line, and when it was set here: a later change on the gateway replaces an earlier line. */
  private lines = new Map<string, { line: NameLine; at: number }>();
  /** The read under way for each bot, by a token of its own, so only that read ends it. */
  private readonly reading = new Map<string, object>();
  private readonly skipped = new Set<string>();
  /** Runs already checked (`MAX_CHECKED_RUNS`), so one run reads the file once. */
  private readonly checkedRuns = new Set<string>();
  /** Runs this device started, by id: their task, the text sent, its files, and a steer of its own. */
  private readonly sentRuns = new Map<
    string,
    { sessionKey: string; text: string; cut: boolean; attachments: boolean; steered: boolean }
  >();
  /** Renames this device applied (`MAX_NAME_CARDS`), by gateway and run. */
  private readonly applied = new Map<string, Applied>();
  /** Changes whose line was closed on this device (`MAX_NAME_CARDS`): not shown again here. */
  private readonly dismissed = new Set<string>();
  /**
   * Undos whose change this device couldn't mark undone on the gateway, by gateway and bot, at
   * most `MAX_NAME_CARDS` (`MAX_BOTS`): their edits count as declined here, and are written again.
   */
  private readonly unrecorded = new Map<
    string,
    { stamp: GatewayStamp; botId: string; name: string; run: string; file: string; op: string }
  >();
  /** The record as last published: the same object the state holds. */
  private published: { stamp: GatewayStamp; changes: NameRecordChange[] } | null = null;
  /** Moves on with every reset, so a read begun before it changes nothing after. */
  private epoch = 0;
  private forgotDeclines = false;

  private readonly ctx: BotNamesContext;

  constructor(ctx: BotNamesContext) {
    this.ctx = ctx;
  }

  /** This device sent a message that starts a run: its id is that run's id (`chat.send`). */
  sent(sessionKey: string, runId: string, text: string, attachments = false): void {
    if (runId.length > MAX_CHECKED_RUN_CHARS) return;
    this.sentRuns.delete(runId);
    this.sentRuns.set(runId, {
      sessionKey,
      text: text.slice(0, MAX_SENT_TEXT_CHARS),
      cut: text.length > MAX_SENT_TEXT_CHARS,
      attachments,
      steered: false,
    });
    if (this.sentRuns.size > MAX_SENT_RUNS)
      this.sentRuns.delete(this.sentRuns.keys().next().value!);
  }

  /** This device steered a message into a run: the run is no longer one message's. */
  steered(runId: string): void {
    const sent = this.sentRuns.get(runId);
    if (sent) sent.steered = true;
  }

  /**
   * A run of `botId` ended in an open task: read its name line once, and apply a new name, or
   * say why not. A run already checked (its end delivered twice) reads nothing again.
   */
  async afterRun(botId: string, sessionKey: string, runId?: string): Promise<void> {
    if (this.reading.has(botId) || this.skipped.has(botId)) return;
    void this.forgetOldDeclines();
    const counted = runId !== undefined && runId.length <= MAX_CHECKED_RUN_CHARS;
    if (counted && this.checkedRuns.has(runId)) return;
    const bot = this.ctx.bots().find((each) => each.id === botId);
    // The gateway's default bot takes its name in OpenClaw's own first run, which saves the config
    // too, and the gateway renames an implicit `main` only through its config (R13, R16).
    if (!bot || bot.isDefault) return;
    const release = this.ctx.takeRead();
    if (!release) return;
    // Counted only once its read has a slot: an end that found every read busy can be checked
    // when it comes again.
    if (counted) {
      this.checkedRuns.add(runId);
      if (this.checkedRuns.size > MAX_CHECKED_RUNS)
        this.checkedRuns.delete(this.checkedRuns.values().next().value!);
    }
    const epoch = this.epoch;
    const stamp = this.ctx.stamp();
    const token = {};
    this.reading.set(botId, token);
    const stale = () =>
      epoch !== this.epoch ||
      !sameStamp(this.ctx.stamp(), stamp) ||
      ["renaming", "undoing"].includes(this.lines.get(botId)?.line.status ?? "");
    try {
      const answer = asRecord(
        asRecord(
          await this.ctx
            .request("agents.files.get", { agentId: botId, name: "IDENTITY.md" })
            // The read's slot goes once it settles: the wait and the rename hold no file read.
            .finally(release),
        )?.file,
      );
      if (stale()) return;
      // A picture copied in isn't counted: a rename takes it out again.
      const content =
        typeof answer?.content === "string" ? answer.content.replace(PICTURE_LINE, "") : null;
      if (content === null) return;
      if (content.length > MAX_IDENTITY_CHARS) {
        // Read once, then left alone on this connection: a file this long isn't one to rename from.
        this.skipped.add(botId);
        if (this.skipped.size > MAX_NAME_CARDS)
          this.skipped.delete(this.skipped.values().next().value!);
        return;
      }
      const raw = identityName(content);
      const name = raw === null ? null : plainName(raw);
      const now = this.ctx.bots().find((each) => each.id === botId);
      if (!now || name === null) return;
      // A name the bot already has, longer than a line's, is not a new one cut short. Another
      // device may have applied it: the line follows the record.
      if (name === now.name || name === plainName(now.name)) return this.reconcile();
      const sent = runId === undefined ? undefined : this.sentRuns.get(runId);
      const mine = sent?.sessionKey === sessionKey;
      // History read through the run's end: a steer another device sent is in it by then. Unread,
      // nothing shows there was none.
      const read = runId !== undefined && (await this.ctx.readHistory(sessionKey));
      if (stale()) return;
      const run = runId === undefined ? null : this.ctx.runFacts(sessionKey, runId);
      const facts: RunFacts = {
        sentHere: mine,
        text: mine ? sent!.text : null,
        cut: mine && sent!.cut,
        attachments: mine && sent!.attachments,
        steered: (mine && sent!.steered) || !read || (run?.steered ?? false),
        steps: run?.steps ?? null,
      };
      const origin: RenameOrigin = {
        ...judgeRename(facts, name),
        run: runTag(runId ?? `${botId}\n${name}\n${this.ctx.now()}`),
        file: runTag(content),
      };
      // The device that sent the run has `CLAIM_DELAY_MS` to claim it; then any device may.
      if (!facts.sentHere) {
        await this.ctx.waitToClaim();
        if (stale()) return;
      }
      await this.apply(botId, name, origin, stamp, epoch, now.name);
    } catch (error) {
      this.ctx.log(`could not read ${botId}'s IDENTITY.md: ${errorText(error)}`);
    } finally {
      if (this.reading.get(botId) === token) this.reading.delete(botId);
      release();
    }
  }

  /**
   * Apply a bot's new name, with its line and its Undo record: the one path a rename a bot asked
   * for takes, whether the name came from its file or, later, from a tool of its own. Only one
   * writer changes a bot's name at a time: the one whose claim on that bot the record holds,
   * compared and set against the record it read. Any other device shows the change from the
   * record once the bot has the name.
   */
  async apply(
    botId: string,
    name: string,
    origin: RenameOrigin,
    stamp: GatewayStamp,
    epoch = this.epoch,
    seen?: string,
  ): Promise<void> {
    const bot = this.ctx.bots().find((each) => each.id === botId);
    if (!bot) return;
    // Renamed by someone else since the file was read (during the wait, say): not this rename's.
    if (seen !== undefined && bot.name !== seen) return this.giveUp(botId);
    const line = (patch: Partial<NameLine>) => {
      if (epoch !== this.epoch) return;
      this.setLine({
        botId,
        from: bot.name,
        to: name,
        stamp,
        run: origin.run,
        whose: origin.whose,
        source: origin.source,
        status: "renamed",
        reason: null,
        after: null,
        error: null,
        ...patch,
      });
    };
    let op: RecordOp = { stamp, generation: this.ctx.generation() };
    await this.flushDeclines(op);
    const read = await this.readRecord(op);
    if (epoch !== this.epoch) return;
    const record = read.record && settled(read.record, this.ctx.bots(), this.ctx.now());
    // The same edit an Undo declined: not a request, so nothing is said.
    if (this.isDeclined(record, stamp, botId, name, origin)) return;
    const existing = record?.changes.find((each) => each.run === origin.run && each.bot === botId);
    // Another device's, landed or undone: its line is the record's.
    if (
      record &&
      existing &&
      (existing.undone !== undefined || landed(existing, record.changes, this.ctx.bots()))
    )
      return this.reconcile();
    // Another writer's claim on this bot still stands: its line comes with the record.
    if (record && otherClaim(record, botId, "", this.ctx.now())) return;
    if (!this.ctx.canRename()) return line({ status: "not-done", reason: "no-admin" });
    if (nameTaken(this.ctx.bots(), botId, name))
      return line({ status: "not-done", reason: "taken" });
    // A name before that a rename couldn't set again would leave no real Undo.
    if (!record || !isPlainName(bot.name)) return line({ status: "not-done", reason: "no-record" });
    const opId = runTag(`${origin.run}\n${this.ctx.now()}\n${Math.random()}`);
    const change: NameRecordChange = {
      bot: botId,
      field: "name",
      from: bot.name,
      to: name,
      at: this.ctx.now(),
      run: origin.run,
      whose: origin.whose,
      source: origin.source,
      file: origin.file,
    };
    const claim: NameClaim = { bot: botId, op: opId, run: origin.run, at: change.at };
    line({ status: "renaming" });
    try {
      let sent = false;
      for (let attempt = 0; attempt < CLAIM_ATTEMPTS && !sent; attempt += 1) {
        op = { stamp, generation: this.ctx.generation() };
        let claimedAt = this.ctx.now();
        const claimed = await this.writeRecord(op, (record) => {
          const now = this.ctx.now();
          claimedAt = now;
          if (otherClaim(record, botId, opId, now)) return "busy";
          const same = record.changes.find((each) => each.run === origin.run && each.bot === botId);
          if (same && (same.undone !== undefined || landed(same, record.changes, this.ctx.bots())))
            return "taken";
          if (this.isDeclined(record, stamp, botId, name, origin)) return "declined";
          const day = dayOf(now);
          const confirmed = record.changes.filter(
            (each) => each.bot === botId && each.done !== undefined && dayOf(each.done) === day,
          ).length;
          if (Math.max(confirmed, renamesOn(record, botId, day)) >= MAX_RENAMES_PER_DAY)
            return "limit";
          const next = {
            ...record,
            changes: [...record.changes.filter((each) => each !== same), change],
            claims: [...record.claims.filter((each) => each.op !== opId), { ...claim, at: now }],
          };
          // Room now for what confirming it writes too: the day's count, kept with today's others,
          // and the count each other rename still under way will write when it is confirmed.
          let counted: NameRecord = next;
          for (const other of next.claims) {
            if (other.undo || other.op === opId) continue;
            const pending = next.changes.find(
              (each) => each.run === other.run && each.bot === other.bot,
            );
            if (pending && pending.done === undefined && pending.undone === undefined)
              counted = withCount(counted, other.bot, day);
          }
          counted = withCount(counted, botId, day);
          if (!keepsWhatItAdds(record, counted, day)) return "full";
          return next;
        });
        if (epoch !== this.epoch) return;
        if (claimed === "busy") return this.giveUp(botId);
        if (claimed === "taken") return this.giveUp(botId);
        if (claimed === "declined") return this.drop(botId);
        if (claimed === "limit") return line({ status: "not-done", reason: "limit" });
        if (claimed === "full") return line({ status: "not-done", reason: "full" });
        if (claimed === "unavailable") return line({ status: "not-done", reason: "no-record" });
        // Holding the claim: the bot as the gateway lists it now, on the gateway the read was for.
        await this.ctx.refreshBots();
        await this.ctx.sameGateway(stamp);
        if (epoch !== this.epoch) throw new Error(NOTHING_SENT);
        const still = this.ctx.bots().find((each) => each.id === botId);
        // Renamed by someone else since the run ended, or already this name: not this rename's.
        if (!still || still.name !== bot.name) {
          await this.release(op, opId, botId, origin.run, true);
          return this.giveUp(botId);
        }
        // Sent only on the connection that holds the claim, while the claim is young enough to
        // outlast the request; otherwise the claim is taken again.
        if (!this.current(op) || this.ctx.now() - claimedAt >= CLAIM_SEND_MS) continue;
        try {
          await this.ctx.request("agents.update", { agentId: botId, name });
        } catch (error) {
          // The gateway refused, so nothing was renamed: the entry and the claim go again.
          // Otherwise its answer was lost and the rename may have landed: both stay until the
          // claim expires, and then the bot's name as the gateway lists it says which.
          if (this.ctx.certainRefusal(error)) {
            await this.release(op, opId, botId, origin.run, true);
            throw error;
          }
          this.ctx.log(`no answer to ${botId}'s rename: ${errorText(error)}`);
        }
        sent = true;
        // Sent: this device keeps its own copy of what it changed, for its own Undo.
        this.keepApplied({
          gatewayId: stamp.gatewayId,
          botId,
          run: origin.run,
          from: bot.name,
          to: name,
          file: origin.file,
        });
      }
      if (!sent) throw new Error(NOTHING_SENT);
      await this.keepPictureOutOfFile(botId, epoch);
      // Read back and confirmed only on the connection the rename was sent on (`op`): after a
      // reconnect its claim stays, for the record to settle by the name the gateway lists.
      if (this.current(op)) await this.ctx.refreshBots().catch(() => {});
      if (epoch !== this.epoch || !this.current(op)) throw new Error(CONNECTION_CHANGED_AFTER_SEND);
      if (this.ctx.bots().find((each) => each.id === botId)?.name !== name)
        throw new Error(`Rename was sent, but the gateway's bot list doesn't show ${name} yet.`);
      // Confirmed by the bot list: marked done and counted, and the claim let go.
      // Settling the record does this for a claim whose rename the bot list shows; counted once.
      const done = this.ctx.now();
      const recorded = await this.writeRecord(op, (record) => {
        const entry = record.changes.find((each) => each.run === origin.run && each.bot === botId);
        const claims = record.claims.filter((each) => each.op !== opId);
        if (entry?.done !== undefined) return { ...record, claims };
        // An entry another device settled away while the rename was on its way is written again:
        // the rename landed, so it has its record, its Undo and its count.
        const changes = entry
          ? record.changes.map((each) => (each === entry ? { ...each, done } : each))
          : [...record.changes, { ...change, done }];
        return withCount({ ...record, changes, claims }, botId, dayOf(done));
      }).catch((error: unknown) => {
        this.ctx.log(`could not mark ${botId}'s rename done: ${errorText(error)}`);
        return "unavailable" as const;
      });
      // Renamed, but not saved to the record: said, since its Undo and count may then be missing.
      line({ status: "renamed", error: recorded === "written" ? null : UNRECORDED });
    } catch (error) {
      line({
        status: "failed",
        error: this.ctx.missingScope(error)
          ? "The gateway refused: renaming a bot needs admin access."
          : errorText(error).slice(0, MAX_NAME_ERROR_CHARS),
      });
    }
  }

  /**
   * Undo: put back the name before, only while the change is the bot's latest, the bot is still
   * called what it made it, and the name it puts back is `from`, the one the button named. This
   * device's own copy of a change it applied wins over the shared record's. It holds the bot's
   * claim, reads the bot again, sends on the claim's connection, then reads the name back: the
   * line says what the gateway lists now. The change is marked undone and that edit declined on
   * the gateway; when that can't be written, the decline is kept here and written again before
   * this device applies another name on that gateway, and the line says so.
   */
  async undo(botId: string, run: string, from: string, stamp: GatewayStamp): Promise<void> {
    const epoch = this.epoch;
    if (!this.ctx.canRename()) throw new Error("Renaming a bot needs admin access.");
    if (!sameStamp(this.ctx.stamp(), stamp))
      throw new Error("This change was read on another gateway, so nothing was sent.");
    let op: RecordOp = { stamp, generation: this.ctx.generation() };
    await this.ctx.refreshBots();
    const { record } = await this.readRecord(op);
    const change = record?.changes.find((each) => each.run === run && each.bot === botId);
    if (!record || !change || !canUndoName(change, record.changes, this.ctx.bots(), this.ctx.now()))
      throw new Error(NO_LONGER);
    if (change.from !== from)
      throw new Error(
        `That change now puts back ${change.from}, not ${from}, so nothing was sent.`,
      );
    const restore = (patch: Partial<NameLine>) => {
      if (epoch !== this.epoch) return;
      this.setLine({
        botId,
        from: change.from,
        to: change.to,
        stamp,
        run,
        whose: change.whose,
        source: change.source,
        status: "undoing",
        reason: null,
        after: null,
        error: null,
        ...patch,
      });
    };
    const opId = runTag(`undo\n${run}\n${this.ctx.now()}\n${Math.random()}`);
    restore({ status: "undoing" });
    try {
      let sent = false;
      for (let attempt = 0; attempt < CLAIM_ATTEMPTS && !sent; attempt += 1) {
        op = { stamp, generation: this.ctx.generation() };
        let claimedAt = this.ctx.now();
        const claimed = await this.writeRecord(op, (current) => {
          const now = this.ctx.now();
          claimedAt = now;
          if (otherClaim(current, botId, opId, now)) return "busy";
          const kept = current.changes.find((each) => each.run === run && each.bot === botId);
          if (!kept || kept.undone !== undefined) return "gone";
          return {
            ...current,
            claims: [
              ...current.claims.filter((each) => each.op !== opId),
              { bot: botId, op: opId, run, at: now, undo: true as const },
            ],
          };
        });
        if (claimed === "busy")
          throw new Error("Another change to this bot's name is under way, so nothing was sent.");
        if (claimed === "gone") throw new Error(NO_LONGER);
        if (claimed !== "written")
          throw new Error("Clawtrate couldn't hold this Undo on the gateway, so nothing was sent.");
        await this.ctx.refreshBots();
        await this.ctx.sameGateway(stamp);
        if (epoch !== this.epoch) throw new Error(NOTHING_SENT);
        // Exactly the name the change gave: a rename since, from anywhere, ends it here.
        if (this.ctx.bots().find((each) => each.id === botId)?.name !== change.to) {
          await this.release(op, opId, botId, run, false);
          this.reconcile();
          throw new Error(NO_LONGER);
        }
        if (!this.current(op) || this.ctx.now() - claimedAt >= CLAIM_SEND_MS) continue;
        try {
          await this.ctx.request("agents.update", { agentId: botId, name: change.from });
        } catch (error) {
          // A refusal: nothing was written. Any other error: the answer was lost and the name
          // may be back, which the read below settles.
          if (this.ctx.certainRefusal(error)) throw error;
          this.ctx.log(`no answer to ${botId}'s Undo: ${errorText(error)}`);
        }
        sent = true;
      }
      if (!sent) throw new Error(NOTHING_SENT);
    } catch (error) {
      restore({ status: "renamed", error: errorText(error).slice(0, MAX_NAME_ERROR_CHARS) });
      throw error;
    }
    await this.keepPictureOutOfFile(botId, epoch);
    // What the gateway lists now, read again on the very connection Undo was sent on (`op`). A
    // list that couldn't be read there says nothing of Undo: its claim stays, for the record to
    // settle by the name listed.
    const reread =
      this.current(op) &&
      (await this.ctx.refreshBots().then(
        () => true,
        () => false,
      ));
    if (!reread || !this.current(op)) {
      restore({ status: "undone", after: null, error: UNCONFIRMED });
      return;
    }
    // Said as it is.
    const after = this.ctx.bots().find((each) => each.id === botId)?.name ?? null;
    if (after !== change.from) {
      await this.release({ stamp, generation: this.ctx.generation() }, opId, botId, run, false);
      restore({ status: "undone", after });
      return;
    }
    this.unrecorded.set(`${stamp.gatewayId}\n${botId}`, {
      stamp,
      botId,
      name: change.to,
      run,
      file: change.file,
      op: opId,
    });
    if (this.unrecorded.size > MAX_NAME_CARDS)
      this.unrecorded.delete(this.unrecorded.keys().next().value!);
    const kept = await this.flushDeclines({ stamp, generation: this.ctx.generation() });
    restore({
      status: "undone",
      after,
      error: kept
        ? null
        : `Clawtrate couldn't keep this on the gateway yet, so another device may rename ${change.from} to ${change.to} again.`,
    });
  }

  /**
   * Write the declines Undo couldn't keep on the gateway, for that gateway only: the change marked
   * undone, its edit declined, its claim let go. Whether none is left for it.
   */
  private async flushDeclines(op: RecordOp): Promise<boolean> {
    const mine = [...this.unrecorded].filter(([, each]) => sameStore(each.stamp, op.stamp));
    if (mine.length === 0) return true;
    const now = this.ctx.now();
    let kept: NameRecord | null = null;
    const result = await this.writeRecord(
      op,
      (record) => ({
        ...record,
        changes: record.changes.map((each) =>
          mine.some(([, kept]) => kept.run === each.run && each.undone === undefined)
            ? { ...each, undone: now }
            : each,
        ),
        declined: [
          ...record.declined.filter(
            (each) =>
              !mine.some(
                ([, kept]) =>
                  kept.botId === each.bot && kept.name === each.name && kept.file === each.file,
              ),
          ),
          ...mine.map(([, kept]) => ({
            bot: kept.botId,
            name: kept.name,
            file: kept.file,
            at: now,
          })),
        ],
        claims: record.claims.filter((each) => !mine.some(([, kept]) => kept.op === each.op)),
      }),
      (value) => (kept = value),
    ).catch((error: unknown) => {
      this.ctx.log(`could not record an undo: ${errorText(error)}`);
      return "unavailable" as const;
    });
    if (result !== "written" || kept === null) return false;
    // Only those the gateway kept: one the record's room left out stays here, and is written again.
    const saved: NameRecord = kept;
    let all = true;
    for (const [key, each] of mine) {
      if (
        saved.declined.some(
          (decline) =>
            decline.bot === each.botId && decline.name === each.name && decline.file === each.file,
        )
      ) {
        // A later Undo of the bot may have taken the key meanwhile: its decline isn't saved yet.
        if (this.unrecorded.get(key)?.op === each.op) this.unrecorded.delete(key);
      } else all = false;
    }
    return all;
  }

  /**
   * Whether an Undo declined this very edit: the bot, the name and the file as it was, and the run
   * wrote nothing of its own. A run that writes the file again is a fresh edit, even of the same name.
   */
  private isDeclined(
    record: NameRecord | null,
    stamp: GatewayStamp,
    botId: string,
    name: string,
    origin: RenameOrigin,
  ): boolean {
    if (origin.whose !== "file") return false;
    const same = (each: { name: string; file: string }) =>
      each.name === name && each.file === origin.file;
    if (record?.declined.some((each) => each.bot === botId && same(each))) return true;
    return [...this.unrecorded.values()].some(
      (each) => sameStore(each.stamp, stamp) && each.botId === botId && same(each),
    );
  }

  /** Let go of a claim this device holds, and, for a rename not sent, take its entry back. */
  private async release(
    op: RecordOp,
    opId: string,
    botId: string,
    run: string,
    entry: boolean,
  ): Promise<void> {
    const result = await this.writeRecord(op, (record) => ({
      ...record,
      changes: entry
        ? record.changes.filter(
            (each) => !(each.run === run && each.bot === botId && each.done === undefined),
          )
        : record.changes,
      claims: record.claims.filter((each) => each.op !== opId),
    })).catch(() => "unavailable" as const);
    if (result !== "written") this.ctx.log(`could not let go of the claim on ${botId}'s name`);
  }

  /** Given up for another writer: the line here follows the record once that change lands. */
  private giveUp(botId: string): void {
    this.drop(botId);
    this.reconcile();
  }

  private keepApplied(change: Applied): void {
    const key = `${change.gatewayId}\n${change.run}`;
    this.applied.delete(key);
    this.applied.set(key, change);
    if (this.applied.size > MAX_NAME_CARDS) this.applied.delete(this.applied.keys().next().value!);
  }

  /**
   * Put a line away on this device, only while it is the line of the change `run` names, read on
   * the gateway and target `stamp` names: a newer line that replaced it meanwhile, or the same
   * change's line restored after the target changed, stays. Nothing is sent.
   */
  dismiss(botId: string, run: string, stamp: GatewayStamp): void {
    const shown = this.lines.get(botId)?.line;
    if (shown?.run !== run || !sameStamp(shown.stamp, stamp)) return;
    {
      this.dismissed.add(run);
      if (this.dismissed.size > MAX_NAME_CARDS)
        this.dismissed.delete(this.dismissed.values().next().value!);
    }
    this.drop(botId);
  }

  /** The record changed on the gateway: read it again, and let lines follow it. */
  async onPrefsChanged(keys: unknown): Promise<void> {
    if (!Array.isArray(keys) || !keys.includes(NAME_RECORD_KEY)) return;
    await this.loadRecord();
  }

  /** Read the record on connecting, for the bots' settings and their lines. */
  async loadRecord(): Promise<void> {
    await this.readRecord({ stamp: this.ctx.stamp(), generation: this.ctx.generation() }).catch(
      () => {},
    );
  }

  /** The bot list changed: a line whose bot is gone goes, and the others follow the record. */
  onBots(bots: Bot[]): void {
    for (const botId of this.lines.keys())
      if (!bots.some((bot) => bot.id === botId)) this.drop(botId);
    this.reconcile();
  }

  /** Another gateway, or none: nothing read of the last one counts. */
  reset(): void {
    this.epoch += 1;
    this.reading.clear();
    this.skipped.clear();
    this.checkedRuns.clear();
    this.published = null;
    this.ctx.publishRecord(null);
    if (this.lines.size === 0) return;
    this.lines = new Map();
    this.publish();
  }

  /**
   * Each bot's line against the record as last read: its latest change that landed, or was
   * undone, is shown with the classification the device that applied it recorded, replacing a
   * line this device set before that change (a refusal it no longer holds, or none at all). A line
   * for a change still under way here, or set here after it, stays; one closed here stays closed.
   */
  private reconcile(): void {
    const record = this.published;
    if (!record || !sameStamp(record.stamp, this.ctx.stamp())) return;
    const bots = this.ctx.bots();
    for (const bot of bots) {
      const latest = record.changes.filter((each) => each.bot === bot.id).at(-1);
      if (!latest || this.dismissed.has(latest.run)) continue;
      const undone = latest.undone !== undefined;
      if (!undone && !landed(latest, record.changes, bots)) continue;
      const shown = this.lines.get(bot.id);
      if (shown && ["renaming", "undoing"].includes(shown.line.status)) continue;
      if (shown && shown.line.run === latest.run) {
        // Already this change's line; otherwise a refusal or failure it replaces, or now undone.
        const status = shown.line.status;
        if (!undone && (status === "renamed" || status === "undone")) continue;
        // An Undo this device couldn't confirm gives way to the record's.
        if (undone && status === "undone" && shown.line.error !== UNCONFIRMED) continue;
      } else if (shown && shown.at > (latest.undone ?? latest.done ?? latest.at)) continue;
      this.setLine({
        botId: bot.id,
        from: latest.from,
        to: latest.to,
        stamp: record.stamp,
        run: latest.run,
        whose: latest.whose,
        source: latest.source,
        status: undone ? "undone" : "renamed",
        reason: null,
        after: undone ? bot.name : null,
        error: null,
      });
    }
  }

  /**
   * A request of the record's, made only while the connection is still the one `stamp` names:
   * an operation begun on one gateway never reads or writes another's record.
   */
  private async recordRequest(op: RecordOp, method: string, params: unknown) {
    if (!this.current(op)) throw new Error(NOTHING_SENT);
    return asRecord(await this.ctx.request(method, params));
  }

  /** Whether the connection is still the one the operation began on. */
  private current(op: RecordOp): boolean {
    return sameStamp(this.ctx.stamp(), op.stamp) && this.ctx.generation() === op.generation;
  }

  /**
   * The record as the gateway holds it now, with the raw value a write compares against. Claims
   * abandoned past `CLAIM_EXPIRY_MS` are settled against the name the gateway lists, and this
   * device's own copies of its renames take the place of what the record says of them.
   */
  private async readRecord(op: RecordOp): Promise<{ record: NameRecord | null; raw: unknown }> {
    const { stamp } = op;
    const result = await this.recordRequest(op, "users.prefs.get", {
      keys: [NAME_RECORD_KEY],
    }).catch(() => null);
    const current = this.current(op);
    if (result?.status !== "ok") {
      if (current) {
        this.published = null;
        this.ctx.publishRecord(null);
      }
      return { record: null, raw: null };
    }
    const entries = asRecord(result.entries) ?? {};
    const raw = Object.hasOwn(entries, NAME_RECORD_KEY) ? entries[NAME_RECORD_KEY] : null;
    const record = this.own(stamp, parseNameRecord(raw, this.ctx.now()));
    if (current) this.show(stamp, settled(record, this.ctx.bots(), this.ctx.now()));
    return { record, raw };
  }

  /** The record with this device's own copy of each rename it applied in place of the record's. */
  private own(stamp: GatewayStamp, record: NameRecord): NameRecord {
    return {
      ...record,
      changes: record.changes.map((each) => {
        const own = this.applied.get(`${stamp.gatewayId}\n${each.run}`);
        return own && own.botId === each.bot
          ? { ...each, from: own.from, to: own.to, file: own.file }
          : each;
      }),
    };
  }

  /** Publish the record's changes for the bots' settings, and let the lines follow it. */
  private show(stamp: GatewayStamp, record: NameRecord): void {
    this.published = { stamp, changes: record.changes };
    this.ctx.publishRecord(this.published);
    this.reconcile();
  }

  /**
   * One change to the record, compared and set against what was just read, and applied again to
   * the newer value when another device wrote first, each request on the operation's gateway.
   * Abandoned claims are settled in the same write. `change` may answer why not instead.
   */
  private async writeRecord<T extends string>(
    op: RecordOp,
    change: (record: NameRecord) => NameRecord | T,
    written?: (value: NameRecord) => void,
  ): Promise<"written" | "unavailable" | "full" | T> {
    for (let attempt = 0; attempt < RECORD_WRITE_ATTEMPTS; attempt += 1) {
      const { record, raw } = await this.readRecord(op);
      if (!record) return "unavailable";
      const base = settled(record, this.ctx.bots(), this.ctx.now());
      const next = change(base);
      if (typeof next === "string") return next;
      const value = fitNameRecord({ ...next, rev: record.rev + 1 });
      if (!keepsWhatItAdds(base, { ...next, rev: value.rev }, dayOf(this.ctx.now()))) return "full";
      const result = await this.recordRequest(op, "users.prefs.set", {
        entries: { [NAME_RECORD_KEY]: value },
        expectedEntries: { [NAME_RECORD_KEY]: raw ?? null },
      });
      if (result?.status === "ok") {
        written?.(value);
        if (this.current(op)) this.show(op.stamp, this.own(op.stamp, value));
        return "written";
      }
      if (result?.status !== "conflict") return "unavailable";
    }
    throw new Error("The record of changes kept changing on another device.");
  }

  /**
   * `agents.update` writes every identity field the config holds into IDENTITY.md, the picture
   * as an `Avatar` line of up to 32 KB that every run would carry (R38). Take that line out
   * again, held to the file just read, as New bot's first step does (`endFirstRun`); the picture
   * stays in the config, which takes precedence over the file. Only a line with the config's own
   * picture goes: a bot whose picture lives only in its file keeps it. The rename has landed
   * whatever happens here, so a failure is only logged.
   */
  private async keepPictureOutOfFile(botId: string, epoch: number): Promise<void> {
    // Within the client's file reads like every other read: with none free it is left for the
    // next rename, which a copied picture doesn't keep from coming.
    const release = this.ctx.takeRead();
    if (!release) {
      this.ctx.log(`left the picture in ${botId}'s IDENTITY.md: no file read was free`);
      return;
    }
    try {
      const configPicture = async () => {
        const config = asRecord(await this.ctx.request("config.get", {}));
        const entry = asRecord(asRecord(asRecord(config?.config)?.agents)?.entries)?.[botId];
        return asRecord(asRecord(entry)?.identity)?.avatar;
      };
      const picture = await configPicture();
      if (epoch !== this.epoch || typeof picture !== "string" || !picture.startsWith("data:"))
        return;
      const file = asRecord(
        asRecord(
          await this.ctx.request("agents.files.get", { agentId: botId, name: "IDENTITY.md" }),
        )?.file,
      );
      if (epoch !== this.epoch) return;
      const content = typeof file?.content === "string" ? file.content : null;
      const hash =
        typeof file?.hash === "string" && /^[a-f0-9]{64}$/i.test(file.hash) ? file.hash : null;
      if (content === null || hash === null) return;
      const kept = content
        .split(/(?<=\n)/)
        .filter((line) => line.replace(/\r?\n$/, "") !== `- Avatar: ${picture}`)
        .join("");
      if (kept === content) return;
      // Read again just before the write: a picture taken out of the config meanwhile lives only
      // in the file now, and its line stays. The gateway offers no precondition on the config.
      if ((await configPicture()) !== picture || epoch !== this.epoch) return;
      await this.ctx.request("agents.files.set", {
        agentId: botId,
        name: "IDENTITY.md",
        content: kept,
        expectedHash: hash,
      });
    } catch (error) {
      this.ctx.log(`could not take the picture out of ${botId}'s IDENTITY.md: ${errorText(error)}`);
    } finally {
      release();
    }
  }

  /** The earlier card kept Not now on this device; the record on the gateway replaces it. */
  private async forgetOldDeclines(): Promise<void> {
    if (this.forgotDeclines) return;
    this.forgotDeclines = true;
    await this.ctx.storage.delete(NAME_DECLINES_KEY).catch(() => {});
  }

  private setLine(line: NameLine): void {
    if (!this.lines.has(line.botId) && this.lines.size >= MAX_NAME_CARDS) return;
    this.lines.set(line.botId, { line, at: this.ctx.now() });
    this.publish();
  }

  private drop(botId: string): void {
    if (this.lines.delete(botId)) this.publish();
  }

  private publish(): void {
    this.ctx.publishLines([...this.lines.values()].map((each) => each.line));
  }
}

/**
 * The record with its claims settled against the name the gateway lists. A claim whose change
 * the bot list shows has landed is let go whatever its age: a rename whose bot has its name is
 * marked done and counted, an Undo whose bot has the name before is marked undone and its edit
 * declined. A claim abandoned past `CLAIM_EXPIRY_MS` is let go too, and a rename it held that
 * never landed is taken back. Any other claim stays as it is.
 */
export function settled(record: NameRecord, bots: readonly Bot[], now: number): NameRecord {
  let next: NameRecord = record;
  for (const claim of record.claims) {
    const name = bots.find((bot) => bot.id === claim.bot)?.name;
    const entry = next.changes.find((each) => each.run === claim.run && each.bot === claim.bot);
    const stale = now - claim.at >= CLAIM_EXPIRY_MS;
    const live = !!entry && entry.undone === undefined;
    const landedHere = live && name === (claim.undo ? entry.from : entry.to);
    if (!landedHere && !stale) continue;
    next = { ...next, claims: next.claims.filter((each) => each !== claim) };
    if (!live) continue;
    if (claim.undo) {
      if (!landedHere) continue;
      next = {
        ...next,
        changes: next.changes.map((each) => (each === entry ? { ...each, undone: now } : each)),
        declined: [...next.declined, { bot: entry.bot, name: entry.to, file: entry.file, at: now }],
      };
    } else if (entry.done === undefined) {
      next = landedHere
        ? withCount(
            {
              ...next,
              changes: next.changes.map((each) => (each === entry ? { ...each, done: now } : each)),
            },
            entry.bot,
            dayOf(now),
          )
        : { ...next, changes: next.changes.filter((each) => each !== entry) };
    }
  }
  return next;
}

/**
 * One more confirmed rename of `bot` on `day`. Counts from before the day before go; the others
 * stay: the day before's, which a device whose clock hasn't passed midnight yet still counts on,
 * and later days', which a device whose clock already has wrote.
 */
function withCount(record: NameRecord, bot: string, day: string): NameRecord {
  return {
    ...record,
    counts: [
      ...record.counts.filter(
        (each) => each.day >= keptFrom(day) && !(each.day === day && each.bot === bot),
      ),
      { bot, day, n: renamesOn(record, bot, day) + 1 },
    ],
  };
}

/**
 * Whether `next`, cut to what the gateway keeps, still has what it adds to `before`: every count
 * from the day before `day` on, every change it adds, and every claim. A write that would lose one isn't made: the
 * day's limit would forget a bot's renames, a rename recorded nowhere would have no Undo, and a
 * claim dropped would let another writer in.
 */
function keepsWhatItAdds(before: NameRecord, next: NameRecord, day: string): boolean {
  const value = fitNameRecord(next);
  // The day before and later ones: a device on either side of midnight counts on those.
  const from = keptFrom(day);
  const today = (counts: NameRecord["counts"]) => counts.filter((each) => each.day >= from).length;
  if (today(value.counts) < today(next.counts)) return false;
  const kept = (list: NameRecordChange[], each: NameRecordChange) =>
    list.some((other) => other.run === each.run && other.bot === each.bot);
  const added = next.changes.filter((each) => !kept(before.changes, each));
  if (added.some((each) => !kept(value.changes, each))) return false;
  if (value.claims.length < next.claims.length) return false;
  return utf8Length(JSON.stringify(value)) <= MAX_RECORD_BYTES;
}
