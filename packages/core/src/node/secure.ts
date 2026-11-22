// This device's credentials in the system's secure storage
// (docs/decisions.md, "This device's credentials in secure storage"): its device tokens, the saved gateway
// settings that can carry a gateway token while pairing, and its signing key.
// They are kept together in one file encrypted by the system's secure storage
// (on macOS, Electron's safeStorage with its key in the Keychain). Everything
// else stays in `state.json`.
//
// They move once, and a restart at any point is safe. The encrypted copy is
// written beside the old files, read back and decrypted, and only then takes
// its place; the clear-text copies are removed after that. Once the encrypted
// copy exists it is authoritative: a clear-text copy an interrupted removal
// left is never read, and is removed again at the next start.
//
// Secure storage that can't be used fails closed. Before anything has moved,
// credentials already in the files are read, and every change is kept in this
// process only, for this session: no credential is written in clear text. After they
// have moved, nothing is read or written until secure storage works again.
// Either way the host has no full access (`ClawtrateHost.secureCredentials`).

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClawtrateHost, DeviceSigner, KeyValueStore } from "../host.ts";
import { createFileStore, createPemSigner, newDeviceKeyPem } from "./index.ts";

export const STATE_FILE = "state.json";
export const DEVICE_KEY_FILE = "device-key.pem";
export const CREDENTIALS_FILE = "credentials.bin";

/** The system's secure storage, as the host reaches it. */
export type SecretBox = {
  /** Whether it can encrypt and decrypt now. */
  available(): Promise<boolean>;
  encrypt(text: string): Promise<Uint8Array>;
  /** Rejects when the data isn't this box's, or the system can't decrypt it now. */
  decrypt(data: Uint8Array): Promise<string>;
};

/** The storage keys that hold a credential: the saved gateway settings and every device token. */
export function isCredentialKey(key: string): boolean {
  return key === "connection" || key.startsWith("deviceToken:");
}

export class SecureStorageUnavailableError extends Error {
  constructor() {
    super(
      "Clawtrate couldn't read this device's credentials from the system's secure storage. " +
        "Unlock your keychain and try again.",
    );
    this.name = "SecureStorageUnavailableError";
  }
}

export type SecureCredentials = {
  storage: KeyValueStore;
  signer: DeviceSigner;
  /** True once this device's credentials are kept in secure storage. */
  secure(): Promise<boolean>;
};

type Credentials = { values: Record<string, string>; deviceKey: string | null };
type Mode =
  | { kind: "secure"; credentials: Credentials }
  | { kind: "session"; credentials: Credentials }
  | { kind: "locked" };

const VERSION = 1;

function encode(credentials: Credentials): string {
  return JSON.stringify({ version: VERSION, ...credentials });
}

