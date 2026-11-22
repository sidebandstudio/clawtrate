// This device's credentials in the system's secure storage (docs/decisions.md, "This
// device's credentials in secure storage"): moved once from the files and durably,
// verified before the clear text goes, authenticated, authoritative afterwards, and never
// written in clear text, not even in a temporary file, when secure storage can't be used.

import {
  createFileSigner,
  createNodeHost,
  createSecureCredentials,
  CREDENTIALS_FILE,
  CredentialRecordInvalidError,
  DEVICE_KEY_FILE,
  newDeviceKeyPem,
  SavedSettingsInvalidError,
  SecureStorageUnavailableError,
  STATE_FILE,
  type SecretBox,
} from "@clawtrate/core/node";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Every byte written to a temporary file, and a rename a test makes fail.
const fsHooks = vi.hoisted(() => ({
  written: [] as Array<{ file: string; text: string }>,
  failRename: null as null | ((to: string) => boolean),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  const open = (async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const file = String(args[0]);
    return new Proxy(handle, {
      get(target, prop, receiver) {
        if (prop === "writeFile")
          return (data: string | Uint8Array) => {
            fsHooks.written.push({ file, text: Buffer.from(data).toString("latin1") });
            return target.writeFile(data);
          };
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof actual.open;
  const writeFile = ((...args: Parameters<typeof actual.writeFile>) => {
    fsHooks.written.push({
      file: String(args[0]),
      text: Buffer.from(args[1] as string).toString("latin1"),
    });
    return actual.writeFile(...args);
  }) as typeof actual.writeFile;
  const rename = ((from: string, to: string) =>
    fsHooks.failRename?.(String(to))
      ? Promise.reject(Object.assign(new Error("rename refused"), { code: "EIO" }))
      : actual.rename(from, to)) as typeof actual.rename;
  return { ...actual, open, writeFile, rename };
});

const SHARED = "shared-token-5f1c";
const DEVICE = "device-token-9a2e";
const TOKEN_KEY = "deviceToken:ws%3A%2F%2F127.0.0.1%3A19001:device-1:operator";
const URL = "ws://127.0.0.1:19001";
const CONNECTION = JSON.stringify({ url: URL, token: SHARED });
const NO_TOKEN = JSON.stringify({ url: URL, token: null });
const RECORD = JSON.stringify({
  token: DEVICE,
  grantedScopes: ["operator.read"],
  heldScopes: ["operator.read"],
});
const SECRETS = [SHARED, DEVICE, "PRIVATE KEY"];

const dirs: string[] = [];
afterEach(() => {
  fsHooks.written.length = 0;
  fsHooks.failRename = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function emptyFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-secure-"));
  dirs.push(dir);
  return dir;
}

/** A data folder as an earlier version left it: settings with a gateway token, a device token and a key. */
function legacyFolder(): { dir: string; pem: string } {
  const dir = emptyFolder();
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

/** Every temporary file written, and every file in the folder, hold none of these. */
function expectNowhere(dir: string, secrets: string[]) {
  const temps = fsHooks.written.filter(({ file }) => basename(file).endsWith(".tmp"));
  for (const secret of secrets) {
    expect(everything(dir), secret).not.toContain(secret);
    for (const { file, text } of temps) expect(text, `${secret} in ${file}`).not.toContain(secret);
    expect(logged.join("\n"), secret).not.toContain(secret);
  }
}

const deviceIdOf = async (pem: string) => {
  const dir = emptyFolder();
  writeFileSync(join(dir, "key.pem"), pem);
  return (await createFileSigner(join(dir, "key.pem")).loadIdentity()).deviceId;
};

describe("this device's credentials in secure storage", () => {
  it("are moved once: read back before the clear text goes, with the same identity, and no temporary file holds one", async () => {
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
    // The earlier build's gateway token is kept, sealed, for the pairing it was saved for.
    expect(await credentials.storage.get("connection")).toBe(CONNECTION);
    expect(await credentials.storage.get(TOKEN_KEY)).toBe(RECORD);
    expect(await credentials.storage.get("turn-limit-minutes")).toBe("30");

    expect(state(dir)).toEqual({ connection: NO_TOKEN, "turn-limit-minutes": "30" });
    expect(readdirSync(dir).sort()).toEqual([CREDENTIALS_FILE, STATE_FILE].sort());
    if (process.platform !== "win32")
      for (const name of [CREDENTIALS_FILE, STATE_FILE])
        expect(statSync(join(dir, name)).mode & 0o077, name).toBe(0);

    await credentials.storage.set(TOKEN_KEY, RECORD.replace(DEVICE, "device-token-2"));
    await credentials.storage.set("turn-limit-minutes", "45");
    expectNowhere(dir, [...SECRETS, "device-token-2"]);
  });

  it("already moved: a restart opens the record and writes nothing", async () => {
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

  it("a record that doesn't read back replaces nothing; the files stay, and settings aren't written over their credentials", async () => {
    const { dir, pem } = legacyFolder();
    const before = readFileSync(join(dir, STATE_FILE), "utf8");
    logged.length = 0;
    const credentials = open(dir, fakeBox({ decrypt: async () => "something else" }).box);
    expect((await credentials.signer.loadIdentity()).deviceId).toBe(await deviceIdOf(pem));
    expect(await credentials.status()).toBe("session");
    expect(await credentials.secure()).toBe(false);
    expect(readFileSync(join(dir, STATE_FILE), "utf8")).toBe(before);
    expect(readFileSync(join(dir, DEVICE_KEY_FILE), "utf8")).toBe(pem);
    expect(readdirSync(dir).sort()).toEqual([DEVICE_KEY_FILE, STATE_FILE].sort());
    // The saved pairing goes on working; changes are kept for this session only.
    expect(await credentials.storage.get(TOKEN_KEY)).toBe(RECORD);
    await credentials.storage.set(TOKEN_KEY, RECORD.replace(DEVICE, "session-token"));
    await credentials.storage.set("turn-limit-minutes", "45");
    expect(await credentials.storage.get(TOKEN_KEY)).toContain("session-token");
    expect(await credentials.storage.get("turn-limit-minutes")).toBe("45");
    expect(readFileSync(join(dir, STATE_FILE), "utf8")).toBe(before);
    const temps = fsHooks.written.filter(({ file }) => basename(file).endsWith(".tmp"));
    for (const secret of [...SECRETS, "session-token"])
      for (const { text } of temps) expect(text).not.toContain(secret);
  });

  it("a cleanup that fails after the record is in place leaves it authoritative, says so, and finishes at the next change or start", async () => {
    const { dir, pem } = legacyFolder();
    fsHooks.failRename = (to) => to.endsWith(STATE_FILE);
    const credentials = open(dir, fakeBox().box);
    expect((await credentials.signer.loadIdentity()).deviceId).toBe(await deviceIdOf(pem));
    expect(await credentials.status()).toBe("cleanup-pending");
    expect(await credentials.secure()).toBe(false);
    expect(existsSync(join(dir, CREDENTIALS_FILE))).toBe(true);
    // A settings change while removal keeps failing writes nothing over the earlier file.
    await expect(credentials.storage.set("turn-limit-minutes", "45")).rejects.toThrow();
    expect(state(dir)[TOKEN_KEY]).toBe(RECORD);
    // The next start removes it, never reading it.
    fsHooks.failRename = null;
    writeFileSync(
      join(dir, STATE_FILE),
      JSON.stringify({ ...state(dir), [TOKEN_KEY]: RECORD.replace(DEVICE, "stale") }),
    );
    const again = open(dir, fakeBox().box);
    expect(await again.storage.get(TOKEN_KEY)).toBe(RECORD);
    expect(await again.secure()).toBe(true);
    expect(state(dir)).toEqual({ connection: NO_TOKEN, "turn-limit-minutes": "30" });
    expect(existsSync(join(dir, DEVICE_KEY_FILE))).toBe(false);
    expectNowhere(dir, [...SECRETS, "stale"]);
  });

  it("an earlier build run again after the move can't replace the sealed identity or token, and its files are removed unread", async () => {
    const { dir, pem } = legacyFolder();
    await open(dir, fakeBox().box).signer.loadIdentity();
    // What an earlier build writes on the same data folder: a new key, a new pairing.
    writeFileSync(
      join(dir, STATE_FILE),
      JSON.stringify({
        connection: JSON.stringify({ url: URL, token: "downgrade-shared" }),
        [TOKEN_KEY]: RECORD.replace(DEVICE, "downgrade-token"),
        "turn-limit-minutes": "30",
      }),
    );
    writeFileSync(join(dir, DEVICE_KEY_FILE), newDeviceKeyPem());
    const again = open(dir, fakeBox().box);
    expect(await again.storage.get(TOKEN_KEY)).toBe(RECORD);
    expect((await again.signer.loadIdentity()).deviceId).toBe(await deviceIdOf(pem));
    expect(await again.storage.get("connection")).toBe(CONNECTION);
    expect(existsSync(join(dir, DEVICE_KEY_FILE))).toBe(false);
    expectNowhere(dir, ["downgrade-shared", "downgrade-token", "PRIVATE KEY"]);
  });

  it("removes an earlier build's temporary files whose writer has ended, and leaves a live writer's", async () => {
    const { dir } = legacyFolder();
    const ended = `${STATE_FILE}.2147483646.tmp`;
    const live = `${STATE_FILE}.${process.ppid}.tmp`;
    writeFileSync(join(dir, ended), JSON.stringify({ [TOKEN_KEY]: RECORD }));
    writeFileSync(join(dir, live), "{}");
    const credentials = open(dir, fakeBox().box);
    expect(await credentials.secure()).toBe(true);
    expect(existsSync(join(dir, ended))).toBe(false);
    expect(existsSync(join(dir, live))).toBe(true);
  });

  it("refuses a changed record or wrapped key before using anything in it, and a failed write keeps the record before it", async () => {
    const { dir } = legacyFolder();
    await open(dir, fakeBox().box).signer.loadIdentity();
    const path = join(dir, CREDENTIALS_FILE);
    const good = readFileSync(path, "utf8");
    const outer = JSON.parse(good) as Record<string, string>;
    const flip = (text: string, at: "first" | "last" = "last") => {
      const bytes = Buffer.from(text, "base64");
      bytes[at === "first" ? 0 : bytes.length - 1]! ^= 1;
      return bytes.toString("base64");
    };
    const flipLast = (text: string) => flip(text);
    const cases: Array<[string, Record<string, string>, new () => Error]> = [
      ["data", { ...outer, data: flipLast(outer.data!) }, CredentialRecordInvalidError],
      ["tag", { ...outer, tag: flipLast(outer.tag!) }, CredentialRecordInvalidError],
      ["wrapped key", { ...outer, key: flip(outer.key!, "first") }, SecureStorageUnavailableError],
    ];
    for (const [name, changed, error] of cases) {
      writeFileSync(path, JSON.stringify(changed));
      const opened = open(dir, fakeBox().box);
      await expect(opened.storage.get(TOKEN_KEY), name).rejects.toThrow(error);
      await expect(opened.signer.loadIdentity(), name).rejects.toThrow(error);
      expect(await opened.status()).toBe("locked");
    }
    writeFileSync(path, "not a record");
    await expect(open(dir, fakeBox().box).storage.get(TOKEN_KEY)).rejects.toThrow(
      CredentialRecordInvalidError,
    );

    writeFileSync(path, good);
    let reads = 0;
    const failing = open(
      dir,
      fakeBox({
        // Opens the record, then refuses the read-back of the next write.
        decrypt: async (data) => {
          if ((reads += 1) > 1) throw new Error("locked");
          return fakeBox().box.decrypt(data);
        },
      }).box,
    );
    expect(await failing.storage.get(TOKEN_KEY)).toBe(RECORD);
    await expect(failing.storage.set(TOKEN_KEY, RECORD.replace(DEVICE, "x"))).rejects.toThrow();
    expect(await failing.storage.get(TOKEN_KEY)).toBe(RECORD);
    expect(readFileSync(path, "utf8")).toBe(good);
  });

  it("keeps a gateway token typed for a new pairing in this process only, and drops an earlier saved one once replaced", async () => {
    const { dir } = legacyFolder();
    const credentials = open(dir, fakeBox().box);
    const typed = JSON.stringify({ url: "ws://127.0.0.1:19002", token: "typed-token-7" });
    await credentials.storage.set("connection", typed);
    expect(await credentials.storage.get("connection")).toBe(typed);
    expectNowhere(dir, [...SECRETS, "typed-token-7"]);
    // After a restart: the address is kept, neither token is, not even in the sealed record.
    const again = open(dir, fakeBox().box);
    expect(await again.storage.get("connection")).toBe(
      JSON.stringify({ url: "ws://127.0.0.1:19002", token: null }),
    );
    expect(state(dir).connection).toBe(
      JSON.stringify({ url: "ws://127.0.0.1:19002", token: null }),
    );

    // Once paired, the settings drop the token, and the earlier build's copy goes with it.
    const { dir: other } = legacyFolder();
    const paired = open(other, fakeBox().box);
    expect(await paired.storage.get("connection")).toBe(CONNECTION);
    await paired.storage.set("connection", NO_TOKEN);
    expect(await open(other, fakeBox().box).storage.get("connection")).toBe(NO_TOKEN);
  });

  it("without secure storage, nothing moves, nothing is written in clear text, and the host has no full access", async () => {
    const dir = emptyFolder();
    const { box, calls } = fakeBox({ available: async () => false });
    const credentials = open(dir, box);
    const { deviceId } = await credentials.signer.loadIdentity();
    await credentials.storage.set("connection", CONNECTION);
    await credentials.storage.set(TOKEN_KEY, RECORD);
    await credentials.storage.set("turn-limit-minutes", "30");
    expect(await credentials.storage.get(TOKEN_KEY)).toBe(RECORD);
    expect(await credentials.secure()).toBe(false);
    expect(await credentials.status()).toBe("session");
    expect(calls.encrypt).toBe(0);
    expect(readdirSync(dir)).toEqual([STATE_FILE]);
    expect(state(dir)).toEqual({ connection: NO_TOKEN, "turn-limit-minutes": "30" });
    expectNowhere(dir, SECRETS);
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
      await expect(locked.storage.get(TOKEN_KEY)).rejects.toThrow(SecureStorageUnavailableError);
      await expect(locked.storage.set(TOKEN_KEY, RECORD)).rejects.toThrow(
        SecureStorageUnavailableError,
      );
      expect(await locked.secure()).toBe(false);
      // Settings that aren't credentials still work, and the saved address carries no token.
      expect(await locked.storage.get("turn-limit-minutes")).toBe("30");
      expect(await locked.storage.get("connection")).toBe(NO_TOKEN);
      expect(readFileSync(join(dir, CREDENTIALS_FILE)).equals(sealed)).toBe(true);
    }
  });

  it("an earlier build's settings that can't be read stop with fixed words, quoting nothing from the file", async () => {
    for (const contents of [
      `{"connection": "${SHARED}", broken`,
      JSON.stringify({ connection: `not settings ${SHARED}` }),
      JSON.stringify({ [TOKEN_KEY]: `{"token": 5, "x": "${SHARED}"}` }),
    ]) {
      const dir = emptyFolder();
      writeFileSync(join(dir, STATE_FILE), contents);
      const credentials = open(dir, fakeBox().box);
      const failure = await credentials.signer.loadIdentity().catch((error: Error) => error);
      expect(failure).toBeInstanceOf(SavedSettingsInvalidError);
      expect(String((failure as Error).message)).not.toContain(SHARED);
      expect((failure as Error).cause).toBeUndefined();
    }
  });

  it("a host given secure storage keeps credentials there, and only then says so", async () => {
    const { dir } = legacyFolder();
    const client = { displayName: "Clawtrate Test", version: "0.0.0", platform: "test" };
    const host = createNodeHost({ dataDir: dir, client, secretBox: fakeBox().box });
    await host.storage.set(TOKEN_KEY, RECORD.replace(DEVICE, "device-token-3"));
    expect(await host.secureCredentials?.()).toBe(true);
    expect(await host.credentialStatus?.()).toBe("secure");
    expectNowhere(dir, [...SECRETS, "device-token-3"]);
    const plain = createNodeHost({ dataDir: legacyFolder().dir, client });
    expect(await plain.secureCredentials?.()).toBe(false);
  });
});
