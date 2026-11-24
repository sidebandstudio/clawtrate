// The beta release script without a signing identity: every outside tool
// (the vault, git, gh, security, notarytool, the build, ditto, codesign,
// spctl, stapler, the site) is a stand-in, so these checks show what the
// script does with their answers, which process is given each secret, and
// what reaches the output, the staging folder or a leftover file.

import { createPackage } from "@electron/asar";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { RESERVATION_FILE } from "../packaging/reservation.ts";
import { OUTPUT_VARIABLE, packageOutput } from "../packaging/output.ts";
import { builderConfig } from "../packaging/config.ts";
import { basename, dirname, join } from "node:path";
import type * as Fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Two calls a test can make fail, to show what a setup step that fails
// partway leaves; every other call is the real one.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    mkdtempSync: vi.fn(actual.mkdtempSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});
const realFs = await vi.importActual<typeof Fs>("node:fs");
import {
  buildEnvironment,
  main,
  nextRun,
  NOTARY_PROFILE,
  p12Bytes,
  p8Text,
  LOCKS_FOLDER,
  prepare,
  releaseStateFolder,
  publish,
  takeReleaseLock,
  readSecrets,
  readSignature,
  releaseNotes,
  run,
  SECRET_NAMES,
  SECURITY,
  XCRUN,
  signingKeychain,
  stagedRelease,
  Stop,
  verifyApp,
  withdraw,
  zipCheck,
  type Net,
  type Places,
  type Run,
  type RunResult,
  type Secrets,
} from "../packaging/release-beta.ts";
import { signingPlan, signingProblems } from "../packaging/signing.ts";
import { parseFeed } from "../src/main/update/feed.ts";
import {
  BETA_FEED_URL,
  LEGACY_BETA_FEED_URL,
  checkBetaFiles,
  makeLatestMac,
  releaseFolder,
} from "../packaging/beta-files.ts";
import { makeFeed } from "../packaging/feed.ts";
import type { ReleaseRow } from "../packaging/site-feed.ts";

// A made-up key; its label is joined here so no line reads like a real one.
const LABEL = ["PRIVATE", "KEY"].join(" ");
const KEY = [
  `-----BEGIN ${LABEL}-----`,
  "MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgmadeupmadeupmadeup",
  "madeupmadeupmadeupmadeupmadeupmadeupmadeupmadeupmadeupmadeupmade",
  `-----END ${LABEL}-----`,
].join("\n");
const SECRETS: Secrets = {
  APPLE_CLAWTRATE_DEVELOPER_ID_P12_BASE64: Buffer.from("made-up certificate bytes").toString(
    "base64",
  ),
  APPLE_CLAWTRATE_DEVELOPER_ID_P12_PASSWORD: 'p"w\\d',
  APPLE_CLAWTRATE_NOTARY_API_KEY_P8: KEY,
  APPLE_CLAWTRATE_NOTARY_API_KEY_ID: "KEYID12345",
  APPLE_CLAWTRATE_NOTARY_ISSUER_ID: "00000000-made-up0-issuer-000000000000",
};
/** Each secret as a process could be handed it. */
const SECRET_TEXTS = [
  ...Object.values(SECRETS),
  ...KEY.split("\n").slice(1, 3),
  SECRETS.APPLE_CLAWTRATE_NOTARY_ISSUER_ID,
];
const TEAM = "TEAMID1234";
const IDENTITY = "0123456789ABCDEF0123456789ABCDEF01234567";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ok = (stdout = "", stderr = ""): RunResult => ({ status: 0, stdout, stderr });
const fail = (stderr = "", stdout = ""): RunResult => ({ status: 1, stdout, stderr });

/** The vault answers as `fleet secret get` does: the value and a newline. */
function vault(secrets: Partial<Secrets>): Run {
  return (command, args) =>
    command === "fleet" && secrets[args[2] as keyof Secrets] !== undefined
      ? ok(`${secrets[args[2] as keyof Secrets]}\n`)
      : fail("not found");
}

let output: string[];
beforeEach(() => {
  output = [];
  for (const stream of ["log", "error"] as const)
    vi.spyOn(console, stream).mockImplementation((text) => void output.push(String(text)));
});
afterEach(() => vi.restoreAllMocks());

/** The message of the Stop a call throws. */
async function stopped(call: () => unknown): Promise<string> {
  try {
    await call();
  } catch (error) {
    expect(error).toBeInstanceOf(Stop);
    return (error as Error).message;
  }
  throw new Error("it did not stop");
}

describe("reading the vault", () => {
  it("reads each name with `fleet secret get <NAME> --scope personal`", () => {
    const calls: string[][] = [];
    const runner: Run = (command, args) => {
      calls.push([command, ...args]);
      return vault(SECRETS)(command, args);
    };
    expect(readSecrets(runner)).toEqual({ ok: true, secrets: SECRETS });
    expect(calls).toEqual(
      SECRET_NAMES.map((name) => ["fleet", "secret", "get", name, "--scope", "personal"]),
    );
  });

  it("names every missing secret, and counts a blank one as missing", () => {
    const partial: Partial<Secrets> = { ...SECRETS };
    delete partial.APPLE_CLAWTRATE_NOTARY_API_KEY_P8;
    partial.APPLE_CLAWTRATE_NOTARY_ISSUER_ID = "  ";
    expect(readSecrets(vault(partial))).toEqual({
      ok: false,
      missing: ["APPLE_CLAWTRATE_NOTARY_API_KEY_P8", "APPLE_CLAWTRATE_NOTARY_ISSUER_ID"],
    });
  });

  it("stops before building anything, naming only the missing secrets", async () => {
    const calls: string[] = [];
    const partial = { ...SECRETS } as Partial<Secrets>;
    delete partial.APPLE_CLAWTRATE_DEVELOPER_ID_P12_BASE64;
    // The test's own folders: main never looks in this machine's temporary folder for it.
    const place = places();
    const dead = join(place.state, "clawtrate-signing-Ghi789");
    mkdirSync(dead);
    writeFileSync(join(dead, "pid"), "99999999");
    let code: number;
    try {
      code = await main(
        [],
        (command, args) => {
          calls.push(command);
          return vault(partial)(command, args);
        },
        "darwin",
        place,
      );
      expect(readdirSync(place.state).filter((name) => name !== LOCKS_FOLDER)).toEqual([]);
    } finally {
      rmSync(place.root, { recursive: true, force: true });
    }
    expect(output.join("\n")).toContain(`Removed ${dead}`);
    expect(code).toBe(1);
    expect(calls.every((command) => command === "fleet")).toBe(true);
    expect(output.join("\n")).toContain(
      "The vault has no value for APPLE_CLAWTRATE_DEVELOPER_ID_P12_BASE64.",
    );
    for (const value of Object.values(partial)) expect(output.join("\n")).not.toContain(value);
  });
});

describe("where a beta is built", () => {
  it("prepares only on macOS, refusing elsewhere before reading anything", async () => {
    const calls: string[] = [];
    const code = await main(
      [],
      (command) => {
        calls.push(command);
        return fail();
      },
      "linux",
    );
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(output).toEqual(["A Mac beta is built on macOS."]);
  });
});

describe("the secrets' forms", () => {
  it("reads the certificate as base64 only", () => {
    expect(p12Bytes(SECRETS.APPLE_CLAWTRATE_DEVELOPER_ID_P12_BASE64)?.toString()).toBe(
      "made-up certificate bytes",
    );
    expect(p12Bytes("bWFkZS11cA==\n")?.toString()).toBe("made-up");
    for (const bad of ["", "not base64!", "abc"]) expect(p12Bytes(bad)).toBeNull();
  });

  it("reads the notary key as PEM text or as the base64 of it", () => {
    expect(p8Text(KEY)).toBe(`${KEY}\n`);
    expect(p8Text(Buffer.from(KEY).toString("base64"))).toBe(`${KEY}\n`);
    expect(p8Text("just text")).toBeNull();
    expect(p8Text(Buffer.from("just text").toString("base64"))).toBeNull();
  });
});

interface Call {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv | undefined;
  input?: string | undefined;
  files?: string[];
}

/**
 * `security` and `notarytool` as they answer for a good certificate and key.
 * Each call is recorded with the files then in `dir`; `security -i` steps are
 * keyed by their command's first word, as in `security -i import`.
 */
/**
 * A stand-in for the user's keychain search list, never this machine's own: a
 * path with spaces shows that nothing splits it.
 */
const SEARCH_LIST = ["/Volumes/Keys/login.keychain-db", "/Volumes/Keys/Work Keys.keychain-db"];

/** `security list-keychains -d user` against `list`, which `-s` replaces. */
function listKeychains(list: string[], args: string[]): RunResult | null {
  if (args[0] !== "list-keychains" || args[1] !== "-d" || args[2] !== "user") return null;
  if (args.length === 3) return ok(list.map((path) => `    "${path}"\n`).join(""));
  if (args[3] !== "-s") return fail("unexpected list-keychains");
  list.splice(0, list.length, ...args.slice(4));
  return ok("");
}

function keychainTools(
  calls: Call[],
  overrides: Partial<Record<string, RunResult>> = {},
  dir?: string,
  searchList: string[] = [...SEARCH_LIST],
): Run {
  return (command, args, options) => {
    const files = dir && existsSync(dir) ? readdirSync(dir).sort() : [];
    calls.push({ command, args, env: options?.env, input: options?.input, files });
    const step = args[0] === "-i" ? `-i ${options?.input?.split(" ")[0]}` : args[0];
    const key = `${command.split("/").at(-1)} ${step}`;
    if (overrides[key]) return overrides[key]!;
    const listed = command === SECURITY ? listKeychains(searchList, args) : null;
    if (listed) return listed;
    if (command === SECURITY && args[0] === "-i") return ok("");
    if (command === SECURITY && args[0] === "show-keychain-info")
      return ok("", `Keychain "${args[1]}" lock-on-sleep timeout=3600s\n`);
    if (command === XCRUN && args[0] === "notarytool") return ok("Credentials saved.\n");
    if (command === SECURITY && args[0] === "find-identity")
      return ok(
        `  1) ${IDENTITY} "Developer ID Application: Example (${TEAM})"\n     1 valid identities found\n`,
      );
    return fail(`unexpected ${command}`);
  };
}

