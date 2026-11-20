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
      const detail = "stderr" in error && error.stderr ? String(error.stderr) : error.message;
      writeFileSync(join(dirname(root), "folder-error.txt"), detail);
    }
    throw error;
  }
}
