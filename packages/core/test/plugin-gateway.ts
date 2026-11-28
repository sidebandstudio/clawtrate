// A stand-in gateway for the install engine's tests. It keeps one plugin's state (its entry, the
// allow and deny lists, whether it is staged and loaded) and answers every call with the frames a
// development gateway of each OpenClaw version answered (fixtures/plugin-install/<version>.json,
// captured on both versions with the calls of docs/design/plugins-install.md, section 3.4).
// Each answer is the captured frame with the state's own values put in: the entry, the listed
// version and runtime state, the inspected integrity, and the source digest of what is loaded.

import v1006 from "./fixtures/plugin-install/2026.10.6.json" with { type: "json" };
import v1110 from "./fixtures/plugin-install/2026.11.10.json" with { type: "json" };
import type {
  PluginInstallContext,
  PluginPin,
  PluginRecord,
  VerifiedArtifact,
} from "../src/plugin-install.ts";

export const VERSIONS = ["2026.10.6", "2026.11.10"] as const;
export type Version = (typeof VERSIONS)[number];

// The captured frames are read and changed field by field; their shapes are each version's own.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const frames = (version: Version): Json =>
  clone((version === "2026.10.6" ? v1006 : v1110) as Json);

export const ID = "clawtrate-voice";
export const PIN_DIGEST = "99dfd0ed8aedfd66ca983024dc0bd56510358a3236b8530d1943eb722556c760";
export const OLDER_DIGEST = "9c69e73a74b09fa5a4a48ee541960a5de5d11cb8e694beba1e78280c1bf57378";
export const OTHER_DIGEST = "1".repeat(64);

/** The tarballs the tests hand the gateway: the app's own, an older shipped one, another copy. */
export const TARBALLS: Record<string, { version: string; integrity: string; digest: string }> = {
  "/app/plugins/clawtrate-clawtrate-voice-0.1.0.tgz": {
    version: "0.1.0",
    integrity:
      "sha512-7cEUmNnRN1uCGhxcVN1XgsryIiZSn0SylLRmggowyv3rB/cXV75EfoteeJEckZR4uzfYWZNCCys8xc60+sI06w==",
    digest: PIN_DIGEST,
  },
  "/old/plugins/clawtrate-clawtrate-voice-0.0.9.tgz": {
    version: "0.0.9",
    integrity:
      "sha512-8HYfqK4+izxRKTziNZ4TnlyMDFSlmXSQMTiyDS7VXD00cuZFzb2qKtzZA0/Gap0ns0OwVEzZ+1UvuL24G2em1w==",
    digest: OLDER_DIGEST,
  },
  "/other/plugins/clawtrate-clawtrate-voice-0.1.0.tgz": {
    version: "0.1.0",
    integrity:
      "sha512-ML6aZyJ6pPiiVnYxRagLquxFOdvFeZHq8+ZAp3kNU4jISItq7vQDhq+UMmLZer7KSyqMDYtWlyFQdDZguZZT5A==",
    digest: OTHER_DIGEST,
  },
};
export const ARCHIVE = "/app/plugins/clawtrate-clawtrate-voice-0.1.0.tgz";
/** The app's resources folder the host finds its tarball in. */
export const RESOURCES = "/app/plugins";
export const OLDER_ARCHIVE = "/old/plugins/clawtrate-clawtrate-voice-0.0.9.tgz";
export const OTHER_ARCHIVE = "/other/plugins/clawtrate-clawtrate-voice-0.1.0.tgz";

export const PIN: PluginPin = {
  packageName: "@clawtrate/clawtrate-voice",
  version: "0.1.0",
  pluginId: ID,
  integrity: TARBALLS[ARCHIVE]!.integrity,
  declared: {
    channels: [],
    providers: [],
    tools: [],
    contracts: [],
    hooks: [],
    mcpServers: [],
    cliCommands: [],
    cliBackends: [],
    skills: [],
    dangerousConfigFlags: [],
  },
  grants: { hooks: { allowConversationAccess: true } },
  sourceDigests: { "2026.10.6": PIN_DIGEST, "2026.11.10": PIN_DIGEST },
};
export const CONFIRM = { method: "clawtrate-voice.get", params: {} };
export const SHIPPED = [{ version: "0.0.9", integrity: TARBALLS[OLDER_ARCHIVE]!.integrity }];