describe("the release keychain", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clawtrate-release-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("hands each secret to security or notarytool on its input, one command at a time, never in arguments or environment", () => {
    const calls: Call[] = [];
    const base = { PATH: "/usr/bin", HOME: "/home-of-the-maintainer", NODE_OPTIONS: "--require x" };
    const signing = signingKeychain(keychainTools(calls, {}, dir), SECRETS, dir, base);
    const keychain = join(dir, "release.keychain-db");
    const key = join(dir, "notary.p8");
    expect(signing).toEqual({ keychain, identity: IDENTITY, teamId: TEAM });
    expect(calls.map(({ command, args }) => [command, ...args])).toEqual([
      ...Array.from({ length: 5 }, () => ["/usr/bin/security", "-i"]),
      ["/usr/bin/security", "show-keychain-info", keychain],
      ["/usr/bin/xcrun", "notarytool", "store-credentials", NOTARY_PROFILE, "--keychain", keychain],
      ["/usr/bin/security", "find-identity", "-v", "-p", "codesigning", keychain],
    ]);
    for (const call of calls) {
      const outside = JSON.stringify([call.args, call.env]);
      for (const secret of SECRET_TEXTS) expect(outside).not.toContain(secret);
      expect(call.env).toEqual({ PATH: "/usr/bin", HOME: "/home-of-the-maintainer" });
    }
    // One command per `security -i`, each a single line; its own quoting escapes the quote and backslash.
    const lines = calls.slice(0, 5).map((call) => call.input!);
    for (const line of lines) expect(line.split("\n")).toEqual([expect.any(String), ""]);
    expect(lines[3]).toBe(
      `import "${join(dir, "developer-id.p12")}" -k "${keychain}" -f pkcs12 -P "p\\"w\\\\d" -T /usr/bin/codesign\n`,
    );
    expect(lines.map((line) => line.split(" ")[0])).toEqual([
      "create-keychain",
      "set-keychain-settings",
      "unlock-keychain",
      "import",
      "set-key-partition-list",
    ]);
    expect(calls[6]!.input).toBe(
      `${key}\nKEYID12345\n${SECRETS.APPLE_CLAWTRATE_NOTARY_ISSUER_ID}\n`,
    );
    // The certificate's file exists only up to its import, the key's only for notarytool.
    expect(calls[3]!.files).toEqual(["developer-id.p12"]);
    expect(calls[4]!.files).toEqual([]);
    expect(calls[6]!.files).toEqual(["notary.p8"]);
    expect(calls[7]!.files).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([
    ["security -i create-keychain", "The release keychain's create-keychain step failed."],
    [
      "security -i set-keychain-settings",
      "The release keychain's set-keychain-settings step failed.",
    ],
    ["security -i import", "The release keychain's import step failed."],
    [
      "security -i set-key-partition-list",
      "The release keychain's set-key-partition-list step failed.",
    ],
    ["security show-keychain-info", "does not lock on sleep and after an hour"],
    ["xcrun notarytool", "Apple did not accept the notary API key"],
    ["security find-identity", "no single valid Developer ID Application identity"],
  ])("stops when %s fails, printing none of its input or output", async (tool, message) => {
    const leaked = fail(`bad password ${SECRETS.APPLE_CLAWTRATE_DEVELOPER_ID_P12_PASSWORD}`, KEY);
    const calls: Call[] = [];
    const text = await stopped(() =>
      signingKeychain(keychainTools(calls, { [tool]: leaked }), SECRETS, dir, {}),
    );
    expect(text).toContain(message);
    for (const secret of [...SECRET_TEXTS, dir]) expect(text).not.toContain(secret);
    // It stops at the failing step: nothing after it runs.
    const at = calls.findIndex(
      (call) =>
        `${call.command.split("/").at(-1)} ${call.args[0] === "-i" ? `-i ${call.input!.split(" ")[0]}` : call.args[0]}` ===
        tool,
    );
    expect(at).toBe(calls.length - 1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("stops when the keychain would not lock on sleep or after an hour", async () => {
    const unlocked = ok("", 'Keychain "k" no-timeout\n');
    expect(
      await stopped(() =>
        signingKeychain(
          keychainTools([], { "security show-keychain-info": unlocked }),
          SECRETS,
          dir,
          {},
        ),
      ),
    ).toBe("The release keychain does not lock on sleep and after an hour.");
  });

  it("refuses a password with a line break, which would end security's command, before writing anything", async () => {
    const calls: Call[] = [];
    const text = await stopped(() =>
      signingKeychain(
        keychainTools(calls),
        { ...SECRETS, APPLE_CLAWTRATE_DEVELOPER_ID_P12_PASSWORD: "a\nb" },
        dir,
      ),
    );
    expect(text).toBe("APPLE_CLAWTRATE_DEVELOPER_ID_P12_PASSWORD has a line break.");
    expect(calls).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a key id that is not Apple's form, before writing anything", async () => {
    expect(
      await stopped(() =>
        signingKeychain(
          keychainTools([]),
          { ...SECRETS, APPLE_CLAWTRATE_NOTARY_API_KEY_ID: "short" },
          dir,
        ),
      ),
    ).toBe("APPLE_CLAWTRATE_NOTARY_API_KEY_ID is not ten letters or digits.");
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("the build's environment", () => {
  it("keeps only ordinary variables, and names the keychain, identity and profile", () => {
    const signing = {
      keychain: "/private/k/release.keychain-db",
      identity: IDENTITY,
      teamId: TEAM,
    };
    const env = buildEnvironment(
      {
        PATH: "/usr/bin",
        HOME: "/home-of-the-maintainer",
        TMPDIR: "/var/folders/x/",
        CSC_LINK: "/elsewhere.p12",
        CSC_KEY_PASSWORD: "inherited",
        WIN_CSC_LINK: "/elsewhere.pfx",
        APPLE_ID: "someone",
        APPLE_API_KEY: "/elsewhere.p8",
        CLAWTRATE_UPDATE_FEED_URL: "https://elsewhere.example/feed.json",
        NODE_OPTIONS: "--require /elsewhere.js",
        GH_TOKEN: "made-up",
        SOURCE_DATE_EPOCH: "1",
      },
      signing,
      1_790_000_000,
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home-of-the-maintainer",
      TMPDIR: "/var/folders/x/",
      CSC_KEYCHAIN: signing.keychain,
      CSC_NAME: IDENTITY,
      APPLE_KEYCHAIN: signing.keychain,
      APPLE_KEYCHAIN_PROFILE: NOTARY_PROFILE,
      CLAWTRATE_NIGHTLY_UPDATE_FEED_URL: BETA_FEED_URL,
      SOURCE_DATE_EPOCH: "1790000000",
    });
    // F-559: a beta reads the new folder alone; the legacy one is only for earlier betas.
    expect(env.CLAWTRATE_NIGHTLY_UPDATE_FEED_URL).toBe(
      "https://clawtrate.dev/updates/channel/beta/feed.json",
    );
    expect(Object.values(env)).not.toContain(LEGACY_BETA_FEED_URL);
    expect(signingPlan(env)).toEqual({
      mac: "developer-id",
      notarize: "keychain-profile",
      windows: "unsigned",
    });
    expect(signingProblems(env, "mac")).toEqual([]);
  });
});

describe("versions", () => {
  it("takes the next run number of the day that no tag has used", () => {
    expect(nextRun([], "0.1.1", "20261120")).toBe(1);
    expect(
      nextRun(
        ["v0.1.1-beta.20261120.1", "v0.1.1-beta.20261120.3", "v0.1.1-beta.20261119.9", "v0.1.0"],
        "0.1.1",
        "20261120",
      ),
    ).toBe(4);
  });

  it("counts only whole beta tags, not one whose run Number() would still read", () => {
    expect(nextRun(["v0.1.1-beta.20261120.1e12"], "0.1.1", "20261120")).toBe(1);
    expect(
      nextRun(["v0.1.1-beta.20261120.1e12", "v0.1.1-beta.20261120.3"], "0.1.1", "20261120"),
    ).toBe(4);
  });
});

/** codesign, spctl and stapler as they answer for a notarized, stapled Developer ID app. */
function macTools(version: () => string, overrides: Record<string, RunResult> = {}): Run {
  return (command, args) => {
    const key = `${command} ${args[0]}`;
    if (overrides[key]) return overrides[key]!;
    const app = args.at(-1)!;
    if (command === "plutil")
      return ok(args[1] === "CFBundleIdentifier" ? "dev.clawtrate.desktop\n" : `${version()}\n`);
    if (command === "lipo") return ok(app.includes("mac-x64") ? "x86_64\n" : "arm64\n");
    if (command === "codesign" && args[0] === "--verify") return ok();
    if (command === "codesign")
      return ok(
        "",
        `Executable=${app}/Contents/MacOS/Clawtrate\nIdentifier=dev.clawtrate.desktop\nAuthority=Developer ID Application: Example (${TEAM})\nAuthority=Developer ID Certification Authority\nTeamIdentifier=${TEAM}\n`,
      );
    if (command === "spctl") return ok("", `${app}: accepted\nsource=Notarized Developer ID\n`);
    if (command === "xcrun") return ok("The validate action worked!\n");
    return fail(`unexpected ${command}`);
  };
}

describe("checking an app as it ships", () => {
  const app = "/stage/verify-mac-arm64/Clawtrate.app";
  const expected = { version: "0.1.1-beta.20261120.1", arch: "arm64" as const };
  const tools = (overrides: Record<string, RunResult> = {}) =>
    macTools(() => expected.version, overrides);

  it("reads the team from the signature", () => {
    expect(verifyApp(tools(), app, expected)).toEqual({ teamId: TEAM });
    expect(readSignature("Identifier=a\nTeamIdentifier=not set\n")).toEqual({
      identifier: "a",
      teamId: "not set",
      authority: null,
    });
  });

  it.each([
    [
      "codesign --verify",
      fail("a sealed resource is missing"),
      "codesign --verify --deep --strict",
    ],
    ["spctl --assess", fail("rejected"), "spctl --assess --type execute"],
    ["spctl --assess", ok("", "accepted\nsource=Developer ID\n"), "notarized Developer ID"],
    ["xcrun stapler", fail("does not have a ticket stapled"), "xcrun stapler validate"],
    ["lipo -archs", ok("x86_64\n"), "architecture arm64"],
    [
      "codesign --display",
      ok(
        "",
        "Identifier=dev.clawtrate.desktop\nAuthority=Apple Development: x\nTeamIdentifier=TEAMID1234\n",
      ),
      "Developer ID Application signature",
    ],
    [
      "codesign --display",
      ok("", "Identifier=dev.clawtrate.desktop\nSignature=adhoc\n"),
      "Developer ID Application signature",
    ],
  ])("refuses when %s answers otherwise", (tool, answer, check) => {
    expect(() => verifyApp(tools({ [tool]: answer }), app, expected)).toThrow(check);
  });

  it.each([
    ["plutil -extract", fail("", "dev.clawtrate.desktop\n"), "plutil CFBundleIdentifier"],
    ["lipo -archs", fail("", "arm64\n"), "lipo -archs"],
    [
      "codesign --display",
      fail(
        `Identifier=dev.clawtrate.desktop\nAuthority=Developer ID Application: Example (${TEAM})\nTeamIdentifier=${TEAM}\n`,
      ),
      "codesign --display",
    ],
    ["spctl --assess", fail("source=Notarized Developer ID\n"), "spctl --assess --type execute"],
  ])("refuses when %s fails even with the expected output", (tool, answer, check) => {
    expect(() => verifyApp(tools({ [tool]: answer }), app, expected)).toThrow(`${check} failed.`);
  });

  it("refuses another bundle id or version", () => {
    expect(() =>
      verifyApp(
        macTools(() => "0.1.0"),
        app,
        expected,
      ),
    ).toThrow(`version ${expected.version}`);
  });
});

/** The beta these tests prepare: the remote has run 1 of the day. */
/** An app.asar whose main bundle names `feed` as its Beta feed, as a beta build's does. */
async function compiledAsar(feed: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-asar-"));
  mkdirSync(join(dir, "app", "out", "main"), { recursive: true });
  writeFileSync(
    join(dir, "app", "out", "main", "index.js"),
    `const BUILD_NIGHTLY_FEED_ADDRESS = ${JSON.stringify(feed)};\n`,
  );
  await createPackage(join(dir, "app"), join(dir, "app.asar"));
  return join(dir, "app.asar");
}
const BUILT_ASAR = await compiledAsar(BETA_FEED_URL);

const VERSION = "0.1.1-beta.20261120.2";
const TAG = `v${VERSION}`;
const NOW = new Date("2026-11-20T18:00:00Z");
const ZIPS = [`Clawtrate-${VERSION}-mac-arm64.zip`, `Clawtrate-${VERSION}-mac-x64.zip`];
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** A run's own folders: the staging folder, the app and the temporary folder. */
function places(): Places & { root: string } {
  const root = mkdtempSync(join(tmpdir(), "clawtrate-release-test-"));
  const appDir = join(root, "app");
  mkdirSync(appDir, { recursive: true });
  mkdirSync(join(root, "state"), { mode: 0o700 });
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ version: "0.1.0" }));
  return { root, appDir, staging: join(root, "staging"), state: join(root, "state") };
}

/** git, gh, the vault, the keychain tools, candidate-build.ts and the Mac tools. */
function tools(
  build: (out: string, version: string, env: NodeJS.ProcessEnv) => RunResult,
  overrides: Record<string, RunResult> = {},
  /** The app.asar each unpacked app holds. */
  asar = BUILT_ASAR,
) {
  const calls: Call[] = [];
  let current = "";
  const searchList = [...SEARCH_LIST];
  const keychain = keychainTools(calls, {}, undefined, searchList);
  const mac = macTools(() => current, overrides);
  const seen: { env?: NodeJS.ProcessEnv; signingFiles?: string[]; searchList?: string[] } = {};
  const runner: Run = (command, args, options) => {
    if (command === "fleet") return vault(SECRETS)(command, args);
    if (command === SECURITY || command === XCRUN) return keychain(command, args, options);
    calls.push({ command, args, env: options?.env, input: options?.input });
    if (command === "git" && args[0] === "status") return ok("");
    if (command === "git" && args[0] === "rev-parse") return ok(`${COMMIT}\n`);
    if (command === "git" && args[0] === "ls-remote")
      return ok(`${COMMIT}\trefs/tags/v0.1.1-beta.20261120.1\n`);
    if (command === "gh")
      return ok(
        `${JSON.stringify({ tag_name: "v0.1.0-beta.20261101.1", draft: false, prerelease: true, assets: [] })}\n`,
      );
    if (command === process.execPath) {
      current = args[2]!;
      seen.env = options!.env!;
      // What the build could open in the signing folder.
      seen.signingFiles = readdirSync(dirname(options!.env!.CSC_KEYCHAIN!)).sort();
      seen.searchList = [...searchList];
      return build(args[1]!, args[2]!, options!.env!);
    }
    // The update helper's ZIP check that zipCheck builds: it passes every zip.
    if (basename(command) === "check-zip") return overrides["check-zip"] ?? ok("ok\n");
    if (command === "ditto" && overrides[`ditto ${args[0]}`]) return overrides[`ditto ${args[0]}`]!;
    if (command === "ditto") {
      if (args[0] === "-x") {
        const resources = join(args.at(-1)!, "Clawtrate.app", "Contents", "Resources");
        mkdirSync(resources, { recursive: true });
        copyFileSync(asar, join(resources, "app.asar"));
      }
      return ok();
    }
    return mac(command, args, options);
  };
  return { runner, calls, seen, searchList };
}

/** Where the stand-in build writes, as config.ts tells electron-builder: the run's own folder, or dist. */
const builtInto = (appDir: string, env: NodeJS.ProcessEnv = {}) =>
  env[OUTPUT_VARIABLE] ?? join(appDir, "dist");

const builds =
  (appDir: string, signed = "certificate") =>
  (out: string, version: string, env: NodeJS.ProcessEnv = {}): RunResult => {
    // As candidate-build.ts: electron-builder writes its output, and the zips
    // go into the reserved version folder.
    mkdirSync(join(builtInto(appDir, env), "mac-arm64"), { recursive: true });
    mkdirSync(out, { recursive: true });
    for (const key of ["mac-arm64", "mac-x64"]) {
      writeFileSync(join(out, `Clawtrate-${version}-${key}.zip`), `zip of ${key}`);
      writeFileSync(
        join(out, `${key}.json`),
        JSON.stringify({
          commit: COMMIT,
          packagerReadback: signed,
          sha512: createHash("sha512").update(`zip of ${key}`).digest("base64"),
        }),
      );
    }
    return ok();
  };

describe("preparing a beta from start to finish, with stand-ins for every tool", () => {
  let place: ReturnType<typeof places>;
  beforeEach(() => {
    place = places();
  });
  afterEach(() => rmSync(place.root, { recursive: true, force: true }));

  it("stages the zips, the Beta feed and latest-mac.json, and gives the build no secret", async () => {
    const { runner, calls, seen } = tools(builds(place.appDir));
    await prepare(runner, NOW, place);
    const out = join(place.staging, VERSION);
    expect(readdirSync(out).sort()).toEqual([
      ...ZIPS,
      "feed.json",
      "latest-mac.json",
      "notes.md",
      "release.json",
    ]);
    // The signing folder is gone, and so is dist.
    expect(readdirSync(place.state).filter((name) => name !== LOCKS_FOLDER)).toEqual([]);
    expect(existsSync(join(place.appDir, "dist"))).toBe(false);
    const keychain = seen.env!.CSC_KEYCHAIN!;
    const signingDir = dirname(keychain);
    expect(dirname(signingDir)).toBe(place.state);
    expect(basename(signingDir)).toMatch(/^clawtrate-signing-[A-Za-z0-9]{6}$/);
    expect(basename(keychain)).toBe("release.keychain-db");
    expect(seen.env!.CSC_NAME).toBe(IDENTITY);
    // Neither raw credential file exists when the build starts.
    // No credential: the run's pid and the search list it put back afterwards.
    expect(seen.signingFiles).toEqual(["pid", "search-list.json"]);
    // No process saw a secret in its arguments or environment.
    for (const call of calls) {
      const outside = JSON.stringify([call.args, call.env ?? {}]);
      for (const secret of SECRET_TEXTS) expect(outside).not.toContain(secret);
    }

    const download = `https://github.com/sidebandstudio/clawtrate/releases/download/${TAG}/`;
    const feedText = readFileSync(join(out, "feed.json"), "utf8");
    const latestText = readFileSync(join(out, "latest-mac.json"), "utf8");
    expect(checkBetaFiles(TAG, feedText, latestText)).toEqual({
      feed: feedText,
      latest: latestText,
    });
    expect(
      parseFeed(feedText, new URL(BETA_FEED_URL), "mac-x64", undefined, "nightly"),
    ).toMatchObject({ ok: true });
    expect(JSON.parse(latestText)).toEqual({
      teamIdentifier: TEAM,
      arm64: { version: VERSION, url: `${download}${ZIPS[0]}`, sha256: sha256("zip of mac-arm64") },
      x86_64: { version: VERSION, url: `${download}${ZIPS[1]}`, sha256: sha256("zip of mac-x64") },
    });
    expect(JSON.parse(feedText)).toMatchObject({
      track: "nightly",
      version: VERSION,
      releaseDate: "2026-11-20T18:00:00.000Z",
      // F-559: the address both apps were checked to read.
      buildFeed: BETA_FEED_URL,
    });
    const record = sha256(readFileSync(join(out, "release.json")));
    expect(stagedRelease(place.staging, VERSION, record).plan).toMatchObject({
      version: VERSION,
      tag: TAG,
      commit: COMMIT,
      teamId: TEAM,
    });
    expect(output).toContain(`  release.json  sha256 ${record}`);
    expect(output.join("\n")).toContain(`pnpm release:beta --publish ${VERSION} ${record}`);
    const everything = [
      output.join("\n"),
      ...readdirSync(out).map((name) => readFileSync(join(out, name), "utf8")),
    ].join("\n");
    for (const secret of SECRET_TEXTS) expect(everything).not.toContain(secret);
  });

  const unread = `is not built to read ${BETA_FEED_URL} alone.`;
  it.each<[string, () => Promise<string>, string]>([
    ["the legacy feed address", () => compiledAsar(LEGACY_BETA_FEED_URL), unread],
    [
      "both feed addresses",
      () => compiledAsar(`${BETA_FEED_URL}" "${LEGACY_BETA_FEED_URL}`),
      unread,
    ],
    [
      "no main bundle",
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "clawtrate-asar-"));
        mkdirSync(join(dir, "app"));
        writeFileSync(join(dir, "app", "package.json"), "{}");
        await createPackage(join(dir, "app"), join(dir, "app.asar"));
        return join(dir, "app.asar");
      },
      ": its main bundle could not be read from app.asar.",
    ],
  ])("F-559: stages nothing from an app built with %s", async (_case, asar, ending) => {
    const { runner } = tools(builds(place.appDir), {}, await asar());
    const text = await stopped(() => prepare(runner, NOW, place));
    expect(text.endsWith(`Clawtrate.app${ending.startsWith(":") ? "" : " "}${ending}`), text).toBe(
      true,
    );
    expect(existsSync(join(place.staging, VERSION, "release.json"))).toBe(false);
  });

  it("prepares with the stand-ins whatever system the tests run on", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      await prepare(tools(builds(place.appDir)).runner, NOW, place);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    expect(existsSync(join(place.staging, VERSION, "release.json"))).toBe(true);
  });

  it("names a failed build's log without printing it, and removes the signing folder", async () => {
    // A temporary folder's name can hold spaces; the whole path is named.
    mkdirSync(join(place.root, "Release Builds"));
    const log = join(place.root, "Release Builds", "pack.log");
    const { runner } = tools(() => {
      writeFileSync(log, "Signing with Developer ID Application: Example (TEAMID1234)\n");
      // As Node prints an uncaught error: the throwing source line comes first.
      return fail(
        [
          "file:///repo/apps/desktop/packaging/candidate-build.ts:68",
          "      throw new Error(`Packaging failed (${reason}). Build log: ${log}`);",
          "            ^",
          "",
          `Error: Packaging failed (exit 1). Build log: ${log}`,
          "    at build (file:///repo/apps/desktop/packaging/candidate-build.ts:68:13)",
        ].join("\n"),
      );
    });
    const text = await stopped(() => prepare(runner, NOW, place));
    expect(text).toBe(`The build failed. Its log is ${log}; keep it private.`);
    expect(output.join("\n")).not.toContain("Signing with");
    expect(readdirSync(place.state).filter((name) => name !== LOCKS_FOLDER)).toEqual([]);
  });

  it("puts the release keychain first on the search list for the build only, then restores the list exactly", async () => {
    const { runner, calls, seen, searchList } = tools(builds(place.appDir));
    await prepare(runner, NOW, place);
    const keychain = seen.env!.CSC_KEYCHAIN!;
    expect(seen.searchList).toEqual([keychain, ...SEARCH_LIST]);
    expect(searchList).toEqual(SEARCH_LIST);
    // The list is set whole, each path one argument, and the default keychain is never touched.
    const sets = calls.filter((call) => call.args[0] === "list-keychains" && call.args[3] === "-s");
    expect(sets.map((call) => call.args.slice(4))).toEqual([
      [keychain, ...SEARCH_LIST],
      SEARCH_LIST,
    ]);
    expect(calls.some((call) => call.args.includes("default-keychain"))).toBe(false);
    expect(output.join("\n")).toContain("Restored the keychain search list.");
  });

  it("restores the search list and removes its build output and partial folder when the build fails, keeping an earlier staged release", async () => {
    const earlier = join(place.staging, "0.1.1-beta.20261119.1");
    mkdirSync(earlier, { recursive: true });
    writeFileSync(join(earlier, "release.json"), "{}");
    let built = "";
    const { runner, seen, searchList } = tools((out, _version, env) => {
      // As the real failure left them: the arm64 app, and an empty version folder.
      built = builtInto(place.appDir, env);
      mkdirSync(join(built, "mac-arm64"), { recursive: true });
      mkdirSync(out, { recursive: true });
      return fail("Error: Packaging failed (exit 1).");
    });
    expect(await stopped(() => prepare(runner, NOW, place))).toContain("The build failed");
    expect(seen.searchList![0]).toBe(seen.env!.CSC_KEYCHAIN);
    expect(searchList).toEqual(SEARCH_LIST);
    expect(existsSync(built)).toBe(false);
    expect(existsSync(join(place.staging, VERSION))).toBe(false);
    expect(readFileSync(join(earlier, "release.json"), "utf8")).toBe("{}");
  });

  it("restores the search list when a step after the keychain fails before the build", async () => {
    const { runner, searchList, calls } = tools(builds(place.appDir));
    // The build cannot start: the list it was given is put back.
    const refusing: Run = (command, args, options) =>
      command === process.execPath
        ? (() => {
            throw new Error("spawn failed");
          })()
        : runner(command, args, options);
    await expect(prepare(refusing, NOW, place)).rejects.toThrow("spawn failed");
    expect(calls.filter((call) => call.args[3] === "-s")).toHaveLength(2);
    expect(searchList).toEqual(SEARCH_LIST);
  });

  it("restores the search list a killed run changed, before anything else, and writes nothing when it cannot tell what to put back", async () => {
    const dead = join(place.state, "clawtrate-signing-Abc123");
    mkdirSync(dead);
    writeFileSync(join(dead, "pid"), "99999999");
    writeFileSync(join(dead, "search-list.json"), JSON.stringify(SEARCH_LIST));
    const { runner, searchList } = tools(builds(place.appDir));
    searchList.unshift(join(dead, "release.keychain-db"));
    // A run the vault refuses still restores it first.
    const refused: Run = (command, args, options) =>
      command === "fleet" ? vault({})(command, args) : runner(command, args, options);
    expect(await stopped(() => prepare(refused, NOW, place))).toContain("The vault has no value");
    expect(searchList).toEqual(SEARCH_LIST);
    expect(output.join("\n")).toContain(
      "Restored the keychain search list that an interrupted release (pid 99999999) changed.",
    );
    expect(readdirSync(place.state).filter((name) => name !== LOCKS_FOLDER)).toEqual([]);

    // Its keychain is gone from the list, which is not its record either:
    // this run cannot tell what to put back, so it writes nothing and keeps the folder.
    mkdirSync(dead);
    writeFileSync(join(dead, "pid"), "99999999");
    writeFileSync(join(dead, "search-list.json"), JSON.stringify(["/elsewhere.keychain-db"]));
    expect(await stopped(() => prepare(refused, NOW, place))).toContain("wrote nothing");
    expect(searchList).toEqual(SEARCH_LIST);
    expect(readdirSync(dead)).toContain("search-list.json");
  });

  it("removes a signing folder a killed run left, before anything else, and refuses while another run signs", async () => {
    const dead = join(place.state, "clawtrate-signing-Abc123");
    mkdirSync(dead);
    writeFileSync(join(dead, "notary.p8"), "left behind");
    // A pid no process has: well above the system's limit.
    writeFileSync(join(dead, "pid"), "99999999");
    const unrelated = join(place.state, "clawtrate-signing-test");
    mkdirSync(unrelated);
    // Even a run the vault refuses clears it first.
    const empty = vault({});
    expect(await stopped(() => prepare(empty, NOW, place))).toContain("The vault has no value");
    expect(readdirSync(place.state).filter((name) => name !== LOCKS_FOLDER)).toEqual([
      "clawtrate-signing-test",
    ]);
    expect(output.join("\n")).toContain(
      `Removed ${dead}, which an interrupted release (pid 99999999) left.`,
    );

    const live = join(place.state, "clawtrate-signing-Def456");
    mkdirSync(live);
    writeFileSync(join(live, "pid"), String(process.ppid));
    expect(await stopped(() => prepare(tools(builds(place.appDir)).runner, NOW, place))).toBe(
      `Another release (pid ${process.ppid}) is signing from ${live}. Let it finish first.`,
    );
    expect(existsSync(live)).toBe(true);
  });

  it("builds nothing while a raw credential file is still in the signing folder", async () => {
    const { runner, calls } = tools(builds(place.appDir));
    // A tool that leaves the key behind: the identity lookup writes it back.
    const leaving: Run = (command, args, options) => {
      if (command === SECURITY && args[0] === "find-identity")
        writeFileSync(join(dirname(args.at(-1)!), "notary.p8"), "left by a tool");
      return runner(command, args, options);
    };
    expect(await stopped(() => prepare(leaving, NOW, place))).toBe(
      "notary.p8 still exists. Nothing was built.",
    );
    expect(calls.some((call) => call.command === process.execPath)).toBe(false);
    expect(readdirSync(place.state).filter((name) => name !== LOCKS_FOLDER)).toEqual([]);
  });

  it("leaves a signing folder with no pid for the maintainer to inspect", async () => {
    const starting = join(place.state, "clawtrate-signing-Ghi789");
    mkdirSync(starting);
    writeFileSync(join(starting, "notary.p8"), "maybe a run that is starting");
    await prepare(tools(builds(place.appDir)).runner, NOW, place);
    expect(readdirSync(place.state).filter((name) => name !== LOCKS_FOLDER)).toEqual([
      "clawtrate-signing-Ghi789",
    ]);
    expect(output.join("\n")).toContain(
      `Left ${starting} alone: it records no pid. If no release is running, remove it yourself.`,
    );
  });

  it("stages and records the copy it verified, not the file the build left", async () => {
    const { runner } = tools(builds(place.appDir));
    const out = join(place.staging, VERSION);
    // Something rewrites the build's zip while the copy is being checked.
    const swapping: Run = (command, args, options) => {
      if (command === "spctl" && existsSync(join(out, ZIPS[0]!)))
        writeFileSync(join(out, ZIPS[0]!), "a different zip");
      return runner(command, args, options);
    };
    await prepare(swapping, NOW, place);
    expect(readFileSync(join(out, ZIPS[0]!), "utf8")).toBe("zip of mac-arm64");
    const record = sha256(readFileSync(join(out, "release.json")));
    expect(stagedRelease(place.staging, VERSION, record).plan.files[0]!.sha256).toBe(
      sha256("zip of mac-arm64"),
    );
  });

  it("checks the zip again after stapling it, and stops when it does not unpack", async () => {
    let stapled = false;
    const { runner } = tools(builds(place.appDir));
    const stapling: Run = (command, args, options) => {
      if (command === "xcrun" && args.join(" ").startsWith("stapler validate") && !stapled)
        return fail("does not have a ticket stapled");
      if (command === "xcrun" && args[0] === "stapler" && args[1] === "staple") {
        stapled = true;
        return ok();
      }
      if (command === "ditto" && args[0] === "-x" && stapled) return fail("damaged archive");
      return runner(command, args, options);
    };
    expect(await stopped(() => prepare(stapling, NOW, place))).toContain("does not unpack.");
  });

  it("refuses a zip that is not the one its build receipt names, before checking the app", async () => {
    const { runner, calls } = tools((out, version) => {
      const result = builds(place.appDir)(out, version);
      // Another build's zip in place of the one the receipt describes.
      writeFileSync(join(out, `Clawtrate-${version}-mac-arm64.zip`), "another zip");
      return result;
    });
    expect(await stopped(() => prepare(runner, NOW, place))).toBe(
      `Clawtrate-${VERSION}-mac-arm64.zip is not the zip its build receipt names.`,
    );
    expect(calls.some((call) => call.command === "ditto")).toBe(false);
  });

  it("refuses an app the packager did not sign with the certificate", async () => {
    const { runner } = tools(builds(place.appDir, "ad hoc"));
    expect(await stopped(() => prepare(runner, NOW, place))).toBe(
      "mac-arm64 was not signed with a certificate by this commit's build.",
    );
  });

  it("builds only from a clean checkout", async () => {
    const { runner } = tools(builds(place.appDir));
    const dirty: Run = (command, args, options) =>
      command === "git" && args[0] === "status" ? ok(" M file\n") : runner(command, args, options);
    expect(await stopped(() => prepare(dirty, NOW, place))).toContain("clean checkout");
  });

  it("checks both zips with the update helper's ZIP check, built from its source", async () => {
    const { runner, calls } = tools(builds(place.appDir));
    await prepare(runner, NOW, place);
    const build = calls.find((call) => call.command === "xcrun" && call.args[0] === "clang")!;
    expect(build.args).toContain(join(import.meta.dirname, "../packaging/mac/check-zip.m"));
    const checker = build.args.at(-1)!;
    expect(dirname(dirname(checker))).toBe(place.state);
    const checked = calls.filter((call) => call.command === checker);
    expect(checked.map((call) => basename(call.args[0]!))).toEqual(ZIPS);
    // The private copies that were verified and then staged.
    for (const call of checked) expect(dirname(call.args[0]!)).toBe(dirname(checker));
  });

  it.each(["mac-arm64", "mac-x64"])(
    "stops before staging anything when the %s zip fails the ZIP check, and exits 1",
    async (key) => {
      const { runner, calls } = tools(builds(place.appDir));
      const checking: Run = (command, args, options) =>
        basename(command) === "check-zip" && args[0]!.endsWith(`-${key}.zip`)
          ? (calls.push({ command, args }), fail("", "an archive comment\n"))
          : runner(command, args, options);
      // As the release job runs it, on today's date.
      expect(await main([], checking, "darwin", place)).toBe(1);
      expect(output.at(-1)).toMatch(
        new RegExp(
          `^Clawtrate-[0-9.]+-beta\\.[0-9.]+-${key}\\.zip would be refused by the Mac updater's ZIP check: an archive comment\\. Nothing was published\\.$`,
        ),
      );
      // Nothing staged for publishing to take.
      expect(readdirSync(place.staging)).toEqual([]);
      // Its one GitHub call is the read of the releases, before the build.
      expect(
        calls.filter((call) => call.command === "gh").map((call) => call.args.slice(0, 2)),
      ).toEqual([["api", "repos/sidebandstudio/clawtrate/releases"]]);
    },
  );

  it("checks the zip it made again after stapling, not the one the build left", async () => {
    let stapled = false;
    const { runner, calls } = tools(builds(place.appDir));
    const stapling: Run = (command, args, options) => {
      if (command === "xcrun" && args.join(" ").startsWith("stapler validate") && !stapled)
        return fail("does not have a ticket stapled");
      if (command === "xcrun" && args[0] === "stapler" && args[1] === "staple") {
        stapled = true;
        return ok();
      }
      if (command === "ditto" && args[0] === "-c") {
        calls.push({ command, args });
        writeFileSync(args.at(-1)!, "stapled zip");
        return ok();
      }
      if (basename(command) === "check-zip") {
        calls.push({ command, args });
        return readFileSync(args[0]!, "utf8") === "stapled zip"
          ? fail("", "a ZIP64 locator\n")
          : ok("ok\n");
      }
      return runner(command, args, options);
    };
    expect(await stopped(() => prepare(stapling, NOW, place))).toBe(
      `${ZIPS[0]} would be refused by the Mac updater's ZIP check: a ZIP64 locator. Nothing was published.`,
    );
    const zipped = calls.findIndex((call) => call.command === "ditto" && call.args[0] === "-c");
    const checked = calls.findIndex((call) => basename(call.command) === "check-zip");
    expect(zipped).toBeGreaterThan(-1);
    expect(checked).toBeGreaterThan(zipped);
  });

  it("takes only the check's own ok as a pass, not a silent exit 0", async () => {
    const { runner } = tools(builds(place.appDir));
    const silent: Run = (command, args, options) =>
      basename(command) === "check-zip" ? ok() : runner(command, args, options);
    expect(await stopped(() => prepare(silent, NOW, place))).toBe(
      `${ZIPS[0]} would be refused by the Mac updater's ZIP check: the check exited 0. Nothing was published.`,
    );
  });

  it.each<[string, RunResult, string]>([
    [
      "times out",
      { status: null, stdout: "", stderr: "", signal: "SIGTERM", error: "ETIMEDOUT" },
      "timed out",
    ],
    [
      "crashes",
      { status: null, stdout: "", stderr: "", signal: "SIGSEGV" },
      "crashed (signal SIGSEGV)",
    ],
  ])("stops, saying so, when the check %s, and gives it a deadline", async (_, answer, said) => {
    const { runner } = tools(builds(place.appDir));
    const deadlines: Record<string, number | undefined> = {};
    const ending: Run = (command, args, options) => {
      if (command === "xcrun" && args[0] === "clang") deadlines.clang = options?.timeout;
      if (basename(command) !== "check-zip") return runner(command, args, options);
      deadlines.check = options?.timeout;
      return answer;
    };
    expect(await stopped(() => prepare(ending, NOW, place))).toBe(
      `${ZIPS[0]} would be refused by the Mac updater's ZIP check: the check ${said}. Nothing was published.`,
    );
    expect(deadlines).toEqual({ clang: 120_000, check: 60_000 });
  });

  it("stops when the ZIP check does not build, before the build, the keychain or notarization", async () => {
    const { runner, calls } = tools(builds(place.appDir));
    const failing: Run = (command, args, options) =>
      command === "xcrun" && args[0] === "clang"
        ? fail("check-zip.m: error: no such file")
        : runner(command, args, options);
    expect(await stopped(() => prepare(failing, NOW, place))).toBe(
      "Could not build the update helper's ZIP check: check-zip.m: error: no such file. Nothing was published.",
    );
    expect(calls.some((call) => [process.execPath, SECURITY, XCRUN].includes(call.command))).toBe(
      false,
    );
  });

  it("names what failed when xcrun cannot start", async () => {
    const { runner } = tools(builds(place.appDir));
    const missing: Run = (command, args, options) =>
      command === "xcrun" && args[0] === "clang"
        ? { status: null, stdout: "", stderr: "", error: "ENOENT" }
        : runner(command, args, options);
    expect(await stopped(() => prepare(missing, NOW, place))).toBe(
      "Could not build the update helper's ZIP check: xcrun clang could not start (ENOENT). Nothing was published.",
    );
  });
});

