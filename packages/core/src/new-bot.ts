// A new bot's command choice and the first-bot prompt (docs/design/bots.md
// section 3, docs/design/controls.md section 10): what the writes after
// `agents.create` contain, how a read of the config identifies the bot Create
// returned, what the gateway's approvals file settles before Create, and the
// reads that make a gateway one whose only agent is an unused implicit `main`.
// Everything here reads what the gateway answered; nothing here sends.

import { asRecord, type RawRecord } from "./mapping.ts";

/** What the person chose in New bot's Approvals step: `tools.exec.mode` for that bot. */
export type CommandChoice = "ask" | "full";
export const COMMAND_CHOICES: readonly CommandChoice[] = ["ask", "full"];

/** The gateway's reported default command policy for a bot (`agents.list` `defaultPermissionMode`). */
export type ReportedPolicy = "read-only" | "guarded" | "workspace" | "full";
const REPORTED: readonly ReportedPolicy[] = ["read-only", "guarded", "workspace", "full"];

export function readReportedPolicy(value: unknown): ReportedPolicy | null {
  return REPORTED.includes(value as ReportedPolicy) ? (value as ReportedPolicy) : null;
}

/**
 * The reported label as a fact read from one bot's `agents.list` row: one
 * Clawtrate knows, `none` when the row has no label, `unrecognized` when it has
 * one Clawtrate has no words for. An absent label is not an unknown one.
 */
export type ReportedLabel = ReportedPolicy | "none" | "unrecognized";

export function readReportedLabel(row: RawRecord): ReportedLabel {
  if (!Object.hasOwn(row, "defaultPermissionMode") || row.defaultPermissionMode === undefined)
    return "none";
  return readReportedPolicy(row.defaultPermissionMode) ?? "unrecognized";
}

/** The tools step 2 and step 3 deny by name, whatever was chosen (controls.md section 10). */
const KEPT_DENIED = ["gateway", "plugins"] as const;
/** T3 Code's tools, denied by the pattern of `bots.md` section 20, row 27. */
export const T3_CODE_DENY = "t3code__*";
/** The most tool servers step 2 names; past it the patch stops, as a list cut short is no Never. */
export const MAX_TOOL_SERVERS = 64;

/**
 * Step 2's deny list: the named tools, and `<server>__*` for every tool
 * server the config names, T3 Code's always. Null when the servers can't all
 * be named, so step 2 is not written.
 */
export function restrictiveDeny(config: RawRecord | null): string[] | null {
  const servers = asRecord(asRecord(config?.mcp)?.servers);
  const names = servers ? Object.keys(servers) : [];
  if (names.length > MAX_TOOL_SERVERS) return null;
  const patterns = names.filter((name) => /^[A-Za-z0-9_.-]+$/.test(name)).map((n) => `${n}__*`);
  if (patterns.length !== names.length) return null;
  return [
    ...KEPT_DENIED,
    "automations",
    "browser",
    "message",
    ...new Set([T3_CODE_DENY, ...patterns]),
  ];
}

/** Step 3's deny list, the same for both choices. */
export const FINAL_DENY: readonly string[] = [...KEPT_DENIED, T3_CODE_DENY];

/** The config's bot entry, as `config.get` answers it. */
export function configEntry(config: RawRecord | null, botId: string): RawRecord | null {
  const entries = asRecord(asRecord(config?.agents)?.entries);
  return entries && Object.hasOwn(entries, botId) ? asRecord(entries[botId]) : null;
}

/** What `agents.create` answered: the bot it made, and what names it. */
export type CreatedIdentity = { botId: string; name: string; workspace: string };

/** The longest bot id kept from a reply: the gateway makes ids of at most 64. */
export const MAX_CREATED_ID_CHARS = 64;
/** The longest name kept from a reply. */
export const MAX_CREATED_NAME_CHARS = 256;
/** The longest workspace path kept from a reply. */
export const MAX_CREATED_WORKSPACE_CHARS = 4096;
const CREATED_ID = /^[a-z0-9_-]{1,64}$/i;

