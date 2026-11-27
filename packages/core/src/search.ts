// The gateway's part of the Cmd/Ctrl+K palette (docs/design/search.md): one
// request shape per source, all at `operator.read`. Each answer goes to the
// viewer that asked and nothing is kept here; the query is never logged.
//
// What each method matches, returns and leaves out is in
// docs/research/search.md.

import { cutText } from "./bounds.ts";
import { establishFolder } from "./files.ts";
import {
  asRecord,
  botIdFromSessionKey,
  generatedName,
  isPlaceholderName,
  mapSessionRow,
  type RawRecord,
} from "./mapping.ts";
import { markerTextOut, snippetWithoutMarker, titleWithoutMarker } from "./send-marker.ts";
import { MAX_ID_CHARS } from "./state-bounds.ts";
import { MAX_TASK_LABEL_CHARS } from "./task-actions.ts";

/** The gateway's limit on a query (`sessions.search`); the palette's field stops there. */
export const MAX_SEARCH_QUERY_CHARS = 4_096;
/** Matches one message search asks for: the gateway's most (research §5). */
export const MESSAGE_SEARCH_LIMIT = 25;
/** Routines asked for a page at a time (search.md §5). */
export const ROUTINE_SEARCH_PAGE = 50;
/**
 * File names kept from one bot's reply, so the largest answer fits a web
 * viewer's result frame; the gateway itself stops at 500. Past it the answer
 * says how many it returned.
 */
export const MAX_FILE_HITS = 100;
/** A snippet as shown: the gateway sends at most 500 characters (research §4). */
export const MAX_SNIPPET_CHARS = 500;
/** A routine's description as shown in a result. */
export const MAX_ROUTINE_DESCRIPTION_CHARS = 512;
/** A path as shown in a result. */
export const MAX_FILE_HIT_CHARS = 1_024;
/** Search requests the host sends at once: a message search, a routine page and two lanes of four. */
export const MAX_SEARCHES_IN_FLIGHT = 10;

type Request = (method: string, params: unknown) => Promise<unknown>;

export type MessageHit = {
  sessionKey: string;
  sessionId: string | null;
  messageId: string;
  botId: string;
  role: "user" | "assistant";
  timestamp: number | null;
  /**
   * As the gateway sent it, with no marks: the reply gives no matching ranges. A person's
   * message without the marker Clawtrate sends it with (`personSnippet`).
   */
  snippet: string;
};

export type MessageSearch = {
  hits: MessageHit[];
  /** The matched tasks' titles from the reply's `sessions` rows, by key. */
  titles: Record<string, string>;
  /** The searched index holds more matches than were returned. */
  truncated: boolean;
  /** Part of the index was still catching up. */
  indexing: boolean;
  /** Tasks whose archived transcript content was not searched. */
  archivedExcluded: number;
};

export type RoutineHit = {
  id: string;
  name: string;
  description: string;
  botId: string;
  enabled: boolean;
};

export type RoutineSearch = {
  offset: number;
  routines: RoutineHit[];
  total: number | null;
  hasMore: boolean;
  nextOffset: number | null;
  /** The revision of the list this page was cut from, when the gateway gives one. */
  revision: string | null;
};

export type FileSearch =
  | {
      status: "searched";
      botId: string;
      /** File paths only: a matching folder is not a result. At most `MAX_FILE_HITS`. */
      paths: string[];
      /** File names the gateway returned, before `MAX_FILE_HITS`. */
      returned: number;
      /** The walk stopped at its limit of 500 names or 5,000 entries. */
      truncated: boolean;
    }
  /** The bot has no listed task whose root is established as its workspace. */
  | { status: "unverified"; botId: string }
  /** The gateway returned no root for the task, so nothing was searched. */
  | { status: "no-root"; botId: string };

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
/** An id is used whole to open its result: one past the cap is dropped, never cut. */
const exactId = (value: unknown): string | null => {
  const id = str(value);
  return id !== null && id.length <= MAX_ID_CHARS ? id : null;
};

/**
 * `sessions.search` across bots, or one bot's, with the task list's own filters (search.md §5).
 * `hidden` leaves out a hit whose session the list hides, decided from the session's row as the
 * gateway sends it with the matches, or null when it sent none. `firstMessageTitle` is the title
 * the client made from a task's first message, as the task list has it, for the row's session.
 */
export async function searchMessages(
  request: Request,
  query: string,
  botId: string | null,
  hidden?: (sessionKey: string, row: RawRecord | null) => boolean,
  firstMessageTitle?: (key: string, row: RawRecord) => string | null,
): Promise<MessageSearch> {
  const reply = asRecord(
    await request("sessions.search", {
      query,
      scope: {
        excludeCron: true,
        excludeSubagents: true,
        ...(botId !== null ? { agentId: botId } : {}),
      },
      limit: MESSAGE_SEARCH_LIMIT,
    }),
  );
  const found = readMessageSearch(reply, query, firstMessageTitle);
  if (!hidden) return found;
  // The gateway sends the row of each session its matches came from (`sessions`, at most 25).
  const rows = new Map<string, RawRecord>();
  for (const raw of Array.isArray(reply?.sessions) ? reply.sessions : []) {
    const row = asRecord(raw);
    const key = exactId(row?.key);
    if (row && key) rows.set(key, row);
  }
  const hits = found.hits.filter(
    (hit) => !hidden(hit.sessionKey, rows.get(hit.sessionKey) ?? null),
  );
  const titles = Object.fromEntries(
    Object.entries(found.titles).filter(([key]) => hits.some((hit) => hit.sessionKey === key)),
  );
  return { ...found, hits, titles };
}

