// Clawtrate's guides in a bot's instructions (#532, #544, #628). On by default, with nothing
// asked first, an admin connection writes one marked section at the top of each bot's `AGENTS.md`
// (`agents.files.set`, held to the hash it read): how to talk to the person, and what a task is in
// Clawtrate; one switch in Settings turns it off, and takes it out again. The
// gateway puts `AGENTS.md` into every run's prompt (main conversations, tasks, routines, the
// helpers a bot starts), and the section's place at the top keeps it whole when the gateway
// cuts a long file. No plugin, no config key and no grant are involved.
//
// The section is text, never interface: Clawtrate reads only its own markers, and the text
// between them is used for nothing but showing it. A bot can edit its own file, and so can the
// person: a section changed or removed outside Clawtrate is shown, never silently restored.

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { sha256Hex, utf8Bytes } from "./bytes.ts";
import { VOICE_GUIDE, WHERE_GUIDE } from "./guide-text.ts";
import { answerKind } from "./read-again.ts";
import type { GatewayStamp } from "./types.ts";

/** The file the section goes into: the only one the gateway gives every kind of run. */
export const GUIDES_FILE = "AGENTS.md";
/**
 * The section's version. A section of a lower version is replaced by this one; one of this
 * version or a newer one, written by this or a later build, is left as it is.
 */
export const GUIDES_VERSION = 2;
/**
 * The first 16 hex digits of the SHA-256 of this version's text between the markers. A test
 * holds the text to it, so the text can't change without the version changing with it. Every
 * earlier version's section is in the tests (`guides-published.ts`), as released builds wrote it.
 */
export const GUIDES_PINNED_SHA256 = "ec194b8ae364ffb8";
/**
 * Where OpenClaw (2026.10.6 and 2026.11.10) starts cutting a long `AGENTS.md` out of a prompt
 * when its config sets no limit (`bootstrapMaxChars`): what Clawtrate uses when the config can't
 * be read (`guidesLimit`).
 */
export const GUIDES_LONG_CHARS = 20_000;
/** The gateway's default for all of a prompt's instruction files together (`bootstrapTotalMaxChars`). */
export const GUIDES_TOTAL_CHARS = 60_000;
/**
 * Whether a file may be cut from a prompt: its length without trailing whitespace, as the gateway
 * measures it, past `limit`.
 */
export const guidesWouldBeCut = (file: string, limit = GUIDES_LONG_CHARS) =>
  file.trimEnd().length > limit;

/**
 * The length past which the gateway cuts a bot's `AGENTS.md` from its prompt, from `config.get`'s
 * answer, as OpenClaw 2026.10.6 and 2026.11.10 resolve it (`resolveBootstrapCharLimit`): the bot's
 * own `bootstrapMaxChars` (its entry under `agents.entries`, or in `agents.list`), else
 * `agents.defaults`', else 20,000; a positive number only, rounded down. `AGENTS.md` comes first in
 * the prompt, so it also gets no more than `bootstrapTotalMaxChars`, resolved the same way.
 */
export function guidesLimit(answer: unknown, botId: string): number {
  const agents = rec(rec(rec(answer).config).agents);
  const id = botId.toLowerCase();
  const entries = rec(agents.entries);
  const keyed = Object.keys(entries).find((key) => key.toLowerCase() === id);
  const entry = rec(
    keyed !== undefined
      ? entries[keyed]
      : Array.isArray(agents.list)
        ? agents.list.find((each) => String(rec(each).id).toLowerCase() === id)
        : undefined,
  );
  const limit = (key: string, fallback: number) => {
    const raw = entry[key] ?? rec(agents.defaults)[key];
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
  };
  return Math.min(
    limit("bootstrapMaxChars", GUIDES_LONG_CHARS),
    limit("bootstrapTotalMaxChars", GUIDES_TOTAL_CHARS),
  );
}

/** Each configured bot's id in a config: its entry under `agents.entries`, or in `agents.list`. */
function configuredBots(answer: unknown): string[] {
  const agents = rec(rec(rec(answer).config).agents);
  const listed = Array.isArray(agents.list) ? agents.list.map((each) => rec(each).id) : [];
  return [...Object.keys(rec(agents.entries)), ...listed].filter(
    (id): id is string => typeof id === "string" && id !== "",
  );
}

/**
 * Each folder's limit (`guidesLimit`, the least of its bots'), from one `config.get`, or null when
 * it isn't established, for every folder: then 20,000 could be more than the gateway keeps whole,
 * and Clawtrate writes nothing by itself. It is established only from the config the gateway runs
 * with: `config.get` reads the settings file, and both OpenClaw 2026.10.6 and 2026.11.10 answer the
 * revision of that file (`configRevisionHash`, null when it isn't valid) beside the revision the
 * running gateway applied (`appliedConfigHash`, `config-get-response.ts`); both have to be there
 * and the same. And only when `visible`, the bots the gateway lists to this connection, holds
 * every bot that config names: `agents.list` leaves out the bots an operator's role doesn't
 * allow, and one of those may read a folder shown here, with a lower limit. A config that sets no
 * limit gives 20,000, the gateway's own.
 */
export async function readGuidesLimits(
  request: Request,
  visible: string[],
): Promise<(bots: string[]) => number | null> {
  const shown = new Set(visible.map((id) => id.toLowerCase()));
  const known = (read: unknown) => {
    const { config, configRevisionHash: saved, appliedConfigHash: applied } = rec(read);
    if (config === undefined || typeof saved !== "string" || saved === "" || saved !== applied)
      return false;
    return configuredBots(read).every((id) => shown.has(id.toLowerCase()));
  };
  const answer = await request("config.get", {}).then(
    (read) => (known(read) ? read : null),
    () => null,
  );
  return (bots) =>
    answer === null ? null : Math.min(...bots.map((bot) => guidesLimit(answer, bot)));
}

