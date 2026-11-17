// Card scenes for the fixture mode: one for every state of the approval,
// question and Messaged cards. Each is built the way the engine builds it:
// gateway-shaped events and records go through the engine's own reducers, so
// the cards draw from the state shapes a real connection produces. All bots,
// machines and text here are invented.

import {
  admitApproval,
  applyAgentEvent,
  applyApprovalRequested,
  applyApprovalResolved,
  applyQuestionRequested,
  applyQuestionResolved,
  markQuestion,
  emptyActivity,
  beginDecision,
  beginReadback,
  endDecision,
  endReadback,
  patchError,
  readbackPending,
  normalizeApprovals,
  parseExecApproval,
  parsePluginApproval,
  RawTable,
  type ApprovalResolution,
  type SettlingRecord,
  type ClawtrateState,
  type EngineContext,
  type LinkedRun,
  type Task,
  type TaskActivity,
  type Transcript,
  type TranscriptItem,
} from "@clawtrate/core";

export const CARD_TASK = "agent:otto:transcode-cache";
export const RECEIVING_TASK = "agent:marlow:house-log";
export const CARD_RUN = "run_7f3a91c2";
const USER_ITEM = "u-7f3a:0";
const MINUTE = 60_000;

/**
 * The tool server T3 Code is on in the card scenes. The cards know it is T3
 * Code from the tool's published name, not from this name.
 */
export const T3_SERVER = "t3code";

export const CARD_SCENES = [
  "approval-pending",
  "approval-allow-only",
  "approval-routine",
  "approval-sending",
  "approval-refused",
  "approval-unknown",
  "approval-cut",
  "approval-run-ended",
  "approval-helper",
  "approval-messaged",
  "approval-readonly",
  "approval-plugin",
  "approval-allowed-once",
  "approval-always-allowlist",
  "approval-always-routine",
  "approval-denied",
  "approval-expired",
  "approval-cancelled",
  "approval-closed-ended",
  "approval-closed-failed",
  "approval-closed-unknown",
  "approval-winner",
  "question-single",
  "question-multi",
  "question-three",
  "question-unanswerable",
  "question-readonly",
  "question-answered",
  "question-answered-typed",
  "question-answered-multi",
  "question-dismissed",
  "question-expired",
  "question-cancelled",
  "question-closed-ended",
  "question-closed-failed",
  "messaged-started",
  "messaged-approval",
  "messaged-sent",
  "messaged-working",
  "messaged-recipient-waiting",
  "messaged-no-reply",
  "messaged-no-reply-timeout",
  "messaged-replied",
  "messaged-recipient-stopped",
  "messaged-recipient-failed",
  "messaged-failed",
  "messaged-blocked",
  "messaged-not-sent",
  "messaged-unknown",
  "messaged-last-seen",
  "messaged-return",
  "received-working",
  "received-waiting",
  "received-completed",
  "received-failed",
  "received-stopped",
  "incoming-line",
  "t3-started",
  "t3-approval",
  "t3-call-made",
  "t3-work-may-continue",
  "t3-delivery-unknown",
  "t3-failed",
  "t3-not-sent",
] as const;

export type CardSceneName = (typeof CARD_SCENES)[number];

/** How the fixture answers a decision on an approval in this scene. */
export type DecisionMode = "apply" | "refuse" | "silent";

export type CardScene = {
  /** The task the scene opens. */
  task: string;
  change: (state: ClawtrateState) => ClawtrateState;
  decisions: DecisionMode;
};

// Events --------------------------------------------------------------------------

class Builder {
  activity: TaskActivity = emptyActivity;
  private seq = 0;
  private readonly raw = new RawTable();
  private readonly key: string;
  private readonly now: number;
  constructor(key: string, now: number) {
    this.key = key;
    this.now = now;
  }

  ctx(): EngineContext {
    return { sessionKey: this.key, now: this.now, raw: this.raw };
  }

  event(stream: string, data: Record<string, unknown>, at: number, runId = CARD_RUN): this {
    this.seq += 1;
    this.activity = applyAgentEvent(
      this.activity,
      { runId, seq: this.seq, stream, ts: at, sessionKey: this.key, data },
      this.ctx(),
    ).activity;
    return this;
  }

  start(at: number, runId = CARD_RUN): this {
    return this.event("lifecycle", { phase: "start", startedAt: at }, at, runId);
  }

  end(at: number, phase: "end" | "error" = "end", data: Record<string, unknown> = {}): this {
    return this.event("lifecycle", { phase, endedAt: at, ...data }, at);
  }

  toolStart(name: string, id: string, args: Record<string, unknown>, at: number): this {
    return this.event("tool", { phase: "start", name, toolCallId: id, args }, at);
  }

