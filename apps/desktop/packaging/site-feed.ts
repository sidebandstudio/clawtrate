// Assembles the website for GitHub Pages, with the newest published beta's feed:
//
//   node apps/desktop/packaging/site-feed.ts <site source> <output folder>
//
// It refuses a missing site source, which has to hold index.html, and one that
// has its own updates/beta/: that folder is only ever the generated feed. It
// copies the source, reads the repository's releases from GitHub's API, takes
// the newest published beta that carries both Mac zips, feed.json and
// latest-mac.json, checks the two files against each other, the release's tag
// and GitHub's size and digest of each zip, and writes them to
// <output>/updates/beta/. With no published beta it writes no feed, so a
// withdrawn first beta leaves none. The Site workflow runs it on every deploy
// and every release event; docs/development/releases.md has the flow.

import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isNewer, parseVersion, versionTrack } from "../src/main/update/version.ts";
import {
  checkBetaFiles,
  FEED_NAME,
  LATEST_MAC_NAME,
  MAC_ARCHITECTURES,
  REPOSITORY,
  type LatestMac,
} from "./beta-files.ts";
import { artifactName } from "./feed.ts";

export interface ReleaseRow {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  target_commitish?: string;
  assets: Array<{
    id?: number;
    name: string;
    size?: number;
    /** GitHub's digest of the uploaded file, `sha256:<hex>`. */
    digest?: string | null;
    state?: string;
    browser_download_url: string;
  }>;
}

export type Get = (url: string, headers: Record<string, string>) => Promise<Response>;

/** The newest release that is published, a beta by its tag, and carries all four files. */
export function newestBeta(rows: readonly ReleaseRow[]): ReleaseRow | null {
  let best: { row: ReleaseRow; version: NonNullable<ReturnType<typeof parseVersion>> } | null =
    null;
  for (const row of rows) {
    if (row.draft || !row.prerelease || !row.tag_name.startsWith("v")) continue;
    const version = parseVersion(row.tag_name.slice(1));
    if (!version || versionTrack(version) !== "nightly") continue;
    const names = row.assets.map((asset) => asset.name);
    const needed = [
      FEED_NAME,
      LATEST_MAC_NAME,
      ...Object.values(MAC_ARCHITECTURES).map((key) => artifactName(row.tag_name.slice(1), key)),
    ];
    if (!needed.every((name) => names.includes(name))) continue;
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
  const folder = join(site, "updates", "beta");
  if (existsSync(folder))
    throw new Error(
      "updates/beta/ is the generated Beta feed's folder; the site may not have one.",
    );
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
  const tag = release.tag_name;
  const version = tag.slice(1);
  const asset = (name: string) => release.assets.find((candidate) => candidate.name === name)!;
  const files = checkBetaFiles(
    tag,
    await text(get, asset(FEED_NAME).browser_download_url, {}),
    await text(get, asset(LATEST_MAC_NAME).browser_download_url, {}),
  );
  // Each architecture's entries name the zip GitHub holds: its size and its digest.
  const feed = JSON.parse(files.feed) as { files: Record<string, { size: number }> };
  const latest = JSON.parse(files.latest) as LatestMac;
  for (const [arch, key] of Object.entries(MAC_ARCHITECTURES)) {
    const zip = asset(artifactName(version, key));
    const sha256 = latest[arch as keyof typeof MAC_ARCHITECTURES].sha256;
    if (zip.size !== feed.files[key]!.size || zip.digest !== `sha256:${sha256}`)
      throw new Error(`${zip.name} on ${tag} is not the file its feed and latest-mac.json name.`);
  }
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, FEED_NAME), files.feed);
  writeFileSync(join(folder, LATEST_MAC_NAME), files.latest);
  return tag;
}

/** Copies the site source into `output` and adds the Beta feed. Refuses a missing source. */
export async function assembleSite(
  source: string,
  output: string,
  get: Get,
  token: string | undefined,
): Promise<string | null> {
  if (!existsSync(join(source, "index.html")))
    throw new Error(`${source}/index.html does not exist: there is no site to deploy.`);
  if (existsSync(join(source, "updates", "beta")))
    throw new Error(`${source}/updates/beta/ is reserved for the generated Beta feed.`);
  mkdirSync(output, { recursive: true });
  cpSync(source, output, { recursive: true });
  return writeSiteFeed(output, get, token);
}

if (import.meta.main) {
  const [source, output] = process.argv.slice(2);
  if (!source || !output) {
    console.error("usage: node apps/desktop/packaging/site-feed.ts <site source> <output folder>");
    process.exit(2);
  }
  const tag = await assembleSite(
    source,
    output,
    (url, headers) => fetch(url, { headers, signal: AbortSignal.timeout(60_000) }),
    process.env.GITHUB_TOKEN,
  );
  console.log(tag ? `Beta feed from ${tag}.` : "No published beta: the site has no Beta feed.");
}