/** A refusal the gateway answered, as the gateway client throws it. */
export class Refusal extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(frame: Json) {
    super(String(frame.message));
    this.code = String(frame.code);
    if (frame.details !== undefined) this.details = frame.details;
    this.retryable = frame.retryable === true;
    if (typeof frame.retryAfterMs === "number") this.retryAfterMs = frame.retryAfterMs;
  }
}
/** A request whose reply never came. */
export class LostReply extends Error {}

/**
 * The error both versions answer a plugin change with when something after its runtime change
 * failed: the change applied, and the answer is an error all the same. Built as the gateway
 * builds it, since no development run makes it happen on purpose: `pluginLifecycleError` (on
 * 2026.10.6 `plugins-lifecycle-error-61PGW2_G.mjs:23-52`, on 2026.11.10
 * `plugins-mutations-MjAXEDgk.mjs:3`) with `projectPluginRuntimeFailure`'s `committed: true`
 * runtime (2026.10.6 `lifecycle-CvKiePUp.mjs:69-78`, 2026.11.10 `lifecycle-rUzhDmbF.mjs:4`).
 */
export function committedError(
  digest: string | null,
  cause = "Plugin config could not be persisted.",
): Json {
  return {
    code: "UNAVAILABLE",
    message: `${cause}\nAn earlier runtime change from this operation was applied in Gateway generation 7.`,
    details: {
      runtime: {
        operationId: "a1d50d7d-069f-4544-babc-b1331e996fb9",
        generation: 7,
        pluginIds: [ID],
        // What the change left loaded: the enabled copy, or nothing after a disable.
        sourceDigests: digest ? { [ID]: digest } : {},
        selectedEntries: digest
          ? {
              [ID]: "/gateway-state/npm/projects/voice/node_modules/@clawtrate/clawtrate-voice/index.js",
            }
          : {},
        committed: true,
      },
    },
  };
}

/**
 * The cause both versions give when the registry lookup after an applied enable or disable
 * fails (`<1006>/dist/management-mutations-BsUMS3ce.mjs:288`, the same words in
 * `<1110>/dist/management-mutations-C4la5R4f.mjs`).
 */
export const LOOKUP_FAILED = `updated plugin missing from refreshed registry: ${ID}`;

export type Call = { method: string; params: Json };
/** What a test does at a call: before the gateway handles it, or instead of its reply. */
export type Hook = {
  method: string;
  /** Which call of that method, counting from 1; every one when absent. */
  nth?: number;
  /** Change the state before the gateway handles the call (an owner, another device). */
  before?: (gateway: FakeGateway) => void;
  /** The reply is lost: "before" the gateway handles it, or "after" it applied. */
  lose?: "before" | "after";
  /** The gateway answers this refusal instead (from the captured errors, by name). */
  refuse?: string | Json;
  /** The request is never answered: the device's process ends while it waits. */
  hang?: boolean;
  /** The gateway handles the call, then answers this error: a change that committed anyway. */
  refuseAfter?: string | Json;
  /** Answer with this instead (for a field missing, or an answer the run never saw). */
  answer?: (answer: Json) => Json;
};

export class FakeGateway {
  readonly version: Version;
  readonly f: Json;
  /** The plugin's entry, `plugins.entries.clawtrate-voice`. */
  entry: Json | undefined;
  allow: string[] = [];
  deny: string[] = [];
  /** What is staged: its tarball's facts, or null when not installed. */
  staged: { version: string; integrity: string; digest: string } | null = null;
  /** Its code is loaded: the runtime's `active`. */
  loaded = false;
  /** Every digest that ever loaded, in order: what ran. */
  ran: string[] = [];
  busy = false;
  /** Sessions served a page at a time, as the gateway pages `sessions.list`; one page when null. */
  sessionPages: Json[][] | null = null;
  /** Sessions served by offset and limit from one list, as the gateway pages it, when set. */
  sessionRows: Json[] | null = null;
  /**
   * An enable whose request timed out on the client and is still under way: it holds the
   * lifecycle lease, so the next plugin or config change is answered "already running", and it
   * publishes when the lease ends (at that change, or at `finishDelayed`).
   */
  delayedEnable = false;
  /** Changes the delayed enable's lease refuses before it ends and the enable publishes. */
  delayedRefusals = 0;
  /** The listing's runtime state, when it differs from what the entry and stage make it. */
  runtimeState: string | null = null;
  /** A routine's run going, which `cron.list` shows and `sessions.list` never does. */
  routineRunning = false;
  /** Routines served a page at a time, as the gateway pages `cron.list`; one page when null. */
  routinePages: Json[][] | null = null;
  hash = 0;
  token = "review-token-of-the-captured-inspect";
  readonly calls: Call[] = [];
  readonly hooks: Hook[] = [];
  private seen = new Map<string, number>();
  changedListeners: (() => void)[] = [];

