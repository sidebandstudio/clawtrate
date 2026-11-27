// A turn no person asked for (the gateway's own, an automation's, another session's) that ended
// with no answer (#680). OpenClaw 2026.11.10 ends it with an error it marks not to show
// (`suppressErrorNotice: true` on its lifecycle error, its `chat` error and the task's row, beside
// `status: "failed"`). 2026.10.6 sends no such mark: it ends such a turn as a `final` with no
// message. The mark is the gateway's own, but it marks more than a quiet answer: the same end, with
// the same words, follows a turn that ended with reasoning only, or empty, or with an error the
// gateway gave no cause for. Its history tells them apart: it leaves out a row whose answer was the
// silent token, and keeps every other (`answeredNothing`). So a marked end is a quiet answer only
// once a history read asked after it, one that holds every row of the run (`historyCoversRun`), has
// found no row of it that answered nothing; until then it shows as the quiet answer it is meant to
// be, and a read refused, failed or not reaching the run's start leaves the failure.

import { answeredNothing } from "./runs.ts";
import { rowIdempotencyKey } from "./update-notice.ts";

type RawRecord = Record<string, unknown>;

const asRecord = (value: unknown): RawRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RawRecord)
    : null;

/** Tasks not followed whose row reports a marked failure: one check each, none giving way. */
export const MAX_QUIET_CHECKS = 200;
/**
 * History rows a check reads, and a read on after a task's own read didn't reach a run's start:
 * the most one page of 2026.11.10's history holds (`CHAT_HISTORY_MAX_ENTRIES`). A turn has no
 * bound of its own on the rows it writes (only 20 identical tool calls in a row stop it), so a run
 * whose start this page doesn't reach stays the failure the gateway sent.
 */
export const QUIET_CHECK_ROWS = 1000;
/** Characters of each row's text such a read asks for: what tells an answer from none is kept. */
export const QUIET_CHECK_CHARS = 200;
/** JSON characters one check can take: its key, its run's id, its connection and its verdict. */
export const quietCheckChars = (idChars: number) => 2 * idChars + 80;

/** `unread`: the read failed, so the failure stands; a later connection reads again. */
export type QuietVerdict = "pending" | "quiet" | "failed" | "unread";

type Check = { runId: string; connection: number; verdict: QuietVerdict };

/**
 * Whether a history read holds every row of the run, so that no row of it answering nothing can
 * be outside it: it reaches the transcript's start (`hasMore: false`) or the run's own input (the
 * row keyed `<runId>:user`, or by the run's id), which the gateway writes before any row of the
 * run; and it left no row out for size (`omission`, 2026.11.10's byte budget). A read that says
 * neither (a full page, `hasMore` missing) proves nothing.
 */
export function historyCoversRun(history: RawRecord | null, runId: string): boolean {
  if (!history || asRecord(history.omission)) return false;
  if (history.hasMore === false) return true;
  const rows = Array.isArray(history.messages) ? history.messages : [];
  return rows.some((entry) => {
    const row = asRecord(entry);
    const key = row ? rowIdempotencyKey(row) : null;
    return key === `${runId}:user` || key === runId;
  });
}

/** The runs among `ids` that a history read holds whole (`historyCoversRun`). */
export function coveredRuns(history: RawRecord | null, ids: ReadonlySet<string>): Set<string> {
  return new Set([...ids].filter((id) => historyCoversRun(history, id)));
}

/** Whether history holds no row of the run that answered nothing (`answeredNothing`). */
export function quietInHistory(messages: unknown, runId: string): boolean {
  const rows = Array.isArray(messages) ? messages : [];
  return !rows.some((entry) => {
    const message = asRecord(entry);
    const meta = asRecord(message?.__openclaw);
    return message !== null && meta?.runId === runId && answeredNothing(message);
  });
}

/**
 * What the gateway's history said of a task's marked failure, for a task this client does not
 * follow: by the task's key, for the run its row names. A new run of the task replaces it.
 */
export class QuietChecks {
  private readonly checks = new Map<string, Check>();

  /**
   * What the task's check said of the run, on this connection (the client's `epoch`). One still on its way
   * or unread on an earlier connection says nothing: it is read again.
   */
  verdict(key: string, runId: string, connection: number): QuietVerdict | undefined {
    const check = this.checks.get(key);
    if (check?.runId !== runId) return undefined;
    const settled = check.verdict === "quiet" || check.verdict === "failed";
    return settled || check.connection === connection ? check.verdict : undefined;
  }

  /**
   * A check begun. False when none more can be kept: then the failure stays. None gives way to
   * another: a task whose check gave way would ask again at the next publish, and that one's
   * answer would push out the next, reading history over and over (`retain` frees them).
   */
  begin(key: string, runId: string, connection: number): boolean {
    if (!this.checks.has(key) && this.checks.size >= MAX_QUIET_CHECKS) return false;
    this.checks.delete(key);
    this.checks.set(key, { runId, connection, verdict: "pending" });
    return true;
  }

  /** Keep only the checks whose task's row still reports the marked failure of the same run. */
  retain(marked: (key: string, runId: string) => boolean): void {
    for (const [key, check] of this.checks) if (!marked(key, check.runId)) this.checks.delete(key);
  }

  /** The check's verdict, if it is still the task's check begun on that connection. */
  settle(
    key: string,
    runId: string,
    connection: number,
    verdict: Exclude<QuietVerdict, "pending">,
  ): void {
    const check = this.checks.get(key);
    if (check?.runId === runId && check.connection === connection)
      this.checks.set(key, { ...check, verdict });
  }

  clear(): void {
    this.checks.clear();
  }
}
