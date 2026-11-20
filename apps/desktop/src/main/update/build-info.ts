// What the build fixed: the feed's address and the build's own release date.
// Both are constants electron-vite writes into the main bundle
// (`packaging/update-defines.ts`); the packaged app reads neither from its
// environment, a file, a link or the gateway. Without them (a unit test) the
// feed is not configured and the release date is unknown.

import { UpdateEngine, type UpdateEngineOptions } from "./engine.ts";

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

/**
 * The production engine: the address and the release date are the build's,
 * and nothing else can set them.
 */
export function productionUpdateEngine(
  options: Pick<
    UpdateEngineOptions,
    "currentVersion" | "downloadDir" | "platform" | "arch" | "onState"
  >,
): UpdateEngine {
  const { currentVersion, downloadDir, platform, arch, onState } = options;
  return new UpdateEngine({
    feedAddress: BUILD_FEED_ADDRESS,
    buildReleaseDate: BUILD_RELEASE_DATE,
    currentVersion,
    downloadDir,
    platform,
    arch,
    ...(onState ? { onState } : {}),
  });
}
