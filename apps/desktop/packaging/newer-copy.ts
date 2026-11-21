// A copy of a packaged macOS app that reports a newer version, the way an
// update in place replaces it: the same bundle id, name and files, with only
// the version in its archive and Info.plist changed. The launch check starts
// it on the first app's data folder to show that a newer build keeps the
// pairing. It is signed ad hoc, so it proves the paths, not Squirrel's
// signed handoff (docs/development/releases.md has the signed trial).

import { createPackage, extractAll, extractFile, getRawHeader, uncache } from "@electron/asar";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ASAR_KEY = ":ElectronAsarIntegrity:Resources/app.asar:hash";

/** The hash Electron checks the archive against: SHA-256 of its header. */
export function asarHeaderHash(archive: string): string {
  uncache(archive);
  return createHash("sha256").update(getRawHeader(archive).headerString).digest("hex");
}

function plist(app: string, command: string): string {
  return execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", command, join(app, "Contents/Info.plist")],
    {
      encoding: "utf8",
    },
  ).trim();
}

/** The packaged app's own package.json: `app.getVersion()` and the app's name come from it. */
export function packagedManifest(app: string): Record<string, unknown> {
  const archive = join(app, "Contents/Resources/app.asar");
  uncache(archive);
  return JSON.parse(extractFile(archive, "package.json").toString("utf8")) as Record<
    string,
    unknown
  >;
}

export async function newerCopy(
  app: string,
  dest: string,
  version: string,
  scratch: string,
): Promise<void> {
  const original = join(app, "Contents/Resources/app.asar");
  // The copy's hash is computed the way the original's was, or not at all.
  if (asarHeaderHash(original) !== plist(app, `Print ${ASAR_KEY}`))
    throw new Error("The archive's integrity hash is not the SHA-256 of its header.");
  execFileSync("ditto", [app, dest]);
  const archive = join(dest, "Contents/Resources/app.asar");
  const files = join(scratch, "app");
  extractAll(original, files);
  const manifest = join(files, "package.json");
  writeFileSync(
    manifest,
    JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version }),
  );
  rmSync(archive);
  await createPackage(files, archive);
  plist(dest, `Set ${ASAR_KEY} ${asarHeaderHash(archive)}`);
  plist(dest, `Set :CFBundleShortVersionString ${version}`);
  plist(dest, `Set :CFBundleVersion ${version}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", dest], { stdio: "ignore" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", dest], { stdio: "ignore" });
}