describe("how a run ends", () => {
  it("reports a timeout and a command that cannot start, which the ZIP check's messages name", () => {
    expect(run("/bin/sleep", ["5"], { timeout: 200 })).toMatchObject({
      status: null,
      signal: "SIGTERM",
      error: "ETIMEDOUT",
    });
    expect(run(join(tmpdir(), "clawtrate-no-such-tool"), [])).toMatchObject({
      status: null,
      error: "ENOENT",
    });
  });
});

// The ZIP check as the release builds and runs it, on zips made by macOS's own tools.
describe.skipIf(process.platform !== "darwin")("the update helper's ZIP check, for real", () => {
  let dir: string, check: (zip: string) => void;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "clawtrate-zip-check-"));
    check = zipCheck(run, dir);
    mkdirSync(join(dir, "Clawtrate.app", "Contents"), { recursive: true });
    writeFileSync(join(dir, "Clawtrate.app", "Contents", "a.txt"), "hello hello hello\n");
  }, 60000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const make = (name: string, command: string) => {
    expect(spawnSync("/bin/sh", ["-c", command], { cwd: dir }).status).toBe(0);
    return join(dir, name);
  };
  const ditto = (name: string) => make(name, `ditto -c -k --keepParent Clawtrate.app ${name}`);

  it.each([
    ["a ditto zip", () => ditto("plain.zip")],
    [
      "the re-stapled zip, extended attributes in __MACOSX",
      () =>
        make(
          "sequester.zip",
          "xattr -w dev.clawtrate.test 1 Clawtrate.app/Contents/a.txt && ditto -c -k --sequesterRsrc --keepParent Clawtrate.app sequester.zip",
        ),
    ],
  ])("passes %s", (_, zip) => {
    expect(() => check(zip())).not.toThrow();
  });

  it.each([
    [
      "a zip -z comment",
      () => make("comment.zip", "printf 'note\\n' | /usr/bin/zip -qrz comment.zip Clawtrate.app"),
      "the last 22 bytes aren't an end record (a comment or trailing bytes, or not a ZIP)",
    ],
    [
      "a comment length in the end record",
      () => {
        const zip = ditto("length.zip");
        const bytes = readFileSync(zip);
        bytes.writeUInt16LE(1, bytes.length - 2);
        writeFileSync(zip, bytes);
        return zip;
      },
      "an archive comment",
    ],
  ])("refuses %s, naming the zip and the check", async (_, zip, reason) => {
    const file = zip();
    expect(await stopped(() => check(file))).toBe(
      `${basename(file)} would be refused by the Mac updater's ZIP check: ${reason}. Nothing was published.`,
    );
  });
});