/**
 * The gateway's own record of the bots that held Clawtrate's section, from any of this person's
 * devices: one user preference (`users.prefs`, per person, as the sidebar's arrangement and the
 * budgets are), so a device that has never seen the gateway knows a section removed on another
 * one was removed, and doesn't add it again. The device's own record can't carry that: it is kept
 * on the device. `full`: the bots didn't all fit, so a bot not listed has no known history.
 * `folders`: the folder each bot was recorded in (`folderKeys`), as `GuidesRecord`'s.
 */
export type GuidesHistory = { bots: string[]; full: boolean; folders?: Record<string, string> };
export const GUIDES_HISTORY_KEY = "clawtrate.guides.history";
/** The most the gateway keeps in one preference: 4,096 UTF-8 bytes of its JSON (`value-too-large`). */
export const MAX_GUIDES_HISTORY_BYTES = 4_096;
/** The most bots read from it, whatever its size. */
export const MAX_GUIDES_HISTORY_BOTS = 512;
/** Tries of a history save against another device's save at the same time (`conflict`). */
const GUIDES_HISTORY_ATTEMPTS = 3;

/**
 * `kept: false`: the gateway keeps no preferences for this connection (`no_durable_identity`, or
 * any status but ok), so there is no history to read or write. A failed read, or a value that
 * isn't one, is neither: the history may say something this device can't see.
 */
type HistoryRead =
  { known: true; history: GuidesHistory; raw: unknown } | { known: false; kept: boolean };

/** The history the gateway holds, as read now; never guessed when it can't be read. */
export async function readGuidesHistory(request: Request): Promise<HistoryRead> {
  const answer = await request("users.prefs.get", { keys: [GUIDES_HISTORY_KEY] }).then(
    rec,
    () => null,
  );
  // A failure, or an answer that isn't one: the history isn't known.
  if (answer === null || typeof answer.status !== "string") return { known: false, kept: true };
  // `no_durable_identity`: the gateway keeps none for this connection.
  if (answer.status !== "ok") return { known: false, kept: false };
  const entries = rec(answer.entries);
  const raw = Object.hasOwn(entries, GUIDES_HISTORY_KEY) ? entries[GUIDES_HISTORY_KEY] : null;
  // None yet: no device of this person has recorded a bot on this gateway.
  if (raw === null || raw === undefined)
    return { known: true, history: { bots: [], full: false }, raw: null };
  const fields = rec(raw);
  if (fields.v !== 1 || !Array.isArray(fields.bots)) return { known: false, kept: true };
  const bots = fields.bots
    .filter((bot): bot is string => typeof bot === "string" && bot !== "")
    .slice(0, MAX_GUIDES_HISTORY_BOTS);
  const folders = foldersOf(fields.folders, bots);
  return {
    known: true,
    history: {
      bots,
      full: fields.full === true || bots.length < fields.bots.length,
      ...(folders && { folders }),
    },
    raw,
  };
}

/** A stored `folders`, for `bots` only; undefined when it holds none. */
function foldersOf(value: unknown, bots: string[]): Record<string, string> | undefined {
  const pairs = Object.entries(rec(value)).filter(
    (pair): pair is [string, string] => typeof pair[1] === "string" && bots.includes(pair[0]),
  );
  return pairs.length > 0 ? Object.fromEntries(pairs) : undefined;
}

/** The history as written: as many bots as fit in one preference, and `full` when some don't. */
export function fitGuidesHistory(history: GuidesHistory): {
  v: 1;
  bots: string[];
  full?: true;
  folders?: Record<string, string>;
} {
  const bots = [...new Set(history.bots)].slice(0, MAX_GUIDES_HISTORY_BOTS);
  let full = history.full || bots.length < new Set(history.bots).size;
  const value = () => {
    const folders = foldersOf(history.folders, bots);
    return {
      v: 1 as const,
      bots,
      ...(full && { full: true as const }),
      ...(folders && { folders }),
    };
  };
  while (utf8Bytes(JSON.stringify(value())).length > MAX_GUIDES_HISTORY_BYTES) {
    bots.pop();
    full = true;
  }
  return value();
}

/** Save `next` of the history read, compare-and-set; on another device's save, `next` of that. */
async function saveGuidesHistory(
  request: Request,
  read: HistoryRead & { known: true },
  next: (history: GuidesHistory) => GuidesHistory,
): Promise<boolean> {
  let current = read;
  for (let attempt = 0; attempt < GUIDES_HISTORY_ATTEMPTS; attempt += 1) {
    const value = fitGuidesHistory(next(current.history));
    if (
      current.raw !== null &&
      JSON.stringify(value) === JSON.stringify(fitGuidesHistory(current.history))
    )
      return true;
    const answer = rec(
      await request("users.prefs.set", {
        entries: { [GUIDES_HISTORY_KEY]: value },
        expectedEntries: { [GUIDES_HISTORY_KEY]: current.raw ?? null },
      }).catch(() => null),
    );
    if (answer.status === "ok") return true;
    if (answer.status !== "conflict") return false;
    const again = await readGuidesHistory(request);
    if (!again.known) return false;
    current = again;
  }
  return false;
}

/** The second line of the section: whose it is, and where it is turned off. */
export const GUIDES_NOTICE =
  "<!-- Added by Clawtrate, which keeps it current. Turn it off in Clawtrate: Settings, Conversation. -->";
/** The guides themselves, as Settings shows them (Read it). */
export const GUIDES_TEXT = `${VOICE_GUIDE}\n\n${WHERE_GUIDE}`;

