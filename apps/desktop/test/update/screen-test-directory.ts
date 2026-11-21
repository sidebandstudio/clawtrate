// Only linked by the standalone update check. Preserve the host refusal and
// give the test runner the error that preceded the first file request.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { prepareUpdateDirectory as prepare } from "../../src/main/private-update-directory.ts";
export { clearUpdateDirectory } from "../../src/main/private-update-directory.ts";

export async function prepareUpdateDirectory(root: string, offerId: string) {
  try {
    await prepare(root, offerId);
  } catch (error) {
    if (error instanceof Error) {
      const detail = JSON.stringify({
        message: error.message.split("\n")[0],
        code: "code" in error ? error.code : undefined,
        signal: "signal" in error ? error.signal : undefined,
        killed: "killed" in error ? error.killed : undefined,
        stdout: "stdout" in error ? String(error.stdout).slice(0, 1024) : undefined,
        stderr: "stderr" in error ? String(error.stderr).slice(0, 1024) : undefined,
      });
      writeFileSync(join(dirname(root), "folder-error.txt"), detail);
    }
    throw error;
  }
}
