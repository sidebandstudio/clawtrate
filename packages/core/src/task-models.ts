// A task's model and effort (docs/design/conversation.md, section 25): the
// models the gateway lists for one task, a change saved with `sessions.patch`
// at `operator.write` or held while a turn of the task is active and saved once
// it settles, and the line each change leaves. The engine's state is
// `ClawtrateState.taskModels`, one view per followed task. The client wires it
// in (`client.ts`).
//
// The gateway records no change of a task's model or effort, so the lines are
// this app's own record, kept on this device in the host's storage, one key per
// gateway, for the most recent `MAX_LOGGED_TASKS` tasks. No public field reports
// the effort a turn used, and none is kept here for one.

import { parseModelRef, readCatalog, type CatalogModel } from "./accounts.ts";
import type { KeyValueStore } from "./host.ts";
import { asRecord, type RawRecord } from "./mapping.ts";
import type { Task } from "./types.ts";

/** The models of the task's provider kept for its menu. */
export const MAX_TASK_MODELS = 32;
/** The lines kept for one task, newest last. */
export const MAX_TASK_MODEL_EVENTS = 16;
/** The tasks whose lines the storage keeps, most recently changed last. */
export const MAX_LOGGED_TASKS = 64;
/** The storage key's prefix; the gateway's identity follows it. */
export const TASK_MODEL_LOG_PREFIX = "clawtrate.task-models:";
/** The longest model reference, account, effort or id this engine keeps. */
export const MAX_TASK_MODEL_ID_CHARS = 256;
/**
 * How often a save the gateway answers as retryable is sent again, and the
 * pause before the first retry, doubled each time: a patch sent as a turn
 * ends can meet the gateway still settling it (`UNAVAILABLE`, `retryable`).
 */
export const MAX_SAVE_ATTEMPTS = 5;
export const SAVE_RETRY_MS = 400;
/** The longest refusal kept: the gateway's reason, cut. */
export const MAX_TASK_MODEL_ERROR_CHARS = 512;

/** A change the person chose: a model (`<provider>/<model>`), an effort, or both. */
export type TaskModelChoice = { model: string | null; effort: string | null };

/** One line in the conversation (25.4): a change saved, or refused. */
export type TaskModelEvent = {
  id: string;
  /**
   * `changed`: the gateway's answer, or a read after it, shows the change;
   * `refused`: the gateway answered with an error; `unconfirmed`: it accepted
   * the request and its answer does not show (all of) the change, or no
   * answer came, so what it has is read again.
   */
  outcome: "changed" | "refused" | "unconfirmed";
  /** When it was saved or refused, on this device's clock. */
  at: number;
  /**
   * The gateway's time it follows: the end of the task's last turn, or its
   * last message, when it was saved. The line goes before the first message
   * after it.
   */
  after: number;
  /** The model it changed to, or meant to, when the model was part of it. */
  model: string | null;
  /** The effort it changed to, or meant to, when the effort was part of it. */
  effort: string | null;
  wasModel: string | null;
  wasEffort: string | null;
  /** The effort went with the model: the new model does not offer the one it had. */
  followed: boolean;
  /** The gateway's reason, for a refusal. */
  error: string | null;
  /**
   * The task's session it was made in: a task the gateway started afresh under
   * the same key (a reset) is another conversation, and does not show it.
   */
  sessionId: string | null;
};

export type TaskModelView = {
  catalog: "idle" | "loading" | "ready" | "error";
  catalogError: string | null;
  /** The models of the task's provider, as `models.list {sessionKey}` lists them. */
  models: CatalogModel[];
  /** A change made while a turn was active, saved once it settles. */
  held: (TaskModelChoice & { at: number; sessionId: string | null }) | null;
  saving: boolean;
  /** What a save on its way asks for, shown as pending until the gateway answers (25.2). */
  pending: TaskModelChoice | null;
  /** The last refusal, until the next change. */
  refused: { error: string; at: number } | null;
  events: TaskModelEvent[];
};

