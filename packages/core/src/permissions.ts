// Settings, Permissions (docs/design/controls.md sections 7 to 9): the rules
// plugin's state, the standing approvals the gateway keeps and lists, and the
// tool actions its audit log holds, with what a record made with each call says
// caused it. Every read here is an answer, read again each time and kept
// nowhere: the engine holds no list of grants, entries or activity, and no
// history of its own. Each answer is bounded where it enters (the counts below,
// and each string's length as JSON writes it), so the largest one fits the web
// host's result frame.
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

/**
 * How many characters a string takes inside a JSON answer, quotes aside. Every
 * bound here counts these, not the string's own length: a backslash takes two,
 * a control character six, so a bound on length alone could let an answer
 * outgrow the frame it is sent in.
 */
export function jsonChars(text: string): number {
  return JSON.stringify(text).length - 2;
}

/** The longest start of `text` that takes at most `max` characters inside JSON. */
export function fitJson(text: string, max: number): string {
  if (jsonChars(text) <= max) return text;
  let used = 0;
  let end = 0;
  for (const char of text) {
    const size = jsonChars(char);
    if (used + size > max) break;
    used += size;
    end += char.length;
  }
  return text.slice(0, end);
}

const cut = (value: unknown, max = MAX_PERMISSION_TEXT): string | null =>
  typeof value === "string" && value.length > 0 ? fitJson(value, max) || null : null;
/** An id kept whole or not at all: a cut id could name another record. */
const wholeId = (value: unknown, max = MAX_PERMISSION_TEXT): string | null =>
  typeof value === "string" && value.length > 0 && jsonChars(value) <= max ? value : null;
const time = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const errorText = (error: unknown): string =>
  fitJson(error instanceof Error ? error.message : String(error), MAX_PERMISSION_TEXT);
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
 * `unavailable` when the hello did not list its methods; `stopped` when status
 * could not be read or named no version; `old` below the version the decision
 * record needs; `not-enforcing` when it answered that it enforces nothing
 * (`enforcing: "not-enforced"`: its hook is not registered, or its service is
 * not running); else `running`, with what it enforces for the next call
 * (`enforcing`, apart from the hook).
 */
export type RulesPluginState =
  | { state: "unavailable" }
  | { state: "stopped"; reason: string }
  | { state: "old"; version: string }
  | { state: "not-enforcing"; answeredAt: number; lastCallAt: number | null }
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
  const version = typeof answer?.version === "string" ? fitJson(answer.version, 32) : "";
  if (!version) return { state: "stopped", reason: "Its status named no version." };
  if (!versionAtLeast(version, RULES_PLUGIN_MIN_VERSION)) return { state: "old", version };
  const hook = asRecord(answer?.hook);
  const enforcing = answer?.enforcing;
  // An answer that it enforces nothing is an answer, not silence.
  if (hook?.registered !== true || enforcing === "not-enforced")
    return { state: "not-enforcing", answeredAt: ctx.now(), lastCallAt: time(hook?.lastCallAt) };
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
  /** The entry's id in the file; null when it has none (a tool entry): then it cannot be removed here. */
  entryId: string | null;
  kind: "command" | "tool";
  /** A command entry's pattern, or a tool entry's `<server>__<tool>`. */
  pattern: string;
  argPattern: string | null;
  commandText: string | null;
  fromAlwaysAllow: boolean;
  /** When the file says it was last used; null when the file records none (not "never used"). */
  lastUsedAt: number | null;
  /** When it was added, where the file records it (tool entries do; command entries don't). */
  addedAt: number | null;
  /** The pattern and argument pattern are shown whole: only then can the person confirm its removal. */
  shownWhole: boolean;
};

