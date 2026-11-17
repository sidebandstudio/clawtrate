// Approvals: exec, plugin and the generic kind (capability map row 8, schema
// `ApprovalSnapshot`, `ExecApprovalResolveParams`, `ApprovalResolveParams`).
// An approval that names its tool call is that step's own waiting status; one
// that names no step is its own card. Everything here needs `operator.approvals`.

import { asRecord, type RawRecord } from "./mapping.ts";
import {
  findRun,
  isOpenStep,
  isTerminal,
  type Run,
  type RunState,
  type Step,
  type TaskActivity,
} from "./runs.ts";

export type ApprovalKind = "exec" | "plugin" | "system-agent";
export type ApprovalDecision = "allow-once" | "allow-always" | "deny";
export type ApprovalStatus =
  | "pending"
  | "allowed"
  | "denied"
  | "expired"
  /** Cancelled by the gateway, for example because the run was aborted or the gateway restarted. */
  | "cancelled"
  /** No longer listed by the gateway after a reload; this client did not see how it ended. */
  | "closed";

/** What an exec approval will run, exactly as the gateway described it. */
export type ExecApprovalDetail = {
  command: string | null;
  commandArgv: string[] | null;
  cwd: string | null;
  host: string | null;
  nodeId: string | null;
  security: string | null;
  ask: string | null;
  resolvedPath: string | null;
  warningText: string | null;
  /** `commandAnalysis` as sent; its shape is not documented in the map. */
  commandAnalysis: unknown;
  /**
   * Where it runs. A command on a node is governed by that node's rules, not
   * the gateway's, and a saved rule there does not bypass an "always ask" host.
   */
  runsOn: "gateway" | "node";
  /** A node's run plan (`systemRunPlan`), as sent. */
  systemRunPlan: unknown;
};

export type PluginApprovalDetail = {
  title: string | null;
  description: string | null;
  detail: string | null;
  severity: string | null;
  pluginId: string | null;
  toolName: string | null;
};

export type SystemAgentApprovalDetail = {
  title: string | null;
  description: string | null;
  /** The change described as a command, as the request sends it. */
  command: string | null;
  proposalHash: string | null;
};

/** Who settled an approval, as a terminal `ApprovalSnapshot` names it. No display label is invented. */
export type ApprovalResolver = {
  kind: "device" | "channel" | "runtime" | "system";
  id: string | null;
};

export type ApprovalCard = {
  id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  decision: ApprovalDecision | null;
  /** The gateway's terminal reason (`user`, `timeout`, `no-route`, `run-aborted`, …), or this client's. */
  reason: string | null;
  sessionKey: string | null;
  agentId: string | null;
  runId: string | null;
  toolCallId: string | null;
  /** The step this approval belongs to, once that step is known. Null for a card of its own. */
  stepId: string | null;
  /** Still pending although its run has ended: it outlived the run, and allowing it may still act. */
  runEnded: boolean;
  createdAt: number | null;
  expiresAt: number | null;
  resolvedAt: number | null;
  /** The human-readable label the legacy resolved event carries (`resolvedBy`), as sent. */
  resolvedBy: string | null;
  /** The typed resolver of a terminal `ApprovalSnapshot` (`resolver.kind`, `resolver.id`). */
  resolver: ApprovalResolver | null;
  /**
   * The terminal status is this client's inference, not the gateway's word:
   * the expiry time passed, or a reload no longer listed it. A later outcome
   * from the gateway replaces it.
   */
  inferred: boolean;
  /**
   * The gateway said the approval is settled but not how: a legacy exec or
   * plugin resolution reads `deny` whether a reviewer denied it or the gateway
   * cancelled it when its run was stopped. It shows as `closed` until the
   * approval's own snapshot (`approval.get`) says how it ended.
   */
  outcomeUnknown: boolean;
  /**
   * For a system-agent change that was allowed: whether the gateway then
   * applied it (`applicationStatus`, `applied` or `not-applied`), kept apart
   * from the permission outcome.
   */
  applicationStatus: string | null;
  /**
   * The decisions the request offers, and nothing it did not: a standing allow
   * appears only when offered. Always contains `deny`.
   */
  allowedDecisions: ApprovalDecision[];
  /** Decisions the request says are not available (`unavailableDecisions`), as sent. */
  unavailableDecisions: ApprovalDecision[];
  /**
   * The task whose run started the one that asked, when the asking session is a
   * helper or a bot messaged by another (`spawnedBy` on its events).
   */
  parentSessionKey: string | null;
  /**
   * How the asking session relates to the task showing the approval: a helper
   * it spawned (`spawnedBy`), or a bot one of its `sessions_send` calls
   * messaged (the result named the recipient's run or session). Null when the
   * approval is the task's own.
   */
  relation: "helper" | "messaged" | null;
  exec: ExecApprovalDetail | null;
  plugin: PluginApprovalDetail | null;
  systemAgent: SystemAgentApprovalDetail | null;
  /** The approval's `scope` (message send, payment, external post, standing grant), as sent. */
  scope: unknown;
  /**
   * The approval's record and analysis were not kept because its task or the
   * host reached its retention budget. What identifies it is kept, and it can
   * be denied; allowing it waits until it is read again in full.
   */
  detailOmitted: boolean;
  /** A resolution from this client is on its way, or the last one failed. */
  submitting: boolean;
  error: string | null;
  /** The record as received. */
  raw: unknown;
};