  toolResult(
    name: string,
    id: string,
    result: { content: unknown[]; details?: Record<string, unknown> },
    at: number,
    isError = false,
  ): this {
    return this.event("tool", { phase: "result", name, toolCallId: id, isError, result }, at);
  }

  update(change: (activity: TaskActivity) => TaskActivity): this {
    this.activity = change(this.activity);
    return this;
  }

  question(record: Record<string, unknown>): this {
    this.activity = applyQuestionRequested(this.activity, record, this.ctx());
    return this;
  }
}

const text = (value: string) => [{ type: "text", text: value }];

// Approvals -----------------------------------------------------------------------

const COMMAND = "mv /srv/media/transcode-cache /srv/scratch/transcode-cache";
/** Longer than the engine keeps of a command, so only Deny is offered until it is read whole. */
const LONG_COMMAND = `${COMMAND} && ${Array.from({ length: 400 }, (_, i) => `touch /srv/scratch/marker-${i}`).join(" && ")}`;

function execRecord(now: number, request: Record<string, unknown> = {}) {
  return {
    id: "apr_5d2a",
    request: {
      command: COMMAND,
      commandArgv: ["mv", "/srv/media/transcode-cache", "/srv/scratch/transcode-cache"],
      cwd: "/srv/media",
      host: "node",
      nodeId: "media-box",
      security: "allowlist",
      ask: "on-miss",
      agentId: "otto",
      sessionKey: CARD_TASK,
      runId: CARD_RUN,
      toolCallId: "call_mv",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      commandAnalysis: {
        commandCount: 1,
        nestedCommandCount: 0,
        riskKinds: ["filesystem-move"],
        warningLines: ["This can't be undone"],
      },
      warningText: "Moves a folder outside Otto's own workspace.",
      ...request,
    },
    createdAtMs: now - 2 * MINUTE,
    expiresAtMs: now + 28 * MINUTE,
  };
}

/** A run that asked to run a command and waits on its approval. */
function waitingApproval(
  now: number,
  request: Record<string, unknown> = {},
  record: (now: number, request: Record<string, unknown>) => unknown = execRecord,
): Builder {
  const b = new Builder(CARD_TASK, now);
  b.start(now - 3 * MINUTE)
    .toolStart("exec", "call_mv", { command: COMMAND }, now - 2 * MINUTE - 1000)
    .event("lifecycle", { phase: "waiting-approval", approvalId: "apr_5d2a" }, now - 2 * MINUTE);
  const raw = record(now, request);
  const parsed = record === execRecord ? parseExecApproval(raw) : parsePluginApproval(raw);
  if (parsed) b.update((activity) => applyApprovalRequested(activity, admitApproval(parsed)));
  return b;
}

/** A read-back of the approval found it still pending, as the engine applies it. */
function stillPending(activity: TaskActivity): TaskActivity {
  const begun = beginReadback(activity, "apr_5d2a");
  const read = readbackPending(begun.activity, "apr_5d2a", begun.attempt);
  return endReadback(read.activity, "apr_5d2a", begun.attempt);
}

/**
 * The event the gateway sends when a decision settles an exec request,
 * `{id, decision, resolvedBy, ts, request}`, as `exec.approval.resolved` carries it.
 */
function resolvedEvent(
  id: string,
  decision: string,
  at: number,
  resolvedBy: string | null,
  request: Record<string, unknown> = {},
): SettlingRecord {
  return {
    via: "exec.approval.resolved",
    record: {
      id,
      decision,
      resolvedBy,
      ts: at,
      request: {
        command: COMMAND,
        cwd: "/srv/media",
        host: "node",
        nodeId: "media-box",
        agentId: "otto",
        sessionKey: CARD_TASK,
        runId: CARD_RUN,
        toolCallId: "call_mv",
        ...request,
      },
    },
  };
}

function resolution(
  status: ApprovalResolution["status"],
  decision: ApprovalResolution["decision"],
  at: number,
  extra: Partial<ApprovalResolution> = {},
): ApprovalResolution {
  return {
    id: "apr_5d2a",
    status,
    decision,
    reason: "user",
    resolvedAt: at,
    resolvedBy: null,
    resolver: null,
    applicationStatus: null,
    authoritative: true,
    lossy: false,
    sessionKey: CARD_TASK,
    runId: CARD_RUN,
    // A decision's outcome arrives as the gateway's event; an expiry or cancellation here has none.
    records: decision ? [resolvedEvent("apr_5d2a", decision, at, extra.resolvedBy ?? null)] : [],
    ...extra,
  };
}

const settle = (r: ApprovalResolution) => (activity: TaskActivity) =>
  applyApprovalResolved(activity, r);

