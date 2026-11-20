import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { FileKey } from "../src/main/update/feed.ts";

export function artifactFormat(key: FileKey, path: string) {
  const script = fileURLToPath(new URL("./inspect-candidate.py", import.meta.url));
  const result = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    ["-I", script, key, path],
    { stdio: "ignore" },
  );
  if (result.error) throw new Error("The candidate plan requires Python 3.");
  if (result.status !== 0) return null;
  return key === "win-x64"
    ? "PE32+ x64 executable"
    : "ZIP with " + key.slice(4) + " Mach-O app executable";
}