/**
 * Whether this connection can see approvals at all. Read-only connections
 * cannot: that is not "none". `partial` means some kinds' lists loaded and
 * others failed (`approvalSources` says which); an incomplete list is not "no
 * approvals".
 */
export type ApprovalAccess = "unavailable" | "loading" | "ready" | "partial" | "error";
export type ApprovalSourceAccess = "unavailable" | "loading" | "ready" | "error";
export const APPROVAL_KINDS: readonly ApprovalKind[] = ["exec", "plugin", "system-agent"];

const DECISIONS: readonly ApprovalDecision[] = ["allow-once", "allow-always", "deny"];

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function decision(value: unknown): ApprovalDecision | null {
  return DECISIONS.includes(value as ApprovalDecision) ? (value as ApprovalDecision) : null;
}

function decisionList(value: unknown): ApprovalDecision[] {
  return (Array.isArray(value) ? value : [])
    .map(decision)
    .filter((d): d is ApprovalDecision => d !== null);
}

/**
 * What the gateway offers by default when a request lists no decisions, per
 * kind. Exec requests always list theirs; without one, allow once is the safe
 * reading. A plugin request without a list gets the plugin default of allow
 * once, allow always and deny (`resolvePluginApprovalRequestAllowedDecisions`
 * in OpenClaw 2026.10.6). System-agent changes offer allow once and deny.
 */
const DEFAULT_DECISIONS: Record<ApprovalKind, readonly ApprovalDecision[]> = {
  exec: ["allow-once"],
  plugin: ["allow-once", "allow-always", "deny"],
  "system-agent": ["allow-once", "deny"],
};

/**
 * The offered decisions, in a fixed order: the listed ones; without a list,
 * the kind's default less anything marked unavailable. Deny is always possible.
 */
function decisions(
  kind: ApprovalKind,
  allowed: unknown,
  unavailable: unknown = undefined,
): ApprovalDecision[] {
  const listed = decisionList(allowed);
  const offered = new Set<ApprovalDecision>(
    Array.isArray(allowed) && listed.length > 0 ? listed : DEFAULT_DECISIONS[kind],
  );
  for (const each of decisionList(unavailable)) if (each !== "deny") offered.delete(each);
  offered.add("deny");
  return DECISIONS.filter((each) => offered.has(each));
}

function blank(id: string, kind: ApprovalKind, raw: unknown): ApprovalCard {
  return {
    id,
    kind,
    status: "pending",
    decision: null,
    reason: null,
    sessionKey: null,
    agentId: null,
    runId: null,
    toolCallId: null,
    stepId: null,
    runEnded: false,
    createdAt: null,
    expiresAt: null,
    resolvedAt: null,
    resolvedBy: null,
    resolver: null,
    inferred: false,
    outcomeUnknown: false,
    applicationStatus: null,
    allowedDecisions: decisions(kind, undefined),
    unavailableDecisions: [],
    parentSessionKey: null,
    relation: null,
    exec: null,
    plugin: null,
    systemAgent: null,
    scope: null,
    detailOmitted: false,
    submitting: false,
    error: null,
    raw,
  };
}

