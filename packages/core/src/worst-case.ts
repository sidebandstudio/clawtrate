// The most the host can keep, as arithmetic over the named bounds: the state
// (`state-bounds.ts`), the raw table, files, the client's own maps, and what
// the web host's viewers can have queued. `docs/decisions.md` states these
// same totals, and a test checks that they agree.

import { MAX_FILE_BYTES, MAX_PENDING_ATTACHMENT_BYTES } from "./attachments.ts";
import { worstCase } from "./bounds.ts";
import {
  FOREIGN_RUNS_PER_SESSION,
  FOREIGN_SESSIONS,
  MAX_APPROVAL_OUTCOMES,
  MAX_RETAINED_ATTACHMENT_BYTES,
  MAX_SPAWN_LINKS,
} from "./client.ts";
import { MAX_RAW_BYTES, MAX_RAW_ENTRY_CHARS } from "./runs.ts";
import {
  APPROVAL_OUTCOME,
  MAX_ID_CHARS,
  MAX_LISTED_TASKS,
  MAX_RUN_TEXT_CHARS,
  MAX_STEPS_PER_TASK,
  MAX_TRACKED_TASKS,
  RUN,
  WORST_ROW_CHARS,
  WORST_STATE_CHARS,
  worstViewerChars,
} from "./state-bounds.ts";

/**
 * The most a `chat.history` response can be (OpenClaw 2026.10.6). One read of
 * each followed task can be in flight, held until it is mapped and bounded.
 */
export const GATEWAY_HISTORY_RESPONSE_BYTES = 524_288;

/** The base64 length of a file of `bytes` bytes: what the host holds once it has the file. */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** What a web host serves at most, for the socket part of the total. */
export type ViewerLimits = {
  viewers: number;
  snapshotsInFlight: number;
  openTasksPerViewer: number;
  commandsPerViewer: number;
  resultChars: number;
};

/** Each part of the host's worst case, in JSON characters (base64 characters for files). */
export function hostWorstCase(limits: ViewerLimits): Record<string, number> {
  const runWithoutSteps = worstCase(RUN, new Map([["steps", 0]]));
  const viewer = worstViewerChars(limits.openTasksPerViewer);
  return {
    state: WORST_STATE_CHARS,
    rawPayloads: MAX_RAW_BYTES + MAX_RAW_ENTRY_CHARS,
    outboxFiles: base64Length(MAX_RETAINED_ATTACHMENT_BYTES),
    uploads: base64Length(MAX_PENDING_ATTACHMENT_BYTES) + base64Length(MAX_FILE_BYTES),
    sessionRows: MAX_LISTED_TASKS * WORST_ROW_CHARS,
    foreignRuns: FOREIGN_SESSIONS * FOREIGN_RUNS_PER_SESSION * runWithoutSteps,
    approvalOutcomes: MAX_APPROVAL_OUTCOMES * worstCase(APPROVAL_OUTCOME),
    spawnLinks: MAX_SPAWN_LINKS * 2 * MAX_ID_CHARS,
    recipientLinks: MAX_TRACKED_TASKS * MAX_STEPS_PER_TASK * 2 * MAX_ID_CHARS,
    streamBaselines: MAX_TRACKED_TASKS * 2 * MAX_RUN_TEXT_CHARS,
    historyReads: MAX_TRACKED_TASKS * GATEWAY_HISTORY_RESPONSE_BYTES,
    snapshotsQueued: limits.snapshotsInFlight * viewer,
    resultsQueued: limits.viewers * limits.commandsPerViewer * limits.resultChars,
    serializing: viewer,
  };
}

export function hostWorstTotal(limits: ViewerLimits): number {
  return Object.values(hostWorstCase(limits)).reduce((sum, each) => sum + each, 0);
}