/** One identity field as the gateway answered it, or null when it is missing or out of bounds. */
const identityText = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 && JSON.stringify(value).length <= max + 2
    ? value
    : null;

/** A bot's identity, as a reply or a kept record gives it, or null when any part fails its bounds. */
export function readIdentity(value: unknown): CreatedIdentity | null {
  const record = asRecord(value);
  const botId = identityText(record?.botId, MAX_CREATED_ID_CHARS);
  const name = identityText(record?.name, MAX_CREATED_NAME_CHARS);
  const workspace = identityText(record?.workspace, MAX_CREATED_WORKSPACE_CHARS);
  if (!botId || !CREATED_ID.test(botId) || !name || !workspace) return null;
  return { botId, name, workspace };
}

/**
 * The confirmed reply of `agents.create`: `ok`, the `agentId` it made, the
 * name it gave and the workspace it made, each within its bound. Anything less
 * is not a reply that settles what was made, and nothing follows it.
 */
export function readCreateReply(value: unknown): CreatedIdentity | null {
  const reply = asRecord(value);
  if (!reply || reply.ok !== true) return null;
  return readIdentity({ botId: reply.agentId, name: reply.name, workspace: reply.workspace });
}

/**
 * Why a read of the config does not let the next write go to the bot Create
 * returned, or null when it does: the entry is there and carries the name and
 * the workspace Create answered with. An entry without a workspace does not
 * identify the bot.
 */
export function entryProblem(
  config: RawRecord | null,
  made: CreatedIdentity,
): "gone" | "changed" | null {
  const entry = configEntry(config, made.botId);
  if (!entry) return "gone";
  const name = typeof entry.name === "string" ? entry.name : null;
  if (name !== made.name) return "changed";
  const workspace = typeof entry.workspace === "string" ? entry.workspace : null;
  if (workspace !== made.workspace) return "changed";
  return null;
}

const sameList = (value: unknown, expected: readonly string[]) =>
  Array.isArray(value) &&
  value.length === expected.length &&
  value.every((each, index) => each === expected[index]);

/** The entry's `tools.exec.mode` as read, or null when there is none a mode could be. */
export function savedMode(entry: RawRecord | null): string | null {
  const mode = asRecord(asRecord(entry?.tools)?.exec)?.mode;
  return typeof mode === "string" && /^[a-z-]{1,32}$/.test(mode) ? mode : null;
}

/** Step 2 reads back as written: Never, the restrictive deny list, and the model with no fallbacks. */
export function restrictiveReadBack(
  entry: RawRecord | null,
  deny: readonly string[],
  primary: string,
): boolean {
  const model = asRecord(entry?.model);
  return (
    savedMode(entry) === "deny" &&
    sameList(asRecord(entry?.tools)?.deny, deny) &&
    model?.primary === primary &&
    sameList(model?.fallbacks, [])
  );
}

/** Step 3 reads back as written: the chosen mode and the final deny list. */
export function chosenReadBack(entry: RawRecord | null, chosen: CommandChoice): boolean {
  return savedMode(entry) === chosen && sameList(asRecord(entry?.tools)?.deny, FINAL_DENY);
}

/**
 * Whether the gateway's approvals file, as `exec.approvals.get` answers it,
 * blocks commands for a bot of this id: its `defaults` deny, and no entry
 * that applies to the bot says otherwise. Absent, unreadable or unsettled is
 * false, and only the general line is shown. Only these fields are read: the
 * file also carries its socket's token, which goes nowhere.
 */
export function approvalsFileBlocks(snapshot: unknown, botId: string | null): boolean {
  const record = asRecord(snapshot);
  if (!record || record.exists !== true) return false;
  const file = asRecord(record.file);
  if (asRecord(file?.defaults)?.security !== "deny") return false;
  const agents = asRecord(file?.agents) ?? {};
  for (const [id, value] of Object.entries(agents)) {
    if (id !== "*" && id !== botId) continue;
    const security = asRecord(value)?.security;
    if (security !== undefined && security !== "deny") return false;
  }
  return true;
}

