// The beta release script without a signing identity: every outside tool
// (the vault, git, gh, security, notarytool, the build, ditto, codesign,
// spctl, stapler, the site) is a stand-in, so these checks show what the
// script does with their answers, which process is given each secret, and
// what reaches the output, the staging folder or a leftover file.

import { createHash } from "node:crypto";
import {
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEnvironment,
  main,
  nextRun,
  NOTARY_PROFILE,
  p12Bytes,
  p8Text,
  prepare,
  publish,
  readSecrets,
  readSignature,
  SECRET_NAMES,
  signingKeychain,
  stagedRelease,
  Stop,
  verifyApp,
  withdraw,
  type Net,
  type Places,
  type Run,
  type RunResult,
  type Secrets,
} from "../packaging/release-beta.ts";
import { signingPlan, signingProblems } from "../packaging/signing.ts";
import { parseFeed } from "../src/main/update/feed.ts";
import { BETA_FEED_URL, checkBetaFiles, releaseFolder } from "../packaging/beta-files.ts";
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
    const code = await main(
      [],
      (command, args) => {
        calls.push(command);
        return vault(partial)(command, args);
      },
      "darwin",
    );
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
}

/** `security` and `notarytool` as they answer for a good certificate and key. */
function keychainTools(calls: Call[], overrides: Partial<Record<string, RunResult>> = {}): Run {
  return (command, args, options) => {
    calls.push({ command, args, env: options?.env, input: options?.input });
    const key = `${command} ${args[0]}`;
    if (overrides[key]) return overrides[key]!;
    if (command === "security" && args[0] === "-i") return ok("keychain: made\n");
    if (command === "xcrun" && args[0] === "notarytool") return ok("Credentials saved.\n");
    if (command === "security" && args[0] === "find-identity")
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

  it("hands each secret to security or notarytool on its input, never in arguments or environment", () => {
    const calls: Call[] = [];
    const base = { PATH: "/usr/bin", HOME: "/home-of-the-maintainer", NODE_OPTIONS: "--require x" };
    const signing = signingKeychain(keychainTools(calls), SECRETS, dir, base);
    const keychain = join(dir, "release.keychain-db");
    expect(signing).toEqual({ keychain, identity: IDENTITY, teamId: TEAM });
    expect(calls.map(({ command, args }) => [command, ...args])).toEqual([
      ["security", "-i"],
      ["xcrun", "notarytool", "store-credentials", NOTARY_PROFILE, "--keychain", keychain],
      ["security", "find-identity", "-v", "-p", "codesigning", keychain],
    ]);
    for (const call of calls) {
      const outside = JSON.stringify([call.args, call.env]);
      for (const secret of SECRET_TEXTS) expect(outside).not.toContain(secret);
      expect(call.env).toEqual({ PATH: "/usr/bin", HOME: "/home-of-the-maintainer" });
    }
    // `security -i` reads its own quoting: the password's quote and backslash are escaped.
    const lines = calls[0]!.input!.trimEnd().split("\n");
    expect(lines[3]).toBe(
      `import "${join(dir, "developer-id.p12")}" -k "${keychain}" -f pkcs12 -P "p\\"w\\\\d" -T /usr/bin/codesign`,
    );
    expect(lines.map((line) => line.split(" ")[0])).toEqual([
      "create-keychain",
      "set-keychain-settings",
      "unlock-keychain",
      "import",
      "set-key-partition-list",
    ]);
    const key = join(dir, "AuthKey_KEYID12345.p8");
    expect(calls[1]!.input).toBe(
      `${key}\nKEYID12345\n${SECRETS.APPLE_CLAWTRATE_NOTARY_ISSUER_ID}\n`,
    );
    // The certificate's file is gone once imported; the key's stays, private, for notarization.
    expect(readdirSync(dir)).toEqual(["AuthKey_KEYID12345.p8"]);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(readFileSync(key, "utf8")).toBe(`${KEY}\n`);
  });

  it.each([
    ["security -i", "The certificate did not import"],
    ["xcrun notarytool", "Apple did not accept the notary API key"],
    ["security find-identity", "no single valid Developer ID Application identity"],
  ])("stops when %s fails, printing none of its output", async (tool, message) => {
    const leaked = fail(`bad password ${SECRETS.APPLE_CLAWTRATE_DEVELOPER_ID_P12_PASSWORD}`, KEY);
    const text = await stopped(() =>
      signingKeychain(keychainTools([], { [tool]: leaked }), SECRETS, dir, {}),
    );
    expect(text).toContain(message);
    for (const secret of SECRET_TEXTS) expect(text).not.toContain(secret);
    expect(existsSync(join(dir, "developer-id.p12"))).toBe(false);
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
  mkdirSync(join(root, "temp"));
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ version: "0.1.0" }));
  return { root, appDir, staging: join(root, "staging"), temp: join(root, "temp") };
}

