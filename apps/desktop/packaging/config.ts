// The electron-builder configuration for the packaged desktop app.
//
// It is a function of the environment so that signing can be turned on later
// without a code change: with no signing variables the macOS app is ad-hoc
// signed and not notarized, and the Windows installer is not signed. See
// docs/development/packaging.md for the variables.

import { FuseV1Options, FuseVersion, type FuseV1Config } from "@electron/fuses";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AfterPackContext, Configuration } from "electron-builder";
import {
  CARRIED_BUILD_DIR,
  CARRIED_LIST_NAME,
  CARRIED_RESOURCES_DIR,
} from "../src/main/carried-plugins.ts";
import { APP_ID, PRODUCT_NAME } from "../src/main/identity.ts";
import { packageOutput } from "./output.ts";
import { macSigningRequested, notarizeWith, type Env } from "./signing.ts";

export { APP_ID, macSigningRequested, PRODUCT_NAME, type Env };

/**
 * Electron fuses, flipped in the binary at package time. The packaged app has
 * no use for Node's own entry points, so they are off. Loading only from the
 * app archive, checked against its hash, is turned on for the two platforms
 * that are built: electron-builder writes the hash into Info.plist on macOS
 * and into the executable's resources on Windows. docs/decisions.md says how
 * both fuses were shown to work on Windows.
 */
export function fuses(platform: string): FuseV1Config {
  return {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    ...(platform === "darwin" || platform === "win32"
      ? {
          [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
          [FuseV1Options.OnlyLoadAppFromAsar]: true,
        }
      : {}),
  };
}

/** The helper that reads OpenClaw's settings file (setup-effortless.md §3), in Contents/Helpers. */
export const LOCAL_GATEWAY_HELPER = "ClawtrateLocalGateway";

/** `xcrun`'s arguments that build it, for packaging and its tests alike. */
export function localGatewayBuild(output: string): string[] {
  return [
    "clang",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-arch",
    "arm64",
    "-arch",
    "x86_64",
    "-mmacosx-version-min=12.0",
    join(import.meta.dirname, "mac", "local-gateway.c"),
    "-o",
    output,
  ];
}

/** Flip the fuses, then, on an unsigned macOS build, sign ad hoc so the app runs on Apple silicon. */
export function afterPack(env: Env) {
  return async (context: AfterPackContext): Promise<void> => {
    const platform = context.electronPlatformName;
    await context.packager.addElectronFuses(context, fuses(platform));
    if (platform === "darwin" && macSigningRequested(env)) {
      const helpers = join(context.appOutDir, PRODUCT_NAME + ".app", "Contents", "Helpers");
      mkdirSync(helpers, { recursive: true });
      execFileSync("/usr/bin/xcrun", [
        "clang",
        "-fobjc-arc",
        "-Wall",
        "-Werror",
        "-O2",
        "-arch",
        "arm64",
        "-arch",
        "x86_64",
        "-mmacosx-version-min=12.0",
        "-framework",
        "Foundation",
        "-framework",
        "Security",
        "-larchive.2",
        join(import.meta.dirname, "mac", "inspect-archive.m"),
        "-o",
        join(helpers, "ClawtrateUpdateInspection"),
      ]);
      execFileSync("/usr/bin/xcrun", localGatewayBuild(join(helpers, LOCAL_GATEWAY_HELPER)));
    }
    if (platform === "darwin" && !macSigningRequested(env)) {
      const app = join(context.appOutDir, `${PRODUCT_NAME}.app`);
      // "-" is the ad-hoc identity: no certificate and no keychain are involved.
      execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
      execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
    }
  };
}

export function builderConfig(env: Env, electronVersion: string): Configuration {
  const signMac = macSigningRequested(env);
  return {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    electronVersion,
    // apps/desktop/dist, or a beta release's own folder (output.ts).
    directories: { output: packageOutput(env).label, buildResources: "resources" },
    // The main process, preload and renderer are bundled by electron-vite and
    // need no node_modules. Nothing else is shipped: not the web preview's or
    // the fixture mode's builds, and no source. resources/icon.png, generated
    // from the logo, is the window icon on Windows and Linux (the main process
    // reads it from the archive); macOS takes its icon from the bundle. The list
    // of the plugins the app carries is in the archive too; their tarballs are
    // outside it, in the resources' plugins folder (carried-plugins.ts).
    files: [
      "package.json",
      "out/main/**",
      "out/preload/**",
      "out/renderer/**",
      "resources/icon.png",
      `${CARRIED_BUILD_DIR}/${CARRIED_LIST_NAME}`,
      "!**/node_modules/**",
    ],
    extraResources: [{ from: CARRIED_BUILD_DIR, to: CARRIED_RESOURCES_DIR, filter: ["*.tgz"] }],
    asar: true,
    npmRebuild: false,
    // Releasing is the owner's: nothing is uploaded and no update feed is written.
    publish: null,
    afterPack: afterPack(env),
    artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
    mac: {
      category: "public.app-category.productivity",
      icon: "resources/icon.icns",
      target: [
        { target: "dmg", arch: ["arm64", "x64"] },
        { target: "zip", arch: ["arm64", "x64"] },
      ],
      // null skips electron-builder's signing and its keychain lookup; the
      // afterPack hook signs ad hoc instead. Unset, it signs with CSC_LINK or
      // CSC_NAME, and notarizes only when a complete set of APPLE_* variables
      // is present (packaging/signing.ts).
      ...(signMac ? {} : { identity: null }),
      hardenedRuntime: true,
      notarize: signMac && notarizeWith(env) !== null,
    },
    dmg: { writeUpdateInfo: false },
    win: {
      icon: "resources/icon.ico",
      target: [{ target: "nsis", arch: ["x64"] }],
      // One SHA-256 signature per file. electron-builder's default adds a SHA-1
      // signature first, for Windows releases that cannot check SHA-256, and
      // Electron 45 runs on none of them.
      signtoolOptions: { signingHashAlgorithms: ["sha256"] },
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      differentialPackage: false,
      // The uninstaller also removes the copy of the installer kept for an updater.
      include: "packaging/installer.nsh",
    },
  };
}