function pluginRecord(now: number) {
  return {
    id: "apr_5d2a",
    request: {
      title: "post to the house noticeboard",
      description: "Post this week's backup summary to the house noticeboard.",
      detail: "Backups for the week of Nov 9 finished. 3 of 3 machines, 41 GB in total.",
      severity: "warning",
      pluginId: "noticeboard",
      toolName: "noticeboard_post",
      agentId: "otto",
      sessionKey: CARD_TASK,
      runId: CARD_RUN,
      toolCallId: "call_mv",
      allowedDecisions: ["allow-once", "deny"],
    },
    createdAtMs: now - 2 * MINUTE,
    expiresAtMs: now + 28 * MINUTE,
  };
}

// Questions -----------------------------------------------------------------------

const KEEP = {
  questionId: "keep_cache",
  header: "Keep cache",
  question: "How long should I keep the cache in /srv/scratch before deleting it?",
  options: [
    { label: "A week", description: "Delete it next Monday" },
    { label: "A month" },
    { label: "Until I say so", description: "Keep it and remind me" },
    { label: "Delete it now" },
  ],
  isOther: true,
};

const MACHINES = {
  questionId: "machines",
  header: "Machines",
  question: "Which machines should the weekly check cover?",
  options: [{ label: "media-box" }, { label: "garage-pi" }, { label: "attic-nas" }],
  multiSelect: true,
  isOther: true,
};

const WHEN = {
  questionId: "when",
  header: "When",
  question: "When should it run?",
  options: [{ label: "Sunday night" }, { label: "Monday morning" }],
  isOther: true,
};

function questionRecord(now: number, questions: unknown[]) {
  return {
    id: "qst_81f0",
    questions,
    agentId: "otto",
    sessionKey: CARD_TASK,
    runId: CARD_RUN,
    createdAtMs: now - MINUTE,
    expiresAtMs: now + 14 * MINUTE,
    status: "pending",
  };
}

function asked(now: number, questions: unknown[] = [KEEP]): Builder {
  return new Builder(CARD_TASK, now)
    .start(now - 3 * MINUTE)
    .question(questionRecord(now, questions));
}

/** The gateway's `question.resolved` event, `{id, status, answers?}`, applied as the engine applies it. */
export const questionEvent =
  (payload: { id: string; status: string; answers?: unknown }) => (activity: TaskActivity) =>
    applyQuestionResolved(activity, payload, { via: "question.resolved", record: payload });

/** Answered from this app: what it sent, the gateway's reply, and its event. */
const answer = (answers: Record<string, string[]>) => (activity: TaskActivity) => {
  const params = { id: "qst_81f0", answers: { answers } };
  const sent = markQuestion(activity, "qst_81f0", {
    submitting: true,
    error: null,
    sent: { method: "question.resolve", params },
  });
  const replied = applyQuestionResolved(
    sent,
    { id: "qst_81f0", status: "answered", answers: { answers } },
    { via: "question.resolve", record: { status: "answered", answers: { answers } } },
  );
  return questionEvent({ id: "qst_81f0", status: "answered", answers: { answers } })(replied);
};

// Messages to other bots ----------------------------------------------------------

const MARLOW_KEY = RECEIVING_TASK;
const MARLOW_RUN = "run_m42b";
const SENT =
  "Write a two-line entry for the house log: the weekly backup finished, 41 GB across three machines.";
const REPLY =
  "Nov 16 — Weekly backup finished cleanly.\n41 GB across media-box, garage-pi and attic-nas.";

function messaged(now: number, b = new Builder(CARD_TASK, now).start(now - 3 * MINUTE)): Builder {
  return b.toolStart(
    "sessions_send",
    "call_msg",
    { sessionKey: MARLOW_KEY, message: SENT, timeoutSeconds: 120 },
    now - 2 * MINUTE,
  );
}

function sendResult(b: Builder, now: number, details: Record<string, unknown>, isError = false) {
  return b.toolResult(
    "sessions_send",
    "call_msg",
    { content: text(JSON.stringify(details)), details },
    now - MINUTE,
    isError,
  );
}

function linked(state: LinkedRun["state"], now: number): Record<string, LinkedRun> {
  return {
    [MARLOW_RUN]: {
      id: MARLOW_RUN,
      sessionKey: MARLOW_KEY,
      state,
      outcomeKnown: true,
      startedAt: now - 2 * MINUTE,
      endedAt: state === "running" || state === "waiting" ? null : now - 30_000,
    },
  };
}

// T3 Code -------------------------------------------------------------------------

/** T3 Code's own tool, as the gateway names a simple server's tool. */
const T3_TOOL = `${T3_SERVER}__t3_thread_launch`;
const T3_SENT =
  "In backup-scripts, make the weekly check skip machines that are asleep instead of failing, and add a test for it.";

