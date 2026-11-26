// Where a bot runs and the gateway's machines (docs/design/controls.md,
// sections 14 and 15). Read now and not kept: every answer carries the time it
// was read, and the engine retains nothing between reads (nothing here is in
// `ClawtrateState` or in a collection of the client). What each method of
// OpenClaw 2026.10.6 returned on a development instance is in
// `docs/decisions.md` ("Where a bot runs and Machines").
//
// Everything here is what the gateway's settings say or what the gateway
// reported, and nothing is inferred from it: a configured host is not where a
// command ran, a stored path or node equal to another bot's is the same
// setting and no more, and an approvals file's settings are not what a command
// will do. A command's machine, a bot's workspace and its browser settings are
// read apart; none is inferred from another.

import { parseModelRef } from "./accounts.ts";
import { isCertainRefusal } from "./accounts-engine.ts";
import { asRecord, type RawRecord } from "./mapping.ts";

/** Paired machines kept in one answer; past it, `nodesOmitted` counts the rest. */
export const MAX_NODES = 16;
/** Paired devices kept in one answer. */
export const MAX_DEVICES = 32;
/** Names of the gateway's secret store, of tool servers, of accounts, of list entries. */
export const MAX_INVENTORY = 32;
/** Plugins whose credential fields are read, and fields read per plugin. */
export const MAX_PLUGINS = 8;
export const MAX_PLUGIN_FIELDS = 8;
/** Per-bot entries of an approvals file shown: only those of listed bots, at most the bot count. */
export const MAX_APPROVAL_ENTRIES = 32;
/** A name, a label, an id, a stored setting's value. */
export const MAX_MACHINE_NAME_CHARS = 128;
/** A last-seen reason (`connect`, …). */
export const MAX_SEEN_REASON_CHARS = 64;
/** A path the gateway reports or a person types. */
export const MAX_PATH_CHARS = 4096;
/** A reason or an error. */
export const MAX_REASON_CHARS = 512;

/** The commands a node declares that let Clawtrate read and set its approvals file. */
export const NODE_APPROVALS_COMMANDS = ["system.execApprovals.get", "system.execApprovals.set"];

/** The `tools.exec.host` values OpenClaw 2026.10.6 accepts. Any other stored value is shown as it is. */
export const KNOWN_HOSTS = ["auto", "sandbox", "gateway", "node"];

export type Security = "deny" | "allowlist" | "full";
export type Ask = "off" | "on-miss" | "always";

/** Why a fact is not shown: the tier lacks a scope, the machine is away, or the read failed. */
export type Unavailable =
  | { status: "needs-admin" }
  | { status: "needs-pairing" }
  | { status: "not-connected" }
  /** A node whose approvals are a host-native policy, not a file. */
  | { status: "not-a-file" }
  | { status: "failed"; message: string };

/** A paired machine as `node.list` reported it: last seen, never inferred. */
export type NodeFacts = {
  id: string;
  name: string;
  connected: boolean;
  /** `lastSeenAtMs`; while it is disconnected, the gateway's last record of it. */
  lastSeenAt: number | null;
  /** The gateway's `lastSeenReason` (`connect`, …), as given. */
  lastSeenReason: string | null;
  /** The gateway approved its commands (`approvalState: "approved"`). */
  approved: boolean;
  /** It declares both approvals commands, so its file can be read with admin. */
  approvalsCommands: boolean;
  /** `system.run` is among the commands it declares. */
  listsRun: boolean;
  /** `node.list` reports it paired (`paired: true`); a connected node can be unpaired. */
  paired: boolean;
};

/**
 * A bot's command machine as its settings store it (`tools.exec.host` and
 * `.node`, the bot's own over the gateway's for every bot). A session can
 * name another, and where a command ran is only in its own result.
 */
export type CommandPlace = {
  /** The bot's own stored values, or null when it stores none. */
  ownHost: string | null;
  ownNode: string | null;
  /** The gateway's stored values for every bot. */
  defaultHost: string | null;
  defaultNode: string | null;
  /** The stored host: the bot's own, else every bot's; null when neither is set. */
  host: string | null;
  /** The stored host is one OpenClaw 2026.10.6 accepts (`KNOWN_HOSTS`); null when none is stored. */
  hostSupported: boolean | null;
  /** The host comes from the gateway's setting for every bot. */
  inherited: boolean;
  /** The stored node: the bot's own, else every bot's (the gateway reads them so, whichever set the host). */
  nodeSelector: string | null;
  /** The node comes from the gateway's setting for every bot. */
  nodeInherited: boolean;
  /** The listed machine whose id is exactly the stored node, or null. No name is matched. */
  node: NodeFacts | null;
};

/** A tool list as stored: allow or deny, the bot's own or every bot's. */
export type ToolLists = { allow: string[] | null; deny: string[] | null };

/** What a bot's settings store about the browser. Nothing here says which browser it uses. */
export type BrowserSettings = {
  /** The bot's own `tools.allow` and `tools.deny`, and the gateway's for every bot, as stored. */
  own: ToolLists;
  everyBot: ToolLists;
  /** The gateway's own switches as stored: `browser.enabled` and the browser plugin's `enabled`. */
  gateway: { control: boolean | null; plugin: boolean | null };
  /** Clawtrate's computer plugin's entry: the profile named for this bot, and its `enabled` flag. */
  plugin: { present: boolean; enabled: boolean | null; profile: string | null };
};

export type InventoryAccount = { id: string; label: string | null; bound: boolean };
export type ToolServer = {
  name: string;
  /** A deny-list entry naming the server, as stored (`<server>__*`, its name, or `*`). */
  deniedBy: { list: "bot" | "every-bot"; entry: string } | null;
  /** Offered in the bot's latest task's listing; null when there is no listing to read. */
  offered: boolean | null;
};
/** A plugin's credential field as `plugins.credentials.inspect` described it; never its value. */
export type CredentialField = { label: string; kind: string; unresolved: boolean };
export type PluginCredentials = {
  plugin: string;
  fields: CredentialField[] | Unavailable;
  fieldsOmitted: number;
};