/**
 * A text's terms as the gateway's message index reads them, folded past both versions' folding:
 * - SQLite's `unicode61 remove_diacritics 2` (2026.10.6, and 2026.11.10's SQLite index): letters,
 *   digits, private-use characters and the 25 Latin diacritics it removes (`TERM_SPLIT`) make a
 *   term, and anything else, any other combining mark among it, parts terms.
 * - 2026.11.10's own index (`session-actor-memory-search`): a combining mark stays in its term,
 *   a Latin letter's marks are taken off, and terms compare without case.
 * Each term then loses case (both ways, so "ẞ" and "ß" and "ss" are one), its compatibility
 * forms and every mark. Two terms either index takes as one are one here too, so a query that
 * finds a person's words there finds them here. Checked for every character to U+2FFFF against
 * both; the exceptions are 21 New Tai Lue and Vedic signs, which SQLite's older tables part
 * terms at, and a Latin letter followed by the Greek iota mark.
 */
const TERM_SPLIT =
  /[\p{L}\p{N}\p{Co}\u0300-\u0304\u0306-\u030c\u030f\u0311\u031b\u0323-\u0328\u032d\u032e\u0330\u0331]+/gu;
const TERM_JOINED = /[\p{L}\p{N}\p{Co}][\p{L}\p{N}\p{Co}\p{M}]*/gu;
const folded = (term: string) =>
  term
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ς/g, "σ");
const termsOf = (text: string, pattern: RegExp) =>
  [...text.matchAll(pattern)].map((match) => folded(match[0])).filter(Boolean);

/**
 * Whether a person's words would match the query on their own, read as `sessions.search` reads
 * it on both versions: each of the query's words is a phrase of its terms, and the last term of
 * its last word matches the start of a term (`match: "prefix"`). One phrase is enough: the
 * excerpt is a window of the message, so another of the query's words may lie outside it.
 */
function wordsMatch(text: string, query: string): boolean {
  const words = query.trim().split(/\s+/u);
  let searchable = false;
  for (const pattern of [TERM_SPLIT, TERM_JOINED]) {
    const terms = termsOf(text, pattern);
    for (const [index, word] of words.entries()) {
      const phrase = termsOf(word, pattern);
      if (phrase.length === 0) continue;
      searchable = true;
      const prefix = index === words.length - 1;
      const at = (start: number) =>
        phrase.every((term, offset) => {
          const found = terms[start + offset];
          return (
            found !== undefined &&
            (prefix && offset === phrase.length - 1 ? found.startsWith(term) : found === term)
          );
        });
      for (let start = 0; start + phrase.length <= terms.length; start += 1)
        if (at(start)) return true;
    }
  }
  // A query with no term in it finds nothing the marker could have given it.
  return !searchable;
}

/**
 * The gateway indexes the model's copy of a person's message, so a message sent from Clawtrate
 * is found and shown with the marker after its words (`send-marker.ts`). The person's view is
 * their words: the marker comes off the snippet (`snippetWithoutMarker`). A hit is left out when
 * the snippet, with every exact run of the marker's own text taken out (`markerTextOut`), has no
 * match left for the query: the marker is all it showed matching. In every other case it stays.
 */
function personSnippet(snippet: string, query: string): string | null {
  const { rest, found } = markerTextOut(snippet);
  if (found && !wordsMatch(rest, query)) return null;
  return snippetWithoutMarker(snippet).text;
}

/**
 * A snippet within `MAX_SNIPPET_CHARS` as JSON writes it. The gateway's own 500 characters and
 * "…" can be more than that: one cut here ends in "…" too, so it still says it was cut.
 */
function shownSnippet(snippet: string): string {
  const shown = cutText(snippet, MAX_SNIPPET_CHARS);
  return shown === snippet ? snippet : `${cutText(snippet, MAX_SNIPPET_CHARS - 1).trimEnd()}…`;
}

