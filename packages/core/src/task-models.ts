// A task's model and effort (docs/design/conversation.md, section 25): the
// models the gateway lists for one task, a change saved with `sessions.patch`
// at `operator.write` or held while a turn of the task is active and saved once
// it settles, the line each change leaves, and the effort each turn this app
// started asked for. The engine's state is `ClawtrateState.taskModels`, one
// view per followed task. The client wires it in (`client.ts`).
//
// The gateway records no change of a task's model or effort, and no public
// field reports the effort a turn used. So the lines, and the effort each turn
// this app started asked for (as the task's row named it then), are this app's
// own record, kept on this device in the host's storage, one key per gateway,
// for the most recent `MAX_LOGGED_TASKS` tasks.

import { parseModelRef, readCatalog, type CatalogModel } from "./accounts.ts";
import type { KeyValueStore } from "./host.ts";
import { asRecord, type RawRecord } from "./mapping.ts";
import type { Task } from "./types.ts";

/** The models of the task's provider kept for its menu. */
export const MAX_TASK_MODELS = 32;
/** The lines kept for one task, newest last. */
export const MAX_TASK_MODEL_EVENTS = 16;
/** The turns whose requested effort is kept for one task, newest last: as many as its run list. */
export const MAX_REQUESTED_EFFORTS = 32;
/** The tasks whose lines and efforts the storage keeps, most recently changed last. */
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
  outcome: "changed" | "refused";
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

/**
 * The effort a turn this app started asked for (25.5): the task's own level
 * (`thinkingLevel`, which a change of effort writes) or, with none, the
 * default its row reported (`thinkingDefault`), when the message was sent.
 */
export type RequestedEffort = {
  runId: string;
  effort: string;
  from: "thinkingLevel" | "thinkingDefault";
};

export type TaskModelView = {
  catalog: "idle" | "loading" | "ready" | "error";
  catalogError: string | null;
  /** The models of the task's provider, as `models.list {sessionKey}` lists them. */
  models: CatalogModel[];
  /** The account the task's conversation selected (`accountSelection`), if it selected one. */
  account: string | null;
  /** A change made while a turn was active, saved once it settles. */
  held: (TaskModelChoice & { at: number; sessionId: string | null }) | null;
  saving: boolean;
  /** The last refusal, until the next change. */
  refused: { error: string; at: number } | null;
  events: TaskModelEvent[];
  requested: RequestedEffort[];
};

export const emptyTaskModel: TaskModelView = {
  catalog: "idle",
  catalogError: null,
  models: [],
  account: null,
  held: null,
  saving: false,
  refused: null,
  events: [],
  requested: [],
};

/** What the engine needs from the client. */
export type TaskModelsContext = {
  request(method: string, params: unknown): Promise<unknown>;
  get(): Record<string, TaskModelView>;
  update(change: (all: Record<string, TaskModelView>) => Record<string, TaskModelView>): void;
  /** The task's row as the gateway last listed it. */
  task(key: string): Task | null;
  /** The account a bot is bound to, if it is bound to one. */
  botAccount(botId: string): string | null;
  /** A turn of the task is running, waiting for the person, or stopping. */
  active(key: string): boolean;
  /** The gateway's time of the end of the task's last turn, or of its last message. */
  lastTurnEnd(key: string): number | null;
  connected(): boolean;
  canWrite(): boolean;
  /** Write access, held already: nothing here asks for it (25.6). */
  ensureWrite(): Promise<void>;
  /** The task's row as the gateway's answer to a patch now has it. */
  applyRow(key: string, fields: RawRecord): void;
  /** Read the task list again, so the row shows what the gateway has. */
  refreshTasks(): void;
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
  return {
    model: held?.model ?? task?.model ?? null,
    effort: held?.effort ?? rowEffort(task),
    held: held !== null,
  };
}