/** Prepares the beta with the stand-ins and returns its places. */
async function staged() {
  const place = places();
  await prepare(tools(builds(place.appDir)).runner, NOW, place);
  output.length = 0;
  return place;
}

/** Rewrites a staged file and its record in release.json, as anyone editing the folder could. */
function edit(dir: string, name: string, change: (text: string) => string) {
  writeFileSync(join(dir, name), change(readFileSync(join(dir, name), "utf8")));
  const plan = JSON.parse(readFileSync(join(dir, "release.json"), "utf8"));
  for (const file of plan.files) {
    if (file.name !== name) continue;
    const bytes = readFileSync(join(dir, name));
    file.size = bytes.length;
    file.sha256 = sha256(bytes);
    file.sha512 = createHash("sha512").update(bytes).digest("base64");
  }
  writeFileSync(join(dir, "release.json"), JSON.stringify(plan));
}

describe("what publishing accepts as the prepared release", () => {
  let place: ReturnType<typeof places>;
  let dir: string;
  beforeEach(async () => {
    place = await staged();
    dir = join(place.staging, VERSION);
  });
  afterEach(() => rmSync(place.root, { recursive: true, force: true }));

  it.each<[string, () => void, string]>([
    [
      "the Intel zip is missing",
      () => rmSync(join(dir, ZIPS[1]!)),
      `must hold exactly ${[...ZIPS, "feed.json", "latest-mac.json", "notes.md", "release.json"].sort().join(", ")}`,
    ],
    [
      "the folder holds another file",
      () => writeFileSync(join(dir, "extra.zip"), "x"),
      "must hold exactly",
    ],
    [
      "release.json drops the Intel zip",
      () => {
        const plan = JSON.parse(readFileSync(join(dir, "release.json"), "utf8"));
        plan.files.splice(1, 1);
        writeFileSync(join(dir, "release.json"), JSON.stringify(plan));
      },
      "release.json must list exactly",
    ],
    [
      "release.json is another version's",
      () => edit(dir, "release.json", (text) => text.replaceAll(VERSION, "0.1.1-beta.20261120.3")),
      `release.json is for 0.1.1-beta.20261120.3 (v0.1.1-beta.20261120.3), not ${VERSION}.`,
    ],
    [
      "a zip changed",
      () => writeFileSync(join(dir, ZIPS[1]!), "zip of something else"),
      `${ZIPS[1]} changed since it was prepared.`,
    ],
    [
      "latest-mac.json names another team, recorded again",
      () => edit(dir, "latest-mac.json", (text) => text.replace(TEAM, "OTHERTEAM1")),
      `latest-mac.json names team OTHERTEAM1, release.json ${TEAM}.`,
    ],
    [
      "the feed names other Intel bytes, recorded again",
      () =>
        edit(dir, "feed.json", (text) => {
          const feed = JSON.parse(text);
          feed.files["mac-x64"].sha512 = feed.files["mac-arm64"].sha512;
          return JSON.stringify(feed);
        }),
      `The feed's mac-x64 file is not ${ZIPS[1]} as prepared.`,
    ],
    [
      "latest-mac.json names other Intel bytes, recorded again",
      () =>
        edit(dir, "latest-mac.json", (text) => {
          const latest = JSON.parse(text);
          latest.x86_64.sha256 = latest.arm64.sha256;
          return JSON.stringify(latest);
        }),
      `latest-mac.json's x86_64 file is not ${ZIPS[1]} as prepared.`,
    ],
    [
      "both architectures name the same zip, recorded again",
      () => edit(dir, "feed.json", (text) => text.replace(ZIPS[1]!, ZIPS[0]!)),
      `The feed of ${TAG} does not name ${ZIPS[1]} for mac-x64.`,
    ],
    [
      "the notes were edited",
      () => writeFileSync(join(dir, "notes.md"), "Clawtrate, now with something else.\n"),
      "notes.md is not the notes this release's record makes.",
    ],
  ])(
    "refuses it when %s, even given the edited record's own digest",
    async (_name, change, message) => {
      change();
      const record = existsSync(join(dir, "release.json"))
        ? sha256(readFileSync(join(dir, "release.json")))
        : "0".repeat(64);
      expect(await stopped(() => stagedRelease(place.staging, VERSION, record))).toContain(message);
    },
  );

  it("refuses a folder staged as another version", async () => {
    const record = sha256(readFileSync(join(dir, "release.json")));
    renameSync(dir, join(place.staging, "0.1.1-beta.20261120.3"));
    expect(
      await stopped(() => stagedRelease(place.staging, "0.1.1-beta.20261120.3", record)),
    ).toContain("must hold exactly");
  });

  it("refuses a whole consistent replacement against the digest preparation printed", async () => {
    const printed = sha256(readFileSync(join(dir, "release.json")));
    // Another arm64 zip, and the feed, latest-mac.json, notes and record all made to agree with it.
    writeFileSync(join(dir, ZIPS[0]!), "plain text, not an app");
    const plan = JSON.parse(readFileSync(join(dir, "release.json"), "utf8"));
    const feed = {
      ...makeFeed({
        version: VERSION,
        releaseDate: plan.releaseDate,
        folder: releaseFolder(TAG),
        dir,
      }),
      buildFeed: BETA_FEED_URL,
    };
    const feedText = `${JSON.stringify(feed, null, 2)}\n`;
    const zips = ZIPS.map((name) => {
      const bytes = readFileSync(join(dir, name));
      return {
        name,
        size: bytes.length,
        sha256: sha256(bytes),
        sha512: createHash("sha512").update(bytes).digest("base64"),
      };
    });
    const latestText = `${JSON.stringify(
      makeLatestMac(VERSION, TEAM, {
        "mac-arm64": { url: feed.files["mac-arm64"]!.url, sha256: zips[0]!.sha256 },
        "mac-x64": { url: feed.files["mac-x64"]!.url, sha256: zips[1]!.sha256 },
        "win-x64": undefined,
      }),
      null,
      2,
    )}\n`;
    writeFileSync(join(dir, "feed.json"), feedText);
    writeFileSync(join(dir, "latest-mac.json"), latestText);
    writeFileSync(join(dir, "notes.md"), releaseNotes(VERSION, COMMIT, zips));
    const file = (name: string, text: string) => ({
      name,
      size: Buffer.byteLength(text),
      sha256: sha256(text),
      sha512: createHash("sha512").update(text).digest("base64"),
    });
    plan.files = [...zips, file("feed.json", feedText), file("latest-mac.json", latestText)];
    writeFileSync(join(dir, "release.json"), `${JSON.stringify(plan, null, 2)}\n`);
    // Consistent with itself: only the printed digest tells it apart.
    const forged = sha256(readFileSync(join(dir, "release.json")));
    expect(stagedRelease(place.staging, VERSION, forged).plan.files[0]!.sha256).toBe(
      sha256("plain text, not an app"),
    );
    expect(await stopped(() => stagedRelease(place.staging, VERSION, printed))).toBe(
      `${dir}/release.json is not the record preparation printed (sha256 ${printed}). Nothing was published.`,
    );
  });
});

const siteRuns = "repos/sidebandstudio/clawtrate/actions/workflows/site.yml/runs?per_page=100";

/** GitHub and the site as the publishing and withdrawing steps see them. */
function github(
  dir: string,
  options: { earlier?: ReleaseRow[]; teams?: Record<number, string> } = {},
) {
  const calls: string[][] = [];
  const releases: ReleaseRow[] = [...(options.earlier ?? [])];
  const answers: Record<string, RunResult> = {};
  const digests: Record<string, string> = {};
  const runner: Run = (command, args) => {
    calls.push([command, ...args]);
    const line = [command, ...args].join(" ");
    for (const [start, answer] of Object.entries(answers))
      if (line.startsWith(start)) return answer;
    // The ZIP check publishing builds and runs on the staged zips: it passes them.
    if (command === "xcrun" && args[0] === "clang") return ok();
    if (basename(command) === "check-zip") return ok("ok\n");
    if (command === "gh" && args.includes(siteRuns)) return ok();
    if (line === "gh auth status") return ok();
    if (line.startsWith(`gh api repos/sidebandstudio/clawtrate/compare/${COMMIT}...main`))
      return ok("ahead\n");
    if (line.startsWith("git ls-remote")) return ok("");
    if (line.startsWith("gh api -H Accept: application/octet-stream")) {
      const id = Number(args.at(-1)!.split("/").at(-1));
      const team = options.teams?.[id];
      return team ? ok(JSON.stringify({ teamIdentifier: team })) : fail("Not Found");
    }
    if (line.startsWith("gh api repos/sidebandstudio/clawtrate/releases"))
      return ok(releases.map((row) => `${JSON.stringify(row)}\n`).join(""));
    if (line.startsWith("gh release create")) {
      const files = args.filter((arg) => arg.startsWith(dir));
      releases.push({
        tag_name: args[2]!,
        draft: true,
        prerelease: true,
        target_commitish: args[args.indexOf("--target") + 1]!,
        body: args.includes("--notes") ? args[args.indexOf("--notes") + 1]! : null,
        assets: files.map((path, id) => {
          const name = basename(path);
          const bytes = readFileSync(path);
          return {
            id: 100 + id,
            name,
            size: bytes.length,
            digest: digests[name] ?? `sha256:${sha256(bytes)}`,
            state: "uploaded",
            browser_download_url: `${releaseFolder(args[2]!)}${name}`,
          };
        }),
      });
      return ok();
    }
    if (line.startsWith("gh release edit")) {
      const row = releases.find((each) => each.tag_name === args[2]);
      if (row) row.draft = args.includes("--draft=true");
      return ok();
    }
    if (line === "gh workflow run site.yml --repo sidebandstudio/clawtrate --ref main") return ok();
    return fail(`unexpected ${line}`);
  };
  return { runner, calls, releases, answers, digests };
}

