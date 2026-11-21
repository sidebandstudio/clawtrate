// Cuts a Clawtrate beta for macOS on the maintainer's Mac. CI never runs it.
//
//   pnpm release:beta                       build, sign, notarize, verify and prepare
//   pnpm release:beta --publish <version>   publish what was prepared
//   pnpm release:beta --withdraw <version>  take a published beta back
//
// Preparing reads the signing and notarization secrets from the maintainer's
// vault and hands them to macOS's own tools on their standard input, never in
// a command's arguments or environment: `security` imports the certificate
// into a new keychain in a private temporary folder, and `notarytool` stores
// the API key in that keychain as a profile. The build runs with a short list
// of ordinary variables plus the keychain's path, the identity's hash and the
// profile's name, so neither it nor anything it starts holds a secret. Then it
// checks each app inside its zip: signature, Gatekeeper, stapled ticket, bundle
// id, version and architecture. It writes the zips, the Beta feed,
// latest-mac.json, the release notes and release.json to
// .release/beta/<version>/. Only Apple's notary service receives anything;
// nothing is published.
//
// Publishing checks that folder holds exactly that release and that every file
// is unchanged, creates the GitHub prerelease as a draft, compares GitHub's
// digest of each uploaded file with the prepared one, and only then makes it
// public, reads every file back and waits for the site to serve the new feed.
//
// docs/development/releases.md is the runbook, including what a killed run
// leaves behind and how to remove it.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
  betaTag,
  checkBetaFiles,
  FEED_NAME,
  LATEST_MAC_NAME,
  MAC_ARCHITECTURES,
  makeLatestMac,
  releaseFolder,
  REPOSITORY,
  TEAM_ID,
  type LatestMac,
} from "./beta-files.ts";
import { nightlyVersion } from "./candidate-version.ts";
import { APP_ID, PRODUCT_NAME } from "./config.ts";
import { artifactName, makeFeed } from "./feed.ts";
import { newestBeta, type ReleaseRow } from "./site-feed.ts";

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
  options?: { env?: NodeJS.ProcessEnv; cwd?: string; inherit?: boolean; input?: string },
) => RunResult;

export const run: Run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    input: options.input,
    stdio: [
      options.input === undefined ? "ignore" : "pipe",
      options.inherit ? "inherit" : "pipe",
      options.inherit ? "inherit" : "pipe",
    ],
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

// Built from parts, so the source holds no line that reads like a key.
const PEM_LABEL = ["PRIVATE", "KEY"].join(" ");
const PEM_KEY = new RegExp(
  `^-----BEGIN ${PEM_LABEL}-----\\r?\\n[\\s\\S]+\\r?\\n-----END ${PEM_LABEL}-----\\s*$`,
);

/** The .p8 key as PEM text, stored as the text itself or as its base64, or null. */
export function p8Text(value: string): string | null {
  const trimmed = value.trim();
  if (PEM_KEY.test(trimmed)) return `${trimmed}\n`;
  const bytes = p12Bytes(trimmed);
  const decoded = bytes?.toString("utf8").trim();
  return decoded && PEM_KEY.test(decoded) ? `${decoded}\n` : null;
}

/** The notarytool profile the release keychain holds. A name, not a secret. */
export const NOTARY_PROFILE = "clawtrate-release";

/** The ordinary variables the build and the signing tools keep; nothing else is passed on. */
const KEPT_VARIABLES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "PNPM_HOME",
  "COREPACK_HOME",
  "ELECTRON_CACHE",
  "ELECTRON_BUILDER_CACHE",
];

function kept(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of KEPT_VARIABLES) if (base[name] !== undefined) env[name] = base[name];
  return env;
}

