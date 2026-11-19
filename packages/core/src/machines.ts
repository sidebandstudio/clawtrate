// Where a bot runs and the gateway's machines (docs/design/controls.md,
// sections 14 and 15). Read now and not kept: every answer carries the time it
// was read, and the engine retains nothing between reads (nothing here is in
// `ClawtrateState` or in a collection of the client). What each method of
// OpenClaw 2026.10.6 returned on a development instance is in
// `docs/decisions.md` ("Where a bot runs and Machines").
//
// Four facts stay apart: what a bot is configured to use (its own setting, or
// the gateway's for every bot, which it inherits), what a machine reported when
// last seen, what the gateway combines, and what is unavailable at this tier.
// A command's machine, a bot's workspace and its browser are three settings;
// none is inferred from another.

import { parseModelRef } from "./accounts.ts";
import { asRecord, type RawRecord } from "./mapping.ts";

/** Paired machines kept in one answer; past it, `nodesOmitted` counts the rest. */
export const MAX_NODES = 16;
/** Paired devices kept in one answer. */
export const MAX_DEVICES = 32;
/** Names of the gateway's secret store, of tool servers, of accounts, of plugin sign-ins. */
export const MAX_INVENTORY = 32;
/** Per-bot entries of an approvals file shown: only those of listed bots, at most the bot count. */
export const MAX_APPROVAL_ENTRIES = 32;
/** A name, a label, an id. */
export const MAX_MACHINE_NAME_CHARS = 128;
/** A last-seen reason (`connect`, …). */
export const MAX_SEEN_REASON_CHARS = 64;
/** A path the gateway reports or a person types. */
export const MAX_PATH_CHARS = 1024;
/** A reason or an error. */
export const MAX_REASON_CHARS = 512;

/** The commands a node declares that let Clawtrate read and set its approvals file. */
export const NODE_APPROVALS_COMMANDS = ["system.execApprovals.get", "system.execApprovals.set"];

export type ExecHost = "auto" | "sandbox" | "gateway" | "node";
export type Security = "deny" | "allowlist" | "full";
export type Ask = "off" | "on-miss" | "always";

/** Why a fact is not shown: the tier lacks a scope, the machine is away, or the read failed. */
export type Unavailable =
  | { status: "needs-admin" }
  | { status: "needs-pairing" }
  | { status: "not-connected" }
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
  /** It declares `system.run`: a command can run there. */
  runsCommands: boolean;
};

/** A bot's command placement, as configured. Where a command ran is only in its own result. */
export type CommandPlace = {
  /** The bot's own `tools.exec.host` and `.node`, or null when it sets none. */
  ownHost: ExecHost | null;
  ownNode: string | null;
  /** The gateway's `tools.exec.host` and `.node` for every bot. */
  defaultHost: ExecHost | null;
  defaultNode: string | null;
  /** The configured host: the bot's own, else the default, else the gateway's `auto`. */
  host: ExecHost;
  /** True when the bot sets no host of its own and inherits it. */
  inherited: boolean;
  /** The node it names (id, name or address), when the host is `node`. */
  nodeSelector: string | null;
  /** That node as `node.list` names it; null when none matches or none is named. */
  node: NodeFacts | null;
  /** A sandbox is configured for this bot (`auto` then resolves to it). */
  sandbox: boolean;
};

export type BrowserPlace =
  /** Clawtrate's computer plugin gives the bot a profile of its own on the gateway's machine. */
  | { kind: "own"; profile: string; pluginEnabled: boolean }
  /** The gateway's default browser, shared by every bot that uses the browser. */
  | { kind: "shared" }
  /** The gateway's settings deny the browser to this bot or to every bot. */
  | { kind: "denied"; by: "bot" | "every-bot" };

export type InventoryAccount = { id: string; label: string | null; bound: boolean };
export type ToolServer = {
  name: string;
  /** Denied by the bot's own deny list or the gateway's for every bot; null when neither names it. */
  denied: "bot" | "every-bot" | null;
  /** Offered in the bot's latest task's listing; null when there is no listing to read. */
  offered: boolean | null;
};

