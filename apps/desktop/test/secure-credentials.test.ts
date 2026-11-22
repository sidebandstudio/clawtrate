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
import { createDecipheriv } from "node:crypto";
import type * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keepAside } from "../src/main/secret-box.ts";

// Every byte written to a temporary file, and a rename a test makes fail.
const fsHooks = vi.hoisted(() => ({
  written: [] as Array<{ file: string; text: string }>,
  failRename: null as null | ((to: string) => boolean),
  /** Folder syncs to refuse, from the next one on. */
  failFolderSyncs: 0,
  /** Removals to refuse. */
  failRm: null as null | ((path: string) => boolean),
  /** A rename to hold until its gate opens, and folder syncs to refuse right after a rename. */
  holdRename: null as null | { match: (to: string) => boolean; gate: Promise<void> },
  failSyncsAfterRename: null as null | ((to: string) => number),
  /** Called once, right after the next rename onto a matching path completes. */
  onRenamed: null as null | { match: (to: string) => boolean; run: () => void },
  /** Called once, when the next folder handle closes (after its sync). */
  onFolderClose: null as null | (() => void),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  const open = (async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const file = String(args[0]);
    const folder = args[1] === "r" && (await handle.stat()).isDirectory();
    return new Proxy(handle, {
      get(target, prop, receiver) {
        if (prop === "close" && folder && fsHooks.onFolderClose) {
          const hook = fsHooks.onFolderClose;
          fsHooks.onFolderClose = null;
          return async () => {
            await target.close();
            hook();
          };
        }
        if (prop === "sync" && folder && fsHooks.failFolderSyncs > 0)
          return () => {
            fsHooks.failFolderSyncs -= 1;
            return Promise.reject(Object.assign(new Error("sync refused"), { code: "EIO" }));
          };
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
  const rename = (async (from: string, to: string) => {
    if (fsHooks.failRename?.(String(to)))
      throw Object.assign(new Error("rename refused"), { code: "EIO" });
    const hold = fsHooks.holdRename;
    if (hold?.match(String(to))) {
      fsHooks.holdRename = null;
      await hold.gate;
    }
    await actual.rename(from, to);
    const renamed = fsHooks.onRenamed;
    if (renamed?.match(String(to))) {
      fsHooks.onRenamed = null;
      renamed.run();
    }
    const fails = fsHooks.failSyncsAfterRename?.(String(to)) ?? 0;
    if (fails > 0) {
      fsHooks.failSyncsAfterRename = null;
      fsHooks.failFolderSyncs = fails;
    }
  }) as typeof actual.rename;
  const rm = ((path: string, options?: Parameters<typeof actual.rm>[1]) =>
    fsHooks.failRm?.(String(path))
      ? Promise.reject(Object.assign(new Error("removal refused"), { code: "EPERM" }))
      : actual.rm(path, options)) as typeof actual.rm;
  return { ...actual, open, writeFile, rename, rm };
});

/** A promise and the function that settles it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

/** Waits until `check` passes, for up to four seconds. */
async function until(check: () => boolean): Promise<void> {
  for (const end = Date.now() + 4_000; !check();) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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
  fsHooks.onFolderClose = null;
  fsHooks.written.length = 0;
  fsHooks.failRename = null;
  fsHooks.failFolderSyncs = 0;
  fsHooks.failRm = null;
  fsHooks.holdRename = null;
  fsHooks.failSyncsAfterRename = null;
  fsHooks.onRenamed = null;
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

/** The values in the folder's sealed record, opened with `fakeBox`'s key as the app would. */
async function sealedValues(dir: string): Promise<Record<string, string>> {
  const outer = JSON.parse(readFileSync(join(dir, CREDENTIALS_FILE), "utf8")) as Record<
    string,
    string
  >;
  const field = (name: string) => Buffer.from(outer[name]!, "base64");
  const key = Buffer.from(await fakeBox().box.decrypt(field("key")), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, field("nonce"));
  decipher.setAAD(Buffer.from("clawtrate credentials v2"));
  decipher.setAuthTag(field("tag"));
  const plain = Buffer.concat([decipher.update(field("data")), decipher.final()]);
  return (JSON.parse(plain.toString("utf8")) as { values: Record<string, string> }).values;
}

/** The device token key of the device whose key this is, for `URL`. */
const ownTokenKey = async (pem: string) =>
  `deviceToken:${encodeURIComponent(URL)}:${await deviceIdOf(pem)}:operator`;

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

  it("a settings write that fails changes nothing, and a later unrelated save doesn't carry it to disk", async () => {
    const { dir } = legacyFolder();
    const credentials = open(dir, fakeBox().box);
    expect(await credentials.secure()).toBe(true);
    // The next settings replacement fails at its rename, once.
    let refuse = true;
    fsHooks.failRename = (to) => {
      if (!refuse || !to.endsWith(STATE_FILE)) return false;
      refuse = false;
      return true;
    };
    await expect(credentials.storage.set("turn-limit-minutes", "45")).rejects.toThrow();
    // Not what reads return...
    expect(await credentials.storage.get("turn-limit-minutes")).toBe("30");
    // ...and not written by the next change, which is kept.
    await credentials.storage.set("sidebar", "wide");
    expect(state(dir)).toEqual({
      connection: NO_TOKEN,
      "turn-limit-minutes": "30",
      sidebar: "wide",
    });
    expect(await credentials.storage.get("turn-limit-minutes")).toBe("30");
    expect(await open(dir, fakeBox().box).storage.get("turn-limit-minutes")).toBe("30");
  });

  it("a gateway settings write or removal that fails changes nothing, typed token included, and a later save keeps the old gateway", async () => {
    const { dir } = legacyFolder();
    const credentials = open(dir, fakeBox().box);
    const a = JSON.stringify({ url: "ws://127.0.0.1:19002", token: "typed-A" });
    await credentials.storage.set("connection", a);
    const refuseOnce = () => {
      let refuse = true;
      fsHooks.failRename = (to) => {
        if (!refuse || !to.endsWith(STATE_FILE)) return false;
        refuse = false;
        return true;
      };
    };
    refuseOnce();
    const b = JSON.stringify({ url: "ws://127.0.0.1:19003", token: "typed-B" });
    await expect(credentials.storage.set("connection", b)).rejects.toThrow();
    expect(await credentials.storage.get("connection")).toBe(a);
    refuseOnce();
    await expect(credentials.storage.delete("connection")).rejects.toThrow();
    expect(await credentials.storage.get("connection")).toBe(a);
    await credentials.storage.set("turn-limit-minutes", "45");
    expect(JSON.parse(state(dir).connection!)).toEqual({
      url: "ws://127.0.0.1:19002",
      token: null,
    });
    expect(await credentials.storage.get("connection")).toBe(a);
  });

  // Windows has no folder sync (`syncFolder`), so there is none to fail.
  it.skipIf(process.platform === "win32")(
    "cleanup waits for the sealed record's folder to be on disk: a failed sync changes no earlier file",
    async () => {
      const { dir } = legacyFolder();
      await open(dir, fakeBox().box).signer.loadIdentity();
      // Clear text an interrupted removal left beside the record.
      writeFileSync(
        join(dir, STATE_FILE),
        JSON.stringify({ connection: NO_TOKEN, [TOKEN_KEY]: RECORD.replace(DEVICE, "stale") }),
      );
      const before = readFileSync(join(dir, STATE_FILE), "utf8");
      fsHooks.failFolderSyncs = 1;
      const again = open(dir, fakeBox().box);
      expect(await again.status()).toBe("cleanup-pending");
      expect(readFileSync(join(dir, STATE_FILE), "utf8")).toBe(before);
      // The next change finishes it.
      await again.storage.set(TOKEN_KEY, RECORD);
      expect(await again.status()).toBe("secure");
      expect(everything(dir)).not.toContain("stale");
    },
  );

  it("a pending cleanup is tried again after a credential-only change, and full access waits for it", async () => {
    const { dir } = legacyFolder();
    fsHooks.failRename = (to) => to.endsWith(STATE_FILE);
    const credentials = open(dir, fakeBox().box);
    expect(await credentials.status()).toBe("cleanup-pending");
    // Still failing: the token is kept, the cleanup stays pending.
    await credentials.storage.set(TOKEN_KEY, RECORD.replace(DEVICE, "token-2"));
    expect(await credentials.secure()).toBe(false);
    fsHooks.failRename = null;
    await credentials.storage.set(TOKEN_KEY, RECORD.replace(DEVICE, "token-3"));
    expect(await credentials.secure()).toBe(true);
    expect(existsSync(join(dir, DEVICE_KEY_FILE))).toBe(false);
    expectNowhere(dir, SECRETS);
  });

  it("a host given secure storage makes its missing data folder, private, before it reads it", async () => {
    const parent = emptyFolder();
    const dir = join(parent, "not", "yet");
    const client = { displayName: "Clawtrate Test", version: "0.0.0", platform: "test" };
    const host = createNodeHost({ dataDir: dir, client, secretBox: fakeBox().box });
    expect((await host.signer.loadIdentity()).deviceId).toMatch(/^[0-9a-f]{64}$/);
    expect(await host.secureCredentials?.()).toBe(true);
    if (process.platform !== "win32") expect(statSync(dir).mode & 0o077).toBe(0);
  });

  it("a settings change while the old key file can't be removed changes nothing, live or at the next start", async () => {
    const { dir } = legacyFolder();
    fsHooks.failRm = (path) => path.endsWith(DEVICE_KEY_FILE);
    const credentials = open(dir, fakeBox().box);
    expect(await credentials.status()).toBe("cleanup-pending");
    await expect(credentials.storage.set("turn-limit-minutes", "45")).rejects.toThrow();
    expect(await credentials.storage.get("turn-limit-minutes")).toBe("30");
    expect(state(dir)["turn-limit-minutes"]).toBe("30");
    expect(await open(dir, fakeBox().box).storage.get("turn-limit-minutes")).toBe("30");
  });

  it("a gateway switch commits at its settings write: before it, nothing changes; after it, the switch is whole", async () => {
    const b = JSON.stringify({ url: "ws://127.0.0.1:19003", token: "typed-B" });
    const reopened = async (dir: string) => open(dir, fakeBox().box).storage.get("connection");
    // The settings write fails, and so does every rename after it: the old gateway, with its token.
    {
      const { dir } = legacyFolder();
      const one = open(dir, fakeBox().box);
      expect(await one.storage.get("connection")).toBe(CONNECTION);
      fsHooks.failRename = (to) => to.endsWith(STATE_FILE) || to.endsWith(CREDENTIALS_FILE);
      await expect(one.storage.set("connection", b)).rejects.toThrow();
      expect(await one.storage.get("connection")).toBe(CONNECTION);
      fsHooks.failRename = null;
      expect(await reopened(dir)).toBe(CONNECTION);
    }
    // The settings are kept, and the earlier token's removal fails, as if the process had
    // stopped between the two: the switch has committed, and the old token is never used.
    {
      const { dir } = legacyFolder();
      let reads = 0;
      const two = open(
        dir,
        fakeBox({
          decrypt: async (data) => {
            if ((reads += 1) > 1) throw new Error("locked");
            return fakeBox().box.decrypt(data);
          },
        }).box,
      );
      expect(await two.storage.get("connection")).toBe(CONNECTION);
      await two.storage.set("connection", b);
      expect(await two.storage.get("connection")).toBe(b);
      expect(await reopened(dir)).toBe(
        JSON.stringify({ url: "ws://127.0.0.1:19003", token: null }),
      );
      // That start removed the copy left behind: back at the old address, it gives no token.
      writeFileSync(join(dir, STATE_FILE), JSON.stringify({ connection: NO_TOKEN }));
      expect(await reopened(dir)).toBe(NO_TOKEN);
    }
  });

  it("forgetting the gateway commits at its settings write, and an earlier build's token left behind is never used", async () => {
    const reopened = async (dir: string) => open(dir, fakeBox().box).storage.get("connection");
    // The settings write fails: the gateway stays, with its earlier token.
    {
      const { dir } = legacyFolder();
      const one = open(dir, fakeBox().box);
      expect(await one.storage.get("connection")).toBe(CONNECTION);
      fsHooks.failRename = (to) => to.endsWith(STATE_FILE);
      await expect(one.storage.delete("connection")).rejects.toThrow();
      expect(await one.storage.get("connection")).toBe(CONNECTION);
      fsHooks.failRename = null;
      expect(await reopened(dir)).toBe(CONNECTION);
    }
    // The settings are kept and the token's removal fails: forgotten, and the token isn't revived.
    {
      const { dir } = legacyFolder();
      let reads = 0;
      const two = open(
        dir,
        fakeBox({
          decrypt: async (data) => {
            if ((reads += 1) > 1) throw new Error("locked");
            return fakeBox().box.decrypt(data);
          },
        }).box,
      );
      expect(await two.storage.get("connection")).toBe(CONNECTION);
      await two.storage.delete("connection");
      expect(await two.storage.get("connection")).toBe(null);
      expect(await reopened(dir)).toBe(null);
      writeFileSync(join(dir, STATE_FILE), JSON.stringify({ connection: NO_TOKEN }));
      expect(await reopened(dir)).toBe(NO_TOKEN);
    }
  });

  it("once this device is paired, an earlier build's token whose removal failed is never used again", async () => {
    const { dir, pem } = legacyFolder();
    const setup = open(dir, fakeBox().box);
    await setup.storage.set(await ownTokenKey(pem), RECORD);
    let reads = 0;
    const paired = open(
      dir,
      fakeBox({
        decrypt: async (data) => {
          if ((reads += 1) > 1) throw new Error("locked");
          return fakeBox().box.decrypt(data);
        },
      }).box,
    );
    // Paired: the earlier token isn't offered, before or after its removal fails.
    expect(await paired.storage.get("connection")).toBe(NO_TOKEN);
    await paired.storage.set("connection", NO_TOKEN);
    expect(await paired.storage.get("connection")).toBe(NO_TOKEN);
    expect(await open(dir, fakeBox().box).storage.get("connection")).toBe(NO_TOKEN);
  });

  it("a reader during a gateway switch sees the whole old gateway or the whole new one, never a mix", async () => {
    const { dir } = legacyFolder();
    const credentials = open(dir, fakeBox().box);
    expect(await credentials.storage.get("connection")).toBe(CONNECTION);
    const b = JSON.stringify({ url: "ws://127.0.0.1:19003", token: "typed-B" });
    // Held at the settings write: the old gateway, with its token.
    const settingsGate = deferred<void>();
    fsHooks.holdRename = { match: (to) => to.endsWith(STATE_FILE), gate: settingsGate.promise };
    const switching = credentials.storage.set("connection", b);
    await until(() => fsHooks.holdRename === null);
    expect(await credentials.storage.get("connection")).toBe(CONNECTION);
    // Held at the earlier token's removal, after the settings committed: the new gateway.
    const removalGate = deferred<void>();
    fsHooks.holdRename = {
      match: (to) => to.endsWith(CREDENTIALS_FILE),
      gate: removalGate.promise,
    };
    settingsGate.resolve();
    await until(() => fsHooks.holdRename === null);
    expect(await credentials.storage.get("connection")).toBe(b);
    removalGate.resolve();
    await switching;
    expect(await credentials.storage.get("connection")).toBe(b);
    expect(await open(dir, fakeBox().box).storage.get("connection")).toBe(
      JSON.stringify({ url: "ws://127.0.0.1:19003", token: null }),
    );
  });

  // Windows has no folder sync (`syncFolder`), so there is none to fail.
  it.skipIf(process.platform === "win32")(
    "an earlier token's removal whose rename lands but whose folder syncs both fail is indeterminate, after the switch committed",
    async () => {
      const { dir } = legacyFolder();
      const credentials = open(dir, fakeBox().box);
      expect(await credentials.storage.get("connection")).toBe(CONNECTION);
      const b = JSON.stringify({ url: "ws://127.0.0.1:19003", token: "typed-B" });
      fsHooks.failSyncsAfterRename = (to) => (to.endsWith(CREDENTIALS_FILE) ? 2 : 0);
      // Committed at its settings write: the call succeeds, and the store reads the disk again.
      await credentials.storage.set("connection", b);
      expect(fsHooks.failFolderSyncs).toBe(0);
      // Live: the new gateway, with the token typed for this attempt.
      expect(await credentials.storage.get("connection")).toBe(b);
      expect(await open(dir, fakeBox().box).storage.get("connection")).toBe(
        JSON.stringify({ url: "ws://127.0.0.1:19003", token: null }),
      );
      // The old address's token is gone, or unused: never offered again.
      writeFileSync(join(dir, STATE_FILE), JSON.stringify({ connection: NO_TOKEN }));
      expect(await open(dir, fakeBox().box).storage.get("connection")).toBe(NO_TOKEN);
    },
  );

  it("a same-address replacement retires the earlier token in its settings commit, so a failed or interrupted removal can't revive it", async () => {
    const typed = JSON.stringify({ url: URL, token: "typed-new" });
    const lockedAfterOpen = () => {
      let reads = 0;
      return fakeBox({
        decrypt: async (data) => {
          if ((reads += 1) > 1) throw new Error("locked");
          return fakeBox().box.decrypt(data);
        },
      }).box;
    };
    // The earlier token's removal fails after the settings committed.
    {
      const { dir } = legacyFolder();
      const one = open(dir, lockedAfterOpen());
      expect(await one.storage.get("connection")).toBe(CONNECTION);
      await one.storage.set("connection", typed);
      expect(await one.storage.get("connection")).toBe(typed);
      const relaunched = await open(dir, fakeBox().box).storage.get("connection");
      expect(relaunched).toBe(NO_TOKEN);
      expect(everything(dir)).not.toContain("typed-new");
    }
    // The process stops between the two writes: a fresh start while the removal is held.
    {
      const { dir } = legacyFolder();
      const two = open(dir, fakeBox().box);
      expect(await two.storage.get("connection")).toBe(CONNECTION);
      const removal = deferred<void>();
      fsHooks.holdRename = { match: (to) => to.endsWith(CREDENTIALS_FILE), gate: removal.promise };
      const switching = two.storage.set("connection", typed);
      await until(() => fsHooks.holdRename === null);
      expect(await open(dir, fakeBox().box).storage.get("connection")).toBe(NO_TOKEN);
      expect(everything(dir)).not.toContain("typed-new");
      removal.resolve();
      await switching.catch(() => {});
    }
  });

  it("switching away and back while the earlier token's removal keeps failing never revives it, live or after relaunch", async () => {
    const { dir } = legacyFolder();
    let reads = 0;
    const lockedAfterOpen = fakeBox({
      decrypt: async (data) => {
        if ((reads += 1) > 1) throw new Error("locked");
        return fakeBox().box.decrypt(data);
      },
    }).box;
    const credentials = open(dir, lockedAfterOpen);
    expect(await credentials.storage.get("connection")).toBe(CONNECTION);
    // Another gateway: the earlier token's removal fails, so its sealed copy stays.
    const other = JSON.stringify({ url: "ws://127.0.0.1:19003", token: null });
    await credentials.storage.set("connection", other);
    expect(await credentials.storage.get("connection")).toBe(other);
    // Back to the first address, with no token typed: the earlier token stays retired.
    await credentials.storage.set("connection", NO_TOKEN);
    expect(await credentials.storage.get("connection")).toBe(NO_TOKEN);
    expect(await open(dir, fakeBox().box).storage.get("connection")).toBe(NO_TOKEN);
  });

  it("starting fresh with the settings set aside keeps the earlier token retired while its removal fails, and keeps the device pairing", async () => {
    const { dir, pem } = legacyFolder();
    expect(await open(dir, fakeBox().box).storage.get("connection")).toBe(CONNECTION);
    // The recovery for unreadable settings: `state.json` set aside, the sealed record kept.
    await keepAside(join(dir, STATE_FILE), new Date("2026-11-22T10:20:30Z"));
    fsHooks.failRename = (to) => to.endsWith(CREDENTIALS_FILE);
    const fresh = open(dir, fakeBox().box);
    expect(await fresh.storage.get("connection")).toBe(null);
    // The person chooses the same gateway again, with no token typed.
    await fresh.storage.set("connection", NO_TOKEN);
    expect(await fresh.storage.get("connection")).toBe(NO_TOKEN);
    expect(await open(dir, fakeBox().box).storage.get("connection")).toBe(NO_TOKEN);
    // Once the removal works, the copy goes; the device pairing and identity stay.
    fsHooks.failRename = null;
    const relaunched = open(dir, fakeBox().box);
    expect(await relaunched.storage.get("connection")).toBe(NO_TOKEN);
    expect(await relaunched.storage.get(TOKEN_KEY)).toBe(RECORD);
    expect((await relaunched.signer.loadIdentity()).deviceId).toBe(await deviceIdOf(pem));
    expect(await sealedValues(dir)).not.toHaveProperty("connection");
  });

  it("removing this device's own token never revives the earlier build's token, live or after relaunch", async () => {
    const { dir, pem } = legacyFolder();
    const credentials = open(dir, fakeBox().box);
    expect(await credentials.storage.get("connection")).toBe(CONNECTION);
    const own = await ownTokenKey(pem);
    // Paired: this device's token retires the earlier one in the same commit.
    await credentials.storage.set(own, RECORD);
    expect(await credentials.storage.get("connection")).toBe(NO_TOKEN);
    // The device token is refused and removed later.
    await credentials.storage.delete(own);
    expect(await credentials.storage.get("connection")).toBe(NO_TOKEN);
    expect(await open(dir, fakeBox().box).storage.get("connection")).toBe(NO_TOKEN);
  });

  it("an earlier build's token moved in beside this device's own is retired when that token is removed", async () => {
    const { dir, pem } = legacyFolder();
    const own = await ownTokenKey(pem);
    // Both came from the earlier build's files: no save of this device's token ran here.
    writeFileSync(
      join(dir, STATE_FILE),
      JSON.stringify({ connection: CONNECTION, [own]: RECORD, "turn-limit-minutes": "30" }),
    );
    const credentials = open(dir, fakeBox().box);
    expect(await credentials.storage.get("connection")).toBe(NO_TOKEN);
    // The first sealed record already leaves it out, beside this device's own token.
    const first = await sealedValues(dir);
    expect(first).not.toHaveProperty("connection");
    expect(first[own]).toBe(RECORD);
    expect(JSON.stringify(first)).not.toContain(SHARED);
    await credentials.storage.delete(own);
    expect(await credentials.storage.get("connection")).toBe(NO_TOKEN);
    expect(await open(dir, fakeBox().box).storage.get("connection")).toBe(NO_TOKEN);
  });

  it("an earlier build's token moved in beside another device's or another gateway's token stays in the first sealed record", async () => {
    // Another device's token for the same gateway: the earlier folder's own `TOKEN_KEY`.
    {
      const { dir } = legacyFolder();
      expect(await open(dir, fakeBox().box).storage.get("connection")).toBe(CONNECTION);
      const first = await sealedValues(dir);
      expect(first.connection).toBe(CONNECTION);
      expect(first[TOKEN_KEY]).toBe(RECORD);
    }
    // This device's token for another gateway.
    {
      const { dir, pem } = legacyFolder();
      const elsewhere = `deviceToken:${encodeURIComponent("ws://127.0.0.1:19009")}:${await deviceIdOf(pem)}:operator`;
      writeFileSync(
        join(dir, STATE_FILE),
        JSON.stringify({ connection: CONNECTION, [elsewhere]: RECORD, "turn-limit-minutes": "30" }),
      );
      expect(await open(dir, fakeBox().box).storage.get("connection")).toBe(CONNECTION);
      const first = await sealedValues(dir);
      expect(first.connection).toBe(CONNECTION);
      expect(first[elsewhere]).toBe(RECORD);
    }
  });

  it("readers during a switch see the settings and their typed token together, never one without the other", async () => {
    const { dir } = legacyFolder();
    const credentials = open(dir, fakeBox().box);
    const a = JSON.stringify({ url: URL, token: "typed-A" });
    const b = JSON.stringify({ url: "ws://127.0.0.1:19003", token: "typed-B" });
    await credentials.storage.set("connection", a);
    // From the moment the new settings' file is renamed into place, on every platform, a read
    // starts at once and then on every turn of the event loop until the switch has returned:
    // before, across and after the moment the settings and their typed token are published.
    const reads: Array<Promise<string | null>> = [];
    let switched = false;
    fsHooks.onRenamed = {
      match: (to) => to.endsWith(STATE_FILE),
      run: () => {
        const next = () => {
          reads.push(credentials.storage.get("connection"));
          if (!switched) setImmediate(next);
        };
        next();
      },
    };
    await credentials.storage.set("connection", b);
    switched = true;
    await new Promise((resolve) => setImmediate(resolve));
    const seen = await Promise.all(reads);
    expect(seen[0]).toBe(a);
    expect(seen.filter((value) => value !== a && value !== b)).toEqual([]);
    expect(seen.at(-1)).toBe(b);
  });

  it("readers right after the settings' write finishes see the new settings with their typed token, never the settings alone", async () => {
    const { dir } = legacyFolder();
    const credentials = open(dir, fakeBox().box);
    const a = JSON.stringify({ url: URL, token: "typed-A" });
    const b = JSON.stringify({ url: "ws://127.0.0.1:19003", token: "typed-B" });
    await credentials.storage.set("connection", a);
    // The write's last step is the folder sync after the rename, or the rename itself on
    // Windows, where folders aren't synced. From there a read starts on each of the next
    // microtasks: across the settings' publication and the continuation of the call that
    // wrote them, so a typed token assigned in that continuation is seen missing.
    const reads: Array<Promise<string | null>> = [];
    const burst = () => {
      let left = 40;
      const next = () => {
        reads.push(credentials.storage.get("connection"));
        if ((left -= 1) > 0) queueMicrotask(next);
      };
      queueMicrotask(next);
    };
    fsHooks.onRenamed = {
      match: (to) => to.endsWith(STATE_FILE),
      run: () => {
        if (process.platform === "win32") burst();
        else fsHooks.onFolderClose = burst;
      },
    };
    await credentials.storage.set("connection", b);
    await until(() => reads.length === 40);
    const seen = await Promise.all(reads);
    expect(seen.filter((value) => value !== a && value !== b)).toEqual([]);
    expect(seen).toContain(b);
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
    // A live writer's file may hold a credential: cleanup isn't confirmed while it is there.
    expect(await credentials.secure()).toBe(false);
    expect(await credentials.status()).toBe("cleanup-pending");
    expect(existsSync(join(dir, ended))).toBe(false);
    expect(existsSync(join(dir, live))).toBe(true);
    rmSync(join(dir, live));
    expect(await open(dir, fakeBox().box).secure()).toBe(true);
  });

  it("removes a dead writer's temporary file at a restart even when the other files are clean", async () => {
    const { dir } = legacyFolder();
    await open(dir, fakeBox().box).signer.loadIdentity();
    expect(readdirSync(dir).sort()).toEqual([CREDENTIALS_FILE, STATE_FILE].sort());
    const orphan = `${STATE_FILE}.2147483646.tmp`;
    writeFileSync(join(dir, orphan), JSON.stringify({ [TOKEN_KEY]: RECORD }));
    const again = open(dir, fakeBox().box);
    expect(await again.secure()).toBe(true);
    expect(existsSync(join(dir, orphan))).toBe(false);
    expect(everything(dir)).not.toContain(DEVICE);
  });

  // Windows has no folder sync (`syncFolder`), so there is none to fail.
  it.skipIf(process.platform === "win32")(
    "a folder sync that fails after the record's rename drops what is held, and the next use reads the disk",
    async () => {
      const { dir } = legacyFolder();
      const credentials = open(dir, fakeBox().box);
      expect(await credentials.storage.get(TOKEN_KEY)).toBe(RECORD);
      const newer = RECORD.replace(DEVICE, "token-B");
      fsHooks.failFolderSyncs = 2;
      await expect(credentials.storage.set(TOKEN_KEY, newer)).rejects.toThrow();
      // Not the snapshot from before the failed write: what the disk holds.
      expect(await credentials.storage.get(TOKEN_KEY)).toBe(newer);
      expect(await open(dir, fakeBox().box).storage.get(TOKEN_KEY)).toBe(newer);
      // A later write builds on that, and is kept.
      const latest = RECORD.replace(DEVICE, "token-C");
      await credentials.storage.set(TOKEN_KEY, latest);
      expect(await open(dir, fakeBox().box).storage.get(TOKEN_KEY)).toBe(latest);
    },
  );

  // Windows has no folder sync (`syncFolder`), so there is none to fail.
  it.skipIf(process.platform === "win32")(
    "a folder sync that fails after the move's rename keeps the earlier files, and the next start finishes the move",
    async () => {
      const { dir, pem } = legacyFolder();
      const before = readFileSync(join(dir, STATE_FILE), "utf8");
      fsHooks.failFolderSyncs = 2;
      const credentials = open(dir, fakeBox().box);
      await expect(credentials.signer.loadIdentity()).rejects.toThrow();
      expect(readFileSync(join(dir, STATE_FILE), "utf8")).toBe(before);
      expect(readFileSync(join(dir, DEVICE_KEY_FILE), "utf8")).toBe(pem);
      const again = open(dir, fakeBox().box);
      expect((await again.signer.loadIdentity()).deviceId).toBe(await deviceIdOf(pem));
      expect(await again.secure()).toBe(true);
      expect(existsSync(join(dir, DEVICE_KEY_FILE))).toBe(false);
    },
  );

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
    const { dir: other, pem } = legacyFolder();
    const paired = open(other, fakeBox().box);
    expect(await paired.storage.get("connection")).toBe(CONNECTION);
    await paired.storage.set(await ownTokenKey(pem), RECORD);
    await paired.storage.set("connection", NO_TOKEN);
    expect(await open(other, fakeBox().box).storage.get("connection")).toBe(NO_TOKEN);
  });

  it("settings that only drop a token keep an earlier build's saved token until a device token is saved for its address", async () => {
    const dir = emptyFolder();
    const pem = newDeviceKeyPem();
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ connection: CONNECTION }));
    writeFileSync(join(dir, DEVICE_KEY_FILE), pem);
    const credentials = open(dir, fakeBox().box);
    // A Disconnect or a refusal drops the typed token: the earlier saved one stays.
    await credentials.storage.set("connection", NO_TOKEN);
    expect(await open(dir, fakeBox().box).storage.get("connection")).toBe(CONNECTION);
    // Another device identity's token for the address doesn't replace it.
    const again = open(dir, fakeBox().box);
    await again.storage.set(TOKEN_KEY, RECORD);
    await again.storage.set("connection", NO_TOKEN);
    expect(await open(dir, fakeBox().box).storage.get("connection")).toBe(CONNECTION);
    // This device's own does.
    const paired = open(dir, fakeBox().box);
    await paired.storage.set(await ownTokenKey(pem), RECORD);
    await paired.storage.set("connection", NO_TOKEN);
    expect(await open(dir, fakeBox().box).storage.get("connection")).toBe(NO_TOKEN);
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
