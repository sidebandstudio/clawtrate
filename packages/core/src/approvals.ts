// Approvals: exec, plugin and the generic kind (capability map row 8, schema
// `ApprovalSnapshot`, `ExecApprovalResolveParams`, `ApprovalResolveParams`).
// An approval that names its tool call is that step's own waiting status; one
// that names no step is its own card. Everything here needs `operator.approvals`.

import { digestKey, digestOf, enforce } from "./bounds.ts";
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
import { APPROVAL } from "./state-bounds.ts";

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
   * A digest of the whole text the reviewer decides on (exec: command, argv
   * and directory; plugin: title, description and detail; system-agent:
   * title, description and command), taken before anything was cut to its
   * bound. When any of that text was cut (`cut`), the card can only be
   * denied until the full text has been read (`readApprovalText`) and the
   * allow names this digest.
   */
  decisionDigest: string;
  /**
   * What the reviewer is asked to allow was cut to its bound when this card
   * was admitted. Set once, at admission, apart from the diagnostic `cut`
   * list (whose entries later cuts can displace); nothing clears it. While it
   * is set only deny is accepted, unless the viewer deciding has read the
   * whole text (`readApprovalText`) and names its digest.
   */
  decisionCut: boolean;
  /** Paths of fields cut to their bound, for diagnosis; never the safety fact. */
  cut?: string[];
  /** A resolution from this client is on its way, or the last one failed. */
  submitting: boolean;
  /** The latest decision on its way while `submitting`; a Deny may still follow an allow. */
  submittingDecision: ApprovalDecision | null;
  /**
   * The number of the latest attempt for this approval. Every decision sent
   * and every read-back sent takes the next number; a response settles only
   * the attempt it belongs to.
   */
  attempt: number;
  /** Decisions on their way, by attempt: at most an allow and a Deny that followed it. */
  inFlight: DecisionAttempt[];
  /**
   * The attempt number current when the latest unknown outcome was
   * established. Only a read-back numbered above it, answered before any newer
   * attempt began, can clear it. Null when no outcome is unknown.
   */
  unknownAt: number | null;
  /** A Deny is among the decisions whose outcome is unknown: no Deny is sent again until read back. */
  unknownDeny: boolean;
  /** The attempt number of the latest read-back still on its way, or null. */
  readingAt: number | null;
  error: string | null;
  /**
   * What the last failed resolution from this client establishes. `refused`:
   * the gateway answered with an error, so it did not apply that decision;
   * it does not say the request is still open. `unknown`: no answer came
   * after the decision was sent, so it may or may not have been applied, and
   * no allow is accepted until the request's state has been read back
   * (`checkApproval`). Null when nothing failed, or nothing was sent.
   */
  decisionError: "refused" | "unknown" | null;
  /** A read-back after a refused decision found the request still pending. */
  stillOpen: boolean;
  /** The record as received. */
  raw: unknown;
};

/**
 * Whether this connection can see approvals at all. Read-only connections
 * cannot: that is not "none". `partial` means some kinds' lists loaded and
 * others failed (`approvalSources` says which); an incomplete list is not "no
 * approvals".
 */
/** One decision this client sent for an approval, and the attempt number it carries. */
export type DecisionAttempt = { attempt: number; decision: ApprovalDecision };

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
    decisionDigest: "",
    decisionCut: false,
    submitting: false,
    submittingDecision: null,
    attempt: 0,
    inFlight: [],
    unknownAt: null,
    unknownDeny: false,
    readingAt: null,
    error: null,
    decisionError: null,
    stillOpen: false,
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
  return withDecisionDigest({
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
  });
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
  return withDecisionDigest({
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
  });
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
  return withDecisionDigest({
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
  });
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
  return withDecisionDigest(card);
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
        submittingDecision: existing.submittingDecision,
        attempt: existing.attempt,
        inFlight: existing.inFlight,
        unknownAt: existing.unknownAt,
        unknownDeny: existing.unknownDeny,
        readingAt: existing.readingAt,
        error: existing.error,
        decisionError: existing.decisionError,
        stillOpen: existing.stillOpen,
        raw: existing.kind === card.kind && existing.raw ? existing.raw : card.raw,
        // Fields the earlier card set are kept, so its cut text may be what shows: the flag stays.
        decisionCut: existing.decisionCut || card.decisionCut,
      }
    : card;
  const approvals = existing
    ? activity.approvals.map((each) => (each.id === card.id ? merged : each))
    : [...activity.approvals, merged];
  return normalizeApprovals({ ...activity, approvals });
}

