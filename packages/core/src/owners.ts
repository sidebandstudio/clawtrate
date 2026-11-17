// Every map, set and array the host keeps outside its state, with its bound:
// the client's own collections, a viewer's bridge session's, and the waiting
// files'. A test reflects over the live objects' own properties and fails for
// any collection this registry does not name, and checks each one's size
// against its `max`. `hostWorstCase` adds each entry's `max × each` to the
// part of the host's worst case it names (`row`), so the documented table is
// arithmetic over this registry. Sizes are JSON characters, as in
// `state-bounds.ts`; an entry whose values are the state's own objects counts
// only its keys, since the state already counts the objects.

import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_PENDING_ATTACHMENTS } from "./attachments.ts";
import { jsonLength, worstCase } from "./bounds.ts";
import {
  FOREIGN_RUNS_PER_SESSION,
  FOREIGN_SESSIONS,
  MAX_ACCESS_WAITERS,
  MAX_APPROVAL_OUTCOMES,
  MAX_APPROVAL_READERS,
  MAX_OUTCOME_LOOKUPS,
  MAX_SPAWN_LINKS,
  MAX_STREAMS_PER_TASK,
  MAX_TASKS_WITH_OUTBOX,
} from "./client.ts";
import { MAX_VIEWER_OPEN_TASKS } from "./bridge.ts";
import { emptyActivity } from "./runs.ts";
import {
  APPROVAL_OUTCOME,
  MAX_CREATIONS,
  MAX_FILE_NAME_CHARS,
  MAX_ID_CHARS,
  MAX_LISTED_TASKS,
  MAX_OUTBOX,
  MAX_PENDING_APPROVAL_COUNT,
  MAX_RUN_LIST,
  MAX_RUN_TEXT_CHARS,
  MAX_STEPS_PER_TASK,
  MAX_TRACKED_TASKS,
  MAX_UNROUTED,
  RUN,
  WORST_ROW_CHARS,
} from "./state-bounds.ts";

/** One collection: at most `max` entries of at most `each` JSON characters, counted in the host's `row`. */
export type Owner = {
  max: number;
  each: number;
  /** The part of `hostWorstCase` its entries are counted in; null when it keeps nothing. */
  row: string | null;
  /** Entries die with the objects they name (a WeakSet), so there is no count to keep. */
  weak?: boolean;
};

const T = MAX_TRACKED_TASKS;
const ID = MAX_ID_CHARS;
/** A number, a counter or a short flag. */
const N = 24;
/** A scope name, a resync reason, a list kind. */
const SHORT = 32;
/** A digest key (`digestKey`): three base-36 numbers. */
const DIGEST = 32;
const runWithoutSteps = worstCase(RUN, new Map([["steps", 0]]));

