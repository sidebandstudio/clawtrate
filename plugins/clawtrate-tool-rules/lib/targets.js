// What a call acts on, read from its parameters only where the plugin can
// validate it, and how a rule's pattern matches it. Pure functions: no I/O.
//
//   path      a file tool's `path` (read, write, edit, ls), as a path in the
//             bot's workspace; apply_patch's paths are only hinted by the
//             host, so it is never readable
//   command   exec's `command`, as words; process carries no command
//
// A value the plugin cannot read is `null`, and a rule treats it as acting on
// everything: a Never or an Ask about some targets applies to it, an Allow
// about some targets does not cover it.

/** The kind of target each tool's rules may name, by canonical tool name. */
export const TARGET_KINDS = Object.freeze({
  read: "path",
  write: "path",
  edit: "path",
  ls: "path",
  apply_patch: "path",
  exec: "command",
  process: "command",
});

/** The longest parameter the plugin reads; anything longer is unreadable. */
export const MAX_READ_LENGTH = 4096;
const MAX_PATH_SEGMENTS = 128;

/** Keys a file tool can take its path from; more than one present is ambiguous. */
const PATH_KEYS = ["path", "file_path", "filePath", "paths", "file", "files"];
/** The host repairs these extensions before the tool runs, so such a path is not read. */
const REPAIRED_EXTENSION = /\.(doc|ppt|xls)(?:odex|codex|xodex|xcodex)$/i;
// Control characters, by code: NUL to US, and DEL.
const CONTROL = /[\u0000-\u001f\u007f]/u; // eslint-disable-line no-control-regex

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Split a slash path into its names, dropping empty and `.` names; null on `..`. */
function segmentsOf(path) {
  const out = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    out.push(segment);
  }
  return out;
}

/**
 * A file tool's path as names inside the bot's workspace, or null when it
 * cannot be read: missing, ambiguous, not text, too long, with a control
 * character, a backslash or a colon (a drive, a URL, `file:`), starting with
 * `~` or `@` (the host expands those), with `..`, absolute outside the
 * workspace, or with an extension the host would repair. `workspaceDir` is
 * the bot's workspace folder, a list of the names it goes by, or a function
 * returning either.
 */
export function readPath(params, workspaceDir) {
  if (!isPlainObject(params)) return null;
  const present = PATH_KEYS.filter((key) => Object.hasOwn(params, key));
  if (present.length !== 1 || !["path", "file_path"].includes(present[0])) return null;
  const value = params[present[0]];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_READ_LENGTH) {
    return null;
  }
  if (CONTROL.test(value) || value.includes("\\") || value.includes(":")) return null;
  if (value.startsWith("~") || value.startsWith("@") || REPAIRED_EXTENSION.test(value)) {
    return null;
  }
  let relative = value;
  if (value.startsWith("/")) {
    // The workspace is looked up only for an absolute path.
    const roots = [typeof workspaceDir === "function" ? workspaceDir() : workspaceDir]
      .flat()
      .filter((root) => typeof root === "string" && root.startsWith("/"));
    const root = roots
      .map((r) => r.replace(/\/+$/, ""))
      .find((r) => value === r || value.startsWith(`${r}/`));
    if (root === undefined) return null;
    relative = value.slice(root.length);
  }
  const segments = segmentsOf(relative);
  if (segments === null || segments.length > MAX_PATH_SEGMENTS) return null;
  return segments.join("/");
}

/** Characters a word may hold outside quotes: no expansion, redirection or control. */
const PLAIN = /[A-Za-z0-9_./:=,+@%-]/;

/**
 * exec's command as its words joined by single spaces, quotes removed, or
 * null when it cannot be read: not text, too long, more than one line, or
 * with anything the shell would expand or treat as control (`;`, `&`, `|`,
 * `$`, backquotes, redirection, globs, `~`, `#`, backslashes, parentheses),
 * an unterminated quote, a double-quoted `$`, `` ` ``, `\` or `!`, or a
 * first word that sets a variable.
 */
