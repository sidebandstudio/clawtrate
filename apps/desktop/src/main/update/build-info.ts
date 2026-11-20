// Feed addresses and the release date are compiled into the main bundle.
import { DesktopUpdateService, type UpdateServiceOptions } from "./service.ts";

import { windowsInstall } from "../windows-install.ts";
import type { UpdateInstaller } from "./install.ts";
import type { UpdateInstallRefusal } from "@clawtrate/core";

declare const __CLAWTRATE_SIGNED_MAC__: boolean | undefined;
declare const __CLAWTRATE_WINDOWS_PUBLISHER__: string | null | undefined;

function buildInstaller(platform: string, arch: string, packaged: boolean): UpdateInstaller {
  const publisher =
    typeof __CLAWTRATE_WINDOWS_PUBLISHER__ === "string" ? __CLAWTRATE_WINDOWS_PUBLISHER__ : null;
  if (
    packaged &&
    platform === "win32" &&
    arch === "x64" &&
    publisher &&
    /^[A-F0-9]{64}$/.test(publisher)
  ) {
    return {
      unavailable: null,
      async inspect(file) {
        const reason = await windowsInstall(file, publisher, false);
        return reason === "installer-failed" ? "inspection-failed" : reason;
      },
      launch: (file, signal) => windowsInstall(file, publisher, true, signal),
    };
  }
  const signedMac =
    platform === "darwin" &&
    typeof __CLAWTRATE_SIGNED_MAC__ !== "undefined" &&
    __CLAWTRATE_SIGNED_MAC__;
  const unavailable: UpdateInstallRefusal =
    (platform === "win32" && arch !== "x64") ||
    (platform === "darwin" && arch !== "x64" && arch !== "arm64") ||
    (platform !== "darwin" && platform !== "win32") ||
    signedMac
      ? "no-installer-path"
      : "build-not-signed";
  return { unavailable, inspect: async () => unavailable, launch: async () => unavailable };
}

export { isUpdateRequired, UPDATE_REQUIRED_AFTER_MS } from "./engine.ts";

declare const __CLAWTRATE_UPDATE_FEED__: string | null | undefined;
declare const __CLAWTRATE_NIGHTLY_UPDATE_FEED__: string | null | undefined;
export const BUILD_NIGHTLY_FEED_ADDRESS =
  typeof __CLAWTRATE_NIGHTLY_UPDATE_FEED__ === "string" ? __CLAWTRATE_NIGHTLY_UPDATE_FEED__ : null;

declare const __CLAWTRATE_RELEASE_DATE__: string | null | undefined;

export const BUILD_FEED_ADDRESS: string | null =
  typeof __CLAWTRATE_UPDATE_FEED__ === "string" ? __CLAWTRATE_UPDATE_FEED__ : null;

export const BUILD_RELEASE_DATE: string | null =
  typeof __CLAWTRATE_RELEASE_DATE__ === "string" ? __CLAWTRATE_RELEASE_DATE__ : null;

/** Only the packager can choose the sources and date used in the running app. */
export function startDesktopUpdates(
  options: Omit<
    UpdateServiceOptions,
    "feeds" | "releaseDate" | "loopbackHttpForTests" | "installer"
  >,
) {
  const { version, packaged, platform, arch, downloadDir, store, changed, quitAfterLaunch } =
    options;
  return DesktopUpdateService.start({
    version,
    packaged,
    platform,
    arch,
    downloadDir,
    store,
    changed,
    installer: buildInstaller(platform, arch, packaged && !!quitAfterLaunch),
    ...(quitAfterLaunch && { quitAfterLaunch }),
    feeds: { stable: BUILD_FEED_ADDRESS, nightly: BUILD_NIGHTLY_FEED_ADDRESS },
    releaseDate: BUILD_RELEASE_DATE,
  });
}