/**
 * An `exec.approval.requested` payload or an `exec.approval.list` item:
 * `{id, request{command, cwd, host, nodeId, security, ask, agentId, sessionKey,
 * runId, toolCallId, allowedDecisions, commandAnalysis, resolvedPath}, createdAtMs, expiresAtMs}`.
 */
export function parseExecApproval(value: unknown): ApprovalCard | null {
  const record = asRecord(value);
  const id = str(record?.id);
  const request = asRecord(record?.request);
  if (!record || !id || !request) return null;
  const argv = Array.isArray(request.commandArgv)
    ? request.commandArgv.filter((part): part is string => typeof part === "string")
    : null;
  return {
    ...blank(id, "exec", value),
    sessionKey: str(request.sessionKey),
    agentId: str(request.agentId),
    runId: str(request.runId),
    toolCallId: str(request.toolCallId),
    createdAt: num(record.createdAtMs),
    expiresAt: num(record.expiresAtMs),
    allowedDecisions: decisions("exec", request.allowedDecisions, request.unavailableDecisions),
    unavailableDecisions: decisionList(request.unavailableDecisions),
    scope: request.scope ?? null,
    exec: {
      command: str(request.command),
      commandArgv: argv,
      cwd: str(request.cwd),
      host: str(request.host),
      nodeId: str(request.nodeId),
      security: str(request.security),
      ask: str(request.ask),
      resolvedPath: str(request.resolvedPath),
      warningText: str(request.warningText),
      commandAnalysis: request.commandAnalysis ?? null,
      runsOn: str(request.nodeId) || str(request.host) === "node" ? "node" : "gateway",
      systemRunPlan: request.systemRunPlan ?? null,
    },
  };
}

/**
 * A `plugin.approval.requested` payload or `plugin.approval.list` item. The map
 * saw only exec events live; this reads the same `{id, request, createdAtMs,
 * expiresAtMs}` envelope with the `PluginApprovalRequestParams` fields.
 */
export function parsePluginApproval(value: unknown): ApprovalCard | null {
  const record = asRecord(value);
  const id = str(record?.id);
  const request = asRecord(record?.request);
  if (!record || !id || !request) return null;
  return {
    ...blank(id, "plugin", value),
    sessionKey: str(request.sessionKey),
    agentId: str(request.agentId),
    runId: str(request.runId),
    toolCallId: str(request.toolCallId),
    createdAt: num(record.createdAtMs),
    expiresAt: num(record.expiresAtMs),
    // The producer omits the list when the plugin did not set one; the gateway then offers its default.
    allowedDecisions: decisions("plugin", request.allowedDecisions),
    unavailableDecisions: [],
    scope: request.scope ?? null,
    plugin: {
      title: str(request.title),
      description: str(request.description),
      detail: str(request.detail),
      severity: str(request.severity),
      pluginId: str(request.pluginId),
      toolName: str(request.toolName),
    },
  };
}

/**
 * A system-agent request: an `openclaw.approval.requested` event or an
 * `openclaw.approval.list` item, `{approvalKind?, id, request{title,
 * description, command, proposalHash, allowedDecisions, agentId, sessionKey,
 * runId}, createdAtMs, expiresAtMs}` (OpenClaw 2026.10.6 `buildRequestedApprovalEvent`
 * and `listVisiblePendingApprovalRequests`). It is not an `ApprovalSnapshot`.
 */
export function parseSystemAgentApproval(value: unknown): ApprovalCard | null {
  const record = asRecord(value);
  const id = str(record?.id);
  const request = asRecord(record?.request);
  if (!record || !id || !request) return null;
  if (record.approvalKind !== undefined && record.approvalKind !== "system-agent") return null;
  return {
    ...blank(id, "system-agent", value),
    sessionKey: str(request.sessionKey),
    agentId: str(request.agentId),
    runId: str(request.runId),
    createdAt: num(record.createdAtMs),
    expiresAt: num(record.expiresAtMs),
    allowedDecisions: decisions("system-agent", request.allowedDecisions),
    systemAgent: {
      title: str(request.title),
      description: str(request.description),
      command: str(request.command),
      proposalHash: str(request.proposalHash),
    },
  };
}

