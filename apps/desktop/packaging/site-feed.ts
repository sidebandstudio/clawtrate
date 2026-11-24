// Assembles the website for GitHub Pages, with the newest published beta's feed:
//
//   node apps/desktop/packaging/site-feed.ts <site source> <output folder>
//
// It refuses a missing site source, which has to hold index.html, one that has
// its own updates/channel/beta/ or updates/beta/, which only ever hold the
// generated feeds, and an output folder that is not empty. It copies the
// source, reads the repository's releases from GitHub's API, takes the newest
// published beta that carries both Mac zips, feed.json and latest-mac.json,
// checks the two files against GitHub's digest of each, each other and the
// release's tag, and each zip against GitHub's size and digest, reads each zip
// from its release address, following only the redirect the app follows, to
// check the SHA-512 the app will check and the SHA-256 install.sh will check,
// both of the same download, and writes them to <output>/updates/channel/beta/,
// the folder builds read. It writes the same files to <output>/updates/beta/,
// the folder betas published before that one read, or, while LEGACY_BETA_PIN
// names a beta, that beta's files, checked the same way, and only when its
// feed records that its build reads the new folder. From the newest beta it
// fills the Mac download page (download/mac/index.html, a template) and
// requires install.sh to pin that beta's team. The page's "What's new" section
// is the newest betas' own lists: the "- " lines under "What's new:" on each
// release's page, as plain text, and the same lists go beside each feed as
// whats-new.json, which the app reads inside a check (F-554); beside a pinned
// legacy feed they stop at the pinned beta. With no published beta, a template
// token left, another team pinned or a pin it can't serve, it fails, so the
// workflow deploys nothing and the last deployment stays; it assembles in a
// temporary folder and copies the result to <output> only once every check has
// passed. The Site workflow runs it on every deploy, from main only;
// docs/development/releases.md has the flow.

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
  isTitle,
  MAX_WHATS_NEW_ITEMS,
  WHATS_NEW_FILE,
  WHATS_NEW_FORMAT,
} from "../src/main/update/whats-new.ts";
import {
  BETA_FEED_URL,
  BETA_FOLDER,
  checkBetaFiles,
  LEGACY_BETA_FOLDER,
  LEGACY_BETA_PIN,
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

/** The repository's releases, as GitHub's API lists them. */
async function releaseRows(get: Get, token: string | undefined): Promise<ReleaseRow[]> {
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
  return rows;
}

/** The line a release page puts above its list of what the beta adds. */
export const WHATS_NEW_HEADING = "What's new:";

/**
 * What a release page says the beta adds, as plain text. The contract is
 * narrow on purpose: the last line reading "What's new:", then the lines that
 * begin "- " at the margin, up to the first line that is neither one of those
 * nor a blank before the list. The release tooling writes that block last.
 * Nothing else on the page is read, and it is not read as Markdown: a title
 * that is too long, or holds a character outside `TITLE`, is left out.
 */
export function whatsNew(body: string | null | undefined): string[] {
  const lines = (body ?? "").split(/\r\n?|\n/);
  let start = -1;
  lines.forEach((line, at) => {
    if (line.trim() === WHATS_NEW_HEADING) start = at;
  });
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("- ")) {
      if (line.trim() === "" && !items.length) continue;
      break;
    }
    // The app's own rule (isTitle), so the page and the app show the same lines.
    const item = line.slice(2).trim();
    if (isTitle(item)) items.push(item);
    if (items.length === MAX_WHATS_NEW_ITEMS) break;
  }
  return items;
}

/** whats-new.json: the newest betas' lists, as the app reads them (update/whats-new.ts). */
export function whatsNewFile(rows: readonly ReleaseRow[]): string {
  const text = JSON.stringify({ format: WHATS_NEW_FORMAT, builds: betaNotes(rows) }, null, 2);
  // A title may name a template token. With the second "_" of each "__" written "\u005f"
  // it reads back the same and is not mistaken for a token left in the site. Only those:
  // each costs five bytes more, and the largest list must stay under the app's cap.
  return `${text.replaceAll("__", "_\\u005f")}\n`;
}

