import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_KEYS, type FileKey } from "../src/main/update/feed.ts";
import { artifactName, sha512Base64 } from "./feed.ts";
import { macSignatureKind } from "./signing.ts";
import { artifactFormat } from "./candidate-format.ts";
import { requireUnsignedEnvironment } from "./unsigned-environment.ts";

export function nativeUnsigned(file: string, key: FileKey, run = spawnSync) {
  if (key === "win-x64") {
    const result = run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-AuthenticodeSignature -LiteralPath $env:CANDIDATE_INSTALLER -ErrorAction Stop).Status.ToString()",
      ],
      { encoding: "utf8", env: { ...process.env, CANDIDATE_INSTALLER: file } },
    );
    return result.status === 0 && result.stdout?.trim() === "NotSigned";
  }
  const dir = mkdtempSync(join(tmpdir(), "candidate-signature-"));
  try {
    if (run("ditto", ["-x", "-k", file, dir], { stdio: "ignore" }).status !== 0) return false;
    const app = join(dir, "Clawtrate.app");
    if (run("codesign", ["--verify", "--deep", "--strict", app], { stdio: "ignore" }).status !== 0)
      return false;
    const read = run("codesign", ["--display", "--verbose=2", app], { encoding: "utf8" });
    return (
      read.status === 0 &&
      macSignatureKind(read.stderr ?? "") === "ad hoc" &&
      !/^Authority=/m.test(read.stderr ?? "")
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Emit only the digests checked on this native runner. The assembly job compares
// them again from job outputs before retaining its copy of the same bytes.
export function checkedDigests(dir: string, version: string) {
  requireUnsignedEnvironment(process.env);
  const os = process.platform;
  if (os !== "win32" && os !== "darwin") throw new Error("Native runner required.");
  const keys = FILE_KEYS.filter((key) => (os === "win32" ? key === "win-x64" : key !== "win-x64"));
  const allowed = keys.flatMap((key) => [key + ".json", artifactName(version, key)]);
  const entries = readdirSync(dir, { withFileTypes: true });
  if (
    entries.length !== allowed.length ||
    entries.some((e) => !e.isFile() || !allowed.includes(e.name))
  )
    throw new Error("Unexpected staging contents.");
  const results = [];
  for (const key of keys) {
    const file = join(dir, artifactName(version, key));
    const receipt = JSON.parse(readFileSync(join(dir, key + ".json"), "utf8"));
    if (key !== "win-x64" && receipt.packagerReadback !== "ad hoc")
      throw new Error("Expected an ad hoc packaging readback.");
    if (!artifactFormat(key, file) || !nativeUnsigned(file, key))
      throw new Error("Native unsigned file check failed.");
    results.push(sha512Base64(file));
  }
  return results.join(",");
}

if (import.meta.main) {
  const [dir, version] = process.argv.slice(2);
  if (!dir || !version) throw new Error("Expected staging folder and version.");
  console.log(checkedDigests(dir, version));
}
