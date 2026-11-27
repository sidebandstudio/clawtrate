// How a released build of version 2 reads and keeps the section, as `packages/core/src/guides.ts`
// had it at 01179ace9 (the last build before #795): its own parser and its own by-itself rule,
// copied unchanged but for `export`s and names, so a test can run that build's passes and this
// build's on one file (guides.test.ts, "two builds don't take turns"). Its records and history
// decide only whether a missing section is added, so they are left out: a section it never knew.

import { sha256Hex, utf8Bytes } from "../src/bytes.ts";
import { VOICE_GUIDE, WHERE_GUIDE } from "../src/guide-text.ts";

const GUIDES_VERSION = 2;
const GUIDES_NOTICE =
  "<!-- Added by Clawtrate, which keeps it current. Turn it off in Clawtrate: Settings, Conversation. -->";
const GUIDES_TEXT = `${VOICE_GUIDE}\n\n${WHERE_GUIDE}`;
const END = "<!-- clawtrate:guides end -->";
const BEGIN_LINE = /^<!-- clawtrate:guides begin v(\d{1,6}) sha256=([a-f0-9]{64}) -->\r?\n/m;
const END_LINE = /^<!-- clawtrate:guides end -->[ \t]*(?:\r?\n|$)/m;
/** Any line that looks like one of the markers, well formed or not. */
const ANY_MARKER = /^<!-- clawtrate:guides\b[^\n]*(?:\n|$)/gm;

const hash = (text: string) => sha256Hex(utf8Bytes(text));

/** Between the markers: the notice, then the guides. Its SHA-256 is in the first marker. */
const INNER = `${GUIDES_NOTICE}\n${GUIDES_TEXT}\n`;
/** The whole section, as Clawtrate writes it, ending with a line break. */
const GUIDES_SECTION = `<!-- clawtrate:guides begin v${GUIDES_VERSION} sha256=${hash(INNER)} -->\n${INNER}${END}\n`;
const MAX_CHANGED_SECTION_CHARS = 16_384;

/** What a file holds of Clawtrate's section: `start` and `end` bound the span it takes. */
type FoundSection =
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

function findSection(file: string): FoundSection {
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

function withSection(file: string): string {
  const found = findSection(file);
  if (found.kind === "changed" && !found.replaceable) return file;
  if (found.kind !== "none")
    return file.slice(0, found.start) + GUIDES_SECTION + file.slice(found.end);
  // A byte-order mark stays first, before the section, as findSection reads it.
  const top = file.startsWith("\uFEFF") ? 1 : 0;
  return `${file.slice(0, top)}${GUIDES_SECTION}\n${file.slice(top)}`;
}

/** Version 2's section, as that build writes it. */
export const V2_SECTION = GUIDES_SECTION;

/**
 * That build's own pass on one file (its `addOrUpdate` by itself, the length limit aside): the
 * file it writes, or null when it leaves it.
 */
export function v2Pass(file: string): string | null {
  const found = findSection(file);
  if (found.kind !== "none" && !(found.kind === "ours" && !found.current)) return null;
  const next = withSection(file);
  return next === file ? null : next;
}