/** Where a bot runs (section 14). */
export type BotPlacement = {
  botId: string;
  readAt: number;
  commands: CommandPlace;
  /** `agents.list` `workspace`: the configured folder of its file tools, on the gateway's machine. */
  workspace: string | null;
  browser: BrowserPlace;
  /** Other bots set to the same paired machine, the same workspace folder, or the shared browser. */
  sharedWith: { machine: string[]; workspace: string[]; browser: string[] };
  /** Inventory: what its settings name. Not whether it can use each. */
  inventory: {
    accounts: InventoryAccount[] | Unavailable;
    toolServers: ToolServer[];
    /** The task whose listing `offered` comes from, and when it was read. */
    listing: { key: string; readAt: number } | null;
    secrets: string[] | Unavailable;
    pluginSignIns: Array<{ plugin: string; names: string[] }> | Unavailable;
    /** `tools.fs.workspaceOnly`, for the bot or every bot. */
    workspaceOnly: boolean | null;
  };
  /** The paired machines, for the choice of where its commands run. */
  nodes: NodeFacts[];
  nodesOmitted: number;
};

/** A bot's command policy as the gateway resolves it from its settings (`tools.exec`). */
export type ExecPolicy = {
  /** The mode named, or null for a legacy `security`/`ask` pair or no policy at all. */
  mode: string | null;
  security: Security;
  ask: Ask;
  autoReview: boolean;
  /** Set by the bot's own entry rather than inherited. */
  own: boolean;
  /** Set with the legacy `security`/`ask` pair. */
  legacy: boolean;
  /** No policy anywhere: the gateway runs commands without asking. */
  none: boolean;
};

export type ApprovalLevels = { security: Security | null; ask: Ask | null };

/** A machine's exec approvals file, as read with admin. Its path and socket are not kept. */
export type ApprovalsFile = {
  hash: string | null;
  exists: boolean;
  defaults: ApprovalLevels;
  /** The gateway's own resolution of the defaults, where it reports one (the gateway's machine). */
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
  /** Bots configured to run commands here. */
  botsHere: string[];
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
};

/** Settings, Machines (section 15). */
export type MachinesView = {
  readAt: number;
  machines: MachineRow[];
  nodesOmitted: number;
  devices: DeviceRow[] | Unavailable;
  devicesOmitted: number;
  /** Each bot's command policy, for the effective result on each machine. */
  policies: Array<{ botId: string; policy: ExecPolicy }>;
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

/** The choice a file's levels are, or null when they are none of the four (or unset). */
export function choiceOf(levels: ApprovalLevels): DefaultsChoice | null {
  for (const choice of DEFAULTS_CHOICES) {
    const want = CHOICE_LEVELS[choice];
    if (levels.security === want.security && levels.ask === want.ask) return choice;
  }
  if (levels.security === "deny") return "never";
  return null;
}

// Reading ---------------------------------------------------------------------------------

const cap = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);
const str = (value: unknown, max = MAX_MACHINE_NAME_CHARS): string | null =>
  typeof value === "string" && value.trim() !== "" ? cap(value, max) : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const rec = (value: unknown): RawRecord => asRecord(value) ?? {};

const HOSTS: readonly ExecHost[] = ["auto", "sandbox", "gateway", "node"];
const host = (value: unknown): ExecHost | null =>
  HOSTS.includes(value as ExecHost) ? (value as ExecHost) : null;
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
    runsCommands: commands.includes("system.run"),
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

/** The node an `exec.node` selector names: by id, then by name (the gateway also takes an address). */
export function matchNode(nodes: readonly NodeFacts[], selector: string | null): NodeFacts | null {
  if (!selector) return null;
  return (
    nodes.find((node) => node.id === selector) ??
    nodes.find((node) => node.name === selector) ??
    null
  );
}

const entriesOf = (config: RawRecord) => rec(rec(config.agents).entries);
const entryOf = (config: RawRecord, botId: string) => rec(entriesOf(config)[botId]);
const toolsOf = (config: RawRecord) => rec(config.tools);

