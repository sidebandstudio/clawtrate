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
/** Requests remembered as having shared a code; past it, every request is blocked until none waits. */
export const MAX_COLLIDED = 2 * MAX_DEVICE_REQUESTS;
/** A reported name, platform or app, as shown, in characters. */
export const MAX_REPORTED_CHARS = 64;
/** The same as JSON: two units for a character past the basic plane, and the quotes. */
export const MAX_REPORTED_JSON_CHARS = 2 * MAX_REPORTED_CHARS + 2;
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
/**
 * A list read that failed is tried again this many times in a row, after `READ_GAP_MS` and then
 * four times longer each time (1, 4, 16 and 64 seconds); then only an event, a new connection or
 * a refresh reads it.
 */
export const READ_RETRIES = 4;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_DOMAIN = utf8Bytes("clawtrate pairing code v2\n");

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
 * A request's pairing code: the first 40 bits of SHA-256 over a fixed label, the device's raw
 * public key and the gateway's id for the request, as `ABCD-EFGH`. The gateway makes the id
 * (`randomUUID()`) when it files the request and hands it to the waiting device in its
 * `PAIRING_REQUIRED` answer (`details.requestId`); the approving device reads it from
 * `device.pair.list`. So the code can't be known before the request exists, and a new request
 * has a new code: matching a code someone has seen takes a request filed at the gateway per
 * try. The waiting device and the approving one both call this. Null for a key that isn't a
 * raw Ed25519 key in base64url, or no id.
 */
export function pairCode(publicKey: string, requestId: string): string | null {
  const raw = rawPublicKey(publicKey);
  if (!raw || requestId === "") return null;
  return crockford(hex(sha256Hex(concat(CODE_DOMAIN, raw, utf8Bytes(`\n${requestId}`)))));
}

/** A code read one character at a time, for a screen reader: "A B C D, E F G H". */
export const spokenCode = (code: string) =>
  code
    .split("-")
    .map((group) => [...group].join(" "))
    .join(", ");

/**
 * The codes offered for a request: its own and `PAIR_CODE_CHOICES - 1` others, in sorted order.
 * The others come from SHA-256 over `secret` (this engine's own random bytes), the key, the id
 * and a counter, so a request gets the same choices each time the sheet opens and repeated looks
 * give nothing away; each differs from the request's own code and from each other.
 */
export function codeChoices(
  publicKey: string,
  requestId: string,
  secret: Uint8Array,
): string[] | null {
  const own = pairCode(publicKey, requestId);
  const raw = rawPublicKey(publicKey);
  if (!own || !raw) return null;
  const codes = new Set([own]);
  for (let i = 0; codes.size < PAIR_CODE_CHOICES; i += 1)
    codes.add(crockford(hex(sha256Hex(concat(secret, raw, utf8Bytes(`\n${requestId}\n${i}`))))));
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
  | "bad-key"
  /** Another waiting request shows the same code: neither is picked; deny both and ask again. */
  | "same-code"
  /** More requests wait than are shown: none is picked until the hidden ones are cleared. */
  | "too-many";

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
  /**
   * The connection the list was read on. A decision carries it back, and one made on a list an
   * earlier connection published sends nothing.
   */
  listedOn: number;
};

export const initialDeviceRequests: DeviceRequestsState = {
  access: "none",
  requests: [],
  omitted: 0,
  noticed: 0,
  prompt: null,
  error: null,
  listedOn: 0,
};

/**
 * A list read a caller waited for (`readNow`): `fresh` when a list at least as new as that read
 * was applied; otherwise `error` says why, or is null when the connection changed or has no
 * admin.
 */
