// Approvals: exec, plugin and the generic kind (capability map row 8, schema
// `ApprovalSnapshot`, `ExecApprovalResolveParams`, `ApprovalResolveParams`).
// An approval that names its tool call is that step's own waiting status; one
// that names no step is its own card. Everything here needs `operator.approvals`.

import { asRecord, type RawRecord } from "./mapping.ts";
import { findRun, isOpenStep, isTerminal, type Run, type Step, type TaskActivity } from "./runs.ts";

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
  proposalHash: string | null;
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
  resolvedBy: string | null;
  /** The decisions the gateway offers. Always contains `deny`. */
  allowedDecisions: ApprovalDecision[];
  exec: ExecApprovalDetail | null;
  plugin: PluginApprovalDetail | null;
  systemAgent: SystemAgentApprovalDetail | null;
  /** The approval's `scope` (message send, payment, external post, standing grant), as sent. */
  scope: unknown;
  /** A resolution from this client is on its way, or the last one failed. */
  submitting: boolean;
  error: string | null;
  /** The record as received. */
  raw: unknown;
};

/** Whether this connection can see approvals at all. Read-only connections cannot: that is not "none". */
export type ApprovalAccess = "unavailable" | "loading" | "ready" | "error";

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

/** The offered decisions, in a fixed order. Deny is always possible. */
function decisions(value: unknown): ApprovalDecision[] {
  const offered = new Set(
    (Array.isArray(value) ? value : [])
      .map(decision)
      .filter((d): d is ApprovalDecision => d !== null),
  );
  if (offered.size === 0) {
    offered.add("allow-once");
    offered.add("allow-always");
  }
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
    allowedDecisions: decisions(undefined),
    exec: null,
    plugin: null,
    systemAgent: null,
    scope: null,
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
    allowedDecisions: decisions(request.allowedDecisions),
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
    allowedDecisions: decisions(request.allowedDecisions),
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
 * A generic `ApprovalSnapshot` (`openclaw.approval.*`, `approval.get`), or an
 * event that wraps one as `approval`. A snapshot names no run or tool call, so
 * it never links to a step on its own; it merges into an exec or plugin record
 * with the same id.
 */
export function parseApprovalSnapshot(
  value: unknown,
  sessionKey?: string | null,
): ApprovalCard | null {
  const outer = asRecord(value);
  const record = asRecord(outer?.approval) ?? outer;
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
  const card: ApprovalCard = {
    ...blank(id, kind, value),
    sessionKey: sessionKey ?? str(outer?.sessionKey) ?? str(record.sourceSessionKey),
    agentId: str(presentation.agentId),
    createdAt: num(record.createdAtMs),
    expiresAt: num(record.expiresAtMs),
    allowedDecisions: decisions(presentation.allowedDecisions),
    scope: presentation.scope ?? null,
  };
  if (kind === "exec") {
    card.exec = {
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
    card.resolvedBy = str(asRecord(record.resolver)?.label) ?? str(record.resolver);
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
};

/**
 * `exec.approval.resolved` / `plugin.approval.resolved`: `{id, decision,
 * resolvedBy, ts, request}`. A generic snapshot event is read for its status.
 */
export function parseApprovalResolved(value: unknown): ApprovalResolution | null {
  const record = asRecord(value);
  const snapshot = parseApprovalSnapshot(value);
  if (snapshot && snapshot.status !== "pending") {
    return {
      id: snapshot.id,
      status: snapshot.status,
      decision: snapshot.decision,
      reason: snapshot.reason,
      resolvedAt: snapshot.resolvedAt,
      resolvedBy: snapshot.resolvedBy,
    };
  }
  const id = str(record?.id);
  const chosen = decision(record?.decision);
  if (!record || !id || !chosen) return null;
  return {
    id,
    status: chosen === "deny" ? "denied" : "allowed",
    decision: chosen,
    reason: str(record.reason),
    resolvedAt: num(record.ts),
    resolvedBy: str(record.resolvedBy) ?? str(asRecord(record.resolvedBy)?.label),
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

export function applyApprovalResolved(
  activity: TaskActivity,
  resolution: ApprovalResolution,
): TaskActivity {
  const existing = activity.approvals.find((each) => each.id === resolution.id);
  if (!existing || existing.status !== "pending") return activity;
  const approvals = activity.approvals.map((each) =>
    each.id === resolution.id
      ? {
          ...each,
          status: resolution.status,
          decision: resolution.decision,
          reason: resolution.reason,
          resolvedAt: resolution.resolvedAt,
          resolvedBy: resolution.resolvedBy,
          submitting: false,
          error: null,
        }
      : each,
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

/** Pending approvals past their `expiresAt` expire. The gateway does not run them. */
export function expireApprovals(activity: TaskActivity, now: number): TaskActivity {
  let next = activity;
  for (const approval of activity.approvals) {
    if (approval.status === "pending" && approval.expiresAt !== null && approval.expiresAt <= now) {
      next = applyApprovalResolved(next, {
        id: approval.id,
        status: "expired",
        decision: null,
        reason: "timeout",
        resolvedAt: approval.expiresAt,
        resolvedBy: null,
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
): TaskActivity {
  let next = activity;
  for (const approval of activity.approvals) {
    if (
      approval.status === "pending" &&
      kinds.includes(approval.kind) &&
      !listed.has(approval.id)
    ) {
      next = applyApprovalResolved(next, {
        id: approval.id,
        status: "closed",
        decision: null,
        reason: "no-longer-listed",
        resolvedAt: null,
        resolvedBy: null,
      });
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
export function normalizeApprovals(activity: TaskActivity): TaskActivity {
  if (activity.approvals.length === 0) return activity;
  let runs = activity.runs;
  let changed = false;
  const approvals = activity.approvals.map((approval) => {
    const run = runFor({ ...activity, runs }, approval);
    const stepId = approval.toolCallId ? `tool:${approval.toolCallId}` : null;
    const linked =
      run && stepId && run.steps.some((step) => step.id === stepId) ? stepId : approval.stepId;
    const runEnded = approval.status === "pending" && run !== undefined && isTerminal(run.state);
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
