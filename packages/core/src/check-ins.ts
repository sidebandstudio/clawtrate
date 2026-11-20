// A bot's proactive check-ins: the gateway's heartbeat (automation.md section
// 13). What will run is the bot's heartbeat job in `cron.list` (read tier);
// what was set is `agents.entries.<bot>.heartbeat` in the config, written with
// one `config.patch` (admin). Facts this rests on, read in OpenClaw 2026.10.6's
// `resolveHeartbeatAgentIds` and observed on it (docs/decisions.md, "Check-ins"):
// - any bot with a `heartbeat` of its own (even `{}`): only those bots have a job;
// - else `agents.defaults.heartbeat.agentId`: only that bot;
// - else an `agents.defaults.heartbeat` block: every bot in the config;
// - else the gateway's ambient owner, from the config (`tryResolveAmbientOwnerAgentId`);
// - a bot's cadence is its own `every`, else the default's, else "30m";
// - the job list is re-derived only when a heartbeat setting changes, so it can
//   name an owner the config no longer does: enrollment is read from the config;
// - `every: "0m"` keeps the bot's job with `enabled: false` (and its old `everyMs`);
// - the job cannot be edited with `cron.update` ("system-owned monitor jobs").

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { asRecord, type RawRecord } from "./mapping.ts";

/** The longest prompt kept and edited here; a longer one is shown cut and left as it is. */
export const MAX_CHECKIN_PROMPT_CHARS = 4_000;
/** The `every` values Clawtrate writes. */
export const CHECKIN_EVERY = /^(\d{1,9})(ms|s|m|h)$/;
/** The longest `every` kept and written back; a longer one is never written back cut. */
export const MAX_CHECKIN_EVERY_CHARS = 64;
/** The most bots a save may also write: one per bot Clawtrate lists. */
export const MAX_CHECKIN_KEPT = 32;
export const KEEP_TOO_MANY = `More than ${MAX_CHECKIN_KEPT} other bots check in through the gateway's default, and Clawtrate writes at most ${MAX_CHECKIN_KEPT} of them in one change.`;
export const KEEP_TOO_LONG =
  "The cadence the gateway's default gives is longer than Clawtrate writes back.";
export const CHECKIN_BOT_DELETED = "This bot was deleted while you were editing.";
const READ_BACK_MS = 20_000;
const READ_BACK_EVERY_MS = 500;
const JOB_PAGE = 200;
/** Past this many pages of jobs (10,000), the list is not read whole and nothing is confirmed by it. */
const MAX_JOB_PAGES = 50;
/** Reads of the whole list begun again because it changed between pages, as the gateway's own CLI does. */
const MAX_JOB_RESTARTS = 3;

/** The bot's heartbeat job as `cron.list` returns it: what will actually run. */
export type CheckInJob = {
  botId: string;
  enabled: boolean;
  everyMs: number | null;
  nextRunAtMs: number | null;
};

/** A bot's own `agents.entries.<bot>.heartbeat`, as the config holds it. */
export type CheckInSetting = {
  botId: string;
  every: string | null;
  /** Null: the default's prompt. */
  prompt: string | null;
  /** The prompt was longer than `MAX_CHECKIN_PROMPT_CHARS`; `prompt` is its start and is not written back. */
  promptCut: boolean;
};

/** What a bot without a setting of its own gets, from the same config read as the settings. */
export type CheckInDefaults = {
  /**
   * The bots that check in now through the default, and would stop once any
   * bot has its own: up to one more than `MAX_CHECKIN_KEPT`, since the bot
   * being saved is not kept.
   */
  inherited: string[];
  /** More bots inherit than `inherited` holds. */
  inheritedCut: boolean;
  /** The cadence they inherit, exactly as the config gives it, unless `everyCut`. */
  every: string;
  /** The cadence is longer than `MAX_CHECKIN_EVERY_CHARS`: `every` is its start and is never written. */
  everyCut: boolean;
  /** `agents.defaults.heartbeat.prompt`; null for the gateway's built-in prompt. */
  prompt: string | null;
  promptCut: boolean;
};