const END = "<!-- clawtrate:guides end -->";
const BEGIN_LINE = /^<!-- clawtrate:guides begin v(\d{1,6}) sha256=([a-f0-9]{64}) -->\r?\n/m;
const END_LINE = /^<!-- clawtrate:guides end -->[ \t]*(?:\r?\n|$)/m;
/** Any line that looks like one of the markers, well formed or not. */
const ANY_MARKER = /^<!-- clawtrate:guides\b[^\n]*(?:\n|$)/gm;

const hash = (text: string) => sha256Hex(utf8Bytes(text));

/** Between the markers: the notice, then the guides. Its SHA-256 is in the first marker. */
const INNER = `${GUIDES_NOTICE}\n${GUIDES_TEXT}\n`;
/** The whole section, as Clawtrate writes it, ending with a line break. */
export const GUIDES_SECTION = `<!-- clawtrate:guides begin v${GUIDES_VERSION} sha256=${hash(INNER)} -->\n${INNER}${END}\n`;
/** The most of a changed section's text an answer carries, for Show. */
export const MAX_CHANGED_SECTION_CHARS = 16_384;

/** What a file holds of Clawtrate's section: `start` and `end` bound the span it takes. */
export type FoundSection =
  | { kind: "none" }
  | { kind: "ours"; current: boolean; start: number; end: number }
  /**
   * Changed outside Clawtrate. `replaceable` only for one well-formed pair at the top of the
   * file (offset 0, or 1 after a leading byte-order mark) whose hash fails: anything else with a
   * marker in it can't be told apart from the person's own text, so nothing writes to it.
   * `moved`: an intact section (its hash holds) that isn't at the top, where Clawtrate writes it:
   * a bot moved it or a person quoted it, so it is shown and nothing writes to the file.
   */
  | {
      kind: "changed";
      replaceable: boolean;
      moved: boolean;
      start: number;
      end: number;
      text: string;
    };

/**
 * Find Clawtrate's section. It is ours when exactly one well-formed pair of markers is there and
 * what lies between them hashes to the first marker's hash; current when its version is this
 * build's or a later one. Anything else that carries a marker changed outside Clawtrate.
 */
