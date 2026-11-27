// Cuts a Clawtrate beta for macOS on the maintainer's Mac. CI never runs it.
//
//   pnpm release:beta                       build, sign, notarize, verify and prepare
//   pnpm release:beta --publish <version> <release.json sha256>
//                                           publish what was prepared
//   pnpm release:beta --withdraw <version>  take a published beta back
//
// Preparing reads the signing and notarization secrets from the maintainer's
// vault and hands them to macOS's own tools on their standard input, never in
// a command's arguments or environment: `security` imports the certificate
// into a new keychain in a private temporary folder, and `notarytool` stores
// the API key in that keychain as a profile. Both raw files are deleted before
// the build starts. The build runs with a short list of ordinary variables plus
// the keychain's path, the identity's hash and the profile's name, so neither
// it nor anything it starts holds a secret. Then it checks a private copy of
// each zip, app inside: signature, Gatekeeper, stapled ticket, bundle id,
// version and architecture. From those verified copies it writes the zips, the
// Beta feed, latest-mac.json, the release notes and release.json to
// .release/beta/<version>/, and prints release.json's SHA-256. Only Apple's
// notary service receives anything; nothing is published.
//
// Publishing takes that SHA-256 and requires release.json to have it, the
// folder to hold exactly that release and every file to be unchanged, and both
// Beta feed addresses to serve a feed already. It
// creates the GitHub prerelease as a draft, compares GitHub's digest of each
// uploaded file and the draft's notes with the prepared ones, and only then
// makes it public, reads it back, reads every file back and waits for the site
// to serve the new feed.
//
// docs/development/releases.md is the runbook, including what a killed run
// leaves behind and how to remove it.

import { extractFile, uncache } from "@electron/asar";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { parseFeed } from "../src/main/update/feed.ts";
import { isNewer, parseVersion } from "../src/main/update/version.ts";
import {
  BETA_FEED_URL,
  betaTag,
  LEGACY_BETA_FEED_URL,
  LEGACY_BETA_PIN,
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
import { packagedCarried } from "./carried-plugins.ts";
import { OUTPUT_VARIABLE } from "./output.ts";
import { RESERVATION_FILE, reserve, reservedBy } from "./reservation.ts";
import { APP_ID, PRODUCT_NAME } from "./config.ts";
import { artifactName, makeFeed } from "./feed.ts";
import { newestBeta, pinnedBeta, type ReleaseRow } from "./site-feed.ts";

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
  /** The signal that ended it, and the code of an error that kept it from finishing. */
  signal?: NodeJS.Signals | null | undefined;
  error?: string | undefined;
}
export type Run = (
  command: string,
  args: string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    inherit?: boolean;
    input?: string;
    timeout?: number;
  },
) => RunResult;

export const run: Run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout,
    input: options.input,
    stdio: [
      options.input === undefined ? "ignore" : "pipe",
      options.inherit ? "inherit" : "pipe",
      options.inherit ? "inherit" : "pipe",
    ],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    signal: result.signal,
    error: (result.error as NodeJS.ErrnoException | undefined)?.code,
  };
};

/** How a run that gave no answer ended, for a message. */
function ended(result: RunResult): string {
  if (result.error === "ETIMEDOUT") return "timed out";
  if (result.error) return `could not start (${result.error})`;
  if (result.signal) return `crashed (signal ${result.signal})`;
  return `exited ${result.status}`;
}

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

/** The tools that take a secret, by absolute path, so no entry in PATH can stand in for them. */
export const SECURITY = "/usr/bin/security";
export const XCRUN = "/usr/bin/xcrun";
/** The lock settings the release keychain is given, as `show-keychain-info` reports them. */
const KEYCHAIN_LOCK = /\block-on-sleep timeout=3600s\b/;

/**
 * Makes the release keychain in `dir`: the certificate imported and the notary
 * key stored as NOTARY_PROFILE. Every secret goes to `security` or `notarytool`
 * on its standard input, one `security -i` command at a time, each one's status
 * checked. Both raw files are deleted as soon as their tool returns, before the
 * identity is read, so neither exists when the build starts. Failures name the
 * step, never its input or the tool's output.
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
  const certificate = join(dir, CERTIFICATE_FILE);
  const key = join(dir, KEY_FILE);
  const keychain = join(dir, KEYCHAIN_FILE);
  // Lives only in this process: a keychain left by a killed run stays locked to everyone.
  const unlock = randomBytes(32).toString("base64url");
  const security = (step: string, command: string) => {
    if (runner(SECURITY, ["-i"], { env, input: `${command}\n` }).status !== 0)
      stop(`The release keychain's ${step} step failed.`);
  };
  writeFileSync(certificate, p12, { mode: 0o600, flag: "wx" });
  try {
    security(
      "create-keychain",
      `create-keychain -p ${securityWord(unlock)} ${securityWord(keychain)}`,
    );
    // Locks itself after an hour unused and when the Mac sleeps.
    security(
      "set-keychain-settings",
      `set-keychain-settings -l -u -t 3600 ${securityWord(keychain)}`,
    );
    security(
      "unlock-keychain",
      `unlock-keychain -p ${securityWord(unlock)} ${securityWord(keychain)}`,
    );
    security(
      "import",
      `import ${securityWord(certificate)} -k ${securityWord(keychain)} -f pkcs12 -P ${securityWord(password)} -T /usr/bin/codesign`,
    );
  } finally {
    rmSync(certificate, { force: true });
  }
  security(
    "set-key-partition-list",
    `set-key-partition-list -S apple-tool:,apple: -s -k ${securityWord(unlock)} ${securityWord(keychain)}`,
  );
  const info = runner(SECURITY, ["show-keychain-info", keychain], { env });
  if (info.status !== 0 || !KEYCHAIN_LOCK.test(info.stderr + info.stdout))
    stop("The release keychain does not lock on sleep and after an hour.");
  writeFileSync(key, p8, { mode: 0o600, flag: "wx" });
  let stored: RunResult;
  try {
    // notarytool asks for the key's path, its id and the issuer, in that order.
    stored = runner(
      XCRUN,
      ["notarytool", "store-credentials", NOTARY_PROFILE, "--keychain", keychain],
      {
        env,
        input: `${key}\n${keyId}\n${issuer}\n`,
      },
    );
  } finally {
    rmSync(key, { force: true });
  }
  if (stored.status !== 0)
    stop(
      "Apple did not accept the notary API key. Check APPLE_CLAWTRATE_NOTARY_API_KEY_P8, APPLE_CLAWTRATE_NOTARY_API_KEY_ID and APPLE_CLAWTRATE_NOTARY_ISSUER_ID.",
    );
  const found = runner(SECURITY, ["find-identity", "-v", "-p", "codesigning", keychain], { env });
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

/** The raw credential files, by fixed names; neither outlives its tool's call. */
export const CERTIFICATE_FILE = "developer-id.p12";
export const KEY_FILE = "notary.p8";
/** The release keychain's file in the signing folder. */
export const KEYCHAIN_FILE = "release.keychain-db";
/** The user's keychain search list before the build, recorded in the signing folder. */
export const SEARCH_LIST_FILE = "search-list.json";