/**
 * Where a bot runs (section 14), in parts that are read apart, so a read that
 * hangs holds back only its own part. Each part carries the time it was read.
 */
export type PlacementParts = {
  /** `config.get` and `node.list`. */
  commands: {
    readAt: number;
    /** `config.get` `hash`, the revision this answer was read from; a save sends it back. */
    configHash: string | null;
    /** The gateway reports its active revision equal to its saved one; null when it doesn't report both. */
    configActive: boolean | null;
    commands: CommandPlace;
    /** Other bots whose stored node is the same as this bot's. */
    sameMachine: string[];
    /** The paired machines, for the choice of where its commands run. */
    nodes: NodeFacts[];
    nodesOmitted: number;
  };
  /** `agents.list`. */
  workspace: {
    readAt: number;
    /** `agents.list` `workspace`, as the gateway reports it. */
    workspace: string | null;
    /** Other bots whose reported workspace path is the same as this bot's. */
    sameWorkspace: string[];
  };
  /** `config.get`. */
  browser: { readAt: number; browser: BrowserSettings };
  /** Inventory: what its settings name. Not whether it can use each. */
  inventory: {
    readAt: number;
    accounts: InventoryAccount[] | Unavailable;
    toolServers: ToolServer[];
    /** The task whose listing `offered` comes from, and when it was read. */
    listing: { key: string; readAt: number } | null;
    secrets: string[] | Unavailable;
    /** `tools.fs.workspaceOnly` as stored, the bot's own or every bot's. */
    workspaceOnly: { value: boolean; set: "bot" | "every-bot" } | null;
  };
  /** Enabled plugins' credential fields (admin), read one field after another. */
  credentials: {
    readAt: number;
    /** Empty when the settings enable no plugin. */
    plugins: PluginCredentials[] | Unavailable;
    pluginsOmitted: number;
  };
};
export type PlacementPart = keyof PlacementParts;
export const PLACEMENT_PARTS: readonly PlacementPart[] = [
  "commands",
  "workspace",
  "browser",
  "inventory",
  "credentials",
];

export type ApprovalLevels = { security: Security | null; ask: Ask | null };

/** A machine's exec approvals file, as read with admin. Its path and socket are not kept. */
export type ApprovalsFile = {
  hash: string | null;
  exists: boolean;
  defaults: ApprovalLevels;
  /** The defaults the gateway reports it resolved, where it reports them (the gateway's machine). */
  resolved: ApprovalLevels | null;
  entries: Array<{ botId: string; levels: ApprovalLevels; allowlist: number }>;
  entriesOmitted: number;
};

export type MachineRow = {
  /** `gateway`, or the node's id. */
  id: string;
  kind: "gateway" | "node";
  name: string;
  node: NodeFacts | null;
  /** Bots whose stored host names this machine: `gateway`, or `node` with exactly this id. */
  named: string[];
  approvals: ApprovalsFile | Unavailable;
};

export type DeviceRow = {
  id: string;
  /** The operator's label when there is one, else the name the device gave. */
  name: string;
  role: string | null;
  connected: boolean;
  lastSeenAt: number | null;
  lastSeenReason: string | null;
  thisDevice: boolean;
  /** Its role, its roles and its tokens' roles are all `operator`: the gateway lets it manage its own record. */
  operatorOnly: boolean;
};

/** Settings, Machines (section 15). */
export type MachinesView = {
  readAt: number;
  machines: MachineRow[];
  nodesOmitted: number;
  devices: DeviceRow[] | Unavailable;
  devicesOmitted: number;
};

/** A machine's defaults, as the four choices of section 15. */
export type DefaultsChoice = "always" | "miss" | "allow" | "never";
export const DEFAULTS_CHOICES: readonly DefaultsChoice[] = ["always", "miss", "allow", "never"];

export const CHOICE_LEVELS: Record<DefaultsChoice, { security: Security; ask: Ask }> = {
  always: { security: "allowlist", ask: "always" },
  miss: { security: "allowlist", ask: "on-miss" },
  allow: { security: "full", ask: "off" },
  never: { security: "deny", ask: "off" },
};

/** The choice a file's levels are exactly, or null when they are none of the four (or unset). */
export function choiceOf(levels: ApprovalLevels): DefaultsChoice | null {
  for (const choice of DEFAULTS_CHOICES) {
    const want = CHOICE_LEVELS[choice];
    if (levels.security === want.security && levels.ask === want.ask) return choice;
  }
  return null;
}

/** How a save ended. Only `saved` says the gateway answered that it stored the change. */
export type ConfigSave =
  | {
      status: "saved";
      /** What `config.get` reported after the write. */
      place: CommandPlace;
      /**
       * `applied`: the read-back revision is the one this write's receipt names, and the
       * gateway reports it active. `failed`: the gateway answered that it persisted the
       * change but didn't apply it. `pending`: anything else.
       */
      active: "applied" | "pending" | "failed";
      /** The gateway's words when it answered with a persisted-change refusal, in any state. */
      message: string | null;
    }
  /** The gateway refused it, in `message`, with an answer that establishes nothing was saved. */
  | { status: "refused"; message: string }
  /**
   * Sent, with no answer that settles it: it may or may not have landed. `place` is the
   * setting read back afterwards, or null when that read failed too.
   */
  | { status: "unknown"; message: string; place: CommandPlace | null };

// Reading ---------------------------------------------------------------------------------

