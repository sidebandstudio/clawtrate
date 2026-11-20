import { win32 } from "node:path";
import { expect, it } from "vitest";
import { checkWindowsDirectorySpelling } from "../../src/main/private-update-directory.ts";

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
