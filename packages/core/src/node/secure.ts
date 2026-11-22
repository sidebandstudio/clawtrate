// This device's credentials in the system's secure storage (docs/decisions.md,
// "This device's credentials in secure storage"): its device tokens and its
// signing key, and while an earlier build's saved gateway token is still
// needed, that token. They are kept in one record, `credentials.bin`, sealed
// with AES-256-GCM under a random key that the system's secure storage wraps
// (on macOS, Electron's safeStorage with its key in the Keychain). safeStorage's
// own encryption carries no authentication, so the record's is what rejects a
// changed file. Settings that aren't credentials, the gateway's address
// included, stay in `state.json`, never with a credential in them. A gateway
// token typed for a new pairing is kept in this process only.
//
// An earlier build's files move once. The sealed record is written to a new
// private file, read back through it and opened, synced, renamed into place
// and the rename synced; only then is `state.json` rewritten without its
// credentials, in one write, and the key file removed. Once the record exists
// it is authoritative: an earlier build's credentials beside it are never read
// again, only removed.
//
// Secure storage that can't be used fails closed. Before anything has moved,
// the files' credentials are read and every change is kept in memory for the
// session; settings are not written while the file still holds credentials,
// since writing it would copy them. After, nothing is read or written until
// secure storage works again. Either way the host has no full access
// (`ClawtrateHost.secureCredentials`), and no credential is written in clear text.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
} from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ClawtrateHost, DeviceSigner, KeyValueStore } from "../host.ts";
import { createPemSigner, newDeviceKeyPem } from "./index.ts";

export const STATE_FILE = "state.json";
export const DEVICE_KEY_FILE = "device-key.pem";
export const CREDENTIALS_FILE = "credentials.bin";
/** The saved gateway settings: kept in `state.json` without their token. */
const SETTINGS_KEY = "connection";

/** The system's secure storage, as the host reaches it. */
export type SecretBox = {
  /** Whether it can encrypt and decrypt now. */
  available(): Promise<boolean>;
  encrypt(text: string): Promise<Uint8Array>;
  /** Rejects when the data isn't this box's, or the system can't decrypt it now. */
  decrypt(data: Uint8Array): Promise<string>;
};