/**
 * One save, tied to the draft it wrote. `unknown`: the gateway may have
 * applied it, but Clawtrate could not establish that it did. `conflict`:
 * nothing was written, because the gateway changed under the draft.
 */
export type CheckInSave = {
  id: string;
  botId: string;
  status: "saving" | "saved" | "failed" | "unknown" | "conflict";
  error: string | null;
};

export type CheckInsState = {
  status: "loading" | "ready" | "error";
  error: string | null;
  /** The identity (`gateway.identity.get`) of the gateway this was read from; null once its connection closed. */
  gatewayId: string | null;
  /** `cron.status` `enabled`: false means no scheduled check-in runs; null when not read. */
  scheduler: boolean | null;
  jobs: CheckInJob[];
  /** The bots' own settings; null when the config could not be read. */
  settings: CheckInSetting[] | null;
  defaults: CheckInDefaults | null;
  save: CheckInSave | null;
};

export type CheckInRead = Pick<CheckInsState, "gatewayId" | "jobs" | "settings" | "defaults">;

/** A bot another save also writes, at the cadence it inherits now. */
export type CheckInKept = { botId: string; every: string };

/**
 * What a save asks. `every` and `prompt` are null when the person left them
 * as they were ("" prompt: the default's). `was` is the bot's own setting the
 * draft started from, and `kept` the other bots the dialog said it would also
 * write: if the gateway's config no longer matches them, nothing is written.
 * `gatewayId` is the gateway the draft was made on; no other is written.
 */
export type CheckInDraft = {
  gatewayId: string;
  every: string | null;
  prompt: string | null;
  was: { every: string | null; prompt: string | null };
  kept: CheckInKept[];
};

/** One open connection: requests go to it alone, and `alive` turns false once it is gone. */
export type CheckInsLink = {
  request(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  alive(): boolean;
};

export type CheckInsContext = {
  link(): CheckInsLink;
  /** The current connection's gateway identity, once `gateway.identity.get` answered; null if it gave none. */
  gateway(): Promise<string | null>;
  /** Marks a read begun; the check turns false once a later one begins, and its answer is then not shown. */
  begin(): () => boolean;
  get(): CheckInsState | undefined;
  set(next: CheckInsState): void;
  botIds(): string[];
  admin(): boolean;
  checkNotWithdrawn?(): void;
  now(): number;
  sleep(ms: number): Promise<void>;
};

const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** A duration as the gateway parses `every` (minutes when no unit), or null when it would not run. */
export function durationMs(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  const single = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(text);
  let total = 0;
  if (single) total = Number(single[1]) * UNITS[single[2] ?? "m"]!;
  else {
    let consumed = 0;
    for (const match of text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) {
      if (match.index !== consumed) return null;
      total += Number(match[1]) * UNITS[match[2]!]!;
      consumed += match[0].length;
    }
    if (consumed === 0 || consumed !== text.length) return null;
  }
  const ms = Math.round(total);
  return Number.isSafeInteger(ms) ? ms : null;
}

/** `every` for a cadence in milliseconds, exactly, in the largest unit that divides it. */
export function everyText(ms: number): string {
  for (const [unit, size] of [
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1_000],
  ] as const) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}

/** Every heartbeat job among the gateway's jobs, one per bot. */
export function readJobs(answer: unknown): CheckInJob[] {
  const jobs = asRecord(answer)?.jobs;
  if (!Array.isArray(jobs)) return [];
  const out: CheckInJob[] = [];
  for (const raw of jobs) {
    const job = asRecord(raw);
    if (asRecord(job?.payload)?.kind !== "heartbeat") continue;
    const botId = job?.agentId;
    if (typeof botId !== "string" || out.some((each) => each.botId === botId)) continue;
    const schedule = asRecord(job?.schedule);
    const every = schedule?.kind === "every" ? schedule.everyMs : null;
    const next = asRecord(job?.state)?.nextRunAtMs;
    out.push({
      botId,
      enabled: job?.enabled === true,
      everyMs: typeof every === "number" && every > 0 ? every : null,
      nextRunAtMs: typeof next === "number" ? next : null,
    });
  }
  return out;
}

