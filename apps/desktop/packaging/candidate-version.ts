import { readFileSync } from "node:fs";
import { parseVersion, versionTrack } from "../src/main/update/version.ts";

/** The checked-in desktop version is the stable base. */
export function nightlyVersion(current: string, date: Date, run: string): string {
  const base = parseVersion(current);
  if (!base || base.length !== 3) throw new Error("Expected a stable desktop version.");
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  const result = `${base[0]}.${base[1]}.${base[2] + 1}-nightly.${day}.${run}`;
  if (!parseVersion(result)) throw new Error("Nightly version exceeds the update version limits.");
  return result;
}

export function candidateVersion(
  track: string,
  requested: string,
  current: string,
  date: Date,
  run: string,
) {
  const version = track === "nightly" ? nightlyVersion(current, date, run) : requested;
  if (track === "nightly" && requested && requested !== version)
    throw new Error("The requested nightly differs from the date and run number.");
  const parsed = parseVersion(version);
  if (!parsed || versionTrack(parsed) !== track) throw new Error("Version does not match track.");
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