/** git, gh, the vault, the keychain tools, candidate-build.ts and the Mac tools. */
function tools(
  build: (out: string, version: string, env: NodeJS.ProcessEnv) => RunResult,
  overrides: Record<string, RunResult> = {},
) {
  const calls: Call[] = [];
  let current = "";
  const keychain = keychainTools(calls);
  const mac = macTools(() => current, overrides);
  const seen: { env?: NodeJS.ProcessEnv } = {};
  const runner: Run = (command, args, options) => {
    if (command === "fleet") return vault(SECRETS)(command, args);
    if (command === "security" || (command === "xcrun" && args[0] === "notarytool"))
      return keychain(command, args, options);
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
      return build(args[1]!, args[2]!, options!.env!);
    }
    if (command === "ditto" && overrides[`ditto ${args[0]}`]) return overrides[`ditto ${args[0]}`]!;
    if (command === "ditto") {
      if (args[0] === "-x") mkdirSync(join(args.at(-1)!, "Clawtrate.app"), { recursive: true });
      return ok();
    }
    return mac(command, args, options);
  };
  return { runner, calls, seen };
}

const builds =
  (appDir: string, signed = "certificate") =>
  (out: string, version: string): RunResult => {
    // candidate-build.ts leaves electron-builder's output in dist.
    mkdirSync(join(appDir, "dist"));
    mkdirSync(out);
    for (const key of ["mac-arm64", "mac-x64"]) {
      writeFileSync(join(out, `Clawtrate-${version}-${key}.zip`), `zip of ${key}`);
      writeFileSync(
        join(out, `${key}.json`),
        JSON.stringify({ commit: COMMIT, packagerReadback: signed }),
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

  it("stages the zips, the Beta feed and latest-mac.json, and gives the build no secret", () => {
    const { runner, calls, seen } = tools(builds(place.appDir));
    prepare(runner, NOW, place);
    const out = join(place.staging, VERSION);
    expect(readdirSync(out).sort()).toEqual([
      ...ZIPS,
      "feed.json",
      "latest-mac.json",
      "notes.md",
      "release.json",
    ]);
    // The signing folder is gone, and so is dist.
    expect(readdirSync(place.temp)).toEqual([]);
    expect(existsSync(join(place.appDir, "dist"))).toBe(false);
    expect(seen.env!.CSC_KEYCHAIN).toMatch(
      new RegExp(`^${place.temp}/clawtrate-signing-[A-Za-z0-9]{6}/release\\.keychain-db$`),
    );
    expect(seen.env!.CSC_NAME).toBe(IDENTITY);
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
    });
    expect(stagedRelease(place.staging, VERSION)).toMatchObject({
      version: VERSION,
      tag: TAG,
      commit: COMMIT,
      teamId: TEAM,
    });
    expect(output.join("\n")).toContain(`pnpm release:beta --publish ${VERSION}`);
    const everything = [
      output.join("\n"),
      ...readdirSync(out).map((name) => readFileSync(join(out, name), "utf8")),
    ].join("\n");
    for (const secret of SECRET_TEXTS) expect(everything).not.toContain(secret);
  });

  it("prepares with the stand-ins whatever system the tests run on", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      prepare(tools(builds(place.appDir)).runner, NOW, place);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    expect(existsSync(join(place.staging, VERSION, "release.json"))).toBe(true);
  });

  it("names a failed build's log without printing it, and removes the signing folder", async () => {
    const log = join(place.root, "pack.log");
    const { runner } = tools(() => {
      writeFileSync(log, "Signing with Developer ID Application: Example (TEAMID1234)\n");
      return fail(`Error: Packaging failed (exit 1). Build log: ${log}\n    at build`);
    });
    const text = await stopped(() => prepare(runner, NOW, place));
    expect(text).toBe(`The build failed. Its log is ${log}; keep it private.`);
    expect(output.join("\n")).not.toContain("Signing with");
    expect(readdirSync(place.temp)).toEqual([]);
  });

  it("removes a signing folder a killed run left, and refuses while another run signs", async () => {
    const dead = join(place.temp, "clawtrate-signing-Abc123");
    mkdirSync(dead);
    writeFileSync(join(dead, "AuthKey_KEYID12345.p8"), "left behind");
    // A pid no process has: well above the system's limit.
    writeFileSync(join(dead, "pid"), "99999999");
    const unrelated = join(place.temp, "clawtrate-signing-test");
    mkdirSync(unrelated);
    prepare(tools(builds(place.appDir)).runner, NOW, place);
    expect(readdirSync(place.temp)).toEqual(["clawtrate-signing-test"]);
    expect(output.join("\n")).toContain(`Removed ${dead}, which an interrupted release left.`);

    rmSync(join(place.appDir, "dist"), { recursive: true, force: true });
    const live = join(place.temp, "clawtrate-signing-Def456");
    mkdirSync(live);
    writeFileSync(join(live, "pid"), String(process.ppid));
    expect(await stopped(() => prepare(tools(builds(place.appDir)).runner, NOW, place))).toBe(
      `Another release (pid ${process.ppid}) is signing from ${live}. Let it finish first.`,
    );
    expect(existsSync(live)).toBe(true);
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
});

