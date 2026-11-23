// Packages the built desktop app (`electron-vite build` output in out/) with
// electron-builder.
//
//   node packaging/build.ts mac   # Clawtrate.app, a .dmg and a .zip for arm64 and x64
//   node packaging/build.ts win   # an NSIS installer for x64; run it on Windows
//   node packaging/build.ts mac --check <absolute folder>
//                                 # for `pnpm check:packaged`: an ad hoc signed app for this
//                                 # Mac's architecture, under a fresh check bundle id
//
// Output goes to apps/desktop/dist, which git ignores, or for --check to the
// folder named. Nothing is published.
// Clawtrate's signing plan, preflight and signature-kind lines omit input values.
// electron-builder's output passes through and can include those values.
// Keep signed-build logs private.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { build, Platform } from "electron-builder";
import { LOGO_PATH, MANIFEST_PATH, sha256 } from "../../../tools/brand/src/make-icons.ts";
import { APP_ID, builderConfig, PRODUCT_NAME } from "./config.ts";
import { OUTPUT_VARIABLE, packageOutput } from "./output.ts";
import {
  checkMacSignature,
  checkWindowsSignature,
  readWindowsSignature,
  signingPlan,
  signingProblems,
  signingSummary,
  windowsSigner,
} from "./signing.ts";
import { requireUnsignedEnvironment } from "./unsigned-environment.ts";

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
// The certificate a signed Windows build must carry, read before anything is built.
let signer: string | null = null;
if (target === "win" && plan.windows === "certificate") {
  const expected = windowsSigner(process.env, APP_DIR);
  if ("problem" in expected) {
    console.error(`Signing variables: ${expected.problem}.`);
    process.exit(1);
  }
  signer = expected.thumbprint;
}

// The exact Electron the app is developed and tested with.
const require = createRequire(join(APP_DIR, "package.json"));
const electronVersion = (require("electron/package.json") as { version: string }).version;

const platform = target === "mac" ? Platform.MAC : Platform.WINDOWS;
// A check build carries an identifier of its own, so the preferences macOS keeps
// by bundle id are never those of a Clawtrate someone uses.
const check = target === "mac" && process.argv[3] === "--check";
if (check) {
  requireUnsignedEnvironment(process.env);
  if (!process.argv[4] || !isAbsolute(process.argv[4])) {
    console.error("usage: node packaging/build.ts mac --check <absolute folder>");
    process.exit(2);
  }
}
const env = check ? { ...process.env, [OUTPUT_VARIABLE]: process.argv[4] } : process.env;
const config = builderConfig(env, electronVersion);
const artifacts = await build({
  projectDir: APP_DIR,
  targets: platform.createTarget(check ? "dir" : undefined),
  config: check
    ? { ...config, appId: `${APP_ID}.check.${randomBytes(8).toString("hex")}` }
    : config,
  publish: "never",
});
for (const artifact of artifacts) console.log(artifact);

// electron-builder's temporary-file cleanup (async-exit-hook) ends the process with
// status 0 once nothing is left to run, whatever process.exitCode says, so a failed
// check sets the status again as the process exits. Another failing status stands.
let failed = false;
function failCheck(message: string) {
  console.error(message);
  if (failed) return;
  failed = true;
  process.on("exit", (code) => {
    if (code === 0) process.exitCode = 1;
  });
}
const SIGNATURE_DIFFERS = "The signature is not the one the signing variables asked for.";

// What the macOS apps' signatures are, read back from the bundles. electron-builder
// skips signing in a pull request's CI run even with an identity set.
if (target === "mac") {
  const output = packageOutput(env, APP_DIR);
  for (const folder of check
    ? [process.arch === "arm64" ? "mac-arm64" : "mac"]
    : ["mac-arm64", "mac"]) {
    const app = join(output.path, folder, `${PRODUCT_NAME}.app`);
    const shown = spawnSync("codesign", ["--display", "--verbose=2", app], { encoding: "utf8" });
    const { kind, matches } = checkMacSignature(plan.mac, shown);
    console.log(`Signature of ${output.label}/${folder}/${PRODUCT_NAME}.app: ${kind}.`);
    if (!matches) failCheck(SIGNATURE_DIFFERS);
  }
}

// What the Windows executable's and x64 installer's signatures are, read back from
// the files. A signed build's must come from the certificate read above, not just
// any. electron-builder deletes its copy of the uninstaller once the installer
// holds it, so the uninstaller can be read only from an install.
if (target === "win") {
  const output = packageOutput(env, APP_DIR);
  const { version } = require("./package.json") as { version: string };
  const installer = `${PRODUCT_NAME}-${version}-win-x64.exe`;
  if (!artifacts.some((file) => resolve(file) === join(output.path, installer)))
    failCheck(`The build made no ${output.label}/${installer}.`);
  for (const file of [`win-unpacked/${PRODUCT_NAME}.exe`, installer]) {
    const shown = readWindowsSignature(join(output.path, file), process.env);
    const { kind, matches } = checkWindowsSignature(signer, shown);
    console.log(`Signature of ${output.label}/${file}: ${kind}.`);
    if (!matches) failCheck(SIGNATURE_DIFFERS);
  }
}