export const emptyTaskModel: TaskModelView = {
  catalog: "idle",
  catalogError: null,
  models: [],
  held: null,
  saving: false,
  pending: null,
  refused: null,
  events: [],
};

/** What the engine needs from the client. */
export type TaskModelsContext = {
  request(method: string, params: unknown): Promise<unknown>;
  get(): Record<string, TaskModelView>;
  update(change: (all: Record<string, TaskModelView>) => Record<string, TaskModelView>): void;
  /** The task's row as the gateway last listed it. */
  task(key: string): Task | null;
  /** A turn of the task is running, waiting for the person, or stopping. */
  active(key: string): boolean;
  /** The gateway's time of the end of the task's last turn, or of its last message. */
  lastTurnEnd(key: string): number | null;
  connected(): boolean;
  /**
   * The client's connection: it changes with every new connection, to this
   * gateway or another. Work started on one connection is dropped on the next.
   */
  generation(): number;
  canWrite(): boolean;
  /** Write access, held already: nothing here asks for it (25.6). */
  ensureWrite(): Promise<void>;
  /** The task's row as the gateway's answer to a patch now has it. */
  applyRow(key: string, fields: RawRecord): void;
  /** Read the task list again, so the row shows what the gateway has. */
  refreshTasks(): void;
  /**
   * The gateway answered the request with an error (or it never left this
   * client): a refusal. Any other error is an answer that did not come.
   */
  refusal(error: unknown): boolean;
  /** A held change was saved or refused: what waited behind it may start. */
  released(key: string): void;
  storage: KeyValueStore;
  /** The storage key for this gateway, or null before it is known. */
  storageKey(): string | null;
  now(): number;
  randomId(): string;
  log(message: string): void;
  /** Wait before a retry; a test can make it immediate. */
  pause?: (ms: number) => Promise<void>;
};

/**
 * One request, sent once more when the gateway answers it as retryable, as it
 * does for `models.list` while it prepares a task's metadata.
 */
export async function onceMore<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if ((error as { retryable?: unknown } | null)?.retryable !== true) throw error;
    await new Promise<void>((resolve) => setTimeout(() => resolve(), SAVE_RETRY_MS));
    return send();
  }
}

/** The gateway says the request may be sent again (`retryable`), and when. */
function retryAfter(error: unknown, attempt: number): number | null {
  const shape = error as { retryable?: unknown; retryAfterMs?: unknown } | null;
  if (shape?.retryable !== true) return null;
  const asked = typeof shape.retryAfterMs === "number" ? shape.retryAfterMs : 0;
  return Math.min(5_000, Math.max(asked, SAVE_RETRY_MS * 2 ** attempt));
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const cut = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);
const shortId = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_TASK_MODEL_ID_CHARS
    ? value
    : null;

/** The model of a reference without its account: `acme/dev-2`. */
export function plainModel(ref: string | null | undefined): string | null {
  const parsed = parseModelRef(ref);
  return parsed ? `${parsed.provider}/${parsed.model}` : (ref ?? null);
}

/** The catalogue's entry for a `<provider>/<model>` reference. */
export function catalogEntry(models: readonly CatalogModel[], ref: string | null | undefined) {
  const parsed = parseModelRef(ref);
  return parsed
    ? models.find((each) => each.provider === parsed.provider && each.id === parsed.model)
    : undefined;
}

/**
 * What is known of a model's effort levels (25.2): the levels the gateway
 * lists for it; none, which is "Not offered" and said only then; or why they
 * are not known: the list is not read yet, its read failed, or it does not
 * contain the model.
 */
export type EffortLevels =
  | { kind: "levels"; levels: string[] }
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "failed"; error: string | null }
  | { kind: "unlisted" };

