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

import { answeredNothing, capError, type Run } from "./runs.ts";
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

/** `token`: this check's own, so an answer to an earlier check of the same run never settles it. */
type Check = { runId: string; connection: number; verdict: QuietVerdict; token: number };

/**
 * Whether a history read holds every row of the run, so that no row of it answering nothing can
 * be outside it, and left no row out for size (`omission`, 2026.11.10's byte budget). It holds
 * them when it reaches the transcript's start (`hasMore: false`); or holds the run's own input, a
 * `user` row keyed `<runId>:user` (or by the run's id), which the gateway writes before any row of
 * the run; or holds a row the gateway's run machinery wrote for another run (an `assistant` or
 * `toolResult` row with another `__openclaw.runId`) before this run started (`startedAt`, the
 * gateway's time). A session runs one turn at a time on both versions (2026.10.6's per-session
 * lane, 2026.11.10's session controller), so every row of this run was written after that one.
 * A turn the gateway starts from an event has no input of its own: its input row is keyed by the
 * event, so in a long session only that last way shows it whole. A read that says none of these
 * (a full page, `hasMore` missing, no start known) proves nothing.
 */
export function historyCoversRun(
  history: RawRecord | null,
  runId: string,
  startedAt: number | null = null,
): boolean {
  // A reply without its rows says nothing of them, `hasMore: false` or not.
  if (!history || asRecord(history.omission) || !Array.isArray(history.messages)) return false;
  if (history.hasMore === false) return true;
  const rows = history.messages;
  return rows.some((entry) => {
    const row = asRecord(entry);
    if (!row) return false;
    if (row.role === "user") {
      const key = rowIdempotencyKey(row);
      return key === `${runId}:user` || key === runId;
    }
    if (row.role !== "assistant" && row.role !== "toolResult") return false;
    const other = asRecord(row.__openclaw)?.runId;
    const at = typeof row.timestamp === "number" ? row.timestamp : null;
    return (
      startedAt !== null &&
      typeof other === "string" &&
      other !== runId &&
      at !== null &&
      at < startedAt
    );
  });
}

/**
 * A run's ids: its own, and the other id of each queue pair naming it (the send's and the
 * gateway's own, `historyQueuePairs`), as `{ gateway: client }`.
 */
export function runAliases(runId: string, pairs: Readonly<Record<string, string>>): string[] {
  return [
    runId,
    ...Object.entries(pairs).flatMap(([gateway, client]) =>
      gateway === runId ? [client] : client === runId ? [gateway] : [],
    ),
  ];
}

/**
 * The runs among `ids` that a history read holds whole (`historyCoversRun`), under any of the
 * run's ids (`runAliases`), with each one's start.
 */
export function coveredRuns(
  history: RawRecord | null,
  ids: ReadonlySet<string>,
  startOf: (runId: string) => number | null,
  pairs: Readonly<Record<string, string>> = {},
): Set<string> {
  return new Set(
    [...ids].filter((id) =>
      runAliases(id, pairs).some((each) => historyCoversRun(history, each, startOf(id))),
    ),
  );
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

const hasText = (message: RawRecord): boolean =>
  typeof message.content === "string"
    ? message.content.trim() !== ""
    : Array.isArray(message.content) &&
      message.content.some((part) => {
        const block = asRecord(part);
        return block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "";
      });

/** Whether no row of the bot's in the run has text: it answered nothing (a step is no answer). */
const answeredNoText = (messages: unknown, runId: string): boolean =>
  !(Array.isArray(messages) ? messages : []).some((entry) => {
    const message = asRecord(entry);
    return (
      message?.role === "assistant" &&
      asRecord(message.__openclaw)?.runId === runId &&
      hasText(message)
    );
  });

/**
 * The runs a history read rebuilt, the one the task's row says failed with an end the gateway
 * marked not to show failed too, when none of its rows has text (#766). OpenClaw 2026.11.10 keeps
 * such a turn (one no person asked for that ended with reasoning only, or said nothing after it) as
 * rows of reasoning that end `stopReason: "stop"`; its record of the failure is hidden
 * (`run-failed-before-reply`, `display: false`), and `chat.history` doesn't return it. So the rows
 * alone rebuild a completed run, and only the row (`lastRunId`, `lastRunError` and the mark) says
 * otherwise. The row names its latest run alone, so no other run takes its failure; a run with
 * text in any of its rows answered, and never does, nor does one with no row that answered nothing
 * (`quietInHistory`), which #680 reads as a quiet answer. Its failure has no message unless the
 * run's own is keyed (#686).
 */
export function failedByRow(
  runs: Run[],
  messages: unknown,
  row: RawRecord | undefined,
  pairs: Readonly<Record<string, string>>,
): Run[] {
  const runId = row?.suppressErrorNotice === true ? row.lastRunId : null;
  const error = typeof row?.lastRunError === "string" ? row.lastRunError.trim() : "";
  if (typeof runId !== "string" || !runId || !error) return runs;
  const ids = new Set(runAliases(runId, pairs));
  let changed = false;
  const settled = runs.map((run) => {
    if (!ids.has(run.id) || run.state !== "completed" || !run.outcomeKnown) return run;
    // A quiet answer by #680's own reading (no row of it answered nothing) is an answer too.
    if (!answeredNoText(messages, run.id) || quietInHistory(messages, run.id)) return run;
    changed = true;
    return {
      ...run,
      state: "failed" as const,
      error: { message: capError(error), kind: null, quiet: true as const },
      anchorItemId: run.anchorKeyed ? run.anchorItemId : null,
    };
  });
  return changed ? settled : runs;
}

/**
 * What the gateway's history said of a task's marked failure, for a task this client does not
 * follow: by the task's key, for the run its row names. A new run of the task replaces it.
 */
export class QuietChecks {
  private readonly checks = new Map<string, Check>();
  private tokens = 0;

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
   * A check begun: its token, which its answer settles it by. Null when none more can be kept:
   * then the failure stays. None gives way to another: a task whose check gave way would ask again
   * at the next publish, and that one's answer would push out the next, reading history over and
   * over (`retain` frees them).
   */
  begin(key: string, runId: string, connection: number): number | null {
    if (!this.checks.has(key) && this.checks.size >= MAX_QUIET_CHECKS) return null;
    this.checks.delete(key);
    this.tokens += 1;
    this.checks.set(key, { runId, connection, verdict: "pending", token: this.tokens });
    return this.tokens;
  }

  /** Keep only the checks whose task's row still reports the marked failure of the same run. */
  retain(marked: (key: string, runId: string) => boolean): void {
    for (const [key, check] of this.checks) if (!marked(key, check.runId)) this.checks.delete(key);
  }

  /**
   * The check's verdict, if it is still the task's check its token names (#770): a check let go
   * (`retain`) and begun again for the same run on the same connection is another check.
   */
  settle(key: string, token: number, verdict: Exclude<QuietVerdict, "pending">): void {
    const check = this.checks.get(key);
    if (check?.token === token) this.checks.set(key, { ...check, verdict });
  }

  clear(): void {
    this.checks.clear();
  }
}
