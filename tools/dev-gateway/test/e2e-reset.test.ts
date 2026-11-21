// What the end-to-end teardown reports when the reset of one of its instances
// fails (e2e/global-setup.ts). The reset is the real tool, run under a temporary
// HOME on a folder seeded here, with a `ps` that fails so that it cannot prove the
// instance idle. No gateway is started and no port is used.
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { resetInstance } from "../../../e2e/global-setup.ts";
import { cleanUp, saveRecord, type RunRecord } from "../../../e2e/run-record.ts";
import { deadProcess, seedInstance, tempDir } from "./fixtures.ts";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const realHome = process.env.HOME;
const realPath = process.env.PATH;
afterEach(() => {
  process.env.HOME = realHome;
  process.env.PATH = realPath;
});

const own = (dir: string) => (made.push(dir), dir);

describe("a failed reset in the end-to-end teardown says why", () => {
  it("the problem carries what the reset printed: its output, then its error", () => {
    const home = own(tempDir("clawtrate-home-"));
    const run = "0badc0de";
    const name = `e2e-${run}-other`;
    const { stateDir, runId } = seedInstance(home, name);
    // With ps failing, the reset cannot list the instance's browser processes, so it keeps the folder.
    const bin = own(tempDir("clawtrate-ps-"));
    writeFileSync(join(bin, "ps"), "#!/bin/sh\nexit 2\n");
    chmodSync(join(bin, "ps"), 0o755);
    process.env.HOME = home;
    process.env.PATH = `${bin}:${realPath}`;
    const records = own(tempDir("clawtrate-records-"));
    const record: RunRecord = {
      run,
      runner: deadProcess(),
      instances: [{ name, runId }],
      host: null,
      dirs: [],
    };
    saveRecord(records, record);

    const problems = cleanUp(records, record, resetInstance);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      `reset ${name}: Error: dev-gateway reset --run-id ${runId} --instance ${name} failed (1):\n`,
    );
    expect(problems[0]).toMatch(
      new RegExp(
        `Could not list processes to find the browser of instance "${name}"\\n[\\s\\S]*` +
          `its browser's processes are still running\\. Nothing was deleted\\.$`,
      ),
    );
    expect(existsSync(stateDir)).toBe(true);
  });
});
