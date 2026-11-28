// Gateway skill library (`skills.library.*`, OpenClaw 2026.10.6 and 2026.11.10):
// reading the library, validating and previewing a local SKILL.md file at the
// trust boundary, importing a copy with `skills.library.save` (`operator.write`),
// and refreshing a task's pinned skill revisions with `skills.library.activate`.

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { utf8Bytes } from "./bytes.ts";
import { asRecord } from "./mapping.ts";
import type { GatewayStamp } from "./types.ts";

/** Largest SKILL.md OpenClaw accepts (`SKILL_LIBRARY_MAX_FILE_BYTES`, 1 MiB). */
export const MAX_SKILL_FILE_BYTES = 1_048_576;
/** Longest skill slug OpenClaw accepts (`^[a-z0-9][a-z0-9-]{0,62}$`). */
export const MAX_SKILL_SLUG_CHARS = 63;
/** Valid library slug pattern, matching OpenClaw's `SkillsLibrarySaveParamsSchema`. */
export const SKILL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Longest description OpenClaw's `prepareSkillLibraryBundle` accepts. */
export const MAX_SKILL_DESCRIPTION_CHARS = 1_024;
/** Preview cap on the file's front matter name. */
export const MAX_SKILL_PREVIEW_NAME_CHARS = 256;
/** Preview cap on the file's Markdown instructions body. */
export const MAX_SKILL_PREVIEW_CHARS = 4_096;
/** Most library entries kept from one `skills.library.list` answer. */
export const MAX_SKILL_LIBRARY_ENTRIES = 256;

const MAX_ENTRY_ID_CHARS = 1_024;
const MAX_ENTRY_NAME_CHARS = 256;
const MAX_SELECTION_NOTICE_CHARS = 512;

// Fields OpenClaw recovers when an unquoted value contains `: ` (`FREEFORM_TEXT_FIELDS`).
const isFreeformTextField = (key: string) =>
  key === "description" || key === "read_when" || key === "summary";
const TRAILING_YAML_COMMENT = /^(?:[ \t]+#.*)?[ \t]*$/;
const BLOCK_SCALAR_HEADER = /^([|>])(?:([1-9])([+-])?|([+-])([1-9])?)?(?:[ \t]+#.*)?$/;

const UUID_PATTERN = /^[a-f0-9-]{36}$/;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;

export type SkillLibraryEntry = {
  skillId: string;
  slug: string;
  /** Generated `/skill <name>` command identity. */
  name: string;
  description: string;
  ownerProfileId: string | null;
  ownerLabel: string;
  shared: boolean;
  enabled: boolean;
  revision: string;
  updatedAt: number | null;
  canEdit: boolean;
};

export type SkillLibraryList = {
  entries: SkillLibraryEntry[];
  profileId: string | null;
  multipleProfiles: boolean;
  truncated: boolean;
  /** Gateway notice when enabled skills exceed the default new-task selection limit (64). */
  defaultSelectionNotice: string | null;
  stamp: GatewayStamp;
};

export type SkillImportPreview = {
  name: string;
  nameCut: boolean;
  description: string;
  /** Suggested slug derived from the file's name; empty when none can be derived. */
  slug: string;
  instructions: string;
  instructionsCut: boolean;
  totalInstructionsChars: number;
  sizeBytes: number;
};

export type SkillParseResult =
  { ok: true; content: string; preview: SkillImportPreview } | { ok: false; error: string };

export type SkillLibrarySaveResult =
  | {
      outcome: "saved";
      state: string;
      target: string | null;
      nextAction: string | null;
      entry: SkillLibraryEntry;
      stamp: GatewayStamp;
    }
  | {
      outcome: "conflict";
      /** The gateway's own refusal text. */
      message: string;
      stamp: GatewayStamp;
    };

export type SkillLibraryActivateResult = {
  sessionKey: string;
  sessionActivation: string | null;
  selectionCount: number;
};

type Request = (method: string, params: unknown) => Promise<unknown>;

function cutText(value: string, max: number): { text: string; cut: boolean } {
  if (value.length <= max) return { text: value, cut: false };
  // Never split a UTF-16 surrogate pair at the boundary.
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: value.slice(0, end), cut: true };
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  return cutText(value, max).text;
}

/**
 * Decode strict UTF-8 in plain TypeScript (no platform global needed). Returns null on any
 * malformed byte sequence, overlong encoding, surrogate code point or value above U+10FFFF.
 */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  let out = "";
  let chunk = "";
  let i = 0;
  const flush = () => {
    if (chunk.length > 0) {
      out += chunk;
      chunk = "";
    }
  };
  while (i < bytes.length) {
    const b0 = bytes[i++]!;
    if (b0 < 0x80) {
      chunk += String.fromCharCode(b0);
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      if (i >= bytes.length) return null;
      const b1 = bytes[i++]!;
      if ((b1 & 0xc0) !== 0x80) return null;
      chunk += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      if (i + 1 >= bytes.length) return null;
      const b1 = bytes[i++]!;
      const b2 = bytes[i++]!;
      if (
        (b0 === 0xe0 && (b1 < 0xa0 || b1 > 0xbf)) ||
        (b0 === 0xed && (b1 < 0x80 || b1 > 0x9f)) ||
        (b0 !== 0xe0 && b0 !== 0xed && (b1 & 0xc0) !== 0x80) ||
        (b2 & 0xc0) !== 0x80
      )
        return null;
      chunk += String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      if (i + 2 >= bytes.length) return null;
      const b1 = bytes[i++]!;
      const b2 = bytes[i++]!;
      const b3 = bytes[i++]!;
      if (
        (b0 === 0xf0 && (b1 < 0x90 || b1 > 0xbf)) ||
        (b0 === 0xf4 && (b1 < 0x80 || b1 > 0x8f)) ||
        (b0 !== 0xf0 && b0 !== 0xf4 && (b1 & 0xc0) !== 0x80) ||
        (b2 & 0xc0) !== 0x80 ||
        (b3 & 0xc0) !== 0x80
      )
        return null;
      const cp =
        (((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f)) - 0x10000;
      chunk += String.fromCharCode(0xd800 | (cp >> 10), 0xdc00 | (cp & 0x3ff));
    } else {
      return null;
    }
    if (chunk.length >= 4096) flush();
  }
  flush();
  return out;
}

/** Turn a SKILL.md front matter name into a valid library slug, or "" when none can be made. */
export function deriveSkillSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SKILL_SLUG_CHARS)
    .replace(/-+$/g, "");
}