/** The configured command place of a bot (`tools.exec.host`, `.node`). */
export function readCommandPlace(
  config: RawRecord,
  botId: string,
  nodes: readonly NodeFacts[],
): CommandPlace {
  const own = rec(rec(entryOf(config, botId).tools).exec);
  const all = rec(toolsOf(config).exec);
  const ownHost = host(own.host);
  const defaultHost = host(all.host);
  const ownNode = str(own.node);
  const defaultNode = str(all.node);
  const configured = ownHost ?? defaultHost ?? "auto";
  const nodeSelector = configured === "node" ? (ownHost ? ownNode : defaultNode) : null;
  const sandboxMode =
    str(rec(entryOf(config, botId).sandbox).mode) ??
    str(rec(rec(rec(config.agents).defaults).sandbox).mode);
  return {
    ownHost,
    ownNode,
    defaultHost,
    defaultNode,
    host: configured,
    inherited: ownHost === null,
    nodeSelector,
    node: configured === "node" ? matchNode(nodes, nodeSelector) : null,
    sandbox: sandboxMode !== null && sandboxMode !== "off",
  };
}

const denies = (tools: RawRecord, name: string) =>
  list(tools.deny).some((entry) => entry === name || entry === "*");
const allowListExcludes = (tools: RawRecord, name: string) => {
  const allow = list(tools.allow);
  return allow.length > 0 && !allow.some((entry) => entry === name || entry === "*");
};

/** The browser a bot's settings give it. */
export function readBrowserPlace(config: RawRecord, botId: string): BrowserPlace {
  const botTools = rec(entryOf(config, botId).tools);
  const allTools = toolsOf(config);
  if (denies(allTools, "browser") || allowListExcludes(allTools, "browser"))
    return { kind: "denied", by: "every-bot" };
  if (denies(botTools, "browser") || allowListExcludes(botTools, "browser"))
    return { kind: "denied", by: "bot" };
  const plugin = rec(rec(rec(config.plugins).entries)["clawtrate-computer"]);
  const profile = str(rec(rec(rec(plugin.config).bots)[botId]).profile);
  if (profile) return { kind: "own", profile, pluginEnabled: plugin.enabled !== false };
  return { kind: "shared" };
}

/** A tool server is denied by name or by its `<server>__*` pattern. */
function serverDenied(tools: RawRecord, server: string): boolean {
  return list(tools.deny).some(
    (entry) => entry === `${server}__*` || entry === server || entry === "*",
  );
}

export function readToolServers(
  config: RawRecord,
  botId: string,
  listing: unknown | null,
): ToolServer[] {
  const names = Object.keys(rec(rec(config.mcp).servers)).slice(0, MAX_INVENTORY);
  const offered = new Set<string>();
  for (const group of list(rec(listing).groups))
    for (const tool of list(rec(group).tools)) {
      const id = str(rec(tool).id);
      if (id) offered.add(id);
    }
  const botTools = rec(entryOf(config, botId).tools);
  return names.map((name) => ({
    name: cap(name, MAX_MACHINE_NAME_CHARS),
    denied: serverDenied(toolsOf(config), name)
      ? "every-bot"
      : serverDenied(botTools, name)
        ? "bot"
        : null,
    offered: listing === null ? null : [...offered].some((id) => id.startsWith(`${name}__`)),
  }));
}