export function effortLevels(view: TaskModelView | undefined, ref: string | null): EffortLevels {
  const entry = catalogEntry(view?.models ?? [], ref);
  if (entry)
    return entry.levels.length ? { kind: "levels", levels: entry.levels } : { kind: "none" };
  if (!view || view.catalog === "idle" || view.catalog === "loading") return { kind: "loading" };
  if (view.catalog === "error") return { kind: "failed", error: view.catalogError };
  return { kind: "unlisted" };
}

/** The effort the task's row says it uses: its own level, or the gateway's default for it. */
export function rowEffort(task: Task | null | undefined): string | null {
  return task?.effort ?? task?.effortDefault ?? null;
}

/**
 * The level a model takes when a change of model leaves the effort behind:
 * the one it had when the new model offers it, else the model's default, else
 * the middle of its levels; null for a model with none (bots.md section 9).
 */
export function followingEffort(model: CatalogModel | undefined, was: string | null) {
  if (!model || model.levels.length === 0) return null;
  if (was && model.levels.includes(was)) return was;
  return model.defaultLevel && model.levels.includes(model.defaultLevel)
    ? model.defaultLevel
    : model.levels[Math.floor(model.levels.length / 2)]!;
}

/** What the chip and the Details show (25.2): the held change over what the gateway has. */
export function shownChoice(task: Task | null | undefined, view: TaskModelView | undefined) {
  const held = view?.held ?? null;
  const pending = held ? null : (view?.pending ?? null);
  return {
    model: held?.model ?? pending?.model ?? task?.model ?? null,
    effort: held?.effort ?? pending?.effort ?? rowEffort(task),
    held: held !== null,
    pending: pending !== null,
  };
}

/** The words of a line (25.4). */
export function taskModelLine(event: TaskModelEvent, word: (level: string) => string): string {
  if (event.outcome === "unconfirmed") {
    const what = event.model
      ? `the model to ${event.model}${event.effort ? ` and the effort to ${word(event.effort)}` : ""}`
      : event.effort
        ? `the effort to ${word(event.effort)}`
        : "the change";
    return `Couldn't confirm the change of ${what}. Reading the task again.`;
  }
  if (event.outcome === "refused") {
    const what = event.model
      ? `the model to ${event.model}`
      : event.effort
        ? `the effort to ${word(event.effort)}`
        : "the model";
    return `Couldn't change ${what}: ${event.error ?? "the gateway refused it"}`;
  }
  const parts: string[] = [];
  if (event.model) parts.push(`Model changed to ${event.model}`);
  if (event.effort)
    parts.push(
      parts.length > 0
        ? `effort to ${word(event.effort)}`
        : `Effort changed to ${word(event.effort)}`,
    );
  return `${parts.join(", ")} · from the next turn`;
}

type LogEntry = { events: TaskModelEvent[] };

/** One stored line, read back as untrusted: anything of the wrong shape is dropped. */
function readEvent(value: unknown): TaskModelEvent | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const id = shortId(raw.id);
  const outcome =
    raw.outcome === "changed" || raw.outcome === "refused" || raw.outcome === "unconfirmed"
      ? raw.outcome
      : null;
  const at = typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : null;
  const after = typeof raw.after === "number" && Number.isFinite(raw.after) ? raw.after : null;
  if (!id || !outcome || at === null || after === null) return null;
  const text = (v: unknown) => (v === null || v === undefined ? null : shortId(v));
  return {
    id,
    outcome,
    at,
    after,
    model: text(raw.model),
    effort: text(raw.effort),
    wasModel: text(raw.wasModel),
    wasEffort: text(raw.wasEffort),
    followed: raw.followed === true,
    sessionId: text(raw.sessionId),
    error: typeof raw.error === "string" ? cut(raw.error, MAX_TASK_MODEL_ERROR_CHARS) : null,
  };
}

