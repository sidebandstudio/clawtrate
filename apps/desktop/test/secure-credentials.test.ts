// This device's credentials in the system's secure storage (docs/decisions.md, "This
// device's credentials in secure storage"): moved once from the files, verified before the clear text goes, authoritative after
// an interrupted move, and never written in clear text when secure storage can't be used.

import {
  createFileSigner,
  createSecureCredentials,
  CREDENTIALS_FILE,
  DEVICE_KEY_FILE,
  newDeviceKeyPem,
  SecureStorageUnavailableError,
  STATE_FILE,
  type SecretBox,
} from "@clawtrate/core/node";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SHARED = "shared-token-5f1c";
const DEVICE = "device-token-9a2e";
const TOKEN_KEY = "deviceToken:ws%3A%2F%2F127.0.0.1%3A19001:device-1:operator";
const CONNECTION = JSON.stringify({ url: "ws://127.0.0.1:19001", token: SHARED });
const RECORD = JSON.stringify({
  token: DEVICE,
  grantedScopes: ["operator.read"],
  heldScopes: ["operator.read"],
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A data folder as an earlier version left it: settings with a gateway token, a device token and a key. */
function legacyFolder(): { dir: string; pem: string } {
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-secure-"));
  dirs.push(dir);
  const pem = newDeviceKeyPem();
  writeFileSync(
    join(dir, STATE_FILE),
    JSON.stringify({ connection: CONNECTION, [TOKEN_KEY]: RECORD, "turn-limit-minutes": "30" }),
  );
  writeFileSync(join(dir, DEVICE_KEY_FILE), pem);
  return { dir, pem };
}

/** A stand-in for the system's secure storage: reversible, and never the clear text. */
function fakeBox(overrides: Partial<SecretBox> = {}) {
  const calls = { encrypt: 0, decrypt: 0 };
  const flip = (bytes: Uint8Array) => Uint8Array.from(bytes, (byte) => byte ^ 0xa5);
  const box: SecretBox = {
    available: async () => true,
    encrypt: async (text) => {
      calls.encrypt += 1;
      return flip(new TextEncoder().encode(`box:${text}`));
    },
    decrypt: async (data) => {
      calls.decrypt += 1;
      const text = new TextDecoder().decode(flip(data));
      if (!text.startsWith("box:")) throw new Error("not this box's");
      return text.slice(4);
    },
    ...overrides,
  };
  return { box, calls };
}

const logged: string[] = [];
const open = (dir: string, box: SecretBox) =>
  createSecureCredentials({ dataDir: dir, box, log: (_level, line) => logged.push(line) });

const state = (dir: string) =>
  JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8")) as Record<string, string>;

/** Every file in the folder, as text, for a search for clear-text secrets. */
const everything = (dir: string) =>
  readdirSync(dir)
    .map((name) => readFileSync(join(dir, name), "latin1"))
    .join("\n");

const deviceIdOf = async (pem: string) => {
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-secure-key-"));
  dirs.push(dir);
  writeFileSync(join(dir, "key.pem"), pem);
  return (await createFileSigner(join(dir, "key.pem")).loadIdentity()).deviceId;
};

describe("this device's credentials in secure storage", () => {
  it("are moved once: read back before the clear text goes, with the same identity and the saved gateway token swept", async () => {
    const { dir, pem } = legacyFolder();
    let readBacks = 0;
    const { box } = fakeBox({
      // The move's read-back happens while every clear-text copy is still in place.
      decrypt: async (data) => {
        if ((readBacks += 1) === 1) {
          expect(existsSync(join(dir, DEVICE_KEY_FILE))).toBe(true);
          expect(state(dir)[TOKEN_KEY]).toBe(RECORD);
        }
        return fakeBox().box.decrypt(data);
      },
    });
    const credentials = open(dir, box);
    expect((await credentials.signer.loadIdentity()).deviceId).toBe(await deviceIdOf(pem));
    expect(await credentials.secure()).toBe(true);
    expect(readBacks).toBe(1);
    expect(await credentials.storage.get("connection")).toBe(CONNECTION);
    expect(await credentials.storage.get(TOKEN_KEY)).toBe(RECORD);
    expect(await credentials.storage.get("turn-limit-minutes")).toBe("30");

    expect(state(dir)).toEqual({ "turn-limit-minutes": "30" });
    expect(existsSync(join(dir, DEVICE_KEY_FILE))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual([CREDENTIALS_FILE, STATE_FILE].sort());
    for (const secret of [SHARED, DEVICE, "PRIVATE KEY"])
      expect(everything(dir)).not.toContain(secret);

    // A new device token goes to the protected record, never to the file.
    await credentials.storage.set(TOKEN_KEY, RECORD.replace(DEVICE, "device-token-2"));
    expect(everything(dir)).not.toContain("device-token-2");
    expect(state(dir)).toEqual({ "turn-limit-minutes": "30" });
  });

  it("already moved: a restart reads the protected record and writes nothing", async () => {
    const { dir, pem } = legacyFolder();
    await open(dir, fakeBox().box).signer.loadIdentity();
    const sealed = readFileSync(join(dir, CREDENTIALS_FILE));
    const { box, calls } = fakeBox();
    const again = open(dir, box);
    expect((await again.signer.loadIdentity()).deviceId).toBe(await deviceIdOf(pem));
    expect(await again.storage.get(TOKEN_KEY)).toBe(RECORD);
    expect(calls.encrypt).toBe(0);
    expect(readFileSync(join(dir, CREDENTIALS_FILE)).equals(sealed)).toBe(true);
  });

  it("after an interrupted move, the protected record wins and the clear-text copy left behind is removed unread", async () => {
    const { dir, pem } = legacyFolder();
    await open(dir, fakeBox().box).signer.loadIdentity();
    // As if the removal never ran, with other values: they must never be used.
    writeFileSync(
      join(dir, STATE_FILE),
      JSON.stringify({ [TOKEN_KEY]: RECORD.replace(DEVICE, "stale"), "turn-limit-minutes": "30" }),
    );
    writeFileSync(join(dir, DEVICE_KEY_FILE), newDeviceKeyPem());
    const again = open(dir, fakeBox().box);
    expect(await again.storage.get(TOKEN_KEY)).toBe(RECORD);
    expect((await again.signer.loadIdentity()).deviceId).toBe(await deviceIdOf(pem));
    expect(state(dir)).toEqual({ "turn-limit-minutes": "30" });
    expect(existsSync(join(dir, DEVICE_KEY_FILE))).toBe(false);
  });

  it("a protected record that doesn't read back replaces nothing, and changes stay out of the files", async () => {
    const { dir, pem } = legacyFolder();
    const before = { state: state(dir), pem };
    const { box } = fakeBox({ decrypt: async () => "something else" });
    logged.length = 0;
    const credentials = open(dir, box);
    expect((await credentials.signer.loadIdentity()).deviceId).toBe(await deviceIdOf(pem));
    expect(await credentials.secure()).toBe(false);
    // Rolled back: the files are as they were, with no protected record and no temporary file.
    expect(state(dir)).toEqual(before.state);
    expect(readFileSync(join(dir, DEVICE_KEY_FILE), "utf8")).toBe(before.pem);
    expect(readdirSync(dir).sort()).toEqual([DEVICE_KEY_FILE, STATE_FILE].sort());
    // The pairing already saved goes on working; a new token is kept for this session only.
    expect(await credentials.storage.get(TOKEN_KEY)).toBe(RECORD);
    await credentials.storage.set(TOKEN_KEY, RECORD.replace(DEVICE, "session-token"));
    expect(await credentials.storage.get(TOKEN_KEY)).toContain("session-token");
    expect(everything(dir)).not.toContain("session-token");
    for (const secret of [SHARED, DEVICE, "session-token", "PRIVATE KEY"])
      expect(logged.join("\n")).not.toContain(secret);
  });

  it("without secure storage, nothing moves, nothing is written in clear text, and the host has no full access", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawtrate-secure-"));
    dirs.push(dir);
    const { box, calls } = fakeBox({ available: async () => false });
    const credentials = open(dir, box);
    const { deviceId } = await credentials.signer.loadIdentity();
    await credentials.storage.set("connection", CONNECTION);
    await credentials.storage.set(TOKEN_KEY, RECORD);
    await credentials.storage.set("turn-limit-minutes", "30");
    expect(await credentials.storage.get(TOKEN_KEY)).toBe(RECORD);
    expect(await credentials.secure()).toBe(false);
    expect(calls.encrypt).toBe(0);
    expect(readdirSync(dir)).toEqual([STATE_FILE]);
    expect(state(dir)).toEqual({ "turn-limit-minutes": "30" });
    // Kept for this session only: the next start has neither the token nor the identity.
    const next = open(dir, box);
    expect(await next.storage.get(TOKEN_KEY)).toBe(null);
    expect((await next.signer.loadIdentity()).deviceId).not.toBe(deviceId);
  });

  it("once moved, secure storage that can't be read stops, and nothing falls back to the files", async () => {
    const { dir } = legacyFolder();
    await open(dir, fakeBox().box).signer.loadIdentity();
    const sealed = readFileSync(join(dir, CREDENTIALS_FILE));
    for (const box of [
      fakeBox({ available: async () => false }).box,
      fakeBox({ decrypt: async () => Promise.reject(new Error("locked")) }).box,
    ]) {
      const locked = open(dir, box);
      await expect(locked.signer.loadIdentity()).rejects.toThrow(SecureStorageUnavailableError);
      await expect(locked.storage.get("connection")).rejects.toThrow(SecureStorageUnavailableError);
      await expect(locked.storage.set(TOKEN_KEY, "new")).rejects.toThrow(
        SecureStorageUnavailableError,
      );
      expect(await locked.secure()).toBe(false);
      // Settings that aren't credentials still work.
      expect(await locked.storage.get("turn-limit-minutes")).toBe("30");
      expect(readFileSync(join(dir, CREDENTIALS_FILE)).equals(sealed)).toBe(true);
      expect(state(dir)).toEqual({ "turn-limit-minutes": "30" });
    }
  });
});
