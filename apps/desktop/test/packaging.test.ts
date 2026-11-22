// The packaging configuration: what is shipped, and that signing is chosen by
// the environment alone.
import { FuseV1Options } from "@electron/fuses";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ID, builderConfig, fuses, macSigningRequested } from "../packaging/config.ts";
import { fuseMismatches } from "../packaging/fuse-check.ts";

const APP = join(import.meta.dirname, "..");
// The marker Electron embeds before the version and fuse bytes in an executable.
const FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";

describe("packaging configuration", () => {
  it("names the app and ships only the bundled main, preload and renderer", () => {
    const config = builderConfig({}, "45.3.2");
    expect(config.appId).toBe(APP_ID);
    expect(APP_ID).toBe("dev.clawtrate.desktop");
    expect(config.productName).toBe("Clawtrate");
    expect(config.files).toEqual([
      "package.json",
      "out/main/**",
      "out/preload/**",
      "out/renderer/**",
      "resources/icon.png",
      "!**/node_modules/**",
    ]);
    expect(JSON.stringify(config)).not.toMatch(/fixture|out\/web/);
  });

  it("has the Windows uninstaller remove the copy of the installer kept for an updater", () => {
    const include = builderConfig({}, "45.3.2").nsis?.include;
    expect(include).toBe("packaging/installer.nsh");
    const script = readFileSync(join(APP, include!), "utf8");
    expect(script).toContain('Delete "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"');
    expect(script).toContain('RMDir "$LOCALAPPDATA\\${CLAWTRATE_UPDATER_DIR}"');
  });

  it("validates an output override before packaging on either platform", () => {
    const output = (path: string) =>
      builderConfig({ CLAWTRATE_PACKAGE_OUTPUT: path }, "45.3.2").directories?.output;
    expect(output("  ")).toBe("dist");
    expect(output(APP)).toBe(APP);
    expect(() => output("custom-dist")).toThrow("must be an absolute path");
  });

  it("F-248: declares the link scheme for macOS; the Windows installer registers it and removes only its own", () => {
    const config = builderConfig({}, "45.3.2");
    expect(config.protocols).toEqual([{ name: "Clawtrate", schemes: ["clawtrate"] }]);
    const script = readFileSync(join(APP, config.nsis!.include!), "utf8");
    /** A macro's statements in order, without comments or blank lines. */
    const statements = (name: string) => {
      const start = script.indexOf(`!macro ${name}\n`);
      expect(start, name).toBeGreaterThanOrEqual(0);
      return script
        .slice(start, script.indexOf("!macroend", start))
        .split("\n")
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith(";"));
    };
    const key = '"Software\\Classes\\clawtrate"';
    const commandKey = '"Software\\Classes\\clawtrate\\shell\\open\\command"';
    const command = '\'"$INSTDIR\\${APP_EXECUTABLE_FILENAME}" -- "%1"\'';
    // At the install's scope, replacing an entry there, with `--` before the link
    // (src/main/links.ts).
    expect(statements("customInstall")).toEqual([
      `WriteRegStr SHELL_CONTEXT ${key} "" "URL:clawtrate"`,
      `WriteRegStr SHELL_CONTEXT ${key} "URL Protocol" ""`,
      `WriteRegStr SHELL_CONTEXT ${commandKey} "" ${command}`,
    ]);
    expect(statements("customUnInstall")).toEqual([
      // Not on an update: the copy of the installer, in the current user's folder for
      // either scope, then the install's scope again.
      "${ifNot} ${isUpdated}",
      '${if} $installMode == "all"',
      "SetShellVarContext current",
      "${endif}",
      'Delete "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"',
      'RMDir "$LOCALAPPDATA\\${CLAWTRATE_UPDATER_DIR}"',
      '${if} $installMode == "all"',
      "SetShellVarContext all",
      "${endif}",
      "${endif}",
      // On every uninstall, an update too, at the install's scope: the link entry, only
      // while it opens this installation.
      "Push $0",
      `ReadRegStr $0 SHELL_CONTEXT ${commandKey} ""`,
      `\${if} $0 == ${command}`,
      `DeleteRegKey SHELL_CONTEXT ${key}`,
      "${endif}",
      "Pop $0",
    ]);
  });

  it.each(["1.2.0", "1.2.0-beta.20261104.10"])(
    "emits the full signed setup version and setup-only marker for %s",
    (version) => {
      const config = builderConfig({}, "45.3.2");
      const include = readFileSync(join(APP, config.nsis!.include!), "utf8");
      expect(include).toMatch(
        /!ifndef BUILD_UNINSTALLER\s+VIAddVersionKey \/LANG=1033 "OriginalFilename" "ClawtrateSetup.exe"\s+!endif/,
      );
      const require = createRequire(import.meta.url);
      require("electron-builder");
      const builderRequire = createRequire(require.resolve("electron-builder"));
      // Ask the pinned packager for the actual NSIS version-resource commands.
      // No installer is built or run.
      const { NsisTarget } = builderRequire("app-builder-lib/out/targets/nsis/NsisTarget.js") as {
        NsisTarget: { prototype: { computeVersionKey(): string[] } };
      };
      const fields = NsisTarget.prototype.computeVersionKey.call({
        options: config.nsis,
        packager: {
          platformSpecificBuildOptions: {},
          appInfo: {
            productName: config.productName,
            version,
            buildVersion: version,
            description: "Fixture",
            copyright: "Fixture",
          },
        },
      });
      expect(fields).toContain('/LANG=1033 ProductName "Clawtrate"');
      expect(fields).toContain(`/LANG=1033 ProductVersion "${version}"`);
    },
  );

  it("builds into a folder git ignores and publishes nothing", () => {
    const config = builderConfig({}, "45.3.2");
    expect(config.directories?.output).toBe("dist");
    expect(readFileSync(join(APP, "../../.gitignore"), "utf8")).toMatch(/^dist\/$/m);
    expect(config.publish).toBeNull();
  });

  it("ships the window icon the main process loads on Windows and Linux", () => {
    const main = readFileSync(join(APP, "src/main/index.ts"), "utf8");
    expect(main).toContain('icon: join(RESOURCES, "icon.png")');
    expect(main).toContain('const RESOURCES = join(APP_ROOT, "resources");');
    expect(builderConfig({}, "45.3.2").files).toContain("resources/icon.png");
    const manifest = JSON.parse(
      readFileSync(join(APP, "../../assets/brand/generated.json"), "utf8"),
    ) as { outputs: string[] };
    expect(manifest.outputs).toContain("apps/desktop/resources/icon.png");
  });

  it("uses the icons generated from the logo", () => {
    const config = builderConfig({}, "45.3.2");
    const manifest = JSON.parse(
      readFileSync(join(APP, "../../assets/brand/generated.json"), "utf8"),
    ) as { outputs: string[] };
    expect(manifest.outputs).toContain(`apps/desktop/${config.mac?.icon}`);
    expect(manifest.outputs).toContain(`apps/desktop/${config.win?.icon}`);
  });

  it("builds a disk image and a zip for both Mac architectures and an x64 Windows installer", () => {
    const config = builderConfig({}, "45.3.2");
    expect(config.mac?.target).toEqual([
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ]);
    expect(config.win?.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
  });

  it("without signing variables, never looks for an identity and never notarizes", () => {
    expect(macSigningRequested({})).toBe(false);
    expect(macSigningRequested({ CSC_LINK: " " })).toBe(false);
    const mac = builderConfig({}, "45.3.2").mac!;
    expect(mac.identity).toBeNull();
    expect(mac.notarize).toBe(false);
  });

  it("signs when a certificate is given, and notarizes only with complete credentials, with no code change", () => {
    for (const env of [{ CSC_LINK: "cert.p12" }, { CSC_NAME: "Some Developer (TEAMID)" }]) {
      expect(macSigningRequested(env)).toBe(true);
      const mac = builderConfig(env, "45.3.2").mac!;
      expect("identity" in mac).toBe(false);
      expect(mac.hardenedRuntime).toBe(true);
      expect(mac.notarize).toBe(false);
      const notarized = builderConfig({ ...env, APPLE_KEYCHAIN_PROFILE: "profile" }, "45.3.2").mac!;
      expect(notarized.notarize).toBe(true);
    }
    // Credentials without a certificate notarize nothing.
    expect(builderConfig({ APPLE_KEYCHAIN_PROFILE: "profile" }, "45.3.2").mac!.notarize).toBe(
      false,
    );
  });

  it("turns off Node's own entry points in the shipped binary", () => {
    for (const platform of ["darwin", "win32"]) {
      const config = fuses(platform) as Record<number, unknown>;
      expect(config[FuseV1Options.RunAsNode]).toBe(false);
      expect(config[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(false);
      expect(config[FuseV1Options.EnableNodeCliInspectArguments]).toBe(false);
    }
  });

  it("reads a binary's fuses and names those packaging did not set as it asks", async () => {
    // A binary as small as the reader needs: the sentinel, wire version 1, its
    // length and one character per fuse, "1" on and "0" off.
    const dir = mkdtempSync(join(tmpdir(), "clawtrate-fuses-"));
    const binary = (wire: string) => {
      const path = join(dir, `${wire}.exe`);
      writeFileSync(
        path,
        Buffer.concat([
          Buffer.from("MZ"),
          Buffer.from(FUSE_SENTINEL),
          Buffer.from([1, wire.length]),
          Buffer.from(wire),
        ]),
      );
      return path;
    };
    try {
      // As packaging flips them: Node's entry points off, archive only and its integrity on.
      expect(await fuseMismatches(binary("00001101"), "win32")).toEqual([]);
      // Electron's defaults, as a binary nobody flipped has them.
      expect(await fuseMismatches(binary("10110001"), "win32")).toEqual([
        "RunAsNode",
        "EnableNodeOptionsEnvironmentVariable",
        "EnableNodeCliInspectArguments",
        "EnableEmbeddedAsarIntegrityValidation",
        "OnlyLoadAppFromAsar",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads the app only from its archive, checked against its hash, on macOS and Windows", () => {
    for (const platform of ["darwin", "win32"]) {
      const config = fuses(platform) as Record<number, unknown>;
      expect(config[FuseV1Options.OnlyLoadAppFromAsar]).toBe(true);
      expect(config[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(true);
    }
  });
});

it("manual NSIS setup leaves app-close handling to the stock template", () => {
  const include = readFileSync(join(APP, builderConfig({}, "45.3.2").nsis!.include!), "utf8");
  expect(include).not.toMatch(
    /customCheckAppRunning|getProcessInfo\.nsh|CLAWTRATE_EXITED_INSTALL_DIR/,
  );
});
