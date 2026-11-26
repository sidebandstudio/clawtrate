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
// conversation says what happened, with Undo. Whether it was the person's ask
// is judged silently and is never proof: the line says what happened, and
// Undo is always there. A rename that isn't made is said in the same place.

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
/** How long Undo is offered, and how long a change is kept. */
export const UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many renames of one bot are applied in a day. */
export const MAX_RENAMES_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A device that didn't send the run waits this long, so the one that did applies it first. */
export const CLAIM_DELAY_MS = 5_000;
/** Times a record write is tried again after another device's write came first. */
export const RECORD_WRITE_ATTEMPTS = 4;
/** A change dated this far ahead of this device's clock is not believed. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_RECORD_BOT_CHARS = 128;
/** The host storage key the earlier card kept Not now under; removed, it no longer counts. */
export const NAME_DECLINES_KEY = "clawtrate.bot-name-declines";

const PLACEHOLDERS = new Set(["not set yet", "pick something you like"]);
/** A picture `agents.update` copied into IDENTITY.md from the config (R38). */
const PICTURE_LINE = /^- Avatar: data:[^\n]*(\n|$)/gm;
/** Tools whose result is no outside content: the session tools, and asking the person. */
const OWN_TOOLS = new Set([
  "sessions_spawn",
  "sessions_send",
  "sessions_list",
  "sessions_history",
  "subagents",
  "ask_user",
  "progress_card",
]);
const WEB_TOOLS = /^(web_search|web_fetch|browser)/;
const FILE_TOOLS = new Set(["read", "ls", "find", "grep", "glob"]);
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
 * become spaces, direction controls and invisible spaces go, runs of space one, the ends trimmed, as the gateway stores a name; then cut to
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

const folded = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** The record's tag for a run: the first 16 hex digits of its id's SHA-256. */
export const runTag = (runId: string) => sha256Hex(utf8Bytes(runId)).slice(0, 16);

/** One step of a run, as the engine has it: the tool and the text of its arguments. */
export type RunStepFacts = { toolName: string | null; args: string | null };

/** What this device knows of the run that wrote a name, to judge whose ask it was. */
export type RunFacts = { sentHere: boolean; text: string | null; steps: RunStepFacts[] | null };

/**
 * Whose ask a rename was, as far as Clawtrate can tell, and where it came from when known. It is
 * the person's (`asked`) only when this device sent the run, the run used no tool whose result is
 * outside content before it wrote the name, and the name is in what the person typed. These are
 * necessary, not proof: "Don't rename yourself Juniper" passes them too, so a line never says the
 * person asked, and every rename carries Undo. A read or write of the bot's own IDENTITY.md is
 * the edit itself; a run whose steps aren't known counts as having read something.
 */
