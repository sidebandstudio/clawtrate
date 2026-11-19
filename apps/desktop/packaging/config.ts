// The electron-builder configuration for the packaged desktop app.
//
// It is a function of the environment so that signing can be turned on later
// without a code change: with no signing variables the macOS app is ad-hoc
// signed and not notarized, and the Windows installer is not signed. See
// docs/development/packaging.md for the variables.

import { FuseV1Options, FuseVersion, type FuseV1Config } from "@electron/fuses";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { AfterPackContext, Configuration } from "electron-builder";
import { APP_ID } from "../src/main/identity.ts";

export { APP_ID };
export const PRODUCT_NAME = "Clawtrate";

export type Env = Record<string, string | undefined>;

/**
 * macOS signing is on when a Developer ID certificate is named: CSC_LINK (a
 * .p12 file or its base64) or CSC_NAME (an identity already in the keychain).
 * Without either, electron-builder is told there is no identity, so it never
 * looks in the keychain.
 */
export function macSigningRequested(env: Env): boolean {
  return Boolean(env.CSC_LINK?.trim() || env.CSC_NAME?.trim());
}

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

/** Flip the fuses, then, on an unsigned macOS build, sign ad hoc so the app runs on Apple silicon. */
export function afterPack(env: Env) {
  return async (context: AfterPackContext): Promise<void> => {
    const platform = context.electronPlatformName;
    await context.packager.addElectronFuses(context, fuses(platform));
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
    directories: { output: "dist", buildResources: "resources" },
    // The main process, preload and renderer are bundled by electron-vite and
    // need no node_modules. Nothing else is shipped: not the web preview's or
    // the fixture mode's builds, and no source. resources/icon.png, generated
    // from the logo, is the window icon on Windows and Linux (the main process
    // reads it from the archive); macOS takes its icon from the bundle.
    files: [
      "package.json",
      "out/main/**",
      "out/preload/**",
      "out/renderer/**",
      "resources/icon.png",
      "!**/node_modules/**",
    ],
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
      // CSC_NAME and notarizes when the APPLE_* variables are set.
      ...(signMac ? {} : { identity: null }),
      hardenedRuntime: true,
      notarize: signMac,
    },
    dmg: { writeUpdateInfo: false },
    win: {
      icon: "resources/icon.ico",
      target: [{ target: "nsis", arch: ["x64"] }],
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
