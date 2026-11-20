// Feed addresses and the release date are compiled into the main bundle.
import { DesktopUpdateService, type UpdateServiceOptions } from "./service.ts";

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
  options: Omit<UpdateServiceOptions, "feeds" | "releaseDate" | "loopbackHttpForTests">,
) {
  const { version, packaged, platform, arch, downloadDir, store, changed } = options;
  return DesktopUpdateService.start({
    version,
    packaged,
    platform,
    arch,
    downloadDir,
    store,
    changed,
    feeds: { stable: BUILD_FEED_ADDRESS, nightly: BUILD_NIGHTLY_FEED_ADDRESS },
    releaseDate: BUILD_RELEASE_DATE,
  });
}