/** `models.authStatus {agentId}`: the accounts the bot's view lists, and the one its model names. */
export function readInventoryAccounts(
  status: unknown,
  modelRef: string | null,
): InventoryAccount[] {
  const bound = parseModelRef(modelRef)?.account ?? null;
  const out: InventoryAccount[] = [];
  for (const provider of list(rec(status).providers))
    for (const profile of list(rec(provider).profiles)) {
      const id = str(rec(profile).profileId);
      if (!id || out.some((each) => each.id === id)) continue;
      out.push({ id, label: str(rec(profile).displayName), bound: id === bound });
    }
  return out.slice(0, MAX_INVENTORY);
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

/** A bot's command policy, layered as the gateway layers it (`applyExecPolicyLayer`). */
export function readExecPolicy(config: RawRecord, botId: string): ExecPolicy {
  const all = rec(toolsOf(config).exec);
  const own = rec(rec(entryOf(config, botId).tools).exec);
  const layers = [all, own];
  let mode: string | null = null;
  let sec: Security | null = null;
  let asked: Ask | null = null;
  let ownSet = false;
  let legacy = false;
  for (const [index, layer] of layers.entries()) {
    const named = str(layer.mode);
    if (named) {
      mode = named;
      sec = null;
      asked = null;
      legacy = false;
      if (index === 1) ownSet = true;
    } else if (layer.security !== undefined || layer.ask !== undefined) {
      mode = null;
      sec = security(layer.security) ?? sec;
      asked = ask(layer.ask) ?? asked;
      legacy = true;
      if (index === 1) ownSet = true;
    }
  }
  const byMode = MODE_POLICIES[mode ?? ""];
  if (byMode) return { mode, ...byMode, own: ownSet, legacy: false, none: false };
  return {
    mode: null,
    security: sec ?? "full",
    ask: asked ?? "off",
    autoReview: false,
    own: ownSet,
    legacy,
    none: !legacy,
  };
}

/** `resolveExecPolicyForMode` in OpenClaw 2026.10.6. */
const MODE_POLICIES: Record<string, { security: Security; ask: Ask; autoReview: boolean }> = {
  deny: { security: "deny", ask: "off", autoReview: false },
  allowlist: { security: "allowlist", ask: "off", autoReview: false },
  ask: { security: "allowlist", ask: "on-miss", autoReview: false },
  auto: { security: "allowlist", ask: "on-miss", autoReview: true },
  full: { security: "full", ask: "off", autoReview: false },
};

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

/** A file's levels for one bot: its entry over the defaults, over full and off (`resolveExecApprovalsFromFile`). */
export function fileLevelsFor(
  file: ApprovalsFile,
  botId: string,
): { security: Security; ask: Ask } {
  const entry = file.entries.find((each) => each.botId === botId)?.levels;
  return {
    security: entry?.security ?? file.defaults.security ?? "full",
    ask: entry?.ask ?? file.defaults.ask ?? "off",
  };
}

const SECURITY_ORDER: Security[] = ["deny", "allowlist", "full"];
const ASK_ORDER: Ask[] = ["off", "on-miss", "always"];
const stricter = (a: Security, b: Security) =>
  SECURITY_ORDER[Math.min(SECURITY_ORDER.indexOf(a), SECURITY_ORDER.indexOf(b))]!;
const moreAsking = (a: Ask, b: Ask) =>
  ASK_ORDER[Math.max(ASK_ORDER.indexOf(a), ASK_ORDER.indexOf(b))]!;

/**
 * The gateway's combination for a bot's next command (OpenClaw 2026.10.6,
 * `bash-tools` exec): the stricter security and the more asking ask of the
 * bot's policy and each approvals file that applies, and the reviewer only
 * when no file raised the ask. A command sent to a node meets the gateway
 * machine's file there and the node's own file when the node runs it.
 */
export function combinePosture(
  policy: ExecPolicy,
  files: ReadonlyArray<{ security: Security; ask: Ask }>,
): { security: Security; ask: Ask; autoReview: boolean; raisedBy: number | null } {
  let sec = policy.security;
  let asked = policy.ask;
  let raisedBy: number | null = null;
  files.forEach((file, index) => {
    sec = stricter(sec, file.security);
    const next = moreAsking(asked, file.ask);
    if (next !== asked) raisedBy = index;
    asked = next;
  });
  return {
    security: sec,
    ask: asked,
    autoReview: policy.autoReview && asked === policy.ask,
    raisedBy,
  };
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
      };
    })
    .filter((row): row is DeviceRow => row !== null)
    // Machines are listed above, under Machines.
    .filter((row) => row.role !== "node");
  all.sort((a, b) => Number(b.thisDevice) - Number(a.thisDevice));
  return { devices: all.slice(0, MAX_DEVICES), omitted: Math.max(0, all.length - MAX_DEVICES) };
}

/** `agents.list`: each bot's configured workspace folder. */
export function readWorkspaces(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const agent of list(rec(value).agents)) {
    const id = str(rec(agent).id);
    const workspace = str(rec(agent).workspace, MAX_PATH_CHARS);
    if (id && workspace) out.set(id, workspace);
  }
  return out;
}