const configData = (answer: unknown) => {
  const result = asRecord(answer);
  return result?.valid === false ? null : asRecord(result?.config);
};
const agentsOf = (config: unknown) => asRecord(configData(config)?.agents);
const entriesOf = (config: unknown) => asRecord(agentsOf(config)?.entries);
const prompt = (value: unknown) => {
  const text = typeof value === "string" ? value : null;
  return {
    prompt: text?.slice(0, MAX_CHECKIN_PROMPT_CHARS) ?? null,
    promptCut: (text?.length ?? 0) > MAX_CHECKIN_PROMPT_CHARS,
  };
};

/** The bots' own heartbeat settings in a `config.get` answer. */
export function readSettings(config: unknown, botIds: readonly string[]): CheckInSetting[] {
  const all = entriesOf(config);
  const out: CheckInSetting[] = [];
  for (const botId of botIds) {
    const heartbeat = asRecord(asRecord(all?.[botId])?.heartbeat);
    if (!heartbeat) continue;
    out.push({
      botId,
      every:
        typeof heartbeat.every === "string"
          ? heartbeat.every.slice(0, MAX_CHECKIN_EVERY_CHARS)
          : null,
      ...prompt(heartbeat.prompt),
    });
  }
  return out;
}

const VALID_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
/** A bot id as the gateway normalizes it (`normalizeAgentId`). */
function agentId(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (VALID_ID.test(raw.trim())) return lower;
  const cleaned = lower
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return cleaned || "main";
}
const named = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? agentId(value) : null;

/**
 * Every bot that checks in through the default, by the gateway's rules (top of
 * this file); none once any bot has a setting of its own. From the config
 * alone, so it agrees with the `baseHash` read with it.
 */
function enrolledByDefault(agents: RawRecord | null): string[] {
  const entries = asRecord(agents?.entries) ?? {};
  const ids = Object.keys(entries).filter((id) => asRecord(entries[id]));
  if (ids.some((id) => asRecord(entries[id])!.heartbeat)) return [];
  const defaults = asRecord(agents?.defaults);
  const heartbeat = defaults?.heartbeat;
  const owner = named(asRecord(heartbeat)?.agentId);
  if (owner) return ids.filter((id) => id === owner);
  if (heartbeat) return [...new Set(ids.map(agentId))].filter((id) => ids.includes(id));
  // The ambient owner: the system agent, else the one bot marked default, else the only bot.
  const system = named(asRecord(defaults?.systemAgent)?.agentId);
  if (system) return ids.filter((id) => id === system);
  const marked = ids.filter((id) => asRecord(entries[id])!.default === true);
  const ambient = agents?.ownership !== "explicit" && marked.length === 1 ? marked : ids;
  return ambient.length === 1 ? ids.filter((id) => id === agentId(ambient[0]!)) : [];
}

/** The cadence a bot without its own `every` gets, exactly as the config gives it. */
function inheritedEvery(agents: RawRecord | null): string {
  const every = asRecord(asRecord(agents?.defaults)?.heartbeat)?.every;
  return typeof every === "string" ? every : "30m";
}

/** Who checks in through the default, and with what, by the gateway's rules (top of this file). */
export function readDefaults(config: unknown): CheckInDefaults {
  const agents = agentsOf(config);
  const defaults = asRecord(asRecord(agents?.defaults)?.heartbeat);
  const inherited = enrolledByDefault(agents);
  const every = inheritedEvery(agents);
  return {
    inherited: inherited.slice(0, MAX_CHECKIN_KEPT + 1),
    inheritedCut: inherited.length > MAX_CHECKIN_KEPT + 1,
    every: every.slice(0, MAX_CHECKIN_EVERY_CHARS),
    everyCut: every.length > MAX_CHECKIN_EVERY_CHARS,
    ...prompt(defaults?.prompt),
  };
}

