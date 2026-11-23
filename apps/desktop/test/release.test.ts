// The release side of packaging, without any identity: which signing a build
// does and the line it prints, the constants it writes for the update engine,
// and the feed it writes for its artifacts. Every value here is made up.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { artifactName, makeFeed } from "../packaging/feed.ts";
import {
  checkMacSignature,
  checkWindowsSignature,
  macSignatureKind,
  signingPlan,
  signingProblems,
  signingSummary,
  WINDOWS_SIGNATURE_COMMAND,
  windowsSignatureEnv,
  windowsSignatureKind,
} from "../packaging/signing.ts";
import { releaseDate, updateDefines } from "../packaging/update-defines.ts";
import { parseFeed } from "../src/main/update/feed.ts";

const APP = join(import.meta.dirname, "..");

describe("signing", () => {
  it("without identities, signs ad hoc, notarizes nothing, leaves Windows unsigned and says so", () => {
    const plan = signingPlan({});
    expect(plan).toEqual({ mac: "ad-hoc", notarize: null, windows: "unsigned" });
    expect(signingProblems({}, "mac")).toEqual([]);
    expect(signingSummary(plan, "mac")).toBe(
      "Signing plan: none. The macOS app will be signed ad hoc and not notarized.",
    );
    expect(signingSummary(plan, "win")).toBe(
      "Signing plan: none. The Windows installer will be unsigned.",
    );
  });

  it("signs and notarizes from the owner's variables, naming the method and never a value", () => {
    const apple = { APPLE_ID: "a", APPLE_APP_SPECIFIC_PASSWORD: "b", APPLE_TEAM_ID: "c" };
    const key = { APPLE_API_KEY: "k.p8", APPLE_API_KEY_ID: "d", APPLE_API_ISSUER: "e" };
    const cert = { CSC_LINK: "x", CSC_KEY_PASSWORD: "y" };
    expect(signingPlan({ CSC_NAME: "x", ...apple }).notarize).toBe("apple-id");
    expect(signingPlan({ ...cert, ...key }).notarize).toBe("api-key");
    expect(signingPlan({ ...cert, APPLE_KEYCHAIN_PROFILE: "p" }).notarize).toBe("keychain-profile");
    expect(signingPlan(cert)).toEqual({
      mac: "developer-id",
      notarize: null,
      windows: "certificate",
    });
    expect(signingProblems(cert, "mac")).toEqual([]);
    expect(signingProblems(cert, "win")).toEqual([]);
    expect(signingPlan({ WIN_CSC_LINK: "x", WIN_CSC_KEY_PASSWORD: "y" }).windows).toBe(
      "certificate",
    );
    const summary = signingSummary(
      signingPlan({ CSC_LINK: "secret-file", CSC_KEY_PASSWORD: "y", ...key }),
      "mac",
    );
    expect(summary).toBe(
      "Signing plan: the macOS app will be signed with a Developer ID and notarized (api-key).",
    );
    expect(summary).not.toMatch(/secret|k\.p8/);
    expect(
      signingSummary(
        signingPlan({ WIN_CSC_LINK: "secret-file", WIN_CSC_KEY_PASSWORD: "y" }),
        "win",
      ),
    ).not.toMatch(/secret/);
    const inputs = {
      CSC_LINK: "data:application/x-pkcs12;base64,Rml4dHVyZQ==",
      CSC_KEY_PASSWORD: "FixturePassWord",
      APPLE_API_KEY: "FixtureNotaryKey",
    };
    for (const target of ["mac", "win"] as const) {
      const planLine = signingSummary(signingPlan(inputs), target);
      const partialErrors = signingProblems(inputs, target);
      if (target === "mac") {
        expect(partialErrors).toEqual([
          "APPLE_API_KEY set without APPLE_API_KEY_ID, APPLE_API_ISSUER",
        ]);
      }
      for (const value of Object.values(inputs)) {
        expect(planLine).not.toContain(value);
        expect(partialErrors.join("\n")).not.toContain(value);
      }
    }
  });

  it("takes a certificate and its password together, read as electron-builder reads them, on each system", () => {
    // A certificate alone, or a password alone, never becomes a silent unsigned or passwordless build.
    expect(signingProblems({ CSC_LINK: "x" }, "mac")).toEqual([
      "CSC_LINK set without CSC_KEY_PASSWORD (set it empty for a certificate without a password)",
    ]);
    expect(signingProblems({ CSC_KEY_PASSWORD: "y" }, "mac")).toEqual([
      "CSC_KEY_PASSWORD set without CSC_LINK",
    ]);
    expect(signingProblems({ CSC_NAME: "n", CSC_KEY_PASSWORD: "y" }, "mac")).toEqual([
      "CSC_KEY_PASSWORD set without CSC_LINK",
    ]);
    expect(signingProblems({ WIN_CSC_LINK: "x" }, "win")).toEqual([
      "WIN_CSC_LINK set without WIN_CSC_KEY_PASSWORD or CSC_KEY_PASSWORD (set it empty for a certificate without a password)",
    ]);
    expect(signingProblems({ CSC_LINK: "x" }, "win")).toEqual([
      "CSC_LINK set without WIN_CSC_KEY_PASSWORD or CSC_KEY_PASSWORD (set it empty for a certificate without a password)",
    ]);
    expect(signingProblems({ WIN_CSC_KEY_PASSWORD: "y" }, "win")).toEqual([
      "WIN_CSC_KEY_PASSWORD set without WIN_CSC_LINK or CSC_LINK",
    ]);
    // Windows falls back to the generic variables, each on its own.
    expect(signingProblems({ WIN_CSC_LINK: "x", CSC_KEY_PASSWORD: "y" }, "win")).toEqual([]);
    expect(signingProblems({ CSC_LINK: "x", WIN_CSC_KEY_PASSWORD: "y" }, "win")).toEqual([]);
    // A certificate without a password, only when the password is set empty on purpose.
    expect(signingProblems({ CSC_LINK: "x", CSC_KEY_PASSWORD: "" }, "mac")).toEqual([]);
    expect(signingProblems({ WIN_CSC_LINK: "x", WIN_CSC_KEY_PASSWORD: "" }, "win")).toEqual([]);
    for (const target of ["mac", "win"] as const) {
      expect(signingProblems({ CSC_LINK: "x", CSC_KEY_PASSWORD: " " }, target)).toEqual([
        "CSC_KEY_PASSWORD contains only whitespace (set it empty for a certificate without a password)",
      ]);
    }
    // A blank variable electron-builder would take instead of a good one after it.
    expect(
      signingProblems({ WIN_CSC_LINK: "", CSC_LINK: "x", CSC_KEY_PASSWORD: "y" }, "win"),
    ).toEqual(["WIN_CSC_LINK is set but blank, and hides CSC_LINK"]);
    expect(signingPlan({ WIN_CSC_LINK: "", CSC_LINK: "x" }).windows).toBe("unsigned");
    expect(
      signingProblems(
        { WIN_CSC_LINK: "x", WIN_CSC_KEY_PASSWORD: " ", CSC_KEY_PASSWORD: "y" },
        "win",
      ),
    ).toEqual(["WIN_CSC_KEY_PASSWORD is set but blank, and hides CSC_KEY_PASSWORD"]);
    expect(signingProblems({ CSC_LINK: " " }, "mac")).toEqual(["CSC_LINK is set but blank"]);
    // A system's build reads only its own variables.
    expect(signingProblems({ WIN_CSC_LINK: "x" }, "mac")).toEqual([]);
    expect(signingProblems({ CSC_NAME: "n" }, "mac")).toEqual([]);
  });

  it("stops on a partial set, or on notarizing without an identity, naming only the variables", () => {
    const cert = { CSC_LINK: "x", CSC_KEY_PASSWORD: "y" };
    expect(signingProblems({ ...cert, APPLE_ID: "someone" }, "mac")).toEqual([
      "APPLE_ID set without APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID",
    ]);
    expect(signingProblems({ ...cert, APPLE_API_KEY: "k", APPLE_API_ISSUER: "i" }, "mac")).toEqual([
      "APPLE_API_KEY, APPLE_API_ISSUER set without APPLE_API_KEY_ID",
    ]);
    expect(signingProblems({ ...cert, APPLE_KEYCHAIN: "k" }, "mac")).toEqual([
      "APPLE_KEYCHAIN set without APPLE_KEYCHAIN_PROFILE",
    ]);
    expect(signingProblems({ APPLE_KEYCHAIN_PROFILE: "p" }, "mac")).toEqual([
      "notarizing credentials set without CSC_LINK or CSC_NAME to sign with",
    ]);
    expect(signingProblems({ APPLE_ID: "someone" }, "win")).toEqual([]);
  });

  it("refuses a blank notarizing value, so the build and electron-builder pick the same method", () => {
    const cert = { CSC_LINK: "x", CSC_KEY_PASSWORD: "y" };
    const key = { APPLE_API_KEY: "k.p8", APPLE_API_KEY_ID: "d", APPLE_API_ISSUER: "e" };
    // electron-builder would take this APPLE_ID and stop for its missing password after signing.
    expect(signingProblems({ ...cert, ...key, APPLE_ID: " " }, "mac")).toEqual([
      "APPLE_ID is set but blank",
    ]);
    expect(signingProblems({ ...cert, APPLE_KEYCHAIN_PROFILE: "\t" }, "mac")).toEqual([
      "APPLE_KEYCHAIN_PROFILE is set but blank",
    ]);
    expect(signingProblems({ ...cert, CSC_NAME: " " }, "mac")).toEqual([
      "CSC_NAME is set but blank",
    ]);
    expect(signingProblems({ ...cert, ...key }, "mac")).toEqual([]);
  });

  it("reads what codesign says of a bundle's signature", () => {
    expect(
      macSignatureKind(
        "Executable=/x\nIdentifier=dev.clawtrate.desktop\nSignature=adhoc\nTeamIdentifier=not set\n",
      ),
    ).toBe("ad hoc");
    expect(
      macSignatureKind(
        "Identifier=dev.clawtrate.desktop\nAuthority=Developer ID Application: Example (ABCDE12345)\nAuthority=Apple Root CA\n",
      ),
    ).toBe("certificate");
    expect(macSignatureKind("x: code object is not signed at all\n")).toBe("none");
  });

  it("the build prints the plan before building and checks the signature after", () => {
    const build = readFileSync(join(APP, "packaging/build.ts"), "utf8");
    expect(build).toContain("signingProblems(process.env, target)");
    expect(build).toContain("console.log(signingSummary(plan, target));");
    expect(build).toContain('spawnSync("codesign", ["--display", "--verbose=2", app]');
    expect(build).toContain('"-Command", WINDOWS_SIGNATURE_COMMAND]');
    expect(build).toContain("checkWindowsSignature(plan.windows, shown)");
    expect(build.indexOf("signingSummary(")).toBeLessThan(build.indexOf("await build("));
    expect(build.indexOf("await build(")).toBeLessThan(build.indexOf("checkWindowsSignature("));
  });

  it("a failed check fails the build, though electron-builder's exit hook ends with 0, and keeps any other failing status", () => {
    // electron-builder → app-builder-lib → temp-file → async-exit-hook, which calls
    // process.exit(0) from its beforeExit handler, and process.exit(130) on SIGINT.
    const from = (base: string, name: string) => createRequire(base).resolve(name);
    const builder = from(join(APP, "package.json"), "electron-builder");
    const exitHook = from(from(from(builder, "app-builder-lib"), "temp-file"), "async-exit-hook");
    // Like temp-file's, the hook cleans up at once when it gets no callback, as on process.exit().
    const run = (fail: string) =>
      spawnSync(process.execPath, [
        "-e",
        `require(${JSON.stringify(exitHook)})((done) => done && setTimeout(done, 10)); ${fail}`,
      ]).status;
    const listener =
      'process.on("exit", (code) => {\n    if (code === 0) process.exitCode = 1;\n  });';
    expect(run("process.exitCode = 1;")).toBe(0);
    expect(run(listener)).toBe(1);
    expect(run(`${listener} process.exit(7);`)).toBe(7);
    expect(run(`${listener} process.exit(130);`)).toBe(130);
    // A listener that always sets 1 replaces them.
    expect(run('process.on("exit", () => (process.exitCode = 1)); process.exit(130);')).toBe(1);
    const build = readFileSync(join(APP, "packaging/build.ts"), "utf8").replaceAll("\r\n", "\n");
    expect(build).toContain(listener);
    // Registered once, however many checks fail.
    expect(build.match(/process\.on\("exit"/g)).toHaveLength(1);
    expect(build).toContain("if (failed) return;\n  failed = true;\n  process.on(");
    expect(build).not.toMatch(/^\s*process\.exitCode = 1;/m);
    expect(build.match(/if \(!matches\) failCheck\(SIGNATURE_DIFFERS\);/g)).toHaveLength(2);
  });

  it("reads a Windows signature without PowerShell 7's module path, and stops at any error", () => {
    expect(
      windowsSignatureEnv(
        { PATH: "p", PSModulePath: "C:\\pwsh7\\Modules", PSMODULEPATH: "q", SIGNED_FILE: "old" },
        "D:\\out\\Clawtrate.exe",
      ),
    ).toEqual({ PATH: "p", SIGNED_FILE: "D:\\out\\Clawtrate.exe" });
    // Without it, a command that cannot be found prints its error and the command goes on.
    expect(WINDOWS_SIGNATURE_COMMAND).toMatch(/^\$ErrorActionPreference = 'Stop'; /);
  });

  it("reads what Get-AuthenticodeSignature says of a Windows file's signature", () => {
    expect(WINDOWS_SIGNATURE_COMMAND).toContain("-LiteralPath $env:SIGNED_FILE");
    expect(windowsSignatureKind("NotSigned False\r\n")).toBe("none");
    expect(windowsSignatureKind("Valid True\r\n")).toBe("certificate");
    // A certificate no root on the machine vouches for, such as CI's throwaway one.
    expect(windowsSignatureKind("UnknownError True\r\n")).toBe("certificate");
    expect(windowsSignatureKind("NotTrusted True")).toBe("certificate");
    // A file changed after signing, or a status that names no signer.
    expect(windowsSignatureKind("HashMismatch True")).toBe("invalid");
    expect(windowsSignatureKind("UnknownError False")).toBe("invalid");
    expect(windowsSignatureKind("NotSupportedFileFormat False")).toBe("invalid");
    expect(windowsSignatureKind("")).toBe("invalid");
  });

  it("requires a successful readback of the requested signature on each Windows file", () => {
    const none = { status: 0, stdout: "NotSigned False\r\n" };
    const certificate = { status: 0, stdout: "UnknownError True\r\n" };
    expect(checkWindowsSignature("unsigned", none)).toEqual({ kind: "none", matches: true });
    expect(checkWindowsSignature("certificate", certificate)).toEqual({
      kind: "certificate",
      matches: true,
    });
    expect(checkWindowsSignature("unsigned", certificate).matches).toBe(false);
    expect(checkWindowsSignature("certificate", none).matches).toBe(false);
    for (const plan of ["unsigned", "certificate"] as const) {
      for (const result of [
        { status: 1, stdout: "NotSigned False\r\n" },
        { status: 1, stdout: "Valid True\r\n" },
        { status: 0, stdout: "HashMismatch True\r\n" },
        { status: null, stdout: null },
      ]) {
        expect(checkWindowsSignature(plan, result)).toEqual({ kind: "invalid", matches: false });
      }
    }
  });

  it("requires a successful readback of the requested signature on each macOS bundle", () => {
    const adHoc = { status: 0, stderr: "Signature=adhoc\n" };
    const certificate = { status: 0, stderr: "Authority=Example\n" };
    expect(checkMacSignature("ad-hoc", adHoc).matches).toBe(true);
    expect(checkMacSignature("developer-id", certificate).matches).toBe(true);
    expect(checkMacSignature("ad-hoc", certificate).matches).toBe(false);
    expect(checkMacSignature("developer-id", adHoc).matches).toBe(false);
    for (const plan of ["ad-hoc", "developer-id"] as const) {
      for (const result of [
        { status: 1, stderr: "Signature=adhoc\n" },
        { status: 1, stderr: "Authority=Example\n" },
        { status: 0, stderr: "code object is not signed at all" },
        { status: null, stderr: null },
      ]) {
        expect(checkMacSignature(plan, result)).toEqual({ kind: "none", matches: false });
      }
    }
  });
});

describe("the constants the build writes for the update engine", () => {
  const now = new Date("2026-11-19T12:00:00.000Z");

  it("without a feed address the build has none, and its release date is the build's time", () => {
    expect(updateDefines({}, now)).toEqual({
      __CLAWTRATE_SIGNED_MAC__: "false",
      __CLAWTRATE_SIGNED_WINDOWS__: "false",
      __CLAWTRATE_UPDATE_FEED__: "null",
      __CLAWTRATE_NIGHTLY_UPDATE_FEED__: "null",
      __CLAWTRATE_RELEASE_DATE__: JSON.stringify("2026-11-19T12:00:00.000Z"),
    });
  });

  it("records signing requests separately for each platform", () => {
    expect(updateDefines({ WIN_CSC_LINK: "fixture" }, now).__CLAWTRATE_SIGNED_WINDOWS__).toBe(
      "true",
    );
    expect(updateDefines({ CSC_NAME: "fixture" }, now).__CLAWTRATE_SIGNED_MAC__).toBe("true");
  });

  it("fixes the optional nightly address under the same build rules", () => {
    const env = { CLAWTRATE_UPDATE_FEED_URL: "https://updates.example/stable" };
    const url = "https://updates.example/nightly";
    expect(
      updateDefines({ ...env, CLAWTRATE_NIGHTLY_UPDATE_FEED_URL: url }, now)
        .__CLAWTRATE_NIGHTLY_UPDATE_FEED__,
    ).toBe(JSON.stringify(url));
    expect(updateDefines({ CLAWTRATE_NIGHTLY_UPDATE_FEED_URL: url }, now)).toMatchObject({
      __CLAWTRATE_UPDATE_FEED__: "null",
      __CLAWTRATE_NIGHTLY_UPDATE_FEED__: JSON.stringify(url),
    });
    expect(() =>
      updateDefines(
        { ...env, CLAWTRATE_NIGHTLY_UPDATE_FEED_URL: "http://updates.example/nightly" },
        now,
      ),
    ).toThrow(/https/);
  });

  it("takes the feed address and SOURCE_DATE_EPOCH from the build's environment", () => {
    const defines = updateDefines(
      {
        CLAWTRATE_UPDATE_FEED_URL: "https://updates.example/clawtrate/feed.json",
        SOURCE_DATE_EPOCH: "1762000000",
      },
      now,
    );
    expect(defines.__CLAWTRATE_UPDATE_FEED__).toBe(
      JSON.stringify("https://updates.example/clawtrate/feed.json"),
    );
    expect(defines.__CLAWTRATE_RELEASE_DATE__).toBe(JSON.stringify("2025-11-01T12:26:40.000Z"));
  });

  it("refuses an address that is not https, carries credentials or is loopback, and a bad epoch", () => {
    for (const address of [
      "http://updates.example/feed.json",
      "https://u:p@updates.example/f",
      "https://127.0.0.1/f",
      "nonsense",
    ]) {
      expect(() => updateDefines({ CLAWTRATE_UPDATE_FEED_URL: address }, now), address).toThrow(
        /CLAWTRATE_UPDATE_FEED_URL/,
      );
    }
    expect(() => releaseDate({ SOURCE_DATE_EPOCH: "yesterday" }, now)).toThrow(/SOURCE_DATE_EPOCH/);
  });

  it("electron-vite writes them into the main process's bundle only", () => {
    const config = readFileSync(join(APP, "electron.vite.config.ts"), "utf8");
    expect(config).toContain("define: updateDefines(process.env, new Date()),");
    expect(config.indexOf("define:")).toBeLessThan(config.indexOf("preload:"));
  });
});

describe("the feed the release writes", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("labels a generated nightly feed from the validated package version", () => {
    dir = mkdtempSync(join(tmpdir(), "clawtrate-feed-"));
    const options = {
      dir,
      folder: "https://updates.example/nightly",
      releaseDate: "2026-11-01T00:00:00Z",
    };
    expect(makeFeed({ ...options, version: "1.0.0-beta.20261101.1" }).track).toBe("nightly");
    expect(() => makeFeed({ ...options, version: "1.0.0-alpha.1" })).toThrow(/version/);
  });

  it.each(["/releases", "/releases/", "/releases?dummy=1", "/releases#fixture"])(
    "keeps the installer in the supplied folder %s",
    (folder) => {
      dir = mkdtempSync(join(tmpdir(), "clawtrate-feed-"));
      writeFileSync(join(dir, artifactName("0.2.0", "win-x64")), "a Windows installer");
      const feed = makeFeed({
        version: "0.2.0",
        releaseDate: "2026-11-01T00:00:00.000Z",
        folder: `https://updates.example${folder}`,
        dir,
      });
      expect(feed.files["win-x64"]?.url).toBe(
        "https://updates.example/releases/Clawtrate-0.2.0-win-x64.exe",
      );
      expect(
        parseFeed(
          JSON.stringify(feed),
          new URL("https://updates.example/releases/feed.json"),
          "win-x64",
        ),
      ).toMatchObject({ ok: true, feed: { file: { size: 19 } } });
    },
  );

  it.each(["empty file", "directory"])(
    "refuses a Windows installer at an invalid path (%s)",
    (kind) => {
      dir = mkdtempSync(join(tmpdir(), "clawtrate-feed-"));
      writeFileSync(join(dir, artifactName("0.2.0", "mac-arm64")), "a macOS zip");
      const path = join(dir, artifactName("0.2.0", "win-x64"));
      if (kind === "directory") mkdirSync(path);
      else writeFileSync(path, "");
      const options = {
        version: "0.2.0",
        releaseDate: "2026-11-01T00:00:00.000Z",
        folder: "https://updates.example/releases",
        dir,
      };
      expect(() => makeFeed(options)).toThrow(new Error("win-x64 must be a non-empty artifact."));
    },
  );

  it("names each artifact with its size and SHA-512, and the engine reads it back", () => {
    dir = mkdtempSync(join(tmpdir(), "clawtrate-feed-"));
    const zip = Buffer.from("a macOS zip");
    const exe = Buffer.from("a Windows installer");
    writeFileSync(join(dir, artifactName("0.2.0", "mac-arm64")), zip);
    writeFileSync(join(dir, artifactName("0.2.0", "win-x64")), exe);
    const feed = makeFeed({
      version: "0.2.0",
      releaseDate: "2026-11-01T00:00:00.000Z",
      folder: "https://updates.example/clawtrate",
      dir,
    });
    expect(feed).toEqual({
      format: 1,
      track: "stable",
      version: "0.2.0",
      releaseDate: "2026-11-01T00:00:00.000Z",
      files: {
        "mac-arm64": {
          url: "https://updates.example/clawtrate/Clawtrate-0.2.0-mac-arm64.zip",
          size: zip.length,
          sha512: createHash("sha512").update(zip).digest("base64"),
        },
        "win-x64": {
          url: "https://updates.example/clawtrate/Clawtrate-0.2.0-win-x64.exe",
          size: exe.length,
          sha512: createHash("sha512").update(exe).digest("base64"),
        },
      },
    });
    const read = parseFeed(
      JSON.stringify(feed),
      new URL("https://updates.example/clawtrate/feed.json"),
      "win-x64",
    );
    expect(read).toMatchObject({
      ok: true,
      feed: { version: [0, 2, 0], file: { size: exe.length } },
    });
  });
});

it("accepts the example release feed in the decision", () => {
  const decisions = readFileSync(join(APP, "../../docs/decisions.md"), "utf8");
  const section = decisions.split("## Updates and release signing")[1]!;
  const example = section.match(/```json\s+([\s\S]*?)```/)![1]!;
  const result = parseFeed(
    example,
    new URL("https://updates.example/clawtrate/feed.json"),
    "mac-arm64",
  );
  expect(result).toMatchObject({ ok: true, feed: { file: { size: expect.any(Number) } } });
});
