import { ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { findGitHubCli, installLocations, starRepository } from "../src/main/github-star.ts";
import type * as GitHubStar from "../src/main/github-star.ts";
import { createDesktopBridge } from "../src/renderer/bridge-desktop.ts";
import type { DesktopHostApi } from "../src/preload/index.ts";

let dir: string;
let gh: string;
let log: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clawtrate-star-"));
  gh = join(dir, "gh");
  log = join(dir, "arguments");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { force: true, recursive: true });
});
const success = "printf 'HTTP/2.0 204 No Content\\r\\n'";
function script(body: string) {
  writeFileSync(gh, "#!/bin/sh\n" + body, { mode: 0o700 });
  return findGitHubCli([gh]);
}

it("F-521: only the standard local install locations are candidates, even with gh on PATH", async () => {
  script("exit 99");
  const env = {
    PATH: dir,
    SystemRoot: "C:\\Windows",
    ProgramFiles: "C:\\Programs",
    LOCALAPPDATA: "C:\\Local",
  };
  expect(installLocations("linux", env)).toEqual([]);
  expect(installLocations("darwin", env)).toEqual([
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    "/opt/local/bin/gh",
  ]);
  expect(installLocations("win32", env)).toEqual([
    "C:\\Programs\\GitHub CLI\\gh.exe",
    "C:\\Local\\Microsoft\\WinGet\\Links\\gh.exe",
  ]);
  expect(
    installLocations("win32", {
      ...env,
      ProgramFiles: "relative",
      LOCALAPPDATA: "\\\\server\\shared",
    }),
  ).toEqual([]);
  expect(findGitHubCli([])).toBeNull();
  const bridge = await createDesktopBridge({
    hello: async () => ({ info: { canStarWithCli: false } }),
    onState: () => {},
  } as unknown as DesktopHostApi);
  expect(bridge.starWithCli).toBeUndefined();
});

it("F-521: a listed link starts its canonical file only on activation, with the fixed arguments", async () => {
  const link = join(dir, "listed");
  symlinkSync(gh, link);
  script(`printf '%s\\n' "$0" "$@" > "${log}"\n${success}`);
  const cli = findGitHubCli([link]);
  expect(cli?.path).toBe(realpathSync(gh));
  const bridge = await createDesktopBridge({
    hello: async () => ({ info: { canStarWithCli: true } }),
    onState: () => {},
    starWithCli: (...args: unknown[]) => {
      expect(args).toEqual([]);
      return starRepository(cli);
    },
  } as unknown as DesktopHostApi);
  expect(existsSync(log)).toBe(false);
  expect(await Reflect.apply(bridge.starWithCli!, bridge, ["ignored"])).toBe(true);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    realpathSync(gh),
    "api",
    "--method",
    "PUT",
    "/user/starred/sidebandstudio/clawtrate",
    "--hostname",
    "github.com",
    "--silent",
    "--include",
  ]);
});

it("F-521: removal, replacement, retargeting, missing execute permission and spawn errors fail", async () => {
  const cli = script(success);
  renameSync(gh, gh + "-old");
  expect(await starRepository(cli)).toBe(false);
  script(`touch "${log}"\n${success}`);
  expect(await starRepository(cli)).toBe(false);
  const link = join(dir, "listed");
  symlinkSync(gh, link);
  const linked = findGitHubCli([link]);
  rmSync(link);
  symlinkSync(gh + "-old", link);
  expect(await starRepository(linked)).toBe(false);
  expect(existsSync(log)).toBe(false);
  chmodSync(gh, 0o600);
  expect(findGitHubCli([gh, dir])).toBeNull();
  chmodSync(gh, 0o700);
  writeFileSync(gh, "#!/missing-interpreter\n");
  expect(await starRepository(findGitHubCli([gh]))).toBe(false);
});

it("F-521: success requires exit zero and a 204 within the first 4 KiB", async () => {
  for (const [body, ok] of [
    [success, true],
    [success + "\nexit 2", false],
    ["exit 0", false],
    ["printf 'HTTP/1.1 200 OK\\r\\nHTTP/1.1 204 No Content\\r\\n'", false],
    ["printf '%4096s' ' '; " + success, false],
    [success + "\nprintf '%9000s' ' '", true],
  ] as const)
    expect(await starRepository(script(body))).toBe(ok);
  for (const [body, expected] of [
    ["printf 'HTTP/1.1 302 Found\\r\\n'\n" + success, false],
    ["printf 'HTTP/2.0 2'\n/bin/sleep 0.05\nprintf '04\\r\\n'", true],
    ["printf 'HTTP/2.0 204 %4082s\\n' ''", true],
    ["printf 'HTTP/2.0 204 %4083s\\n' ''", false],
  ] as const)
    expect(await starRepository(script(body))).toBe(expected);
  expect(await starRepository(script(success + "\nexec /bin/sleep 30"), 100)).toBe(false);
});

