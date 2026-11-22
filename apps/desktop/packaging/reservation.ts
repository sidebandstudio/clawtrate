// A folder a release run makes for itself before the build, marked with that
// run's owner text, so that after a failure the run removes only what it made.
// release-beta.ts reserves the version's staging folder; candidate-build.ts
// starts from it only when the reservation it is given is its own.

import { mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RESERVATION_FILE = ".clawtrate-release-run";

/**
 * Creates `folder` with `owner` inside it. The folder must not exist: the
 * create is exclusive, so a run that loses a race throws EEXIST and touches
 * nothing.
 */
export function reserve(folder: string, owner: string): void {
  mkdirSync(folder);
  try {
    writeFileSync(join(folder, RESERVATION_FILE), owner, { mode: 0o600, flag: "wx" });
  } catch (error) {
    try {
      rmdirSync(folder);
    } catch {
      // Another writer may have added files. Leave them in place and report the marker error.
    }
    throw error;
  }
}

/** Whether `folder` carries `owner`'s marker. */
export function reservedBy(folder: string, owner: string): boolean {
  try {
    return readFileSync(join(folder, RESERVATION_FILE), "utf8") === owner;
  } catch {
    return false;
  }
}

/** Reserved by `owner` and holding nothing else yet: what a build may start from. */
export function freshReservation(folder: string, owner: string | undefined): boolean {
  if (!owner) return false;
  try {
    return reservedBy(folder, owner) && readdirSync(folder).join("\n") === RESERVATION_FILE;
  } catch {
    return false;
  }
}
