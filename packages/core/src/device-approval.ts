// Approving a waiting device from inside Clawtrate (docs/design/setup-effortless.md §5).
//
// The waiting device shows a code made from its own public key. A connection with admin lists
// the gateway's pending requests and, for one, shows that request's code among a few made up
// here; the person picks the one the waiting device shows. A right pick approves with the
// gateway's own `device.pair.approve`, by request id, after the request is read again and still
// has the key, roles and scopes shown. Afterwards the paired device is read back; anything other
// than the key and access shown is removed at once and said. Nothing here is inferred from what
// a device reports about itself: its name, platform and app are shown as reported.

import { fromBase64, sha256Hex, utf8Bytes } from "./bytes.ts";
import { cleanLine } from "./gateway-names.ts";
import { asRecord, type RawRecord } from "./mapping.ts";
import { FULL_SCOPES } from "./scopes.ts";

/** Requests kept and shown, newest first; past it, `omitted` counts the rest. */
export const MAX_DEVICE_REQUESTS = 16;
/** A reported name, platform or app, as shown. */
export const MAX_REPORTED_CHARS = 64;
/** Codes offered for one request: its own and the made-up ones. */
export const PAIR_CODE_CHOICES = 4;
/** Characters in a code: 5 bytes of SHA-256, 40 bits, in Crockford's Base32. */
export const PAIR_CODE_CHARS = 8;
/** How long a request seen without admin is noticed, as the gateway keeps one (5 minutes). */
export const NOTICE_MS = 5 * 60_000;
/** Events are read together: one list read at most this often. */
export const READ_GAP_MS = 1_000;
/** While requests wait, the list is read again this often, so an expired one goes. */
export const REREAD_MS = 30_000;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_DOMAIN = utf8Bytes("clawtrate pairing code v1\n");

/** The raw 32-byte Ed25519 key of a base64url `publicKey`, or null. */
export function rawPublicKey(publicKey: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(publicKey)) return null;
  const bytes = fromBase64(`${publicKey.replace(/-/g, "+").replace(/_/g, "/")}=`);
  return bytes && bytes.length === 32 ? bytes : null;
}

const hex = (text: string) => Uint8Array.from(text.match(/../g)!, (pair) => parseInt(pair, 16));

