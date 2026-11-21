// Assembles the website for GitHub Pages, with the newest published beta's feed:
//
//   node apps/desktop/packaging/site-feed.ts <site source> <output folder>
//
// It refuses a missing site source, which has to hold index.html, and one that
// has its own updates/beta/: that folder is only ever the generated feed. It
// copies the source, reads the repository's releases from GitHub's API, takes
// the newest published beta that carries both Mac zips, feed.json and
// latest-mac.json, checks the two files against each other, the release's tag
// and GitHub's size and digest of each zip, reads each zip from its release
// address to check the SHA-512 the app will check, and writes them to
// <output>/updates/beta/. From the same beta it fills the Mac download page
// (download/mac/index.html, a template) and requires install.sh to pin that
// beta's team. With no published beta, a template token left or another
// team pinned, it fails, so the workflow deploys nothing and the last
// deployment stays. The Site workflow runs it on every deploy, from main
// only; docs/development/releases.md has the flow.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isNewer, parseVersion, versionTrack } from "../src/main/update/version.ts";
import {
  checkBetaFiles,
  releaseFolder,
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
  body?: string | null;
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

/** The size and base64 SHA-512 of what an address serves, read as a stream. */
async function streamedSha512(get: Get, url: string): Promise<{ size: number; sha512: string }> {
  const response = await get(url, {});
  if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}.`);
  const hash = createHash("sha512");
  let size = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha512: hash.digest("base64") };
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
  // Each architecture's entries name the zip GitHub holds: its size and digest
  // as GitHub reports them, and the SHA-512 of the bytes it serves, which is
  // what the app checks. Both are checked before either file is written.
  const feed = JSON.parse(files.feed) as {
    files: Record<string, { size: number; sha512: string }>;
  };
  const latest = JSON.parse(files.latest) as LatestMac;
  for (const [arch, key] of Object.entries(MAC_ARCHITECTURES)) {
    const zip = asset(artifactName(version, key));
    const entry = feed.files[key]!;
    const sha256 = latest[arch as keyof typeof MAC_ARCHITECTURES].sha256;
    const mismatch = `${zip.name} on ${tag} is not the file its feed and latest-mac.json name.`;
    if (
      zip.state !== "uploaded" ||
      zip.browser_download_url !== `${releaseFolder(tag)}${zip.name}` ||
      zip.size !== entry.size ||
      zip.digest !== `sha256:${sha256}`
    )
      throw new Error(mismatch);
    const served = await streamedSha512(get, zip.browser_download_url);
    if (served.size !== entry.size || served.sha512 !== entry.sha512) throw new Error(mismatch);
  }
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, FEED_NAME), files.feed);
  writeFileSync(join(folder, LATEST_MAC_NAME), files.latest);
  return tag;
}

/** The Mac download page, a template the assembly fills from the beta it serves. */
export const DOWNLOAD_PAGE = join("download", "mac", "index.html");
/** The install script, whose pinned team must be the beta's. */
export const INSTALL_SCRIPT = "install.sh";
/** What the install script holds until the owner pins the real team. */
export const TEAM_PLACEHOLDER = "APPLE_CLAWTRATE_TEAM_ID";
const TEMPLATE_TOKEN = /__CLAWTRATE_[A-Z0-9_]+__/;

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = join(prefix, entry.name);
    return entry.isDirectory() ? filesUnder(dir, path) : [path];
  });
}

/**
 * Copies the site source into `output`, adds the Beta feed, and fills the Mac
 * download page from the same beta. Refuses, so nothing deploys, a missing
 * source, a source with its own updates/beta/, no beta to fill the page from,
 * a template token left anywhere, and an install script whose pinned team is
 * the placeholder or not the beta's.
 */
export async function assembleSite(
  source: string,
  output: string,
  get: Get,
  token: string | undefined,
): Promise<string> {
  if (!existsSync(join(source, "index.html")))
    throw new Error(`${source}/index.html does not exist: there is no site to deploy.`);
  if (existsSync(join(source, "updates", "beta")))
    throw new Error(`${source}/updates/beta/ is reserved for the generated Beta feed.`);
  for (const required of [DOWNLOAD_PAGE, INSTALL_SCRIPT])
    if (!existsSync(join(source, required)))
      throw new Error(`${source}/${required} does not exist: there is no site to deploy.`);
  mkdirSync(output, { recursive: true });
  cpSync(source, output, { recursive: true });
  const tag = await writeSiteFeed(output, get, token);
  if (!tag)
    throw new Error("No published beta: the download page cannot be filled, so nothing deploys.");
  const latest = JSON.parse(
    readFileSync(join(output, "updates", "beta", LATEST_MAC_NAME), "utf8"),
  ) as LatestMac;

  const page = join(output, DOWNLOAD_PAGE);
  const filled = readFileSync(page, "utf8")
    .replaceAll("__CLAWTRATE_BETA_VERSION__", tag.slice(1))
    .replaceAll("__CLAWTRATE_ARM64_ZIP__", latest.arm64.url)
    .replaceAll("__CLAWTRATE_X64_ZIP__", latest.x86_64.url)
    .replaceAll(
      "__CLAWTRATE_RELEASE_PAGE__",
      `https://github.com/${REPOSITORY}/releases/tag/${tag}`,
    );
  writeFileSync(page, filled);
  for (const file of filesUnder(output)) {
    const left = TEMPLATE_TOKEN.exec(readFileSync(join(output, file), "latin1"));
    if (left) throw new Error(`${file} still holds ${left[0]}, so nothing deploys.`);
  }

  const pins = [
    ...readFileSync(join(output, INSTALL_SCRIPT), "utf8").matchAll(
      /^CLAWTRATE_TEAM_ID="([^"]*)"$/gm,
    ),
  ];
  if (pins.length !== 1)
    throw new Error(
      `${INSTALL_SCRIPT} must pin CLAWTRATE_TEAM_ID exactly once, so nothing deploys.`,
    );
  const team = pins[0]![1]!;
  if (team === TEAM_PLACEHOLDER)
    throw new Error(
      `${INSTALL_SCRIPT} still pins the placeholder ${TEAM_PLACEHOLDER}, so nothing deploys.`,
    );
  if (team !== latest.teamIdentifier)
    throw new Error(
      `${INSTALL_SCRIPT} pins team ${team}, but ${tag} is signed by ${latest.teamIdentifier}, so nothing deploys.`,
    );
  return tag;
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
  console.log(`The site, its Beta feed and its download page are from ${tag}.`);
}