/** The client's own collections, by property path. */
export const CLIENT_OWNERS: Record<string, Owner> = {
  // Task list rows: only the fields read, the newest `MAX_LISTED_TASKS`.
  rows: { max: MAX_LISTED_TASKS, each: ID + WORST_ROW_CHARS, row: "sessionRows" },
  // Per followed task: keys and small values.
  openSessions: { max: T, each: ID + N, row: "bookkeeping" },
  retained: { max: T, each: ID, row: "bookkeeping" },
  incarnations: { max: T, each: ID + N, row: "bookkeeping" },
  loads: { max: T, each: ID + SHORT, row: "bookkeeping" },
  deliveries: { max: T, each: ID, row: "bookkeeping" },
  historyTimers: { max: T, each: ID, row: "bookkeeping" },
  resyncReasons: { max: T, each: ID + SHORT, row: "bookkeeping" },
  expiryTimers: { max: T, each: ID, row: "bookkeeping" },
  afterRunning: { max: T, each: ID, row: "bookkeeping" },
  afterAgain: { max: T, each: ID, row: "bookkeeping" },
  // One per task and list kind (three approval kinds and questions).
  listRequested: { max: T * 4, each: ID + SHORT + N, row: "bookkeeping" },
  listApplied: { max: T * 4, each: ID + SHORT + N, row: "bookkeeping" },
  // A run's turn limit, for each run of a followed task.
  turnTimers: { max: T * MAX_RUN_LIST, each: 2 * ID + 1, row: "bookkeeping" },
  // Streaming `chat` text: run id, task, agent and the text only.
  "streams.runs": {
    max: T * MAX_STREAMS_PER_TASK,
    each: 3 * ID + MAX_RUN_TEXT_CHARS,
    row: "streamBaselines",
  },
  // Raw payloads: their content is the table's budget; these are their keys.
  "raw.entries": { max: T * MAX_STEPS_PER_TASK, each: 3 * ID + 1 + N, row: "rawPayloads" },
  "raw.perTask": { max: T, each: ID + N, row: "rawPayloads" },
  // Sessions no viewer has open: a few runs each, without their steps; their payloads are not kept.
  foreign: {
    max: FOREIGN_SESSIONS,
    each: ID + jsonLength(emptyActivity) + FOREIGN_RUNS_PER_SESSION * (runWithoutSteps + 1),
    row: "foreignRuns",
  },
  "foreignRaw.entries": { max: 0, each: 0, row: null },
  "foreignRaw.perTask": { max: 0, each: 0, row: null },
  spawnedBy: { max: MAX_SPAWN_LINKS, each: 2 * ID, row: "spawnLinks" },
  recipients: { max: T, each: ID + 2 * MAX_STEPS_PER_TASK * ID, row: "recipientLinks" },
  approvalOutcomes: {
    max: MAX_APPROVAL_OUTCOMES,
    each: ID + worstCase(APPROVAL_OUTCOME),
    row: "approvalOutcomes",
  },
  // The same objects as the state's `unroutedApprovals`: only the keys are more.
  unrouted: { max: MAX_UNROUTED, each: ID, row: "bookkeeping" },
  lookingUp: { max: MAX_OUTCOME_LOOKUPS, each: ID, row: "bookkeeping" },
  // Whole reads of pending approvals' text: the digest given to each viewer.
  approvalReads: {
    max: T * MAX_PENDING_APPROVAL_COUNT + 1,
    each: 2 * ID + 1 + MAX_APPROVAL_READERS * DIGEST,
    row: "approvalReads",
  },
  // Creations: the same objects as the state's `creations`, and their timers, waiters and slots.
  creations: { max: MAX_CREATIONS, each: ID, row: "bookkeeping" },
  creationTimers: { max: MAX_CREATIONS, each: ID, row: "bookkeeping" },
  creationWaiters: { max: MAX_CREATIONS, each: ID, row: "bookkeeping" },
  checkingSlots: { max: MAX_CREATIONS, each: ID, row: "bookkeeping" },
  accessWaiters: { max: MAX_ACCESS_WAITERS, each: SHORT, row: "bookkeeping" },
  // Files of outgoing messages: their content is `outboxFiles`; these are the names kept beside it.
  attachmentContent: {
    max: MAX_TASKS_WITH_OUTBOX * MAX_OUTBOX,
    each: 2 * ID + MAX_ATTACHMENTS_PER_MESSAGE * 3 * MAX_FILE_NAME_CHARS,
    row: "outboxFiles",
  },
  // Viewers that went away; an entry lives only as long as the viewer's own object.
  withdrawnOwners: { max: 0, each: 0, row: null, weak: true },
};

/**
 * Properties of the client that are not its own collections: what the host
 * passed in, and the official client package's objects, which keep their own.
 */
export const CLIENT_FOREIGN: readonly string[] = ["host", "protocol", "auth", "scopeUpgrade"];

/** One viewer's bridge session, per viewer (`MAX_WEB_VIEWERS` on the web host). */
export const VIEWER_OWNERS: Record<string, Owner> = {
  open: { max: MAX_VIEWER_OPEN_TASKS, each: ID, row: "viewers" },
};
/** Properties of a viewer's session that are not its own: the client and the host's policy. */
export const VIEWER_FOREIGN: readonly string[] = ["client", "policy"];

/** The files waiting for a message (`AttachmentStore`); their content is `uploads`. */
export const ATTACHMENT_OWNERS: Record<string, Owner> = {
  entries: {
    max: MAX_PENDING_ATTACHMENTS,
    each: 2 * ID + 3 * MAX_FILE_NAME_CHARS,
    row: "uploads",
  },
  reserved: { max: MAX_PENDING_ATTACHMENTS, each: N, row: "uploads" },
};
export const ATTACHMENT_FOREIGN: readonly string[] = ["options"];

/** JSON characters each registry row adds to the host's worst case, with `viewers` bridge sessions. */
export function ownerRows(viewers: number): Record<string, number> {
  const rows: Record<string, number> = {};
  const add = (owners: Record<string, Owner>, times: number) => {
    for (const owner of Object.values(owners)) {
      if (owner.row === null) continue;
      rows[owner.row] = (rows[owner.row] ?? 0) + times * owner.max * owner.each;
    }
  };
  add(CLIENT_OWNERS, 1);
  add(VIEWER_OWNERS, viewers);
  add(ATTACHMENT_OWNERS, 1);
  return rows;
}
