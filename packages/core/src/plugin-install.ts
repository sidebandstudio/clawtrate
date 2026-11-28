// Installs one of Clawtrate's own OpenClaw plugins on a gateway, from the tarball the desktop app
// carries, through the gateway's own methods (docs/design/plugins-install.md, section 3, with the
// resume rules of issue #832). This engine is the one sender of every `plugins.*` write and every
// `config.patch` the install makes; nothing calls it by itself yet.
//
// What it guarantees: from its first write until the final enable (step 7) the plugin's entry says
// `enabled: false`, so no stop, crash or lost reply before step 7 leaves the plugin's code loaded.
// It never uninstalls, never adds to `plugins.allow`, never takes anything out of `plugins.deny`,
// never acknowledges an install-policy warning and never asks for a scope. It writes only on a
// connection whose current, confirmed grant holds `operator.admin`, and only on the routes the
// design allows the local source on (this computer after one-click Connect's check, or SSH).
//
// The steps (3.4): 0 preconditions; 1 read and choose the mode; 2 off first; 3 stage; 4 verify the
// installed artifact; 5 grant; 6 the last check; 7 enable; 8 confirm. Before each write of steps
// 2, 3, 5 and 7 it reads the config, the plugin list and the sessions, requires the gateway's own
// policy to let the plugin in, the state the previous step leaves, and no run going. A difference
// is a stop; a code that may have run is turned off by the one write that skips those checks.
//
// Every write is numbered (`writes`), and each read and write carries the connection's epoch: an
// attempt begun on a connection that has since closed or changed sends nothing more.

/** The groups `plugins.inspect` reports in `declared`, on 2026.10.6 and 2026.11.10. */
export const DECLARED_GROUPS = [
  "channels",
  "providers",
  "tools",
  "contracts",
  "hooks",
  "mcpServers",
  "cliCommands",
  "cliBackends",
  "skills",
  "dangerousConfigFlags",
] as const;
export type DeclaredGroup = (typeof DECLARED_GROUPS)[number];

/**
 * The plugins Clawtrate carries, the only ones the engine installs, whatever a caller passes: a
 * pin of another id is refused before any gateway call.
 */
export const CARRIED_PLUGIN_IDS = ["clawtrate-voice"] as const;

/** One plugin the app carries, as its signed list pins it (section 3.3). */
export type PluginPin = {
  packageName: string;
  version: string;
  pluginId: string;
  integrity: string;
  declared: Record<DeclaredGroup, string[]>;
  /** The entry's fields that grant the plugin something, merged into its entry as they are. */
  grants: Record<string, unknown>;
  /** By OpenClaw version, `runtime.sourceDigests[<id>]` as that version reported it. */
  sourceDigests: Record<string, string>;
};

export type PluginMode = "install" | "add-again" | "turn-on" | "update";

/** Where the engine may write from (step 0): only these carry the local source. */
export type PluginRoute = "same-computer" | "ssh" | "other";

/** The device's record of the attempt it runs, one per gateway and plugin (3.3). */
export type PluginRecord = {
  mode: PluginMode;
  /** The pin's integrity the attempt installs. */
  integrity: string;
  /** The last step completed. */
  step: number;
  /** The write sent and not yet seen to apply, when its reply hasn't come. */
  pending: number | null;
  /** Turning the plugin off on a mismatch, until a read shows it off. */
  turningOff: boolean;
  /** Step 7's `runtime.sourceDigests[<id>]`, once it answered (#832, 2). */
  sourceDigest: string | null;
  /** Steps 6 and 7 run again after a lost step 7 reply: a second loss turns it off and stops. */
  again?: boolean;
  /** The config hash after this device's last write. */
  configHash: string | null;
  /**
   * The person's Take it off, kept before its first write: no later run resumes the install, and
   * the next attempt finishes the take-off before anything else (section 12).
   */
  takingOff?: boolean;
};

/**
 * The tarball the host hands the engine for a stage, checked by the host at that moment
 * (docs/design/plugins-install.md, 3.6, "The host's tarball").
 */
export type VerifiedArtifact = {
  /** Absolute, as the host resolved it: no symbolic link on the way, no `.` or `..` in it. */
  path: string;
  /** The folder of the app's own resources the host found it in, absolute and resolved too. */
  root: string;
  /** `sha512-<base64>` of the bytes the host read for this call: it must be the pin's. */
  integrity: string;
};

/** Why an attempt stopped: each is one of section 10's lines, chosen by the step 3 interface. */
export type PluginStop =
  | "no-admin"
  | "route"
  | "openclaw-version"
  | "bots-busy"
  | "gateway-busy"
  | "refused"
  | "policy-warning"
  | "mismatch"
  | "turned-off"
  | "lost"
  | "restart"
  | "owner-settings"
  | "owner-turned-on"
  | "not-listed-off"
  | "listed-off"
  | "other-copy"
  | "another-device"
  | "already-on"
  | "in-progress"
  | "connection-changed"
  | "not-carried"
  | "artifact"
  | "cancelled";

export type PluginOutcome =
  | { kind: "enabled" }
  | {
      kind: "stopped";
      stop: PluginStop;
      /** The gateway's own words, behind the line's "i". */
      gateway?: string;
      /** No read has shown the plugin off since a write that could have turned it on. */
      mayBeRunning: boolean;
      /** The source digest step 7 reported, when it wasn't the pin's. */
      reported?: string;
    }
  | { kind: "taken-off" };

export type PluginInstallContext = {
  request(method: string, params: unknown): Promise<unknown>;
  /** The connection's current, confirmed grant holds `operator.admin`, and this host may write. */
  admin(): boolean;
  /** `hello-ok` `server.version`. */
  serverVersion(): string | null;
  route(): PluginRoute;
  /** The gateway answered (a refusal), as opposed to a lost or unsent request. */
  answered(error: unknown): boolean;
  /** Moves on with each connection: an attempt begun on another one writes nothing more. */
  epoch(): number;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Resolves true at the next `plugins.changed`, false after `ms`. */
  changed(ms: number): Promise<boolean>;
  loadRecord(pluginId: string): Promise<PluginRecord | null>;
  saveRecord(pluginId: string, record: PluginRecord | null): Promise<void>;
  /** Releases this app's earlier versions shipped, for Update: each version and integrity. */
  shipped: readonly { version: string; integrity: string }[];
  /** The app's carried list, as the host read it from its own resources: the pins it may install. */
  carried: readonly PluginPin[];
  /**
   * The pin's tarball, checked by the host now (each stage asks again): its path resolved inside
   * the app's resources and its SHA-512 measured from the bytes. It throws when the file can't be
   * read or isn't the app's.
   */
  artifact(pin: PluginPin): Promise<VerifiedArtifact>;
};