function readLog(value: string | null): Array<[string, LogEntry]> {
  let parsed: unknown;
  try {
    parsed = value ? JSON.parse(value) : null;
  } catch {
    return [];
  }
  const tasks = asRecord(parsed)?.tasks;
  if (!Array.isArray(tasks)) return [];
  const out: Array<[string, LogEntry]> = [];
  for (const item of tasks.slice(-MAX_LOGGED_TASKS)) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const key = typeof item[0] === "string" && item[0].length <= 1024 ? item[0] : null;
    const entry = asRecord(item[1]);
    if (!key || !entry) continue;
    const events = (Array.isArray(entry.events) ? entry.events : [])
      .slice(-MAX_TASK_MODEL_EVENTS)
      .map(readEvent)
      .filter((each): each is TaskModelEvent => each !== null);
    out.push([key, { events }]);
  }
  return out;
}

const mergeEvents = (a: TaskModelEvent[], b: TaskModelEvent[]) => {
  const byId = new Map<string, TaskModelEvent>();
  for (const event of [...a, ...b]) byId.set(event.id, event);
  return [...byId.values()].sort((x, y) => x.at - y.at).slice(-MAX_TASK_MODEL_EVENTS);
};

/** Write access is missing: the chip is not offered then, so this is not asked for (25.6). */
export class TaskModelAccessError extends Error {
  constructor() {
    super("Changing this task's model needs a connection that can send.");
    this.name = "TaskModelAccessError";
  }
}

/** A read of one task's record for this opening of it, on the gateway it was asked for. */
type LoadJob = { storageKey: string; key: string; opening: number };
/**
 * A write of one task's lines to its gateway's record: the lines as they were
 * when it was asked for, kept with that gateway's key, so a task let go, or a
 * change of gateway, before the write is made loses none of them.
 */
type WriteJob = { storageKey: string; key: string; events: TaskModelEvent[] };

/** How a save ended. */
type SaveOutcome = "saved" | "unconfirmed" | "dropped" | { refused: string };

/** A save on its way: which opening of the task, and which connection, it belongs to. */
type TrackedSave = { done: Promise<void>; opening: number | undefined; generation: number };

/** The gateway refused the change; its reason is the message. */
export class TaskModelRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TaskModelRefusedError";
  }
}

export class TaskModelsEngine {
  private readonly ctx: TaskModelsContext;
  /**
   * A save on its way, per followed task: a message to that task waits for it.
   * One started for an earlier opening of the task, or on an earlier connection,
   * no longer counts: a new opening starts on its own.
   */
  private readonly saves = new Map<string, TrackedSave>();
  /**
   * Reads of this device's record still to make, one per gateway and task: a
   * second for the same pair joins the first. Only the present gateway's, and
   * only for a followed task (letting one go removes its read), so at most one
   * per followed task.
   */
  private readonly storeLoads = new Map<string, LoadJob>();
  /**
   * Writes still to make, one per gateway and task, each with its lines: a
   * second for the same pair joins the first. At most the `MAX_LOGGED_TASKS`
   * most recently changed pairs, as many as the record keeps.
   */
  private readonly storeWrites = new Map<string, WriteJob>();
  private storeRunning = false;
  /** Which opening of each followed task a job belongs to: a job for an earlier one is dropped. */
  private readonly openings = new Map<string, number>();
  private nextOpening = 0;

  constructor(ctx: TaskModelsContext) {
    this.ctx = ctx;
  }

  private patch(key: string, change: (view: TaskModelView) => TaskModelView): void {
    this.ctx.update((all) => (all[key] ? { ...all, [key]: change(all[key]) } : all));
  }

  /** A task is followed: its view, its lines from the storage, and its models. */
  open(key: string): void {
    if (this.ctx.get()[key]) return;
    this.openings.set(key, (this.nextOpening += 1));
    this.ctx.update((all) => ({ ...all, [key]: emptyTaskModel }));
    this.loadLog(key);
    if (this.ctx.connected()) void this.readCatalog(key);
  }

  /** A task is let go. Its record stays in the storage. */
  close(key: string): void {
    if (this.hasWork(key)) return;
    this.openings.delete(key);
    // Its reads are not needed now; its writes are made, with the lines they were asked with.
    for (const [id, job] of this.storeLoads) if (job.key === key) this.storeLoads.delete(id);
    this.ctx.update((all) => {
      if (!all[key]) return all;
      const next = { ...all };
      delete next[key];
      return next;
    });
  }