function resolverOf(value: unknown): ApprovalResolver | null {
  const record = asRecord(value);
  const kind = record?.kind;
  if (kind !== "device" && kind !== "channel" && kind !== "runtime" && kind !== "system")
    return null;
  return { kind, id: str(record?.id) };
}

/**
 * An `ApprovalSnapshot` as `approval.get` and `approval.resolve` return it.
 * A pending snapshot may name `sourceSessionKey`; a terminal one names
 * `source{agentId, sessionKey}` and a typed `resolver{kind, id}`. A snapshot
 * names no run or tool call, so it never links to a step on its own.
 */
export function parseApprovalSnapshot(
  value: unknown,
  sessionKey?: string | null,
): ApprovalCard | null {
  const record = asRecord(value);
  const id = str(record?.id);
  const presentation = asRecord(record?.presentation);
  const kind = presentation?.kind;
  if (
    !record ||
    !id ||
    !presentation ||
    (kind !== "exec" && kind !== "plugin" && kind !== "system-agent")
  ) {
    return null;
  }
  const source = asRecord(record.source);
  const card: ApprovalCard = {
    ...blank(id, kind, value),
    sessionKey: sessionKey ?? str(source?.sessionKey) ?? str(record.sourceSessionKey),
    agentId: str(source?.agentId) ?? str(presentation.agentId),
    createdAt: num(record.createdAtMs),
    expiresAt: num(record.expiresAtMs),
    allowedDecisions: decisions(kind, presentation.allowedDecisions),
    scope: presentation.scope ?? null,
  };
  if (kind === "exec") {
    card.exec = {
      // The generic snapshot's presentation names it `commandText`; the interactive request names it `command`.
      command: str(presentation.commandText),
      commandArgv: null,
      cwd: null,
      host: str(presentation.host),
      nodeId: str(presentation.nodeId),
      security: null,
      ask: null,
      resolvedPath: null,
      warningText: str(presentation.warningText),
      commandAnalysis: null,
      runsOn: str(presentation.nodeId) ? "node" : "gateway",
      systemRunPlan: null,
    };
  } else if (kind === "plugin") {
    card.plugin = {
      title: str(presentation.title),
      description: str(presentation.description),
      detail: str(presentation.detail),
      severity: str(presentation.severity),
      pluginId: str(presentation.pluginId),
      toolName: str(presentation.toolName),
    };
  } else {
    card.systemAgent = {
      title: str(presentation.title),
      description: str(presentation.description),
      command: null,
      proposalHash: str(presentation.proposalHash),
    };
  }
  const status = record.status;
  if (
    status === "allowed" ||
    status === "denied" ||
    status === "expired" ||
    status === "cancelled"
  ) {
    card.status = status;
    card.decision = decision(record.decision);
    card.reason = str(record.reason);
    card.resolvedAt = num(record.resolvedAtMs);
    card.resolver = resolverOf(record.resolver);
  }
  return card;
}

/** The outcome an `*.approval.resolved` event or a resolve call reports. */
export type ApprovalResolution = {
  id: string;
  status: Exclude<ApprovalStatus, "pending">;
  decision: ApprovalDecision | null;
  reason: string | null;
  resolvedAt: number | null;
  resolvedBy: string | null;
  resolver: ApprovalResolver | null;
  /** A system-agent application result (`applied`, `not-applied`), when the event carries one. */
  applicationStatus: string | null;
  /** False for this client's own inference (local expiry, no longer listed). */
  authoritative: boolean;
  /** The gateway's word that it is settled, without how (a legacy `deny`); exact outcomes replace it. */
  lossy: boolean;
  /** The session the request named (`request.sessionKey`, or a terminal snapshot's `source.sessionKey`). */
  sessionKey: string | null;
  runId: string | null;
};

/**
 * `exec.approval.resolved`, `plugin.approval.resolved` and
 * `openclaw.approval.resolved`: `{id, decision, resolvedBy, ts, request}`.
 * A system-agent event may add `terminalStatus` (`cancelled` or `expired`),
 * which is authoritative although its projected decision is deny, and a
 * later application result adds `applicationStatus`. None of them is an
 * `ApprovalSnapshot`.
 */