const cap = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);
const str = (value: unknown, max = MAX_MACHINE_NAME_CHARS): string | null =>
  typeof value === "string" && value.trim() !== "" ? cap(value, max) : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const rec = (value: unknown): RawRecord => asRecord(value) ?? {};

const security = (value: unknown): Security | null =>
  value === "deny" || value === "allowlist" || value === "full" ? value : null;
const ask = (value: unknown): Ask | null =>
  value === "off" || value === "on-miss" || value === "always" ? value : null;

export function readNode(value: unknown): NodeFacts | null {
  const row = rec(value);
  const id = str(row.nodeId);
  if (!id) return null;
  const commands = list(row.commands).filter((c): c is string => typeof c === "string");
  return {
    id,
    name: str(row.displayName) ?? id,
    connected: row.connected === true,
    lastSeenAt: num(row.lastSeenAtMs),
    lastSeenReason: str(row.lastSeenReason, MAX_SEEN_REASON_CHARS),
    approved: row.approvalState === "approved",
    approvalsCommands: NODE_APPROVALS_COMMANDS.every((c) => commands.includes(c)),
    listsRun: commands.includes("system.run"),
    paired: row.paired === true,
  };
}

/** `node.list`, at most `MAX_NODES`, paired or connected ones only. */
export function readNodes(value: unknown): { nodes: NodeFacts[]; omitted: number } {
  const all = list(rec(value).nodes)
    .filter((row) => rec(row).paired === true || rec(row).connected === true)
    .map(readNode)
    .filter((node): node is NodeFacts => node !== null);
  return { nodes: all.slice(0, MAX_NODES), omitted: Math.max(0, all.length - MAX_NODES) };
}

const entriesOf = (config: RawRecord) => rec(rec(config.agents).entries);
const entryOf = (config: RawRecord, botId: string) => rec(entriesOf(config)[botId]);
const toolsOf = (config: RawRecord) => rec(config.tools);

/** The stored command place of a bot (`tools.exec.host`, `.node`), read as the gateway reads them. */
export function readCommandPlace(
  config: RawRecord,
  botId: string,
  nodes: readonly NodeFacts[],
): CommandPlace {
  const own = rec(rec(entryOf(config, botId).tools).exec);
  const all = rec(toolsOf(config).exec);
  const ownHost = str(own.host);
  const defaultHost = str(all.host);
  const ownNode = str(own.node);
  const defaultNode = str(all.node);
  const host = ownHost ?? defaultHost;
  const nodeSelector = ownNode ?? defaultNode;
  return {
    ownHost,
    ownNode,
    defaultHost,
    defaultNode,
    host,
    hostSupported: host === null ? null : KNOWN_HOSTS.includes(host),
    inherited: ownHost === null && defaultHost !== null,
    nodeSelector,
    nodeInherited: ownNode === null && defaultNode !== null,
    node: nodeSelector === null ? null : (nodes.find((node) => node.id === nodeSelector) ?? null),
  };
}

const storedList = (value: unknown): string[] | null =>
  Array.isArray(value)
    ? value
        .map((entry) => str(entry))
        .filter((entry): entry is string => entry !== null)
        .slice(0, MAX_INVENTORY)
    : null;
const toolLists = (tools: RawRecord): ToolLists => ({
  allow: storedList(tools.allow),
  deny: storedList(tools.deny),
});

/** What a bot's settings store about the browser: the tool lists and the computer plugin's entry. */
export function readBrowserSettings(config: RawRecord, botId: string): BrowserSettings {
  const entries = rec(rec(config.plugins).entries);
  const plugin = asRecord(entries["clawtrate-computer"]);
  const flag = (value: unknown) => (typeof value === "boolean" ? value : null);
  return {
    own: toolLists(rec(entryOf(config, botId).tools)),
    everyBot: toolLists(toolsOf(config)),
    gateway: {
      control: flag(rec(config.browser).enabled),
      plugin: flag(rec(entries.browser).enabled),
    },
    plugin: {
      present: plugin !== null,
      enabled: typeof plugin?.enabled === "boolean" ? plugin.enabled : null,
      profile: str(rec(rec(rec(plugin?.config).bots)[botId]).profile),
    },
  };
}

/** A deny-list entry that names a tool server: `<server>__*`, its name, or `*`. */
function serverEntry(tools: RawRecord, server: string): string | null {
  const entry = list(tools.deny).find(
    (each) => each === `${server}__*` || each === server || each === "*",
  );
  return typeof entry === "string" ? cap(entry, MAX_MACHINE_NAME_CHARS) : null;
}

export function readToolServers(
  config: RawRecord,
  botId: string,
  listing: unknown | null,
): ToolServer[] {
  const names = Object.keys(rec(rec(config.mcp).servers)).slice(0, MAX_INVENTORY);
  // A server is offered when the listing has a tool of it, by the gateway's own server name
  // (tool ids carry a shortened one), that the session doesn't deny.
  const offered = new Set<string>();
  for (const group of list(rec(listing).groups))
    for (const tool of list(rec(group).tools)) {
      const server = rec(tool).mcpServer;
      if (typeof server === "string" && rec(tool).deniedBySession !== true) offered.add(server);
    }
  const botTools = rec(entryOf(config, botId).tools);
  return names.map((name) => {
    const own = serverEntry(botTools, name);
    const every = serverEntry(toolsOf(config), name);
    return {
      name: cap(name, MAX_MACHINE_NAME_CHARS),
      deniedBy: own
        ? { list: "bot", entry: own }
        : every
          ? { list: "every-bot", entry: every }
          : null,
      offered: listing === null ? null : offered.has(name),
    };
  });
}

