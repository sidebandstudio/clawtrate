// Live conversation scenes for the fixture: the access request on the read
// tier, and a run in each of its states on the interactive tier. Every run is
// on Otto's "Disk almost full on the media box" task. Invented content only.

import {
  INTERACTIVE_SCOPES,
  newRun,
  type ApprovalCard,
  type BridgeCommand,
  type ClawtrateState,
  type OutgoingMessage,
  type QuestionCard,
  type Run,
  type Step,
  type Transcript,
} from "@clawtrate/core";
import { OPEN_TASK } from "./data.ts";

export const LIVE_SCENES = [
  "access-asking",
  "access-requested",
  "access-denied",
  "access-expired",
  "access-error",
  "access-pinned",
  "access-granted",
  "read-wait",
  "composer",
  "run-thinking",
  "run-working",
  "run-streaming",
  "run-waiting",
  "run-question",
  "run-queued",
  "run-stopping",
  "run-stopped",
  "run-stopped-elsewhere",
  "run-finished-before-stop",
  "run-failed",
  "run-turn-limit",
  "stop-failed",
  "send-failed",
  "send-unknown",
  "stopped-not-sent",
  "queued-refused",
  "offline-send",
] as const;

export type LiveScene = (typeof LIVE_SCENES)[number];

const SECOND = 1000;
const REQUEST_ID = "7c41d09e-52b3-4e8a-9f10-3d6b2a7e9c41";

const withTranscript = (state: ClawtrateState, change: (t: Transcript) => Transcript) => ({
  ...state,
  transcripts: { ...state.transcripts, [OPEN_TASK]: change(state.transcripts[OPEN_TASK]!) },
});

const interactive = (state: ClawtrateState): ClawtrateState => ({
  ...state,
  connection: {
    ...state.connection,
    scopes: [...INTERACTIVE_SCOPES],
    requestedScopes: [...INTERACTIVE_SCOPES],
    canWrite: true,
    canAnswer: true,
    canApprove: true,
  },
});

const upgrade = (
  state: ClawtrateState,
  change: Partial<ClawtrateState["connection"]["upgrade"]>,
) => ({
  ...state,
  connection: {
    ...state.connection,
    upgrade: { ...state.connection.upgrade, scopes: [...INTERACTIVE_SCOPES], ...change },
  },
});

function message(
  id: string,
  text: string,
  at: number,
  change: Partial<OutgoingMessage> = {},
): OutgoingMessage {
  return {
    id,
    text,
    mode: "new",
    status: "sent",
    runId: "run-live",
    messageSeq: null,
    createdAt: at,
    error: null,
    attachments: [],
    ...change,
  };
}

function toolStep(
  id: string,
  name: string,
  args: Record<string, unknown>,
  at: number,
  change: Partial<Step> = {},
): Step {
  const argsText = JSON.stringify(args, null, 2);
  return {
    id: `tool:${id}`,
    kind: "tool",
    title: name,
    toolName: name,
    toolCallId: id,
    status: "running",
    startedAt: at,
    endedAt: null,
    argsText: { text: argsText, totalChars: argsText.length },
    output: null,
    result: null,
    error: null,
    approvalId: null,
    failureKind: null,
    truncated: false,
    replaceable: false,
    correction: 0,
    continuation: null,
    raw: null,
    rawSize: null,
    ...change,
  };
}

const ASK = "Can you check the backup log from last night too?";
const REPLY =
  "The backup finished at 02:14 and wrote 41 GB. Two folders were skipped because they were";

function run(now: number, change: Partial<Run>): Run {
  return newRun(
    "run-live",
    {
      state: "running",
      origin: "local",
      bound: true,
      messageId: "msg-1",
      reportedStartAt: now - 42 * SECOND,
      ...change,
    },
    now - 42 * SECOND,
  );
}

/** The transcript with one message sent and its run in the given form. */
function withRun(
  state: ClawtrateState,
  now: number,
  change: Partial<Run>,
  extra: Partial<Transcript> = {},
): ClawtrateState {
  return withTranscript(interactive(state), (transcript) => ({
    ...transcript,
    outbox: [message("msg-1", ASK, now - 42 * SECOND), ...(extra.outbox ?? [])],
    runs: [run(now, change), ...(extra.runs ?? [])],
    approvals: extra.approvals ?? [],
    questions: extra.questions ?? [],
  }));
}