export function parseApprovalResolved(
  value: unknown,
  kind: ApprovalKind,
): ApprovalResolution | null {
  const record = asRecord(value);
  const id = str(record?.id);
  const chosen = decision(record?.decision);
  if (!record || !id || !chosen) return null;
  const request = asRecord(record.request);
  const terminal = kind === "system-agent" ? record.terminalStatus : undefined;
  // Exec and plugin publications project a cancellation or expiry as `deny`
  // (`publishAppliedApprovalResolution` in OpenClaw 2026.10.6): their deny
  // says the approval is settled, not that anyone denied it.
  const lossy = kind !== "system-agent" && chosen === "deny";
  const status: ApprovalResolution["status"] =
    terminal === "cancelled"
      ? "cancelled"
      : terminal === "expired"
        ? "expired"
        : lossy
          ? "closed"
          : chosen === "deny"
            ? "denied"
            : "allowed";
  return {
    id,
    status,
    decision: status === "allowed" || status === "denied" ? chosen : null,
    reason:
      str(record.reason) ??
      (status === "expired" ? "timeout" : lossy ? "settled-cause-unknown" : null),
    resolvedAt: num(record.ts),
    resolvedBy: str(record.resolvedBy),
    resolver: null,
    applicationStatus: kind === "system-agent" ? str(record.applicationStatus) : null,
    authoritative: true,
    lossy,
    sessionKey: str(request?.sessionKey),
    runId: str(request?.runId),
  };
}

/** The outcome a terminal `ApprovalSnapshot` reports, as `approval.resolve` returns it. */
export function resolutionFromSnapshot(value: unknown): ApprovalResolution | null {
  const card = parseApprovalSnapshot(value);
  if (!card || card.status === "pending") return null;
  return {
    id: card.id,
    status: card.status,
    decision: card.decision,
    reason: card.reason,
    resolvedAt: card.resolvedAt,
    resolvedBy: null,
    resolver: card.resolver,
    applicationStatus: null,
    authoritative: true,
    lossy: false,
    sessionKey: card.sessionKey,
    runId: null,
  };
}

/** How much a report establishes: this client's inference, the gateway's lossy word, or its exact outcome. */
function rank(resolution: Pick<ApprovalResolution, "authoritative" | "lossy">): number {
  return !resolution.authoritative ? 0 : resolution.lossy ? 1 : 2;
}

function cardRank(card: ApprovalCard): number {
  return card.status === "pending" ? -1 : card.inferred ? 0 : card.outcomeUnknown ? 1 : 2;
}

/** Fold a later report about the same approval into what is known: an application result adds to the outcome. */
export function mergeResolution(
  known: ApprovalResolution | undefined,
  next: ApprovalResolution,
): ApprovalResolution {
  if (!known || rank(next) > rank(known)) return next;
  if (rank(next) < rank(known)) return known;
  return {
    ...known,
    applicationStatus: next.applicationStatus ?? known.applicationStatus,
    resolver: known.resolver ?? next.resolver,
    resolvedBy: known.resolvedBy ?? next.resolvedBy,
    sessionKey: known.sessionKey ?? next.sessionKey,
    runId: known.runId ?? next.runId,
  };
}

// Reducers ---------------------------------------------------------------------------

/** Add or refresh an approval. A generic snapshot fills in fields; it never drops the link fields. */
export function applyApprovalRequested(activity: TaskActivity, card: ApprovalCard): TaskActivity {
  const existing = activity.approvals.find((each) => each.id === card.id);
  if (existing && existing.status !== "pending") return activity;
  const merged: ApprovalCard = existing
    ? {
        ...existing,
        ...card,
        sessionKey: existing.sessionKey ?? card.sessionKey,
        runId: existing.runId ?? card.runId,
        toolCallId: existing.toolCallId ?? card.toolCallId,
        stepId: existing.stepId,
        exec:
          card.exec && existing.exec
            ? { ...card.exec, ...pickSet(existing.exec) }
            : (existing.exec ?? card.exec),
        submitting: existing.submitting,
        error: existing.error,
        raw: existing.kind === card.kind && existing.raw ? existing.raw : card.raw,
      }
    : card;
  const approvals = existing
    ? activity.approvals.map((each) => (each.id === card.id ? merged : each))
    : [...activity.approvals, merged];
  return normalizeApprovals({ ...activity, approvals });
}

