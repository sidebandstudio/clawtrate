// Packages the built desktop app (`electron-vite build` output in out/) with
// electron-builder.
//
//   node packaging/build.ts mac   # Clawtrate.app, a .dmg and a .zip for arm64 and x64
//   node packaging/build.ts win   # an NSIS installer for x64; run it on Windows
//
// Output goes to apps/desktop/dist, which git ignores. Nothing is published.
// It prints which signing the build does, and after a macOS build what each
// app's signature turned out to be.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build, Platform } from "electron-builder";
import { LOGO_PATH, MANIFEST_PATH, sha256 } from "../../../tools/brand/src/make-icons.ts";
import { builderConfig, PRODUCT_NAME } from "./config.ts";
import { macSignatureKind, signingPlan, signingProblems, signingSummary } from "./signing.ts";

const APP_DIR = join(import.meta.dirname, "..");

const target = process.argv[2];
if (target !== "mac" && target !== "win") {
  console.error("usage: node packaging/build.ts mac|win");
  process.exit(2);
}
if (target === "mac" && process.platform !== "darwin") {
  console.error("The macOS app is packaged on macOS.");
  process.exit(1);
}
if (target === "win" && process.platform !== "win32") {
  console.error("The Windows installer is packaged on Windows.");
  process.exit(1);
}

// The icons come from the logo through `pnpm brand:icons`; refuse stale ones.
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { sourceSha256: string };
if (manifest.sourceSha256 !== sha256(LOGO_PATH)) {
  console.error("The icons are older than assets/brand/logo.png. Run `pnpm brand:icons` first.");
  process.exit(1);
}
for (const file of ["out/main/index.js", "out/preload/index.cjs", "out/renderer/index.html"]) {
  if (!existsSync(join(APP_DIR, file))) {
    console.error(`${file} is missing. Run \`electron-vite build\` first.`);
    process.exit(1);
  }
}

// Signing runs only with the owner's identities in the environment; a partial
// set stops here, before anything is built, naming the variables only.
const problems = signingProblems(process.env, target);
if (problems.length > 0) {
  for (const problem of problems) console.error(`Signing variables: ${problem}.`);
  process.exit(1);
}
const plan = signingPlan(process.env);
console.log(signingSummary(plan, target));

// The exact Electron the app is developed and tested with.
const require = createRequire(join(APP_DIR, "package.json"));
const electronVersion = (require("electron/package.json") as { version: string }).version;

const platform = target === "mac" ? Platform.MAC : Platform.WINDOWS;
const artifacts = await build({
  projectDir: APP_DIR,
  targets: platform.createTarget(),
  config: builderConfig(process.env, electronVersion),
  publish: "never",
});
for (const artifact of artifacts) console.log(artifact);

// What the macOS apps' signatures are, read back from the bundles. electron-builder
// skips signing in a pull request's CI run even with an identity set.
if (target === "mac") {
  for (const folder of ["mac-arm64", "mac"]) {
    const app = join(APP_DIR, "dist", folder, `${PRODUCT_NAME}.app`);
    if (!existsSync(app)) continue;
    const shown = spawnSync("codesign", ["--display", "--verbose=2", app], { encoding: "utf8" });
    const kind = macSignatureKind(shown.stderr ?? "");
    console.log(`Signature of dist/${folder}/${PRODUCT_NAME}.app: ${kind}.`);
    if ((plan.mac === "developer-id") !== (kind === "certificate")) {
      console.error("The signature is not the one the signing variables asked for.");
      process.exitCode = 1;
    }
  }
}
