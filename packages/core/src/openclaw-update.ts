// Updating OpenClaw from Clawtrate (#565). Where the gateway reports a newer
// OpenClaw (`gateway-update.ts`), a person's press, after one confirmation,
// sends `update.run` (operator.admin), bound to the gateway the screen showed.
// The gateway's own run record is then followed: its phases through the
// `update.run.changed` event, and the record itself (`update.runs.get`,
// `update.status` `activeRun`/`lastRun`) after each reconnect, since the
// gateway restarts while it updates. "Updated" is said only when the record
// says succeeded and the same gateway, reconnected, reports that version.
//
// What the gateway does (OpenClaw 2026.10.6, `src/gateway/server-methods/update.ts`):
// a global package or Git install with a service manager, or a verified
// foreground gateway, hands the update to a detached updater and answers
// `ok: true`; any other install finishes the run at once as `skipped` or
// `failed` with a reason code, and a host-owned or immutable install is
// refused with an error and no run. The run lives in the gateway's state
// database, so its id survives the restart, and every gateway process
// broadcasts its changes to admin connections. Nothing here starts a run but
// `start`, which only a person's press reaches.
//
// `update.status` is asked only for a reason: when Settings › Gateway or the
// confirmation opens, when a run is followed or kept, and when a press whose
// answer was lost must be settled. It is not a pure read (it reads the
// restart sentinel and run history through the gateway's state database, and
// may reconcile them), so it is never asked on every connect.

import { isOpenClawVersion } from "./gateway-update.ts";
import type { KeyValueStore } from "./host.ts";
import { asRecord } from "./mapping.ts";
import type { ConnectionState, GatewayStamp } from "./types.ts";
import {
  MAX_UPDATED_RUNS,
  UPDATE_RUN_ID,
  UPDATED_RUN_MAX_AGE_MS,
  type UpdatedRun,
} from "./update-notice.ts";

/** The gateway's phases, in its order (`UPDATE_RUN_PHASES`). */
export const UPDATE_PHASES = [
  "requested",
  "staging",
  "validating",
  "repairing",
  "activating",
  "restarting",
  "verifying",
  "finished",
] as const;
export type UpdatePhase = (typeof UPDATE_PHASES)[number];
const RUN_STATUSES = ["running", "succeeded", "failed", "rolled-back", "skipped"] as const;
export type UpdateRunStatus = (typeof RUN_STATUSES)[number];

const RUN_ID = UPDATE_RUN_ID;
/** The longest reason code kept, and the longest of the gateway's own sentences. */
export const MAX_UPDATE_REASON_CHARS = 128;
export const MAX_UPDATE_NOTE_CHARS = 400;
/**
 * How long a followed run's gateway may be out of reach before Clawtrate says it hasn't come
 * back. It counts only time disconnected, which begins after the drain: OpenClaw 2026.10.6 waits
 * for running work while the gateway is still connected (up to 30 minutes on Linux, 45 when the
 * press takes over the gateway's own scheduled update: `update-command-service-drain` line 19,
 * `update-run-timeouts` line 4). From the stop on, it covers the gateway's shutdown budget
 * (325 s), the swap, the restart and the verification, with a wide margin. A longer outage shows
 * "hasn't come back", which is corrected when the gateway returns. Real updates on Linux were
 * gone 71 to 150 s, far below this. One constant, to be tuned.
 */
export const UPDATE_AWAY_MS = 40 * 60_000;
/**
 * How long a followed run's gateway may be away before Clawtrate says it has been away longer
 * than an update usually takes. Real updates of global npm installs on Linux were gone 71 to
 * 150 s (`docs/research/model-catalog.md` section 7); 5 minutes is twice the longest of those.
 * A gateway started by hand can be left stopped by an update, so past this the line says so.
 */
export const UPDATE_LATE_MS = 5 * 60_000;
/** Asking the gateway about a press whose answer was lost: at once, then after these waits. */
export const UPDATE_ASK_WAITS_MS = [5_000, 15_000, 30_000, 60_000] as const;
/** While a run moves with no event, its record is read again this often, and this long at most. */
export const UPDATE_RECORD_POLL_MS = 30_000;
export const UPDATE_RECORD_POLL_LIMIT_MS = UPDATE_AWAY_MS;
/** The prefix of the tag a press sends as its requester, so its run can be told by the gateway. */
const TAG_PREFIX = "clawtrate-update:";
const TAG = /^clawtrate-update:[A-Za-z0-9._-]{8,64}$/;
/** The gateway's own channel: a requester on it is not a chat request (`isInternalMessageChannel`). */
const INTERNAL_CHANNEL = "webchat";
/** The run this device started, kept so reopening the app follows it again. */
export const UPDATE_RUN_KEY = "clawtrate.openclaw-update";
/** Gateways whose kept run or held press is remembered at once: the latest kept. */
export const MAX_KEPT_GATEWAYS = 4;
/** A kept value longer than this isn't read. */
const MAX_KEPT_CHARS = 8_192;
/**
 * The updates this device saw succeed (`UpdatedRun`), kept so the gateway's notice of each is
 * drawn as Clawtrate's line after the app is opened again: at most `MAX_UPDATED_RUNS`, none older
 * than `UPDATED_RUN_MAX_AGE_MS`. A value longer than `MAX_UPDATED_CHARS` isn't read.
 */
export const UPDATED_RUNS_KEY = "clawtrate.openclaw-updated";
const MAX_UPDATED_CHARS = 32_768;
/**
 * How long after an update this app followed to "Updated" it reads the main bot's main
 * conversation again, once: the gateway marks the run succeeded as it starts and writes its
 * notice in a startup task after that, and sends no event when it does (OpenClaw 2026.10.6,
 * `server-restart-sentinel`).
 */
export const UPDATE_NOTICE_READ_AFTER_MS = 5_000;
/**
 * When that read finds no notice yet, it is read once more this long after it (30 s after
 * "Updated"), and then not again. The gateway writes it in the same startup task that marks the
 * run succeeded, about 4 s later in a real update; a pending managed handoff retries every 2 s,
 * and a loaded host starts slower. A later notice shows the next time the conversation is read.
 */
export const UPDATE_NOTICE_READ_LAST_MS = 25_000;

/**
 * Reasons a gateway gives for not updating itself (`update.run` 2026.10.6): no button is
 * offered while the gateway that gave one runs.
 */