/** `models.authStatus {agentId}`: the accounts the bot's view lists, and the one its model names. */
export function readInventoryAccounts(
  status: unknown,
  modelRef: string | null,
): InventoryAccount[] {
  const bound = parseModelRef(modelRef)?.account ?? null;
  const out: InventoryAccount[] = [];
  // Whole ids are compared; only the shown id is cut to length.
  const seen = new Set<string>();
  for (const provider of list(rec(status).providers))
    for (const profile of list(rec(provider).profiles)) {
      const id = rec(profile).profileId;
      if (typeof id !== "string" || id.trim() === "" || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id: cap(id, MAX_MACHINE_NAME_CHARS),
        label: str(rec(profile).displayName),
        bound: id === bound,
      });
    }
  return out.slice(0, MAX_INVENTORY);
}

/** A `models.authStatus` reply that says its status is unavailable: not an empty list. */
export function accountsUnavailable(status: unknown): Unavailable | null {
  const unavailable = asRecord(rec(status).unavailable);
  if (!unavailable) return null;
  return {
    status: "failed",
    message:
      str(unavailable.message, MAX_REASON_CHARS) ??
      str(unavailable.code, MAX_REASON_CHARS) ??
      "The gateway reports the accounts unavailable.",
  };
}

/** `secrets.store.list`: names only, never values. */
export function readSecretNames(value: unknown): string[] {
  return list(rec(value).entries)
    .map((entry) => (typeof entry === "string" ? str(entry) : str(rec(entry).name)))
    .filter((name): name is string => name !== null)
    .slice(0, MAX_INVENTORY);
}

/** The bot's model as config holds it (`agents.list` drops the account). */
export function modelRefOf(config: RawRecord, botId: string): string | null {
  const model = entryOf(config, botId).model ?? rec(rec(config.agents).defaults).model;
  return typeof model === "string" ? model : str(rec(model).primary);
}

/**
 * `exec.approvals.get` or `exec.approvals.node.get`. The path and socket are
 * not kept; entries only for the bots named (all when none are), the rest counted.
 */
export function readApprovalsFile(
  value: unknown,
  botIds: readonly string[] | null = null,
): ApprovalsFile {
  const answer = rec(value);
  const file = rec(answer.file);
  const levels = (raw: unknown): ApprovalLevels => ({
    security: security(rec(raw).security),
    ask: ask(rec(raw).ask),
  });
  const all = Object.entries(rec(file.agents));
  const agents = botIds === null ? all : all.filter(([id]) => botIds.includes(id));
  const resolved = asRecord(answer.resolvedDefaults);
  return {
    hash: str(answer.hash),
    exists: answer.exists === true,
    defaults: levels(file.defaults),
    resolved: resolved ? levels(resolved) : null,
    entries: agents.slice(0, MAX_APPROVAL_ENTRIES).map(([botId, entry]) => ({
      botId: cap(botId, MAX_MACHINE_NAME_CHARS),
      levels: levels(entry),
      allowlist: list(rec(entry).allowlist).length,
    })),
    entriesOmitted: all.length - Math.min(agents.length, MAX_APPROVAL_ENTRIES),
  };
}

/**
 * A node's snapshot that is a host-native policy (`enabled`, and when on, `defaultAction` and
 * `rules`) rather than a file (OpenClaw 2026.10.6, `ExecApprovalsNodeSnapshotSchema`).
 */
export function isNativeApprovals(value: unknown): boolean {
  const answer = rec(value);
  return asRecord(answer.file) === null && typeof answer.enabled === "boolean";
}

/** A `device.pair.list` row whose role is `operator` and whose every other role is too. */
function isOperatorOnly(r: RawRecord): boolean {
  return (
    r.role === "operator" &&
    [...list(r.roles), ...list(r.tokens).map((token) => rec(token).role)]
      .filter((role): role is string => typeof role === "string" && role.trim() !== "")
      .every((role) => role.trim() === "operator")
  );
}

/** `device.pair.list`'s paired devices. */
export function readDevices(
  value: unknown,
  ownDeviceId: string | null,
): { devices: DeviceRow[]; omitted: number } {
  const all = list(rec(value).paired)
    .map((row): DeviceRow | null => {
      const r = rec(row);
      const id = str(r.deviceId);
      if (!id) return null;
      return {
        id,
        name: str(r.operatorLabel) ?? str(r.displayName) ?? id.slice(0, 12),
        role: str(r.role),
        connected: r.connected === true,
        lastSeenAt: num(r.lastSeenAtMs),
        lastSeenReason: str(r.lastSeenReason, MAX_SEEN_REASON_CHARS),
        thisDevice: id === ownDeviceId,
        operatorOnly: isOperatorOnly(r),
      };
    })
    .filter((row): row is DeviceRow => row !== null)
    // Machines are listed above, under Machines.
    .filter((row) => row.role !== "node");
  all.sort((a, b) => Number(b.thisDevice) - Number(a.thisDevice));
  return { devices: all.slice(0, MAX_DEVICES), omitted: Math.max(0, all.length - MAX_DEVICES) };
}

/** A workspace path whole, or null: never a prefix to compare or copy. */
export function workspacePath(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_PATH_CHARS
    ? value
    : null;
}

/** `agents.list`: each bot's workspace folder as the gateway reports it. */
export function readWorkspaces(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const agent of list(rec(value).agents)) {
    const id = str(rec(agent).id);
    const workspace = workspacePath(rec(agent).workspace);
    if (id && workspace) out.set(id, workspace);
  }
  return out;
}

/** A listing whose every row names its id: only then does an absent id prove a removal. */
const wholeList = (rows: unknown, key: "nodeId" | "deviceId") =>
  Array.isArray(rows) && rows.every((row) => typeof rec(row)[key] === "string");

/** Whether a whole listing (`node.list` `nodes`, `device.pair.list` `paired`) holds an id, unbounded. */
const listsId = (rows: unknown, key: "nodeId" | "deviceId", id: string) =>
  list(rows).some((row) => rec(row)[key] === id);