/**
 * The whole text a reviewer decides on, as the request gives it: what an exec
 * approval will run and where, what a plugin approval describes, what change
 * a system-agent approval makes. Read in full by `readApprovalText`.
 */
export function decisionText(card: ApprovalCard): Record<string, string | string[] | null> {
  if (card.exec) {
    return { command: card.exec.command, commandArgv: card.exec.commandArgv, cwd: card.exec.cwd };
  }
  if (card.plugin) {
    return {
      title: card.plugin.title,
      description: card.plugin.description,
      detail: card.plugin.detail,
    };
  }
  if (card.systemAgent) {
    return {
      title: card.systemAgent.title,
      description: card.systemAgent.description,
      command: card.systemAgent.command,
    };
  }
  return {};
}

/**
 * An approval as the host keeps it: within its bound (`APPROVAL`), and with
 * `decisionCut` set when that bound cut what the reviewer decides on. Every
 * card the client keeps, shown or waiting unrouted, is this value; the whole
 * text is never kept beside it.
 */
export function admitApproval(card: ApprovalCard): ApprovalCard {
  const bounded = enforce(APPROVAL, card);
  const cut =
    card.decisionCut ||
    JSON.stringify(decisionText(bounded)) !== JSON.stringify(decisionText(card));
  return cut === bounded.decisionCut ? bounded : { ...bounded, decisionCut: cut };
}

