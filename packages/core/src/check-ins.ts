// A bot's proactive check-ins: the gateway's heartbeat (automation.md section
// 13). What will run is the bot's heartbeat job in `cron.list` (read tier);
// what was set is `agents.entries.<bot>.heartbeat` in the config, written with
// one `config.patch` (admin). Facts this rests on, read in OpenClaw 2026.10.6's
// `resolveHeartbeatAgentIds` and observed on it (docs/decisions.md, "Check-ins"):
// - any bot with a `heartbeat` of its own (even `{}`): only those bots have a job;
// - else `agents.defaults.heartbeat.agentId`: only that bot;
// - else an `agents.defaults.heartbeat` block: every bot in the config;
// - else the gateway's ambient owner, which Clawtrate reads from the jobs;
// - a bot's cadence is its own `every`, else the default's, else "30m";
// - `every: "0m"` keeps the bot's job with `enabled: false` (and its old `everyMs`);
// - the job cannot be edited with `cron.update` ("system-owned monitor jobs").

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { asRecord, type RawRecord } from "./mapping.ts";

/** The longest prompt kept and edited here; a longer one is shown cut and left as it is. */
export const MAX_CHECKIN_PROMPT_CHARS = 4_000;
/** The `every` values Clawtrate writes. */
export const CHECKIN_EVERY = /^(\d{1,9})(ms|s|m|h)$/;
/** The most bots a save may also write: one per bot Clawtrate lists. */
export const MAX_CHECKIN_KEPT = 32;
const READ_BACK_MS = 20_000;
const READ_BACK_EVERY_MS = 500;
const JOB_PAGE = 200;
/** Past this many pages of jobs (10,000), the list is not read whole and nothing is confirmed by it. */
const MAX_JOB_PAGES = 50;

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
  /** The bots that check in now through the default, and would stop once any bot has its own. */
  inherited: string[];
  /** More bots inherit than `MAX_CHECKIN_KEPT`; a save that would have to write them all is refused. */
  inheritedCut: boolean;
  /** The cadence they inherit, exactly as the config gives it. */
  every: string;
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
  /** `cron.status` `enabled`: false means no scheduled check-in runs; null when not read. */
  scheduler: boolean | null;
  jobs: CheckInJob[];
  /** The bots' own settings; null when the config could not be read. */
  settings: CheckInSetting[] | null;
  defaults: CheckInDefaults | null;
  save: CheckInSave | null;
};

/** A bot another save also writes, at the cadence it inherits now. */
export type CheckInKept = { botId: string; every: string };

/**
 * What a save asks. `every` and `prompt` are null when the person left them
 * as they were ("" prompt: the default's). `was` is the bot's own setting the
 * draft started from, and `kept` the other bots the dialog said it would also
 * write: if the gateway's config no longer matches them, nothing is written.
 */
export type CheckInDraft = {
  every: string | null;
  prompt: string | null;
  was: { every: string | null; prompt: string | null };
  kept: CheckInKept[];
};

/** One open connection: requests go to it alone, and `alive` turns false once it is gone. */
export type CheckInsLink = {
  request(method: string, params: unknown): Promise<unknown>;
  alive(): boolean;
};

export type CheckInsContext = {
  link(): CheckInsLink;
  get(): CheckInsState | undefined;
  set(next: CheckInsState): void;
  botIds(): string[];
  admin(): boolean;
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

const agentsOf = (config: unknown) => asRecord(asRecord(asRecord(config)?.config)?.agents);
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
      every: typeof heartbeat.every === "string" ? heartbeat.every.slice(0, 64) : null,
      ...prompt(heartbeat.prompt),
    });
  }
  return out;
}