/** A word for `security -i`, which splits its input lines itself. */
const securityWord = (value: string) => `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

export interface Signing {
  /** The release keychain, which holds the identity and the notary profile. */
  keychain: string;
  /** The identity's SHA-1 hash, as `security find-identity` prints it. */
  identity: string;
  teamId: string;
}

/**
 * Makes the release keychain in `dir`: the certificate imported and the notary
 * key stored as NOTARY_PROFILE. Every secret goes to `security` or `notarytool`
 * on its standard input. The certificate's file is deleted once imported; the
 * key's file stays in `dir` until the caller removes it.
 */
export function signingKeychain(runner: Run, secrets: Secrets, dir: string, base = process.env) {
  const p12 = p12Bytes(secrets.APPLE_CLAWTRATE_DEVELOPER_ID_P12_BASE64);
  if (!p12) stop("APPLE_CLAWTRATE_DEVELOPER_ID_P12_BASE64 is not base64.");
  const password = secrets.APPLE_CLAWTRATE_DEVELOPER_ID_P12_PASSWORD;
  if (/[\r\n]/.test(password)) stop("APPLE_CLAWTRATE_DEVELOPER_ID_P12_PASSWORD has a line break.");
  const p8 = p8Text(secrets.APPLE_CLAWTRATE_NOTARY_API_KEY_P8);
  if (!p8) stop("APPLE_CLAWTRATE_NOTARY_API_KEY_P8 is not a private key.");
  const keyId = secrets.APPLE_CLAWTRATE_NOTARY_API_KEY_ID.trim();
  if (!/^[A-Z0-9]{10}$/.test(keyId))
    stop("APPLE_CLAWTRATE_NOTARY_API_KEY_ID is not ten letters or digits.");
  const issuer = secrets.APPLE_CLAWTRATE_NOTARY_ISSUER_ID.trim();
  if (/\s/.test(issuer)) stop("APPLE_CLAWTRATE_NOTARY_ISSUER_ID has a space or line break.");

  const env = kept(base);
  const certificate = join(dir, "developer-id.p12");
  const key = join(dir, `AuthKey_${keyId}.p8`);
  const keychain = join(dir, "release.keychain-db");
  // Lives only in this process: a keychain left by a killed run stays locked to everyone.
  const unlock = randomBytes(32).toString("base64url");
  writeFileSync(certificate, p12, { mode: 0o600, flag: "wx" });
  writeFileSync(key, p8, { mode: 0o600, flag: "wx" });
  const commands = [
    `create-keychain -p ${securityWord(unlock)} ${securityWord(keychain)}`,
    // Locks itself after an hour unused and when the Mac sleeps.
    `set-keychain-settings -l -u -t 3600 ${securityWord(keychain)}`,
    `unlock-keychain -p ${securityWord(unlock)} ${securityWord(keychain)}`,
    `import ${securityWord(certificate)} -k ${securityWord(keychain)} -f pkcs12 -P ${securityWord(password)} -T /usr/bin/codesign`,
    `set-key-partition-list -S apple-tool:,apple: -s -k ${securityWord(unlock)} ${securityWord(keychain)}`,
  ];
  const made = runner("security", ["-i"], { env, input: `${commands.join("\n")}\n` });
  rmSync(certificate, { force: true });
  if (made.status !== 0)
    stop(
      "The certificate did not import into the release keychain. Check APPLE_CLAWTRATE_DEVELOPER_ID_P12_BASE64 and APPLE_CLAWTRATE_DEVELOPER_ID_P12_PASSWORD.",
    );
  // notarytool asks for the key's path, its id and the issuer, in that order.
  const stored = runner(
    "xcrun",
    ["notarytool", "store-credentials", NOTARY_PROFILE, "--keychain", keychain],
    { env, input: `${key}\n${keyId}\n${issuer}\n` },
  );
  if (stored.status !== 0)
    stop(
      "Apple did not accept the notary API key. Check APPLE_CLAWTRATE_NOTARY_API_KEY_P8, APPLE_CLAWTRATE_NOTARY_API_KEY_ID and APPLE_CLAWTRATE_NOTARY_ISSUER_ID.",
    );
  const found = runner("security", ["find-identity", "-v", "-p", "codesigning", keychain], { env });
  const identities = [
    ...found.stdout.matchAll(
      /^\s*\d+\)\s+([0-9A-F]{40})\s+"Developer ID Application: .*\(([A-Z0-9]{10})\)"$/gm,
    ),
  ];
  if (found.status !== 0 || identities.length !== 1)
    stop(
      "The release keychain has no single valid Developer ID Application identity. Is the certificate a Developer ID Application one, and is Apple's Developer ID intermediate certificate installed?",
    );
  return { keychain, identity: identities[0]![1]!, teamId: identities[0]![2]! } as Signing;
}

/**
 * The build's environment: the ordinary variables of `base` and nothing else,
 * plus the release keychain, the identity's hash, the notary profile's name,
 * the Beta feed and the build date. None of them is a secret.
 */
export function buildEnvironment(
  base: NodeJS.ProcessEnv,
  signing: Signing,
  epoch: number,
): NodeJS.ProcessEnv {
  return {
    ...kept(base),
    CSC_KEYCHAIN: signing.keychain,
    CSC_NAME: signing.identity,
    APPLE_KEYCHAIN: signing.keychain,
    APPLE_KEYCHAIN_PROFILE: NOTARY_PROFILE,
    // The Beta track only: a beta build has no Stable feed until Stable opens.
    CLAWTRATE_NIGHTLY_UPDATE_FEED_URL: BETA_FEED_URL,
    SOURCE_DATE_EPOCH: String(epoch),
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
 * team. Every tool must succeed and say what is expected. Throws naming the
 * check that failed, with the tool's own output.
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
  const tool = (command: string, args: string[], check: string) => {
    const result = runner(command, args);
    require(result.status === 0, check, result);
    return result;
  };
  const plist = join(app, "Contents/Info.plist");
  const read = (key: string) =>
    tool("plutil", ["-extract", key, "raw", plist], `plutil ${key}`).stdout.trim();
  require(read("CFBundleIdentifier") === APP_ID, `bundle id ${APP_ID}`);
  require(read("CFBundleShortVersionString") === expected.version, `version ${expected.version}`);
  const executable = join(app, "Contents/MacOS", PRODUCT_NAME);
  const archs = tool("lipo", ["-archs", executable], "lipo -archs");
  require(archs.stdout.trim() === expected.arch, `architecture ${expected.arch}`, archs);
  tool(
    "codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", app],
    "codesign --verify --deep --strict",
  );
  const shown = tool("codesign", ["--display", "--verbose=2", app], "codesign --display");
  const signature = readSignature(shown.stderr + shown.stdout);
  require(signature.identifier === APP_ID, `signature identifier ${APP_ID}`);
  require(signature.authority?.startsWith("Developer ID Application:") ===
    true, "Developer ID Application signature");
  require(TEAM_ID.test(signature.teamId ?? ""), "team identifier");
  const gatekeeper = tool(
    "spctl",
    ["--assess", "--type", "execute", "--verbose=2", app],
    "spctl --assess --type execute",
  );
  require(/source=Notarized Developer ID/.test(
    gatekeeper.stderr,
  ), "spctl --assess --type execute (notarized Developer ID)", gatekeeper);
  tool("xcrun", ["stapler", "validate", app], "xcrun stapler validate");
  return { teamId: signature.teamId! };
}

const sha = (algorithm: "sha256" | "sha512", bytes: Buffer, encoding: "hex" | "base64") =>
  createHash(algorithm).update(bytes).digest(encoding);

export interface PlannedFile {
  name: string;
  size: number;
  sha512: string;
  sha256: string;
}

export interface ReleasePlan {
  version: string;
  tag: string;
  commit: string;
  releaseDate: string;
  teamId: string;
  files: PlannedFile[];
}

function plannedFile(dir: string, name: string): PlannedFile {
  const bytes = readFileSync(join(dir, name));
  return {
    name,
    size: bytes.length,
    sha512: sha("sha512", bytes, "base64"),
    sha256: sha("sha256", bytes, "hex"),
  };
}

/** A beta's files, in the order release.json lists them: the zips, the feed, latest-mac.json. */
export function releaseFiles(version: string): string[] {
  return [
    ...Object.values(MAC_ARCHITECTURES).map((key) => artifactName(version, key)),
    FEED_NAME,
    LATEST_MAC_NAME,
  ];
}

/** Every release GitHub has, drafts included, one compact JSON row per line. */
function githubReleases(runner: Run): ReleaseRow[] {
  const listed = runner("gh", [
    "api",
    `repos/${REPOSITORY}/releases`,
    "--paginate",
    "--jq",
    ".[] | {tag_name, draft, prerelease, target_commitish, assets: [.assets[] | {id, name, size, digest, state, browser_download_url}]}",
  ]);
  if (listed.status !== 0) stop("Could not read the repository's releases from GitHub.");
  return listed.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ReleaseRow);
}

/** The tags GitHub has, as tags or releases, published or not: never reuse a version. */
function githubTags(runner: Run, releases: readonly ReleaseRow[]): string[] {
  const remote = runner("git", ["ls-remote", "--tags", "origin", "v*"]);
  if (remote.status !== 0) stop("Could not read the repository's tags from GitHub.");
  const tags = remote.stdout
    .split("\n")
    .map((line) => line.split("refs/tags/")[1]?.replace(/\^\{\}$/, "") ?? "");
  return [...tags, ...releases.map((row) => row.tag_name)].filter(Boolean);
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

function tagOf(version: string): string {
  try {
    return betaTag(version);
  } catch {
    stop(`${version} is not a beta version.`);
  }
}

/** Where a release is staged, which app it builds and where its signing folder goes. */
export interface Places {
  staging: string;
  appDir: string;
  temp: string;
}
const PLACES: Places = { staging: STAGING, appDir: APP_DIR, temp: tmpdir() };

/** The private folder a release signs from: `mkdtemp` makes it readable by this user only. */
const SIGNING_FOLDER = /^clawtrate-signing-[A-Za-z0-9]{6}$/;

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Removes the signing folders of runs that ended without removing them; refuses while one runs. */
function clearLeftovers(parent: string) {
  for (const name of readdirSync(parent).filter((entry) => SIGNING_FOLDER.test(entry))) {
    const folder = join(parent, name);
    let pid = 0;
    try {
      pid = Number(readFileSync(join(folder, "pid"), "utf8"));
    } catch {
      // No pid: the run ended before writing it.
    }
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && running(pid))
      stop(`Another release (pid ${pid}) is signing from ${folder}. Let it finish first.`);
    rmSync(folder, { recursive: true, force: true });
    console.log(`Removed ${folder}, which an interrupted release left.`);
  }
}

export function prepare(runner: Run, now: Date, places: Places = PLACES): void {
  const { staging, appDir } = places;
  const read = readSecrets(runner);
  if (!read.ok) {
    stop(
      `The vault has no value for ${read.missing.join(", ")}. Add ${read.missing.length > 1 ? "them" : "it"} and run again. Nothing was built.`,
    );
  }
  const { secrets } = read;
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
  const tags = [...githubTags(runner, githubReleases(runner)), ...local];
  const next = `${stable[0]}.${stable[1]}.${stable[2] + 1}`;
  const version = nightlyVersion(current, now, String(nextRun(tags, next, day)));
  requireNewest(version, tags);
  const tag = betaTag(version);
  const out = join(staging, version);
  mkdirSync(staging, { recursive: true });
  clearLeftovers(places.temp);
  console.log(`Building Clawtrate ${version} from ${commit.slice(0, 12)}.`);
  console.log("Notarization sends both apps to Apple's notary service. Nothing is published.");

  // The keychain and the key file live here while the build runs. A normal
  // exit, an error, Ctrl-C and SIGTERM remove it; a run killed outright
  // leaves it, and the next run removes it (docs/development/releases.md).
  const temp = mkdtempSync(join(places.temp, "clawtrate-signing-"));
  writeFileSync(join(temp, "pid"), String(process.pid), { mode: 0o600 });
  const remove = () => rmSync(temp, { recursive: true, force: true });
  const interrupted = () => {
    remove();
    process.exit(130);
  };
  process.on("exit", remove);
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  try {
    const signing = signingKeychain(runner, secrets, temp);
    const build = runner(
      process.execPath,
      [join(APP_DIR, "packaging/candidate-build.ts"), out, version],
      { env: buildEnvironment(process.env, signing, epoch) },
    );
    if (build.status !== 0) {
      // The log is electron-builder's and can name the identity and team; it is not printed.
      const log = /Build log: (\S+)/.exec(build.stderr)?.[1];
      stop(
        log
          ? `The build failed. Its log is ${log}; keep it private.`
          : `The build failed before it wrote a log (exit ${build.status}).`,
      );
    }
    let teamId: string | null = null;
    for (const [arch, key] of Object.entries(MAC_ARCHITECTURES) as Array<
      [keyof typeof MAC_ARCHITECTURES, (typeof MAC_ARCHITECTURES)[keyof typeof MAC_ARCHITECTURES]]
    >) {
      const receipt = JSON.parse(readFileSync(join(out, `${key}.json`), "utf8")) as {
        commit: string;
        packagerReadback: string;
      };
      if (receipt.commit !== commit || receipt.packagerReadback !== "certificate")
        stop(`${key} was not signed with a certificate by this commit's build.`);
      rmSync(join(out, `${key}.json`));
      const zip = join(out, artifactName(version, key));
      const unpacked = join(temp, `verify-${key}`);
      const unpack = () => {
        rmSync(unpacked, { recursive: true, force: true });
        mkdirSync(unpacked);
        if (runner("ditto", ["-x", "-k", zip, unpacked]).status !== 0)
          stop(`${zip} does not unpack.`);
      };
      unpack();
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
        unpack();
        checked = verifyApp(runner, app, { version, arch });
      }
      if (checked.teamId !== signing.teamId)
        stop(`${key} is signed by team ${checked.teamId}, not ${signing.teamId}.`);
      teamId = checked.teamId;
      console.log(`${key}: signed by team ${teamId}, notarized, stapled, accepted by Gatekeeper.`);
    }

    const feed = makeFeed({ version, releaseDate, folder: releaseFolder(tag), dir: out });
    const feedText = `${JSON.stringify(feed, null, 2)}\n`;
    const zips = Object.values(MAC_ARCHITECTURES).map((key) =>
      plannedFile(out, artifactName(version, key)),
    );
    const latest: LatestMac = makeLatestMac(version, teamId!, {
      "mac-arm64": { url: feed.files["mac-arm64"]!.url, sha256: zips[0]!.sha256 },
      "mac-x64": { url: feed.files["mac-x64"]!.url, sha256: zips[1]!.sha256 },
      "win-x64": undefined,
    });
    const latestText = `${JSON.stringify(latest, null, 2)}\n`;
    checkBetaFiles(tag, feedText, latestText);
    writeFileSync(join(out, FEED_NAME), feedText);
    writeFileSync(join(out, LATEST_MAC_NAME), latestText);
    writeFileSync(join(out, "notes.md"), releaseNotes(version, commit, zips));
    const plan: ReleasePlan = {
      version,
      tag,
      commit,
      releaseDate,
      teamId: teamId!,
      files: [...zips, plannedFile(out, FEED_NAME), plannedFile(out, LATEST_MAC_NAME)],
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

/**
 * Reads the release prepared for `version` and checks it is exactly that
 * release: the folder holds only its files, release.json names this version,
 * its tag and every file, each file is unchanged, the feed and latest-mac.json
 * name those zips by size and digest under this tag and team, and the notes
 * are the ones its record makes. Stops naming the first difference.
 */
export function stagedRelease(staging: string, version: string): ReleasePlan {
  const tag = tagOf(version);
  const dir = join(staging, version);
  if (!existsSync(join(dir, "release.json"))) stop(`${dir} holds no prepared release.`);
  const names = releaseFiles(version);
  const expected = [...names, "notes.md", "release.json"].sort();
  const present = readdirSync(dir).sort();
  if (present.join("\n") !== expected.join("\n"))
    stop(`${dir} must hold exactly ${expected.join(", ")}; it holds ${present.join(", ")}.`);
  let plan: ReleasePlan;
  try {
    plan = JSON.parse(readFileSync(join(dir, "release.json"), "utf8")) as ReleasePlan;
  } catch {
    stop(`${dir}/release.json is not JSON.`);
  }
  if (plan.version !== version || plan.tag !== tag)
    stop(`release.json is for ${plan.version} (${plan.tag}), not ${version}.`);
  if (!/^[0-9a-f]{40}$/.test(plan.commit ?? "")) stop("release.json names no full commit.");
  if (!TEAM_ID.test(plan.teamId ?? "")) stop("release.json names no team.");
  if (!Array.isArray(plan.files) || plan.files.map((file) => file.name).join() !== names.join())
    stop(`release.json must list exactly ${names.join(", ")}.`);
  for (const planned of plan.files) {
    const now = plannedFile(dir, planned.name);
    if (now.size !== planned.size || now.sha512 !== planned.sha512 || now.sha256 !== planned.sha256)
      stop(`${planned.name} changed since it was prepared.`);
  }
  const feedText = readFileSync(join(dir, FEED_NAME), "utf8");
  const latestText = readFileSync(join(dir, LATEST_MAC_NAME), "utf8");
  try {
    checkBetaFiles(tag, feedText, latestText);
  } catch (error) {
    stop((error as Error).message);
  }
  const feed = JSON.parse(feedText) as {
    releaseDate: string;
    files: Record<string, { size: number; sha512: string }>;
  };
  const latest = JSON.parse(latestText) as LatestMac;
  if (feed.releaseDate !== plan.releaseDate) stop("The feed's date is not release.json's.");
  if (latest.teamIdentifier !== plan.teamId)
    stop(`latest-mac.json names team ${latest.teamIdentifier}, release.json ${plan.teamId}.`);
  const zips = plan.files.slice(0, 2);
  Object.entries(MAC_ARCHITECTURES).forEach(([arch, key], index) => {
    const zip = zips[index]!;
    const entry = feed.files[key]!;
    if (entry.size !== zip.size || entry.sha512 !== zip.sha512)
      stop(`The feed's ${key} file is not ${zip.name} as prepared.`);
    if (latest[arch as keyof typeof MAC_ARCHITECTURES].sha256 !== zip.sha256)
      stop(`latest-mac.json's ${arch} file is not ${zip.name} as prepared.`);
  });
  if (readFileSync(join(dir, "notes.md"), "utf8") !== releaseNotes(version, plan.commit, zips))
    stop("notes.md is not the notes this release's record makes.");
  return plan;
}

/** How the script reaches the site and GitHub's public downloads; tests pass stand-ins. */
export interface Net {
  get: (url: string, signal: AbortSignal) => Promise<Response>;
  /** Each request's own deadline. */
  requestMs: number;
  /** How long to wait for the site, and how often to ask. */
  waitMs: number;
  pollMs: number;
}
const NET: Net = {
  get: (url, signal) => fetch(url, { redirect: "follow", signal }),
  requestMs: 60_000,
  waitMs: 15 * 60_000,
  pollMs: 20_000,
};

/** A file's bytes through its public address, following GitHub's redirect, or why not. */
async function download(
  net: Net,
  url: string,
  ms: number,
): Promise<{ ok: true; body: Buffer } | { ok: false; status: number | null; reason: string }> {
  try {
    const response = await net.get(url, AbortSignal.timeout(ms));
    if (!response.ok)
      return { ok: false, status: response.status, reason: `HTTP ${response.status}` };
    return { ok: true, body: Buffer.from(await response.arrayBuffer()) };
  } catch (error) {
    const timedOut = (error as Error).name === "TimeoutError";
    return { ok: false, status: null, reason: timedOut ? "no answer in time" : "no connection" };
  }
}

/** What the site serves at the Beta feed's address, read once. */
export type SiteReading =
  | { kind: "feed"; version: string; body: Buffer }
  | { kind: "absent" }
  | { kind: "inconclusive"; reason: string };

export async function readSite(net: Net): Promise<SiteReading> {
  const got = await download(net, `${BETA_FEED_URL}?${Date.now()}`, net.requestMs);
  if (!got.ok)
    return got.status === 404 ? { kind: "absent" } : { kind: "inconclusive", reason: got.reason };
  const text = got.body.toString("utf8");
  const parsed = parseFeed(text, new URL(BETA_FEED_URL), null, undefined, "nightly");
  if (!parsed.ok) return { kind: "inconclusive", reason: `not a Beta feed (${parsed.cause})` };
  return {
    kind: "feed",
    version: (JSON.parse(text) as { version: string }).version,
    body: got.body,
  };
}

/** Reads the site until `done` accepts a reading or the wait ends; returns the last reading. */
async function watchSite(net: Net, done: (reading: SiteReading) => boolean) {
  const deadline = Date.now() + net.waitMs;
  for (;;) {
    const reading = await readSite(net);
    if (done(reading)) return { done: true, reading };
    if (Date.now() + net.pollMs > deadline) return { done: false, reading };
    await new Promise((resolve) => setTimeout(resolve, net.pollMs));
  }
}

/**
 * Every earlier beta on GitHub that carries latest-mac.json, published or
 * withdrawn, must be signed by `teamId`. Reads them through the API, so an
 * outage or an unreadable file stops the release; only a listing with no
 * earlier beta is a first release.
 */
function requireSameSigner(
  runner: Run,
  releases: readonly ReleaseRow[],
  tag: string,
  teamId: string,
) {
  const earlier = releases.filter(
    (row) =>
      row.tag_name !== tag &&
      /^v\d+\.\d+\.\d+-beta\./.test(row.tag_name) &&
      row.assets.some((asset) => asset.name === LATEST_MAC_NAME),
  );
  if (earlier.length === 0) {
    console.log("GitHub has no earlier beta: this is the first, so there is no signer to match.");
    return;
  }
  for (const row of earlier) {
    const asset = row.assets.find((each) => each.name === LATEST_MAC_NAME)!;
    const got = runner("gh", [
      "api",
      "-H",
      "Accept: application/octet-stream",
      `repos/${REPOSITORY}/releases/assets/${asset.id}`,
    ]);
    let team: unknown;
    try {
      team = got.status === 0 ? (JSON.parse(got.stdout) as LatestMac).teamIdentifier : undefined;
    } catch {
      team = undefined;
    }
    if (typeof team !== "string")
      stop(`Could not read the team of ${row.tag_name} from GitHub. Nothing was published.`);
    if (team !== teamId)
      stop(
        `${row.tag_name} is signed by team ${team}, this beta by ${teamId}. Nothing was published.`,
      );
  }
  console.log(`Signed by team ${teamId}, as every earlier beta (${earlier.length}).`);
}

export async function publish(
  runner: Run,
  version: string,
  net: Net = NET,
  staging = STAGING,
): Promise<void> {
  const plan = stagedRelease(staging, version);
  const dir = join(staging, version);
  if (runner("gh", ["auth", "status"]).status !== 0)
    stop("Sign in to GitHub with `gh auth login`.");
  if (runner("git", ["fetch", "--quiet", "origin", "main"]).status !== 0)
    stop("Could not refresh origin/main from GitHub. Nothing was published.");
  if (runner("git", ["merge-base", "--is-ancestor", plan.commit, "origin/main"]).status !== 0)
    stop(`${plan.commit} is not on main. Publish only a commit that has merged.`);
  const releases = githubReleases(runner);
  const tags = githubTags(runner, releases);
  if (tags.includes(plan.tag)) stop(`${plan.tag} already exists on GitHub.`);
  requireNewest(version, tags);
  requireSameSigner(runner, releases, plan.tag, plan.teamId);

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
      ...plan.files.map((file) => join(dir, file.name)),
    ],
    { inherit: true },
  );
  if (created.status !== 0)
    stop(
      `Creating the draft release failed. Delete the draft ${plan.tag} on GitHub if one was made.`,
    );

  // The draft must hold exactly the prepared files, by GitHub's own digest of each.
  const leftDraft = `It was left a draft: delete it and publish again.`;
  const draft = githubReleases(runner).find((row) => row.tag_name === plan.tag);
  if (!draft?.draft || !draft.prerelease)
    stop(`GitHub does not list ${plan.tag} as a draft prerelease.`);
  if (draft.target_commitish !== plan.commit)
    stop(
      `The draft ${plan.tag} targets ${draft.target_commitish}, not ${plan.commit}. ${leftDraft}`,
    );
  const uploaded = draft.assets.map((asset) => asset.name).sort();
  const planned = plan.files.map((file) => file.name).sort();
  if (uploaded.join("\n") !== planned.join("\n"))
    stop(
      `The draft holds ${uploaded.join(", ") || "no files"}, not ${planned.join(", ")}. ${leftDraft}`,
    );
  for (const file of plan.files) {
    const asset = draft.assets.find((each) => each.name === file.name)!;
    if (asset.state !== "uploaded" || asset.size !== file.size)
      stop(`The draft's ${file.name} is not fully uploaded at ${file.size} bytes. ${leftDraft}`);
    if (asset.digest !== `sha256:${file.sha256}`)
      stop(
        asset.digest
          ? `GitHub's digest of the draft's ${file.name} is not the prepared file's. ${leftDraft}`
          : `GitHub reports no digest for the draft's ${file.name}. ${leftDraft}`,
      );
  }
  console.log(`The draft ${plan.tag} holds the ${plan.files.length} prepared files, by digest.`);
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
    const got = await download(net, `${releaseFolder(plan.tag)}${file.name}`, 10 * 60_000);
    if (
      !got.ok ||
      got.body.length !== file.size ||
      createHash("sha512").update(got.body).digest("base64") !== file.sha512
    )
      stop(
        `The public ${file.name} is not the prepared file. Withdraw ${version} and investigate.`,
      );
    console.log(`  ${file.name}: the public file matches.`);
  }
  const feed = readFileSync(join(dir, FEED_NAME));
  console.log(`Waiting for ${BETA_FEED_URL} to offer ${version}…`);
  const seen = await watchSite(
    net,
    (reading) => reading.kind === "feed" && reading.body.equals(feed),
  );
  if (!seen.done)
    stop(
      `The site does not serve the new feed yet (${describe(seen.reading)}). Run the Site workflow, then check ${BETA_FEED_URL}.`,
    );
  console.log(`The Beta feed offers ${version}.`);
}