/** The words of a line (25.4). */
export function taskModelLine(event: TaskModelEvent, word: (level: string) => string): string {
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

type LogEntry = { events: TaskModelEvent[]; requested: RequestedEffort[] };

/** One stored line, read back as untrusted: anything of the wrong shape is dropped. */
function readEvent(value: unknown): TaskModelEvent | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const id = shortId(raw.id);
  const outcome = raw.outcome === "changed" || raw.outcome === "refused" ? raw.outcome : null;
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
    const requested = (Array.isArray(entry.requested) ? entry.requested : [])
      .slice(-MAX_REQUESTED_EFFORTS)
      .flatMap((each): RequestedEffort[] => {
        const raw = asRecord(each);
        const runId = shortId(raw?.runId);
        const effort = shortId(raw?.effort);
        const from = raw?.from === "thinkingLevel" ? "thinkingLevel" : "thinkingDefault";
        return runId && effort ? [{ runId, effort, from }] : [];
      });
    out.push([key, { events, requested }]);
  }
  return out;
}

const mergeEvents = (a: TaskModelEvent[], b: TaskModelEvent[]) => {
  const byId = new Map<string, TaskModelEvent>();
  for (const event of [...a, ...b]) byId.set(event.id, event);
  return [...byId.values()].sort((x, y) => x.at - y.at).slice(-MAX_TASK_MODEL_EVENTS);
};
const mergeRequested = (a: RequestedEffort[], b: RequestedEffort[]) => {
  const byId = new Map<string, RequestedEffort>();
  for (const each of [...a, ...b]) {
    byId.delete(each.runId);
    byId.set(each.runId, each);
  }
  return [...byId.values()].slice(-MAX_REQUESTED_EFFORTS);
};

/** Write access is missing: the chip is not offered then, so this is not asked for (25.6). */
export class TaskModelAccessError extends Error {
  constructor() {
    super("Changing this task's model needs a connection that can send.");
    this.name = "TaskModelAccessError";
  }
}

export class TaskModelsEngine {
  private readonly ctx: TaskModelsContext;
  /** A save on its way, per followed task: a message to that task waits for it. */
  private readonly saves = new Map<string, Promise<void>>();
  /** Reads and writes of the storage key, one after another. */
  private storing: Promise<void> = Promise.resolve();

  constructor(ctx: TaskModelsContext) {
    this.ctx = ctx;
  }

  private patch(key: string, change: (view: TaskModelView) => TaskModelView): void {
    this.ctx.update((all) => (all[key] ? { ...all, [key]: change(all[key]) } : all));
  }

  /** A task is followed: its view, its lines and efforts from the storage, and its models. */
  open(key: string): void {
    if (this.ctx.get()[key]) return;
    this.ctx.update((all) => ({ ...all, [key]: emptyTaskModel }));
    void this.loadLog(key);
    if (this.ctx.connected()) void this.readCatalog(key);
  }

  /** A task is let go. Its record stays in the storage. */
  close(key: string): void {
    if (this.hasWork(key)) return;
    this.ctx.update((all) => {
      if (!all[key]) return all;
      const next = { ...all };
      delete next[key];
      return next;
    });
  }

  /** A change waits or is on its way: the task is kept followed until it is saved. */
  hasWork(key: string): boolean {
    return this.saves.has(key) || (this.ctx.get()[key]?.held ?? null) !== null;
  }

  /** After a reconnect: every followed task's models again, and any held change once nothing runs. */
  reconnected(): void {
    for (const key of Object.keys(this.ctx.get())) {
      void this.loadLog(key);
      void this.readCatalog(key);
      this.ctx.released(key);
    }
  }