/** Why a typed workspace path is not accepted, or null. */
export function workspaceProblem(path: string): string | null {
  if (path.trim() !== path || path === "")
    return "Enter a full path, with no spaces at either end.";
  if (!path.startsWith("/")) return "Enter a full path on the gateway's machine, starting with /.";
  if (path.length > MAX_PATH_CHARS) return `Enter a path of at most ${MAX_PATH_CHARS} characters.`;
  if ([...path].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f))
    return "A path can't hold control characters.";
  if (path.split("/").includes("..")) return "Enter a path without '..'.";
  return null;
}

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

/**
 * Reads and writes for these pages. It keeps no collection: each read is
 * answered and forgotten, each write is read back before it is reported.
 */
export class MachinesEngine {
  private readonly ctx: MachinesContext;

  constructor(ctx: MachinesContext) {
    this.ctx = ctx;
  }

  private connectedOrThrow(): void {
    if (!this.ctx.connected()) throw new Error("Not connected to the gateway.");
  }

  private async config(): Promise<{ config: RawRecord; hash: string | null; raw: RawRecord }> {
    const raw = rec(await this.ctx.request("config.get", {}));
    return { config: rec(raw.config), hash: str(raw.hash), raw };
  }

  /** Section 14, for one bot. Admin reads are asked only of an admin connection. */
  async readPlacement(botId: string): Promise<BotPlacement> {
    this.connectedOrThrow();
    const { ctx } = this;
    const admin = ctx.admin();
    const latest = ctx.latestTask(botId);
    const [{ config }, workspaces, nodeList, status, listing, secrets] = await Promise.all([
      this.config(),
      ctx.request("agents.list", {}).then(readWorkspaces),
      ctx.request("node.list", {}).then(readNodes),
      settle(() => ctx.request("models.authStatus", { agentId: botId })),
      latest
        ? ctx.request("tools.effective", { sessionKey: latest }).then(
            (value) => ({ key: latest, value, readAt: ctx.now() }),
            () => null,
          )
        : Promise.resolve(null),
      admin
        ? settle(() => ctx.request("secrets.store.list", {}).then(readSecretNames))
        : Promise.resolve<Unavailable>({ status: "needs-admin" }),
    ]);
    const pluginSignIns = admin
      ? await settle(() => this.readPluginSignIns(config))
      : ({ status: "needs-admin" } as const);
    const { nodes, omitted } = nodeList;
    const bots = ctx.bots().map((bot) => ({ ...bot, workspace: workspaces.get(bot.id) ?? null }));
    const commands = readCommandPlace(config, botId, nodes);
    const browser = readBrowserPlace(config, botId);
    const workspace = bots.find((bot) => bot.id === botId)?.workspace ?? null;
    const others = bots.filter((bot) => bot.id !== botId);
    const sharedWith = {
      machine:
        commands.node === null
          ? []
          : others
              .filter(
                (bot) => readCommandPlace(config, bot.id, nodes).node?.id === commands.node!.id,
              )
              .map((bot) => bot.id),
      workspace:
        workspace === null
          ? []
          : others.filter((bot) => bot.workspace === workspace).map((bot) => bot.id),
      browser:
        browser.kind !== "shared"
          ? []
          : others
              .filter((bot) => readBrowserPlace(config, bot.id).kind === "shared")
              .map((bot) => bot.id),
    };
    const fs = (tools: RawRecord) => rec(tools.fs).workspaceOnly;
    const workspaceOnly = fs(rec(entryOf(config, botId).tools)) ?? fs(toolsOf(config));
    return {
      botId,
      readAt: ctx.now(),
      commands,
      workspace: workspace === null ? null : cap(workspace, MAX_PATH_CHARS),
      browser,
      sharedWith,
      inventory: {
        accounts: isUnavailable(status)
          ? status
          : readInventoryAccounts(status, modelRefOf(config, botId)),
        toolServers: readToolServers(config, botId, listing?.value ?? null),
        listing: listing ? { key: listing.key, readAt: listing.readAt } : null,
        secrets,
        pluginSignIns,
        workspaceOnly: typeof workspaceOnly === "boolean" ? workspaceOnly : null,
      },
      nodes,
      nodesOmitted: omitted,
    };
  }