/** The id the gateway gives a bot of this name, as `agents.create` makes it (lowercase, dashes). */
export function likelyBotId(name: string): string | null {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return id || null;
}

// The first bot (bots.md section 3, "The first bot") ---------------------------------------

/**
 * `prompt`: successful reads show a gateway whose only agent is an unused
 * implicit `main`, and the app opens on "Make your first bot". `roster`: the
 * normal roster, for every other result, failed and inconclusive ones too.
 * `unknown`: not read yet.
 */
export type FirstBotState = {
  status: "unknown" | "prompt" | "roster";
  /** What the gateway reports for that `main` (`defaultPermissionMode`), or null. */
  mainPolicy: ReportedPolicy | null;
};
export const initialFirstBot: FirstBotState = { status: "unknown", mainPolicy: null };

/** The `main` of a gateway with no roster, from `agents.list` alone, or null when it isn't one. */
export function implicitMain(list: unknown): RawRecord | null {
  const record = asRecord(list);
  if (!record || record.defaultId !== "main" || !Array.isArray(record.agents)) return null;
  const visible = record.agents.map(asRecord).filter((agent) => agent?.kind !== "system");
  if (visible.length !== 1) return null;
  const main = visible[0];
  if (!main || main.id !== "main") return null;
  if (main.name !== undefined || asRecord(main.identity)?.name !== undefined) return null;
  if (main.status !== undefined || main.admissionRefusal !== undefined) return null;
  return main;
}

/**
 * The session list's parameters for `main`: complete, with nothing filtered
 * out, the global and unknown keys the gateway leaves out by default included.
 */
export const MAIN_SESSIONS_PARAMS = {
  agentId: "main",
  archived: "all",
  includeGlobal: true,
  includeUnknown: true,
  limit: 1,
} as const;

/**
 * A session list that proves `main` has no tasks: no rows, and the counts and
 * paging say there are none past them. A page without that evidence proves
 * nothing.
 */
function provesNoTasks(page: RawRecord | null): boolean {
  if (!page || !Array.isArray(page.sessions) || page.sessions.length > 0) return false;
  if (page.hasMore !== false && page.hasMore !== undefined) return false;
  if (page.nextOffset !== undefined && page.nextOffset !== null) return false;
  if (page.totalCount !== undefined) return page.totalCount === 0;
  return page.count === 0 && page.hasMore === false;
}

/**
 * The first-bot reading from three successful reads: `agents.list`, a valid
 * `config.get` and the unfiltered, complete `sessions.list` for `main`.
 * Anything that doesn't affirm an unused implicit `main` is the normal roster.
 */
export function readFirstBot(list: unknown, config: unknown, sessions: unknown): FirstBotState {
  const roster: FirstBotState = { status: "roster", mainPolicy: null };
  const main = implicitMain(list);
  if (!main) return roster;
  if (asRecord(config)?.valid !== true) return roster;
  const settings = asRecord(asRecord(config)?.config);
  if (!settings) return roster;
  const agents = settings.agents;
  if (agents !== undefined) {
    const record = asRecord(agents);
    if (!record || Object.hasOwn(record, "entries") || Object.hasOwn(record, "list")) return roster;
  }
  if (!provesNoTasks(asRecord(sessions))) return roster;
  return { status: "prompt", mainPolicy: readReportedPolicy(main.defaultPermissionMode) };
}

// What a new bot's writes left (controls.md section 10) ------------------------------------

/** Unfinished new bots the host keeps, across every gateway, until each reads back as chosen. */
export const MAX_HELD_BOTS = 8;
/** New bots' notes shown for the current gateway: every held one, then confirmed ones. */
export const MAX_POLICY_NOTES = MAX_HELD_BOTS;

/**
 * A new bot's command setting, as read: shown in its first task until its
 * first message is sent. Its composer stays closed until `status` is
 * `confirmed`. Both facts are what the latest reads returned; a change of
 * connection clears them until they are read again.
 */
