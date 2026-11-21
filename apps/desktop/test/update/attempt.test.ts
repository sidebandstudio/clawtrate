import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createUpdatePreferenceStore } from "../../src/main/update/preferences.ts";
import { tempDir } from "./harness.ts";

it("only validated bounded attempt records can describe a relaunch", async () => {
  const dir = tempDir();
  try {
    const prefs = createUpdatePreferenceStore(join(dir.path, "preferences.json"));
    const record = {
      target: "1.1.0-nightly.20261101.9",
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