/** Five bytes as eight Crockford Base32 characters, in two groups of four. */
function crockford(bytes: Uint8Array): string {
  // 40 bits fit a double exactly.
  let bits = 0;
  for (const byte of bytes.subarray(0, 5)) bits = bits * 256 + byte;
  let out = "";
  for (let i = 0; i < PAIR_CODE_CHARS; i += 1) {
    out = CROCKFORD[bits % 32]! + out;
    bits = Math.floor(bits / 32);
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/**
 * A device's pairing code: the first 40 bits of SHA-256 over a fixed label and its raw public
 * key, as `ABCD-EFGH`. The waiting device shows its own; the approving device computes the same
 * from the key the gateway lists. Null for a key that isn't a raw Ed25519 key in base64url.
 */
export function pairCode(publicKey: string): string | null {
  const raw = rawPublicKey(publicKey);
  return raw ? crockford(hex(sha256Hex(concat(CODE_DOMAIN, raw)))) : null;
}

/** A code read one character at a time, for a screen reader: "A B C D, E F G H". */
export const spokenCode = (code: string) =>
  code
    .split("-")
    .map((group) => [...group].join(" "))
    .join(", ");

/**
 * The codes offered for a request: its own and `PAIR_CODE_CHOICES - 1` others, in sorted order.
 * The others come from SHA-256 over `secret` (this engine's own random bytes), the key and a
 * counter, so the same key gets the same choices each time the sheet opens and repeated looks
 * give nothing away; each differs from the request's own code and from each other.
 */
export function codeChoices(publicKey: string, secret: Uint8Array): string[] | null {
  const own = pairCode(publicKey);
  const raw = rawPublicKey(publicKey);
  if (!own || !raw) return null;
  const codes = new Set([own]);
  for (let i = 0; codes.size < PAIR_CODE_CHOICES; i += 1)
    codes.add(crockford(hex(sha256Hex(concat(secret, raw, utf8Bytes(String(i)))))));
  return [...codes].sort();
}

/** Why a request isn't approved here; it is still listed, and Deny still works. */
export type DeviceRequestBlock =
  /** It asks for a role other than `operator` (a machine): Machines handles those. */
  | "not-operator"
  /** The device is already paired and asks for more. */
  | "repair"
  /** It asks for a scope outside the six Clawtrate can name. */
  | "unknown-scope"
  /** Its key isn't a raw Ed25519 key, or its device id isn't that key's hash. */
  | "bad-key";

/** A pending request as the gateway listed it, cleaned and bounded. */
export type DeviceRequest = {
  requestId: string;
  deviceId: string;
  publicKey: string;
  /** Written by the device itself: shown as reported. Null when it sent none. */
  name: string | null;
  platform: string | null;
  app: string | null;
  /** The address the gateway saw (`remoteIp`), when it reports one. */
  remoteIp: string | null;
  /** The web page it says it came from (`browserOrigin`), when it sent one. */
  origin: string | null;
  roles: string[];
  scopes: string[];
  /** When the gateway filed it (`ts`). */
  at: number;
  blocked: DeviceRequestBlock | null;
  /** The codes to pick from, its own among them. Empty when it is blocked. */
  choices: string[];
  /** A pick or "None of these match" on this host already approved nothing for it. */
  spent: boolean;
};

export type DeviceRequestsState = {
  /** `admin`: listed and decided here. `notice`: a connection without admin saw a request. */
  access: "admin" | "notice" | "none";
  requests: DeviceRequest[];
  omitted: number;
  /** Requests seen asking on a connection without admin, until they end or expire. */
  noticed: number;
  /** The one request this host opens by itself, when it is the only one and not yet shown. */
  prompt: string | null;
  /** The last list read failed: its message. */
  error: string | null;
};

export const initialDeviceRequests: DeviceRequestsState = {
  access: "none",
  requests: [],
  omitted: 0,
  noticed: 0,
  prompt: null,
  error: null,
};

/** What a decision did, for the sheet to say. */
export type DeviceDecision =
  | { kind: "approved"; deviceId: string }
  /** A code that isn't this request's: nothing approved, and this request takes no other pick here. */
  | { kind: "wrong-code" }
  | { kind: "none-match" }
  | { kind: "denied" }
  /** Decided elsewhere, expired or superseded: the gateway no longer lists it. */
  | { kind: "gone" }
  /** The request read again has another key, roles or scopes than shown: nothing approved. */
  | { kind: "changed"; what: string[] }
  /** Approved, then the paired device had other access than shown: its pairing was removed. */
  | { kind: "undone"; what: string[] }
  /** As `undone`, but removing it failed: the person must remove it. */
  | { kind: "undo-failed"; what: string[]; message: string }
  /** The gateway refused: its message. */
  | { kind: "refused"; message: string }
  /** The answer was lost: what the gateway did isn't known. */
  | { kind: "unknown" }
  /** Not offered here: not admin, a read-only host, or a blocked request. */
  | { kind: "not-allowed" };

export type DeviceApprovalsContext = {
  request(method: string, params: unknown): Promise<unknown>;
  /** The connection holds admin and the host may write. */
  admin(): boolean;
  /** The connection receives pairing events (pairing, or admin). */
  pairing(): boolean;
  /** The gateway answered (a refusal), as opposed to a lost or unsent request. */
  answered(error: unknown): boolean;
  now(): number;
  later(run: () => void, ms: number): () => void;
  get(): DeviceRequestsState | undefined;
  set(state: DeviceRequestsState): void;
  /** Random bytes for the made-up codes. */
  random(bytes: number): Uint8Array;
};

const str = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : null);
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v !== "") : [];
const reported = (value: unknown) => {
  const text = typeof value === "string" ? cleanLine(value, MAX_REPORTED_CHARS) : "";
  return text === "" ? null : text;
};
const sameSet = (a: readonly string[], b: readonly string[]) =>
  new Set(a).size === new Set(b).size && a.every((each) => b.includes(each));
/** Roles as the gateway resolves a request's: `roles`, else `role`. */
const rolesOf = (r: RawRecord) => {
  const roles = strings(r.roles);
  const role = str(r.role);
  return [...new Set(role ? [...roles, role] : roles)].sort();
};
const errorText = (error: unknown) =>
  cleanLine(error instanceof Error ? error.message : String(error), 240);