const CANNOT_UPDATE = new Set([
  "unmanaged-package-install",
  "container-image-install",
  "external-supervisor-update-required",
  "restart-unavailable",
  "restart-disabled",
  "not-openclaw-root",
  "immutable-native-updater-required",
  "host-owned-install",
]);

/** A run as the gateway records it, kept to what Clawtrate shows. */
export type GatewayUpdateRun = {
  runId: string;
  createdAtMs: number;
  phase: UpdatePhase;
  status: UpdateRunStatus;
  /** The gateway's reason code, cleaned. */
  reason: string | null;
  /** The gateway's own sentence: what to do next, or what rollback did. */
  note: string | null;
  before: string | null;
  after: string | null;
  target: string | null;
  /** The tag the press that started it sent (`origin.requester.senderId`), or null. */
  tag: string | null;
};

export type UpdateOutcome =
  | "running"
  | "updated"
  | "unconfirmed"
  | "failed"
  | "rolled-back"
  | "skipped"
  | "late"
  | "away"
  | "elsewhere";

/** The run Clawtrate follows, as the screens show it. */
export type UpdateRunView = {
  runId: string;
  /** The gateway it runs on (its identity): nothing about it is said on another. */
  gatewayId: string;
  /**
   * This device's press started it (true), another device, the CLI or the gateway did (false),
   * or nothing the gateway records tells which (null).
   */
  mine: boolean | null;
  from: string | null;
  to: string | null;
  phase: UpdatePhase;
  outcome: UpdateOutcome;
  reason: string | null;
  note: string | null;
  /** After a succeeded record, the version the gateway reports when it isn't the new one. */
  reported: string | null;
};

export type OpenClawUpdateState = {
  run: UpdateRunView | null;
  /** The press being sent, until the gateway answers. */
  starting: boolean;
  /** Why this gateway can't update itself, in its words: no button while it runs. */
  blocked: { reason: string; note: string | null } | null;
  /** Why the last press sent nothing, or what is not known of it. */
  error: string | null;
  /**
   * A press went out and its answer was lost: the update may be under way. No other press is
   * sent until the gateway's record settles it, on the next connection.
   */
  looking: boolean;
  /** Asking the gateway about that press failed: Check again and Stop waiting are offered. */
  lookFailed: boolean;
  /** The updates this device's own press started and saw succeed, the latest last; absent when none. */
  updated?: UpdatedRun[];
  /**
   * Connected, and what this device keeps for the gateway on screen (a run of its press, or a
   * press whose answer was lost) hasn't been read yet: Update is held until it is. Absent otherwise.
   */
  checkingKept?: true;
};

export const initialOpenClawUpdate: OpenClawUpdateState = {
  run: null,
  starting: false,
  blocked: null,
  error: null,
  looking: false,
  lookFailed: false,
};

/**
 * Whether the state holds Update: a press now would send nothing, so none is offered. Until what
 * this device keeps for the gateway is read, while a press goes out or its answer is sought, and
 * while a run is under way.
 */
export function holdsUpdate(state: OpenClawUpdateState): boolean {
  const outcome = state.run?.outcome;
  return (
    state.checkingKept === true ||
    state.starting ||
    state.looking ||
    outcome === "running" ||
    outcome === "late" ||
    outcome === "away"
  );
}

/** Text the gateway wrote, as Clawtrate shows it: one line, no control characters, bounded. */
export function updateText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const line = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return null;
  if (line.length <= max) return line;
  // Cut by whole characters to within `max` UTF-16 units, the way the state's bounds count.
  let cut = "";
  for (const char of line) {
    if (cut.length + char.length > max - 1) break;
    cut += char;
  }
  return `${cut}…`;
}

const versionOf = (value: unknown) => {
  const version = asRecord(value)?.version;
  return typeof version === "string" && isOpenClawVersion(version) ? version : null;
};
const oneOf = <T extends string>(value: unknown, options: readonly T[]) =>
  options.includes(value as T) ? (value as T) : null;

/** A run record from `update.runs.get`, `update.status` or an `update.run` answer, or null. */
export function readUpdateRun(value: unknown): GatewayUpdateRun | null {
  const run = asRecord(value);
  const runId = run?.runId;
  const phase = oneOf(run?.phase, UPDATE_PHASES);
  const status = oneOf(run?.status, RUN_STATUSES);
  if (typeof runId !== "string" || !RUN_ID.test(runId) || !phase || !status) return null;
  const origin = asRecord(run?.origin);
  const rollback = asRecord(asRecord(run?.verification)?.rollbackOutcome);
  const created = run?.createdAtMs;
  return {
    runId,
    createdAtMs: typeof created === "number" && Number.isSafeInteger(created) ? created : 0,
    phase,
    status,
    reason: updateText(run?.reason, MAX_UPDATE_REASON_CHARS),
    note:
      updateText(origin?.nextAction, MAX_UPDATE_NOTE_CHARS) ??
      (status === "rolled-back" || status === "failed"
        ? updateText(rollback?.reason, MAX_UPDATE_NOTE_CHARS)
        : null),
    before: versionOf(run?.before),
    after: versionOf(run?.after),
    target: versionOf(run?.target),
    tag: (() => {
      const requester = asRecord(origin?.requester);
      const tag = requester?.senderId;
      return requester?.channel === INTERNAL_CHANNEL && typeof tag === "string" && TAG.test(tag)
        ? tag
        : null;
    })(),
  };
}

/** `update.run.changed`: `{runId, phase, status}`, or null. */
export function readRunChanged(
  value: unknown,
): { runId: string; phase: UpdatePhase; status: UpdateRunStatus } | null {
  const event = asRecord(value);
  const phase = oneOf(event?.phase, UPDATE_PHASES);
  const status = oneOf(event?.status, RUN_STATUSES);
  const runId = event?.runId;
  if (typeof runId !== "string" || !RUN_ID.test(runId) || !phase || !status) return null;
  return { runId, phase, status };
}

/** Whether a finished run says the gateway can't update itself. */
const cannotUpdate = (run: GatewayUpdateRun) =>
  run.status !== "running" && run.reason !== null && CANNOT_UPDATE.has(run.reason);

/** Outcomes that are final: nothing the gateway sends later changes them. */
const SETTLED = new Set<UpdateOutcome>([
  "updated",
  "failed",
  "rolled-back",
  "skipped",
  "elsewhere",
]);
const isSettled = (run: UpdateRunView | null) => run !== null && SETTLED.has(run.outcome);