/** Who checks in through the default, and with what, by the gateway's rules (top of this file). */
export function readDefaults(config: unknown, jobs: readonly CheckInJob[]): CheckInDefaults {
  const agents = agentsOf(config);
  const entries = asRecord(agents?.entries) ?? {};
  const heartbeat = asRecord(agents?.defaults)?.heartbeat;
  const defaults = asRecord(heartbeat);
  const owner = typeof defaults?.agentId === "string" ? defaults.agentId.trim().toLowerCase() : "";
  let inherited: string[];
  if (Object.values(entries).some((entry) => asRecord(entry)?.heartbeat)) inherited = [];
  else if (owner) inherited = [owner];
  else if (heartbeat) inherited = Object.keys(entries).map((id) => id.toLowerCase());
  else inherited = jobs.map((job) => job.botId);
  return {
    inherited: inherited.slice(0, MAX_CHECKIN_KEPT),
    inheritedCut: inherited.length > MAX_CHECKIN_KEPT,
    every: typeof defaults?.every === "string" ? defaults.every.slice(0, 64) : "30m",
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

/** The jobs show `every` for this bot: Off a disabled job, a cadence an enabled job at it. */
function shows(jobs: readonly CheckInJob[], botId: string, every: string): boolean {
  const job = jobs.find((each) => each.botId === botId);
  const ms = durationMs(every);
  if (!job || ms === null) return false;
  return ms === 0 ? !job.enabled : job.enabled && job.everyMs === ms;
}

const emptyState = (): CheckInsState => ({
  status: "loading",
  error: null,
  scheduler: null,
  jobs: [],
  settings: null,
  defaults: null,
  save: null,
});

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Every page of heartbeat jobs: the list is read whole or not at all. */
async function readAllJobs(link: CheckInsLink): Promise<CheckInJob[]> {
  const out: CheckInJob[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_JOB_PAGES; page += 1) {
    const answer = await link.request("cron.list", {
      includeDisabled: true,
      scheduleKind: "every",
      limit: JOB_PAGE,
      offset,
    });
    for (const job of readJobs(answer))
      if (!out.some((each) => each.botId === job.botId)) out.push(job);
    const next = asRecord(answer)?.nextOffset;
    if (asRecord(answer)?.hasMore !== true || typeof next !== "number" || next <= offset)
      return out;
    offset = next;
  }
  throw new Error("The gateway has too many scheduled jobs to read whole.");
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

/** One config read and the jobs read after it; `required`: a config that cannot be read fails. */
async function read(ctx: CheckInsContext, link: CheckInsLink, required = false): Promise<Snapshot> {
  const bots = ctx.botIds();
  const configRead = link.request("config.get", {});
  const [config, allJobs, status] = await Promise.all([
    required ? configRead : configRead.catch(() => null),
    readAllJobs(link),
    link.request("cron.status", {}).catch(() => null),
  ]);
  const hash = asRecord(config)?.hash;
  const enabled = asRecord(status)?.enabled;
  return {
    hash: typeof hash === "string" ? hash : null,
    config,
    allJobs,
    jobs: allJobs.filter((job) => bots.includes(job.botId)),
    scheduler: typeof enabled === "boolean" ? enabled : null,
    settings: config ? readSettings(config, bots) : null,
    defaults: config ? readDefaults(config, allJobs) : null,
  };
}

const shown = ({ jobs, scheduler, settings, defaults }: Snapshot) => ({
  jobs,
  scheduler,
  settings,
  defaults,
});

/** Read the bots' check-ins: their jobs, the scheduler, their own settings and the default. */
export async function loadCheckIns(ctx: CheckInsContext): Promise<void> {
  const link = ctx.link();
  if (!link.alive()) return;
  if (!ctx.get()) ctx.set(emptyState());
  try {
    const next = await read(ctx, link);
    if (!link.alive()) return;
    ctx.set({ ...(ctx.get() ?? emptyState()), ...shown(next), status: "ready", error: null });
  } catch (error) {
    if (!link.alive()) return;
    ctx.set({ ...(ctx.get() ?? emptyState()), status: "error", error: message(error) });
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
 * cannot be written over this config. Only the fields the person changed are
 * written, and the other bots only as the draft disclosed.
 */
export function planCheckIn(
  botId: string,
  draft: CheckInDraft,
  snapshot: Pick<Snapshot, "config" | "settings" | "defaults">,
):
  | { conflict: string }
  | { patch: RawRecord | null; own: RawRecord; expect: Array<{ botId: string; every: string }> } {
  if (!entriesOf(snapshot.config) || !snapshot.settings || !snapshot.defaults)
    return { conflict: "Clawtrate couldn't read this gateway's bots from its config." };
  const { settings, defaults } = snapshot;
  const setting = settings.find((each) => each.botId === botId);
  if (draft.every !== null && (setting?.every ?? null) !== draft.was.every)
    return { conflict: `${CHANGED} Its cadence was changed.` };
  if (draft.prompt !== null && setting?.promptCut)
    return { conflict: `${CHANGED} Its prompt is now longer than Clawtrate edits.` };
  if (draft.prompt !== null && (setting?.prompt ?? null) !== draft.was.prompt)
    return { conflict: `${CHANGED} Its prompt was changed.` };
  const heartbeat: RawRecord = {};
  if (draft.every !== null) heartbeat.every = draft.every;
  if (draft.prompt !== null) heartbeat.prompt = draft.prompt.trim() === "" ? null : draft.prompt;
  const inherits = defaults.inherited.includes(botId);
  // Any setting of its own enrolls the bot: one that did not check in stays off.
  if (!setting && !inherits && draft.every === null && draft.prompt !== null)
    heartbeat.every = "0m";
  if (Object.keys(heartbeat).length === 0) return { patch: null, own: {}, expect: [] };
  const kept = keptByDefault(botId, settings, defaults);
  if (!sameKept(kept, draft.kept))
    return { conflict: `${CHANGED} Which bots check in through the default changed.` };
  if (kept.length > 0 && defaults.inheritedCut)
    return {
      conflict:
        "More bots check in through the default than Clawtrate can write in one change, so nothing was saved.",
    };
  const entries: RawRecord = { [botId]: { heartbeat } };
  for (const each of kept) entries[each.botId] = { heartbeat: { every: each.every } };
  const every =
    (heartbeat.every as string | undefined) ?? setting?.every ?? (inherits ? defaults.every : null);
  return {
    patch: { agents: { entries } },
    own: heartbeat,
    expect: [...(every === null ? [] : [{ botId, every }]), ...kept],
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
      if (!shows(snapshot.allJobs, botId, each.every)) return false;
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
 * before, then read the config and the jobs until both show it. Only then is
 * it `saved`. Everything runs on the connection open when it started.
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
  if (ctx.get()?.save?.status === "saving") throw new Error("A save is under way.");
  const link = ctx.link();
  if (!link.alive()) throw new Error("Not connected to the gateway.");
  const settle = (status: CheckInSave["status"], error: string | null) => {
    const state = ctx.get();
    if (state?.save?.id !== saveId) return;
    ctx.set({ ...state, save: { ...state.save, status, error } });
  };
  const show = (snapshot: Snapshot) => {
    if (link.alive())
      ctx.set({ ...(ctx.get() ?? emptyState()), ...shown(snapshot), status: "ready", error: null });
  };
  ctx.set({
    ...(ctx.get() ?? emptyState()),
    save: { id: saveId, botId, status: "saving", error: null },
  });
  const gone = "The connection changed before the change was sent. Nothing changed.";
  let fresh: Snapshot;
  try {
    fresh = await read(ctx, link, true);
  } catch (error) {
    return settle("failed", link.alive() ? message(error) : gone);
  }
  if (!link.alive()) return settle("failed", gone);
  const plan = planCheckIn(botId, draft, fresh);
  if ("conflict" in plan) {
    show(fresh);
    return settle("conflict", plan.conflict);
  }
  if (!plan.patch) {
    show(fresh);
    return settle("saved", null);
  }
  if (fresh.hash === null)
    return settle("failed", "The gateway's config had no version to change it against.");
  if (!ctx.admin()) return settle("failed", "Admin access ended before the change was sent.");
  try {
    await link.request("config.patch", { raw: JSON.stringify(plan.patch), baseHash: fresh.hash });
  } catch (error) {
    if (/changed since last load/i.test(message(error))) {
      await loadCheckIns(ctx);
      return settle("conflict", CHANGED);
    }
    return settle(certainlyNotApplied(error) ? "failed" : "unknown", message(error));
  }
  const started = ctx.now();
  for (let reads = 0; reads < 60 && ctx.now() - started < READ_BACK_MS; reads += 1) {
    if (!link.alive()) break;
    try {
      const next = await read(ctx, link, true);
      if (!link.alive()) break;
      if (took(next, botId, plan.own, plan.expect)) {
        show(next);
        return settle("saved", null);
      }
    } catch {
      // A read that failed says nothing about the save; read again.
    }
    await ctx.sleep(READ_BACK_EVERY_MS);
  }
  settle(
    "unknown",
    link.alive()
      ? "Clawtrate couldn't confirm the change: the gateway's config and check-in jobs didn't both show it."
      : "The connection changed before Clawtrate could confirm the change.",
  );
  await loadCheckIns(ctx);
}

/** Forget a save that ended, when its dialog closes. */
export function dismissCheckInSave(ctx: CheckInsContext, saveId: string): void {
  const state = ctx.get();
  if (state?.save?.id === saveId && state.save.status !== "saving")
    ctx.set({ ...state, save: null });
}
