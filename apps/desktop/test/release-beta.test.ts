// The beta release script without a signing identity: every outside tool
// (the vault, git, gh, the build, ditto, codesign, spctl, stapler) is a
// stand-in, so these checks show what the script does with their answers, and
// that no secret reaches its output, the staging folder or a leftover file.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  main,
  nextRun,
  p12Bytes,
  p8Text,
  prepare,
  preparedRelease,
  readSecrets,
  readSignature,
  redact,
  SECRET_NAMES,
  signingEnvironment,
  Stop,
  verifyApp,
  type Run,
  type RunResult,
  type Secrets,
} from "../packaging/release-beta.ts";
import { signingPlan, signingProblems } from "../packaging/signing.ts";
import { parseFeed } from "../src/main/update/feed.ts";
import { BETA_FEED_URL, checkBetaFiles } from "../packaging/beta-files.ts";

const KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgmadeupmadeupmadeup",
  "madeupmadeupmadeupmadeupmadeupmadeupmadeupmadeupmadeupmadeupmade",
  "-----END PRIVATE KEY-----",
].join("\n");
const SECRETS: Secrets = {
  APPLE_CLAWTRATE_DEVELOPER_ID_P12_BASE64: Buffer.from("made-up certificate bytes").toString(
    "base64",
  ),
  APPLE_CLAWTRATE_DEVELOPER_ID_P12_PASSWORD: "made-up-p12-password",
  APPLE_CLAWTRATE_NOTARY_API_KEY_P8: KEY,
  APPLE_CLAWTRATE_NOTARY_API_KEY_ID: "KEYID12345",
  APPLE_CLAWTRATE_NOTARY_ISSUER_ID: "00000000-made-up0-issuer-000000000000",
};
const TEAM = "TEAMID1234";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ok = (stdout = "", stderr = ""): RunResult => ({ status: 0, stdout, stderr });
const fail = (stderr = ""): RunResult => ({ status: 1, stdout: "", stderr });

/** The vault answers as `fleet secret get` does: the value and a newline. */
function vault(secrets: Partial<Secrets>): Run {
  return (command, args) =>
    command === "fleet" && secrets[args[2] as keyof Secrets] !== undefined
      ? ok(`${secrets[args[2] as keyof Secrets]}\n`)
      : fail("not found");
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
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((text) => void errors.push(String(text)));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const calls: string[] = [];
    const partial = { ...SECRETS } as Partial<Secrets>;
    delete partial.APPLE_CLAWTRATE_DEVELOPER_ID_P12_BASE64;
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("clawtrate-release-"));
    const code = await main([], (command, args) => {
      calls.push(command);
      return vault(partial)(command, args);
    });
    expect(code).toBe(1);
    expect(calls.every((command) => command === "fleet")).toBe(true);
    expect(errors.join("\n")).toContain(
      "The vault has no value for APPLE_CLAWTRATE_DEVELOPER_ID_P12_BASE64.",
    );
    for (const value of Object.values(partial)) expect(errors.join("\n")).not.toContain(value);
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith("clawtrate-release-"))).toEqual(
      before,
    );
    vi.restoreAllMocks();
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

  it("redacts every secret and every long line of the key", () => {
    const text = `password ${SECRETS.APPLE_CLAWTRATE_DEVELOPER_ID_P12_PASSWORD} and ${KEY.split("\n")[1]}`;
    const out = redact(text, Object.values(SECRETS));
    expect(out).toBe("password [redacted] and [redacted]");
  });
});