/** The other bots a save for `botId` also writes, so that they keep checking in. */
export function keptByDefault(
  botId: string,
  settings: readonly CheckInSetting[] | null,
  defaults: CheckInDefaults | null,
): CheckInKept[] {
  if (!settings || !defaults || settings.some((each) => each.botId === botId)) return [];
  return defaults.inherited
    .filter((id) => id !== botId)
    .map((id) => ({ botId: id, every: defaults.every }));
}

/** Why a save for `botId` cannot also write the bots it would have to keep, or null when it can. */
export function cannotKeep(
  botId: string,
  settings: readonly CheckInSetting[] | null,
  defaults: CheckInDefaults | null,
): string | null {
  const kept = keptByDefault(botId, settings, defaults);
  if (kept.length === 0) return null;
  if (defaults!.inheritedCut || kept.length > MAX_CHECKIN_KEPT) return KEEP_TOO_MANY;
  return defaults!.everyCut ? KEEP_TOO_LONG : null;
}

/** The jobs show `every` for this bot: Off a disabled job, a cadence an enabled job at it. */
function shows(jobs: readonly CheckInJob[], botId: string, every: string): boolean {
  const job = jobs.find((each) => each.botId === botId);
  const ms = every === "" ? 0 : durationMs(every);
  if (!job || ms === null) return false;
  return ms === 0 ? !job.enabled : job.enabled && job.everyMs === ms;
}

const emptyState = (): CheckInsState => ({
  status: "loading",
  error: null,
  gatewayId: null,
  scheduler: null,
  jobs: [],
  settings: null,
  defaults: null,
  save: null,
});

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Every page of heartbeat jobs: the list is read whole or not at all. Pages
 * of one read carry the same `snapshotRevision` and `total`; when either
 * changes between pages the jobs moved, and the read begins again.
 */
async function readAllJobs(request: CheckInsLink["request"]): Promise<CheckInJob[]> {
  for (let restart = 0; restart <= MAX_JOB_RESTARTS; restart += 1) {
    const out: CheckInJob[] = [];
    let offset = 0;
    let first: RawRecord | null = null;
    let moved = false;
    for (let page = 0; page < MAX_JOB_PAGES && !moved; page += 1) {
      const answer = asRecord(
        await request("cron.list", {
          includeDisabled: true,
          scheduleKind: "every",
          limit: JOB_PAGE,
          offset,
        }),
      );
      first ??= answer;
      if (answer?.snapshotRevision !== first?.snapshotRevision || answer?.total !== first?.total) {
        moved = true;
        break;
      }
      for (const job of readJobs(answer))
        if (!out.some((each) => each.botId === job.botId)) out.push(job);
      if (answer?.hasMore !== true) return out;
      const next = answer.nextOffset;
      if (typeof next !== "number" || next <= offset)
        throw new Error("The gateway's list of scheduled jobs couldn't be read whole.");
      offset = next;
    }
    if (!moved) throw new Error("The gateway has too many scheduled jobs to read whole.");
  }
  throw new Error("The gateway's scheduled jobs kept changing while Clawtrate read them.");
}

type Snapshot = {
  hash: string | null;
  config: unknown;
  jobs: CheckInJob[];
  /** All of them, not only the listed bots'. */
  allJobs: CheckInJob[];
  scheduler: boolean | null;
  settings: CheckInSetting[] | null;
  defaults: CheckInDefaults | null;
};

/**
 * One config read and the jobs read after it. `required`: a config that
 * cannot be read fails. `deadline` (on `ctx.now()`): no request waits past it.
 */
