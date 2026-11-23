import type { UpdateAttemptOutcome, UpdateTrack } from "@clawtrate/core";
import { parseReleaseDate } from "./feed.ts";
import { formatVersion, isNewer, parseVersion, versionTrack } from "./version.ts";

interface Attempt {
  target: string;
  from: string;
  track: UpdateTrack;
  time: string;
  phase: "handoff";
  /** The build that wrote it records its own quit (`UpdateQuit`). */
  marksQuit?: true;
}

/** Written as the app quits after handing an update off: which attempt, and how long it took. */
export interface UpdateQuit {
  attempt: string;
  /** From the handoff's request to quit; absent when nothing asked the app to quit for it. */
  ms?: number;
}

export function readQuit(value: unknown): UpdateQuit | null {
  if (!value || typeof value !== "object" || !("attempt" in value)) return null;
  const { attempt } = value;
  const ms = "ms" in value ? value.ms : undefined;
  if (typeof attempt !== "string" || attempt.length > 64) return null;
  if (ms === undefined) return { attempt };
  return typeof ms === "number" && Number.isSafeInteger(ms) && ms >= 0 ? { attempt, ms } : null;
}

export function readAttempt(value: unknown): Attempt {
  if (
    !value ||
    typeof value !== "object" ||
    !("target" in value) ||
    !("from" in value) ||
    !("track" in value) ||
    !("time" in value) ||
    !("phase" in value)
  )
    throw Error("Invalid update attempt");
  const target = parseVersion(value.target),
    from = parseVersion(value.from);
  const time = parseReleaseDate(value.time);
  if (
    !target ||
    !from ||
    !isNewer(target, from) ||
    versionTrack(target) !== value.track ||
    !time ||
    value.phase !== "handoff"
  )
    throw Error("Invalid update attempt");
  return {
    target: formatVersion(target),
    from: formatVersion(from),
    track: versionTrack(target),
    time,
    phase: "handoff",
    ...("marksQuit" in value && value.marksQuit === true && { marksQuit: true as const }),
  };
}

export function attemptOutcome(
  { target, from, track, time, marksQuit }: Attempt,
  running: string | null,
  quit: UpdateQuit | null = null,
): UpdateAttemptOutcome {
  const kind =
    running === target
      ? "target-running"
      : running === from
        ? "old-version-running"
        : "unconfirmed";
  const quitRecord =
    kind === "target-running" || !marksQuit
      ? {}
      : quit?.attempt === time
        ? { quit: "finished" as const, ...(quit.ms !== undefined && { quitMs: quit.ms }) }
        : { quit: "not-finished" as const };
  return { kind, target, from, track, running, ...quitRecord };
}
