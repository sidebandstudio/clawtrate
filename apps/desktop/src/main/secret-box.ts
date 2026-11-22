// This device's credentials go to the system's secure storage through Electron's
// safeStorage (docs/decisions.md, "This device's credentials in secure storage"). On macOS it keeps one
// encryption key in the login Keychain, under the app's name and readable
// without a prompt only by this app's signature, and returns ciphertext the
// host stores in its data folder. It ships with Electron, so no native module
// is added, and nothing passes a secret through a command line, as the
// `security` tool would. The async calls are the ones Electron 45 keeps.
//
// Linux's `basic_text` backend encrypts with a fixed password, which protects
// nothing, so it counts as unavailable there.

import type { SecretBox } from "@clawtrate/core/node";
import { rename, stat } from "node:fs/promises";

/** The safeStorage calls the box uses. */
export type SafeStorageLike = {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string }>;
  getSelectedStorageBackend(): string;
};

export function safeStorageBox(safeStorage: SafeStorageLike, platform: string): SecretBox {
  return {
    available: async () =>
      (await safeStorage.isAsyncEncryptionAvailable()) &&
      !(platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"),
    encrypt: (text) => safeStorage.encryptStringAsync(text),
    decrypt: async (data) => (await safeStorage.decryptStringAsync(Buffer.from(data))).result,
  };
}

/** The switch a packaged launch check passes to give the app a Keychain name of its own. */
export const KEYCHAIN_CHECK_SWITCH = "clawtrate-keychain-check";

/**
 * The app name a packaged launch check runs under, `Clawtrate Check <16 hex>`, so the
 * key safeStorage keeps is in a Keychain item of the check's own (service "<name> Safe Storage", account "<name> Key"),
 * never a person's Clawtrate's. Only a sandboxed packaged app on macOS takes it, and the
 * switch itself makes a launch sandboxed (`SANDBOX_SWITCHES`).
 */
export function keychainCheckName(
  launch: { kind: string },
  packaged: boolean,
  platform: string,
  value: string,
  mockKeychain = false,
): string | null {
  return !mockKeychain &&
    launch.kind === "sandbox" &&
    packaged &&
    platform === "darwin" &&
    /^[0-9a-f]{16}$/.test(value)
    ? `Clawtrate Check ${value}`
    : null;
}

/**
 * Whether this launch keeps credentials in secure storage: a person's app on macOS
 * (`production`), or a packaged launch check under its own Keychain name. A development
 * build and every other automated run keep their data folder's files and never touch
 * the Keychain; Windows' DPAPI is left to its own change. Such a host has no full access.
 */
export function usesSecureStorage(
  launch: { kind: string },
  platform: string,
  keychainCheck: string | null,
  mockKeychain = false,
): boolean {
  // Chromium's mock Keychain keeps its key in memory: a record sealed under it can't be
  // opened after exit, so nothing may move there.
  if (mockKeychain) return false;
  return platform === "darwin" && (launch.kind === "production" || keychainCheck !== null);
}

/** The switch that gives Chromium an in-memory stand-in for the Keychain. */
export const MOCK_KEYCHAIN_SWITCH = "use-mock-keychain";

/**
 * What the app says when it can't start because of this device's credentials: fixed words
 * for each case, never the error's own message, its cause or anything read from a file.
 */
export function startupFailure(error: unknown): {
  title: string;
  message: string;
  /**
   * What starting fresh sets aside (`keepAside`), kept unchanged: the whole data folder for a
   * damaged record, only `state.json` for unreadable settings, so a good record stays in use.
   * False when the app offers no such choice.
   */
  recover: false | "folder" | "settings";
} {
  const name = error instanceof Error ? error.name : "";
  if (name === "SecureStorageUnavailableError")
    return {
      title: "Clawtrate couldn't open your keychain",
      message:
        "Clawtrate keeps this device's credentials in your keychain, and couldn't read them. Unlock your keychain, then open Clawtrate again.",
      recover: false,
    };
  if (name === "CredentialRecordInvalidError")
    return {
      title: "Clawtrate couldn't use this device's credentials",
      message:
        "This device's saved credentials are damaged or were changed, so Clawtrate didn't use them. Start fresh makes this device a new device with a new identity: its saved files are set aside, unchanged, in a folder next to them, and its old tokens and settings are no longer used. Then pair this device again. Or quit and restore the files from a backup.",
      recover: "folder",
    };
  if (name === "SavedSettingsInvalidError")
    return {
      title: "Clawtrate couldn't read its saved settings",
      message:
        "This device's saved settings can't be read, so Clawtrate didn't use them. Start fresh to set the settings file aside, unchanged, next to it: this device's saved credentials stay in place, so choose its gateway again and it reconnects with them. Or quit and restore the file from a backup.",
      recover: "settings",
    };
  return {
    title: "Clawtrate couldn't start",
    message: "Something went wrong while Clawtrate was starting. Open Clawtrate again.",
    recover: false,
  };
}

/** The button that starts fresh, and the one that quits, in the recovery dialog. */
export const RECOVERY_BUTTONS = ["Start fresh and keep the old files", "Quit"] as const;

/**
 * Starting fresh: renames the data folder, or one file in it, to a sibling,
 * `<path>-kept-<date>` (with `-2`, `-3` … if taken), so nothing in it changes and none of it is
 * read, and returns that path. The next start makes what is missing afresh.
 */
export async function keepAside(dir: string, now: Date): Promise<string> {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  for (let n = 1; ; n += 1) {
    const target = `${dir}-kept-${stamp}${n === 1 ? "" : `-${n}`}`;
    try {
      await stat(target);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(dir, target);
    return target;
  }
}

/** Said once when secure storage couldn't be used before this device's credentials moved there. */
export const SESSION_ONLY = {
  title: "Clawtrate couldn't save this device securely",
  message:
    "Your keychain couldn't be used, so this session keeps changes to this device's pairing in memory only, and full control stays off. Reopening Clawtrate discards those changes: unlock your keychain, open Clawtrate again, and repeat any pairing changes you want to keep.",
};
