// The provider-account probes' recording servers log to a temporary folder that goes when they
// stop, so a probe run leaves nothing behind (#886).
import { readdirSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { startRecorders } from "../docs/research/dev-gateway/provider-accounts/probe-client.mjs";
import { tempDir } from "./temp-dir.ts";

it("the recording servers' log folder goes when they stop", async () => {
  const temp = tempDir("clawtrate-recorders-temp-");
  for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, temp);
  try {
    const recorders = await startRecorders([]);
    expect(readdirSync(temp)).toEqual([expect.stringMatching(/^clawtrate-recorders-/)]);
    expect(recorders.requests()).toEqual([]);
    recorders.stop();
    expect(readdirSync(temp)).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
  }
});
