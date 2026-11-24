import { readFileSync } from "node:fs";
import { fitsTrack, isNewer, parseVersion, type Version } from "../src/main/update/version.ts";

/**
 * The first version of the three-number form. From this line on a beta is
 * `X.Y.Z` and never dated again (docs/decisions.md, "Moving betas to three numbers").
 */
export const FIRST_SHORT: Version = [0, 2, 0];

/** Whether the checked-in version `X.Y.Z` is on a line whose betas have three numbers. */
export function shortLine(base: Version): boolean {
  return base.length === 3 && !isNewer(FIRST_SHORT, base);
}

/** A dated beta from the checked-in version, which must be below 0.2.0. */
export function nightlyVersion(current: string, date: Date, run: string): string {
  const base = parseVersion(current);
  if (!base || base.length !== 3) throw new Error("Expected a stable desktop version.");
  if (shortLine(base))
    throw new Error(`Betas of ${current} have three numbers; a dated beta is never made again.`);
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  const result = `${base[0]}.${base[1]}.${base[2] + 1}-beta.${day}.${run}`;
  if (!parseVersion(result)) throw new Error("Beta version exceeds the update version limits.");
  return result;
}

export function candidateVersion(
  track: string,
  requested: string,
  current: string,
  date: Date,
  run: string,
) {
  const base = parseVersion(current);
  // On a three-number line a beta candidate is named by hand, like a Stable one.
  const dated = track === "nightly" && !(base && shortLine(base));
  const version = dated ? nightlyVersion(current, date, run) : requested;
  if (dated && requested && requested !== version)
    throw new Error("The requested beta differs from the date and run number.");
  const parsed = parseVersion(version);
  if (!parsed || (track !== "stable" && track !== "nightly") || !fitsTrack(parsed, track))
    throw new Error("Version does not match track.");
  if (track === "nightly" && parsed.length === 5 && base && shortLine(base))
    throw new Error("Version does not match track.");
  return version;
}

if (import.meta.main) {
  const current = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).version;
  console.log(
    candidateVersion(
      process.env.TRACK ?? "",
      process.env.REQUESTED ?? "",
      current,
      new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000),
      process.env.GITHUB_RUN_NUMBER ?? "",
    ),
  );
}