/** Plain-word problem with a library slug, or null when it matches the gateway's rule. */
export function skillSlugProblem(slug: string): string | null {
  if (slug.length === 0) return "Enter a slug for this skill.";
  if (slug.length > MAX_SKILL_SLUG_CHARS)
    return `A skill slug can be at most ${MAX_SKILL_SLUG_CHARS} characters.`;
  if (!SKILL_SLUG_PATTERN.test(slug))
    return "Use lowercase letters, numbers and hyphens, starting with a letter or number.";
  return null;
}

function unquoteYaml(
  raw: string,
  key: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const quote = raw[0];
  if (quote === "'") {
    let out = "";
    let closed = false;
    for (let i = 1; i < raw.length; i += 1) {
      const ch = raw[i]!;
      if (ch === "'") {
        if (raw[i + 1] === "'") {
          out += "'";
          i += 1;
          continue;
        }
        if (!TRAILING_YAML_COMMENT.test(raw.slice(i + 1)))
          return {
            ok: false,
            error: `SKILL.md front matter "${key}" has unexpected text after a quote.`,
          };
        closed = true;
        break;
      }
      out += ch;
    }
    if (!closed)
      return {
        ok: false,
        error: `SKILL.md front matter "${key}" has an unclosed single quote.`,
      };
    return { ok: true, value: out };
  }
  if (quote === '"') {
    if (raw.length < 2)
      return {
        ok: false,
        error: `SKILL.md front matter "${key}" has an unclosed double quote.`,
      };
    let out = "";
    let closed = false;
    for (let i = 1; i < raw.length; i += 1) {
      const ch = raw[i]!;
      if (ch === "\\") {
        if (i + 1 >= raw.length)
          return {
            ok: false,
            error: `SKILL.md front matter "${key}" has an incomplete escape sequence.`,
          };
        const next = raw[++i]!;
        if (next === "n") out += "\n";
        else if (next === "r") out += "\r";
        else if (next === "t") out += "\t";
        else if (next === '"' || next === "\\" || next === "/") out += next;
        else out += next;
      } else if (ch === '"') {
        if (!TRAILING_YAML_COMMENT.test(raw.slice(i + 1)))
          return {
            ok: false,
            error: `SKILL.md front matter "${key}" has unexpected text after a quote.`,
          };
        closed = true;
        break;
      } else {
        out += ch;
      }
    }
    if (!closed)
      return {
        ok: false,
        error: `SKILL.md front matter "${key}" has an unclosed double quote.`,
      };
    return { ok: true, value: out };
  }
  return { ok: true, value: raw };
}