/** The run this device started, or a press whose answer was lost (`tag`, with no run id). */
type Kept = {
  gatewayId: string;
  runId: string | null;
  tag: string | null;
  from: string | null;
  to: string | null;
};

function readKeptEntry(value: unknown): Kept | null {
  const kept = asRecord(value);
  const gatewayId = kept?.gatewayId;
  if (typeof gatewayId !== "string" || !gatewayId || gatewayId.length > 1_024) return null;
  const runId = typeof kept?.runId === "string" && RUN_ID.test(kept.runId) ? kept.runId : null;
  const tag = typeof kept?.tag === "string" && TAG.test(kept.tag) ? kept.tag : null;
  if (runId === null && tag === null) return null;
  const version = (each: unknown) =>
    typeof each === "string" && isOpenClawVersion(each) ? each : null;
  return { gatewayId, runId, tag, from: version(kept?.from), to: version(kept?.to) };
}

/** The updates kept as seen to succeed, read field by field: the latest last, none too old. */
function readUpdated(raw: string | null, now: number): UpdatedRun[] {
  if (raw === null || raw.length > MAX_UPDATED_CHARS) return [];
  try {
    const list = asRecord(JSON.parse(raw))?.runs;
    if (!Array.isArray(list)) return [];
    const runs: UpdatedRun[] = [];
    for (const each of list.slice(-MAX_UPDATED_RUNS)) {
      const { gatewayId, runId, to, at } = asRecord(each) ?? {};
      if (
        typeof gatewayId === "string" &&
        gatewayId &&
        gatewayId.length <= 1_024 &&
        typeof runId === "string" &&
        RUN_ID.test(runId) &&
        typeof to === "string" &&
        isOpenClawVersion(to) &&
        typeof at === "number" &&
        Number.isSafeInteger(at) &&
        now - at <= UPDATED_RUN_MAX_AGE_MS
      )
        runs.push({ gatewayId, runId, to, at });
    }
    return runs;
  } catch {
    return [];
  }
}

/** `lists` as one, the later of each pair kept, none too old, the latest `MAX_UPDATED_RUNS`. */
function mergeUpdated(now: number, ...lists: readonly UpdatedRun[][]): UpdatedRun[] {
  const merged: UpdatedRun[] = [];
  for (const each of lists.flat()) {
    if (now - each.at > UPDATED_RUN_MAX_AGE_MS) continue;
    const at = merged.findIndex(
      (other) => other.gatewayId === each.gatewayId && other.runId === each.runId,
    );
    if (at >= 0) merged.splice(at, 1);
    merged.push(each);
  }
  return merged.slice(-MAX_UPDATED_RUNS);
}

/** What is kept, one entry per gateway (its identity), the latest last, at most `MAX_KEPT_GATEWAYS`. */
function readKept(raw: string | null): Kept[] {
  if (raw === null || raw.length > MAX_KEPT_CHARS) return [];
  try {
    const list = asRecord(JSON.parse(raw))?.gateways;
    if (!Array.isArray(list)) return [];
    const kept: Kept[] = [];
    for (const each of list.slice(-MAX_KEPT_GATEWAYS)) {
      const entry = readKeptEntry(each);
      if (entry && !kept.some((other) => other.gatewayId === entry.gatewayId)) kept.push(entry);
    }
    return kept;
  } catch {
    return [];
  }
}

