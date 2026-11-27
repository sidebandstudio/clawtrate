// A stand-in gateway for the install engine's tests. It keeps one plugin's state (its entry, the
// allow and deny lists, whether it is staged and loaded) and answers every call with the frames a
// development gateway of each OpenClaw version answered (fixtures/plugin-install/<version>.json,
// captured on both versions with the calls of docs/design/plugins-install.md, section 3.4).
// Each answer is the captured frame with the state's own values put in: the entry, the listed
// version and runtime state, the inspected integrity, and the source digest of what is loaded.

import v1006 from "./fixtures/plugin-install/2026.10.6.json" with { type: "json" };
import v1110 from "./fixtures/plugin-install/2026.11.10.json" with { type: "json" };
import type { PluginInstallContext, PluginPin, PluginRecord } from "../src/plugin-install.ts";

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
  hash = 0;
  token = "e9ee055fdf3a7d0f5c8f4db342886ceca40fecac78cbd94febb73acd562e45fd";
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

  private listAnswer(): Json {
    const answer = clone(this.f.list);
    if (this.staged) {
      const row = clone(this.f.voiceRow);
      row.version = this.staged.version;
      row.enabled = this.loaded;
      row.state = this.loaded ? "enabled" : "disabled";
      row.runtime = { state: this.loaded ? "active" : "unloaded" };
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
        answer.sessions = this.busy ? [{ key: "agent:main:main", hasActiveRun: true }] : [];
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
    if (hook?.refuse) throw this.refusal(hook.refuse);
    if (hook?.lose === "before") throw new LostReply(`${method}: the reply didn't come`);
    let answer = this.handle(method, p);
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
    slept,
    records,
  };
}