// The engine ------------------------------------------------------------------------------

/** What the engine needs from the client. */
export type MachinesContext = {
  request(method: string, params: unknown): Promise<unknown>;
  connected(): boolean;
  admin(): boolean;
  pairing(): boolean;
  /** This host only reads: it changes nothing. */
  readOnly(): boolean;
  bots(): Array<{ id: string; name: string }>;
  /** A read of the bot's account status is sent now: the accounts stamp it (`statusSent`). */
  statusSent(botId: string): void;
  /** The key of a bot's most recently active task the client lists, or null. */
  latestTask(botId: string): string | null;
  deviceId(): string | null;
  now(): number;
};

const errorText = (error: unknown) =>
  cap(error instanceof Error ? error.message : String(error), MAX_REASON_CHARS);

/** A change the gateway refused or did not read back. Its message is for the person. */
export class PlacementWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlacementWriteError";
  }
}

const settle = async <T>(read: () => Promise<T>): Promise<T | Unavailable> => {
  try {
    return await read();
  } catch (error) {
    const missing = rec(rec(error).details).missingScope;
    if (missing === "operator.admin") return { status: "needs-admin" };
    if (missing === "operator.pairing") return { status: "needs-pairing" };
    return { status: "failed", message: errorText(error) };
  }
};
const isUnavailable = (value: unknown): value is Unavailable =>
  typeof rec(value).status === "string" && !("hash" in rec(value));

type ConfigRead = { config: RawRecord; hash: string | null; raw: RawRecord };

/**
 * Reads and writes for these pages. It keeps no collection: each read is
 * answered and forgotten, each write is read back before it is reported.
 */
export class MachinesEngine {
  private readonly ctx: MachinesContext;
  /** The placement parts' `config.get` while it is out: parts read together send one. */
  private sharedConfig: Promise<ConfigRead> | null = null;

  constructor(ctx: MachinesContext) {
    this.ctx = ctx;
  }

  private connectedOrThrow(): void {
    if (!this.ctx.connected()) throw new Error("Not connected to the gateway.");
  }

  private async config(): Promise<ConfigRead> {
    const raw = rec(await this.ctx.request("config.get", {}));
    // A settings file the gateway can't read or parse is answered `valid: false` with an empty
    // `config`: read as settings, that would be every setting unset.
    if (raw.valid === false)
      throw new Error(
        "The gateway reports that its settings file isn't valid, so it can't be read.",
      );
    return { config: rec(raw.config), hash: str(raw.hash, MAX_REASON_CHARS), raw };
  }

  private placementConfig(): Promise<ConfigRead> {
    if (this.sharedConfig) return this.sharedConfig;
    const read = this.config().finally(() => {
      if (this.sharedConfig === read) this.sharedConfig = null;
    });
    this.sharedConfig = read;
    return read;
  }

  /** Section 14, one part for one bot. Admin reads are asked only of an admin connection. */
  async readPlacement<P extends PlacementPart>(botId: string, part: P): Promise<PlacementParts[P]> {
    this.connectedOrThrow();
    const parts: { [K in PlacementPart]: () => Promise<PlacementParts[K]> } = {
      commands: () => this.readCommandsPart(botId),
      workspace: () => this.readWorkspacePart(botId),
      browser: async () => {
        const { config } = await this.placementConfig();
        return { readAt: this.ctx.now(), browser: readBrowserSettings(config, botId) };
      },
      inventory: () => this.readInventoryPart(botId),
      credentials: () => this.readCredentialsPart(),
    };
    return parts[part]();
  }

  private async readCommandsPart(botId: string): Promise<PlacementParts["commands"]> {
    const { ctx } = this;
    const [{ config, hash, raw }, { nodes, omitted }] = await Promise.all([
      this.placementConfig(),
      ctx.request("node.list", {}).then(readNodes),
    ]);
    const commands = readCommandPlace(config, botId, nodes);
    return {
      readAt: ctx.now(),
      configHash: hash,
      configActive:
        typeof raw.appliedConfigHash === "string" && typeof raw.configRevisionHash === "string"
          ? raw.appliedConfigHash === raw.configRevisionHash
          : null,
      commands,
      sameMachine:
        commands.host === "node" && commands.nodeSelector !== null
          ? ctx
              .bots()
              .filter((bot) => {
                if (bot.id === botId) return false;
                const place = readCommandPlace(config, bot.id, nodes);
                return place.host === "node" && place.nodeSelector === commands.nodeSelector;
              })
              .map((bot) => bot.id)
          : [],
      nodes,
      nodesOmitted: omitted,
    };
  }

  private async readWorkspacePart(botId: string): Promise<PlacementParts["workspace"]> {
    const { ctx } = this;
    const workspaces = readWorkspaces(await ctx.request("agents.list", {}));
    // The requested bot's from the gateway's own list, even before the client lists its bots.
    const workspace = workspaces.get(botId) ?? null;
    return {
      readAt: ctx.now(),
      workspace,
      sameWorkspace:
        workspace === null
          ? []
          : ctx
              .bots()
              .filter((bot) => bot.id !== botId && workspaces.get(bot.id) === workspace)
              .map((bot) => bot.id),
    };
  }

