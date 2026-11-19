// What a bot's check-ins say (automation.md section 13), from its heartbeat
// job: the job is what will run, so it is the source of the words. Silence
// when nothing needs the person is what the gateway's own prompt asks for,
// not something the gateway guarantees, so no sentence here promises it; and
// the gateway can skip a scheduled attempt, so none promises a run either.

import { everyText, type CheckInJob, type CheckInSetting } from "@clawtrate/core";

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
): string {
  const background = `It still reports when a command it started in the background finishes.`;
  if (job && !job.enabled) return `${name} doesn't check in on a schedule. ${background}`;
  if (!checksIn(job)) {
    if (settings === null) return `${name} doesn't check in.`;
    return settings.length > 0
      ? `${name} doesn't check in. Once any bot has a check-in setting of its own, only those bots check in.`
      : `${name} doesn't check in. The gateway's default for check-ins doesn't cover it.`;
  }
  return job.everyMs === DAY
    ? `Once a day, ${name} looks for anything that needs you.`
    : `Every ${cadence(job.everyMs)}, ${name} looks for anything that needs you.`;
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
 * What the prompt in effect asks, as far as words can say: `asks` for the
 * gateway's own, which asks for NO_REPLY when nothing needs attention;
 * `unasked` for one that never mentions NO_REPLY; `unknown` for a custom one
 * that does, since mentioning it is not asking for it.
 */
export type Quiet = "asks" | "unasked" | "unknown";

const QUIET: Record<Quiet, string> = {
  asks: " Its prompt asks it to stay quiet when nothing does.",
  unasked: " Its prompt doesn't ask it to reply NO_REPLY, so it may answer every check-in.",
  unknown: "",
};

/** The words under a choice; every choice that checks in ends with what its prompt asks. */
export function choiceWords(choice: Choice, name: string, quiet: Quiet): string {
  switch (choice) {
    case "off":
      return `${name} doesn't check in on a schedule.`;
    case "daily":
      return `Once a day, ${name} looks for anything that needs you.${QUIET[quiet]}`;
    case "asneeded":
      return `Every 30 minutes, ${name} looks for anything that needs you.${QUIET[quiet]}`;
    case "every":
      return `${name} looks for anything that needs you as often as you choose.${QUIET[quiet]}`;
  }
}

/** Whether a prompt keeps the gateway's way of saying nothing; "" is the built-in prompt, which does. */
export const asksForSilence = (prompt: string) =>
  prompt.trim() === "" || prompt.includes("NO_REPLY");

/** The gateway's own prompt, as OpenClaw 2026.10.6 documents it (`docs/gateway/heartbeat.md`). */
export const DEFAULT_PROMPT =
  "Follow the heartbeat monitor scratch context when provided. Recurring tasks are automations; create or change their schedules with the automations tool, not heartbeat scratch. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply NO_REPLY.";
