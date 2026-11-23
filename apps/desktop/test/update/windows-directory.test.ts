import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { expect, it, vi } from "vitest";
import {
  checkWindowsDirectorySpelling,
  prepareUpdateDirectory,
  PRIVATE_DIRECTORIES_TIMEOUT_MS,
  runUpdatePowerShell,
  updatePowerShellEnv,
} from "../../src/main/private-update-directory.ts";

it("accepts a Windows short directory name only when every differing entry identifies the same directory", async () => {
  const base = win32.join("C:\\", "Profiles");
  const long = win32.join(base, "Example profile");
  const short = win32.join(base, "EXAMPL~1");
  const leaf = win32.join("Temp", "profile");
  const folders = new Map([
    [long, 12n],
    [short, 12n],
    [win32.join(long, "Temp"), 14n],
    [win32.join(short, "Temp"), 14n],
    [win32.join(long, leaf), 16n],
    [win32.join(short, leaf), 16n],
  ]);
  let linked: string | null = null;
  const inspect = async (path: string) => ({
    dev: 1n,
    ino: folders.get(path) ?? 0n,
    isDirectory: () => true,
    isSymbolicLink: () => path === linked,
  });
  const compare = () =>
    checkWindowsDirectorySpelling(win32.join(short, leaf), win32.join(long, leaf), inspect);
  await expect(compare()).resolves.toBeUndefined();
  linked = short;
  await expect(compare()).rejects.toThrow(/Linked/);
  linked = null;
  folders.set(short, 20n);
  await expect(compare()).rejects.toThrow(/Linked/);
});

it("checks case-only aliases, parent identity and UNC roots", async () => {
  const compare = async (path: string, canonical: string, different?: string, linked?: string) => {
    const inspected: string[] = [];
    await checkWindowsDirectorySpelling(path, canonical, async (name) => {
      inspected.push(name);
      return {
        dev: 1n,
        ino: name === different ? 2n : 1n,
        isDirectory: () => true,
        isSymbolicLink: () => name === linked,
      };
    });
    return inspected;
  };
  const long = "C:\\Profiles\\Example",
    alias = "C:\\Profiles\\EXAMPLE";
  expect(await compare(alias, long)).toEqual([alias, long]);
  await expect(compare(alias, long, alias)).rejects.toThrow(/Linked/);
  await expect(compare(alias, long, undefined, alias)).rejects.toThrow(/Linked/);
  await expect(compare("C:\\Profiles\\EXAMPL~1\\", long)).resolves.toBeDefined();
  await expect(compare("C:\\Other\\EXAMPL~1", long, "C:\\Other")).rejects.toThrow(/Linked/);
  const unc = "\\\\server\\share\\folder";
  await expect(compare(unc.toUpperCase(), unc)).resolves.toBeDefined();
  await expect(compare("\\\\server\\other\\folder", unc)).rejects.toThrow(/roots/);
});

const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile }));

it("starts the Windows folder helper from SystemRoot with the host environment and forwards cancellation", async () => {
  const root = "C:\\WindowsFixture";
  const signal = new AbortController().signal;
  vi.stubEnv("SystemRoot", root);
  vi.stubEnv("CLAWTRATE_TEST_ENV", "inherited");
  vi.stubEnv("PSModulePath", "C:\\PowerShell7Fixture\\Modules");
  const values = { CLAWTRATE_PRIVATE_DIRECTORY: "fixture-directory" };
  execFile.mockImplementation((_file, _args, _options, done) => done(null, ""));
  try {
    await runUpdatePowerShell("fixture command", values, 15000, signal);
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "fixture command"],
      {
        env: expect.objectContaining({ CLAWTRATE_TEST_ENV: "inherited", ...values }),
        timeout: 15000,
        windowsHide: true,
        signal,
      },
      expect.any(Function),
    );
    const { env } = execFile.mock.calls[0]![2] as { env: Record<string, string> };
    expect(Object.keys(env).filter((name) => /^psmodulepath$/i.test(name))).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("starts Windows PowerShell without an inherited module path, whatever its case", () => {
  expect(
    updatePowerShellEnv(
      { PSModulePath: "a", psmodulepath: "b", PsModulePath: "c", Path: "C:\\Fixture" },
      { CLAWTRATE_UPDATE_FILE: "file" },
    ),
  ).toEqual({ Path: "C:\\Fixture", CLAWTRATE_UPDATE_FILE: "file" });
});

it("makes both Windows update folders in one PowerShell run that may take 20 seconds to start", async () => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "clawtrate-folders-")));
  const root = join(parent, "updates");
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.useFakeTimers();
  // A stand-in PowerShell that answers after 20 seconds, killed at its run's limit as execFile does.
  execFile.mockReset();
  // The folder's own checks run on the real file system first, for as long as they take.
  let started!: () => void;
  const called = new Promise<void>((resolve) => (started = resolve));
  execFile.mockImplementation((_file, _args, { timeout }, done) => {
    started();
    const answer = setTimeout(() => {
      clearTimeout(kill);
      done(null, "");
    }, 20_000);
    const kill = setTimeout(() => {
      clearTimeout(answer);
      done(Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" }));
    }, timeout);
  });
  try {
    const prepared = expect(prepareUpdateDirectory(root, "stable-offer")).resolves.toBeUndefined();
    await called;
    await vi.advanceTimersByTimeAsync(20_000);
    await prepared;
    expect(execFile).toHaveBeenCalledOnce();
    const [, , options] = execFile.mock.calls[0]!;
    expect(options.timeout).toBe(PRIVATE_DIRECTORIES_TIMEOUT_MS);
    expect(options.env.CLAWTRATE_PRIVATE_DIRECTORIES.split("\n")).toEqual([
      root,
      join(root, "stable-offer"),
    ]);
  } finally {
    vi.useRealTimers();
    Object.defineProperty(process, "platform", platform);
    rmSync(parent, { recursive: true, force: true });
  }
});
