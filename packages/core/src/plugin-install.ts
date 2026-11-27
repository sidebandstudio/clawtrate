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
  | "connection-changed";

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

export class PluginInstaller {
  private readonly ctx: PluginInstallContext;
  /** The writes sent, numbered: each write takes the next. */
  private writes = 0;
  /** The attempt under way, if any: one at a time, for every plugin. */
  private current: Promise<PluginOutcome> | null = null;

  constructor(ctx: PluginInstallContext) {
    this.ctx = ctx;
  }

  /** How many writes this engine has sent. */
  get writesSent(): number {
    return this.writes;
  }

  /** First setup, or a person already paired: the plugin isn't listed and has no entry. */
  install(pin: PluginPin, archivePath: string, confirm: ConfirmCall) {
    return this.one(() => this.attempt(pin, archivePath, confirm, "install"));
  }
  /** The person's "Add again": not listed, entry `OFF`. */
  addAgain(pin: PluginPin, archivePath: string, confirm: ConfirmCall) {
    return this.one(() => this.attempt(pin, archivePath, confirm, "add-again"));
  }
  /** The person's "Turn on": listed `unloaded` at the pin, entry `OFF` or `OFF+G`. */
  turnOn(pin: PluginPin, archivePath: string, confirm: ConfirmCall) {
    return this.one(() => this.attempt(pin, archivePath, confirm, "turn-on"));
  }
  /** The person's "Update": listed `active` at an older shipped release, entry `ON+G`. */
  update(pin: PluginPin, archivePath: string, confirm: ConfirmCall) {
    return this.one(() => this.attempt(pin, archivePath, confirm, "update"));
  }
  /** At a connection: goes on with this device's record, if it has one. */
  resume(pin: PluginPin, archivePath: string, confirm: ConfirmCall) {
    return this.one(() => this.attempt(pin, archivePath, confirm, null));
  }
  /** "Take it off" (section 12): turned off, its grants removed, left installed. */
  takeOff(pin: PluginPin) {
    return this.one(() => this.takeOffNow(pin));
  }