describe("the build's environment", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clawtrate-release-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("signs with the vault's certificate and notarizes with its API key, and nothing inherited", () => {
    const env = signingEnvironment(
      {
        PATH: "/usr/bin",
        CSC_NAME: "Some Identity",
        CSC_LINK: "/elsewhere.p12",
        WIN_CSC_LINK: "/elsewhere.pfx",
        APPLE_ID: "someone",
        APPLE_KEYCHAIN_PROFILE: "profile",
        CLAWTRATE_UPDATE_FEED_URL: "https://elsewhere.example/feed.json",
        TMPDIR: "/elsewhere",
      },
      SECRETS,
      dir,
      1_790_000_000,
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      CSC_LINK: join(dir, "developer-id.p12"),
      CSC_KEY_PASSWORD: SECRETS.APPLE_CLAWTRATE_DEVELOPER_ID_P12_PASSWORD,
      APPLE_API_KEY: join(dir, "AuthKey_KEYID12345.p8"),
      APPLE_API_KEY_ID: "KEYID12345",
      APPLE_API_ISSUER: SECRETS.APPLE_CLAWTRATE_NOTARY_ISSUER_ID,
      CLAWTRATE_NIGHTLY_UPDATE_FEED_URL: BETA_FEED_URL,
      SOURCE_DATE_EPOCH: "1790000000",
      TMPDIR: dir,
    });
    expect(signingPlan(env)).toEqual({
      mac: "developer-id",
      notarize: "api-key",
      windows: "certificate",
    });
    expect(signingProblems(env, "mac")).toEqual([]);
    expect(readFileSync(env.CSC_LINK!).toString()).toBe("made-up certificate bytes");
    expect(readFileSync(env.APPLE_API_KEY!, "utf8")).toBe(`${KEY}\n`);
    for (const file of readdirSync(dir)) expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
  });

  it("refuses a key id that is not Apple's form, before writing anything", () => {
    expect(() =>
      signingEnvironment({}, { ...SECRETS, APPLE_CLAWTRATE_NOTARY_API_KEY_ID: "short" }, dir, 0),
    ).toThrow("APPLE_CLAWTRATE_NOTARY_API_KEY_ID is not ten letters or digits.");
    expect(readdirSync(dir)).toEqual([]);
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
function macTools(version: string, overrides: Record<string, RunResult> = {}): Run {
  return (command, args) => {
    const key = `${command} ${args[0]}`;
    if (overrides[key]) return overrides[key]!;
    const app = args.at(-1)!;
    if (command === "plutil")
      return ok(args[1] === "CFBundleIdentifier" ? "dev.clawtrate.desktop\n" : `${version}\n`);
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

  it("reads the team from the signature", () => {
    expect(verifyApp(macTools(expected.version), app, expected)).toEqual({ teamId: TEAM });
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
    expect(() => verifyApp(macTools(expected.version, { [tool]: answer }), app, expected)).toThrow(
      check,
    );
  });

  it("refuses another bundle id or version", () => {
    expect(() => verifyApp(macTools("0.1.0"), app, expected)).toThrow(
      `version ${expected.version}`,
    );
  });
});

describe("preparing a beta from start to finish, with stand-ins for every tool", () => {
  let root: string;
  let appDir: string;
  let staging: string;
  let output: string[];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clawtrate-release-test-"));
    appDir = join(root, "app");
    staging = join(root, "staging");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ version: "0.1.0" }));
    output = [];
    for (const stream of ["log", "error"] as const)
      vi.spyOn(console, stream).mockImplementation((text) => void output.push(String(text)));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  /** git, gh, the vault, candidate-build.ts and the Mac tools. */
  function tools(build: (out: string, version: string, env: NodeJS.ProcessEnv) => RunResult): {
    runner: Run;
    seen: { certificateMode?: number; tempDir?: string };
  } {
    const seen: { certificateMode?: number; tempDir?: string } = {};
    const mac = macTools("");
    const runner: Run = (command, args, options) => {
      if (command === "fleet") return vault(SECRETS)(command, args);
      if (command === "git" && args[0] === "status") return ok("");
      if (command === "git" && args[0] === "rev-parse") return ok(`${COMMIT}\n`);
      if (command === "git" && args[0] === "ls-remote")
        return ok(`${COMMIT}\trefs/tags/v0.1.1-beta.20261120.1\n`);
      if (command === "gh") return ok("v0.1.0-beta.20261101.1\n");
      if (command === process.execPath) {
        const env = options!.env!;
        seen.certificateMode = statSync(env.CSC_LINK!).mode & 0o777;
        seen.tempDir = env.TMPDIR!;
        return build(args[1]!, args[2]!, env);
      }
      if (command === "ditto") {
        mkdirSync(join(args.at(-1)!, "Clawtrate.app"), { recursive: true });
        return ok();
      }
      if (command === "plutil" && args[1] === "CFBundleShortVersionString")
        return ok(`${current}\n`);
      return mac(command, args);
    };
    let current = "";
    const wrapped: Run = (command, args, options) => {
      if (command === process.execPath) current = args[2]!;
      return runner(command, args, options);
    };
    return { runner: wrapped, seen };
  }

  const builds =
    (signed = "certificate") =>
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

  it("stages the zips, the Beta feed and latest-mac.json, and leaves no secret anywhere", () => {
    const { runner, seen } = tools(builds());
    prepare(runner, new Date("2026-11-20T18:00:00Z"), { staging, appDir });
    const version = "0.1.1-beta.20261120.2";
    const out = join(staging, version);
    expect(readdirSync(out).sort()).toEqual([
      `Clawtrate-${version}-mac-arm64.zip`,
      `Clawtrate-${version}-mac-x64.zip`,
      "feed.json",
      "latest-mac.json",
      "notes.md",
      "release.json",
    ]);
    expect(seen.certificateMode).toBe(0o600);
    expect(existsSync(seen.tempDir!)).toBe(false);
    expect(existsSync(join(appDir, "dist"))).toBe(false);

    const tag = `v${version}`;
    const download = `https://github.com/sidebandstudio/clawtrate/releases/download/${tag}/`;
    const feedText = readFileSync(join(out, "feed.json"), "utf8");
    const latestText = readFileSync(join(out, "latest-mac.json"), "utf8");
    expect(checkBetaFiles(tag, feedText, latestText)).toEqual({
      feed: feedText,
      latest: latestText,
    });
    expect(
      parseFeed(feedText, new URL(BETA_FEED_URL), "mac-x64", undefined, "nightly"),
    ).toMatchObject({
      ok: true,
    });
    const sha256 = (key: string) => createHash("sha256").update(`zip of ${key}`).digest("hex");
    expect(JSON.parse(latestText)).toEqual({
      teamId: TEAM,
      arm64: {
        version,
        url: `${download}Clawtrate-${version}-mac-arm64.zip`,
        sha256: sha256("mac-arm64"),
      },
      x86_64: {
        version,
        url: `${download}Clawtrate-${version}-mac-x64.zip`,
        sha256: sha256("mac-x64"),
      },
    });
    expect(JSON.parse(feedText)).toMatchObject({
      track: "nightly",
      version,
      releaseDate: "2026-11-20T18:00:00.000Z",
    });
    expect(preparedRelease(out)).toMatchObject({ version, tag, commit: COMMIT, teamId: TEAM });
    expect(output.join("\n")).toContain(`pnpm release:beta --publish ${version}`);

    const everything = [
      output.join("\n"),
      ...readdirSync(out).map((name) => readFileSync(join(out, name), "utf8")),
    ].join("\n");
    for (const value of Object.values(SECRETS)) expect(everything).not.toContain(value);
    for (const line of KEY.split("\n").slice(1, 3)) expect(everything).not.toContain(line);

    writeFileSync(join(out, `Clawtrate-${version}-mac-x64.zip`), "zip of something else");
    expect(() => preparedRelease(out)).toThrow(
      `Clawtrate-${version}-mac-x64.zip changed since it was prepared.`,
    );
  });

  it("prints a failed build's log with every secret redacted, and removes the key folder", () => {
    const { runner, seen } = tools((_out, _version, env) => {
      const logDir = join(env.TMPDIR!, "clawtrate-pack-abc");
      mkdirSync(logDir);
      writeFileSync(
        join(logDir, "pack.log"),
        `signing with password ${env.CSC_KEY_PASSWORD}\n${KEY}\nnotarize failed\n`,
      );
      return fail("Packaging failed (exit 1).");
    });
    expect(() => prepare(runner, new Date("2026-11-20T18:00:00Z"), { staging, appDir })).toThrow(
      Stop,
    );
    expect(existsSync(seen.tempDir!)).toBe(false);
    let message = "";
    try {
      prepare(runner, new Date("2026-11-20T18:00:00Z"), { staging, appDir });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("notarize failed");
    expect(message).toContain("signing with password [redacted]");
    for (const value of Object.values(SECRETS)) expect(message).not.toContain(value);
  });

  it("refuses an app the packager did not sign with the certificate", () => {
    const { runner } = tools(builds("ad hoc"));
    expect(() => prepare(runner, new Date("2026-11-20T18:00:00Z"), { staging, appDir })).toThrow(
      "mac-arm64 was not signed with a certificate by this commit's build.",
    );
  });

  it("builds only from a clean checkout", () => {
    const { runner } = tools(builds());
    const dirty: Run = (command, args, options) =>
      command === "git" && args[0] === "status" ? ok(" M file\n") : runner(command, args, options);
    expect(() => prepare(dirty, new Date(), { staging, appDir })).toThrow("clean checkout");
  });
});