async function read(
  ctx: CheckInsContext,
  link: CheckInsLink,
  { required = false, deadline }: { required?: boolean; deadline?: number } = {},
): Promise<Snapshot> {
  const bots = ctx.botIds();
  const request = (method: string, params: unknown) => {
    if (deadline === undefined) return link.request(method, params);
    const left = deadline - ctx.now();
    if (left <= 0) return Promise.reject(new Error("The check-in confirmation timed out."));
    return link.request(method, params, { timeoutMs: left });
  };
  const configRead = request("config.get", {});
  const [config, allJobs, status] = await Promise.all([
    required ? configRead : configRead.catch(() => null),
    readAllJobs(request),
    request("cron.status", {}).catch(() => null),
  ]);
  const hash = asRecord(config)?.hash;
  const enabled = asRecord(status)?.enabled;
  return {
    // A blank hash is no hash: the gateway reads it as missing.
    hash: typeof hash === "string" && hash.trim() !== "" ? hash : null,
    config,
    allJobs,
    jobs: allJobs.filter((job) => bots.includes(job.botId)),
    scheduler: typeof enabled === "boolean" ? enabled : null,
    settings: configData(config) ? readSettings(config, bots) : null,
    defaults: configData(config) ? readDefaults(config) : null,
  };
}

const shown = ({ jobs, scheduler, settings, defaults }: Snapshot) => ({
  jobs,
  scheduler,
  settings,
  defaults,
});

/** Read the bots' check-ins: their jobs, the scheduler, their own settings and the default. */
export async function loadCheckIns(
  ctx: CheckInsContext,
  botId?: string,
  link = ctx.link(),
): Promise<CheckInRead | null> {
  if (!link.alive()) return null;
  if (!ctx.get()) ctx.set(emptyState());
  const latest = ctx.begin();
  // What is read is tied to the gateway that answered, so a draft is never carried to another.
  try {
    const gatewayId = await ctx.gateway();
    const next = await read(ctx, link);
    if (!link.alive() || !latest()) return null;
    ctx.set({
      ...(ctx.get() ?? emptyState()),
      ...shown(next),
      gatewayId,
      status: "ready",
      error: null,
    });
    if (!botId || gatewayId === null || next.settings === null) return null;
    return {
      gatewayId,
      jobs: next.jobs.filter((job) => job.botId === botId),
      settings: next.settings.filter((setting) => setting.botId === botId),
      defaults: next.defaults,
    };
  } catch (error) {
    if (link.alive() && latest())
      ctx.set({ ...(ctx.get() ?? emptyState()), status: "error", error: message(error) });
    return null;
  }
}

/** Nothing was applied: the gateway refused it for certain, or it was never sent. */
function certainlyNotApplied(error: unknown): boolean {
  return (
    (error instanceof GatewayProtocolRequestError &&
      // The refusals `accounts-engine.ts` also reads as "not applied".
      [
        "INVALID_REQUEST",
        "INVALID_PARAMS",
        "BAD_REQUEST",
        "FORBIDDEN",
        "UNAUTHORIZED",
        "NOT_FOUND",
        "CONFLICT",
      ].includes(error.code)) ||
    (error instanceof Error && error.name === "NotSentError")
  );
}

const sameKept = (a: readonly CheckInKept[], b: readonly CheckInKept[]) =>
  a.length === b.length &&
  a.every((each) => b.some((other) => other.botId === each.botId && other.every === each.every));

const CHANGED = "Check-ins changed on the gateway since this dialog opened, so nothing was saved.";

/**
 * The one patch a save writes and what must be true once it took, or why it
 * cannot be written over this `config.get` answer: a `conflict` the person
 * can save over once they have seen it, or a save `refused` outright. Only
 * the fields the person changed are written, and the other bots only as the
 * draft disclosed. Everything here comes from the same config as `baseHash`.
 */
