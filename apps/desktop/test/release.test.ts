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
  windowsSignature,
  windowsSignatureArgs,
  windowsSignatureEnv,
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
    expect(build).toContain("readWindowsSignature(join(output.path, file), process.env)");
    expect(build).toContain("checkWindowsSignature(plan.windows, shown)");
    expect(build.indexOf("signingSummary(")).toBeLessThan(build.indexOf("await build("));
    expect(build.indexOf("await build(")).toBeLessThan(build.indexOf("checkWindowsSignature("));
    // The x64 installer by its expected name, not whichever .exe files the build lists.
    expect(build).toContain("const installer = `${PRODUCT_NAME}-${version}-win-x64.exe`;");
    expect(build).toContain("for (const file of [`win-unpacked/${PRODUCT_NAME}.exe`, installer])");
    expect(build).toContain(
      "if (!artifacts.some((file) => resolve(file) === join(output.path, installer)))",
    );
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

  it("reads Windows signatures with WinVerifyTrust, without PowerShell 7's module path, and stops at any error", () => {
    expect(
      windowsSignatureEnv(
        { PATH: "p", PSModulePath: "C:\\pwsh7\\Modules", PSMODULEPATH: "q", SIGNED_FILE: "old" },
        "D:\\out\\Clawtrate.exe",
      ),
    ).toEqual({ PATH: "p", SIGNED_FILE: "D:\\out\\Clawtrate.exe" });
    const script = readFileSync(join(APP, "packaging/authenticode.ps1"), "utf8");
    const args = windowsSignatureArgs();
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(Buffer.from(args[3]!, "base64").toString("utf16le")).toBe(script);
    // Without it, a command that cannot be found prints its error and the command goes on.
    expect(script).toMatch(/^\$ErrorActionPreference = 'Stop'\r?$/m);
    expect(script).toContain("[ClawtrateAuthenticode]::Read($env:SIGNED_FILE)");
    // The file's own signatures, never a catalog's, each one checked by its index.
    expect(script).toContain("data.dwUnionChoice = 1;");
    expect(script).toContain("settings.dwFlags = index == 0 ? 3u : 1u;");
  });

  describe("what WinVerifyTrust says of a Windows file's embedded signatures", () => {
    const SHA1 = "1.3.14.3.2.26";
    const SHA256 = "2.16.840.1.101.3.4.2.1";
    const SIGNER = "0123456789ABCDEF0123456789ABCDEF01234567";
    const OTHER = "89ABCDEF0123456789ABCDEF0123456789ABCDEF";
    const invalid = { kind: "invalid", signer: null };
    // electron-builder's default: SHA-1, then SHA-256 nested in it.
    const dual = (first: string, second = first, signers = [SIGNER, SIGNER]) =>
      `checked 2\r\n0 ${first} ${SHA1} ${signers[0]}\r\n1 ${second} ${SHA256} ${signers[1]}\r\n`;

    it("counts a signature that verifies, or fails only on a root this machine does not trust", () => {
      const certificate = { kind: "certificate", signer: SIGNER };
      expect(windowsSignature(dual("00000000"))).toEqual(certificate);
      // CERT_E_UNTRUSTEDROOT, as CI's throwaway certificate gives.
      expect(windowsSignature(dual("800b0109"))).toEqual(certificate);
      expect(windowsSignature(dual("00000000", "800b0109"))).toEqual(certificate);
      expect(windowsSignature(`checked 1\n0 800b0109 ${SHA256} ${SIGNER}\n`)).toEqual(certificate);
    });

    it("reads a file with no embedded signature as none, a catalog-signed one included", () => {
      expect(windowsSignature("checked 1\r\n0 800b0100 - -\r\n")).toEqual({
        kind: "none",
        signer: null,
      });
    });

    it.each([
      ["CERT_E_EXPIRED", "800b0101"],
      ["CERT_E_REVOKED", "800b010c"],
      ["TRUST_E_EXPLICIT_DISTRUST", "800b0111"],
      ["TRUST_E_BAD_DIGEST, a file changed after signing", "80096010"],
      ["TRUST_E_TIME_STAMP", "80096005"],
      ["CERT_E_CHAINING", "800b010a"],
      ["CERT_E_WRONG_USAGE", "800b0110"],
      ["CERT_E_UNTRUSTEDTESTROOT", "800b010d"],
      ["TRUST_E_SUBJECT_FORM_UNKNOWN", "800b0003"],
      ["a file that cannot be opened", "80070002"],
    ])("refuses %s on either signature", (_, code) => {
      expect(windowsSignature(dual(code, "800b0109"))).toEqual(invalid);
      expect(windowsSignature(dual("800b0109", code))).toEqual(invalid);
      expect(windowsSignature(`checked 1\n0 ${code} ${SHA256} ${SIGNER}\n`)).toEqual(invalid);
      expect(windowsSignature(`checked 1\n0 ${code} - -\n`)).toEqual(invalid);
    });

    it("refuses signatures from two signers, without a signer, or with no SHA-256 signature", () => {
      expect(windowsSignature(dual("800b0109", "800b0109", [SIGNER, OTHER]))).toEqual(invalid);
      expect(windowsSignature(dual("800b0109", "800b0109", ["-", "-"]))).toEqual(invalid);
      expect(windowsSignature(`checked 1\n0 800b0109 ${SHA1} ${SIGNER}\n`)).toEqual(invalid);
      expect(windowsSignature(`checked 1\n0 800b0109 - ${SIGNER}\n`)).toEqual(invalid);
    });

    it("refuses a passing signature that names no digest algorithm, beside a SHA-256 one", () => {
      const missing = (index: number) =>
        dual("800b0109").replace(
          `\n${index} 800b0109 ${index === 0 ? SHA1 : SHA256} `,
          `\n${index} 800b0109 - `,
        );
      expect(missing(0)).toContain("\n0 800b0109 - ");
      expect(windowsSignature(missing(0))).toEqual(invalid);
      expect(windowsSignature(missing(1))).toEqual(invalid);
      expect(
        windowsSignature(`checked 2\n0 00000000 - ${SIGNER}\n1 00000000 ${SHA256} ${SIGNER}\n`),
      ).toEqual(invalid);
    });

    it("refuses anything but one complete reading", () => {
      for (const output of [
        "",
        "checked 0\n",
        "0 800b0100 - -\n",
        "checked 1\n",
        "checked 2\n0 800b0100 - -\n",
        dual("800b0109").replace("checked 2", "checked 1"),
        dual("800b0109").replace("checked 2", "checked 3"),
        dual("800b0109").replace("\r\n1 ", "\r\n2 "),
        `${dual("800b0109")}${dual("800b0109")}`,
        `checked 1\n0 800b0109 ${SHA256} ${SIGNER.toLowerCase()}\n`,
        "checked 1\n0 800B0109 - -\n",
        // What the Get-AuthenticodeSignature readback printed.
        "NotSigned\r\n",
        "NotSigned False\r\n",
        "NotSigned True\r\n",
        "UnknownError True\r\n",
      ]) {
        expect(windowsSignature(output), output).toEqual(invalid);
      }
    });

    it("refuses a reading that says there is no signature and names a signer", () => {
      expect(windowsSignature(`checked 1\n0 800b0100 - ${SIGNER}\n`)).toEqual(invalid);
      expect(windowsSignature(`checked 1\n0 800b0100 ${SHA256} -\n`)).toEqual(invalid);
      expect(windowsSignature(dual("800b0100", "800b0109"))).toEqual(invalid);
    });
  });

  it("requires a successful readback of the requested signature on each Windows file", () => {
    const none = { status: 0, stdout: "checked 1\r\n0 800b0100 - -\r\n" };
    const signer = "A".repeat(40);
    const certificate = {
      status: 0,
      stdout: `checked 1\r\n0 800b0109 2.16.840.1.101.3.4.2.1 ${signer}\r\n`,
    };
    expect(checkWindowsSignature("unsigned", none)).toEqual({
      kind: "none",
      signer: null,
      matches: true,
    });
    expect(checkWindowsSignature("certificate", certificate)).toEqual({
      kind: "certificate",
      signer,
      matches: true,
    });
    expect(checkWindowsSignature("unsigned", certificate).matches).toBe(false);
    expect(checkWindowsSignature("certificate", none).matches).toBe(false);
    for (const plan of ["unsigned", "certificate"] as const) {
      for (const result of [
        { status: 1, stdout: none.stdout },
        { status: 1, stdout: certificate.stdout },
        { status: 0, stdout: "checked 1\r\n0 80096010 - -\r\n" },
        { status: 0, stdout: "" },
        { status: null, stdout: null },
      ]) {
        expect(checkWindowsSignature(plan, result)).toEqual({
          kind: "invalid",
          signer: null,
          matches: false,
        });
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