/** The plugin's own read that step 8 calls, answering `{version}`. */
export type ConfirmCall = { method: string; params: unknown };

/** The entry's shapes (3.3). */
export type Shape = "none" | "OFF" | "OFF+G" | "ON+G";

const RUN_WAIT_MS = 5 * 60_000;
const RUN_POLL_MS = 5_000;
const OTHER_DEVICE_MS = 60_000;
const BUSY_TRIES = 3;
const SESSION_PAGE = 200;
const MAX_SESSION_PAGES = 50;
const BUSY_WAITS = [1_000, 2_000, 4_000];
const OFF_WAITS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const OFF_EVERY_MS = 30_000;
/** At most this many disable tries while connected, about an hour. */
const MAX_OFF_TRIES = 126;

type Json = Record<string, unknown>;
const rec = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const isRec = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : null);
const deepEqual = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, i) => deepEqual(value, b[i]))
    );
  if (isRec(a) || isRec(b)) {
    if (!isRec(a) || !isRec(b)) return false;
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => key in b && deepEqual(a[key], b[key]))
    );
  }
  return a === b;
};

/** A canonical `x.y.z`, as numbers, or null. */
export function canonicalVersion(text: unknown): [number, number, number] | null {
  const match = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.exec(String(text ?? ""));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
const older = (a: string, b: string) => {
  const x = canonicalVersion(a);
  const y = canonicalVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i]! < y[i]!;
  return false;
};

/** The entry's shape for this pin, or null when it has fields of the owner's. */
export function entryShape(entry: unknown, grants: Json): Shape | null {
  if (entry === undefined || entry === null) return "none";
  if (!isRec(entry)) return null;
  const { config, ...rest } = entry;
  if (config !== undefined && !deepEqual(config, {})) return null;
  if (deepEqual(rest, { enabled: false })) return "OFF";
  if (deepEqual(rest, { enabled: false, ...grants })) return "OFF+G";
  if (deepEqual(rest, { enabled: true, ...grants })) return "ON+G";
  return null;
}

/** What one before-write read saw. */
export type GatewayRead = {
  hash: string | null;
  shape: Shape | null;
  /** The entry says `enabled: true`, whatever else it holds. */
  enabledSet: boolean;
  /** The entry says `enabled: false`, whatever else it holds. */
  disabled: boolean;
  /** `plugins.deny` names it, or a non-empty `plugins.allow` leaves it out. */
  keptOut: boolean;
  listed: { version: string | null; active: boolean; unloaded: boolean } | null;
  busy: boolean;
};

type Expected = {
  listed: boolean;
  at?: "pin" | "older";
  state?: "active" | "unloaded";
  shapes: Shape[];
};

/** The state after each step, by mode (3.3's table). */
export function expectedAfter(mode: PluginMode, step: number): Expected {
  if (mode === "turn-on") {
    if (step <= 4) return { listed: true, at: "pin", state: "unloaded", shapes: ["OFF", "OFF+G"] };
    if (step <= 6) return { listed: true, at: "pin", state: "unloaded", shapes: ["OFF+G"] };
    return { listed: true, at: "pin", state: "active", shapes: ["ON+G"] };
  }
  if (mode === "update") {
    if (step <= 1) return { listed: true, at: "older", state: "active", shapes: ["ON+G"] };
    if (step === 2) return { listed: true, at: "older", state: "unloaded", shapes: ["OFF+G"] };
    if (step <= 6) return { listed: true, at: "pin", state: "unloaded", shapes: ["OFF+G"] };
    return { listed: true, at: "pin", state: "active", shapes: ["ON+G"] };
  }
  if (step <= 1) return { listed: false, shapes: [mode === "install" ? "none" : "OFF"] };
  if (step === 2) return { listed: false, shapes: ["OFF"] };
  if (step <= 4) return { listed: true, at: "pin", state: "unloaded", shapes: ["OFF"] };
  if (step <= 6) return { listed: true, at: "pin", state: "unloaded", shapes: ["OFF+G"] };
  return { listed: true, at: "pin", state: "active", shapes: ["ON+G"] };
}

class Stop extends Error {
  readonly stop: PluginStop;
  readonly gateway?: string;
  reported?: string;
  constructor(stop: PluginStop, gateway?: string) {
    super(stop);
    this.stop = stop;
    if (gateway !== undefined) this.gateway = gateway;
  }
}
/** A request whose reply didn't come: the state is unknown until a read shows it. */
class Lost extends Error {}
/** Step 2's patch on a stale base hash: back to step 1, once. */
class Stale extends Error {}
const staleHash = (error: unknown) => /config changed since last load/i.test(words(error));

/** The gateway's words of a refusal. */
const words = (error: unknown) => str(rec(error).message) ?? String(error);
const busyRefusal = (error: unknown) =>
  /already running/i.test(words(error)) && rec(error).retryable !== false;
/** A take-off write found already applied by the fresh read before it. */
class AlreadyApplied extends Error {}

/** An absolute path's parts: POSIX (`/a/b`) or Windows (`C:\\a\\b`), or null when relative. */
const pathParts = (path: string): string[] | null => {
  const windows = /^[A-Za-z]:[\\/]/.test(path);
  if (!windows && !path.startsWith("/")) return null;
  return (windows ? path.slice(3) : path.slice(1)).split(/[\\/]/);
};

/** What is wrong with the host's tarball for this pin, or null (3.6, "The host's tarball"). */
export function artifactProblem(artifact: VerifiedArtifact, pin: PluginPin): string | null {
  const path = pathParts(artifact.path);
  const root = pathParts(artifact.root);
  if (!path || !root) return "the tarball's path isn't absolute";
  if ([...path, ...root].some((part) => part === "" || part === "." || part === ".."))
    return "the tarball's path isn't resolved";
  const drive = (p: string) => (/^[A-Za-z]:/.test(p) ? p.slice(0, 1).toLowerCase() : "");
  if (
    drive(artifact.path) !== drive(artifact.root) ||
    path.length <= root.length ||
    root.some((part, i) => part !== path[i])
  )
    return "the tarball isn't in the app's resources";
  if (artifact.integrity !== pin.integrity) return "the tarball's bytes aren't the pin's";
  return null;
}

