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

import { sha256Hex, utf8Bytes } from "./bytes.ts";
import { VOICE_GUIDE, WHERE_GUIDE } from "./guide-text.ts";
import type { GatewayStamp } from "./types.ts";

/** The file the section goes into: the only one the gateway gives every kind of run. */
export const GUIDES_FILE = "AGENTS.md";
/**
 * The section's version. A section of a lower version is replaced by this one; one of this
 * version or a newer one, written by this or a later build, is left as it is.
 */
export const GUIDES_VERSION = 1;
/**
 * The first 16 hex digits of the SHA-256 of this version's text between the markers. A test
 * holds the text to it, so the text can't change without the version changing with it.
 */
export const GUIDES_PINNED_SHA256 = "3b11747ce00c0e53";
/**
 * Where OpenClaw 2026.10.6 starts cutting a long `AGENTS.md` out of a prompt by default
 * (`bootstrapMaxChars`). Clawtrate doesn't read the gateway's own setting, so it says "may".
 */
export const GUIDES_LONG_CHARS = 20_000;
/**
 * Whether a file may be cut from a prompt: its length without trailing whitespace, as the gateway
 * measures it, past `GUIDES_LONG_CHARS`.
 */
export const guidesWouldBeCut = (file: string) => file.trimEnd().length > GUIDES_LONG_CHARS;
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
/** What the section adds to each prompt, with the blank line after it. */
export const GUIDES_SIZE = GUIDES_SECTION.length + 1;
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
};

/** Where this device keeps its record for a gateway, by the gateway's identity. */
export const guidesKey = (gatewayId: string) => `clawtrate.guides.${gatewayId}`;

/** The guides as Settings shows them: read now, never assumed. */
export type BotGuides = {
  folders: GuideFolder[];
  /** This device's record for this gateway, or null before any: the switch reads on then. */
  record: GuidesRecord | null;
  /** The voice plugin adds its own voice guide (on, its hook permitted). */
  voicePlugin: boolean;
  /** What failed in the change this answers, one sentence per file. */
  errors: string[];
};
export type BotGuidesAnswer = BotGuides & { stamp: GatewayStamp };

export class GuideConflictError extends Error {}

/** A bot's `AGENTS.md`: its text and the hash a write is held to, or missing. */
async function readFile(
  request: Request,
  agentId: string,
): Promise<{ content: string; held: Raw; utf8: boolean }> {
  const file = rec(rec(await request("agents.files.get", { agentId, name: GUIDES_FILE })).file);
  if (file.missing === true) return { content: "", held: { expectedMissing: true }, utf8: true };
  if (typeof file.content !== "string" || !isHash(file.hash))
    throw new Error(`The gateway did not return ${agentId}'s ${GUIDES_FILE} and its revision.`);
  // The gateway hashes the bytes and decodes them as UTF-8: bytes that aren't come back as
  // U+FFFD under the bytes' hash. Written back, they would be changed for good, so such a file
  // is read (its markers are ASCII) and never written.
  return {
    content: file.content,
    held: { expectedHash: file.hash },
    utf8: hash(file.content) === file.hash.toLowerCase(),
  };
}

/** The gateway's refusal of a write held to a hash the file no longer has. */
const conflict = (error: unknown) =>
  rec(rec(error).details).type === "agent_file_conflict" ||
  (error instanceof Error && error.message.includes("agent_file_conflict"));

/**
 * Change one bot's file by `next`, read now and held to the hash read: `next` returns the new
 * text, or null to leave it. A file that isn't plain UTF-8 is never written: the change fails,
 * or with `skipNotUtf8` (Clawtrate's own changes) it is left without a word. A write refused
 * because the file changed meanwhile reads it again and tries once more. Answers whether anything
 * was written, and what the file held.
 */
export async function changeGuideFile(
  request: Request,
  agentId: string,
  next: (file: string, found: FoundSection) => string | null,
  options: { skipNotUtf8?: boolean } = {},
): Promise<{ written: boolean; found: FoundSection }> {
  for (let attempt = 0; ; attempt += 1) {
    const { content, held, utf8 } = await readFile(request, agentId);
    const found = findSection(content);
    if (!utf8 && options.skipNotUtf8) return { written: false, found };
    if (!utf8)
      throw new Error(
        `${agentId}'s ${GUIDES_FILE} isn't plain UTF-8 text, so Clawtrate can't change it.`,
      );
    const wanted = next(content, found);
    if (wanted === null || wanted === content) return { written: false, found };
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
      return { written: true, found };
    } catch (error) {
      if (attempt === 0 && conflict(error)) continue;
      if (conflict(error))
        throw new GuideConflictError(
          `${GUIDES_FILE} kept changing while Clawtrate wrote it, so it was left as it is.`,
        );
      throw error;
    }
  }
}