export function judgeRename(facts: RunFacts, name: string): { asked: boolean; source: NameSource } {
  let source: NameSource = null;
  let outside = facts.steps === null;
  for (const step of facts.steps ?? []) {
    const tool = step.toolName;
    if (!tool || OWN_TOOLS.has(tool) || tool.startsWith("clawtrate_")) continue;
    const own = ownIdentityFile(tool, step.args);
    if (own && NAME_WRITES.has(tool)) break;
    if (own && tool === "read") continue;
    outside = true;
    source = WEB_TOOLS.test(tool) ? "web" : FILE_TOOLS.has(tool) ? "file" : "tool";
    break;
  }
  const named = facts.text !== null && folded(facts.text).includes(folded(name));
  return { asked: facts.sentHere && !outside && named, source };
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

/** A record as the gateway holds it, checked entry by entry: anything malformed is dropped. */
export type NameRecord = {
  rev: number;
  changes: NameRecordChange[];
  declined: Array<{ bot: string; name: string }>;
  /** Renames per bot and UTC day, kept apart from the changes, which other bots' can push out. */
  counts: Array<{ bot: string; day: string; n: number }>;
};

/** The UTC day a time falls on, as `YYYY-MM-DD`: what the day's limit counts by. */
export const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

const isName = (value: unknown): value is string =>
  typeof value === "string" && plainName(value) === value;
/**
 * A name a bot had before a rename, which Undo puts back: any name the gateway gave it, however
 * spaced and however long up to `MAX_PRIOR_NAME_CHARS`, with no control, direction or invisible
 * character, the ones a rename takes out of a name.
 */
export const MAX_PRIOR_NAME_CHARS = 256;
export const isPriorName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim() !== "" &&
  value.length <= MAX_PRIOR_NAME_CHARS &&
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/.test(
    value,
  );
const isBot = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_RECORD_BOT_CHARS;
const SOURCES = new Set(["web", "file", "tool"]);

/**
 * The record read from `users.prefs`, believed only as far as each entry passes the checks a new
 * name would: any paired device can write that store on OpenClaw 2026.11.10, so a forged or
 * malformed entry, or one older than Undo's window or dated in the future, offers nothing.
 */
export function parseNameRecord(raw: unknown, now: number): NameRecord {
  const value = asRecord(raw);
  const rev = typeof value?.rev === "number" && Number.isSafeInteger(value.rev) ? value.rev : 0;
  const changes: NameRecordChange[] = [];
  for (const each of Array.isArray(value?.changes)
    ? value.changes.slice(-MAX_RECORD_CHANGES)
    : []) {
    const entry = asRecord(each);
    if (!entry || !isBot(entry.bot) || entry.field !== "name") continue;
    if (!isPriorName(entry.from) || !isName(entry.to) || entry.from === entry.to) continue;
    const at = entry.at;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    if (at > now + CLOCK_SKEW_MS || now - at > UNDO_WINDOW_MS) continue;
    if (typeof entry.run !== "string" || !/^[0-9a-f]{16}$/.test(entry.run)) continue;
    const undone = entry.undone;
    if (undone !== undefined && (typeof undone !== "number" || !Number.isFinite(undone))) continue;
    const done = entry.done;
    if (done !== undefined && (typeof done !== "number" || !Number.isFinite(done))) continue;
    const source = entry.source;
    changes.push({
      bot: entry.bot,
      field: "name",
      from: entry.from,
      to: entry.to,
      at,
      run: entry.run,
      asked: entry.asked === true,
      source: typeof source === "string" && SOURCES.has(source) ? (source as NameSource) : null,
      ...(done === undefined ? {} : { done }),
      ...(undone === undefined ? {} : { undone }),
    });
  }
  const declined: NameRecord["declined"] = [];
  for (const each of Array.isArray(value?.declined)
    ? value.declined.slice(-MAX_RECORD_DECLINED)
    : []) {
    const entry = asRecord(each);
    if (entry && isBot(entry.bot) && isName(entry.name))
      declined.push({ bot: entry.bot, name: entry.name });
  }
  const counts: NameRecord["counts"] = [];
  for (const each of Array.isArray(value?.counts) ? value.counts.slice(-MAX_RECORD_COUNTS) : []) {
    const entry = asRecord(each);
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
  }
  return { rev, changes, declined, counts };
}

/** The record cut to what the gateway keeps: the newest entries that fit in `MAX_RECORD_BYTES`. */
export function fitNameRecord(record: NameRecord): NameRecord {
  const next = {
    rev: record.rev,
    changes: record.changes.slice(-MAX_RECORD_CHANGES),
    declined: record.declined.slice(-MAX_RECORD_DECLINED),
    counts: record.counts.slice(-MAX_RECORD_COUNTS),
  };
  // The counts are small and outlast the changes: the day's limit holds while history goes.
  while (utf8Length(JSON.stringify(next)) > MAX_RECORD_BYTES) {
    if (next.declined.length > next.changes.length) next.declined.shift();
    else if (next.changes.length > 0) next.changes.shift();
    else next.counts.shift();
  }
  return next;
}

/** How many renames of a bot the record counts on a day. */
export const renamesOn = (record: NameRecord, bot: string, day: string) =>
  record.counts.find((each) => each.bot === bot && each.day === day)?.n ?? 0;

/**
 * Whether Undo is offered for a change: kept, not undone, the latest change of its bot's name,
 * within Undo's window, and the bot is still called what the change made it.
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
  return bots.find((bot) => bot.id === change.bot)?.name === change.to;
}

/**
 * The changes a bot's settings list: those confirmed done, or undone. A claim whose rename was
 * never confirmed, left by a lost answer or a device that stopped, is not a rename.
 */
export const shownChanges = (changes: readonly NameRecordChange[]) =>
  changes.filter((each) => each.done !== undefined || each.undone !== undefined);

export type BotNamesContext = {
  request: (method: string, params: unknown) => Promise<unknown>;
  bots: () => Bot[];
  /** Connected, with `operator.admin`, on a host that writes. */
  canRename: () => boolean;
  /** Where a read is made now: the gateway's identity and the host's target (`gatewayStamp`). */
  stamp: () => GatewayStamp;
  /** The connection's own number, new with each connection, the same gateway's included. */
  generation: () => number;
  /** Refuse unless `stamp` is still where the host is connected, as every bot write does. */
  sameGateway: (stamp: GatewayStamp) => Promise<void>;
  /** The host's storage: only to forget what the earlier card kept there. */
  storage: KeyValueStore;
  /** Take one of the client's file reads, or null when they are all in use. */
  takeRead: () => (() => void) | null;
  refreshBots: () => Promise<void>;
  /** The steps of a run in a task, as the engine holds them, or null when it has none. */
  runSteps: (sessionKey: string, runId: string) => RunStepFacts[] | null;
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

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Where a record operation began: the gateway and the very connection it is bound to. */
type RecordOp = { stamp: GatewayStamp; generation: number };

/** What a rename's line says of whose it was. */
export type RenameOrigin = { asked: boolean; source: NameSource; run: string };

export class BotNames {
  private lines = new Map<string, NameLine>();
  /** The read under way for each bot, by a token of its own, so only that read ends it. */
  private readonly reading = new Map<string, object>();
  private readonly skipped = new Set<string>();
  /** Runs already checked (`MAX_CHECKED_RUNS`), so one run reads the file once. */
  private readonly checkedRuns = new Set<string>();
  /** Runs this device started, by id: their task and the text sent (`MAX_SENT_RUNS`). */
  private readonly sentRuns = new Map<string, { sessionKey: string; text: string }>();
  /**
   * Undos whose change this device couldn't mark undone on the gateway, by gateway and bot, at
   * most `MAX_NAME_CARDS` (`MAX_BOTS`): their names count as declined here, and are written again.
   */
  private readonly unrecorded = new Map<
    string,
    { stamp: GatewayStamp; botId: string; name: string; run: string }
  >();
  /** Moves on with every reset, so a read begun before it changes nothing after. */
  private epoch = 0;
  private forgotDeclines = false;

  private readonly ctx: BotNamesContext;

  constructor(ctx: BotNamesContext) {
    this.ctx = ctx;
  }

  /** This device sent a message that starts a run: its id is that run's id (`chat.send`). */
  sent(sessionKey: string, runId: string, text: string): void {
    if (runId.length > MAX_CHECKED_RUN_CHARS) return;
    this.sentRuns.delete(runId);
    this.sentRuns.set(runId, { sessionKey, text: text.slice(0, MAX_SENT_TEXT_CHARS) });
    if (this.sentRuns.size > MAX_SENT_RUNS)
      this.sentRuns.delete(this.sentRuns.keys().next().value!);
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
      ["renaming", "undoing"].includes(this.lines.get(botId)?.status ?? "");
    try {
      const answer = asRecord(
        asRecord(
          await this.ctx.request("agents.files.get", { agentId: botId, name: "IDENTITY.md" }),
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
      // A name the bot already has, longer than a line's, is not a new one cut short.
      if (!now || name === null || name === now.name || name === plainName(now.name)) return;
      const sent = runId === undefined ? undefined : this.sentRuns.get(runId);
      const facts: RunFacts = {
        sentHere: sent?.sessionKey === sessionKey,
        text: sent?.sessionKey === sessionKey ? sent.text : null,
        steps: runId === undefined ? null : this.ctx.runSteps(sessionKey, runId),
      };
      const run = runTag(runId ?? `${botId}\n${name}\n${this.ctx.now()}`);
      const origin = { ...judgeRename(facts, name), run };
      // A device that didn't send the run gives the one that did the time to apply it first.
      if (!facts.sentHere) {
        await this.ctx.waitToClaim();
        if (stale()) return;
      }
      await this.apply(botId, name, origin, stamp, epoch);
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
   * device applies it: the first to record it on the gateway, compared and set against the record
   * it read; any other shows that device's line once the bot has the name.
   */
  async apply(
    botId: string,
    name: string,
    origin: RenameOrigin,
    stamp: GatewayStamp,
    epoch = this.epoch,
  ): Promise<void> {
    const bot = this.ctx.bots().find((each) => each.id === botId);
    if (!bot) return;
    const line = (patch: Partial<NameLine>) => {
      if (epoch !== this.epoch) return;
      this.setLine({
        botId,
        from: bot.name,
        to: name,
        stamp,
        run: origin.run,
        asked: origin.asked,
        source: origin.source,
        status: "renamed",
        reason: null,
        error: null,
        ...patch,
      });
    };
    const op: RecordOp = { stamp, generation: this.ctx.generation() };
    await this.flushDeclines(op);
    const read = await this.readRecord(op);
    if (epoch !== this.epoch) return;
    if (this.isDeclined(read.record, stamp, botId, name)) return;
    const shown = read.record?.changes.find((each) => each.run === origin.run);
    if (shown) return this.showChange(shown, stamp);
    if (!this.ctx.canRename()) return line({ status: "not-done", reason: "no-admin" });
    const taken = this.ctx
      .bots()
      .some((each) => each.id !== botId && folded(each.name) === folded(name));
    if (taken) return line({ status: "not-done", reason: "taken" });
    // A name before that the record couldn't keep exactly would leave no real Undo.
    if (!read.record || !isPriorName(bot.name))
      return line({ status: "not-done", reason: "no-record" });
    line({ status: "renaming" });
    try {
      // The bot as the gateway lists it now, then the gateway the read was for.
      await this.ctx.refreshBots();
      await this.ctx.sameGateway(stamp);
      if (epoch !== this.epoch) throw new Error("The connection changed, so nothing was sent.");
      const still = this.ctx.bots().find((each) => each.id === botId);
      if (!still || still.name === name) return this.drop(botId);
      if (still.name !== bot.name)
        throw new Error(`${bot.name} was renamed ${still.name} meanwhile, so nothing was sent.`);
      const change: NameRecordChange = {
        bot: botId,
        field: "name",
        from: bot.name,
        to: name,
        at: this.ctx.now(),
        run: origin.run,
        asked: origin.asked,
        source: origin.source,
      };
      const day = dayOf(change.at);
      const claimed = await this.writeRecord(op, (record) => {
        if (record.changes.some((each) => each.run === origin.run)) return "taken";
        if (this.isDeclined(record, stamp, botId, name)) return "declined";
        const today = record.changes.filter(
          (each) => each.bot === botId && change.at - each.at < DAY_MS,
        ).length;
        if (Math.max(today, renamesOn(record, botId, day)) >= MAX_RENAMES_PER_DAY) return "limit";
        // Only today's counts matter for the limit; one that can't be kept refuses the rename.
        const counts = record.counts.filter((each) => each.day === day && each.bot !== botId);
        const next = {
          ...record,
          changes: [...record.changes, change],
          counts: [...counts, { bot: botId, day, n: renamesOn(record, botId, day) + 1 }],
        };
        if (renamesOn(fitNameRecord(next), botId, day) === 0) return "full";
        return next;
      });
      if (epoch !== this.epoch) return;
      if (claimed === "taken") {
        const other = (await this.readRecord(op)).record?.changes.find(
          (each) => each.run === origin.run,
        );
        return other ? this.showChange(other, stamp) : this.drop(botId);
      }
      if (claimed === "declined") return this.drop(botId);
      if (claimed === "limit") return line({ status: "not-done", reason: "limit" });
      if (claimed === "full") return line({ status: "not-done", reason: "full" });
      if (claimed === "unavailable") return line({ status: "not-done", reason: "no-record" });
      try {
        await this.ctx.request("agents.update", { agentId: botId, name });
      } catch (error) {
        // The gateway refused, so nothing was renamed: the record's entry goes again. Otherwise
        // its answer was lost and the rename may have landed: the entry stays, and the bot's name
        // as the gateway lists it says which.
        if (this.ctx.certainRefusal(error)) {
          const removed = await this.writeRecord(op, (record) => ({
            ...record,
            changes: record.changes.filter((each) => each.run !== origin.run),
          })).catch(() => "unavailable" as const);
          if (removed !== "written")
            this.ctx.log(`could not take back the record of ${botId}'s rename that didn't land`);
          throw error;
        }
        this.ctx.log(`no answer to ${botId}'s rename: ${errorText(error)}`);
      }
      await this.keepPictureOutOfFile(botId, epoch);
      await this.ctx.refreshBots().catch(() => {});
      if (epoch !== this.epoch) throw new Error(CONNECTION_CHANGED_AFTER_SEND);
      if (this.ctx.bots().find((each) => each.id === botId)?.name !== name)
        throw new Error(`Rename was sent, but the gateway's bot list doesn't show ${name} yet.`);
      // Confirmed by the bot list: the record says so, and only then lists it as a rename.
      await this.writeRecord(op, (record) => ({
        ...record,
        changes: record.changes.map((each) =>
          each.run === origin.run ? { ...each, done: this.ctx.now() } : each,
        ),
      })).catch((error: unknown) =>
        this.ctx.log(`could not mark ${botId}'s rename done: ${errorText(error)}`),
      );
      line({ status: "renamed" });
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
   * Undo: put back the name before, only while the record still holds the change, it is the
   * latest for its bot and the bot is still called what it made it; then the change is marked
   * undone and its name declined on the gateway, so the same edit doesn't rename the bot again.
   * When that can't be written, the decline is kept here and written again before this device
   * applies another name on that gateway, and the line says so.
   */
  async undo(botId: string, run: string, stamp: GatewayStamp): Promise<void> {
    const epoch = this.epoch;
    if (!this.ctx.canRename()) throw new Error("Renaming a bot needs admin access.");
    if (!sameStamp(this.ctx.stamp(), stamp))
      throw new Error("This change was read on another gateway, so nothing was sent.");
    const op: RecordOp = { stamp, generation: this.ctx.generation() };
    await this.ctx.refreshBots();
    const { record } = await this.readRecord(op);
    const change = record?.changes.find((each) => each.run === run && each.bot === botId);
    if (!record || !change || !canUndoName(change, record.changes, this.ctx.bots(), this.ctx.now()))
      throw new Error("That change can no longer be undone.");
    const restore = (patch: Partial<NameLine>) => {
      if (epoch !== this.epoch) return;
      this.setLine({
        botId,
        from: change.from,
        to: change.to,
        stamp,
        run,
        asked: change.asked,
        source: change.source,
        status: "undoing",
        reason: null,
        error: null,
        ...patch,
      });
    };
    restore({ status: "undoing" });
    try {
      await this.ctx.sameGateway(stamp);
      if (epoch !== this.epoch) throw new Error("The connection changed, so nothing was sent.");
      if (this.ctx.bots().find((each) => each.id === botId)?.name !== change.to)
        throw new Error("That change can no longer be undone.");
      await this.ctx.request("agents.update", { agentId: botId, name: change.from });
    } catch (error) {
      restore({ status: "renamed", error: errorText(error).slice(0, MAX_NAME_ERROR_CHARS) });
      throw error;
    }
    await this.keepPictureOutOfFile(botId, epoch);
    await this.ctx.refreshBots().catch(() => {});
    this.unrecorded.set(`${stamp.gatewayId}\n${botId}`, { stamp, botId, name: change.to, run });
    if (this.unrecorded.size > MAX_NAME_CARDS)
      this.unrecorded.delete(this.unrecorded.keys().next().value!);
    const kept = await this.flushDeclines(op);
    restore({
      status: "undone",
      error: kept
        ? null
        : `Clawtrate couldn't keep this on the gateway yet, so ${change.from} may take ${change.to} again on another device.`,
    });
  }

  /**
   * Write the declines Undo couldn't keep on the gateway, for that gateway only: the change marked
   * undone and its name declined. Whether none is left for it.
   */
  private async flushDeclines(op: RecordOp): Promise<boolean> {
    const mine = [...this.unrecorded].filter(([, each]) => sameStamp(each.stamp, op.stamp));
    if (mine.length === 0) return true;
    const result = await this.writeRecord(op, (record) => ({
      ...record,
      changes: record.changes.map((each) =>
        mine.some(([, kept]) => kept.run === each.run && each.undone === undefined)
          ? { ...each, undone: this.ctx.now() }
          : each,
      ),
      declined: [
        ...record.declined.filter(
          (each) => !mine.some(([, kept]) => kept.botId === each.bot && kept.name === each.name),
        ),
        ...mine.map(([, kept]) => ({ bot: kept.botId, name: kept.name })),
      ],
    })).catch((error: unknown) => {
      this.ctx.log(`could not record an undo: ${errorText(error)}`);
      return "unavailable" as const;
    });
    if (result !== "written") return false;
    for (const [key] of mine) this.unrecorded.delete(key);
    return true;
  }

  private isDeclined(
    record: NameRecord | null,
    stamp: GatewayStamp,
    botId: string,
    name: string,
  ): boolean {
    if (record?.declined.some((each) => each.bot === botId && each.name === name)) return true;
    return [...this.unrecorded.values()].some(
      (each) => sameStamp(each.stamp, stamp) && each.botId === botId && each.name === name,
    );
  }

  /** Put a line away on this device. Nothing is sent. */
  dismiss(botId: string): void {
    this.drop(botId);
  }

  /** The record changed on the gateway: read it again, and let lines follow it. */
  async onPrefsChanged(keys: unknown): Promise<void> {
    if (!Array.isArray(keys) || !keys.includes(NAME_RECORD_KEY)) return;
    const op: RecordOp = { stamp: this.ctx.stamp(), generation: this.ctx.generation() };
    const { record } = await this.readRecord(op).catch(() => ({ record: null }));
    for (const line of [...this.lines.values()]) {
      const change = record?.changes.find((each) => each.run === line.run);
      if (change?.undone !== undefined && line.status === "renamed")
        this.setLine({ ...line, status: "undone" });
    }
  }

  /** Read the record on connecting, for the bots' settings. */
  async loadRecord(): Promise<void> {
    await this.readRecord({ stamp: this.ctx.stamp(), generation: this.ctx.generation() }).catch(
      () => {},
    );
  }

  /** The bot list changed: a line whose bot is gone goes. */
  onBots(bots: Bot[]): void {
    for (const botId of this.lines.keys())
      if (!bots.some((bot) => bot.id === botId)) this.drop(botId);
  }

  /** Another gateway, or none: nothing read of the last one counts. */
  reset(): void {
    this.epoch += 1;
    this.reading.clear();
    this.skipped.clear();
    this.checkedRuns.clear();
    this.ctx.publishRecord(null);
    if (this.lines.size === 0) return;
    this.lines = new Map();
    this.publish();
  }

  /**
   * Another device's change, shown here: as renamed only while the bot has the name it gave,
   * since an entry can stay behind a rename whose answer was lost and that didn't land.
   */
  private showChange(change: NameRecordChange, stamp: GatewayStamp): void {
    const undone = change.undone !== undefined;
    const named = this.ctx.bots().find((each) => each.id === change.bot)?.name === change.to;
    if (!undone && !named) return this.drop(change.bot);
    this.setLine({
      botId: change.bot,
      from: change.from,
      to: change.to,
      stamp,
      run: change.run,
      asked: change.asked,
      source: change.source,
      status: undone ? "undone" : "renamed",
      reason: null,
      error: null,
    });
  }

  /**
   * A request of the record's, made only while the connection is still the one `stamp` names:
   * an operation begun on one gateway never reads or writes another's record.
   */
  private async recordRequest(op: RecordOp, method: string, params: unknown) {
    if (!this.current(op)) throw new Error("The connection changed, so nothing was sent.");
    return asRecord(await this.ctx.request(method, params));
  }

  /** Whether the connection is still the one the operation began on. */
  private current(op: RecordOp): boolean {
    return sameStamp(this.ctx.stamp(), op.stamp) && this.ctx.generation() === op.generation;
  }

  /** The record as the gateway holds it now, with the raw value a write compares against. */
  private async readRecord(op: RecordOp): Promise<{ record: NameRecord | null; raw: unknown }> {
    const { stamp } = op;
    const result = await this.recordRequest(op, "users.prefs.get", {
      keys: [NAME_RECORD_KEY],
    }).catch(() => null);
    const current = this.current(op);
    if (result?.status !== "ok") {
      if (current) this.ctx.publishRecord(null);
      return { record: null, raw: null };
    }
    const entries = asRecord(result.entries) ?? {};
    const raw = Object.hasOwn(entries, NAME_RECORD_KEY) ? entries[NAME_RECORD_KEY] : null;
    const record = parseNameRecord(raw, this.ctx.now());
    if (current) this.ctx.publishRecord({ stamp, changes: record.changes });
    return { record, raw };
  }

  /**
   * One change to the record, compared and set against what was just read, and applied again to
   * the newer value when another device wrote first, each request on the operation's gateway.
   * `change` may answer why not instead.
   */
  private async writeRecord<T extends string>(
    op: RecordOp,
    change: (record: NameRecord) => NameRecord | T,
  ): Promise<"written" | "unavailable" | T> {
    for (let attempt = 0; attempt < RECORD_WRITE_ATTEMPTS; attempt += 1) {
      const { record, raw } = await this.readRecord(op);
      if (!record) return "unavailable";
      const next = change(record);
      if (typeof next === "string") return next;
      const value = fitNameRecord({ ...next, rev: record.rev + 1 });
      const result = await this.recordRequest(op, "users.prefs.set", {
        entries: { [NAME_RECORD_KEY]: value },
        expectedEntries: { [NAME_RECORD_KEY]: raw ?? null },
      });
      if (result?.status === "ok") {
        if (this.current(op)) this.ctx.publishRecord({ stamp: op.stamp, changes: value.changes });
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
    this.lines.set(line.botId, line);
    this.publish();
  }

  private drop(botId: string): void {
    if (this.lines.delete(botId)) this.publish();
  }

  private publish(): void {
    this.ctx.publishLines([...this.lines.values()]);
  }
}