/** The storage keys whose whole value is a credential: every device token. */
export function isCredentialKey(key: string): boolean {
  return key.startsWith("deviceToken:");
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

/** The sealed record is damaged or was changed: it is never opened or used. */
export class CredentialRecordInvalidError extends Error {
  constructor() {
    super(
      "Clawtrate couldn't use this device's saved credentials: the file that holds them is damaged or was changed.",
    );
    this.name = "CredentialRecordInvalidError";
  }
}

/** An earlier build's settings file can't be read as one. Nothing from it is shown. */
export class SavedSettingsInvalidError extends Error {
  constructor() {
    super("Clawtrate couldn't read this device's saved settings.");
    this.name = "SavedSettingsInvalidError";
  }
}

/**
 * A replacement whose rename happened but whose folder sync didn't: the file on disk may be the
 * new one or the old one, so what is held in memory can't be trusted until it is read again.
 */
class IndeterminateCommitError extends Error {
  constructor() {
    super("A change to this device's saved credentials may or may not have been kept.");
    this.name = "IndeterminateCommitError";
  }
}

/** Where this device's credentials are: sealed, sealed with an earlier copy still to remove, this session only, or unreadable. */
export type CredentialStatus = "secure" | "cleanup-pending" | "session" | "locked";

export type SecureCredentials = {
  storage: KeyValueStore;
  signer: DeviceSigner;
  /** True once the credentials are sealed and no earlier copy of them is left. */
  secure(): Promise<boolean>;
  status(): Promise<CredentialStatus>;
};

type Credentials = { values: Record<string, string>; deviceKey: string | null };
type Sealed = { wrapped: Buffer; key: Buffer; credentials: Credentials };
type Mode =
  | { kind: "secure"; sealed: Sealed; swept: boolean }
  | { kind: "session"; credentials: Credentials; holdSettings: boolean }
  | { kind: "locked"; error: Error };

const VERSION = 2;
/** Binds a sealed record to its format and purpose. */
const ASSOCIATED = Buffer.from("clawtrate credentials v2");
/** An earlier build's temporary files: `state.json.<pid>.tmp` and `device-key.pem.<pid>.tmp`. */
const EARLIER_TEMP = /^(state\.json|device-key\.pem)\.(\d+)\.tmp$/;

const record = (text: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

type Settings = { url: string; token: string | null; suspended?: boolean };

/**
 * A setting in `state.json`, the store's own: set by the settings commit that retires an earlier
 * build's sealed gateway token (a switch away, a same-address replacement, forgetting the
 * gateway). That token was moved in once; once retired it is never used again, whatever is
 * selected later, even if removing it failed or the process stopped first.
 */
const EARLIER_RETIRED_KEY = "earlier-gateway-token-retired";

function parseSettings(text: string): Settings | null {
  const parsed = record(text);
  if (!parsed || typeof parsed.url !== "string") return null;
  const token = parsed.token ?? null;
  if (token !== null && typeof token !== "string") return null;
  if (parsed.suspended !== undefined && typeof parsed.suspended !== "boolean") return null;
  return { ...(parsed as Settings), token };
}

const validTokenRecord = (text: string) => typeof record(text)?.token === "string";

function usableKey(pem: string): boolean {
  try {
    return createPrivateKey(pem).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

function validCredentials(value: unknown): value is Credentials {
  const parsed = value as Partial<Credentials> | null;
  const values = parsed?.values;
  if (typeof values !== "object" || values === null || Array.isArray(values)) return false;
  const deviceKey = parsed?.deviceKey;
  if (deviceKey !== null && (typeof deviceKey !== "string" || !usableKey(deviceKey))) return false;
  return Object.entries(values).every(([key, text]) =>
    typeof text !== "string"
      ? false
      : key === SETTINGS_KEY
        ? parseSettings(text) !== null
        : isCredentialKey(key) && validTokenRecord(text),
  );
}

const encodeCredentials = (credentials: Credentials) =>
  JSON.stringify({ values: credentials.values, deviceKey: credentials.deviceKey });

/** The record as stored: the wrapped key, a fresh nonce, the ciphertext and its tag. */
function seal(sealed: Sealed): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealed.key, nonce);
  cipher.setAAD(ASSOCIATED);
  const data = Buffer.concat([
    cipher.update(encodeCredentials(sealed.credentials)),
    cipher.final(),
  ]);
  return Buffer.from(
    JSON.stringify({
      version: VERSION,
      key: sealed.wrapped.toString("base64"),
      nonce: nonce.toString("base64"),
      data: data.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    }),
  );
}

/** Opens a stored record. A changed record, or one in another format, is refused before anything in it is parsed. */
async function unseal(bytes: Buffer, box: SecretBox): Promise<Sealed> {
  const outer = record(bytes.toString("utf8"));
  const field = (name: string) =>
    typeof outer?.[name] === "string" ? Buffer.from(outer[name], "base64") : null;
  const wrapped = field("key");
  const nonce = field("nonce");
  const data = field("data");
  const tag = field("tag");
  if (outer?.version !== VERSION || !wrapped || nonce?.length !== 12 || !data || tag?.length !== 16)
    throw new CredentialRecordInvalidError();
  let key: Buffer;
  try {
    key = Buffer.from(await box.decrypt(wrapped), "base64");
  } catch {
    throw new SecureStorageUnavailableError();
  }
  if (key.length !== 32) throw new CredentialRecordInvalidError();
  let credentials: unknown;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(ASSOCIATED);
    decipher.setAuthTag(tag);
    credentials = JSON.parse(
      Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"),
    );
  } catch {
    throw new CredentialRecordInvalidError();
  }
  if (!validCredentials(credentials)) throw new CredentialRecordInvalidError();
  return {
    wrapped,
    key,
    credentials: { values: { ...credentials.values }, deviceKey: credentials.deviceKey },
  };
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Makes a rename in the folder survive a power loss. Windows has no folder sync. */
async function syncFolder(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Replaces `path` with `data`: written to a new private file that no other can
 * claim, read back through it and checked by `verify`, synced, renamed over
 * `path`, and the rename synced. A failure leaves `path` as it was.
 */
async function replaceDurably(
  path: string,
  data: Buffer,
  verify: (back: Buffer) => Promise<void> = async () => {},
): Promise<void> {
  const dir = join(path, "..");
  const temp = join(dir, `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temp, "wx+", 0o600);
  try {
    try {
      await handle.writeFile(data);
      await handle.sync();
      const back = Buffer.alloc((await handle.stat()).size);
      await handle.read(back, 0, back.length, 0);
      await verify(back);
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  // Renamed: the change is on disk unless the rename is lost. Finish its sync, once more if it
  // fails; otherwise neither the old nor the new contents can be assumed.
  try {
    await syncFolder(dir);
  } catch {
    try {
      await syncFolder(dir);
    } catch {
      throw new IndeterminateCommitError();
    }
  }
}

/** Whether the device whose key the record holds has its own operator token for the address. */
function hasOwnToken(credentials: Credentials, url: string): boolean {
  if (credentials.deviceKey === null) return false;
  const raw = createPublicKey(createPrivateKey(credentials.deviceKey))
    .export({ type: "spki", format: "der" })
    .subarray(-32);
  const deviceId = createHash("sha256").update(raw).digest("hex");
  return (
    credentials.values[`deviceToken:${encodeURIComponent(url)}:${deviceId}:operator`] !== undefined
  );
}

/**
 * The earlier build's saved gateway token, while it still belongs to the saved settings: the
 * same address, and no device token of this device's own for it yet. A copy left behind after
 * settings that replaced it were kept is never used, and the next start removes it.
 */
function earlierToken(
  credentials: Credentials,
  saved: Settings | null,
  retired: boolean,
): string | null {
  const kept = credentials.values[SETTINGS_KEY];
  const earlier = kept === undefined ? null : parseSettings(kept);
  if (
    !earlier ||
    !saved ||
    retired ||
    earlier.url !== saved.url ||
    hasOwnToken(credentials, earlier.url)
  )
    return null;
  return earlier.token;
}

/**
 * This device's own token for the earlier build's gateway retires that gateway's earlier token
 * in the same commit: once paired there, the earlier token is dropped with the write that saves
 * this device's token, or that removes it, so no separate cleanup can fail and revive it.
 */
function withoutRetiredEarlier(
  key: string,
  next: Credentials,
  before: Credentials = next,
): Credentials {
  const kept = next.values[SETTINGS_KEY];
  const earlier = kept === undefined ? null : parseSettings(kept);
  if (!earlier) return next;
  const own = hasOwnToken(before, earlier.url) || hasOwnToken(next, earlier.url);
  if (!own || !key.startsWith(`deviceToken:${encodeURIComponent(earlier.url)}:`)) return next;
  const { [SETTINGS_KEY]: _retired, ...values } = next.values;
  return { ...next, values };
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
  // Fixed lines only: nothing read from a file or from secure storage is ever logged.
  const warn = (message: string) => options.log?.("warn", message);
  /** Settings that aren't credentials, as `state.json` keeps them: the gateway settings without a token. */
  let settings: Record<string, string> = {};
  /** A gateway token typed for this session's pairing, for its address only. */
  let typed: { url: string; token: string } | null = null;

  /** Writes the record, and opens what reached the disk before it replaces anything. */
  const commit = (sealed: Sealed) => {
    const expected = encodeCredentials(sealed.credentials);
    return replaceDurably(sealedPath, seal(sealed), async (back) => {
      if (encodeCredentials((await unseal(back, box)).credentials) !== expected)
        throw new Error("the sealed record read back differently");
    });
  };

  /** Rewrites `state.json` without any credential, in one write. */
  const writeSettings = (next: Record<string, string>) =>
    replaceDurably(statePath, Buffer.from(`${JSON.stringify(next, null, 2)}\n`));

  /** An earlier build's temporary files whose writer has ended: a live or unknown writer's are left. */
  const earlierTemps = async () =>
    (await readdir(dataDir)).filter((name) => EARLIER_TEMP.test(name));
  /** Removes them, syncs the folder, and returns how many are left: a live or unknown writer's. */
  const sweepEarlierTemps = async () => {
    let left = 0;
    let removed = false;
    for (const name of await earlierTemps()) {
      const pid = Number(EARLIER_TEMP.exec(name)![2]);
      let ended = false;
      if (pid !== process.pid) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          ended = (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      }
      if (!ended) {
        left += 1;
        continue;
      }
      await rm(join(dataDir, name), { force: true });
      removed = true;
    }
    if (removed) await syncFolder(dataDir);
    return left;
  };

  /** Once the record is committed: the files without credentials, then the key file, then earlier temporary files. */
  const sweep = async (mode: Extract<Mode, { kind: "secure" }>) => {
    // No earlier copy changes until the sealed record's rename is on disk: a sync that fails
    // here stops the sweep before it touches a file, and the next change tries again.
    await syncFolder(dataDir);
    await writeSettings(settings);
    await rm(keyPath, { force: true });
    await syncFolder(dataDir);
    // Done only once no earlier temporary file is left: one a live writer still holds keeps it open.
    mode.swept = (await sweepEarlierTemps()) === 0;
  };

  const openMode = async (): Promise<Mode> => {
    // The data folder may not exist yet: made private before anything reads or scans it.
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const raw = await readOptional(statePath);
    const saved = raw ? record(raw.toString("utf8")) : {};
    if (!saved || !Object.values(saved).every((value) => typeof value === "string"))
      throw new SavedSettingsInvalidError();
    const entries = saved as Record<string, string>;
    const tokenKeys = Object.keys(entries).filter(isCredentialKey);
    const savedSettings =
      entries[SETTINGS_KEY] === undefined ? null : parseSettings(entries[SETTINGS_KEY]);
    if (entries[SETTINGS_KEY] !== undefined && !savedSettings)
      throw new SavedSettingsInvalidError();
    settings = Object.fromEntries(
      Object.entries(entries).filter(([key]) => !isCredentialKey(key) && key !== SETTINGS_KEY),
    );
    if (savedSettings) settings[SETTINGS_KEY] = JSON.stringify({ ...savedSettings, token: null });
    const earlier =
      tokenKeys.length > 0 ||
      savedSettings?.token != null ||
      (await exists(keyPath)) ||
      (await earlierTemps()).length > 0;

    const stored = await readOptional(sealedPath);
    const available = await box.available().catch(() => false);
    if (stored) {
      // The record is authoritative: an earlier build's credentials beside it are only removed.
      let sealed: Sealed;
      try {
        if (!available) throw new SecureStorageUnavailableError();
        sealed = await unseal(stored, box);
      } catch (error) {
        warn("This device's credentials are in secure storage, which can't be read now.");
        return {
          kind: "locked",
          error:
            error instanceof CredentialRecordInvalidError
              ? error
              : new SecureStorageUnavailableError(),
        };
      }
      // An earlier gateway token the saved settings no longer use (a removal that failed, or a
      // stop between the two writes) is removed now; if that fails it stays unused.
      if (
        sealed.credentials.values[SETTINGS_KEY] !== undefined &&
        earlierToken(sealed.credentials, savedSettings, entries[EARLIER_RETIRED_KEY] === "true") ===
          null
      ) {
        const { [SETTINGS_KEY]: _stale, ...values } = sealed.credentials.values;
        const reconciled = { ...sealed, credentials: { ...sealed.credentials, values } };
        try {
          await commit(reconciled);
          sealed = reconciled;
        } catch {
          // Kept unused: reads never take a token from it.
        }
      }
      const mode: Mode = { kind: "secure", sealed, swept: !earlier };
      if (earlier)
        await sweep(mode).catch(() =>
          warn(
            "Could not remove the earlier copy of this device's credentials. Clawtrate tries again at its next change.",
          ),
        );
      return mode;
    }

    for (const key of tokenKeys)
      if (!validTokenRecord(entries[key]!)) throw new SavedSettingsInvalidError();
    const pem = (await readOptional(keyPath))?.toString("utf8") ?? null;
    // An earlier build's key that can't be used is a damaged credential, not unreadable settings:
    // its recovery sets the whole folder aside, the key with it, and keeps it.
    if (pem !== null && !usableKey(pem)) throw new CredentialRecordInvalidError();
    const tokens: Credentials = {
      values: Object.fromEntries(tokenKeys.map((key) => [key, entries[key]!])),
      deviceKey: pem,
    };
    // Kept for the pairing it was saved for, until a device token replaces it: one of this
    // device's own for the same gateway already has, so the first record leaves it out.
    const credentials: Credentials =
      savedSettings?.token != null && !hasOwnToken(tokens, savedSettings.url)
        ? { ...tokens, values: { ...tokens.values, [SETTINGS_KEY]: entries[SETTINGS_KEY]! } }
        : tokens;
    if (available) {
      let mode: Mode | null = null;
      try {
        const key = randomBytes(32);
        const wrapped = Buffer.from(await box.encrypt(key.toString("base64")));
        const sealed = { wrapped, key, credentials };
        await commit(sealed);
        mode = { kind: "secure", sealed, swept: false };
      } catch (error) {
        // Renamed but not surely kept: the earlier files stay, and opening is tried again.
        if (error instanceof IndeterminateCommitError) throw error;
        // Otherwise nothing replaced anything: the files are as they were.
      }
      if (mode) {
        await sweep(mode).catch(() =>
          warn(
            "Could not remove the earlier copy of this device's credentials. Clawtrate tries again at its next change.",
          ),
        );
        return mode;
      }
    }
    warn(
      "Secure storage isn't available. This device's credentials are kept for this session only.",
    );
    return { kind: "session", credentials, holdSettings: earlier };
  };

  let opened: Promise<Mode> | null = null;
  /**
   * After a change that may or may not have reached the disk, what is held is dropped and the
   * next use opens the files again, so nothing builds on a snapshot the disk may not have.
   */
  const invalidateOn = (error: unknown) => {
    if (error instanceof IndeterminateCommitError) opened = null;
    throw error;
  };
  const mode = () => (opened ??= openMode().catch(invalidateOn));
  let queue: Promise<void> = Promise.resolve();
  const queued = (run: () => Promise<void>) => {
    const next = queue.then(run).catch(invalidateOn);
    queue = next.catch(() => {});
    return next;
  };

  const credentials = async () => {
    const current = await mode();
    if (current.kind === "locked") throw current.error;
    return current.kind === "secure" ? current.sealed.credentials : current.credentials;
  };

  /** One change to the credentials: committed first when sealed, or kept in memory for the session. */
  const change = (apply: (credentials: Credentials) => Credentials) =>
    queued(async () => {
      const current = await mode();
      if (current.kind === "locked") throw current.error;
      if (current.kind === "session") {
        current.credentials = apply(current.credentials);
        return;
      }
      const next = apply(current.sealed.credentials);
      if (next !== current.sealed.credentials) {
        const sealed = { ...current.sealed, credentials: next };
        await commit(sealed);
        current.sealed = sealed;
      }
      // Cleanup still pending: tried again now that the record is kept; full access stays off
      // until it succeeds.
      if (!current.swept)
        await sweep(current).catch(() =>
          warn(
            "Could not remove the earlier copy of this device's credentials. Clawtrate tries again at its next change.",
          ),
        );
    });

  /** Keeps a change to the settings: never while the file still holds credentials it would copy. */
  /**
   * Keeps `next` as the settings: written first, and only once that write is kept does it become
   * what reads return. A write that fails leaves the settings as they were, so no later change
   * carries it to disk. While the file still holds credentials it would copy, `next` is kept in
   * memory for the session and not written.
   */
  const keepSettings = async (
    next: Record<string, string>,
    nextTyped: { url: string; token: string } | null | undefined = undefined,
  ) => {
    const current = await mode();
    // A pending cleanup finishes first, with the settings as they are: a cleanup that fails
    // leaves `next` unwritten, so a call that fails has changed nothing a later start reads.
    if (current.kind === "secure" && !current.swept) await sweep(current);
    if (!(current.kind === "session" && current.holdSettings)) await writeSettings(next);
    // The settings and their typed token change in one step: no reader sees one without the other.
    settings = next;
    if (nextTyped !== undefined) typed = nextTyped;
  };

  /** Removes an earlier build's saved token once the settings no longer use it; a failure leaves an unused copy. */
  const retireEarlier = async () => {
    if ((await mode()).kind === "locked") return;
    if ((await credentials()).values[SETTINGS_KEY] === undefined) return;
    await change(withoutValue(SETTINGS_KEY)).catch(() =>
      warn(
        "Could not remove an earlier copy of the gateway token. Clawtrate removes it at its next start.",
      ),
    );
  };

  const withoutValue = (key: string) => (current: Credentials) => {
    if (!(key in current.values)) return current;
    const { [key]: _removed, ...values } = current.values;
    return { ...current, values };
  };

  return {
    storage: {
      get: async (key) => {
        if (isCredentialKey(key)) return (await credentials()).values[key] ?? null;
        await mode();
        if (key !== SETTINGS_KEY) return settings[key] ?? null;
        const saved =
          settings[SETTINGS_KEY] === undefined ? null : parseSettings(settings[SETTINGS_KEY]);
        if (!saved) return null;
        let token = typed?.url === saved.url ? typed.token : null;
        if (token === null && (await mode()).kind !== "locked")
          token = earlierToken(
            await credentials(),
            saved,
            settings[EARLIER_RETIRED_KEY] === "true",
          );
        // The retirement mark is the store's own: never handed out.
        return JSON.stringify({ ...saved, token });
      },
      set: async (key, value) => {
        if (isCredentialKey(key)) {
          if (!validTokenRecord(value)) throw new Error("not a device token record");
          return change((current) =>
            withoutRetiredEarlier(key, { ...current, values: { ...current.values, [key]: value } }),
          );
        }
        if (key !== SETTINGS_KEY)
          return queued(async () => {
            await mode();
            await keepSettings({ ...settings, [key]: value });
          });
        const next = parseSettings(value);
        if (!next) throw new Error("not gateway settings");
        // An earlier build's saved token goes once these settings replace it: another address,
        // another token, or this device's own token saved for it. Settings that merely drop a
        // typed token, at a Disconnect or a refusal, keep it. The settings write is the commit:
        // until it is kept nothing has changed and the call fails; once it is, the call has
        // committed, and the earlier sealed copy is removed after it. A copy left by a failed
        // removal or a stop in between no longer matches the settings, so it is never used, and
        // the next start removes it.
        const current = await mode();
        const kept =
          current.kind === "locked" ? undefined : (await credentials()).values[SETTINGS_KEY];
        const earlier = kept === undefined ? null : parseSettings(kept);
        const replaced =
          earlier !== null &&
          (earlier.url !== next.url ||
            (next.token !== null && earlier.token !== next.token) ||
            hasOwnToken(await credentials(), earlier.url));
        // The retirement is part of the settings commit, and stays whatever is selected later.
        await queued(async () => {
          await mode();
          // A typed token stays in this process, for its address only, published with its settings.
          await keepSettings(
            {
              ...settings,
              [SETTINGS_KEY]: JSON.stringify({ ...next, token: null }),
              ...(replaced ? { [EARLIER_RETIRED_KEY]: "true" } : {}),
            },
            next.token === null ? null : { url: next.url, token: next.token },
          );
        });
        if (replaced) await retireEarlier();
      },
      delete: async (key) => {
        if (isCredentialKey(key))
          return change((current) =>
            withoutRetiredEarlier(key, withoutValue(key)(current), current),
          );
        if (key !== SETTINGS_KEY)
          return queued(async () => {
            await mode();
            const { [key]: _removed, ...rest } = settings;
            await keepSettings(rest);
          });
        // As for a switch, the settings write is the commit, and an earlier build's token for the
        // gateway is removed after it: left behind, it matches no saved settings and isn't used.
        await queued(async () => {
          await mode();
          const { [SETTINGS_KEY]: _removed, ...rest } = settings;
          // Forgetting the gateway retires an earlier build's token for it, in the same write.
          const earlierKept =
            (await mode()).kind !== "locked" &&
            (await credentials()).values[SETTINGS_KEY] !== undefined;
          await keepSettings(earlierKept ? { ...rest, [EARLIER_RETIRED_KEY]: "true" } : rest, null);
        });
        await retireEarlier();
      },
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
    secure: async () => {
      const current = await mode().catch(() => null);
      return current?.kind === "secure" && current.swept;
    },
    status: async () => {
      const current = await mode().catch(() => null);
      if (!current || current.kind === "locked") return "locked";
      if (current.kind === "session") return "session";
      return current.swept ? "secure" : "cleanup-pending";
    },
  };
}
