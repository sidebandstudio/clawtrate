// Settings, Permissions (docs/design/controls.md sections 7 to 9): the rules
// plugin's state, the standing approvals the gateway keeps and lists, and the
// tool actions its audit log holds, with what a record made with each call says
// caused it. Every read here is an answer, read again each time and kept
// nowhere: the engine holds no list of grants, entries or activity, and no
// history of its own. Each answer is bounded where it enters (the counts and
// lengths below), so the largest one fits the web host's result frame.
//
// What the gateway established on a development instance (OpenClaw 2026.10.6):
// a routine's grant is listed by `exec.approval.grants.list` (approvals scope)
// with its times and use count, and stays listed once revoked; revoking answers
// `revoked`, `already-revoked` or `not-found`. A machine's allowlist is in the
// approvals file `exec.approvals.get` reads (admin), written whole with its hash.
// The audit log (`audit.activity.list`, read) names a call by a SHA-256 of its id
// and no rule or grant; the rules plugin's decision record shares that id and the
// run's. Approval history carries no run or call, so nothing joins it to a call.

import { sha256Hex, utf8Bytes } from "./bytes.ts";
import { asRecord } from "./mapping.ts";

/** The rules plugin's id and the version its decision record and status need. */
export const RULES_PLUGIN = "clawtrate-tool-rules";
export const RULES_PLUGIN_MIN_VERSION = "1.0.0";
export const RULES_STATUS_METHOD = `${RULES_PLUGIN}.status`;

/** Grants one read lists: the gateway's own limit is 500; past this many `more` is true. */
export const MAX_GRANTS_LISTED = 80;
/** Allowlist entries one read lists, over every bot of the gateway's machine. */
export const MAX_ALLOWLIST_LISTED = 60;
/** Tool-action records one Activity page reads (the gateway allows 500). */
export const ACTIVITY_PAGE_RECORDS = 50;
/** An audit or decision record's id, run, call or task, kept whole up to this length or not at all. */
export const MAX_ACTIVITY_ID = 256;
/** A rule's tools named in a cause, at most this many. */
export const MAX_CAUSE_TOOLS = 4;
/** Decision records read for one run of the page; past them its calls' causes are not read. */
export const DECISIONS_PER_RUN = 100;
/** Runs whose decision records are read at once. */
export const DECISION_READS_AT_ONCE = 4;
/** Any text kept from a gateway answer, cut to this many characters. */
export const MAX_PERMISSION_TEXT = 512;
/** An allowlist entry's argument pattern or saved command text, cut to this many characters. */
export const MAX_ENTRY_DETAIL = 256;
/** A tool's name or a bot's id, cut to this many characters. */
export const MAX_PERMISSION_NAME = 128;

const cut = (value: unknown, max = MAX_PERMISSION_TEXT): string | null =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
/** An id kept whole or not at all: a cut id could name another record. */
const wholeId = (value: unknown, max = MAX_PERMISSION_TEXT): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
const time = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, MAX_PERMISSION_TEXT);
const missingScope = (error: unknown): string | null => {
  const details = asRecord(asRecord(error)?.details);
  return typeof details?.missingScope === "string" ? details.missingScope : null;
};

export type PermissionsContext = {
  request: (method: string, params: unknown) => Promise<unknown>;
  now: () => number;
};

// The rules plugin's state (section 2) --------------------------------------------------

/**
 * What `clawtrate-tool-rules.status` established, as the design's states:
 * `unavailable` when the hello did not list its methods; `stopped` when they are
 * listed and status failed, or said its hook is not registered or nothing is
 * enforced; `old` below the version the decision record needs; else `running`,
 * with what it enforces for the next call (`enforcing`, apart from the hook).
 */
export type RulesPluginState =
  | { state: "unavailable" }
  | { state: "stopped"; reason: string }
  | { state: "old"; version: string }
  | {
      state: "running";
      answeredAt: number;
      lastCallAt: number | null;
      enforcing: "rules" | "kept-copy" | "ask-every-call" | "nothing";
      /** When the copy still enforced was read, while the rules file is lost. */
      keptCopyReadAt: number | null;
    };

