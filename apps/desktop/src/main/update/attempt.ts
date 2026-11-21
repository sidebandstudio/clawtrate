import type { UpdateAttemptOutcome, UpdateTrack } from "@clawtrate/core";
import { parseReleaseDate } from "./feed.ts";
import { formatVersion, isNewer, parseVersion, versionTrack } from "./version.ts";

interface Attempt {
  target: string;
  from: string;
  track: UpdateTrack;
  time: string;
  phase: "handoff";
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
  };
}

export function attemptOutcome(
  { target, from, track }: Attempt,
  running: string | null,
): UpdateAttemptOutcome {
  return {
    kind:
      running === target
        ? "target-running"
        : running === from
          ? "old-version-running"
          : "unconfirmed",
    target,
    from,
    track,
    running,
  };
}