export type SavedApprovals = {
  readAt: number;
  grants:
    | { status: "ready"; items: RoutineGrant[]; more: boolean }
    | { status: "needs-approvals" }
    | { status: "failed"; message: string };
  /** The gateway's own machine's approvals file. Paired machines' files are not read here. */
  allowlist:
    | {
        status: "ready";
        items: AllowlistEntry[];
        omitted: number;
        /** The gateway's revision of the file (`hash`). */
        hash: string;
        /** A SHA-256 of the whole file as read, before anything is left out to show it. */
        snapshotDigest: string;
      }
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

/**
 * A complete answer of `exec.approvals.get` or `exec.approvals.set` for the gateway's
 * own machine: its revision, a digest of the whole file as read, and the file. Read
 * and write share it, and anything less is not used: an answer that marks itself
 * incomplete, has no `exists`, no revision or no version-1 file, or whose bots or
 * entries are not the protocol's shapes. A file with no `agents` is an empty policy.
 */
export type ApprovalsSnapshot = {
  hash: string;
  digest: string;
  file: Record<string, unknown>;
  agents: Record<string, Record<string, unknown>>;
};

/** Marks of an answer that is not the whole file. */
const INCOMPLETE_MARKS = [
  "hasMore",
  "incomplete",
  "partial",
  "truncated",
  "omitted",
  "nextCursor",
  "cursor",
  "continuation",
];

export function approvalsSnapshot(value: unknown): ApprovalsSnapshot | { invalid: string } {
  const answer = asRecord(value);
  if (!answer) return { invalid: "The gateway's answer about its approvals file is not a file." };
  if (INCOMPLETE_MARKS.some((mark) => answer[mark] !== undefined && answer[mark] !== false))
    return { invalid: "The gateway's answer about its approvals file is incomplete." };
  if (typeof answer.exists !== "boolean")
    return { invalid: "The gateway's answer doesn't say whether its approvals file exists." };
  const hash =
    typeof answer.hash === "string" && answer.hash.length > 0 && jsonChars(answer.hash) <= 128
      ? answer.hash
      : null;
  if (!hash) return { invalid: "The gateway's answer names no revision of its approvals file." };
  const file = asRecord(answer.file);
  if (!file || file.version !== 1)
    return { invalid: "The gateway's answer has no approvals file of version 1." };
  const agents: Record<string, Record<string, unknown>> = {};
  if (file.agents !== undefined) {
    const listed = asRecord(file.agents);
    if (!listed) return { invalid: "The approvals file's bots are not a list of bots." };
    for (const [agentId, value] of Object.entries(listed)) {
      const agent = asRecord(value);
      if (!agent) return { invalid: "A bot in the approvals file is not a bot's entry." };
      if (agent.allowlist !== undefined) {
        if (!Array.isArray(agent.allowlist))
          return { invalid: "A bot's allowlist in the approvals file is not a list." };
        for (const raw of agent.allowlist) {
          const entry = asRecord(raw);
          if (
            !entry ||
            typeof entry.pattern !== "string" ||
            (entry.id !== undefined && (typeof entry.id !== "string" || entry.id.length === 0))
          )
            return { invalid: "An allowlist entry in the approvals file is not an entry." };
        }
      }
      if (agent.mcpTools !== undefined) {
        if (!Array.isArray(agent.mcpTools))
          return { invalid: "A bot's tool entries in the approvals file are not a list." };
        for (const raw of agent.mcpTools) {
          const entry = asRecord(raw);
          if (
            !entry ||
            typeof entry.server !== "string" ||
            entry.server.length === 0 ||
            typeof entry.tool !== "string" ||
            entry.tool.length === 0
          )
            return { invalid: "A tool entry in the approvals file is not an entry." };
        }
      }
      agents[agentId] = agent;
    }
  }
  return { hash, digest: sha256Hex(utf8Bytes(JSON.stringify(file))), file, agents };
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
    // Kept whole or not at all: Remove names the bot by it.
    const agentId = wholeId(rawId, MAX_PERMISSION_NAME);
    const agent = asRecord(value);
    if (!agentId) {
      omitted += [agent?.allowlist, agent?.mcpTools].reduce<number>(
        (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
        0,
      );
      continue;
    }
    for (const raw of Array.isArray(agent?.allowlist) ? agent.allowlist : []) {
      const entry = asRecord(raw);
      const pattern = cut(entry?.pattern);
      if (!entry || !pattern) continue;
      const argPattern = cut(entry.argPattern, MAX_ENTRY_DETAIL);
      add({
        agentId,
        entryId: wholeId(entry.id),
        kind: "command",
        pattern,
        argPattern,
        commandText: cut(entry.commandText, MAX_ENTRY_DETAIL),
        fromAlwaysAllow: entry.source === "allow-always",
        lastUsedAt: time(entry.lastUsedAt),
        addedAt: null,
        shownWhole:
          pattern === entry.pattern &&
          (entry.argPattern === undefined ||
            entry.argPattern === "" ||
            argPattern === entry.argPattern),
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
        lastUsedAt: time(entry.lastUsedAt),
        addedAt: time(entry.addedAt),
        shownWhole: server === entry.server && tool === entry.tool,
      });
    }
  }
  return { items, omitted };
}

/** The approvals file as Saved approvals shows it: its entries, bounded, its revision and digest. */
function allowlistFrom(snapshot: ApprovalsSnapshot): SavedApprovals["allowlist"] {
  return {
    status: "ready",
    ...allowlistOf(snapshot.file),
    hash: snapshot.hash,
    snapshotDigest: snapshot.digest,
  };
}

/** An answer as Saved approvals shows it, or why it can't be used. */
function allowlistAnswer(value: unknown): SavedApprovals["allowlist"] {
  const snapshot = approvalsSnapshot(value);
  return "invalid" in snapshot
    ? { status: "failed", message: snapshot.invalid }
    : allowlistFrom(snapshot);
}

export async function readAllowlist(
  ctx: PermissionsContext,
  canAdmin: boolean,
): Promise<SavedApprovals["allowlist"]> {
  if (!canAdmin) return { status: "needs-admin" };
  try {
    return allowlistAnswer(await ctx.request("exec.approvals.get", {}));
  } catch (error) {
    if (missingScope(error)) return { status: "needs-admin" };
    return { status: "failed", message: errorText(error) };
  }
}

/**
 * The most JSON characters a Saved approvals answer may take: room under the web
 * host's 262,144-character result frame for the envelope it is sent in.
 */
export const MAX_SAVED_APPROVALS_CHARS = 250_000;

/**
 * Fit the answer to `MAX_SAVED_APPROVALS_CHARS` as serialized: entries leave from
 * the end of the allowlist first, each counted in `omitted`, then grants from the
 * end, with `more` set. Only the rows shown change: the revision and digest stay
 * those of the whole file.
 */
export function fitSavedApprovals(value: SavedApprovals): SavedApprovals {
  const size = (answer: SavedApprovals) => JSON.stringify(answer).length;
  if (size(value) <= MAX_SAVED_APPROVALS_CHARS) return value;
  let { grants, allowlist } = value;
  while (allowlist.status === "ready" && allowlist.items.length > 0) {
    allowlist = {
      ...allowlist,
      items: allowlist.items.slice(0, -1),
      omitted: allowlist.omitted + 1,
    };
    if (size({ ...value, grants, allowlist }) <= MAX_SAVED_APPROVALS_CHARS)
      return { ...value, grants, allowlist };
  }
  while (grants.status === "ready" && grants.items.length > 0) {
    grants = { ...grants, items: grants.items.slice(0, -1), more: true };
    if (size({ ...value, grants, allowlist }) <= MAX_SAVED_APPROVALS_CHARS) break;
  }
  return { ...value, grants, allowlist };
}

export async function readSavedApprovals(
  ctx: PermissionsContext,
  access: { canApprove: boolean; canAdmin: boolean },
): Promise<SavedApprovals> {
  const [grants, allowlist] = await Promise.all([
    readGrants(ctx, access.canApprove),
    readAllowlist(ctx, access.canAdmin),
  ]);
  return fitSavedApprovals({ readAt: ctx.now(), grants, allowlist });
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
 * Remove one entry from the gateway's machine's allowlist, the entry the person
 * confirmed: the file is written without it only while it is still the revision
 * the page showed (`shownHash`), and the write names that revision, so the
 * gateway refuses it if the file changed in between. `outcome`:
 *
 * - `changed`: the file is not the revision shown; nothing was written, and
 *   `allowlist` is the file as it is now, to confirm again from.
 * - `ambiguous`: the bot's list has more than one entry with that id; nothing was written.
 * - `not-listed`: the shown revision has no such entry; nothing was written.
 * - `still-listed`: the whole file read after the write still has the entry.
 * - `removed`: the write was accepted with a complete file, and the whole file
 *   read after it is that same revision and digest, without the entry. It names
 *   the entry as the file held it before the write.
 * - `not-confirmed`: the file read after it lacks the entry, but the write was
 *   refused, its answer was incomplete, or the two revisions differ: something
 *   else may have removed it.
 * - `unknown`: the file could not be read afterwards, or not whole.
 */
export type AllowlistRemoveResult = {
  outcome:
    | "removed"
    | "still-listed"
    | "not-listed"
    | "changed"
    | "ambiguous"
    | "not-confirmed"
    | "unknown";
  /** The entry the write took out, as the shown revision held it. */
  removed: { agentId: string; pattern: string } | null;
  error: string | null;
  allowlist: SavedApprovals["allowlist"];
};

/** The entries of one bot's allowlist with this id, in the whole file. */
function entriesWithId(file: unknown, agentId: string, entryId: string): Record<string, unknown>[] {
  const agent = asRecord(asRecord(asRecord(file)?.agents)?.[agentId]);
  const list = Array.isArray(agent?.allowlist) ? agent.allowlist : [];
  return list
    .map((each) => asRecord(each))
    .filter((each): each is Record<string, unknown> => each?.id === entryId);
}

/** The revision and digest of the file the person confirmed, and the connection they confirmed on. */
export type AllowlistRemoveTarget = {
  agentId: string;
  entryId: string;
  shownHash: string;
  shownDigest: string;
  /** Throws once the connection the person confirmed on is no longer the client's. */
  assertCurrent?: () => void;
};

export async function removeAllowlistEntry(
  ctx: PermissionsContext,
  target: AllowlistRemoveTarget,
): Promise<AllowlistRemoveResult> {
  const { agentId, entryId, shownHash, shownDigest } = target;
  let removed: AllowlistRemoveResult["removed"] = null;
  let error: string | null = null;
  /** The file as the accepted write left it, when its answer was a complete file. */
  let written: ApprovalsSnapshot | null = null;
  try {
    const before = approvalsSnapshot(await ctx.request("exec.approvals.get", {}));
    if ("invalid" in before)
      return {
        outcome: "unknown",
        removed: null,
        error: before.invalid,
        allowlist: { status: "failed", message: before.invalid },
      };
    // The whole file must be the one shown: its revision and its digest, before anything else.
    if (before.hash !== shownHash || before.digest !== shownDigest)
      return { outcome: "changed", removed: null, error: null, allowlist: allowlistFrom(before) };
    const agent = before.agents[agentId];
    const matching = entriesWithId(before.file, agentId, entryId);
    if (!agent || matching.length === 0)
      return {
        outcome: "not-listed",
        removed: null,
        error: null,
        allowlist: allowlistFrom(before),
      };
    if (matching.length > 1)
      return { outcome: "ambiguous", removed: null, error: null, allowlist: allowlistFrom(before) };
    const entries = agent.allowlist as unknown[];
    removed = { agentId, pattern: cut(matching[0]!.pattern) ?? "(no pattern)" };
    target.assertCurrent?.();
    const reply = await ctx.request("exec.approvals.set", {
      file: {
        ...before.file,
        agents: {
          ...before.agents,
          [agentId]: {
            ...agent,
            allowlist: entries.filter((each) => asRecord(each)?.id !== entryId),
          },
        },
      },
      baseHash: shownHash,
    });
    const accepted = approvalsSnapshot(reply);
    if ("invalid" in accepted) error = accepted.invalid;
    else written = accepted;
  } catch (caught) {
    error = errorText(caught);
  }
  // Whether it is gone is read from the whole file, not from the entries kept to show.
  let after: ApprovalsSnapshot | { invalid: string };
  try {
    after = approvalsSnapshot(await ctx.request("exec.approvals.get", {}));
  } catch (caught) {
    const message = errorText(caught);
    return {
      outcome: "unknown",
      removed: null,
      error: error ?? message,
      allowlist: missingScope(caught) ? { status: "needs-admin" } : { status: "failed", message },
    };
  }
  if ("invalid" in after)
    return {
      outcome: "unknown",
      removed: null,
      error: error ?? after.invalid,
      allowlist: { status: "failed", message: after.invalid },
    };
  if (entriesWithId(after.file, agentId, entryId).length > 0)
    return { outcome: "still-listed", removed: null, error, allowlist: allowlistFrom(after) };
  // Gone from the whole file: removed by this write only if it was accepted and the read is its file.
  const confirmed =
    written !== null && after.hash === written.hash && after.digest === written.digest;
  return {
    outcome: confirmed ? "removed" : "not-confirmed",
    removed: confirmed ? removed : null,
    error,
    allowlist: allowlistFrom(after),
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
  /** The call's task, run and hashed id, or the record's id when it names no call. */
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
  /** A task this host has loaded holds the call: its task, the call's own id and its run. */
  inChat: { key: string; callId: string; runId: string } | null;
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
    const sessionKey = wholeId(event.sessionKey, MAX_ACTIVITY_ID);
    // One row per call in its own task: the same run and call in two tasks are two rows.
    const id = callId ? JSON.stringify([sessionKey, runId, callId]) : recordId;
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
      sessionKey,
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
        const records = Array.isArray(answer?.records) ? answer.records : [];
        if (answer?.hasMore !== true && records.length <= DECISIONS_PER_RUN) full.add(runId);
        for (const raw of records.slice(0, DECISIONS_PER_RUN)) {
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
              .map((each) => fitJson(each, MAX_PERMISSION_NAME))
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
      source: { kind: "fallback", scope: fitJson(source.scope, MAX_PERMISSION_NAME) },
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
    const scope = fitJson(source.scope, MAX_PERMISSION_NAME);
    const ruleId = fitJson(source.ruleId, 64);
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
 * A call as a task this host has loaded draws it: the task, the call's own id,
 * where it is drawn (a history row's block, or a followed run's step) and the
 * run that drawing names itself, if any.
 */
export type LoadedCall = {
  key: string;
  callId: string;
  runId: string | null;
  kind: "history" | "step";
};

/**
 * The call in a loaded task that is this row's: in the row's own task, with the
 * row's own call id, and every drawing of it naming the row's run itself. At most
 * one history block and one step, which are then the one call. A drawing that
 * names no run, or another run, gives no link.
 */
function chatTarget(
  row: Omit<ActivityRow, "cause" | "inChat">,
  loaded: Map<string, LoadedCall[]>,
): ActivityRow["inChat"] {
  if (!row.callId || !row.sessionKey) return null;
  const drawn = (loaded.get(row.callId) ?? []).filter((each) => each.key === row.sessionKey);
  if (drawn.length === 0 || !drawn.every((each) => each.runId === row.runId)) return null;
  const steps = drawn.filter((each) => each.kind === "step");
  const history = drawn.filter((each) => each.kind === "history");
  if (steps.length > 1 || history.length > 1) return null;
  const pick = steps[0] ?? history[0]!;
  return pick.key.length <= MAX_ACTIVITY_ID && pick.callId.length <= MAX_ACTIVITY_ID
    ? { key: pick.key, callId: pick.callId, runId: row.runId }
    : null;
}

/**
 * One page of the audit log's tool actions, newest first, each joined to the
 * rules plugin's decision record by its run and hashed call id, and to the
 * same call in a task this host has loaded (`loaded`, by that hash) by its
 * task and run as well.
 */
export async function readActivity(
  ctx: PermissionsContext,
  query: ActivityQuery,
  options: { rulesListed: boolean; loaded: Map<string, LoadedCall[]> },
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
  /**
   * The plugin's own word that its decision record is failing: while it is, the records it
   * lists can lack ones in a file it could not read, so no record is not "not recorded".
   */
  let recordFailing: string | null = null;
  if (options.rulesListed && withCalls.length > 0) {
    decisions = await decisionsOf(ctx, [...new Set(withCalls.map((row) => row.runId))]);
    if (typeof decisions !== "string") {
      const [current, status] = await Promise.all([
        decisions.byCall.size > 0 ? currentRules(ctx) : Promise.resolve(null),
        ctx.request(RULES_STATUS_METHOD, {}).then(asRecord, () => null),
      ]);
      rules = current;
      const kept = asRecord(status?.decisions);
      if (kept?.state === "failing")
        recordFailing = `Clawtrate's rules plugin says ${cut(kept.reason, 256) ?? "its decision record is failing"}.`;
    }
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
          const found = decisions.byCall.get(`${row.runId}\u0000${row.callId}`);
          cause = found
            ? causeOf(found, rules)
            : recordFailing
              ? { kind: "not-read", reason: recordFailing }
              : decisions.full.has(row.runId)
                ? causeOf(found, rules)
                : {
                    kind: "not-read",
                    reason: `This run has more than ${DECISIONS_PER_RUN} decision records; only the newest were read.`,
                  };
        }
      }
      return { ...row, cause, inChat: chatTarget(row, options.loaded) };
    }),
  };
}