function t3Call(now: number, b = new Builder(CARD_TASK, now).start(now - 3 * MINUTE)): Builder {
  return b.toolStart(
    T3_TOOL,
    "call_t3",
    {
      environmentId: "local",
      projectId: "backup-scripts",
      title: "Skip machines that are asleep",
      workspaceStrategy: { type: "root", branch: "main" },
      message: T3_SENT,
    },
    now - 2 * MINUTE,
  );
}

function t3Result(b: Builder, now: number, isError = false) {
  return b.toolResult(
    T3_TOOL,
    "call_t3",
    isError
      ? {
          content: text("connect ECONNREFUSED: the coding agent's server did not answer"),
          details: { mcpServer: T3_SERVER, mcpTool: "t3_thread_launch" },
        }
      : {
          content: [
            ...text("Started thread 18 in backup-scripts on main. Working on the change now."),
            {
              type: "resource",
              resource: { name: "plan.md", mimeType: "text/markdown", uri: "file:///plan.md" },
            },
          ],
          details: {
            mcpServer: T3_SERVER,
            mcpTool: "t3_thread_launch",
            structuredContent: {
              threadId: "thread-18",
              link: "https://t3.example.test/projects/backup-scripts/threads/18",
              projectId: "backup-scripts",
              runId: "run-t3-1",
              status: "starting",
            },
          },
        },
    now - MINUTE,
    isError,
  );
}

function t3Approval(now: number) {
  return {
    id: "apr_t3",
    request: {
      title: "message T3 Code",
      description: "Send work to T3 Code in backup-scripts.",
      pluginId: "mcp-approvals",
      toolName: T3_TOOL,
      agentId: "otto",
      sessionKey: CARD_TASK,
      runId: CARD_RUN,
      toolCallId: "call_t3",
      allowedDecisions: ["allow-once", "deny"],
    },
    createdAtMs: now - 2 * MINUTE,
    expiresAtMs: now + 28 * MINUTE,
  };
}

function msgApproval(now: number) {
  return {
    id: "apr_msg",
    request: {
      title: "message Marlow",
      description: "Send a message to Marlow's task House log.",
      pluginId: "messaging",
      toolName: "sessions_send",
      agentId: "otto",
      sessionKey: CARD_TASK,
      runId: CARD_RUN,
      toolCallId: "call_msg",
      allowedDecisions: ["allow-once", "deny"],
    },
    createdAtMs: now - 2 * MINUTE,
    expiresAtMs: now + 28 * MINUTE,
  };
}

const requested = (record: unknown) => (activity: TaskActivity) => {
  const card = parsePluginApproval(record);
  return card ? applyApprovalRequested(activity, admitApproval(card)) : activity;
};

// The scenes ----------------------------------------------------------------------