it("F-521: the CLI uses its stored config with prompts, update checks and telemetry disabled", async () => {
  vi.stubEnv("GH_CONFIG_DIR", join(dir, "gh-config"));
  vi.stubEnv("XDG_CONFIG_HOME", join(dir, "xdg"));
  vi.stubEnv("GH_TELEMETRY", "1");
  vi.stubEnv("GH_HOST", "elsewhere");
  vi.stubEnv("CLAWTRATE_UNRELATED", "unrelated");
  const cli =
    script(`test "$GH_TELEMETRY/$GH_PROMPT_DISABLED/$GH_NO_UPDATE_NOTIFIER/$GH_NO_EXTENSION_UPDATE_NOTIFIER" = "0/1/1/1" || exit 1
test "$GH_CONFIG_DIR" = "${join(dir, "gh-config")}" && test "$XDG_CONFIG_HOME" = "${join(dir, "xdg")}" || exit 1
test -z "$GH_HOST$GH_TOKEN$GITHUB_TOKEN$HTTPS_PROXY$CLAWTRATE_UNRELATED" || exit 1
${success}`);
  expect(await starRepository(cli)).toBe(true);
});

it("F-521: one CLI runs until close, including when the direct child times out", async () => {
  const cli = script(`printf 'start\\n' >> "${log}"\nexec /bin/sleep 30`);
  let timeoutReached!: () => void;
  const timedOut = new Promise<void>((resolve) => {
    timeoutReached = resolve;
  });
  const kill = ChildProcess.prototype.kill;
  let finish!: () => void;
  const delayed = vi.spyOn(ChildProcess.prototype, "kill").mockImplementationOnce(function (
    this: ChildProcess,
    signal,
  ) {
    finish = () => {
      kill.call(this, signal);
    };
    timeoutReached();
    return true;
  });
  const first = starRepository(cli, 100);
  try {
    expect(await starRepository(cli)).toBe(false);
    await timedOut;
    await vi.waitFor(() => expect(existsSync(log)).toBe(true));
    expect(await starRepository(cli)).toBe(false);
  } finally {
    delayed.mockRestore();
    finish?.();
  }
  expect(await first).toBe(false);
  expect(readFileSync(log, "utf8")).toBe("start\n");
  expect(await starRepository(script(success))).toBe(true);
});

it("F-521: an ambiguous config location fails before launching a different account", async () => {
  vi.stubEnv("GH_CONFIG_DIR", "relative-config");
  const cli = script(`printf ran > "${log}"\n${success}`);
  expect(await starRepository(cli)).toBe(false);
  expect(existsSync(log)).toBe(false);
});

it("F-521: a local link is resolved before the following parent component", async () => {
  mkdirSync(join(dir, "nested", "child"), { recursive: true });
  const correct = join(dir, "nested", "program");
  writeFileSync(correct, "#!/bin/sh\n" + success, { mode: 0o700 });
  symlinkSync(join(dir, "nested", "child"), join(dir, "redirect"));
  symlinkSync("redirect/../program", gh);
  expect(await starRepository(findGitHubCli([gh]))).toBe(true);
});

it("F-521: a listed link with a regular-file parent is unavailable and cannot launch", async () => {
  const folder = join(dir, "listed");
  mkdirSync(folder);
  const link = join(folder, "gh");
  const program = join(dir, "program");
  writeFileSync(program, `#!/bin/sh\nprintf ran >> "${log}"\n${success}`, { mode: 0o700 });
  const fresh = join(folder, "invalid");
  symlinkSync(program + "/", fresh);
  expect(() => statSync(fresh)).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
  for (const target of [program + "/", program + "/../program"]) {
    symlinkSync(target, link);
    expect(findGitHubCli([link])).toBeNull();
    expect(existsSync(log)).toBe(false);
    rmSync(link);
    symlinkSync(program, link);
    const cli = findGitHubCli([link]);
    expect(cli).not.toBeNull();
    rmSync(link);
    symlinkSync(target, link);
    expect(await starRepository(cli)).toBe(false);
    expect(existsSync(log)).toBe(false);
    rmSync(link);
  }
  symlinkSync(program, link);
  expect(await starRepository(findGitHubCli([link]))).toBe(true);
  expect(readFileSync(log, "utf8")).toBe("ran");
});