function describe(reading: SiteReading): string {
  if (reading.kind === "feed") return `it offers ${reading.version}`;
  if (reading.kind === "absent") return "it answers 404";
  return `inconclusive: ${reading.reason}`;
}

export async function withdraw(runner: Run, version: string, net: Net = NET): Promise<void> {
  const tag = tagOf(version);
  if (
    runner("gh", ["release", "edit", tag, "--repo", REPOSITORY, "--draft=true"], { inherit: true })
      .status !== 0
  )
    stop(`Could not turn ${tag} back into a draft.`);
  const releases = githubReleases(runner);
  const row = releases.find((each) => each.tag_name === tag);
  if (!row) stop(`GitHub no longer lists ${tag}.`);
  if (!row.draft) stop(`GitHub still lists ${tag} as published.`);
  console.log(
    `GitHub lists ${tag} as a draft. Its download addresses can still answer from caches for a while.`,
  );
  // What the site should serve now, by the rule the Site workflow uses.
  const next = newestBeta(releases);
  console.log(
    `Waiting for ${BETA_FEED_URL} to ${next ? `offer ${next.tag_name.slice(1)}` : "serve no feed"}…`,
  );
  const seen = await watchSite(net, (reading) =>
    reading.kind === "feed"
      ? reading.version !== version
      : reading.kind === "absent" && next === null,
  );
  const { reading } = seen;
  if (seen.done) {
    console.log(
      reading.kind === "feed"
        ? `The Beta feed offers ${reading.version}.`
        : "The site serves no Beta feed, and GitHub lists no published beta.",
    );
    return;
  }
  if (reading.kind === "feed")
    stop(`The site still offers ${version}. Run the Site workflow and run this again.`);
  if (reading.kind === "absent")
    stop(
      `The site serves no Beta feed, though GitHub lists ${next!.tag_name} as published. Run the Site workflow.`,
    );
  stop(`Could not tell what the site serves (${reading.reason}). Check ${BETA_FEED_URL} yourself.`);
}

export async function main(
  argv: string[],
  runner: Run = run,
  platform: NodeJS.Platform = process.platform,
): Promise<number> {
  const [flag, version, extra] = argv;
  try {
    if (flag === undefined) {
      if (platform !== "darwin") stop("A Mac beta is built on macOS.");
      prepare(runner, new Date());
    } else if ((flag === "--publish" || flag === "--withdraw") && version && !extra) {
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
