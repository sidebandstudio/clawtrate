// The engine check keeps its client's key and device token in a temporary folder of its own,
// which goes when the check ends, also when it stops early (#886).
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../../test/temp-dir.ts";

const ENGINE = fileURLToPath(new URL("../src/engine.ts", import.meta.url));

describe("the engine check", () => {
  it("removes its client folder when it stops early", () => {
    const temp = tempDir("clawtrate-engine-temp-");
    const out = tempDir("clawtrate-engine-out-");
    const result = spawnSync(
      process.execPath,
      [
        ENGINE,
        // Nothing listens on port 1, and no `openclaw` is on PATH: the check stops at pairing.
        ...["--url", "ws://127.0.0.1:1", "--profile", "clawtrate-dev-folder-check"],
        ...["--out", out, "--reconnects", "0"],
      ],
      {
        encoding: "utf8",
        timeout: 60_000,
        env: {
          HOME: tempDir("clawtrate-engine-home-"),
          PATH: tempDir("clawtrate-engine-path-"),
          TMPDIR: temp,
          TMP: temp,
          TEMP: temp,
          GITHUB_ACTIONS: "true",
          RUNNER_ENVIRONMENT: "github-hosted",
          OPENCLAW_CHECK_TOKEN: "synthetic-check-token",
        },
      },
    );
    expect(result.stdout).toContain("stopped:");
    expect(readdirSync(out)).toEqual(["engine-result.json"]);
    expect(readdirSync(temp)).toEqual([]);
  });
});