  private async readInventoryPart(botId: string): Promise<PlacementParts["inventory"]> {
    const { ctx } = this;
    const latest = ctx.latestTask(botId);
    const [{ config }, status, listing, secrets] = await Promise.all([
      this.placementConfig(),
      settle(() => {
        ctx.statusSent(botId);
        return ctx.request("models.authStatus", { agentId: botId });
      }),
      latest
        ? ctx.request("tools.effective", { sessionKey: latest }).then(
            (value) => ({ key: latest, value, readAt: ctx.now() }),
            () => null,
          )
        : Promise.resolve(null),
      ctx.admin()
        ? settle(() => ctx.request("secrets.store.list", {}).then(readSecretNames))
        : Promise.resolve<Unavailable>({ status: "needs-admin" }),
    ]);
    const fsOnly = (tools: RawRecord) => rec(tools.fs).workspaceOnly;
    const ownOnly = fsOnly(rec(entryOf(config, botId).tools));
    const allOnly = fsOnly(toolsOf(config));
    return {
      readAt: ctx.now(),
      accounts: isUnavailable(status)
        ? status
        : (accountsUnavailable(status) ?? readInventoryAccounts(status, modelRefOf(config, botId))),
      toolServers: readToolServers(config, botId, listing?.value ?? null),
      listing: listing ? { key: listing.key, readAt: listing.readAt } : null,
      secrets,
      workspaceOnly:
        typeof ownOnly === "boolean"
          ? { value: ownOnly, set: "bot" }
          : typeof allOnly === "boolean"
            ? { value: allOnly, set: "every-bot" }
            : null,
    };
  }

  /**
   * Each enabled plugin's credential fields (admin): the fields it declares from
   * `plugins.inspect {pluginId}`, then each one's kind from
   * `plugins.credentials.inspect {pluginId, path, baseHash}`, which answers one
   * `credential`. A plugin whose read fails is unavailable, never empty.
   */
  private async readCredentialsPart(): Promise<PlacementParts["credentials"]> {
    if (!this.ctx.admin())
      return { readAt: this.ctx.now(), plugins: { status: "needs-admin" }, pluginsOmitted: 0 };
    const { config, hash: baseHash } = await this.placementConfig();
    const ids = Object.entries(rec(rec(config.plugins).entries))
      .filter(([, entry]) => rec(entry).enabled !== false)
      .map(([id]) => id);
    const out: PluginCredentials[] = [];
    for (const plugin of ids.slice(0, MAX_PLUGINS)) {
      const name = cap(plugin, MAX_MACHINE_NAME_CHARS);
      try {
        if (!baseHash) throw new Error("The gateway reported no configuration hash.");
        const declared = rec(
          await this.ctx.request("plugins.inspect", { pluginId: plugin }),
        ).credentials;
        if (!Array.isArray(declared) || declared.some((field) => !Array.isArray(rec(field).path)))
          throw new Error("The gateway did not report credential fields.");
        const fields: CredentialField[] = [];
        for (const field of declared.slice(0, MAX_PLUGIN_FIELDS)) {
          const answer = rec(
            await this.ctx.request("plugins.credentials.inspect", {
              pluginId: plugin,
              path: rec(field).path,
              baseHash,
            }),
          );
          const credential = rec(answer.credential);
          const kind = str(credential.kind, MAX_SEEN_REASON_CHARS);
          if (!kind) throw new Error("The gateway's answer named no credential.");
          fields.push({
            label: str(rec(field).label) ?? "A field",
            kind,
            unresolved: credential.unresolved === true,
          });
        }
        out.push({
          plugin: name,
          fields,
          fieldsOmitted: Math.max(0, declared.length - MAX_PLUGIN_FIELDS),
        });
      } catch (error) {
        out.push({
          plugin: name,
          fields: { status: "failed", message: errorText(error) },
          fieldsOmitted: 0,
        });
      }
    }
    return {
      readAt: this.ctx.now(),
      plugins: out,
      pluginsOmitted: Math.max(0, ids.length - MAX_PLUGINS),
    };
  }

  /** Section 15. Approvals files with admin; paired devices with the pairing scope. */
  async readMachines(): Promise<MachinesView> {
    this.connectedOrThrow();
    const { ctx } = this;
    const admin = ctx.admin();
    const [{ config }, { nodes, omitted }] = await Promise.all([
      this.config(),
      ctx.request("node.list", {}).then(readNodes),
    ]);
    const bots = ctx.bots();
    const botIds = bots.map((bot) => bot.id);
    const places = new Map(bots.map((bot) => [bot.id, readCommandPlace(config, bot.id, nodes)]));
    const named = (match: (place: CommandPlace) => boolean) =>
      bots.filter((bot) => match(places.get(bot.id)!)).map((bot) => bot.id);
    const needsAdmin = { status: "needs-admin" } as const;
    const gatewayFile = admin
      ? await settle(() =>
          ctx.request("exec.approvals.get", {}).then((v) => readApprovalsFile(v, botIds)),
        )
      : needsAdmin;
    const machines: MachineRow[] = [
      {
        id: "gateway",
        kind: "gateway",
        name: "The gateway's machine",
        node: null,
        named: named((place) => place.host === "gateway"),
        approvals: gatewayFile,
      },
    ];
    for (const node of nodes) {
      const approvals: ApprovalsFile | Unavailable = !admin
        ? needsAdmin
        : !node.connected
          ? { status: "not-connected" }
          : !node.approvalsCommands
            ? { status: "failed", message: "This machine doesn't offer its approvals file." }
            : await settle(() =>
                ctx
                  .request("exec.approvals.node.get", { nodeId: node.id })
                  .then((v) =>
                    isNativeApprovals(v)
                      ? ({ status: "not-a-file" } as const)
                      : readApprovalsFile(v, botIds),
                  ),
              );
      machines.push({
        id: node.id,
        kind: "node",
        name: node.name,
        node,
        named: named((place) => place.host === "node" && place.nodeSelector === node.id),
        approvals,
      });
    }
    const pairing = ctx.pairing();
    const deviceList = pairing
      ? await settle(() =>
          ctx.request("device.pair.list", {}).then((v) => readDevices(v, ctx.deviceId())),
        )
      : ({ status: "needs-pairing" } as const);
    return {
      readAt: ctx.now(),
      machines,
      nodesOmitted: omitted,
      devices: "status" in deviceList ? deviceList : deviceList.devices,
      devicesOmitted: "status" in deviceList ? 0 : deviceList.omitted,
    };
  }