// Exercise the host's lookup on a synthetic filesystem. No path passed by the
// lookup or the child's environment can reach the machine running the test.
async function withInstallation(
  platform: "darwin" | "win32",
  entries: Record<string, "directory" | "file" | { link: string }>,
  check: (host: typeof GitHubStar, trace: string[], launches: NodeJS.ProcessEnv[]) => Promise<void>,
) {
  const trace: string[] = [];
  const launches: NodeJS.ProcessEnv[] = [];
  const file = statSync(gh, { bigint: true });
  const directory = statSync(dir);
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  vi.resetModules();
  vi.doMock("node:path", () => ({ ...(platform === "darwin" ? posix : win32), win32 }));
  vi.doMock("node:fs", () => ({
    constants: fs.constants,
    lstatSync(path: string) {
      trace.push("lstat " + path);
      const entry = entries[path];
      if (!entry) throw new Error("missing");
      if (entry === "directory") return directory;
      if (entry === "file") return file;
      return { isSymbolicLink: () => true };
    },
    readlinkSync(path: string) {
      trace.push("readlink " + path);
      const entry = entries[path];
      if (typeof entry !== "object") throw new Error("missing link");
      return entry.link;
    },
    statSync(path: string) {
      trace.push("stat " + path);
      if (entries[path] !== "file") throw new Error("missing executable");
      return file;
    },
    accessSync(path: string, mode: number) {
      trace.push("access " + path);
      if (entries[path] !== "file" || mode !== fs.constants.X_OK) throw new Error("denied");
    },
  }));
  vi.doMock("node:child_process", () => ({
    spawn(path: string, _args: string[], options: { env: NodeJS.ProcessEnv }) {
      if (entries[path] !== "file") throw new Error("missing executable");
      launches.push(options.env);
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), { stdout });
      stdout.on("end", () => child.emit("close", 0));
      setImmediate(() => stdout.end("HTTP/2.0 204 No Content\r\n"));
      return child;
    },
  }));
  try {
    const host = await import("../src/main/github-star.ts");
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    await check(host, trace, launches);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    vi.doUnmock("node:path");
    vi.doUnmock("node:fs");
    vi.doUnmock("node:child_process");
    vi.resetModules();
  }
}

it("F-521: Windows config paths must name a drive or a complete UNC share", async () => {
  writeFileSync(gh, "");
  vi.stubEnv("SystemRoot", "C:\\Windows");
  for (const name of ["HOME", "USERPROFILE", "APPDATA", "XDG_CONFIG_HOME"])
    vi.stubEnv(name, undefined);
  const executable = "C:\\cli.exe";
  await withInstallation("win32", { [executable]: "file" }, async (host, trace, launches) => {
    const cli = host.findGitHubCli([executable]);
    expect(cli).not.toBeNull();
    for (const value of ["\\config", "/config", "C:config", "\\\\server"]) {
      vi.stubEnv("GH_CONFIG_DIR", value);
      expect(await host.starRepository(cli)).toBe(false);
      expect(launches).toHaveLength(0);
    }
    const valid = ["C:\\config", "\\\\server\\share\\config"];
    for (const value of valid) {
      vi.stubEnv("GH_CONFIG_DIR", value);
      expect(await host.starRepository(cli)).toBe(true);
    }
    expect(launches.map((env) => env.GH_CONFIG_DIR)).toEqual(valid);
    expect(trace.every((entry) => entry.endsWith(" " + executable))).toBe(true);
  });
});

it("F-521: startup walks the listed paths and activation rechecks only the chosen link", async () => {
  writeFileSync(gh, "");
  vi.stubEnv("PATH", "/on-path");
  const entries = {
    "/on-path/gh": "file",
    "/opt": "directory",
    "/usr": "directory",
    "/usr/local": "directory",
    "/usr/local/bin": "directory",
    "/usr/local/bin/gh": { link: "/Volumes/shared/gh" },
    "/opt/local": "directory",
    "/opt/local/bin": "directory",
    "/opt/local/bin/gh": { link: "/installed/program" },
    "/installed": "directory",
    "/installed/program": "file",
  } as const;
  const recheck = [
    "lstat /opt",
    "lstat /opt/local",
    "lstat /opt/local/bin",
    "lstat /opt/local/bin/gh",
    "readlink /opt/local/bin/gh",
    "lstat /installed",
    "lstat /installed/program",
    "stat /installed/program",
    "access /installed/program",
  ];
  await withInstallation("darwin", entries, async (host, trace, launches) => {
    const cli = host.findGitHubCli();
    expect(cli?.path).toBe("/installed/program");
    expect(trace).toEqual([
      "lstat /opt",
      "lstat /opt/homebrew",
      "lstat /usr",
      "lstat /usr/local",
      "lstat /usr/local/bin",
      "lstat /usr/local/bin/gh",
      "readlink /usr/local/bin/gh",
      ...recheck,
    ]);
    expect(launches).toHaveLength(0);
    trace.length = 0;
    expect(await host.starRepository(cli)).toBe(true);
    expect(trace).toEqual(recheck);
    expect(launches).toHaveLength(1);
  });
});