  private async one(run: () => Promise<PluginOutcome>): Promise<PluginOutcome> {
    if (this.current) return { kind: "stopped", stop: "in-progress", mayBeRunning: false };
    const running = run().finally(() => {
      this.current = null;
    });
    this.current = running;
    return running;
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
      // Refused, or never sent (a before-write read that stopped a retry): it didn't apply, so the
      // write it marked as in flight isn't. A lost reply, or a connection gone mid-request, may
      // have applied, and keeps its mark for the resume to decide.
      const unknown =
        error instanceof Lost || (error instanceof Stop && error.stop === "connection-changed");
      if (!unknown) await notApplied?.();
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
   * Whether any session has a run going, over every page of `sessions.list` (`hasMore` and
   * `nextOffset`). More pages than `MAX_SESSION_PAGES` count as busy: idle is never assumed.
   */
  private async anyRunGoing(epoch: number): Promise<boolean> {
    let params: Json = { limit: SESSION_PAGE };
    for (let pages = 0; pages < MAX_SESSION_PAGES; pages += 1) {
      const page = await this.call(epoch, "sessions.list", params);
      if (!Array.isArray(page.sessions)) throw new Lost("a read missing a field");
      if (page.sessions.some((s) => rec(s).hasActiveRun === true)) return true;
      if (page.hasMore !== true || typeof page.nextOffset !== "number") return false;
      params = { limit: SESSION_PAGE, offset: page.nextOffset };
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
      const read = await this.readGateway(epoch, pin);
      if (read.keptOut || read.shape === null) throw new Stop(this.describe(read, pin));
      if (!this.matches(read, pin, mode, after, olderVersion))
        throw new Stop(this.describe(read, pin));
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
    archivePath: string,
    confirm: ConfirmCall,
    wanted: PluginMode | null,
  ): Promise<PluginOutcome> {
    const epoch = this.ctx.epoch();
    let record = await this.ctx.loadRecord(pin.pluginId);
    if (record && record.integrity !== pin.integrity) {
      // Another pin's attempt: it isn't this app's to finish.
      await this.ctx.saveRecord(pin.pluginId, null);
      record = null;
    }
    const save = async (patch: Partial<PluginRecord>) => {
      record = { ...record!, ...patch };
      await this.ctx.saveRecord(pin.pluginId, record);
    };
    const drop = async () => {
      record = null;
      await this.ctx.saveRecord(pin.pluginId, null);
    };
    let mayBeRunning = false;
    try {
      // Step 0.
      if (!this.ctx.admin()) throw new Stop("no-admin");
      const route = this.ctx.route();
      if (route !== "same-computer" && route !== "ssh") throw new Stop("route");
      const openclaw = this.ctx.serverVersion() ?? "";
      const digest = pin.sourceDigests[openclaw];
      if (!digest) throw new Stop("openclaw-version");

      // A record left by this device: go on where it stopped, or stop. Until a read shows the
      // plugin off, a record whose write could have left it running says it may be (#832, 4).
      if (record)
        mayBeRunning =
          record.turningOff ||
          record.pending === 7 ||
          record.step >= 7 ||
          (record.mode === "update" && (record.step < 2 || record.pending === 2));
      if (record) {
        const resumed = await this.resumeFrom(
          epoch,
          pin,
          record,
          (patch) => save(patch),
          () => drop(),
        );
        if (resumed.kind !== "continue") return resumed.outcome;
        return await this.steps(
          epoch,
          pin,
          archivePath,
          confirm,
          record!,
          resumed.from,
          digest,
          save,
          drop,
          (v) => (mayBeRunning = v),
        );
      }
      if (wanted === null) return { kind: "stopped", stop: "lost", mayBeRunning: false };

      for (let tries = 0; ; tries += 1) {
        try {
          return await this.fromStepOne(
            epoch,
            pin,
            archivePath,
            confirm,
            wanted,
            digest,
            (r) => (record = r),
            save,
            drop,
            (v) => (mayBeRunning = v),
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
    archivePath: string,
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
      archivePath,
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
  ): Promise<{ kind: "continue"; from: number } | { kind: "done"; outcome: PluginOutcome }> {
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
        await save({ turningOff: false, step: 6, pending: null, sourceDigest: null, again: true });
        return { kind: "continue", from: 6 };
      }
      await drop();
      return {
        kind: "done",
        outcome: { kind: "stopped", stop: this.describe(read, pin), mayBeRunning: false },
      };
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
    await drop();
    return {
      kind: "done",
      outcome: {
        kind: "stopped",
        stop: this.describe(read, pin),
        mayBeRunning: read.listed?.active === true,
      },
    };
  }

  /** Steps `from` to 8. */
  private async steps(
    epoch: number,
    pin: PluginPin,
    archivePath: string,
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
    ): Promise<never> => {
      await save({ turningOff: true });
      const off = await this.turnOffUntilApplied(epoch, pin);
      if (off) {
        running(false);
        await drop();
      }
      const stop = new Stop(off ? reason : "lost");
      if (reported) stop.reported = reported;
      throw stop;
    };
    let token: string | null = null;
    let stepDigest: string | null = record.sourceDigest;
    // Step 7 needs step 6's inspect, for its review token (#832, 3).
    for (let step = from === 7 ? 6 : from; step <= 8; step += 1) {
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
            throw error;
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
              await this.beforeWrite(epoch, pin, mode, 2, olderVersion);
              await save({ pending: 3 });
              return {
                source: "npm-pack",
                archivePath,
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
          running(false);
          await save({ pending: null });
          if (/blocked by (allowlist|denylist)/i.test(text)) throw new Stop("owner-settings", text);
          if (/not installed/i.test(text)) throw new Stop("not-listed-off", text);
          throw new Stop("refused", text);
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
      // Without a confirmed admin grant nothing is sent: the record keeps "turning off".
      if (this.ctx.epoch() !== epoch || !this.ctx.admin()) return false;
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
   * Take it off: after the before-write read, `setEnabled false` and then the grants written
   * `null`, which leaves the entry `OFF` and the plugin installed and unloaded.
   */
  private async takeOffNow(pin: PluginPin): Promise<PluginOutcome> {
    const epoch = this.ctx.epoch();
    let mayBeRunning = false;
    try {
      if (!this.ctx.admin()) throw new Stop("no-admin");
      const route = this.ctx.route();
      if (route !== "same-computer" && route !== "ssh") throw new Stop("route");
      const read = await this.readGateway(epoch, pin);
      if (read.shape === null || !read.listed) throw new Stop(this.describe(read, pin));
      if (read.shape === "ON+G" || read.listed.active) {
        mayBeRunning = true;
        await this.write(epoch, "plugins.setEnabled", async () => ({
          pluginId: pin.pluginId,
          enabled: false,
          allowlistPolicy: "preserve",
        }));
      }
      const grantKeys = Object.keys(pin.grants).length;
      const raw = JSON.stringify({
        plugins: {
          entries: {
            [pin.pluginId]: {
              enabled: false,
              ...Object.fromEntries(Object.keys(pin.grants).map((key) => [key, null])),
            },
          },
        },
      });
      if (grantKeys > 0 && (await this.readGateway(epoch, pin)).shape === "OFF+G")
        await this.write(epoch, "config.patch", async () => ({
          baseHash: (await this.readGateway(epoch, pin)).hash,
          raw,
        }));
      const after = await this.readGateway(epoch, pin);
      if (after.shape !== "OFF" || !after.listed?.unloaded)
        throw new Stop(this.describe(after, pin));
      // Taken off on purpose: an attempt this device had under way is over.
      await this.ctx.saveRecord(pin.pluginId, null);
      return { kind: "taken-off" };
    } catch (error) {
      return this.stopped(error, mayBeRunning);
    }
  }
}