function scanFlowValue(
  lines: string[],
  startIndex: number,
  initial: string,
  key: string,
): { ok: true; endIndex: number; value: string } | { ok: false; error: string } {
  const stack: string[] = [];
  const parts: string[] = [];
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex += 1) {
    const text = lineIndex === startIndex ? initial : lines[lineIndex]!;
    parts.push(text.trim());
    for (let j = 0; j < text.length; j += 1) {
      const ch = text[j]!;
      if (inSingle) {
        if (ch === "'") {
          if (text[j + 1] === "'") j += 1;
          else inSingle = false;
        }
        continue;
      }
      if (inDouble) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inDouble = false;
        }
        continue;
      }
      if (ch === "#" && (j === 0 || text[j - 1] === " " || text[j - 1] === "\t")) break;
      if (ch === "'") {
        inSingle = true;
      } else if (ch === '"') {
        inDouble = true;
      } else if (ch === "[") {
        stack.push("]");
      } else if (ch === "{") {
        stack.push("}");
      } else if (ch === "]" || ch === "}") {
        if (stack.pop() !== ch)
          return {
            ok: false,
            error: `SKILL.md front matter "${key}" has invalid YAML syntax.`,
          };
        if (stack.length === 0) {
          if (!TRAILING_YAML_COMMENT.test(text.slice(j + 1)))
            return {
              ok: false,
              error: `SKILL.md front matter "${key}" has unexpected text after a closing bracket.`,
            };
          return { ok: true, endIndex: lineIndex, value: parts.join(" ").trim() };
        }
      }
    }
    if (inSingle || inDouble || escaped)
      return {
        ok: false,
        error: `SKILL.md front matter "${key}" has an unclosed quote.`,
      };
  }
  return {
    ok: false,
    error: `SKILL.md front matter "${key}" has invalid YAML syntax.`,
  };
}