/** The record a Take it off keeps when no attempt left one. */
const takeOffRecord = (pin: PluginPin): PluginRecord => ({
  mode: "install",
  integrity: pin.integrity,
  step: 0,
  pending: null,
  turningOff: false,
  sourceDigest: null,
  configHash: null,
  takingOff: true,
});

/** A record whose plugin may be running: an enable sent or not confirmed, or a disable not seen. */
const tracksRunning = (record: PluginRecord) =>
  record.turningOff || record.pending === 7 || record.step >= 7;

export class PluginInstaller {
  private readonly ctx: PluginInstallContext;
  /** The writes sent, numbered: each write takes the next. */
  private writes = 0;
  /** The attempt under way, if any: one at a time, for every plugin. */
  private current: Promise<PluginOutcome> | null = null;
  /** The attempt under way's "may be running", for a call that finds it under way. */
  private live = false;
  /** A Take it off asked the attempt under way to stop, at its next check. */
  private cancelling = false;

  constructor(ctx: PluginInstallContext) {
    this.ctx = ctx;
  }

  /** How many writes this engine has sent. */
  get writesSent(): number {
    return this.writes;
  }

  // Each takes a pin from the app's carried list as it is, and the tarball comes from the host's
  // `artifact`, checked at the moment of the stage: no caller hands the engine a path.

  /** First setup, or a person already paired: the plugin isn't listed and has no entry. */
  install(pin: PluginPin, confirm: ConfirmCall) {
    return this.one(() => this.attempt(pin, confirm, "install"));
  }
  /** The person's "Add again": not listed, entry `OFF`. */
  addAgain(pin: PluginPin, confirm: ConfirmCall) {
    return this.one(() => this.attempt(pin, confirm, "add-again"));
  }
  /** The person's "Turn on": listed `unloaded` at the pin, entry `OFF` or `OFF+G`. */
  turnOn(pin: PluginPin, confirm: ConfirmCall) {
    return this.one(() => this.attempt(pin, confirm, "turn-on"));
  }
  /** The person's "Update": listed `active` at an older shipped release, entry `ON+G`. */
  update(pin: PluginPin, confirm: ConfirmCall) {
    return this.one(() => this.attempt(pin, confirm, "update"));
  }
  /** At a connection: goes on with this device's record, if it has one. */
  resume(pin: PluginPin, confirm: ConfirmCall) {
    return this.one(() => this.attempt(pin, confirm, null));
  }
  /**
   * "Take it off" (section 12): turned off, its grants removed, left installed. An attempt under
   * way is asked to stop at its next check and waited for; the take-off then keeps its own
   * record before its first write, so nothing resumes the install after it.
   */
  async takeOff(pin: PluginPin): Promise<PluginOutcome> {
    if (this.current) {
      this.cancelling = true;
      try {
        await this.current;
      } finally {
        this.cancelling = false;
      }
    }
    return this.one(() => this.takeOffNow(pin));
  }

  private async one(run: () => Promise<PluginOutcome>): Promise<PluginOutcome> {
    // Under way: what it last knew, never "not running" for a plugin it may have turned on.
    if (this.current) return { kind: "stopped", stop: "in-progress", mayBeRunning: this.live };
    this.live = false;
    const running = run().finally(() => {
      this.current = null;
    });
    this.current = running;
    return running;
  }

  /** The attempt under way stops here when a Take it off asked it to. */
  private checkCancel() {
    if (this.cancelling) throw new Stop("cancelled");
  }

  /** The pin is one the app carries, as its list has it: anything else is refused (3.6). */
  private requireCarried(pin: PluginPin) {
    const carried =
      (CARRIED_PLUGIN_IDS as readonly string[]).includes(pin.pluginId) &&
      this.ctx.carried.some((entry) => deepEqual(entry, pin));
    if (!carried) throw new Stop("not-carried");
  }

  /** The host's tarball for the pin, checked now; a problem is a stop before the stage. */
  private async verifiedArtifact(pin: PluginPin): Promise<VerifiedArtifact> {
    let artifact: VerifiedArtifact;
    try {
      artifact = await this.ctx.artifact(pin);
    } catch (error) {
      throw new Stop("artifact", words(error));
    }
    const problem = artifactProblem(artifact, pin);
    if (problem) throw new Stop("artifact", problem);
    return artifact;
  }

  // --- Requests -------------------------------------------------------------------------------

  /** A read or a write on the attempt's own connection; a lost reply throws `Lost`. */
  private async call(epoch: number, method: string, params: unknown): Promise<Json> {
    if (this.ctx.epoch() !== epoch) throw new Stop("connection-changed");
    try {
      return rec(await this.ctx.request(method, params));
    } catch (error) {
      if (this.ctx.epoch() !== epoch) throw new Stop("connection-changed");
      if (!this.ctx.answered(error)) throw new Lost(words(error));
      throw error;
    }
  }

  /**
   * A write, numbered, waited on while the gateway says another change is running (it says so
   * with `mutationAccepted: false` on 2026.11.10): its `retryAfterMs`, else 1, 2 and 4 seconds,
   * three tries at most. `prepare` runs before every try, the first and each retry: it is the
   * step's before-write read, and gives the parameters from what it read (a fresh `baseHash`).
   * Only an admin connection writes.
   */
  private async write(
    epoch: number,
    method: string,
    prepare: () => Promise<unknown>,
    notApplied?: () => Promise<void>,
  ): Promise<Json> {
    try {
      return await this.writeTries(epoch, method, prepare);
    } catch (error) {
      // Never sent, or refused before it could start (a before-write read that stopped a retry,
      // three "already running", no admin): it didn't apply, so the write it marked as in flight
      // isn't. Anything else keeps its mark for a read to decide: a lost reply, a connection gone
      // mid-request, and an answered error too, which both versions can send after a change has
      // committed (plugins-install.md, 3.4, "An answered error").
      const neverSent = error instanceof Stop && error.stop !== "connection-changed";
      if (neverSent) await notApplied?.();
      throw error;
    }
  }