/** Each bot's workspace folder, as `agents.list` names it; a bot without one stands alone. */
export function guideFolders(agents: unknown): string[][] {
  const groups = new Map<string, string[]>();
  for (const agent of Array.isArray(rec(agents).agents) ? (rec(agents).agents as unknown[]) : []) {
    const id = rec(agent).id;
    if (typeof id !== "string" || id === "") continue;
    const workspace = rec(agent).workspace;
    const key = typeof workspace === "string" && workspace !== "" ? `w:${workspace}` : `b:${id}`;
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  return [...groups.values()];
}

/** The state of each folder's file, read now; `record` tells removed from never there. */
export async function readGuideFolders(
  request: Request,
  record: GuidesRecord | null,
): Promise<GuideFolder[]> {
  const folders = guideFolders(await request("agents.list", {}));
  return Promise.all(
    folders.map(async (bots): Promise<GuideFolder> => {
      try {
        const { content, utf8 } = await readFile(request, bots[0]!);
        const found = findSection(content);
        const state: GuideState =
          found.kind === "ours"
            ? found.current
              ? "current"
              : "older"
            : found.kind === "changed"
              ? "changed"
              : bots.some((bot) => record?.bots.includes(bot))
                ? "removed"
                : "none";
        return {
          bots,
          state,
          replaceable: found.kind === "changed" && found.replaceable,
          moved: found.kind === "changed" && found.moved,
          long: guidesWouldBeCut(withSection(content)),
          utf8,
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
          changedText: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

/**
 * A record as this device stored it, or null when it isn't one. A record from before the switch
 * (#542: the bots added with the person's yes, and "New bots too") reads as on when it holds any
 * yes, and as off when it holds none: "Not now", "Remove from all bots", or "New bots too" turned
 * off with nothing added. An update never turns a no into a yes.
 */
export function parseGuidesRecord(value: string | null): GuidesRecord | null {
  if (value === null) return null;
  try {
    const raw = rec(JSON.parse(value));
    const bots = Array.isArray(raw.bots)
      ? raw.bots.filter((bot): bot is string => typeof bot === "string").slice(0, 512)
      : null;
    if (!bots) return null;
    if (typeof raw.on === "boolean") return { on: raw.on, bots };
    return typeof raw.newBots === "boolean" ? { on: raw.newBots || bots.length > 0, bots } : null;
  } catch {
    return null;
  }
}

/**
 * A change to the guides:
 * - `switch`: the person's one switch. On adds the section to every bot that has none and that
 *   this device never knew it on, and brings older ones up to date, as `auto` does. Off takes it
 *   out of every file it is in as Clawtrate wrote it, and nothing is added after; a changed one
 *   is left as it is.
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
  /** `shown`: the changed section as Settings read it (`changedText`); nothing else is replaced. */
  | { action: "replace"; bot: string; shown: string }
  | { action: "auto"; bot?: string };

/** The switch as this device holds it: on until the person turns it off. */
export const guidesOn = (record: GuidesRecord | null) => record?.on ?? true;

/**
 * What a change that turns the switch off leaves as this device's record, or null for any other
 * change. Off is saved before anything else, so nothing is done when it can't be saved; it holds
 * no bots, so nothing reads as removed and nothing is added while it lasts.
 */
export function withdrawnRecord(change: GuidesChange): GuidesRecord | null {
  return change.action === "switch" && !change.on ? { on: false, bots: [] } : null;
}

/** Said when the switch can't be changed because this device couldn't save it: nothing was done. */
export const GUIDES_NOT_SAVED = "Couldn't save this on this device, so nothing was changed.";
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
): Promise<{ record: GuidesRecord | null; errors: string[] }> {
  const on = change.action === "switch" ? change.on : guidesOn(record);
  // Off wins: nothing is added or replaced while it is off, whoever asks.
  if (!on && change.action !== "switch")
    return { record, errors: change.action === "auto" ? [] : [GUIDES_OFF] };
  const folders = guideFolders(await request("agents.list", {}));
  const errors: string[] = [];
  const kept = new Set(on ? (record?.bots ?? []) : []);
  /** Change one folder's file; whether it holds Clawtrate's section, or any marked one, after. */
  const each = async (
    bots: string[],
    next: (file: string, found: FoundSection) => string | null,
    background = false,
  ): Promise<{ ours: boolean; marked: boolean }> => {
    try {
      const { written, found } = await changeGuideFile(request, bots[0]!, next, {
        skipNotUtf8: background,
      });
      const ours = written || (found.kind === "ours" && found.current);
      return { ours, marked: ours || found.kind !== "none" };
    } catch (error) {
      errors.push(`${bots.join(", ")}: ${error instanceof Error ? error.message : String(error)}`);
      return { ours: false, marked: false };
    }
  };
  /** What Clawtrate writes by itself never takes a file past the length the gateway keeps whole. */
  const fits = (next: string, background: boolean) =>
    !background || !guidesWouldBeCut(next) ? next : null;
  const addOrUpdate = (background: boolean) => (file: string, found: FoundSection) =>
    found.kind === "none" || (found.kind === "ours" && !found.current)
      ? fits(withSection(file), background)
      : null;
  if (change.action === "add" || change.action === "replace") {
    const asked = change.action === "add" ? change.bots : [change.bot];
    const chosen = folders.filter((group) => group.some((bot) => asked.includes(bot)));
    if (change.action === "replace" && chosen.length === 0)
      return { record, errors: [`${change.bot} isn't on the gateway's list of bots.`] };
    for (const bots of chosen) {
      const { ours } = await each(
        bots,
        change.action === "add"
          ? addOrUpdate(false)
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
      if (ours) for (const bot of bots) kept.add(bot);
    }
    return { record: { on: true, bots: [...kept] }, errors };
  }
  if (!on) {
    for (const bots of folders)
      await each(bots, (file, found) => (found.kind === "ours" ? withoutSection(file) : null));
    return { record: { on: false, bots: [] }, errors };
  }
  // On, by the switch or by itself: every folder this device never knew the section in gets it,
  // unless that would make the file too long; an older one is brought up to date. A folder it knew
  // the section in and that has none now was cleared on purpose, so it is left. Every folder that
  // holds a marked section now is recorded, so this device knows if it goes.
  const only = change.action === "auto" ? change.bot : undefined;
  for (const bots of folders.filter((group) => only === undefined || group.includes(only))) {
    const known = bots.some((bot) => kept.has(bot));
    const { marked } = await each(
      bots,
      (file, found) => (found.kind === "none" && known ? null : addOrUpdate(true)(file, found)),
      true,
    );
    if (marked) for (const bot of bots) kept.add(bot);
  }
  return { record: { on: true, bots: [...kept] }, errors };
}
