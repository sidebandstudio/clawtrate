// A turn no person asked for (the gateway's own, an automation's, another session's) that ended
// with no answer (#680). OpenClaw 2026.11.10 ends it with an error it marks not to show
// (`suppressErrorNotice: true` on its lifecycle error, its `chat` error and the task's row, beside
// `status: "failed"`). 2026.10.6 sends no such mark: it ends such a turn as a `final` with no
// message. The mark is the gateway's own, but it marks more than a quiet answer: the same end, with
// the same words, follows a turn that ended with reasoning only, or empty, or with an error the
// gateway gave no cause for. Its history tells them apart: it leaves out a row whose answer was the
// silent token, and keeps every other (`answeredNothing`). So a marked end is a quiet answer only
// once a history read asked after it has found no row of the run that answered nothing; until
// then it shows as the quiet answer it is meant to be, and a read refused or failed leaves the
// failure.

import { answeredNothing } from "./runs.ts";

type RawRecord = Record<string, unknown>;

const asRecord = (value: unknown): RawRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RawRecord)
    : null;

/** Tasks not followed whose row reports a marked failure: one check each, the oldest giving way. */
export const MAX_QUIET_CHECKS = 200;
/** History rows a check reads: the run that just ended is at their end. */
export const QUIET_CHECK_ROWS = 40;
/** JSON characters one check can take: its key, its run's id, its connection and its verdict. */
export const quietCheckChars = (idChars: number) => 2 * idChars + 80;

/** `unread`: the read failed, so the failure stands; a later connection reads again. */
export type QuietVerdict = "pending" | "quiet" | "failed" | "unread";

type Check = { runId: string; connection: number; verdict: QuietVerdict };

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

  /** A check begun. False when none can be kept: every one kept is still on its way. */
  begin(key: string, runId: string, connection: number): boolean {
    this.checks.delete(key);
    if (this.checks.size >= MAX_QUIET_CHECKS) {
      const settled = [...this.checks].find(([, check]) => check.verdict !== "pending");
      if (!settled) return false;
      this.checks.delete(settled[0]);
    }
    this.checks.set(key, { runId, connection, verdict: "pending" });
    return true;
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

  forget(key: string): void {
    this.checks.delete(key);
  }

  clear(): void {
    this.checks.clear();
  }
}