/**
 * The site and public downloads: each exact address answers from `pages`, or
 * 404. The legacy feed address answers as the new one does unless `pages`
 * names it, as the Site workflow serves it while the legacy feed is not pinned.
 */
function site(
  pages: Record<string, () => Promise<Response> | Response>,
  asked: Array<[string, boolean]> = [],
): Net {
  return {
    get: async (url, _signal, follow) => {
      asked.push([url, follow]);
      const page = pages[url] ?? (url === LEGACY_BETA_FEED_URL ? pages[BETA_FEED_URL] : undefined);
      return page ? page() : new Response("", { status: 404 });
    },
    requestMs: 1_000,
    waitMs: 1_000,
    pollMs: 2_000,
  };
}

describe("publishing", () => {
  let place: ReturnType<typeof places>;
  let dir: string;
  let net: Net;
  let record: string;
  beforeEach(async () => {
    place = await staged();
    dir = join(place.staging, VERSION);
    record = sha256(readFileSync(join(dir, "release.json")));
    const files = Object.fromEntries(
      [...ZIPS, "feed.json", "latest-mac.json"].map((name) => [
        `${releaseFolder(TAG)}${name}`,
        () => new Response(readFileSync(join(dir, name))),
      ]),
    );
    net = site({
      ...files,
      [BETA_FEED_URL]: () => new Response(readFileSync(join(dir, "feed.json"))),
    });
  });
  afterEach(() => rmSync(place.root, { recursive: true, force: true }));

  const published = (calls: string[][]) =>
    calls.some((call) => call.join(" ").includes("--draft=false"));

  it("publishes a draft whose every file GitHub reports by the prepared digest", async () => {
    const hub = github(dir);
    await publish(hub.runner, VERSION, record, net, place.staging);
    expect(published(hub.calls)).toBe(true);
    expect(output).toContain(
      "GitHub has no earlier beta: this is the first, so there is no signer to match.",
    );
    expect(output).toContain(
      `The draft ${TAG} holds the 4 prepared files, by digest, and the checked notes.`,
    );
    expect(output).toContain(`The Beta feed offers ${VERSION}.`);
    // The notes go as the checked text, not as a file read again later.
    const create = hub.calls.find((call) => call[1] === "release" && call[2] === "create")!;
    expect(create).not.toContain("--notes-file");
    expect(create[create.indexOf("--notes") + 1]).toBe(readFileSync(join(dir, "notes.md"), "utf8"));
  });

  it("checks both staged zips with the update helper's ZIP check before anything reaches GitHub", async () => {
    const hub = github(dir);
    await publish(hub.runner, VERSION, record, net, place.staging);
    const checks = hub.calls.flatMap((call, index) =>
      basename(call[0]!) === "check-zip" ? [index] : [],
    );
    expect(checks.map((index) => hub.calls[index]![1])).toEqual(ZIPS.map((zip) => join(dir, zip)));
    expect(hub.calls.findIndex((call) => call[0] === "gh")).toBeGreaterThan(checks.at(-1)!);
  });

  it("refuses a staged zip the ZIP check refuses, before any GitHub call, and removes the check", async () => {
    const hub = github(dir);
    let checker = "";
    const refusing: Run = (command, args, options) => {
      if (command === "xcrun" && args[0] === "clang") checker = args.at(-1)!;
      if (basename(command) === "check-zip" && args[0]!.endsWith(ZIPS[1]!)) {
        hub.calls.push([command, ...args]);
        return fail("", "an archive comment\n");
      }
      return hub.runner(command, args, options);
    };
    expect(await stopped(() => publish(refusing, VERSION, record, net, place.staging))).toBe(
      `${ZIPS[1]} would be refused by the Mac updater's ZIP check: an archive comment. Nothing was published.`,
    );
    expect(hub.calls.some((call) => call[0] === "gh")).toBe(false);
    expect(checker).not.toBe("");
    expect(existsSync(dirname(checker))).toBe(false);
  });

  it("checks the site against the feed it published, not the staging file read again", async () => {
    const hub = github(dir);
    const published = readFileSync(join(dir, "feed.json"));
    let reads = 0;
    // The site serves the published feed, while someone edits the staging copy.
    const editing: Net = {
      ...net,
      get: async (url, signal, follow) => {
        if (url !== BETA_FEED_URL && url !== LEGACY_BETA_FEED_URL)
          return net.get(url, signal, follow);
        // Edited once the release is public: after the two reads before publishing.
        if (++reads > 2) writeFileSync(join(dir, "feed.json"), "edited afterwards");
        return new Response(published);
      },
    };
    await publish(hub.runner, VERSION, record, editing, place.staging);
    expect(output).toContain(`The Beta feed offers ${VERSION}.`);
    expect(output).toContain(`The legacy Beta feed offers ${VERSION}.`);
  });

  /** The release's public files, and each feed address as `pages` says. */
  const serving = (pages: Record<string, () => Response>) =>
    site({
      ...Object.fromEntries(
        [...ZIPS, "feed.json", "latest-mac.json"].map((name) => [
          `${releaseFolder(TAG)}${name}`,
          () => new Response(readFileSync(join(dir, name))),
        ]),
      ),
      ...pages,
    });
  const older = "0.1.1-beta.20261119.1";
  const olderFeed = () =>
    new Response(readFileSync(join(dir, "feed.json"), "utf8").replaceAll(VERSION, older));
  const missing = () => new Response("", { status: 404 });
  const fix = `Run the Site workflow on main (gh workflow run site.yml --repo sidebandstudio/clawtrate --ref main), wait for it to finish, and publish again. Nothing was published.`;

  it.each<[string, Record<string, () => Response>, string]>([
    [
      "the new address serves nothing",
      { [BETA_FEED_URL]: missing, [LEGACY_BETA_FEED_URL]: olderFeed },
      `${BETA_FEED_URL} does not serve a Beta feed (it answers 404). ${fix}`,
    ],
    [
      "the legacy address serves nothing",
      { [BETA_FEED_URL]: olderFeed, [LEGACY_BETA_FEED_URL]: missing },
      `${LEGACY_BETA_FEED_URL} does not serve the feed of ${older} (it answers 404). ${fix}`,
    ],
    [
      "the legacy address serves another beta",
      {
        [BETA_FEED_URL]: olderFeed,
        [LEGACY_BETA_FEED_URL]: () => new Response(readFileSync(join(dir, "feed.json"))),
      },
      `${LEGACY_BETA_FEED_URL} does not serve the feed of ${older} (it offers ${VERSION}). ${fix}`,
    ],
  ])("F-559: publishes nothing while %s", async (_case, pages, message) => {
    // An earlier beta with its four files, so this one is not the first.
    const previous: ReleaseRow = {
      tag_name: `v${older}`,
      draft: false,
      prerelease: true,
      assets: [
        ...["feed.json", ...ZIPS.map((zip) => zip.replaceAll(VERSION, older))].map((name) => ({
          name,
          browser_download_url: `${releaseFolder(`v${older}`)}${name}`,
        })),
        { id: 7, name: "latest-mac.json", state: "uploaded", browser_download_url: "unused" },
      ],
    };
    const hub = github(dir, { earlier: [previous], teams: { 7: TEAM } });
    expect(
      await stopped(() => publish(hub.runner, VERSION, record, serving(pages), place.staging)),
    ).toBe(message);
    expect(hub.calls.some((call) => call[1] === "release")).toBe(false);
  });

  it("F-559: before the first beta, neither address need serve a feed", async () => {
    await publish(
      github(dir).runner,
      VERSION,
      record,
      // Nothing at either address until this beta's own Site run deploys it.
      (() => {
        let reads = 0;
        const later = () =>
          ++reads > 2 ? new Response(readFileSync(join(dir, "feed.json"))) : missing();
        return serving({ [BETA_FEED_URL]: later, [LEGACY_BETA_FEED_URL]: later });
      })(),
      place.staging,
    );
    expect(output.slice(-2)).toEqual([
      `The Beta feed offers ${VERSION}.`,
      `The legacy Beta feed offers ${VERSION}.`,
    ]);
  });

  it("F-559: after publishing, stops when the legacy address falls behind the new one", async () => {
    let legacyReads = 0;
    const net = serving({
      [BETA_FEED_URL]: () => new Response(readFileSync(join(dir, "feed.json"))),
      // Right before publishing; then still the earlier beta after it.
      [LEGACY_BETA_FEED_URL]: () =>
        ++legacyReads === 1 ? new Response(readFileSync(join(dir, "feed.json"))) : olderFeed(),
    });
    expect(
      await stopped(() => publish(github(dir).runner, VERSION, record, net, place.staging)),
    ).toBe(
      `The site does not serve what ${BETA_FEED_URL} serves at ${LEGACY_BETA_FEED_URL} yet (it offers ${older}). Look at the Site workflow's run on main, then check it.`,
    );
    expect(output).toContain(`The Beta feed offers ${VERSION}.`);
  });

  it("F-559: pinned, the legacy address must serve the pinned beta's own feed, by GitHub's digest", async () => {
    const pin = "0.1.1-beta.20261119.1";
    const pinnedFeed = readFileSync(join(dir, "feed.json"), "utf8").replaceAll(VERSION, pin);
    const pinnedRow: ReleaseRow = {
      tag_name: `v${pin}`,
      draft: false,
      prerelease: true,
      assets: [
        {
          name: "feed.json",
          digest: `sha256:${sha256(pinnedFeed)}`,
          browser_download_url: `${releaseFolder(`v${pin}`)}feed.json`,
        },
        // Signed by the same team, as publishing requires of every earlier beta.
        { id: 7, name: "latest-mac.json", state: "uploaded", browser_download_url: "unused" },
      ],
    };
    const serve = (legacy: string) =>
      site({
        ...Object.fromEntries(
          [...ZIPS, "feed.json", "latest-mac.json"].map((name) => [
            `${releaseFolder(TAG)}${name}`,
            () => new Response(readFileSync(join(dir, name))),
          ]),
        ),
        [BETA_FEED_URL]: () => new Response(readFileSync(join(dir, "feed.json"))),
        [LEGACY_BETA_FEED_URL]: () => new Response(legacy),
      });
    const hub = () => github(dir, { earlier: [pinnedRow], teams: { 7: TEAM } }).runner;
    // Serving the new beta at the legacy address is wrong once it is pinned:
    // refused before publishing.
    const refused = github(dir, { earlier: [pinnedRow], teams: { 7: TEAM } });
    expect(
      await stopped(() =>
        publish(
          refused.runner,
          VERSION,
          record,
          serve(readFileSync(join(dir, "feed.json"), "utf8")),
          place.staging,
          pin,
        ),
      ),
    ).toBe(
      `${LEGACY_BETA_FEED_URL} does not serve the feed of ${pin} (it offers ${VERSION}). ${fix}`,
    );
    expect(refused.calls.some((call) => call[1] === "release")).toBe(false);
    await publish(hub(), VERSION, record, serve(pinnedFeed), place.staging, pin);
    expect(output.slice(-2)).toEqual([
      `The Beta feed offers ${VERSION}.`,
      `The legacy Beta feed offers ${pin}.`,
    ]);
  });

  it("leaves the draft unpublished when its notes are not the checked notes", async () => {
    const hub = github(dir);
    const changing: Run = (command, args, options) => {
      const result = hub.runner(command, args, options);
      if (args[0] === "release" && args[1] === "create")
        hub.releases.at(-1)!.body = "Clawtrate, with other instructions.";
      return result;
    };
    expect(await stopped(() => publish(changing, VERSION, record, net, place.staging))).toBe(
      "The draft's notes are not the checked notes. It was left a draft: delete it and publish again.",
    );
    expect(published(hub.calls)).toBe(false);
  });

  const DISPATCH = "gh workflow run site.yml --repo sidebandstudio/clawtrate --ref main";
  const dispatched = (calls: string[][]) => calls.filter((call) => call.join(" ") === DISPATCH);

  it("starts the Site workflow on main once GitHub lists the release public, never before", async () => {
    const hub = github(dir);
    await publish(hub.runner, VERSION, record, net, place.staging);
    const lines = hub.calls.map((call) => call.join(" "));
    const flip = lines.findIndex((line) => line.includes("--draft=false"));
    const readBack = lines.findIndex(
      (line, index) =>
        index > flip && line.startsWith("gh api repos/sidebandstudio/clawtrate/releases"),
    );
    expect(dispatched(hub.calls)).toHaveLength(1);
    expect(flip).toBeGreaterThan(-1);
    expect(readBack).toBeGreaterThan(flip);
    expect(lines.indexOf(DISPATCH)).toBeGreaterThan(readBack);
    expect(output).toContain("Started the Site workflow on main.");

    // GitHub still lists it as a draft: nothing is dispatched.
    const ignored = github(dir);
    const stays: Run = (command, args, options) =>
      args.includes("--draft=false") ? ok() : ignored.runner(command, args, options);
    await stopped(() => publish(stays, VERSION, record, net, place.staging));
    expect(dispatched(ignored.calls)).toEqual([]);

    // A draft left unpublished, by a digest that does not match: nothing is dispatched.
    const mismatch = github(dir);
    mismatch.digests[ZIPS[0]!] = `sha256:${sha256("other bytes")}`;
    await stopped(() => publish(mismatch.runner, VERSION, record, net, place.staging));
    expect(dispatched(mismatch.calls)).toEqual([]);
  });

  it("stops, naming the command to run by hand, when the Site workflow cannot be started", async () => {
    const hub = github(dir);
    hub.answers[DISPATCH] = fail("HTTP 403");
    expect(await stopped(() => publish(hub.runner, VERSION, record, net, place.staging))).toBe(
      `Could not start the Site workflow. Start it on main (gh workflow run site.yml --repo sidebandstudio/clawtrate --ref main) signed in with Actions write access, which starting a workflow needs, then check ${BETA_FEED_URL}.`,
    );
  });

  it("reads the release back after making it public, whatever the command answered", async () => {
    // The command fails, but GitHub did publish it: carry on, and say so.
    const refused = github(dir);
    const publishing: Run = (command, args, options) => {
      if (args.includes("--draft=false")) {
        refused.runner(command, args, options);
        return fail("HTTP 502");
      }
      return refused.runner(command, args, options);
    };
    await publish(publishing, VERSION, record, net, place.staging);
    expect(output).toContain(`Publishing reported a failure, but GitHub lists ${TAG} as public.`);

    // The command succeeds, but the release is still a draft.
    const ignored = github(dir);
    const stays: Run = (command, args, options) =>
      args.includes("--draft=false") ? ok() : ignored.runner(command, args, options);
    expect(await stopped(() => publish(stays, VERSION, record, net, place.staging))).toBe(
      `GitHub lists ${TAG} as a draft although it accepted publishing it. It was not published.`,
    );

    // The release cannot be read back.
    const unread = github(dir);
    let flipped = false;
    const blind: Run = (command, args, options) => {
      if (args.includes("--draft=false")) flipped = true;
      if (flipped && args[0] === "api" && args[1]!.endsWith("/releases")) return fail("HTTP 503");
      return unread.runner(command, args, options);
    };
    expect(await stopped(() => publish(blind, VERSION, record, net, place.staging))).toBe(
      `GitHub accepted publishing ${TAG}, and the release could not be read back: whether it is public is unconfirmed. Check it on GitHub.`,
    );
  });

  it("refuses when GitHub cannot compare the commit with main, before creating anything", async () => {
    const hub = github(dir);
    hub.answers["gh api repos/sidebandstudio/clawtrate/compare/"] = fail("Not Found");
    expect(await stopped(() => publish(hub.runner, VERSION, record, net, place.staging))).toBe(
      `Could not compare ${COMMIT} with sidebandstudio/clawtrate's main on GitHub. Nothing was published.`,
    );
    expect(hub.calls.some((call) => call[1] === "release")).toBe(false);
  });

  it.each(["diverged", "behind"])(
    "refuses a commit that is %s from the repository's main, whatever this checkout's origin says",
    async (status) => {
      const hub = github(dir);
      // A fork or a stale origin/main would call it merged.
      hub.answers["git"] = ok();
      hub.answers["gh api repos/sidebandstudio/clawtrate/compare/"] = ok(`${status}\n`);
      expect(await stopped(() => publish(hub.runner, VERSION, record, net, place.staging))).toBe(
        `${COMMIT} is not on sidebandstudio/clawtrate's main (${status}). Publish only a commit that has merged.`,
      );
      expect(hub.calls.some((call) => call[0] === "git")).toBe(false);
      expect(hub.calls.some((call) => call[1] === "release")).toBe(false);
    },
  );

  it("accepts the commit main points at", async () => {
    const hub = github(dir);
    hub.answers["gh api repos/sidebandstudio/clawtrate/compare/"] = ok("identical\n");
    hub.answers["gh release create"] = fail("stop here");
    expect(await stopped(() => publish(hub.runner, VERSION, record, net, place.staging))).toContain(
      "Creating the draft release failed.",
    );
  });

  it("leaves the draft unpublished when GitHub's digest of a file is not the prepared one", async () => {
    const hub = github(dir);
    hub.digests[ZIPS[1]!] = `sha256:${sha256("same size, other bytes")}`;
    expect(await stopped(() => publish(hub.runner, VERSION, record, net, place.staging))).toBe(
      `GitHub's digest of the draft's ${ZIPS[1]} is not the prepared file's. It was left a draft: delete it and publish again.`,
    );
    expect(published(hub.calls)).toBe(false);
  });

  it("leaves the draft unpublished when GitHub reports no digest", async () => {
    const hub = github(dir);
    hub.digests[ZIPS[0]!] = "";
    expect(await stopped(() => publish(hub.runner, VERSION, record, net, place.staging))).toContain(
      `GitHub reports no digest for the draft's ${ZIPS[0]}.`,
    );
    expect(published(hub.calls)).toBe(false);
  });

  it("leaves the draft unpublished when it holds other files than the prepared ones", async () => {
    const hub = github(dir);
    const create = hub.runner;
    const dropping: Run = (command, args, options) => {
      const result = create(command, args, options);
      if (args[0] === "release" && args[1] === "create") hub.releases.at(-1)!.assets.pop();
      return result;
    };
    expect(await stopped(() => publish(dropping, VERSION, record, net, place.staging))).toContain(
      `The draft holds ${[...ZIPS, "feed.json"].sort().join(", ")}, not`,
    );
    expect(published(hub.calls)).toBe(false);
  });

  const earlier = (tag: string, draft = false): ReleaseRow => ({
    tag_name: tag,
    draft,
    prerelease: true,
    assets: [{ id: 7, name: "latest-mac.json", state: "uploaded", browser_download_url: "unused" }],
  });

  it.each<[string, ReleaseRow["assets"]]>([
    ["no latest-mac.json", []],
    [
      "two latest-mac.json",
      [
        { id: 7, name: "latest-mac.json", state: "uploaded", browser_download_url: "unused" },
        { id: 8, name: "latest-mac.json", state: "uploaded", browser_download_url: "unused" },
      ],
    ],
    [
      "a latest-mac.json not fully uploaded",
      [{ id: 7, name: "latest-mac.json", state: "starter", browser_download_url: "unused" }],
    ],
  ])(
    "refuses when an earlier beta has %s, rather than treat it as the first",
    async (_name, assets) => {
      const hub = github(dir, {
        earlier: [{ ...earlier("v0.1.1-beta.20261119.1"), assets }],
        teams: { 7: TEAM, 8: TEAM },
      });
      expect(await stopped(() => publish(hub.runner, VERSION, record, net, place.staging))).toBe(
        "v0.1.1-beta.20261119.1 has no single uploaded latest-mac.json, so its signer is unknown. Nothing was published.",
      );
      expect(hub.calls.some((call) => call[1] === "release")).toBe(false);
    },
  );

  it("refuses another signer than an earlier beta's, published or withdrawn", async () => {
    for (const draft of [false, true]) {
      const hub = github(dir, {
        earlier: [earlier("v0.1.1-beta.20261119.1", draft)],
        teams: { 7: "OTHERTEAM1" },
      });
      expect(await stopped(() => publish(hub.runner, VERSION, record, net, place.staging))).toBe(
        `v0.1.1-beta.20261119.1 is signed by team OTHERTEAM1, this beta by ${TEAM}. Nothing was published.`,
      );
      expect(hub.calls.some((call) => call[1] === "release")).toBe(false);
    }
  });

  it("refuses when an earlier beta's team cannot be read, rather than treat it as the first", async () => {
    const hub = github(dir, { earlier: [earlier("v0.1.1-beta.20261119.1")], teams: {} });
    expect(await stopped(() => publish(hub.runner, VERSION, record, net, place.staging))).toBe(
      "Could not read the team of v0.1.1-beta.20261119.1 from GitHub. Nothing was published.",
    );
    const offline = github(dir);
    offline.answers["gh api repos/sidebandstudio/clawtrate/releases"] = fail("HTTP 503");
    expect(await stopped(() => publish(offline.runner, VERSION, record, net, place.staging))).toBe(
      "Could not read the repository's releases from GitHub.",
    );
  });

  it("accepts the signer of every earlier beta when it is this one", async () => {
    const hub = github(dir, { earlier: [earlier("v0.1.1-beta.20261119.1")], teams: { 7: TEAM } });
    await publish(hub.runner, VERSION, record, net, place.staging);
    expect(output).toContain(`Signed by team ${TEAM}, as every earlier beta (1).`);
  });
});