  constructor(version: Version) {
    this.version = version;
    this.f = frames(version);
  }

  get configHash() {
    return `hmac-sha256:v1:fake-${this.hash}`;
  }

  /** The gateway loads what its entry and staging say, as both versions do. */
  private settle() {
    const was = this.loaded;
    this.loaded =
      this.staged !== null &&
      this.entry?.enabled !== false &&
      (this.entry?.enabled === true || this.entry?.hooks !== undefined) &&
      !this.deny.includes(ID);
    if (this.loaded && !was) this.ran.push(this.staged!.digest);
    for (const listener of this.changedListeners.splice(0)) listener();
  }

  private refusal(name: string | Json): Refusal {
    return new Refusal(typeof name === "string" ? this.f.errors[name] : name);
  }

  private configAnswer(): Json {
    const answer = clone(this.f.config);
    answer.hash = this.configHash;
    const plugins = answer.config.plugins;
    if (this.entry !== undefined) plugins.entries[ID] = clone(this.entry);
    if (this.allow.length > 0) plugins.allow = [...this.allow];
    if (this.deny.length > 0) plugins.deny = [...this.deny];
    return answer;
  }

  /** The delayed enable publishes: its lease has ended. */
  finishDelayed() {
    if (!this.delayedEnable) return;
    this.delayedEnable = false;
    this.entry = { ...(this.entry ?? {}), enabled: true };
    this.hash += 1;
    this.settle();
  }

  private listAnswer(): Json {
    const answer = clone(this.f.list);
    if (this.staged) {
      const row = clone(this.f.voiceRow);
      row.version = this.staged.version;
      row.enabled = this.loaded;
      row.state = this.loaded ? "enabled" : "disabled";
      row.runtime = { state: this.runtimeState ?? (this.loaded ? "active" : "unloaded") };
      answer.plugins.push(row);
    }
    return answer;
  }

  private runtime(answer: Json): Json {
    answer.runtime.sourceDigests = this.loaded ? { [ID]: this.staged!.digest } : {};
    answer.runtime.selectedEntries = this.loaded
      ? {
          [ID]: `/gateway-state/npm/projects/voice/node_modules/@clawtrate/clawtrate-voice/index.js`,
        }
      : {};
    return answer;
  }

  private pluginPart(answer: Json): Json {
    answer.plugin.version = this.staged!.version;
    answer.plugin.enabled = this.loaded;
    answer.plugin.state = this.loaded ? "enabled" : "disabled";
    return answer;
  }