export type OpenClawUpdatesContext = {
  /** A request on the connection open now; `onSent` is called once it has gone out. */
  request: (method: string, params: unknown, onSent?: () => void) => Promise<unknown>;
  connection: () => ConnectionState;
  /** Connected with `operator.admin`, on a host that writes. */
  admin: () => boolean;
  /** The connected gateway's identity, read on this connection, or null. */
  identity: () => Promise<string | null>;
  /** Refuse unless `stamp` is still the gateway connected now (`requireSameGateway`). */
  sameGateway: (stamp: GatewayStamp) => Promise<void>;
  /** When the connected gateway process started, from its hello, or null. */
  startedAt: () => number | null;
  /** Whether an error is the gateway's answer (sent and refused), not a failure to send. */
  answered: (error: unknown) => boolean;
  /** The reason code a gateway's refusal carries (`details.reason`), or null. */
  refusalReason: (error: unknown) => string | null;
  /** Whether an error is the gateway refusing for a missing scope (and note it). */
  missingScope: (error: unknown) => boolean;
  /** The model list, read again the way the app reads it on connect. */
  refreshModels: () => Promise<void>;
  /**
   * Read the main bot's main conversation on gateway `gatewayId` again, if it is open: true when
   * the gateway's notice of run `runId` is in it then, false when it isn't, null when nothing was
   * read.
   */
  readMainAgain: (gatewayId: string, runId: string) => Promise<boolean | null>;
  /** A new tag for one press. */
  newTag: () => string;
  now: () => number;
  storage: KeyValueStore;
  get: () => OpenClawUpdateState | undefined;
  set: (state: OpenClawUpdateState) => void;
  /** Call `run` after `ms`; the answer cancels it. */
  later: (run: () => void, ms: number) => () => void;
  log: (text: string) => void;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const UPDATE_NOT_SENT = "The connection changed, so nothing was sent.";
export const UPDATE_NOT_STARTED =
  "The gateway's update history has nothing from that press. You can try again; if an update is running, the gateway says so.";
export const UPDATE_UNTIED =
  "An update is running on the gateway, and Clawtrate can't tell whether it came from your last Update press.";
export const UPDATE_KEPT_CHECKING =
  "An update from your last Update press may still be running. Clawtrate is asking the gateway how it's going.";
export const UPDATE_KEPT_LOOK_FAILED =
  "An update from your last Update press may still be running, and Clawtrate couldn't ask the gateway how it's going.";
export const UPDATE_SENT_UNKNOWN =
  "Clawtrate didn't get the gateway's answer to the last Update press. It's checking whether the update started.";
export const UPDATE_LOOK_FAILED =
  "Clawtrate didn't get the gateway's answer to the last Update press, and couldn't ask it whether the update started.";
export const UPDATE_HELD = "An update may be under way from the last Update press.";

/**
 * What holds Update until the gateway's record settles it: a press whose answer was lost (its
 * tag), or a run this device started and kept from before the app was opened (its id).
 */
type Look = {
  gatewayId: string;
  tag: string | null;
  runId: string | null;
  from: string | null;
  to: string | null;
};
const lookOf = (kept: Kept): Look => ({ ...kept });

export class OpenClawUpdates {
  /** Moves on with each hello and each reset: an answer read before it changes nothing. */
  private epoch = 0;
  /** Moves on with each reset (another gateway, or none): a press begun before it writes nothing. */
  private resets = 0;
  private cancelAway: (() => void) | null = null;
  private cancelLate: (() => void) | null = null;
  private cancelAsk: (() => void) | null = null;
  private cancelPoll: (() => void) | null = null;
  /** What holds Update, until the gateway's record settles it. */
  private lookFor: Look | null = null;
  /** A held press the person stopped waiting on: a run carrying its tag is still theirs. */
  private released: Look | null = null;
  /** Writes of what is kept, one after another, each from the value the one before left. */
  private keeping: Promise<void> = Promise.resolve();
  /** The gateway refused a press with no run, as an install it can't update: kept until a reset. */
  private refused: { reason: string; note: string | null } | null = null;
  /** The status read under way on this connection, joined by any other ask on it. */
  private asking: { epoch: number; done: Promise<void> } | null = null;
  /** How many asks about a held press have failed in a row. */
  private askFailures = 0;
  /** The run whose record is being read, so repeated events read it once. */
  private reading: string | null = null;
  /** When the followed run last moved (an event or a record that changed it). */
  private movedAt = 0;
  private readonly ctx: OpenClawUpdatesContext;

  constructor(ctx: OpenClawUpdatesContext) {
    this.ctx = ctx;
  }

  private get state(): OpenClawUpdateState {
    return this.ctx.get() ?? initialOpenClawUpdate;
  }

  private patch(patch: Partial<OpenClawUpdateState>): void {
    this.ctx.set({ ...this.state, ...patch });
  }

  private patchRun(runId: string, patch: Partial<UpdateRunView>): void {
    const run = this.state.run;
    if (run?.runId === runId) this.patch({ run: { ...run, ...patch } });
  }

  /** The hold, shown and kept in memory, in words true of what holds it. */
  private hold(look: Look, failed = false): void {
    if (this.lookFor?.tag !== look.tag || this.lookFor?.runId !== look.runId) this.askFailures = 0;
    this.lookFor = look;
    const kept = look.runId !== null;
    this.patch({
      looking: true,
      lookFailed: failed,
      error: kept
        ? failed
          ? UPDATE_KEPT_LOOK_FAILED
          : UPDATE_KEPT_CHECKING
        : failed
          ? UPDATE_LOOK_FAILED
          : UPDATE_SENT_UNKNOWN,
    });
  }

  /**
   * The person's press, after the confirmation: one `update.run`, only to the gateway the
   * screen showed (`stamp`), on the connection that checked it, and only while that gateway
   * reports a newer OpenClaw, can update itself, runs no update and holds no earlier press.
   */
  async start(stamp: GatewayStamp): Promise<void> {
    const state = this.state;
    if (
      state.starting ||
      state.looking ||
      state.run?.outcome === "running" ||
      state.run?.outcome === "late" ||
      state.run?.outcome === "away"
    )
      throw new Error("An update is already under way.");
    if (!this.ctx.admin()) throw new Error("Updating OpenClaw needs admin access.");
    if (state.blocked) throw new Error("This gateway can't update itself, so nothing was sent.");
    const offer = this.ctx.connection().openclawUpdate;
    if (!offer)
      throw new Error("The gateway doesn't report a newer OpenClaw now, so nothing was sent.");
    const epoch = this.epoch;
    const resets = this.resets;
    // Still the gateway it was pressed for: after a reset, nothing here writes anything.
    const current = () => resets === this.resets;
    this.patch({ starting: true, error: null });
    const tag = `${TAG_PREFIX}${this.ctx.newTag()}`;
    let sent = false;
    let answer: unknown;
    try {
      // Anything kept for this gateway (a run of an earlier press, or a press whose answer was
      // lost) holds this one until the gateway's record settles it: never a second update.run,
      // and the kept record is never overwritten by a new press.
      const kept = await this.keptFor(stamp.gatewayId);
      if (current() && kept) {
        this.hold(lookOf(kept));
        void this.look();
        throw new Error(UPDATE_HELD);
      }
      await this.ctx.sameGateway(stamp);
      // Another hello or a reset since the check: nothing goes.
      if (epoch !== this.epoch) throw new Error(UPDATE_NOT_SENT);
      // As things are now, with no wait between this look and the send.
      const now = this.state;
      if (
        now.looking ||
        now.run?.outcome === "running" ||
        now.run?.outcome === "late" ||
        now.run?.outcome === "away" ||
        now.blocked
      )
        throw new Error("An update is already under way.");
      if (!this.ctx.connection().openclawUpdate)
        throw new Error("The gateway doesn't report a newer OpenClaw now, so nothing was sent.");
      // The tag is the gateway's own record of this press: on its internal channel it is kept
      // as the run's requester and is not a chat request (`update.run`, 2026.10.6).
      answer = await this.ctx.request(
        "update.run",
        { requester: { channel: INTERNAL_CHANNEL, senderId: tag } },
        () => {
          sent = true;
        },
      );
    } catch (error) {
      if (!current()) throw error;
      this.patch({ starting: false });
      if (sent && !this.ctx.answered(error)) {
        // It may have started: held, and kept, until the gateway's record settles it.
        await this.lose({ gatewayId: stamp.gatewayId!, tag }, offer);
        throw new Error(UPDATE_SENT_UNKNOWN, { cause: error });
      }
      if (sent && this.ctx.missingScope(error)) {
        const words = "The gateway refused: updating OpenClaw needs admin access.";
        this.patch({ error: words });
        throw new Error(words, { cause: error });
      }
      if (errorText(error) === UPDATE_HELD) throw error;
      const note = updateText(errorText(error), MAX_UPDATE_NOTE_CHARS);
      const reason = sent ? this.ctx.refusalReason(error) : null;
      if (reason !== null && CANNOT_UPDATE.has(reason)) {
        // Refused with no run: a host-owned or immutable install, in the gateway's words.
        this.refused = { reason, note };
        this.patch({ blocked: this.refused, error: null });
        throw new Error(note ?? "The gateway refused the update.", { cause: error });
      }
      this.patch({ error: note });
      throw error;
    }
    if (!current()) return;
    this.patch({ starting: false });
    const reply = asRecord(answer);
    const runId = reply?.runId;
    const gatewayId = stamp.gatewayId!;
    if (typeof runId !== "string" || !RUN_ID.test(runId)) {
      // An answer that names no run: settled by asking, by the press's tag.
      await this.lose({ gatewayId, tag }, offer);
      return;
    }
    const view: UpdateRunView = {
      runId,
      gatewayId,
      mine: true,
      from: offer.current,
      to: offer.latest,
      phase: "requested",
      outcome: "running",
      reason: null,
      note: null,
      reported: null,
    };
    this.patch({ run: view });
    this.movedAt = this.ctx.now();
    await this.keep(view);
    if (!current()) return;
    const handoff = asRecord(reply?.handoff)?.status === "started";
    if (reply?.ok === true && handoff) {
      // Handed to the updater: its events come, and its record is read when they don't.
      this.pollRecord(runId);
      return;
    }
    // Finished at once, or owned by the gateway's update manager, which sends no events: its
    // record says where it stands, or its answer does.
    const note = updateText(reply?.message, MAX_UPDATE_NOTE_CHARS);
    if (note) this.patchRun(runId, { note });
    const record = await this.readRun(runId).catch(() => null);
    if (!current()) return;
    if (record) {
      await this.apply(record, this.epoch);
      if (this.state.run?.runId === runId && this.state.run.outcome === "running")
        this.pollRecord(runId);
      return;
    }
    if (reply?.ok === true) {
      this.pollRecord(runId);
      return;
    }
    const result = asRecord(reply?.result);
    const reason = updateText(result?.reason, MAX_UPDATE_REASON_CHARS);
    this.patchRun(runId, {
      phase: "finished",
      outcome: result?.status === "skipped" ? "skipped" : "failed",
      reason,
      note,
    });
    await this.forget(gatewayId, runId);
    if (reason && CANNOT_UPDATE.has(reason)) this.patch({ blocked: { reason, note } });
  }

  /** The person put the finished run's line away. Nothing is sent. */
  async dismiss(): Promise<void> {
    const run = this.state.run;
    if (!run || run.outcome === "running" || run.outcome === "late" || run.outcome === "away")
      return;
    this.patch({ run: null, error: null });
    await this.forget(run.gatewayId, run.runId);
  }

  /**
   * Stop waiting, by the person's own choice, once asking the gateway has failed: Update is
   * offered again. If an update is running there, the gateway says so instead of starting
   * another (`managed-service-handoff-already-running`). What held it is remembered for this
   * session, so a run that carries its tag, or is its run, is still shown as theirs.
   */
  async release(): Promise<void> {
    const look = this.lookFor;
    if (!look || !this.state.looking || !this.state.lookFailed) return;
    this.cancelAsk?.();
    this.cancelAsk = null;
    this.lookFor = null;
    this.released = look;
    this.patch({ looking: false, lookFailed: false, error: null });
    await this.forget(look.gatewayId, look.runId);
  }

  /** `update.run.changed`, sent to admin connections while a run moves. */
  onRunChanged(payload: unknown): void {
    const event = readRunChanged(payload);
    if (!event) return;
    const run = this.state.run;
    if (run?.runId === event.runId) {
      // Settled: a repeat of the end, or a late step, changes nothing and reads nothing.
      if (isSettled(run) || run.outcome === "unconfirmed") return;
      this.movedAt = this.ctx.now();
      if (event.status === "running") {
        if (run.phase !== event.phase || run.outcome !== "running")
          this.patchRun(event.runId, { phase: event.phase, outcome: "running" });
        return;
      }
      void this.settle(event.runId);
      return;
    }
    if (event.status !== "running") return;
    // Something held, or let go of: whose run this is, the gateway's record says. Asked, not
    // guessed, so the person's own run is never shown as started elsewhere.
    if (this.lookFor || this.released) {
      void this.look();
      return;
    }
    // Another run, while none is running here: started on another device, by the CLI or by
    // the gateway's own schedule. Shown, so no second one is offered.
    if (run?.outcome === "running" || run?.outcome === "late" || run?.outcome === "away") return;
    const connection = this.ctx.connection();
    const gatewayId = connection.gatewayId;
    if (!gatewayId) return;
    this.movedAt = this.ctx.now();
    this.patch({
      run: {
        runId: event.runId,
        gatewayId,
        mine: false,
        from: connection.serverVersion,
        to: connection.openclawUpdate?.latest ?? null,
        phase: event.phase,
        outcome: "running",
        reason: null,
        note: null,
        reported: null,
      },
    });
    void this.settle(event.runId);
  }

  /**
   * The hello has come: until `onHello` has read what this device keeps for the gateway on
   * screen, Update is held, so the connection, its offer and admin access never show it offered
   * before that is known. Called as the connection is published, before any answer.
   */
  onConnected(): void {
    if (this.state.checkingKept !== true) this.patch({ checkingKept: true });
  }

  /** What is kept is known: the hold `onConnected` set ends, and what is kept holds instead. */
  private keptKnown(): void {
    const { checkingKept, ...rest } = this.state;
    if (checkingKept) this.ctx.set(rest);
  }

  /**
   * Connected (a reconnect after the restart, or reopening the app). Update is held from the
   * hello (`onConnected`) until what is kept for this gateway has been read, and then by what is
   * kept, before any answer; the gateway is asked only when there is something to settle.
   */
  async onHello(): Promise<void> {
    const epoch = ++this.epoch;
    this.cancelAway?.();
    this.cancelAway = null;
    this.cancelLate?.();
    this.cancelLate = null;
    // The updates seen to succeed, on every hello: the client starts from a fresh state for
    // another gateway or none, and the oldest age out.
    const raw = await this.ctx.storage.get(UPDATED_RUNS_KEY).catch(() => null);
    if (epoch !== this.epoch) return;
    const updated = mergeUpdated(
      this.ctx.now(),
      readUpdated(raw, this.ctx.now()),
      this.state.updated ?? [],
    );
    if (updated.length > 0 || this.state.updated) {
      if (updated.length > 0) this.patch({ updated });
      else {
        const { updated: _gone, ...rest } = this.state;
        this.ctx.set(rest);
      }
    }
    if (!this.ctx.admin()) {
      this.keptKnown();
      return;
    }
    const kept = readKept(await this.ctx.storage.get(UPDATE_RUN_KEY).catch(() => null));
    if (epoch !== this.epoch) return;
    // Held for the gateway the connection already names, before its identity is read.
    const named = this.ctx.connection().gatewayId;
    const early = kept.find((each) => each.gatewayId === named) ?? null;
    if (early && !this.lookFor && !this.following(early)) this.hold(lookOf(early));
    this.keptKnown();
    const id = await this.ctx.identity();
    if (epoch !== this.epoch || id === null) return;
    const run = this.state.run;
    if (run && run.gatewayId !== id) {
      // The address answers as another gateway: nothing about that one's version is said.
      if (run.outcome !== "elsewhere")
        this.patchRun(run.runId, {
          outcome: "elsewhere",
          from: null,
          to: null,
          reported: null,
          reason: null,
          note: null,
        });
    }
    if (this.lookFor && this.lookFor.gatewayId !== id) {
      // Another gateway: the hold isn't this one's. It stays kept for the gateway it went to.
      this.lookFor = null;
      this.cancelAsk?.();
      this.cancelAsk = null;
      this.patch({ looking: false, lookFailed: false, error: null });
    }
    if (this.released && this.released.gatewayId !== id) this.released = null;
    const mineKept = kept.find((each) => each.gatewayId === id) ?? null;
    if (mineKept && !this.lookFor && !this.following(mineKept)) this.hold(lookOf(mineKept));
    const followed = run && run.gatewayId === id && !isSettled(run) ? run : null;
    if (this.lookFor || followed) await this.look();
  }

  /** Whether `kept` is the run already followed here (so nothing more needs holding). */
  private following(kept: Kept): boolean {
    const run = this.state.run;
    return kept.runId !== null && run?.runId === kept.runId && run.gatewayId === kept.gatewayId;
  }

  /**
   * Ask the gateway (`update.status`) on the connection that is there: whether it can update
   * itself, the run under way, and how what holds Update has ended. Asked when Settings ›
   * Gateway or the confirmation opens, on Check again, and when something waits to be settled.
   * Asks under way on this connection are joined.
   */
  look(): Promise<void> {
    if (this.asking?.epoch === this.epoch) return this.asking.done;
    const asking = {
      epoch: this.epoch,
      done: this.lookOnce().finally(() => {
        if (this.asking === asking) this.asking = null;
      }),
    };
    this.asking = asking;
    return asking.done;
  }

  private async lookOnce(): Promise<void> {
    if (!this.ctx.admin()) return;
    const epoch = this.epoch;
    const id = await this.ctx.identity();
    if (epoch !== this.epoch || id === null) return;
    let status: Record<string, unknown> | null = null;
    try {
      status = asRecord(await this.ctx.request("update.status", {}));
    } catch (error) {
      this.ctx.log(`could not read the gateway's update status: ${errorText(error)}`);
    }
    if (epoch !== this.epoch) return;
    if (!status) {
      // A failing read is asked again on the bound, whatever it was asked for; while something
      // holds Update, it keeps holding it.
      if (this.lookFor?.gatewayId === id) this.askLater();
      return;
    }
    const active = readUpdateRun(status.activeRun);
    const last = readUpdateRun(status.lastRun);
    const startedAt = this.ctx.startedAt();
    const immutable = asRecord(asRecord(status.schedule)?.install)?.kind === "immutable";
    // Can't update itself: said by this gateway process (its last run since it started).
    const blocked = immutable
      ? { reason: "immutable-native-updater-required", note: null }
      : last && cannotUpdate(last) && startedAt !== null && last.createdAtMs >= startedAt
        ? { reason: last.reason!, note: last.note }
        : this.refused;
    this.patch({ blocked });
    const look = this.lookFor?.gatewayId === id ? this.lookFor : null;
    if (look) {
      // What holds Update: its run, from the gateway's own record (by its id, or the tag the
      // press carried), never guessed from time.
      const found = look.runId
        ? await this.findRun(look.runId, active, last)
        : await this.findTagged(look.tag!, active, last);
      if (epoch !== this.epoch) return;
      if (found === undefined) {
        this.askLater();
        return;
      }
      this.cancelAsk?.();
      this.cancelAsk = null;
      this.lookFor = null;
      if (found === null) {
        await this.forget(id, look.runId);
        if (look.runId) {
          // A kept run the gateway has no record of: nothing more can be said of it.
          this.patch({
            looking: false,
            lookFailed: false,
            error: null,
            run: {
              runId: look.runId,
              gatewayId: id,
              mine: true,
              from: look.from,
              to: look.to,
              phase: "finished",
              outcome: "unconfirmed",
              reason: null,
              note: "The gateway has no record of this update.",
              reported: null,
            },
          });
          return;
        }
        // No run carries the press's tag. One running now may be the press's, if its gateway
        // records no tag: say what is true, never that it is someone else's.
        this.patch({ looking: false, lookFailed: false, error: null });
        if (active) await this.follow(id, active, null, look, UPDATE_UNTIED);
        else this.patch({ error: UPDATE_NOT_STARTED });
        return;
      }
      this.patch({ looking: false, lookFailed: false, error: null });
      await this.follow(id, found, true, look);
      await this.apply(found, epoch);
      if (this.state.run?.runId === found.runId && this.state.run.outcome === "running")
        this.pollRecord(found.runId);
      return;
    }
    const run = this.state.run;
    const released = this.released?.gatewayId === id ? this.released : null;
    if (active) {
      const base = run?.runId === active.runId ? run : null;
      if (base && isSettled(base)) return;
      // After Stop waiting: its run is still theirs; an untied one can't be said to be anyone's.
      const theirs =
        released !== null &&
        (released.runId === active.runId || (released.tag !== null && released.tag === active.tag));
      if (theirs) this.released = null;
      const mine = base?.mine ?? (theirs ? true : released ? null : false);
      await this.follow(id, active, mine, released, mine === null ? UPDATE_UNTIED : null);
      if (this.state.run?.mine && this.state.run.runId === active.runId)
        this.pollRecord(active.runId);
      return;
    }
    const followed = run && run.gatewayId === id && !isSettled(run) ? run.runId : null;
    if (!followed) return;
    const record =
      last?.runId === followed ? last : await this.readRun(followed).catch(() => undefined);
    if (epoch !== this.epoch || record === undefined) return;
    if (record === null) {
      this.patchRun(followed, {
        outcome: "unconfirmed",
        note: "The gateway has no record of this update.",
      });
      await this.forget(id, followed);
      return;
    }
    await this.apply(record, epoch);
  }

  /** The run `runId` from the status or its record: null when unknown, undefined unread. */
  private async findRun(
    runId: string,
    active: GatewayUpdateRun | null,
    last: GatewayUpdateRun | null,
  ): Promise<GatewayUpdateRun | null | undefined> {
    for (const run of [active, last]) if (run?.runId === runId) return run;
    return this.readRun(runId).catch((error: unknown) => {
      this.ctx.log(`could not read update run ${runId}: ${errorText(error)}`);
      return undefined;
    });
  }

  /** The run that carries `tag`, null when the gateway's history has none, undefined unread. */
  private async findTagged(
    tag: string,
    active: GatewayUpdateRun | null,
    last: GatewayUpdateRun | null,
  ): Promise<GatewayUpdateRun | null | undefined> {
    for (const run of [active, last]) if (run?.tag === tag) return run;
    try {
      const answer = asRecord(await this.ctx.request("update.runs.list", { limit: 20 }));
      const runs = Array.isArray(answer?.runs) ? answer.runs : [];
      for (const each of runs) {
        const run = readUpdateRun(each);
        if (run?.tag === tag) return run;
      }
      return null;
    } catch (error) {
      this.ctx.log(`could not read the gateway's update history: ${errorText(error)}`);
      return undefined;
    }
  }

  /** Show `record` as the run followed here, with `error` beside it when one is given. */
  private async follow(
    id: string,
    record: GatewayUpdateRun,
    mine: boolean | null,
    known: { from: string | null; to: string | null } | null,
    error: string | null = null,
  ): Promise<void> {
    const base = this.state.run?.runId === record.runId ? this.state.run : null;
    const connection = this.ctx.connection();
    this.movedAt = this.ctx.now();
    this.patch({
      run: {
        runId: record.runId,
        gatewayId: id,
        mine,
        from: record.before ?? base?.from ?? known?.from ?? connection.serverVersion,
        to: record.target ?? base?.to ?? known?.to ?? connection.openclawUpdate?.latest ?? null,
        phase: record.phase,
        outcome: "running",
        reason: null,
        note: base?.note ?? null,
        reported: null,
      },
      error,
    });
    // A run of this device's press is kept, so reopening the app follows it; another's isn't.
    if (mine === true) await this.keep(this.state.run!);
  }

  /**
   * Asking about a held press failed: again after the next wait; after the last, the person is
   * told and offered Check again and Stop waiting.
   */
  private askLater(): void {
    if (this.cancelAsk || !this.lookFor) return;
    const wait = UPDATE_ASK_WAITS_MS[this.askFailures];
    this.askFailures += 1;
    if (wait === undefined) {
      this.hold(this.lookFor, true);
      return;
    }
    this.cancelAsk = this.ctx.later(() => {
      this.cancelAsk = null;
      if (this.lookFor) void this.look();
    }, wait);
  }

  /** A run handed off moves by events; while none come, its record is read now and then. */
  private pollRecord(runId: string): void {
    this.cancelPoll?.();
    const until = this.ctx.now() + UPDATE_RECORD_POLL_LIMIT_MS;
    const tick = () => {
      this.cancelPoll = null;
      const run = this.state.run;
      if (run?.runId !== runId || run.outcome !== "running" || this.ctx.now() > until) return;
      const quiet = this.ctx.now() - this.movedAt >= UPDATE_RECORD_POLL_MS;
      if (quiet && this.ctx.connection().status === "connected") void this.settle(runId);
      this.cancelPoll = this.ctx.later(tick, UPDATE_RECORD_POLL_MS);
    };
    this.cancelPoll = this.ctx.later(tick, UPDATE_RECORD_POLL_MS);
  }

  /**
   * The connection dropped: a run under way may be restarting the gateway. Past the longest an
   * update usually takes, the line says so (a gateway started by hand may have been left
   * stopped); past the outer bound, that it hasn't come back. Either is corrected if it returns.
   */
  onDisconnect(): void {
    this.epoch += 1;
    const run = this.state.run;
    if (!run || run.outcome !== "running" || this.cancelAway) return;
    const runId = run.runId;
    this.cancelLate = this.ctx.later(() => {
      this.cancelLate = null;
      if (this.ctx.connection().status === "connected") return;
      if (this.state.run?.outcome === "running") this.patchRun(runId, { outcome: "late" });
    }, UPDATE_LATE_MS);
    this.cancelAway = this.ctx.later(() => {
      this.cancelAway = null;
      if (this.ctx.connection().status === "connected") return;
      this.patchRun(runId, { outcome: "away" });
    }, UPDATE_AWAY_MS);
  }

  /** Another gateway, or none: nothing followed on the last one is shown. */
  reset(): void {
    this.epoch += 1;
    this.resets += 1;
    for (const cancel of [this.cancelAway, this.cancelLate, this.cancelAsk, this.cancelPoll])
      cancel?.();
    this.cancelAway = null;
    this.cancelLate = null;
    this.cancelAsk = null;
    this.cancelPoll = null;
    this.lookFor = null;
    this.released = null;
    this.refused = null;
    this.reading = null;
    // The updates seen to succeed are each tied to their gateway, so they stay.
    const updated = this.ctx.get()?.updated;
    if (this.ctx.get()) this.ctx.set({ ...initialOpenClawUpdate, ...(updated ? { updated } : {}) });
  }

  /** A press went out and its answer was lost: held, kept, and asked about at once. */
  private async lose(
    look: { gatewayId: string; tag: string },
    offer: { current: string; latest: string },
  ): Promise<void> {
    const held: Look = { ...look, runId: null, from: offer.current, to: offer.latest };
    this.hold(held);
    await this.put({ ...held });
    if (this.ctx.connection().status === "connected") void this.look();
  }

  private async readRun(runId: string): Promise<GatewayUpdateRun | null> {
    const answer = asRecord(await this.ctx.request("update.runs.get", { runId }));
    if (answer?.run === null) return null;
    const run = readUpdateRun(answer?.run);
    if (!run || run.runId !== runId) throw new Error("The gateway's run record couldn't be read.");
    return run;
  }

  /** Read a followed run's record and show it: once at a time, however many events ask. */
  private async settle(runId: string): Promise<void> {
    if (this.reading === runId) return;
    this.reading = runId;
    const epoch = this.epoch;
    try {
      const record = await this.readRun(runId);
      if (epoch !== this.epoch || !record) return;
      await this.apply(record, epoch);
    } catch (error) {
      this.ctx.log(`could not read update run ${runId}: ${errorText(error)}`);
    } finally {
      if (this.reading === runId) this.reading = null;
    }
  }

  /** Show what the gateway's record says, and claim "updated" only on its terms. */
  private async apply(record: GatewayUpdateRun, epoch: number): Promise<void> {
    const runId = record.runId;
    const run = this.state.run;
    // A settled outcome is final: no record read later takes it back.
    if (run?.runId !== runId || isSettled(run)) return;
    const from = record.before ?? run.from;
    const to = record.target ?? run.to;
    if (record.status === "running") {
      if (run.phase !== record.phase) this.movedAt = this.ctx.now();
      this.patchRun(runId, { phase: record.phase, outcome: "running", from, to });
      return;
    }
    this.cancelPoll?.();
    this.cancelPoll = null;
    if (record.status !== "succeeded") {
      this.patchRun(runId, {
        phase: record.phase,
        outcome: record.status,
        reason: record.reason,
        note: record.note,
        from,
        to,
      });
      if (cannotUpdate(record))
        this.patch({ blocked: { reason: record.reason!, note: record.note } });
      await this.forget(run.gatewayId, runId);
      return;
    }
    // Succeeded, says the record: the same gateway, reconnected, must report that version.
    const id = await this.ctx.identity();
    if (epoch !== this.epoch || isSettled(this.state.run)) return;
    if (id !== run.gatewayId) {
      this.patchRun(runId, {
        outcome: "elsewhere",
        from: null,
        to: null,
        reported: null,
        reason: null,
        note: null,
      });
      return;
    }
    const expected = record.after ?? to;
    const connection = this.ctx.connection();
    const reported =
      connection.serverVersion !== null && isOpenClawVersion(connection.serverVersion)
        ? connection.serverVersion
        : null;
    if (connection.status === "connected" && expected !== null && reported === expected) {
      this.patchRun(runId, {
        phase: "finished",
        outcome: "updated",
        from,
        to: expected,
        reported: null,
        reason: null,
        note: null,
      });
      // Only this device's own press is vouched for: a run started elsewhere, a bot's included,
      // leaves the gateway's notice as the message it is.
      if (run.mine === true) {
        await this.remember({ gatewayId: run.gatewayId, runId, to: expected, at: this.ctx.now() });
        // The gateway's notice of it comes with no event: the main conversation is read again.
        this.readForNotice(run.gatewayId, runId, this.epoch, "first");
      }
      await this.forget(run.gatewayId, runId);
      // The newer OpenClaw's models: read again the way the app reads them, once.
      await this.ctx.refreshModels().catch((error: unknown) => {
        this.ctx.log(`could not read the model list again: ${errorText(error)}`);
      });
      return;
    }
    this.patchRun(runId, {
      phase: "finished",
      outcome: "unconfirmed",
      from,
      to: expected,
      reported,
      reason: null,
      note: null,
    });
    // The record has ended: what it says is shown here, and nothing more holds Update.
    await this.forget(run.gatewayId, runId);
  }

  /**
   * Keep `run` among the updates seen to succeed, in the state and in storage, from what storage
   * holds (one write after another): the latest last, the oldest gone past the bounds.
   */
  private remember(run: UpdatedRun): Promise<void> {
    const write = this.keeping.then(async () => {
      const now = this.ctx.now();
      const stored = readUpdated(
        await this.ctx.storage.get(UPDATED_RUNS_KEY).catch(() => null),
        now,
      );
      const updated = mergeUpdated(now, stored, this.state.updated ?? [], [run]);
      this.patch({ updated });
      try {
        await this.ctx.storage.set(UPDATED_RUNS_KEY, JSON.stringify({ runs: updated }));
      } catch (error) {
        this.ctx.log(`could not keep the finished update: ${errorText(error)}`);
      }
    });
    this.keeping = write;
    return write;
  }

  /**
   * Read the main conversation again for the gateway's notice of `runId`: once after
   * `UPDATE_NOTICE_READ_AFTER_MS`, and once more `UPDATE_NOTICE_READ_LAST_MS` later only when that
   * read found no notice; then no more. Both belong to this connection: after another hello, a
   * drop or a reset, nothing is read.
   */
  private readForNotice(
    gatewayId: string,
    runId: string,
    epoch: number,
    read: "first" | "last",
  ): void {
    this.ctx.later(
      () => {
        if (epoch !== this.epoch) return;
        this.ctx.readMainAgain(gatewayId, runId).then(
          (found) => {
            if (found === false && read === "first" && epoch === this.epoch)
              this.readForNotice(gatewayId, runId, epoch, "last");
          },
          (error: unknown) => {
            this.ctx.log(`could not read the main conversation again: ${errorText(error)}`);
          },
        );
      },
      read === "first" ? UPDATE_NOTICE_READ_AFTER_MS : UPDATE_NOTICE_READ_LAST_MS,
    );
  }

  private async keep(run: UpdateRunView): Promise<void> {
    await this.put({
      gatewayId: run.gatewayId,
      runId: run.runId,
      tag: null,
      from: run.from,
      to: run.to,
    });
  }

  /** What is kept for gateway `gatewayId`, or null. */
  private async keptFor(gatewayId: string | null): Promise<Kept | null> {
    if (gatewayId === null) return null;
    await this.keeping;
    const kept = readKept(await this.ctx.storage.get(UPDATE_RUN_KEY).catch(() => null));
    return kept.find((each) => each.gatewayId === gatewayId) ?? null;
  }

  /**
   * Change what is kept, one write after another, each from the value the one before left: an
   * entry for one gateway never touches another's, and the oldest goes past the bound.
   */
  private change(edit: (kept: Kept[]) => Kept[]): Promise<void> {
    const write = this.keeping.then(async () => {
      try {
        const now = readKept(await this.ctx.storage.get(UPDATE_RUN_KEY));
        const next = edit(now).slice(-MAX_KEPT_GATEWAYS);
        if (next.length === 0) await this.ctx.storage.delete(UPDATE_RUN_KEY);
        else await this.ctx.storage.set(UPDATE_RUN_KEY, JSON.stringify({ gateways: next }));
      } catch (error) {
        this.ctx.log(`could not keep the update run: ${errorText(error)}`);
      }
    });
    this.keeping = write;
    return write;
  }

  private put(entry: Kept): Promise<void> {
    return this.change((kept) => [
      ...kept.filter((each) => each.gatewayId !== entry.gatewayId),
      entry,
    ]);
  }

  /** Forget gateway `gatewayId`'s kept run `runId`, or with null its kept lost press. */
  private forget(gatewayId: string, runId: string | null): Promise<void> {
    return this.change((kept) =>
      kept.filter((each) => !(each.gatewayId === gatewayId && each.runId === runId)),
    );
  }
}
