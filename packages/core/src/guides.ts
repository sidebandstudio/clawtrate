// Clawtrate's guides in a bot's instructions (#532, #544). With the person's yes, an admin
// connection writes one marked section at the top of a bot's `AGENTS.md` (`agents.files.set`,
// held to the hash it read): how to talk to the person, and what a task is in Clawtrate. The
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
/** The guides themselves, as the person reads them before saying yes. */
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
 * - `none`: not there, and not added from this device before;
 * - `current`: this version, as Clawtrate wrote it;
 * - `older`: an earlier version, as Clawtrate wrote it; it is brought up to date by itself;
 * - `changed`: edited outside Clawtrate, by the bot or a person, or moved from the top of the
 *   file (`moved`); it is left as it is;
 * - `removed`: added from this device before, and taken out outside Clawtrate since; it is not
 *   added again without asking.
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

/** What this device keeps of the person's answer, per gateway. */
export type GuidesRecord = {
  /** The bots Clawtrate added the section to with the person's yes. */
  bots: string[];
  /** Whether bots made in Clawtrate later get it too. */
  newBots: boolean;
};

/** Where this device keeps its record for a gateway, by the gateway's identity. */
export const guidesKey = (gatewayId: string) => `clawtrate.guides.${gatewayId}`;

/** The guides as Settings shows them: read now, never assumed. */
export type BotGuides = {
  folders: GuideFolder[];
  /** This device's record of the person's answer for this gateway, or null before any. */
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
 * text, or null to leave it. A write refused because the file changed meanwhile reads it again
 * and tries once more. Answers whether anything was written.
 */
export async function changeGuideFile(
  request: Request,
  agentId: string,
  next: (file: string, found: FoundSection) => string | null,
): Promise<{ written: boolean; found: FoundSection }> {
  for (let attempt = 0; ; attempt += 1) {
    const { content, held, utf8 } = await readFile(request, agentId);
    if (!utf8)
      throw new Error(
        `${agentId}'s ${GUIDES_FILE} isn't plain UTF-8 text, so Clawtrate can't change it.`,
      );
    const found = findSection(content);
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

/** The state of each folder's file, read now; `record` tells removed from never added. */
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

/** A record as this device stored it, or null when it isn't one. */
export function parseGuidesRecord(value: string | null): GuidesRecord | null {
  if (value === null) return null;
  try {
    const raw = rec(JSON.parse(value));
    const bots = Array.isArray(raw.bots)
      ? raw.bots.filter((bot): bot is string => typeof bot === "string").slice(0, 512)
      : null;
    return bots && typeof raw.newBots === "boolean" ? { bots, newBots: raw.newBots } : null;
  } catch {
    return null;
  }
}

/**
 * What the person asked for:
 * - `add`: the section for these bots (and the bots sharing their folders), and whether new bots
 *   get it too. A section of an older version is brought up to date; a changed one is left.
 * - `replace`: this version in place of a section changed outside Clawtrate, for one bot's file.
 * - `remove`: the section out of every file it is in as Clawtrate wrote it; a changed one is
 *   left as it is.
 * - `decline`: "Not now": nothing is written, and the offer isn't made again on this device.
 * - `newBots`: whether bots made in Clawtrate from now on get it too, kept on this device only:
 *   nothing is written to the gateway, and no bot that exists is added to or updated.
 * - `update`: bring each section of an older version up to date (after a connect).
 */
export type GuidesChange =
  /** `background`: a new bot's, not the person's own Add: it never makes a file too long. */
  | { action: "add"; bots: string[]; newBots: boolean; background?: boolean }
  /** `shown`: the changed section as Settings read it (`changedText`); nothing else is replaced. */
  | { action: "replace"; bot: string; shown: string }
  | { action: "remove" }
  | { action: "decline" }
  | { action: "newBots"; on: boolean }
  | { action: "update" };

/**
 * What a change that takes a yes back leaves as this device's record, or null for a change that
 * grants one. A yes taken back is saved before anything else, so nothing is done when it can't
 * be saved; a yes given is saved last, once the files hold it.
 */
export function withdrawnRecord(
  record: GuidesRecord | null,
  change: GuidesChange,
): GuidesRecord | null {
  if (change.action === "remove") return { bots: [], newBots: false };
  if (change.action === "newBots" && !change.on)
    return { bots: record?.bots ?? [], newBots: false };
  if (change.action === "decline") return record ?? { bots: [], newBots: false };
  return null;
}

/** Said when a yes can't be taken back because this device couldn't save it: nothing was done. */
export const GUIDES_NOT_SAVED = "Couldn't save this on this device, so nothing was changed.";
/** Said when a yes was carried out on the gateway but this device couldn't record it. */
export const GUIDES_NOT_RECORDED =
  "The bots' files were changed, but this device couldn't record it, so it won't keep these sections up to date or add them to new bots.";

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
  if (change.action === "decline")
    return { record: record ?? { bots: [], newBots: false }, errors: [] };
  if (change.action === "newBots")
    return { record: { bots: record?.bots ?? [], newBots: change.on }, errors: [] };
  const folders = guideFolders(await request("agents.list", {}));
  const errors: string[] = [];
  const kept = new Set(record?.bots ?? []);
  /** Whether the file was written, or already held this version: only then is it recorded. */
  const each = async (
    bots: string[],
    next: (file: string, found: FoundSection) => string | null,
  ): Promise<boolean> => {
    try {
      const { written, found } = await changeGuideFile(request, bots[0]!, next);
      return written || (found.kind === "ours" && found.current);
    } catch (error) {
      errors.push(`${bots.join(", ")}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  /** What Clawtrate writes by itself never takes a file past the length the gateway keeps whole. */
  const fits = (next: string, background: boolean) =>
    !background || !guidesWouldBeCut(next) ? next : null;
  const addOrUpdate = (background: boolean) => (file: string, found: FoundSection) =>
    found.kind === "none" || (found.kind === "ours" && !found.current)
      ? fits(withSection(file), background)
      : null;
  if (change.action === "add") {
    const background = change.background === true;
    for (const bots of folders.filter((group) => group.some((bot) => change.bots.includes(bot))))
      if (await each(bots, addOrUpdate(background))) for (const bot of bots) kept.add(bot);
    return { record: { bots: [...kept], newBots: change.newBots }, errors };
  }
  if (change.action === "replace") {
    const bots = folders.find((group) => group.includes(change.bot));
    if (!bots) return { record, errors: [`${change.bot} isn't on the gateway's list of bots.`] };
    if (
      await each(bots, (file, found) => {
        if (found.kind !== "changed" || !found.replaceable) return null;
        // Changed again since the person was shown it: what they'd replace isn't what they saw.
        if (found.text !== change.shown)
          throw new Error(
            `${GUIDES_FILE} changed again after Settings read it, so nothing was replaced. Look at its section again before you replace it.`,
          );
        return withSection(file);
      })
    )
      for (const bot of bots) kept.add(bot);
    return { record: { bots: [...kept], newBots: record?.newBots ?? false }, errors };
  }
  for (const bots of folders)
    await each(bots, (file, found) =>
      found.kind !== "ours"
        ? null
        : change.action === "remove"
          ? withoutSection(file)
          : found.current
            ? null
            : fits(withSection(file), true),
    );
  return {
    record: change.action === "remove" ? { bots: [], newBots: false } : record,
    errors,
  };
}