/** One `device.pair.list` pending row as a request, or null when it names no id or key. */
export function readDeviceRequest(
  row: unknown,
  secret: Uint8Array,
  spent: boolean,
): DeviceRequest | null {
  const r = asRecord(row) ?? {};
  const requestId = str(r.requestId);
  const deviceId = str(r.deviceId);
  const publicKey = str(r.publicKey);
  if (!requestId || !deviceId || !publicKey || requestId.length > 128 || deviceId.length > 128)
    return null;
  const roles = rolesOf(r);
  const scopes = [...new Set(strings(r.scopes))].sort();
  const raw = rawPublicKey(publicKey);
  const blocked: DeviceRequestBlock | null =
    !raw || sha256Hex(raw) !== deviceId.trim().toLowerCase()
      ? "bad-key"
      : roles.length !== 1 || roles[0] !== "operator"
        ? "not-operator"
        : r.isRepair === true
          ? "repair"
          : scopes.some((scope) => !FULL_SCOPES.includes(scope))
            ? "unknown-scope"
            : null;
  return {
    requestId,
    deviceId,
    publicKey: raw ? publicKey : "",
    name: reported(r.displayName),
    platform: reported(r.platform),
    app: reported([str(r.clientId), str(r.clientMode)].filter(Boolean).join(" · ") || null),
    remoteIp: reported(r.remoteIp),
    origin: reported(r.browserOrigin),
    roles: roles.slice(0, 8).map((role) => cleanLine(role, MAX_REPORTED_CHARS)),
    scopes: scopes.slice(0, 16).map((scope) => cleanLine(scope, MAX_REPORTED_CHARS)),
    at: typeof r.ts === "number" && Number.isFinite(r.ts) ? r.ts : 0,
    blocked,
    choices: blocked ? [] : (codeChoices(publicKey, secret) ?? []),
    spent,
  };
}

/** What differs between a request as shown and a row read again, in words. */
function differences(shown: DeviceRequest, row: RawRecord): string[] {
  const what: string[] = [];
  if (row.publicKey !== shown.publicKey || row.deviceId !== shown.deviceId) what.push("key");
  if (!sameSet(rolesOf(row), shown.roles)) what.push("role");
  if (!sameSet([...new Set(strings(row.scopes))], shown.scopes)) what.push("access");
  if (reported(row.browserOrigin) !== shown.origin) what.push("origin");
  if (row.isRepair === true) what.push("already paired");
  return what;
}

/** What differs between the device paired and the request shown: key, roles, scopes, tokens. */
function pairedDifferences(shown: DeviceRequest, device: RawRecord): string[] {
  const what: string[] = [];
  if (device.publicKey !== shown.publicKey) what.push("key");
  const tokens = Array.isArray(device.tokens) ? device.tokens.map((t) => asRecord(t) ?? {}) : [];
  const live = tokens.filter((t) => t.revokedAtMs === undefined || t.revokedAtMs === null);
  if (!sameSet(rolesOf(device), ["operator"]) || live.some((t) => t.role !== "operator"))
    what.push("role");
  const operator = live.find((t) => t.role === "operator");
  if (
    !sameSet([...new Set(strings(device.scopes))], shown.scopes) ||
    !operator ||
    !sameSet([...new Set(strings(operator.scopes))], shown.scopes)
  )
    what.push("access");
  return what;
}

/** The gateway's own "unknown requestId": the request isn't pending (any more). */
const unknownRequest = (error: unknown) =>
  error instanceof Error && /unknown requestId/i.test(error.message);

export class DeviceApprovals {
  private readonly ctx: DeviceApprovalsContext;
  /** Bytes the made-up codes come from: this engine's own, never sent. */
  private readonly secret: Uint8Array;
  /** Requests a pick already approved nothing for, on this host: no second pick. */
  private readonly spent = new Set<string>();
  /** Requests this host already opened by itself: each opens by itself once. */
  private readonly prompted = new Set<string>();
  /** Requests seen asking without admin, with when the notice of each ends. */
  private readonly noticed = new Map<string, number>();
  /** Moves on with each connection: a read begun before changes nothing. */
  private epoch = 0;
  private reading = false;
  private again = false;
  private cancelRead: (() => void) | null = null;
  private lastReadAt = -Infinity;

  constructor(ctx: DeviceApprovalsContext) {
    this.ctx = ctx;
    this.secret = ctx.random(32);
  }

  private get state(): DeviceRequestsState {
    return this.ctx.get() ?? initialDeviceRequests;
  }

  private patch(patch: Partial<DeviceRequestsState>): void {
    this.ctx.set({ ...this.state, ...patch });
  }

  /** A hello: with admin the list is read; without, only events are noticed. */
  onHello(): void {
    this.epoch += 1;
    this.clearTimer();
    this.noticed.clear();
    const admin = this.ctx.admin();
    this.ctx.set({ ...initialDeviceRequests, access: admin ? "admin" : "none" });
    if (admin) void this.read();
  }

