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
export type CreatedIdentity = { botId: string; name: string; workspace: string | null };

/**
 * The confirmed reply of `agents.create`: `ok`, the `agentId` it made and the
 * name it gave. Anything less is not a reply that settles what was made.
 */
export function readCreateReply(value: unknown): CreatedIdentity | null {
  const reply = asRecord(value);
  if (!reply || reply.ok !== true) return null;
  const botId = typeof reply.agentId === "string" && reply.agentId ? reply.agentId : null;
  const name = typeof reply.name === "string" && reply.name ? reply.name : null;
  if (!botId || !name) return null;
  return {
    botId,
    name,
    workspace: typeof reply.workspace === "string" && reply.workspace ? reply.workspace : null,
  };
}

/**
 * Why a read of the config does not let the next write go to the bot Create
 * returned, or null when it does: the entry is there and carries the name and
 * workspace Create answered with.
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
  if (made.workspace && workspace && workspace !== made.workspace) return "changed";
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

/** The session list's parameters for `main`: complete, with nothing filtered out. */
export const MAIN_SESSIONS_PARAMS = { agentId: "main", archived: "all", limit: 1 } as const;

/**
 * The first-bot reading from three successful reads: `agents.list`,
 * `config.get` and the unfiltered `sessions.list` for `main`. Anything that
 * doesn't affirm an unused implicit `main` is the normal roster.
 */
export function readFirstBot(list: unknown, config: unknown, sessions: unknown): FirstBotState {
  const roster: FirstBotState = { status: "roster", mainPolicy: null };
  const main = implicitMain(list);
  if (!main) return roster;
  const settings = asRecord(asRecord(config)?.config);
  if (!settings) return roster;
  const agents = settings.agents;
  if (agents !== undefined) {
    const record = asRecord(agents);
    if (!record || Object.hasOwn(record, "entries") || Object.hasOwn(record, "list")) return roster;
  }
  const page = asRecord(sessions);
  if (!page || !Array.isArray(page.sessions) || page.sessions.length > 0) return roster;
  if (page.hasMore === true || typeof page.nextOffset === "number") return roster;
  return { status: "prompt", mainPolicy: readReportedPolicy(main.defaultPermissionMode) };
}

// What a new bot's writes left (controls.md section 10) ------------------------------------

/**
 * The command setting of the bot Create last made, as read: kept until its
 * first message is sent. Its composer stays closed until `status` is
 * `confirmed`.
 */
export type NewBotPolicy = {
  botId: string;
  name: string;
  chosen: CommandChoice;
  /**
   * `checking`: a write or its read-back is under way. `confirmed`: the saved
   * mode reads back as chosen. `unconfirmed`: step 3 didn't read back as
   * chosen. `restrictive`: step 2 didn't read back, and nothing was sent to it.
   */
  status: "checking" | "confirmed" | "unconfirmed" | "restrictive";
  /** Step 2 read back as written; until then nothing is sent to the bot. */
  restrictive: boolean;
  /** The saved `tools.exec.mode` an exact read returned, or null when none was read. */
  saved: string | null;
  /** The reported default policy; null when the read had none for the bot. */
  reported: ReportedPolicy | null;
  /** `agents.list` was read after step 3. */
  reportedRead: boolean;
  /** A fresh read still identified the bot and gave a hash: "Write it again" may be offered. */
  retryable: boolean;
};
