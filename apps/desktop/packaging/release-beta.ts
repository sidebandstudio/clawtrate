// Cuts a Clawtrate beta for macOS on the maintainer's Mac. CI never runs it.
//
//   pnpm release:beta                       build, sign, notarize, verify and prepare
//   pnpm release:beta --publish <version>   publish what was prepared
//   pnpm release:beta --withdraw <version>  take a published beta back
//
// Preparing reads the signing and notarization secrets from the maintainer's
// vault, writes the certificate and key into a private temporary folder that is
// deleted at the end, builds both Mac apps with candidate-build.ts, and checks
// each app inside its zip: signature, Gatekeeper, stapled ticket, bundle id,
// version and architecture. It writes the zips, the Beta feed, latest-mac.json,
// the release notes and release.json to .release/beta/<version>/. Only Apple's
// notary service receives anything; nothing is published.
//
// Publishing re-hashes those files, creates the GitHub prerelease as a draft
// with them, publishes it, downloads every file back through its public
// address, and waits for the site to serve the new feed.
//
// No secret is printed, logged or written into the checkout.
// docs/development/releases.md is the runbook.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
import { parseFeed } from "../src/main/update/feed.ts";
import { isNewer, parseVersion } from "../src/main/update/version.ts";
import {
  BETA_FEED_URL,
  BETA_LATEST_MAC_URL,
  betaTag,
  checkBetaFiles,
  FEED_NAME,
  LATEST_MAC_NAME,
  makeLatestMac,
  releaseFolder,
  REPOSITORY,
  type LatestMac,
} from "./beta-files.ts";
import { nightlyVersion } from "./candidate-version.ts";
import { APP_ID, PRODUCT_NAME } from "./config.ts";
import { artifactName, makeFeed } from "./feed.ts";

const ROOT = join(import.meta.dirname, "../../..");
const APP_DIR = join(ROOT, "apps/desktop");
export const STAGING = join(ROOT, ".release/beta");

/** The vault's names for the Developer ID certificate and the notary API key. */
export const SECRET_NAMES = [
  "APPLE_CLAWTRATE_DEVELOPER_ID_P12_BASE64",
  "APPLE_CLAWTRATE_DEVELOPER_ID_P12_PASSWORD",
  "APPLE_CLAWTRATE_NOTARY_API_KEY_P8",
  "APPLE_CLAWTRATE_NOTARY_API_KEY_ID",
  "APPLE_CLAWTRATE_NOTARY_ISSUER_ID",
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export type Secrets = Record<SecretName, string>;

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type Run = (
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; cwd?: string; inherit?: boolean },
) => RunResult;

export const run: Run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/** Each secret from the vault, or the names it does not have. Values are never printed. */
export function readSecrets(
  runner: Run,
): { ok: true; secrets: Secrets } | { ok: false; missing: SecretName[] } {
  const secrets: Partial<Secrets> = {};
  const missing: SecretName[] = [];
  for (const name of SECRET_NAMES) {
    const result = runner("fleet", ["secret", "get", name, "--scope", "personal"]);
    // What `$(...)` would keep: the output without its final newlines.
    const value = result.stdout.replace(/[\r\n]+$/, "");
    if (result.status !== 0 || !value.trim()) missing.push(name);
    else secrets[name] = value;
  }
  return missing.length ? { ok: false, missing } : { ok: true, secrets: secrets as Secrets };
}

/** The .p12 certificate's bytes from its base64, or null. */
export function p12Bytes(value: string): Buffer | null {
  const compact = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) return null;
  const bytes = Buffer.from(compact, "base64");
  return bytes.length > 0 ? bytes : null;
}

const PEM_KEY = /^-----BEGIN PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END PRIVATE KEY-----\s*$/;

/** The .p8 key as PEM text, stored as the text itself or as its base64, or null. */
export function p8Text(value: string): string | null {
  const trimmed = value.trim();
  if (PEM_KEY.test(trimmed)) return `${trimmed}\n`;
  const bytes = p12Bytes(trimmed);
  const decoded = bytes?.toString("utf8").trim();
  return decoded && PEM_KEY.test(decoded) ? `${decoded}\n` : null;
}