  /** `models.list {sessionKey}`: the models of the task's provider, and the account it selected. */
  async readCatalog(key: string): Promise<void> {
    if (!this.ctx.get()[key]) return;
    this.patch(key, (view) => ({
      ...view,
      catalog: view.catalog === "ready" ? "ready" : "loading",
    }));
    try {
      const answer = await onceMore(() => this.ctx.request("models.list", { sessionKey: key }));
      const provider = parseModelRef(this.ctx.task(key)?.model)?.provider ?? null;
      const models = readCatalog(answer)
        .filter((each) => provider === null || each.provider === provider)
        .slice(0, MAX_TASK_MODELS);
      const selection = asRecord(asRecord(answer)?.accountSelection);
      const account = selection?.kind === "shared" ? shortId(selection.authProfileId) : null;
      this.patch(key, (view) => ({
        ...view,
        catalog: "ready",
        catalogError: null,
        models,
        account,
      }));
    } catch (error) {
      this.patch(key, (view) => ({
        ...view,
        catalog: "error",
        catalogError: cut(errorText(error), MAX_TASK_MODEL_ERROR_CHARS),
      }));
    }
  }

  /**
   * The effort the task asks the gateway for now, as its row names it: its own
   * level, else the default the gateway reports for it. Taken when a message
   * that starts a turn is sent. Nothing is added to the message itself: a
   * `chat.send` that carries `thinking` and is stopped at once stays listed by
   * the gateway as a cancelled pending input.
   */
  effortAsked(key: string): Pick<RequestedEffort, "effort" | "from"> | null {
    const task = this.ctx.task(key);
    if (task?.effort) return { effort: task.effort, from: "thinkingLevel" };
    if (task?.effortDefault) return { effort: task.effortDefault, from: "thinkingDefault" };
    return null;
  }

  /** What a turn asked for, by the run the gateway named for it. */
  recordRequested(
    key: string,
    runId: string,
    asked: Pick<RequestedEffort, "effort" | "from">,
  ): void {
    const kept = shortId(runId);
    const effort = shortId(asked.effort);
    if (!kept || !effort || !this.ctx.get()[key]) return;
    this.patch(key, (view) => ({
      ...view,
      requested: mergeRequested(view.requested, [{ runId: kept, effort, from: asked.from }]),
    }));
    this.persist(key);
  }

  /**
   * The person chose a model, an effort, or both (25.3). Saved at once when no
   * turn of the task is active, otherwise held. Choosing what the task has
   * already lets go of a held change.
   */
  async choose(key: string, choice: TaskModelChoice): Promise<"saved" | "held" | "unchanged"> {
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
    if (this.ctx.active(key) || this.saves.has(key) || !this.ctx.connected()) {
      this.patch(key, (current) => ({
        ...current,
        held: { ...desired, at: this.ctx.now(), sessionId: held?.sessionId ?? task.sessionId },
        refused: null,
      }));
      return "held";
    }
    await this.save(key, desired, task.sessionId);
    return "saved";
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
    if (this.saves.has(key)) return true;
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
    return this.saves.get(key) ?? Promise.resolve();
  }

  /** The model to write: with the account the task selected, else the bot's, of the same provider. */
  private withAccount(key: string, model: string): string {
    const ref = parseModelRef(model);
    if (!ref) return model;
    const task = this.ctx.task(key);
    const own = this.ctx.get()[key]?.account ?? null;
    const bot = task ? this.ctx.botAccount(task.botId) : null;
    const account = [own, bot].find((each) => each?.startsWith(`${ref.provider}:`)) ?? null;
    return `${ref.provider}/${ref.model}${account ? `@${account}` : ""}`;
  }

