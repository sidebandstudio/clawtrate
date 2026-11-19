// A bot's proactive check-ins: the gateway's heartbeat (automation.md section
// 13). What will run is the bot's heartbeat job in `cron.list` (read tier);
// what was set is `agents.entries.<bot>.heartbeat` in the config, written with
// one `config.patch` (admin). Facts this rests on, observed on OpenClaw
// 2026.10.6 (docs/decisions.md, "Check-ins"):
// - with no bot setting its own, only `agents.defaults.heartbeat.agentId` has a job;
//   once any bot has its own setting, only bots with their own setting have one;
// - `every: "0m"` keeps the bot's job with `enabled: false` (and its old `everyMs`);
// - the job cannot be edited with `cron.update` ("system-owned monitor jobs").

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { asRecord, type RawRecord } from "./mapping.ts";

/** The longest prompt kept and edited here; a longer one is shown cut and left as it is. */
export const MAX_CHECKIN_PROMPT_CHARS = 4_000;
/** The `every` values Clawtrate writes: minutes or hours, as the gateway's own examples write them. */
export const CHECKIN_EVERY = /^(\d{1,5})([mh])$/;
export const CHECKIN_OFF = "0m";
const READ_BACK_MS = 20_000;
const READ_BACK_EVERY_MS = 500;

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
  /** Null: the gateway's own prompt. */
  prompt: string | null;
  /** The prompt was longer than `MAX_CHECKIN_PROMPT_CHARS`; `prompt` is its start and is not written back. */
  promptCut: boolean;
};

/**
 * One save, tied to the draft it wrote. `unknown`: the gateway may have
 * applied it, but Clawtrate could not establish that it did.
 */
export type CheckInSave = {
  id: string;
  botId: string;
  every: string;
  status: "saving" | "saved" | "failed" | "unknown";
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
  save: CheckInSave | null;
};

/** What a save writes: `every`, and the prompt ("" for the gateway's own, null to leave it as it is). */
export type CheckInDraft = { every: string; prompt: string | null };

export type CheckInsContext = {
  request(method: string, params: unknown): Promise<unknown>;
  get(): CheckInsState | undefined;
  set(next: CheckInsState): void;
  botIds(): string[];
  admin(): boolean;
  /** Changes when the connection is replaced: a save across two connections is not known. */
  generation(): number;
  now(): number;
  sleep(ms: number): Promise<void>;
};

export function everyMs(every: string): number | null {
  const match = CHECKIN_EVERY.exec(every);
  if (!match) return null;
  return Number(match[1]) * (match[2] === "h" ? 3_600_000 : 60_000);
}