  private handle(method: string, params: Json): Json {
    switch (method) {
      case "config.get":
        return this.configAnswer();
      case "plugins.list":
        return this.listAnswer();
      case "sessions.list": {
        const answer = clone(this.f.sessions);
        if (this.sessionRows) {
          const at = typeof params.offset === "number" ? params.offset : 0;
          const limit = typeof params.limit === "number" ? params.limit : this.sessionRows.length;
          answer.sessions = this.sessionRows.slice(at, at + limit);
          answer.offset = at;
          answer.count = answer.sessions.length;
          answer.totalCount = this.sessionRows.length;
          answer.hasMore = at + answer.sessions.length < this.sessionRows.length;
          answer.nextOffset = answer.hasMore ? at + answer.sessions.length : null;
          return answer;
        }
        if (this.sessionPages) {
          const at = typeof params.offset === "number" ? params.offset : 0;
          answer.sessions = this.sessionPages[at] ?? [];
          answer.count = answer.sessions.length;
          answer.totalCount = this.sessionPages.flat().length;
          answer.hasMore = at + 1 < this.sessionPages.length;
          answer.nextOffset = answer.hasMore ? at + 1 : null;
          return answer;
        }
        answer.sessions = this.busy ? [{ key: "agent:main:main", hasActiveRun: true }] : [];
        answer.count = answer.sessions.length;
        answer.totalCount = answer.sessions.length;
        return answer;
      }
      case "cron.list": {
        const answer = clone(this.f.cron);
        if (this.routinePages) {
          const at = typeof params.offset === "number" ? params.offset : 0;
          answer.jobs = this.routinePages[at] ?? [];
          answer.total = this.routinePages.flat().length;
          answer.hasMore = at + 1 < this.routinePages.length;
          answer.nextOffset = answer.hasMore ? at + 1 : null;
          return answer;
        }
        answer.jobs = this.routineRunning
          ? [
              {
                id: "daily-digest",
                name: "Daily digest",
                enabled: true,
                runningAtMs: 1_795_800_000_000,
              },
            ]
          : [];
        answer.total = answer.jobs.length;
        return answer;
      }
      case "config.patch": {
        if (params.baseHash !== this.configHash) throw this.refusal("staleHash");
        const raw = JSON.parse(String(params.raw)) as Json;
        const entries = raw.plugins?.entries ?? {};
        if (ID in entries) {
          const next: Json = { ...(this.entry ?? {}) };
          for (const [key, value] of Object.entries(entries[ID] as Json))
            if (value === null) delete next[key];
            else next[key] = value;
          this.entry = next;
        }
        this.hash += 1;
        this.settle();
        const answer = clone(this.f.patch);
        answer.hash = this.configHash;
        return answer;
      }
      case "plugins.install": {
        const tarball = TARBALLS[String(params.archivePath)];
        if (params.source !== "npm-pack" || !tarball) throw this.refusal("missingArchive");
        if (this.staged && params.mode !== "update") throw this.refusal("alreadyExists");
        this.staged = { ...tarball };
        this.loaded = false;
        this.settle();
        return this.pluginPart(this.runtime(clone(this.f.install)));
      }
      case "plugins.inspect": {
        if (!this.staged)
          throw new Refusal({ message: `Plugin "${ID}" not found.`, code: "INVALID_REQUEST" });
        const answer = clone(this.f.inspect);
        answer.plugin.version = this.staged.version;
        answer.plugin.enabled = this.loaded;
        answer.source.spec = `@clawtrate/clawtrate-voice@${this.staged.version}`;
        answer.source.integrity = this.staged.integrity;
        answer.reviewToken = this.token;
        // As the gateway resolves them from the entry (`buildPluginCapabilitySummary`).
        const hooks = (this.entry?.hooks ?? {}) as Json;
        answer.grants.hooks = {
          allowPromptInjection: {
            effective: hooks.allowPromptInjection !== false,
            ...(typeof hooks.allowPromptInjection === "boolean"
              ? { configured: hooks.allowPromptInjection }
              : {}),
          },
          allowConversationAccess: {
            effective: hooks.allowConversationAccess === true,
            ...(typeof hooks.allowConversationAccess === "boolean"
              ? { configured: hooks.allowConversationAccess }
              : {}),
          },
        };
        return answer;
      }
      case "plugins.setEnabled": {
        if (!this.staged) throw this.refusal("notInstalled");
        if (params.enabled === true) {
          if (this.deny.includes(ID)) throw this.refusal("blockedDeny");
          if (
            this.allow.length > 0 &&
            !this.allow.includes(ID) &&
            params.allowlistPolicy === "preserve"
          )
            throw this.refusal("blockedAllow");
          this.entry = { ...(this.entry ?? {}), enabled: true };
          this.hash += 1;
          this.settle();
          return this.pluginPart(this.runtime(clone(this.f.enable)));
        }
        this.entry = { ...(this.entry ?? {}), enabled: false };
        this.hash += 1;
        this.settle();
        return this.pluginPart(this.runtime(clone(this.f.disable)));
      }
      case "clawtrate-voice.get": {
        if (!this.loaded)
          throw new Refusal({ message: `unknown method: ${ID}.get`, code: "INVALID_REQUEST" });
        const answer = clone(this.f.voiceGet);
        answer.version = this.staged!.version;
        return answer;
      }
      default:
        throw new Error(`the engine called ${method}`);
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Json;
    this.calls.push({ method, params: clone(p) });
    const n = (this.seen.get(method) ?? 0) + 1;
    this.seen.set(method, n);
    const hook = this.hooks.find(
      (h) => h.method === method && (h.nth === undefined || h.nth === n),
    );
    hook?.before?.(this);
    if (hook?.hang) return new Promise(() => {});
    if (
      this.delayedEnable &&
      ["config.patch", "plugins.install", "plugins.setEnabled"].includes(method)
    ) {
      // The lease is the earlier enable's: refused while it holds it; then that enable publishes
      // and this change goes through after it.
      if (this.delayedRefusals > 0) {
        this.delayedRefusals -= 1;
        throw this.refusal("busy");
      }
      this.finishDelayed();
    }
    if (hook?.refuse) throw this.refusal(hook.refuse);
    if (hook?.lose === "before") throw new LostReply(`${method}: the reply didn't come`);
    let answer = this.handle(method, p);
    if (hook?.refuseAfter) throw this.refusal(hook.refuseAfter);
    if (hook?.lose === "after") throw new LostReply(`${method}: the reply didn't come`);
    if (hook?.answer) answer = hook.answer(answer);
    return answer;
  }

  /** The writes the engine sent, in order. */
  writes(): Call[] {
    return this.calls.filter((c) =>
      ["config.patch", "plugins.install", "plugins.setEnabled", "plugins.uninstall"].includes(
        c.method,
      ),
    );
  }

  shape(): string {
    if (this.entry === undefined) return "none";
    const { config: _config, ...rest } = this.entry;
    if (JSON.stringify(rest) === JSON.stringify({ enabled: false })) return "OFF";
    if (
      JSON.stringify(rest) ===
      JSON.stringify({ enabled: false, hooks: { allowConversationAccess: true } })
    )
      return "OFF+G";
    if (
      JSON.stringify(rest) ===
      JSON.stringify({ enabled: true, hooks: { allowConversationAccess: true } })
    )
      return "ON+G";
    return JSON.stringify(this.entry);
  }

  /** A gateway in one of the modes' starting states. */
  static at(
    version: Version,
    start: "fresh" | "uninstalled" | "off" | "off-no-grant" | "older-on" | "on",
  ): FakeGateway {
    const g = new FakeGateway(version);
    if (start === "uninstalled") g.entry = { enabled: false };
    if (start === "off" || start === "on" || start === "off-no-grant")
      g.staged = { ...TARBALLS[ARCHIVE]! };
    if (start === "off") g.entry = { enabled: false, hooks: { allowConversationAccess: true } };
    if (start === "off-no-grant") g.entry = { enabled: false };
    if (start === "on")
      g.entry = { enabled: true, hooks: { allowConversationAccess: true }, config: {} };
    if (start === "older-on") {
      g.staged = { ...TARBALLS[OLDER_ARCHIVE]! };
      g.entry = { enabled: true, hooks: { allowConversationAccess: true }, config: {} };
    }
    g.settle();
    g.ran = [];
    return g;
  }
}

/** The engine's context on `gateway`: an admin connection on this computer, time passing at once. */
export function contextFor(
  gateway: FakeGateway,
  options: {
    admin?: () => boolean;
    route?: "same-computer" | "ssh" | "other";
    records?: Map<string, PluginRecord | null>;
    epoch?: () => number;
    serverVersion?: string;
    /** The app's carried list; the pin alone by default. */
    carried?: PluginPin[];
    /** The host's check of its tarball; the app's own, verified, by default. */
    artifact?: (pin: PluginPin) => Promise<VerifiedArtifact>;
  } = {},
): PluginInstallContext & { slept: number[]; records: Map<string, PluginRecord | null> } {
  const records = options.records ?? new Map<string, PluginRecord | null>();
  const slept: number[] = [];
  let clock = 0;
  return {
    request: (method, params) => gateway.request(method, params),
    admin: options.admin ?? (() => true),
    serverVersion: () => options.serverVersion ?? gateway.version,
    route: () => options.route ?? "same-computer",
    answered: (error) => error instanceof Refusal,
    epoch: options.epoch ?? (() => 1),
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    now: () => clock,
    changed: (ms) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), Math.min(ms, 20));
        gateway.changedListeners.push(() => {
          clearTimeout(timer);
          resolve(true);
        });
      }),
    loadRecord: async (id) => records.get(id) ?? null,
    saveRecord: async (id, record) => {
      records.set(id, record ? JSON.parse(JSON.stringify(record)) : null);
    },
    shipped: SHIPPED,
    carried: options.carried ?? [PIN],
    artifact:
      options.artifact ??
      (async () => ({
        path: ARCHIVE,
        root: RESOURCES,
        integrity: TARBALLS[ARCHIVE]!.integrity,
      })),
    slept,
    records,
  };
}