/** The fields an earlier, fuller record had set. */
function pickSet<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null)) as Partial<T>;
}

/**
 * Settle an approval. The gateway's word settles a pending card and corrects a
 * closure this client only inferred (local expiry, no longer listed),
 * including its decision, reason and resolver. Once the gateway has settled
 * it, only a later application result is added; nothing reopens it.
 */
export function applyApprovalResolved(
  activity: TaskActivity,
  resolution: ApprovalResolution,
): TaskActivity {
  const existing = activity.approvals.find((each) => each.id === resolution.id);
  if (!existing) return activity;
  let patch: Partial<ApprovalCard> | null = null;
  if (rank(resolution) > cardRank(existing)) {
    patch = {
      status: resolution.status,
      decision: resolution.decision,
      reason: resolution.reason,
      resolvedAt: resolution.resolvedAt,
      resolvedBy: resolution.resolvedBy ?? existing.resolvedBy,
      resolver: resolution.resolver ?? existing.resolver,
      applicationStatus: resolution.applicationStatus ?? existing.applicationStatus,
      inferred: !resolution.authoritative,
      outcomeUnknown: resolution.lossy,
      submitting: false,
      error: null,
    };
  } else if (
    cardRank(existing) === 2 &&
    rank(resolution) === 2 &&
    ((resolution.applicationStatus !== null &&
      resolution.applicationStatus !== existing.applicationStatus) ||
      (existing.resolver === null && resolution.resolver !== null))
  ) {
    patch = {
      applicationStatus: resolution.applicationStatus ?? existing.applicationStatus,
      resolver: existing.resolver ?? resolution.resolver,
    };
  }
  if (!patch) return activity;
  const approvals = activity.approvals.map((each) =>
    each.id === resolution.id ? { ...each, ...patch } : each,
  );
  return normalizeApprovals({ ...activity, approvals });
}

export function markApproval(
  activity: TaskActivity,
  id: string,
  patch: Pick<ApprovalCard, "submitting" | "error">,
): TaskActivity {
  return {
    ...activity,
    approvals: activity.approvals.map((each) => (each.id === id ? { ...each, ...patch } : each)),
  };
}

function inferredResolution(
  id: string,
  status: "expired" | "closed",
  reason: string,
): ApprovalResolution {
  return {
    id,
    status,
    decision: null,
    reason,
    resolvedAt: null,
    resolvedBy: null,
    resolver: null,
    applicationStatus: null,
    authoritative: false,
    lossy: false,
    sessionKey: null,
    runId: null,
  };
}

/**
 * Pending approvals past their `expiresAt` expire. The gateway does not run
 * them. This is an inference: the gateway's own outcome, if it differs, wins.
 */
export function expireApprovals(activity: TaskActivity, now: number): TaskActivity {
  let next = activity;
  for (const approval of activity.approvals) {
    if (approval.status === "pending" && approval.expiresAt !== null && approval.expiresAt <= now) {
      next = applyApprovalResolved(next, {
        ...inferredResolution(approval.id, "expired", "timeout"),
        resolvedAt: approval.expiresAt,
      });
    }
  }
  return next;
}

/** After a reload: pending approvals the gateway no longer lists were settled while this client was away. */
export function settleUnlistedApprovals(
  activity: TaskActivity,
  kinds: readonly ApprovalKind[],
  listed: Set<string>,
  /** Ids pending when the list was asked for; one that arrived since is never settled by it. */
  pendingBefore?: ReadonlySet<string>,
): TaskActivity {
  let next = activity;
  for (const approval of activity.approvals) {
    if (
      approval.status === "pending" &&
      kinds.includes(approval.kind) &&
      !listed.has(approval.id) &&
      (pendingBefore === undefined || pendingBefore.has(approval.id))
    ) {
      next = applyApprovalResolved(
        next,
        inferredResolution(approval.id, "closed", "no-longer-listed"),
      );
    }
  }
  return next;
}

