// Only linked by the standalone update check. Times each read-back of a
// downloaded file, which on Windows is a PowerShell run, for the step log.
import { dirname } from "node:path";
import { inspectUpdateFile as inspect } from "../../src/main/inspect-update-file.ts";
import { stepLog } from "./screen-test-steps.ts";

export async function inspectUpdateFile(path: string, expected: number) {
  // The file is <profile>/updates/<offer>/<name>.
  return stepLog(dirname(dirname(dirname(path)))).time(
    "read-back",
    () => inspect(path, expected),
    (proof) => (proof ? "read" : "wrong size"),
  );
}