export type DeviceListRead = { fresh: boolean; error: string | null };

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
  /** As `undone`, but removing it failed, as the gateway said or before it was sent. */
  | { kind: "undo-failed"; what: string[]; message: string }
  /**
   * As `undone`, but the removal's answer was lost or its read-back didn't arrive: whether the
   * pairing is still there isn't known.
   */
  | { kind: "undo-unknown"; what: string[] }
  /** The gateway refused: its message. */
  | { kind: "refused"; message: string }
  /** The answer was lost: what the gateway did isn't known. */
  | { kind: "unknown" }
  /** The connection changed before the approval was sent: nothing was approved. */
  | { kind: "interrupted" }
  /**
   * The read before approving failed without a refusal from the gateway (its answer was lost,
   * or it timed out): no approval was sent.
   */
  | { kind: "unread"; message: string }
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
  /**
   * The code collisions are counted by; `pairCode`, which makes the codes shown, unless a test
   * needs two requests to share one (a real pair takes about 2^40 tries).
   */
  code?: (publicKey: string, requestId: string) => string | null;
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
  /** A block that comes from the other waiting requests, used when the row has none of its own. */
  among: DeviceRequestBlock | null = null,
  /** Make its choices: only for a request that is shown and offers codes. */
  withChoices = true,
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
            : among;
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
    choices: blocked || !withChoices ? [] : (codeChoices(publicKey, requestId, secret) ?? []),
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
  /**
   * Requests this host has seen share a code with another: blocked for as long as each waits,
   * even once the other is gone, so it takes Deny and Ask again. Past `MAX_COLLIDED`, `crowded`
   * blocks every request until the gateway lists none.
   */
  private readonly collided = new Set<string>();
  private crowded = false;
  /**
   * Requests a decision is under way for, each with that decision's own token, taken before its
   * first await: no other decision on the same request starts until it ends, and only the
   * decision holding the token frees it. Kept when the gateway may have acted on it (an approval
   * sent whose answer was lost, or approved, or a denial), until the request leaves the list.
   */
  private readonly deciding = new Map<string, number>();
  /** The last decision token handed out. */
  private decisions = 0;
  /**
   * Until when this host opens no sheet by itself: five minutes after any refusal or wrong pick
   * here, whichever device asks next. The requests are still listed and can be opened.
   */
  private quietUntil = -Infinity;
  /** Requests seen asking without admin, with when the notice of each ends. */
  private readonly noticed = new Map<string, number>();
  /** Moves on with each connection: a read begun before changes nothing. */
  private epoch = 0;
  private reading = false;
  private again = false;
  private cancelRead: (() => void) | null = null;
  /** When the scheduled read is due. */
  private readDue = Infinity;
  /**
   * The scheduled read is only the re-read of a list shown (`REREAD_MS`), which a list applied with
   * none waiting ends. An event's read, or a failed read's retry, outlives such a list: the request
   * it is for may be newer than that list.
   */
  private rereadOnly = false;
  private lastReadAt = -Infinity;
  /** Ends the earliest notice when its five minutes are up, with no event needed. */
  private cancelNotice: (() => void) | null = null;
  /**
   * The list's order on this connection: each `device.pair.list` send takes the next number, and
   * `applied` is the newest whose reply was applied. A reply older than that prunes nothing and
   * publishes nothing, and a decision resting on one sends no approval.
   */
  private sent = 0;
  private applied = 0;
  /** List reads that failed in a row on this connection, for the bounded retry. */
  private failures = 0;
  /** The list read under way, until it ends: `readNow` waits it out before reading. */
  private current: Promise<void> | null = null;

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
    this.applied = 0;
    this.failures = 0;
    this.clearTimer();
    this.clearNotices();
    const admin = this.ctx.admin();
    this.ctx.set({ ...initialDeviceRequests, access: admin ? "admin" : "none" });
    if (admin) void this.read();
  }

  /** The connection closed: what it listed goes with it. */
  onClose(): void {
    this.epoch += 1;
    this.applied = 0;
    this.failures = 0;
    this.clearTimer();
    this.reading = false;
    this.again = false;
    this.clearNotices();
    if (this.ctx.get()) this.ctx.set(initialDeviceRequests);
  }

  /** Another gateway, or none: nothing of this one is kept. */
  reset(): void {
    this.onClose();
    this.spent.clear();
    this.prompted.clear();
    this.collided.clear();
    this.crowded = false;
    this.deciding.clear();
    this.quietUntil = -Infinity;
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
    if (event === "device.pair.requested") {
      if (this.noticed.size >= MAX_DEVICE_REQUESTS && !this.noticed.has(requestId)) return;
      this.noticed.set(requestId, this.ctx.now() + NOTICE_MS);
    } else if (event === "device.pair.resolved") this.noticed.delete(requestId);
    this.notice();
  }

  /** The notices that haven't ended, published; the earliest end is timed. */
  private notice(): void {
    this.cancelNotice?.();
    this.cancelNotice = null;
    const now = this.ctx.now();
    for (const [id, until] of this.noticed) if (until <= now) this.noticed.delete(id);
    this.patch({ access: this.noticed.size > 0 ? "notice" : "none", noticed: this.noticed.size });
    if (this.noticed.size === 0) return;
    const next = Math.min(...this.noticed.values());
    this.cancelNotice = this.ctx.later(() => this.notice(), Math.max(next - now, 0));
  }

  private clearNotices(): void {
    this.cancelNotice?.();
    this.cancelNotice = null;
    this.noticed.clear();
  }

  /** Read the list now, or once the read under way ends. */
  refresh(): Promise<void> {
    return this.read();
  }

  /**
   * A read whose outcome the caller waits for (a window that must not say the list was read
   * again before it was): any read under way is waited out, then one starts, and the answer says
   * whether a list at least that new was applied.
   */
  async readNow(): Promise<DeviceListRead> {
    // The connection asked about: one that changes while a read is waited out answers not fresh.
    const epoch = this.epoch;
    while (this.current) {
      await this.current;
      if (epoch !== this.epoch) return { fresh: false, error: null };
    }
    if (!this.ctx.admin()) return { fresh: false, error: null };
    // `read()` numbers its send before its first await: the next number.
    const seq = this.sent + 1;
    await this.read();
    if (epoch !== this.epoch) return { fresh: false, error: null };
    if (this.applied >= seq) return { fresh: true, error: null };
    return {
      fresh: false,
      error: this.state.error ?? "The gateway's answer didn't list the waiting devices.",
    };
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
    this.readDue = Infinity;
  }

  /**
   * One read for a burst of events, at most one each `READ_GAP_MS`. An event brings a later
   * scheduled read (the 30-second one) forward; it never puts one back.
   */
  private schedule(ms = 0): void {
    if (this.reading) {
      this.again = true;
      return;
    }
    this.arm(ms);
  }

  /** `schedule` without waiting for a read under way: a list applied during one arms its re-read. */
  private arm(ms: number): void {
    const now = this.ctx.now();
    const due = Math.max(now + ms, this.lastReadAt + READ_GAP_MS);
    if (this.cancelRead && this.readDue <= due) {
      // Another read joins the one armed: an empty list applied later no longer ends it.
      if (ms !== REREAD_MS) this.rereadOnly = false;
      return;
    }
    // A sooner read that replaces one armed for more keeps its reason: only a re-read ends with
    // a list applied with none waiting.
    const reread = ms === REREAD_MS && (this.cancelRead === null || this.rereadOnly);
    this.clearTimer();
    this.readDue = due;
    this.rereadOnly = reread;
    this.cancelRead = this.ctx.later(() => {
      this.cancelRead = null;
      this.readDue = Infinity;
      void this.read();
    }, due - now);
  }

  /**
   * The only way the app sends `device.pair.list`: the send is numbered, and its pending rows are
   * applied (published, collisions recorded) if no newer reply was applied on this connection,
   * whichever path asked: the list read, a decision's read again, the read of a paired device, or
   * Settings, Machines (`listDevices`). Only a connection with admin applies them, and only a
   * reply with a pending list: one without changes nothing. `applied` says whether this reply
   * was; `paired` is null when the reply has no paired list; `reply` is the gateway's answer as
   * it came. A source check holds that nothing else sends the method
   * (`apps/desktop/test/device-pair-list-callers.test.ts`).
   */
  private async list(): Promise<{
    applied: boolean;
    pending: unknown[];
    paired: unknown[] | null;
    reply: unknown;
  }> {
    const seq = (this.sent += 1);
    const epoch = this.epoch;
    const reply = await this.ctx.request("device.pair.list", {});
    const answer = asRecord(reply) ?? {};
    const pending = Array.isArray(answer.pending) ? answer.pending : null;
    const applied =
      epoch === this.epoch &&
      pending !== null &&
      this.ctx.admin() &&
      this.applyNewest(seq, pending);
    return {
      applied,
      pending: pending ?? [],
      paired: Array.isArray(answer.paired) ? answer.paired : null,
      reply,
    };
  }

  /**
   * `device.pair.list` for Settings, Machines: the same numbered send, its waiting requests
   * applied by the same rules, and the gateway's whole answer, as it came, for the caller.
   */
  async listDevices(): Promise<unknown> {
    return (await this.list()).reply;
  }

  /**
   * Apply a pending list if no newer one was applied on this connection; false when it is older
   * and changed nothing.
   */
  private applyNewest(seq: number, rows: unknown[]): boolean {
    if (seq < this.applied) return false;
    this.applied = seq;
    // Any list applied, whoever read it, ends a run of failed reads.
    this.failures = 0;
    this.apply(rows);
    // The re-read follows the list applied last, whichever path read it.
    if (this.state.requests.length > 0) this.arm(REREAD_MS);
    else if (this.rereadOnly) this.clearTimer();
    return true;
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
    let ended = () => {};
    const current = new Promise<void>((resolve) => (ended = resolve));
    this.current = current;
    this.lastReadAt = this.ctx.now();
    // `list()` numbers this send, before its first await: the next number.
    const seq = this.sent + 1;
    let failed = false;
    try {
      const { applied } = await this.list();
      if (epoch !== this.epoch) return;
      // A reply without a pending list changes nothing, but is retried like a failure.
      failed = !applied && seq > this.applied;
    } catch (error) {
      // A failure is ordered like a reply: one older than a list already applied (a decision's
      // read, Machines') publishes nothing and is tried again by nothing.
      if (epoch === this.epoch && seq > this.applied) {
        this.patch({ error: errorText(error) });
        failed = true;
      }
    } finally {
      if (this.current === current) this.current = null;
      ended();
      if (epoch === this.epoch) {
        this.reading = false;
        if (this.again) {
          this.again = false;
          this.schedule();
        } else if (failed) {
          // A request may be waiting that no read has shown yet: try again, a few times. Then the
          // last list read stays shown, with the error, until an event, a hello or a refresh.
          if (this.failures < READ_RETRIES) this.schedule(READ_GAP_MS * 4 ** this.failures);
          this.failures += 1;
        }
      }
    }
  }

  /**
   * What one list read says, with the same rules for the list shown and for a decision: every
   * valid request newest first, a code two share (the rows past the sixteen included, and any
   * this host saw collide before) blocking each, and while more wait than are shown, none
   * offering a pick. Choices are made only for the requests shown that offer codes.
   */
  private snapshot(rows: unknown[]): { all: DeviceRequest[]; requests: DeviceRequest[] } {
    const parsed = rows
      .map((row) => readDeviceRequest(row, this.secret, false, null, false))
      .filter((request): request is DeviceRequest => request !== null);
    const codeFor = this.ctx.code ?? pairCode;
    const codeOf = (request: DeviceRequest) =>
      request.publicKey === "" ? null : codeFor(request.publicKey, request.requestId);
    const codes = parsed.map(codeOf);
    const counts = new Map<string, number>();
    for (const code of codes) if (code !== null) counts.set(code, (counts.get(code) ?? 0) + 1);
    const ids = new Set(parsed.map((request) => request.requestId));
    for (const id of this.collided) if (!ids.has(id)) this.collided.delete(id);
    if (this.crowded && parsed.length === 0) this.crowded = false;
    parsed.forEach((request, i) => {
      const code = codes[i] ?? null;
      if (code === null || (counts.get(code) ?? 0) < 2 || this.collided.has(request.requestId))
        return;
      if (this.collided.size >= MAX_COLLIDED) this.crowded = true;
      else this.collided.add(request.requestId);
    });
    const all = parsed
      .map((request) => {
        const shared = this.crowded || this.collided.has(request.requestId);
        return {
          ...request,
          spent: this.spent.has(request.requestId),
          blocked: request.blocked ?? (shared ? ("same-code" as const) : null),
        };
      })
      .sort((a, b) => b.at - a.at);
    // More waiting than shown: the person can't judge a set they can't see, so none is picked.
    const hidden = all.length > MAX_DEVICE_REQUESTS;
    const requests = all.slice(0, MAX_DEVICE_REQUESTS).map((request) => {
      const blocked = request.blocked ?? (hidden ? ("too-many" as const) : null);
      return {
        ...request,
        blocked,
        choices: blocked
          ? []
          : (codeChoices(request.publicKey, request.requestId, this.secret) ?? []),
      };
    });
    return { all, requests };
  }

  private apply(rows: unknown[]): void {
    const { all, requests } = this.snapshot(rows);
    // Every request still pending, shown or past the bound: a spent pick stays spent.
    const ids = new Set(all.map((request) => request.requestId));
    for (const id of this.spent) if (!ids.has(id)) this.spent.delete(id);
    for (const id of this.prompted) if (!ids.has(id)) this.prompted.delete(id);
    for (const id of this.deciding.keys()) if (!ids.has(id)) this.deciding.delete(id);
    const only = all.length === 1 ? requests[0]! : null;
    this.ctx.set({
      access: "admin",
      requests,
      omitted: all.length - requests.length,
      noticed: 0,
      // More than one waiting is a quiet badge, never a stack of sheets.
      prompt:
        only && !this.prompted.has(only.requestId) && this.ctx.now() >= this.quietUntil
          ? only.requestId
          : null,
      error: null,
      listedOn: this.epoch,
    });
  }

  private shown(requestId: string): DeviceRequest | null {
    return this.state.requests.find((request) => request.requestId === requestId) ?? null;
  }

  /** The whole pending list read again from the gateway, for a decision. */
  private async readAgain(): Promise<{ applied: boolean; rows: unknown[] }> {
    const { applied, pending } = await this.list();
    return { applied, rows: pending };
  }

  private spend(requestId: string): void {
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
    listedOn: number,
  ): Promise<DeviceDecision> {
    const shown = this.shown(requestId);
    if (!this.ctx.admin()) return { kind: "not-allowed" };
    // A sheet an earlier connection showed decides nothing here; this one read its own list.
    if (listedOn !== this.epoch) return { kind: "not-allowed" };
    if (!shown) return { kind: "gone" };
    const token = this.reserve(requestId);
    if (token === null) return { kind: "not-allowed" };
    const decision = await this.approveReserved(shown, code, scopes);
    this.settle(requestId, token, decision);
    return decision;
  }

  /**
   * Take `requestId` for one decision: its token, or null when a decision holds the request
   * already or too many do.
   */
  private reserve(requestId: string): number | null {
    if (this.deciding.has(requestId) || this.deciding.size >= MAX_DEVICE_REQUESTS) return null;
    const token = (this.decisions += 1);
    this.deciding.set(requestId, token);
    return token;
  }

  /**
   * The decision holding `token` ended: free its request, unless the gateway may have acted on it
   * (an approval that went through or whose answer was lost, a denial or one whose answer was
   * lost), until the request leaves the list. A token that no longer holds the request (another
   * gateway's, after a reset) frees nothing.
   */
  private settle(requestId: string, token: number, decision: DeviceDecision): void {
    const acted = [
      "approved",
      "undone",
      "undo-failed",
      "undo-unknown",
      "unknown",
      "denied",
    ].includes(decision.kind);
    if (!acted && this.deciding.get(requestId) === token) this.deciding.delete(requestId);
  }

  private async approveReserved(
    shown: DeviceRequest,
    code: string,
    scopes: readonly string[],
  ): Promise<DeviceDecision> {
    const requestId = shown.requestId;
    if (shown.blocked || shown.spent || !shown.choices.includes(code))
      return { kind: "not-allowed" };
    if (code !== pairCode(shown.publicKey, shown.requestId)) {
      this.quiet();
      this.spend(requestId);
      return { kind: "wrong-code" };
    }
    if (!sameSet(scopes, shown.scopes)) return { kind: "changed", what: ["access"] };
    // Each step goes on the connection the sheet was read on, or not at all.
    const same = this.here();
    try {
      const { applied, rows } = await this.readAgain();
      if (!same()) return { kind: "interrupted" };
      // A newer reply, from any read, was applied before this one: decide nothing on it. One
      // applied since is in the published list the decision checks below.
      if (!applied) {
        this.refreshOn(same);
        return { kind: "not-allowed" };
      }
      const row = rows.map((each) => asRecord(each) ?? {}).find((r) => r.requestId === requestId);
      if (!row) return this.gone(same);
      const what = differences(shown, row);
      if (what.length > 0) return { kind: "changed", what };
      // The list as now published, from this read, by the rules it is shown by: a request not
      // in it (hidden past the sixteen), or blocked in it, takes no approval.
      if (this.shown(requestId)?.blocked !== null) return { kind: "not-allowed" };
    } catch (error) {
      // No approval was sent. Only an answer from the gateway is its refusal.
      return this.ctx.answered(error)
        ? { kind: "refused", message: errorText(error) }
        : { kind: "unread", message: errorText(error) };
    }
    try {
      await this.ctx.request("device.pair.approve", { requestId });
    } catch (error) {
      // The answer was lost: the gateway may have approved. The paired device, read once, is
      // compared and removed exactly as after an answer; not listed or not readable is unknown,
      // and the request stays taken, so no second approval goes from here.
      if (!this.ctx.answered(error)) return this.check(shown, same);
      if (unknownRequest(error)) return this.gone(same);
      this.refreshOn(same);
      return { kind: "refused", message: errorText(error) };
    }
    return this.check(shown, same);
  }

  /**
   * After the approval's answer: the paired device is exactly what was shown, or it is removed.
   * On another connection than the approval's, nothing is read or removed: unknown.
   */
  private async check(shown: DeviceRequest, same: () => boolean): Promise<DeviceDecision> {
    let read: { device: RawRecord | null } | null;
    try {
      read = await this.readPairedOn(shown.deviceId, same);
    } catch {
      return { kind: "unknown" };
    } finally {
      this.refreshOn(same);
    }
    // Another connection, or approved but not listed as paired: what the gateway holds isn't known.
    const device = read?.device;
    if (!device) return { kind: "unknown" };
    const what = pairedDifferences(shown, device);
    if (what.length === 0) return { kind: "approved", deviceId: shown.deviceId };
    if (!same())
      return {
        kind: "undo-failed",
        what,
        message: "The connection changed before Clawtrate could remove it.",
      };
    try {
      await this.ctx.request("device.pair.remove", { deviceId: shown.deviceId });
    } catch (error) {
      // Failed only when the gateway said so; a lost answer may have removed it.
      return this.ctx.answered(error)
        ? { kind: "undo-failed", what, message: errorText(error) }
        : { kind: "undo-unknown", what };
    }
    // The removal counts once a read of the paired devices lacks it; no such read, not known.
    try {
      const again = await this.readPairedOn(shown.deviceId, same);
      if (!again) return { kind: "undo-unknown", what };
      if (again.device)
        return { kind: "undo-failed", what, message: "The gateway still lists the device." };
      return { kind: "undone", what };
    } catch {
      return { kind: "undo-unknown", what };
    }
  }

  /** The paired device with `deviceId`; a reply without a paired list fails, so it confirms nothing. */
  private async readPaired(deviceId: string): Promise<RawRecord | null> {
    const { paired } = await this.list();
    if (paired === null) throw new Error("The gateway's answer didn't list its paired devices.");
    return (paired.map((row) => asRecord(row) ?? {}).find((r) => r.deviceId === deviceId) ??
      null) as RawRecord | null;
  }

  /**
   * The paired device as read on the decision's own connection: null when that connection is
   * gone, before the read or by its answer, so nothing read on another gateway decides.
   */
  private async readPairedOn(
    deviceId: string,
    same: () => boolean,
  ): Promise<{ device: RawRecord | null } | null> {
    if (!same()) return null;
    const device = await this.readPaired(deviceId);
    return same() ? { device } : null;
  }

  /** A refusal or a wrong pick: no sheet opens by itself for five minutes, for any device. */
  private quiet(): void {
    this.quietUntil = this.ctx.now() + NOTICE_MS;
    if (this.state.prompt !== null) this.patch({ prompt: null });
  }

  private gone(same: () => boolean): DeviceDecision {
    this.refreshOn(same);
    return { kind: "gone" };
  }

  /**
   * A list read after a decision's step, on that decision's connection only: a new connection
   * reads its own list on its hello, and a stale decision adds nothing to it.
   */
  private refreshOn(same: () => boolean): void {
    if (same()) void this.read();
  }

  /** A guard on the connection this moment is on. */
  private here(): () => boolean {
    const epoch = this.epoch;
    return () => epoch === this.epoch;
  }

  /** "I didn't start this" (`device.pair.reject`) or "None of these match" (nothing sent). */
  async refuse(
    requestId: string,
    why: "not-mine" | "none-match",
    listedOn: number,
  ): Promise<DeviceDecision> {
    const shown = this.shown(requestId);
    if (!this.ctx.admin()) return { kind: "not-allowed" };
    if (listedOn !== this.epoch) return { kind: "not-allowed" };
    if (!shown) return { kind: "gone" };
    // A decision under way on this request (an approval being sent) takes no refusal.
    if (this.deciding.has(requestId)) return { kind: "not-allowed" };
    if (why === "none-match") {
      // Only a request offering codes takes this pick: a blocked one (too many waiting, or a
      // reason of its own) is denied or left, so spent picks stay within the requests shown.
      // One pick per request: a request already picked for (a wrong code, or this) takes no
      // other; "I didn't start this" still denies it.
      if (shown.blocked !== null || shown.spent) return { kind: "not-allowed" };
      this.quiet();
      this.spend(requestId);
      return { kind: "none-match" };
    }
    const token = this.reserve(requestId);
    if (token === null) return { kind: "not-allowed" };
    const same = this.here();
    let decision: DeviceDecision;
    try {
      this.quiet();
      await this.ctx.request("device.pair.reject", { requestId });
      this.refreshOn(same);
      decision = { kind: "denied" };
    } catch (error) {
      decision = !this.ctx.answered(error)
        ? { kind: "unknown" }
        : unknownRequest(error)
          ? this.gone(same)
          : { kind: "refused", message: errorText(error) };
    }
    // A denial (or a lost answer) may have ended the request: it stays taken until it leaves.
    this.settle(requestId, token, decision);
    return decision;
  }
}
