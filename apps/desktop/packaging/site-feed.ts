// Puts the newest published beta's feed into the website before it deploys:
//
//   node apps/desktop/packaging/site-feed.ts <site folder>
//
// It reads the repository's releases from GitHub's API, takes the newest
// published beta that carries feed.json and latest-mac.json, checks both
// against each other and the release's tag (beta-files.ts), and writes them to
// <site folder>/updates/beta/. With no published beta it writes nothing, so a
// withdrawn first beta leaves no feed. The site workflow runs it on every
// deploy and every release event; docs/development/releases.md has the flow.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isNewer, parseVersion, versionTrack } from "../src/main/update/version.ts";
import { checkBetaFiles, FEED_NAME, LATEST_MAC_NAME, REPOSITORY } from "./beta-files.ts";

export interface ReleaseRow {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: Array<{ name: string; browser_download_url: string }>;
}

export type Get = (url: string, headers: Record<string, string>) => Promise<Response>;

/** The newest release that is published, a beta by its tag, and carries both files. */
export function newestBeta(rows: ReleaseRow[]): ReleaseRow | null {
  let best: { row: ReleaseRow; version: NonNullable<ReturnType<typeof parseVersion>> } | null =
    null;
  for (const row of rows) {
    if (row.draft || !row.prerelease || !row.tag_name.startsWith("v")) continue;
    const version = parseVersion(row.tag_name.slice(1));
    if (!version || versionTrack(version) !== "nightly") continue;
    const names = row.assets.map((asset) => asset.name);
    if (!names.includes(FEED_NAME) || !names.includes(LATEST_MAC_NAME)) continue;
    if (!best || isNewer(version, best.version)) best = { row, version };
  }
  return best?.row ?? null;
}

async function text(get: Get, url: string, headers: Record<string, string>): Promise<string> {
  const response = await get(url, headers);
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return response.text();
}

/** Writes the files and returns the tag they came from, or null when there is no beta. */
export async function writeSiteFeed(
  site: string,
  get: Get,
  token: string | undefined,
): Promise<string | null> {
  const api: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const rows: ReleaseRow[] = [];
  for (let page = 1; page <= 10; page++) {
    const url = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100&page=${page}`;
    const batch = JSON.parse(await text(get, url, api)) as ReleaseRow[];
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  const release = newestBeta(rows);
  if (!release) return null;
  const asset = (name: string) =>
    release.assets.find((candidate) => candidate.name === name)!.browser_download_url;
  const files = checkBetaFiles(
    release.tag_name,
    await text(get, asset(FEED_NAME), {}),
    await text(get, asset(LATEST_MAC_NAME), {}),
  );
  const folder = join(site, "updates", "beta");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, FEED_NAME), files.feed);
  writeFileSync(join(folder, LATEST_MAC_NAME), files.latest);
  return release.tag_name;
}

if (import.meta.main) {
  const site = process.argv[2];
  if (!site) {
    console.error("usage: node apps/desktop/packaging/site-feed.ts <site folder>");
    process.exit(2);
  }
  const tag = await writeSiteFeed(
    site,
    (url, headers) => fetch(url, { headers }),
    process.env.GITHUB_TOKEN,
  );
  console.log(tag ? `Beta feed from ${tag}.` : "No published beta: the site has no Beta feed.");
}