describe("withdrawing", () => {
  const older = "0.1.1-beta.20261119.1";
  /** A release's feed, naming both Macs' zips, or only `keys`. */
  const feed = (version: string, keys = ["mac-arm64", "mac-x64"]) =>
    JSON.stringify({
      format: 1,
      track: "nightly",
      version,
      releaseDate: "2026-11-20T18:00:00.000Z",
      files: Object.fromEntries(
        keys.map((key) => [
          key,
          {
            url: `${releaseFolder(`v${version}`)}Clawtrate-${version}-${key}.zip`,
            size: 10,
            sha512: Buffer.alloc(64, 1).toString("base64"),
          },
        ]),
      ),
    });
  const row = (version: string, draft: boolean): ReleaseRow => ({
    tag_name: `v${version}`,
    draft,
    prerelease: true,
    assets: [
      "feed.json",
      "latest-mac.json",
      `Clawtrate-${version}-mac-arm64.zip`,
      `Clawtrate-${version}-mac-x64.zip`,
    ].map((name) => ({
      name,
      browser_download_url: `${releaseFolder(`v${version}`)}${name}`,
      ...(name === "feed.json" ? { digest: `sha256:${sha256(feed(version))}` } : {}),
    })),
  });
  const hub = (withOlder: boolean) => {
    const made = github("/nowhere", {
      earlier: [...(withOlder ? [row(older, false)] : []), row(VERSION, false)],
    });
    return made;
  };
  const serving = (answer: () => Promise<Response> | Response) => site({ [BETA_FEED_URL]: answer });

  it("F-559: never withdraws the beta the legacy feed is pinned to", async () => {
    const made = hub(true);
    expect(
      await stopped(() =>
        withdraw(
          made.runner,
          older,
          serving(() => new Response("")),
          older,
        ),
      ),
    ).toBe(
      `${older} is the beta the legacy Beta feed is pinned to, so it is never withdrawn: copies from before ${BETA_FEED_URL} update through it. Nothing was changed.`,
    );
    expect(made.calls).toEqual([]);
  });

  it("F-559: after a withdrawal, the pinned legacy feed must still be the pinned beta's", async () => {
    const pinnedFeed = () => new Response(feed(older));
    await withdraw(
      hub(true).runner,
      VERSION,
      site({ [BETA_FEED_URL]: pinnedFeed, [LEGACY_BETA_FEED_URL]: pinnedFeed }),
      older,
    );
    expect(output.at(-1)).toBe(`The legacy Beta feed offers ${older}.`);
    // The withdrawn beta still served at the legacy address is caught.
    expect(
      await stopped(() =>
        withdraw(
          hub(true).runner,
          VERSION,
          site({
            [BETA_FEED_URL]: pinnedFeed,
            [LEGACY_BETA_FEED_URL]: () => new Response(feed(VERSION)),
          }),
          older,
        ),
      ),
    ).toBe(
      `The site does not serve the feed of ${older} at ${LEGACY_BETA_FEED_URL} yet (it offers ${VERSION}). Look at the Site workflow's run on main, then check it.`,
    );
  });

  it("waits for Site runs on main before accepting the public feed", async () => {
    const made = hub(false);
    const events: string[] = [];
    const runner: Run = (command, args, options) => {
      if (args.includes(siteRuns)) {
        events.push("list");
        return ok(events.length === 1 ? "123" : "");
      }
      return made.runner(command, args, options);
    };
    const net = serving(() => {
      events.push("read");
      return new Response("", { status: 404 });
    });
    await withdraw(runner, VERSION, { ...net, pollMs: 1 });
    // One read of each feed address.
    expect(events).toEqual(["list", "list", "read", "read"]);
  });

  it("stops before reading the feed if the final Site run list arrives late", async () => {
    const made = hub(false);
    const read = vi.fn(() => new Response("", { status: 404 }));
    let now = 100;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const budgets: Array<number | undefined> = [];
    const runner: Run = (command, args, options) => {
      if (!args.includes(siteRuns)) return made.runner(command, args, options);
      expect(args).toContain("--paginate");
      budgets.push(options?.timeout);
      now += budgets.length === 1 ? 400 : 601;
      return ok(budgets.length === 1 ? "123" : "");
    };
    expect(
      await stopped(() => withdraw(runner, VERSION, { ...serving(read), pollMs: 1 })),
    ).toContain("Could not confirm in time whether the Site workflow's runs on main finished");
    expect(budgets).toEqual([1_000, 600]);
    expect(read).not.toHaveBeenCalled();
  });

  it("expects the beta GitHub lists once the Site runs have finished", async () => {
    const newer = "0.1.1-beta.20261121.1";
    const made = hub(true);
    let lists = 0;
    const runner: Run = (command, args, options) => {
      if (!args.includes(siteRuns)) return made.runner(command, args, options);
      // A newer beta is published while a Site run is still going.
      if (lists++ > 0) return ok("");
      made.releases.push(row(newer, false));
      return ok("123");
    };
    const net = serving(() => new Response(feed(newer)));
    await withdraw(runner, VERSION, { ...net, pollMs: 1 });
    expect(output.slice(-2)).toEqual([
      `The Beta feed offers ${newer}.`,
      `The legacy Beta feed offers ${newer}.`,
    ]);
  });

  it("stops without judging the feed while a Site run on main stays unfinished", async () => {
    const made = hub(false);
    const runner: Run = (command, args, options) =>
      args.includes(siteRuns) ? ok("123") : made.runner(command, args, options);
    const read = vi.fn(() => new Response("", { status: 404 }));
    expect(await stopped(() => withdraw(runner, VERSION, serving(read)))).toContain(
      "have not finished",
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects a matching response completed after the deadline", async () => {
    let now = 100;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const net = serving(() => {
      now += 1_001;
      return new Response("", { status: 404 });
    });
    expect(await stopped(() => withdraw(hub(false).runner, VERSION, net))).toContain(
      "no answer in time",
    );
  });

  it("reports the draft GitHub lists and the older beta the site now offers", async () => {
    await withdraw(
      hub(true).runner,
      VERSION,
      serving(() => new Response(feed(older))),
    );
    expect(output).toEqual([
      `GitHub lists ${TAG} as a draft. Its download addresses can still answer from caches for a while.`,
      "Started the Site workflow on main.",
      `Waiting for ${BETA_FEED_URL} to offer ${older}…`,
      `The Beta feed offers ${older}.`,
      `The legacy Beta feed offers ${older}.`,
    ]);
  });

  it("starts the Site workflow on main only once GitHub lists the release as a draft", async () => {
    const made = hub(true);
    await withdraw(
      made.runner,
      VERSION,
      serving(() => new Response(feed(older))),
    );
    const lines = made.calls.map((call) => call.join(" "));
    const edit = lines.findIndex((line) => line.startsWith("gh release edit"));
    const readBack = lines.findIndex(
      (line, index) =>
        index > edit && line.startsWith("gh api repos/sidebandstudio/clawtrate/releases"),
    );
    const dispatch = lines.indexOf(
      "gh workflow run site.yml --repo sidebandstudio/clawtrate --ref main",
    );
    expect(readBack).toBeGreaterThan(edit);
    expect(dispatch).toBeGreaterThan(readBack);

    // Still public after the edit: nothing is dispatched.
    const stays = hub(true);
    stays.answers["gh release edit"] = ok();
    await stopped(() =>
      withdraw(
        stays.runner,
        VERSION,
        serving(() => new Response(feed(older))),
      ),
    );
    expect(stays.calls.some((call) => call[1] === "workflow")).toBe(false);
  });

  it("reports no beta only when the site has no feed and GitHub lists no published beta", async () => {
    await withdraw(
      hub(false).runner,
      VERSION,
      serving(() => new Response("", { status: 404 })),
    );
    expect(output.slice(-2)).toEqual([
      "The site serves no Beta feed, and GitHub lists no published beta.",
      "The legacy Beta feed serves no feed either.",
    ]);
    expect(
      await stopped(() =>
        withdraw(
          hub(true).runner,
          VERSION,
          serving(() => new Response("", { status: 404 })),
        ),
      ),
    ).toBe(
      `The site serves no Beta feed, though GitHub lists v${older} as published. Run the Site workflow on main.`,
    );
  });

  it.each<[string, () => Promise<Response> | Response, string]>([
    ["a 503", () => new Response("busy", { status: 503 }), "HTTP 503"],
    ["no connection", () => Promise.reject(new TypeError("fetch failed")), "no connection"],
    ["a body that is not a feed", () => new Response("<html>"), "not a Beta feed"],
  ])("reports %s as inconclusive, never as no beta", async (_name, answer, reason) => {
    const text = await stopped(() => withdraw(hub(false).runner, VERSION, serving(answer)));
    expect(text).toContain(`Could not tell what the site serves (${reason}`);
    expect(output.join("\n")).not.toContain("no published beta");
  });

  it("gives each request its own deadline", async () => {
    const hanging: Net = {
      get: (_url, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
      requestMs: 20,
      waitMs: 1_000,
      pollMs: 2_000,
    };
    expect(await stopped(() => withdraw(hub(false).runner, VERSION, hanging))).toBe(
      `Could not tell what the site serves (no answer in time). Check ${BETA_FEED_URL} yourself.`,
    );
  });

  it("ends a read that would outlast the wait at the wait's end", async () => {
    let reads = 0;
    const slowAfterFirst: Net = {
      // The first read answers at once with the withdrawn feed; later ones never answer.
      get: (_url, signal) => {
        reads += 1;
        if (reads === 1) return Promise.resolve(new Response(feed(VERSION)));
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        );
      },
      requestMs: 60_000,
      waitMs: 300,
      pollMs: 50,
    };
    const started = Date.now();
    expect(await stopped(() => withdraw(hub(false).runner, VERSION, slowAfterFirst))).toBe(
      `Could not tell what the site serves (no answer in time). Check ${BETA_FEED_URL} yourself.`,
    );
    expect(reads).toBe(2);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("refuses when the site still offers the version", async () => {
    expect(
      await stopped(() =>
        withdraw(
          hub(true).runner,
          VERSION,
          serving(() => new Response(feed(VERSION))),
        ),
      ),
    ).toBe(`The site still offers ${VERSION}. Run the Site workflow on main and run this again.`);
  });

  it("refuses a feed of another version than the beta GitHub still lists", async () => {
    expect(
      await stopped(() =>
        withdraw(
          hub(true).runner,
          VERSION,
          serving(() => new Response(feed("0.1.1-beta.20261118.1"))),
        ),
      ),
    ).toBe(
      `The site offers 0.1.1-beta.20261118.1, not ${older}. Run the Site workflow on main and run this again.`,
    );
    expect(
      await stopped(() =>
        withdraw(
          hub(false).runner,
          VERSION,
          serving(() => new Response(feed(older))),
        ),
      ),
    ).toBe(
      `The site still offers ${older}, and GitHub lists no published beta, so the Site workflow deploys nothing and the site keeps that feed. Cut a fixed beta, or unpublish the Pages site in the repository's settings until there is one (docs/development/releases.md, "Withdraw a beta").`,
    );
  });

  it("refuses a feed with the remaining beta's version that is not its release's feed.json", async () => {
    // Intel Macs could not update from it.
    expect(
      await stopped(() =>
        withdraw(
          hub(true).runner,
          VERSION,
          serving(() => new Response(feed(older, ["mac-arm64"]))),
        ),
      ),
    ).toBe(
      `The site offers ${older}, but not the feed.json of its release. Run the Site workflow on main and run this again.`,
    );
  });

  it("refuses to judge the site when GitHub reports no digest of the remaining beta's feed", async () => {
    const made = github("/nowhere", { earlier: [row(older, false), row(VERSION, false)] });
    delete made.releases[0]!.assets.find((asset) => asset.name === "feed.json")!.digest;
    expect(
      await stopped(() =>
        withdraw(
          made.runner,
          VERSION,
          serving(() => new Response(feed(older))),
        ),
      ),
    ).toBe(
      `GitHub reports no digest for v${older}'s feed.json, so the site's feed cannot be checked against it. Check ${BETA_FEED_URL} yourself.`,
    );
  });

  it("gives the way out when the only beta is withdrawn and the site still offers it", async () => {
    expect(
      await stopped(() =>
        withdraw(
          hub(false).runner,
          VERSION,
          serving(() => new Response(feed(VERSION))),
        ),
      ),
    ).toBe(
      `The site still offers ${VERSION}, and GitHub lists no published beta, so the Site workflow deploys nothing and the site keeps that feed. Cut a fixed beta, or unpublish the Pages site in the repository's settings until there is one (docs/development/releases.md, "Withdraw a beta").`,
    );
  });

  it("reads the feed's own address and follows no redirect, so a 404 elsewhere proves nothing", async () => {
    const asked: Array<[string, boolean]> = [];
    const moved = site(
      {
        [BETA_FEED_URL]: () =>
          new Response("", { status: 302, headers: { location: "https://example.com/gone" } }),
      },
      asked,
    );
    expect(await stopped(() => withdraw(hub(false).runner, VERSION, moved))).toBe(
      `Could not tell what the site serves (a redirect (HTTP 302)). Check ${BETA_FEED_URL} yourself.`,
    );
    expect(asked.length).toBeGreaterThan(0);
    for (const request of asked) expect(request).toEqual([BETA_FEED_URL, false]);
  });

  it("reports the state as unconfirmed when the release cannot be read back", async () => {
    const made = hub(true);
    let edited = false;
    const blind: Run = (command, args, options) => {
      if (args[0] === "release" && args[1] === "edit") edited = true;
      if (edited && args[0] === "api") return fail("HTTP 503");
      return made.runner(command, args, options);
    };
    expect(
      await stopped(() =>
        withdraw(
          blind,
          VERSION,
          serving(() => new Response(feed(older))),
        ),
      ),
    ).toBe(
      `GitHub accepted turning ${TAG} into a draft, and the release could not be read back: whether it is still public is unconfirmed. Check it on GitHub.`,
    );
  });

  it("refuses when GitHub still lists the release as published", async () => {
    const made = hub(true);
    made.answers["gh release edit"] = ok();
    expect(
      await stopped(() =>
        withdraw(
          made.runner,
          VERSION,
          serving(() => new Response(feed(older))),
        ),
      ),
    ).toBe(`GitHub still lists ${TAG} as published although it accepted the change.`);
  });
});

describe("stopping a release while it builds", () => {
  /** A process's presence, by pid. */
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("stops the build and what it started, restores the search list, then removes the signing folder, dist and the partial folder, on SIGTERM", async () => {
    // A release script of its own, with stand-ins for every tool but the
    // build: a process that never ends and has started a child of its own,
    // as electron-builder waiting on notarytool does.
    const place = places();
    const script = join(place.root, "release.ts");
    const secrets = join(place.root, "secrets.json");
    const pids = join(place.root, "pids");
    // The stand-in search list, kept in a file the script's `security` reads and replaces.
    const list = join(place.root, "search-list");
    writeFileSync(list, JSON.stringify(SEARCH_LIST));
    writeFileSync(secrets, JSON.stringify(SECRETS));
    const sleeper = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      // What a build leaves: its own output and the version's folder.
      "fs.mkdirSync(process.argv[2], { recursive: true }); fs.mkdirSync(process.argv[3], { recursive: true });",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "fs.writeFileSync(process.argv[1], process.pid + ' ' + child.pid);",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    writeFileSync(
      script,
      [
        `import { readFileSync, writeFileSync } from "node:fs";`,
        `import { prepare, startBuild, SECURITY } from ${JSON.stringify(join(import.meta.dirname, "../packaging/release-beta.ts"))};`,
        `const secrets = JSON.parse(readFileSync(${JSON.stringify(secrets)}, "utf8"));`,
        `const ok = (stdout = "", stderr = "") => ({ status: 0, stdout, stderr });`,
        `const list = ${JSON.stringify(list)};`,
        `const runner = (command, args) => {`,
        `  if (command === "fleet") return ok(secrets[args[2]] + "\\n");`,
        `  if (command === SECURITY && args[0] === "list-keychains" && args.length === 3) return ok(JSON.parse(readFileSync(list, "utf8")).map((path) => '"' + path + '"\\n').join(""));`,
        `  if (command === SECURITY && args[0] === "list-keychains" && args[3] === "-s") { writeFileSync(list, JSON.stringify(args.slice(4))); return ok(); }`,
        `  if (command === SECURITY && args[0] === "show-keychain-info") return ok("", "lock-on-sleep timeout=3600s");`,
        `  if (command === SECURITY && args[0] === "find-identity") return ok('  1) ${IDENTITY} "Developer ID Application: Example (${TEAM})"\\n');`,
        `  if (command === "git" && args[0] === "rev-parse") return ok("${COMMIT}\\n");`,
        `  return ok();`,
        `};`,
        `const build = (_command, args, options) => startBuild(process.execPath, ["-e", ${JSON.stringify(sleeper)}, ${JSON.stringify(pids)}, options.env.CLAWTRATE_PACKAGE_OUTPUT, args[1]], options);`,
        `await prepare(runner, new Date(${JSON.stringify(NOW.toISOString())}), ${JSON.stringify({ staging: place.staging, appDir: place.appDir, state: place.state })}, build);`,
      ].join("\n"),
    );
    const release = spawn(process.execPath, [script], { stdio: "ignore" });
    const exited = new Promise<number | null>((resolve) => release.once("exit", resolve));
    let started: number[] = [];
    try {
      for (let waited = 0; !existsSync(pids); waited += 100) {
        if (waited > 20_000) throw new Error("the build stand-in did not start");
        await sleep(100);
      }
      started = readFileSync(pids, "utf8").split(" ").map(Number);
      // The run's lock and its signing folder.
      const held = readdirSync(place.state).sort();
      expect(held).toHaveLength(2);
      expect(held[1]).toBe(LOCKS_FOLDER);
      expect(lockFiles(place.state)).toHaveLength(1);
      const signing = join(place.state, held[0]!);
      // While it builds, the release keychain is first on the list.
      expect(JSON.parse(readFileSync(list, "utf8"))).toEqual([
        join(signing, "release.keychain-db"),
        ...SEARCH_LIST,
      ]);
      expect(JSON.parse(readFileSync(join(signing, "search-list.json"), "utf8"))).toEqual(
        SEARCH_LIST,
      );
      release.kill("SIGTERM");
      const code = await Promise.race([exited, sleep(20_000).then(() => "running")]);
      expect(code, "the release script exits once interrupted").toBe(130);
      for (const pid of started) expect(alive(pid), `pid ${pid}`).toBe(false);
      expect(readdirSync(place.state).filter((name) => name !== LOCKS_FOLDER)).toEqual([]);
      expect(JSON.parse(readFileSync(list, "utf8"))).toEqual(SEARCH_LIST);
      expect(existsSync(join(place.appDir, "dist"))).toBe(false);
      expect(existsSync(join(place.staging, VERSION))).toBe(false);
    } finally {
      release.kill("SIGKILL");
      for (const pid of started) if (alive(pid)) process.kill(pid, "SIGKILL");
      rmSync(place.root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("the beta's release notes", () => {
  it("say an existing OpenClaw is connected with its address and token under Advanced, and why", () => {
    const notes = releaseNotes("0.2.0-beta.1", "0123456789abcdef", [
      { name: "Clawtrate-0.2.0-beta.1-mac-arm64.zip", sha256: "a".repeat(64) },
    ]);
    expect(notes).toContain("asks for your gateway's address and token under Advanced");
    expect(notes).toContain("running OpenClaw's own program before you agree");
    // Nothing offers a connection without typing on an existing install.
    expect(notes).not.toMatch(/without typing|automatically|one click/i);
  });
});

describe("the search list is put back before anything is forgotten", () => {
  let place: ReturnType<typeof places>;
  beforeEach(() => {
    place = places();
  });
  afterEach(() => {
    if (existsSync(place.staging)) chmodSync(place.staging, 0o755);
    rmSync(place.root, { recursive: true, force: true });
  });

  /** The run's signing folder, if it kept one. */
  const signingFolders = () =>
    readdirSync(place.state).filter((name) => name.startsWith("clawtrate-signing-"));

  it.each(["the restore", "the readback"])(
    "keeps the signing folder, its record and the lock, and prints the command, when %s fails",
    async (failing) => {
      const { runner } = tools(builds(place.appDir));
      // Once the release keychain is first, putting the list back fails, or
      // seems to succeed but reads back as another list.
      let changed = false;
      let restoring = false;
      const breaking: Run = (command, args, options) => {
        if (command === SECURITY && args[0] === "list-keychains") {
          const setting = args[3] === "-s";
          if (setting && args[4] !== SEARCH_LIST[0]) changed = true;
          else if (changed && setting) {
            restoring = true;
            if (failing === "the restore") return fail("no write");
          } else if (restoring && !setting && failing === "the readback")
            return ok('    "/Volumes/Keys/other.keychain-db"\n');
        }
        return runner(command, args, options);
      };
      const text = await stopped(() => prepare(breaking, NOW, place));
      expect(text).toContain(
        "The keychain search list could not be restored. Set it back with: /usr/bin/security list-keychains -d user -s '/Volumes/Keys/login.keychain-db' '/Volumes/Keys/Work Keys.keychain-db'",
      );
      const [kept] = signingFolders();
      expect(kept).toBeDefined();
      expect(
        JSON.parse(readFileSync(join(place.state, kept!, "search-list.json"), "utf8")),
      ).toEqual(SEARCH_LIST);
      expect(lockFiles(place.state)).toHaveLength(1);
      expect(output.join("\n")).toContain(
        "search-list.json: the next pnpm release:beta restores the search list from it.",
      );
      expect(existsSync(join(place.staging, VERSION, "release.json"))).toBe(false);
    },
  );

  it("keeps the folder and the record when the first change fails and so does putting the list back", async () => {
    const { runner, calls } = tools(builds(place.appDir));
    // The first change lands but reports failure; putting the list back then fails.
    const refusing: Run = (command, args, options) => {
      if (command === SECURITY && args[0] === "list-keychains" && args[3] === "-s") {
        runner(command, args, options);
        return fail("no write");
      }
      return runner(command, args, options);
    };
    const text = await stopped(() => prepare(refusing, NOW, place));
    expect(text).toBe(
      "Could not put the release keychain on the keychain search list. Nothing was built.",
    );
    // The restore was tried, failed, and named its command; the record stays.
    expect(output.join("\n")).toContain("The keychain search list could not be restored.");
    expect(calls.some((call) => call.command === process.execPath)).toBe(false);
    const [kept] = signingFolders();
    expect(readdirSync(join(place.state, kept!))).toContain("search-list.json");
    expect(lockFiles(place.state)).toHaveLength(1);
  });

  it("restores the list first when removing the run's output fails", async () => {
    const { runner, searchList } = tools((out) => {
      mkdirSync(join(place.appDir, "dist"), { recursive: true });
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "partial"), "x");
      // Removing the folder now fails: its parent cannot be written.
      chmodSync(place.staging, 0o555);
      return fail("Error: Packaging failed (exit 1).");
    });
    expect(await stopped(() => prepare(runner, NOW, place))).toContain("The build failed");
    expect(searchList).toEqual(SEARCH_LIST);
    expect(output.join("\n")).toContain("Could not remove this run's output:");
    expect(signingFolders()).toEqual([]);
    expect(lockFiles(place.state)).toEqual([]);
  });
});

/** The release lock files in a state folder. */
function lockFiles(state: string): string[] {
  const dir = join(state, LOCKS_FOLDER);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith("release-")) : [];
}

/** This process's start time as `ps` reports it, as a live lock records it. */
const myStart = () =>
  spawnSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8" }).stdout.trim();

describe("one release at a time, whatever the environment", () => {
  let place: ReturnType<typeof places>;
  beforeEach(() => {
    place = places();
  });
  afterEach(() => rmSync(place.root, { recursive: true, force: true }));

  it("keeps the lock in one folder per user, whatever TMPDIR and HOME say", () => {
    const saved = { TMPDIR: process.env.TMPDIR, HOME: process.env.HOME };
    try {
      process.env.TMPDIR = "/private/tmp/one/";
      process.env.HOME = "/Volumes/Elsewhere/home";
      const first = releaseStateFolder();
      process.env.TMPDIR = "/private/tmp/two/";
      process.env.HOME = "/Volumes/Other/home";
      expect(releaseStateFolder()).toBe(first);
      expect(first).toBe(
        join(userInfo().homedir, "Library", "Application Support", "clawtrate-release"),
      );
      expect(first.startsWith("/private/tmp")).toBe(false);
    } finally {
      for (const [name, value] of Object.entries(saved))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
  });

  it("lets one admission hold the lock and refuses a second, which removes only its own file", () => {
    const release = takeReleaseLock(place.state);
    try {
      const [held] = lockFiles(place.state);
      expect(() => takeReleaseLock(place.state)).toThrow(
        `Another release (pid ${process.pid}) holds the release lock (${join(place.state, LOCKS_FOLDER, held!)}). Let it finish first.`,
      );
      expect(lockFiles(place.state)).toEqual([held]);
    } finally {
      release();
    }
    expect(lockFiles(place.state)).toEqual([]);
  });

  it("takes over the lock of a run whose pid no longer exists", () => {
    const token = "ab".repeat(16);
    const dead = join(place.state, LOCKS_FOLDER, `release-99999999-${token}.lock`);
    mkdirSync(join(place.state, LOCKS_FOLDER), { mode: 0o700 });
    writeFileSync(
      dead,
      JSON.stringify({ pid: 99999999, start: "Thu Jan  1 00:00:00 1970", token }),
    );
    const release = takeReleaseLock(place.state);
    expect(existsSync(dead)).toBe(false);
    expect(output.join("\n")).toContain(
      "Took over the release lock from a release (pid 99999999) that has ended.",
    );
    release();
  });

  it("never moves or removes a live holder's lock", () => {
    const token = "cd".repeat(16);
    const live = join(place.state, LOCKS_FOLDER, `release-${process.pid}-${token}.lock`);
    mkdirSync(join(place.state, LOCKS_FOLDER), { mode: 0o700 });
    const text = JSON.stringify({ pid: process.pid, start: myStart(), token });
    writeFileSync(live, text);
    const before = statSync(live).ino;
    expect(() => takeReleaseLock(place.state)).toThrow(`Another release (pid ${process.pid})`);
    expect(readFileSync(live, "utf8")).toBe(text);
    expect(statSync(live).ino).toBe(before);
    expect(lockFiles(place.state)).toEqual([basename(live)]);
  });

  it.each<[string, (token: string) => [string, string]]>([
    ["cannot be read", (token) => [`release-${process.pid}-${token}.lock`, "not json"]],
    [
      "names a running pid that started at another time",
      (token) => [
        `release-${process.pid}-${token}.lock`,
        JSON.stringify({ pid: process.pid, start: "Thu Jan  1 00:00:00 1970", token }),
      ],
    ],
    ["is not a lock this tool writes", () => ["release.lock", "{}"]],
  ])("refuses, touching nothing, when a lock %s", (_name, make) => {
    const [name, text] = make("ef".repeat(16));
    const path = join(place.state, LOCKS_FOLDER, name);
    mkdirSync(join(place.state, LOCKS_FOLDER), { mode: 0o700 });
    writeFileSync(path, text);
    expect(() => takeReleaseLock(place.state)).toThrow(
      "If no other release is running, check the pid with `ps -p <pid>`, then remove that file yourself",
    );
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(readdirSync(join(place.state, LOCKS_FOLDER))).toEqual([name]);
  });

  it("refuses to prepare while another release holds the lock, before touching anything", async () => {
    const release = takeReleaseLock(place.state);
    try {
      const { runner, calls } = tools(builds(place.appDir));
      expect(await stopped(() => prepare(runner, NOW, place))).toContain("Another release");
      expect(calls).toEqual([]);
    } finally {
      release();
    }
  });
});

describe("the list is compared before it is put back", () => {
  let place: ReturnType<typeof places>;
  beforeEach(() => {
    place = places();
  });
  afterEach(() => rmSync(place.root, { recursive: true, force: true }));

  const signingFolders = () =>
    readdirSync(place.state).filter((name) => name.startsWith("clawtrate-signing-"));

  /** The stand-in tools, with a build that does `during` to the search list. */
  function changing(during: (list: string[], keychain: string) => void) {
    let list: string[] = [];
    const made = tools((out, version, env) => {
      during(list, env.CSC_KEYCHAIN!);
      return builds(place.appDir)(out, version, env);
    });
    list = made.searchList;
    return made;
  }

  it("keeps a change made during the build and takes off only this run's keychain", async () => {
    const extra = "/Volumes/Keys/Added Later.keychain-db";
    const { runner, searchList } = changing((list) => list.push(extra));
    await prepare(runner, NOW, place);
    expect(searchList).toEqual([...SEARCH_LIST, extra]);
    expect(output.join("\n")).toContain(
      "Took the release keychain off the keychain search list, keeping the other changes made to it during the build.",
    );
  });

  it.each<[string, (list: string[], keychain: string) => void, string]>([
    [
      "no longer holds this run's keychain",
      (list) => list.splice(0, list.length, "/Volumes/Keys/Other.keychain-db"),
      "no longer holds",
    ],
  ])("writes nothing and keeps the record when the list %s", async (_name, during, message) => {
    const { runner, calls } = changing(during);
    const text = await stopped(() => prepare(runner, NOW, place));
    expect(text).toContain(message);
    expect(text).toContain("wrote nothing");
    const writes = calls.filter(
      (call) => call.args[0] === "list-keychains" && call.args[3] === "-s",
    );
    expect(writes).toHaveLength(1);
    const [kept] = signingFolders();
    expect(readdirSync(join(place.state, kept!))).toContain("search-list.json");
    expect(lockFiles(place.state)).toHaveLength(1);
  });

  it("writes nothing and keeps the record when the list cannot be read", async () => {
    const { runner, calls } = tools(builds(place.appDir));
    let built = false;
    const unreadable: Run = (command, args, options) => {
      if (command === process.execPath) built = true;
      if (built && command === SECURITY && args[0] === "list-keychains" && args.length === 3)
        return ok("not a list\n");
      return runner(command, args, options);
    };
    const text = await stopped(() => prepare(unreadable, NOW, place));
    expect(text).toContain("could not be read, so nothing was written");
    expect(
      calls.filter((call) => call.args[0] === "list-keychains" && call.args[3] === "-s"),
    ).toHaveLength(1);
    const [kept] = signingFolders();
    expect(readdirSync(join(place.state, kept!))).toContain("search-list.json");
  });

  it("recovers a killed run's keychain the same way, keeping what changed since", async () => {
    const dead = join(place.state, "clawtrate-signing-Abc123");
    mkdirSync(dead);
    writeFileSync(join(dead, "pid"), "99999999");
    writeFileSync(join(dead, "search-list.json"), JSON.stringify(SEARCH_LIST));
    const extra = "/Volumes/Keys/Added Later.keychain-db";
    const { runner, searchList } = tools(builds(place.appDir));
    searchList.splice(
      0,
      searchList.length,
      join(dead, "release.keychain-db"),
      ...SEARCH_LIST,
      extra,
    );
    const refused: Run = (command, args, options) =>
      command === "fleet" ? vault({})(command, args) : runner(command, args, options);
    expect(await stopped(() => prepare(refused, NOW, place))).toContain("The vault has no value");
    expect(searchList).toEqual([...SEARCH_LIST, extra]);
    expect(existsSync(dead)).toBe(false);
  });

  it("keeps a killed run's folder when the list no longer holds its keychain and is not its record", async () => {
    const dead = join(place.state, "clawtrate-signing-Abc123");
    mkdirSync(dead);
    writeFileSync(join(dead, "pid"), "99999999");
    writeFileSync(
      join(dead, "search-list.json"),
      JSON.stringify(["/Volumes/Keys/Gone.keychain-db"]),
    );
    const { runner, searchList } = tools(builds(place.appDir));
    expect(await stopped(() => prepare(runner, NOW, place))).toContain("wrote nothing");
    expect(searchList).toEqual(SEARCH_LIST);
    expect(readdirSync(dead)).toContain("search-list.json");
  });
});

describe("only this run's output", () => {
  let place: ReturnType<typeof places>;
  beforeEach(() => {
    place = places();
  });
  afterEach(() => {
    vi.mocked(mkdtempSync).mockImplementation(realFs.mkdtempSync);
    vi.mocked(writeFileSync).mockImplementation(realFs.writeFileSync);
    rmSync(place.root, { recursive: true, force: true });
  });

  it("builds into its own folder, never apps/desktop/dist, which ordinary packaging writes", async () => {
    // Ordinary packaging (pnpm package:mac, build.ts) writes to apps/desktop/dist.
    expect(builderConfig({}, "45.3.2").directories?.output).toBe("dist");
    expect(packageOutput({}, place.appDir).path).toBe(join(place.appDir, "dist"));
    const dist = join(place.appDir, "dist");
    let beta = "";
    const { runner } = tools((out, version, env) => {
      // An ordinary packaging run writes while the beta builds.
      mkdirSync(join(dist, "mac-arm64"), { recursive: true });
      writeFileSync(join(dist, "ordinary.zip"), "ordinary");
      beta = builtInto(place.appDir, env);
      expect(builderConfig(env, "45.3.2").directories?.output).toBe(beta);
      return builds(place.appDir)(out, version, env);
    });
    await prepare(runner, NOW, place);
    expect(beta.startsWith(join(place.state, "clawtrate-signing-"))).toBe(true);
    expect(readFileSync(join(dist, "ordinary.zip"), "utf8")).toBe("ordinary");
    expect(readdirSync(dist).sort()).toEqual(["mac-arm64", "ordinary.zip"]);
  });

  it("leaves output another run made after the preflight", async () => {
    const { runner } = tools(builds(place.appDir));
    const racing: Run = (command, args, options) => {
      if (command === "git" && args[0] === "ls-remote") {
        mkdirSync(join(place.staging, VERSION), { recursive: true });
        writeFileSync(join(place.staging, VERSION, "theirs"), "another build");
      }
      return runner(command, args, options);
    };
    expect(await stopped(() => prepare(racing, NOW, place))).toBe(
      `${join(place.staging, VERSION)} appeared before this run could reserve it. It was left as it is.`,
    );
    expect(readFileSync(join(place.staging, VERSION, "theirs"), "utf8")).toBe("another build");
  });

  it("names and leaves a version folder that no longer carries this run's marker", async () => {
    const { runner } = tools((out) => {
      rmSync(join(out, RESERVATION_FILE));
      writeFileSync(join(out, "someone-else"), "x");
      return fail("Error: Packaging failed (exit 1).");
    });
    expect(await stopped(() => prepare(runner, NOW, place))).toContain("The build failed");
    expect(existsSync(join(place.staging, VERSION, "someone-else"))).toBe(true);
    expect(output.join("\n")).toContain(
      `Left ${join(place.staging, VERSION)} in place: this run cannot tell it made it.`,
    );
  });

  it("reserves the version's folder with its marker before the build, and stages without it", async () => {
    let seen: string[] = [];
    const { runner } = tools((out, version, env) => {
      seen = readdirSync(out);
      return builds(place.appDir)(out, version, env);
    });
    await prepare(runner, NOW, place);
    expect(seen).toEqual([RESERVATION_FILE]);
    expect(readdirSync(join(place.staging, VERSION))).not.toContain(RESERVATION_FILE);
  });

  /** After a setup failure: no version folder, no signing folder, no lock. */
  const nothingLeft = () => {
    expect(existsSync(join(place.staging, VERSION))).toBe(false);
    expect(
      readdirSync(place.state).filter((name) => name.startsWith("clawtrate-signing-")),
    ).toEqual([]);
    expect(lockFiles(place.state)).toEqual([]);
  };
  const noSpace = () => Object.assign(new Error("no space left"), { code: "ENOSPC" });

  it("releases everything when its marker cannot be written", async () => {
    vi.mocked(writeFileSync).mockImplementation((path, ...rest) => {
      if (String(path).endsWith(RESERVATION_FILE)) throw noSpace();
      return realFs.writeFileSync(path, ...rest);
    });
    const { runner } = tools(builds(place.appDir));
    await expect(prepare(runner, NOW, place)).rejects.toThrow("no space left");
    nothingLeft();
  });

  it("preserves another writer's marker and files if they appear while reserving staging", async () => {
    const folder = join(place.staging, VERSION);
    const marker = join(folder, RESERVATION_FILE);
    vi.mocked(writeFileSync).mockImplementation((path, ...rest) => {
      if (path === marker) {
        realFs.writeFileSync(marker, "other owner");
        realFs.writeFileSync(join(folder, "other.zip"), "other build");
      }
      return realFs.writeFileSync(path, ...rest);
    });
    const { runner } = tools(builds(place.appDir));
    expect(await stopped(() => prepare(runner, NOW, place))).toContain("left as it is");
    expect(readFileSync(marker, "utf8")).toBe("other owner");
    expect(readFileSync(join(folder, "other.zip"), "utf8")).toBe("other build");
  });

  it("releases everything when the signing folder cannot be made", async () => {
    vi.mocked(mkdtempSync).mockImplementation((prefix, ...rest) => {
      if (String(prefix).includes("clawtrate-signing-")) throw noSpace();
      return realFs.mkdtempSync(prefix, ...rest);
    });
    const { runner } = tools(builds(place.appDir));
    await expect(prepare(runner, NOW, place)).rejects.toThrow("no space left");
    nothingLeft();
  });

  it("releases everything when the run's pid cannot be written", async () => {
    vi.mocked(writeFileSync).mockImplementation((path, ...rest) => {
      if (/clawtrate-signing-[^/]+\/pid$/.test(String(path))) throw noSpace();
      return realFs.writeFileSync(path, ...rest);
    });
    const { runner } = tools(builds(place.appDir));
    await expect(prepare(runner, NOW, place)).rejects.toThrow("no space left");
    nothingLeft();
  });
});
