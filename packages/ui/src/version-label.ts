import type { UpdateTrack } from "@clawtrate/core";

/**
 * How a version reads to a person (F-561). A Beta build numbered with three
 * numbers shows its channel beside the number: "Beta · 0.2.3". Every other
 * version reads as it is, the dated Beta form included, which names Beta itself.
 */
export function versionLabel(version: string, track: UpdateTrack | null): string {
  return track === "nightly" && /^\d+\.\d+\.\d+$/.test(version) ? `Beta · ${version}` : version;
}
