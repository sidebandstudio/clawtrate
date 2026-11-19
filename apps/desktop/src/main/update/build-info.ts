// What the build fixed: the feed's address and the build's own release date.
// Both are constants electron-vite writes into the main bundle
// (`packaging/update-defines.ts`); the packaged app reads neither from its
// environment, a file, a link or the gateway. Without them (a unit test) the
// feed is not configured and the release date is unknown.

import { UpdateEngine, type NewerVersion, type UpdateEngineOptions } from "./engine.ts";

declare const __CLAWTRATE_UPDATE_FEED__: string | null | undefined;
declare const __CLAWTRATE_RELEASE_DATE__: string | null | undefined;

export const BUILD_FEED_ADDRESS: string | null =
  typeof __CLAWTRATE_UPDATE_FEED__ === "string" ? __CLAWTRATE_UPDATE_FEED__ : null;

export const BUILD_RELEASE_DATE: string | null =
  typeof __CLAWTRATE_RELEASE_DATE__ === "string" ? __CLAWTRATE_RELEASE_DATE__ : null;

/** The production engine: the address is the build's, and nothing else can set it. */
export function productionUpdateEngine(
  options: Pick<
    UpdateEngineOptions,
    "currentVersion" | "downloadDir" | "platform" | "arch" | "onState"
  >,
): UpdateEngine {
  const { currentVersion, downloadDir, platform, arch, onState } = options;
  return new UpdateEngine({
    feedAddress: BUILD_FEED_ADDRESS,
    currentVersion,
    downloadDir,
    platform,
    arch,
    ...(onState ? { onState } : {}),
  });
}

export const UPDATE_REQUIRED_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * F-010: "Update required" when a newer version exists and this build is more
 * than 14 days old by its own release date. The feed's dates play no part.
 */
export function isUpdateRequired(
  newer: NewerVersion | null,
  buildReleaseDate: string | null,
  now: Date,
): boolean {
  if (!newer || !buildReleaseDate) return false;
  const built = Date.parse(buildReleaseDate);
  return Number.isFinite(built) && now.getTime() - built > UPDATE_REQUIRED_AFTER_MS;
}