  /** The connection closed: what it listed goes with it. */
  onClose(): void {
    this.epoch += 1;
    this.clearTimer();
    this.reading = false;
    this.again = false;
    this.noticed.clear();
    if (this.ctx.get()) this.ctx.set(initialDeviceRequests);
  }

  /** Another gateway, or none: nothing of this one is kept. */
  reset(): void {
    this.onClose();
    this.spent.clear();
    this.prompted.clear();
  }

  /** `device.pair.requested`, `device.pair.resolved` and `device.pair.changed`. */
  onEvent(event: string, payload: unknown): void {
    if (this.ctx.admin()) {
      this.schedule();
      return;
    }
    if (!this.ctx.pairing()) return;
    const requestId = str(asRecord(payload)?.requestId);
    if (!requestId || requestId.length > 128) return;
    const now = this.ctx.now();
    for (const [id, until] of this.noticed) if (until <= now) this.noticed.delete(id);
    if (event === "device.pair.requested") {
      if (this.noticed.size >= MAX_DEVICE_REQUESTS && !this.noticed.has(requestId)) return;
      this.noticed.set(requestId, now + NOTICE_MS);
    } else if (event === "device.pair.resolved") this.noticed.delete(requestId);
    this.patch({ access: this.noticed.size > 0 ? "notice" : "none", noticed: this.noticed.size });
  }

  /** Read the list now, or once the read under way ends. */
  refresh(): Promise<void> {
    return this.read();
  }

  /** A window takes the one request the host opens by itself; only the first that asks gets it. */
  takePrompt(requestId: string): boolean {
    if (this.state.prompt !== requestId) return false;
    this.prompted.add(requestId);
    this.patch({ prompt: null });
    return true;
  }

  private clearTimer(): void {
    this.cancelRead?.();
    this.cancelRead = null;
  }

  /** One read for a burst of events, at most one each `READ_GAP_MS`. */
  private schedule(ms = 0): void {
    if (this.reading) {
      this.again = true;
      return;
    }
    if (this.cancelRead) return;
    const wait = Math.max(ms, this.lastReadAt + READ_GAP_MS - this.ctx.now(), 0);
    this.cancelRead = this.ctx.later(() => {
      this.cancelRead = null;
      void this.read();
    }, wait);
  }

  private async read(): Promise<void> {
    if (!this.ctx.admin()) return;
    if (this.reading) {
      this.again = true;
      return;
    }
    this.clearTimer();
    const epoch = this.epoch;
    this.reading = true;
    this.lastReadAt = this.ctx.now();
    try {
      const answer = asRecord(await this.ctx.request("device.pair.list", {})) ?? {};
      if (epoch !== this.epoch) return;
      this.apply(Array.isArray(answer.pending) ? answer.pending : []);
    } catch (error) {
      if (epoch === this.epoch) this.patch({ error: errorText(error) });
    } finally {
      if (epoch === this.epoch) {
        this.reading = false;
        if (this.again) {
          this.again = false;
          this.schedule();
        } else if (this.state.requests.length > 0) this.schedule(REREAD_MS);
      }
    }
  }

  private apply(rows: unknown[]): void {
    const all = rows
      .map((row) => {
        const id = str(asRecord(row)?.requestId);
        return readDeviceRequest(row, this.secret, id !== null && this.spent.has(id));
      })
      .filter((request): request is DeviceRequest => request !== null)
      .sort((a, b) => b.at - a.at);
    const requests = all.slice(0, MAX_DEVICE_REQUESTS);
    const ids = new Set(requests.map((request) => request.requestId));
    for (const id of this.spent) if (!ids.has(id)) this.spent.delete(id);
    for (const id of this.prompted) if (!ids.has(id)) this.prompted.delete(id);
    const only = all.length === 1 ? requests[0]! : null;
    this.ctx.set({
      access: "admin",
      requests,
      omitted: all.length - requests.length,
      noticed: 0,
      // More than one waiting is a quiet badge, never a stack of sheets.
      prompt: only && !this.prompted.has(only.requestId) ? only.requestId : null,
      error: null,
    });
  }

  private shown(requestId: string): DeviceRequest | null {
    return this.state.requests.find((request) => request.requestId === requestId) ?? null;
  }