function build(
  name: CardSceneName,
  now: number,
): { b: Builder; extra?: Partial<Transcript>; task?: string } {
  const ago = (minutes: number) => now - minutes * MINUTE;
  switch (name) {
    case "approval-pending":
      return { b: waitingApproval(now) };
    case "approval-allow-only":
      return {
        b: waitingApproval(now, {
          allowedDecisions: ["allow-once", "deny"],
          unavailableDecisions: ["allow-always"],
        }),
      };
    case "approval-routine":
      return {
        b: waitingApproval(now, {
          scope: {
            kind: "standing-grant",
            automation: "Weekly cleanup",
            command: COMMAND,
            expiresInDays: 7,
          },
        }),
      };
    case "approval-sending":
      return {
        b: waitingApproval(now).update((a) => beginDecision(a, "apr_5d2a", "allow-once").activity),
      };
    case "approval-refused":
      return {
        b: waitingApproval(now).update((a) =>
          stillPending(
            endDecision(
              beginDecision(a, "apr_5d2a", "allow-always").activity,
              "apr_5d2a",
              1,
              "refused",
              "allow-always is unavailable for this command",
            ),
          ),
        ),
      };
    case "approval-unknown":
      return {
        b: waitingApproval(now).update((a) =>
          endDecision(
            beginDecision(a, "apr_5d2a", "allow-once").activity,
            "apr_5d2a",
            1,
            "unknown",
            "The gateway did not answer within 60 seconds.",
          ),
        ),
      };
    case "approval-cut":
      return { b: waitingApproval(now, { command: LONG_COMMAND, commandArgv: null }) };
    case "approval-run-ended":
      // A detached command: the run returned at once and ended, the request is still pending.
      return {
        b: waitingApproval(now)
          .toolResult("exec", "call_mv", { content: text("approval-pending") }, ago(1))
          .end(ago(1)),
      };
    case "approval-helper":
      return {
        b: waitingApproval(now).update((a) => ({
          ...a,
          approvals: a.approvals.map((card) => ({ ...card, relation: "helper" as const })),
        })),
      };
    case "approval-messaged":
      return {
        b: waitingApproval(now, { agentId: "marlow" }).update((a) => ({
          ...a,
          approvals: a.approvals.map((card) => ({
            ...card,
            relation: "messaged" as const,
            parentSessionKey: CARD_TASK,
          })),
        })),
      };
    case "approval-readonly":
      return { b: waitingApproval(now) };
    case "approval-plugin":
      return { b: waitingApproval(now, {}, pluginRecord as never) };
    case "approval-allowed-once":
      return {
        b: waitingApproval(now).update(settle(resolution("allowed", "allow-once", ago(1)))),
      };
    case "approval-always-allowlist":
      return {
        b: waitingApproval(now).update(settle(resolution("allowed", "allow-always", ago(1)))),
      };
    case "approval-always-routine":
      return {
        b: waitingApproval(now, {
          scope: {
            kind: "standing-grant",
            automation: "Weekly cleanup",
            command: COMMAND,
            expiresInDays: 7,
          },
        }).update(settle(resolution("allowed", "allow-always", ago(1)))),
      };
    case "approval-denied":
      return { b: waitingApproval(now).update(settle(resolution("denied", "deny", ago(1)))) };
    case "approval-expired":
      return {
        b: waitingApproval(now).update(
          settle(resolution("expired", null, ago(1), { reason: "timeout" })),
        ),
      };
    case "approval-cancelled":
      return {
        b: waitingApproval(now)
          .update((a) => ({
            ...a,
            runs: a.runs.map((run) => ({ ...run, stopRequestedAt: ago(1) })),
          }))
          .end(ago(1), "end", { aborted: true, stopReason: "aborted" })
          .update(settle(resolution("cancelled", null, ago(1), { reason: "run-aborted" }))),
      };
    case "approval-closed-ended":
      return {
        b: waitingApproval(now)
          .toolResult("exec", "call_mv", { content: text("approval-pending") }, ago(1))
          .end(ago(1))
          .update(
            settle(
              resolution("closed", null, ago(1), { lossy: true, reason: "settled-cause-unknown" }),
            ),
          ),
      };
    case "approval-closed-failed":
      return {
        b: waitingApproval(now)
          .end(ago(1), "error", {
            error: "The model provider is overloaded.",
            executionSettled: true,
          })
          .update(
            settle(
              resolution("closed", null, ago(1), { lossy: true, reason: "settled-cause-unknown" }),
            ),
          ),
      };
    case "approval-closed-unknown":
      return {
        b: waitingApproval(now).update(
          settle(
            resolution("closed", null, ago(1), {
              authoritative: false,
              reason: "no-longer-listed",
              resolvedAt: null,
            }),
          ),
        ),
      };
    case "approval-winner":
      return {
        b: waitingApproval(now)
          .update(settle(resolution("denied", "deny", ago(1), { resolvedBy: "Pip's laptop" })))
          .update((a) =>
            patchError(a, "apr_5d2a", "It had already been settled; this is how it ended."),
          ),
      };

    case "question-single":
    case "question-readonly":
      return { b: asked(now) };
    case "question-multi":
      return { b: asked(now, [MACHINES]) };
    case "question-three":
      return { b: asked(now, [KEEP, MACHINES, WHEN]) };
    case "question-unanswerable":
      return {
        b: asked(now, [
          {
            questionId: "sign_in",
            header: "Sign in",
            question: "Sign in to the backup provider, then confirm.",
            url: "https://backup.example.test/sign-in",
            options: [],
            presentation: "form",
          },
        ]),
      };
    case "question-answered":
      return { b: asked(now).update(answer({ keep_cache: ["A week"] })) };
    case "question-answered-typed":
      return { b: asked(now).update(answer({ keep_cache: ["Two weeks, then ask me"] })) };
    case "question-answered-multi":
      return { b: asked(now, [MACHINES]).update(answer({ machines: ["media-box", "attic-nas"] })) };
    case "question-dismissed":
      return {
        b: asked(now).update((a) => questionEvent({ id: "qst_81f0", status: "cancelled" })(a)),
      };
    case "question-expired":
      return {
        b: asked(now).update((a) => questionEvent({ id: "qst_81f0", status: "expired" })(a)),
      };
    case "question-cancelled":
      return {
        b: asked(now)
          .update((a) => ({
            ...a,
            runs: a.runs.map((run) => ({
              ...run,
              state: "stopping" as const,
              stopRequestedAt: ago(1),
            })),
          }))
          .update((a) => questionEvent({ id: "qst_81f0", status: "cancelled" })(a)),
      };
    case "question-closed-ended":
      return { b: asked(now).end(ago(1)).update(closeQuestions) };
    case "question-closed-failed":
      return {
        b: asked(now)
          .end(ago(1), "error", {
            error: "The model provider is overloaded.",
            executionSettled: true,
          })
          .update(closeQuestions),
      };

    case "messaged-started":
      return { b: messaged(now) };
    case "messaged-approval":
      return {
        b: messaged(now)
          .event("lifecycle", { phase: "waiting-approval", approvalId: "apr_msg" }, ago(2))
          .update(requested(msgApproval(now))),
      };
    case "messaged-sent":
      return { b: sendResult(messaged(now), now, { status: "accepted", sessionKey: MARLOW_KEY }) };
    case "messaged-working":
    case "messaged-last-seen":
    case "messaged-return":
      return {
        b: sendResult(messaged(now), now, {
          status: "accepted",
          runId: MARLOW_RUN,
          sessionKey: MARLOW_KEY,
        }),
        extra: { linkedRuns: linked("running", now) },
      };
    case "messaged-recipient-waiting":
      return {
        b: sendResult(messaged(now), now, {
          status: "accepted",
          runId: MARLOW_RUN,
          sessionKey: MARLOW_KEY,
        }),
        extra: { linkedRuns: linked("waiting", now) },
      };
    case "messaged-no-reply":
      return {
        b: sendResult(messaged(now), now, {
          status: "accepted",
          runId: MARLOW_RUN,
          sessionKey: MARLOW_KEY,
        }),
        extra: { linkedRuns: linked("completed", now) },
      };
    case "messaged-no-reply-timeout":
      return {
        b: sendResult(messaged(now), now, {
          status: "timeout",
          sentBeforeError: true,
          sessionKey: MARLOW_KEY,
          error: "No reply within 120 seconds.",
        }),
      };
    case "messaged-replied": {
      // An earlier exchange with Marlow in the same run, for "Show full exchange".
      const earlier = new Builder(CARD_TASK, now)
        .start(ago(3))
        .toolStart(
          "sessions_send",
          "call_msg0",
          { sessionKey: MARLOW_KEY, message: "Is the house log open for this week?" },
          ago(2.6),
        )
        .toolResult(
          "sessions_send",
          "call_msg0",
          {
            content: text("Yes. The week of Nov 16 is open."),
            details: {
              status: "ok",
              runId: "run_m41a",
              sessionKey: MARLOW_KEY,
              reply: "Yes. The week of Nov 16 is open.",
            },
          },
          ago(2.4),
        );
      return {
        b: sendResult(messaged(now, earlier), now, {
          status: "ok",
          runId: MARLOW_RUN,
          sessionKey: MARLOW_KEY,
          reply: REPLY,
        }),
        extra: { linkedRuns: linked("completed", now) },
      };
    }
    case "messaged-recipient-stopped":
      return {
        b: sendResult(messaged(now), now, {
          status: "accepted",
          runId: MARLOW_RUN,
          sessionKey: MARLOW_KEY,
        }),
        extra: { linkedRuns: linked("stopped", now) },
      };
    case "messaged-recipient-failed":
      return {
        b: sendResult(messaged(now), now, {
          status: "accepted",
          runId: MARLOW_RUN,
          sessionKey: MARLOW_KEY,
        }),
        extra: { linkedRuns: linked("failed", now) },
      };
    case "messaged-failed":
      return {
        b: sendResult(
          messaged(now),
          now,
          { status: "error", error: "Session agent:marlow:house-log is not running." },
          true,
        ),
      };
    case "messaged-blocked":
      return {
        b: sendResult(
          messaged(now),
          now,
          { status: "forbidden", error: "Otto may not message Marlow's tasks" },
          true,
        ),
      };
    case "messaged-not-sent":
      return {
        b: messaged(now)
          .event("lifecycle", { phase: "waiting-approval", approvalId: "apr_msg" }, ago(2))
          .update(requested(msgApproval(now)))
          .update((a) =>
            applyApprovalResolved(a, { ...resolution("denied", "deny", ago(1)), id: "apr_msg" }),
          )
          .toolResult(
            "sessions_send",
            "call_msg",
            { content: text("Denied by the user.") },
            ago(1),
            true,
          ),
      };
    case "messaged-unknown":
      return {
        b: messaged(now)
          .update((a) => ({
            ...a,
            runs: a.runs.map((run) => ({ ...run, stopRequestedAt: ago(1) })),
          }))
          .end(ago(1), "end", { aborted: true, stopReason: "aborted" }),
      };

    case "received-working":
    case "received-waiting":
    case "received-completed":
    case "received-failed":
    case "received-stopped": {
      const b = new Builder(RECEIVING_TASK, now).start(ago(2), MARLOW_RUN);
      if (name === "received-waiting") {
        b.question({
          ...questionRecord(now, [
            {
              questionId: "tone",
              header: "Tone",
              question: "Should the entry mention the machine that was asleep?",
              options: [{ label: "Yes" }, { label: "No" }],
              isOther: true,
            },
          ]),
          sessionKey: RECEIVING_TASK,
          agentId: "marlow",
          runId: MARLOW_RUN,
        });
      }
      if (name === "received-completed")
        b.event("lifecycle", { phase: "end", endedAt: ago(1) }, ago(1), MARLOW_RUN);
      if (name === "received-failed")
        b.event(
          "lifecycle",
          {
            phase: "error",
            endedAt: ago(1),
            error: "The model provider is overloaded.",
            executionSettled: true,
          },
          ago(1),
          MARLOW_RUN,
        );
      if (name === "received-stopped")
        b.event(
          "lifecycle",
          { phase: "end", endedAt: ago(1), aborted: true, stopReason: "aborted" },
          ago(1),
          MARLOW_RUN,
        );
      return { b, task: RECEIVING_TASK };
    }
    case "incoming-line":
      return { b: new Builder(CARD_TASK, now).start(ago(3)).end(ago(2)) };

    case "t3-started":
      return { b: t3Call(now) };
    case "t3-approval":
      return {
        b: t3Call(now)
          .event("lifecycle", { phase: "waiting-approval", approvalId: "apr_t3" }, ago(2))
          .update(requested(t3Approval(now))),
      };
    case "t3-call-made":
      return { b: t3Result(t3Call(now), now) };
    case "t3-work-may-continue":
      return {
        b: t3Result(t3Call(now), now)
          .update((a) => ({
            ...a,
            runs: a.runs.map((run) => ({ ...run, stopRequestedAt: ago(1) })),
          }))
          .end(ago(1), "end", { aborted: true, stopReason: "aborted" }),
      };
    case "t3-delivery-unknown":
      return {
        b: t3Call(now)
          .update((a) => ({
            ...a,
            runs: a.runs.map((run) => ({ ...run, stopRequestedAt: ago(1) })),
          }))
          .end(ago(1), "end", { aborted: true, stopReason: "aborted" }),
      };
    case "t3-failed":
      return { b: t3Result(t3Call(now), now, true) };
    case "t3-not-sent":
      return {
        b: t3Call(now)
          .event("lifecycle", { phase: "waiting-approval", approvalId: "apr_t3" }, ago(2))
          .update(requested(t3Approval(now)))
          .update((a) =>
            applyApprovalResolved(a, { ...resolution("denied", "deny", ago(1)), id: "apr_t3" }),
          )
          .toolResult(T3_TOOL, "call_t3", { content: text("Denied by the user.") }, ago(1), true),
      };
  }
}