  private requireWrite(scope: "admin" | "pairing", what: string): void {
    // A read sent before a write, or while it is out, can answer from before it. The shared read is
    // dropped when a write starts and again when a settings write settles, so a read after asks again.
    this.sharedConfig = null;
    this.connectedOrThrow();
    if (this.ctx.readOnly())
      throw new PlacementWriteError("This host only reads; it changes nothing.");
    const held = scope === "admin" ? this.ctx.admin() : this.ctx.pairing();
    if (!held)
      throw new PlacementWriteError(
        `${what} needs ${scope === "admin" ? "admin" : "device"} access.`,
      );
  }

  /** The gateway's own words for a refusal, for the person. */
  private refused(what: string, error: unknown): PlacementWriteError {
    return new PlacementWriteError(
      `Couldn't save ${what}. The gateway answered: ${errorText(error)}`,
    );
  }

  /**
   * Set where a bot's commands run: `agents.entries.<bot>.tools.exec.host` and
   * `.node` in one `config.patch` with the revision the page showed
   * (`baseHash`), then read back by `config.get`. Answers what was stored and
   * whether the gateway reports it active; throws unless the stored setting agrees.
   * A refusal is answered in the gateway's words; a save no answer settles is
   * answered with what reading the setting back shows, never as saved.
   */
  async setCommandMachine(
    botId: string,
    target: { host: "gateway" } | { host: "node"; nodeId: string },
    baseHash: string | null,
  ): Promise<ConfigSave> {
    this.requireWrite("admin", "Changing where a bot runs");
    const exec =
      target.host === "node"
        ? { host: "node", node: target.nodeId }
        : { host: "gateway", node: null };
    const readBack = async () => {
      const [read, { nodes }] = await Promise.all([
        this.config(),
        // The list only names the machine; without it the stored id is shown, and the save stands.
        this.ctx.request("node.list", {}).then(readNodes, () => ({ nodes: [], omitted: 0 })),
      ]);
      return { ...read, place: readCommandPlace(read.config, botId, nodes) };
    };
    // The revision this write saved: from its receipt, or from the saved config a refusal carries.
    let savedHash: string | null;
    let message: string | null = null;
    try {
      const receipt = await this.ctx
        .request("config.patch", {
          raw: JSON.stringify({ agents: { entries: { [botId]: { tools: { exec } } } } }),
          ...(baseHash ? { baseHash } : {}),
        })
        .finally(() => {
          this.sharedConfig = null;
        });
      savedHash = str(rec(receipt).hash, MAX_REASON_CHARS);
    } catch (error) {
      // The gateway can persist a change and not apply it; it says so with the saved config.
      const persisted = asRecord(rec(rec(error).details).persistedConfig);
      if (persisted === null) {
        if (isCertainRefusal(error)) return { status: "refused", message: errorText(error) };
        // A lost reply, or an answer the gateway can give after writing the file.
        const place = await readBack().then(
          (read) => read.place,
          () => null,
        );
        return { status: "unknown", message: errorText(error), place };
      }
      savedHash = str(persisted.hash, MAX_REASON_CHARS);
      message = errorText(error);
    }
    const { hash, raw, place } = await readBack();
    const agrees =
      place.ownHost === target.host &&
      (target.host === "node" ? place.ownNode === target.nodeId : place.ownNode === null);
    if (!agrees)
      throw new PlacementWriteError(
        "The gateway answered, but reading it back shows another setting. Nothing is shown as saved.",
      );
    const active =
      savedHash !== null &&
      hash === savedHash &&
      typeof raw.appliedConfigHash === "string" &&
      raw.appliedConfigHash === raw.configRevisionHash
        ? "applied"
        : message?.startsWith("config.patch persisted but was not applied to the active Gateway")
          ? "failed"
          : "pending";
    return { status: "saved", place, active, message };
  }

  /**
   * `agents.update {agentId, workspace}` (admin) with the path as typed: the
   * gateway resolves it on its own machine and refuses what it can't use. Then
   * `agents.list` reads what it now reports. The method has no base revision,
   * and the gateway may create the folder and its files before it answers, so a
   * refusal is reported as an unclear outcome with what the gateway reports now.
   */
  async setWorkspace(
    botId: string,
    path: string,
  ): Promise<{ workspace: string | null; asTyped: boolean }> {
    this.requireWrite("admin", "Changing a bot's workspace");
    if (path === "") throw new PlacementWriteError("Enter a path.");
    const reported = async () =>
      workspacePath(
        rec(
          list(rec(await this.ctx.request("agents.list", {})).agents).find(
            (agent) => rec(agent).id === botId,
          ),
        ).workspace,
      );
    try {
      await this.ctx.request("agents.update", { agentId: botId, workspace: path }).finally(() => {
        this.sharedConfig = null;
      });
    } catch (error) {
      const now = await reported().catch(() => null);
      throw new PlacementWriteError(
        `The gateway answered: ${errorText(error).replace(/\.$/, "")}. It may have created the folder or files before answering. ` +
          (now === null
            ? "The current workspace could not be confirmed."
            : `The gateway now lists the workspace as ${now}.`),
      );
    }
    const workspace = await reported().catch(() => null);
    return { workspace, asTyped: workspace === path };
  }