  /** A change waits or is on its way: the task is kept followed until it is saved. */
  hasWork(key: string): boolean {
    return this.ownSave(key) !== null || (this.ctx.get()[key]?.held ?? null) !== null;
  }

  /** The save on its way for this opening of the task, on this connection, if there is one. */
  private ownSave(key: string): TrackedSave | null {
    const save = this.saves.get(key);
    return save &&
      save.opening === this.openings.get(key) &&
      save.generation === this.ctx.generation()
      ? save
      : null;
  }

  /** After a reconnect: every followed task's models again, and any held change once nothing runs. */
  reconnected(): void {
    for (const key of Object.keys(this.ctx.get())) {
      this.loadLog(key);
      void this.readCatalog(key);
      this.ctx.released(key);
    }
  }

  /** `models.list {sessionKey}`: the models of the task's provider. */
  async readCatalog(key: string): Promise<void> {
    if (!this.ctx.get()[key]) return;
    // An answer, or a retry, for another connection or an earlier opening of the task is dropped.
    const generation = this.ctx.generation();
    const opening = this.openings.get(key);
    const live = () => this.ctx.generation() === generation && this.openings.get(key) === opening;
    this.patch(key, (view) => ({
      ...view,
      catalog: view.catalog === "ready" ? "ready" : "loading",
    }));
    try {
      const read = () => this.ctx.request("models.list", { sessionKey: key });
      let answer: unknown;
      try {
        answer = await read();
      } catch (error) {
        if ((error as { retryable?: unknown } | null)?.retryable !== true || !live()) throw error;
        await new Promise<void>((resolve) => setTimeout(() => resolve(), SAVE_RETRY_MS));
        if (!live()) return;
        answer = await read();
      }
      if (!live()) return;
      const provider = parseModelRef(this.ctx.task(key)?.model)?.provider ?? null;
      const models = readCatalog(answer)
        .filter((each) => provider === null || each.provider === provider)
        .slice(0, MAX_TASK_MODELS);
      this.patch(key, (view) => ({
        ...view,
        catalog: "ready",
        catalogError: null,
        models,
      }));
    } catch (error) {
      if (!live()) return;
      this.patch(key, (view) => ({
        ...view,
        catalog: "error",
        catalogError: cut(errorText(error), MAX_TASK_MODEL_ERROR_CHARS),
      }));
    }
  }

  /**
   * The person chose a model, an effort, or both (25.3). Saved at once when no
   * turn of the task is active, otherwise held. Choosing what the task has
   * already lets go of a held change.
   */
  async choose(
    key: string,
    choice: TaskModelChoice,
  ): Promise<"saved" | "held" | "unchanged" | "unconfirmed"> {
    if (!this.ctx.canWrite()) throw new TaskModelAccessError();
    const task = this.ctx.task(key);
    const view = this.ctx.get()[key];
    if (!task || !view) throw new Error("That task is not open here.");
    const held = view.held;
    const model = choice.model ?? held?.model ?? null;
    // A new model takes the effort with it only when it does not offer the one the task has.
    const effort = choice.effort
      ? choice.effort
      : choice.model
        ? followingEffort(catalogEntry(view.models, choice.model), held?.effort ?? rowEffort(task))
        : (held?.effort ?? null);
    const desired: TaskModelChoice = {
      model: model && model !== task.model ? model : null,
      effort,
    };
    const writes = this.writes(task, view, desired);
    if (!writes.model && !writes.effort) {
      this.keep(key);
      return "unchanged";
    }
    if (this.ctx.active(key) || this.ownSave(key) || !this.ctx.connected()) {
      this.patch(key, (current) => ({
        ...current,
        held: { ...desired, at: this.ctx.now(), sessionId: held?.sessionId ?? task.sessionId },
        refused: null,
      }));
      return "held";
    }
    const outcome = await this.save(key, desired, task.sessionId);
    if (typeof outcome === "object") throw new TaskModelRefusedError(outcome.refused);
    return outcome === "dropped" ? "unchanged" : outcome;
  }

