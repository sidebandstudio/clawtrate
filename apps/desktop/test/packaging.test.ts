// The packaging configuration: what is shipped, and that signing is chosen by
// the environment alone.
import { FuseV1Options } from "@electron/fuses";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ID, builderConfig, fuses, macSigningRequested } from "../packaging/config.ts";
import { windowsAppUserModelId } from "../src/main/identity.ts";

const APP = join(import.meta.dirname, "..");

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

  it("gives the packaged Windows app the bundle id, the installer's shortcuts' id, as its AppUserModelID", () => {
    expect(windowsAppUserModelId("win32", true)).toBe(APP_ID);
    expect(windowsAppUserModelId("win32", false)).toBeNull();
    expect(windowsAppUserModelId("darwin", true)).toBeNull();
    expect(windowsAppUserModelId("linux", true)).toBeNull();
    const main = readFileSync(join(APP, "src/main/index.ts"), "utf8");
    expect(main).toContain(
      "const appUserModelId = windowsAppUserModelId(process.platform, app.isPackaged);",
    );
    expect(main).toContain("if (appUserModelId) app.setAppUserModelId(appUserModelId);");
  });

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

  it("signs and notarizes when a certificate is given, with no code change", () => {
    for (const env of [{ CSC_LINK: "cert.p12" }, { CSC_NAME: "Some Developer (TEAMID)" }]) {
      expect(macSigningRequested(env)).toBe(true);
      const mac = builderConfig(env, "45.3.2").mac!;
      expect("identity" in mac).toBe(false);
      expect(mac.hardenedRuntime).toBe(true);
      expect(mac.notarize).toBe(true);
    }
  });

  it("turns off Node's own entry points in the shipped binary", () => {
    for (const platform of ["darwin", "win32"]) {
      const config = fuses(platform) as Record<number, unknown>;
      expect(config[FuseV1Options.RunAsNode]).toBe(false);
      expect(config[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(false);
      expect(config[FuseV1Options.EnableNodeCliInspectArguments]).toBe(false);
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