/**
 * Keep steps consistent with the approvals. Idempotent: returns the same
 * object when nothing changes.
 *
 * - A pending approval naming a tool call that the task has as a step, while
 *   that step is still running, makes the step `waiting`: the approval is the
 *   step's own waiting status. A resolved approval releases it to `running`;
 *   the tool's result then finishes it.
 * - The run's state is left to the run's own lifecycle events. A pending
 *   approval does not prove its run is blocked: exec can return an
 *   `approval-pending` result and wait for the decision on its own.
 * - An approval is never settled because its run ended. It stays pending until
 *   the gateway resolves it, it expires, or a reload no longer lists it;
 *   `runEnded` says it outlived its run. To withdraw it, deny it.
 */
export function normalizeApprovals(
  activity: TaskActivity,
  /**
   * The state of a run this task does not hold, such as a helper's or a
   * messaged bot's, when the caller follows it. Without it, such an
   * approval's `runEnded` is left as it was.
   */
  otherRun?: (runId: string) => { state: RunState } | undefined,
): TaskActivity {
  if (activity.approvals.length === 0) return activity;
  let runs = activity.runs;
  let changed = false;
  const approvals = activity.approvals.map((approval) => {
    const run = runFor({ ...activity, runs }, approval);
    const stepId = approval.toolCallId ? `tool:${approval.toolCallId}` : null;
    const linked =
      run && stepId && run.steps.some((step) => step.id === stepId) ? stepId : approval.stepId;
    const elsewhere = !run && approval.runId ? otherRun?.(approval.runId) : undefined;
    const runEnded =
      approval.status !== "pending"
        ? false
        : run
          ? isTerminal(run.state)
          : elsewhere
            ? isTerminal(elsewhere.state)
            : approval.runEnded;
    const next =
      linked !== approval.stepId || runEnded !== approval.runEnded
        ? { ...approval, stepId: linked, runEnded }
        : approval;
    if (next !== approval) changed = true;
    if (run) {
      const updated = syncSteps(run, next);
      if (updated !== run) {
        runs = runs.map((each) => (each.id === run.id ? updated : each));
        changed = true;
      }
    }
    return next;
  });
  return changed ? { ...activity, runs, approvals } : activity;
}

function runFor(activity: TaskActivity, approval: ApprovalCard): Run | undefined {
  if (approval.runId) {
    const run = findRun(activity, approval.runId);
    if (run) return run;
  }
  if (!approval.toolCallId) return undefined;
  const stepId = `tool:${approval.toolCallId}`;
  return activity.runs.find((run) => run.steps.some((step) => step.id === stepId));
}

function syncSteps(run: Run, approval: ApprovalCard): Run {
  const index = approval.stepId ? run.steps.findIndex((step) => step.id === approval.stepId) : -1;
  const step: Step | undefined = index === -1 ? undefined : run.steps[index];
  if (!step) return run;
  let replacement: Step | null = null;
  if (approval.status === "pending" && step.status === "running") {
    replacement = { ...step, status: "waiting", approvalId: approval.id };
  } else if (
    approval.status !== "pending" &&
    step.status === "waiting" &&
    step.approvalId === approval.id
  ) {
    replacement = { ...step, status: "running" };
  } else if (step.approvalId === null && (approval.status !== "pending" || !isOpenStep(step))) {
    // Keep the link, so the step can say which approval it waited on.
    replacement = { ...step, approvalId: approval.id };
  }
  if (!replacement) return run;
  const steps = [...run.steps];
  steps[index] = replacement;
  return { ...run, steps };
}

/** The resolve call for an approval's kind, with its parameters. */
export function resolveRequest(
  approval: ApprovalCard,
  chosen: ApprovalDecision,
  expiresInDays: number | null,
): { method: string; params: RawRecord } {
  const grant =
    chosen === "allow-always" && expiresInDays !== null
      ? { grantExpiresInDays: expiresInDays }
      : {};
  switch (approval.kind) {
    case "exec":
      return {
        method: "exec.approval.resolve",
        params: { id: approval.id, decision: chosen, ...grant },
      };
    case "plugin":
      // `PluginApprovalResolveParams` has no grant duration.
      return { method: "plugin.approval.resolve", params: { id: approval.id, decision: chosen } };
    case "system-agent":
      return {
        method: "approval.resolve",
        params: { id: approval.id, kind: "system-agent", decision: chosen, ...grant },
      };
  }
}