/** A question still pending when its run ended is closed, as the engine settles it. */
function closeQuestions(activity: TaskActivity): TaskActivity {
  return {
    ...activity,
    questions: activity.questions.map((question) =>
      question.status === "pending" ? { ...question, status: "closed" as const } : question,
    ),
  };
}

const ASK =
  "Check that last night's backups finished, and tidy the transcode cache on media-box if it is still in /srv/media.";

/** Rows of ordinary conversation around a card, so the transcript scrolls. */
function filler(at: number, count: number, prefix: string): TranscriptItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `f-${prefix}${i}:${i}`,
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    timestamp: at + i * 1000,
    blocks: [
      {
        kind: "text" as const,
        text:
          i % 2 === 0
            ? `Note ${i + 1}: is the garage-pi backup on schedule?`
            : `Yes. Run ${i + 1} finished on time and the archive checks out.`,
      },
    ],
    model: null,
  }));
}

function senderItems(now: number): TranscriptItem[] {
  return [
    {
      id: USER_ITEM,
      role: "user",
      timestamp: now - 3 * MINUTE,
      blocks: [{ kind: "text", text: ASK }],
      model: null,
    },
  ];
}

function receiverItems(now: number): TranscriptItem[] {
  return [
    {
      id: "m-in:0",
      role: "user",
      timestamp: now - 2 * MINUTE,
      blocks: [{ kind: "text", text: SENT }],
      model: null,
    },
  ];
}