function parsePlainYamlValue(
  rest: string,
  key: string,
  allowFreeformColon: boolean,
): { ok: true; value: string } | { ok: false; error: string } {
  const plain = rest.replace(/[ \t]+#.*$/, "").trim();
  if (/^[\]},@`%*&!]/.test(plain))
    return { ok: false, error: `SKILL.md front matter "${key}" has invalid YAML syntax.` };
  if (!allowFreeformColon && /(?:^|[^\\]):(?:[ \t]|$)/.test(plain))
    return { ok: false, error: `SKILL.md front matter "${key}" has invalid YAML syntax.` };
  return { ok: true, value: plain };
}

function validateNestedYamlLines(
  nested: string[],
  parentKey: string,
): { ok: true } | { ok: false; error: string } {
  for (let idx = 0; idx < nested.length; idx += 1) {
    const raw = nested[idx]!;
    if (raw.trim() === "" || /^\s*#/.test(raw)) continue;
    if (raw.startsWith("\t"))
      return {
        ok: false,
        error: `SKILL.md front matter "${parentKey}" cannot use tabs for indentation.`,
      };
    const indent = /^([ ]+)/.exec(raw)?.[1]?.length ?? 0;
    const trimmed = raw.trim();
    const seqMatch = /^-(?:[ \t]+(.*))?$/.exec(trimmed);
    const body = seqMatch ? (seqMatch[1]?.trim() ?? "") : trimmed;
    if (body === "" || body.startsWith("#")) continue;

    const mapMatch = /^(?:([A-Za-z0-9_-]+)|"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'):[ \t]*(.*)$/.exec(
      body,
    );
    const itemKey = mapMatch
      ? `${parentKey}.${(mapMatch[1] ?? mapMatch[2] ?? mapMatch[3])!}`
      : parentKey;
    const value = mapMatch ? mapMatch[4]!.trim() : body;
    if (value === "" || value.startsWith("#")) continue;

    if (value[0] === "|" || value[0] === ">") {
      if (!BLOCK_SCALAR_HEADER.test(value))
        return {
          ok: false,
          error: `SKILL.md front matter "${itemKey}" has an invalid block scalar header.`,
        };
      while (idx + 1 < nested.length) {
        const next = nested[idx + 1]!;
        if (next.trim() === "") {
          idx += 1;
          continue;
        }
        const nextIndent = /^([ ]+)/.exec(next)?.[1]?.length ?? 0;
        if (nextIndent <= indent) break;
        idx += 1;
      }
      continue;
    }

    if (value[0] === "'" || value[0] === '"') {
      const parsed = unquoteYaml(value, itemKey);
      if (!parsed.ok) return parsed;
      continue;
    }

    if (value[0] === "[" || value[0] === "{") {
      const scanned = scanFlowValue(nested, idx, value, itemKey);
      if (!scanned.ok) return scanned;
      idx = scanned.endIndex;
      continue;
    }

    const plain = parsePlainYamlValue(value, itemKey, false);
    if (!plain.ok) return plain;
  }
  return { ok: true };
}

function parseFrontmatterBlock(
  block: string,
): { ok: true; fields: Record<string, string> } | { ok: false; error: string } {
  const fields: Record<string, string> = {};
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    // Indented lines belong to the previous key; stray leading indentation at the start is invalid.
    if (/^[ \t]/.test(line))
      return { ok: false, error: "SKILL.md front matter must be a YAML mapping of key: value." };
    const match = /^(?:([A-Za-z0-9_-]+)|"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'):[ \t]*(.*)$/.exec(
      line,
    );
    if (!match)
      return { ok: false, error: "SKILL.md front matter must be a YAML mapping of key: value." };
    const key = (match[1] ?? match[2] ?? match[3])!;
    const rest = match[4]!.trim();

    // YAML block scalar (`|`, `|-`, `|+`, `>`, `>-`, `>+`, with optional explicit indent).
    if (rest[0] === "|" || rest[0] === ">") {
      const blockHeader = BLOCK_SCALAR_HEADER.exec(rest);
      if (!blockHeader)
        return {
          ok: false,
          error: `SKILL.md front matter "${key}" has an invalid block scalar header.`,
        };
      const style = blockHeader[1]!;
      const indentStr = blockHeader[2] ?? blockHeader[5];
      const explicitIndent = indentStr ? Number(indentStr) : null;
      const chomp = blockHeader[3] ?? blockHeader[4] ?? "";
      const collected: string[] = [];
      let indent = explicitIndent;
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        if (next.trim() === "") {
          collected.push("");
          i += 1;
          continue;
        }
        const spaces = /^([ ]+)/.exec(next)?.[1]?.length ?? 0;
        if (spaces === 0) break;
        if (indent === null) indent = spaces;
        if (spaces < indent) break;
        collected.push(next.slice(indent));
        i += 1;
      }
      while (chomp === "-" && collected.length > 0 && collected[collected.length - 1] === "")
        collected.pop();
      let joined: string;
      if (style === "|") {
        joined = collected.join("\n");
      } else {
        // Folded scalar: single line breaks become spaces, blank lines stay paragraph breaks.
        joined = "";
        for (let k = 0; k < collected.length; k += 1) {
          const part = collected[k]!;
          if (k === 0) joined = part;
          else if (part === "" || collected[k - 1] === "") joined += "\n" + part;
          else joined += " " + part;
        }
      }
      fields[key] = joined.trim();
      continue;
    }

    if (rest === "" || rest.startsWith("#")) {
      // Nested mapping, sequence, or indented multi-line value.
      const nested: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        if (next.trim() === "") {
          nested.push("");
          i += 1;
          continue;
        }
        if (!/^[ \t]/.test(next)) break;
        nested.push(next);
        i += 1;
      }
      const checked = validateNestedYamlLines(nested, key);
      if (!checked.ok) return checked;
      const nonEmpty = nested.filter((entry) => entry.trim() !== "" && !/^\s*#/.test(entry));
      if (
        nonEmpty.length > 0 &&
        !nonEmpty.every((entry) => /^\s*(?:[\w-]+\s*:|-(?:\s|$))/.test(entry))
      ) {
        fields[key] = nested
          .map((entry) => entry.trim())
          .join("\n")
          .trim();
      }
      continue;
    }

    if (rest[0] === '"' || rest[0] === "'") {
      const parsed = unquoteYaml(rest, key);
      if (!parsed.ok) return parsed;
      fields[key] = parsed.value.trim();
      continue;
    }

    if (rest[0] === "[" || rest[0] === "{") {
      const scanned = scanFlowValue(lines, i, rest, key);
      if (!scanned.ok) return scanned;
      i = scanned.endIndex;
      fields[key] = scanned.value;
      continue;
    }

    const plain = parsePlainYamlValue(rest, key, isFreeformTextField(key));
    if (!plain.ok) return plain;
    fields[key] = plain.value;
  }
  return { ok: true, fields };
}

/**
 * Validate a local SKILL.md at the trust boundary: size, strict UTF-8 encoding, no null bytes,
 * valid YAML front matter with non-empty `name` and `description` (at most 1,024 characters).
 * Returns the exact decoded UTF-8 content and a bounded plain-text preview.
 */
export function parseSkillMarkdown(bytes: Uint8Array): SkillParseResult {
  if (bytes.byteLength === 0) return { ok: false, error: "This SKILL.md file is empty." };
  if (bytes.byteLength > MAX_SKILL_FILE_BYTES)
    return {
      ok: false,
      error: `SKILL.md files can be at most 1 MB (${MAX_SKILL_FILE_BYTES.toLocaleString("en-US")} bytes).`,
    };
  const decoded = decodeUtf8Strict(bytes);
  if (decoded === null) return { ok: false, error: "This file is not valid UTF-8 text." };
  if (decoded.includes("\0"))
    return { ok: false, error: "This file contains binary data and is not plain UTF-8 text." };

  const normalized = decoded
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const opening = /^---[ \t]*\n/.exec(normalized);
  if (!opening)
    return {
      ok: false,
      error: "SKILL.md must begin with YAML front matter (---) containing name and description.",
    };

  const afterOpen = normalized.slice(opening[0].length);
  const lines = afterOpen.split("\n");
  let closeIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^---[ \t]*$/.test(lines[i]!)) {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex < 0)
    return {
      ok: false,
      error: "SKILL.md front matter is missing its closing --- line.",
    };

  const block = lines.slice(0, closeIndex).join("\n");
  const parsed = parseFrontmatterBlock(block);
  if (!parsed.ok) return parsed;

  const rawName = parsed.fields.name?.trim() ?? "";
  if (!rawName) return { ok: false, error: "SKILL.md front matter requires a name." };
  const description = parsed.fields.description?.trim() ?? "";
  if (!description) return { ok: false, error: "SKILL.md front matter requires a description." };
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS)
    return {
      ok: false,
      error: `SKILL.md description can be at most ${MAX_SKILL_DESCRIPTION_CHARS.toLocaleString("en-US")} characters.`,
    };

  const body = lines
    .slice(closeIndex + 1)
    .join("\n")
    .trim();
  const boundedName = cutText(rawName, MAX_SKILL_PREVIEW_NAME_CHARS);
  const boundedBody = cutText(body, MAX_SKILL_PREVIEW_CHARS);

  return {
    ok: true,
    content: decoded,
    preview: {
      name: boundedName.text,
      nameCut: boundedName.cut,
      description,
      slug: deriveSkillSlug(rawName),
      instructions: boundedBody.text,
      instructionsCut: boundedBody.cut,
      totalInstructionsChars: body.length,
      sizeBytes: bytes.byteLength,
    },
  };
}

function parseEntry(raw: unknown): SkillLibraryEntry | null {
  const entry = asRecord(raw);
  if (!entry || entry.removed === true) return null;
  const skillId = str(entry.skillId, MAX_ENTRY_ID_CHARS);
  const slug = str(entry.slug, MAX_SKILL_SLUG_CHARS);
  const name = str(entry.name, MAX_ENTRY_NAME_CHARS);
  const description = str(entry.description, MAX_SKILL_DESCRIPTION_CHARS);
  const revision = str(entry.revision, 64);
  if (!skillId || !slug || !name || description === null || !revision) return null;
  return {
    skillId,
    slug,
    name,
    description,
    ownerProfileId:
      entry.ownerProfileId === null ? null : str(entry.ownerProfileId, MAX_ENTRY_ID_CHARS),
    ownerLabel: str(entry.ownerLabel, MAX_ENTRY_NAME_CHARS) ?? "",
    shared: entry.shared === true,
    enabled: entry.enabled !== false,
    revision,
    updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : null,
    canEdit: entry.canEdit === true,
  };
}

/** Read the gateway's skill library (`skills.library.list`, `operator.read`). */
export async function listSkillLibrary(
  request: Request,
  stamp: GatewayStamp,
): Promise<SkillLibraryList> {
  const answer = asRecord(await request("skills.library.list", { scope: "all" }));
  if (!answer || !Array.isArray(answer.entries))
    throw new Error("The gateway did not return the skill library.");
  const entries: SkillLibraryEntry[] = [];
  let truncated = false;
  for (const raw of answer.entries) {
    const parsed = parseEntry(raw);
    if (!parsed) continue;
    if (entries.length >= MAX_SKILL_LIBRARY_ENTRIES) {
      truncated = true;
      break;
    }
    entries.push(parsed);
  }
  const notice = str(answer.defaultSelectionNotice, MAX_SELECTION_NOTICE_CHARS)?.trim() ?? "";
  return {
    entries,
    profileId: str(answer.profileId, MAX_ENTRY_ID_CHARS),
    multipleProfiles: answer.multipleProfiles === true,
    truncated,
    defaultSelectionNotice: notice || null,
    stamp,
  };
}

function isSkillLibraryConflict(error: unknown): boolean {
  const details =
    error instanceof GatewayProtocolRequestError
      ? asRecord(error.details)
      : asRecord(asRecord(error)?.details);
  const code = details?.code;
  return code === "SKILL_LIBRARY_NAME_CONFLICT" || code === "SKILL_LIBRARY_CONFLICT";
}

/**
 * Save a copy of a validated SKILL.md into the gateway's personal skill library
 * (`skills.library.save`, `operator.write`, `expectedRevision: null`).
 * Returns `"saved"` only when the gateway confirms an entry, `"conflict"` with the gateway's
 * own words on a slug conflict, and rethrows any other gateway refusal in its own words.
 */
export async function saveLibrarySkill(
  request: Request,
  input: { slug: string; content: string; stamp: GatewayStamp },
): Promise<SkillLibrarySaveResult> {
  const problem = skillSlugProblem(input.slug);
  if (problem) throw new Error(problem);
  const parsed = parseSkillMarkdown(utf8Bytes(input.content));
  if (!parsed.ok) throw new Error(parsed.error);

  let raw: unknown;
  try {
    raw = await request("skills.library.save", {
      expectedRevision: null,
      slug: input.slug,
      content: input.content,
    });
  } catch (error) {
    if (isSkillLibraryConflict(error)) {
      const message = error instanceof Error ? error.message : String(error);
      return { outcome: "conflict", message, stamp: input.stamp };
    }
    throw error;
  }

  const answer = asRecord(raw);
  const entry = parseEntry(answer?.entry);
  const state = str(answer?.state, 64);
  if (!entry || !state) throw new Error("The gateway did not confirm saving the skill.");

  return {
    outcome: "saved",
    state,
    target: str(answer?.target, 64),
    nextAction: str(answer?.nextAction, 512),
    entry,
    stamp: input.stamp,
  };
}

/**
 * Refresh, attach or detach library skills for an existing task (`skills.library.activate`,
 * `operator.write`). Existing tasks keep their pinned revisions until this is called.
 */
export async function activateSkillLibrary(
  request: Request,
  input: {
    sessionKey: string;
    action: "attach" | "detach" | "refresh";
    skillId?: string;
    revision?: string;
  },
): Promise<SkillLibraryActivateResult> {
  if (input.skillId !== undefined && !UUID_PATTERN.test(input.skillId))
    throw new Error("invalid skill id");
  if (input.revision !== undefined && !REVISION_PATTERN.test(input.revision))
    throw new Error("invalid skill revision");
  const answer = asRecord(
    await request("skills.library.activate", {
      sessionKey: input.sessionKey,
      action: input.action,
      ...(input.skillId ? { skillId: input.skillId } : {}),
      ...(input.revision ? { revision: input.revision } : {}),
    }),
  );
  const sessionKey = str(answer?.sessionKey, MAX_ENTRY_ID_CHARS);
  if (!sessionKey || !Array.isArray(answer?.selections))
    throw new Error("The gateway did not confirm updating the task's skills.");
  return {
    sessionKey,
    sessionActivation: str(answer?.sessionActivation, 64),
    selectionCount: answer.selections.length,
  };
}