/** The bots' heartbeat jobs among the gateway's jobs. */
export function readJobs(answer: unknown, botIds: readonly string[]): CheckInJob[] {
  const jobs = asRecord(answer)?.jobs;
  if (!Array.isArray(jobs)) return [];
  const out: CheckInJob[] = [];
  for (const raw of jobs) {
    const job = asRecord(raw);
    if (asRecord(job?.payload)?.kind !== "heartbeat") continue;
    const botId = job?.agentId;
    if (typeof botId !== "string" || !botIds.includes(botId)) continue;
    if (out.some((each) => each.botId === botId)) continue;
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

const entries = (config: unknown) =>
  asRecord(asRecord(asRecord(asRecord(config)?.config)?.agents)?.entries);

/** The bots' own heartbeat settings in a `config.get` answer. */
export function readSettings(config: unknown, botIds: readonly string[]): CheckInSetting[] {
  const all = entries(config);
  const out: CheckInSetting[] = [];
  for (const botId of botIds) {
    const heartbeat = asRecord(asRecord(all?.[botId])?.heartbeat);
    if (!heartbeat) continue;
    const prompt = typeof heartbeat.prompt === "string" ? heartbeat.prompt : null;
    out.push({
      botId,
      every: typeof heartbeat.every === "string" ? heartbeat.every.slice(0, 64) : null,
      prompt: prompt?.slice(0, MAX_CHECKIN_PROMPT_CHARS) ?? null,
      promptCut: (prompt?.length ?? 0) > MAX_CHECKIN_PROMPT_CHARS,
    });
  }
  return out;
}

/** `every` for a cadence in milliseconds, in whole hours when it is one. */
export function everyText(ms: number): string {
  return ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${Math.max(1, Math.round(ms / 60_000))}m`;
}

/**
 * The one patch a save writes: the bot's setting, and the current cadence of
 * every other bot that checks in now through the gateway's default, which a
 * setting of this bot's own would otherwise stop.
 */
export function checkInPatch(
  botId: string,
  draft: CheckInDraft,
  jobs: readonly CheckInJob[],
  settings: readonly CheckInSetting[],
): RawRecord {
  const heartbeat: RawRecord = { every: draft.every };
  if (draft.prompt !== null) heartbeat.prompt = draft.prompt.trim() === "" ? null : draft.prompt;
  const out: RawRecord = { [botId]: { heartbeat } };
  for (const job of jobs) {
    if (job.botId === botId || !job.enabled || job.everyMs === null) continue;
    if (settings.some((each) => each.botId === job.botId)) continue;
    out[job.botId] = { heartbeat: { every: everyText(job.everyMs) } };
  }
  return { agents: { entries: out } };
}

/** The bots that keep checking in only because a save writes their cadence too. */
export function keptByDefault(
  botId: string,
  jobs: readonly CheckInJob[],
  settings: readonly CheckInSetting[] | null,
): string[] {
  if (!settings) return [];
  return jobs
    .filter((job) => job.botId !== botId && job.enabled && job.everyMs !== null)
    .filter((job) => !settings.some((each) => each.botId === job.botId))
    .map((job) => job.botId);
}

/** Whether the jobs show the draft took: Off is a disabled job, a cadence an enabled job at it. */
export function landed(jobs: readonly CheckInJob[], botId: string, every: string): boolean {
  const job = jobs.find((each) => each.botId === botId);
  const ms = everyMs(every);
  if (ms === 0) return job !== undefined && !job.enabled;
  return job !== undefined && job.enabled && job.everyMs === ms;
}

const emptyState = (): CheckInsState => ({
  status: "loading",
  error: null,
  scheduler: null,
  jobs: [],
  settings: null,
  save: null,
});

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function read(
  ctx: CheckInsContext,
): Promise<Omit<CheckInsState, "status" | "error" | "save">> {
  const bots = ctx.botIds();
  const [list, status, config] = await Promise.all([
    ctx.request("cron.list", { includeDisabled: true, limit: 200 }),
    ctx.request("cron.status", {}).catch(() => null),
    ctx.request("config.get", {}).catch(() => null),
  ]);
  const enabled = asRecord(status)?.enabled;
  return {
    jobs: readJobs(list, bots),
    scheduler: typeof enabled === "boolean" ? enabled : null,
    settings: config ? readSettings(config, bots) : null,
  };
}

/** Read the bots' check-ins: their jobs, the scheduler and their own settings. */
export async function loadCheckIns(ctx: CheckInsContext): Promise<void> {
  const before = ctx.get() ?? emptyState();
  if (!ctx.get()) ctx.set(before);
  try {
    const next = await read(ctx);
    ctx.set({ ...(ctx.get() ?? before), ...next, status: "ready", error: null });
  } catch (error) {
    ctx.set({ ...(ctx.get() ?? before), status: "error", error: message(error) });
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

/**
 * Save one bot's check-ins in one `config.patch`, then read `cron.list` until
 * the bot's job shows the draft. Only then is it `saved`.
 */
export async function saveCheckIn(
  ctx: CheckInsContext,
  saveId: string,
  botId: string,
  draft: CheckInDraft,
): Promise<void> {
  if (!ctx.admin()) throw new Error("Changing check-ins needs admin access.");
  if (everyMs(draft.every) === null) throw new Error("invalid check-in cadence");
  if (ctx.get()?.save?.status === "saving") throw new Error("A save is under way.");
  const generation = ctx.generation();
  const settle = (status: CheckInSave["status"], error: string | null) => {
    const state = ctx.get() ?? emptyState();
    if (state.save?.id !== saveId) return;
    ctx.set({ ...state, save: { ...state.save, status, error } });
  };
  ctx.set({
    ...(ctx.get() ?? emptyState()),
    save: { id: saveId, botId, every: draft.every, status: "saving", error: null },
  });
  let fresh: Awaited<ReturnType<typeof read>>;
  let baseHash: unknown;
  try {
    const config = await ctx.request("config.get", {});
    baseHash = asRecord(config)?.hash;
    const bots = ctx.botIds();
    fresh = {
      ...(await read(ctx)),
      settings: readSettings(config, bots),
    };
  } catch (error) {
    return settle("failed", message(error));
  }
  const keepPrompt = fresh.settings?.find((each) => each.botId === botId)?.promptCut === true;
  const patch = checkInPatch(
    botId,
    keepPrompt ? { ...draft, prompt: null } : draft,
    fresh.jobs,
    fresh.settings ?? [],
  );
  try {
    await ctx.request("config.patch", {
      raw: JSON.stringify(patch),
      ...(typeof baseHash === "string" ? { baseHash } : {}),
    });
  } catch (error) {
    return settle(certainlyNotApplied(error) ? "failed" : "unknown", message(error));
  }
  const started = ctx.now();
  for (let reads = 0; reads < 60 && ctx.now() - started < READ_BACK_MS; reads += 1) {
    if (ctx.generation() !== generation) break;
    try {
      const next = await read(ctx);
      if (landed(next.jobs, botId, draft.every)) {
        const state = ctx.get() ?? emptyState();
        ctx.set({ ...state, ...next, status: "ready", error: null });
        return settle("saved", null);
      }
    } catch {
      // A read that failed says nothing about the save; read again.
    }
    await ctx.sleep(READ_BACK_EVERY_MS);
  }
  settle("unknown", "Clawtrate couldn't confirm the change: the check-in job didn't show it.");
  await loadCheckIns(ctx);
}

/** Forget a save that ended, when its dialog closes. */
export function dismissCheckInSave(ctx: CheckInsContext, saveId: string): void {
  const state = ctx.get();
  if (state?.save?.id === saveId && state.save.status !== "saving")
    ctx.set({ ...state, save: null });
}
