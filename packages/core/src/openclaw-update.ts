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

import { isOpenClawVersion } from "./gateway-update.ts";
import type { KeyValueStore } from "./host.ts";
import { asRecord } from "./mapping.ts";
import type { ConnectionState, GatewayStamp } from "./types.ts";

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

/** A run id as the gateway writes one: a UUID, or `ocm:` and a job id. */
const RUN_ID =
  /^(ocm:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
/** The longest reason code kept, and the longest of the gateway's own sentences. */
export const MAX_UPDATE_REASON_CHARS = 128;
export const MAX_UPDATE_NOTE_CHARS = 400;
/**
 * How long a run may be out of reach before Clawtrate says the gateway hasn't come back:
 * the gateway waits up to 5 minutes for running work before it restarts, then starts again.
 */
export const UPDATE_AWAY_MS = 15 * 60_000;
/** The run this device started, kept so reopening the app follows it again. */
export const UPDATE_RUN_KEY = "clawtrate.openclaw-update";
/** A kept record longer than this isn't read. */
const MAX_KEPT_CHARS = 2_048;

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
};

export type UpdateOutcome =
  | "running"
  | "updated"
  | "unconfirmed"
  | "failed"
  | "rolled-back"
  | "skipped"
  | "away"
  | "elsewhere";

/** The run Clawtrate follows, as the screens show it. */
export type UpdateRunView = {
  runId: string;
  /** The gateway it runs on (its identity): nothing about it is said on another. */
  gatewayId: string;
  /** This device's press started it; otherwise another device, the CLI or the gateway did. */
  mine: boolean;
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
};

export const initialOpenClawUpdate: OpenClawUpdateState = {
  run: null,
  starting: false,
  blocked: null,
  error: null,
};

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

type Kept = { gatewayId: string; runId: string; from: string | null; to: string | null };