/**
 * The user's keychain search list, in order, as `security list-keychains -d
 * user` prints it: one double-quoted path a line. Anything else stops the
 * release before the list is changed.
 */
export function readSearchList(runner: Run): string[] {
  const got = runner(SECURITY, ["list-keychains", "-d", "user"]);
  if (got.status !== 0) stop("Could not read the keychain search list. It was not changed.");
  const list: string[] = [];
  for (const line of got.stdout.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    const quoted = /^"([^"]+)"$/.exec(text);
    if (!quoted) stop(`Could not read the keychain search list (${text}). It was not changed.`);
    list.push(quoted[1]!);
  }
  return list;
}

/** Sets the user's search list to exactly `list`, each path one argument: no shell splits it. */
function setSearchList(runner: Run, list: readonly string[]): boolean {
  return runner(SECURITY, ["list-keychains", "-d", "user", "-s", ...list]).status === 0;
}

/** The shell command that sets the list to `list`, each path quoted. */
function setCommand(list: readonly string[]): string {
  return `/usr/bin/security list-keychains -d user -s ${list.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(" ")}`;
}

/** The names the list can show a keychain by: as made, and through any link in its folder. */
function keychainNames(keychain: string): Set<string> {
  const names = new Set([keychain]);
  try {
    names.add(join(realpathSync(dirname(keychain)), basename(keychain)));
  } catch {
    // Its folder is gone: only the name it was made with.
  }
  return names;
}

const KEPT_RECORD =
  'Its record is kept; docs/development/releases.md, "If a run is killed", says how to restore it by hand.';

/**
 * Takes this run's keychain off the user's search list, read and compared
 * first so a change made meanwhile by the user or another tool is kept:
 * - the list is exactly what this run put there (`keychain` first, then the
 *   recorded list): the recorded list is put back;
 * - it is already the recorded list: nothing is written;
 * - it holds `keychain` among other changes: the current list minus that
 *   entry is written;
 * - it cannot be read, or no longer holds `keychain`: nothing is written,
 *   since this run cannot tell what to put back.
 * What it writes must read back as written. Otherwise, and when it writes
 * nothing for want of knowing what, it stops, naming the command or the record.
 * Returns what the list now is, whether it wrote it, and whether other changes were kept.
 */
export function restoreSearchList(
  runner: Run,
  previous: readonly string[],
  keychain: string,
): { list: string[]; wrote: boolean; keptChanges: boolean } {
  const names = keychainNames(keychain);
  let now: string[];
  try {
    now = readSearchList(runner);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    stop(`The keychain search list could not be read, so nothing was written. ${KEPT_RECORD}`);
  }
  const same = (a: readonly string[], b: readonly string[]) => a.join("\n") === b.join("\n");
  if (same(now, previous)) return { list: now, wrote: false, keptChanges: false };
  if (!now.some((path) => names.has(path)))
    stop(
      `The keychain search list no longer holds ${keychain} and is not the recorded list, so this run cannot tell what to put back and wrote nothing. ${KEPT_RECORD}`,
    );
  const installed = [keychain, ...previous.filter((path) => !names.has(path))];
  const asInstalled = same(
    now.map((path) => (names.has(path) ? keychain : path)),
    installed,
  );
  const target = asInstalled ? [...previous] : now.filter((path) => !names.has(path));
  const set = setSearchList(runner, target);
  let back: string[] | null = null;
  try {
    back = readSearchList(runner);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
  }
  if (!set || back === null || !same(back, target))
    stop(`The keychain search list could not be restored. Set it back with: ${setCommand(target)}`);
  return { list: target, wrote: true, keptChanges: !asInstalled };
}

/** Puts the recorded list back, verified; safe to call again after a failure. */
export type RestoreList = () => void;

/**
 * Puts the release keychain first on the user's search list for the build,
 * keeping the user's keychains in order and the default keychain as it is:
 * electron-builder 26.18.1 asks codesign for the identity by name with
 * `--keychain`, and codesign finds no identity in a keychain that is not on the
 * search list. The previous list is recorded in `dir` and the restore is handed
 * to `register` before the list is changed, so every way out, a failed first
 * change included, puts it back; the next run restores it after a run killed
 * outright (`clearLeftovers`). The restore counts as done only once the list
 * reads back as it was, so a failed one can be tried again.
 */
export function searchListForBuild(
  runner: Run,
  keychain: string,
  dir: string,
  register: (restore: RestoreList) => void,
): void {
  const previous = readSearchList(runner);
  writeFileSync(join(dir, SEARCH_LIST_FILE), JSON.stringify(previous), { mode: 0o600, flag: "wx" });
  let restored = false;
  register(() => {
    if (restored) return;
    const { wrote, keptChanges } = restoreSearchList(runner, previous, keychain);
    restored = true;
    console.log(
      keptChanges
        ? "Took the release keychain off the keychain search list, keeping the other changes made to it during the build."
        : wrote
          ? "Restored the keychain search list."
          : "The keychain search list was already as recorded.",
    );
  });
  if (!setSearchList(runner, [keychain, ...previous.filter((path) => path !== keychain)]))
    stop("Could not put the release keychain on the keychain search list. Nothing was built.");
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
  reservation?: string,
  output?: string,
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
    // Which reserved staging folder the build may start from (reservation.ts).
    ...(reservation ? { CLAWTRATE_RELEASE_RESERVATION: reservation } : {}),
    // Where electron-builder writes: this run's own folder (output.ts).
    ...(output ? { [OUTPUT_VARIABLE]: output } : {}),
  };
}