export function planCheckIn(
  botId: string,
  draft: CheckInDraft,
  config: unknown,
):
  | { conflict: string }
  | { refused: string }
  | { patch: RawRecord | null; own: RawRecord; expect: CheckInKept[] } {
  const agents = agentsOf(config);
  const entries = asRecord(agents?.entries);
  if (!entries) {
    return configData(config) && agents?.entries === undefined
      ? { conflict: CHECKIN_BOT_DELETED }
      : { refused: "Clawtrate couldn't read this gateway's bots from its config." };
  }
  const entry = asRecord(entries[botId]);
  if (!Object.hasOwn(entries, botId) || !entry) return { conflict: CHECKIN_BOT_DELETED };
  const raw = asRecord(entry.heartbeat);
  const setting = readSettings(config, [botId])[0];
  if (
    draft.every !== null &&
    typeof raw?.every === "string" &&
    raw.every.length > MAX_CHECKIN_EVERY_CHARS
  )
    return { refused: "This cadence is longer than Clawtrate edits." };
  if (draft.every !== null && (setting?.every ?? null) !== draft.was.every)
    return { conflict: `${CHANGED} Its cadence was changed.` };
  if (draft.prompt !== null && setting?.promptCut)
    return { conflict: `${CHANGED} Its prompt is now longer than Clawtrate edits.` };
  if (draft.prompt !== null && (setting?.prompt ?? null) !== draft.was.prompt)
    return { conflict: `${CHANGED} Its prompt was changed.` };
  const heartbeat: RawRecord = {};
  if (draft.every !== null) heartbeat.every = draft.every;
  if (draft.prompt !== null) heartbeat.prompt = draft.prompt.trim() === "" ? null : draft.prompt;
  const inherited = enrolledByDefault(agents);
  // Any setting of its own enrolls the bot: one that did not check in stays off.
  if (!raw && !inherited.includes(botId) && draft.every === null && draft.prompt !== null)
    heartbeat.every = "0m";
  if (Object.keys(heartbeat).length === 0) return { patch: null, own: {}, expect: [] };
  const every = inheritedEvery(agents);
  const kept = inherited.filter((id) => id !== botId).map((id) => ({ botId: id, every }));
  if (kept.length > MAX_CHECKIN_KEPT) return { refused: KEEP_TOO_MANY };
  if (kept.length > 0 && every.length > MAX_CHECKIN_EVERY_CHARS) return { refused: KEEP_TOO_LONG };
  if (!sameKept(kept, draft.kept))
    return { conflict: `${CHANGED} Which bots check in through the default changed.` };
  const patch: RawRecord = { [botId]: { heartbeat } };
  for (const each of kept) patch[each.botId] = { heartbeat: { every: each.every } };
  // Once written, the bot has a setting of its own, so it has a job, at the cadence the gateway resolves.
  const own = typeof raw?.every === "string" ? raw.every : every;
  return {
    patch: { agents: { entries: patch } },
    own: heartbeat,
    expect: [{ botId, every: (heartbeat.every as string | undefined) ?? own }, ...kept],
  };
}

/** The config holds what was written, and every affected job runs as it should. */
function took(
  snapshot: Snapshot,
  botId: string,
  own: RawRecord,
  expect: ReadonlyArray<{ botId: string; every: string }>,
): boolean {
  const heartbeat = asRecord(asRecord(entriesOf(snapshot.config)?.[botId])?.heartbeat);
  if (!heartbeat) return false;
  if ("every" in own && heartbeat.every !== own.every) return false;
  if ("prompt" in own && (heartbeat.prompt ?? null) !== own.prompt) return false;
  for (const each of expect) {
    if (each.botId === botId) {
      const every =
        typeof heartbeat.every === "string"
          ? heartbeat.every
          : inheritedEvery(agentsOf(snapshot.config));
      if (!shows(snapshot.allJobs, botId, every)) return false;
      continue;
    }
    const kept = asRecord(asRecord(entriesOf(snapshot.config)?.[each.botId])?.heartbeat);
    if (kept?.every !== each.every || !shows(snapshot.allJobs, each.botId, each.every))
      return false;
  }
  return true;
}

/**
 * Save one bot's check-ins in one `config.patch` over the config read just
 * before, then read the config and the jobs until both show it, for at most
 * `READ_BACK_MS` in all. Only then is it `saved`. Everything runs on the
 * connection open when it started, to the gateway the draft was made on.
 */