  private async writeTries(
    epoch: number,
    method: string,
    prepare: () => Promise<unknown>,
  ): Promise<Json> {
    for (let attempt = 0; ; attempt += 1) {
      const params = await prepare();
      this.checkCancel();
      if (!this.ctx.admin()) throw new Stop("no-admin");
      this.writes += 1;
      try {
        return await this.call(epoch, method, params);
      } catch (error) {
        if (error instanceof Stop || error instanceof Lost) throw error;
        if (/missing scope/i.test(words(error))) throw new Stop("no-admin", words(error));
        if (!busyRefusal(error)) throw error;
        if (attempt + 1 >= BUSY_TRIES) throw new Stop("gateway-busy", words(error));
        const after = rec(error).retryAfterMs;
        await this.ctx.sleep(typeof after === "number" && after > 0 ? after : BUSY_WAITS[attempt]!);
      }
    }
  }

  private async readGateway(epoch: number, pin: PluginPin): Promise<GatewayRead> {
    const [config, list, busy] = await Promise.all([
      this.call(epoch, "config.get", {}),
      this.call(epoch, "plugins.list", {}),
      this.anyRunGoing(epoch),
    ]);
    if (!Array.isArray(list.plugins) || !isRec(config.config))
      throw new Lost("a read missing a field");
    const plugins = rec(rec(config.config).plugins);
    const deny = Array.isArray(plugins.deny) ? plugins.deny : [];
    const allow = Array.isArray(plugins.allow) ? plugins.allow : [];
    const row = list.plugins.map(rec).find((p) => p.id === pin.pluginId);
    const state = str(rec(row?.runtime).state);
    return {
      hash: str(config.hash),
      shape: entryShape(rec(plugins.entries)[pin.pluginId], pin.grants),
      enabledSet: rec(rec(plugins.entries)[pin.pluginId]).enabled === true,
      disabled: rec(rec(plugins.entries)[pin.pluginId]).enabled === false,
      keptOut: deny.includes(pin.pluginId) || (allow.length > 0 && !allow.includes(pin.pluginId)),
      listed: row
        ? { version: str(row.version), active: state === "active", unloaded: state === "unloaded" }
        : null,
      busy,
    };
  }

  /**
   * Whether a run is going that a read can show (3.4, "No run going"): a session's, over every
   * page of `sessions.list` with the global and unknown rows it leaves out by default, and a
   * routine's, over every page of `cron.list`, since `sessions.list` never lists a routine's run
   * on either version. More pages than `MAX_SESSION_PAGES`, or a page that says there are more
   * without saying where, count as busy: idle is never assumed.
   */
  private async anyRunGoing(epoch: number): Promise<boolean> {
    const sessions = this.anyPage(
      epoch,
      "sessions.list",
      { limit: SESSION_PAGE, includeGlobal: true, includeUnknown: true },
      "sessions",
      (row) => row.hasActiveRun === true,
    );
    const routines = this.anyPage(
      epoch,
      "cron.list",
      { includeDisabled: true, compact: true, limit: SESSION_PAGE },
      "jobs",
      (job) => typeof job.runningAtMs === "number" && job.runningAtMs > 0,
    );
    const [session, routine] = await Promise.all([sessions, routines]);
    return session || routine;
  }

  /** Whether any row of any page of `method` is `going`; a page that can't be followed is busy. */
  private async anyPage(
    epoch: number,
    method: string,
    first: Json,
    field: string,
    going: (row: Json) => boolean,
  ): Promise<boolean> {
    let params = first;
    for (let pages = 0; pages < MAX_SESSION_PAGES; pages += 1) {
      const page = await this.call(epoch, method, params);
      const rows = page[field];
      if (!Array.isArray(rows)) throw new Lost("a read missing a field");
      if (rows.some((row) => going(rec(row)))) return true;
      if (page.hasMore !== true) return false;
      if (typeof page.nextOffset !== "number") return true;
      params = { ...first, offset: page.nextOffset };
    }
    return true;
  }

  private async inspect(epoch: number, pin: PluginPin): Promise<Json> {
    try {
      return await this.call(epoch, "plugins.inspect", { pluginId: pin.pluginId });
    } catch (error) {
      if (error instanceof Stop || error instanceof Lost) throw error;
      throw new Stop("refused", words(error));
    }
  }

  // --- Checks ---------------------------------------------------------------------------------

  /** The state matches what `mode` leaves after `step`. */
  private matches(
    read: GatewayRead,
    pin: PluginPin,
    mode: PluginMode,
    step: number,
    olderVersion?: string | null,
  ) {
    const want = expectedAfter(mode, step);
    if (read.shape === null || !want.shapes.includes(read.shape)) return false;
    if (!want.listed) return read.listed === null;
    if (!read.listed) return false;
    const version = want.at === "pin" ? pin.version : olderVersion;
    if (want.at === "older" && (olderVersion === undefined || olderVersion === null)) {
      if (!read.listed.version || !older(read.listed.version, pin.version)) return false;
    } else if (read.listed.version !== version) return false;
    return want.state === "active" ? read.listed.active : read.listed.unloaded;
  }

  /** The read before a write of steps 2, 3, 5 and 7: policy OK, the expected state, no run going. */
  private async beforeWrite(
    epoch: number,
    pin: PluginPin,
    mode: PluginMode,
    after: number,
    olderVersion?: string | null,
  ) {
    const started = this.ctx.now();
    for (;;) {
      this.checkCancel();
      const read = await this.readGateway(epoch, pin);
      if (read.keptOut || read.shape === null) throw new Stop(this.describe(read, pin));
      if (!this.matches(read, pin, mode, after, olderVersion))
        throw new Stop(this.describe(read, pin));
      if (!read.busy) return read;
      if (this.ctx.now() - started >= RUN_WAIT_MS) throw new Stop("bots-busy");
      await this.ctx.sleep(RUN_POLL_MS);
    }
  }

  /** A read with no run going, waited for as before a write; for Take it off, which acts on it. */
  private async idleRead(epoch: number, pin: PluginPin, seen?: (read: GatewayRead) => void) {
    const started = this.ctx.now();
    for (;;) {
      const read = await this.readGateway(epoch, pin);
      seen?.(read);
      if (!read.busy) return read;
      if (this.ctx.now() - started >= RUN_WAIT_MS) throw new Stop("bots-busy");
      await this.ctx.sleep(RUN_POLL_MS);
    }
  }

