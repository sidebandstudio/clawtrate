// Run by asar-trees.test.ts under the development Electron binary with ELECTRON_RUN_AS_NODE=1,
// so these update modules use Electron's own fs, which reads an .asar file as a folder (#383).
// Plain Node can't show that bug. This is the development Electron, not the Clawtrate app: it
// opens no window and touches no keychain.
//
//   <electron> asar-trees.electron.ts <case> <fixture Clawtrate.app> <empty work folder>
//
// It prints one JSON line with what happened.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearUpdateDirectory } from "../../src/main/private-update-directory.ts";
import { macInstaller } from "../../src/main/mac-install.ts";

const [kind, fixtureApp, work] = process.argv.slice(2) as [string, string, string];
const report = (result: Record<string, unknown>) => console.log(JSON.stringify(result));
const failure = (error: unknown) => ({
  error: (error as { code?: string }).code ?? String(error),
});

/** What the update folder holds, by name, at any depth. */
function names(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

const updates = join(work, "updates");
const offer = join(updates, "offer");

if (kind === "clear") {
  // A checked copy an earlier build left behind, holding the candidate's app.asar.
  const left = join(offer, ".inspect-left");
  mkdirSync(left, { recursive: true, mode: 0o700 });
  execFileSync("/bin/cp", ["-R", fixtureApp, join(left, "Clawtrate.app")]);
  const before = names(updates).some((name) => name.endsWith("app.asar"));
  try {
    await clearUpdateDirectory(updates);
    report({ before, removed: !existsSync(updates) });
  } catch (error) {
    report({ before, ...failure(error), left: names(updates) });
  }
} else if (kind === "install") {
  // The installed app's layout: Contents/Resources and the helper in Contents/Helpers. The
  // stand-in helper answers ok to the signature-only call and, given the archive, unpacks the
  // fixture app into its scratch folder as the real one does, then answers ok.
  const contents = join(work, "Installed.app", "Contents");
  mkdirSync(join(contents, "Resources"), { recursive: true });
  mkdirSync(join(contents, "Helpers"));
  const helper = join(contents, "Helpers", "ClawtrateUpdateInspection");
  writeFileSync(
    helper,
    [
      "#!/bin/sh",
      'if [ "$1" = --running-signature ]; then echo ok; exit 0; fi',
      `/bin/cp -R '${fixtureApp}' "$1/Clawtrate.app" || exit 1`,
      "echo ok",
      "",
    ].join("\n"),
  );
  chmodSync(helper, 0o755);
  Object.defineProperty(process, "resourcesPath", {
    value: join(contents, "Resources"),
    configurable: true,
  });
  mkdirSync(offer, { recursive: true, mode: 0o700 });
  const path = join(offer, "Clawtrate-2.0.0-mac-arm64.zip");
  const bytes = Buffer.alloc(100000, 7);
  writeFileSync(path, bytes);
  const stat = lstatSync(path, { bigint: true });
  const file = {
    path,
    offerId: "offer",
    version: "2.0.0",
    track: "stable" as const,
    size: bytes.length,
    identity: [stat.dev, stat.ino, stat.birthtimeNs].join("."),
    sha512: createHash("sha512").update(bytes).digest("base64"),
  };
  // Restart's handoff as far as it runs without the system updater: the stand-in stage reads
  // the local feed and the archive it names, as Squirrel.Mac does, and checks the bytes.
  let served: string | null = null;
  const installer = macInstaller("arm64", undefined, async (feed, _signal, handed) => {
    const { url } = (await (await fetch(feed)).json()) as { url: string };
    const body = Buffer.from(await (await fetch(url)).arrayBuffer());
    served = createHash("sha512").update(body).digest("base64");
    handed();
  });
  let inspected: unknown;
  try {
    inspected = await installer.inspect(file);
  } catch (error) {
    inspected = failure(error);
  }
  const leftAfterInspect = names(offer).filter((name) => name.startsWith(".inspect-"));
  let launched: unknown = null;
  if (inspected === null) {
    let handed = false;
    try {
      launched = await installer.launch(file, new AbortController().signal, () => {
        handed = true;
      });
    } catch (error) {
      launched = failure(error);
    }
    launched = { result: launched, handed, sameBytes: served === file.sha512 };
  }
  installer.retire?.();
  report({ inspected, leftAfterInspect, launched });
} else throw new Error(`unknown case ${kind}`);