export async function saveCheckIn(
  ctx: CheckInsContext,
  saveId: string,
  botId: string,
  draft: CheckInDraft,
): Promise<void> {
  if (!ctx.admin()) throw new Error("Changing check-ins needs admin access.");
  if (draft.every !== null && !CHECKIN_EVERY.test(draft.every))
    throw new Error("invalid check-in cadence");
  const link = ctx.link();
  if (!link.alive()) throw new Error("Not connected to the gateway.");
  const here = await ctx.gateway();
  if (!link.alive()) throw new Error("The connection changed before the change was sent.");
  if (here === null || here !== draft.gatewayId)
    throw new Error("This change was made for another gateway, so nothing was sent.");
  if (ctx.get()?.save?.status === "saving") throw new Error("A save is under way.");
  const settle = (status: CheckInSave["status"], error: string | null, loading = false) => {
    const state = ctx.get();
    if (state?.save?.id !== saveId) return;
    ctx.set({
      ...state,
      ...(loading ? { status: "loading" as const } : {}),
      save: { ...state.save, status, error },
    });
  };
  const show = (latest: () => boolean, snapshot: Snapshot) => {
    if (link.alive() && latest())
      ctx.set({
        ...(ctx.get() ?? emptyState()),
        ...shown(snapshot),
        gatewayId: here,
        status: "ready",
        error: null,
      });
  };
  ctx.set({
    ...(ctx.get() ?? emptyState()),
    save: { id: saveId, botId, status: "saving", error: null },
  });
  const gone = "The connection changed before the change was sent. Nothing changed.";
  let fresh: Snapshot;
  const latest = ctx.begin();
  try {
    fresh = await read(ctx, link, { required: true });
  } catch (error) {
    return settle("failed", link.alive() ? message(error) : gone);
  }
  if (!link.alive()) return settle("failed", gone);
  const plan = planCheckIn(botId, draft, fresh.config);
  if ("conflict" in plan) {
    if (!latest()) {
      settle("conflict", plan.conflict, true);
      await loadCheckIns(ctx, undefined, link);
      return;
    }
    show(latest, fresh);
    return settle("conflict", plan.conflict);
  }
  if ("refused" in plan || !plan.patch) show(latest, fresh);
  if ("refused" in plan) return settle("failed", plan.refused);
  if (!plan.patch) return settle("saved", null);
  if (fresh.hash === null)
    return settle("failed", "The gateway's config had no version to change it against.");
  if (!ctx.admin()) return settle("failed", "Admin access ended before the change was sent.");
  try {
    ctx.checkNotWithdrawn?.();
  } catch (error) {
    return settle("failed", message(error));
  }
  try {
    await link.request("config.patch", { raw: JSON.stringify(plan.patch), baseHash: fresh.hash });
  } catch (error) {
    if (/changed since last load/i.test(message(error))) {
      // Said first, so the dialog never waits on the read that shows what changed.
      settle("conflict", CHANGED, link.alive());
      await loadCheckIns(ctx, undefined, link);
      return;
    }
    return settle(certainlyNotApplied(error) ? "failed" : "unknown", message(error));
  }
  const deadline = ctx.now() + READ_BACK_MS;
  while (link.alive() && ctx.now() < deadline) {
    const latest = ctx.begin();
    try {
      const next = await read(ctx, link, { required: true, deadline });
      if (!link.alive() || ctx.now() >= deadline) break;
      if (latest() && took(next, botId, plan.own, plan.expect)) {
        show(latest, next);
        return settle("saved", null);
      }
    } catch {
      // A read that failed says nothing about the save; read again while there is time.
    }
    const left = deadline - ctx.now();
    if (left <= 0) break;
    await ctx.sleep(Math.min(READ_BACK_EVERY_MS, left));
  }
  settle(
    "unknown",
    link.alive()
      ? "Clawtrate couldn't confirm the change: the gateway's config and check-in jobs didn't both show it."
      : "The connection changed before Clawtrate could confirm the change.",
  );
  await loadCheckIns(ctx, undefined, link);
}

/** Forget a save that ended, when its dialog closes. */
export function dismissCheckInSave(ctx: CheckInsContext, saveId: string): void {
  const state = ctx.get();
  if (state?.save?.id === saveId && state.save.status !== "saving")
    ctx.set({ ...state, save: null });
}