function versionAtLeast(version: string, min: string): boolean {
  const parts = (text: string) =>
    text
      .split(/[.-]/)
      .slice(0, 3)
      .map((each) => Number(each) || 0);
  const [a, b] = [parts(version), parts(min)];
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

export async function readRulesPlugin(
  ctx: PermissionsContext,
  listed: boolean,
): Promise<RulesPluginState> {
  if (!listed) return { state: "unavailable" };
  let answer: Record<string, unknown> | null;
  try {
    answer = asRecord(await ctx.request(RULES_STATUS_METHOD, {}));
  } catch (error) {
    return { state: "stopped", reason: errorText(error) };
  }
  const version = typeof answer?.version === "string" ? answer.version.slice(0, 32) : "";
  if (!version) return { state: "stopped", reason: "Its status named no version." };
  if (!versionAtLeast(version, RULES_PLUGIN_MIN_VERSION)) return { state: "old", version };
  const hook = asRecord(answer?.hook);
  const enforcing = answer?.enforcing;
  if (hook?.registered !== true || enforcing === "not-enforced") {
    return { state: "stopped", reason: "Its hook is not registered." };
  }
  const rules = asRecord(answer?.rules);
  return {
    state: "running",
    answeredAt: ctx.now(),
    lastCallAt: time(hook.lastCallAt),
    enforcing:
      enforcing === "rules" || enforcing === "kept-copy" || enforcing === "ask-every-call"
        ? enforcing
        : "nothing",
    keptCopyReadAt: rules?.state === "lost" ? time(rules.keptCopyReadAt) : null,
  };
}

// Saved approvals (section 8) -------------------------------------------------------------

/** A routine's grant as `exec.approval.grants.list` gives it. */
export type RoutineGrant = {
  grantId: string;
  agentId: string;
  routineId: string;
  /** Null once the routine is gone; the gateway keeps the grant listed. */
  routineName: string | null;
  /** The exact command and folder it is bound to, as the gateway displays them. */
  command: string;
  cwd: string | null;
  createdAtMs: number;
  /** Null: until revoked or the routine changes. */
  expiresAtMs: number | null;
  revokedAtMs: number | null;
  lastUsedAtMs: number | null;
  useCount: number;
};

/** One entry of a machine's allowlist, in the approvals file's own terms. */
export type AllowlistEntry = {
  agentId: string;
  /** The entry's id in the file; null when it has none (then it cannot be removed here). */
  entryId: string | null;
  kind: "command" | "tool";
  /** A command entry's pattern, or a tool entry's `<server>__<tool>`. */
  pattern: string;
  argPattern: string | null;
  commandText: string | null;
  fromAlwaysAllow: boolean;
  lastUsedAt: number | null;
  /** When it was added, where the file records it (tool entries do; command entries don't). */
  addedAt: number | null;
};

export type SavedApprovals = {
  readAt: number;
  grants:
    | { status: "ready"; items: RoutineGrant[]; more: boolean }
    | { status: "needs-approvals" }
    | { status: "failed"; message: string };
  /** The gateway's own machine's approvals file. Paired machines' files are not read here. */
  allowlist:
    | { status: "ready"; items: AllowlistEntry[]; omitted: number; hash: string | null }
    | { status: "needs-admin" }
    | { status: "failed"; message: string };
};

function readGrant(value: unknown): RoutineGrant | null {
  const raw = asRecord(value);
  const grantId = wholeId(raw?.grantId);
  const agentId = wholeId(raw?.agentId, MAX_PERMISSION_NAME);
  const routineId = wholeId(raw?.cronJobId);
  const createdAtMs = time(raw?.createdAtMs);
  if (!raw || !grantId || !agentId || !routineId || createdAtMs === null) return null;
  return {
    grantId,
    agentId,
    routineId,
    routineName: cut(raw.cronJobName, MAX_PERMISSION_NAME),
    command: cut(raw.command) ?? "(unreadable)",
    cwd: cut(raw.cwd),
    createdAtMs,
    expiresAtMs: time(raw.expiresAtMs),
    revokedAtMs: time(raw.revokedAtMs),
    lastUsedAtMs: time(raw.lastUsedAtMs),
    useCount: typeof raw.useCount === "number" && raw.useCount >= 0 ? Math.floor(raw.useCount) : 0,
  };
}

export async function readGrants(
  ctx: PermissionsContext,
  canApprove: boolean,
): Promise<SavedApprovals["grants"]> {
  if (!canApprove) return { status: "needs-approvals" };
  try {
    const answer = asRecord(
      await ctx.request("exec.approval.grants.list", { limit: MAX_GRANTS_LISTED + 1 }),
    );
    const listed = Array.isArray(answer?.grants) ? answer.grants : [];
    const items = listed
      .slice(0, MAX_GRANTS_LISTED)
      .map(readGrant)
      .filter((each): each is RoutineGrant => each !== null);
    return { status: "ready", items, more: listed.length > MAX_GRANTS_LISTED };
  } catch (error) {
    if (missingScope(error)) return { status: "needs-approvals" };
    return { status: "failed", message: errorText(error) };
  }
}

/** Every entry of the approvals file, command and tool, bounded, in the file's order. */
export function allowlistOf(file: unknown): { items: AllowlistEntry[]; omitted: number } {
  const agents = asRecord(asRecord(file)?.agents) ?? {};
  const items: AllowlistEntry[] = [];
  let omitted = 0;
  const add = (entry: AllowlistEntry) => {
    if (items.length < MAX_ALLOWLIST_LISTED) items.push(entry);
    else omitted += 1;
  };
  for (const [rawId, value] of Object.entries(agents)) {
    const agentId = rawId.slice(0, MAX_PERMISSION_NAME);
    const agent = asRecord(value);
    for (const raw of Array.isArray(agent?.allowlist) ? agent.allowlist : []) {
      const entry = asRecord(raw);
      const pattern = cut(entry?.pattern);
      if (!entry || !pattern) continue;
      add({
        agentId,
        entryId: wholeId(entry.id),
        kind: "command",
        pattern,
        argPattern: cut(entry.argPattern, MAX_ENTRY_DETAIL),
        commandText: cut(entry.commandText, MAX_ENTRY_DETAIL),
        fromAlwaysAllow: entry.source === "allow-always",
        lastUsedAt: time(entry.lastUsedAt),
        addedAt: null,
      });
    }
    for (const raw of Array.isArray(agent?.mcpTools) ? agent.mcpTools : []) {
      const entry = asRecord(raw);
      const server = cut(entry?.server, MAX_PERMISSION_NAME);
      const tool = cut(entry?.tool, MAX_PERMISSION_NAME);
      if (!entry || !server || !tool) continue;
      add({
        agentId,
        entryId: null,
        kind: "tool",
        pattern: `${server}__${tool}`,
        argPattern: null,
        commandText: null,
        fromAlwaysAllow: entry.source === "allow-always",
        lastUsedAt: null,
        addedAt: time(entry.addedAt),
      });
    }
  }
  return { items, omitted };
}

export async function readAllowlist(
  ctx: PermissionsContext,
  canAdmin: boolean,
): Promise<SavedApprovals["allowlist"]> {
  if (!canAdmin) return { status: "needs-admin" };
  try {
    const answer = asRecord(await ctx.request("exec.approvals.get", {}));
    return {
      status: "ready",
      ...allowlistOf(answer?.file),
      hash: typeof answer?.hash === "string" ? answer.hash.slice(0, 128) : null,
    };
  } catch (error) {
    if (missingScope(error)) return { status: "needs-admin" };
    return { status: "failed", message: errorText(error) };
  }
}

export async function readSavedApprovals(
  ctx: PermissionsContext,
  access: { canApprove: boolean; canAdmin: boolean },
): Promise<SavedApprovals> {
  const [grants, allowlist] = await Promise.all([
    readGrants(ctx, access.canApprove),
    readAllowlist(ctx, access.canAdmin),
  ]);
  return { readAt: ctx.now(), grants, allowlist };
}

/**
 * Revoke a routine's grant, then read the list again. `answer` is the gateway's
 * own outcome, or null when the request failed (`error`); `grant` is the grant
 * as the read afterwards lists it, null when it lists none by that id, and
 * `readError` says why that read failed. Nothing is said revoked from the answer
 * alone: the page shows what the read afterwards lists.
 */
export type GrantRevokeResult = {
  answer: "revoked" | "already-revoked" | "not-found" | null;
  error: string | null;
  grant: RoutineGrant | null;
  readError: string | null;
  grants: SavedApprovals["grants"];
};

export async function revokeGrant(
  ctx: PermissionsContext,
  grantId: string,
): Promise<GrantRevokeResult> {
  let answer: GrantRevokeResult["answer"] = null;
  let error: string | null = null;
  try {
    const outcome = asRecord(
      await ctx.request("exec.approval.grants.revoke", { grantId }),
    )?.outcome;
    if (outcome === "revoked" || outcome === "already-revoked" || outcome === "not-found")
      answer = outcome;
    else error = "The gateway's answer named no outcome.";
  } catch (caught) {
    error = errorText(caught);
  }
  const grants = await readGrants(ctx, true);
  return {
    answer,
    error,
    grant:
      grants.status === "ready"
        ? (grants.items.find((each) => each.grantId === grantId) ?? null)
        : null,
    readError: grants.status === "failed" ? grants.message : null,
    grants,
  };
}

/**
 * Remove one entry from the gateway's machine's allowlist: read the approvals
 * file, take out exactly that entry by its id, write the file with the hash it
 * was read with, and read it again. `outcome` comes from the read afterwards:
 * `removed` when it no longer lists the entry, `still-listed` when it does,
 * `not-listed` when the file had no such entry before anything was written.
 */
export type AllowlistRemoveResult = {
  outcome: "removed" | "still-listed" | "not-listed" | "unknown";
  error: string | null;
  allowlist: SavedApprovals["allowlist"];
};

export async function removeAllowlistEntry(
  ctx: PermissionsContext,
  agentId: string,
  entryId: string,
): Promise<AllowlistRemoveResult> {
  const listed = (allowlist: SavedApprovals["allowlist"]) =>
    allowlist.status === "ready"
      ? allowlist.items.some((each) => each.agentId === agentId && each.entryId === entryId)
      : null;
  let error: string | null = null;
  try {
    const before = asRecord(await ctx.request("exec.approvals.get", {}));
    const file = asRecord(before?.file);
    const agents = asRecord(file?.agents);
    const agent = asRecord(agents?.[agentId]);
    const entries = Array.isArray(agent?.allowlist) ? agent.allowlist : [];
    const kept = entries.filter((each) => asRecord(each)?.id !== entryId);
    if (!file || !agents || !agent || kept.length === entries.length) {
      const allowlist = await readAllowlist(ctx, true);
      return { outcome: listed(allowlist) ? "still-listed" : "not-listed", error: null, allowlist };
    }
    await ctx.request("exec.approvals.set", {
      file: { ...file, agents: { ...agents, [agentId]: { ...agent, allowlist: kept } } },
      ...(typeof before?.hash === "string" ? { baseHash: before.hash } : {}),
    });
  } catch (caught) {
    error = errorText(caught);
  }
  const allowlist = await readAllowlist(ctx, true);
  const still = listed(allowlist);
  return {
    outcome: still === null ? "unknown" : still ? "still-listed" : "removed",
    error,
    allowlist,
  };
}

// Activity (section 9) --------------------------------------------------------------------

export const AUDIT_STATUSES = [
  "started",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "blocked",
  "unknown",
] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

/** A rule as the decision record names it, and what the rules say of it now. */
export type RecordedRule = {
  scope: string;
  ruleId: string;
  /** The rule's version when the call was decided. */
  version: number;
  action: "allow" | "ask" | "never";
  /** The rule as `get` lists it now; null when it no longer lists it; `unread` when the rules were not read. */
  now: { version: number; tools: string[]; pattern: string | null } | null | "unread";
};

/**
 * What a record made with the call says caused it. `recorded` comes from the
 * rules plugin's decision record, which shares the call's run and its hashed id;
 * nothing else is joined. `not-read` says the records that could join were not
 * read, and why.
 */
export type ActivityCause =
  | { kind: "not-recorded" }
  | { kind: "not-read"; reason: string }
  | {
      kind: "recorded";
      decision: "block" | "ask" | "allow";
      source:
        | { kind: "rule"; rule: RecordedRule }
        | { kind: "fallback"; scope: string }
        | { kind: "rules-lost" };
      /** The answer the gateway gave the plugin for an ask: not who gave it, and not what ran. */
      answer: "allow-once" | "deny" | "timeout" | "cancelled" | null;
      /** The decision record's own id. */
      recordId: string;
    };

export type ActivityRow = {
  /** The call's run and hashed id, or the record's id when it names no call. */
  id: string;
  /** The newest record of the call on this page: its end, or its start. */
  at: number;
  startedAt: number | null;
  agentId: string;
  sessionKey: string | null;
  runId: string;
  /** The gateway's hash of the call's id (`sha256:…`). */
  callId: string | null;
  toolName: string | null;
  /** The audit record's own status: `started` while no end is listed on this page. */
  status: AuditStatus;
  /** The audit log's record id, of the newest record. */
  recordId: string;
  cause: ActivityCause;
  /** A task this host has loaded holds the call: its key and the call's own id, for "Show in chat". */
  inChat: { key: string; callId: string } | null;
};

export type ActivityPage = {
  readAt: number;
  rows: ActivityRow[];
  /** The audit log's cursor for the next, older page, or null at its end. */
  nextCursor: string | null;
  /** `off` when the gateway's settings switch its audit log off (`logging.audit.enabled`). */
  recording: "on" | "off" | "unknown";
  /** The rules plugin's decision record could not be read for this page, and why. */
  decisionsUnread: string | null;
};

export type ActivityQuery = {
  cursor: string | null;
  agentId: string | null;
  status: AuditStatus | null;
};

/** The audit log's form of a call id: `sha256:` and the hex digest of the id. */
export function auditCallId(toolCallId: string): string {
  return `sha256:${sha256Hex(utf8Bytes(toolCallId))}`;
}

/** Group a page of tool-action records by call, newest first; a record naming no call stands alone. */
export function activityRows(events: unknown[]): Omit<ActivityRow, "cause" | "inChat">[] {
  const rows = new Map<string, Omit<ActivityRow, "cause" | "inChat">>();
  for (const value of events) {
    const event = asRecord(value);
    if (event?.kind !== "tool_action") continue;
    const recordId = wholeId(event.eventId, MAX_ACTIVITY_ID);
    const agentId = wholeId(event.agentId, MAX_PERMISSION_NAME);
    const runId = wholeId(event.runId, MAX_ACTIVITY_ID);
    const at = time(event.occurredAt);
    const status = AUDIT_STATUSES.find((each) => each === event.status) ?? "unknown";
    if (!recordId || !agentId || !runId || at === null) continue;
    const callId = wholeId(event.toolCallId, MAX_ACTIVITY_ID);
    if (event.toolCallId !== undefined && callId === null) continue;
    const id = callId ? `${runId}\u0000${callId}` : recordId;
    const known = rows.get(id);
    if (known) {
      // Newest first: a later record of the same call is its start.
      if (event.action === "tool.action.started") known.startedAt = at;
      continue;
    }
    rows.set(id, {
      id,
      at,
      startedAt: event.action === "tool.action.started" ? at : null,
      agentId,
      sessionKey: wholeId(event.sessionKey, MAX_ACTIVITY_ID),
      runId,
      callId,
      toolName: cut(event.toolName, MAX_PERMISSION_NAME),
      status: event.action === "tool.action.started" ? "started" : status,
      recordId,
    });
  }
  return [...rows.values()];
}

type Decision = {
  id: string;
  callId: string;
  decision: string;
  source: Record<string, unknown> | null;
  answer: string | null;
};

async function decisionsOf(
  ctx: PermissionsContext,
  runIds: string[],
): Promise<{ byCall: Map<string, Decision>; full: Set<string> } | string> {
  const byCall = new Map<string, Decision>();
  /** Runs whose every record was read: an unmatched call there was not decided by a record. */
  const full = new Set<string>();
  for (let i = 0; i < runIds.length; i += DECISION_READS_AT_ONCE) {
    const chunk = runIds.slice(i, i + DECISION_READS_AT_ONCE);
    try {
      const answers = await Promise.all(
        chunk.map((runId) =>
          ctx.request(`${RULES_PLUGIN}.decisions.list`, { runId, limit: DECISIONS_PER_RUN }),
        ),
      );
      answers.forEach((value, index) => {
        const answer = asRecord(value);
        const runId = chunk[index]!;
        if (answer?.hasMore !== true) full.add(runId);
        for (const raw of Array.isArray(answer?.records) ? answer.records : []) {
          const record = asRecord(raw);
          const callId = wholeId(record?.callId, MAX_ACTIVITY_ID);
          const id = wholeId(record?.id, MAX_ACTIVITY_ID);
          if (!record || !callId || !id || record.runId !== runId) continue;
          byCall.set(`${runId}\u0000${callId}`, {
            id,
            callId,
            decision: typeof record.decision === "string" ? record.decision : "none",
            source: asRecord(record.source),
            answer: typeof record.answer === "string" ? record.answer : null,
          });
        }
      });
    } catch (error) {
      return errorText(error);
    }
  }
  return { byCall, full };
}

type CurrentRules = Map<string, { version: number; tools: string[]; pattern: string | null }>;

async function currentRules(ctx: PermissionsContext): Promise<CurrentRules | null> {
  try {
    const scopes = asRecord(asRecord(await ctx.request(`${RULES_PLUGIN}.get`, {}))?.scopes) ?? {};
    const rules: CurrentRules = new Map();
    for (const [scope, value] of Object.entries(scopes)) {
      const list = asRecord(value)?.rules;
      for (const raw of Array.isArray(list) ? list : []) {
        const rule = asRecord(raw);
        if (typeof rule?.id !== "string" || typeof rule.version !== "number") continue;
        const tools = Array.isArray(rule.tools)
          ? rule.tools
              .filter((each): each is string => typeof each === "string")
              .slice(0, MAX_CAUSE_TOOLS)
              .map((each) => each.slice(0, MAX_PERMISSION_NAME))
          : [];
        rules.set(`${scope}\u0000${rule.id}`, {
          version: rule.version,
          tools,
          pattern: cut(asRecord(rule.target)?.pattern, 256),
        });
      }
    }
    return rules;
  } catch {
    return null;
  }
}

function causeOf(decision: Decision | undefined, rules: CurrentRules | null): ActivityCause {
  if (
    !decision ||
    (decision.decision !== "block" && decision.decision !== "ask" && decision.decision !== "allow")
  )
    return { kind: "not-recorded" };
  const source = decision.source;
  const answer =
    decision.answer === "allow-once" ||
    decision.answer === "deny" ||
    decision.answer === "timeout" ||
    decision.answer === "cancelled"
      ? decision.answer
      : null;
  const base = {
    kind: "recorded" as const,
    decision: decision.decision as "block" | "ask" | "allow",
    answer: answer as "allow-once" | "deny" | "timeout" | "cancelled" | null,
    recordId: decision.id,
  };
  if (source?.kind === "fallback" && typeof source.scope === "string")
    return {
      ...base,
      source: { kind: "fallback", scope: source.scope.slice(0, MAX_PERMISSION_NAME) },
    };
  if (source?.kind === "rules-lost") return { ...base, source: { kind: "rules-lost" } };
  const action = source?.action;
  if (
    source?.kind === "rule" &&
    typeof source.scope === "string" &&
    typeof source.ruleId === "string" &&
    typeof source.version === "number" &&
    (action === "allow" || action === "ask" || action === "never")
  ) {
    const scope = source.scope.slice(0, MAX_PERMISSION_NAME);
    const ruleId = source.ruleId.slice(0, 64);
    // The rule's scope, id and version as recorded; its words only from the rules read now.
    const now = rules === null ? "unread" : (rules.get(`${scope}\u0000${ruleId}`) ?? null);
    return {
      ...base,
      source: { kind: "rule", rule: { scope, ruleId, version: source.version, action, now } },
    };
  }
  return { kind: "not-recorded" };
}

/**
 * One page of the audit log's tool actions, newest first, each joined to the
 * rules plugin's decision record by its run and hashed call id, and to a step
 * of a task this host has loaded by the same hash (`loaded`).
 */
export async function readActivity(
  ctx: PermissionsContext,
  query: ActivityQuery,
  options: { rulesListed: boolean; loaded: Map<string, { key: string; callId: string }> },
): Promise<ActivityPage> {
  const [answer, config] = await Promise.all([
    ctx.request("audit.activity.list", {
      kind: "tool_action",
      limit: ACTIVITY_PAGE_RECORDS,
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.agentId ? { agentId: query.agentId } : {}),
      ...(query.status ? { status: query.status } : {}),
    }),
    ctx.request("config.get", {}).then(asRecord, () => null),
  ]);
  const page = asRecord(answer);
  const events = Array.isArray(page?.events) ? page.events.slice(0, ACTIVITY_PAGE_RECORDS) : [];
  const rows = activityRows(events);
  const audit = asRecord(asRecord(asRecord(config?.config)?.logging)?.audit);
  const recording = config === null ? "unknown" : audit?.enabled === false ? "off" : "on";
  let decisions: Awaited<ReturnType<typeof decisionsOf>> | null = null;
  let rules: CurrentRules | null = null;
  const withCalls = rows.filter((row) => row.callId !== null);
  if (options.rulesListed && withCalls.length > 0) {
    decisions = await decisionsOf(ctx, [...new Set(withCalls.map((row) => row.runId))]);
    if (typeof decisions !== "string" && decisions.byCall.size > 0) rules = await currentRules(ctx);
  }
  const unread = typeof decisions === "string" ? decisions : null;
  return {
    readAt: ctx.now(),
    nextCursor: cut(page?.nextCursor),
    recording,
    decisionsUnread: unread,
    rows: rows.map((row) => {
      let cause: ActivityCause = { kind: "not-recorded" };
      if (row.callId && decisions !== null) {
        if (typeof decisions === "string") cause = { kind: "not-read", reason: decisions };
        else {
          const found = decisions.byCall.get(row.id);
          cause =
            found || decisions.full.has(row.runId)
              ? causeOf(found, rules)
              : {
                  kind: "not-read",
                  reason: `This run has more than ${DECISIONS_PER_RUN} decision records; only the newest were read.`,
                };
        }
      }
      const found = row.callId ? options.loaded.get(row.callId) : undefined;
      const inChat =
        found && found.key.length <= MAX_ACTIVITY_ID && found.callId.length <= MAX_ACTIVITY_ID
          ? found
          : null;
      return { ...row, cause, inChat };
    }),
  };
}
