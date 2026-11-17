// The most the host can keep, as arithmetic over the named bounds: the state
// (`state-bounds.ts`), the raw table, files, the client's own maps, and what
// the web host's viewers can have queued. `docs/decisions.md` states these
// same totals, and a test checks that they agree.

import { MAX_FILE_BYTES, MAX_PENDING_ATTACHMENT_BYTES } from "./attachments.ts";
import { MAX_FULL_READS, MAX_RETAINED_ATTACHMENT_BYTES } from "./client.ts";
import { ownerRows } from "./owners.ts";
import { MAX_RAW_BYTES, MAX_RAW_ENTRY_CHARS } from "./runs.ts";
import { MAX_TRACKED_TASKS, WORST_STATE_CHARS, worstViewerChars } from "./state-bounds.ts";

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

/**
 * Each part of the host's worst case, in JSON characters (base64 characters
 * for files). The parts that are the host's own collections come from the
 * registry (`owners.ts`): each collection's count times the most each entry
 * holds, added to the part it names.
 */
export function hostWorstCase(limits: ViewerLimits): Record<string, number> {
  const viewer = worstViewerChars(limits.openTasksPerViewer);
  const owners = ownerRows(limits.viewers);
  const parts: Record<string, number> = {
    state: WORST_STATE_CHARS,
    rawPayloads: MAX_RAW_BYTES + MAX_RAW_ENTRY_CHARS,
    outboxFiles: base64Length(MAX_RETAINED_ATTACHMENT_BYTES),
    uploads: base64Length(MAX_PENDING_ATTACHMENT_BYTES) + base64Length(MAX_FILE_BYTES),
  };
  for (const [part, chars] of Object.entries(owners)) parts[part] = (parts[part] ?? 0) + chars;
  return {
    ...parts,
    // One history read per followed task and `MAX_FULL_READS` whole reads (`readStepRaw`,
    // `readHistoryItem`) until they are mapped and dropped, and one page's payloads rebuilt at a time.
    historyReads: (MAX_TRACKED_TASKS + MAX_FULL_READS + 1) * GATEWAY_HISTORY_RESPONSE_BYTES,
    snapshotsQueued: limits.snapshotsInFlight * viewer,
    resultsQueued: limits.viewers * limits.commandsPerViewer * limits.resultChars,
    serializing: viewer,
  };
}

export function hostWorstTotal(limits: ViewerLimits): number {
  return Object.values(hostWorstCase(limits)).reduce((sum, each) => sum + each, 0);
}