  /** Each enabled plugin's sign-ins by name (`plugins.credentials.inspect {pluginId}`, admin). */
  private async readPluginSignIns(
    config: RawRecord,
  ): Promise<Array<{ plugin: string; names: string[] }>> {
    const ids = Object.entries(rec(rec(config.plugins).entries))
      .filter(([, entry]) => rec(entry).enabled !== false)
      .map(([id]) => id)
      .slice(0, MAX_INVENTORY);
    const out: Array<{ plugin: string; names: string[] }> = [];
    for (const plugin of ids) {
      const answer = await this.ctx
        .request("plugins.credentials.inspect", { pluginId: plugin })
        .catch(() => null);
      const names = list(rec(answer).credentials ?? rec(answer).entries)
        .map((entry) =>
          typeof entry === "string" ? str(entry) : (str(rec(entry).name) ?? str(rec(entry).id)),
        )
        .filter((name): name is string => name !== null)
        .slice(0, MAX_INVENTORY);
      if (names.length > 0) out.push({ plugin: cap(plugin, MAX_MACHINE_NAME_CHARS), names });
    }
    return out;
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
    const here = (match: (place: CommandPlace) => boolean) =>
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
        botsHere: here(
          (place) => place.host === "gateway" || (place.host === "auto" && !place.sandbox),
        ),
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
                  .then((v) => readApprovalsFile(v, botIds)),
              );
      machines.push({
        id: node.id,
        kind: "node",
        name: node.name,
        node,
        botsHere: here((place) => place.host === "node" && place.node?.id === node.id),
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
      policies: bots.map((bot) => ({ botId: bot.id, policy: readExecPolicy(config, bot.id) })),
    };
  }