export function readMessageSearch(
  reply: RawRecord | null,
  query = "",
  firstMessageTitle?: (key: string, row: RawRecord) => string | null,
): MessageSearch {
  const hits: MessageHit[] = [];
  for (const raw of Array.isArray(reply?.results) ? reply.results : []) {
    const row = asRecord(raw);
    const sessionKey = exactId(row?.sessionKey);
    const messageId = exactId(row?.messageId);
    const botId = sessionKey ? botIdFromSessionKey(sessionKey) : null;
    const role = row?.role === "user" || row?.role === "assistant" ? row.role : null;
    if (!row || !sessionKey || !messageId || !botId || !role) continue;
    const sent = typeof row.snippet === "string" ? row.snippet : "";
    const snippet = role === "user" ? personSnippet(sent, query) : sent;
    if (snippet === null) continue;
    hits.push({
      sessionKey,
      sessionId: exactId(row.sessionId),
      messageId,
      botId,
      role,
      timestamp: num(row.timestamp),
      snippet: shownSnippet(snippet),
    });
    if (hits.length === MESSAGE_SEARCH_LIMIT) break;
  }
  const titles: Record<string, string> = {};
  for (const raw of Array.isArray(reply?.sessions) ? reply.sessions : []) {
    const row = asRecord(raw);
    const key = exactId(row?.key);
    // A title the gateway made from the first message loses the marker, as the task list's does.
    // The gateway's placeholder name is no title: the task list's stands for it, the title its
    // first message makes, else the key's own (#741).
    const named = str(row?.displayName);
    // A small model's name for the task (#750) is placed as the task list places it.
    const title =
      row && key && (isPlaceholderName(row, key) || generatedName(row, key))
        ? (mapSessionRow(
            { ...row, archived: false },
            {
              // A row that leaves out its session is in its hit's.
              firstMessage:
                firstMessageTitle?.(key, {
                  ...row,
                  sessionId: row.sessionId ?? hits.find((hit) => hit.sessionKey === key)?.sessionId,
                }) ?? null,
            },
          )?.title ?? null)
        : (str(row?.label) ?? (named === null ? null : str(titleWithoutMarker(named))));
    if (key && title && hits.some((hit) => hit.sessionKey === key))
      titles[key] = cutText(title, MAX_TASK_LABEL_CHARS);
  }
  const archived = num(reply?.archivedTranscriptsExcluded);
  return {
    hits,
    titles,
    truncated: reply?.truncated === true,
    indexing: reply?.indexing === true,
    archivedExcluded: archived !== null && archived > 0 ? Math.floor(archived) : 0,
  };
}

/** One page of `cron.list`, on or off, matching the query (search.md §5). */
export async function searchRoutines(
  request: Request,
  query: string,
  offset: number,
): Promise<RoutineSearch> {
  const reply = asRecord(
    await request("cron.list", { query, enabled: "all", limit: ROUTINE_SEARCH_PAGE, offset }),
  );
  return readRoutineSearch(reply, offset);
}

export function readRoutineSearch(reply: RawRecord | null, offset: number): RoutineSearch {
  const routines: RoutineHit[] = [];
  for (const raw of Array.isArray(reply?.jobs) ? reply.jobs : []) {
    const job = asRecord(raw);
    const id = exactId(job?.id);
    // The bot as the Routines view resolves it (routines.ts), so both list the same routines.
    const botId = exactId(job?.agentId) ?? exactId(job?.effectiveAgentId) ?? "main";
    if (!job || !id) continue;
    routines.push({
      id,
      name: cutText(str(job.name) ?? id, MAX_TASK_LABEL_CHARS),
      description: cutText(str(job.description) ?? "", MAX_ROUTINE_DESCRIPTION_CHARS),
      botId,
      enabled: job.enabled !== false,
    });
    if (routines.length === ROUTINE_SEARCH_PAGE) break;
  }
  const next = num(reply?.nextOffset);
  const revision = reply?.snapshotRevision;
  return {
    offset,
    routines,
    total: num(reply?.total),
    hasMore: reply?.hasMore === true,
    nextOffset: next !== null && Number.isInteger(next) && next > offset ? next : null,
    revision:
      typeof revision === "string" || typeof revision === "number"
        ? cutText(String(revision), 128)
        : null,
  };
}

/**
 * One bot's file names (`sessions.files.list {sessionKey, search}`), through
 * `sessionKey`, the bot's newest listed task. The names are used only when that
 * task's row (`sessions.describe`) carries no folder of its own and the list
 * returned a root: then the root is the bot's workspace (search.md §5).
 */
export async function searchFiles(
  request: Request,
  query: string,
  botId: string,
  sessionKey: string | null,
): Promise<FileSearch> {
  if (sessionKey === null) return { status: "unverified", botId };
  const [listed, described] = await Promise.all([
    request("sessions.files.list", { sessionKey, search: query }),
    request("sessions.describe", { key: sessionKey }).catch(() => null),
  ]);
  const list = asRecord(listed);
  const root = str(list?.root);
  const folder = establishFolder(asRecord(asRecord(described)?.session), root);
  if (folder.kind !== "workspace") return { status: "unverified", botId };
  if (!folder.sameAsWorkspace) return { status: "no-root", botId };
  const browser = asRecord(list?.browser);
  const files: string[] = [];
  for (const raw of Array.isArray(browser?.entries) ? browser.entries : []) {
    const entry = asRecord(raw);
    const path = str(entry?.path);
    if (entry?.kind === "file" && path) files.push(cutText(path, MAX_FILE_HIT_CHARS));
  }
  return {
    status: "searched",
    botId,
    paths: files.slice(0, MAX_FILE_HITS),
    returned: files.length,
    truncated: browser?.truncated === true,
  };
}
