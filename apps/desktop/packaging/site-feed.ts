// Assembles the website for GitHub Pages, with the newest published beta's feed:
//
//   node apps/desktop/packaging/site-feed.ts <site source> <output folder>
//
// It refuses a missing site source, which has to hold index.html, one that has
// its own updates/beta/, which is only ever the generated feed, and an output
// folder that is not empty. It copies the source, reads the repository's
// releases from GitHub's API, takes
// the newest published beta that carries both Mac zips, feed.json and
// latest-mac.json, checks the two files against GitHub's digest of each, each
// other and the release's tag, and each zip against GitHub's size and digest,
// reads each zip from its release address, following only the redirect the app
// follows, to check the SHA-512 the app will check and the SHA-256
// install.sh will check, both of the same download, and writes them to
// <output>/updates/beta/. From the same beta it fills the Mac download page
// (download/mac/index.html, a template) and requires install.sh to pin that
// beta's team. With no published beta, a template token left or another
// team pinned, it fails, so the workflow deploys nothing and the last
// deployment stays; it assembles in a temporary folder and copies the result
// to <output> only once every check has passed. The Site workflow runs it on every deploy, from main
// only; docs/development/releases.md has the flow.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GITHUB_RELEASE_ASSETS, releaseAssetRedirect } from "../src/main/update/address.ts";
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

/** One request, returning a redirect rather than following it. */
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

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * A release file from its download address, by the desktop updater's rule
 * (`releaseAssetRedirect`): GitHub's one redirect to its asset host, and no
 * redirect after it, so the site never serves a feed whose files the app
 * would refuse to download.
 */
async function releaseFile(get: Get, url: string): Promise<Response> {
  let response = await get(url, {});
  if (REDIRECTS.has(response.status)) {
    await response.body?.cancel();
    const next = releaseAssetRedirect(
      new URL(url),
      response.headers.get("location") ?? undefined,
      GITHUB_RELEASE_ASSETS,
    );
    if (!next) throw new Error(`${url} redirects elsewhere than GitHub's asset host.`);
    response = await get(next.href, {});
    if (REDIRECTS.has(response.status)) {
      await response.body?.cancel();
      throw new Error(`${url} redirects more than once.`);
    }
  }
  if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}.`);
  return response;
}

/** A release's JSON file as text, only if its bytes are the ones GitHub's digest names. */
async function releaseJson(get: Get, tag: string, asset: ReleaseRow["assets"][number]) {
  const response = await releaseFile(get, asset.browser_download_url);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (asset.digest !== `sha256:${createHash("sha256").update(bytes).digest("hex")}`)
    throw new Error(`${asset.name} on ${tag} is not the file GitHub's digest names.`);
  // Exactly these bytes are written back: invalid UTF-8 is refused and a BOM is kept.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

/**
 * The size, base64 SHA-512 (what the app checks) and hex SHA-256 (what
 * install.sh checks) of what an address serves, read once as a stream.
 */
async function streamedDigests(
  get: Get,
  url: string,
): Promise<{ size: number; sha512: string; sha256: string }> {
  const response = await releaseFile(get, url);
  const sha512 = createHash("sha512");
  const sha256 = createHash("sha256");
  let size = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    sha512.update(chunk);
    sha256.update(chunk);
    size += chunk.length;
  }
  return { size, sha512: sha512.digest("base64"), sha256: sha256.digest("hex") };
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
    await releaseJson(get, tag, asset(FEED_NAME)),
    await releaseJson(get, tag, asset(LATEST_MAC_NAME)),
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
    // One download must satisfy both: the app's SHA-512 and install.sh's SHA-256.
    const served = await streamedDigests(get, zip.browser_download_url);
    if (served.size !== entry.size || served.sha512 !== entry.sha512 || served.sha256 !== sha256)
      throw new Error(mismatch);
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
 * source, a source with its own updates/beta/, an output that is not empty, no
 * beta to fill the page from, a template token left anywhere, and an install
 * script whose pinned team is the placeholder or not the beta's.
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
  // Copying over an earlier assembly would keep pages since removed from the source.
  if (existsSync(output) && readdirSync(output).length)
    throw new Error(`${output} is not empty: assemble the site into a new folder.`);
  // Assembled aside, so a refusal leaves <output> as it was and a rerun can use it.
  const work = mkdtempSync(join(tmpdir(), "clawtrate-site-"));
  try {
    cpSync(source, work, { recursive: true });
    const tag = await writeSiteFeed(work, get, token);
    if (!tag)
      throw new Error("No published beta: the download page cannot be filled, so nothing deploys.");
    const latest = JSON.parse(
      readFileSync(join(work, "updates", "beta", LATEST_MAC_NAME), "utf8"),
    ) as LatestMac;

    const page = join(work, DOWNLOAD_PAGE);
    const filled = readFileSync(page, "utf8")
      .replaceAll("__CLAWTRATE_BETA_VERSION__", tag.slice(1))
      .replaceAll("__CLAWTRATE_ARM64_ZIP__", latest.arm64.url)
      .replaceAll("__CLAWTRATE_X64_ZIP__", latest.x86_64.url)
      .replaceAll(
        "__CLAWTRATE_RELEASE_PAGE__",
        `https://github.com/${REPOSITORY}/releases/tag/${tag}`,
      );
    writeFileSync(page, filled);
    for (const file of filesUnder(work)) {
      const left = TEMPLATE_TOKEN.exec(readFileSync(join(work, file), "latin1"));
      if (left) throw new Error(`${file} still holds ${left[0]}, so nothing deploys.`);
    }

    const pins = [
      ...readFileSync(join(work, INSTALL_SCRIPT), "utf8").matchAll(
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
    mkdirSync(output, { recursive: true });
    cpSync(work, output, { recursive: true });
    return tag;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The command: assembles the site and, in Actions, passes the beta's tag on to the deploy job. */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  get: Get,
): Promise<number> {
  const [source, output] = argv;
  if (!source || !output) {
    console.error("usage: node apps/desktop/packaging/site-feed.ts <site source> <output folder>");
    return 2;
  }
  const tag = await assembleSite(source, output, get, env.GITHUB_TOKEN);
  // The deploy job checks this beta is still published before deploying it.
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `tag=${tag}\n`);
  console.log(`The site, its Beta feed and its download page are from ${tag}.`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), process.env, (url, headers) =>
    fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(60_000) }),
  );
}
