import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { attemptOutcome, readAttempt } from "../../src/main/update/attempt.ts";
import { createUpdatePreferenceStore } from "../../src/main/update/preferences.ts";
import { tempDir } from "./harness.ts";

it("only validated bounded attempt records can describe a relaunch", async () => {
  const dir = tempDir();
  try {
    const prefs = createUpdatePreferenceStore(join(dir.path, "preferences.json"));
    const record = {
      target: "1.1.0-beta.20261101.9",
      from: "1.0.0",
      time: "2026-11-01T00:00:00.000Z",
      track: "nightly",
      phase: "handoff",
    };
    for (const fields of [
      { target: "v".repeat(51) },
      { from: record.target },
      { track: "stable" },
      { time: "invalid" },
      { phase: "installed" },
    ]) {
      await expect(
        prefs.set("attempt", JSON.stringify({ ...record, ...fields })),
      ).rejects.toThrow();
    }
    expect(await prefs.get("attempt")).toBeNull();
    await prefs.set("attempt", JSON.stringify({ ...record, unknown: "discard" }));
    expect(JSON.parse((await prefs.get("attempt"))!)).toEqual(record);
    writeFileSync(
      join(dir.path, "preferences.json"),
      JSON.stringify({ attempt: { ...record, phase: "installed" } }),
    );
    await expect(prefs.get("attempt")).rejects.toThrow();
  } finally {
    dir.remove();
  }
});

it("F-559: an attempt from a dated beta to a three-numbered Beta build is read on both sides", () => {
  const record = {
    target: "0.2.0",
    from: "0.1.1-beta.20261124.2",
    time: "2026-11-01T00:00:00.000Z",
    track: "nightly",
    phase: "handoff",
  } as const;
  expect(readAttempt(record)).toEqual(record);
  expect(attemptOutcome(readAttempt(record), "0.2.0")).toMatchObject({
    kind: "target-running",
    track: "nightly",
  });
  expect(attemptOutcome(readAttempt(record), record.from)).toMatchObject({
    kind: "old-version-running",
  });
  expect(readAttempt({ ...record, from: "0.2.0", target: "0.2.1" })).toMatchObject({
    track: "nightly",
  });
  expect(readAttempt({ ...record, track: "stable" })).toMatchObject({ track: "stable" });
  for (const fields of [
    // A dated build is never on Stable.
    { target: "0.2.1-beta.20261201.1", from: "0.2.0", track: "stable" },
    // Never to an older or the same build.
    { target: "0.1.1-beta.20261124.2", from: "0.2.0" },
    { target: "0.2.0", from: "0.2.0" },
    { track: "beta" },
  ])
    expect(() => readAttempt({ ...record, ...fields })).toThrow();
});
