// Node implementations of the host services: a JSON file store, an Ed25519 key
// kept in a private file, and the built-in WebSocket. Used by Electron's main
// process and by the web preview host. Never imported by shared code.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createSecureCredentials, DEVICE_KEY_FILE, STATE_FILE, type SecretBox } from "./secure.ts";
import type {
  ClawtrateHost,
  ClientIdentity,
  DeviceSigner,
  KeyValueStore,
  WebSocketLike,
} from "../host.ts";

export {
  createSecureCredentials,
  CREDENTIALS_FILE,
  DEVICE_KEY_FILE,
  isCredentialKey,
  SecureStorageUnavailableError,
  STATE_FILE,
  type SecretBox,
  type SecureCredentials,
} from "./secure.ts";

async function writePrivateFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, contents, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

/**
 * A key/value store persisted as one JSON file with owner-only permissions. A
 * change is written to a copy, and the copy becomes what `get` reads only once
 * the file has been replaced.
 */
export function createFileStore(path: string): KeyValueStore {
  let cache: Record<string, string> | null = null;
  let queue: Promise<void> = Promise.resolve();

  const load = async () => {
    if (cache) return cache;
    // A write can land while this read is in flight; the first value to fill the cache wins.
    try {
      const loaded = JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
      cache ??= loaded;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      cache ??= {};
    }
    return cache;
  };
  const persist = (mutate: (data: Record<string, string>) => void) => {
    const run = queue.then(async () => {
      const data = { ...(await load()) };
      mutate(data);
      await writePrivateFile(path, `${JSON.stringify(data, null, 2)}\n`);
      cache = data;
    });
    queue = run.catch(() => {});
    return run;
  };

  return {
    get: async (key) => (await load())[key] ?? null,
    set: (key, value) =>
      persist((data) => {
        data[key] = value;
      }),
    delete: (key) =>
      persist((data) => {
        delete data[key];
      }),
  };
}

/** Raw 32-byte Ed25519 public key from a SPKI key object. */
function rawPublicKey(publicKeyPem: string): Buffer {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(der.length - 32));
}

/** A new Ed25519 private key, PKCS#8 PEM. */
export function newDeviceKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

/** The device key in a private PEM file, created there on first use. */
export async function fileDeviceKey(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const privateKeyPem = newDeviceKeyPem();
    await writePrivateFile(path, privateKeyPem);
    return privateKeyPem;
  }
}

/** Ed25519 device identity in a PEM file, created on first use. */
export function createFileSigner(path: string): DeviceSigner {
  return createPemSigner(() => fileDeviceKey(path));
}

/** Ed25519 device identity from a PEM key `loadPem` gives, read once and kept. */
export function createPemSigner(loadPem: () => Promise<string>): DeviceSigner {
  let loaded: Promise<{ privateKeyPem: string; deviceId: string; publicKey: string }> | null = null;

  const load = () =>
    (loaded ??= (async () => {
      const privateKeyPem = await loadPem();
      const publicKeyPem = createPublicKey(createPrivateKey(privateKeyPem))
        .export({ type: "spki", format: "pem" })
        .toString();
      const raw = rawPublicKey(publicKeyPem);
      return {
        privateKeyPem,
        deviceId: createHash("sha256").update(raw).digest("hex"),
        publicKey: raw.toString("base64url"),
      };
    })());

  return {
    async loadIdentity() {
      const { deviceId, publicKey } = await load();
      return { deviceId, publicKey };
    },
    async sign(payload) {
      const { privateKeyPem } = await load();
      return sign(null, Buffer.from(payload, "utf8"), createPrivateKey(privateKeyPem)).toString(
        "base64url",
      );
    },
  };
}

export type NodeHostOptions = {
  /** Directory for the device key and saved connection state. Created with mode 0700. */
  dataDir: string;
  /**
   * The system's secure storage. With it, this device's credentials are kept
   * encrypted by it (`createSecureCredentials`); without it, in the files as before.
   */
  secretBox?: SecretBox;
  client: ClientIdentity;
  log?: ClawtrateHost["log"];
  approvalInstructions?: ClawtrateHost["approvalInstructions"];
};

export function createNodeHost(options: NodeHostOptions): ClawtrateHost {
  const credentials = options.secretBox
    ? createSecureCredentials({
        dataDir: options.dataDir,
        box: options.secretBox,
        ...(options.log ? { log: options.log } : {}),
      })
    : {
        storage: createFileStore(join(options.dataDir, STATE_FILE)),
        signer: createFileSigner(join(options.dataDir, DEVICE_KEY_FILE)),
        secure: async () => false,
      };
  return {
    createWebSocket: (url) => new WebSocket(url) as unknown as WebSocketLike,
    storage: credentials.storage,
    signer: credentials.signer,
    secureCredentials: credentials.secure,
    client: options.client,
    ...(options.log ? { log: options.log } : {}),
    ...(options.approvalInstructions ? { approvalInstructions: options.approvalInstructions } : {}),
  };
}