export function findSection(file: string): FoundSection {
  // A leading byte-order mark stands before the first line: the section is read past it.
  if (file.startsWith("\uFEFF")) {
    const found = findSection(file.slice(1));
    return found.kind === "none" ? found : { ...found, start: found.start + 1, end: found.end + 1 };
  }
  const markers = [...file.matchAll(ANY_MARKER)];
  if (markers.length === 0) return { kind: "none" };
  const begin = BEGIN_LINE.exec(file);
  const innerStart = begin ? begin.index + begin[0].length : -1;
  const end = begin ? END_LINE.exec(file.slice(innerStart)) : null;
  if (!begin || !end || markers.length !== 2) {
    // Markers out of shape: the span runs from the first to the last of them.
    const first = markers[0]!;
    const last = markers.at(-1)!;
    const start = first.index;
    const stop = last.index + last[0].length;
    return {
      kind: "changed",
      replaceable: false,
      moved: false,
      start,
      end: stop,
      text: file.slice(start, stop),
    };
  }
  const inner = file.slice(innerStart, innerStart + end.index);
  const stop = innerStart + end.index + end[0].length;
  if (hash(inner) !== begin[2])
    return {
      kind: "changed",
      // Replace takes out exactly what Show shows: a span at the top, no longer than Show's bound,
      // with no code-fence line in it (Clawtrate's own text has none: a fence means a marker
      // was quoted, and the span would run into the person's text).
      replaceable:
        begin.index === 0 &&
        stop - begin.index <= MAX_CHANGED_SECTION_CHARS &&
        !/^\s*(```|~~~)/m.test(inner),
      moved: false,
      start: begin.index,
      end: stop,
      text: file.slice(begin.index, stop),
    };
  // Intact, but not at the top, where Clawtrate writes it: moved by a bot or quoted by a person.
  // Clawtrate's only where it put it, so this one is shown and never written.
  if (begin.index !== 0)
    return {
      kind: "changed",
      replaceable: false,
      moved: true,
      start: begin.index,
      end: stop,
      text: file.slice(begin.index, stop),
    };
  return {
    kind: "ours",
    current: Number(begin[1]) >= GUIDES_VERSION,
    start: begin.index,
    end: stop,
  };
}

/**
 * The file with this version's section: in place of the one there, or at the top, with a blank
 * line before what was there, an empty file's included, so a line added below it later is never
 * taken for Clawtrate's; a leading byte-order mark stays first. Nothing else in the file changes.
 */
export function withSection(file: string): string {
  const found = findSection(file);
  if (found.kind === "changed" && !found.replaceable) return file;
  if (found.kind !== "none")
    return file.slice(0, found.start) + GUIDES_SECTION + file.slice(found.end);
  // A byte-order mark stays first, before the section, as findSection reads it.
  const top = file.startsWith("\uFEFF") ? 1 : 0;
  return `${file.slice(0, top)}${GUIDES_SECTION}\n${file.slice(top)}`;
}

/**
 * The file without the section: a file Clawtrate added it to comes back byte for byte as it
 * was, the blank line it added included.
 */
export function withoutSection(file: string): string {
  const found = findSection(file);
  if (found.kind !== "ours") return file;
  let after = file.slice(found.end);
  const top = file.startsWith("\uFEFF") ? 1 : 0;
  if (found.start === top && after.startsWith("\n")) after = after.slice(1);
  return file.slice(0, found.start) + after;
}

// Reading and writing a gateway's bots ------------------------------------------------------

type Request = (method: string, params: unknown) => Promise<unknown>;
type Raw = Record<string, unknown>;
const rec = (value: unknown): Raw =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {};
const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);

/**
 * Where a bot's section stands:
 * - `none`: not there, and this device never knew it there; while the switch is on it is added
 *   by itself, unless that would make the file too long;
 * - `current`: this version, as Clawtrate wrote it;
 * - `older`: an earlier version, as Clawtrate wrote it; it is brought up to date by itself;
 * - `changed`: edited outside Clawtrate, by the bot or a person, or moved from the top of the
 *   file (`moved`); it is left as it is;
 * - `removed`: this device added it or saw it there, and it was taken out outside Clawtrate
 *   since, on purpose by someone; it is not added again unless the person asks.
 */
export type GuideState = "none" | "current" | "older" | "changed" | "removed";

/** One instructions file, and the bots that read it: bots can share a workspace folder. */
export type GuideFolder = {
  bots: string[];
  /** Null when the file couldn't be read, or isn't plain UTF-8 text; `error` says why. */
  state: GuideState | null;
  /** A changed section Replace may write over: one well-formed pair at the top (`FoundSection`). */
  replaceable: boolean;
  /** An intact section that isn't at the top, where Clawtrate put it: nothing writes to it. */
  moved: boolean;
  /**
   * The file with this version's section in it (added, or put in place of an older one) may be
   * cut from a prompt (`guidesWouldBeCut`); false when it couldn't be read.
   */
  long: boolean;
  /** The file is plain UTF-8 text. When it isn't, its state is still read, and nothing writes. */
  utf8: boolean;
  /**
   * The file doesn't exist yet. The gateway makes it from its own template on the bot's next run,
   * only while it is missing, so Clawtrate never makes it by itself.
   */
  missing: boolean;
  /** The gateway refused Clawtrate's own write of this file, and why: not tried again by itself. */
  refused: string | null;
  /** The text between the markers of a changed section, for Show, cut to its bound. */
  changedText: string | null;
  error: string | null;
};

/** What this device keeps, per gateway. */
export type GuidesRecord = {
  /** The switch: off only once the person turned it off. No record at all reads as on. */
  on: boolean;
  /**
   * The bots this device knew to carry Clawtrate's section while the switch was on: those it
   * added it to, and those it found holding one. Such a bot whose section is gone was cleared on
   * purpose by someone, so it reads `removed` and isn't added to again by itself.
   */
  bots: string[];
  /**
   * Bots whose file the gateway refused Clawtrate's own write of, with the gateway's reason (cut
   * to `MAX_REFUSED_CHARS`): not tried again by itself until the person adds it or turns the
   * switch on.
   */
  refused?: Record<string, string>;
  /**
   * The folder each of `bots` was recorded in (`folderKeys`): a bot that reads another folder
   * now has no history there. A bot without one, recorded before folders were kept, counts in
   * any folder, as it did then.
   */
  folders?: Record<string, string>;
};

/** Where this device keeps its record for a gateway, by the gateway's identity. */
export const guidesKey = (gatewayId: string) => `clawtrate.guides.${gatewayId}`;
/**
 * Where this device keeps the switch for gateways it has no record of: saved off when the person
 * turns the switch off anywhere, deleted when they turn it on.
 */
export const GUIDES_DEFAULT_KEY = "clawtrate.guides.default";
/** The most of a gateway's reason for a refused write a record keeps. */
export const MAX_REFUSED_CHARS = 300;

/** The guides as Settings shows them: read now, never assumed. */
export type BotGuides = {
  folders: GuideFolder[];
  /** This device's record for this gateway, or null before any: the switch reads on then. */
  record: GuidesRecord | null;
  /** This device's record couldn't be read: whether the switch is on isn't known. */
  unreadable: boolean;
  /**
   * Off only because the person turned it off for another gateway on this device (the
   * device-wide default): this gateway has no choice of its own yet.
   */
  inherited?: boolean;
  /** The voice plugin adds its own voice guide (on, its hook permitted). */
  voicePlugin: boolean;
  /** What failed in the change this answers, one sentence per file. */
  errors: string[];
};
export type BotGuidesAnswer = BotGuides & { stamp: GatewayStamp };

export class GuideConflictError extends Error {}
/** The gateway's own refusal of a write, for a reason other than a changed file. */
export class GuideRefusedError extends Error {}

/** A bot's `AGENTS.md`: its text and the hash a write is held to, or missing. */
async function readFile(
  request: Request,
  agentId: string,
): Promise<{ content: string; held: Raw; utf8: boolean; missing: boolean }> {
  const file = rec(rec(await request("agents.files.get", { agentId, name: GUIDES_FILE })).file);
  if (file.missing === true)
    return { content: "", held: { expectedMissing: true }, utf8: true, missing: true };
  if (typeof file.content !== "string" || !isHash(file.hash))
    throw new Error(`The gateway did not return ${agentId}'s ${GUIDES_FILE} and its revision.`);
  // The gateway hashes the bytes and decodes them as UTF-8: bytes that aren't come back as
  // U+FFFD under the bytes' hash. Written back, they would be changed for good, so such a file
  // is read (its markers are ASCII) and never written.
  return {
    content: file.content,
    held: { expectedHash: file.hash },
    utf8: hash(file.content) === file.hash.toLowerCase(),
    missing: false,
  };
}

/** The gateway's refusal of a write held to a hash the file no longer has. */
const conflict = (error: unknown) =>
  rec(rec(error).details).type === "agent_file_conflict" ||
  (error instanceof Error && error.message.includes("agent_file_conflict"));

/**
 * Whether the gateway refused a write for good: its own answer (not a lost connection or a lost
 * answer), one the app calls lasting (`answerKind`), and not `UNAVAILABLE`. OpenClaw (2026.10.6
 * and 2026.11.10) sends any error its handler throws as `UNAVAILABLE` with no flag and no reason,
 * a race with the workspace host and a full or busy disk included: those may pass, so the next
 * occasion tries again (one read and one write per connect at most), and nothing is remembered.
 * A refusal such as `INVALID_REQUEST` or `FORBIDDEN` is remembered.
 */
export const refusedForGood = (error: unknown) =>
  error instanceof GatewayProtocolRequestError &&
  error.gatewayCode !== "UNAVAILABLE" &&
  answerKind(error) === "lasting";

/** The gateway's reason, as a person reads it: without the "Error: " the message is wrapped in. */
const refusalReason = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/^(?:Error:\s*)+/, "");

/**
 * Change one bot's file by `next`, read now and held to the hash read: `next` returns the new
 * text, or null to leave it. A file that isn't plain UTF-8 is never written: the change fails,
 * or with `byItself` (Clawtrate's own changes) it is left without a word. With `byItself`, a
 * missing file is left too: the gateway writes its own template into it only while it is missing.
 * A write refused because the file changed meanwhile reads it again and tries once more; one the
 * gateway refuses for good fails as `GuideRefusedError` (`refusedForGood`). Answers whether anything was
 * written, what the file held, and whether it was missing.
 */
export async function changeGuideFile(
  request: Request,
  agentId: string,
  next: (file: string, found: FoundSection) => string | null,
  options: { byItself?: boolean } = {},
): Promise<{ written: boolean; found: FoundSection; missing: boolean }> {
  for (let attempt = 0; ; attempt += 1) {
    const { content, held, utf8, missing } = await readFile(request, agentId);
    const found = findSection(content);
    if (options.byItself && (missing || !utf8)) return { written: false, found, missing };
    if (!utf8)
      throw new Error(
        `${agentId}'s ${GUIDES_FILE} isn't plain UTF-8 text, so Clawtrate can't change it.`,
      );
    const wanted = next(content, found);
    if (wanted === null || wanted === content) return { written: false, found, missing };
    try {
      const result = rec(
        await request("agents.files.set", {
          agentId,
          name: GUIDES_FILE,
          content: wanted,
          ...held,
        }),
      );
      if (result.ok !== true)
        throw new Error(`The gateway did not confirm ${agentId}'s ${GUIDES_FILE} was saved.`);
      return { written: true, found, missing };
    } catch (error) {
      if (attempt === 0 && conflict(error)) continue;
      if (conflict(error))
        throw new GuideConflictError(
          `${GUIDES_FILE} kept changing while Clawtrate wrote it, so it was left as it is.`,
        );
      if (refusedForGood(error)) throw new GuideRefusedError(refusalReason(error));
      throw error;
    }
  }
}

/**
 * Each bot's workspace folder, as `agents.list` names it, as 16 hex digits of its hash, so a
 * record's entry has a fixed size; a bot without one stands alone.
 */
function folderKeys(agents: unknown): Map<string, string> {
  const keys = new Map<string, string>();
  for (const agent of Array.isArray(rec(agents).agents) ? (rec(agents).agents as unknown[]) : []) {
    const id = rec(agent).id;
    if (typeof id !== "string" || id === "") continue;
    const workspace = rec(agent).workspace;
    const key = typeof workspace === "string" && workspace !== "" ? `w:${workspace}` : `b:${id}`;
    keys.set(id, hash(key).slice(0, 16));
  }
  return keys;
}

/** The bots that read each folder (`folderKeys`): bots can share a workspace folder. */
export function guideFolders(agents: unknown): string[][] {
  const groups = new Map<string, string[]>();
  for (const [id, key] of folderKeys(agents)) groups.set(key, [...(groups.get(key) ?? []), id]);
  return [...groups.values()];
}

/** Whether a bot recorded in `folder` was recorded in the one it reads now; no folder is any. */
const sameFolder = (where: Map<string, string>, bot: string, folder: string | undefined) =>
  (folder ?? where.get(bot)) === where.get(bot);

/**
 * The state of each folder's file, read now; `record` tells removed from never there, and keeps
 * the gateway's refusals. Whether a file is long goes by the gateway's own limit for its bots.
 */
export async function readGuideFolders(
  request: Request,
  record: GuidesRecord | null,
): Promise<GuideFolder[]> {
  const [listed, history] = await Promise.all([
    request("agents.list", {}),
    readGuidesHistory(request),
  ]);
  const folders = guideFolders(listed);
  const where = folderKeys(listed);
  const limits = await readGuidesLimits(request, folders.flat());
  // A bot another of this person's devices recorded counts as one this device knew, while on.
  // Each counts only in the folder it was recorded in: a bot moved to another has none there.
  const knew = (bot: string) =>
    (record?.bots.includes(bot) === true && sameFolder(where, bot, record.folders?.[bot])) ||
    (record?.on !== false &&
      history.known &&
      history.history.bots.includes(bot) &&
      sameFolder(where, bot, history.history.folders?.[bot]));
  const refusedOf = (bots: string[]) =>
    bots.map((bot) => record?.refused?.[bot]).find((reason) => reason !== undefined) ?? null;
  return Promise.all(
    folders.map(async (bots): Promise<GuideFolder> => {
      try {
        const { content, utf8, missing } = await readFile(request, bots[0]!);
        const found = findSection(content);
        const state: GuideState =
          found.kind === "ours"
            ? found.current
              ? "current"
              : "older"
            : found.kind === "changed"
              ? "changed"
              : bots.some(knew)
                ? "removed"
                : "none";
        return {
          bots,
          state,
          replaceable: found.kind === "changed" && found.replaceable,
          moved: found.kind === "changed" && found.moved,
          // Shown against the gateway's limit, or its default when the config couldn't be read.
          long: guidesWouldBeCut(withSection(content), limits(bots) ?? GUIDES_LONG_CHARS),
          utf8,
          missing,
          refused: state === "none" ? refusedOf(bots) : null,
          changedText:
            found.kind === "changed" ? found.text.slice(0, MAX_CHANGED_SECTION_CHARS) : null,
          error: null,
        };
      } catch (error) {
        return {
          bots,
          state: null,
          replaceable: false,
          moved: false,
          long: false,
          utf8: true,
          missing: false,
          refused: null,
          changedText: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

/**
 * A record as this device stored it, or null when it isn't one: the caller treats that as a record
 * it can't read, never as no record. `on: false` is off whatever else is there. A record left by
 * the card before the switch (#542: the bots added with the person's yes, and "New bots too") is
 * read as on, with its bots: one that holds no yes can't tell a dismissed card from a removal,
 * and bots know how Clawtrate works by default.
 */
export function parseGuidesRecord(value: string | null): GuidesRecord | null {
  if (value === null) return null;
  try {
    const raw = JSON.parse(value) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const fields = rec(raw);
    if (fields.on === false) return offRecord();
    const bots = Array.isArray(fields.bots)
      ? fields.bots.filter((bot): bot is string => typeof bot === "string").slice(0, 512)
      : null;
    if (!bots) return null;
    if (fields.on === true) {
      const refused = Object.entries(rec(fields.refused)).filter(
        (pair): pair is [string, string] => typeof pair[1] === "string",
      );
      const folders = foldersOf(fields.folders, bots);
      return {
        on: true,
        bots,
        ...(refused.length > 0 && { refused: Object.fromEntries(refused.slice(0, 512)) }),
        ...(folders && { folders }),
      };
    }
    return fields.on === undefined && typeof fields.newBots === "boolean"
      ? { on: true, bots }
      : null;
  } catch {
    return null;
  }
}

/**
 * A change to the guides:
 * - `switch`: the person's one switch. On adds the section to every bot that has none and that
 *   this device never knew it on, and brings older ones up to date, as `auto` does, trying again
 *   the files the gateway refused. Off takes it out of every file it is in as Clawtrate wrote it,
 *   and nothing is added after; a changed one is left as it is.
 * - `remove`: a row's Remove while the switch is off: the section out of these bots' files (and
 *   the bots sharing their folders) only.
 * - `add`: the person's Add on one row: the section for these bots (and the bots sharing their
 *   folders), a removed one's or a long file's included; an older one is brought up to date and a
 *   changed one is left. Only while the switch is on.
 * - `replace`: this version in place of a section changed outside Clawtrate, for one bot's file.
 *   Only while the switch is on.
 * - `auto`: the client's own, never a viewer's: after a connect with admin access, and for a bot
 *   just made (`bot`), while the switch is on. As `switch` on, without changing the switch.
 */
export type GuidesChange =
  | { action: "switch"; on: boolean }
  | { action: "add"; bots: string[] }
  | { action: "remove"; bots: string[] }
  /** `shown`: the changed section as Settings read it (`changedText`); nothing else is replaced. */
  | { action: "replace"; bot: string; shown: string }
  | { action: "auto"; bot?: string };

/** The record of a switch turned off: it holds no bots. */
export const offRecord = (): GuidesRecord => ({ on: false, bots: [] });

/** The switch as this device holds it: on until the person turns it off. */
export const guidesOn = (record: GuidesRecord | null) => record?.on ?? true;

/**
 * What a change that turns the switch off leaves as this device's record, or null for any other
 * change. Off is saved before anything else, so nothing is done when it can't be saved; it holds
 * no bots, so nothing reads as removed and nothing is added while it lasts.
 */
export function withdrawnRecord(change: GuidesChange): GuidesRecord | null {
  return change.action === "switch" && !change.on ? offRecord() : null;
}

/** Said when the switch can't be changed because this device couldn't save it: nothing was done. */
export const GUIDES_NOT_SAVED = "Couldn't save this on this device, so nothing was changed.";
/**
 * Said when the gateway's history couldn't record a removal before it: the section would be gone
 * with nothing saying it was taken out on purpose, so another device could add it again.
 */
export const GUIDES_HISTORY_NOT_SAVED =
  "It's off, but the gateway couldn't record that Clawtrate is taking its section out, so nothing was taken out.";
/** Said when this device's record can't be read: it may say off, so nothing is changed. */
export const GUIDES_NOT_READ = "Couldn't read this on this device, so nothing was changed.";
/** Said when a row's Remove comes while the switch is on: Clawtrate would add it back. */
export const GUIDES_ON =
  '"Bots know how Clawtrate works" is on, so the section stays. Turn it off to take it out.';
/** Said when On was saved and nothing written, but which bots hold the section wasn't saved. */
export const GUIDES_ON_NOT_RECORDED =
  "It's on, but this device couldn't record which bots hold the section, so it can't tell later whether one was removed on purpose.";
/** Said when Off was saved for this gateway, but not as the default for gateways not seen yet. */
export const GUIDES_DEFAULT_NOT_SAVED =
  "It's off for this gateway, but this device couldn't save it for gateways it hasn't connected to yet.";
/** Said when files were changed on the gateway but this device couldn't record which. */
export const GUIDES_NOT_RECORDED =
  "The bots' files were changed, but this device couldn't record which, so it can't tell later whether one of these sections was removed on purpose.";
/** Said when a stale screen asks for a section while the switch is off: off wins. */
export const GUIDES_OFF = '"Bots know how Clawtrate works" is off, so nothing was added.';

/**
 * Apply `change` to the gateway's files, each read now and held to its hash, and answer the
 * record to keep and what failed, one sentence per file. What the files hold afterwards is read
 * back by the caller: nothing is reported as done from what was sent.
 */
export async function applyGuidesChange(
  request: Request,
  record: GuidesRecord | null,
  change: GuidesChange,
): Promise<{
  record: GuidesRecord | null;
  errors: string[];
  /** Whether any file was written. */
  wrote: boolean;
  /** Folders Clawtrate's own change left because their file doesn't exist yet. */
  missing: string[][];
}> {
  const on = change.action === "switch" ? change.on : guidesOn(record);
  // Off wins: nothing is added or replaced while it is off, whoever asks. A row's Remove is for
  // a switch that is off: while it is on, the section would only come back.
  if (!on && change.action !== "switch" && change.action !== "remove")
    return {
      record,
      errors: change.action === "auto" ? [] : [GUIDES_OFF],
      wrote: false,
      missing: [],
    };
  if (on && change.action === "remove")
    return { record, errors: [GUIDES_ON], wrote: false, missing: [] };
  const listedAgents = await request("agents.list", {});
  const folders = guideFolders(listedAgents);
  const where = folderKeys(listedAgents);
  // The gateway's history of the bots that held the section, from any of this person's devices.
  const history = await readGuidesHistory(request);
  const elsewhere = new Set(history.known ? history.history.bots : []);
  /** A bot the history recorded in the folder it reads now. */
  const elsewhereHere = (bot: string) =>
    elsewhere.has(bot) &&
    sameFolder(where, bot, history.known ? history.history.folders?.[bot] : undefined);
  /** Whether a folder's history is known: a bot not in a history that is full has none. */
  const historyKnown = (bots: string[]) =>
    history.known && (!history.history.full || bots.some((bot) => elsewhere.has(bot)));
  /** Bots whose folder held a marked section in this change, for the gateway's history. */
  const held = new Set<string>();
  const errors: string[] = [];
  /** The bots this device knows held the section, each with the folder it held it in. */
  const kept = new Map(
    (on ? (record?.bots ?? []) : []).map((bot) => [bot, record?.folders?.[bot]] as const),
  );
  const keep = (bot: string) => kept.set(bot, where.get(bot));
  const keptHere = (bot: string) => kept.has(bot) && sameFolder(where, bot, kept.get(bot));
  const foldersIn = (bots: string[], of: (bot: string) => string | undefined) =>
    Object.fromEntries(bots.flatMap((bot) => (of(bot) === undefined ? [] : [[bot, of(bot)!]])));
  /** Only bots still on the gateway's list are kept, so the record holds no deleted bot's id. */
  const onList = new Set(folders.flat());
  const listed = (bots: string[]) => bots.filter((bot) => onList.has(bot));
  // Refusals are kept only for Clawtrate's own change: the switch turned on, or the person's own
  // Add for those bots, tries again.
  const refused = new Map(change.action === "auto" ? Object.entries(record?.refused ?? {}) : []);
  if (change.action === "add" && on)
    for (const [bot, reason] of Object.entries(record?.refused ?? {}))
      if (!change.bots.includes(bot)) refused.set(bot, reason);
  const missing: string[][] = [];
  let wrote = false;
  /** The record this change leaves, while the switch is on. */
  const onRecord = (): GuidesRecord => {
    const left = [...refused].filter(([bot]) => onList.has(bot));
    const bots = listed([...kept.keys()]);
    const folders = foldersIn(bots, (bot) => kept.get(bot));
    return {
      on: true,
      bots,
      ...(left.length > 0 && { refused: Object.fromEntries(left) }),
      ...(Object.keys(folders).length > 0 && { folders }),
    };
  };
  /** Change one folder's file; whether it holds Clawtrate's section, or any marked one, after. */
  const each = async (
    bots: string[],
    next: (file: string, found: FoundSection) => string | null,
    byItself = false,
  ): Promise<{ ours: boolean; marked: boolean }> => {
    try {
      const result = await changeGuideFile(request, bots[0]!, next, { byItself });
      if (result.missing && byItself) missing.push(bots);
      if (result.written) wrote = true;
      const ours = result.written || (result.found.kind === "ours" && result.found.current);
      const marked = ours || result.found.kind !== "none";
      if (marked) for (const bot of bots) held.add(bot);
      return { ours, marked };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (byItself && error instanceof GuideRefusedError)
        for (const bot of bots) refused.set(bot, reason.slice(0, MAX_REFUSED_CHARS));
      errors.push(`${bots.join(", ")}: ${reason}`);
      return { ours: false, marked: false };
    }
  };
  // What Clawtrate writes by itself never takes a file past the length the gateway keeps whole:
  // the gateway's own limit for the folder's bots, read once for the change. When the config
  // can't be read the limit isn't known, so nothing is written by itself: it is tried again at
  // the next occasion. The person's own Add doesn't depend on it.
  const limits =
    change.action === "auto" || (change.action === "switch" && change.on)
      ? await readGuidesLimits(request, folders.flat())
      : () => GUIDES_LONG_CHARS;
  /**
   * The gateway's history after this change: the bots that held a marked section added to it.
   * Turning the switch on starts it again, for the bots on this change's list, from those that
   * hold the section after it, as it does this device's record: the person asked for it on every
   * bot. A bot not on that list (one this connection isn't shown, or one another device recorded
   * since) keeps its entry, from the history as read at each try. A history that can't be read
   * isn't written; a save that fails leaves it as it was, and nothing is said. A removal is
   * recorded before it, below.
   */
  const finish = async <T>(result: T): Promise<T> => {
    if (history.known)
      await saveGuidesHistory(request, history, (was) =>
        change.action === "switch" && change.on
          ? {
              bots: [...listed([...kept.keys()]), ...was.bots.filter((bot) => !onList.has(bot))],
              full: false,
              folders: { ...was.folders, ...foldersIn([...kept.keys()], (bot) => kept.get(bot)) },
            }
          : {
              bots: [...was.bots, ...held],
              full: was.full,
              folders: { ...was.folders, ...foldersIn([...held], (bot) => where.get(bot)) },
            },
      );
    return result;
  };
  const addOrUpdate =
    (byItself: boolean, bots: string[]) => (file: string, found: FoundSection) => {
      if (found.kind !== "none" && !(found.kind === "ours" && !found.current)) return null;
      const next = withSection(file);
      if (!byItself) return next;
      const limit = limits(bots);
      return limit === null || guidesWouldBeCut(next, limit) ? null : next;
    };
  /**
   * A removal is recorded on the gateway before any file changes: the folders among `groups` whose
   * file holds a marked section go into its history first, so another device knows the section
   * was taken out on purpose. If that save fails, or the history can't be read, nothing is
   * removed (null), and the change says so; a gateway that keeps no history for this connection
   * has none to record. Only the folders recorded are changed after.
   */
  async function recordRemoval(groups: string[][]): Promise<string[][] | null> {
    const holding: string[][] = [];
    for (const bots of groups) {
      // A file that can't be read now may hold one: it is recorded, and its change says why it failed.
      const found = await readFile(request, bots[0]!).then(
        ({ content }) => findSection(content).kind,
        () => "unread" as const,
      );
      if (found !== "none") holding.push(bots);
    }
    if (holding.length === 0 || (!history.known && !history.kept)) return holding;
    if (!history.known) return null;
    const saved = await saveGuidesHistory(request, history, (was) => ({
      bots: [...was.bots, ...holding.flat()],
      full: was.full,
      folders: { ...was.folders, ...foldersIn(holding.flat(), (bot) => where.get(bot)) },
    }));
    return saved ? holding : null;
  }
  if (change.action === "remove") {
    const recorded = await recordRemoval(
      folders.filter((group) => group.some((bot) => change.bots.includes(bot))),
    );
    if (recorded === null) return { record, errors: [GUIDES_HISTORY_NOT_SAVED], wrote, missing };
    for (const bots of recorded)
      await each(bots, (file, found) => {
        // A section that changed since Settings read it isn't Clawtrate's to take out: said, so
        // nothing announces it as gone.
        if (found.kind === "changed")
          throw new Error(
            `${GUIDES_FILE}'s section changed after Settings read it, so Clawtrate left it as it is.`,
          );
        return found.kind === "ours" ? withoutSection(file) : null;
      });
    return { record, errors, wrote, missing };
  }
  if (change.action === "add" || change.action === "replace") {
    const asked = change.action === "add" ? change.bots : [change.bot];
    const chosen = folders.filter((group) => group.some((bot) => asked.includes(bot)));
    if (change.action === "replace" && chosen.length === 0)
      return {
        record,
        errors: [`${change.bot} isn't on the gateway's list of bots.`],
        wrote,
        missing,
      };
    if (change.action === "replace")
      for (const [bot, reason] of Object.entries(record?.refused ?? {})) refused.set(bot, reason);
    // The person's Add tries a refused folder again: every bot sharing it, not only the one asked.
    if (change.action === "add")
      for (const bots of chosen) for (const bot of bots) refused.delete(bot);
    for (const bots of chosen) {
      const { ours } = await each(
        bots,
        change.action === "add"
          ? addOrUpdate(false, bots)
          : (file, found) => {
              if (found.kind !== "changed" || !found.replaceable) return null;
              // Changed again since the person was shown it: what they'd replace isn't what they saw.
              if (found.text !== change.shown)
                throw new Error(
                  `${GUIDES_FILE} changed again after Settings read it, so nothing was replaced. Look at its section again before you replace it.`,
                );
              return withSection(file);
            },
      );
      if (ours) for (const bot of bots) keep(bot);
    }
    return finish({ record: onRecord(), errors, wrote, missing });
  }
  if (!on) {
    // Off is already saved on this device: if the gateway can't record the removal first, the
    // sections stay, and their rows say so, with Remove.
    const recorded = await recordRemoval(folders);
    if (recorded === null)
      return { record: offRecord(), errors: [GUIDES_HISTORY_NOT_SAVED], wrote, missing };
    for (const bots of recorded)
      await each(bots, (file, found) => (found.kind === "ours" ? withoutSection(file) : null));
    return { record: offRecord(), errors, wrote, missing };
  }
  // On, by the switch or by itself: every folder this device never knew the section in gets it,
  // unless its file doesn't exist yet or that would make it too long; an older one is brought up
  // to date. A folder it knew the section in and that has none now was cleared on purpose, so it
  // is left, as is one whose write the gateway refused before. Every folder that holds a marked
  // section now is recorded, so this device knows if it goes.
  const only = change.action === "auto" ? change.bot : undefined;
  for (const bots of folders.filter((group) => only === undefined || group.includes(only))) {
    if (bots.some((bot) => refused.has(bot))) continue;
    // A section seen on an earlier attempt of this change, and gone on the retry, was just
    // removed by someone: it is left, as one this device knew. By itself, so is one that another
    // of this person's devices recorded (the gateway's history); and while that history isn't
    // known, nothing is added by itself, since the section may have been removed elsewhere: it
    // is tried again at the next occasion. Turning the switch on asks for it on every bot.
    const byItself = change.action === "auto";
    let known = bots.some((bot) => keptHere(bot) || (byItself && elsewhereHere(bot)));
    const unknown = byItself && !historyKnown(bots);
    const { marked } = await each(
      bots,
      (file, found) => {
        if (found.kind !== "none") known = true;
        return found.kind === "none" && (known || unknown)
          ? null
          : addOrUpdate(true, bots)(file, found);
      },
      true,
    );
    if (marked || known)
      for (const bot of bots) {
        keep(bot);
        held.add(bot);
      }
  }
  return finish({ record: onRecord(), errors, wrote, missing });
}