/** The next run number of `base` on `day` that no tag has used. */
export function nextRun(tags: readonly string[], base: string, day: string): number {
  const prefix = `v${base}-beta.${day}.`;
  let highest = 0;
  for (const tag of tags) {
    // Only a whole beta tag counts: `….1e12` is not one, though Number() reads it.
    if (!tag.startsWith(prefix) || !isBetaTag(tag)) continue;
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
  requireCarried(app, require);
  return { teamId: signature.teamId! };
}

/**
 * The plugins the app carries (carried-plugins.ts): the list in its archive names at least
 * one, and each tarball it names is in the resources' plugins folder with the list's integrity.
 */
function requireCarried(app: string, require: (ok: boolean, check: string) => void): void {
  let carried: ReturnType<typeof packagedCarried> | null = null;
  try {
    carried = packagedCarried(join(app, "Contents/Resources"));
  } catch {
    // Said by the check below.
  }
  require(Array.isArray(carried?.list.plugins), "the carried plugins' list in app.asar");
  const { list, tarballs } = carried!;
  require(list.plugins.length > 0, "a carried plugin in app.asar's list");
  for (const plugin of list.plugins) {
    const path = join(tarballs, String(plugin.file));
    const plain = basename(String(plugin.file)) === plugin.file;
    const bytes = plain && existsSync(path) ? readFileSync(path) : null;
    require(bytes !== null &&
      `sha512-${sha("sha512", bytes, "base64")}` ===
        plugin.integrity, `the carried plugin ${String(plugin.file)} with its integrity`);
  }
}

/**
 * The Beta feed address the app's main bundle is compiled with must be
 * `BETA_FEED_URL`, and never the legacy one, so the address a release records
 * is the one its build reads (docs/decisions.md, "Moving betas to three numbers").
 */
export function requireCompiledFeed(app: string): void {
  const archive = join(app, "Contents/Resources/app.asar");
  let main: string;
  try {
    uncache(archive);
    main = extractFile(archive, "out/main/index.js").toString("utf8");
  } catch {
    stop(`${app}: its main bundle could not be read from app.asar.`);
  }
  if (!main.includes(JSON.stringify(BETA_FEED_URL)) || main.includes(LEGACY_BETA_FEED_URL))
    stop(`${app} is not built to read ${BETA_FEED_URL} alone.`);
}

/**
 * Builds the update helper's ZIP preflight (mac/check-zip.m, which compiles
 * inspect-archive.m) into `dir`, and returns a check that stops the release on
 * a zip it refuses: every installed app runs that preflight before reading an update.
 */
export function zipCheck(runner: Run, dir: string): (zip: string) => void {
  const checker = join(dir, "check-zip");
  const source = join(APP_DIR, "packaging/mac/check-zip.m");
  const built = runner(
    "xcrun",
    [
      "clang",
      "-fobjc-arc",
      "-Wall",
      "-Werror",
      "-O2",
      "-mmacosx-version-min=12.0",
      "-framework",
      "Foundation",
      "-framework",
      "Security",
      "-larchive.2",
      source,
      "-o",
      checker,
    ],
    { timeout: 120_000 },
  );
  if (built.status !== 0)
    stop(
      `Could not build the update helper's ZIP check: ${built.stderr.trim() || `xcrun clang ${ended(built)}`}. Nothing was published.`,
    );
  return (zip) => {
    const result = runner(checker, [zip], { timeout: 60_000 });
    // A pass is the check's own "ok", never a silent exit 0.
    if (result.status === 0 && result.stdout === "ok\n") return;
    const reason = (result.status === 1 && result.stdout.trim()) || `the check ${ended(result)}`;
    stop(
      `${basename(zip)} would be refused by the Mac updater's ZIP check: ${reason}. Nothing was published.`,
    );
  };
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
  return plannedBytes(name, readFileSync(join(dir, name)));
}

function plannedBytes(name: string, bytes: Buffer): PlannedFile {
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
    ".[] | {tag_name, draft, prerelease, target_commitish, body, assets: [.assets[] | {id, name, size, digest, state, browser_download_url}]}",
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

/**
 * Where a release is staged, which app it builds, and its private state
 * folder: the release locks and the signing folders.
 */
export interface Places {
  staging: string;
  appDir: string;
  state: string;
}

/**
 * This macOS user's release state folder. It comes from the account's own
 * home folder (`os.userInfo`), not from `TMPDIR` or `HOME`, so every
 * environment the same user runs a release from shares one lock.
 */
export function releaseStateFolder(home = userInfo().homedir): string {
  return join(home, "Library", "Application Support", "clawtrate-release");
}

/** Creates `folder` if missing, and requires it to be a real folder of this user's that only they can read. */
export function privateFolder(folder: string): void {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const found = lstatSync(folder);
  const uid = process.getuid?.();
  if (
    !found.isDirectory() ||
    found.isSymbolicLink() ||
    (uid !== undefined && found.uid !== uid) ||
    (found.mode & 0o077) !== 0
  )
    stop(
      `${folder} must be a folder of yours that only you can read. Fix its owner and mode (chmod 700), then run this again.`,
    );
}

const PLACES = (): Places => ({ staging: STAGING, appDir: APP_DIR, state: releaseStateFolder() });

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

/**
 * Removes the signing folders of runs that have ended, by the pid each one
 * records; refuses while one of them runs. A folder with no readable pid may be
 * a run that is just starting, so it is left for the maintainer to inspect.
 * Before removing a folder, it puts back the search list that run recorded,
 * but only while that run's keychain is still on the list.
 */
function clearLeftovers(runner: Run, parent: string) {
  for (const name of readdirSync(parent).filter((entry) => SIGNING_FOLDER.test(entry))) {
    const folder = join(parent, name);
    let pid = Number.NaN;
    try {
      pid = Number(readFileSync(join(folder, "pid"), "utf8"));
    } catch {
      // No pid file.
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      console.log(
        `Left ${folder} alone: it records no pid. If no release is running, remove it yourself.`,
      );
      continue;
    }
    if (pid !== process.pid && running(pid))
      stop(`Another release (pid ${pid}) is signing from ${folder}. Let it finish first.`);
    const record = join(folder, SEARCH_LIST_FILE);
    if (existsSync(record)) {
      let previous: unknown;
      try {
        previous = JSON.parse(readFileSync(record, "utf8"));
      } catch {
        previous = null;
      }
      if (!Array.isArray(previous) || !previous.every((path) => typeof path === "string"))
        stop(
          `${record} is not a keychain search list. Check the list yourself, then remove ${folder}.`,
        );
      // The same rule as a run's own restore: read and compare first, and
      // write nothing when it cannot tell what to put back.
      const { wrote, keptChanges } = restoreSearchList(
        runner,
        previous,
        join(folder, KEYCHAIN_FILE),
      );
      console.log(
        keptChanges
          ? `Took the keychain of an interrupted release (pid ${pid}) off the keychain search list, keeping the other changes made to it since.`
          : wrote
            ? `Restored the keychain search list that an interrupted release (pid ${pid}) changed.`
            : `The keychain search list is already as it was before an interrupted release (pid ${pid}).`,
      );
    }
    rmSync(folder, { recursive: true, force: true });
    console.log(`Removed ${folder}, which an interrupted release (pid ${pid}) left.`);
  }
}

/** The release locks' folder inside the per-user state folder (`releaseStateFolder`). */
export const LOCKS_FOLDER = "locks";
/** One lock file per run: its pid and a random token, so no run's name is another's. */
const LOCK_NAME = /^release-(\d+)-([0-9a-f]{32})\.lock$/;

/** A process's start time as `ps` reports it, which tells a reused pid apart; null if none. */
function processStart(pid: number): string | null {
  const got = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const text = got.status === 0 ? got.stdout.trim() : "";
  return text || null;
}

/**
 * Takes this user's release lock, so one release at a time owns the keychain
 * search list, whatever its checkout or environment. Each run writes a lock
 * file of its own, named by its pid and a random token, under `state`, then
 * reads every other one:
 * - a run that is alive with the start time it recorded holds the lock: refuse;
 * - a run whose pid no longer exists has ended: its file is removed, which can
 *   only ever be that ended run's, since every run's file has its own name;
 * - anything else (a file that cannot be read, or a live pid with another
 *   start time) is ambiguous: refuse, and say how to clear it by hand.
 * Every run writes its file before it reads the others, so two runs that start
 * together never both go ahead. A refusing run removes only its own file.
 * Returns the call that gives up this run's lock, which removes only its own file.
 */
export function takeReleaseLock(state: string): () => void {
  privateFolder(state);
  const dir = join(state, LOCKS_FOLDER);
  privateFolder(dir);
  const start = processStart(process.pid);
  if (!start) stop("Could not read this process's start time to take the release lock.");
  const token = randomBytes(16).toString("hex");
  const name = `release-${process.pid}-${token}.lock`;
  const mine = join(dir, name);
  const text = JSON.stringify({ pid: process.pid, start, token });
  // Written whole under a name no scan reads, then renamed into place.
  const partial = join(dir, `.${name}.partial`);
  writeFileSync(partial, text, { mode: 0o600, flag: "wx" });
  renameSync(partial, mine);
  const release = () => {
    try {
      if (readFileSync(mine, "utf8") === text) rmSync(mine);
    } catch {
      // Gone already.
    }
  };
  const refuse = (why: string): never => {
    release();
    stop(
      `${why} If no other release is running, check the pid with \`ps -p <pid>\`, then remove that file yourself (docs/development/releases.md, "If a run is killed").`,
    );
  };
  for (const entry of readdirSync(dir).sort()) {
    if (entry === name || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    const named = LOCK_NAME.exec(entry);
    if (!named) refuse(`${path} is not a release lock this tool writes.`);
    let holder: { pid?: unknown; start?: unknown; token?: unknown } | null;
    try {
      holder = JSON.parse(readFileSync(path, "utf8")) as typeof holder;
    } catch {
      holder = null;
    }
    if (
      !holder ||
      holder.pid !== Number(named![1]) ||
      holder.token !== named![2] ||
      typeof holder.start !== "string"
    )
      refuse(`${path} cannot be read as a release's lock.`);
    const pid = holder!.pid as number;
    if (!running(pid)) {
      rmSync(path, { force: true });
      console.log(`Took over the release lock from a release (pid ${pid}) that has ended.`);
      continue;
    }
    if (processStart(pid) === holder!.start)
      refuse(`Another release (pid ${pid}) holds the release lock (${path}). Let it finish first.`);
    refuse(
      `${path} names pid ${pid}, which is running but started at another time than the lock records, so this run cannot tell whether that release has ended.`,
    );
  }
  return release;
}

/** A build that has started: its result, and a way to stop it and everything it started. */
export interface StartedBuild {
  done: Promise<RunResult>;
  /** Stops the build's whole process group and resolves once none of it is left. */
  stop(): Promise<void>;
}
export type StartBuild = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => StartedBuild;

/** Whether any process of the group led by `pid` is left. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The build in a process group of its own, run without blocking, so that
 * Ctrl-C or SIGTERM to this script can stop electron-builder, notarytool and
 * every other process it started (a stalled notarization included) before the
 * signing folder is removed.
 */
export const startBuild: StartBuild = (command, args, { env }) => {
  const child = spawn(command, args, {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => (stdout += text));
  child.stderr.setEncoding("utf8").on("data", (text: string) => (stderr += text));
  const done = new Promise<RunResult>((resolve) => {
    child.once("error", (error) => resolve({ status: null, stdout, stderr: `${stderr}${error}` }));
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
  const signal = (name: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, name);
    } catch {
      // The group is gone.
    }
  };
  const stop = async () => {
    const pid = child.pid;
    if (!pid) return;
    signal("SIGTERM");
    // Ten seconds to stop cleanly, then the group is killed outright.
    for (let waited = 0; groupAlive(pid); waited += 100) {
      if (waited === 10_000) signal("SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await done;
  };
  return { done, stop };
};

/** A build run through `runner`, for the tests' stand-ins: it ends before it can be stopped. */
export function blockingBuild(runner: Run): StartBuild {
  return (command, args, options) => ({
    done: Promise.resolve(runner(command, args, options)),
    stop: async () => undefined,
  });
}

/**
 * The build log candidate-build.ts names: the last `Build log: <path>` line
 * whose path is absolute and exists. Node prints the throwing source line, which
 * holds `Build log: ${log}` itself, before the error, so the first match is not
 * the path. The rest of the line is the path: a folder's name can hold spaces.
 */
export function buildLog(stderr: string): string | undefined {
  return [...stderr.matchAll(/Build log: (.+?)\r?$/gm)]
    .map((match) => match[1]!)
    .filter((path) => isAbsolute(path) && existsSync(path))
    .at(-1);
}

export async function prepare(
  runner: Run,
  now: Date,
  places: Places = PLACES(),
  startBuilding: StartBuild = blockingBuild(runner),
): Promise<void> {
  // One release at a time owns the keychain search list, from any checkout.
  // Kept only while a search list awaits restoring: the next run takes it
  // over once this run has ended, and restores the list first.
  const lock = { release: takeReleaseLock(places.state), keep: false };
  try {
    await prepareLocked(runner, now, places, startBuilding, lock);
  } finally {
    if (!lock.keep) lock.release();
  }
}

/**
 * The release under the lock. Sets `lock.keep` when it leaves the search list
 * for the next run to restore (the restore could not be verified), and gives
 * the lock up itself when it exits from a signal.
 */
async function prepareLocked(
  runner: Run,
  now: Date,
  places: Places,
  startBuilding: StartBuild,
  lock: { release: () => void; keep: boolean },
): Promise<void> {
  const { staging, appDir } = places;
  // First, so a retry after any refusal clears what a killed run left.
  clearLeftovers(runner, places.state);
  const read = readSecrets(runner);
  if (!read.ok) {
    stop(
      `The vault has no value for ${read.missing.join(", ")}. Add ${read.missing.length > 1 ? "them" : "it"} and run again. Nothing was built.`,
    );
  }
  const { secrets } = read;
  if (runner("git", ["status", "--porcelain"]).stdout.trim())
    stop("Commit or remove local changes first: a release is built from a clean checkout.");
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
  console.log(`Building Clawtrate ${version} from ${commit.slice(0, 12)}.`);
  console.log("Notarization sends both apps to Apple's notary service. Nothing is published.");

  // This run's version folder, created exclusively with its marker inside
  // (reservation.ts). After a failure it is removed only while it is
  // unfinished and still carries that marker.
  const owner = JSON.stringify({ pid: process.pid, token: randomBytes(16).toString("hex") });
  try {
    reserve(out, owner);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    stop(`${out} appeared before this run could reserve it. It was left as it is.`);
  }
  /** Removes the version folder while it is this run's and unfinished; names it otherwise. */
  const clearOut = () => {
    if (!existsSync(out) || existsSync(join(out, "release.json"))) return;
    if (reservedBy(out, owner)) rmSync(out, { recursive: true, force: true });
    else console.log(`Left ${out} in place: this run cannot tell it made it.`);
  };

  // The keychain lives here while the build runs, electron-builder writes the
  // build here (output.ts: never apps/desktop/dist), and the zips are verified
  // here. Every way out puts the search list back first and removes the folder
  // once the list reads back as it was; a run killed outright leaves it, and
  // the next run restores the list and removes it (docs/development/releases.md).
  // A setup step that fails releases what was reserved before it.
  let temp: string;
  try {
    temp = mkdtempSync(join(places.state, "clawtrate-signing-"));
  } catch (error) {
    clearOut();
    throw error;
  }
  try {
    writeFileSync(join(temp, "pid"), String(process.pid), { mode: 0o600, flag: "wx" });
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    clearOut();
    throw error;
  }
  const output = join(temp, "build");
  let restoreList: RestoreList | null = null;
  let succeeded = false;
  /** Puts the list back; on failure prints the command and keeps the folder for the next run. */
  const putBack = () => {
    try {
      restoreList?.();
      return true;
    } catch (error) {
      console.error((error as Error).message);
      return false;
    }
  };
  /** Removes this run's build output and its unfinished version folder. */
  const clearFailed = () => {
    rmSync(output, { recursive: true, force: true });
    clearOut();
  };
  /** Restore first; then the artifacts; then the folder, only once the list is back. */
  const finish = (failed: boolean) => {
    const restored = putBack();
    if (failed)
      try {
        clearFailed();
      } catch (error) {
        console.error(`Could not remove this run's output: ${(error as Error).message}`);
      }
    if (restored) rmSync(temp, { recursive: true, force: true });
    else if (!lock.keep) {
      lock.keep = true;
      console.error(
        `Kept ${temp} with its ${SEARCH_LIST_FILE}: the next pnpm release:beta restores the search list from it.`,
      );
    }
  };
  // An exit the code did not plan for: put everything back, then give up the lock.
  const atExit = () => {
    finish(!succeeded);
    if (!lock.keep) lock.release();
  };
  let building: StartedBuild | null = null;
  let interrupting = false;
  // Stops the build and waits for all of it, restores the search list, removes
  // what the run made, and exits.
  const interrupted = () => {
    if (interrupting) return;
    interrupting = true;
    void (building?.stop() ?? Promise.resolve()).finally(() => {
      process.off("exit", atExit);
      atExit();
      process.exit(130);
    });
  };
  process.on("exit", atExit);
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  try {
    // Built before the build, so a check that won't compile costs no build or notarization.
    const checkZip = zipCheck(runner, temp);
    const signing = signingKeychain(runner, secrets, temp);
    for (const name of [CERTIFICATE_FILE, KEY_FILE])
      if (existsSync(join(temp, name))) stop(`${name} still exists. Nothing was built.`);
    // For the build only: restored as soon as it ends, and on every way out.
    searchListForBuild(runner, signing.keychain, temp, (restore) => (restoreList = restore));
    building = startBuilding(
      process.execPath,
      [join(APP_DIR, "packaging/candidate-build.ts"), out, version],
      { env: buildEnvironment(process.env, signing, epoch, owner, output) },
    );
    const build = await building.done;
    building = null;
    // Interrupted while building: the handler exits once the folder is removed.
    if (interrupting) await new Promise(() => undefined);
    restoreList!();
    if (build.status !== 0) {
      // The log is electron-builder's and can name the identity and team; it is not printed.
      const log = buildLog(build.stderr);
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
        sha512: string;
      };
      if (receipt.commit !== commit || receipt.packagerReadback !== "certificate")
        stop(`${key} was not signed with a certificate by this commit's build.`);
      rmSync(join(out, `${key}.json`));
      // Verified as a private copy, which is what gets staged and recorded.
      const zip = join(temp, artifactName(version, key));
      copyFileSync(join(out, artifactName(version, key)), zip);
      // The copy must be the zip the receipt describes, or the record would
      // attribute another build to this commit.
      if (sha("sha512", readFileSync(zip), "base64") !== receipt.sha512)
        stop(`${artifactName(version, key)} is not the zip its build receipt names.`);
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
      // The zip as it will be staged, after any second stapling.
      checkZip(zip);
      requireCompiledFeed(app);
      if (checked.teamId !== signing.teamId)
        stop(`${key} is signed by team ${checked.teamId}, not ${signing.teamId}.`);
      teamId = checked.teamId;
      console.log(`${key}: signed by team ${teamId}, notarized, stapled, accepted by Gatekeeper.`);
    }

    // Everything below is made from the verified copies, then staged.
    // The feed records the address both apps were just checked to read; installed
    // builds ignore the field, and the site requires it of a pinned beta.
    const feed = {
      ...makeFeed({ version, releaseDate, folder: releaseFolder(tag), dir: temp }),
      buildFeed: BETA_FEED_URL,
    };
    const feedText = `${JSON.stringify(feed, null, 2)}\n`;
    const zips = Object.values(MAC_ARCHITECTURES).map((key) => {
      const name = artifactName(version, key);
      const bytes = readFileSync(join(temp, name));
      writeFileSync(join(out, name), bytes);
      return plannedBytes(name, bytes);
    });
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
      files: [
        ...zips,
        plannedBytes(FEED_NAME, Buffer.from(feedText)),
        plannedBytes(LATEST_MAC_NAME, Buffer.from(latestText)),
      ],
    };
    const record = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
    writeFileSync(join(out, "release.json"), record);
    // Staged: the folder holds exactly the release's files.
    rmSync(join(out, RESERVATION_FILE));
    const recordSha256 = sha("sha256", record, "hex");
    succeeded = true;
    console.log(`\nPrepared ${out}`);
    for (const file of plan.files)
      console.log(`  ${file.name}  ${file.size} bytes  sha256 ${file.sha256}`);
    console.log(`  release.json  sha256 ${recordSha256}`);
    console.log(
      `\nNothing was published. Keep the release.json digest above: publishing requires it.\nTo publish it: pnpm release:beta --publish ${version} ${recordSha256}`,
    );
  } finally {
    if (!interrupting) {
      finish(!succeeded);
      process.off("exit", atExit);
      process.off("SIGINT", interrupted);
      process.off("SIGTERM", interrupted);
    }
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
    "If OpenClaw is already on your Mac, Clawtrate asks for your gateway's address and token under Advanced. It doesn't connect to it by itself yet: that would mean running OpenClaw's own program before you agree, and that program can change its installation when it starts.",
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
export function stagedRelease(
  staging: string,
  version: string,
  recordSha256: string,
): { plan: ReleasePlan; notes: string } {
  const tag = tagOf(version);
  const dir = join(staging, version);
  if (!existsSync(join(dir, "release.json"))) stop(`${dir} holds no prepared release.`);
  const names = releaseFiles(version);
  const expected = [...names, "notes.md", "release.json"].sort();
  const present = readdirSync(dir).sort();
  if (present.join("\n") !== expected.join("\n"))
    stop(`${dir} must hold exactly ${expected.join(", ")}; it holds ${present.join(", ")}.`);
  // Read once, and matched with the digest preparation printed before anything trusts it.
  const record = readFileSync(join(dir, "release.json"));
  if (sha("sha256", record, "hex") !== recordSha256)
    stop(
      `${dir}/release.json is not the record preparation printed (sha256 ${recordSha256}). Nothing was published.`,
    );
  let plan: ReleasePlan;
  try {
    plan = JSON.parse(record.toString("utf8")) as ReleasePlan;
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
    buildFeed?: unknown;
  };
  const latest = JSON.parse(latestText) as LatestMac;
  if (feed.releaseDate !== plan.releaseDate) stop("The feed's date is not release.json's.");
  if (feed.buildFeed !== BETA_FEED_URL)
    stop(`The feed does not record that this build reads ${BETA_FEED_URL}. Prepare it again.`);
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
  const notes = releaseNotes(version, plan.commit, zips);
  if (readFileSync(join(dir, "notes.md"), "utf8") !== notes)
    stop("notes.md is not the notes this release's record makes.");
  return { plan, notes };
}

/** How the script reaches the site and GitHub's public downloads; tests pass stand-ins. */
export interface Net {
  /** `follow` false asks for a redirect to be returned, not followed. */
  get: (url: string, signal: AbortSignal, follow: boolean) => Promise<Response>;
  /** Each request's own deadline. */
  requestMs: number;
  /** How long to wait for the site, and how often to ask. */
  waitMs: number;
  pollMs: number;
}
const NET: Net = {
  get: (url, signal, follow) => fetch(url, { redirect: follow ? "follow" : "manual", signal }),
  requestMs: 60_000,
  waitMs: 15 * 60_000,
  pollMs: 20_000,
};

/** A file's bytes through its public address, following GitHub's redirect unless told not to, or why not. */
async function download(
  net: Net,
  url: string,
  ms: number,
  follow = true,
): Promise<{ ok: true; body: Buffer } | { ok: false; status: number | null; reason: string }> {
  try {
    const response = await net.get(url, AbortSignal.timeout(ms), follow);
    if (response.status >= 300 && response.status < 400)
      return { ok: false, status: response.status, reason: `a redirect (HTTP ${response.status})` };
    if (!response.ok)
      return { ok: false, status: response.status, reason: `HTTP ${response.status}` };
    return { ok: true, body: Buffer.from(await response.arrayBuffer()) };
  } catch (error) {
    const timedOut = (error as Error).name === "TimeoutError";
    return { ok: false, status: null, reason: timedOut ? "no answer in time" : "no connection" };
  }
}

/** What the site serves at a Beta feed's address, read once. */
export type SiteReading =
  | { kind: "feed"; version: string; body: Buffer }
  | { kind: "absent" }
  | { kind: "inconclusive"; reason: string };

export async function readSite(
  net: Net,
  ms = net.requestMs,
  url = BETA_FEED_URL,
): Promise<SiteReading> {
  // The configured address itself, with no redirect followed: a 404 elsewhere proves nothing.
  const got = await download(net, url, ms, false);
  if (!got.ok)
    return got.status === 404 ? { kind: "absent" } : { kind: "inconclusive", reason: got.reason };
  const text = got.body.toString("utf8");
  const parsed = parseFeed(text, new URL(url), null, undefined, "nightly");
  if (!parsed.ok) return { kind: "inconclusive", reason: `not a Beta feed (${parsed.cause})` };
  return {
    kind: "feed",
    version: (JSON.parse(text) as { version: string }).version,
    body: got.body,
  };
}

/**
 * Reads the site until `done` accepts a reading or the wait ends; returns the
 * last reading completed in time, or an inconclusive result for a late read.
 */
async function watchSite(net: Net, done: (reading: SiteReading) => boolean, url = BETA_FEED_URL) {
  const deadline = Date.now() + net.waitMs;
  for (;;) {
    const reading = await readSite(
      net,
      Math.max(1, Math.min(net.requestMs, deadline - Date.now())),
      url,
    );
    if (Date.now() > deadline)
      return {
        done: false,
        reading: { kind: "inconclusive", reason: "no answer in time" } as const,
      };
    if (done(reading)) return { done: true, reading };
    if (Date.now() + net.pollMs > deadline) return { done: false, reading };
    await new Promise((resolve) => setTimeout(resolve, net.pollMs));
  }
}

/** Whether a tag is a beta's own, `v` and a beta version exactly. */
function isBetaTag(tag: string): boolean {
  try {
    return tag.startsWith("v") && betaTag(tag.slice(1)) === tag;
  } catch {
    return false;
  }
}

/**
 * Every earlier beta on GitHub, published or withdrawn, must carry exactly one
 * uploaded latest-mac.json naming `teamId`. Reads them through the API, so an
 * outage, a missing or unreadable file stops the release; only a listing with
 * no earlier beta is a first release.
 */
function requireSameSigner(
  runner: Run,
  releases: readonly ReleaseRow[],
  tag: string,
  teamId: string,
) {
  const earlier = releases.filter((row) => row.tag_name !== tag && isBetaTag(row.tag_name));
  if (earlier.length === 0) {
    console.log("GitHub has no earlier beta: this is the first, so there is no signer to match.");
    return;
  }
  for (const row of earlier) {
    const metadata = row.assets.filter((each) => each.name === LATEST_MAC_NAME);
    const asset = metadata[0];
    if (
      metadata.length !== 1 ||
      asset!.state !== "uploaded" ||
      !Number.isSafeInteger(asset!.id) ||
      asset!.id! <= 0
    )
      stop(
        `${row.tag_name} has no single uploaded ${LATEST_MAC_NAME}, so its signer is unknown. Nothing was published.`,
      );
    const got = runner("gh", [
      "api",
      "-H",
      "Accept: application/octet-stream",
      `repos/${REPOSITORY}/releases/assets/${asset!.id}`,
    ]);
    let team: unknown;
    try {
      team = got.status === 0 ? (JSON.parse(got.stdout) as LatestMac).teamIdentifier : undefined;
    } catch {
      team = undefined;
    }
    if (typeof team !== "string" || !TEAM_ID.test(team))
      stop(`Could not read the team of ${row.tag_name} from GitHub. Nothing was published.`);
    if (team !== teamId)
      stop(
        `${row.tag_name} is signed by team ${team}, this beta by ${teamId}. Nothing was published.`,
      );
  }
  console.log(`Signed by team ${teamId}, as every earlier beta (${earlier.length}).`);
}

/** The release as GitHub lists it now: the row, undefined when absent, null when unreadable. */
function readBack(runner: Run, tag: string): ReleaseRow | undefined | null {
  try {
    return githubReleases(runner).find((row) => row.tag_name === tag);
  } catch (error) {
    if (error instanceof Stop) return null;
    throw error;
  }
}

/** Release text as GitHub keeps it: line ends and trailing space aside. */
const sameText = (a: string | null | undefined, b: string) =>
  (a ?? "").replace(/\r\n/g, "\n").trimEnd() === b.replace(/\r\n/g, "\n").trimEnd();

export async function publish(
  runner: Run,
  version: string,
  recordSha256: string,
  net: Net = NET,
  staging = STAGING,
  pin: string | null = LEGACY_BETA_PIN,
): Promise<void> {
  const { plan, notes } = stagedRelease(staging, version, recordSha256);
  const dir = join(staging, version);
  // Again before any upload: the folder may have been staged before this check existed.
  const checking = mkdtempSync(join(tmpdir(), "clawtrate-zip-check-"));
  try {
    const checkZip = zipCheck(runner, checking);
    for (const zip of plan.files.slice(0, 2)) checkZip(join(dir, zip.name));
  } finally {
    rmSync(checking, { recursive: true, force: true });
  }
  if (runner("gh", ["auth", "status"]).status !== 0)
    stop("Sign in to GitHub with `gh auth login`.");
  // Asked of the repository the release goes to, not of this checkout's
  // `origin`, which can be a fork or a stale copy. A commit GitHub does not
  // know there answers 404 and is refused.
  const compared = runner("gh", [
    "api",
    `repos/${REPOSITORY}/compare/${plan.commit}...main`,
    "--jq",
    ".status",
  ]);
  const status = compared.stdout.trim();
  if (compared.status !== 0 || !["ahead", "identical"].includes(status))
    stop(
      compared.status === 0
        ? `${plan.commit} is not on ${REPOSITORY}'s main (${status}). Publish only a commit that has merged.`
        : `Could not compare ${plan.commit} with ${REPOSITORY}'s main on GitHub. Nothing was published.`,
    );
  const releases = githubReleases(runner);
  const tags = githubTags(runner, releases);
  if (tags.includes(plan.tag)) stop(`${plan.tag} already exists on GitHub.`);
  requireNewest(version, tags);
  requireSameSigner(runner, releases, plan.tag, plan.teamId);
  await requireSiteReady(net, releases, pin);

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
      // The notes checked above, as text: not the file, which could change after the check.
      "--notes",
      notes,
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
  if (!sameText(draft.body, notes))
    stop(`The draft's notes are not the checked notes. ${leftDraft}`);
  console.log(
    `The draft ${plan.tag} holds the ${plan.files.length} prepared files, by digest, and the checked notes.`,
  );
  const flipped =
    runner("gh", [
      "release",
      "edit",
      plan.tag,
      "--repo",
      REPOSITORY,
      "--draft=false",
      "--prerelease",
    ]).status === 0;
  // The command's status alone is not GitHub's state: read it back.
  const after = readBack(runner, plan.tag);
  if (after === null)
    stop(
      `GitHub ${flipped ? "accepted" : "refused"} publishing ${plan.tag}, and the release could not be read back: whether it is public is unconfirmed. Check it on GitHub.`,
    );
  if (!after || after.draft)
    stop(
      `GitHub lists ${plan.tag} as ${after ? "a draft" : "absent"}${flipped ? " although it accepted publishing it" : ""}. It was not published.`,
    );
  if (!flipped)
    console.log(`Publishing reported a failure, but GitHub lists ${plan.tag} as public.`);
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
  // Only now, with GitHub listing it public and every file as prepared.
  dispatchSite(runner);
  // The feed as recorded and published, not the staging file read again.
  const feed = plan.files.find((file) => file.name === FEED_NAME)!;
  console.log(`Waiting for ${BETA_FEED_URL} to offer ${version}…`);
  const isPrepared = (reading: SiteReading) =>
    reading.kind === "feed" &&
    reading.body.length === feed.size &&
    sha("sha512", reading.body, "base64") === feed.sha512;
  const seen = await watchSite(net, isPrepared);
  if (!seen.done)
    stop(
      `The site does not serve the new feed yet (${describe(seen.reading)}). Look at the Site workflow's run on main, then check ${BETA_FEED_URL}.`,
    );
  console.log(`The Beta feed offers ${version}.`);
  await watchLegacy(runner, net, pin, isPrepared);
}

/**
 * Before anything is published: both Beta feed addresses already serve a Beta
 * feed, the legacy one the same beta as the new one, or the pinned beta while
 * it is pinned. This beta's build reads only the new address, so publishing it
 * while the site doesn't serve that address would leave its copies with no feed,
 * and a release once public can't be published again.
 */
async function requireSiteReady(
  net: Net,
  releases: readonly ReleaseRow[],
  pin: string | null,
): Promise<void> {
  const fix = `Run the Site workflow on main (gh workflow run site.yml --repo ${REPOSITORY} --ref main), wait for it to finish, and publish again. Nothing was published.`;
  // Only before the first beta may neither address serve a feed.
  const first = newestBeta(releases) === null;
  const current = await readSite(net);
  if (current.kind !== "feed" && !(first && current.kind === "absent"))
    stop(`${BETA_FEED_URL} does not serve a Beta feed (${describe(current)}). ${fix}`);
  // The pinned beta's own feed.json, by GitHub's digest of it, checked before anything
  // is created: a cached feed of the right version is not enough.
  const digest = pin === null ? null : pinnedFeedDigest(releases, pin);
  if (pin !== null && !digest)
    stop(
      `The legacy Beta feed is pinned to ${pin}, which GitHub doesn't list as a published beta with its four files and a digest of its ${FEED_NAME}, as the site requires. Nothing was published.`,
    );
  const legacy = await readSite(net, net.requestMs, LEGACY_BETA_FEED_URL);
  const wanted = pin ?? (current.kind === "feed" ? current.version : null);
  const served =
    wanted === null
      ? legacy.kind === "absent"
      : legacy.kind === "feed" &&
        legacy.version === wanted &&
        (digest === null || `sha256:${sha("sha256", legacy.body, "hex")}` === digest);
  if (!served)
    stop(
      `${LEGACY_BETA_FEED_URL} does not serve ${wanted === null ? "what the new address serves" : `the feed of ${wanted}`} (${describe(legacy)}). ${fix}`,
    );
}

/** GitHub's digest of the pinned beta's feed.json, when that beta is published and has one. */
function pinnedFeedDigest(releases: readonly ReleaseRow[], pin: string): string | null {
  // The site's own rule (pinnedBeta): a published prerelease with its four files.
  const row = pinnedBeta(releases, pin);
  return row?.assets.find((asset) => asset.name === FEED_NAME)?.digest ?? null;
}

/**
 * After the Beta feed's address serves what it should: waits for the legacy
 * address, which betas published before it read, to serve what the Site
 * workflow puts there. That is the pinned beta's own feed.json, by GitHub's
 * digest of it, while the legacy feed is pinned, and otherwise what `same`
 * accepted at the new address.
 */
async function watchLegacy(
  runner: Run,
  net: Net,
  pin: string | null,
  same: (reading: SiteReading) => boolean,
): Promise<void> {
  let accept = same;
  let what = `what ${BETA_FEED_URL} serves`;
  if (pin !== null) {
    const digest = pinnedFeedDigest(githubReleases(runner), pin);
    if (!digest)
      stop(
        `The legacy Beta feed is pinned to ${pin}, which GitHub doesn't list as a published beta with its four files and a digest of its ${FEED_NAME}, as the site requires. Check ${LEGACY_BETA_FEED_URL} yourself.`,
      );
    accept = (reading) =>
      reading.kind === "feed" && `sha256:${sha("sha256", reading.body, "hex")}` === digest;
    what = `the feed of ${pin}`;
  }
  const seen = await watchSite(net, accept, LEGACY_BETA_FEED_URL);
  if (!seen.done)
    stop(
      `The site does not serve ${what} at ${LEGACY_BETA_FEED_URL} yet (${describe(seen.reading)}). Look at the Site workflow's run on main, then check it.`,
    );
  console.log(
    seen.reading.kind === "feed"
      ? `The legacy Beta feed offers ${seen.reading.version}.`
      : "The legacy Beta feed serves no feed either.",
  );
}

/**
 * Starts the Site workflow on main, the only ref its github-pages environment
 * deploys from (.github/workflows/site.yml says why). Release events do not
 * start it, so the commands that change a release do, once GitHub lists the
 * release's new state.
 */
export function dispatchSite(runner: Run): void {
  const started = runner("gh", [
    "workflow",
    "run",
    "site.yml",
    "--repo",
    REPOSITORY,
    "--ref",
    "main",
  ]);
  if (started.status !== 0)
    stop(
      `Could not start the Site workflow. Start it on main (gh workflow run site.yml --repo ${REPOSITORY} --ref main) signed in with Actions write access, which starting a workflow needs, then check ${BETA_FEED_URL}.`,
    );
  console.log("Started the Site workflow on main.");
}

function describe(reading: SiteReading): string {
  if (reading.kind === "feed") return `it offers ${reading.version}`;
  if (reading.kind === "absent") return "it answers 404";
  return `inconclusive: ${reading.reason}`;
}

export async function withdraw(
  runner: Run,
  version: string,
  net: Net = NET,
  pin: string | null = LEGACY_BETA_PIN,
): Promise<void> {
  const tag = tagOf(version);
  // Betas published before the new feed address reach the others through it.
  if (version === pin)
    stop(
      `${version} is the beta the legacy Beta feed is pinned to, so it is never withdrawn: copies from before ${BETA_FEED_URL} update through it. Nothing was changed.`,
    );
  const edited =
    runner("gh", ["release", "edit", tag, "--repo", REPOSITORY, "--draft=true"], { inherit: true })
      .status === 0;
  // The command's status alone is not GitHub's state: read it back.
  let releases: ReleaseRow[];
  try {
    releases = githubReleases(runner);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    stop(
      `GitHub ${edited ? "accepted" : "refused"} turning ${tag} into a draft, and the release could not be read back: whether it is still public is unconfirmed. Check it on GitHub.`,
    );
  }
  const row = releases.find((each) => each.tag_name === tag);
  if (!row) stop(`GitHub no longer lists ${tag}.`);
  if (!row.draft)
    stop(
      `GitHub still lists ${tag} as published${edited ? " although it accepted the change" : ""}.`,
    );
  console.log(
    `GitHub lists ${tag} as a draft. Its download addresses can still answer from caches for a while.`,
  );
  dispatchSite(runner);
  // A run that checked the tag before the edit can still deploy the withdrawn feed.
  // A rerun keeps its original run id, so check every page for unfinished main runs.
  const deadline = Date.now() + net.waitMs;
  const inconclusive = `Could not confirm in time whether the Site workflow's runs on main finished. Look at them, then check ${BETA_FEED_URL}.`;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) stop(inconclusive);
    const runs = runner(
      "gh",
      [
        "api",
        `repos/${REPOSITORY}/actions/workflows/site.yml/runs?per_page=100`,
        "--paginate",
        "--jq",
        '.workflow_runs[] | select(.head_branch == "main" and .status != "completed") | .id',
      ],
      { timeout: remaining },
    );
    if (Date.now() >= deadline) stop(inconclusive);
    if (runs.status !== 0)
      stop(
        `Could not read the Site workflow's runs on main from GitHub. Wait for them to finish, then check ${BETA_FEED_URL}.`,
      );
    if (!runs.stdout.trim()) break;
    if (Date.now() + net.pollMs > deadline)
      stop(
        `The Site workflow's runs on main have not finished. Look at them, then check ${BETA_FEED_URL}.`,
      );
    await new Promise((resolve) => setTimeout(resolve, net.pollMs));
  }
  // A beta published during the wait changes what the Site workflow deploys.
  releases = githubReleases(runner);
  // What the site should serve now, by the rule the Site workflow uses.
  const next = newestBeta(releases);
  console.log(
    `Waiting for ${BETA_FEED_URL} to ${next ? `offer ${next.tag_name.slice(1)}` : "serve no feed"}…`,
  );
  // The remaining beta's own feed.json, by GitHub's digest of it, or, with
  // none, a 404 at the feed's own address.
  const expected = next ? next.tag_name.slice(1) : null;
  const digest = next?.assets.find((asset) => asset.name === FEED_NAME)?.digest;
  if (next && !digest)
    stop(
      `GitHub reports no digest for ${next.tag_name}'s ${FEED_NAME}, so the site's feed cannot be checked against it. Check ${BETA_FEED_URL} yourself.`,
    );
  const isNextFeed = (reading: SiteReading) =>
    reading.kind === "feed" && `sha256:${sha("sha256", reading.body, "hex")}` === digest;
  const seen = await watchSite(net, (reading) =>
    expected ? isNextFeed(reading) : reading.kind === "absent",
  );
  const { reading } = seen;
  if (seen.done) {
    console.log(
      reading.kind === "feed"
        ? `The Beta feed offers ${reading.version}.`
        : "The site serves no Beta feed, and GitHub lists no published beta.",
    );
    await watchLegacy(runner, net, pin, (legacy) =>
      expected ? isNextFeed(legacy) : legacy.kind === "absent",
    );
    return;
  }
  if (reading.kind === "feed" && !expected)
    // With no published beta the Site workflow deploys nothing: running it again changes nothing.
    stop(
      `The site still offers ${reading.version}, and GitHub lists no published beta, so the Site workflow deploys nothing and the site keeps that feed. Cut a fixed beta, or unpublish the Pages site in the repository's settings until there is one (docs/development/releases.md, "Withdraw a beta").`,
    );
  if (reading.kind === "feed")
    stop(
      reading.version === version
        ? `The site still offers ${version}. Run the Site workflow on main and run this again.`
        : reading.version === expected
          ? `The site offers ${expected}, but not the ${FEED_NAME} of its release. Run the Site workflow on main and run this again.`
          : `The site offers ${reading.version}, not ${expected}. Run the Site workflow on main and run this again.`,
    );
  if (reading.kind === "absent")
    stop(
      `The site serves no Beta feed, though GitHub lists ${next!.tag_name} as published. Run the Site workflow on main.`,
    );
  stop(`Could not tell what the site serves (${reading.reason}). Check ${BETA_FEED_URL} yourself.`);
}

export async function main(
  argv: string[],
  runner: Run = run,
  platform: NodeJS.Platform = process.platform,
  places: Places = PLACES(),
): Promise<number> {
  const [flag, version, record, extra] = argv;
  try {
    if (flag === undefined) {
      if (platform !== "darwin") stop("A Mac beta is built on macOS.");
      // The real build only with the real tools: stand-ins run their own.
      await prepare(
        runner,
        new Date(),
        places,
        runner === run ? startBuild : blockingBuild(runner),
      );
    } else if (flag === "--publish" && version && record && !extra) {
      if (!parseVersion(version)) stop(`${version} is not a version.`);
      if (!/^[0-9a-f]{64}$/.test(record))
        stop(`${record} is not the release.json SHA-256 that preparation printed.`);
      await publish(runner, version, record);
    } else if (flag === "--withdraw" && version && !record) {
      if (!parseVersion(version)) stop(`${version} is not a version.`);
      await withdraw(runner, version);
    } else {
      console.error(
        "usage: pnpm release:beta [--publish <version> <release.json sha256> | --withdraw <version>]",
      );
      return 2;
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Stop ? error.message : error);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