/** A card with the digest of its whole decision text, taken before anything is cut. */
function withDecisionDigest(card: ApprovalCard): ApprovalCard {
  return { ...card, decisionDigest: digestKey(digestOf(JSON.stringify(decisionText(card)))) };
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
      submittingDecision: null,
      inFlight: [],
      unknownAt: null,
      unknownDeny: false,
      readingAt: null,
      error: null,
      decisionError: null,
      stillOpen: false,
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

// Decision attempts ----------------------------------------------------------------

/**
 * Why a decision may not be sent now, or null when it may. At most one
 * decision is on its way, except that a Deny may follow an allow still on its
 * way. No allow leaves while any outcome is unknown, and no Deny leaves again
 * while an earlier Deny's outcome is unknown.
 */
export function decisionRefusal(card: ApprovalCard, decision: ApprovalDecision): string | null {
  if (card.status !== "pending") return "That approval is no longer open.";
  if (card.inFlight.length > 0) {
    const denyAfterAllow =
      decision === "deny" && card.inFlight.every((each) => each.decision !== "deny");
    if (!denyAfterAllow) return "An answer to that approval is already on its way.";
  }
  if (decision !== "deny" && card.decisionError === "unknown") {
    return "Whether the last decision was applied is not known yet; check the request again first.";
  }
  if (decision === "deny" && card.unknownDeny) {
    return "Whether the last Deny was applied is not known yet; check the request again first.";
  }
  return null;
}

function patchApproval(
  activity: TaskActivity,
  id: string,
  change: (card: ApprovalCard) => ApprovalCard,
): TaskActivity {
  return {
    ...activity,
    approvals: activity.approvals.map((each) => (each.id === id ? change(each) : each)),
  };
}

/** What is on its way, as the card shows it. */
function withInFlight(card: ApprovalCard, inFlight: DecisionAttempt[]): ApprovalCard {
  return {
    ...card,
    inFlight,
    submitting: inFlight.length > 0,
    submittingDecision: inFlight.at(-1)?.decision ?? null,
  };
}

/** Set the error a card shows, and nothing else. */
export function patchError(activity: TaskActivity, id: string, error: string | null): TaskActivity {
  return patchApproval(activity, id, (card) => ({ ...card, error }));
}

/** A decision is sent: it takes the next attempt number. An unknown outcome stays unknown. */
export function beginDecision(
  activity: TaskActivity,
  id: string,
  decision: ApprovalDecision,
): { activity: TaskActivity; attempt: number } {
  const card = activity.approvals.find((each) => each.id === id);
  const attempt = (card?.attempt ?? 0) + 1;
  return {
    attempt,
    activity: patchApproval(activity, id, (each) => ({
      ...withInFlight({ ...each, attempt }, [...each.inFlight, { attempt, decision }]),
      error: null,
      decisionError: each.decisionError === "unknown" ? "unknown" : null,
      stillOpen: false,
    })),
  };
}

/**
 * A decision's own response. It settles only its attempt: an answer that the
 * decision was refused, that its outcome is unknown, or that it never left.
 * A settled card only forgets the attempt.
 */
export function endDecision(
  activity: TaskActivity,
  id: string,
  attempt: number,
  outcome: "refused" | "unknown" | "not-sent" | "answered",
  error: string | null,
): TaskActivity {
  return patchApproval(activity, id, (card) => {
    const own = card.inFlight.find((each) => each.attempt === attempt);
    const next = withInFlight(
      card,
      card.inFlight.filter((each) => each.attempt !== attempt),
    );
    if (card.status !== "pending" || outcome === "answered") return next;
    if (outcome === "unknown") {
      return {
        ...next,
        decisionError: "unknown",
        unknownAt: card.attempt,
        unknownDeny: card.unknownDeny || own?.decision === "deny",
        stillOpen: false,
        error,
      };
    }
    if (outcome === "refused" && card.decisionError !== "unknown") {
      return { ...next, decisionError: "refused", stillOpen: false, error };
    }
    // Refused while another outcome is unknown: the unknown one decides what may be sent.
    return { ...next, error };
  });
}

/** A read-back is sent: it takes the next attempt number. */
export function beginReadback(
  activity: TaskActivity,
  id: string,
): { activity: TaskActivity; attempt: number } {
  const card = activity.approvals.find((each) => each.id === id);
  const attempt = (card?.attempt ?? 0) + 1;
  return {
    attempt,
    activity: patchApproval(activity, id, (each) => ({ ...each, attempt, readingAt: attempt })),
  };
}

/** A read-back's answer arrived, or it failed: it is no longer on its way. */
export function endReadback(activity: TaskActivity, id: string, attempt: number): TaskActivity {
  return patchApproval(activity, id, (each) =>
    each.readingAt === attempt ? { ...each, readingAt: null } : each,
  );
}

/**
 * A read-back answered that the request is still pending. It applies only if
 * no newer attempt began since it was sent; then it clears an unknown outcome
 * established before it was sent, and marks a refusal still open. `stale`
 * says it was dropped.
 */
export function readbackPending(
  activity: TaskActivity,
  id: string,
  attempt: number,
): { activity: TaskActivity; stale: boolean } {
  const card = activity.approvals.find((each) => each.id === id);
  if (!card || card.status !== "pending" || card.attempt !== attempt) {
    return { activity, stale: true };
  }
  return {
    stale: false,
    activity: patchApproval(activity, id, (each) => {
      if (each.unknownAt !== null && attempt > each.unknownAt) {
        return {
          ...each,
          decisionError: null,
          unknownAt: null,
          unknownDeny: false,
          stillOpen: false,
          error: null,
        };
      }
      return each.decisionError === "refused" ? { ...each, stillOpen: true } : each;
    }),
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