const readStep = (now: number, change: Partial<Step> = {}) =>
  toolStep("call-read-1", "read", { path: "/var/log/backup/backup-2026-11-15.log" }, now, change);

function approval(now: number): ApprovalCard {
  return {
    id: "approval-1",
    kind: "exec",
    status: "pending",
    runId: "run-live",
    createdAt: now - 5 * SECOND,
    allowedDecisions: ["allow-once", "deny"],
  } as unknown as ApprovalCard;
}

function question(now: number): QuestionCard {
  return {
    id: "question-1",
    runId: "run-live",
    status: "pending",
    questions: [
      {
        id: "keep",
        header: "Old backups",
        question: "Which old backups should I keep?",
        options: [
          { index: 0, label: "The last two weeks", description: null, value: null },
          { index: 1, label: "Only the monthly ones", description: null, value: null },
        ],
        optionsOmitted: 0,
        multiSelect: false,
        allowsOther: true,
      },
    ],
    createdAt: now - 5 * SECOND,
    expiresAt: null,
    answers: null,
    submitting: false,
    error: null,
    raw: null,
  };
}

/** The scene's state, from the loaded fixture state. */
export function liveScene(
  name: LiveScene,
  base: ClawtrateState,
  now: number,
): {
  initial: ClawtrateState;
  steps: Array<{ after: number; change: (s: ClawtrateState) => ClawtrateState }>;
} {
  switch (name) {
    case "access-asking":
      return { initial: upgrade(base, { status: "requesting" }), steps: [] };
    case "access-requested":
      return {
        initial: upgrade(base, {
          status: "pending",
          requestId: REQUEST_ID,
          approveCommand: `openclaw devices approve ${REQUEST_ID}`,
          approveNote: null,
        }),
        steps: [],
      };
    case "access-denied":
      return { initial: upgrade(base, { status: "rejected" }), steps: [] };
    case "access-expired":
      return { initial: upgrade(base, { status: "expired" }), steps: [] };
    case "access-error":
      return {
        initial: upgrade(base, {
          status: "error",
          error: "The gateway did not answer within 60 seconds.",
        }),
        steps: [],
      };
    case "access-pinned":
      return { initial: base, steps: [] };
    case "access-granted":
      return {
        initial: upgrade(base, {
          status: "pending",
          requestId: REQUEST_ID,
          approveCommand: `openclaw devices approve ${REQUEST_ID}`,
        }),
        steps: [
          {
            after: 300,
            change: (state) => upgrade(interactive(state), { status: "approved" }),
          },
        ],
      };
    case "read-wait":
      return {
        initial: withTranscript(base, (transcript) => ({
          ...transcript,
          runs: [
            newRun(
              "run-elsewhere",
              {
                state: "waiting",
                origin: "gateway",
                bound: true,
                reportedStartAt: now - 75 * SECOND,
              },
              now - 75 * SECOND,
            ),
          ],
        })),
        steps: [],
      };
    case "composer":
      return { initial: interactive(base), steps: [] };
    case "run-thinking":
      return { initial: withRun(base, now, {}), steps: [] };
    case "run-working":
      return { initial: withRun(base, now, { steps: [readStep(now - 3 * SECOND)] }), steps: [] };
    case "run-streaming":
      return {
        initial: withRun(base, now, {
          steps: [readStep(now - 30 * SECOND, { status: "done", endedAt: now - 29 * SECOND })],
          text: REPLY,
        }),
        steps: [],
      };
    case "run-waiting":
      return {
        initial: withRun(
          base,
          now,
          {
            state: "waiting",
            pendingCards: [{ id: "approval-1", kind: "approval", since: now - 5 * SECOND }],
            steps: [
              toolStep(
                "call-exec-1",
                "exec",
                { command: "rm -rf /srv/media/cache/thumbs" },
                now - 6 * SECOND,
                { status: "waiting", approvalId: "approval-1" },
              ),
            ],
          },
          { approvals: [approval(now)] },
        ),
        steps: [],
      };
    case "run-question":
      return {
        initial: withRun(
          base,
          now,
          {
            state: "waiting",
            pendingCards: [{ id: "question-1", kind: "question", since: now - 5 * SECOND }],
          },
          {
            questions: [question(now)],
            outbox: [
              message("msg-2", "Also keep anything from this month.", now - 2 * SECOND, {
                mode: "steer",
                status: "held",
                attachments: [
                  { fileName: "keep-list.txt", mimeType: "text/plain", sizeBytes: 2048 },
                ],
              }),
            ],
          },
        ),
        steps: [],
      };
    case "run-queued":
      return {
        initial: withRun(
          base,
          now,
          { steps: [readStep(now - 3 * SECOND)] },
          {
            outbox: [
              message("msg-2", "Skip the photos folder.", now - 20 * SECOND, { mode: "steer" }),
              message("msg-3", "Then send me a summary.", now - 4 * SECOND, {
                mode: "queue",
                status: "queued",
                runId: null,
              }),
            ],
            runs: [newRun("msg-3", { state: "queued", origin: "local", messageId: "msg-3" }, now)],
          },
        ),
        steps: [],
      };
    case "run-stopping":
      return {
        initial: withRun(
          base,
          now,
          { state: "stopping", stopRequestedAt: now - SECOND, text: REPLY },
          {
            outbox: [
              message("msg-3", "Then send me a summary.", now - 1 * SECOND, {
                mode: "queue",
                status: "queued",
                runId: null,
              }),
            ],
            runs: [newRun("msg-3", { state: "queued", origin: "local", messageId: "msg-3" }, now)],
          },
        ),
        steps: [],
      };
    case "run-stopped":
      return {
        initial: withRun(base, now, {
          state: "stopped",
          stopRequestedAt: now - 2 * SECOND,
          endedAt: now - 2 * SECOND,
          text: REPLY,
          steps: [readStep(now - 30 * SECOND, { status: "done", endedAt: now - 29 * SECOND })],
        }),
        steps: [],
      };
    case "run-stopped-elsewhere":
      return {
        initial: withRun(base, now, { state: "stopped", endedAt: now - 2 * SECOND, text: REPLY }),
        steps: [],
      };
    case "run-finished-before-stop":
      return {
        initial: withRun(base, now, {
          state: "completed",
          finishedBeforeStop: true,
          stopRequestedAt: now - 2 * SECOND,
          endedAt: now - SECOND,
          textComplete: true,
          text: "The backup finished at 02:14 and wrote 41 GB. Nothing was skipped.",
        }),
        steps: [],
      };
    case "run-failed":
      return {
        initial: withRun(base, now, {
          state: "failed",
          endedAt: now - 2 * SECOND,
          text: REPLY,
          error: {
            message:
              "The model provider is overloaded. Nothing ran after step 1, and steps already completed are not undone.",
            kind: "provider",
          },
        }),
        steps: [],
      };
    case "run-turn-limit":
      return {
        initial: withRun(base, now, {
          state: "failed",
          endedAt: now - 2 * SECOND,
          error: { message: "Stopped at the 50-minute turn limit.", kind: "turn-limit" },
        }),
        steps: [],
      };
    case "stop-failed":
      return {
        initial: withRun(base, now, {
          stopError: "The gateway refused chat.abort: the run is owned by another session.",
          steps: [readStep(now - 3 * SECOND)],
        }),
        steps: [],
      };
    case "send-failed":
      return {
        initial: withTranscript(interactive(base), (transcript) => ({
          ...transcript,
          outbox: [
            message("msg-1", ASK, now - 10 * SECOND, {
              status: "failed",
              runId: null,
              error: "chat.send was refused: the session is archived.",
            }),
          ],
        })),
        steps: [],
      };
    case "stopped-not-sent":
      return {
        initial: withRun(
          base,
          now,
          {
            state: "stopped",
            stopRequestedAt: now - 3 * SECOND,
            endedAt: now - 2 * SECOND,
            text: REPLY,
          },
          {
            outbox: [
              message("msg-3", "Then send me a summary.", now - 3 * SECOND, {
                mode: "queue",
                status: "not-sent",
                runId: null,
              }),
            ],
          },
        ),
        steps: [],
      };
    case "queued-refused":
      return {
        initial: withTranscript(interactive(base), (transcript) => ({
          ...transcript,
          outbox: [
            message("msg-3", "Then send me a summary.", now - 10 * SECOND, {
              mode: "queue",
              status: "failed",
              runId: null,
              error: "The gateway refused to start it: the session's budget is used up.",
            }),
          ],
        })),
        steps: [],
      };
    case "send-unknown":
      return {
        initial: withTranscript(interactive(base), (transcript) => ({
          ...transcript,
          outbox: [
            message("msg-1", ASK, now - 10 * SECOND, {
              status: "unknown",
              runId: null,
              error:
                "No answer came from the gateway, and its history does not show this message. Whether it was received is not known.",
            }),
          ],
        })),
        steps: [],
      };
    case "offline-send":
      return {
        initial: withRun(
          {
            ...base,
            connection: {
              ...base.connection,
              status: "reconnecting",
              retryAt: now + 4 * SECOND,
            },
          },
          now,
          { steps: [readStep(now - 3 * SECOND)] },
          {
            outbox: [
              message("msg-2", "Skip the photos folder.", now - 1 * SECOND, {
                mode: "steer",
                status: "awaiting-access",
              }),
            ],
          },
        ),
        steps: [],
      };
  }
}