/** Prepares the beta with the stand-ins and returns its places. */
function staged() {
  const place = places();
  prepare(tools(builds(place.appDir)).runner, NOW, place);
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
  beforeEach(() => {
    place = staged();
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
  ])("refuses it when %s", async (_name, change, message) => {
    change();
    expect(await stopped(() => stagedRelease(place.staging, VERSION))).toContain(message);
  });

  it("refuses a folder staged as another version", async () => {
    renameSync(dir, join(place.staging, "0.1.1-beta.20261120.3"));
    expect(await stopped(() => stagedRelease(place.staging, "0.1.1-beta.20261120.3"))).toContain(
      "must hold exactly",
    );
  });
});

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
    if (line === "gh auth status") return ok();
    if (line.startsWith("git fetch") || line.startsWith("git merge-base")) return ok();
    if (line.startsWith("git ls-remote")) return ok("");
    if (line.startsWith("gh api -H Accept: application/octet-stream")) {
      const id = Number(args.at(-1)!.split("/").at(-1));
      const team = options.teams?.[id];
      return team ? ok(JSON.stringify({ teamIdentifier: team })) : fail("Not Found");
    }
    if (line.startsWith("gh api repos/sidebandstudio/clawtrate/releases"))
      return ok(releases.map((row) => `${JSON.stringify(row)}\n`).join(""));
    if (line.startsWith("gh release create")) {
      const files = args.filter((arg) => arg.startsWith(dir) && !arg.endsWith("notes.md"));
      releases.push({
        tag_name: args[2]!,
        draft: true,
        prerelease: true,
        target_commitish: args[args.indexOf("--target") + 1]!,
        assets: files.map((path, id) => {
          const name = path.split("/").at(-1)!;
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
    return fail(`unexpected ${line}`);
  };
  return { runner, calls, releases, answers, digests };
}

/** The site and public downloads: each address answers from `pages`, or 404. */
function site(pages: Record<string, () => Promise<Response> | Response>): Net {
  return {
    get: async (url) => {
      const page = pages[url.split("?")[0]!];
      return page ? page() : new Response("", { status: 404 });
    },
    requestMs: 1_000,
    waitMs: 0,
    pollMs: 0,
  };
}

describe("publishing", () => {
  let place: ReturnType<typeof places>;
  let dir: string;
  let net: Net;
  beforeEach(() => {
    place = staged();
    dir = join(place.staging, VERSION);
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
    await publish(hub.runner, VERSION, net, place.staging);
    expect(published(hub.calls)).toBe(true);
    expect(output).toContain(
      "GitHub has no earlier beta: this is the first, so there is no signer to match.",
    );
    expect(output).toContain(`The draft ${TAG} holds the 4 prepared files, by digest.`);
    expect(output).toContain(`The Beta feed offers ${VERSION}.`);
  });

  it("refuses when origin/main cannot be refreshed, before creating anything", async () => {
    const hub = github(dir);
    hub.answers["git fetch"] = fail("could not resolve host");
    expect(await stopped(() => publish(hub.runner, VERSION, net, place.staging))).toBe(
      "Could not refresh origin/main from GitHub. Nothing was published.",
    );
    expect(hub.calls.some((call) => call[1] === "release")).toBe(false);
  });

  it("leaves the draft unpublished when GitHub's digest of a file is not the prepared one", async () => {
    const hub = github(dir);
    hub.digests[ZIPS[1]!] = `sha256:${sha256("same size, other bytes")}`;
    expect(await stopped(() => publish(hub.runner, VERSION, net, place.staging))).toBe(
      `GitHub's digest of the draft's ${ZIPS[1]} is not the prepared file's. It was left a draft: delete it and publish again.`,
    );
    expect(published(hub.calls)).toBe(false);
  });

  it("leaves the draft unpublished when GitHub reports no digest", async () => {
    const hub = github(dir);
    hub.digests[ZIPS[0]!] = "";
    expect(await stopped(() => publish(hub.runner, VERSION, net, place.staging))).toContain(
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
    expect(await stopped(() => publish(dropping, VERSION, net, place.staging))).toContain(
      `The draft holds ${[...ZIPS, "feed.json"].sort().join(", ")}, not`,
    );
    expect(published(hub.calls)).toBe(false);
  });

  const earlier = (tag: string, draft = false): ReleaseRow => ({
    tag_name: tag,
    draft,
    prerelease: true,
    assets: [{ id: 7, name: "latest-mac.json", browser_download_url: "unused" }],
  });

  it("refuses another signer than an earlier beta's, published or withdrawn", async () => {
    for (const draft of [false, true]) {
      const hub = github(dir, {
        earlier: [earlier("v0.1.1-beta.20261119.1", draft)],
        teams: { 7: "OTHERTEAM1" },
      });
      expect(await stopped(() => publish(hub.runner, VERSION, net, place.staging))).toBe(
        `v0.1.1-beta.20261119.1 is signed by team OTHERTEAM1, this beta by ${TEAM}. Nothing was published.`,
      );
      expect(hub.calls.some((call) => call[1] === "release")).toBe(false);
    }
  });

  it("refuses when an earlier beta's team cannot be read, rather than treat it as the first", async () => {
    const hub = github(dir, { earlier: [earlier("v0.1.1-beta.20261119.1")], teams: {} });
    expect(await stopped(() => publish(hub.runner, VERSION, net, place.staging))).toBe(
      "Could not read the team of v0.1.1-beta.20261119.1 from GitHub. Nothing was published.",
    );
    const offline = github(dir);
    offline.answers["gh api repos/sidebandstudio/clawtrate/releases"] = fail("HTTP 503");
    expect(await stopped(() => publish(offline.runner, VERSION, net, place.staging))).toBe(
      "Could not read the repository's releases from GitHub.",
    );
  });

  it("accepts the signer of every earlier beta when it is this one", async () => {
    const hub = github(dir, { earlier: [earlier("v0.1.1-beta.20261119.1")], teams: { 7: TEAM } });
    await publish(hub.runner, VERSION, net, place.staging);
    expect(output).toContain(`Signed by team ${TEAM}, as every earlier beta (1).`);
  });
});

describe("withdrawing", () => {
  const older = "0.1.1-beta.20261119.1";
  const row = (version: string, draft: boolean): ReleaseRow => ({
    tag_name: `v${version}`,
    draft,
    prerelease: true,
    assets: [
      "feed.json",
      "latest-mac.json",
      `Clawtrate-${version}-mac-arm64.zip`,
      `Clawtrate-${version}-mac-x64.zip`,
    ].map((name) => ({ name, browser_download_url: `${releaseFolder(`v${version}`)}${name}` })),
  });
  const feed = (version: string) =>
    JSON.stringify({
      format: 1,
      track: "nightly",
      version,
      releaseDate: "2026-11-20T18:00:00.000Z",
      files: {
        "mac-arm64": {
          url: `${releaseFolder(`v${version}`)}Clawtrate-${version}-mac-arm64.zip`,
          size: 10,
          sha512: Buffer.alloc(64, 1).toString("base64"),
        },
      },
    });
  const hub = (withOlder: boolean) => {
    const made = github("/nowhere", {
      earlier: [...(withOlder ? [row(older, false)] : []), row(VERSION, false)],
    });
    return made;
  };
  const serving = (answer: () => Promise<Response> | Response) => site({ [BETA_FEED_URL]: answer });

  it("reports the draft GitHub lists and the older beta the site now offers", async () => {
    await withdraw(
      hub(true).runner,
      VERSION,
      serving(() => new Response(feed(older))),
    );
    expect(output).toEqual([
      `GitHub lists ${TAG} as a draft. Its download addresses can still answer from caches for a while.`,
      `Waiting for ${BETA_FEED_URL} to offer ${older}…`,
      `The Beta feed offers ${older}.`,
    ]);
  });

  it("reports no beta only when the site has no feed and GitHub lists no published beta", async () => {
    await withdraw(
      hub(false).runner,
      VERSION,
      serving(() => new Response("", { status: 404 })),
    );
    expect(output.at(-1)).toBe("The site serves no Beta feed, and GitHub lists no published beta.");
    expect(
      await stopped(() =>
        withdraw(
          hub(true).runner,
          VERSION,
          serving(() => new Response("", { status: 404 })),
        ),
      ),
    ).toBe(
      `The site serves no Beta feed, though GitHub lists v${older} as published. Run the Site workflow.`,
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
      waitMs: 0,
      pollMs: 0,
    };
    expect(await stopped(() => withdraw(hub(false).runner, VERSION, hanging))).toBe(
      `Could not tell what the site serves (no answer in time). Check ${BETA_FEED_URL} yourself.`,
    );
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
    ).toBe(`The site still offers ${VERSION}. Run the Site workflow and run this again.`);
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
    ).toBe(`GitHub still lists ${TAG} as published.`);
  });
});