  /** The request's row read again from the gateway, or null when it isn't pending. */
  private async readAgain(requestId: string): Promise<RawRecord | null> {
    const answer = asRecord(await this.ctx.request("device.pair.list", {})) ?? {};
    const pending = Array.isArray(answer.pending) ? answer.pending : [];
    return (pending.map((row) => asRecord(row) ?? {}).find((r) => r.requestId === requestId) ??
      null) as RawRecord | null;
  }

  private spend(requestId: string): void {
    if (this.spent.size >= MAX_DEVICE_REQUESTS) return;
    this.spent.add(requestId);
    this.patch({
      requests: this.state.requests.map((request) =>
        request.requestId === requestId ? { ...request, spent: true } : request,
      ),
    });
  }

  /**
   * The person picked `code` for `requestId`, whose sheet showed `scopes`. The request's own
   * code approves it, after it is read again; any other approves nothing.
   */
  async approve(
    requestId: string,
    code: string,
    scopes: readonly string[],
  ): Promise<DeviceDecision> {
    const shown = this.shown(requestId);
    if (!this.ctx.admin()) return { kind: "not-allowed" };
    if (!shown) return { kind: "gone" };
    if (shown.blocked || shown.spent || !shown.choices.includes(code))
      return { kind: "not-allowed" };
    if (code !== pairCode(shown.publicKey)) {
      this.spend(requestId);
      return { kind: "wrong-code" };
    }
    if (!sameSet(scopes, shown.scopes)) return { kind: "changed", what: ["access"] };
    try {
      const row = await this.readAgain(requestId);
      if (!row) return this.gone();
      const what = differences(shown, row);
      if (what.length > 0) {
        void this.read();
        return { kind: "changed", what };
      }
    } catch (error) {
      return { kind: "refused", message: errorText(error) };
    }
    try {
      await this.ctx.request("device.pair.approve", { requestId });
    } catch (error) {
      if (!this.ctx.answered(error)) return this.afterLost(shown);
      if (unknownRequest(error)) return this.gone();
      void this.read();
      return { kind: "refused", message: errorText(error) };
    }
    return this.check(shown);
  }

  /** After the approval's answer: the paired device is exactly what was shown, or it is removed. */
  private async check(shown: DeviceRequest): Promise<DeviceDecision> {
    let device: RawRecord | null;
    try {
      device = await this.readPaired(shown.deviceId);
    } catch {
      return { kind: "unknown" };
    } finally {
      void this.read();
    }
    // Approved, but not listed as paired: what the gateway holds isn't known.
    if (!device) return { kind: "unknown" };
    const what = pairedDifferences(shown, device);
    if (what.length === 0) return { kind: "approved", deviceId: shown.deviceId };
    try {
      await this.ctx.request("device.pair.remove", { deviceId: shown.deviceId });
      if (await this.readPaired(shown.deviceId))
        return { kind: "undo-failed", what, message: "The gateway still lists the device." };
      return { kind: "undone", what };
    } catch (error) {
      return { kind: "undo-failed", what, message: errorText(error) };
    }
  }

  private async readPaired(deviceId: string): Promise<RawRecord | null> {
    const answer = asRecord(await this.ctx.request("device.pair.list", {})) ?? {};
    const paired = Array.isArray(answer.paired) ? answer.paired : [];
    return (paired.map((row) => asRecord(row) ?? {}).find((r) => r.deviceId === deviceId) ??
      null) as RawRecord | null;
  }

  /** The approval's answer was lost: read what the gateway did, and check it as for an answer. */
  private async afterLost(shown: DeviceRequest): Promise<DeviceDecision> {
    try {
      if (await this.readPaired(shown.deviceId)) return this.check(shown);
    } catch {
      // Not readable either: unknown.
    }
    return { kind: "unknown" };
  }

  private gone(): DeviceDecision {
    void this.read();
    return { kind: "gone" };
  }

  /** "I didn't start this" (`device.pair.reject`) or "None of these match" (nothing sent). */
  async refuse(requestId: string, why: "not-mine" | "none-match"): Promise<DeviceDecision> {
    const shown = this.shown(requestId);
    if (!this.ctx.admin()) return { kind: "not-allowed" };
    if (!shown) return { kind: "gone" };
    if (why === "none-match") {
      this.spend(requestId);
      return { kind: "none-match" };
    }
    try {
      await this.ctx.request("device.pair.reject", { requestId });
      void this.read();
      return { kind: "denied" };
    } catch (error) {
      if (!this.ctx.answered(error)) return { kind: "unknown" };
      if (unknownRequest(error)) return this.gone();
      return { kind: "refused", message: errorText(error) };
    }
  }
}