/**
 * Commands the fixture answers in live scenes, following the engine's rules
 * closely enough for interface checks: a send starts a run, steers or
 * queues; Stop goes through stopping to stopped. Returns undefined for a
 * command it does not handle.
 */
export function liveCommand(
  command: BridgeCommand,
  get: () => ClawtrateState,
  set: (state: ClawtrateState) => void,
  files: Map<string, OutgoingMessage["attachments"][number]> = new Map(),
): Promise<unknown> | undefined {
  const now = Date.now();
  const update = (change: (t: Transcript) => Transcript) => set(withTranscript(get(), change));
  switch (command.type) {
    case "requestAccess": {
      set(upgrade(get(), { status: "requesting" }));
      setTimeout(
        () =>
          set(
            upgrade(get(), {
              status: "pending",
              requestId: REQUEST_ID,
              approveCommand: `openclaw devices approve ${REQUEST_ID}`,
            }),
          ),
        300,
      );
      return Promise.resolve();
    }
    case "sendMessage": {
      const id = `msg-${Math.random().toString(36).slice(2, 8)}`;
      const attachments = command.attachmentIds.flatMap((each) => {
        const file = files.get(each);
        return file ? [file] : [];
      });
      update((transcript) => {
        const active = transcript.runs.find((each) =>
          ["running", "waiting", "stopping"].includes(each.state),
        );
        const asking = active && transcript.questions.some((card) => card.status === "pending");
        if (!active) {
          return {
            ...transcript,
            outbox: [
              ...transcript.outbox,
              message(id, command.text, now, { runId: id, attachments }),
            ],
            runs: [
              ...transcript.runs,
              newRun(id, { state: "running", origin: "local", bound: true, messageId: id }, now),
            ],
          };
        }
        if (active.state === "stopping" || (command.mode === "queue" && !asking)) {
          return {
            ...transcript,
            outbox: [
              ...transcript.outbox,
              message(id, command.text, now, { mode: "queue", status: "queued", runId: null }),
            ],
            runs: [
              ...transcript.runs,
              newRun(id, { state: "queued", origin: "local", messageId: id }, now),
            ],
          };
        }
        return {
          ...transcript,
          outbox: [
            ...transcript.outbox,
            message(id, command.text, now, {
              mode: command.mode === "queue" ? "queue" : "steer",
              status: asking ? "held" : "sent",
              runId: active.id,
            }),
          ],
        };
      });
      return Promise.resolve({ messageId: id });
    }
    case "stopRun": {
      update((transcript) => ({
        ...transcript,
        runs: transcript.runs.map((each) =>
          each.id === command.runId ? { ...each, state: "stopping", stopRequestedAt: now } : each,
        ),
      }));
      setTimeout(
        () =>
          update((transcript) => ({
            ...transcript,
            runs: transcript.runs.map((each) =>
              each.id === command.runId && each.state === "stopping"
                ? { ...each, state: "stopped", endedAt: Date.now() }
                : each.state === "queued"
                  ? { ...each, state: "cancelled" }
                  : each,
            ),
            // As the engine does: nothing starts by itself after a confirmed Stop.
            outbox: transcript.outbox.map((each) =>
              each.status === "queued" || each.status === "held"
                ? { ...each, status: "not-sent", runId: null }
                : each,
            ),
          })),
        400,
      );
      return Promise.resolve();
    }
    case "cancelQueued":
      update((transcript) => ({
        ...transcript,
        outbox: transcript.outbox.map((each) =>
          each.id === command.messageId ? { ...each, status: "cancelled" } : each,
        ),
        runs: transcript.runs.map((each) =>
          each.id === command.messageId && each.state === "queued"
            ? { ...each, state: "cancelled" }
            : each,
        ),
      }));
      return Promise.resolve();
    case "sendQueuedNow":
      update((transcript) => ({
        ...transcript,
        outbox: transcript.outbox.map((each) =>
          each.id === command.messageId
            ? { ...each, status: "sent", mode: "steer", runId: "run-live" }
            : each,
        ),
        runs: transcript.runs.filter((each) => each.id !== command.messageId),
      }));
      return Promise.resolve();
    case "takeBackMessage": {
      const taken = get().transcripts[OPEN_TASK]?.outbox.find(
        (each) => each.id === command.messageId,
      );
      if (!taken || (taken.status !== "held" && taken.status !== "queued"))
        return Promise.reject(new Error("That message can no longer be edited."));
      update((transcript) => ({
        ...transcript,
        outbox: transcript.outbox.map((each) =>
          each.id === command.messageId ? { ...each, status: "cancelled" } : each,
        ),
        runs: transcript.runs.map((each) =>
          each.id === command.messageId && each.state === "queued"
            ? { ...each, state: "cancelled" }
            : each,
        ),
      }));
      const attachments = taken.attachments.map((file, index) => {
        const info = { id: `back-${command.messageId}-${index}`, ...file };
        files.set(info.id, file);
        return info;
      });
      return Promise.resolve({ text: taken.text, attachments });
    }
    case "sendAgain": {
      const original = get().transcripts[OPEN_TASK]?.outbox.find(
        (each) => each.id === command.messageId,
      );
      if (!original) return Promise.reject(new Error("That message is no longer held here."));
      const id = `msg-${Math.random().toString(36).slice(2, 8)}`;
      update((transcript) => ({
        ...transcript,
        outbox: [
          ...transcript.outbox,
          message(id, original.text, now, { runId: id, attachments: original.attachments }),
        ],
        runs: [
          ...transcript.runs,
          newRun(id, { state: "running", origin: "local", bound: true, messageId: id }, now),
        ],
      }));
      return Promise.resolve({ messageId: id });
    }
    case "retryMessage":
      update((transcript) => ({
        ...transcript,
        outbox: transcript.outbox.map((each) =>
          each.id === command.messageId
            ? { ...each, status: "sending", error: null, runId: command.messageId }
            : each,
        ),
        runs: transcript.runs.some((each) =>
          ["running", "waiting", "stopping"].includes(each.state),
        )
          ? transcript.runs
          : [
              ...transcript.runs,
              newRun(
                command.messageId,
                { state: "running", origin: "local", messageId: command.messageId },
                now,
              ),
            ],
      }));
      return Promise.resolve();
    case "deleteMessage":
      update((transcript) => ({
        ...transcript,
        outbox: transcript.outbox.filter((each) => each.id !== command.messageId),
      }));
      return Promise.resolve();
    case "createTask":
      return Promise.resolve({ key: "agent:otto:new-task" });
    default:
      return undefined;
  }
}
