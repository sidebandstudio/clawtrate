// Nothing may automate a packaged app without the sandbox switch: started
// with none of the markers, it is a person's app and looks at the real
// computer (docs/development/setup.md). Every launch of the packaged app the
// launch check makes carries `--clawtrate-setup-sandbox`.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  exitedWithin,
  launchArgs,
  launchPlace,
  recordExit,
  reportExit,
  withCheckBundle,
} from "../e2e-packaged/global-setup.ts";
import { APP_ID } from "../apps/desktop/src/main/identity.ts";

const ROOT = join(import.meta.dirname, "..");

describe("the packaged app's launches", () => {
  it("refuses a person's Clawtrate, or any bundle not built for the check, before touching preferences", () => {
    const use = vi.fn();
    const check = `${APP_ID}.check.0123456789abcdef`;
    for (const refused of [
      APP_ID,
      `${APP_ID}.check`,
      `${APP_ID}.check.0123456789ABCDEF`,
      `${check}0`,
      check.slice(0, -1),
      `${check}\n`,
      `x${check}`,
      check.replace("dev.", "devX"),
    ]) {
      expect(() => withCheckBundle(refused, use), refused).toThrow(/only a check build/);
    }
    expect(use).not.toHaveBeenCalled();
  });

  it("hands the preference work a check build's identifier and no other", () => {
    const use = vi.fn(() => "ran");
    const check = `${APP_ID}.check.0123456789abcdef`;
    expect(withCheckBundle(check, use)).toBe("ran");
    expect(use.mock.calls).toEqual([[check]]);
  });

  it("starts the Mac run, the only code that touches preferences, through that guard alone", () => {
    const source = readFileSync(join(ROOT, "e2e-packaged/global-setup.ts"), "utf8");
    expect(source.match(/\bmacSetup\(/g)).toHaveLength(2);
    expect(source).toContain(
      "withCheckBundle(bundleIdentifier(app), (domain) => macSetup(app, domain))",
    );
    expect(source.match(/\bpreferencesForgetter\(/g)).toHaveLength(2);
    expect(source.indexOf("preferencesForgetter(domain)")).toBeGreaterThan(
      source.indexOf("async function macSetup("),
    );
    for (const file of readdirSync(join(ROOT, "e2e-packaged"))) {
      const text = readFileSync(join(ROOT, "e2e-packaged", file), "utf8");
      const uses = (text.match(/"defaults"|Library\/Preferences/g) ?? []).length;
      expect(uses, file).toBe(file === "global-setup.ts" ? 2 : 0);
    }
  });

  it("on Windows, replaces the inherited profile, AppData and temporary folders whatever their case", () => {
    const names = ["Home", "UserProfile", "HomeDrive", "HomePath", "AppData", "LocalAppData"];
    const inherited = {
      Path: "C:\\Windows",
      ...Object.fromEntries(names.map((name) => [name, "C:\\inherited"])),
      ...Object.fromEntries(["tmpdir", "temp", "tmp"].map((name) => [name, "C:\\Temp"])),
    };
    const dir = mkdtempSync(join(tmpdir(), "clawtrate-windows-place-"));
    try {
      const { env } = launchPlace(dir, "win32", inherited);
      const home = join(dir, "home");
      const tmp = join(dir, "tmp");
      expect(env).toEqual({
        Path: "C:\\Windows",
        HOME: home,
        USERPROFILE: home,
        HOMEDRIVE: expect.any(String),
        HOMEPATH: expect.any(String),
        APPDATA: join(home, "AppData", "Roaming"),
        LOCALAPPDATA: join(home, "AppData", "Local"),
        TMPDIR: tmp,
        TEMP: tmp,
        TMP: tmp,
      });
      expect(env.HOMEDRIVE! + env.HOMEPATH!).toBe(home);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("on macOS, points the app's Library at the run's home, which HOME alone does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawtrate-mac-place-"));
    try {
      const { env } = launchPlace(dir, "darwin", { CFFIXED_USER_HOME: "/inherited/home" });
      expect(env.CFFIXED_USER_HOME).toBe(join(dir, "home"));
      expect(env.HOME).toBe(join(dir, "home"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("always carry the sandbox switch, beside the data folder and the debugging port", () => {
    expect(launchArgs("/data", "/tmp/run/sandbox.json", "/checkout")).toEqual([
      "--user-data-dir=/data",
      "--remote-debugging-port=0",
      "--clawtrate-setup-sandbox=/tmp/run/sandbox.json",
      "--clawtrate-setup-checkout=/checkout",
    ]);
  });

  it("every spawn of the packaged executable in the launch check names a sandbox", () => {
    const folder = join(ROOT, "e2e-packaged");
    const launches: string[] = [];
    for (const file of readdirSync(folder).filter((name) => name.endsWith(".ts"))) {
      const lines = readFileSync(join(folder, file), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!/spawn\(|gatedSpawn\(/.test(line)) return;
        const call = lines.slice(index, index + 8).join("\n");
        if (!/packagedExecutable\(|\bexe\b/.test(call)) return;
        launches.push(`${file}:${index + 1}`);
        expect(call, `${file}:${index + 1}`).toMatch(/launchArgs\(|--clawtrate-setup-sandbox=/);
      });
    }
    // The Mac and Windows launches, the second instance and the newer Mac build.
    expect(launches.length).toBeGreaterThanOrEqual(4);
  });

  it("every packaged launch, the second included, gets the run's own home, temporary folder and working folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawtrate-launch-place-"));
    try {
      const place = launchPlace(dir);
      expect(place.cwd).toBe(join(dir, "work"));
      expect(place.env.HOME).toBe(join(dir, "home"));
      expect(place.env.TMPDIR).toBe(join(dir, "tmp"));
      expect(Object.keys(place.env).filter((key) => key.startsWith("CLAWTRATE_"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const folder = join(ROOT, "e2e-packaged");
    let launches = 0;
    for (const file of readdirSync(folder).filter((name) => name.endsWith(".ts"))) {
      const lines = readFileSync(join(folder, file), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!/spawn\(|gatedSpawn\(/.test(line)) return;
        const call = lines.slice(index, index + 12).join("\n");
        if (!/packagedExecutable\(|\bexe\b/.test(call)) return;
        launches += 1;
        expect(call, `${file}:${index + 1}`).toMatch(/cwd: place\.cwd/);
        expect(call, `${file}:${index + 1}`).toMatch(/env: place\.env/);
      });
    }
    expect(launches).toBeGreaterThanOrEqual(4);
  });

  it("an app that exited before its teardown asked is seen as exited, from the exit recorded at its spawn", async () => {
    const child = recordExit(spawn(process.execPath, ["-e", ""], { stdio: "ignore" }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const started = Date.now();
    expect(await exitedWithin(child, 5_000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("reports how the app ended to the test that quit it, which runs in another process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawtrate-exit-"));
    try {
      const file = join(dir, "app-exit.json");
      for (const [script, ended] of [
        ["process.exit(0)", { code: 0, signal: null }],
        ["process.exit(3)", { code: 3, signal: null }],
        ["process.kill(process.pid, 'SIGSEGV')", { code: null, signal: "SIGSEGV" }],
      ] as const) {
        rmSync(file, { force: true });
        const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
        reportExit(child, file);
        await new Promise((resolve) => child.once("exit", resolve));
        expect(existsSync(file), script).toBe(true);
        expect(JSON.parse(readFileSync(file, "utf8")), script).toEqual(ended);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an app still running at the end of the wait has not exited", async () => {
    const child = recordExit(
      spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" }),
    );
    try {
      expect(await exitedWithin(child, 300)).toBe(false);
    } finally {
      process.kill(child.pid!, "SIGKILL");
    }
  });
});