  /**
   * What a change writes against the row as it is: the model when it differs,
   * and the effort when the task would not have it without being told.
   */
  private writes(task: Task, view: TaskModelView, desired: TaskModelChoice): TaskModelChoice {
    const model = desired.model && desired.model !== task.model ? desired.model : null;
    const defaultAfter = model
      ? (catalogEntry(view.models, model)?.defaultLevel ?? task.effortDefault ?? null)
      : (task.effortDefault ?? null);
    const without = task.effort ?? defaultAfter;
    const effort = desired.effort && desired.effort !== without ? desired.effort : null;
    return { model, effort };
  }

  /** "Keep": let go of a held change. */
  keep(key: string): void {
    this.patch(key, (view) => (view.held ? { ...view, held: null } : view));
  }

  /**
   * After any change of the task's turns: when nothing is active and a change
   * is held, save it. True while a save is on its way: nothing queued behind
   * the turn starts until it is done.
   */
  release(key: string): boolean {
    if (this.ownSave(key)) return true;
    const held = this.ctx.get()[key]?.held;
    if (!held) return false;
    // A task the gateway no longer lists: its held change is dropped, once, and never sent.
    if (!this.ctx.task(key)) {
      this.drop(key);
      return false;
    }
    if (this.ctx.active(key) || !this.ctx.connected()) return false;
    void this.save(key, { model: held.model, effort: held.effort }, held.sessionId);
    return true;
  }

  /** The task is gone: a held change for it is let go, and nothing is said about it. */
  drop(key: string): void {
    if (this.ctx.get()[key]?.held) this.keep(key);
  }

  /** Wait for a save on its way to this task, if there is one. */
  settled(key: string): Promise<void> {
    return this.ownSave(key)?.done ?? Promise.resolve();
  }