export type NewBotPolicy = {
  botId: string;
  name: string;
  /** The workspace Create answered with: with the name, what identifies the bot in a read. */
  workspace: string;
  chosen: CommandChoice;
  /**
   * `checking`: a write or a read is under way. `confirmed`: the saved mode
   * reads back as chosen. `unconfirmed`: step 3 didn't read back as chosen, or
   * a later read shows another mode. `restrictive`: step 2 didn't read back,
   * and nothing was sent to it.
   */
  status: "checking" | "confirmed" | "unconfirmed" | "restrictive";
  /** Step 2 read back as written; until then nothing is sent to the bot. */
  restrictive: boolean;
  /** The saved `tools.exec.mode` the latest exact read returned, or null when none was read. */
  saved: string | null;
  /**
   * The reported default policy from the `agents.list` read after the latest
   * read of the saved setting; null until that read.
   */
  reported: ReportedLabel | null;
  /**
   * "Write it again" may be offered: the latest read identified the bot and
   * the config has not changed since Clawtrate last identified it.
   */
  retryable: boolean;
};

/**
 * What the host keeps of an unfinished new bot, for its gateway, until its
 * saved setting reads back as chosen or the bot can no longer be identified:
 * the composer's hold and "Write it again" are rebuilt from it after a
 * restart. `seen` is the config's hash when Clawtrate last identified the
 * bot: a later write goes only while the config still has it.
 */
export type HeldBot = {
  gatewayId: string | null;
  gatewayUrl: string;
  made: CreatedIdentity;
  chosen: CommandChoice;
  primary: string;
  effort: string | null;
  restrictive: boolean;
  taskMade: boolean;
  seen: string | null;
};

/** The longest gateway address or id a held record keeps. */
export const MAX_HELD_GATEWAY_CHARS = 2048;
/** The longest model reference or effort a held record keeps. */
export const MAX_HELD_MODEL_CHARS = 512;
/** The longest config hash a held record keeps. */
export const MAX_HELD_HASH_CHARS = 256;
/** A held record's largest JSON length. */
export const HELD_BOT_CHARS =
  2 * MAX_HELD_GATEWAY_CHARS +
  MAX_CREATED_ID_CHARS +
  MAX_CREATED_NAME_CHARS +
  MAX_CREATED_WORKSPACE_CHARS +
  2 * MAX_HELD_MODEL_CHARS +
  MAX_HELD_HASH_CHARS +
  256;

/** A held record as kept, or null when any field fails its bound. */
export function readHeldBot(value: unknown): HeldBot | null {
  const record = asRecord(value);
  if (!record) return null;
  const made = readIdentity(record.made);
  const gatewayUrl = identityText(record.gatewayUrl, MAX_HELD_GATEWAY_CHARS);
  const gatewayId =
    record.gatewayId === null ? null : identityText(record.gatewayId, MAX_HELD_GATEWAY_CHARS);
  const primary = identityText(record.primary, MAX_HELD_MODEL_CHARS);
  const effort = record.effort === null ? null : identityText(record.effort, MAX_HELD_MODEL_CHARS);
  const seen = record.seen === null ? null : identityText(record.seen, MAX_HELD_HASH_CHARS);
  if (
    !made ||
    !gatewayUrl ||
    (record.gatewayId !== null && !gatewayId) ||
    !COMMAND_CHOICES.includes(record.chosen as CommandChoice) ||
    !primary ||
    (record.effort !== null && !effort) ||
    (record.seen !== null && !seen) ||
    typeof record.restrictive !== "boolean" ||
    typeof record.taskMade !== "boolean"
  )
    return null;
  return {
    gatewayId,
    gatewayUrl,
    made,
    chosen: record.chosen as CommandChoice,
    primary,
    effort,
    restrictive: record.restrictive,
    taskMade: record.taskMade,
    seen,
  };
}

/** Whether a held record belongs to the gateway now connected: its id when both are known, else its address. */
export function sameGateway(
  held: Pick<HeldBot, "gatewayId" | "gatewayUrl">,
  gateway: { id: string | null; url: string },
): boolean {
  if (held.gatewayId !== null && gateway.id !== null) return held.gatewayId === gateway.id;
  return held.gatewayUrl === gateway.url;
}
