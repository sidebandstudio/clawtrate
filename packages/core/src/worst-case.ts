// The most the host retains between events, as arithmetic over the named
// bounds: the state (`state-bounds.ts`), the raw table, files, the client's
// own collections (`owners.ts`), and what the web host's viewers can have
// queued. Lists and pages being read from the gateway are in flight, not
// retained, and their size is the gateway's: they are gated (one history read
// per task, `MAX_FULL_READS` whole reads, one listing at a time) but not
// counted here. `docs/decisions.md` states these same totals, and a test
// checks that they agree.

import { MAX_FILE_BYTES, MAX_PENDING_ATTACHMENT_BYTES } from "./attachments.ts";
import { MAX_RETAINED_ATTACHMENT_BYTES } from "./client.ts";
import { MAX_NOT_RUN_FILE_BYTES } from "./not-run.ts";
import { ownerRows } from "./owners.ts";
import { MAX_RAW_BYTES, MAX_RAW_ENTRY_CHARS } from "./runs.ts";
import { WORST_STATE_CHARS, worstViewerChars } from "./state-bounds.ts";

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
    notRunFiles: base64Length(MAX_NOT_RUN_FILE_BYTES),
    uploads: base64Length(MAX_PENDING_ATTACHMENT_BYTES) + base64Length(MAX_FILE_BYTES),
  };
  for (const [part, chars] of Object.entries(owners)) parts[part] = (parts[part] ?? 0) + chars;
  return {
    ...parts,
    snapshotsQueued: limits.snapshotsInFlight * viewer,
    resultsQueued: limits.viewers * limits.commandsPerViewer * limits.resultChars,
    serializing: viewer,
  };
}

export function hostWorstTotal(limits: ViewerLimits): number {
  return Object.values(hostWorstCase(limits)).reduce((sum, each) => sum + each, 0);
}