  /**
   * A machine's defaults: its whole file read again, the hash compared with the
   * one the person saw, the defaults replaced and the file written with that hash
   * (`exec.approvals.set`, or `.node.set` for a node), then read back.
   */
  async setMachineDefaults(
    machineId: string,
    choice: DefaultsChoice,
    expectedHash: string | null,
    beforeSend: () => void = () => {},
  ): Promise<ApprovalsFile> {
    this.requireWrite("admin", "Setting a machine's approvals");
    const node = machineId === "gateway" ? null : machineId;
    const get = () =>
      this.ctx.request(
        node ? "exec.approvals.node.get" : "exec.approvals.get",
        node ? { nodeId: node } : {},
      );
    const current = rec(await get());
    // A file payload sent to a host that keeps a native policy would ask it for something else.
    if (isNativeApprovals(current))
      throw new PlacementWriteError(
        "This machine's approvals aren't kept in a file, so they can't be changed here.",
      );
    const hash = str(current.hash);
    // The revision the page showed, even none: a file that has one since was changed by someone else.
    if (hash !== expectedHash)
      throw new PlacementWriteError(
        "This file changed since it was read. It has been read again; choose again.",
      );
    const { socket: _socket, ...file } = rec(current.file);
    const next = { ...file, defaults: { ...rec(file.defaults), ...CHOICE_LEVELS[choice] } };
    // Whoever asked may have gone while the file was read: then nothing is sent.
    beforeSend();
    try {
      await this.ctx.request(node ? "exec.approvals.node.set" : "exec.approvals.set", {
        ...(node ? { nodeId: node } : {}),
        file: next,
        ...(hash ? { baseHash: hash } : {}),
      });
    } catch (error) {
      throw this.refused("the machine's approvals", error);
    }
    const after = readApprovalsFile(await get());
    if (choiceOf(after.defaults) !== choice)
      throw new PlacementWriteError(
        "The machine took the change, but reading its file back shows other defaults. Nothing is shown as saved.",
      );
    return after;
  }

  // Names and removals. The gateway lets a connection that signs in with its device token
  // manage another device's record, a node's included, only with admin; with device access
  // alone, only its own device's record (OpenClaw 2026.10.6, device-management-authz).

  /** `node.rename` (admin: a node is another device), read back from `node.list`. */
  async renameMachine(nodeId: string, name: string): Promise<void> {
    this.requireWrite("admin", "Renaming a machine");
    const label = name.trim();
    if (label === "" || label.length > MAX_MACHINE_NAME_CHARS)
      throw new PlacementWriteError("Enter a name.");
    try {
      await this.ctx.request("node.rename", { nodeId, displayName: label });
    } catch (error) {
      throw this.refused("the name", error);
    }
    // Found by id in the whole list: the shown list's bound must not hide it.
    const rows = list(rec(await this.ctx.request("node.list", {})).nodes);
    if (readNode(rows.find((row) => rec(row).nodeId === nodeId))?.name !== label)
      throw new PlacementWriteError(
        "The gateway reads back another name. Nothing is shown as saved.",
      );
  }

  /** `node.pair.remove` (admin), done when the whole `node.list` read back no longer has the id. */
  async removeMachine(nodeId: string): Promise<void> {
    this.requireWrite("admin", "Removing a machine");
    try {
      await this.ctx.request("node.pair.remove", { nodeId });
    } catch (error) {
      throw this.refused("the removal", error);
    }
    const again = rec(await this.ctx.request("node.list", {}));
    if (!wholeList(again.nodes, "nodeId"))
      throw new PlacementWriteError(
        "The gateway did not return the pairing list. Removal could not be confirmed.",
      );
    if (listsId(again.nodes, "nodeId", nodeId))
      throw new PlacementWriteError("The gateway still lists this machine.");
  }

  /** `device.pair.rename`: this device's own name with device access, another's with admin. */
  async renameDevice(
    deviceId: string,
    name: string,
    beforeSend: () => void = () => {},
  ): Promise<void> {
    const own = deviceId === this.ctx.deviceId();
    this.requireWrite(own ? "pairing" : "admin", "Renaming a device");
    const label = name.trim();
    if (label === "" || label.length > MAX_MACHINE_NAME_CHARS)
      throw new PlacementWriteError("Enter a name.");
    if (own && !this.ctx.admin()) {
      // Below admin the gateway lets this device rename only an operator-only record.
      const rows = list(rec(await this.ctx.request("device.pair.list", {})).paired);
      if (!isOperatorOnly(rec(rows.find((each) => rec(each).deviceId === deviceId))))
        throw new PlacementWriteError("Renaming this device needs admin access.");
    }
    beforeSend();
    try {
      await this.ctx.request("device.pair.rename", { deviceId, label });
    } catch (error) {
      throw this.refused("the name", error);
    }
    const paired = list(rec(await this.ctx.request("device.pair.list", {})).paired);
    const row = rec(paired.find((each) => rec(each).deviceId === deviceId));
    if ((str(row.operatorLabel) ?? str(row.displayName)) !== label)
      throw new PlacementWriteError(
        "The gateway reads back another name. Nothing is shown as saved.",
      );
  }

  /** `device.pair.remove` (admin), never this device; done when the whole listing lacks the id. */
  async removeDevice(deviceId: string): Promise<void> {
    if (deviceId === this.ctx.deviceId())
      throw new PlacementWriteError("This device can't remove itself here.");
    this.requireWrite("admin", "Removing a device");
    try {
      await this.ctx.request("device.pair.remove", { deviceId });
    } catch (error) {
      throw this.refused("the removal", error);
    }
    const again = rec(await this.ctx.request("device.pair.list", {}));
    if (!wholeList(again.paired, "deviceId"))
      throw new PlacementWriteError(
        "The gateway did not return the pairing list. Removal could not be confirmed.",
      );
    if (listsId(again.paired, "deviceId", deviceId))
      throw new PlacementWriteError("The gateway still lists this device.");
  }
}
