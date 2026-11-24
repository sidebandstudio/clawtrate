// The files a beta release carries besides the apps: the Beta feed the app
// reads, and `latest-mac.json` for the website's install script. Both are
// written by release-beta.ts and checked again by site-feed.ts before the site
// serves them. docs/development/releases.md describes them.

import { GITHUB_RELEASE_ASSETS } from "../src/main/update/address.ts";
import { parseFeed, type FileKey } from "../src/main/update/feed.ts";
import { fitsTrack, formatVersion, parseVersion } from "../src/main/update/version.ts";
import { artifactName } from "./feed.ts";

export const REPOSITORY = "sidebandstudio/clawtrate";
/**
 * The site's folder for the Beta feed, and the one before it. Builds read the
 * first. Every beta published before it read the second, which stays served
 * so those copies can still update (docs/decisions.md, "Moving betas to three
 * numbers").
 */
export const BETA_FOLDER = "updates/channel/beta";
export const LEGACY_BETA_FOLDER = "updates/beta";
/** Where the app built for the Beta track reads its feed. */
export const BETA_FEED_URL = `https://clawtrate.dev/${BETA_FOLDER}/feed.json`;
/** Where the website's install script reads the newest Mac build. */
export const BETA_LATEST_MAC_URL = `https://clawtrate.dev/${BETA_FOLDER}/latest-mac.json`;
/** Where betas published before the new folder read their feed. */
export const LEGACY_BETA_FEED_URL = `https://clawtrate.dev/${LEGACY_BETA_FOLDER}/feed.json`;
/**
 * The beta the legacy folder serves instead of the newest one, or null to
 * serve the newest there too. It is set once, when betas move to three
 * numbers, to the last dated beta, which reads the new folder. That release
 * is never withdrawn.
 */
export const LEGACY_BETA_PIN: string | null = null;
export const FEED_NAME = "feed.json";
export const LATEST_MAC_NAME = "latest-mac.json";

/** The Mac files of a beta, keyed as `uname -m` names each architecture. */
export const MAC_ARCHITECTURES = { arm64: "mac-arm64", x86_64: "mac-x64" } as const;
export type MacArchitecture = keyof typeof MAC_ARCHITECTURES;

export interface LatestMac {
  /** The Developer ID team the apps are signed by, read from their signatures. */
  teamIdentifier: string;
  arm64: { version: string; url: string; sha256: string };
  x86_64: { version: string; url: string; sha256: string };
}

export const TEAM_ID = /^[A-Z0-9]{10}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A beta's tag: `v` and its version, dated or three numbers, as the app writes it. */
export function betaTag(version: string): string {
  const parsed = parseVersion(version);
  if (!parsed || !fitsTrack(parsed, "nightly") || formatVersion(parsed) !== version)
    throw new Error(`${version} is not a beta.`);
  return `v${version}`;
}

/** The release download folder of a tag, which the feed's files are in. */
export function releaseFolder(tag: string): string {
  return `${GITHUB_RELEASE_ASSETS.downloadPrefix}${tag}/`;
}

export function makeLatestMac(
  version: string,
  teamId: string,
  files: Record<FileKey, { url: string; sha256: string } | undefined>,
): LatestMac {
  if (!TEAM_ID.test(teamId)) throw new Error("The team identifier is not ten letters or digits.");
  const entry = (key: FileKey) => {
    const file = files[key];
    if (!file || !SHA256_HEX.test(file.sha256)) throw new Error(`No ${key} file to name.`);
    return { version, url: file.url, sha256: file.sha256 };
  };
  return { teamIdentifier: teamId, arm64: entry("mac-arm64"), x86_64: entry("mac-x64") };
}

/**
 * Checks a beta release's feed and latest-mac.json against each other and the
 * release's tag, and returns them unchanged. Throws, naming the first problem.
 */
export function checkBetaFiles(tag: string, feedText: string, latestText: string) {
  const version = tag.slice(1);
  if (betaTag(version) !== tag) throw new Error(`${tag} is not a beta tag.`);
  const read = parseFeed(feedText, new URL(BETA_FEED_URL), null, undefined, "nightly");
  if (!read.ok) throw new Error(`The feed of ${tag} is refused: ${read.cause}.`);
  const feed = JSON.parse(feedText) as {
    version: string;
    files: Partial<Record<FileKey, { url: string }>>;
  };
  if (feed.version !== version) throw new Error(`The feed of ${tag} names ${feed.version}.`);
  const keys = Object.keys(feed.files).sort();
  if (keys.join() !== "mac-arm64,mac-x64") throw new Error(`The feed of ${tag} names ${keys}.`);
  // Each architecture's own zip, by its canonical name, in this release.
  for (const key of keys as FileKey[]) {
    const url = feed.files[key]!.url;
    if (url !== `${releaseFolder(tag)}${artifactName(version, key)}`)
      throw new Error(`The feed of ${tag} does not name ${artifactName(version, key)} for ${key}.`);
  }
  let latest: LatestMac;
  try {
    latest = JSON.parse(latestText) as LatestMac;
  } catch {
    throw new Error(`The latest-mac.json of ${tag} is not JSON.`);
  }
  if (typeof latest?.teamIdentifier !== "string" || !TEAM_ID.test(latest.teamIdentifier))
    throw new Error(`The latest-mac.json of ${tag} has no team identifier.`);
  for (const [arch, key] of Object.entries(MAC_ARCHITECTURES)) {
    const entry = latest[arch as MacArchitecture];
    if (
      entry?.version !== version ||
      entry.url !== feed.files[key]!.url ||
      typeof entry.sha256 !== "string" ||
      !SHA256_HEX.test(entry.sha256)
    )
      throw new Error(`The latest-mac.json of ${tag} does not match its feed for ${arch}.`);
  }
  return { feed: feedText, latest: latestText };
}