  private save(key: string, desired: TaskModelChoice, sessionId: string | null): Promise<void> {
    const run = (async () => {
      const task = this.ctx.task(key);
      const view = this.ctx.get()[key];
      if (!task || !view) {
        // Gone since the change was held: dropped here, so nothing releases it again.
        this.drop(key);
        return;
      }
      const change = this.writes(task, view, desired);
      this.patch(key, (current) => ({ ...current, held: null, refused: null }));
      if (!change.model && !change.effort) return;
      const wasModel = task.model ?? null;
      const wasEffort = rowEffort(task);
      const effort = desired.effort && desired.effort !== wasEffort ? desired.effort : null;
      const followed =
        change.model !== null &&
        effort !== null &&
        wasEffort !== null &&
        !(catalogEntry(view.models, change.model)?.levels.includes(wasEffort) ?? true);
      const params: RawRecord = { key };
      if (change.model) params.model = this.withAccount(key, change.model);
      if (change.effort) params.thinkingLevel = change.effort;
      // A task replaced or removed meanwhile is refused, never made again (25.3).
      if (sessionId) params.expectedSessionId = sessionId;
      this.patch(key, (current) => ({ ...current, saving: true }));
      const event = (outcome: TaskModelEvent["outcome"], error: string | null): TaskModelEvent => ({
        id: this.ctx.randomId(),
        outcome,
        at: this.ctx.now(),
        after: this.ctx.lastTurnEnd(key) ?? this.ctx.now(),
        model: change.model,
        effort,
        wasModel,
        wasEffort,
        followed,
        error,
        sessionId,
      });
      try {
        await this.ctx.ensureWrite();
        let answer: RawRecord | null = null;
        for (let attempt = 0; ; attempt += 1) {
          try {
            answer = asRecord(await this.ctx.request("sessions.patch", params));
            break;
          } catch (error) {
            const wait = retryAfter(error, attempt);
            if (wait === null || attempt + 1 >= MAX_SAVE_ATTEMPTS || !this.ctx.connected())
              throw error;
            await (this.ctx.pause ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(wait);
          }
        }
        const resolved = asRecord(answer?.resolved);
        const entry = asRecord(answer?.entry);
        const fields: RawRecord = {};
        if (typeof resolved?.model === "string") fields.model = resolved.model;
        if (typeof resolved?.modelProvider === "string")
          fields.modelProvider = resolved.modelProvider;
        if (typeof entry?.thinkingLevel === "string") fields.thinkingLevel = entry.thinkingLevel;
        if (typeof entry?.sessionId === "string") fields.sessionId = entry.sessionId;
        this.ctx.applyRow(key, fields);
        const saved = event("changed", null);
        this.patch(key, (current) => ({
          ...current,
          saving: false,
          events: mergeEvents(current.events, [saved]),
        }));
      } catch (error) {
        const reason = cut(errorText(error), MAX_TASK_MODEL_ERROR_CHARS);
        this.ctx.log(`the change of ${key}'s model was not saved: ${reason}`);
        const refused = event("refused", reason);
        this.patch(key, (current) => ({
          ...current,
          saving: false,
          refused: { error: reason, at: refused.at },
          events: mergeEvents(current.events, [refused]),
        }));
        // What the gateway has now, whatever that is.
        this.ctx.refreshTasks();
      }
      this.persist(key);
      void this.readCatalog(key);
    })();
    const tracked = run.finally(() => {
      if (this.saves.get(key) === tracked) this.saves.delete(key);
      this.ctx.released(key);
    });
    this.saves.set(key, tracked);
    return tracked;
  }

  // The record on this device ----------------------------------------------------------------

  private chain(step: () => Promise<void>): Promise<void> {
    const next = this.storing.then(step, step).catch((error: unknown) => {
      this.ctx.log(`the task model record was not read or written: ${errorText(error)}`);
    });
    this.storing = next;
    return next;
  }

  private loadLog(key: string): Promise<void> {
    return this.chain(async () => {
      const storageKey = this.ctx.storageKey();
      if (!storageKey) return;
      const entry = readLog(await this.ctx.storage.get(storageKey)).find(([k]) => k === key)?.[1];
      if (!entry) return;
      this.patch(key, (view) => ({
        ...view,
        events: mergeEvents(entry.events, view.events),
        requested: mergeRequested(entry.requested, view.requested),
      }));
    });
  }

  private persist(key: string): void {
    void this.chain(async () => {
      const storageKey = this.ctx.storageKey();
      const view = this.ctx.get()[key];
      if (!storageKey || !view) return;
      const tasks = readLog(await this.ctx.storage.get(storageKey)).filter(([k]) => k !== key);
      tasks.push([key, { events: view.events, requested: view.requested }]);
      await this.ctx.storage.set(
        storageKey,
        JSON.stringify({ v: 1, tasks: tasks.slice(-MAX_LOGGED_TASKS) }),
      );
    });
  }
}
