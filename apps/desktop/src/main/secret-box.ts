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
 * key safeStorage keeps is in a Keychain item of the check's own ("<name> Safe Storage"),
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