  private requireWrite(scope: "admin" | "pairing", what: string): void {
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
   * `.node` in one `config.patch` with the config's hash, then read back by
   * `config.get`. Answers the place read back; throws unless it agrees.
   */
  async setCommandMachine(
    botId: string,
    target: { host: "gateway" } | { host: "node"; nodeId: string },
  ): Promise<CommandPlace> {
    this.requireWrite("admin", "Changing where a bot runs");
    const before = await this.config();
    const exec =
      target.host === "node"
        ? { host: "node", node: target.nodeId }
        : { host: "gateway", node: null };
    try {
      await this.ctx.request("config.patch", {
        raw: JSON.stringify({ agents: { entries: { [botId]: { tools: { exec } } } } }),
        ...(before.hash ? { baseHash: before.hash } : {}),
      });
    } catch (error) {
      throw this.refused("where its commands run", error);
    }
    const { nodes } = readNodes(await this.ctx.request("node.list", {}));
    const after = readCommandPlace((await this.waitApplied(before.raw)).config, botId, nodes);
    const agrees =
      after.ownHost === target.host &&
      (target.host === "node" ? after.ownNode === target.nodeId : after.ownNode === null);
    if (!agrees)
      throw new PlacementWriteError(
        "The gateway took the change, but reading it back shows another setting. Nothing is shown as saved.",
      );
    return after;
  }

  /** `config.get` until the gateway reports the new revision applied (as the accounts engine waits). */
  private async waitApplied(before: RawRecord): Promise<{ config: RawRecord }> {
    const started = this.ctx.now();
    for (let reads = 0; reads < 100 && this.ctx.now() - started < 20_000; reads += 1) {
      const now = await this.config();
      if (before.configRevisionHash === undefined) return now;
      const revised = now.raw.configRevisionHash !== before.configRevisionHash;
      if (revised && now.raw.appliedConfigHash === now.raw.configRevisionHash) return now;
      if (!revised && (this.ctx.now() - started > 3_000 || reads >= 15)) return now;
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 200));
    }
    return this.config();
  }

  /** `agents.update {agentId, workspace}` (admin), then `agents.list` reads it back. */
  async setWorkspace(botId: string, path: string): Promise<string> {
    this.requireWrite("admin", "Changing a bot's workspace");
    const problem = workspaceProblem(path);
    if (problem) throw new PlacementWriteError(problem);
    try {
      await this.ctx.request("agents.update", { agentId: botId, workspace: path });
    } catch (error) {
      throw this.refused("the workspace", error);
    }
    const agents = list(rec(await this.ctx.request("agents.list", {})).agents);
    const read = str(
      rec(agents.find((agent) => rec(agent).id === botId)).workspace,
      MAX_PATH_CHARS,
    );
    if (read !== path)
      throw new PlacementWriteError(
        `The gateway took the change, but reads the folder back as ${read ?? "none"}. Nothing is shown as saved.`,
      );
    return read;
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
  ): Promise<ApprovalsFile> {
    this.requireWrite("admin", "Setting a machine's approvals");
    const node = machineId === "gateway" ? null : machineId;
    const get = () =>
      this.ctx.request(
        node ? "exec.approvals.node.get" : "exec.approvals.get",
        node ? { nodeId: node } : {},
      );
    const current = rec(await get());
    const hash = str(current.hash);
    if (expectedHash !== null && hash !== expectedHash)
      throw new PlacementWriteError(
        "This file changed since it was read. It has been read again; choose again.",
      );
    const { socket: _socket, ...file } = rec(current.file);
    const next = { ...file, defaults: { ...rec(file.defaults), ...CHOICE_LEVELS[choice] } };
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

  /** `node.rename` (pairing), read back from `node.list`. */
  async renameMachine(nodeId: string, name: string): Promise<void> {
    this.requireWrite("pairing", "Renaming a machine");
    const label = name.trim();
    if (label === "" || label.length > MAX_MACHINE_NAME_CHARS)
      throw new PlacementWriteError("Enter a name.");
    try {
      await this.ctx.request("node.rename", { nodeId, displayName: label });
    } catch (error) {
      throw this.refused("the name", error);
    }
    const { nodes } = readNodes(await this.ctx.request("node.list", {}));
    if (nodes.find((node) => node.id === nodeId)?.name !== label)
      throw new PlacementWriteError(
        "The gateway reads back another name. Nothing is shown as saved.",
      );
  }

  /** `node.pair.remove` (pairing), only for a machine not connected; read back from `node.list`. */
  async removeMachine(nodeId: string): Promise<void> {
    this.requireWrite("pairing", "Removing a machine");
    const { nodes } = readNodes(await this.ctx.request("node.list", {}));
    const node = nodes.find((each) => each.id === nodeId);
    if (node?.connected)
      throw new PlacementWriteError(
        "This machine is connected. Only a machine not connected is removed.",
      );
    try {
      await this.ctx.request("node.pair.remove", { nodeId });
    } catch (error) {
      throw this.refused("the removal", error);
    }
    const again = readNodes(await this.ctx.request("node.list", {})).nodes;
    if (again.some((each) => each.id === nodeId))
      throw new PlacementWriteError("The gateway still lists this machine.");
  }

  /** `device.pair.rename` (pairing), read back from `device.pair.list`. */
  async renameDevice(deviceId: string, name: string): Promise<void> {
    this.requireWrite("pairing", "Renaming a device");
    const label = name.trim();
    if (label === "" || label.length > MAX_MACHINE_NAME_CHARS)
      throw new PlacementWriteError("Enter a name.");
    try {
      await this.ctx.request("device.pair.rename", { deviceId, label });
    } catch (error) {
      throw this.refused("the name", error);
    }
    const { devices } = readDevices(await this.ctx.request("device.pair.list", {}), null);
    if (devices.find((device) => device.id === deviceId)?.name !== label)
      throw new PlacementWriteError(
        "The gateway reads back another name. Nothing is shown as saved.",
      );
  }

  /** `device.pair.remove` (pairing), never this device; read back from `device.pair.list`. */
  async removeDevice(deviceId: string): Promise<void> {
    this.requireWrite("pairing", "Removing a device");
    if (deviceId === this.ctx.deviceId())
      throw new PlacementWriteError("This device can't remove itself here.");
    try {
      await this.ctx.request("device.pair.remove", { deviceId });
    } catch (error) {
      throw this.refused("the removal", error);
    }
    const { devices } = readDevices(await this.ctx.request("device.pair.list", {}), null);
    if (devices.some((device) => device.id === deviceId))
      throw new PlacementWriteError("The gateway still lists this device.");
  }
}