/** Replaces every secret, and each long line of one, with [redacted]. */
export function redact(text: string, secrets: readonly string[]): string {
  const parts = secrets
    .flatMap((secret) => [secret, ...secret.split(/\r?\n/).map((line) => line.trim())])
    .filter((part) => part.length >= 6)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const part of parts) out = out.split(part).join("[redacted]");
  return out;
}

/**
 * Writes the certificate and key into `dir`, readable by this user only, and
 * returns the build's environment: the inherited one without any signing,
 * notarizing or feed variable, plus this release's.
 */
export function signingEnvironment(
  base: NodeJS.ProcessEnv,
  secrets: Secrets,
  dir: string,
  epoch: number,
): NodeJS.ProcessEnv {
  const p12 = p12Bytes(secrets.APPLE_CLAWTRATE_DEVELOPER_ID_P12_BASE64);
  if (!p12) throw new Error("APPLE_CLAWTRATE_DEVELOPER_ID_P12_BASE64 is not base64.");
  const p8 = p8Text(secrets.APPLE_CLAWTRATE_NOTARY_API_KEY_P8);
  if (!p8) throw new Error("APPLE_CLAWTRATE_NOTARY_API_KEY_P8 is not a private key.");
  const keyId = secrets.APPLE_CLAWTRATE_NOTARY_API_KEY_ID.trim();
  if (!/^[A-Z0-9]{10}$/.test(keyId))
    throw new Error("APPLE_CLAWTRATE_NOTARY_API_KEY_ID is not ten letters or digits.");
  const certificate = join(dir, "developer-id.p12");
  const key = join(dir, `AuthKey_${keyId}.p8`);
  writeFileSync(certificate, p12, { mode: 0o600, flag: "wx" });
  writeFileSync(key, p8, { mode: 0o600, flag: "wx" });
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (!/^(CSC_|WIN_CSC_|APPLE_|CLAWTRATE_|SOURCE_DATE_EPOCH$|TMPDIR$)/.test(name))
      env[name] = value;
  }
  return {
    ...env,
    CSC_LINK: certificate,
    CSC_KEY_PASSWORD: secrets.APPLE_CLAWTRATE_DEVELOPER_ID_P12_PASSWORD,
    APPLE_API_KEY: key,
    APPLE_API_KEY_ID: keyId,
    APPLE_API_ISSUER: secrets.APPLE_CLAWTRATE_NOTARY_ISSUER_ID.trim(),
    // The Beta track only: a beta build has no Stable feed until Stable opens.
    CLAWTRATE_NIGHTLY_UPDATE_FEED_URL: BETA_FEED_URL,
    SOURCE_DATE_EPOCH: String(epoch),
    // candidate-build.ts keeps a failed build's log in the temporary folder: this one.
    TMPDIR: dir,
  };
}

/** The next run number of `base` on `day` that no tag has used. */
export function nextRun(tags: readonly string[], base: string, day: string): number {
  const prefix = `v${base}-beta.${day}.`;
  let highest = 0;
  for (const tag of tags) {
    if (!tag.startsWith(prefix)) continue;
    const run = Number(tag.slice(prefix.length));
    if (Number.isSafeInteger(run)) highest = Math.max(highest, run);
  }
  return highest + 1;
}

/** What `codesign --display --verbose=2` says of a signature. */
export function readSignature(display: string) {
  const field = (name: string) =>
    new RegExp(`^${name}=(.*)$`, "m").exec(display)?.[1]?.trim() ?? null;
  return {
    identifier: field("Identifier"),
    teamId: field("TeamIdentifier"),
    authority: field("Authority"),
  };
}

/**
 * Checks one app as it will ship, extracted from its zip, and returns its
 * team. Throws naming the check that failed; tool output is kept out of the
 * message unless `explain` is set.
 */