  /** Step 4's comparison of `plugins.inspect` with the pin, every field required. */
  /**
   * The hook grants the gateway reports in `plugins.inspect`'s `grants.hooks`, as it resolved
   * them from the entry: each one the pin grants is in effect and configured as pinned, and
   * prompt injection isn't turned off for it. A plugin that isn't a bundle can't declare its
   * hooks (OpenClaw reports `declared.hooks: []`), so this is the gateway's one report about the
   * hook its code registers.
   */
  private hookGrantsInEffect(answer: Json, pin: PluginPin): boolean {
    const reported = rec(rec(answer.grants).hooks);
    const pinned = rec(pin.grants.hooks);
    if (rec(reported.allowPromptInjection).effective !== true) return false;
    return Object.entries(pinned).every(
      ([key, value]) =>
        rec(reported[key]).effective === value && rec(reported[key]).configured === value,
    );
  }

  private verified(answer: Json, pin: PluginPin): string | null {
    const plugin = rec(answer.plugin);
    const source = rec(answer.source);
    const declared = rec(answer.declared);
    const token = str(answer.reviewToken);
    const ok =
      plugin.id === pin.pluginId &&
      plugin.version === pin.version &&
      source.kind === "npm" &&
      source.packageName === pin.packageName &&
      source.spec === `${pin.packageName}@${pin.version}` &&
      source.integrity === pin.integrity &&
      source.integrityKind === "ssri" &&
      DECLARED_GROUPS.every(
        (group) =>
          Array.isArray(declared[group]) &&
          deepEqual([...(declared[group] as unknown[])].sort(), [...pin.declared[group]].sort()),
      ) &&
      Object.keys(declared).every((group) =>
        (DECLARED_GROUPS as readonly string[]).includes(group),
      ) &&
      token !== null &&
      token !== "";
    return ok ? token : null;
  }

  /** The line for a state no step expected. */
  private describe(read: GatewayRead, pin: PluginPin): PluginStop {
    if (read.keptOut) return "owner-settings";
    if (read.shape === null) return read.enabledSet ? "owner-turned-on" : "owner-settings";
    if (!read.listed) {
      if (read.shape === "ON+G") return "owner-turned-on";
      if (read.shape === "OFF" || read.shape === "OFF+G") return "not-listed-off";
      return "refused";
    }
    if (read.listed.version !== pin.version) return "other-copy";
    if (read.listed.active) return read.shape === "ON+G" ? "already-on" : "owner-turned-on";
    return "listed-off";
  }

  // --- The attempt ----------------------------------------------------------------------------

  private async attempt(
    pin: PluginPin,
    confirm: ConfirmCall,
    wanted: PluginMode | null,
  ): Promise<PluginOutcome> {
    const epoch = this.ctx.epoch();
    let record: PluginRecord | null = null;
    const save = async (patch: Partial<PluginRecord>) => {
      record = { ...record!, ...patch };
      await this.ctx.saveRecord(pin.pluginId, record);
    };
    const drop = async () => {
      record = null;
      await this.ctx.saveRecord(pin.pluginId, null);
    };
    let mayBeRunning = false;
    const running = (value: boolean) => {
      mayBeRunning = value;
      this.live = value;
    };
    try {
      // Only a pin the app carries, before any gateway call.
      this.requireCarried(pin);
      // Step 0.
      if (!this.ctx.admin()) throw new Stop("no-admin");
      const route = this.ctx.route();
      if (route !== "same-computer" && route !== "ssh") throw new Stop("route");
      const openclaw = this.ctx.serverVersion() ?? "";
      const digest = pin.sourceDigests[openclaw];
      if (!digest) throw new Stop("openclaw-version");
      await this.verifiedArtifact(pin);

      record = await this.ctx.loadRecord(pin.pluginId);
      if (record?.takingOff) {
        // The person's Take it off comes first: finished before anything else runs.
        const off = await this.takeOffNow(pin);
        if (off.kind !== "taken-off" || wanted === null) return off;
        record = null;
      }
      if (record && record.integrity !== pin.integrity) {
        // Another pin's attempt. One that may have left the plugin running is finished first: its
        // plugin turned off, its record kept until a read shows that (#832, 4).
        if (tracksRunning(record)) {
          running(true);
          await save({ turningOff: true });
          if (!(await this.turnOffUntilApplied(epoch, pin))) throw new Stop("lost");
          running(false);
        }
        await drop();
      }

      // A record left by this device: go on where it stopped, or stop. Until a read shows the
      // plugin off, a record whose write could have left it running says it may be (#832, 4).
      if (record)
        running(
          tracksRunning(record) ||
            (record.mode === "update" && (record.step < 2 || record.pending === 2)),
        );
      if (record) {
        const resumed = await this.resumeFrom(
          epoch,
          pin,
          record,
          (patch) => save(patch),
          () => drop(),
          running,
        );
        if (resumed.kind !== "continue") return resumed.outcome;
        return await this.steps(
          epoch,
          pin,
          confirm,
          record!,
          resumed.from,
          digest,
          save,
          drop,
          running,
        );
      }
      if (wanted === null) return { kind: "stopped", stop: "lost", mayBeRunning: false };

      for (let tries = 0; ; tries += 1) {
        try {
          return await this.fromStepOne(
            epoch,
            pin,
            confirm,
            wanted,
            digest,
            (r) => (record = r),
            save,
            drop,
            running,
          );
        } catch (error) {
          if (!(error instanceof Stale) || tries > 0) throw error;
          await drop();
        }
      }
    } catch (error) {
      if (error instanceof Stale) return this.stopped(new Stop("another-device"), mayBeRunning);
      return this.stopped(error, mayBeRunning);
    }
  }

  /** Steps 1 to 8 for an attempt this device starts. */
  private async fromStepOne(
    epoch: number,
    pin: PluginPin,
    confirm: ConfirmCall,
    wanted: PluginMode,
    digest: string,
    keep: (record: PluginRecord) => void,
    save: (patch: Partial<PluginRecord>) => Promise<void>,
    drop: () => Promise<void>,
    running: (value: boolean) => void,
  ): Promise<PluginOutcome> {
    // Step 1.
    let read = await this.readGateway(epoch, pin);
    let olderVersion: string | null = null;
    const mode = this.chooseMode(read, pin);
    if (mode !== wanted) {
      if (read.shape === "OFF" || read.shape === "OFF+G") {
        // Another device's attempt, most likely, finishing: wait for it before saying anything.
        if (await this.ctx.changed(OTHER_DEVICE_MS)) read = await this.readGateway(epoch, pin);
        this.checkCancel();
      }
      throw new Stop(this.describe(read, pin));
    }
    if (mode === "update") {
      olderVersion = read.listed!.version;
      await this.requireShipped(epoch, pin, olderVersion);
    }
    const record: PluginRecord = {
      mode,
      integrity: pin.integrity,
      step: 1,
      pending: null,
      turningOff: false,
      sourceDigest: null,
      configHash: read.hash,
    };
    keep(record);
    await this.ctx.saveRecord(pin.pluginId, record);
    return await this.steps(
      epoch,
      pin,
      confirm,
      record,
      2,
      digest,
      save,
      drop,
      running,
      olderVersion,
    );
  }