function readKept(raw: string | null): Kept | null {
  if (raw === null || raw.length > MAX_KEPT_CHARS) return null;
  try {
    const kept = asRecord(JSON.parse(raw));
    const gatewayId = kept?.gatewayId;
    const runId = kept?.runId;
    if (typeof gatewayId !== "string" || !gatewayId || gatewayId.length > 1_024) return null;
    if (typeof runId !== "string" || !RUN_ID.test(runId)) return null;
    const version = (value: unknown) =>
      typeof value === "string" && isOpenClawVersion(value) ? value : null;
    return { gatewayId, runId, from: version(kept?.from), to: version(kept?.to) };
  } catch {
    return null;
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
  storage: KeyValueStore;
  get: () => OpenClawUpdateState | undefined;
  set: (state: OpenClawUpdateState) => void;
  /** Call `run` after `ms`; the answer cancels it. */
  later: (run: () => void, ms: number) => () => void;
  log: (text: string) => void;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const UPDATE_NOT_SENT = "The connection changed, so nothing was sent.";
export const UPDATE_SENT_UNKNOWN =
  "The connection changed before the gateway answered. Clawtrate looks for the update when it reconnects.";

export class OpenClawUpdates {
  /** Moves on with each hello and each reset: an answer read before it changes nothing. */
  private epoch = 0;
  private cancelAway: (() => void) | null = null;
  /** A press whose answer was lost: the gateway and when, looked for on the next hello. */
  private lookFor: { gatewayId: string; since: number } | null = null;
  /** The gateway refused a press with no run, as an install it can't update: kept until a reset. */
  private refused: { reason: string; note: string | null } | null = null;
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

  /**
   * The person's press, after the confirmation: one `update.run`, only to the gateway the
   * screen showed (`stamp`), on the connection that checked it, and only while that gateway
   * reports a newer OpenClaw, can update itself and runs no update.
   */
  async start(stamp: GatewayStamp): Promise<void> {
    const state = this.state;
    if (state.starting || state.run?.outcome === "running" || state.run?.outcome === "away")
      throw new Error("An update is already under way.");
    if (!this.ctx.admin()) throw new Error("Updating OpenClaw needs admin access.");
    if (state.blocked) throw new Error("This gateway can't update itself, so nothing was sent.");
    const offer = this.ctx.connection().openclawUpdate;
    if (!offer)
      throw new Error("The gateway doesn't report a newer OpenClaw now, so nothing was sent.");
    const epoch = this.epoch;
    this.patch({ starting: true, error: null });
    let sent = false;
    let answer: unknown;
    try {
      await this.ctx.sameGateway(stamp);
      // Another hello or a reset since the check: nothing goes.
      if (epoch !== this.epoch) throw new Error(UPDATE_NOT_SENT);
      // As things are now, with no wait between this look and the send.
      const now = this.state;
      if (now.run?.outcome === "running" || now.run?.outcome === "away" || now.blocked)
        throw new Error("An update is already under way.");
      if (!this.ctx.connection().openclawUpdate)
        throw new Error("The gateway doesn't report a newer OpenClaw now, so nothing was sent.");
      answer = await this.ctx.request("update.run", {}, () => {
        sent = true;
      });
    } catch (error) {
      this.patch({ starting: false });
      if (sent && !this.ctx.answered(error)) {
        // It may have started: the next hello looks for it.
        if (stamp.gatewayId)
          this.lookFor = { gatewayId: stamp.gatewayId, since: Date.now() - 60_000 };
        this.patch({ error: UPDATE_SENT_UNKNOWN });
        throw new Error(UPDATE_SENT_UNKNOWN, { cause: error });
      }
      if (sent && this.ctx.missingScope(error)) {
        const words = "The gateway refused: updating OpenClaw needs admin access.";
        this.patch({ error: words });
        throw new Error(words, { cause: error });
      }
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
    this.patch({ starting: false });
    const reply = asRecord(answer);
    const runId = reply?.runId;
    const gatewayId = stamp.gatewayId!;
    if (epoch !== this.epoch || typeof runId !== "string" || !RUN_ID.test(runId)) {
      // The answer came on a connection that is gone, or names no run: look for it again.
      this.lookFor = { gatewayId, since: Date.now() - 60_000 };
      this.patch({ error: UPDATE_SENT_UNKNOWN });
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
    if (reply?.ok === true) {
      await this.keep(view);
      return;
    }
    // Finished at once: the gateway's record says why, or its answer does.
    const record = await this.readRun(runId).catch(() => null);
    if (epoch !== this.epoch) return;
    if (record) return this.apply(record, epoch);
    const result = asRecord(reply?.result);
    const reason = updateText(result?.reason, MAX_UPDATE_REASON_CHARS);
    const note = updateText(reply?.message, MAX_UPDATE_NOTE_CHARS);
    this.patchRun(runId, {
      phase: "finished",
      outcome: result?.status === "skipped" ? "skipped" : "failed",
      reason,
      note,
    });
    if (reason && CANNOT_UPDATE.has(reason)) this.patch({ blocked: { reason, note } });
  }

  /** The person put the finished run's line away. Nothing is sent. */
  async dismiss(): Promise<void> {
    const run = this.state.run;
    if (!run || run.outcome === "running" || run.outcome === "away") return;
    this.patch({ run: null, error: null });
    await this.forget(run.runId);
  }

  /** `update.run.changed`, sent to admin connections while a run moves. */
  onRunChanged(payload: unknown): void {
    const event = readRunChanged(payload);
    if (!event) return;
    const run = this.state.run;
    const epoch = this.epoch;
    if (run?.runId === event.runId) {
      if (event.status === "running") {
        this.patchRun(event.runId, { phase: event.phase, outcome: "running" });
        return;
      }
      void this.settle(event.runId, epoch);
      return;
    }
    // Another run, while this one isn't running: started on another device, by the CLI or by
    // the gateway's own schedule. Shown, so no second one is offered.
    if (event.status !== "running" || run?.outcome === "running") return;
    const gatewayId = this.ctx.connection().gatewayId;
    if (!gatewayId) return;
    const connection = this.ctx.connection();
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
    void this.settle(event.runId, epoch);
  }

  /**
   * Connected again (a reconnect after the restart, or reopening the app): read the gateway's
   * update status, follow the run under way, and settle the run followed from its record.
   */
  async onHello(): Promise<void> {
    const epoch = ++this.epoch;
    this.cancelAway?.();
    this.cancelAway = null;
    if (!this.ctx.admin()) return;
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
      return;
    }
    const kept = run
      ? null
      : readKept(await this.ctx.storage.get(UPDATE_RUN_KEY).catch(() => null));
    if (epoch !== this.epoch) return;
    let status: Record<string, unknown> | null = null;
    try {
      status = asRecord(await this.ctx.request("update.status", {}));
    } catch (error) {
      this.ctx.log(`could not read the gateway's update status: ${errorText(error)}`);
    }
    if (epoch !== this.epoch) return;
    const active = readUpdateRun(status?.activeRun);
    const last = readUpdateRun(status?.lastRun);
    const startedAt = this.ctx.startedAt();
    const immutable = asRecord(asRecord(status?.schedule)?.install)?.kind === "immutable";
    // Can't update itself: said by this gateway process (its last run since it started).
    const blocked = immutable
      ? { reason: "immutable-native-updater-required", note: null }
      : last && cannotUpdate(last) && startedAt !== null && last.createdAtMs >= startedAt
        ? { reason: last.reason!, note: last.note }
        : this.refused;
    this.patch({ blocked });
    const followed =
      run?.runId ??
      (kept?.gatewayId === id ? kept.runId : null) ??
      this.lookedFor(id, active, last);
    if (active) {
      const base = run?.runId === active.runId ? run : null;
      this.patch({
        run: {
          runId: active.runId,
          gatewayId: id,
          mine: base?.mine ?? active.runId === followed,
          from: active.before ?? base?.from ?? kept?.from ?? this.ctx.connection().serverVersion,
          to:
            active.target ??
            base?.to ??
            kept?.to ??
            this.ctx.connection().openclawUpdate?.latest ??
            null,
          phase: active.phase,
          outcome: "running",
          reason: null,
          note: null,
          reported: null,
        },
        error: null,
      });
      return;
    }
    if (!followed) return;
    if (run && !["running", "away", "unconfirmed"].includes(run.outcome)) return;
    if (!run)
      this.patch({
        run: {
          runId: followed,
          gatewayId: id,
          mine: true,
          from: kept?.from ?? null,
          to: kept?.to ?? null,
          phase: "requested",
          outcome: "running",
          reason: null,
          note: null,
          reported: null,
        },
        error: null,
      });
    const record =
      last?.runId === followed ? last : await this.readRun(followed).catch(() => undefined);
    if (epoch !== this.epoch || record === undefined) return;
    if (record === null) {
      this.patchRun(followed, {
        outcome: "unconfirmed",
        note: "The gateway has no record of this update.",
      });
      await this.forget(followed);
      return;
    }
    await this.apply(record, epoch);
  }

  /** The connection dropped: a run under way may be restarting the gateway. */
  onDisconnect(): void {
    this.epoch += 1;
    const run = this.state.run;
    if (!run || run.outcome !== "running" || this.cancelAway) return;
    const runId = run.runId;
    this.cancelAway = this.ctx.later(() => {
      this.cancelAway = null;
      if (this.ctx.connection().status === "connected") return;
      this.patchRun(runId, { outcome: "away" });
    }, UPDATE_AWAY_MS);
  }

  /** Another gateway, or none: nothing followed on the last one is shown. */
  reset(): void {
    this.epoch += 1;
    this.cancelAway?.();
    this.cancelAway = null;
    this.lookFor = null;
    this.refused = null;
    if (this.ctx.get()) this.ctx.set(initialOpenClawUpdate);
  }

  private lookedFor(
    id: string,
    active: GatewayUpdateRun | null,
    last: GatewayUpdateRun | null,
  ): string | null {
    const look = this.lookFor;
    this.lookFor = null;
    if (!look || look.gatewayId !== id) return null;
    const found = [active, last].find((run) => run && run.createdAtMs >= look.since);
    if (found) this.patch({ error: null });
    return found?.runId ?? null;
  }

  private async readRun(runId: string): Promise<GatewayUpdateRun | null> {
    const answer = asRecord(await this.ctx.request("update.runs.get", { runId }));
    if (answer?.run === null) return null;
    const run = readUpdateRun(answer?.run);
    if (!run || run.runId !== runId) throw new Error("The gateway's run record couldn't be read.");
    return run;
  }

  /** A followed run reached an end: read its record and settle it. */
  private async settle(runId: string, epoch: number): Promise<void> {
    try {
      const record = await this.readRun(runId);
      if (epoch !== this.epoch || !record) return;
      await this.apply(record, epoch);
    } catch (error) {
      this.ctx.log(`could not read update run ${runId}: ${errorText(error)}`);
    }
  }

  /** Show what the gateway's record says, and claim "updated" only on its terms. */
  private async apply(record: GatewayUpdateRun, epoch: number): Promise<void> {
    const runId = record.runId;
    const run = this.state.run;
    if (run?.runId !== runId) return;
    const from = record.before ?? run.from;
    const to = record.target ?? run.to;
    if (record.status === "running") {
      this.patchRun(runId, { phase: record.phase, outcome: "running", from, to });
      return;
    }
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
      await this.forget(runId);
      return;
    }
    // Succeeded, says the record: the same gateway, reconnected, must report that version.
    const id = await this.ctx.identity();
    if (epoch !== this.epoch) return;
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
      await this.forget(runId);
      // The newer OpenClaw's models: read again the way the app reads them.
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
  }

  private async keep(run: UpdateRunView): Promise<void> {
    const kept: Kept = { gatewayId: run.gatewayId, runId: run.runId, from: run.from, to: run.to };
    await this.ctx.storage.set(UPDATE_RUN_KEY, JSON.stringify(kept)).catch((error: unknown) => {
      this.ctx.log(`could not keep the update run: ${errorText(error)}`);
    });
  }

  private async forget(runId: string): Promise<void> {
    try {
      const kept = readKept(await this.ctx.storage.get(UPDATE_RUN_KEY));
      if (kept?.runId === runId) await this.ctx.storage.delete(UPDATE_RUN_KEY);
    } catch (error) {
      this.ctx.log(`could not forget the update run: ${errorText(error)}`);
    }
  }
}