function decode(text: string): Credentials {
  const parsed = JSON.parse(text) as { version?: unknown; values?: unknown; deviceKey?: unknown };
  const { values, deviceKey } = parsed;
  if (
    parsed.version !== VERSION ||
    typeof values !== "object" ||
    values === null ||
    Array.isArray(values) ||
    !Object.values(values).every((value) => typeof value === "string") ||
    (deviceKey !== null && typeof deviceKey !== "string")
  )
    throw new Error("unreadable protected record");
  return { values: { ...(values as Record<string, string>) }, deviceKey };
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function createSecureCredentials(options: {
  dataDir: string;
  box: SecretBox;
  log?: ClawtrateHost["log"];
}): SecureCredentials {
  const { box, dataDir } = options;
  const statePath = join(dataDir, STATE_FILE);
  const keyPath = join(dataDir, DEVICE_KEY_FILE);
  const sealedPath = join(dataDir, CREDENTIALS_FILE);
  const plain = createFileStore(statePath);
  // Fixed lines only: nothing read from a file or from secure storage is ever logged.
  const warn = (message: string) => options.log?.("warn", message);

  /** Encrypts, writes beside the record, reads that back and decrypts it, and only then replaces the record. */
  const seal = async (credentials: Credentials) => {
    const text = encode(credentials);
    const data = await box.encrypt(text);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const temp = `${sealedPath}.${process.pid}.tmp`;
    try {
      await writeFile(temp, data, { mode: 0o600 });
      await chmod(temp, 0o600);
      if ((await box.decrypt(await readFile(temp))) !== text)
        throw new Error("the protected record read back differently");
      await rename(temp, sealedPath);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  };

  /** The credentials still in the files, as earlier versions kept them. */
  const legacy = async (): Promise<{ credentials: Credentials; keys: string[] }> => {
    const state = await readOptional(statePath);
    const saved = state ? (JSON.parse(state.toString("utf8")) as Record<string, string>) : {};
    const keys = Object.keys(saved).filter(isCredentialKey);
    const pem = (await readOptional(keyPath))?.toString("utf8") ?? null;
    return {
      credentials: {
        values: Object.fromEntries(keys.map((key) => [key, saved[key]!])),
        deviceKey: pem,
      },
      keys,
    };
  };

  /** Removes the clear-text copies, once the protected record holds them. A failure is tried again at the next start. */
  const sweep = async (keys: string[], pem: boolean) => {
    try {
      for (const key of keys) await plain.delete(key);
      if (pem) await rm(keyPath, { force: true });
    } catch {
      warn(
        "Could not remove the earlier copy of this device's credentials. Clawtrate tries again at its next start.",
      );
    }
  };

  const openMode = async (): Promise<Mode> => {
    const sealed = await readOptional(sealedPath);
    const available = await box.available().catch(() => false);
    if (sealed) {
      let credentials: Credentials;
      try {
        if (!available) throw new Error("unavailable");
        credentials = decode(await box.decrypt(sealed));
      } catch {
        warn("This device's credentials are in secure storage, which can't be read now.");
        return { kind: "locked" };
      }
      // An interrupted removal may have left clear-text copies: the protected record wins.
      const found = await legacy().catch(() => null);
      if (found) await sweep(found.keys, found.credentials.deviceKey !== null);
      return { kind: "secure", credentials };
    }
    const found = await legacy();
    if (available) {
      try {
        await seal(found.credentials);
        await sweep(found.keys, found.credentials.deviceKey !== null);
        return { kind: "secure", credentials: found.credentials };
      } catch {
        // Nothing replaced anything: the files are as they were.
      }
    }
    warn(
      "Secure storage isn't available. This device's credentials are kept for this session only.",
    );
    return { kind: "session", credentials: found.credentials };
  };

  let opened: Promise<Mode> | null = null;
  const mode = () => (opened ??= openMode());
  let queue: Promise<void> = Promise.resolve();

  /** One change to the credentials, after the previous one: sealed first in secure storage, or kept in memory for the session. */
  const change = (apply: (credentials: Credentials) => Credentials) => {
    const run = queue.then(async () => {
      const current = await mode();
      if (current.kind === "locked") throw new SecureStorageUnavailableError();
      const next = apply(current.credentials);
      if (current.kind === "secure") await seal(next);
      current.credentials = next;
    });
    queue = run.catch(() => {});
    return run;
  };

  const credentials = async () => {
    const current = await mode();
    if (current.kind === "locked") throw new SecureStorageUnavailableError();
    return current.credentials;
  };

  return {
    storage: {
      get: async (key) =>
        isCredentialKey(key) ? ((await credentials()).values[key] ?? null) : plain.get(key),
      set: (key, value) =>
        isCredentialKey(key)
          ? change((current) => ({ ...current, values: { ...current.values, [key]: value } }))
          : plain.set(key, value),
      delete: (key) =>
        isCredentialKey(key)
          ? change((current) => {
              const { [key]: _removed, ...values } = current.values;
              return { ...current, values };
            })
          : plain.delete(key),
    },
    signer: createPemSigner(async () => {
      const existing = (await credentials()).deviceKey;
      if (existing !== null) return existing;
      const created = newDeviceKeyPem();
      await change((current) =>
        current.deviceKey === null ? { ...current, deviceKey: created } : current,
      );
      return (await credentials()).deviceKey!;
    }),
    secure: async () => (await mode().catch(() => null))?.kind === "secure",
  };
}