  /** Update's copy is a release this app shipped, of its package, older than the pin. */
  private async requireShipped(epoch: number, pin: PluginPin, version: string | null) {
    const source = rec((await this.inspect(epoch, pin)).source);
    const shipped = this.ctx.shipped.some(
      (r) => r.version === version && r.integrity === source.integrity,
    );
    if (
      !shipped ||
      source.packageName !== pin.packageName ||
      !version ||
      !older(version, pin.version)
    )
      throw new Stop("other-copy");
  }

  private chooseMode(read: GatewayRead, pin: PluginPin): PluginMode | null {
    if (read.keptOut || read.shape === null) return null;
    if (!read.listed) {
      if (read.shape === "none") return "install";
      if (read.shape === "OFF") return "add-again";
      return null;
    }
    if (
      read.listed.unloaded &&
      read.listed.version === pin.version &&
      (read.shape === "OFF" || read.shape === "OFF+G")
    )
      return "turn-on";
    if (
      read.listed.active &&
      read.shape === "ON+G" &&
      read.listed.version &&
      older(read.listed.version, pin.version)
    )
      return "update";
    return null;
  }

  private stopped(error: unknown, mayBeRunning: boolean): PluginOutcome {
    if (error instanceof Stop)
      return {
        kind: "stopped",
        stop: error.stop,
        ...(error.gateway ? { gateway: error.gateway } : {}),
        mayBeRunning,
        ...(error.reported ? { reported: error.reported } : {}),
      };
    if (error instanceof Lost)
      return { kind: "stopped", stop: "lost", gateway: error.message, mayBeRunning };
    return { kind: "stopped", stop: "refused", gateway: words(error), mayBeRunning };
  }

  /**
   * At a connection with a record: the state after the record's last step goes on from the next;
   * the state after the pending write means that write applied. A pending step 7 whose entry is
   * still `OFF+G` is a stop, never a retry: the owner may have turned it off (#832, 1).
   */
  private async resumeFrom(
    epoch: number,
    pin: PluginPin,
    record: PluginRecord,
    save: (patch: Partial<PluginRecord>) => Promise<void>,
    drop: () => Promise<void>,
    running: (value: boolean) => void,
  ): Promise<{ kind: "continue"; from: number } | { kind: "done"; outcome: PluginOutcome }> {
    // A state the record can't go on from. A plugin the read shows active, or an entry that says
    // enabled, keeps the record and the warning: no read has shown it off (#832, 4).
    const stopHere = async (read: GatewayRead) => {
      const risky = read.listed?.active === true || read.enabledSet;
      if (!risky) await drop();
      running(risky);
      return {
        kind: "done" as const,
        outcome: {
          kind: "stopped" as const,
          stop: this.describe(read, pin),
          mayBeRunning: risky,
        },
      };
    };
    if (record.turningOff) {
      const off = await this.turnOffUntilApplied(epoch, pin);
      // Kept until a read shows it off, so the next connection goes on turning it off.
      if (off) await drop();
      return {
        kind: "done",
        outcome: { kind: "stopped", stop: off ? "turned-off" : "lost", mayBeRunning: !off },
      };
    }
    const read = await this.readGateway(epoch, pin);
    const mode = record.mode;
    const pending = record.pending;
    if (pending === 7) {
      if (read.shape === "ON+G" && record.again) {
        // Steps 6 and 7 already ran again once: turn it off and stop, never a third enable.
        await save({ turningOff: true });
        const off = await this.turnOffUntilApplied(epoch, pin);
        if (off) await drop();
        return {
          kind: "done",
          outcome: { kind: "stopped", stop: off ? "turned-off" : "lost", mayBeRunning: !off },
        };
      }
      if (read.shape === "ON+G") {
        // Step 7 applied but its answer was lost: turn it off, then steps 6 and 7 again for the digest.
        await save({ turningOff: true });
        if (!(await this.turnOffUntilApplied(epoch, pin))) throw new Stop("lost");
        running(false);
        await save({ turningOff: false, step: 6, pending: null, sourceDigest: null, again: true });
        return { kind: "continue", from: 6 };
      }
      // `OFF+G` and unloaded: a stop, never a retry, the owner may have turned it off (#832, 1).
      return await stopHere(read);
    }
    if (record.step === 7 && record.sourceDigest !== null && this.matches(read, pin, mode, 7))
      return { kind: "continue", from: 8 };
    if (pending !== null && this.matches(read, pin, mode, pending)) {
      await save({ step: pending, pending: null });
      return { kind: "continue", from: pending + 1 };
    }
    if (this.matches(read, pin, mode, record.step)) {
      // Update's step 2 lost: until a read shows it off, it may still run (#832, 4); this read did.
      await save({ pending: null });
      return { kind: "continue", from: record.step + 1 };
    }
    return await stopHere(read);
  }