export const CARD_TASKS = {
  otto: {
    key: CARD_TASK,
    botId: "otto",
    sessionId: "otto-transcode-cache",
    title: "Tidy the transcode cache",
    preview: "Moving the cache off /srv/media",
  },
  marlow: {
    key: RECEIVING_TASK,
    botId: "marlow",
    sessionId: "marlow-house-log",
    title: "House log",
    preview: "Writing the weekly entry",
  },
} as const;

export function isCardScene(value: string | null): value is CardSceneName {
  return value !== null && (CARD_SCENES as readonly string[]).includes(value);
}

/** The scene: the loaded state, with the card task added and its transcript built. */
export function cardScene(name: CardSceneName, now: number): CardScene {
  const { b, extra, task = CARD_TASK } = build(name, now);
  // The client keeps steps and approvals consistent after every change.
  b.update((activity) => normalizeApprovals(activity));
  const receiving = task === RECEIVING_TASK;
  // The run belongs under the message that started it.
  const anchor = receiving ? "m-in:0" : USER_ITEM;
  const activity: TaskActivity = {
    ...b.activity,
    approvalAccess: name.endsWith("readonly") ? "unavailable" : "ready",
    approvalSources: {
      exec: "ready",
      plugin: "ready",
      "system-agent": "ready",
    },
    // In the return scene the task has moved on since: the sender's run finished, so its
    // card stays at its run's place in history, above the later messages.
    runs: b.activity.runs.map((run) => ({
      ...run,
      anchorItemId: anchor,
      ...(name === "messaged-return"
        ? { state: "completed" as const, endedAt: now - 2 * MINUTE }
        : {}),
    })),
  };
  const items = receiving
    ? receiverItems(now)
    : name === "messaged-return"
      ? [
          ...filler(now - 40 * MINUTE, 18, "e"),
          ...senderItems(now),
          ...filler(now - MINUTE, 20, "l"),
        ]
      : senderItems(now);
  const interSession = receiving
    ? [
        {
          itemId: "m-in:0",
          text: SENT,
          sourceSessionKey: CARD_TASK,
          sourceTool: "sessions_send",
          senderLabel: "Otto",
          senderAgentId: "otto",
          timestamp: now - 2 * MINUTE,
        },
      ]
    : name === "incoming-line"
      ? [
          {
            itemId: "m-late:1",
            text: REPLY,
            sourceSessionKey: MARLOW_KEY,
            sourceTool: "sessions_send",
            senderLabel: "Marlow",
            senderAgentId: "marlow",
            timestamp: now - MINUTE,
          },
        ]
      : [];
  if (name === "incoming-line") {
    items.push({
      id: "m-late:1",
      role: "user",
      timestamp: now - MINUTE,
      blocks: [{ kind: "text", text: REPLY }],
      model: null,
    });
  }
  const transcript: Transcript = {
    ...activity,
    linkedRuns: extra?.linkedRuns ?? {},
    interSession,
    sessionKey: task,
    status: "ready",
    items,
    error: null,
    hasMore: false,
    live: null,
    loadedAt: now,
  };
  const decisions: DecisionMode =
    name === "approval-refused" ? "refuse" : name === "approval-unknown" ? "silent" : "apply";

  // A message to Marlow: Marlow's task holds the run it started, for "Open in Marlow" and back.
  const companion =
    name.startsWith("messaged") && name !== "messaged-not-sent" && name !== "messaged-blocked"
      ? cardScene(
          name === "messaged-replied" || name === "messaged-no-reply"
            ? "received-completed"
            : "received-working",
          now,
        )
      : null;
  return {
    task,
    decisions,
    change: (before) => {
      const state = companion ? companion.change(before) : before;
      const add = (list: Task[] | undefined, row: Task) => [
        row,
        ...(list ?? []).filter((each) => each.key !== row.key),
      ];
      const withTasks = {
        ...state.tasksByBot,
        otto: add(state.tasksByBot.otto, taskRow(CARD_TASKS.otto, now)),
        marlow: add(state.tasksByBot.marlow, taskRow(CARD_TASKS.marlow, now)),
      };
      const readOnly = name.endsWith("readonly");
      const reconnecting = name === "messaged-last-seen";
      const scopes = readOnly
        ? ["operator.read", "operator.write"]
        : ["operator.read", "operator.write", "operator.approvals", "operator.questions"];
      return {
        ...state,
        connection: {
          ...state.connection,
          status: reconnecting ? "reconnecting" : state.connection.status,
          retryAt: reconnecting ? now + 4000 : state.connection.retryAt,
          scopes,
          canWrite: true,
          canApprove: !readOnly,
          canAnswer: !readOnly,
        },
        tasksByBot: withTasks,
        transcripts: { ...state.transcripts, [task]: transcript },
      };
    },
  };
}

function taskRow(spec: (typeof CARD_TASKS)[keyof typeof CARD_TASKS], now: number): Task {
  return { ...spec, updatedAt: now - MINUTE, status: "running", unread: false };
}

/** The approval as the gateway sent it, before anything was cut: what "read it whole" returns. */
export function wholeApproval(name: string, now: number, id: string) {
  if (!isCardScene(name)) return null;
  const card = build(name, now).b.activity.approvals.find((each) => each.id === id);
  if (!card) return null;
  const parsed = card.kind === "exec" ? parseExecApproval(card.raw) : parsePluginApproval(card.raw);
  // The kept record may itself be cut; the scene's own record is whole.
  return (
    parsed ??
    (name === "approval-cut"
      ? parseExecApproval(execRecord(now, { command: LONG_COMMAND, commandArgv: null }))
      : null)
  );
}
