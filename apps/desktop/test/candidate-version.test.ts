import { expect, it } from "vitest";
import { candidateVersion, nightlyVersion } from "../packaging/candidate-version.ts";
import { isNewer, parseVersion } from "../src/main/update/version.ts";

const date = new Date("2026-11-18T21:00:00-05:00");
it("orders nightlies by UTC day and numeric run between consecutive stable patches", () => {
  const make = (day: Date, run: string) => nightlyVersion("0.1.0", day, run);
  expect(make(date, "10")).toBe("0.1.1-beta.20261119.10");
  const versions = [
    "0.1.0",
    make(new Date("2026-11-18"), "99"),
    make(date, "9"),
    make(date, "10"),
    "0.1.1",
  ];
  for (let i = 1; i < versions.length; i++)
    expect(isNewer(parseVersion(versions[i])!, parseVersion(versions[i - 1])!)).toBe(true);
});
it("accepts a stable version or the calculated nightly and rejects mismatched inputs", () => {
  const pick = (track: string, value: string) => candidateVersion(track, value, "0.1.0", date, "3");
  expect(pick("stable", "1.0.0")).toBe("1.0.0");
  expect(pick("nightly", "")).toBe(pick("nightly", "0.1.1-beta.20261119.3"));
  for (const [track, value] of [
    ["stable", ""],
    ["stable", pick("nightly", "")],
    ["nightly", "0.1.0"],
    ["other", "0.1.0"],
  ] as const)
    expect(() => pick(track, value)).toThrow();
  for (const [base, run] of [
    ["bad", "1"],
    ["0.1.0", "01"],
    ["0.1.999999", "1"],
  ] as const)
    expect(() => nightlyVersion(base, date, run)).toThrow();
});