  private save(
    key: string,
    desired: TaskModelChoice,
    sessionId: string | null,
  ): Promise<SaveOutcome> {
    // The connection, the opening of the task, its session and the gateway the save starts on: it
    // goes on only while all four are still the same, and is dropped, unsaid, once one is not.
    const generation = this.ctx.generation();
    const opening = this.openings.get(key);
    const gateway = this.ctx.storageKey();
    const session = sessionId ?? this.ctx.task(key)?.sessionId ?? null;
    const sameClient = () =>
      this.ctx.generation() === generation && this.ctx.storageKey() === gateway;
    const live = () =>
      sameClient() &&
      this.openings.get(key) === opening &&
      (session === null || (this.ctx.task(key)?.sessionId ?? null) === session);
    const run = (async (): Promise<SaveOutcome> => {
      const task = this.ctx.task(key);
      const view = this.ctx.get()[key];
      if (!task || !view) {
        // Gone since the change was held: dropped here, so nothing releases it again.
        this.drop(key);
        return "dropped";
      }
      const change = this.writes(task, view, desired);
      this.patch(key, (current) => ({ ...current, held: null, refused: null }));
      if (!change.model && !change.effort) return "dropped";
      const wasModel = task.model ?? null;
      const wasEffort = rowEffort(task);
      const effort = desired.effort && desired.effort !== wasEffort ? desired.effort : null;
      const followed =
        change.model !== null &&
        effort !== null &&
        wasEffort !== null &&
        !(catalogEntry(view.models, change.model)?.levels.includes(wasEffort) ?? true);
      const params: RawRecord = { key };
      // The model alone: the gateway keeps the task's account. An account Clawtrate read (or one
      // the gateway chose by itself) is never sent back as the person's choice (bots.md F-490).
      if (change.model) params.model = change.model;
      if (change.effort) params.thinkingLevel = change.effort;
      // A task replaced or removed meanwhile is refused, never made again (25.3).
      if (sessionId) params.expectedSessionId = sessionId;
      this.patch(key, (current) => ({
        ...current,
        saving: true,
        pending: { model: change.model, effort },
      }));
      const event = (
        outcome: TaskModelEvent["outcome"],
        fields: TaskModelChoice,
        error: string | null,
      ): TaskModelEvent => ({
        id: this.ctx.randomId(),
        outcome,
        at: this.ctx.now(),
        after: this.ctx.lastTurnEnd(key) ?? this.ctx.now(),
        model: fields.model,
        effort: fields.effort,
        wasModel,
        wasEffort,
        followed: followed && fields.model !== null && fields.effort !== null,
        error,
        sessionId,
      });
      let outcome: SaveOutcome;
      const lines: TaskModelEvent[] = [];
      let refused: { error: string; at: number } | null = null;
      /** The save is let go: its connection, opening, session or gateway is not the one it began on. */
      const stale = (): SaveOutcome => {
        // The view, when it is still this opening's, stops saying it saves; nothing else is touched.
        if (this.openings.get(key) === opening)
          this.patch(key, (current) => ({ ...current, saving: false, pending: null }));
        return "dropped";
      };
      try {
        await this.ctx.ensureWrite();
        if (!live()) return stale();
        let answer: RawRecord | null = null;
        for (let attempt = 0; ; attempt += 1) {
          if (!live()) return stale();
          try {
            answer = asRecord(await this.ctx.request("sessions.patch", params));
            break;
          } catch (error) {
            if (!live()) return stale();
            const wait = retryAfter(error, attempt);
            if (wait === null || attempt + 1 >= MAX_SAVE_ATTEMPTS || !this.ctx.connected())
              throw error;
            await (this.ctx.pause ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(wait);
          }
        }
        if (!live()) return stale();
        // What the answer itself shows: the model it resolved, and the level it keeps or uses.
        const resolved = asRecord(answer?.resolved);
        const entry = asRecord(answer?.entry);
        const answeredModel =
          typeof resolved?.modelProvider === "string" && typeof resolved.model === "string"
            ? `${resolved.modelProvider}/${resolved.model}`
            : null;
        const answeredLevels = [entry?.thinkingLevel, resolved?.thinkingLevel].filter(
          (level): level is string => typeof level === "string",
        );
        const fields: RawRecord = {};
        if (typeof resolved?.model === "string") fields.model = resolved.model;
        if (typeof resolved?.modelProvider === "string")
          fields.modelProvider = resolved.modelProvider;
        if (typeof entry?.thinkingLevel === "string") fields.thinkingLevel = entry.thinkingLevel;
        if (typeof entry?.sessionId === "string") fields.sessionId = entry.sessionId;
        this.ctx.applyRow(key, fields);
        const confirmed: TaskModelChoice = {
          model: change.model && answeredModel === change.model ? change.model : null,
          effort: effort && answeredLevels.includes(effort) ? effort : null,
        };
        const missing: TaskModelChoice = {
          model: change.model && !confirmed.model ? change.model : null,
          effort: effort && !confirmed.effort ? effort : null,
        };
        if (confirmed.model || confirmed.effort) lines.push(event("changed", confirmed, null));
        if (missing.model || missing.effort) lines.push(event("unconfirmed", missing, null));
        outcome = missing.model || missing.effort ? "unconfirmed" : "saved";
      } catch (error) {
        if (!live()) return stale();
        const reason = cut(errorText(error), MAX_TASK_MODEL_ERROR_CHARS);
        if (this.ctx.refusal(error)) {
          this.ctx.log(`the change of ${key}'s model was refused: ${reason}`);
          const line = event("refused", { model: change.model, effort }, reason);
          lines.push(line);
          refused = { error: reason, at: line.at };
          outcome = { refused: reason };
        } else {
          // No answer: whether it landed is not known; the read below shows what the gateway has.
          this.ctx.log(`the change of ${key}'s model was not confirmed: ${reason}`);
          lines.push(event("unconfirmed", { model: change.model, effort }, null));
          outcome = "unconfirmed";
        }
      }
      this.patch(key, (current) => ({
        ...current,
        saving: false,
        pending: null,
        refused,
        events: mergeEvents(current.events, lines),
      }));
      // What the gateway has now, whatever the answer was.
      this.ctx.refreshTasks();
      this.persist(key);
      void this.readCatalog(key);
      return outcome;
    })();
    const tracked = run.finally(() => {
      // Only its own entry is cleared; only the connection it began on hears that it ended.
      if (this.saves.get(key)?.done === done) this.saves.delete(key);
      if (sameClient()) this.ctx.released(key);
    });
    const done = tracked.then(
      () => undefined,
      () => undefined,
    );
    this.saves.set(key, { done, opening, generation });
    return tracked;
  }

  // The record on this device ----------------------------------------------------------------

  private loadLog(key: string): void {
    const storageKey = this.ctx.storageKey();
    const opening = this.openings.get(key);
    if (!storageKey || opening === undefined) return;
    // Reads for another gateway are stale: this device now follows this one.
    for (const [id, job] of this.storeLoads)
      if (job.storageKey !== storageKey) this.storeLoads.delete(id);
    this.storeLoads.set(`${storageKey}\u0000${key}`, { storageKey, key, opening });
    void this.runStore();
  }

  /** Write the task's lines as they are now, under the gateway they were made on. */
  private persist(key: string): void {
    const storageKey = this.ctx.storageKey();
    const events = this.ctx.get()[key]?.events;
    if (!storageKey || !events) return;
    const id = `${storageKey}\u0000${key}`;
    const before = this.storeWrites.get(id);
    // The most recently changed last; the oldest goes beyond the record's own limit.
    this.storeWrites.delete(id);
    this.storeWrites.set(id, {
      storageKey,
      key,
      events: before ? mergeEvents(before.events, events) : events,
    });
    while (this.storeWrites.size > MAX_LOGGED_TASKS)
      this.storeWrites.delete(this.storeWrites.keys().next().value!);
    void this.runStore();
  }

  /** One pair at a time, its record read once for its read and its write. */
  private async runStore(): Promise<void> {
    if (this.storeRunning) return;
    this.storeRunning = true;
    try {
      for (;;) {
        const id = this.storeWrites.keys().next().value ?? this.storeLoads.keys().next().value;
        if (id === undefined) break;
        const load = this.storeLoads.get(id) ?? null;
        const write = this.storeWrites.get(id) ?? null;
        this.storeLoads.delete(id);
        this.storeWrites.delete(id);
        try {
          await this.store(load, write);
        } catch (error) {
          this.ctx.log(`the task model record was not read or written: ${errorText(error)}`);
        }
      }
    } finally {
      this.storeRunning = false;
    }
  }

  private async store(load: LoadJob | null, write: WriteJob | null): Promise<void> {
    const storageKey = (write ?? load)!.storageKey;
    const key = (write ?? load)!.key;
    // A read shows its lines only to the opening, and the gateway, it was asked for.
    const current = () =>
      load !== null &&
      this.ctx.storageKey() === load.storageKey &&
      this.openings.get(key) === load.opening &&
      this.ctx.get()[key] !== undefined;
    if (!write && !current()) return;
    const tasks = readLog(await this.ctx.storage.get(storageKey));
    const stored = tasks.find(([k]) => k === key)?.[1].events ?? [];
    if (current() && stored.length > 0)
      this.patch(key, (view) => ({ ...view, events: mergeEvents(stored, view.events) }));
    if (write) {
      const rest = tasks.filter(([k]) => k !== key);
      // What the record has, joined with what was asked to be written, by id.
      rest.push([key, { events: mergeEvents(stored, write.events) }]);
      await this.ctx.storage.set(
        storageKey,
        JSON.stringify({ v: 1, tasks: rest.slice(-MAX_LOGGED_TASKS) }),
      );
    }
  }
}