  /** Steps `from` to 8. */
  private async steps(
    epoch: number,
    pin: PluginPin,
    confirm: ConfirmCall,
    record: PluginRecord,
    from: number,
    digest: string,
    save: (patch: Partial<PluginRecord>) => Promise<void>,
    drop: () => Promise<void>,
    running: (value: boolean) => void,
    olderVersionAtStart?: string | null,
  ): Promise<PluginOutcome> {
    const mode = record.mode;
    const id = pin.pluginId;
    let olderVersion = olderVersionAtStart ?? null;
    const entry = (value: Json) => JSON.stringify({ plugins: { entries: { [id]: value } } });
    const patch = async (after: number, value: Json, step: number) => {
      for (let attempt = 0; ; attempt += 1) {
        let base: string | null = null;
        try {
          const answer = await this.write(
            epoch,
            "config.patch",
            async () => {
              const read = await this.beforeWrite(epoch, pin, mode, after, olderVersion);
              await save({ pending: step });
              base = read.hash;
              return { baseHash: read.hash, raw: entry(value) };
            },
            () => save({ pending: null }),
          );
          await save({ configHash: str(answer.hash) ?? base });
          return;
        } catch (error) {
          if (error instanceof Stop || error instanceof Lost || !staleHash(error)) throw error;
          // A stale base hash: step 2's goes back to step 1, a later one to the read before it, once.
          if (step === 2) throw new Stale();
          if (attempt === 0) continue;
          throw error;
        }
      }
    };
    const disable = async (
      reason: PluginStop = "turned-off",
      reported?: string,
      said?: string,
    ): Promise<never> => {
      running(true);
      await save({ turningOff: true });
      const off = await this.turnOffUntilApplied(epoch, pin);
      if (off) {
        running(false);
        await drop();
      }
      const stop = new Stop(off ? reason : "lost", said);
      if (reported) stop.reported = reported;
      throw stop;
    };
    let token: string | null = null;
    let stepDigest: string | null = record.sourceDigest;
    // Step 7 needs step 6's inspect, for its review token (#832, 3).
    for (let step = from === 7 ? 6 : from; step <= 8; step += 1) {
      this.checkCancel();
      if (step === 2) {
        if (mode === "install") await patch(1, { enabled: false }, 2);
        else if (mode === "update") {
          if (!olderVersion)
            olderVersion = (await this.readGateway(epoch, pin)).listed?.version ?? null;
          // On a resume too: the copy it turns off and replaces is a release this app shipped.
          await this.requireShipped(epoch, pin, olderVersion);
          running(true);
          try {
            await this.write(
              epoch,
              "plugins.setEnabled",
              async () => {
                await this.beforeWrite(epoch, pin, mode, 1, olderVersion);
                await save({ pending: 2 });
                return { pluginId: id, enabled: false, allowlistPolicy: "preserve" };
              },
              () => save({ pending: null }),
            );
          } catch (error) {
            if (error instanceof Lost) throw new Stop("lost", error.message);
            if (error instanceof Stop) throw error;
            // Answered, which is no proof either way: a read decides. Still on, it didn't apply.
            const read = await this.readGateway(epoch, pin);
            if (!this.matches(read, pin, mode, 2, olderVersion)) {
              if (this.matches(read, pin, mode, 1, olderVersion)) await save({ pending: null });
              throw new Stop("refused", words(error));
            }
          }
          const read = await this.readGateway(epoch, pin);
          if (!this.matches(read, pin, mode, 2, olderVersion))
            throw new Stop(this.describe(read, pin));
          running(false);
        }
        await save({ step: 2, pending: null });
      } else if (step === 3) {
        if (mode === "turn-on") continue;
        let answer: Json;
        try {
          answer = await this.write(
            epoch,
            "plugins.install",
            async () => {
              // The host's tarball, checked again for this try: its path and bytes the pin's.
              const artifact = await this.verifiedArtifact(pin);
              await this.beforeWrite(epoch, pin, mode, 2, olderVersion);
              await save({ pending: 3 });
              return {
                source: "npm-pack",
                archivePath: artifact.path,
                enable: false,
                ...(mode === "update" ? { mode: "update" } : {}),
              };
            },
            () => save({ pending: null }),
          );
        } catch (error) {
          if (error instanceof Stop || error instanceof Lost) throw error;
          const text = words(error);
          if (/already exists/i.test(text)) throw new Stop("another-device", text);
          if (/connection from the Gateway host/i.test(text)) throw new Stop("route", text);
          if (
            /install_policy_warning/i.test(text) ||
            /install_policy_warning/i.test(JSON.stringify(rec(error).details ?? ""))
          )
            throw new Stop("policy-warning", text);
          throw new Stop("refused", text);
        }
        const plugin = rec(answer.plugin);
        const runtime = rec(answer.runtime);
        if (id in rec(runtime.sourceDigests) || id in rec(runtime.selectedEntries)) {
          running(true);
          await disable();
        }
        if (plugin.id !== id || plugin.packageName !== pin.packageName) {
          // The gateway staged another package than the one the host checked: never the engine's
          // to turn on or off. Its code may run if an entry of its own says so.
          const ran = [rec(runtime.sourceDigests), rec(runtime.selectedEntries)].some(
            (map) => Object.keys(map).length > 0,
          );
          running(ran);
          throw new Stop("mismatch", `the gateway staged ${String(plugin.id)}`);
        }
        if (answer.restartRequired === true) throw new Stop("restart");
        if (
          answer.ok !== true ||
          answer.restartRequired !== false ||
          plugin.id !== id ||
          plugin.packageName !== pin.packageName ||
          plugin.version !== pin.version ||
          plugin.enabled !== false ||
          !isRec(runtime.sourceDigests) ||
          !isRec(runtime.selectedEntries)
        )
          throw new Stop("lost", "the stage's answer is missing a field");
        await save({ step: 3, pending: null });
      } else if (step === 4) {
        const read = await this.readGateway(epoch, pin);
        if (!this.matches(read, pin, mode, 3, olderVersion))
          throw new Stop(this.describe(read, pin));
        token = this.verified(await this.inspect(epoch, pin), pin);
        if (token === null) throw new Stop("mismatch");
        await save({ step: 4 });
      } else if (step === 5) {
        const read = await this.readGateway(epoch, pin);
        if (read.shape === "OFF") {
          await patch(4, { enabled: false, ...pin.grants }, 5);
          const after = await this.readGateway(epoch, pin);
          if (!this.matches(after, pin, mode, 5)) throw new Stop(this.describe(after, pin));
        }
        await save({ step: 5, pending: null });
      } else if (step === 6) {
        await this.beforeWrite(epoch, pin, mode, 5);
        const inspected = await this.inspect(epoch, pin);
        // The token comes from this inspect, on a resume too (#832, 3).
        token = this.verified(inspected, pin);
        if (token === null || !this.hookGrantsInEffect(inspected, pin)) throw new Stop("mismatch");
        await save({ step: 6 });
      } else if (step === 7) {
        if (token === null) throw new Stop("lost", "no review token");
        const reviewToken = token;
        let answer: Json;
        try {
          answer = await this.write(
            epoch,
            "plugins.setEnabled",
            async () => {
              await this.beforeWrite(epoch, pin, mode, 6);
              await save({ pending: 7 });
              running(true);
              return {
                pluginId: id,
                enabled: true,
                allowlistPolicy: "preserve",
                acknowledgeCapabilities: { reviewToken },
              };
            },
            async () => {
              running(false);
              await save({ pending: null });
            },
          );
        } catch (error) {
          if (error instanceof Lost && record.again) await disable("lost");
          if (error instanceof Stop || error instanceof Lost) throw error;
          const text = words(error);
          const reason: PluginStop = /blocked by (allowlist|denylist)/i.test(text)
            ? "owner-settings"
            : /not installed/i.test(text)
              ? "not-listed-off"
              : "refused";
          // Answered, which is no proof the enable didn't apply: both versions answer an error
          // after a committed runtime change (3.4, "An answered error"). A read decides; until it
          // does, the mark and the warning stay.
          const read = await this.readGateway(epoch, pin);
          const off = read.disabled && (!read.listed || read.listed.unloaded);
          if (!off) await disable(reason, undefined, text);
          running(false);
          await save({ pending: null });
          throw new Stop(reason, text);
        }
        const got = str(rec(rec(answer.runtime).sourceDigests)[id]);
        if (answer.restartRequired === true) throw new Stop("restart");
        if (answer.ok !== true || answer.restartRequired !== false || got !== digest)
          await disable("turned-off", got ?? undefined);
        stepDigest = got;
        await save({ step: 7, pending: null, sourceDigest: got });
      } else if (step === 8) {
        // The plugin's own read first, then the reads the result is decided from.
        let reported: string | null = null;
        try {
          reported = str(rec(await this.call(epoch, confirm.method, confirm.params)).version);
        } catch (error) {
          if (error instanceof Stop || error instanceof Lost) throw error;
        }
        const read = await this.readGateway(epoch, pin);
        const inspected = await this.inspect(epoch, pin);
        const ok =
          stepDigest === digest &&
          read.shape === "ON+G" &&
          !read.keptOut &&
          read.listed?.active === true &&
          read.listed.version === pin.version &&
          rec(inspected.source).integrity === pin.integrity &&
          this.hookGrantsInEffect(inspected, pin) &&
          reported === pin.version;
        if (!ok)
          await disable(read.keptOut || read.shape === null ? "owner-settings" : "turned-off");
        running(false);
        await drop();
      }
    }
    return { kind: "enabled" };
  }