/** The newest published betas whose pages list what they add, newest first. */
export function betaNotes(
  rows: readonly ReleaseRow[],
  limit = 5,
): Array<{ version: string; items: string[] }> {
  const betas = rows.flatMap((row) => {
    if (row.draft || !row.prerelease || !row.tag_name.startsWith("v")) return [];
    const version = parseVersion(row.tag_name.slice(1));
    if (!version || versionTrack(version) !== "nightly") return [];
    const items = whatsNew(row.body);
    return items.length ? [{ version, text: row.tag_name.slice(1), items }] : [];
  });
  betas.sort((a, b) =>
    isNewer(a.version, b.version) ? -1 : isNewer(b.version, a.version) ? 1 : 0,
  );
  return betas.slice(0, limit).map(({ text, items }) => ({ version: text, items }));
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (value: string) =>
  value
    .replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!)
    // A title may name a template token. Written with entities it shows as typed,
    // is not filled in, and is not mistaken for a token left in the page.
    .replaceAll("__", "&#95;&#95;");

/**
 * The download page's "What's new" section, which opens on a click: each
 * beta's list, with a change's closing "(#123)" linked to its pull request.
 * Empty when no beta has a list.
 */
export function whatsNewHtml(
  notes: ReadonlyArray<{ version: string; items: readonly string[] }>,
  current: string,
): string {
  if (!notes.length) return "";
  const item = (value: string) =>
    escapeHtml(value).replace(
      /\(#(\d{1,7})\)$/,
      `(<a href="https://github.com/${REPOSITORY}/pull/$1">#$1</a>)`,
    );
  const builds = notes.map(
    ({ version, items }) =>
      `<article class="whats-new-build"><h3>${escapeHtml(version)}${
        version === current ? ' <span class="whats-new-current">This beta</span>' : ""
      }</h3><ul>${items.map((value) => `<li>${item(value)}</li>`).join("")}</ul></article>`,
  );
  // Closed until the visitor opens it, so the downloads stay the page's first thing.
  return (
    '<details class="whats-new">' +
    "<summary><h2>What's new</h2></summary>" +
    '<p class="whats-new-note">What each beta added, newest first.</p>' +
    builds.join("") +
    "</details>"
  );
}

/**
 * A beta's feed.json and latest-mac.json, read from its release and checked:
 * against GitHub's digest of each, each other and the tag, and each zip they
 * name against GitHub's size and digest and the bytes it serves.
 */
async function checkedFiles(get: Get, release: ReleaseRow) {
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
  return files;
}

/** The generated folders, which a site source may not hold. */
const FEED_FOLDERS = [BETA_FOLDER, LEGACY_BETA_FOLDER] as const;

/** One Beta feed folder: a beta's two files as its release holds them, and the lists beside them. */
function writeFeedFolder(
  folder: string,
  files: { feed: string; latest: string },
  whatsNew: string,
) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, FEED_NAME), files.feed);
  writeFileSync(join(folder, LATEST_MAC_NAME), files.latest);
  // What the newest betas add, for the app to read inside a check (F-554); the
  // two files above are written exactly as the release holds them.
  writeFileSync(join(folder, WHATS_NEW_FILE), whatsNew);
}

/**
 * Writes both Beta feed folders and returns the newest beta's tag, or null
 * when there is no beta. `rows` are the releases already read, when the caller
 * has them. The new folder serves the newest beta. The legacy folder, which
 * betas published before it read, serves the same files, or the pinned beta's
 * when `pin` names one; its lists then stop at that beta.
 */
