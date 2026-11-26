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
  /** The connection changed before the approval was sent: nothing was approved. */
  | { kind: "interrupted" }
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
  private lastReadAt = -Infinity;
  /** Ends the earliest notice when its five minutes are up, with no event needed. */
  private cancelNotice: (() => void) | null = null;

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
    this.clearNotices();
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
    const now = this.ctx.now();
    const due = Math.max(now + ms, this.lastReadAt + READ_GAP_MS);
    if (this.cancelRead && this.readDue <= due) return;
    this.clearTimer();
    this.readDue = due;
    this.cancelRead = this.ctx.later(() => {
      this.cancelRead = null;
      this.readDue = Infinity;
      void this.read();
    }, due - now);
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
    });
  }

  private shown(requestId: string): DeviceRequest | null {
    return this.state.requests.find((request) => request.requestId === requestId) ?? null;
  }

  /** The whole pending list read again from the gateway, for a decision. */
  private async readAgain(): Promise<unknown[]> {
    const answer = asRecord(await this.ctx.request("device.pair.list", {})) ?? {};
    return Array.isArray(answer.pending) ? answer.pending : [];
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
  ): Promise<DeviceDecision> {
    const shown = this.shown(requestId);
    if (!this.ctx.admin()) return { kind: "not-allowed" };
    if (!shown) return { kind: "gone" };
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
      const rows = await this.readAgain();
      if (!same()) return { kind: "interrupted" };
      const row = rows.map((each) => asRecord(each) ?? {}).find((r) => r.requestId === requestId);
      if (!row) return this.gone(same);
      const what = differences(shown, row);
      if (what.length > 0) {
        this.refreshOn(same);
        return { kind: "changed", what };
      }
      // The list as it is now, by the rules it is shown by: a code it now shares, a collision
      // seen before, more waiting than are shown, or a newer block this connection published.
      const now = this.snapshot(rows).requests.find((each) => each.requestId === requestId);
      if (!now || now.blocked || this.shown(requestId)?.blocked) {
        this.apply(rows);
        return { kind: "not-allowed" };
      }
    } catch (error) {
      return { kind: "refused", message: errorText(error) };
    }
    try {
      await this.ctx.request("device.pair.approve", { requestId });
    } catch (error) {
      if (!this.ctx.answered(error)) return this.afterLost(shown, same);
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
    try {
      if (!same())
        return {
          kind: "undo-failed",
          what,
          message: "The connection changed before Clawtrate could remove it.",
        };
      await this.ctx.request("device.pair.remove", { deviceId: shown.deviceId });
      const again = await this.readPairedOn(shown.deviceId, same);
      if (!again)
        return {
          kind: "undo-failed",
          what,
          message: "The connection changed before Clawtrate could confirm the removal.",
        };
      if (again.device)
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

  /** The approval's answer was lost: read what the gateway did, and check it as for an answer. */
  private async afterLost(shown: DeviceRequest, same: () => boolean): Promise<DeviceDecision> {
    try {
      if ((await this.readPairedOn(shown.deviceId, same))?.device) return this.check(shown, same);
    } catch {
      // Not readable either: unknown.
    }
    return { kind: "unknown" };
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
  async refuse(requestId: string, why: "not-mine" | "none-match"): Promise<DeviceDecision> {
    const shown = this.shown(requestId);
    if (!this.ctx.admin()) return { kind: "not-allowed" };
    if (!shown) return { kind: "gone" };
    if (why === "none-match") {
      // Only a request offering codes takes this pick: a blocked one (too many waiting, or a
      // reason of its own) is denied or left, so spent picks stay within the requests shown.
      if (shown.blocked !== null) return { kind: "not-allowed" };
      this.quiet();
      this.spend(requestId);
      return { kind: "none-match" };
    }
    const same = this.here();
    try {
      this.quiet();
      await this.ctx.request("device.pair.reject", { requestId });
      this.refreshOn(same);
      return { kind: "denied" };
    } catch (error) {
      if (!this.ctx.answered(error)) return { kind: "unknown" };
      if (unknownRequest(error)) return this.gone(same);
      return { kind: "refused", message: errorText(error) };
    }
  }
}
