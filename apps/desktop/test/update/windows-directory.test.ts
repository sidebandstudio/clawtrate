import { join, win32 } from "node:path";
import { expect, it, vi } from "vitest";
import {
  checkWindowsDirectorySpelling,
  runUpdatePowerShell,
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
  const values = { CLAWTRATE_PRIVATE_DIRECTORY: "fixture-directory" };
  execFile.mockImplementation((_file, _args, _options, done) => done(null, ""));
  try {
    await runUpdatePowerShell("fixture command", values, 15000, signal);
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "fixture command"],
      { env: { ...process.env, ...values }, timeout: 15000, windowsHide: true, signal },
      expect.any(Function),
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