export async function writeSiteFeed(
  site: string,
  get: Get,
  token: string | undefined,
  rows?: readonly ReleaseRow[],
  pin: string | null = LEGACY_BETA_PIN,
): Promise<string | null> {
  for (const name of FEED_FOLDERS)
    if (existsSync(join(site, name)))
      throw new Error(`${name}/ is a generated Beta feed's folder; the site may not have one.`);
  const all = rows ?? (await releaseRows(get, token));
  const release = newestBeta(all);
  if (!release) return null;
  const files = await checkedFiles(get, release);
  const whatsNew = whatsNewFile(all);
  writeFeedFolder(join(site, BETA_FOLDER), files, whatsNew);
  if (pin === null) {
    writeFeedFolder(join(site, LEGACY_BETA_FOLDER), files, whatsNew);
    return release.tag_name;
  }
  const pinned = newestBeta(all.filter((row) => row.tag_name === `v${pin}`));
  if (!pinned)
    throw new Error(
      `The legacy Beta feed is pinned to ${pin}, which is not a published beta with its files, so nothing deploys.`,
    );
  const ceiling = parseVersion(pin)!;
  const upToPin = all.filter((row) => {
    const version = parseVersion(row.tag_name.slice(1));
    return version !== null && !isNewer(version, ceiling);
  });
  const pinnedFiles = await checkedFiles(get, pinned);
  // The beta old copies update to must read the new folder, or they would stay here.
  if ((JSON.parse(pinnedFiles.feed) as { buildFeed?: unknown }).buildFeed !== BETA_FEED_URL)
    throw new Error(
      `The legacy Beta feed is pinned to ${pin}, whose release does not record that its build reads ${BETA_FEED_URL}, so nothing deploys.`,
    );
  writeFeedFolder(join(site, LEGACY_BETA_FOLDER), pinnedFiles, whatsNewFile(upToPin));
  return release.tag_name;
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
 * source, a source with either feed folder of its own, an output that is not empty, no
 * beta to fill the page from, a template token left anywhere, and an install
 * script whose pinned team is the placeholder or not the beta's.
 */
export async function assembleSite(
  source: string,
  output: string,
  get: Get,
  token: string | undefined,
  pin: string | null = LEGACY_BETA_PIN,
): Promise<string> {
  if (!existsSync(join(source, "index.html")))
    throw new Error(`${source}/index.html does not exist: there is no site to deploy.`);
  for (const name of FEED_FOLDERS)
    if (existsSync(join(source, name)))
      throw new Error(`${source}/${name}/ is reserved for a generated Beta feed.`);
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
    // Read once: the feed comes from the newest beta, the page's list from the newest few.
    const rows = await releaseRows(get, token);
    const tag = await writeSiteFeed(work, get, token, rows, pin);
    if (!tag)
      throw new Error("No published beta: the download page cannot be filled, so nothing deploys.");
    const latest = JSON.parse(
      readFileSync(join(work, BETA_FOLDER, LATEST_MAC_NAME), "utf8"),
    ) as LatestMac;

    const page = join(work, DOWNLOAD_PAGE);
    const filled = readFileSync(page, "utf8")
      .replaceAll("__CLAWTRATE_BETA_VERSION__", tag.slice(1))
      .replaceAll("__CLAWTRATE_ARM64_ZIP__", latest.arm64.url)
      .replaceAll("__CLAWTRATE_X64_ZIP__", latest.x86_64.url)
      .replaceAll(
        "__CLAWTRATE_RELEASE_PAGE__",
        `https://github.com/${REPOSITORY}/releases/tag/${tag}`,
      )
      // A function, so the section goes in as written: in a replacement string
      // a title's "$&" or "$`" would be read as a pattern.
      .replaceAll("__CLAWTRATE_WHATS_NEW__", () => whatsNewHtml(betaNotes(rows), tag.slice(1)));
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
  pin: string | null = LEGACY_BETA_PIN,
): Promise<number> {
  const [source, output] = argv;
  if (!source || !output) {
    console.error("usage: node apps/desktop/packaging/site-feed.ts <site source> <output folder>");
    return 2;
  }
  const tag = await assembleSite(source, output, get, env.GITHUB_TOKEN, pin);
  const pinned = pin === null ? "" : `v${pin}`;
  // The deploy job checks both betas are still published before deploying them.
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `tag=${tag}\npinned=${pinned}\n`);
  console.log(
    pinned
      ? `The site, its Beta feed and its download page are from ${tag}. The legacy Beta feed is pinned to ${pinned}.`
      : `The site, both Beta feeds and its download page are from ${tag}.`,
  );
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), process.env, (url, headers) =>
    fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(60_000) }),
  );
}