  /**
   * The one write that skips the checks: `setEnabled false` whatever is running and whatever the
   * state, tried again after 1, 2, 4, 8, 16 and 30 seconds and then every 30 while connected,
   * until a read shows the entry `enabled: false` and the plugin `unloaded`. False when the
   * connection went first: the record keeps "turning off" for the next.
   */
  private async turnOffUntilApplied(epoch: number, pin: PluginPin): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_OFF_TRIES; attempt += 1) {
      // Without a confirmed admin grant nothing is sent: the record keeps "turning off". A Take
      // it off asking the attempt to stop takes the turning off over.
      if (this.ctx.epoch() !== epoch || !this.ctx.admin() || this.cancelling) return false;
      try {
        this.writes += 1;
        await this.call(epoch, "plugins.setEnabled", {
          pluginId: pin.pluginId,
          enabled: false,
          allowlistPolicy: "preserve",
        });
      } catch (error) {
        if (error instanceof Stop) return false;
      }
      try {
        const read = await this.readGateway(epoch, pin);
        if (read.disabled && (!read.listed || read.listed.unloaded)) return true;
      } catch (error) {
        if (error instanceof Stop) return false;
      }
      await this.ctx.sleep(OFF_WAITS[attempt] ?? OFF_EVERY_MS);
    }
    return false;
  }

  /**
   * Take it off (section 12): its record kept first, then, with no run going, the plugin turned
   * off until a read shows it unloaded, then its grants written `null` under the hash of the
   * same read that found them. That leaves the entry `OFF` and the plugin installed. The record
   * goes only once a read shows that; until then the next attempt finishes the take-off first.
   */
  private async takeOffNow(pin: PluginPin): Promise<PluginOutcome> {
    const epoch = this.ctx.epoch();
    const id = pin.pluginId;
    let mayBeRunning = false;
    const saw = (read: GatewayRead) => {
      if (read.listed?.active === true || read.enabledSet) mayBeRunning = true;
      else if (read.disabled && !read.listed?.active) mayBeRunning = false;
      this.live = mayBeRunning;
    };
    try {
      this.requireCarried(pin);
      if (!this.ctx.admin()) throw new Stop("no-admin");
      const route = this.ctx.route();
      if (route !== "same-computer" && route !== "ssh") throw new Stop("route");
      // Kept before any write: an install this device had under way never resumes after this.
      const kept = await this.ctx.loadRecord(id);
      if (kept && tracksRunning(kept)) mayBeRunning = true;
      await this.ctx.saveRecord(id, { ...(kept ?? takeOffRecord(pin)), takingOff: true });

      const read = await this.idleRead(epoch, pin, saw);
      if (read.shape === null || read.keptOut) throw new Stop(this.describe(read, pin));
      // Not installed but its entry on: the owner's, and nothing a disable can reach.
      if (!read.listed && read.enabledSet) throw new Stop(this.describe(read, pin));
      if (read.enabledSet || read.listed?.active) {
        mayBeRunning = true;
        if (!(await this.turnOffUntilApplied(epoch, pin))) throw new Stop("lost");
        mayBeRunning = false;
      }
      const raw = JSON.stringify({
        plugins: {
          entries: {
            [id]: {
              enabled: false,
              ...Object.fromEntries(Object.keys(pin.grants).map((key) => [key, null])),
            },
          },
        },
      });
      if (Object.keys(pin.grants).length > 0) {
        for (let attempt = 0; ; attempt += 1) {
          try {
            await this.write(epoch, "config.patch", async () => {
              // One fresh read checks the entry and gives the hash the patch is sent under.
              const now = await this.idleRead(epoch, pin, saw);
              if (now.shape === "OFF" || now.shape === "none") throw new AlreadyApplied();
              if (now.shape !== "OFF+G" || now.listed?.active)
                throw new Stop(this.describe(now, pin));
              return { baseHash: now.hash, raw };
            });
            break;
          } catch (error) {
            if (error instanceof AlreadyApplied) break;
            if (error instanceof Stop || error instanceof Lost) throw error;
            if (!staleHash(error) || attempt > 0) throw error;
          }
        }
      }
      const after = await this.readGateway(epoch, pin);
      saw(after);
      if ((after.shape !== "OFF" && after.shape !== "none") || after.listed?.active)
        throw new Stop(this.describe(after, pin));
      // Taken off: the record, the take-off's and any attempt's before it, is over.
      await this.ctx.saveRecord(id, null);
      return { kind: "taken-off" };
    } catch (error) {
      return this.stopped(error, mayBeRunning);
    }
  }
}
