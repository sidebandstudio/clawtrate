// What an update adds (F-554). The site serves the newest betas' lists beside the
// Beta feed, in whats-new.json (packaging/site-feed.ts). The app reads that file
// only inside a check the person starts, from the feed's own folder, with the
// feed's rules (whats-new-read.ts). Anything wrong with it means no list: it
// never changes, fails or delays the check. This module has no Node API, so the
// site assembly uses the same rules.

import type { UpdateTrack } from "@clawtrate/core";
import { fitsTrack, formatVersion, isNewer, parseVersion } from "./version.ts";

/** The file beside each track's feed. */
export const WHATS_NEW_FILE = "whats-new.json";
export const WHATS_NEW_FORMAT = 1;
export const MAX_WHATS_NEW_BUILDS = 10;
export const MAX_WHATS_NEW_ITEMS = 30;
export const MAX_WHATS_NEW_ITEM_CHARS = 200;
export const MAX_WHATS_NEW_BYTES = 128 * 1024;
export const WHATS_NEW_TIMEOUT_MS = 5_000;

/**
 * What a change's title is made of: letters, numbers, marks, punctuation,
 * symbols and the plain space. Controls, zero-width characters, the marks
 * that reorder text and every other separator are outside it.
 */
export const TITLE = /^[\p{L}\p{N}\p{M}\p{P}\p{S} ]+$/u;
/** What a title must hold at least one of, so it never shows as an empty line: marks alone are invisible. */
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;
/**
 * Characters within VISIBLE that draw nothing: those Unicode lists as default-ignorable,
 * such as the Hangul fillers, and the blank Braille pattern. They never count as visible.
 */
const BLANK = /[\p{Default_Ignorable_Code_Point}\u2800]/u;

/**
 * Whether a title may be shown: at most 200 characters, all within TITLE, at
 * least one of them visible and not blank, nothing to trim.
 */
export function isTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_WHATS_NEW_ITEM_CHARS &&
    value.trim() === value &&
    TITLE.test(value) &&
    [...value].some((char) => VISIBLE.test(char) && !BLANK.test(char))
  );
}

export interface BuildNotes {
  version: string;
  items: string[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

/**
 * The builds whats-new.json lists, or null when it is not the file the site
 * writes: format 1, at most 10 builds, each a beta or release version written
 * as the app writes it, once, with at most 30 titles. A title outside the rule
 * is left out, and a build with none left is too.
 */
export function parseWhatsNew(text: string): BuildNotes[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !record(value) ||
    !only(value, ["format", "builds"]) ||
    value.format !== WHATS_NEW_FORMAT ||
    !Array.isArray(value.builds) ||
    value.builds.length > MAX_WHATS_NEW_BUILDS
  )
    return null;
  const seen = new Set<string>();
  const builds: BuildNotes[] = [];
  for (const build of value.builds as unknown[]) {
    if (
      !record(build) ||
      !only(build, ["version", "items"]) ||
      !Array.isArray(build.items) ||
      build.items.length > MAX_WHATS_NEW_ITEMS
    )
      return null;
    const version = parseVersion(build.version);
    if (!version || formatVersion(version) !== build.version || seen.has(build.version))
      return null;
    seen.add(build.version);
    const items = (build.items as unknown[]).filter(isTitle);
    if (items.length) builds.push({ version: build.version, items });
  }
  return builds;
}

/** whats-new.json's address: the feed's own folder, so the same origin and path rules. */
export function whatsNewAddress(feed: URL): URL {
  return new URL(WHATS_NEW_FILE, feed);
}

export interface WhatsNewView {
  /** Builds newer than the running one, up to the one offered, newest first. */
  coming: BuildNotes[];
  /** What the running build added, when the file lists it. */
  running: string[] | null;
}

/**
 * What the Updates pane shows from the builds a check read. The file is
 * unsigned, so it decides nothing and shows only what matches: the offered
 * build's list only when the file lists exactly that version (otherwise the
 * file is stale and nothing shows for the update), the builds that can be on
 * the checked track strictly between the running one and the offered one only
 * beside it, newest first, and the running build's own list only for exactly
 * its version. Undefined when there is nothing to show.
 */
export function whatsNewView(
  builds: readonly BuildNotes[],
  runningVersion: string | null,
  offeredVersion: string | null,
  track: UpdateTrack,
): WhatsNewView | undefined {
  const running = parseVersion(runningVersion);
  if (!running) return undefined;
  const offered = parseVersion(offeredVersion);
  const own = builds.find((build) => build.version === formatVersion(running))?.items ?? null;
  const offer =
    offered && isNewer(offered, running)
      ? builds.find((build) => build.version === formatVersion(offered))
      : undefined;
  const coming = offer
    ? [
        offer,
        ...builds
          .map((build) => ({ build, version: parseVersion(build.version)! }))
          // On the checked track: a dated beta is not a Stable build skipped.
          .filter(
            ({ version }) =>
              fitsTrack(version, track) && isNewer(version, running) && isNewer(offered!, version),
          )
          .sort((a, b) => (isNewer(a.version, b.version) ? -1 : 1))
          .map(({ build }) => build),
      ]
    : [];
  return coming.length || own ? { coming, running: own } : undefined;
}
