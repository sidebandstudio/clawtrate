import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FILE_KEYS, type FileKey } from "../src/main/update/feed.ts";
import { parseVersion, versionTrack } from "../src/main/update/version.ts";
import { artifactName, sha512Base64 } from "./feed.ts";
import { releaseDate } from "./update-defines.ts";
import { requireUnsignedEnvironment } from "./unsigned-environment.ts";
import { compiledAddresses } from "./candidate-addresses.ts";
import { freshReservation } from "./reservation.ts";

const app = fileURLToPath(new URL("../", import.meta.url));
const dist = join(app, "dist");
export function macReadback(log: string, key: FileKey) {
  const prefix =
    "Signature of dist/" + (key === "mac-arm64" ? "mac-arm64" : "mac") + "/Clawtrate.app: ";
  const lines = log.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) return "unknown";
  if (lines[0] === prefix + "ad hoc.") return "ad hoc";
  if (lines[0] === prefix + "none.") return "none";
  if (lines[0] === prefix + "certificate.") return "certificate";
  return "unknown";
}

function build(dir: string, version: string) {
  const parsed = parseVersion(version);
  if (!parsed || !process.env.SOURCE_DATE_EPOCH)
    throw new Error("Expected candidate version and epoch.");
  const feedAddresses = compiledAddresses(versionTrack(parsed), process.env);
  const buildDate = releaseDate(process.env, new Date());
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const manifest = join(app, "package.json");
  const original = readFileSync(manifest, "utf8");
  // A beta release reserves dist and the folder first (release-beta.ts) and
  // names its reservation; a build starts from them only while they hold
  // nothing but that run's marker.
  const reservation = process.env.CLAWTRATE_RELEASE_RESERVATION;
  if (
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() ||
    (existsSync(dist) && !freshReservation(dist, reservation))
  )
    throw new Error("Start from a clean checkout and an absent dist folder.");
  const win = process.platform === "win32";
  if (!win && process.platform !== "darwin") throw new Error("Build on macOS or Windows.");
  if (!freshReservation(dir, reservation)) mkdirSync(dir);
  const temp = mkdtempSync(join(tmpdir(), "clawtrate-pack-"));
  const log = join(temp, "pack.log");
  const fd = openSync(log, "wx", 0o600);
  let keepLog = false;
  try {
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(original), version }, null, 2) + "\n");
    const result = spawnSync(
      win ? "cmd.exe" : "pnpm",
      win ? ["/d", "/c", "pnpm package:win"] : ["package:mac"],
      { stdio: ["ignore", fd, process.env.GITHUB_ACTIONS === "true" ? "inherit" : fd] },
    );
    if (result.status !== 0) {
      keepLog = true;
      const reason = result.error?.message ?? result.signal ?? `exit ${result.status}`;
      throw new Error(`Packaging failed (${reason}). Build log: ${log}`);
    }
    const keys = FILE_KEYS.filter((key) => key.startsWith(win ? "win-" : "mac-"));
    const names = keys.map((key) => artifactName(version, key));
    if (readdirSync(dist).some((name) => /\.(zip|exe)$/i.test(name) && !names.includes(name)))
      throw new Error("Unexpected update artifact.");
    for (const key of keys) {
      const name = artifactName(version, key);
      const path = join(dir, name);
      copyFileSync(join(dist, name), path);

      const receipt = {
        commit,
        buildDate,
        name,
        sha512: sha512Base64(path),
        packagerReadback: win ? null : macReadback(readFileSync(log, "utf8"), key),
        feedAddresses,
      };
      writeFileSync(join(dir, key + ".json"), JSON.stringify(receipt, null, 2) + "\n");
    }
  } finally {
    closeSync(fd);
    writeFileSync(manifest, original);
    if (!keepLog) rmSync(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [dir, version, mode] = process.argv.slice(2);
  if (!dir || !version) throw new Error("Usage: candidate-build.ts NEW_FOLDER VERSION");
  if (mode === "--unsigned-only" || process.env.GITHUB_ACTIONS === "true")
    requireUnsignedEnvironment(process.env);
  build(dir, version);
}