export function verifyApp(
  runner: Run,
  app: string,
  expected: { version: string; arch: "arm64" | "x86_64" },
): { teamId: string } {
  const require = (ok: boolean, check: string, result?: RunResult) => {
    if (ok) return;
    const detail = result ? `\n${(result.stderr || result.stdout).trim()}` : "";
    throw new Error(`${app}: ${check} failed.${detail}`);
  };
  const plist = join(app, "Contents/Info.plist");
  const read = (key: string) => runner("plutil", ["-extract", key, "raw", plist]).stdout.trim();
  require(read("CFBundleIdentifier") === APP_ID, `bundle id ${APP_ID}`);
  require(read("CFBundleShortVersionString") === expected.version, `version ${expected.version}`);
  const archs = runner("lipo", ["-archs", join(app, "Contents/MacOS", PRODUCT_NAME)]);
  require(archs.stdout.trim() === expected.arch, `architecture ${expected.arch}`, archs);
  const strict = runner("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  require(strict.status === 0, "codesign --verify --deep --strict", strict);
  const shown = runner("codesign", ["--display", "--verbose=2", app]);
  const signature = readSignature(shown.stderr + shown.stdout);
  require(signature.identifier === APP_ID, `signature identifier ${APP_ID}`);
  require(signature.authority?.startsWith("Developer ID Application:") ===
    true, "Developer ID Application signature");
  require(/^[A-Z0-9]{10}$/.test(signature.teamId ?? ""), "team identifier");
  const gatekeeper = runner("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
  require(gatekeeper.status === 0 &&
    /source=Notarized Developer ID/.test(
      gatekeeper.stderr,
    ), "spctl --assess --type execute (notarized Developer ID)", gatekeeper);
  const ticket = runner("xcrun", ["stapler", "validate", app]);
  require(ticket.status === 0, "xcrun stapler validate", ticket);
  return { teamId: signature.teamId! };
}

const sha = (algorithm: "sha256" | "sha512", path: string, encoding: "hex" | "base64") =>
  createHash(algorithm).update(readFileSync(path)).digest(encoding);

export interface ReleasePlan {
  version: string;
  tag: string;
  commit: string;
  releaseDate: string;
  teamId: string;
  files: Array<{ name: string; size: number; sha512: string; sha256: string }>;
}

function plannedFile(dir: string, name: string) {
  const path = join(dir, name);
  return {
    name,
    size: readFileSync(path).length,
    sha512: sha("sha512", path, "base64"),
    sha256: sha("sha256", path, "hex"),
  };
}

/** The tags GitHub has, as tags or releases, published or not: never reuse a version. */
function githubTags(runner: Run): string[] {
  const remote = runner("git", ["ls-remote", "--tags", "origin", "v*"]);
  const releases = runner("gh", [
    "api",
    `repos/${REPOSITORY}/releases`,
    "--paginate",
    "--jq",
    ".[].tag_name",
  ]);
  if (remote.status !== 0 || releases.status !== 0)
    throw new Error("Could not read the repository's tags and releases from GitHub.");
  const tags = remote.stdout
    .split("\n")
    .map((line) => line.split("refs/tags/")[1]?.replace(/\^\{\}$/, "") ?? "");
  return [...tags, ...releases.stdout.split("\n")].filter(Boolean);
}

/** Throws unless `version` is newer than every version a tag names. */
function requireNewest(version: string, tags: readonly string[]) {
  const parsed = parseVersion(version)!;
  for (const tag of tags) {
    const used = parseVersion(tag.slice(1));
    if (used && !isNewer(parsed, used)) stop(`${version} is not newer than ${tag}.`);
  }
}

/** A refusal: the message is printed and the script exits 1. */
export class Stop extends Error {}
function stop(message: string): never {
  throw new Stop(message);
}

/** Where a release is staged and which app it builds; tests pass their own folders. */
export interface Places {
  staging: string;
  appDir: string;
}

export function prepare(
  runner: Run,
  now: Date,
  { staging, appDir }: Places = { staging: STAGING, appDir: APP_DIR },
): void {
  const read = readSecrets(runner);
  if (!read.ok) {
    stop(
      `The vault has no value for ${read.missing.join(", ")}. Add ${read.missing.length > 1 ? "them" : "it"} and run again. Nothing was built.`,
    );
  }
  if (process.platform !== "darwin") stop("A Mac beta is built on macOS.");
  const { secrets } = read;
  const values = Object.values(secrets);
  if (runner("git", ["status", "--porcelain"]).stdout.trim())
    stop("Commit or remove local changes first: a release is built from a clean checkout.");
  if (existsSync(join(appDir, "dist"))) stop("Remove apps/desktop/dist first.");
  const commit = runner("git", ["rev-parse", "HEAD"]).stdout.trim();

  const epoch = Math.floor(now.getTime() / 1000);
  const releaseDate = new Date(epoch * 1000).toISOString();
  const current = (
    JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as { version: string }
  ).version;
  const stable = parseVersion(current);
  if (!stable || stable.length !== 3) stop("apps/desktop/package.json needs an X.Y.Z version.");
  const day = releaseDate.slice(0, 10).replaceAll("-", "");
  const local = existsSync(staging) ? readdirSync(staging).map((name) => `v${name}`) : [];
  const tags = [...githubTags(runner), ...local];
  const next = `${stable[0]}.${stable[1]}.${stable[2] + 1}`;
  const version = nightlyVersion(current, now, String(nextRun(tags, next, day)));
  requireNewest(version, tags);
  const tag = betaTag(version);
  const out = join(staging, version);
  mkdirSync(staging, { recursive: true });
  console.log(`Building Clawtrate ${version} from ${commit.slice(0, 12)}.`);
  console.log("Notarization sends both apps to Apple's notary service. Nothing is published.");

  // The certificate and key live here only while the build runs. Every way
  // out removes it: return, error, Ctrl-C, or the process ending.
  const temp = mkdtempSync(join(tmpdir(), "clawtrate-release-"));
  const remove = () => rmSync(temp, { recursive: true, force: true });
  const interrupted = () => {
    remove();
    process.exit(130);
  };
  process.on("exit", remove);
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  try {
    const env = signingEnvironment(process.env, secrets, temp, epoch);
    const build = runner(
      process.execPath,
      [join(APP_DIR, "packaging/candidate-build.ts"), out, version],
      { env },
    );
    if (build.status !== 0) {
      const logs = readdirSync(temp)
        .filter((name) => name.startsWith("clawtrate-pack-"))
        .map((name) => join(temp, name, "pack.log"))
        .filter((path) => existsSync(path));
      const tail = logs.map((path) => readFileSync(path, "utf8").split("\n").slice(-60).join("\n"));
      stop(
        redact(
          [`The build failed.`, build.stderr.trim(), ...tail].filter(Boolean).join("\n"),
          values,
        ),
      );
    }
    let teamId: string | null = null;
    for (const [key, arch] of [
      ["mac-arm64", "arm64"],
      ["mac-x64", "x86_64"],
    ] as const) {
      const receipt = JSON.parse(readFileSync(join(out, `${key}.json`), "utf8")) as {
        commit: string;
        packagerReadback: string;
      };
      if (receipt.commit !== commit || receipt.packagerReadback !== "certificate")
        stop(`${key} was not signed with a certificate by this commit's build.`);
      rmSync(join(out, `${key}.json`));
      const zip = join(out, artifactName(version, key));
      const unpacked = join(temp, `verify-${key}`);
      mkdirSync(unpacked);
      if (runner("ditto", ["-x", "-k", zip, unpacked]).status !== 0)
        stop(`${zip} does not unpack.`);
      const app = join(unpacked, `${PRODUCT_NAME}.app`);
      let checked: { teamId: string };
      try {
        checked = verifyApp(runner, app, { version, arch });
      } catch (error) {
        // electron-builder staples before zipping. Should a ticket be missing,
        // staple the app as it ships, zip it again and check everything again.
        if (!String(error).includes("stapler validate")) throw error;
        if (runner("xcrun", ["stapler", "staple", app]).status !== 0)
          stop(`${key}: Apple has no notarization ticket to staple.`);
        rmSync(zip);
        if (runner("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]).status !== 0)
          stop(`${key}: could not zip the stapled app.`);
        rmSync(unpacked, { recursive: true });
        mkdirSync(unpacked);
        runner("ditto", ["-x", "-k", zip, unpacked]);
        checked = verifyApp(runner, app, { version, arch });
      }
      if (teamId !== null && teamId !== checked.teamId) stop("The two apps have different teams.");
      teamId = checked.teamId;
      console.log(`${key}: signed by team ${teamId}, notarized, stapled, accepted by Gatekeeper.`);
    }

    const feed = makeFeed({ version, releaseDate, folder: releaseFolder(tag), dir: out });
    const feedText = `${JSON.stringify(feed, null, 2)}\n`;
    const files = (["mac-arm64", "mac-x64"] as const).map((key) =>
      plannedFile(out, artifactName(version, key)),
    );
    const latest: LatestMac = makeLatestMac(version, teamId!, {
      "mac-arm64": { url: feed.files["mac-arm64"]!.url, sha256: files[0]!.sha256 },
      "mac-x64": { url: feed.files["mac-x64"]!.url, sha256: files[1]!.sha256 },
      "win-x64": undefined,
    });
    const latestText = `${JSON.stringify(latest, null, 2)}\n`;
    checkBetaFiles(tag, feedText, latestText);
    writeFileSync(join(out, FEED_NAME), feedText);
    writeFileSync(join(out, LATEST_MAC_NAME), latestText);
    writeFileSync(join(out, "notes.md"), releaseNotes(version, commit, files));
    const plan: ReleasePlan = {
      version,
      tag,
      commit,
      releaseDate,
      teamId: teamId!,
      files: [...files, plannedFile(out, FEED_NAME), plannedFile(out, LATEST_MAC_NAME)],
    };
    writeFileSync(join(out, "release.json"), `${JSON.stringify(plan, null, 2)}\n`);
    rmSync(join(appDir, "dist"), { recursive: true, force: true });
    console.log(`\nPrepared ${out}`);
    for (const file of plan.files)
      console.log(`  ${file.name}  ${file.size} bytes  sha256 ${file.sha256}`);
    console.log(`\nNothing was published. To publish it: pnpm release:beta --publish ${version}`);
  } finally {
    remove();
    process.off("exit", remove);
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
  }
}

export function releaseNotes(
  version: string,
  commit: string,
  files: ReadonlyArray<{ name: string; sha256: string }>,
): string {
  return [
    `Clawtrate ${version}, a beta for macOS, built from ${commit}.`,
    "",
    "Install it from https://clawtrate.dev, or choose Check for Updates in a beta already installed.",
    "Apple silicon takes the arm64 zip and Intel Macs the x64 zip. Both are signed with a Developer ID and notarized by Apple.",
    "",
    "SHA-256:",
    "",
    ...files.map((file) => `- \`${file.name}\`: \`${file.sha256}\``),
    "",
  ].join("\n");
}

/** Reads a prepared release and checks every file is still the one it planned. */
export function preparedRelease(dir: string): ReleasePlan {
  const plan = JSON.parse(readFileSync(join(dir, "release.json"), "utf8")) as ReleasePlan;
  for (const planned of plan.files) {
    const now = plannedFile(dir, planned.name);
    if (now.size !== planned.size || now.sha512 !== planned.sha512 || now.sha256 !== planned.sha256)
      throw new Error(`${planned.name} changed since it was prepared.`);
  }
  checkBetaFiles(
    plan.tag,
    readFileSync(join(dir, FEED_NAME), "utf8"),
    readFileSync(join(dir, LATEST_MAC_NAME), "utf8"),
  );
  return plan;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** GETs an address, following GitHub's redirect, into a buffer; null on any failure. */
async function download(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url, { redirect: "follow" });
    return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** Waits up to `minutes` for the site to serve `expected` (or nothing, for null). */
async function waitForSite(url: string, accept: (body: Buffer | null) => boolean, minutes: number) {
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    if (accept(await download(`${url}?${Date.now()}`))) return true;
    if (Date.now() > deadline) return false;
    await sleep(20_000);
  }
}

export async function publish(runner: Run, version: string): Promise<void> {
  const dir = join(STAGING, version);
  if (!existsSync(join(dir, "release.json"))) stop(`${dir} holds no prepared release.`);
  const plan = preparedRelease(dir);
  if (runner("gh", ["auth", "status"]).status !== 0)
    stop("Sign in to GitHub with `gh auth login`.");
  runner("git", ["fetch", "--quiet", "origin", "main"]);
  if (runner("git", ["merge-base", "--is-ancestor", plan.commit, "origin/main"]).status !== 0)
    stop(`${plan.commit} is not on main. Publish only a commit that has merged.`);
  const tags = githubTags(runner);
  if (tags.includes(plan.tag)) stop(`${plan.tag} already exists on GitHub.`);
  requireNewest(version, tags);
  const current = await download(BETA_LATEST_MAC_URL);
  if (current) {
    const team = (JSON.parse(current.toString("utf8")) as LatestMac).teamId;
    if (team !== plan.teamId)
      stop(`The published beta is signed by team ${team}, this one by ${plan.teamId}.`);
  }

  const assets = plan.files.map((file) => join(dir, file.name));
  const created = runner(
    "gh",
    [
      "release",
      "create",
      plan.tag,
      "--repo",
      REPOSITORY,
      "--target",
      plan.commit,
      "--title",
      `Clawtrate ${version} Beta`,
      "--notes-file",
      join(dir, "notes.md"),
      "--prerelease",
      "--draft",
      ...assets,
    ],
    { inherit: true },
  );
  if (created.status !== 0)
    stop(
      `Creating the draft release failed. Delete the draft ${plan.tag} on GitHub if one was made.`,
    );
  const view = runner("gh", [
    "release",
    "view",
    plan.tag,
    "--repo",
    REPOSITORY,
    "--json",
    "assets",
  ]);
  const uploaded =
    (JSON.parse(view.stdout || "{}") as { assets?: Array<{ name: string; size: number }> })
      .assets ?? [];
  for (const file of plan.files) {
    if (!uploaded.some((asset) => asset.name === file.name && asset.size === file.size))
      stop(`The draft is missing ${file.name}. It was left a draft.`);
  }
  if (
    runner("gh", [
      "release",
      "edit",
      plan.tag,
      "--repo",
      REPOSITORY,
      "--draft=false",
      "--prerelease",
    ]).status !== 0
  )
    stop(`Publishing the draft ${plan.tag} failed. It is still a draft.`);
  console.log(`Published https://github.com/${REPOSITORY}/releases/tag/${plan.tag}`);

  for (const file of plan.files) {
    const body = await download(`${releaseFolder(plan.tag)}${file.name}`);
    const sha512 = body && createHash("sha512").update(body).digest("base64");
    if (!body || body.length !== file.size || sha512 !== file.sha512)
      stop(
        `The public ${file.name} is not the prepared file. Withdraw ${version} and investigate.`,
      );
    console.log(`  ${file.name}: the public file matches.`);
  }
  const feed = readFileSync(join(dir, FEED_NAME));
  console.log(`Waiting for ${BETA_FEED_URL} to offer ${version}…`);
  const live = await waitForSite(BETA_FEED_URL, (body) => body?.equals(feed) ?? false, 15);
  if (!live)
    stop(
      `The site does not serve the new feed yet. Run the Site workflow, then check ${BETA_FEED_URL}.`,
    );
  console.log(`The Beta feed offers ${version}.`);
}

export async function withdraw(runner: Run, version: string): Promise<void> {
  const tag = betaTag(version);
  if (
    runner("gh", ["release", "edit", tag, "--repo", REPOSITORY, "--draft=true"], { inherit: true })
      .status !== 0
  )
    stop(`Could not turn ${tag} back into a draft.`);
  console.log(`${tag} is a draft again: its files are no longer public.`);
  const offers = (body: Buffer | null) => {
    if (!body) return false;
    try {
      return (JSON.parse(body.toString("utf8")) as { version?: string }).version === version;
    } catch {
      return false;
    }
  };
  console.log(`Waiting for ${BETA_FEED_URL} to stop offering ${version}…`);
  if (!(await waitForSite(BETA_FEED_URL, (body) => !offers(body), 15)))
    stop(`The site still offers ${version}. Run the Site workflow.`);
  const feed = await download(BETA_FEED_URL);
  const now =
    feed && parseFeed(feed.toString("utf8"), new URL(BETA_FEED_URL), null, undefined, "nightly");
  console.log(
    now && now.ok
      ? `The Beta feed offers ${(JSON.parse(feed!.toString("utf8")) as { version: string }).version}.`
      : "The site has no Beta feed: no beta is published.",
  );
}

export async function main(argv: string[], runner: Run = run): Promise<number> {
  const [flag, version, extra] = argv;
  try {
    if (flag === undefined) prepare(runner, new Date());
    else if ((flag === "--publish" || flag === "--withdraw") && version && !extra) {
      if (!parseVersion(version)) stop(`${version} is not a version.`);
      await (flag === "--publish" ? publish(runner, version) : withdraw(runner, version));
    } else {
      console.error("usage: pnpm release:beta [--publish <version> | --withdraw <version>]");
      return 2;
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Stop ? error.message : error);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
