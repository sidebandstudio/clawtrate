// Only linked by the standalone update check. Times each read-back of a
// downloaded file, which on Windows is a PowerShell run, for the step log.
import { dirname } from "node:path";
import { inspectUpdateFile as inspect } from "../../src/main/inspect-update-file.ts";
import { timeStep } from "./screen-test-steps.ts";

export function inspectUpdateFile(path: string, expected: number) {
  // The file is <profile>/updates/<offer>/<name>.
  return timeStep(
    dirname(dirname(dirname(path))),
    "read-back",
    () => inspect(path, expected),
    (proof) => (proof ? "read" : "wrong size"),
  );
}