export function readCommand(params) {
  if (!isPlainObject(params)) return null;
  const command = params.command;
  if (typeof command !== "string" || command.length > MAX_READ_LENGTH) return null;
  const words = [];
  let word = null;
  let plainEquals = false;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (c === " " || c === "\t") {
      if (word !== null) words.push({ word, plainEquals });
      word = null;
      plainEquals = false;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      if (end === -1) return null;
      const inside = command.slice(i + 1, end);
      if (CONTROL.test(inside)) return null;
      if (c === '"' && /[$`\\!]/.test(inside)) return null;
      word = (word ?? "") + inside;
      i = end;
      continue;
    }
    if (!PLAIN.test(c)) return null;
    if (c === "=") plainEquals = true;
    word = (word ?? "") + c;
  }
  if (word !== null) words.push({ word, plainEquals });
  if (words.length === 0) return null;
  // `NAME=value cmd` runs cmd with a variable set; its first word is not the command.
  if (words[0].plainEquals) return null;
  return words.map((w) => w.word).join(" ");
}

/** What a call acts on, by its tool's kind: `{kind, value}`, value null when unreadable. */
export function readTarget(tool, params, workspaceDir) {
  const kind = TARGET_KINDS[tool];
  if (kind === "path") {
    return { kind, value: tool === "apply_patch" ? null : readPath(params, workspaceDir) };
  }
  if (kind === "command") {
    return { kind, value: tool === "process" ? null : readCommand(params) };
  }
  return null;
}

/**
 * Whether `text` matches `pattern`, where `*` matches any run of characters
 * and everything else matches itself. Linear in practice; at worst the
 * product of the two lengths.
 */
function wildcard(pattern, text) {
  let p = 0;
  let t = 0;
  let starAt = -1;
  let resumeAt = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === "*") {
      starAt = p;
      resumeAt = t;
      p += 1;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (starAt !== -1) {
      p = starAt + 1;
      resumeAt += 1;
      t = resumeAt;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/**
 * Whether a path pattern matches a workspace path: `*` within one name,
 * `**` (a whole name) across any number of names, none included, so
 * `secrets/**` matches `secrets` and everything under it.
 */
export function pathMatches(pattern, path) {
  const pat = pattern.split("/");
  const names = path === "" ? [] : path.split("/");
  // The positions in `names` reachable after each pattern name.
  let reach = new Set([0]);
  for (const part of pat) {
    const next = new Set();
    if (part === "**") {
      const from = Math.min(...reach);
      for (let j = from; j <= names.length; j += 1) next.add(j);
    } else {
      for (const j of reach) {
        if (j < names.length && wildcard(part, names[j])) next.add(j + 1);
      }
    }
    reach = next;
    if (reach.size === 0) return false;
  }
  return reach.has(names.length);
}

/** Whether a command pattern matches a command: `*` matches the rest of a word or of the line. */
export const commandMatches = (pattern, command) => wildcard(pattern, command);

/** Whether a rule's tool entry (an exact name, or `<server>__<pattern>`) covers a tool. */
export const toolMatches = (entry, tool) =>
  entry.includes("*") ? wildcard(entry, tool) : entry === tool;

/** The spaces the gateway's file tools read as an ASCII space (OpenClaw 2026.10.6, path-utils). */
const UNICODE_SPACES = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g;
const QUOTES = /[\u2018\u2019]/g;

/**
 * A path folded to one spelling for every name that can reach the same
 * file: the spellings the gateway's file tools try when the exact name is
 * missing (Unicode spaces and the narrow space before AM or PM as a plain
 * space, curly quotes as straight ones, composed and decomposed accents),
 * and those a case-insensitive filesystem treats as one (case).
 */
export const foldPath = (path) =>
  path
    .normalize("NFC")
    .replace(UNICODE_SPACES, " ")
    .replace(QUOTES, "'")
    .toLowerCase()
    .normalize("NFC");

/**
 * Whether a pattern of a kind matches a read value. `loose` (for a Never
 * and an Ask) matches a path when any spelling of it that reaches the same
 * file matches; otherwise (an Allow) only the spelling as given.
 */
export function targetMatches(kind, pattern, value, loose = false) {
  if (kind === "path") {
    return loose ? pathMatches(foldPath(pattern), foldPath(value)) : pathMatches(pattern, value);
  }
  if (kind === "command") return commandMatches(pattern, value);
  return false;
}
