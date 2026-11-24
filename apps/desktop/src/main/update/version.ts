import type { UpdateTrack } from "@clawtrate/core";

const VERSION =
  /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-beta\.([1-9]\d{7})\.(0|[1-9]\d{0,11}))?$/;

export type Version =
  readonly [number, number, number] | readonly [number, number, number, number, number];

export function parseVersion(text: unknown): Version | null {
  if (typeof text !== "string" || text.length > 50) return null;
  const match = VERSION.exec(text);
  if (!match || match[0] !== text) return null;
  const base = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const date = match[4];
  if (!date) return base;
  const iso = date.slice(0, 4) + "-" + date.slice(4, 6) + "-" + date.slice(6);
  const time = Date.parse(iso);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== iso) return null;
  return [...base, Number(date), Number(match[5])];
}

/** The track a version's shape names: three numbers Stable, the dated five-part form Beta. */
export function versionTrack(version: Version): UpdateTrack {
  return version.length === 3 ? "stable" : "nightly";
}

/**
 * Whether a version can be a build on `track`. A dated five-part version is
 * only ever a Beta build. Three numbers can be either, because the track is
 * not part of the number: Beta builds move to three numbers (issue #438).
 */
export function fitsTrack(version: Version, track: UpdateTrack): boolean {
  return version.length === 3 || track === "nightly";
}

export function isNewer(candidate: Version, current: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (candidate[i] !== current[i]) return candidate[i]! > current[i]!;
  }
  if (current.length === 3) return false;
  if (candidate.length === 3) return true;
  return candidate[3] === current[3] ? candidate[4] > current[4] : candidate[3] > current[3];
}

export function formatVersion(version: Version): string {
  const base = version.slice(0, 3).join(".");
  return version.length === 3 ? base : base + "-beta." + version[3] + "." + version[4];
}
