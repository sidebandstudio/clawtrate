// What a bot's check-ins say (automation.md section 13), from its heartbeat
// job: the job is what will run, so it is the source of the words. Silence
// when nothing needs the person is what the gateway's own prompt asks for,
// not something the gateway guarantees, so no sentence here promises it; and
// the gateway can skip a scheduled attempt, so none promises a run either.

import {
  everyText,
  type CheckInDefaults,
  type CheckInJob,
  type CheckInSetting,
} from "@clawtrate/core";

export type Choice = "off" | "daily" | "asneeded" | "every";

const DAY = 86_400_000;
const AS_NEEDED = 1_800_000;

/** The Every… cadences offered, as `every` values and in words. */
export const EVERY_CHOICES: Array<{ value: string; label: string }> = [
  { value: "15m", label: "15 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "2h", label: "2 hours" },
  { value: "4h", label: "4 hours" },
  { value: "8h", label: "8 hours" },
  { value: "12h", label: "12 hours" },
];

/** A cadence in words, exactly, in the largest unit that divides it: "30 minutes", "90 seconds", "1 hour". */
export function cadence(ms: number): string {
  for (const [size, unit] of [
    [3_600_000, "hour"],
    [60_000, "minute"],
    [1_000, "second"],
    [1, "millisecond"],
  ] as const) {
    if (ms % size !== 0) continue;
    const count = ms / size;
    return count === 1 ? `1 ${unit}` : `${count.toLocaleString("en-US")} ${unit}s`;
  }
  return `${ms} milliseconds`;
}

const checksIn = (job: CheckInJob | undefined): job is CheckInJob & { everyMs: number } =>
  job !== undefined && job.enabled && job.everyMs !== null;

/** The short line at the right of a bot's name. */
export function summary(job: CheckInJob | undefined): string {
  if (!checksIn(job)) return "No check-ins";
  return job.everyMs === DAY ? "Checks in daily" : `Checks in every ${cadence(job.everyMs)}`;
}

/** The block's sentence. */
export function sentence(
  name: string,
  job: CheckInJob | undefined,
  settings: readonly CheckInSetting[] | null,
  defaults: CheckInDefaults | null,
): string {
  const background = `It still reports when a command it started in the background finishes.`;
  if (job && !job.enabled) return `${name} doesn't check in on a schedule. ${background}`;
  if (!checksIn(job)) {
    if (settings === null) return `${name} doesn't check in.`;
    return settings.length > 0
      ? `${name} doesn't check in. Once any bot has a check-in setting of its own, only those bots check in.`
      : `${name} doesn't check in. The gateway's default for check-ins doesn't cover it.`;
  }
  const own = settings?.find((each) => each.botId === job.botId)?.prompt ?? null;
  const kind = settings === null ? "unknown" : promptKind(own, defaults);
  return withPrompt(
    job.everyMs === DAY ? "Once a day" : `Every ${cadence(job.everyMs)}`,
    name,
    kind,
  );
}

/** The choice a job stands for, and the Every… value when it is one. */
export function choiceOf(job: CheckInJob | undefined): { choice: Choice; every: string } {
  if (!checksIn(job)) return { choice: "off", every: "2h" };
  if (job.everyMs === DAY) return { choice: "daily", every: "2h" };
  if (job.everyMs === AS_NEEDED) return { choice: "asneeded", every: "2h" };
  return { choice: "every", every: everyText(job.everyMs) };
}

/** The `every` a choice writes. */
export function everyFor(choice: Choice, every: string): string {
  return choice === "off"
    ? "0m"
    : choice === "daily"
      ? "24h"
      : choice === "asneeded"
        ? "30m"
        : every;
}

/**
 * What Clawtrate knows of the prompt in effect, never read from its wording:
 * the gateway's built-in one (an empty own prompt and no default of the
 * gateway's), the bot's own, the gateway's custom default, or one it can't read.
 */
export type PromptKind = "builtin" | "own" | "default" | "unknown";

/** The kind of prompt a bot gets from its own prompt (null or "" for none) and the gateway's default. */
export function promptKind(
  own: string | null,
  defaults: Pick<CheckInDefaults, "prompt"> | null,
): PromptKind {
  if (own) return "own";
  if (!defaults) return "unknown";
  return defaults.prompt === null ? "builtin" : "default";
}

/** "<Cadence>, Juniper …": what is said after a cadence, by the kind of prompt (automation.md section 13). */
function withPrompt(lead: string, name: string, kind: PromptKind): string {
  switch (kind) {
    case "builtin":
      return `${lead}, ${name} looks for anything that needs you. Its prompt asks it to stay quiet when nothing does.`;
    case "own":
      return `${lead}, ${name} checks in with a prompt of its own.`;
    case "default":
      return `${lead}, ${name} checks in with the prompt the gateway sets for every bot.`;
    case "unknown":
      return `${lead}, ${name} checks in. Clawtrate can't read its prompt.`;
  }
}

/** The words under a choice. */
export function choiceWords(choice: Choice, name: string, kind: PromptKind): string {
  switch (choice) {
    case "off":
      return `${name} doesn't check in on a schedule.`;
    case "daily":
      return withPrompt("Once a day", name, kind);
    case "asneeded":
      return withPrompt("Every 30 minutes", name, kind);
    case "every":
      return withPrompt("As often as you choose", name, kind);
  }
}

/** The gateway's own prompt, as OpenClaw 2026.10.6 documents it (`docs/gateway/heartbeat.md`). */
export const DEFAULT_PROMPT =
  "Follow the heartbeat monitor scratch context when provided. Recurring tasks are automations; create or change their schedules with the automations tool, not heartbeat scratch. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply NO_REPLY.";
