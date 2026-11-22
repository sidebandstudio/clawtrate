// Which launches keep this device's credentials in the Keychain through safeStorage, and
// that no shipped host turns full access on: it stays off until the paths that need it
// bring their own consent and transport checks (docs/decisions.md, "Scopes, once, at the first pairing").

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  keychainCheckName,
  safeStorageBox,
  usesSecureStorage,
  type SafeStorageLike,
} from "../src/main/secret-box.ts";

const ROOT = join(import.meta.dirname, "../../..");

function fakeSafeStorage(available: boolean, backend = "unknown"): SafeStorageLike {
  return {
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (text) => Buffer.from(`sealed:${text}`),
    decryptStringAsync: async (data) => ({ result: data.toString().replace(/^sealed:/, "") }),
    getSelectedStorageBackend: () => backend,
  };
}

/** Every TypeScript source file under a folder. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("the Keychain through safeStorage", () => {
  it("is available where safeStorage says so, except Linux's basic_text, which protects nothing", async () => {
    expect(await safeStorageBox(fakeSafeStorage(true), "darwin").available()).toBe(true);
    expect(await safeStorageBox(fakeSafeStorage(false), "darwin").available()).toBe(false);
    const basic = fakeSafeStorage(true, "basic_text");
    expect(await safeStorageBox(basic, "linux").available()).toBe(false);
    expect(
      await safeStorageBox(fakeSafeStorage(true, "gnome_libsecret"), "linux").available(),
    ).toBe(true);
    const box = safeStorageBox(fakeSafeStorage(true), "darwin");
    expect(await box.decrypt(await box.encrypt("record"))).toBe("record");
  });

  it("is used by a person's app on macOS, and by a packaged launch check under its own name only", () => {
    const production = { kind: "production" };
    const sandbox = { kind: "sandbox" };
    expect(usesSecureStorage(production, "darwin", null)).toBe(true);
    expect(usesSecureStorage(production, "win32", null)).toBe(false);
    expect(usesSecureStorage(sandbox, "darwin", null)).toBe(false);
    expect(usesSecureStorage({ kind: "refused" }, "darwin", null)).toBe(false);

    const hex = "0123456789abcdef";
    expect(keychainCheckName(sandbox, true, "darwin", hex)).toBe(`Clawtrate Check ${hex}`);
    expect(usesSecureStorage(sandbox, "darwin", `Clawtrate Check ${hex}`)).toBe(true);
    // Never a person's app, a development build, another system or another name.
    expect(keychainCheckName(production, true, "darwin", hex)).toBe(null);
    expect(keychainCheckName(sandbox, false, "darwin", hex)).toBe(null);
    expect(keychainCheckName(sandbox, true, "win32", hex)).toBe(null);
    for (const value of ["", "0123456789ABCDEF", `${hex}0`, "Clawtrate", "../x"])
      expect(keychainCheckName(sandbox, true, "darwin", value), value).toBe(null);
  });

  it("no shipped host or interface turns full access on", () => {
    const shipped = [
      ...sources(join(ROOT, "apps/desktop/src")),
      ...sources(join(ROOT, "packages/ui/src")),
      ...sources(join(ROOT, "packages/core/src")),
    ];
    // Code, not comments: the lines that name it once comments are taken out.
    const code = (file: string) =>
      readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
    const naming = shipped
      .filter((file) => /\bfullAccess\b/.test(code(file)))
      .map((file) => relative(ROOT, file).split(sep).join("/"));
    // Only the client, which defines the option and reads it.
    expect(naming).toEqual(["packages/core/src/client.ts"]);
    const client = readFileSync(join(ROOT, "packages/core/src/client.ts"), "utf8");
    expect(client.match(/\bfullAccess\s*[:=]\s*true/g)).toBe(null);
  });
});
