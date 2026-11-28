// The gateway connection and the state it projects. Built on the official
// browser-safe protocol client, with transport, storage and signing injected.

import { readOpenClawUpdate, type OpenClawUpdate } from "./gateway-update.ts";
import { OpenClawUpdates } from "./openclaw-update.ts";
import {
  DeviceApprovals,
  pairCode,
  type DeviceDecision,
  type DeviceListRead,
} from "./device-approval.ts";
import { listMemory, readMemory, writeMemory } from "./memory.ts";
import { startTasksFrom } from "./start-tasks.ts";
import {
  keepGuidesCurrent,
  oldGuidesKeys,
  readGuideFolders,
  type BotGuidesAnswer,
} from "./guides.ts";
import {
  readVoice,
  setVoice,
  VOICE_CHANGED_EVENT,
  VOICE_GET,
  type BotVoiceAnswer,
} from "./voice.ts";
import {
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  GatewayBrowserDeviceAuthLifecycle,
  GatewayProtocolClient,
  GatewayProtocolRequestError,
  PROTOCOL_VERSION,
  shouldPauseGatewayReconnect,
  type EventFrame,
  type GatewayBrowserDeviceAuthPlan,
  type GatewayBrowserDeviceTokenStore,
  type HelloOk,
} from "@openclaw/gateway-client/browser";
import { isRefusedDecision } from "./approval-refusals.ts";
import { answerKind, readAgain, READ_AGAIN_TRIES } from "./read-again.ts";
import { fromBase64, toBase64 } from "./bytes.ts";
import { goesUnmarked, markerRefusal } from "./send-marker.ts";
import { chatSendParams, sendRefusal } from "./send-size.ts";
import { GatewayScopeUpgrade } from "@openclaw/gateway-client/scope-upgrade";
import { ConnectErrorDetailCodes } from "@openclaw/gateway-protocol/connect-error-details";
import {
  AccountsEngine,
  AdminNeededError,
  type CreateBotInput,
  type CreatedBot,
} from "./accounts-engine.ts";
import { BotNames } from "./bot-names.ts";
import type { ModelList, ModelRefresh, OrderClear } from "./accounts.ts";
import {
  dismissCheckInSave,
  loadCheckIns,
  saveCheckIn,
  type CheckInDraft,
  type CheckInsContext,
  type CheckInRead,
} from "./check-ins.ts";
import {
  RoutinesEngine,
  type BotRoutines,
  type CalendarRuns,
  type GatewayHooks,
  type NewRoutine,
  type Routine,
  type RoutineFields,
  type RoutineRevision,
  type RoutineRemove,
  type RoutineRun,
  type RoutineRunNow,
  type RoutineSaveCheck,
  type RoutineWrite,
  type RunConversation,
  type RunSelector,
} from "./routines.ts";
import {
  MachinesEngine,
  type ApprovalsFile,
  type ConfigSave,
  type DefaultsChoice,
  type MachinesView,
  type PlacementPart,
  type PlacementParts,
} from "./machines.ts";
import {
  deleteBot,
  rosterIds,
  wholeRoster,
  readBotDelete,
  type BotDeleteContext,
  type BotDeleteOutcome,
  type BotDeleteRead,
  type DeleteRequest,
} from "./bot-delete.ts";
import {
  admitApproval,
  applyApprovalRequested,
  applyApprovalResolved,
  APPROVAL_KINDS,
  decisionText,
  expireApprovals,
  attemptsOf,
  attemptsSettled,
  decisionRefusal,
  finishDecision,
  finishReadback,
  NO_ATTEMPTS,
  noteSent,
  patchError,
  readbackStillPending,
  reopenAttempts,
  sameAttempts,
  startDecision,
  startReadback,
  type ApprovalAttempts,
  mergeResolution,
  normalizeApprovals,
  parseApprovalResolved,
  parseExecApproval,
  parsePluginApproval,
  parseSystemAgentApproval,
  resolutionFromSnapshot,
  resolveRequest,
  settleUnlistedApprovals,
  type ApprovalAccess,
  type ApprovalCard,
  type ApprovalDecision,
  type ApprovalKind,
  type ApprovalResolution,
  type ApprovalSourceAccess,
} from "./approvals.ts";
import {
  interSessionMessages,
  linkedRunOf,
  builtinToolNames,
  mcpToolMap,
  BOT_MESSAGE_TOOL,
  recipientLinks,
  recipientRunIds,
  type LinkedRun,
} from "./cards.ts";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  validateAttachmentMeta,
} from "./attachments.ts";
import { ChatTextBaselines } from "./chat-text.ts";
import {
  FileTransfers,
  listTaskFiles,
  listWorkspace,
  readCheckoutDiff,
  readTaskFile,
  readWorkspaceFile,
  type CheckoutDiff,
  type FileRead,
  type FileReaderContext,
  type FileTransferStart,
  type TaskFileList,
  type WorkspacePage,
} from "./files.ts";
import {
  fetchInboundPicture,
  isDrawnPicture,
  readBackAddress,
  isShownPictureType,
  MAX_PICTURE_BYTES,
  ownPictureRead,
  readChatPicture,
  type ChatPictureContext,
  type ChatPictureRead,
  type SentPictureRead,
} from "./pictures.ts";
import { readChatFile, type ChatFileRead } from "./chat-files.ts";
import type {
  ApprovalInstructions,
  ClawtrateHost,
  WebSocketFactory,
  WebSocketLike,
} from "./host.ts";
import { externalChannelOf } from "./channels.ts";
import { isOtherToolSession } from "./origins.ts";
import {
  asRecord,
  botIdFromSessionKey,
  rowBotOf,
  groupTasks,
  isExcludedSessionKey,
  isSessionRemoval,
  isTaskSession,
  mapAgents,
  mapHistory,
  plainPreview,
  sentSources,
  startedTaskSince,
  mergeSessionRow,
  sessionChangeRow,
  sessionRowKey,
  sessionRowsFromList,
  titledByGateway,
  type RawRecord,
} from "./mapping.ts";
import { holdsUpdateNotice, mainToReadAgain } from "./update-notice.ts";
import { SKILL_REVIEW_RUN_PREFIX } from "./skill-notes.ts";
import {
  MAX_SEARCHES_IN_FLIGHT,
  searchFiles,
  searchMessages,
  searchRoutines,
  type FileSearch,
  type MessageSearch,
  type RoutineSearch,
} from "./search.ts";
import {
  PAIRING_ENDED,
  pairingEnded,
  protocolMessage,
  protocolMismatch,
} from "./connect-errors.ts";
import {
  activeRun,
  activitySize,
  applyAgentEvent,
  applyChatEvent,
  applyQuestionRequested,
  applyQuestionResolved,
  foreignQuestionRequested,
  foreignQuestionResolved,
  questionMarkers,
  runsWithQuestionMarkers,
  bindRun,
  markStoppedAsFollowUp,
  unmarkStoppedAsFollowUp,
  markStoppedForTimeouts,
  noteRunRequest,
  timeoutsInARow,
  TIMEOUTS_IN_A_ROW,
  markStopAsked,
  markWithdrawn,
  MAX_RAW_ENTRY_CHARS,
  runErrorRawId,
  markTurnLimit,
  runningRunId,
  noteStoppedWith,
  cancelQueuedRun,
  dropUnboundRun,
  dropUnboundRunUnlessStopping,
  emptyActivity,
  failRunStart,
  findRun,
  finishRun,
  isActive,
  cachedSize,
  isTerminal,
  markUnconfirmed,
  parkAfterStop,
  markQuestion,
  mergeHistoryRuns,
  gatewayRunning,
  queueLocalRun,
  requeueLocalRun,
  RawTable,
  namesOutgoing,
  reconcileOutbox,
  historyQueuePairs,
  MAX_QUEUE_ALIASES,
  registerRunAlias,
  registerSteerAlias,
  settleRunFromSendAnswer,
  settleRunFromWait,
  settleUnboundStops,
  throughRunAliases,
  removeMessage,
  requestStop,
  retireStopIntent,
  revertStop,
  runsFromHistory,
  settleMissingQuestions,
  settleQuestionsOfEndedRuns,
  settleVanishedRuns,
  settleQuietEnds,
  quietPending,
  quietToRead,
  retainActivity,
  startLocalRun,
  questionPending,
  startQueuedRun,
  updateMessage,
  type CaughtUp,
  type EngineContext,
  type OutgoingMessage,
  type QuestionAnswer,
  type QuestionCard,
  type QuestionOption,
  type Run,
  type StepRaw,
  type RunRawRead,
  type StepRead,
  type TaskActivity,
} from "./runs.ts";
import {
  APPROVALS_SCOPE,
  ADMIN_SCOPE,
  ADMIN_SCOPES,
  FULL_SCOPES,
  PAIRING_SCOPE,
  heldFromGrant,
  INTERACTIVE_SCOPES,
  normalizeHeldScopes,
  QUESTIONS_SCOPE,
  READ_SCOPES,
  scopeSatisfied,
  WRITE_SCOPE,
} from "./scopes.ts";
import { capId, enforce, jsonLength, jsonTextLength } from "./bounds.ts";
import {
  endpointSpellings,
  gatewayEndpoint,
  protectedGatewayUrl,
  validateGatewayUrl,
} from "./gateway-url.ts";
import {
  cleanLine,
  GATEWAY_NAMES_KEY,
  gatewayNameFor,
  readGatewayNames,
  withGatewayName,
  writeGatewayNames,
  type GatewayNames,
} from "./gateway-names.ts";
import { openClawAtLeast } from "./gateway-version.ts";
import {
  APPROVAL_ATTEMPTS,
  APPROVAL_OUTCOME,
  CREATION,
  enforceState,
  MAX_CREATIONS,
  MAX_ID_CHARS,
  MAX_LINKED_RUNS,
  MAX_MCP_TOOLS,
  MAX_BOTS,
  MAX_BUILTIN_TOOLS,
  MAX_LISTED_TASKS,
  MAX_MESSAGE_JSON_CHARS,
  MAX_OUTBOX,
  MAX_PENDING_APPROVAL_COUNT,
  MAX_REACTIONS_PER_MESSAGE,
  MAX_RUN_TEXT_CHARS,
  MAX_STEPS_PER_TASK,
  MAX_TASK_LINE_CHARS,
  MAX_TITLE_CHARS,
  MAX_TRACKED_TASKS as TRACKED_TASKS,
  MAX_UNROUTED,
  RUN,
  SESSION_ROW,
  WORST_STATE_CHARS,
} from "./state-bounds.ts";
import type { SetupState } from "./setup.ts";
import { createStore, type Store } from "./store.ts";
import {
  changeSidebar,
  initialSidebar,
  readSidebar,
  sidebarRev,
  SIDEBAR_PREF_KEY,
  type SidebarChange,
  type SidebarContext,
  type SidebarPrefs,
  type SidebarState,
} from "./sidebar.ts";
import {
  UsageEngine,
  type UsageBusy,
  type UsageReport,
  type UsageReportRequest,
} from "./usage-engine.ts";
import { initialUsage, type BudgetChange, type BudgetRoutine } from "./usage.ts";
import {
  archiveTask,
  deleteTask,
  listArchived,
  markTask,
  newMainTask,
  newTask,
  pinTask,
  renameTask,
  restoreTask,
  type ArchivedList,
  type ArchiveResult,
  type CreatedTask,
  type TaskActionContext,
} from "./task-actions.ts";
import { nameTask } from "./task-names.ts";
import { endsRun, fromActivity, WaitingIndex } from "./waiting.ts";
import {
  coveredRuns,
  failedByRow,
  runAliases,
  QUIET_CHECK_CHARS,
  QUIET_CHECK_ROWS,
  QuietChecks,
  quietInHistory,
} from "./quiet-end.ts";
import { mentionRows, slashRows, type MenuRow } from "./composer-menus.ts";
import { listedBots } from "./gateway-bot.ts";
import {
  CONTROL_EVENT,
  ComputerViews,
  initialComputerState,
  type ClosedCode,
  type ComputerFrame,
  type ComputerInput,
  type StopAnswer,
} from "./computer.ts";
import { readMachine, type MachineFacts } from "./machine.ts";
import {
  CONNECTION_CHANGED_AFTER_SEND,
  gatewayStamp,
  initialConnectionState,
  initialScopeUpgrade,
  initialState,
  sameStamp,
  type ClawtrateState,
  type ConnectionState,
  type GatewayStamp,
  type ReadStamp,
  type DiscoveryState,
  type MessageReaction,
  type ScopeUpgradeState,
  type SendLimits,
  type TaskCreation,
  type TranscriptItem,
  type Transcript,
} from "./types.ts";

/** A read-only connection's scopes. Every connect asks for these until write access is approved. */
export const REQUESTED_SCOPES = ["operator.read"] as const;
/** Why forgetting a gateway was refused: another viewer chose a different one meanwhile. */
export const GATEWAY_CHANGED_MESSAGE = "The selected gateway changed. Choose again.";

/** Deferred Stops of an archive or a delete kept for their runs' aborts (`deferredStops`). */
export const MAX_DEFERRED_STOPS = 32;
/** Turns the gateway owes a task after a Stop of this client's stopped a recipient (`followUps`). */
export const MAX_FOLLOW_UPS = 32;
/**
 * How long such a turn is waited for once the recipient's stop is confirmed. The gateway starts
 * it as soon as it sees the recipient's run end, and waits at most 60 s for that end.
 */
export const FOLLOW_UP_WAIT_MS = 120_000;
/** A resend of a message the gateway refused the marker on, held by a question that opened meanwhile. */
const HELD_FOR_QUESTION = Symbol("held for a question");
/** Why a deferred Stop was given up: every place for its check is held by a Stop still waiting. */
const TOO_MANY_STOPS =
  "Too many Stops are waiting for their runs to start, so nothing was sent for this one. Try again in a moment.";
/**
 * What the strip adds when bots and tasks couldn't be loaded and the gateway's last answer to
 * every read that failed was one it marks as passing (`answerKind`): only then is it true.
 */
export const DISCOVERY_NOT_READY = "The gateway wasn't ready.";
/** What an open task says when its live updates couldn't be started, after the tries again. */
export const LIVE_UPDATES_NOT_STARTED = "Live updates for this task couldn't be started.";

/** A failed read of the gateway's identity is asked again this many times, each 4 times later. */
const IDENTITY_RETRIES = 4;
const IDENTITY_RETRY_MS = 500;

/** Why a write stamped on an earlier connection target is not sent (`requireSameGateway`). */
export const CONNECTION_CHANGED =
  "The connection changed since this screen was read, so nothing was sent. Look again, then try again.";
/** Why a write stamped with one gateway's identity is not sent to another (`requireSameGateway`). */
const ANOTHER_GATEWAY = "This change was made for another gateway, so nothing was sent.";
const UNNAMED_GATEWAY = "The gateway hasn't said which gateway it is, so nothing was sent.";
/** The identity read failed or named none: a retry may read it, unlike another gateway's. */
const IDENTITY_UNREAD =
  "Clawtrate couldn't confirm which gateway this is, so nothing was sent. Try again.";
/** Why a file a bot handed over isn't read: its row came from another gateway (`readChatFile`). */
export const FILE_FROM_ANOTHER_GATEWAY =
  "This file was listed by another gateway, so it wasn't read. Look again, then try again.";
/** Why a write that had already sent part of itself stopped: what the gateway did is not known. */
export { CONNECTION_CHANGED_AFTER_SEND };

/** What a task action asks that changes nothing: the rest of its requests are writes. */
const taskRead = (method: string) =>
  method === "sessions.describe" || method === "sessions.list" || method === "users.prefs.get";

/** Disconnect refused because another gateway is selected now: the one asked for is no longer there. */
export class GatewayChangedError extends Error {
  constructor() {
    super(GATEWAY_CHANGED_MESSAGE);
    this.name = "GatewayChangedError";
  }
}
/**
 * Client capabilities advertised in `connect`. `tool-events` is the only one
 * the live run view needs: without it the gateway sends no tool lifecycle
 * events. Approval caps are not claimed, because this client does not show or
 * resolve approvals.
 */
export const CLIENT_CAPS: readonly string[] = ["tool-events"];
/**
 * Added when the connect asks for `operator.approvals`: without `approvals` and
 * `exec-approvals` the gateway auto-denies exec approvals as `no-route`, and
 * `plugin-approvals` routes plugin approvals. A read-only connect does not claim
 * them, so the gateway never waits on a connection that cannot see approvals.
 */
export const APPROVAL_CAPS: readonly string[] = ["approvals", "exec-approvals", "plugin-approvals"];

/** The caps a connect requesting these scopes advertises. */
export function capsFor(scopes: readonly string[]): string[] {
  return scopes.includes(APPROVALS_SCOPE) ? [...CLIENT_CAPS, ...APPROVAL_CAPS] : [...CLIENT_CAPS];
}

/** Longest standing allow the gateway accepts (`grantExpiresInDays`). */
export const MAX_GRANT_DAYS = 3650;
/** A registered client id for third-party operator UIs; we do not claim an OpenClaw product id. */
export const CLIENT_ID = "gateway-client";
export const CLIENT_MODE = "ui";

/** One page of the task list. Pages are read until the gateway reports no more. */
export const SESSION_PAGE_SIZE = 200;
/** A ceiling so a huge gateway cannot make one reconnect read forever. */
export const MAX_SESSION_PAGES = 50;
/** Clawtrate's turn limit (F-100): a run this client started fails after it. */
export const DEFAULT_TURN_LIMIT_MS = 50 * 60_000;
/** The "Turn time limit" a person may choose, in minutes (F-100). */
export const MIN_TURN_LIMIT_MINUTES = 1;
export const MAX_TURN_LIMIT_MINUTES = 24 * 60;
/** Where the host keeps the chosen turn limit. */
/** Reads of a task's reactions, the first and again each time a newer change overtook one. */
const REACTION_LIST_ATTEMPTS = 3;
const TURN_LIMIT_KEY = "turn-limit-minutes";
/** Where the host keeps "Show external channel chats"; absent is off. */
const CHANNEL_CHATS_KEY = "show-channel-chats";
/** Where the host keeps "Show sessions from other tools"; absent is off. */
const OTHER_TOOLS_KEY = "show-other-tool-sessions";
/** Where the host keeps "Show the gateway's own bot"; absent is off. */
const GATEWAY_BOT_KEY = "show-gateway-bot";
/** Tasks the client follows at once: open in some viewer, kept for their unsent work, or being created. */
export const MAX_TRACKED_TASKS = TRACKED_TASKS;
/** Tasks this client names at once, or waits to name (`taskNames`); past it, the oldest goes. */
export const MAX_NAMED_TASKS = 32;
/** Messages with no text one empty task may have from this client before it gives up naming it. */
export const MAX_TEXTLESS_SENDS = 4;

/** A session id from the gateway, kept when it is within the id bound. */
function sessionOf(value: unknown): string | null {
  return typeof value === "string" && value && jsonTextLength(value) <= MAX_ID_CHARS ? value : null;
}

/**
 * A row's session, with its `lifecycleRevision` when the gateway gives one: a reset or a cut of
 * the session makes another revision of the same id, and another conversation.
 */
function sessionOfRow(row: RawRecord | null | undefined): string | null {
  const id = sessionOf(row?.sessionId);
  const revision = row?.lifecycleRevision;
  return id && typeof revision === "string" && revision
    ? (sessionOf(`${id}\u0000${revision}`) ?? id)
    : id;
}

/** Whether two sessions (`sessionOfRow`) are known to differ: a revision only one names doesn't. */
function otherSession(a: string | null, b: string | null): boolean {
  if (a === null || b === null || a === b) return false;
  const [idA, revisionA] = a.split("\u0000");
  const [idB, revisionB] = b.split("\u0000");
  return idA !== idB || (revisionA !== undefined && revisionB !== undefined);
}

/**
 * A task this client names (`taskNames`): `waiting` for the gateway to accept the message it is
 * named from (`first`: the creation's message, or an empty task's first with text), with the ids of
 * the messages it sent there before with no text (a picture or a file alone), or `naming` while its
 * name is made. With the session the task was created as, when known.
 */
type TaskNaming = {
  stage: "waiting" | "naming";
  sessionId: string | null;
  textless: string[];
  /** The message it is named from, once the gateway accepts its `chat.send`; null until chosen. */
  first: string | null;
  /** Created with that message (`createTask`): no other message can come before it. */
  withMessage: boolean;
};
/** Titles made from tasks' first messages the client keeps (`firstMessageTitles`); the oldest goes past it. */
export const MAX_FIRST_MESSAGE_TITLES = 200;

/**
 * A title made from a task's first message, and the outgoing message it was made from while that
 * message is not yet in the task's history (`from`); null once history holds it. With the session
 * the task had then, when known: a task made again under the same key is another one. And the
 * connection (`epoch`) it was made or last confirmed on: one before another gateway answered at
 * the address was the other gateway's.
 */
type FirstMessageTitle = {
  title: string;
  from: string | null;
  session: string | null;
  epoch: number;
};

/** The text of a transcript's first message from the person, or null when it has none. */
function firstPersonText(items: readonly TranscriptItem[]): string | null {
  const first = items.find((item) => item.role === "user");
  const texts = first?.blocks.flatMap((block) => (block.kind === "text" ? [block.text] : []));
  return texts?.join("\n") ?? null;
}
/**
 * Messages one task's outbox may hold, whatever their state: waiting, being
 * sent, accepted but not yet in history, unconfirmed, failed or cancelled. A
 * new message past it is refused before anything is kept; nothing accepted is
 * dropped to make room.
 */
export const MAX_OUTBOX_PER_TASK = MAX_OUTBOX;
/**
 * Decoded bytes of files the client keeps for messages in outboxes, across
 * every task, until history confirms them or the user deletes them. With the
 * waiting uploads (`MAX_PENDING_ATTACHMENT_BYTES`) this is all the file
 * content the host keeps.
 */
export const MAX_RETAINED_ATTACHMENT_BYTES = 32 * 1024 * 1024;
/**
 * Messages history confirmed whose pictures this client keeps to show, from
 * the copy it sent, whenever their task is open on this device, until this
 * client disconnects from the gateway or the task or its bot is deleted (archiving keeps
 * them). Their bytes share
 * `MAX_RETAINED_ATTACHMENT_BYTES` with the outboxes' files and give way,
 * oldest first, to a new message's.
 */
export const MAX_SENT_PICTURE_MESSAGES = 32;
/**
 * Pictures a person sent that this client read back from the gateway (#469), kept so a
 * message scrolled to again isn't read again, until the same events as the copies above
 * let them go. Their bytes share the same budget and give way first, oldest first.
 */
export const MAX_READ_BACK_PICTURES = 16;
/**
 * Pictures being read back at once, under way or waiting for a file read's place: more than a
 * screen shows together. Past it a new read is refused at once, and the picture offers Try again.
 */
export const MAX_PICTURE_READS = 32;
/** Operations waiting for access at once; past it a new one is refused. */
export const MAX_ACCESS_WAITERS = 128;

/** What the offer of full control was shown for: its gateway, this device, and its stamp. */
export type FullControlBinding = { gatewayUrl: string; deviceId: string; stamp: GatewayStamp };

/** Why core starts no further scope request for a full pairing (setup-effortless.md §2). */
export const FULL_PAIRING_LIMIT =
  "This device's full pairing holds what the gateway granted; it asks for no more.";

/**
 * The person's answer to the offer of full control, per device and gateway endpoint: asked
 * (sent, not yet decided), granted, narrower, refused or dismissed ("Keep current access").
 */
type OfferAnswer = "asked" | "granted" | "narrower" | "refused" | "dismissed";
const OFFER_ANSWERS: readonly string[] = ["asked", "granted", "narrower", "refused", "dismissed"];
/** Reads on opening a task on their way at once; past it, one more waits for the next opening. */
export const MAX_OPENED_READS = 16;
/** Bot deletes under way at once, from every viewer. */
export const MAX_BOT_DELETES = 8;
/** One bot on one gateway, as the delete's bookkeeping keys it. */
const deleteKey = (gatewayId: string, botId: string) => `${gatewayId}\u0000${botId}`;
/**
 * Approval outcomes the gateway reported, kept by id apart from the visible
 * cards so a request or list entry that arrives after its resolution can never
 * make it actionable again. The oldest give way; switching gateways clears them.
 */
export const MAX_APPROVAL_OUTCOMES = 512;
/**
 * Approvals whose attempts are kept apart from any task: those with a decision
 * on its way, an unknown outcome or a read-back on its way. Past it, a
 * decision on another approval is refused until one settles.
 */
export const MAX_APPROVAL_ATTEMPTS = 256;
/**
 * Pending approvals kept while no followed task can show them, or while the
 * task they belong to already shows `MAX_PENDING_APPROVALS_PER_TASK`
 * (`unroutedApprovals`). Past it a new one is not kept and is counted in
 * `unroutedApprovalsOmitted`; the next list read brings it back.
 */
export const MAX_UNROUTED_APPROVALS = MAX_UNROUTED;
/** `approval.get` lookups of ambiguous legacy outcomes in flight at once; past it the outcome stays unknown. */
export const MAX_OUTCOME_LOOKUPS = 16;
/** Pending approvals one task shows; more wait in `unroutedApprovals` until one settles. */
export const MAX_PENDING_APPROVALS_PER_TASK = MAX_PENDING_APPROVAL_COUNT;

/**
 * How long a request may go unanswered on a live connection before it fails
 * locally. Nothing the client sent waits for ever: a send that times out is
 * failed with its outcome unknown, to retry with the same idempotency key.
 * Waits the gateway answers late by design (`device.scopes.waitUpgrade`) opt out.
 */
export const REQUEST_TIMEOUT_MS = 60_000;

/** How long Stop waits for the gateway to answer the withdrawal of the run's steers. */
export const STEER_WITHDRAWAL_WAIT_MS = 2_000;
/** Longest message text the client sends. */
export const MAX_MESSAGE_CHARS = 32_000;
/** The gateway's frame ceiling after `connect` when `hello-ok.policy.maxPayload` is absent (25 MiB). */
export const DEFAULT_MAX_PAYLOAD_BYTES = 26_214_400;
const SESSION_LIST_PARAMS = {
  limit: SESSION_PAGE_SIZE,
  includeDerivedTitles: true,
  includeLastMessage: true,
  excludeCron: true,
  excludeSubagents: true,
};
const HISTORY_LIMIT = 200;

/** Whether a history read lists a turn the gateway holds to run. One it withdrew stays listed as `cancelled`. */
function holdsInput(history: RawRecord | null): boolean {
  const items = asRecord(history?.pendingInputs)?.items;
  return Array.isArray(items) && items.some((item) => asRecord(item)?.state !== "cancelled");
}

/** A chat from an external channel, or a session another tool opened: not the person's own task. */
const isElsewhere = (row: RawRecord) => externalChannelOf(row) !== null || isOtherToolSession(row);

/**
 * The newest `MAX_LISTED_TASKS` task rows, each only the fields the list reads, cut to their bound,
 * keyed under the id cap. Chats from external channels and other tools' sessions give way first,
 * so a busy channel or API client never pushes the person's own tasks out of the list.
 */
function newestRows(
  rows: RawRecord[],
  keeps: (key: string) => boolean = () => false,
): Map<string, RawRecord> {
  const kept = new Map<string, RawRecord>();
  for (const row of rows) {
    if (!isTaskSession(row)) continue;
    const bounded = SESSION_ROW(row);
    const key = sessionRowKey(bounded);
    if (key !== null) kept.set(key, bounded);
  }
  // One that waits for the person, or that a viewer has open, never gives way: it is listed
  // until answered or left.
  const givesWay = ([key, row]: [string, RawRecord]) => !keeps(key) && isElsewhere(row);
  return new Map(
    [...kept]
      .sort(
        (a, b) =>
          Number(keeps(b[0])) - Number(keeps(a[0])) ||
          Number(givesWay(a)) - Number(givesWay(b)) ||
          Number(b[1].updatedAt ?? 0) - Number(a[1].updatedAt ?? 0),
      )
      .slice(0, MAX_LISTED_TASKS),
  );
}
/** How many sessions nobody has open, and how many runs of each, are followed for bot-to-bot cards. */
/** Sessions nobody has open whose runs are followed for bot-to-bot cards, and runs of each. */
export const FOREIGN_SESSIONS = 16;
export const FOREIGN_RUNS_PER_SESSION = 4;
/** Recipient sessions with a read on their way at once, and reads of one session at once. */
export const MAX_FOREIGN_READ_SESSIONS = MAX_TRACKED_TASKS * MAX_STEPS_PER_TASK;
/** Reads of one session on their way at once: at most the runs a task's steps name. */
export const MAX_FOREIGN_READS_PER_SESSION = MAX_STEPS_PER_TASK;
const MAX_TIMER_MS = 2_147_483_647;
/** Whole reads (`readStepRaw`, `readHistoryItem`, `readApprovalText`) in flight at once; past it one is refused. */
export const MAX_FULL_READS = 4;
/** File lists and reads in flight at once, across viewers; past it, refused. */
export const MAX_FILE_READS = 4;
/** Who reads a file, and how long an answer the reader's channel takes. */
export type FileReadOptions = { owner?: object; maxChars?: number };
/** The text length `chat.history` gives when not asked for more (OpenClaw 2026.10.6). */
export const GATEWAY_HISTORY_TEXT_CHARS = 8_000;
/** The most text per row a whole read asks `chat.history` for: the protocol's `maxChars` maximum. */
export const MAX_HISTORY_READ_CHARS = 500_000;
/** Runs of one task whose streaming `chat` text is kept to build on the next delta. */
export const MAX_STREAMS_PER_TASK = 2;
/** Spawn links kept (`spawnedBy`), newest. */
export const MAX_SPAWN_LINKS = 200;
const PAIRING_RETRY_MS = 3000;

const SETTINGS_KEY = "connection";

export type ConnectionSettings = {
  url: string;
  token: string | null;
  /** The user chose Disconnect: stay disconnected, across restarts, until Reconnect. */
  suspended?: boolean;
  /**
   * The host's name for the proved route this gateway was set up through (local
   * connect's profile folder, `SetupEndpointCheck.route`). While it is set, every
   * socket of every connection to it, after a restart too, comes from
   * `ClientOptions.localConnect` for this name; with none, nothing is opened.
   */
  route?: string;
  /**
   * For a gateway saved with a `route`: the identity (`gateway.identity.get`) that route's
   * gateway reported at its first hello. Another identity there later drops this device's token.
   */
  gatewayId?: string;
};

/** A gateway saved with a proved route reported another identity than the one it paired as. */
export const ROUTE_IDENTITY_CHANGED = "ROUTE_IDENTITY_CHANGED";

/**
 * Sockets the host checks itself (local connect, docs/design/setup-effortless.md
 * §3): that each one's far end matches this account's OpenClaw profile, before its
 * first byte, and again, by `verify`, just before its credential. `verify` is about
 * the latest socket `createSocket` made. What that check establishes, and what it
 * doesn't: docs/decisions.md, "Local connect's proof".
 */
export type ProvedRoute = {
  createSocket: WebSocketFactory;
  verify: (signal: AbortSignal) => Promise<boolean>;
  /**
   * Why the host's last proof of one of these sockets refused it, in fixed words for the
   * person (`PROOF_REFUSAL_LINES`), or null when none did since the last that passed. A
   * connection whose socket was refused stops with these words, rather than retrying.
   */
  refusal?: () => string | null;
};

/** A gateway saved with a proved route, reached at its address typed under Advanced. */
export const LOCAL_ROUTE_ONLY = "LOCAL_ROUTE_ONLY";
/** The way on from a refused proof, said with its words. */
const LOCAL_WAY_ON = "Choose This computer to connect to it again, or use Advanced.";

export type ConnectOptions = { url: string; token?: string | null };

/**
 * How to deliver a message while the task has an active run. Either way a
 * message to an idle task starts a new run, and a message sent while the run is
 * stopping is queued (§5.6). `auto` is the composer's Enter: a steer while the
 * run is running or waiting. `queue` is "Queue after this turn".
 */
export type SendMode = "auto" | "queue";

export type ClientOptions = {
  /**
   * Gateways this client may open. Checked before every connection, including
   * a saved one resumed at start and every retry.
   */
  allowGatewayUrl?: (url: string) => boolean;
  /** Reconnect backoff. Tests shorten it. */
  reconnect?: { initialMs: number; maxMs: number };
  /** Turn limit for runs this client starts. */
  turnLimitMs?: number;
  /** `REQUEST_TIMEOUT_MS` unless a test shortens it. */
  requestTimeoutMs?: number;
  /** `SETUP_LISTENER_READS_MS` unless a test shortens it. */
  setupListenerReadsMs?: number;
  /** First wait before a creation without an answer is asked again; `CREATION_CHECK_MS` unless a test shortens it. */
  creationCheckMs?: number;
  /** First wait before a read answered as passing is asked again; `READ_AGAIN_MS` unless a test shortens it. */
  readAgainMs?: number;
  /**
   * Counts the host sets for its device. Each defaults to the bound the
   * retention arithmetic assumes and may only be lower: `trackedTasks`, the
   * tasks followed at once (`MAX_TRACKED_TASKS`).
   */
  limits?: { trackedTasks?: number };
  /**
   * Pin the connection to the read tier: every connect asks for
   * `operator.read` alone, whatever the stored token holds, and access is
   * never requested, so every write fails at once.
   */
  readOnly?: boolean;
  /**
   * Whether Clawtrate keeps its section in the bots' instructions current (guides.ts). Always,
   * in every shipped host; only checks of other features turn it off, so their gateways see no
   * file reads they don't count on.
   */
  keepGuides?: boolean;
  /**
   * Local connect: the proved sockets for a gateway saved with `route`, asked as
   * each connection to it opens, or null when the host can't prove that route
   * (then nothing is opened). Off in every shipped host.
   */
  localConnect?: (url: string, route: string) => ProvedRoute | null;
};

/** A file sent with a message, as `chat.send` takes it: base64 content. */
export type OutgoingAttachment = {
  type: string;
  mimeType: string;
  fileName: string;
  content: string;
};

export type SendOptions = {
  mode?: SendMode;
  attachments?: OutgoingAttachment[];
  /** The gateway's id of the message this one replies to (F-067). */
  replyToId?: string;
};

/**
 * A send that would break a gateway ceiling. Checked before anything reaches
 * the socket: an oversized frame would close the connection with code 1009 and
 * no answer, and an oversized image or file would be refused anyway.
 */
export class SendTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendTooLargeError";
  }
}

function decodedBytes(base64: string): number {
  const clean = base64.replace(/\s+/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

type Plan = GatewayBrowserDeviceAuthPlan;

/**
 * A device token record. `grantedScopes` is what the gateway granted and is
 * kept for reference only. `heldScopes` is what this client means to hold and
 * is the only thing a connect ever requests.
 */
type StoredDeviceToken = {
  token: string;
  /**
   * The proved route (`ConnectionSettings.route`) this token was saved over: it goes only on a
   * socket of that route, proved again last, never on a typed address's.
   */
  route?: string;
  grantedScopes: string[];
  heldScopes: string[];
  /** This client asked for admin itself and the gateway granted it: connect asks for it again. */
  adminHeld?: boolean;
  /** The same for device access (`operator.pairing`), asked for by name. */
  pairingHeld?: boolean;
  /**
   * A first full pairing's record: `heldScopes` is exactly what the gateway granted of
   * what the signed request named, in its order, and only ever narrows. Used only while
   * full access holds; otherwise its device asks for read.
   */
  fullGrant?: boolean;
};

/** Kept per host store, so clients that share one write its device tokens as one. */
type ConnectionWrites = {
  /** The last change to a gateway's settings or token; the next one starts once it has settled. */
  pending: Promise<void>;
  /** For each token key, the connection that opened last: only it may save that token. */
  owners: Map<string, symbol>;
  /** For each token key, the tokens refusals named, each until its removal has run. */
  rejected: Map<string, Set<string>>;
  /** Refusals accepted so far, of any token: a plan whose last read came before one is not sent. */
  refusals: number;
  /** For each token key, its tokens rotated by approved access requests: a hello planned before one saves nothing. */
  rotations: Map<string, number>;
  /**
   * For each token key, its record's grant as last confirmed by any client on the store (`grantBits`):
   * every write and removal sets it, and a read seeds one not set yet; null once removed. Only for
   * an approved rotation whose reads of the saved record fail.
   */
  grants: Map<string, { full: boolean; held: number } | null>;
  /** Bumped by every write or removal of the saved settings record, by any client on the store. */
  settingsRevision: number;
  /**
   * The settings write or removal currently in flight on this store, if any: records the revision
   * it settled at once storage returns, so a startup read that overlapped publication can reconcile.
   */
  inFlightSettings: { settledRevision: number | null } | null;
  /** Numbered choices made on this store (Connect, setup, Reconnect, real Forget), newest last. */
  choices: number;
  /**
   * The choice number of the latest committed choice (a Connect, a setup's save, a Reconnect, or
   * a Forget that removed a saved record). An older setup steps aside once a newer choice commits.
   */
  chosen: number;
  /**
   * For each gateway URL, the shared gateway token a pairing on this store replaced with a device
   * token. It stays retired if that device token is refused later, until a Connect to that URL.
   */
  retiredShared: Map<string, string>;
};
const connectionWrites = new WeakMap<ClawtrateHost["storage"], ConnectionWrites>();

/**
 * A connection's token store. A rejection removes a token only through
 * `forget`, which names the token the gateway rejected.
 */
type ConnectionTokenStore = GatewayBrowserDeviceTokenStore & {
  ownsToken(deviceId: string, role: string): boolean;
  forget(params: { deviceId: string; role: string }, rejected: string): Promise<void>;
};

/** The state with the host's setup slice, or without one. */
function withSetup(state: ClawtrateState, setup: SetupState | undefined): ClawtrateState {
  if (setup) return { ...state, setup };
  const { setup: _dropped, ...rest } = state;
  return rest;
}

/** Of an upgrade's grant, what it asked for or what an asked scope implies; pairing only if asked. */
function withinAsked(granted: readonly string[], asked: readonly string[]): string[] {
  return granted.filter((scope) =>
    scope === PAIRING_SCOPE
      ? asked.includes(scope)
      : asked.some((wanted) => scopeSatisfied([wanted], scope)),
  );
}

/**
 * Whether a hello's grant can narrow a full pairing's record: this protocol, the operator role
 * and a list of scope names, which may be empty (the protocol allows an empty grant).
 */
function grantShapeValid(hello: Pick<HelloOk, "auth" | "protocol">): boolean {
  const auth = asRecord(hello.auth);
  const scopes = auth?.scopes;
  return (
    hello.protocol === PROTOCOL_VERSION &&
    auth?.role === "operator" &&
    Array.isArray(scopes) &&
    scopes.every((scope) => typeof scope === "string")
  );
}

/** A signed request's scopes and what the hello answering it granted. */
type SignedGrant = { asked: readonly string[]; granted: readonly string[] };

/** A full pairing's held scopes after a hello: any it signed for and wasn't granted go. */
function narrowedHeld(held: readonly string[], grant: SignedGrant): string[] {
  return held.filter((scope) => !grant.asked.includes(scope) || grant.granted.includes(scope));
}

/** A full pairing's record after an approved upgrade: held outside the request, or granted of it by name. */
function fullUpgrade(
  heldBefore: readonly string[],
  token: string,
  target: readonly string[],
  granted: readonly string[],
): StoredDeviceToken {
  const held = FULL_SCOPES.filter((scope) =>
    target.includes(scope) ? granted.includes(scope) : heldBefore.includes(scope),
  );
  return { token, grantedScopes: [...held], heldScopes: held, fullGrant: true };
}

/** A first full pairing's record: the scopes of the signed request the gateway granted by name, in its order. */
function fullRecord(
  token: string,
  granted: readonly string[],
  asked: readonly string[],
): StoredDeviceToken {
  const held = asked.filter((scope) => FULL_SCOPES.includes(scope) && granted.includes(scope));
  return { token, grantedScopes: [...held], heldScopes: held, fullGrant: true };
}

/**
 * A token record for a grant the gateway confirmed: what it asked for, or what an asked
 * scope implies, is kept. Admin and pairing are held only when asked for and granted.
 */
function grantRecord(
  token: string,
  granted: readonly string[],
  asked: readonly string[],
): StoredDeviceToken {
  const within = withinAsked(granted, asked);
  const admin = asked.includes(ADMIN_SCOPE) && scopeSatisfied(within, ADMIN_SCOPE);
  const pairing = asked.includes(PAIRING_SCOPE) && within.includes(PAIRING_SCOPE);
  return {
    token,
    grantedScopes: within,
    heldScopes: [
      ...heldFromGrant(within),
      ...(admin ? [ADMIN_SCOPE] : []),
      ...(pairing ? [PAIRING_SCOPE] : []),
    ],
    ...(admin ? { adminHeld: true } : {}),
    ...(pairing ? { pairingHeld: true } : {}),
  };
}

/**
 * The host's checks of a setup connection's endpoint. `check`, synchronous, is
 * asked before every socket and around signing; `verify` reads the endpoint's
 * listener again, once each socket opens and again just before the frame that
 * carries its credential. Either failing sends nothing. `verify` is given its
 * socket's signal, which ends when the socket closes or its reads' time is up:
 * the read stops what it started then.
 */
export type SetupEndpointCheck = {
  check?: () => boolean;
  verify?: (signal: AbortSignal) => Promise<boolean>;
  /**
   * Whether the host's dialog consent still holds (its two minutes), asked just before the
   * first frame that carries a credential, a saved token's included. Once a hello is in, the
   * consent is used and isn't asked again. On a plain `connect` it decides only whether a first
   * pairing over the proved route asks for the six, before each such request until the gateway
   * holds one pending, whose retries keep the six: without it the same token asks for read, as a
   * typed address does, and the connection goes on.
   */
  consent?: () => boolean;
  /**
   * The host's own sockets for this setup, in place of `createWebSocket`, for every socket
   * of it, retries included: local connect's, each proved before a byte goes.
   */
  createSocket?: WebSocketFactory;
  /**
   * The far end of the latest socket `createSocket` made, proved again: asked last before
   * the frame that carries a credential, after the plan's final storage read, so nothing
   * but the send follows it. Failing sends nothing, as `verify` failing does.
   */
  prove?: (signal: AbortSignal) => Promise<boolean>;
  /** Why the host's proof last refused one of `createSocket`'s sockets (`ProvedRoute.refusal`). */
  refusal?: () => string | null;
  /**
   * The host's name for the route `createSocket` proves (local connect's profile folder),
   * saved with the gateway (`ConnectionSettings.route`): once setup ends, and after a
   * restart, every socket of the connection comes from `ClientOptions.localConnect`.
   */
  route?: string;
};

/**
 * How long both listener reads of one setup socket may take together, from
 * the socket's open: within the protocol's 15 s for a handshake, so a read
 * that runs out ends the connection as a change, never as a timed-out retry.
 */
export const SETUP_LISTENER_READS_MS = 10_000;

function setupCheckFor(url: string, setup: SetupEndpointCheck) {
  if (!setup.check && !setup.verify && !setup.consent && !setup.createSocket && !setup.prove)
    return null;
  return {
    url,
    check: setup.check ?? (() => true),
    ...(setup.verify ? { verify: setup.verify } : {}),
    ...(setup.consent ? { consent: setup.consent } : {}),
    ...(setup.createSocket ? { createSocket: setup.createSocket } : {}),
    ...(setup.prove ? { prove: setup.prove } : {}),
    ...(setup.refusal ? { refusal: setup.refusal } : {}),
  };
}

/** A setup's gateway, with the proved route it was set up through, if any. */
function setupSettings(url: string, setup: SetupEndpointCheck): ConnectionSettings {
  return { url, token: null, ...(setup.route !== undefined ? { route: setup.route } : {}) };
}

/** A setup connection's first device token, held in memory until its grant is checked. */
type StagedDeviceToken = { deviceId: string; role: string; token: string; scopes: string[] };

/** The error a setup connection ends with when the gateway granted other than exactly read. */
export const SETUP_GRANT_REFUSED = "SETUP_GRANT_REFUSED";
/** A setup connection's endpoint no longer passed the host's check before a socket was opened. */
export const SETUP_ENDPOINT_CHANGED = "SETUP_ENDPOINT_CHANGED";
/** A setup reuse found no saved token for its gateway any more: a new consent is needed. */
export const SETUP_PAIRING_GONE = "SETUP_PAIRING_GONE";
/** A new setup pairing found a saved token for its gateway: consent to reuse it is needed first. */
export const SETUP_PAIRING_APPEARED = "SETUP_PAIRING_APPEARED";
/** A new setup pairing couldn't be saved: another connection on this device's store opened meanwhile. */
export const SETUP_PAIRING_UNSAVED = "SETUP_PAIRING_UNSAVED";
/** An ordinary connection's refusal whose code the pinned protocol doesn't name. A code of the client's own. */
export const CONNECT_REFUSED = "CONNECT_REFUSED";
/** The refusal codes an ordinary connection publishes as they are: the pinned protocol's named ones. */
const NAMED_CONNECT_CODES: ReadonlySet<string> = new Set(Object.values(ConnectErrorDetailCodes));
/** Any refusal of a setup connection but the few the setup screens name. A code of the client's own. */
export const SETUP_CONNECT_REFUSED = "SETUP_CONNECT_REFUSED";
/** The gateway codes a setup connection publishes as they are; any other is `SETUP_CONNECT_REFUSED`. */
const namedSetupCode = (code: string) =>
  code === "AUTH_BOOTSTRAP_TOKEN_INVALID" || code === "PAIRING_REQUIRED";
/** A gateway version as a setup screen may show it: a date version, nothing else. */
const setupVersion = (value: unknown): string | null =>
  typeof value === "string" && /^\d{4}\.\d{1,2}\.\d{1,3}$/.test(value) ? value : null;

/** A Connect waiting to be applied (`waitingConnects`). */
type WaitingConnect = { url: string | null; cancelled: boolean; older: WaitingConnect | null };

/** Reads of the saved grant an approved rotation tries before it uses the connection's own. */
const GRANT_READS = 3;

/** A token record's grant as `ConnectionWrites.grants` keeps it. */
function grantBits(record: StoredDeviceToken | null): { full: boolean; held: number } {
  return {
    full: record?.fullGrant === true,
    held: FULL_SCOPES.reduce(
      (bits, scope, index) => (record?.heldScopes.includes(scope) ? bits | (1 << index) : bits),
      0,
    ),
  };
}

/** The gateway address as a Connect will use it, or null for one it will refuse. */
function gatewayUrlOrNull(raw: string): string | null {
  try {
    return validateGatewayUrl(raw);
  } catch {
    return null;
  }
}

/**
 * A short digest of a pairing request id, so that a setup connection can tell
 * the request it saw ended without keeping the id itself (FNV-1a).
 */
function digest(text: string): string {
  if (text === "") return "";
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * What a setup connection's hello granted: `read` only for this protocol, the
 * operator role and exactly `["operator.read"]`; anything else, another role,
 * no scopes or more scopes, is `other` and nothing is written. A setup that
 * asked for more (full access) is `within` when the grant is the operator role
 * and one or more of the scopes it asked for, and nothing else: the narrower
 * grant is kept as it is.
 */
export function setupGrant(
  hello: Pick<HelloOk, "auth" | "protocol">,
  asked: readonly string[] = READ_SCOPES,
): "read" | "within" | "other" {
  const auth = asRecord(hello.auth);
  const scopes = auth?.scopes;
  if (hello.protocol !== PROTOCOL_VERSION || auth?.role !== "operator" || !Array.isArray(scopes))
    return "other";
  if (asked.length === 1 && asked[0] === READ_SCOPES[0])
    return scopes.length === 1 && scopes[0] === READ_SCOPES[0] && READ_SCOPES.length === 1
      ? "read"
      : "other";
  return scopes.length > 0 &&
    scopes.every((scope) => typeof scope === "string" && asked.includes(scope)) &&
    asked.every((scope) => FULL_SCOPES.includes(scope))
    ? "within"
    : "other";
}

type Waiter = {
  scope: string;
  resolve: () => void;
  reject: (error: Error) => void;
  /** Who asked: a viewer's operations are withdrawn with `withdraw` when it goes away. */
  owner: object | null;
  /** The gateway a task change's stamp named: after a reconnect, its access is asked of it only. */
  gatewayId: string | null;
};

/** The approval kinds' list methods and readers. */
const APPROVAL_SOURCES: ReadonlyArray<{
  kind: ApprovalKind;
  method: string;
  parse: (value: unknown) => ApprovalCard | null;
}> = [
  { kind: "exec", method: "exec.approval.list", parse: parseExecApproval },
  { kind: "plugin", method: "plugin.approval.list", parse: parsePluginApproval },
  { kind: "system-agent", method: "openclaw.approval.list", parse: parseSystemAgentApproval },
];

function approvalAccessOf(sources: Record<ApprovalKind, ApprovalSourceAccess>): ApprovalAccess {
  const values = APPROVAL_KINDS.map((kind) => sources[kind]);
  if (values.every((each) => each === "ready")) return "ready";
  if (values.every((each) => each === "unavailable")) return "unavailable";
  if (values.some((each) => each === "loading")) return "loading";
  if (values.some((each) => each === "ready")) return "partial";
  return "error";
}

/** A request that never left this client: nothing happened. */
export class NotSentError extends Error {
  constructor() {
    super("not connected");
    this.name = "NotSentError";
  }
}

/** The gateway's answer did not come: what happened is not known yet, and is being checked. */
export class OutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutcomeUnknownError";
  }
}

/**
 * The parameters of a creation, identical on every ask, as the gateway's idempotency requires.
 * Without its message: `sessions.create` takes no `workContext` on OpenClaw 2026.10.6 or
 * 2026.11.10, so the first message follows by `chat.send`, which says it comes from Clawtrate
 * (`send-marker.ts`, #743).
 */
function creationParams(creation: TaskCreation) {
  return {
    agentId: creation.botId,
    idempotencyKey: creation.id,
    ...(creation.label ? { label: creation.label } : {}),
  };
}

/** What a creation whose outcome could not be established says: retrying is the user's call, and may duplicate. */
export const CREATION_UNKNOWN_WARNING =
  "Whether the task was created could not be established. Check the task list: retrying may create a second task.";

/** How long a creation's key is asked again: within the 300 s the gateway remembers it, with a margin. */
export const CREATION_KEY_WINDOW_MS = 240_000;
const CREATION_CHECK_MS = 2_000;
const CREATION_CHECK_MAX_MS = 30_000;

/** A withdrawn operation: its viewer went away before the gateway was asked. */
export class WithdrawnError extends Error {
  constructor() {
    super("The request was withdrawn.");
    this.name = "WithdrawnError";
  }
}

/** The interactive scopes were asked for and not granted. */
export class AccessRequestError extends Error {
  readonly status: "rejected" | "expired" | "error";
  constructor(status: "rejected" | "expired" | "error", detail?: string) {
    super(
      status === "rejected"
        ? "The gateway's owner did not approve sending and answering from this device."
        : status === "expired"
          ? "The request to send and answer from this device expired before it was approved."
          : `Access could not be requested${detail ? `: ${detail}` : "."}`,
    );
    this.name = "AccessRequestError";
    this.status = status;
  }
}

function isRetryableNetworkFailure(error: Error): boolean {
  return !(error instanceof GatewayProtocolRequestError);
}

function isMissingScope(error: unknown): boolean {
  return (
    error instanceof GatewayProtocolRequestError &&
    asRecord(error.details)?.code === "MISSING_SCOPE"
  );
}

export { validateGatewayUrl };

export function defaultApprovalInstructions(url: string, requestId: string): ApprovalInstructions {
  // OpenClaw's own page approves a device in one click at Settings › Devices (`/settings/devices`
  // in 2026.10.6 and 2026.11.10, docs/web/urls.md), but only from a browser on the gateway's
  // computer that its default local policy lets in; otherwise the page itself asks for a command
  // to approve the browser. So the command stays, for where the page can't be used. Without a
  // request id (a setup connection keeps none), the gateway's pending-devices list.
  const where = `On the computer running OpenClaw, open ${pageAddress(url)}, go to Settings › Devices and approve this device. If that page asks to approve the browser first, or that computer has no browser,`;
  if (requestId === "")
    return { command: "openclaw devices list", note: `${where} find it with this there instead.` };
  return {
    command: `openclaw devices approve ${requestId}`,
    note: `${where} run this there instead.`,
  };
}

/** OpenClaw's page on the gateway's own computer: the port is known only from a `ws://` address. */
function pageAddress(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "ws:" && parsed.port) return `http://127.0.0.1:${parsed.port}`;
  } catch {
    // An address that doesn't parse names no port.
  }
  return "OpenClaw's page (http://127.0.0.1 and the gateway's port)";
}

export class GatewayNotAllowedError extends Error {
  constructor(url: string) {
    super(`This host is not allowed to connect to ${url}.`);
    this.name = "GatewayNotAllowedError";
  }
}

/**
 * A task holds work that must outlive its viewers: unsent or failed words,
 * words the gateway accepted that history has not confirmed, or a run this
 * client started. Cancelled messages are not work.
 */
export function hasUnsettledWork(activity: TaskActivity): boolean {
  return (
    activity.outbox.some(
      (message) => message.status !== "cancelled" && message.status !== "handled",
    ) || activity.runs.some((run) => run.origin === "local" && !isTerminal(run.state))
  );
}

/** Who asks when the client is called directly rather than through a viewer's bridge session. */
const DIRECT_CALLER = {};
/** Viewers whose whole read of one approval's text is remembered at once; the oldest give way. */
export const MAX_APPROVAL_READERS = 8;

/** The secondary alarm: roughly what the state holds against its arithmetic bound. Never the bound itself. */
function withAlarm(state: ClawtrateState): ClawtrateState {
  let estimated = 0;
  for (const transcript of Object.values(state.transcripts)) {
    estimated +=
      activitySize(transcript) +
      cachedSize(transcript.items, jsonLength) +
      cachedSize(transcript.interSession, jsonLength);
  }
  const near = estimated > ALARM_FRACTION * WORST_STATE_CHARS;
  const shown = state.retention;
  if (
    shown.near === near &&
    shown.bound === WORST_STATE_CHARS &&
    Math.abs(shown.estimated - estimated) < WORST_STATE_CHARS / 100
  ) {
    return state;
  }
  return { ...state, retention: { estimated, bound: WORST_STATE_CHARS, near } };
}

/** The share of the arithmetic bound past which the alarm says it is near. */
export const ALARM_FRACTION = 0.8;

/** A finite number, or null. */
/** When the gateway said the run started (its lifecycle `start`), for `historyCoversRun`. */
const startOf = (runs: readonly Run[], id: string): number | null =>
  runs.find((run) => run.id === id)?.reportedStartAt ?? null;

const numberOr = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function withLive(transcript: Transcript): Transcript {
  const active = transcript.runs.find((run) => isActive(run.state));
  const live = active ? { runId: active.id, text: active.text } : null;
  const same =
    live === transcript.live ||
    (live !== null &&
      transcript.live !== null &&
      live.runId === transcript.live.runId &&
      live.text === transcript.live.text);
  return same ? transcript : { ...transcript, live };
}

export class ClawtrateClient {
  /**
   * The state, brought within its bounds (`state-bounds.ts`) every time it is
   * written, so nothing the host keeps can exceed its arithmetic worst case.
   */
  readonly store: Store<ClawtrateState> = createStore(initialState, (next) =>
    withAlarm(
      enforceState(
        this.withGatewayName(
          next.setup === this.setupSlice ? next : withSetup(next, this.setupSlice),
        ),
      ),
    ),
  );
  /** The names given to gateways on this device, from the host's storage (`gateway-names.ts`). */
  private gatewayNames: GatewayNames = [];
  /** The current address's name, on every state written, so no reset of the connection loses it. */
  private withGatewayName(next: ClawtrateState): ClawtrateState {
    // The store normalises its first value before this field is set.
    const name = gatewayNameFor(this.gatewayNames ?? [], next.connection.gatewayUrl);
    return next.connection.gatewayName === name
      ? next
      : { ...next, connection: { ...next.connection, gatewayName: name } };
  }
  /**
   * The host's setup slice (`setup.ts`), kept through every reset of the
   * state, since the host alone writes it (`setSetup`).
   */
  private setupSlice: SetupState | undefined;
  /**
   * A one-time setup code the host made for its own connection
   * (`connectWithSetupCode`), in memory only, for one gateway. Dropped after
   * a hello, after any failure but a pairing that waits, on another connect or
   * a disconnect, and when it expires.
   */
  private setupCode: { url: string; bootstrapToken: string; expiresAtMs: number } | null = null;
  /**
   * The host's check of a setup connection's endpoint, asked before every
   * socket, retries included, until bots are first read on it: the listener
   * the host found is still there.
   */
  private setupCheck: {
    url: string;
    check: () => boolean;
    /** Reads the endpoint's listener again: once each socket opens, and before its credential. */
    verify?: (signal: AbortSignal) => Promise<boolean>;
    /** The dialog's consent, until the first hello: asked before the first credential frame. */
    consent?: () => boolean;
    /** The host's own sockets for this setup (local connect's), in place of `createWebSocket`. */
    createSocket?: WebSocketFactory;
    /** The far end of `createSocket`'s latest socket proved again, last before its credential. */
    prove?: (signal: AbortSignal) => Promise<boolean>;
    /** Why the host's proof last refused one of `createSocket`'s sockets. */
    refusal?: () => string | null;
  } | null = null;
  /**
   * A connection the host's setup opened, from its first socket through its
   * first hello and the first read of bots and tasks after it, whether it
   * redeems a code or reuses this device's token. While it lasts the client
   * publishes only typed outcomes: fixed codes and words, never the gateway's
   * own codes, text, request fields or version.
   */
  private setupIntent: {
    url: string;
    reuse: boolean;
    /** A rejected code can recheck for a saved pairing. A changed pairing needs fresh consent. */
    refusal?: "invalid-code" | "pairing-changed";
  } | null = null;
  /** A setup connection's update report, held until its setup succeeds (`holdSetupUpdate`). */
  private setupUpdate: { generation: number; update: OpenClawUpdate } | null = null;
  /**
   * The setup connection whose first device token is staged here until its
   * grant is checked (`setupGrant`): written only for the operator role with
   * exactly `operator.read`, or with full access, within the scopes it asked for.
   */
  private tokenGate: { generation: number; url: string; staged: StagedDeviceToken | null } | null =
    null;
  /** The device token of the gateway connected to last, kept only to scrub it from gateway text. */
  private heldToken: string | null = null;
  /** The next try of a reopen that failed before its connection could retry by itself (`reopen`). */
  private reopenTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Full access holds for the current connection: a protected route, not read-only, and the
   * host keeps this device's credentials in secure storage. Read again as each connection opens.
   */
  private fullAccess = false;
  /**
   * Whether a first pairing may ask for the six: only in an attempt the person started
   * (`connect`, `connectWithSetupCode`), and no longer once a saved token was refused or
   * lost, from the moment the refusal is accepted, before its removal runs.
   */
  private fullEligible = false;
  /** The route the open connection's gateway was saved with, as the host gave it (false: none). */
  private savedRoute: { url: string; sockets: ProvedRoute | false } | null = null;
  /** The pending request a first pairing sent the six in, with consent: its retries ask for them. */
  private fullPending: string | null = null;
  /** This attempt's plans have used a saved token: one gone since was lost. */
  private planHadToken = false;
  /**
   * How many times full-access eligibility has ended (a refusal, a lost token, an ended
   * attempt). A Connect grants it only if none ended after that Connect began.
   */
  private eligibilityEnds = 0;
  /**
   * Each Connect still waiting to be applied, newest first, linked to the one before it: its
   * address, and whether an end for that address came since it began. Only such an end cancels
   * it; ends for other gateways don't, and nor does another Connect, whether or not that one
   * takes effect. Each leaves the chain when its Connect settles, so the chain is never longer
   * than the Connects queued.
   */
  private waitingConnects: WaitingConnect | null = null;
  /** A gateway token the person typed for the current attempt, dropped when it ends. */
  private typedAttempt: { url: string; token: string; selection: number } | null = null;

  private readonly host: ClawtrateHost;
  private readonly options: ClientOptions;
  /**
   * The credential store and device-auth lifecycle of the current connection,
   * bound to its gateway URL and generation. A new connection gets new ones,
   * so nothing an older connection finishes can write another gateway's token.
   */
  private auth: {
    url: string;
    generation: number;
    tokenStore: ConnectionTokenStore;
    lifecycle: GatewayBrowserDeviceAuthLifecycle;
  } | null = null;
  private protocol: GatewayProtocolClient<Plan> | null = null;
  /** Stops the current setup socket's listener reads and the commands they started. */
  private endSocketReads: () => void = () => {};
  /**
   * Each choice of gateway (a connect of any kind, or a disconnect), numbered as
   * it is asked: `selectionAsked` when queued, `selectionApplied` once it ran.
   * `selectionReady` is the one whose bots and tasks were last read in full.
   */
  private selectionAsked = 0;
  private selectionApplied = 0;
  private selectionReady = -1;
  /** The generation of the connection opened as the host's setup connection, while it lasts. */
  private setupGeneration: number | null = null;
  /** Each failed request's log policy, as it was when the request went out. */
  private readonly dispatchedQuiet = new WeakMap<object, boolean>();
  private settings: ConnectionSettings | null = null;
  /**
   * The store's settings revision when this client last read or wrote the saved record, or null
   * before it did. Any other revision is a record another client on this store saved or forgot
   * since (`recordSeen`).
   */
  private seenRevision: number | null = null;
  /**
   * When startup read the saved record while a settings write was in flight (for instance, the
   * secure store publishing a new record before retiring an earlier token), the snapshot and the
   * write it overlapped, reconciled once that write has settled.
   */
  private pendingSeen: {
    before: number;
    write: { settledRevision: number | null };
    raw: string | null;
  } | null = null;
  /** A setup's gateway and the choice number from when the person chose it. */
  private setupChosen: { url: string; choice: number } | null = null;
  /**
   * A Connect over a proved route (local connect) not yet paired: it replaces the saved gateway
   * only at its first paired hello. Until then the record is the earlier gateway's, `previous`
   * here, which a Disconnect of this attempt selects again instead of forgetting anything.
   */
  private replacing: { url: string; previous: ConnectionSettings | null } | null = null;
  /**
   * While `start` reads the saved settings. A Disconnect, Suspend or Retry sent meanwhile waits
   * for `read`, settled once they are in `settings` or with the error that stopped the read, so
   * it acts on the saved gateway; `start` waits for those `commands` before it opens anything.
   */
  private restoring: {
    read: Promise<{ failed: false } | { failed: true; error: unknown }>;
    release: (outcome: { failed: false } | { failed: true; error: unknown }) => void;
    commands: Promise<unknown>[];
  } | null = null;
  /** Each Disconnect, Suspend or Retry that acted on the gateway, counted as it does. */
  private connectionCommands = 0;
  private identity: { deviceId: string; publicKey: string } | null = null;
  /** Bumped for every new connection so late responses from an old one are dropped. */
  private generation = 0;
  /** True once the current connection has reached hello at least once. */
  private everConnected = false;
  /** This connection's gateway refused the marker as a field it doesn't take (`send-marker.ts`). */
  private markerRefused = false;
  /**
   * The gateway's `hello-ok.server.bootId`: a random id per gateway start, the
   * lifetime of its in-memory `sessions.create` idempotency cache. Null when
   * the hello does not carry one.
   */
  private gatewayBootId: string | null = null;
  /** The turn limit in force (F-100): the host's option, else the person's choice, else 50 minutes. */
  private turnLimitMs = DEFAULT_TURN_LIMIT_MS;
  /** "Show external channel chats": the person's choice, off until they turn it on. */
  private showChannelChats = false;
  /** "Show sessions from other tools": the person's choice, off until they turn it on. */
  private showOtherToolSessions = false;
  /** "Show the gateway's own bot": the person's choice, off until they turn it on. */
  private showGatewayBot = false;
  /** How often the person set each preference: a startup read begun before a change doesn't undo it. */
  private readonly preferenceSets = {
    turnLimit: 0,
    channelChats: 0,
    gatewayNames: 0,
    otherTools: 0,
    gatewayBot: 0,
  };
  /**
   * Each preference's reads and writes, one at a time and in the order they were asked: a
   * storage write doesn't promise to finish before a later one, so two quick changes could keep
   * and show the older. Each rename starts from the names the one before it left.
   */
  private readonly preferenceWork: Record<
    "channelChats" | "gatewayBot" | "gatewayNames" | "otherTools" | "turnLimit",
    Promise<unknown>
  > = {
    channelChats: Promise.resolve(),
    gatewayBot: Promise.resolve(),
    gatewayNames: Promise.resolve(),
    otherTools: Promise.resolve(),
    turnLimit: Promise.resolve(),
  };
  private inOrder<T>(
    preference: keyof ClawtrateClient["preferenceWork"],
    work: () => Promise<T>,
  ): Promise<T> {
    const run = this.preferenceWork[preference].then(work);
    this.preferenceWork[preference] = run.catch(() => {});
    return run;
  }
  /**
   * The person this connection acts for, as the gateway names them (`users.self` profile id):
   * which reactions are this person's own. Read once per connection; null until then, or when
   * the gateway names nobody.
   */
  private selfId: string | null = null;
  private rows = new Map<string, RawRecord>();
  /** Which tasks wait for the person, across every bot (`waiting.ts`), for the rail. */
  private readonly waiting = new WaitingIndex();
  /** What history said of a marked failure of a task this client does not follow (#680). */
  private readonly quietChecks = new QuietChecks();
  /** Tasks whose read on opening is on its way: one per task at a time, however often it is asked. */
  private readonly openedReads = new Set<string>();
  /** Reads and writes of the rail's arrangement in the order they were asked, and the latest shown. */
  private sidebarIssued = 0;
  private sidebarShown = 0;
  /** Reads of the bot list in the order they were asked, and the latest shown. */
  private botsIssued = 0;
  private botsShown = 0;
  /** Coalesced bot-list reread for `config.changed`: at most one in flight plus one queued. */
  private botsRefresh: { generation: number; again: boolean } | null = null;
  /** Deletes under way, by gateway and bot: a second one waits for no answer, it is refused. */
  private readonly botDeletes = new Set<string>();
  /** Open transcripts, counted, so several viewers can share one. */
  private readonly openSessions = new Map<string, number>();
  /** The streaming reply text of each task's newest `MAX_STREAMS_PER_TASK` runs, only while they stream. */
  private readonly streams = new ChatTextBaselines(MAX_STREAMS_PER_TASK, MAX_RUN_TEXT_CHARS);
  private readonly historyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Why a pending history reload runs, when it is a resync. */
  private readonly resyncReasons = new Map<string, CaughtUp["reason"]>();
  private readonly raw = new RawTable();
  private readonly turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Tasks no viewer has open that still hold unsent words or a run this client started. */
  private readonly retained = new Set<string>();
  private readonly deliveries = new Map<string, Promise<void>>();
  /** History reads per task, one at a time with at most one more waiting. */
  private readonly loads = new Map<
    string,
    { done: Promise<void>; again: { subscribe: boolean; resync: CaughtUp["reason"] | null } | null }
  >();
  /** Bumped each time a task is opened afresh, so a read from an earlier opening is dropped. */
  private readonly incarnations = new Map<string, number>();
  private nextIncarnation = 0;
  private readonly afterRunning = new Set<string>();
  private readonly afterAgain = new Set<string>();
  /** Tasks whose runs' `agent.wait` check is on its way, and the runs each last checked. */
  private readonly endChecking = new Set<string>();
  private readonly endChecked = new Map<string, string>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Runs of sessions no viewer has open, kept small, so a bot-to-bot card can
   * follow the recipient's run when this connection receives its events.
   */
  private readonly foreign = new Map<string, TaskActivity>();
  /** Steps of foreign runs are not kept, so neither are their payloads: this table keeps nothing. */
  private readonly foreignRaw = new RawTable(0, 0);
  /**
   * Recipient reads on their way, by session, at most
   * `MAX_FOREIGN_READ_SESSIONS` sessions and `MAX_FOREIGN_READS_PER_SESSION`
   * reads of one: each read carries a token, and a deletion of the session
   * cancels its reads' tokens, so an answer that predates the deletion is
   * dropped whatever happened to other sessions meanwhile.
   */
  private readonly foreignReads = new Map<string, Set<{ cancelled: boolean }>>();
  /** Which session spawned which (`spawnedBy` on events), newest kept, at most `MAX_SPAWN_LINKS`. */
  private readonly spawnedBy = new Map<string, string>();
  /** The last guide change in line (`oneGuidesChangeAtATime`). */
  private guidesChanges: Promise<unknown> = Promise.resolve();
  /**
   * The connection whose guide change after its connect didn't know the gateway's identity: it
   * runs again once, when that connection learns it (`confirmGatewayIdentity`).
   */
  private guidesUnnamed: { generation: number; epoch: number } | null = null;
  /**
   * Settled once the change after this connection's connect is in line (or won't be): a read of
   * the guides made before then waits for it, so it shows what that change leaves.
   */
  private guidesConnectPass: { epoch: number; queued: Promise<void> } | null = null;
  /**
   * Settled once this connection's route has decided its binding from the saved record
   * (`bindRouteIdentity`): until then an upkeep write can't know which gateway the route is for.
   * True only when the record was read and the route may go on as this connection's gateway.
   */
  private routeBinding: { epoch: number; decided: Promise<boolean> } | null = null;
  /** Bots of this connection whose `AGENTS.md` didn't exist yet at its guide change (`keepGuides`). */
  private readonly guidesMissing = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private discoveryRead: { sessionsChanged: boolean; botsChanged: boolean } | null = null;
  /**
   * Bots and tasks failed to load, every failure one asked again (`askedAgain`), and the tries
   * were used up: the gateway's next event reads them once more. Set or cleared when each read
   * of bots and tasks ends, so it is always the latest one's; a new connection's own read is out
   * or has ended by the time its gateway sends an event.
   */
  private discoveryAgain = false;
  /**
   * Settles when the current connection ends (another hello, a drop, a close): a read waiting
   * to be asked again (`readAgain`) stops waiting then, and makes no try on the next connection.
   */
  private connectionEnded = new AbortController();
  /** The pairing request this client last saw pending, and when. */
  private pairingSeen: string | null = null;
  private readonly writes: ConnectionWrites;
  /** A host stop cancels socket opens requested before it, including ones still saving settings. */
  private stops = 0;
  /** Each settings read still out, ended by `stop()` so it can't hold the shared queue. */
  private readonly stopWaiters = new Set<() => void>();
  /** Every startup still reading, released by `stop()`: a later `start()` replaces `restoring`. */
  private readonly startReads = new Set<{ release: (outcome: { failed: false }) => void }>();
  /** The current attempt reached hello. */
  private attemptGreeted = false;
  /** Set by the protocol client's gap callback; the reconnect it forces reloads with this reason. */
  private pendingResync: CaughtUp["reason"] | null = null;
  /** The next hello follows a reconnect this client made on purpose, so it is not a resync. */
  private quietReconnect = false;
  /** The user asked for write access and it is not settled yet. */
  private upgradeWanted = false;
  /**
   * What the person asked for themselves within the ask wanted, or null when it was raised only
   * for operations waiting on it: what is left once those are withdrawn (#782).
   */
  private directAsk: { tier: "interactive" | "admin" | "held" | "full"; pairing: boolean } | null =
    null;
  /** The connection whose identity `resumeUpgrade` reads before its waiters' access is asked. */
  private resumeRead: number | null = null;
  /**
   * What the request under way asks for: the interactive tier, admin with it,
   * (`held`) the scopes the connection held when device access was asked for, or (`full`)
   * the six, the offer of full control accepted.
   */
  private upgradeTier: "interactive" | "admin" | "held" | "full" = "interactive";
  /**
   * The saved spelling of an address whose pairing is kept under another spelling of the
   * same endpoint (`endpointSpellings`), for the address the connection opened last: it is
   * the same pairing.
   */
  private tokenAlias: { url: string; spelling: string } | null = null;
  /** The answer to the full-control offer for the current gateway and device, read at each open. */
  private offerAnswer: OfferAnswer | "unread" | null = null;
  /**
   * The accept of the full-control offer under way, from before its answer is saved until the
   * gateway settles its request: an accept that comes meanwhile (a double click, another window)
   * joins it, so one choice sends one request. Released when the save fails, or when the
   * connection stops before the gateway answers, to try again.
   */
  private fullAttempt: Promise<void> | null = null;
  /** The scopes a `held` request keeps, as the connection held them when it was made. */
  private heldBase: readonly string[] = [];
  /** The access request under way also asks for device access (`operator.pairing`). */
  private pairingWanted = false;
  private scopeUpgrade: GatewayScopeUpgrade | null = null;
  private accessWaiters: Waiter[] = [];
  /** The frame, image and file ceilings from `hello-ok.policy`; nothing else of it is kept. */
  private payloadLimits: {
    maxPayload: number | null;
    maxImageBytes: number | null;
    maxFileBytes: number | null;
  } = {
    maxPayload: null,
    maxImageBytes: null,
    maxFileBytes: null,
  };
  /** Attachment content for outgoing messages, kept off the state snapshots, with its decoded size and the characters it holds. */
  private readonly attachmentContent = new Map<
    string,
    {
      task: string;
      /**
       * The bot its task was listed under when sent (`rowBotOf`): the read of the bots that drops
       * a deleted bot's rows can land before the gateway's answer to the delete.
       */
      bot: string | null;
      files: OutgoingAttachment[];
      bytes: number;
      /** Its task was deleted on this connection: history that holds it keeps none of its pictures. */
      taskDeleted?: true;
    }
  >();
  private attachmentBytes = 0;
  /** Pictures of messages history confirmed, by message id, oldest first (`MAX_SENT_PICTURE_MESSAGES`). */
  private readonly sentPictures = new Map<
    string,
    {
      task: string;
      /** As for `attachmentContent`. */
      bot: string | null;
      mode: OutgoingMessage["mode"];
      runId: string | null;
      files: { index: number; mimeType: string; content: string }[];
      /** Its files named as pictures whose bytes aren't one: never drawn, so not kept. */
      notPictures: number[];
      bytes: number;
    }
  >();
  private sentPictureBytes = 0;
  /**
   * Each followed task's references to the files its person's rows carried (`sentSources`),
   * from its last history read: what a picture with no copy here is read back by.
   */
  private readonly sentSources = new Map<string, Map<string, string>>();
  /**
   * Each followed task's last history read: the session it was read in, when known, the
   * connection (`epoch`) and when it was asked (`at`). Only such a read of the row's session titles
   * a task (`settleFirstMessage`).
   */
  private readonly historyReads = new Map<
    string,
    { session: string | null; epoch: number; at: number }
  >();
  /**
   * Tasks this client names (#750), by key, oldest first: `waiting` until the gateway accepts the
   * message it is named from (`TaskNaming`), `naming` while the name is made. Only the device that sends a task's
   * first message names it, so two devices never both do.
   */
  private readonly taskNames = new Map<string, TaskNaming>();
  /**
   * The title each task's first message makes, by task key, oldest first: what a task shows when
   * nothing stronger names it (`taskTitle`, #741). From the creation that sent the message, then
   * from what the task's transcript shows (`settleFirstMessage`); gone with the task.
   */
  private readonly firstMessageTitles = new Map<string, FirstMessageTitle>();
  /** The gateway identity `firstMessageTitles` were made on, and the connection that confirmed it. */
  private firstMessageGateway: { id: string; epoch: number } | null = null;
  /** Pictures read back from the gateway, by `task\0messageKey\0index`, oldest first (`MAX_READ_BACK_PICTURES`). */
  private readonly readBackPictures = new Map<
    string,
    { task: string; bot: string | null; mimeType: string; content: string; bytes: number }
  >();
  private readBackBytes = 0;
  /** Reads back in flight, by task: one whose task's or bot's pictures are let go keeps nothing. */
  private readonly pictureReadsInFlight = new Set<{
    task: string;
    bot: string | null;
    dropped: boolean;
  }>();
  /** Viewers that went away: anything they asked for is checked against this just before the gateway is asked. */
  private readonly withdrawnOwners = new WeakSet<object>();
  /**
   * Computer Stops whose first abort has not gone (`task\0run`), and who asked: it goes once the
   * send's answer or history names the run, unless the owner is withdrawn first. Removed when it
   * goes, when the run settles, or with its owner.
   */
  private readonly unsentStops = new Map<string, object>();
  /**
   * An archive's or a delete's Stop of a run the gateway had not named yet, by `key\u0000runId`:
   * the action's connection (`stopRun` `bound`), kept for the aborts sent once the run is named,
   * until the run is no longer stopping. At most `MAX_DEFERRED_STOPS`, none let go while waiting.
   */
  private readonly deferredStops = new Map<string, () => boolean>();
  /**
   * The turn the gateway will start in a task because a Stop of this client's stopped a
   * recipient's run whose send left the reply to come later (#645), by
   * `task\u0000recipient session\u0000recipient run`: the stopped run of the task, when the wait
   * for that turn ends, the run found to be it, whether its stop was asked, and the connection it
   * was made on (`target` and `epoch`): a wait never acts on another gateway or connection. Gone
   * once the wait ends or the connection changes, and all of them when the host is pointed at
   * another gateway. At most `MAX_FOLLOW_UPS`.
   */
  private readonly followUps = new Map<string, FollowUp>();
  /** Task creations not yet settled, oldest first (`MAX_CREATIONS`). */
  private readonly creations = new Map<string, TaskCreation>();
  private readonly creationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly creationWaiters = new Map<
    string,
    Array<{ resolve: (key: string) => void; reject: (error: Error) => void }>
  >();
  /** Task slots held for tasks being created, so a creation never exceeds `MAX_TRACKED_TASKS`. */
  private reservedTasks = 0;
  /** Creations being checked, each still holding its task slot until it settles. */
  private readonly checkingSlots = new Set<string>();
  /** What the gateway reported about approvals, by id, newest last (`MAX_APPROVAL_OUTCOMES`). */
  private readonly approvalOutcomes = new Map<string, ApprovalResolution>();
  /**
   * Each unsettled approval's attempts, by id, kept for as long as anything is
   * outstanding whether or not a task shows it (`MAX_APPROVAL_ATTEMPTS`). Every
   * card of a pending approval is drawn from it.
   */
  private readonly approvalAttempts = new Map<string, ApprovalAttempts>();
  /** The last attempt number given, to any approval: numbers never repeat in this client. */
  private attemptSeq = 0;
  /** Pending approvals no followed task can show yet, oldest first (`MAX_UNROUTED_APPROVALS`). */
  private readonly unrouted = new Map<string, ApprovalCard>();
  private unroutedOmitted = 0;
  /** Approvals whose outcome is being looked up (`approval.get`). */
  private readonly lookingUp = new Set<string>();
  /** Recipient runs and sessions each task's `sessions_send` results name. */
  private readonly recipients = new Map<string, { runs: Set<string>; sessions: Set<string> }>();
  /**
   * Whole reads of a cut approval's text, per approval (`<key>\0<id>`) and per
   * viewer: the digest of what that viewer was given. Only approvals pending
   * in a followed task are kept, at most `MAX_APPROVAL_READERS` viewers each.
   */
  private readonly approvalReads = new Map<string, Map<object, string>>();
  /** Per task and list (`<key>\0<kind>`): the last list requested, and the newest applied. */
  private readonly listRequested = new Map<string, number>();
  private readonly listApplied = new Map<string, number>();
  /** Per task: its `tools.effective` read in flight, and whether another was asked for meanwhile. */
  private readonly toolReads = new Map<string, { again: boolean }>();
  /** Whole reads from history in flight (`MAX_FULL_READS`). */
  private fullReads = 0;
  /** File content on its way to viewers, in chunks (`files.ts`): nothing else of a file is kept. */
  private readonly fileTransfers = new FileTransfers(() => this.now());
  /** File lists and reads in flight (`MAX_FILE_READS`). */
  private fileReads = 0;
  /** Search requests in flight (`MAX_SEARCHES_IN_FLIGHT`). */
  private searches = 0;
  /** Changes with every hello and every close, so work started on one connection never runs on the next. */
  private epoch = 0;
  /**
   * The host's target (`ConnectionState.target`): raised when the host is pointed at a gateway
   * anew, kept across reconnects to the same one. Never lowered, so no earlier screen matches.
   * It starts at a random number, not the clock, so a restarted host is vanishingly unlikely to
   * hand out a number a page kept from the last one, even when the clock repeats or steps back.
   */
  private target = 1 + Math.floor(Math.random() * 2 ** 52);
  /** The gateway's identity as read on the connection of `epoch`, once asked. */
  private gatewayIdentity: { epoch: number; id: Promise<string | null> } | null = null;
  /** Check-in reads begun; only the latest one's answer is shown. */
  private checkInReads = 0;
  /** Provider accounts per bot (`accounts-engine.ts`); its state is `accounts`. */
  private readonly accounts = new AccountsEngine({
    request: (method, params, options) => {
      if (!this.protocol) return Promise.reject(new NotSentError());
      return this.protocol.request(method, params, options);
    },
    readAgain: (read, current) => this.readAgain(read, current),
    get: () => this.state.accounts,
    update: (change) =>
      this.store.update((state) => ({ ...state, accounts: change(state.accounts) })),
    bots: () =>
      this.state.bots.map((bot) => ({
        id: bot.id,
        name: bot.name,
        isDefault: bot.isDefault,
        avatarUrl: bot.avatarUrl,
      })),
    connected: () => this.state.connection.status === "connected",
    admin: () => this.holds(ADMIN_SCOPE) && this.state.connection.scopes.includes(ADMIN_SCOPE),
    refreshBots: () => this.refreshBots(),
    gateway: () => this.readGatewayIdentity(),
    gatewayNow: () => this.state.connection.gatewayId,
    readStamp: () => ({
      gatewayId: this.state.connection.gatewayId,
      target: this.target,
      connectedAt: this.state.connection.connectedAt,
    }),
    target: () => this.target,
    createMainTask: async (botId) => {
      const generation = this.generation;
      await this.request("sessions.create", {
        key: `agent:${botId}:main`,
        agentId: botId,
        label: "Main",
      });
      if (generation === this.generation) await this.refreshSessions(generation);
    },
    now: () => this.now(),
    randomId: () => this.randomId(),
    log: (message) => this.logEngine(message),
  });
  /** The gateway's scheduled jobs (`routines.ts`); its state is `routines`. */
  private readonly routines = new RoutinesEngine({
    request: (method, params) => {
      if (!this.protocol) return Promise.reject(new NotSentError());
      return this.protocol.request(method, params);
    },
    get: () => this.state.routines,
    update: (change) =>
      this.store.update((state) => ({ ...state, routines: change(state.routines) })),
    connected: () => this.state.connection.status === "connected",
    admin: () => this.holds(ADMIN_SCOPE) && this.state.connection.scopes.includes(ADMIN_SCOPE),
    identity: () => this.state.connection.gatewayId,
    withdrawn: (owner) => this.withdrawnOwners.has(owner),
    target: () => this.target,
  });
  /** Names bots wrote for themselves, waiting for the person (`bot-names.ts`); its state is `botNames`. */
  private readonly botNames = new BotNames({
    request: (method, params) => this.request(method, params),
    bots: () => this.state.bots,
    canRename: () =>
      this.state.connection.status === "connected" &&
      this.state.connection.canAdmin &&
      !this.options.readOnly,
    gateway: () => this.state.connection.gatewayId ?? this.state.connection.gatewayUrl,
    stamp: () => gatewayStamp(this.state.connection),
    sameGateway: async (stamp) => {
      await this.requireSameGateway(stamp);
    },
    storage: {
      get: (key) => this.host.storage.get(key),
      set: (key, value) => this.host.storage.set(key, value),
      delete: (key) => this.host.storage.delete(key),
    },
    takeRead: () => {
      if (this.fileReads >= MAX_FILE_READS) return null;
      this.fileReads += 1;
      let released = false;
      return () => {
        if (!released) this.fileReads -= 1;
        released = true;
      };
    },
    refreshBots: () => this.refreshBots(),
    missingScope: (error) => {
      this.noteMissingScope(error);
      return isMissingScope(error);
    },
    publish: (botNames) => this.store.update((state) => ({ ...state, botNames })),
    log: (message) => this.log("warn", message),
  });
  /**
   * Updating OpenClaw (`openclaw-update.ts`): a person's press, and the gateway's run followed
   * across its restart; its state is `openclawUpdating`.
   */
  private readonly openclawUpdates = new OpenClawUpdates({
    request: (method, params, onSent) =>
      this.request(method, params, onSent ? { onSent: () => onSent() } : undefined),
    connection: () => this.state.connection,
    admin: () =>
      this.state.connection.status === "connected" &&
      this.state.connection.canAdmin &&
      !this.options.readOnly,
    identity: () => this.readGatewayIdentity(),
    sameGateway: async (stamp) => {
      await this.requireSameGateway(stamp);
    },
    startedAt: () => this.gatewayStartedAt,
    answered: (error) => error instanceof GatewayProtocolRequestError,
    refusalReason: (error) => {
      if (!(error instanceof GatewayProtocolRequestError)) return null;
      const reason = asRecord(error.details)?.reason;
      return typeof reason === "string" ? reason : null;
    },
    missingScope: (error) => {
      this.noteMissingScope(error);
      return isMissingScope(error);
    },
    refreshModels: () => this.accounts.load(),
    readMainAgain: async (gatewayId, runId) => {
      // The main bot's main conversation, where the gateway writes its notice (F-590).
      const key = mainToReadAgain(this.state, gatewayId, (each) => this.tracked(each));
      if (!key) return null;
      await this.loadTranscript(key, false, null);
      if (this.state.connection.gatewayId !== gatewayId) return null;
      return holdsUpdateNotice(this.state.transcripts[key], runId);
    },
    newTag: () => this.randomId(),
    now: () => this.now(),
    storage: {
      get: (key) => this.host.storage.get(key),
      set: (key, value) => this.host.storage.set(key, value),
      delete: (key) => this.host.storage.delete(key),
    },
    get: () => this.state.openclawUpdating,
    set: (openclawUpdating) => this.store.update((state) => ({ ...state, openclawUpdating })),
    later: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    log: (message) => this.log("warn", message),
  });
  /** When the connected gateway process started (its hello's `snapshot.uptimeMs`), or null. */
  private gatewayStartedAt: number | null = null;
  /** Usage reports, warning budgets and providers' limits (`usage-engine.ts`); its state is `usage`. */
  private readonly usage = new UsageEngine({
    request: (method, params) => this.request(method, params),
    get: () => this.state.usage ?? initialUsage,
    update: (change) =>
      this.store.update((state) => ({ ...state, usage: change(state.usage ?? initialUsage) })),
    connected: () => this.state.connection.status === "connected",
    now: () => this.now(),
    log: (message) => this.logEngine(message),
  });
  /**
   * Where a bot runs and the gateway's machines (`machines.ts`): read when a page
   * asks and answered, never kept; writes read back before they answer.
   */
  private readonly machines = new MachinesEngine({
    request: (method, params) => this.request(method, params),
    connected: () => this.state.connection.status === "connected",
    admin: () => this.holds(ADMIN_SCOPE) && this.state.connection.scopes.includes(ADMIN_SCOPE),
    pairing: () => this.holds(PAIRING_SCOPE),
    readOnly: () => this.options.readOnly === true,
    bots: () => this.state.bots.map((bot) => ({ id: bot.id, name: bot.name })),
    readStatus: (botId, send) => this.accounts.readStatus(botId, send),
    listDevices: () => this.deviceApprovals.listDevices(),
    latestTask: (botId) => {
      const tasks = this.state.tasksByBot[botId] ?? [];
      let latest: { key: string; at: number } | null = null;
      for (const task of tasks) {
        const at = task.updatedAt ?? 0;
        if (!latest || at > latest.at) latest = { key: task.key, at };
      }
      return latest?.key ?? null;
    },
    deviceId: () => this.state.connection.deviceId,
    now: () => this.now(),
  });
  /** Waiting devices this admin connection can approve (`device-approval.ts`); its state is `deviceRequests`. */
  private readonly deviceApprovals = new DeviceApprovals({
    request: (method, params) => this.request(method, params),
    // A setup connection publishes typed outcomes only, so it lists, approves and denies nothing,
    // whichever path asks (a window's refresh included); its hello and events already skip it.
    admin: () =>
      this.holds(ADMIN_SCOPE) && !this.options.readOnly && !this.isSetup(this.settings?.url),
    pairing: () => this.holds(PAIRING_SCOPE),
    answered: (error) => error instanceof GatewayProtocolRequestError,
    now: () => this.now(),
    later: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    get: () => this.state.deviceRequests,
    set: (deviceRequests) => this.store.update((state) => ({ ...state, deviceRequests })),
    random: (bytes) => {
      const out = new Uint8Array(bytes);
      const api = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => void } }).crypto;
      if (api?.getRandomValues) api.getRandomValues(out);
      else for (let i = 0; i < bytes; i += 1) out[i] = Math.floor(Math.random() * 256);
      return out;
    },
  });
  /**
   * Task lists being read, each its rows so far, already bounded: at most two,
   * a hello's and one refresh (refreshes run one at a time; a changed
   * connection's read ends when its requests are flushed).
   */
  private readonly listings = new Set<Map<string, RawRecord>>();
  private refreshing = false;
  private refreshAgain = false;
  /**
   * Bots the gateway stopped listing while the task read now out was asked: that read's rows for
   * them are dropped, so a stale answer can't bring a deleted bot's tasks back.
   */
  private readonly removedDuringRead = new Set<string>();
  /** A removal that didn't fit in `removedDuringRead`: the task read now out is dropped whole. */
  private readOutdated = false;
  /**
   * The last whole roster on this connection: its ids, at most `MAX_BOTS` of them, and whether
   * that was all of them (`none` before one). A bot that leaves it, or joins it, is known
   * against it.
   */
  private readonly lastRosterIds = new Set<string>();
  private lastRoster: "none" | "all" | "some" = "none";

  /** Tasks followed at once: the host's count, at most `MAX_TRACKED_TASKS`. */
  private readonly trackedLimit: number;

  /**
   * Every viewer's Computer tab (`computer.ts`): what the plugin answered, the
   * views and the control. Tickets, streams, frames, generations and queued
   * input stay in it; only codes and plain facts reach the state.
   */
  /** Whether the latest hello's `features.methods` lists the voice plugin's read, or null when it listed none. */
  private voiceAdvertised: boolean | null = null;
  private readonly computer: ComputerViews = new ComputerViews({
    request: (method, params) => this.request(method, params),
    openStream: (url) => {
      const socket = this.host.createWebSocket(url);
      // Frames arrive as bytes; a socket without the setting gives bytes of its own kind.
      socket.binaryType = "arraybuffer";
      return socket;
    },
    gatewayUrl: () => this.state.connection.gatewayUrl,
    canWrite: () =>
      this.state.connection.status === "connected" &&
      this.state.connection.canWrite &&
      !this.options.readOnly,
    online: () => this.state.connection.status === "connected",
    now: () => this.now(),
    get: () => this.state.computer ?? initialComputerState,
    set: (computer) => this.store.update((state) => ({ ...state, computer })),
    pendingQuestion: (key) =>
      this.state.transcripts[key]?.questions.find((q) => q.status === "pending") ?? null,
    questionStatus: (key, id) =>
      this.state.transcripts[key]?.questions.find((q) => q.id === id)?.status ?? null,
    answer: (key, id, answers, owner) => this.answerQuestion(key, id, answers, { owner }),
    withdraw: (owner) => this.withdraw(owner),
    stopTask: (key, owner) => this.stopTask(key, owner),
    log: (level, message) => this.log(level, message),
  });

  constructor(host: ClawtrateHost, options: ClientOptions = {}) {
    this.host = host;
    this.writes = connectionWrites.get(host.storage) ?? {
      pending: Promise.resolve(),
      owners: new Map(),
      rejected: new Map(),
      refusals: 0,
      rotations: new Map(),
      grants: new Map(),
      settingsRevision: 0,
      inFlightSettings: null,
      choices: 0,
      chosen: 0,
      retiredShared: new Map(),
    };
    connectionWrites.set(host.storage, this.writes);
    this.options = options;
    this.turnLimitMs = options.turnLimitMs ?? DEFAULT_TURN_LIMIT_MS;
    this.trackedLimit = hostLimit(options.limits?.trackedTasks, MAX_TRACKED_TASKS, "trackedTasks");
  }

  get state(): ClawtrateState {
    return this.store.get();
  }

  /** The gateway saved from an earlier run, if any. */
  async savedSettings(): Promise<ConnectionSettings | null> {
    const raw = await this.host.storage.get(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as ConnectionSettings) : null;
  }

  /** Run a read, or abandon it with `fallback` if `stop()` runs first. */
  private async raceStop<T>(stops: number, read: () => Promise<T>, fallback: T): Promise<T> {
    if (stops !== this.stops) return fallback;
    let stop!: () => void;
    const stopped = new Promise<T>((resolve) => (stop = () => resolve(fallback)));
    this.stopWaiters.add(stop);
    try {
      return await Promise.race([read(), stopped]);
    } finally {
      this.stopWaiters.delete(stop);
    }
  }

  /** Read the saved gateway, or abandon the read if `stop()` runs first. */
  private readSavedSettings(stops: number): Promise<ConnectionSettings | null> {
    return this.raceStop(stops, () => this.savedSettings(), null);
  }

  /** Written first: settings the host could not save are never the ones in use. */
  private async saveSettings(settings: ConnectionSettings): Promise<void> {
    await this.writeRecord(settings);
    this.settings = settings;
  }

  /** Saved as a choice the person made: any setup chosen before `choice` steps aside. */
  private async saveChoice(
    settings: ConnectionSettings,
    choice: number = ++this.writes.choices,
  ): Promise<void> {
    await this.saveSettings(settings);
    if (choice > this.writes.chosen) this.writes.chosen = choice;
    // Another gateway saved as the choice: a replacement still waiting for its own gateway's
    // first paired hello is over, and the saved gateway is this one.
    if (this.replacing && this.replacing.url !== settings.url) this.replacing = null;
  }

  /** The saved record alone; this client's settings stay as they are. */
  private async writeRecord(record: ConnectionSettings): Promise<void> {
    const write: { settledRevision: number | null } = { settledRevision: null };
    this.writes.inFlightSettings = write;
    try {
      await this.host.storage.set(SETTINGS_KEY, JSON.stringify(record));
      const rev = ++this.writes.settingsRevision;
      write.settledRevision = rev;
      this.seenRevision = rev;
      this.pendingSeen = null;
    } finally {
      if (this.writes.inFlightSettings === write) this.writes.inFlightSettings = null;
    }
  }

  private async forgetRecord(): Promise<void> {
    const write: { settledRevision: number | null } = { settledRevision: null };
    this.writes.inFlightSettings = write;
    try {
      await this.host.storage.delete(SETTINGS_KEY);
      const rev = ++this.writes.settingsRevision;
      write.settledRevision = rev;
      this.seenRevision = rev;
      this.pendingSeen = null;
    } finally {
      if (this.writes.inFlightSettings === write) this.writes.inFlightSettings = null;
    }
  }

  /**
   * Whether the saved record is the one this client last read or wrote. Any other is another
   * client's on this store, saved or forgotten since, and this client changes in it only what it
   * means to change.
   */
  private recordSeen(saved?: ConnectionSettings | null): boolean {
    if (this.seenRevision === this.writes.settingsRevision) return true;
    const pending = this.pendingSeen;
    if (!pending || saved === undefined) return false;
    const expected = pending.write.settledRevision ?? pending.before;
    if (expected !== this.writes.settingsRevision) return false;
    const savedRaw = saved === null ? null : JSON.stringify(saved);
    if (savedRaw !== pending.raw) return false;
    this.seenRevision = expected;
    this.pendingSeen = null;
    return true;
  }

  /**
   * The choice number a setup for `url` may save under, or null once a newer choice committed on
   * this store (including a Connect to the same URL or a real Forget). Non-choices — a token
   * clear, a suspension, or Back from an empty store — leave `chosen` alone. Decided without
   * reading the store, so nothing runs between a save's check that its socket is live and its write.
   */
  private setupMaySave(url: string): number | null {
    const chosen = this.setupChosen;
    return chosen?.url === url && chosen.choice >= this.writes.chosen ? chosen.choice : null;
  }

  /**
   * Run one change to the selected gateway, its saved settings or its device
   * token after the previous one has settled, so each reads and writes what the
   * last one left.
   */
  private changeConnection<T>(change: () => Promise<T>): Promise<T> {
    const run = this.writes.pending.then(change);
    this.writes.pending = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * A Disconnect, Suspend or Retry, queued. Sent while `start` reads the saved gateway, it waits
   * for that read and fails if the read did.
   */
  private connectionCommand(change: (stops: number) => Promise<void>): Promise<void> {
    const stops = this.stops;
    const restoring = this.restoring;
    const run = this.changeConnection(async () => {
      const outcome = await restoring?.read;
      if (stops !== this.stops) return;
      if (outcome?.failed) throw outcome.error;
      return change(stops);
    });
    restoring?.commands.push(run);
    return run;
  }

  /**
   * Resume the saved gateway by default. With `resume: false`, skip reading
   * the gateway settings. With `resume: "disconnected"`, load the saved
   * gateway so the host can offer it as a choice without opening a socket.
   */
  async start(options: { resume?: boolean | "disconnected" } = {}): Promise<void> {
    const stops = this.stops;
    const selection = this.selectionApplied;
    const prior = this.settings;
    // Published before the first wait: a command sent while the identity loads waits too.
    const commands = this.connectionCommands;
    type ReadOutcome = { failed: false } | { failed: true; error: unknown };
    let release!: (outcome: ReadOutcome) => void;
    const read = new Promise<ReadOutcome>((resolve) => (release = resolve));
    const restoring = { read, release, commands: [] as Promise<unknown>[] };
    this.restoring = restoring;
    this.startReads.add(restoring);
    let settings: ConnectionSettings | null;
    let outcome: ReadOutcome = { failed: false };
    try {
      try {
        const identity = await this.loadIdentity();
        if (stops !== this.stops) return;
        this.setConnection({ deviceId: identity.deviceId });
        // A turn limit the person chose earlier, unless the host was given one.
        const sets = { ...this.preferenceSets };
        const limit =
          this.options.turnLimitMs === undefined
            ? Number(await this.host.storage.get(TURN_LIMIT_KEY).catch(() => null))
            : null;
        const channelChats =
          (await this.host.storage.get(CHANNEL_CHATS_KEY).catch(() => null)) === "true";
        const otherTools =
          (await this.host.storage.get(OTHER_TOOLS_KEY).catch(() => null)) === "true";
        // In the names' queue, so a rename sent meanwhile starts from what was read. A stop ends
        // the wait, so a read that never answers can't hold the queue for later starts and
        // renames. A failed or abandoned read is null: the names already held stay.
        const names = await this.inOrder("gatewayNames", () =>
          this.raceStop<GatewayNames | null>(
            stops,
            async () => {
              try {
                return readGatewayNames(await this.host.storage.get(GATEWAY_NAMES_KEY));
              } catch {
                return null;
              }
            },
            null,
          ),
        );
        const gatewayBot =
          (await this.host.storage.get(GATEWAY_BOT_KEY).catch(() => null)) === "true";
        // A startup stopped while it read keeps nothing: the next one reads again. A preference
        // the person set meanwhile is newer than what was read.
        if (stops !== this.stops) return;
        if (
          sets.turnLimit === this.preferenceSets.turnLimit &&
          limit !== null &&
          validTurnLimit(limit)
        )
          this.turnLimitMs = limit * 60_000;
        if (sets.channelChats === this.preferenceSets.channelChats)
          this.showChannelChats = channelChats;
        if (names !== null && sets.gatewayNames === this.preferenceSets.gatewayNames)
          this.gatewayNames = names;
        if (sets.otherTools === this.preferenceSets.otherTools)
          this.showOtherToolSessions = otherTools;
        if (sets.gatewayBot === this.preferenceSets.gatewayBot) this.showGatewayBot = gatewayBot;
        this.store.update((state) => ({
          ...state,
          turnLimitMinutes: this.turnLimitMs / 60_000,
          showChannelChats: this.showChannelChats,
          showOtherToolSessions: this.showOtherToolSessions,
          showGatewayBot: this.showGatewayBot,
        }));
        if (options.resume === false) return;
        // Startup needs to open the socket without waiting for another client's credential write.
        // A write that lands during the read may or may not be in what it returned, so the record
        // is read again, twice at most, until no write lands across a read — unless a command
        // queued meanwhile, which acts on the gateway already captured. A command queued while a
        // reread was pending discards that reread and its revision. Only an uncontended read
        // claims its revision, so the record and revision this client keeps go together.
        let before = this.writes.settingsRevision;
        let writingBefore = this.writes.inFlightSettings;
        settings = await this.savedSettings();
        for (
          let again = 0;
          again < 2 &&
          stops === this.stops &&
          restoring.commands.length === 0 &&
          before !== this.writes.settingsRevision;
          again += 1
        ) {
          const rereadBefore = this.writes.settingsRevision;
          const rereadWriting = this.writes.inFlightSettings;
          const reread = await this.savedSettings();
          if (restoring.commands.length > 0) break;
          before = rereadBefore;
          writingBefore = rereadWriting;
          settings = reread;
        }
        const after = this.writes.settingsRevision;
        const inFlight = this.writes.inFlightSettings ?? writingBefore;
        const uncontended = before === after && inFlight === null;
        if (stops !== this.stops || selection !== this.selectionApplied || this.settings !== prior)
          return;
        this.settings = settings;
        this.seenRevision = uncontended ? before : null;
        this.pendingSeen =
          !uncontended && before === after && inFlight !== null
            ? {
                before,
                write: inFlight,
                raw: settings === null ? null : JSON.stringify(settings),
              }
            : null;
      } catch (error) {
        outcome = { failed: true, error };
        throw error;
      } finally {
        release(outcome);
      }
      // Publish before clearing `restoring` so commands sent from this notification wait ahead of resume.
      if (restoring.commands.length > 0 && settings) {
        this.setConnection({ status: "disconnected", gatewayUrl: settings.url });
      }
    } finally {
      if (this.restoring === restoring) this.restoring = null;
      this.startReads.delete(restoring);
    }
    // A Disconnect, Suspend or Retry sent during the read (or its notification) decides what
    // happens to the gateway. One that was refused leaves it to startup.
    if (restoring.commands.length > 0) {
      await Promise.allSettled(restoring.commands);
      if (stops !== this.stops || selection !== this.selectionApplied) return;
    }
    if (commands !== this.connectionCommands) return;
    if (settings && (settings.suspended || options.resume === "disconnected")) {
      this.setConnection({ status: "disconnected", gatewayUrl: settings.url });
      return;
    }
    if (settings) await this.open();
  }

  /**
   * Connect to a gateway. A token is only needed until this device is paired. `setup` is for a
   * host's own setup only: the address form passes none. With local connect's proved sockets
   * and the person's consent it is the route a first pairing at this computer's gateway may ask
   * for full access on (docs/design/setup-effortless.md §3).
   */
  async connect(options: ConnectOptions, setup: SetupEndpointCheck = {}): Promise<void> {
    const stops = this.stops;
    const selection = ++this.selectionAsked;
    const endsAtStart = this.eligibilityEnds;
    const waiting: WaitingConnect = {
      url: gatewayUrlOrNull(options.url),
      cancelled: false,
      older: this.waitingConnects,
    };
    this.waitingConnects = waiting;
    return this.settleConnect(waiting, async () => {
      const url = validateGatewayUrl(options.url);
      if (!this.isAllowed(url)) throw new GatewayNotAllowedError(url);
      const token = options.token?.trim() || null;
      const switched = this.settings?.url !== url;
      const routed = setup.createSocket !== undefined && setup.route !== undefined;
      // Over a proved route, the gateway is saved with that route, and so is its token. It is
      // saved only once this device is paired there (its first hello): until then the saved
      // gateway stays as it was, and a Connect that fails or is let go selects it again.
      const chosen = { url, token, ...(routed ? { route: setup.route } : {}) };
      if (routed) {
        this.replacing = { url, previous: this.replacing?.previous ?? this.settings };
        this.settings = chosen;
        const choice = ++this.writes.choices;
        this.writes.chosen = choice;
        this.setupChosen = { url, choice };
      } else {
        await this.saveChoice(chosen);
        // Saved: a Connect over a proved route still waiting, at this address too, is over. One
        // that couldn't be saved leaves that wait, and the earlier gateway's record, as they were.
        this.replacing = null;
      }
      this.writes.retiredShared.delete(url);
      // The selection changes only once this choice was valid and saved: a refused one leaves
      // the connection that stays open its own, and its attempt as it was.
      this.selectionApplied = selection;
      this.typedAttempt = token ? { url, token, selection } : null;
      // The person chose to connect, and that choice is now the attempt: a new pairing may ask
      // for full access, unless a refusal or loss accepted since this Connect began says not.
      this.fullEligible = this.eligibleSince(endsAtStart, waiting);
      this.planHadToken = false;
      if (switched) this.abandonAccessRequest("Switched to another gateway.");
      this.setupCode = null;
      this.setupCheck = setupCheckFor(url, setup);
      this.setupIntent = null;
      this.setupUpdate = null;
      this.pairingSeen = null;
      if (stops === this.stops) await this.open({ newTarget: true });
    });
  }

  /**
   * Connect with a one-time setup code the host made and redeems at once
   * (docs/design/setup.md §7). The code stays in memory, is never written to
   * storage, and is dropped after the first hello or failure. The first device
   * token is written only when the gateway granted the operator role and
   * exactly `operator.read` (with full access, scopes within the six it asked
   * for); anything else writes nothing and disconnects. The
   * gateway is saved once that token is.
   */
  async connectWithSetupCode(
    options: { url: string; bootstrapToken: string; expiresAtMs: number },
    setup: SetupEndpointCheck = {},
  ): Promise<void> {
    const stops = this.stops;
    const selection = ++this.selectionAsked;
    const endsAtStart = this.eligibilityEnds;
    const waiting: WaitingConnect = {
      url: gatewayUrlOrNull(options.url),
      cancelled: false,
      older: this.waitingConnects,
    };
    this.waitingConnects = waiting;
    return this.settleConnect(waiting, async () => {
      const url = validateGatewayUrl(options.url);
      if (!this.isAllowed(url)) throw new GatewayNotAllowedError(url);
      if (!options.bootstrapToken) throw new Error("A setup code needs its token.");
      this.selectionApplied = selection;
      // The person chose to connect, and that choice is now the attempt: a new pairing may ask
      // for full access, unless a refusal or loss accepted since this Connect began says not.
      this.fullEligible = this.eligibleSince(endsAtStart, waiting);
      this.planHadToken = false;
      this.typedAttempt = null;
      if (this.settings?.url !== url) this.abandonAccessRequest("Switched to another gateway.");
      this.settings = setupSettings(url, setup);
      this.setupChosen = { url, choice: ++this.writes.choices };
      this.pairingSeen = null;
      this.setupCheck = setupCheckFor(url, setup);
      this.setupIntent = { url, reuse: false };
      this.setupCode = {
        url,
        bootstrapToken: options.bootstrapToken,
        expiresAtMs: options.expiresAtMs,
      };
      if (stops === this.stops) await this.open({ newTarget: true });
    });
  }

  /**
   * Reconnect for the host's setup with this device's saved token for `url`,
   * asking for `operator.read` alone, on this socket and its retries, whatever
   * the saved record holds or comes to hold. Wider access the device already
   * holds stays saved for later ordinary connections. If the token is gone by
   * the time the socket asks, nothing is sent and the connection ends with
   * `SETUP_PAIRING_GONE`.
   */
  async connectForSetup(url: string, setup: SetupEndpointCheck = {}): Promise<void> {
    const stops = this.stops;
    const selection = ++this.selectionAsked;
    return this.changeConnection(async () => {
      const target = validateGatewayUrl(url);
      if (!this.isAllowed(target)) throw new GatewayNotAllowedError(target);
      this.selectionApplied = selection;
      if (this.settings?.url !== target) this.abandonAccessRequest("Switched to another gateway.");
      this.setupCode = null;
      this.settings = setupSettings(target, setup);
      this.setupChosen = { url: target, choice: ++this.writes.choices };
      this.pairingSeen = null;
      this.setupCheck = setupCheckFor(target, setup);
      this.setupIntent = { url: target, reuse: true };
      if (stops === this.stops) await this.open({ newTarget: true });
    });
  }

  /**
   * The number the next choice of gateway will get: read just before a connect
   * call, it names that connect's selection.
   */
  nextSelection(): number {
    return this.selectionAsked + 1;
  }

  /** Whether `selection` is the gateway chosen now. */
  isSelected(selection: number): boolean {
    return this.selectionApplied === selection;
  }

  /** Whether `selection` is the gateway chosen now, and its bots and tasks were read in full. */
  readyFor(selection: number): boolean {
    return (
      this.selectionApplied === selection &&
      this.selectionReady === selection &&
      this.state.discovery.status === "ready"
    );
  }

  /** Whether this device has a saved pairing for the gateway at `url`: `new` without one. */
  async deviceAccess(url: string): Promise<"new" | "paired"> {
    return (await this.hasDeviceToken(url)) ? "paired" : "new";
  }

  /** Whether this device already holds a token for the gateway at `url`. */
  async hasDeviceToken(url: string): Promise<boolean> {
    const identity = await this.loadIdentity();
    return (await this.loadToken(validateGatewayUrl(url), identity.deviceId, "operator")) !== null;
  }

  /** The host's setup slice: what its look found and where setup stands. */
  setSetup(next: SetupState | undefined): void {
    this.setupSlice = next;
    this.store.update((state) => ({ ...state }));
    // Kept as the store bounded it, so nothing beyond its bounds stays in memory.
    this.setupSlice = this.state.setup;
  }

  /**
   * Close the connection and forget the gateway. The device key and any device
   * token remain. With `gatewayUrl`, only that gateway is forgotten: the address
   * the person saw, which another viewer may have changed since.
   */
  async disconnect(gatewayUrl?: string, selection?: number): Promise<void> {
    const asked = ++this.selectionAsked;
    return this.connectionCommand(async (stops) => {
      if (!this.settings) return;
      if (gatewayUrl !== undefined && this.settings.url !== gatewayUrl) {
        throw new GatewayChangedError();
      }
      // A cleanup for one selection never ends a later one, even of the same address.
      if (selection !== undefined && this.selectionApplied !== selection) {
        throw new GatewayChangedError();
      }
      // Forgotten first: a gateway the host could not forget stays connected, as it stays saved,
      // and stays the selection it was. A record another client on this store saved or changed
      // since is that client's, and stays, even for this gateway.
      const saved = await this.readSavedSettings(stops);
      if (!this.settings || stops !== this.stops) return;
      // A Connect over a proved route that isn't paired yet saved nothing: the record is the
      // earlier gateway's, and stays, and that gateway is selected again (below).
      const replacing = this.replacing;
      this.replacing = null;
      if (replacing) this.writes.chosen = ++this.writes.choices;
      else if (saved === null || this.recordSeen(saved)) {
        await this.forgetRecord();
        // A real deletion (not Back on an empty store) is a choice that blocks older setup saves.
        if (saved !== null) this.writes.chosen = ++this.writes.choices;
      }
      // The earlier gateway, still saved: selected again, as it is after a start that doesn't
      // resume, for Reconnect to open.
      this.selectAgain(
        asked,
        replacing?.previous && saved?.url === replacing.previous.url ? saved : null,
      );
    });
  }

  /**
   * Ends the connection and everything of its gateway's here, and selects `previous` again (a
   * saved gateway, as the record holds it: disconnected, for Reconnect to open), or nothing.
   */
  private selectAgain(asked: number, previous: ConnectionSettings | null): void {
    this.connectionCommands += 1;
    this.selectionApplied = asked;
    this.abandonAccessRequest("Disconnected from the gateway.");
    this.close();
    this.setupCode = null;
    this.setupCheck = null;
    this.setupIntent = null;
    this.setupUpdate = null;
    this.settings = null;
    this.pairingSeen = null;
    this.rows = new Map();
    this.raw.clear();
    this.retained.clear();
    this.forgetGatewayState();
    this.target += 1;
    this.settings = previous;
    this.store.set({
      ...initialState,
      turnLimitMinutes: this.turnLimitMs / 60_000,
      showChannelChats: this.showChannelChats,
      showOtherToolSessions: this.showOtherToolSessions,
      showGatewayBot: this.showGatewayBot,
      connection: {
        ...initialConnectionState,
        deviceId: this.identity?.deviceId ?? null,
        target: this.target,
        ...(previous ? { status: "disconnected" as const, gatewayUrl: previous.url } : {}),
      },
    });
  }

  /**
   * The user's retry. While connected it reloads bots and tasks; otherwise it
   * reconnects at once, keeping what is already on screen.
   */
  async retryNow(): Promise<void> {
    let reload: number | null = null;
    // The reload runs outside the queue: it changes nothing saved.
    await this.connectionCommand(async (stops) => {
      if (!this.settings) return;
      if (this.setupIntent?.refusal === "pairing-changed") return;
      if (this.protocol?.connected && this.state.connection.status === "connected") {
        reload = this.generation;
        return;
      }
      if (this.settings.suspended) {
        // Reconnect is the person's latest choice, as Connect is. A record of this gateway keeps
        // what is in it now: another client, or the store itself, may have changed its token.
        const saved = await this.readSavedSettings(stops);
        if (!this.settings || stops !== this.stops) return;
        if (saved?.url === this.settings.url) {
          await this.saveChoice({ ...saved, suspended: false });
        } else if (this.recordSeen(saved)) {
          await this.saveChoice({ ...this.settings, suspended: false });
        } else {
          // Another client saved another gateway or forgot this one since. Drop this client's
          // token when a pairing on this store retired it, even if that device token was refused
          // since, or a device token has replaced it (or on a secure store, where switching
          // retired any migrated token and typed tokens stay in memory only). Keep it when it is
          // still this gateway's only credential on a plain-file store.
          const { token, url } = this.settings;
          const dropToken =
            token !== null &&
            (this.host.credentialStatus !== undefined ||
              this.writes.retiredShared.get(url) === token ||
              (await this.raceStop(stops, () => this.hasDeviceToken(url), true)));
          if (!this.settings || stops !== this.stops) return;
          await this.saveChoice({
            ...this.settings,
            ...(dropToken ? { token: null } : {}),
            suspended: false,
          });
        }
      }
      if (stops !== this.stops) return;
      // Counted once it opens: one whose open failed, or was stopped, leaves startup to open the
      // saved gateway. A stop frees the queue at once: the open, still reading this device's
      // token, gives up at its next check and writes nothing, so another client's change needn't
      // wait for that read.
      await this.raceStop(stops, () => this.open(), undefined);
      if (stops !== this.stops) return;
      this.connectionCommands += 1;
    });
    if (reload !== null && reload === this.generation) {
      const epoch = this.epoch;
      await this.bootstrap(reload, null);
      // A retry can finish setup on a connection whose hello skipped the update read: read it
      // now, as the hello's continuation would have.
      if (
        reload === this.generation &&
        epoch === this.epoch &&
        this.state.connection.status === "connected" &&
        !this.isSetup(this.settings?.url)
      )
        void this.openclawUpdates.onHello();
    }
  }

  /**
   * Close the connection and keep everything else: the gateway, the device's
   * pairing and what is on screen. `retryNow` reconnects.
   */
  async suspend(): Promise<void> {
    return this.connectionCommand(async (stops) => {
      if (!this.settings) return;
      // Saved, so a restart does not reconnect by itself; a token typed for this attempt ends with it.
      // Taken before the read: a refusal during it ends the attempt and drops its token from memory.
      const url = this.settings.url;
      const typed = this.typedTokenEnds(url) ? this.settings.token : null;
      // Read the current record so another client's gateway or newer token stays intact.
      const saved = await this.readSavedSettings(stops);
      if (!this.settings || stops !== this.stops) return;
      // A Connect over a proved route that isn't paired yet saved nothing: the record is the
      // earlier gateway's. Suspending ends that Connect as Back does: the suspension is recorded
      // on the earlier gateway's record as it stands, which is selected again, and nothing of
      // the new gateway is saved.
      const replacing = this.replacing?.url === url ? this.replacing : null;
      if (replacing) {
        const earlier = replacing.previous && saved?.url === replacing.previous.url ? saved : null;
        if (earlier && !earlier.suspended) await this.writeRecord({ ...earlier, suspended: true });
        if (stops !== this.stops) return;
        this.replacing = null;
        this.writes.chosen = ++this.writes.choices;
        this.selectAgain(++this.selectionAsked, earlier && { ...earlier, suspended: true });
        return;
      }
      if (saved?.url === url) {
        // From the record as it is now: another client, or the store itself, may have changed
        // its token since. Only the suspension and the typed token, if it is still the one
        // saved, change.
        await this.saveSettings({
          ...saved,
          suspended: true,
          ...(typed && saved.token === typed ? { token: null } : {}),
        });
      } else if (this.recordSeen(saved)) {
        await this.saveSettings({
          ...this.settings,
          suspended: true,
          ...(typed ? { token: null } : {}),
        });
      } else {
        // Another client saved another gateway or forgot this one since, and a restart opens what
        // it left.
        this.settings = { ...this.settings, suspended: true, ...(typed ? { token: null } : {}) };
      }
      this.connectionCommands += 1;
      // Only once that is saved does the attempt end: a Disconnect that failed keeps it.
      this.endAttempt(url);
      // The connection stops: writes waiting for access fail, as on any lost connection.
      // Runs are kept as they are and reconciled with history after Reconnect.
      this.abandonAccessRequest("Disconnected from the gateway.");
      this.close();
      this.target += 1;
      this.setConnection({
        status: "disconnected",
        retryAt: null,
        error: null,
        pairing: null,
        target: this.target,
      });
    });
  }

  /**
   * Whether the current settings carry the token the person typed for this attempt, on a host
   * that keeps such tokens in memory only (one with `credentialStatus`), and so whether that
   * token ends now. It is forgotten for the attempt either way.
   */
  private typedTokenEnds(url: string): boolean {
    const typed = this.typedAttempt;
    if (!typed || typed.url !== url) return false;
    return (
      this.host.credentialStatus !== undefined &&
      this.selectionApplied === typed.selection &&
      this.settings?.url === url &&
      this.settings.token === typed.token
    );
  }

  /**
   * An attempt ended for good (a refusal or an ended pairing request): the token typed for it
   * goes from the settings, in memory at once and then saved, unless a newer attempt took over.
   */
  private endTypedAttempt(url: string): void {
    const selection = this.typedAttempt?.selection;
    const token = this.typedAttempt?.token;
    const typed = this.typedTokenEnds(url);
    this.endAttempt(url);
    if (!typed || !this.settings) return;
    this.settings = { ...this.settings, token: null };
    void this.changeConnection(async () => {
      const current = this.settings;
      if (!current || current.url !== url || this.selectionApplied !== selection) return;
      if (current.token !== null) return;
      // Only from the record as it is now, and only while it still holds this token: another
      // client on this store may have saved another gateway, or forgotten this one, since.
      const saved = await this.savedSettings();
      if (saved?.url !== url || saved.token !== token) return;
      // This client's settings take the record it wrote, a suspension another client saved
      // with it, so Reconnect lifts that suspension.
      await this.saveSettings({ ...saved, token: null });
    }).catch(() => this.log("warn", "Could not drop the gateway token from this device."));
  }

  /** Full-access eligibility ends now, and a Connect already under way doesn't grant it back. */
  private endEligibility(url: string | null = this.settings?.url ?? null): void {
    for (let waiting = this.waitingConnects; waiting; waiting = waiting.older)
      if (waiting.url === url) waiting.cancelled = true;
    this.fullEligible = false;
    this.eligibilityEnds += 1;
  }

  /** A Connect's change, queued; whatever it ends with, it no longer waits. */
  private settleConnect(waiting: WaitingConnect, change: () => Promise<void>): Promise<void> {
    return this.changeConnection(change).finally(() => this.releaseConnect(waiting));
  }

  /** Takes a Connect out of `waitingConnects`, if it is still there. */
  private releaseConnect(waiting: WaitingConnect): void {
    let newer: WaitingConnect | null = null;
    let link = this.waitingConnects;
    while (link && link !== waiting) {
      newer = link;
      link = link.older;
    }
    if (!link) return;
    if (newer) newer.older = link.older;
    else this.waitingConnects = link.older;
  }

  /**
   * Whether a Connect, begun when `endsAtStart` ends had happened, may grant full access now that
   * it applies: no end since it began, or none for its own address.
   */
  private eligibleSince(endsAtStart: number, waiting: WaitingConnect): boolean {
    this.releaseConnect(waiting);
    return this.eligibilityEnds === endsAtStart || !waiting.cancelled;
  }

  /** The attempt on this address ended: no full pairing by itself, and its typed token is done. */
  private endAttempt(url: string): void {
    if (this.settings?.url !== url) return;
    this.endEligibility(url);
    if (this.typedAttempt?.url === url) this.typedAttempt = null;
  }

  /** Stop without forgetting anything. Used when the host process exits. */
  stop(): void {
    this.stops += 1;
    // A command waiting for startup's read no longer holds other clients' writes.
    for (const restoring of this.startReads) restoring.release({ failed: false });
    this.startReads.clear();
    this.restoring = null;
    for (const stop of this.stopWaiters) stop();
    this.close();
    this.target += 1;
    this.setConnection({ target: this.target });
  }

  /** Open a transcript. Calls are counted; the last matching close releases it. */
  openSession(key: string, reservation = false): void {
    // A task's key is kept, and keys every map of the task, only within the id cap.
    if (jsonTextLength(key) > MAX_ID_CHARS) throw new Error("That task key is too long.");
    const taken = this.openSessions.size + this.retained.size + this.reservedTasks;
    if (!this.tracked(key) && !reservation && taken >= this.trackedLimit) {
      throw new Error(`At most ${this.trackedLimit} tasks can be open at once.`);
    }
    const count = this.openSessions.get(key) ?? 0;
    const before = count === 0 ? this.keptKeys() : null;
    this.openSessions.set(key, count + 1);
    if (before) this.relistIfHidden(key, before);
    if (count > 0) {
      // A view coming to a task whose history failed asks for it, as a first open would,
      // unless a read already under way will settle it.
      if (this.state.transcripts[key]?.status === "error") this.reloadSession(key);
      return;
    }
    // A task closed with unsent work was kept: reopening shows the same queue.
    const kept = this.retained.delete(key);
    if (!kept || !this.incarnations.has(key))
      this.incarnations.set(key, (this.nextIncarnation += 1));
    this.setTranscript(key, (current) => current ?? this.openedTranscript(key));
    // An approval waiting for a task that can show it may belong here now.
    this.routeUnrouted();
    if (this.state.connection.status === "connected") void this.loadTranscript(key, !kept, null);
  }

  /**
   * Read an open task's history again, keeping every hold on it: the retry of a
   * failed read. Closing and opening again would not read while another viewer
   * holds the task, since only the first open reads.
   */
  reloadSession(key: string, failed?: string): void {
    if (!this.openSessions.has(key)) throw new Error("That task isn't open.");
    const current = this.state.transcripts[key];
    if (failed !== undefined && (current?.status !== "error" || current.error !== failed)) return;
    const load = this.loads.get(key);
    if (load) {
      // A read already under way settles this task; coalescing avoids queuing a second read
      // behind it (for instance from a second Try again before the loading snapshot arrives).
      if (current?.status !== "error") return;
      // Capture the incarnation before publishing loading: a synchronous store listener can close
      // every hold and reopen the same key, replacing it before this call returns.
      const incarnation = this.incarnations.get(key);
      this.setTranscript(key, () => ({ ...current, status: "loading", error: null }));
      // A read that published its failure while this retry arrived (its listeners run before it
      // ends) settles nothing more: still loading once it ends, the task is read again. A close
      // and reopen between here and then is a different task, so its incarnation must still match.
      // That read subscribes again, as a retry of a failed task does when no read is under way:
      // the failure cleared above may have been its live updates (#592).
      void load.done.then(() => {
        if (
          this.openSessions.has(key) &&
          this.incarnations.get(key) === incarnation &&
          this.state.transcripts[key]?.status === "loading" &&
          this.state.connection.status === "connected"
        )
          void this.loadTranscript(key, true, null);
      });
      return;
    }
    // A task that failed may have failed to subscribe: Try again subscribes again (a read).
    const subscribe = current?.status === "error";
    if (current?.status === "error")
      this.setTranscript(key, () => ({ ...current, status: "loading", error: null }));
    if (this.state.connection.status === "connected")
      void this.loadTranscript(key, subscribe, null);
  }

  /** Keep only Raw entries that still belong to this task's retained state. */
  private retainTaskRaw(key: string, after: TaskActivity): void {
    this.raw.retainTask(
      key,
      after.runs.flatMap((run) => [
        ...run.steps.map((step) => step.id),
        // Also while a marked end waits for history: it may yet be the failure, Raw and all (#680).
        ...(run.error?.raw || run.quietError?.raw ? [runErrorRawId(run.id)] : []),
      ]),
    );
  }

  /**
   * Release a viewer's interest. When the last one goes, a task that still holds
   * unsent, unconfirmed or failed words, or a run this client started, is kept
   * and followed until that work is done or the user cancels it; otherwise it
   * is released.
   */
  closeSession(key: string): void {
    const count = this.openSessions.get(key);
    if (!count) return;
    if (count > 1) {
      this.openSessions.set(key, count - 1);
      return;
    }
    const before = this.keptKeys();
    this.openSessions.delete(key);
    this.relistIfHidden(key, before);
    const transcript = this.state.transcripts[key];
    if (transcript && hasUnsettledWork(transcript)) {
      this.retained.add(key);
      return;
    }
    this.releaseTask(key);
  }

  /** Whether a task waits for the person (`waiting.ts`), whatever its row says. */
  private readonly waits = (key: string): boolean => this.waiting.waitingFor(key) !== null;

  /** Whether the row cap keeps a task ahead of the others: it waits for the person, or is open. */
  private readonly keeps = (key: string): boolean => this.waits(key) || this.openSessions.has(key);

  /** Counts changes to what waits, so a list read can tell whether one came while it ran. */
  private waitingEpoch = 0;

  /** Whether a task waits but the list holds no row for it. */
  private readonly unheldWait = (key: string): boolean =>
    !isExcludedSessionKey(key) && !this.rows.has(capId(key, MAX_ID_CHARS));

  /**
   * After what waits changed: the list again, and, for a task that waits but whose row the
   * client does not hold, the list read again so it is listed until answered.
   */
  private waitingChanged(before: ReadonlySet<string>): void {
    this.waitingEpoch += 1;
    this.publishTasks(before);
    if (this.waiting.keys().some(this.unheldWait)) this.scheduleRefresh(this.generation);
  }

  /**
   * Opening or leaving a task changes what the cap keeps (`releaseKeptRows`), from `before`. One a
   * switch may hide is listed while open, so for it the tasks are listed again.
   */
  private relistIfHidden(key: string, before: ReadonlySet<string>): void {
    const row = this.rows.get(capId(key, MAX_ID_CHARS));
    if (row && isElsewhere(row)) this.publishTasks(before);
    else if (row) this.releaseKeptRows(before);
  }

  /** Whether events and reloads for this task are followed: a viewer has it open, or it is kept for its work. */
  private tracked(key: string): boolean {
    return this.openSessions.has(key) || this.retained.has(key);
  }

  private releaseTask(key: string): void {
    this.retained.delete(key);
    this.incarnations.delete(key);
    this.endChecked.delete(key);
    this.loads.delete(key);
    // Drop the chat stream baselines this task held.
    this.streams.retire(key);
    const timer = this.historyTimers.get(key);
    if (timer) clearTimeout(timer);
    this.historyTimers.delete(key);
    this.resyncReasons.delete(key);
    this.raw.clearTask(key);
    this.clearTurnTimers(key);
    const expiry = this.expiryTimers.get(key);
    if (expiry) clearTimeout(expiry);
    this.expiryTimers.delete(key);
    for (const message of this.state.transcripts[key]?.outbox ?? []) {
      this.dropAttachments(message.id);
    }
    // Pictures you sent stay (`sentPictures`, `readBackPictures`): the task can be opened again on
    // this device, and they show there once more. Their own bound lets them go. Its references
    // come back with its next history read.
    this.sentSources.delete(key);
    this.historyReads.delete(key);
    this.recipients.delete(key);
    for (const readKey of [...this.approvalReads.keys()])
      if (readKey.startsWith(`${key}\u0000`)) this.approvalReads.delete(readKey);
    for (const map of [this.listRequested, this.listApplied]) {
      for (const listKey of [...map.keys()])
        if (listKey.startsWith(`${key}\u0000`)) map.delete(listKey);
    }
    this.toolReads.delete(key);
    if (this.state.connection.status === "connected") {
      this.request("sessions.messages.unsubscribe", { key }).catch(() => {});
    }
    this.keepLinkedRuns(key);
    this.store.update((state) => {
      const transcripts = { ...state.transcripts };
      delete transcripts[key];
      return { ...state, transcripts };
    });
    const before = this.keptKeys();
    if (this.waiting.unhold(key)) this.publishTasks(before);
  }

  /**
   * A task let go that holds a run another followed task's send names (a
   * recipient's run, while its sender's task is open): that run goes on being
   * followed as a session nobody has open, so the sender's card keeps it and
   * sees how it ends, rather than forgetting it and reading Sent again.
   */
  private keepLinkedRuns(key: string): void {
    const leaving = this.state.transcripts[key];
    if (!leaving) return;
    const linked = new Set(
      Object.values(this.state.transcripts)
        .filter((transcript) => transcript.sessionKey !== key)
        .flatMap((transcript) => Object.keys(transcript.linkedRuns)),
    );
    const kept = leaving.runs.filter((run) => linked.has(run.id));
    if (kept.length === 0) return;
    this.updateForeign(key, (activity) => ({
      ...activity,
      runs: [...activity.runs.filter((run) => !linked.has(run.id)), ...kept],
    }));
  }

  /** How many viewers hold a transcript open. */
  sessionInterest(key: string): number {
    return this.openSessions.get(key) ?? 0;
  }

  // Write access ----------------------------------------------------------------

  /**
   * Ask the gateway's owner, in one request, for the interactive scopes
   * (`operator.write`, `operator.approvals`, `operator.questions`) through
   * `device.scopes.requestUpgrade`. Returns once the request is under way; the
   * pending request id and approve command appear in `connection.upgrade`.
   * When it is approved the client stores the rotated device token and
   * reconnects asking for exactly what was granted of that set.
   */
  async requestAccess(
    tier: "interactive" | "admin" | "pairing" = "interactive",
    forWaiter = false,
  ): Promise<void> {
    if (this.options.readOnly)
      throw new Error("This host only reads; it does not ask for more access.");
    // A full pairing's grant is the gateway's limit, a narrower one too: nothing asks again,
    // whatever calls this (setup-effortless.md §2).
    if (this.holdsFullPairing()) throw new Error(FULL_PAIRING_LIMIT);
    // The six asked for already cover any tier: a smaller ask never replaces that request.
    if (this.upgradeWanted && this.upgradeTier === "full") return;
    // A request for admin is never narrowed by a later one for less, and device access
    // (`operator.pairing`) is asked for only by name, added to the scopes the connection
    // holds and nothing else: from a read connection it asks for no power to send or answer.
    const raise = (base: { tier: string; pairing: boolean } | null) => ({
      tier:
        tier === "admin" || base?.tier === "admin"
          ? ("admin" as const)
          : tier === "interactive" || base?.tier === "interactive"
            ? ("interactive" as const)
            : ("held" as const),
      pairing: tier === "pairing" || !!base?.pairing,
    });
    const waiting = this.upgradeWanted ? this.upgradeTier : null;
    // While the reconnect's identity is read, the waiters' gateway is unknown: the person's ask
    // goes with its own tier, and theirs joins it once the read names their gateway.
    const { tier: wanted, pairing } = raise(
      !this.upgradeWanted
        ? null
        : this.resumeRead === this.epoch
          ? this.directAsk
          : { tier: this.upgradeTier, pairing: this.pairingWanted },
    );
    if (wanted === "held" && waiting !== "held")
      this.heldBase = ADMIN_SCOPES.filter((scope) => this.state.connection.scopes.includes(scope));
    const target = [...this.tierScopes(wanted), ...(pairing ? [PAIRING_SCOPE] : [])];
    if (target.every((scope) => this.holdsExactly(scope))) return;
    if (!this.settings) throw new Error("Connect to a gateway first.");
    if (this.scopeUpgrade && (wanted !== this.upgradeTier || (pairing && !this.pairingWanted))) {
      // A narrower request is waiting; ask again, for this with it.
      this.scopeUpgrade.cancelScopeUpgrade();
      this.scopeUpgrade = null;
    }
    this.upgradeTier = wanted;
    this.pairingWanted = pairing;
    const direct = this.upgradeWanted ? this.directAsk : null;
    this.directAsk = forWaiter ? direct : raise(direct);
    this.upgradeWanted = true;
    if (this.state.connection.status === "connected") this.startUpgrade();
  }

  private tierScopes(tier: "interactive" | "admin" | "held" | "full"): readonly string[] {
    return tier === "full"
      ? FULL_SCOPES
      : tier === "admin"
        ? ADMIN_SCOPES
        : tier === "held"
          ? this.heldBase
          : INTERACTIVE_SCOPES;
  }

  /**
   * Accept the offer of full control (setup-effortless.md §6): one `device.scopes.requestUpgrade`
   * for the six, in their order, which the gateway's owner decides once. The answer is saved
   * before the request goes, so the offer never shows by itself again. An approval saves the
   * grant as a full pairing, a narrower one too, and nothing asks again; a refusal is saved.
   * Bound to the gateway and device the offer was shown for, and to its stamp (`GatewayStamp`):
   * an offer read before a Connect, a Disconnect or a switch sends nothing, even to a gateway
   * that reports the same identity. The reconnect that brings the grant keeps the target.
   */
  async requestFullControl(binding: FullControlBinding): Promise<void> {
    if (this.options.readOnly)
      throw new Error("This host only reads; it does not ask for more access.");
    if (!sameStamp(binding.stamp, gatewayStamp(this.state.connection)))
      throw new Error(CONNECTION_CHANGED);
    const generation = this.generation;
    const offered = () =>
      sameStamp(binding.stamp, gatewayStamp(this.state.connection)) &&
      generation === this.generation &&
      this.state.connection.status === "connected" &&
      this.state.connection.fullOffer !== null &&
      // A full pairing asks for nothing more, even before the next hello moves the offer away.
      !this.holdsFullPairing() &&
      this.state.connection.gatewayUrl === binding.gatewayUrl &&
      this.state.connection.deviceId === binding.deviceId &&
      this.settings?.url === binding.gatewayUrl;
    if (!offered()) throw new Error("Full control isn't offered on this connection.");
    // Reserved before the save starts: an accept that overlaps this one joins it, even if the
    // gateway settles it first, so it never sends a request of its own.
    if (this.fullAttempt) return this.fullAttempt;
    if (this.scopeUpgrade && this.upgradeTier === "full") return;
    const attempt = (async () => {
      // Saved first: an answer that can't be kept would let the offer ask again.
      if (!(await this.answerOffer("asked", binding)))
        throw new Error("Clawtrate couldn't save this choice. Try again.");
      if (!offered()) throw new Error("The connection changed. Try again from Settings.");
      if (this.scopeUpgrade && this.upgradeTier === "full") return;
      this.scopeUpgrade?.cancelScopeUpgrade();
      this.scopeUpgrade = null;
      this.upgradeTier = "full";
      this.pairingWanted = false;
      this.upgradeWanted = true;
      this.directAsk = { tier: "full", pairing: false };
      this.startUpgrade();
    })();
    this.fullAttempt = attempt;
    // A failed save sends nothing: the person may try again. Otherwise the gateway's answer to
    // the request releases it (`startUpgrade`), or leaving the gateway does.
    attempt.catch(() => {
      if (this.fullAttempt === attempt) this.fullAttempt = null;
    });
    return attempt;
  }

  /** "Keep current access": the offer is answered, and shows by itself no more. */
  async dismissFullControl(binding: FullControlBinding): Promise<void> {
    const connection = this.state.connection;
    if (
      !sameStamp(binding.stamp, gatewayStamp(connection)) ||
      connection.fullOffer !== "offer" ||
      connection.gatewayUrl !== binding.gatewayUrl ||
      connection.deviceId !== binding.deviceId
    )
      return;
    await this.answerOffer("dismissed", binding);
  }

  private offerKey(url: string, deviceId: string): string {
    return `fullControlOffer:${encodeURIComponent(gatewayEndpoint(url) ?? url)}:${deviceId}`;
  }

  /** The saved answer; one that can't be read counts as answered, so nothing asks twice. */
  private async loadOfferAnswer(
    url: string,
    deviceId: string,
  ): Promise<OfferAnswer | "unread" | null> {
    try {
      const raw = await this.host.storage.get(this.offerKey(url, deviceId));
      if (raw === null) return null;
      const answer = asRecord(JSON.parse(raw))?.answer;
      return typeof answer === "string" && OFFER_ANSWERS.includes(answer)
        ? (answer as OfferAnswer)
        : "unread";
    } catch {
      return "unread";
    }
  }

  /**
   * Saves the answer for the gateway and device it was given for, and, while that gateway is
   * the one in use, moves the offer to Settings. Resolves false when it couldn't be kept; this
   * session counts it as answered anyway.
   */
  private async answerOffer(
    answer: OfferAnswer,
    at: { gatewayUrl: string; deviceId: string },
  ): Promise<boolean> {
    if (this.settings?.url === at.gatewayUrl && this.state.connection.deviceId === at.deviceId) {
      this.offerAnswer = answer;
      if (this.state.connection.fullOffer === "offer")
        this.setConnection({ fullOffer: "settings" });
    }
    try {
      await this.host.storage.set(
        this.offerKey(at.gatewayUrl, at.deviceId),
        JSON.stringify({ answer }),
      );
      return true;
    } catch {
      this.log("warn", "Could not save the answer to the full-control offer.");
      return false;
    }
  }

  /**
   * Whether this connection is offered full control, and where (`ConnectionState.fullOffer`):
   * only at a protected address. This Mac's upgrade presents the shared token on a proved
   * socket instead, and isn't built.
   */
  private offerFor(scopes: readonly string[]): "offer" | "settings" | null {
    const url = this.settings?.url;
    if (!url || !this.fullAccess || !protectedGatewayUrl(url)) return null;
    if (this.holdsFullPairing() || this.isSetup(url)) return null;
    // Only a device the gateway paired: a hello that left no saved token offers nothing.
    const deviceId = this.state.connection.deviceId;
    if (!deviceId || !this.writes.grants.get(this.tokenKey(url, deviceId, "operator"))) return null;
    if (FULL_SCOPES.every((scope) => scopes.includes(scope))) return null;
    return this.offerAnswer === null ? "offer" : "settings";
  }

  /** What an access request asks for: its tier, device access when asked for or held. */
  private upgradeTarget(): string[] {
    if (this.upgradeTier === "full") return [...FULL_SCOPES];
    const keepPairing = this.pairingWanted || this.state.connection.scopes.includes(PAIRING_SCOPE);
    return [...this.tierScopes(this.upgradeTier), ...(keepPairing ? [PAIRING_SCOPE] : [])];
  }

  /** Device access counts only when granted by name: admin implies it, but was not asked for it. */
  private holdsExactly(scope: string): boolean {
    return scope === PAIRING_SCOPE
      ? this.state.connection.status === "connected" &&
          this.state.connection.scopes.includes(PAIRING_SCOPE)
      : this.holds(scope);
  }

  private holds(scope: string): boolean {
    const connection = this.state.connection;
    return connection.status === "connected" && scopeSatisfied(connection.scopes, scope);
  }

  private setUpgrade(patch: Partial<ScopeUpgradeState>): void {
    this.store.update((state) => ({
      ...state,
      connection: { ...state.connection, upgrade: { ...state.connection.upgrade, ...patch } },
    }));
  }

  private startUpgrade(): void {
    // A full pairing asks for nothing more, a request queued before its grant was known too.
    if (this.holdsFullPairing()) {
      if (!this.upgradeWanted) return;
      this.upgradeWanted = false;
      this.pairingWanted = false;
      const waiters = this.accessWaiters;
      this.accessWaiters = [];
      for (const waiter of waiters) waiter.reject(new Error(FULL_PAIRING_LIMIT));
      return;
    }
    const protocol = this.protocol;
    const identity = this.identity;
    const url = this.settings?.url;
    const auth = this.auth;
    if (this.scopeUpgrade || !protocol || !identity || !url || !auth || auth.url !== url) return;
    const generation = this.generation;
    const tier = this.upgradeTier;
    const target = this.upgradeTarget();
    const askedPairing = target.includes(PAIRING_SCOPE);
    const asked = { gatewayUrl: url, deviceId: identity.deviceId };
    // The gateway's answer ends the person's accept of the offer: a later one is a new choice.
    const settled = () => {
      if (tier === "full") this.fullAttempt = null;
    };
    const upgrade = new GatewayScopeUpgrade({
      request: (method, params, options) => protocol.request(method, params, options),
      tokenStore: {
        load: auth.tokenStore.load,
        clear: auth.tokenStore.clear,
        // The rotated token carries the new grant; from now on connect asks for exactly what it covers.
        // It belongs to this gateway and this connection only. It retires every token issued before
        // it, so it is kept even when another socket on this store opened since, and even when a
        // newer request replaced the one it answers: only the current request reconnects or shows
        // its approval (the pinned client reconnects only for a request not cancelled). Queued with every other token change, so a late rejection cannot remove it.
        store: ({ deviceId, role, token, scopes }) =>
          this.changeConnection(async () => {
            const sameConnection = () => {
              if (generation !== this.generation || this.settings?.url !== url) {
                throw new Error("The gateway changed while access was being approved.");
              }
            };
            sameConnection();
            // Only what the upgrade asked for, or what an asked scope implies, is kept: a
            // pairing-only upgrade adds pairing and nothing else, whatever the gateway granted.
            // A full pairing's record stays one: what the upgrade granted of what it asked for,
            // by name, beside what it holds outside the request now: the saved record as read
            // in this queued write, after every earlier change of any client on this store. A
            // read that keeps failing never counts as no record: the grant last confirmed for the
            // key by any client on this store stands in, so the rotation is saved, a full
            // pairing's still, as widened, narrowed or removed since.
            let current: StoredDeviceToken | null | undefined;
            for (let read = 0; read < GRANT_READS && current === undefined; read += 1) {
              current = await this.loadToken(url, deviceId, role, true).catch(() => undefined);
              sameConnection();
            }
            const known = this.writes.grants.get(this.tokenKey(url, deviceId, role));
            const fullHeld =
              current === undefined
                ? known?.full
                  ? FULL_SCOPES.filter((_scope, index) => (known.held & (1 << index)) !== 0)
                  : null
                : current?.fullGrant
                  ? current.heldScopes
                  : null;
            // Full control accepted: the grant is a full pairing's, held by name, a narrower one too.
            await this.writeToken(
              url,
              deviceId,
              role,
              fullHeld || tier === "full"
                ? fullUpgrade(fullHeld ?? [], token, target, scopes)
                : grantRecord(token, scopes, target),
            );
            const key = this.tokenKey(url, deviceId, role);
            this.writes.rotations.set(key, (this.writes.rotations.get(key) ?? 0) + 1);
          }),
      },
      reconnect: () => {
        if (generation !== this.generation || this.settings?.url !== url) return;
        this.quietReconnect = true;
        this.reopen();
      },
    });
    this.scopeUpgrade = upgrade;
    this.setUpgrade({
      ...initialScopeUpgrade,
      status: "requesting",
      scopes: target,
    });
    upgrade
      .requestScopeUpgrade({
        binding: { clientId: CLIENT_ID, deviceId: identity.deviceId, role: "operator" },
        scopes: target,
        onPending: (requestId) => {
          const instructions = (this.host.approvalInstructions ?? defaultApprovalInstructions)(
            url,
            requestId,
          );
          this.setUpgrade({
            status: "pending",
            requestId,
            approveCommand: instructions.command,
            approveNote: instructions.note,
          });
        },
      })
      .then(
        (outcome) => {
          if (this.scopeUpgrade !== upgrade) return;
          this.scopeUpgrade = null;
          settled();
          if (outcome.status === "approved") {
            // Judged on what is kept (the store's rule), so an approval is never one the saved
            // record can't hold: an admin grant for a write request keeps neither.
            const kept = withinAsked(outcome.scopes, target);
            // Full control's grant is the limit, whatever it is: kept, said, and never asked again.
            if (tier === "full")
              void this.answerOffer(
                FULL_SCOPES.every((scope) => outcome.scopes.includes(scope))
                  ? "granted"
                  : "narrower",
                asked,
              );
            else if (
              (tier !== "held" &&
                !scopeSatisfied(kept, tier === "admin" ? ADMIN_SCOPE : WRITE_SCOPE)) ||
              (askedPairing && !kept.includes(PAIRING_SCOPE))
            ) {
              this.failAccess(
                new AccessRequestError(
                  "error",
                  `the gateway granted only ${outcome.scopes.join(", ")}`,
                ),
              );
              return;
            }
            // Settled. The reconnect is under way; its hello settles the waiters.
            this.upgradeWanted = false;
            this.pairingWanted = false;
            this.setUpgrade({ status: "approved", error: null });
            return;
          }
          if (tier === "full" && outcome.status === "rejected")
            void this.answerOffer("refused", asked);
          this.failAccess(new AccessRequestError(outcome.status));
        },
        (error: unknown) => {
          if (this.scopeUpgrade !== upgrade) return;
          this.scopeUpgrade = null;
          if (!this.upgradeWanted) return;
          if (!(error instanceof GatewayProtocolRequestError) && !this.protocol?.connected) {
            // The connection dropped while waiting. Ask again after the next hello.
            return;
          }
          settled();
          this.failAccess(new AccessRequestError("error", errorMessage(error)));
        },
      );
  }

  /**
   * After a hello, access queued for a task change is asked only of the gateway its stamp named
   * (#782): the request waits for this connection's identity, and a change whose gateway this
   * isn't is refused, rather than asking a gateway that answered the reconnect at the same address.
   */
  private resumeUpgrade(): void {
    // A waiter this hello grants (`settleAccessWaiters`) is gone by the read, but still named
    // its gateway. One withdrawn meanwhile names none.
    const granted = new Set(
      this.accessWaiters
        .filter((waiter) => this.holds(waiter.scope))
        .map((waiter) => waiter.gatewayId),
    );
    granted.delete(null);
    if (this.accessWaiters.every((waiter) => waiter.gatewayId === null)) {
      if (this.accessWaiters.length === 0) {
        // Operations all withdrawn since asked for nothing: no gateway is asked for them, and
        // what the person asked for goes on as they asked it.
        if (!this.directAsk) return this.dropAsk();
        this.upgradeTier = this.directAsk.tier;
        this.pairingWanted = this.directAsk.pairing;
        // The hello kept the withdrawn changes' tier, so it didn't take what this one holds.
        if (this.upgradeTier === "held")
          this.heldBase = ADMIN_SCOPES.filter((scope) =>
            this.state.connection.scopes.includes(scope),
          );
      }
      return this.startUpgrade();
    }
    const epoch = this.epoch;
    this.resumeRead = epoch;
    void this.readGatewayIdentity().then((id) => {
      if (this.resumeRead === epoch) this.resumeRead = null;
      if (epoch !== this.epoch || !this.upgradeWanted) return;
      const waiters = this.accessWaiters;
      this.accessWaiters = waiters.filter(
        (waiter) => waiter.gatewayId === null || waiter.gatewayId === id,
      );
      for (const waiter of waiters)
        if (!this.accessWaiters.includes(waiter))
          waiter.reject(new Error(id === null ? IDENTITY_UNREAD : ANOTHER_GATEWAY));
      // A device-access ask sent during the read went alone: the changes on this gateway need write.
      if (this.accessWaiters.length > 0 && this.upgradeTier === "held") {
        this.upgradeTier = "interactive";
        this.scopeUpgrade?.cancelScopeUpgrade();
        this.scopeUpgrade = null;
      }
      if (this.accessWaiters.length > 0 || (id !== null && granted.has(id)))
        return this.startUpgrade();
      // A request asked for on this connection meanwhile is under way: its answer settles it.
      if (this.scopeUpgrade) return;
      // Beside changes refused here, the person's accept of full control ends as a failure they
      // can try again from Settings, never quietly; an accept still being saved keeps its place.
      if (this.upgradeTier === "full" && (waiters.length > 0 || granted.size > 0)) {
        this.fullAttempt = null;
        this.failAccess(
          new AccessRequestError("error", id === null ? IDENTITY_UNREAD : ANOTHER_GATEWAY),
        );
        return;
      }
      // No waiter is left: as if none had waited.
      this.resumeUpgrade();
    });
  }

  /** A queued ask no one waits on any more goes, and the access state with it. */
  private dropAsk(): void {
    this.upgradeWanted = false;
    this.pairingWanted = false;
    this.setUpgrade(initialScopeUpgrade);
  }

  private failAccess(error: AccessRequestError): void {
    this.upgradeWanted = false;
    this.pairingWanted = false;
    this.setUpgrade({ status: error.status, error: error.message });
    const waiters = this.accessWaiters;
    this.accessWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  private abandonAccessRequest(reason: string): void {
    this.scopeUpgrade?.cancelScopeUpgrade();
    this.scopeUpgrade = null;
    this.fullAttempt = null;
    this.upgradeWanted = false;
    this.pairingWanted = false;
    const waiters = this.accessWaiters;
    this.accessWaiters = [];
    for (const waiter of waiters) waiter.reject(new Error(reason));
  }

  /** After a hello: resolve waiters the grant covers; once nothing is being asked for, refuse the rest. */
  private settleAccessWaiters(): void {
    const waiters = this.accessWaiters;
    this.accessWaiters = [];
    for (const waiter of waiters) {
      if (this.holds(waiter.scope)) waiter.resolve();
      else if (this.upgradeWanted) this.accessWaiters.push(waiter);
      else waiter.reject(new Error(`The gateway did not grant ${waiter.scope}.`));
    }
  }

  /**
   * Resolves once the connection holds `scope`. When the client does not mean
   * to hold it yet, this asks for the interactive scopes; when it already does
   * (the connection is only down), it waits for the next hello. A connection
   * that has stopped (the gateway refused the device, or reconnecting gave up)
   * will not bring one, so the operation fails at once and stays retryable.
   * `owner` names the viewer that asked, so its operations can be withdrawn.
   */
  private ensureScope(
    scope: string,
    owner: object | null = null,
    gatewayId: string | null = null,
  ): Promise<void> {
    if (this.holds(scope)) return Promise.resolve();
    const connection = this.state.connection;
    if (connection.status === "error" || connection.status === "idle" || !this.protocol) {
      return Promise.reject(
        new Error(
          `Not connected to the gateway${connection.error ? `: ${connection.error.message}` : "."}`,
        ),
      );
    }
    // A full pairing asks for nothing more: what it doesn't hold, while it is connected or
    // doesn't mean to hold, it never will by asking (setup-effortless.md §2).
    if (
      this.holdsFullPairing() &&
      (connection.status === "connected" || !connection.requestedScopes.includes(scope))
    )
      return Promise.reject(new Error(FULL_PAIRING_LIMIT));
    if (this.accessWaiters.length >= MAX_ACCESS_WAITERS) {
      return Promise.reject(
        new Error("Too many operations are waiting for access; try again when they finish."),
      );
    }
    const waiting = new Promise<void>((resolve, reject) => {
      this.accessWaiters.push({ scope, resolve, reject, owner, gatewayId });
    });
    // Not meant to be held yet, or held and then lost (capped or revoked) on a
    // live connection: ask the gateway's owner. Otherwise the connection is
    // only down, and the next hello settles it.
    if (
      !this.state.connection.requestedScopes.includes(scope) ||
      this.state.connection.status === "connected"
    ) {
      this.requestAccess("interactive", true).catch((error: unknown) => {
        this.failAccess(new AccessRequestError("error", errorMessage(error)));
      });
    }
    return waiting;
  }

  /**
   * A viewer went away: everything it asked for that is still waiting for
   * access is withdrawn now, before the gateway is asked, and nothing of it is
   * kept. Work the client owns (outgoing messages) is not a viewer's.
   */
  withdraw(owner: object): void {
    this.withdrawnOwners.add(owner);
    this.fileTransfers.release(owner);
    for (const readers of this.approvalReads.values()) readers.delete(owner);
    // A Computer Stop whose first abort has not gone goes with it; one already sent is left as it is.
    for (const [id, asker] of [...this.unsentStops]) {
      if (asker !== owner) continue;
      this.unsentStops.delete(id);
      const [key, runId] = id.split("\u0000") as [string, string];
      if (this.state.transcripts[key])
        this.updateActivity(key, (activity) =>
          retireStopIntent(activity, runId, new WithdrawnError().message),
        );
    }
    const withdrawn = this.accessWaiters.filter((waiter) => waiter.owner === owner);
    if (withdrawn.length === 0) return;
    this.accessWaiters = this.accessWaiters.filter((waiter) => waiter.owner !== owner);
    for (const waiter of withdrawn) waiter.reject(new WithdrawnError());
  }

  /**
   * The last check before an operation asks the gateway: its viewer has not
   * gone away. Waiter withdrawal covers an operation still waiting for access;
   * this covers one whose access was already held or just settled.
   */
  private checkNotWithdrawn(owner: object | null | undefined): void {
    if (owner && this.withdrawnOwners.has(owner)) throw new WithdrawnError();
  }

  /** Operations waiting for access, for tests and diagnostics. */
  get pendingAccessWaiters(): number {
    return this.accessWaiters.length;
  }

  /**
   * Resolves once the task's current read queue is idle, or at once if none runs,
   * for tests that need a late duplicate read to have been queued already.
   */
  historyReadsSettled(key: string): Promise<void> {
    return this.loads.get(key)?.done ?? Promise.resolve();
  }

  /** Reject every operation waiting for access, without changing what is being asked for. */
  private rejectAccessWaiters(error: Error): void {
    this.upgradeWanted = false;
    // An accept of full control ends here unanswered, so a later one asks again. A request
    // still under way keeps blocking a second one (`scopeUpgrade`).
    this.fullAttempt = null;
    const waiters = this.accessWaiters;
    this.accessWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  /**
   * The gateway refused a call for a missing scope: this connection does not
   * hold it, whatever the last hello said. Drop it from the effective scopes,
   * so the next use asks for it again instead of repeating the refused call.
   */
  private noteMissingScope(error: unknown): void {
    if (!isMissingScope(error)) return;
    const details = asRecord((error as GatewayProtocolRequestError).details);
    const missing = typeof details?.missingScope === "string" ? details.missingScope : null;
    if (!missing) return;
    this.setEffectiveScopes(
      this.state.connection.scopes.filter(
        (scope) => scope !== missing && scope !== "operator.admin",
      ),
    );
    // Without the scope no list can be read: say so, rather than show what was read before as current.
    if (!this.holds(APPROVALS_SCOPE)) {
      for (const key of Object.keys(this.state.transcripts)) {
        for (const kind of APPROVAL_KINDS) this.setApprovalSource(key, kind, "unavailable");
      }
    }
  }

  /** The scopes this connection holds, and every flag derived from them, set together. */
  private setEffectiveScopes(scopes: string[]): void {
    this.setConnection({
      scopes,
      canWrite: scopeSatisfied(scopes, WRITE_SCOPE),
      canAnswer: scopeSatisfied(scopes, QUESTIONS_SCOPE),
      canApprove: scopeSatisfied(scopes, APPROVALS_SCOPE),
      canAdmin: scopes.includes(ADMIN_SCOPE),
    });
  }

  // Sending ---------------------------------------------------------------------

  /**
   * Send a message to an open task. It shows at once in the task's outbox and
   * leaves it when history holds it. The idempotency key is the message id,
   * so a retry is never delivered twice. Returns the message id. Throws
   * `SendTooLargeError` before anything is sent when it would break a ceiling.
   */
  sendMessage(key: string, text: string, options: SendOptions = {}): string {
    const transcript = this.state.transcripts[key];
    if (!transcript) throw new Error("Open the task before sending to it.");
    const body = text.trim();
    const attachments = options.attachments ?? [];
    this.checkOutboxRoom(key);
    if (!body && attachments.length === 0) throw new Error("The message is empty.");
    // Never cut: a message whose escaped form would pass its bound is refused instead.
    if (body.length > MAX_MESSAGE_CHARS || jsonTextLength(body) > MAX_MESSAGE_JSON_CHARS)
      throw new Error("The message is too long.");
    // A file's name and type are kept beside its content: only valid ones, never cut.
    for (const each of attachments) {
      validateAttachmentMeta(each.fileName, each.mimeType);
      if (typeof each.type !== "string" || each.type.length > 32)
        throw new Error("invalid file type");
    }
    if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE)
      throw new SendTooLargeError(
        `${attachments.length} files; one message can carry at most ${MAX_ATTACHMENTS_PER_MESSAGE}.`,
      );
    // As it will be sent, its reply reference included; checked again at delivery.
    this.checkSize(
      this.sendParams(key, body, "x".repeat(36), "followup", attachments, options.replyToId),
    );
    const bytes = attachments.reduce((sum, each) => sum + decodedBytes(each.content), 0);
    if (this.attachmentBytes + bytes > MAX_RETAINED_ATTACHMENT_BYTES) {
      throw new Error(
        "Files of earlier messages are still waiting to go out; send or delete some of them first.",
      );
    }
    const active = activeRun(transcript);
    const resolved = !active
      ? "new"
      : active.state === "stopping" || options.mode === "queue"
        ? "queue"
        : "steer";
    // A pending question holds every outgoing message in the task, however it
    // was sent; it is released when the last pending question settles.
    const held = active?.state !== "stopping" && questionPending(transcript, active);
    const replyToId = options.replyToId;
    if (
      replyToId !== undefined &&
      (typeof replyToId !== "string" || !replyToId || replyToId.length > MAX_ID_CHARS)
    )
      throw new Error("That message can't be replied to.");
    const message: OutgoingMessage = {
      id: this.randomId(),
      text: body,
      mode: resolved,
      status: held ? "held" : resolved === "queue" ? "queued" : "sending",
      runId: resolved === "steer" ? active!.id : null,
      messageSeq: null,
      leftAt: null,
      createdAt: this.now(),
      error: null,
      attachments: attachments.map((attachment) => ({
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes: decodedBytes(attachment.content),
      })),
      ...(replyToId ? { replyToId } : {}),
    };
    this.noteFirstSend(key, message);
    if (attachments.length > 0) {
      this.attachmentContent.set(message.id, {
        task: key,
        bot: this.taskBot(key),
        files: attachments,
        bytes,
      });
      this.attachmentBytes += bytes;
      // Pictures kept only to be shown give way to files still to go out, read-back ones first.
      this.makeRoomForPictures(0);
      for (const id of this.sentPictures.keys()) {
        if (this.attachmentBytes + this.sentPictureBytes <= MAX_RETAINED_ATTACHMENT_BYTES) break;
        this.dropSentPictures(id);
      }
    }
    this.updateActivity(key, (activity) => {
      const withMessage = { ...activity, outbox: [...activity.outbox, message] };
      // A held message starts nothing: once the question settles it is queued, as a turn of its own.
      if (resolved === "new" && !held) return startLocalRun(withMessage, message, this.now());
      if (resolved === "queue" && !held) return queueLocalRun(withMessage, message, this.now());
      return withMessage;
    });
    if (message.status === "sending") this.enqueueDelivery(key, message.id);
    return message.id;
  }

  /**
   * Refuse a new outgoing message beyond the per-task and per-client bounds,
   * before keeping anything. Every message the outbox holds counts, failed and
   * unconfirmed ones included, so retrying and deleting are always possible
   * and nothing accepted is dropped to make room.
   */
  private checkOutboxRoom(key: string): void {
    const here = (this.state.transcripts[key] ?? emptyActivity).outbox.length;
    if (here >= MAX_OUTBOX_PER_TASK) {
      throw new Error(
        `This task already holds ${MAX_OUTBOX_PER_TASK} messages waiting to be sent, confirmed, retried or deleted.`,
      );
    }
  }

  /** Forget a message's file content and give its bytes back. */
  private dropAttachments(messageId: string): void {
    const kept = this.attachmentContent.get(messageId);
    if (!kept) return;
    this.attachmentContent.delete(messageId);
    this.attachmentBytes -= kept.bytes;
  }

  /**
   * Once history holds a message, keep the pictures it carried that a
   * conversation draws, from the copy sent, so its own message can still show
   * them; its other files are let go. Room is made by dropping the oldest kept.
   */
  private keepSentPictures(message: OutgoingMessage): void {
    const kept = this.attachmentContent.get(message.id);
    this.dropAttachments(message.id);
    // A history read asked before its task was deleted can still be answered after.
    if (!kept || kept.taskDeleted) return;
    const named = kept.files.flatMap((file, index) =>
      isShownPictureType(file.mimeType) && decodedBytes(file.content) <= MAX_PICTURE_BYTES
        ? [{ index, mimeType: file.mimeType, content: file.content }]
        : [],
    );
    // Bytes that aren't the picture they are named as would never be drawn: not kept.
    const files = named.filter((file) => isDrawnPicture(file.mimeType, fromBase64(file.content)));
    const notPictures = named.filter((file) => !files.includes(file)).map((file) => file.index);
    const bytes = files.reduce((sum, file) => sum + decodedBytes(file.content), 0);
    if (named.length === 0 || this.attachmentBytes + bytes > MAX_RETAINED_ATTACHMENT_BYTES) return;
    this.makeRoomForPictures(bytes);
    for (const id of this.sentPictures.keys()) {
      if (
        this.sentPictures.size < MAX_SENT_PICTURE_MESSAGES &&
        this.attachmentBytes + this.sentPictureBytes + bytes <= MAX_RETAINED_ATTACHMENT_BYTES
      )
        break;
      this.dropSentPictures(id);
    }
    this.sentPictures.set(message.id, {
      task: kept.task,
      bot: kept.bot,
      mode: message.mode,
      runId: message.runId,
      files,
      notPictures,
      bytes,
    });
    this.sentPictureBytes += bytes;
  }

  /** Let go of every picture kept for the tasks `deleted` names, and of those still to be kept. */
  private dropDeletedPictures(
    deleted: (record: { task: string; bot: string | null }) => boolean,
  ): void {
    for (const flight of this.pictureReadsInFlight) if (deleted(flight)) flight.dropped = true;
    for (const [id, kept] of this.sentPictures) if (deleted(kept)) this.dropSentPictures(id);
    for (const [id, kept] of this.readBackPictures) if (deleted(kept)) this.dropReadBackPicture(id);
    for (const sending of this.attachmentContent.values())
      if (deleted(sending)) sending.taskDeleted = true;
  }

  /**
   * The bot a task is listed under now (\`rowBotOf\`), noted on a picture's record when it is made:
   * the read of the bots that drops a deleted bot's rows can land before the gateway's answer to
   * the delete.
   */
  private taskBot(key: string): string | null {
    const bot = rowBotOf(key, this.rows.get(capId(key, MAX_ID_CHARS)) ?? {});
    return bot === null ? null : capId(bot, MAX_ID_CHARS);
  }

  /** Read-back pictures give way, oldest first, until `bytes` more fit in the shared budget. */
  private makeRoomForPictures(bytes: number): void {
    for (const id of this.readBackPictures.keys()) {
      if (
        this.attachmentBytes + this.sentPictureBytes + this.readBackBytes + bytes <=
        MAX_RETAINED_ATTACHMENT_BYTES
      )
        break;
      this.dropReadBackPicture(id);
    }
  }

  private dropReadBackPicture(id: string): void {
    const kept = this.readBackPictures.get(id);
    if (!kept) return;
    this.readBackPictures.delete(id);
    this.readBackBytes -= kept.bytes;
  }

  /** Keep a picture read back, as the newest, when it fits beside everything else kept. */
  private keepReadBack(
    id: string,
    task: string,
    bot: string | null,
    mimeType: string,
    bytes: Uint8Array,
  ): void {
    this.dropReadBackPicture(id);
    if (this.readBackPictures.size >= MAX_READ_BACK_PICTURES)
      this.dropReadBackPicture(this.readBackPictures.keys().next().value!);
    this.makeRoomForPictures(bytes.length);
    if (
      this.attachmentBytes + this.sentPictureBytes + this.readBackBytes + bytes.length >
      MAX_RETAINED_ATTACHMENT_BYTES
    )
      return;
    this.readBackPictures.set(id, {
      task,
      bot,
      mimeType,
      content: toBase64(bytes),
      bytes: bytes.length,
    });
    this.readBackBytes += bytes.length;
  }

  private dropSentPictures(messageId: string): void {
    const kept = this.sentPictures.get(messageId);
    if (!kept) return;
    this.sentPictures.delete(messageId);
    this.sentPictureBytes -= kept.bytes;
  }

  /** Decoded bytes of pictures kept to show for messages history holds, for tests and diagnostics. */
  get keptPictureBytes(): number {
    return this.sentPictureBytes;
  }

  /** Decoded bytes of pictures read back from the gateway and kept, for tests and diagnostics. */
  get readBackPictureBytes(): number {
    return this.readBackBytes;
  }

  /** Decoded bytes of files held for outgoing messages, for tests and diagnostics. */
  get retainedAttachmentBytes(): number {
    return this.attachmentBytes;
  }

  private sendParams(
    key: string,
    text: string,
    idempotencyKey: string,
    queueMode: "steer" | "followup",
    attachments: OutgoingAttachment[],
    replyToId?: string,
    marked = !goesUnmarked(text),
  ) {
    return chatSendParams(
      { sessionKey: key, text, idempotencyKey, queueMode, replyToId: replyToId ?? null },
      attachments,
      marked,
    );
  }

  /** What one message may carry: the smaller of Clawtrate's own ceilings and the gateway's. */
  private sendLimits(): SendLimits {
    const { maxPayload, maxImageBytes, maxFileBytes } = this.payloadLimits;
    return {
      imageBytes:
        maxImageBytes !== null ? Math.min(maxImageBytes, MAX_IMAGE_BYTES) : MAX_IMAGE_BYTES,
      fileBytes: maxFileBytes !== null ? Math.min(maxFileBytes, MAX_FILE_BYTES) : MAX_FILE_BYTES,
      payloadBytes: maxPayload ?? DEFAULT_MAX_PAYLOAD_BYTES,
      files: MAX_ATTACHMENTS_PER_MESSAGE,
    };
  }

  /**
   * Refuse a send past the file count, an image or file ceiling or the frame ceiling, before it
   * reaches the socket: `sendRefusal`, the function the composer checks a draft with, over the
   * request as built and the gateway's current policy.
   */
  private checkSize(params: ReturnType<typeof chatSendParams<OutgoingAttachment>>): void {
    const files = (params.attachments ?? []).map((each) => ({
      fileName: each.fileName,
      mimeType: each.mimeType,
      bytes: decodedBytes(each.content),
    }));
    const refused = sendRefusal(
      {
        sessionKey: params.sessionKey,
        text: params.message,
        idempotencyKey: params.idempotencyKey,
        queueMode: params.queueMode,
        replyToId: params.replyToId ?? null,
        files,
      },
      this.sendLimits(),
    );
    if (!refused) return;
    throw new SendTooLargeError(
      refused.kind === "count"
        ? `${refused.count} files; one message can carry at most ${refused.limit}.`
        : refused.kind === "frame"
          ? `The message and its files come to ${refused.bytes} bytes; one message can carry at most ${refused.limit}.`
          : `${files[refused.index]!.fileName} is ${refused.bytes} bytes; the gateway accepts ${refused.kind === "image" ? "images" : "files"} up to ${refused.limit} bytes.`,
    );
  }

  /**
   * Send a failed, unconfirmed or unknown message again, with the same idempotency key,
   * so the gateway delivers it at most once. It already counts against the
   * outbox bounds, so a retry is never refused for room.
   */
  retryMessage(key: string, messageId: string): void {
    const message = this.outgoing(key, messageId);
    if (
      !message ||
      (message.status !== "failed" &&
        message.status !== "unconfirmed" &&
        message.status !== "unknown" &&
        message.status !== "not-sent")
    )
      return;
    // The gateway keeps a withdrawn steer's id as aborted and answers a send under it with that
    // abort: it goes again under a new key, in its place on the shelf, with its files.
    if (message.steer === "withdrawn") {
      const id = this.randomId();
      // The message a task waits to be named from goes under its new key.
      const naming = this.taskNames.get(key);
      if (naming?.first === messageId) naming.first = id;
      const kept = this.attachmentContent.get(messageId);
      if (kept) {
        this.attachmentContent.delete(messageId);
        this.attachmentContent.set(id, kept);
      }
      this.updateActivity(key, (activity) => ({
        ...activity,
        outbox: activity.outbox.map((each) => {
          if (each.id !== messageId) return each;
          const fresh = { ...each, id };
          delete fresh.steer;
          return fresh;
        }),
      }));
      return this.retryMessage(key, id);
    }
    const transcript = this.state.transcripts[key]!;
    // The gateway is running a run under this message's own id: the message is out, and nothing
    // goes again (as when a held one is released).
    if (gatewayRunning(transcript, messageId)) {
      this.updateActivity(key, (activity) =>
        updateMessage(activity, messageId, { status: "sent", error: null, runId: messageId }),
      );
      return;
    }
    const active = activeRun(transcript);
    // A message that came from the queue keeps that origin through every attempt, until
    // it starts or is removed: it starts now with no run active, and otherwise waits
    // behind the active run, so a refusal still reads "Couldn't start" on the shelf.
    // "Send" on one left Not sent after a Stop follows the normal send rules instead: it goes
    // as a message sent at that moment would, a steer into a run the person has since started.
    const fromQueue = message.mode === "queue" && message.status !== "not-sent";
    const mode = fromQueue
      ? "queue"
      : !active
        ? "new"
        : active.state === "stopping"
          ? "queue"
          : "steer";
    const held = active?.state !== "stopping" && questionPending(transcript, active);
    const status = held ? "held" : mode === "queue" && active ? "queued" : "sending";
    this.updateActivity(key, (activity) => {
      // A run the gateway refused never started, and one under this id that ended is over: the
      // retry is a new attempt, and its id names one run.
      const cleared = {
        ...activity,
        runs: activity.runs.filter(
          (run) =>
            !(
              run.id === messageId &&
              ((run.origin === "local" && !run.bound) || isTerminal(run.state))
            ),
        ),
      };
      const next = updateMessage(cleared, messageId, {
        mode,
        status,
        error: null,
        runId: mode === "steer" ? active!.id : null,
      });
      const updated = next.outbox.find((each) => each.id === messageId)!;
      if (status === "sending" && !active) return startLocalRun(next, updated, this.now());
      if (status === "queued") return queueLocalRun(next, updated, this.now());
      return next;
    });
    if (status === "sending") this.enqueueDelivery(key, messageId);
  }

  /** Remove a failed, cancelled or unconfirmed message, and the run that never started with it. */
  deleteMessage(key: string, messageId: string): void {
    const message = this.outgoing(key, messageId);
    if (
      !message ||
      (message.status !== "failed" &&
        message.status !== "cancelled" &&
        message.status !== "unconfirmed" &&
        message.status !== "unknown" &&
        message.status !== "not-sent" &&
        message.status !== "handled")
    )
      return;
    this.dropAttachments(messageId);
    this.updateActivity(key, (activity) => ({
      ...removeMessage(activity, messageId),
      runs: activity.runs.filter(
        (run) => !(run.id === messageId && run.origin === "local" && !run.bound),
      ),
    }));
  }

  /** "Cancel" on a queued or held message's row: it is never sent. */
  cancelQueued(key: string, messageId: string): void {
    const message = this.outgoing(key, messageId);
    if (!message || (message.status !== "queued" && message.status !== "held")) return;
    // A cancelled message is never sent: its files are not kept.
    this.dropAttachments(messageId);
    this.updateActivity(key, (activity) =>
      updateMessage(cancelQueuedRun(activity, messageId, this.now()), messageId, {
        status: "cancelled",
      }),
    );
  }

  /**
   * "Edit" on a held or queued message's row: the message is taken back,
   * never sent, and its words and files are handed to the caller as one
   * record, to go back into the composer. The files leave this client's
   * keeping at once.
   */
  /**
   * What `takeBack` would give back, changing nothing: a host checks there is
   * room for the files before any of it happens. Throws as `takeBack` does.
   */
  peekTakeBack(
    key: string,
    messageId: string,
  ): { text: string; attachments: OutgoingAttachment[] } {
    const message = this.outgoing(key, messageId);
    if (!message || (message.status !== "queued" && message.status !== "held"))
      throw new Error("That message can no longer be edited.");
    const files = this.attachmentContent.get(messageId)?.files ?? [];
    if (message.attachments.length > 0 && files.length === 0)
      throw new Error("Its files are no longer held; attach them again.");
    return { text: message.text, attachments: [...files] };
  }

  takeBack(key: string, messageId: string): { text: string; attachments: OutgoingAttachment[] } {
    const { text, attachments: files } = this.peekTakeBack(key, messageId);
    this.dropAttachments(messageId);
    this.updateActivity(key, (activity) =>
      updateMessage(cancelQueuedRun(activity, messageId, this.now()), messageId, {
        status: "cancelled",
      }),
    );
    return { text, attachments: files };
  }

  /**
   * "Try again" on a turn that failed: the same words and files, sent now as
   * a new message with its own key, a reply to the same message when it was
   * one. The files must still be held for the message (until history holds
   * it); otherwise it is refused, never sent without them.
   */
  sendAgain(key: string, messageId: string): string {
    const message = this.outgoing(key, messageId);
    if (!message) throw new Error("That message is no longer held here.");
    const files = this.attachmentContent.get(messageId)?.files ?? [];
    if (message.attachments.length > 0 && files.length === 0)
      throw new Error("Its files are no longer held; attach them again.");
    return this.sendMessage(key, message.text, {
      attachments: [...files],
      ...(message.replyToId ? { replyToId: message.replyToId } : {}),
    });
  }

  /** "Send now" on a queued message's chip: a steer into the running or waiting run. */
  sendQueuedNow(key: string, messageId: string): void {
    const message = this.outgoing(key, messageId);
    if (!message || message.status !== "queued") return;
    const transcript = this.state.transcripts[key]!;
    const active = activeRun(transcript);
    if (questionPending(transcript, active))
      throw new Error("Send now is unavailable while a question is pending.");
    if (active?.state === "stopping")
      throw new Error("Send now is unavailable while the run stops.");
    this.updateActivity(key, (activity) => {
      if (!active)
        return startQueuedRun(
          updateMessage(activity, messageId, { status: "sending" }),
          messageId,
          this.now(),
        );
      const withoutQueued = {
        ...activity,
        runs: activity.runs.filter((run) => run.id !== messageId),
      };
      const held = questionPending(activity, active);
      return updateMessage(withoutQueued, messageId, {
        mode: "steer",
        status: held ? "held" : "sending",
        runId: active.id,
      });
    });
    if (this.outgoing(key, messageId)?.status === "sending") this.enqueueDelivery(key, messageId);
  }

  /**
   * Create a task under a bot with its first message. `sessions.create`
   * carries only `agentId`, `idempotencyKey` and `label`, which keep it at
   * `operator.write`; the message follows by `chat.send`, under the same key
   * (`completeCreation`). The caller holds one interest in the new task, as
   * if it had called `openSession`, and releases it with `closeSession`.
   */
  async createTask(
    botId: string,
    text: string,
    options: { label?: string; owner?: object; retryUnknown?: boolean } = {},
  ): Promise<string> {
    const body = text.trim();
    if (!body) throw new Error("The message is empty.");
    if (body.length > MAX_MESSAGE_CHARS || jsonTextLength(body) > MAX_MESSAGE_JSON_CHARS)
      throw new Error("The message is too long.");
    const label = options.label?.trim() || null;
    // Kept as asked, never cut: a cut field would ask the gateway something else on a later ask.
    if (
      jsonTextLength(botId) > MAX_ID_CHARS ||
      (label && jsonTextLength(label) > MAX_TASK_LINE_CHARS)
    )
      throw new Error("The bot id or label is too long.");
    // The same request whose earlier attempt the gateway refused is asked again with its own key;
    // one still being checked is not asked twice.
    const earlier = [...this.creations.values()].find(
      (each) => each.botId === botId && each.text === body && each.label === label,
    );
    if (earlier && (earlier.status === "creating" || earlier.status === "checking")) {
      // Asked again while the first is out or being checked: the same request, so the same outcome.
      return this.awaitCreation(earlier.id);
    }
    if (earlier?.status === "created" && earlier.key) {
      // Found created after its answer was lost: asking again is the same request, not a second task.
      this.openSession(earlier.key);
      return earlier.key;
    }
    if (earlier?.status === "unknown" && !options.retryUnknown) {
      // It may exist: only the user's own retry (`retryCreation`), warned, asks again.
      throw new Error(CREATION_UNKNOWN_WARNING);
    }
    if (!earlier && this.creations.size >= MAX_CREATIONS) {
      throw new Error("Too many task creations are still unsettled; dismiss some first.");
    }
    // The new task's slot is held before anything is asked of the gateway, and given back on failure.
    if (this.openSessions.size + this.retained.size + this.reservedTasks >= this.trackedLimit) {
      throw new Error(`At most ${this.trackedLimit} tasks can be open at once.`);
    }
    // Owned before anything is awaited: its key, its task slot and its place in the count are
    // taken now, so the same request asked meanwhile joins it rather than sending a second key.
    this.reservedTasks += 1;
    let reserved = true;
    const release = () => {
      if (reserved) this.reservedTasks -= 1;
      reserved = false;
    };
    // Kept from before it is sent: the request and its key survive a timeout.
    const creation: TaskCreation =
      earlier && (earlier.status === "failed" || earlier.status === "unknown")
        ? // The same key: a refusal freed it, and a gateway that still has it answers the original.
          { ...earlier, status: "creating", error: null, createdAt: this.now() }
        : {
            id: this.randomId(),
            botId,
            text: body,
            label,
            status: "creating",
            createdAt: this.now(),
            error: null,
            key: null,
            gatewayBootId: null,
          };
    this.putCreation(creation);
    let sent = false;
    try {
      // A viewer that goes away while access is approved takes its request with it (`withdraw`).
      await this.ensureScope(WRITE_SCOPE, options.owner ?? null);
      // The viewer went away while access settled: nothing is asked of the gateway.
      this.checkNotWithdrawn(options.owner);
      // Switching gateways while access settled dropped it: it is never asked of another gateway.
      if (this.creations.get(creation.id)?.status !== "creating")
        throw new Error("Switched to another gateway.");
      creation.gatewayBootId = this.gatewayBootId;
      this.putCreation(creation);
      sent = true;
      const result = asRecord(await this.request("sessions.create", creationParams(creation)));
      release();
      return this.completeCreation(creation, result, true);
    } catch (error) {
      if (!sent) {
        // Nothing was asked of the gateway: an earlier refused attempt goes back to how it was,
        // a new one is dropped, and whoever joined it learns why.
        if (this.creations.has(creation.id)) {
          if (earlier) this.putCreation(earlier, error as Error);
          else this.dropCreation(creation.id, error as Error);
        }
        throw error;
      }
      // Settled as unknown already (an answer that names no task).
      if (error instanceof OutcomeUnknownError) throw error;
      if (error instanceof GatewayProtocolRequestError || error instanceof NotSentError) {
        // The gateway refused it, or it never left: it did not happen. It can be asked again with its key.
        this.putCreation({ ...creation, status: "failed", error: errorMessage(error) });
        throw error;
      }
      // No answer: the outcome is unknown. Ask again with the same key, which the gateway
      // answers with the original outcome; nothing is created twice. The task's slot stays
      // held until it settles, so the task it may bring has room.
      if (reserved) {
        reserved = false;
        this.checkingSlots.add(creation.id);
      }
      this.putCreation({ ...creation, status: "checking", error: errorMessage(error) });
      this.scheduleCreationCheck(creation.id);
      throw new OutcomeUnknownError(
        "The gateway did not answer in time; whether the task was created is being checked.",
      );
    } finally {
      release();
    }
  }

  /**
   * The new task from a `sessions.create` answer: opened, its first message in its outbox and on
   * its way by `chat.send`, under the creation's key, as any message is sent (`deliver`). From
   * here it is the task's message: a send that fails leaves it Not sent there, with Try again.
   */
  private completeCreation(
    creation: TaskCreation,
    result: RawRecord | null,
    byCaller: boolean,
  ): string {
    const key = typeof result?.key === "string" ? result.key : null;
    if (!key) {
      // The gateway answered, so something may exist; without its key it cannot be found.
      this.putCreation({ ...creation, status: "unknown", error: CREATION_UNKNOWN_WARNING });
      throw new OutcomeUnknownError(CREATION_UNKNOWN_WARNING);
    }
    const id = creation.id;
    // The task was made, but the gateway says what it needs after that failed: the message waits,
    // Not sent, for the person's Try again, rather than going to a task that may not take it.
    const runError = asRecord(result?.runError);
    const now = this.now();
    const message: OutgoingMessage = {
      id,
      text: creation.text,
      mode: "new",
      status: runError ? "failed" : "sending",
      runId: null,
      messageSeq: null,
      leftAt: null,
      createdAt: now,
      error: runError ? String(runError.message ?? "The run did not start.") : null,
      attachments: [],
    };
    const sessionId = sessionOf(result?.sessionId);
    // Named from its message at once; the task's history settles it (`settleFirstMessage`).
    if (!this.firstMessageTitles.has(capId(key, MAX_ID_CHARS)))
      this.keepFirstMessage(capId(key, MAX_ID_CHARS), creation.text, creation.id, sessionId);
    // A task created with its first message is named from it once the gateway accepts it (here or
    // on a retry), unless the person named it.
    if (!creation.label) {
      this.keepTaskName(key, {
        stage: "waiting",
        sessionId,
        textless: [],
        first: id,
        withMessage: true,
      });
    }
    // A caller holds one interest in the new task; one settled later is kept for its message.
    this.openSession(key, true);
    this.updateActivity(key, (activity, ctx) => {
      if (activity.outbox.some((each) => each.id === id)) return activity;
      const next = startLocalRun(
        { ...activity, outbox: [...activity.outbox, message] },
        message,
        now,
      );
      if (!runError) return next;
      return failRunStart(
        next,
        id,
        {
          message: message.error!,
          kind: typeof runError.code === "string" ? runError.code : "not-started",
        },
        ctx,
      );
    });
    // As any message is sent: once, under its key, while it is still to be sent.
    if (!runError) this.enqueueDelivery(key, id);
    if (byCaller) {
      this.creations.delete(id);
      this.releaseCheckingSlot(id);
      this.publishCreations();
      this.settleCreationWaiters(id, key);
    } else {
      this.closeSession(key);
      this.putCreation({ ...creation, status: "created", error: null, key });
    }
    return key;
  }

  /** Keep a creation as it now is; once it is settled, callers waiting on it learn how (or `reason`). */
  private putCreation(asked: TaskCreation, reason?: Error): void {
    // The bounded record is the one kept; the state publishes the same object.
    const creation = enforce(CREATION, asked);
    this.creations.delete(creation.id);
    this.creations.set(creation.id, creation);
    this.publishCreations();
    // Callers waiting on its outcome learn it once it is settled one way or the other.
    if (creation.status === "creating" || creation.status === "checking") return;
    this.releaseCheckingSlot(creation.id);
    if (creation.status === "created" && creation.key)
      this.settleCreationWaiters(creation.id, creation.key);
    else
      this.settleCreationWaiters(
        creation.id,
        reason ?? new Error(creation.error ?? "The task was not created."),
      );
  }

  /** Forget a creation that was never asked of the gateway; whoever joined it learns why. */
  private dropCreation(id: string, reason: Error): void {
    this.creations.delete(id);
    this.publishCreations();
    this.settleCreationWaiters(id, reason);
  }

  private settleCreationWaiters(id: string, outcome: string | Error): void {
    const waiting = this.creationWaiters.get(id) ?? [];
    this.creationWaiters.delete(id);
    for (const waiter of waiting) {
      if (typeof outcome === "string") waiter.resolve(outcome);
      else waiter.reject(outcome);
    }
  }

  private releaseCheckingSlot(id: string): void {
    if (this.checkingSlots.delete(id)) this.reservedTasks -= 1;
  }

  /** The outcome of a creation already under way, once known. */
  private awaitCreation(id: string): Promise<string> {
    if ((this.creationWaiters.get(id)?.length ?? 0) >= MAX_ACCESS_WAITERS)
      return Promise.reject(new Error("Too many requests are waiting for this task; try again."));
    return new Promise((resolve, reject) => {
      // Like any caller of `createTask`, one that joins holds an interest in the new task.
      const settle = (key: string) => {
        this.openSession(key, true);
        resolve(key);
      };
      this.creationWaiters.set(id, [
        ...(this.creationWaiters.get(id) ?? []),
        { resolve: settle, reject },
      ]);
    });
  }

  private publishCreations(): void {
    this.store.update((state) => ({ ...state, creations: [...this.creations.values()] }));
  }

  private scheduleCreationCheck(id: string, attempt = 0): void {
    const earlier = this.creationTimers.get(id);
    if (earlier) clearTimeout(earlier);
    const timer = setTimeout(
      () => {
        this.creationTimers.delete(id);
        void this.checkCreation(id, attempt);
      },
      Math.min(
        CREATION_CHECK_MAX_MS,
        (this.options.creationCheckMs ?? CREATION_CHECK_MS) * 2 ** attempt,
      ),
    );
    this.creationTimers.set(id, timer);
  }

  /**
   * Find out how a creation whose answer did not come ended. It is asked
   * again, with the same key and parameters, only of the gateway start that
   * holds that key: the hello's `server.bootId` names it, and the gateway
   * keeps a key for 300 s (OpenClaw 2026.10.6), so within
   * `CREATION_KEY_WINDOW_MS` it answers with the original outcome or waits
   * for work still in flight. Without that identity nothing establishes what
   * happened: the creation is `unknown`, and only the user's own retry, with
   * its warning, asks again.
   */
  private async checkCreation(id: string, attempt: number): Promise<void> {
    const creation = this.creations.get(id);
    if (!creation || creation.status !== "checking") return;
    if (this.state.connection.status !== "connected" || !this.holds(WRITE_SCOPE)) {
      if (this.now() - creation.createdAt <= CREATION_KEY_WINDOW_MS) return; // After the next hello.
    }
    if (
      this.now() - creation.createdAt > CREATION_KEY_WINDOW_MS ||
      creation.gatewayBootId === null ||
      creation.gatewayBootId !== this.gatewayBootId
    ) {
      this.putCreation({ ...creation, status: "unknown", error: CREATION_UNKNOWN_WARNING });
      return;
    }
    try {
      const result = asRecord(await this.request("sessions.create", creationParams(creation)));
      if (this.creations.get(id)?.status !== "checking") return;
      this.completeCreation(creation, result, false);
    } catch (error) {
      if (this.creations.get(id)?.status !== "checking") return;
      if (error instanceof GatewayProtocolRequestError) {
        this.putCreation({ ...creation, status: "failed", error: errorMessage(error) });
        return;
      }
      this.scheduleCreationCheck(id, attempt + 1);
    }
  }

  /** Check every creation still waiting for its outcome, at once; after a hello. */
  private checkCreations(): void {
    for (const creation of this.creations.values()) {
      if (creation.status !== "checking") continue;
      const timer = this.creationTimers.get(creation.id);
      if (timer) clearTimeout(timer);
      this.creationTimers.delete(creation.id);
      void this.checkCreation(creation.id, 0);
    }
  }

  /**
   * The user's retry of a creation the gateway refused, or whose outcome could
   * not be established (`CREATION_UNKNOWN_WARNING`: it may create a second
   * task), with its own key.
   */
  async retryCreation(id: string, options: { owner?: object } = {}): Promise<string> {
    const creation = this.creations.get(id);
    if (!creation || (creation.status !== "failed" && creation.status !== "unknown"))
      throw new Error("That creation cannot be retried.");
    return this.createTask(creation.botId, creation.text, {
      ...(creation.label ? { label: creation.label } : {}),
      ...(options.owner ? { owner: options.owner } : {}),
      retryUnknown: true,
    });
  }

  /** Forget a creation that failed, settled or cannot be established. */
  dismissCreation(id: string): void {
    const creation = this.creations.get(id);
    if (!creation || creation.status === "creating" || creation.status === "checking") return;
    this.creations.delete(id);
    this.publishCreations();
  }

  private outgoing(key: string, messageId: string): OutgoingMessage | undefined {
    return this.state.transcripts[key]?.outbox.find((message) => message.id === messageId);
  }

  /** Deliver one outgoing message with `chat.send`, once write access is held. */
  private async deliver(key: string, messageId: string): Promise<void> {
    // A message cancelled while it waited its turn (its bot deleted, say) stays cancelled.
    const waiting = () => {
      const status = this.outgoing(key, messageId)?.status;
      return status === "sending" || status === "awaiting-access";
    };
    // Every delivery is enqueued while its message is sending; one cancelled meanwhile asks for
    // nothing, not even access.
    if (!waiting()) return;
    if (!this.state.connection.canWrite) {
      this.updateActivity(key, (activity) =>
        updateMessage(activity, messageId, { status: "awaiting-access" }),
      );
    }
    try {
      await this.ensureScope(WRITE_SCOPE);
    } catch (error) {
      if (waiting()) this.failDelivery(key, messageId, error, true);
      return;
    }
    let message = this.outgoing(key, messageId);
    if (!message || (message.status !== "sending" && message.status !== "awaiting-access")) return;

    // A pending question holds every send, whatever run it was meant for and whether or not
    // a run is still shown as active: the question's own state is the guard.
    {
      const current = this.state.transcripts[key];
      const currentRun = current ? activeRun(current) : undefined;
      if (current && questionPending(current, currentRun)) {
        this.updateActivity(key, (activity) =>
          updateMessage(activity, messageId, { status: "held", runId: currentRun?.id ?? null }),
        );
        return;
      }
    }

    // The active run may have changed while access was pending.
    if (message.mode === "steer") {
      const active = activeRun(this.state.transcripts[key]!);
      if (!active) {
        this.updateActivity(key, (activity) => {
          const next = updateMessage(activity, messageId, { mode: "new", runId: null });
          return startLocalRun(
            next,
            next.outbox.find((each) => each.id === messageId)!,
            this.now(),
          );
        });
      } else if (active.state === "stopping") {
        this.updateActivity(key, (activity) => {
          const next = updateMessage(activity, messageId, {
            mode: "queue",
            status: "queued",
            runId: null,
          });
          return queueLocalRun(
            next,
            next.outbox.find((each) => each.id === messageId)!,
            this.now(),
          );
        });
        return;
      } else if (active.id !== message.runId) {
        this.updateActivity(key, (activity) =>
          updateMessage(activity, messageId, { runId: active.id }),
        );
      }
    }
    this.updateActivity(key, (activity) =>
      updateMessage(activity, messageId, { status: "sending" }),
    );
    message = this.outgoing(key, messageId)!;

    let result: RawRecord | null;
    try {
      // It says it comes from Clawtrate (#666), unless the gateway already refused that for this
      // message, or for every message on this connection. A command (`/…`, `!…`) or a stop word
      // goes without it at once (`goesUnmarked`): the gateway takes the marker only on ordinary
      // chat messages, and a stop must not depend on its refusal of the marker arriving.
      const marked =
        message.unmarked !== true && !this.markerRefused && !goesUnmarked(message.text);
      const params = this.sendParams(
        key,
        message.text,
        message.id,
        message.mode === "steer" ? "steer" : "followup",
        this.attachmentContent.get(messageId)?.files ?? [],
        message.replyToId,
        marked,
      );
      this.checkSize(params);
      // A send that starts its own run names that run's request: what a failed turn's
      // "Copy request ID" gives (F-301). A steer joins a run another frame started.
      const starts = message.mode !== "steer";
      const send = (frame: typeof params) =>
        this.request("chat.send", frame, {
          onSent: (requestId) => {
            if (!starts) return;
            this.updateActivity(key, (activity) => noteRunRequest(activity, messageId, requestId));
          },
        });
      const generation = this.generation;
      const sent = send(params).catch(async (error: unknown) => {
        // Refused for the marker alone: the same message once more without it, under the same
        // key, so it is never lost and never delivered twice. Any other refusal is its own.
        const refused = marked ? markerRefusal(error) : null;
        if (!refused) throw error;
        // Learnt for the connection that answered, never for a later one.
        if (refused === "gateway" && generation === this.generation) this.markerRefused = true;
        // A Stop withdrew it, or it went away, while the refusal was on its way: nothing more.
        const now = this.outgoing(key, messageId);
        if (!now || now.steer === "withdrawn") throw error;
        // A question opened meanwhile holds the resend, as it holds any send: the gateway would
        // take a plain message as its answer. It goes, without the marker, once the question
        // settles. The refused frame started nothing, so the message's own local run waits too,
        // queued in its place ahead of what was queued after it (`requeueLocalRun`); the release
        // starts it, or steers the message into the gateway's run and drops it. A run the person
        // asked to stop keeps the path below, where the resend's answer names it and it is aborted.
        const current = this.state.transcripts[key];
        const own = current ? findRun(current, messageId) : undefined;
        const requeue = (activity: TaskActivity) => {
          const message = activity.outbox.find((each) => each.id === messageId);
          return own && message ? requeueLocalRun(activity, message, this.now()) : activity;
        };
        const kept = current && own?.state !== "stopping" ? requeue(current) : null;
        const keptRun = kept ? activeRun(kept) : undefined;
        if (kept && questionPending(kept, keptRun)) {
          this.updateActivity(key, (activity) =>
            updateMessage(requeue(activity), messageId, {
              status: "held",
              unmarked: true,
              leftAt: null,
              runId: keptRun?.id ?? null,
            }),
          );
          return HELD_FOR_QUESTION;
        }
        // Anything else pressed meanwhile is as it would be had the gateway taken the first
        // frame. The refused frame started nothing, and a Stop asked for meanwhile waits for an
        // answer that names the run: the resend's, which is aborted then (below), as before the
        // marker. A stop word's resend is handled as the gateway answers it.
        this.updateActivity(key, (activity) =>
          updateMessage(activity, messageId, { unmarked: true }),
        );
        const { workContext: _marker, ...unmarked } = params;
        return send(unmarked as typeof params);
      });
      // The frame has left: from here a Stop no longer parks it. A steer's own run id is its key
      // (the gateway's `clientRunId`), known before the answer: its events, and a Stop's
      // withdrawal of it, need not wait for the answer.
      const joins = starts ? null : message.runId;
      this.updateActivity(key, (activity) => {
        const left = updateMessage(activity, messageId, { leftAt: this.now() });
        return joins ? registerSteerAlias(left, messageId, joins) : left;
      });
      const answer = await sent;
      if (answer === HELD_FOR_QUESTION) return;
      result = asRecord(answer);
    } catch (error) {
      this.noteMissingScope(error);
      // A Stop withdrew it while the answer was on its way: it stays Not sent.
      if (this.outgoing(key, messageId)?.steer === "withdrawn") return;
      if (
        error instanceof GatewayProtocolRequestError ||
        error instanceof SendTooLargeError ||
        error instanceof NotSentError
      ) {
        // Refused by the gateway, or never sent: it did not happen.
        this.failDelivery(key, messageId, error, !(error instanceof NotSentError));
        return;
      }
      // No answer: whether it was delivered is unknown. History is read to find
      // it by its key; it becomes unconfirmed, with retry and delete, only if
      // history does not hold it. Nothing is sent again on an assumption.
      // A run the person asked to stop stays, stopping, until history names or settles it.
      this.updateActivity(key, (activity) =>
        dropUnboundRunUnlessStopping(
          updateMessage(activity, messageId, {
            status: "checking",
            runId: null,
            error: errorMessage(error),
          }),
          messageId,
        ),
      );
      this.scheduleHistory(key);
      return;
    }
    // A Stop withdrew it while the answer was on its way: it stays Not sent, whatever the answer.
    if (this.outgoing(key, messageId)?.steer === "withdrawn") return;
    const runId = typeof result?.runId === "string" ? result.runId : null;
    const messageSeq = typeof result?.messageSeq === "number" ? result.messageSeq : null;
    const steeredInto = message.mode === "steer" ? message.runId : null;
    // A stop command (`/stop`) is answered `{ok, aborted, runIds}` before any
    // run or turn is recorded: the gateway handled it, and no run or history
    // row will follow.
    const command = runId === null && typeof result?.aborted === "boolean";
    this.updateActivity(key, (activity, ctx) => {
      if (command) {
        // A stop command of this task's stopped the runs its answer names: as this client's Stop.
        const stopped =
          result?.aborted === true && Array.isArray(result.runIds)
            ? result.runIds.filter((id): id is string => typeof id === "string")
            : [];
        // The gateway's `/stop` withdraws the steers it held too, and names them.
        return markWithdrawn(
          markStopAsked(
            dropUnboundRun(
              updateMessage(activity, messageId, {
                status: "handled",
                messageSeq: null,
                runId: null,
                error: null,
              }),
              messageId,
            ),
            stopped,
            this.now(),
          ),
          stopped,
        );
      }
      if (runId === null && message.mode !== "steer") {
        // Accepted, but no run named: none is assumed, unless the person asked to stop it.
        // History confirms the message, or the next read finds it unconfirmed, to retry or delete.
        return dropUnboundRunUnlessStopping(
          updateMessage(activity, messageId, { status: "sent", messageSeq, runId: null }),
          messageId,
        );
      }
      let next = updateMessage(activity, messageId, {
        status: "sent",
        messageSeq,
        runId: steeredInto ?? runId ?? messageId,
      });
      if (message.mode === "steer") {
        // The steer's own run id settles at once; the reply streams under the run it joined.
        if (steeredInto && runId) next = registerSteerAlias(next, runId, steeredInto);
      } else if (runId) {
        next = settleRunFromSendAnswer(bindRun(next, messageId, runId), runId, result!, ctx);
      }
      return next;
    });
    // The run is named now: a deferred Stop's check, kept under the message id, moves to the run's
    // own id, which the run keeps once history holds its message and drops the message id.
    if (runId && runId !== messageId) {
      const check = this.deferredStops.get(`${key}\u0000${messageId}`);
      if (check) {
        this.deferredStops.delete(`${key}\u0000${messageId}`);
        this.deferredStops.set(`${key}\u0000${runId}`, check);
      }
    }
    // Stop was pressed before the gateway had taken the send: abort the run it named now.
    if (runId && !command && message.mode !== "steer") {
      const run = findRun(this.state.transcripts[key] ?? emptyActivity, runId);
      if (run?.state === "stopping") {
        this.unsentStops.delete(`${key}\u0000${runId}`);
        void this.abortRun(key, runId, this.deferredStop(key, messageId, runId));
      }
    }
    // Accepted is not confirmed: the files stay until history holds the message or the user deletes it.
    if (command) this.dropAttachments(messageId);
    // Accepted: the message a task waits to be named from may be shown to a model now.
    else this.nameAccepted(key, messageId, message.text);
    this.scheduleHistory(key);
  }

  /**
   * A send failed. A gateway refusal is definitive: the run "Couldn't start".
   * Anything else leaves the outcome unknown, so the optimistic run is dropped;
   * the message can be retried with the same idempotency key either way.
   */
  private failDelivery(key: string, messageId: string, error: unknown, definitive: boolean): void {
    const message = this.outgoing(key, messageId);
    if (!message) return;
    this.updateActivity(key, (activity, ctx) => {
      let next = updateMessage(activity, messageId, {
        status: "failed",
        error: errorMessage(error),
      });
      if (message.mode !== "steer" && findRun(next, messageId)) {
        next = definitive
          ? failRunStart(
              next,
              messageId,
              { message: errorMessage(error), kind: "not-started" },
              ctx,
            )
          : dropUnboundRun(next, messageId);
      }
      return next;
    });
  }

  // Stopping --------------------------------------------------------------------

  /**
   * Stop a running or waiting run with `chat.abort`. The run is `stopping`
   * until the gateway reports how it ended: `stopped` when the abort took,
   * `completed` with `finishedBeforeStop` when the run finished first. With `taskOnly` (the
   * Computer tab's Stop), the runs of other bots this run's messages started are not stopped.
   */
  async stopRun(
    key: string,
    asked: string,
    options: {
      owner?: object;
      everyRun?: boolean;
      taskOnly?: boolean;
      /** A Stop that belongs to an action's connection (archive, delete): false once it has gone. */
      bound?: () => boolean;
    } = {},
  ): Promise<void> {
    const transcript = this.state.transcripts[key];
    const runId = transcript
      ? (runningRunId(transcript, asked) ??
        // Archive and delete stop every active run of the task, so each is aborted by its own
        // id even when none of them is established as the current one.
        (options.everyRun
          ? (transcript.steerAliases[asked] ?? transcript.queueAliases[asked] ?? asked)
          : null))
      : asked;
    // No one current run is established: Stop is withheld until the gateway identifies it.
    if (runId === null) return;
    const run = transcript && findRun(transcript, runId);
    if (!run || (run.state !== "running" && run.state !== "waiting")) return;
    this.updateActivity(key, (activity) => {
      const stopping = requestStop(activity, runId, this.now());
      // A task-only Stop leaves the recipients alone, as if already asked (`stopRecipients`); a
      // later Stop of the conversation's own, after that one was refused, asks them again.
      if (options.taskOnly || run.stoppedWith?.recipientsAsked)
        return noteStoppedWith(stopping, runId, (now) => ({
          ...now,
          recipientsAsked: options.taskOnly === true,
        }));
      return stopping;
    });
    // An action's Stop of a run not named yet keeps its check before the wait for write access:
    // the send's answer can name the run meanwhile, and its abort must find the check. With no
    // room left for it, the Stop is given up now rather than sent unbound later.
    // Kept before the wait: the abort is then the send's answer's, or a history read's, alone.
    const deferred = options.bound !== undefined && !run.bound;
    if (deferred && !this.keepDeferredStop(key, runId, options.bound!)) {
      this.updateActivity(key, (activity) => revertStop(activity, runId, TOO_MANY_STOPS));
      return;
    }
    try {
      await this.ensureScope(WRITE_SCOPE, options.owner ?? null);
      this.checkNotWithdrawn(options.owner);
      const current = findRun(this.state.transcripts[key] ?? emptyActivity, runId);
      if (!current || current.state !== "stopping") return;
      // The gateway cancels only a run it has registered: an abort that reaches it before it
      // has taken the send stops nothing, with or without the run's id, and the turn then runs
      // in full. So a run the gateway has not named yet is aborted once the send's answer
      // names it (`deliver`); an answer that says it is over already needs no abort.
      if (!current.bound) {
        if (options.taskOnly && options.owner)
          this.unsentStops.set(`${key}\u0000${runId}`, options.owner);
        // The abort sent once the run is named stays on the action's connection: its check is kept.
        return;
      }
      // Named during the wait: the send's answer has aborted it already, with the check.
      if (deferred) return;
      await this.abortRun(key, current.id, options.bound);
    } catch (error) {
      this.noteMissingScope(error);
      this.updateActivity(key, (activity) => revertStop(activity, runId, errorMessage(error)));
      // Given up (withdrawn, or no write access): its check goes with it, wherever it was moved,
      // so no later Stop of the run takes this action's connection.
      if (deferred) {
        for (const [held, check] of this.deferredStops)
          if (check === options.bound && held.startsWith(`${key}\u0000`))
            this.deferredStops.delete(held);
      }
    }
  }

  /**
   * Keep a deferred Stop's check (the action's connection) until its run ends. Checks whose runs
   * have ended are let go first; a check still needed is never let go for a newer one. False when
   * `MAX_DEFERRED_STOPS` are all still needed.
   */
  private keepDeferredStop(key: string, runId: string, bound: () => boolean): boolean {
    for (const held of [...this.deferredStops.keys()]) {
      const [task, id] = held.split("\u0000") as [string, string];
      const activity = this.state.transcripts[task];
      const run = activity?.runs.find((each) => each.id === id || each.messageId === id);
      // Still stopping, or stopped with no known outcome after a Stop: a history read that names
      // it can still abort it (`readTranscript`), and that abort needs the check.
      const needed =
        run?.state === "stopping" ||
        (run?.state === "stopped" && !run.outcomeKnown && run.stopRequestedAt !== null);
      if (!needed) this.deferredStops.delete(held);
    }
    if (this.deferredStops.size >= MAX_DEFERRED_STOPS) return false;
    this.deferredStops.set(`${key}\u0000${runId}`, bound);
    return true;
  }

  /**
   * The action's connection a deferred Stop of this run was asked on, if any. It stays while the
   * run is stopping: the send's answer and a history read can each abort the run, and retry.
   */
  private deferredStop(key: string, ...ids: string[]): (() => boolean) | undefined {
    for (const id of ids) {
      const bound = this.deferredStops.get(`${key}\u0000${id}`);
      if (bound) return bound;
    }
    return undefined;
  }

  /**
   * The check of a deferred Stop a history read aborts: kept under the run's id from before the
   * gateway named it, its message id, whatever id the run has now (`deliver` renames it).
   */
  private historyStopCheck(key: string, run: Pick<Run, "id" | "messageId">) {
    return this.deferredStop(key, run.id, run.messageId ?? run.id);
  }

  /**
   * `chat.abort` for one run the gateway has named, its exact id. Only the gateway's refusal
   * gives the Stop up. An abort that was not sent, or whose answer the connection lost, leaves
   * the run stopping: once the connection is back, the run is aborted again if it still is, as
   * many times as the connection drops, until the gateway answers or the run's end arrives.
   */
  private async abortRun(
    key: string,
    runId: string,
    bound?: () => boolean,
    sent = false,
  ): Promise<void> {
    // The Stop belongs to the gateway it began on: after the wait below, the person may have
    // switched to another, which must never get this abort. A reconnect to the same one still does,
    // except for a Stop that belongs to an action's connection (`bound`): another gateway can
    // answer that reconnect at the same address, so the abort goes no further.
    const gateway = this.settings?.url;
    const gone = () => {
      if (!bound || bound()) return false;
      const why = sent ? CONNECTION_CHANGED_AFTER_SEND : CONNECTION_CHANGED;
      this.updateActivity(key, (activity) => revertStop(activity, runId, why));
      return true;
    };
    if (gone()) return;
    try {
      // A withdrawal the gateway does not answer must not hold the Stop: after a short wait the
      // run is aborted anyway, and that steer stays as it was.
      let waited: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.withdrawSteers(key, runId),
        new Promise<void>((resolve) => (waited = setTimeout(resolve, STEER_WITHDRAWAL_WAIT_MS))),
      ]);
      clearTimeout(waited);
      if (this.settings?.url !== gateway || gone()) return;
      sent = true;
      const result = asRecord(await this.request("chat.abort", { sessionKey: key, runId }));
      // Nothing was aborted: the run ended already. Its terminal event or history settles it.
      if (result?.aborted === false) this.scheduleHistory(key);
      else if (result?.aborted === true) this.noteHelpers(key, runId, result);
    } catch (error) {
      this.noteMissingScope(error);
      if (error instanceof GatewayProtocolRequestError) {
        this.updateActivity(key, (activity) => revertStop(activity, runId, errorMessage(error)));
        return;
      }
      // Let the connection's own handling of a drop run first, so a lost connection is seen as one.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      // A client that was stopped sends nothing more.
      if (!this.protocol) return;
      try {
        await this.ensureScope(WRITE_SCOPE);
      } catch (waiting) {
        this.updateActivity(key, (activity) => revertStop(activity, runId, errorMessage(waiting)));
        return;
      }
      const run = this.state.transcripts[key] && findRun(this.state.transcripts[key], runId);
      if (run?.state === "stopping" && run.bound) await this.abortRun(key, runId, bound, sent);
    }
  }

  /**
   * Before a run is aborted, each steer sent into it that the gateway may still hold is
   * withdrawn by its own id. A Stop by the run's id alone leaves a held steer to run as a turn
   * of its own once the run has stopped; withdrawing it first is the gateway's own order for a
   * session's Stop (docs/research/steer-stop.md). Only the gateway's answer naming the steer
   * withdraws it. One that joined the run answers `aborted: false`, and one whose answer is
   * lost stays as it was: the stop note says the gateway may still run it.
   */
  private async withdrawSteers(key: string, runId: string): Promise<void> {
    // A steer whose frame left counts, answered or not: the gateway may have queued it already.
    // One whose answer never came has no run named; the alias its key got as it left still does.
    const transcript = this.state.transcripts[key] ?? emptyActivity;
    const steers = transcript.outbox.filter(
      (message) =>
        message.mode === "steer" &&
        (message.runId === runId || transcript.steerAliases[message.id] === runId) &&
        message.leftAt !== null &&
        ["sending", "sent", "checking", "unknown"].includes(message.status) &&
        message.steer === undefined,
    );
    await Promise.all(
      steers.map(async (message) => {
        try {
          const answer = asRecord(
            await this.request("chat.abort", { sessionKey: key, runId: message.id }),
          );
          if (answer?.aborted === true && Array.isArray(answer.runIds))
            this.updateActivity(key, (activity) =>
              markWithdrawn(activity, answer.runIds as unknown[]),
            );
        } catch (error) {
          this.log("warn", `chat.abort of a steer failed: ${errorMessage(error)}`);
        }
      }),
    );
  }

  /** The helper runs the gateway's confirmation of a Stop names besides the run (F-098). */
  private noteHelpers(key: string, runId: string, answer: RawRecord): void {
    const helpers = (Array.isArray(answer.runIds) ? answer.runIds : []).filter(
      (id) => typeof id === "string" && id !== runId,
    ).length;
    if (helpers > 0)
      this.updateActivity(key, (activity) =>
        noteStoppedWith(activity, runId, (now) => ({ ...now, helpers: now.helpers + helpers })),
      );
  }

  /**
   * A run this client stopped (Stop, a typed `/stop`, the timeouts' own stop) has ended as
   * stopped, however that reached it: the abort's answer, the run's end event after a lost
   * answer, or history after a reconnect. The runs of other bots its messages started are then
   * stopped too (F-296), each recipient taken from the run's own record (its `sessions_send`
   * results), every one of them asked, not only the first `MAX_STOPPED_NAMED`. Each is recorded
   * as the gateway answered: stopped, refused, unanswered, or, with no run named, uncertain. A
   * recipient whose run had ended already is not named.
   */
  private async stopRecipients(key: string, runId: string): Promise<void> {
    const transcript = this.state.transcripts[key];
    const run = transcript && findRun(transcript, runId);
    if (!transcript || !run) return;
    this.updateActivity(key, (activity) =>
      noteStoppedWith(activity, runId, (now) => ({ ...now, recipientsAsked: true })),
    );
    const note = (kind: "bots" | "uncertain" | "refused" | "unanswered", sessionKey: string) =>
      this.updateActivity(key, (activity) =>
        noteStoppedWith(activity, runId, (now) => ({ ...now, [kind]: [...now[kind], sessionKey] })),
      );
    const rawOf = (step: Run["steps"][number]) => step.raw ?? this.raw.get(key, step.id);
    // The connection the run ended on: no retry goes to another gateway, and the wait for the
    // gateway's own turn is recorded only on this connection (#645).
    const target = this.target;
    const epoch = this.epoch;
    const recipients = recipientLinks([run], rawOf).map(async (link) => {
      if (!link.sessionKey) return;
      const known = link.runId ? transcript.linkedRuns[link.runId] : undefined;
      if (known && isTerminal(known.state)) return;
      if (!link.runId) return note("uncertain", link.sessionKey);
      const params = { sessionKey: link.sessionKey, runId: link.runId };
      for (let attempt = 0; ; attempt += 1) {
        // Never asked of another gateway: after a switch, a retry's wait for access can end on it.
        if (this.target !== target) return note("unanswered", link.sessionKey);
        try {
          const stopped = asRecord(await this.request("chat.abort", params));
          // `aborted: false`: nothing of it was running any more.
          if (stopped?.aborted === true) {
            note("bots", link.sessionKey);
            // Its reply was to come later: the gateway now starts a turn here by itself (#645).
            if (link.deliveryPending && this.target === target && this.epoch === epoch)
              this.expectFollowUp(key, link.sessionKey, link.runId, runId);
          }
          return;
        } catch (error) {
          this.logFailure("warn", "chat.abort of a recipient", error);
          if (error instanceof GatewayProtocolRequestError) return note("refused", link.sessionKey);
          // No answer: once the connection is back, asked once more.
          if (attempt > 0) return note("unanswered", link.sessionKey);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (!this.protocol) return note("unanswered", link.sessionKey);
          try {
            await this.ensureScope(WRITE_SCOPE);
          } catch {
            return note("unanswered", link.sessionKey);
          }
        }
      }
    });
    await Promise.all(recipients);
  }

  /**
   * A recipient's run this client stopped for a Stop in `key` had its reply still to come
   * (`delivery: {status: "pending"}`). Once that run ends without a reply, the gateway itself
   * starts one turn in `key` (OpenClaw 2026.10.6 and 2026.11.10, `runSessionsSendA2AFlow`): a
   * message, sent as the recipient's, that the delivery failed and the bot may retry. That turn is
   * waited for here and stopped once found (`stopFollowUps`).
   */
  private expectFollowUp(
    key: string,
    sessionKey: string,
    recipientRunId: string,
    stoppedRunId: string,
  ): void {
    const now = this.now();
    // Expired waits, and waits of an earlier connection (a reconnect to the same address keeps
    // them), give way before the bound is checked: neither can stop anything any more.
    for (const [held, each] of this.followUps)
      if (each.until <= now || each.target !== this.target || each.epoch !== this.epoch)
        this.followUps.delete(held);
    if (this.followUps.size >= MAX_FOLLOW_UPS) return;
    const id = (value: string) => capId(value, MAX_ID_CHARS);
    this.followUps.set(`${key}\u0000${id(sessionKey)}\u0000${id(recipientRunId)}`, {
      stopped: stoppedRunId,
      until: now + FOLLOW_UP_WAIT_MS,
      claimedBy: null,
      asked: false,
      target: this.target,
      epoch: this.epoch,
    });
    // It may be shown already.
    this.afterActivity(key);
  }

  /**
   * Stop the turn the gateway started by itself in `key` after a Stop of this client's (#645), as
   * that Stop would have: the person stopped the exchange, and that turn may redo it. It is found
   * by what the gateway sends, never by its words: the first run of the task after the stopped
   * one that was started by an inter-session message (its keyed row) from the stopped recipient's
   * session through `sessions_send`, and not already another awaited turn. That run claims the
   * wait whatever its state: one that ended before it was seen leaves a later message from that
   * bot alone. It is stopped only while still active, and only on the gateway the wait was made
   * on. Where the turn can't be told from a wanted one it runs: the gateway's relay of a reply,
   * and its note for another send, have the same form, so nothing is stopped when the
   * recipient's run is known to have finished well (the abort came too late: this is its reply),
   * or when another send of this task to that session could be the one answered (`mayBeAnswer`).
   * A claimed turn whose stop was withheld (no write access yet, or not yet the task's current
   * run) is looked at again on later passes; its stop is asked once. A turn the person has
   * steered is theirs, and runs (`steeredByPerson`).
   */
  private stopFollowUps(key: string, transcript: Transcript): void {
    if (this.followUps.size === 0) return;
    const now = this.now();
    const claimed = new Set<string>();
    for (const [held, expected] of this.followUps)
      if (held.startsWith(`${key}\u0000`) && expected.claimedBy) claimed.add(expected.claimedBy);
    for (const [held, expected] of [...this.followUps]) {
      const [task, sessionKey, recipientRunId] = held.split("\u0000") as [string, string, string];
      if (task !== key) continue;
      if (
        expected.until <= now ||
        expected.target !== this.target ||
        expected.epoch !== this.epoch
      ) {
        this.followUps.delete(held);
        continue;
      }
      if (expected.asked) continue;
      let run: Run | undefined;
      if (expected.claimedBy) run = findRun(transcript, expected.claimedBy);
      else {
        const stopped = findRun(transcript, expected.stopped);
        run = transcript.runs.find(
          (each) =>
            each.id !== expected.stopped &&
            !claimed.has(each.id) &&
            startedAfter(each, stopped) &&
            startedBySend(transcript, each, sessionKey),
        );
        if (!run) continue;
        this.followUps.set(held, { ...expected, claimedBy: run.id });
        claimed.add(run.id);
      }
      if (!run || !isActive(run.state) || run.state === "stopping" || run.stopRequestedAt !== null)
        continue;
      if (transcript.linkedRuns[recipientRunId]?.state === "completed") continue;
      if (steeredByPerson(transcript, run)) continue;
      if (this.mayBeAnswer(transcript, key, sessionKey, recipientRunId, run)) continue;
      if (!this.state.connection.canWrite || this.options.readOnly) continue;
      if (runningRunId(transcript, run.id) !== run.id || !run.bound) continue;
      this.followUps.set(held, { ...this.followUps.get(held)!, asked: true });
      void this.stopFollowUp(key, run.id, expected.stopped, sessionKey, expected);
      // One per pass: the change runs this again with the task as it is now.
      return;
    }
  }

  /**
   * The Stop of a turn the gateway started by itself (#645), apart from the person's own Stop:
   * it withdraws no steer and parks no message (`parkAfterStop` leaves a run stopped as a
   * follow-up alone), since what the person sends meanwhile is theirs. One abort, sent only on
   * the connection its wait was made on (`target` and `epoch`): it is never retried, so it never
   * reaches another connection. The stopped run's note names the turn only once the gateway
   * confirms the abort (`aborted: true`). Anything else (refused, no answer, `aborted: false`)
   * takes the marker back, with nothing said: what ends the turn then is not this stop.
   */
  private async stopFollowUp(
    key: string,
    runId: string,
    stoppedRunId: string,
    sessionKey: string,
    connection: { target: number; epoch: number },
  ): Promise<void> {
    const giveUp = () =>
      this.updateActivity(key, (activity) => unmarkStoppedAsFollowUp(activity, runId));
    if (this.target !== connection.target || this.epoch !== connection.epoch) return;
    this.updateActivity(key, (activity) =>
      requestStop(markStoppedAsFollowUp(activity, runId), runId, this.now()),
    );
    try {
      const result = asRecord(await this.request("chat.abort", { sessionKey: key, runId }));
      if (result?.aborted === true) {
        this.updateActivity(key, (activity) =>
          noteStoppedWith(activity, stoppedRunId, (now) => ({
            ...now,
            followUps: [...now.followUps, sessionKey],
          })),
        );
        return;
      }
      giveUp();
      // Nothing was aborted: the turn ended already. Its terminal event or history settles it.
      if (result?.aborted === false) this.scheduleHistory(key);
    } catch (error) {
      this.noteMissingScope(error);
      giveUp();
    }
  }

  /**
   * Whether `run` could instead answer another of this task's sends to `sessionKey` whose reply was
   * to come later: the gateway starts a turn of the same form for each, its reply or its note that
   * the delivery failed, once that send's recipient's run has ended, and nothing in that turn
   * names the send it answers. So any such send counts while its recipient's run is not known to
   * be still going, however many turns of that form came since: one of them may have been the
   * other bot's own message, and the answer still to come. A send whose recipient's run finished
   * well always counts, awaited or not: its reply is owed. Otherwise a send doesn't count when
   * `run` made it (a turn doesn't answer its own message), or when what the gateway starts for it
   * is itself awaited as the follow-up of a Stop.
   */
  private mayBeAnswer(
    transcript: Transcript,
    key: string,
    sessionKey: string,
    recipientRunId: string,
    run: Run,
  ): boolean {
    const rawOf = (step: Run["steps"][number]) => step.raw ?? this.raw.get(key, step.id);
    return transcript.runs.some(
      (sender) =>
        sender.id !== run.id &&
        recipientLinks([sender], rawOf).some((link) => {
          if (link.sessionKey !== sessionKey || !link.deliveryPending) return false;
          // A send whose recipient's run isn't named: nothing is awaited for it, and its reply
          // could be this turn.
          if (!link.runId) return true;
          const runId = capId(link.runId, MAX_ID_CHARS);
          const linked = transcript.linkedRuns[runId];
          // Its recipient finished well, its abort too late or never sent: its real reply is owed,
          // and could be this turn, whatever else awaits it.
          if (linked?.state === "completed") return true;
          // The send whose stopped recipient this turn answers, or another that a Stop awaits too.
          if (runId === recipientRunId) return false;
          if (this.followUps.has(`${key}\u0000${sessionKey}\u0000${runId}`)) return false;
          // Still running: what the gateway starts for it comes only after it ends.
          return !(linked && isActive(linked.state));
        }),
    );
  }

  // Approvals -------------------------------------------------------------------

  /**
   * Resolve an approval with the method for its kind: allow once, deny, or a
   * standing allow (`allow-always`), optionally limited to `expiresInDays`
   * days where the gateway takes a duration (exec and the generic kind). Deny
   * is always possible. The gateway offers no field for which bots a standing
   * allow covers. The generic method answers with the approval's actual
   * outcome, which is what the card then shows, even when another reviewer
   * settled it first.
   */
  async resolveApproval(
    key: string,
    approvalId: string,
    decision: ApprovalDecision,
    options: { expiresInDays?: number | null; owner?: object; shownDigest?: string | null } = {},
  ): Promise<void> {
    const approval = this.state.transcripts[key]?.approvals.find((each) => each.id === approvalId);
    if (!approval || approval.status !== "pending")
      throw new Error("That approval is no longer open.");
    // One decision on its way at a time, but a Deny may follow an allow; no allow while
    // an outcome is unknown, and no Deny again while an earlier Deny's is (`decisionRefusal`).
    const refusal = decisionRefusal({ ...approval, ...this.attemptsFor(approvalId) }, decision);
    if (refusal) throw new Error(refusal);
    if (this.attemptsFull(approvalId)) {
      throw new Error(
        "Too many decisions are waiting for an outcome; check them again before deciding another.",
      );
    }
    // Text cut to its bound is allowed only by a viewer this host gave the whole text to, naming
    // the digest of what it was given. A digest the state already carries proves nothing.
    const owner = options.owner ?? DIRECT_CALLER;
    if (
      decision !== "deny" &&
      approval.decisionCut &&
      !this.readWhole(key, approval, owner, options)
    ) {
      throw new Error(
        "This approval's command is too long to show in full; read it whole (readApprovalText) before allowing it, or deny it.",
      );
    }
    if (decision !== "deny" && !approval.allowedDecisions.includes(decision)) {
      throw new Error(`The gateway does not offer ${decision} for this approval.`);
    }
    const days = options.expiresInDays ?? null;
    if (days !== null) {
      if (decision !== "allow-always") throw new Error("Only a standing allow takes a duration.");
      if (approval.kind === "plugin") throw new Error("Plugin approvals take no duration.");
      if (!Number.isInteger(days) || days < 1 || days > MAX_GRANT_DAYS) {
        throw new Error(`A standing allow lasts 1 to ${MAX_GRANT_DAYS} days.`);
      }
    }
    const { method, params } = resolveRequest(approval, decision, days);
    // This decision's attempt: its response settles only it.
    const attempt = this.nextAttempt();
    this.changeAttempts(approvalId, (each) => startDecision(each, decision, attempt), null);
    // Whether the decision left this client: before that, a failure means nothing was sent.
    let sent = false;
    try {
      await this.ensureScope(APPROVALS_SCOPE, options.owner ?? null);
      this.checkNotWithdrawn(options.owner);
      // Access may have taken a while: what is decided must still be the approval that was checked.
      const now = this.state.transcripts[key]?.approvals.find((each) => each.id === approvalId);
      if (
        !now ||
        now.status !== "pending" ||
        now.decisionDigest !== approval.decisionDigest ||
        (decision !== "deny" && now.decisionCut && !this.readWhole(key, now, owner, options))
      ) {
        throw new Error("The approval changed or was settled while access was being approved.");
      }
      sent = true;
      this.updateActivity(key, (activity) => noteSent(activity, approvalId, { method, params }));
      const result = asRecord(await this.request(method, params));
      let resolution: ApprovalResolution | null;
      let applied = true;
      if (method === "approval.resolve") {
        // `{applied, approval}`: the approval as it actually ended.
        resolution = resolutionFromSnapshot(result?.approval, { via: method, record: result });
        applied = result?.applied === true;
        if (!resolution) throw new Error("The gateway did not say how the approval ended.");
      } else {
        // The legacy methods answer `{ok: true}` once the decision is applied.
        resolution = {
          id: approvalId,
          status: decision === "deny" ? "denied" : "allowed",
          decision,
          reason: "user",
          resolvedAt: this.now(),
          resolvedBy: this.host.client.displayName,
          resolver: null,
          applicationStatus: null,
          authoritative: true,
          lossy: false,
          sessionKey: approval.sessionKey,
          runId: approval.runId,
          // The reply as the gateway sent it (`{ok: true}`); its resolved event follows.
          records: [{ via: method, record: result }],
        };
      }
      this.noteApprovalOutcome(resolution);
      this.changeAttempts(approvalId, (each) => finishDecision(each, attempt, "answered"));
      if (!applied) {
        this.updateActivity(key, (activity) =>
          patchError(activity, approvalId, "It had already been settled; this is how it ended."),
        );
      }
    } catch (error) {
      // A gateway error is a refusal of this decision; anything else after sending leaves it unknown.
      // Refused only when the answer establishes the decision was not applied
      // (`approval-refusals.ts`); every other answer after sending is unknown.
      const outcome =
        !sent || error instanceof NotSentError
          ? "not-sent"
          : isRefusedDecision(method, error)
            ? "refused"
            : "unknown";
      // Only this attempt is settled; a decision that lost to one already settled changes nothing.
      // Kept with the approval, so it holds even when no task shows it any more.
      this.changeAttempts(
        approvalId,
        (each) => finishDecision(each, attempt, outcome),
        errorMessage(error),
      );
      this.noteMissingScope(error);
      // Neither answer says whether the request is still open: read it back.
      if (outcome !== "not-sent") void this.checkApproval(key, approvalId).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Read back an approval whose last decision from this client was refused or
   * got no answer (`approval.get`). Settled: the card shows how it ended.
   * Still pending: an unanswered decision was not applied, so the card offers
   * its choices again; a refused one is marked still open. Anything else
   * leaves the card as it is.
   */
  async checkApproval(key: string, approvalId: string): Promise<void> {
    const card = this.state.transcripts[key]?.approvals.find((each) => each.id === approvalId);
    if (card && card.status !== "pending") return;
    if (this.approvalOutcomes.get(capId(approvalId, MAX_ID_CHARS))?.status) return;
    // The approval's own attempts: they hold whether or not a task shows it now.
    const before = this.attemptsFor(approvalId);
    if (before.decisionError === null) return;
    if (!this.holds(APPROVALS_SCOPE)) throw new NotSentError();
    if (this.attemptsFull(approvalId)) throw new NotSentError();
    const generation = this.generation;
    // The read-back's attempt: its pending answer counts only if nothing newer began.
    const attempt = this.nextAttempt();
    this.changeAttempts(approvalId, (each) => startReadback(each, attempt));
    let result: Record<string, unknown> | null;
    try {
      result = asRecord(await this.request("approval.get", { id: approvalId }));
    } finally {
      this.changeAttempts(approvalId, (each) => finishReadback(each, attempt));
    }
    if (generation !== this.generation) return;
    const snapshot = asRecord(result?.approval);
    const resolution = resolutionFromSnapshot(snapshot, {
      via: "approval.get",
      record: result,
    });
    if (resolution && resolution.id === approvalId) {
      // A settled request is evidence of the winner whenever it was read.
      this.noteApprovalOutcome(resolution);
      if (before.decisionError === "refused") {
        this.forEachCard(approvalId, (key) =>
          this.updateActivity(key, (activity) =>
            patchError(activity, approvalId, "It had already been settled; this is how it ended."),
          ),
        );
      }
      return;
    }
    if (snapshot?.id !== approvalId || snapshot.status !== "pending") {
      throw new Error("The gateway did not say whether the request is still open.");
    }
    let stale = false;
    let cleared = false;
    this.changeAttempts(approvalId, (each) => {
      const read = readbackStillPending(each, attempt);
      stale = read.stale;
      cleared = read.cleared;
      return read.card;
    });
    if (cleared) {
      this.forEachCard(approvalId, (key) =>
        this.updateActivity(key, (activity) => patchError(activity, approvalId, null)),
      );
    }
    // A newer attempt began while this was read: its answer proves nothing now. Read again,
    // unless a newer read-back is already on its way to decide it.
    const now = this.attemptsFor(approvalId);
    if (stale && now.decisionError === "unknown" && now.readingAt === null) {
      void this.checkApproval(key, approvalId).catch(() => undefined);
    }
  }

  // Attempts kept with the approval --------------------------------------------

  private nextAttempt(): number {
    this.attemptSeq += 1;
    return this.attemptSeq;
  }

  /** An approval's attempts: those kept for it, else those its card shows, else none. */
  private attemptsFor(approvalId: string): ApprovalAttempts {
    const kept = this.approvalAttempts.get(capId(approvalId, MAX_ID_CHARS));
    if (kept) return kept;
    for (const transcript of Object.values(this.state.transcripts)) {
      const card = transcript.approvals.find((each) => each.id === approvalId);
      if (card && card.status === "pending") return attemptsOf(card);
    }
    return NO_ATTEMPTS;
  }

  /** Whether keeping one more approval's attempts would pass the bound. */
  private attemptsFull(approvalId: string): boolean {
    return (
      !this.approvalAttempts.has(capId(approvalId, MAX_ID_CHARS)) &&
      this.approvalAttempts.size >= MAX_APPROVAL_ATTEMPTS
    );
  }

  /** Every followed task that shows this approval. */
  private forEachCard(approvalId: string, fn: (key: string) => void): void {
    for (const transcript of Object.values(this.state.transcripts)) {
      if (transcript.approvals.some((each) => each.id === approvalId)) fn(transcript.sessionKey);
    }
  }

  /**
   * Change an approval's attempts where they are kept, then on every card
   * that shows it. Kept while anything is outstanding and the approval is not
   * settled; `error`, when given, is what its cards say.
   */
  private changeAttempts(
    approvalId: string,
    change: (attempts: ApprovalAttempts) => ApprovalAttempts,
    error?: string | null,
  ): void {
    const id = capId(approvalId, MAX_ID_CHARS);
    const next = enforce(APPROVAL_ATTEMPTS, attemptsOf(change(this.attemptsFor(approvalId))));
    this.approvalAttempts.delete(id);
    const settled = this.approvalOutcomes.get(id) !== undefined;
    if (!settled && !attemptsSettled(next) && this.approvalAttempts.size < MAX_APPROVAL_ATTEMPTS) {
      this.approvalAttempts.set(id, next);
    }
    this.forEachCard(approvalId, (key) =>
      this.updateActivity(key, (activity) => ({
        ...activity,
        approvals: activity.approvals.map((card) => {
          // A settled card shows how it ended: a late answer changes nothing on it.
          if (card.id !== approvalId || card.status !== "pending") return card;
          const shown = { ...card, ...next };
          return error === undefined ? shown : { ...shown, error };
        }),
      })),
    );
  }

  /**
   * Draw every pending card from its approval's kept attempts. A card that a
   * task admits while something is outstanding (the task opened again, or the
   * approval came back in a list) starts a new attempt: its outcome is unknown
   * until a read-back sent after this answers.
   */
  private withKeptAttempts(before: TaskActivity | undefined, activity: TaskActivity): TaskActivity {
    if (this.approvalAttempts.size === 0) return activity;
    let changed = false;
    const approvals = activity.approvals.map((card) => {
      if (card.status !== "pending") return card;
      const id = capId(card.id, MAX_ID_CHARS);
      let kept = this.approvalAttempts.get(id);
      if (!kept) return card;
      if (!before?.approvals.some((each) => each.id === card.id)) {
        kept = reopenAttempts(kept, this.nextAttempt());
        this.approvalAttempts.set(id, kept);
        // Read back after this, outside the change being made.
        const approvalId = card.id;
        void Promise.resolve().then(() =>
          this.checkApproval(this.keyShowing(approvalId), approvalId).catch(() => undefined),
        );
      }
      if (sameAttempts(card, kept)) return card;
      changed = true;
      return { ...card, ...kept };
    });
    return changed ? { ...activity, approvals } : activity;
  }

  /** A followed task that shows this approval, or "" when none does. */
  private keyShowing(approvalId: string): string {
    for (const transcript of Object.values(this.state.transcripts)) {
      if (transcript.approvals.some((each) => each.id === approvalId)) return transcript.sessionKey;
    }
    return "";
  }

  /**
   * Remember what the gateway reported about an approval and apply it to every
   * task showing it. Kept apart from the cards, so a request or list entry that
   * arrives later can never make it actionable again.
   */
  private noteApprovalOutcome(resolution: ApprovalResolution): void {
    // Kept, and keyed, as bounded: the id under its cap, like the cards' ids.
    const known = enforce(
      APPROVAL_OUTCOME,
      mergeResolution(this.approvalOutcomes.get(capId(resolution.id, MAX_ID_CHARS)), resolution),
    );
    if (known.lossy) void this.lookUpOutcome(known.id);
    this.approvalOutcomes.delete(known.id);
    this.approvalOutcomes.set(known.id, known);
    // Settled: nothing about it is outstanding any more.
    this.approvalAttempts.delete(known.id);
    while (this.approvalOutcomes.size > MAX_APPROVAL_OUTCOMES) {
      this.approvalOutcomes.delete(this.approvalOutcomes.keys().next().value as string);
    }
    if (this.unrouted.delete(known.id)) this.publishUnrouted();
    for (const transcript of Object.values(this.state.transcripts)) {
      if (transcript.approvals.some((approval) => approval.id === known.id)) {
        this.updateActivity(transcript.sessionKey, (activity) =>
          applyApprovalResolved(activity, known),
        );
      }
    }
    // A settled approval makes room for one that was waiting.
    this.routeUnrouted();
  }

  /** Whether this viewer was given this approval's whole text, and names the digest of what it was given. */
  private readWhole(
    key: string,
    approval: ApprovalCard,
    owner: object,
    options: { shownDigest?: string | null },
  ): boolean {
    const read = this.approvalReads.get(`${key}\u0000${approval.id}`)?.get(owner);
    return read !== undefined && read === approval.decisionDigest && options.shownDigest === read;
  }

  /** Remember that a viewer was given an approval's whole text, keeping only reads of pending approvals. */
  private noteApprovalRead(key: string, approvalId: string, owner: object, digest: string): void {
    for (const readKey of [...this.approvalReads.keys()]) {
      const [task, id] = readKey.split("\u0000") as [string, string];
      const pending = this.state.transcripts[task]?.approvals.some(
        (each) => each.id === id && each.status === "pending",
      );
      if (!pending || !this.tracked(task)) this.approvalReads.delete(readKey);
    }
    const readKey = `${key}\u0000${approvalId}`;
    const readers = this.approvalReads.get(readKey) ?? new Map<object, string>();
    readers.delete(owner);
    readers.set(owner, digest);
    while (readers.size > MAX_APPROVAL_READERS)
      readers.delete(readers.keys().next().value as object);
    this.approvalReads.set(readKey, readers);
  }

  /**
   * A legacy exec or plugin resolution said `deny`, which the gateway also
   * sends when it cancelled the approval or it expired: read the approval's
   * own snapshot (`approval.get`, under the `operator.approvals` the client
   * already holds) for how it ended. Until it answers, or if it cannot, the
   * approval shows closed with its cause unknown, never as a denial.
   */
  private async lookUpOutcome(id: string): Promise<void> {
    if (this.lookingUp.has(id) || this.lookingUp.size >= MAX_OUTCOME_LOOKUPS) return;
    if (!this.holds(APPROVALS_SCOPE)) return;
    const generation = this.generation;
    this.lookingUp.add(id);
    try {
      const result = asRecord(await this.request("approval.get", { id }));
      if (generation !== this.generation) return;
      const resolution = resolutionFromSnapshot(result?.approval, {
        via: "approval.get",
        record: result,
      });
      if (resolution && resolution.id === id) this.noteApprovalOutcome(resolution);
    } catch (error) {
      if (generation === this.generation) this.noteMissingScope(error);
      this.logFailure("warn", "approval.get", error);
    } finally {
      this.lookingUp.delete(id);
    }
  }

  /**
   * The followed task an approval belongs in, and how it got there: where it
   * already is; its own session; the task holding its run; the task that
   * spawned its session (a helper); or the task whose `sessions_send` result
   * named its run, or, for an approval naming no run, its session (a messaged
   * bot). Null when no followed task is known to be its origin.
   */
  private approvalTarget(
    card: ApprovalCard,
  ): { key: string; parent: string | null; relation: ApprovalCard["relation"] } | null {
    const transcripts = Object.values(this.state.transcripts).filter((each) =>
      this.tracked(each.sessionKey),
    );
    for (const transcript of transcripts) {
      const existing = transcript.approvals.find((approval) => approval.id === card.id);
      if (existing) {
        return {
          key: transcript.sessionKey,
          parent: existing.parentSessionKey,
          relation: existing.relation,
        };
      }
    }
    if (card.sessionKey && this.tracked(card.sessionKey)) {
      return { key: card.sessionKey, parent: null, relation: null };
    }
    if (card.runId) {
      const holder = transcripts.find((each) => findRun(each, card.runId!) !== undefined);
      if (holder) return { key: holder.sessionKey, parent: null, relation: null };
    }
    const spawner = card.sessionKey ? this.spawnedBy.get(card.sessionKey) : undefined;
    if (spawner && this.tracked(spawner)) {
      return { key: spawner, parent: spawner, relation: "helper" };
    }
    for (const [key, links] of this.recipients) {
      if (!this.tracked(key)) continue;
      if (
        (card.runId !== null && links.runs.has(card.runId)) ||
        (card.runId === null && card.sessionKey !== null && links.sessions.has(card.sessionKey))
      ) {
        return { key, parent: key, relation: "messaged" };
      }
    }
    return null;
  }

  /**
   * Put a pending approval in the one task it belongs to, with where it came
   * from. One no followed task can show yet is kept in `unroutedApprovals`
   * until its origin is known. What the gateway already reported about it is
   * applied at once, so it never shows as actionable after its resolution.
   */
  private routeApproval(card: ApprovalCard): void {
    const outcome = this.approvalOutcomes.get(card.id);
    const target = this.approvalTarget(card);
    if (!target) {
      if (!outcome && card.status === "pending") this.keepUnrouted(card);
      return;
    }
    const shown = this.state.transcripts[target.key]?.approvals.some((each) => each.id === card.id);
    if (!shown && !outcome && !this.hasPendingRoom(target.key)) {
      // The task shows as many pending approvals as it may: this one waits, kept and visible.
      this.keepUnrouted({ ...card, parentSessionKey: target.parent, relation: target.relation });
      return;
    }
    if (this.unrouted.delete(card.id)) this.publishUnrouted();
    this.updateActivity(target.key, (activity) => {
      let next = applyApprovalRequested(activity, {
        ...card,
        parentSessionKey: target.parent,
        relation: target.relation,
      });
      if (outcome) next = applyApprovalResolved(next, outcome);
      return next;
    });
  }

  /** Keep an approval no task shows yet; past the bound it is not kept and is counted instead. */
  private keepUnrouted(received: ApprovalCard): void {
    // Only the bounded card is kept, never the one received beside it.
    const card = admitApproval(received);
    if (!this.unrouted.has(card.id) && this.unrouted.size >= MAX_UNROUTED_APPROVALS) {
      this.unroutedOmitted += 1;
      this.publishUnrouted();
      return;
    }
    this.unrouted.set(card.id, card);
    this.publishUnrouted();
  }

  private publishUnrouted(): void {
    this.store.update((state) => ({
      ...state,
      unroutedApprovals: [...this.unrouted.values()],
      unroutedApprovalsOmitted: this.unroutedOmitted,
    }));
  }

  /** Whether a task can show one more pending approval. */
  private hasPendingRoom(key: string, extra = 0): boolean {
    const pending = (this.state.transcripts[key]?.approvals ?? []).filter(
      (approval) => approval.status === "pending",
    ).length;
    return pending + extra < MAX_PENDING_APPROVALS_PER_TASK;
  }

  /** Approvals kept without a task: route the ones whose origin is now known. */
  private routeUnrouted(): void {
    if (this.unrouted.size === 0) return;
    for (const card of [...this.unrouted.values()]) {
      if (this.approvalTarget(card)) this.routeApproval(card);
    }
  }

  /**
   * Pending approvals for one task, from `exec.approval.list`,
   * `plugin.approval.list` and `openclaw.approval.list`, when it opens and
   * after every reconnect. Each list is read against a revision and the
   * task's opening: a response older than one already applied, or from an
   * earlier opening or connection, changes nothing. Each kind's access is kept
   * apart, and a list refused for a missing scope drops that scope. On a
   * connection without `operator.approvals` the task says approvals are
   * unavailable.
   */
  private async backfillApprovals(key: string, generation: number): Promise<void> {
    if (!this.holds(APPROVALS_SCOPE)) {
      for (const kind of APPROVAL_KINDS) this.setApprovalSource(key, kind, "unavailable");
      return;
    }
    await Promise.all(
      APPROVAL_SOURCES.map((source) => this.backfillApprovalKind(key, source, generation)),
    );
  }

  private async backfillApprovalKind(
    key: string,
    source: (typeof APPROVAL_SOURCES)[number],
    generation: number,
  ): Promise<void> {
    const incarnation = this.incarnations.get(key);
    const listKey = `${key}\u0000${source.kind}`;
    const revision = (this.listRequested.get(listKey) ?? 0) + 1;
    this.listRequested.set(listKey, revision);
    const stale = () =>
      generation !== this.generation ||
      !this.tracked(key) ||
      this.incarnations.get(key) !== incarnation ||
      (this.listApplied.get(listKey) ?? 0) > revision;
    if (this.state.transcripts[key]?.approvalSources[source.kind] !== "ready")
      this.setApprovalSource(key, source.kind, "loading");
    // Only approvals pending now can be found settled by this list; later arrivals are newer than it.
    const pendingBefore = new Set(
      (this.state.transcripts[key]?.approvals ?? [])
        .filter((approval) => approval.status === "pending" && approval.kind === source.kind)
        .map((approval) => approval.id),
    );
    let value: unknown;
    try {
      value = await this.request(source.method, {});
    } catch (error) {
      if (stale()) return;
      // A failure is this revision's answer too: an older list arriving later changes nothing.
      this.listApplied.set(listKey, revision);
      this.noteMissingScope(error);
      this.setApprovalSource(key, source.kind, isMissingScope(error) ? "unavailable" : "error");
      this.logFailure("warn", source.method, error);
      return;
    }
    if (stale()) return;
    this.listApplied.set(listKey, revision);
    const record = asRecord(value);
    const items = Array.isArray(value)
      ? value
      : Array.isArray(record?.approvals)
        ? record.approvals
        : Array.isArray(record?.items)
          ? record.items
          : [];
    const mine: ApprovalCard[] = [];
    const shownIds = new Set((this.state.transcripts[key]?.approvals ?? []).map((each) => each.id));
    let added = 0;
    for (const card of items
      .map((item) => source.parse(item))
      .filter((each): each is ApprovalCard => each !== null && each.status === "pending")
      .map(admitApproval)) {
      const target = this.approvalTarget(card);
      if (target?.key !== key) {
        if (!target && !this.approvalOutcomes.has(card.id)) this.keepUnrouted(card);
        continue;
      }
      const placed = { ...card, parentSessionKey: target.parent, relation: target.relation };
      const settled = this.approvalOutcomes.has(card.id);
      if (shownIds.has(card.id) || settled || this.hasPendingRoom(key, added)) {
        if (!shownIds.has(card.id) && !settled) added += 1;
        mine.push(placed);
        if (this.unrouted.delete(card.id)) this.publishUnrouted();
      } else {
        // The task shows as many pending approvals as it may: this one waits, kept and visible.
        this.keepUnrouted(placed);
      }
    }
    const pendingNow = this.pendingApprovalIds(key);
    this.updateActivity(key, (activity) => {
      let next = activity;
      for (const card of mine) {
        next = applyApprovalRequested(next, card);
        const outcome = this.approvalOutcomes.get(card.id);
        if (outcome) next = applyApprovalResolved(next, outcome);
      }
      return settleUnlistedApprovals(
        next,
        [source.kind],
        new Set(mine.map((card) => card.id)),
        pendingBefore,
      );
    });
    this.lookUpInferred(key, pendingNow);
    // Another list may have been refused for the scope meanwhile: this one cannot be kept current then.
    this.setApprovalSource(key, source.kind, this.holds(APPROVALS_SCOPE) ? "ready" : "unavailable");
  }

  private setApprovalSource(key: string, kind: ApprovalKind, access: ApprovalSourceAccess): void {
    const transcript = this.state.transcripts[key];
    if (!transcript || transcript.approvalSources[kind] === access) return;
    const approvalSources = { ...transcript.approvalSources, [kind]: access };
    this.setTranscript(key, () => ({
      ...transcript,
      approvalSources,
      approvalAccess: approvalAccessOf(approvalSources),
    }));
  }

  private pendingApprovalIds(key: string): Set<string> {
    return new Set(
      (this.state.transcripts[key]?.approvals ?? [])
        .filter((approval) => approval.status === "pending")
        .map((approval) => approval.id),
    );
  }

  /**
   * Approvals this client has just closed by inference (past their expiry, or
   * no longer listed) are read back one by one (`approval.get`): the gateway's
   * snapshot of a settled request says how it ended, its decision and its
   * terminal reason, which then replace the inference. Each is asked once, when
   * the inference is made; one that cannot be read stays inferred.
   */
  private lookUpInferred(key: string, pendingBefore: ReadonlySet<string>): void {
    for (const approval of this.state.transcripts[key]?.approvals ?? []) {
      if (approval.inferred && approval.status !== "pending" && pendingBefore.has(approval.id))
        void this.lookUpOutcome(approval.id);
    }
  }

  /** Expire pending approvals at their `expiresAt`, then re-read the lists to confirm. */
  private scheduleApprovalExpiry(key: string): void {
    const transcript = this.state.transcripts[key];
    const existing = this.expiryTimers.get(key);
    if (existing) clearTimeout(existing);
    this.expiryTimers.delete(key);
    const next = Math.min(
      ...(transcript?.approvals ?? [])
        .filter((approval) => approval.status === "pending" && approval.expiresAt !== null)
        .map((approval) => approval.expiresAt!),
    );
    if (!Number.isFinite(next)) return;
    this.expiryTimers.set(
      key,
      setTimeout(
        () => {
          this.expiryTimers.delete(key);
          const pendingNow = this.pendingApprovalIds(key);
          this.updateActivity(key, (activity) => expireApprovals(activity, this.now()));
          this.lookUpInferred(key, pendingNow);
          void this.backfillApprovals(key, this.generation);
        },
        // setTimeout fires at once past 2^31-1 ms; re-check at that horizon instead.
        Math.min(MAX_TIMER_MS, Math.max(0, next - this.now())),
      ),
    );
  }

  // Linked runs -------------------------------------------------------------------

  /** Apply an event to a session nobody has open, keeping a few recent runs of a few sessions. */
  private updateForeign(
    rawKey: string,
    fn: (activity: TaskActivity, ctx: EngineContext) => TaskActivity,
  ): void {
    // Kept under the id cap, as the state keeps ids.
    const sessionKey = capId(rawKey, MAX_ID_CHARS);
    const before = this.foreign.get(sessionKey) ?? emptyActivity;
    let next = fn(before, { sessionKey, now: this.now(), raw: this.foreignRaw });
    if (next === before) return;
    if (next.runs.length > FOREIGN_RUNS_PER_SESSION) {
      next = { ...next, runs: next.runs.slice(-FOREIGN_RUNS_PER_SESSION) };
    }
    // Steps of foreign runs are not shown; keep only the run states, within the run bound.
    next = {
      ...next,
      runs: next.runs.map((run) => enforce(RUN, run.steps.length ? { ...run, steps: [] } : run)),
    };
    // The id pairs the session's turns were named by, newest kept, as a task's own are.
    const aliasKeys = Object.keys(next.queueAliases);
    if (aliasKeys.length > MAX_QUEUE_ALIASES)
      next = {
        ...next,
        queueAliases: Object.fromEntries(
          aliasKeys.slice(-MAX_QUEUE_ALIASES).map((key) => [key, next.queueAliases[key]!]),
        ),
      };
    this.foreign.delete(sessionKey);
    this.foreign.set(sessionKey, next);
    // A quiet end is one only once its history has been read (#680).
    const quiet = [...quietPending(next.runs)].filter(
      (id) => findRun(before, id)?.quietEnd !== "pending",
    );
    if (quiet.length > 0) void this.settleForeignQuiet(sessionKey, new Set(quiet));
    while (this.foreign.size > FOREIGN_SESSIONS) {
      const oldest = this.foreign.keys().next().value as string;
      this.foreign.delete(oldest);
    }
    const changed = next.runs.some((run) => findRun(before, run.id)?.state !== run.state);
    if (!changed) return;
    for (const key of Object.keys(this.state.transcripts)) {
      this.refreshLinkedRuns(key);
      // An approval from a helper or a messaged bot follows that run's end.
      if (this.state.transcripts[key]?.approvals.some((approval) => approval.relation !== null))
        this.updateActivity(key, (activity) => activity);
    }
  }

  /**
   * A session the gateway deleted while nobody had it open: its runs this client
   * followed are over, however they stood, and a question they waited on is no
   * longer asked. They settle as ended with no known outcome, so a card that
   * follows them stops showing them working or waiting, and the entry goes.
   */
  private retireForeign(rawKey: string): void {
    const sessionKey = capId(rawKey, MAX_ID_CHARS);
    if (this.foreign.has(sessionKey)) {
      this.updateForeign(sessionKey, (activity, ctx) =>
        activity.runs.some((run) => !isTerminal(run.state))
          ? {
              ...activity,
              runs: activity.runs.map((run) =>
                isTerminal(run.state)
                  ? run
                  : { ...finishRun(run, "cancelled", ctx), outcomeKnown: false },
              ),
            }
          : activity,
      );
      this.foreign.delete(sessionKey);
    }
    // A deletion supersedes every read of this session on its way.
    for (const token of this.foreignReads.get(sessionKey) ?? []) token.cancelled = true;
    this.foreignReads.delete(sessionKey);
  }

  /** A run this task does not hold: a followed foreign session's, or another task's. */
  private otherRun(runId: string): Run | undefined {
    for (const activity of this.foreign.values()) {
      const run = findRun(activity, runId);
      if (run) return run;
    }
    for (const transcript of Object.values(this.state.transcripts)) {
      const run = findRun(transcript, runId);
      if (run) return run;
    }
    return undefined;
  }

  /**
   * Read the gateway's current map from tool-server tools' effective names to
   * their servers and tools for a task (`tools.effective`, `operator.read`),
   * after its history loads and whenever the gateway reports its plugins
   * changed. Evidence for a call before its result only; a failed read keeps
   * the map there was. One read of a task at a time: one asked for while it
   * is in flight is made once it has answered, so a newer answer is always the
   * one applied last.
   */
  private async readToolMap(key: string, generation: number): Promise<void> {
    const running = this.toolReads.get(key);
    if (running) {
      running.again = true;
      return;
    }
    const read = { again: false };
    this.toolReads.set(key, read);
    try {
      do {
        read.again = false;
        await this.readToolMapOnce(key, generation);
      } while (read.again && generation === this.generation && this.tracked(key));
    } finally {
      if (this.toolReads.get(key) === read) this.toolReads.delete(key);
    }
  }

  private async readToolMapOnce(key: string, generation: number): Promise<void> {
    const incarnation = this.incarnations.get(key);
    let answer: unknown;
    try {
      answer = await this.request("tools.effective", { sessionKey: key });
    } catch (error) {
      if (generation === this.generation) this.logFailure("warn", "tools.effective", error);
      return;
    }
    if (
      generation !== this.generation ||
      !this.tracked(key) ||
      this.incarnations.get(key) !== incarnation
    ) {
      return;
    }
    const map = mcpToolMap(answer, MAX_MCP_TOOLS);
    const builtin = builtinToolNames(answer, MAX_BUILTIN_TOOLS);
    const startTasks = startTasksFrom(answer);
    const current = this.state.transcripts[key];
    if (
      !current ||
      (JSON.stringify(current.mcpTools) === JSON.stringify(map) &&
        JSON.stringify(current.builtinTools) === JSON.stringify(builtin) &&
        JSON.stringify(current.startTasks ?? null) === JSON.stringify(startTasks))
    )
      return;
    this.setTranscript(key, () => {
      const { startTasks: _was, ...rest } = this.state.transcripts[key]!;
      return {
        ...rest,
        mcpTools: map,
        builtinTools: builtin,
        ...(startTasks ? { startTasks } : {}),
      };
    });
  }

  /**
   * Read the reactions on a task's messages (`session.reactions.list`, `operator.read`) once its
   * history loads, keeping those of the messages it shows. Later changes come as
   * `session.reaction` events. A failed read leaves what was shown before (F-283).
   */
  private async readReactions(key: string, generation: number, attempt = 0): Promise<void> {
    const incarnation = this.incarnations.get(key);
    const epoch = this.epoch;
    const currentConnection = () => generation === this.generation && epoch === this.epoch;
    let answer: unknown;
    let before: Transcript["reactions"];
    try {
      if (this.selfId === null) await this.readSelf(currentConnection);
      if (!currentConnection()) return;
      // What the list will replace: an event, a change of this person's or a new history page
      // after it was asked for is newer than the list, and the list then gives way to it.
      before = this.state.transcripts[key]?.reactions;
      answer = await this.request("session.reactions.list", { sessionKey: key });
    } catch (error) {
      if (currentConnection()) this.logFailure("warn", "session.reactions.list", error);
      return;
    }
    if (!currentConnection() || !this.tracked(key) || this.incarnations.get(key) !== incarnation)
      return;
    if (this.state.transcripts[key]!.reactions !== before) {
      // Changed while the list was on its way: ask again, a few times, rather than go back.
      if (attempt < REACTION_LIST_ATTEMPTS - 1)
        void this.readReactions(key, generation, attempt + 1);
      return;
    }
    const listed = asRecord(asRecord(answer)?.reactions) ?? {};
    this.setTranscript(key, () => {
      const current = this.state.transcripts[key]!;
      const shown = shownMessageIds(current);
      const reactions: Record<string, MessageReaction[]> = {};
      for (const [messageId, summary] of Object.entries(listed)) {
        if (!shown.has(messageId)) continue;
        const kept = reactionsOf(summary, this.selfId);
        if (kept.length > 0) reactions[messageId] = kept;
      }
      return { ...current, reactions };
    });
  }

  /**
   * What the composer's "/" or "@" menu lists for a task (`composer-menus.ts`), read now and
   * kept nowhere (F-071, F-070). Each read is `operator.read`, `skills.library.list` included.
   */
  async readComposerMenu(key: string, trigger: "/" | "@"): Promise<MenuRow[]> {
    if (this.state.connection.status !== "connected")
      throw new Error("Not connected to the gateway.");
    if (trigger === "@") {
      const generation = this.generation;
      const routines = await this.request("cron.list", {}).catch(() => null);
      // The bots are read now: from the gateway the routines came from, or not at all.
      if (generation !== this.generation)
        throw new Error("The gateway changed while the list was read.");
      // The bots the sidebar lists (F-562).
      return mentionRows(listedBots(this.state), routines);
    }
    const agentId = botIdFromSessionKey(key);
    const [skills, metadata, library] = await Promise.all([
      agentId ? this.request("skills.status", { agentId }).catch(() => null) : null,
      this.request("chat.metadata", { sessionKey: key }).catch(() => null),
      // The library skills this task has, the person's own among them.
      this.request("skills.library.list", { sessionKey: key }).catch(() => null),
    ]);
    if (skills === null && metadata === null && library === null)
      throw new Error("The gateway did not list them.");
    return slashRows(skills, metadata, library);
  }

  /**
   * Who this connection acts for (`users.self`), for which reactions are the person's own.
   * `current` says whether the answer still applies when it arrives.
   */
  private async readSelf(current: () => boolean): Promise<void> {
    try {
      const answer = asRecord(await this.request("users.self", {}));
      if (!current()) return;
      const id = asRecord(answer?.profile)?.id;
      this.selfId = typeof id === "string" && id.length <= MAX_ID_CHARS ? id : null;
    } catch {
      // A refusal on an earlier connection says nothing of a later one's identity.
      if (current()) this.selfId = null;
    }
  }

  /**
   * Add or remove this person's reaction on a message (`session.reactions.set`,
   * `operator.write`). The gateway's answer is the message's reactions now (F-283).
   */
  async setReaction(
    key: string,
    messageId: string,
    emoji: string,
    remove: boolean,
    options: { owner?: object } = {},
  ): Promise<void> {
    const transcript = this.state.transcripts[key];
    if (!transcript) throw new Error("Open the task before reacting in it.");
    if (!shownMessageIds(transcript).has(messageId))
      throw new Error("That message is no longer shown here.");
    if (typeof emoji !== "string" || !emoji || emoji.length > 64)
      throw new Error("Choose one emoji.");
    if (this.options.readOnly) throw new Error("This host only reads; it does not react.");
    // A scope upgrade reconnects to the same address and keeps the opening of the task.
    const url = this.settings?.url;
    const incarnation = this.incarnations.get(key);
    await this.ensureScope(WRITE_SCOPE, options.owner ?? null);
    if (this.settings?.url !== url) throw new Error("That message is no longer shown here.");
    // From the identity read through the write, a new connection can act for a different person.
    const generation = this.generation;
    const epoch = this.epoch;
    const sameConnection = () => generation === this.generation && epoch === this.epoch;
    if (this.selfId === null) await this.readSelf(sameConnection);
    // After every wait, immediately before the write: its viewer is still here, and the same
    // opening of the task still shows the message.
    this.checkNotWithdrawn(options.owner);
    const now = this.state.transcripts[key];
    if (
      !sameConnection() ||
      this.incarnations.get(key) !== incarnation ||
      !now ||
      !shownMessageIds(now).has(messageId)
    )
      throw new Error("That message is no longer shown here.");
    // Any change of the task's reactions after the request is newer than its answer.
    const before = this.state.transcripts[key]?.reactions;
    let answer: RawRecord | null;
    try {
      answer = asRecord(
        await this.request("session.reactions.set", {
          sessionKey: key,
          messageId,
          emoji,
          ...(remove ? { remove: true } : {}),
        }),
      );
    } catch (error) {
      if (sameConnection()) this.noteMissingScope(error);
      throw error;
    }
    if (!sameConnection() || !this.tracked(key) || this.incarnations.get(key) !== incarnation)
      return;
    if (this.state.transcripts[key]?.reactions !== before) {
      // Something newer changed them: the gateway's list says what is true now.
      void this.readReactions(key, this.generation);
      return;
    }
    this.applyReactions(key, messageId, answer?.reactions);
  }

  /** A message's reactions as the gateway now counts them, kept if the task shows the message. */
  private applyReactions(key: string, messageId: string, summary: unknown): void {
    const current = this.state.transcripts[key];
    if (!current || !shownMessageIds(current).has(messageId)) return;
    const kept = reactionsOf(summary, this.selfId);
    this.setTranscript(key, () => {
      const latest = this.state.transcripts[key]!;
      const reactions = { ...latest.reactions };
      if (kept.length > 0) reactions[messageId] = kept;
      else delete reactions[messageId];
      return { ...latest, reactions };
    });
  }

  /**
   * Two runs of the task still look active, after a history read or from live events alone: one
   * whose end this client missed, beside the one the gateway runs now. Stop names neither until
   * one is current, so each is asked of the gateway's own run record (`agent.wait` with no wait,
   * `operator.write`). A run it reports over settles as it reports; one it reports still going,
   * or does not know, stays as it is. One check at a time per task, and one per set of runs
   * until the next history read, so answers that change nothing ask nothing more.
   */
  private async settleEndedRuns(key: string): Promise<void> {
    const transcript = this.state.transcripts[key];
    const first = transcript && activeRun(transcript);
    if (!first || runningRunId(transcript, first.id) !== null) return;
    if (!this.state.connection.canWrite || this.options.readOnly) return;
    const asked = transcript.runs.filter((run) => run.bound && isActive(run.state));
    const runIds = asked.map((run) => run.id).join("\u0000");
    if (this.endChecking.has(key) || this.endChecked.get(key) === runIds) return;
    this.endChecking.add(key);
    this.endChecked.set(key, runIds);
    const generation = this.generation;
    const incarnation = this.incarnations.get(key);
    try {
      await Promise.all(
        asked.map(async (run) => {
          let answer: RawRecord | null;
          try {
            answer = asRecord(await this.request("agent.wait", { runId: run.id, timeoutMs: 0 }));
          } catch (error) {
            if (generation === this.generation) this.logFailure("warn", "agent.wait", error);
            return;
          }
          if (
            !answer ||
            generation !== this.generation ||
            this.incarnations.get(key) !== incarnation
          )
            return;
          this.updateActivity(key, (activity, ctx) =>
            settleRunFromWait(activity, run.id, answer, ctx),
          );
        }),
      );
    } finally {
      this.endChecking.delete(key);
    }
    // Runs that started while this check was on its way are asked now, unless they are the same set.
    void this.settleEndedRuns(key);
  }

  /**
   * Read the bot's workspace root, as the gateway names it
   * (`agents.files.list`, `operator.read`, its `workspace`), once a task's
   * history loads. A failed read leaves it unknown: an absolute path is then
   * never read as a memory note (8.2).
   */
  private async readWorkspaceRoot(key: string, generation: number): Promise<void> {
    const botId = botIdFromSessionKey(key);
    if (!botId) return;
    const incarnation = this.incarnations.get(key);
    let answer: unknown;
    try {
      answer = await this.request("agents.files.list", { agentId: botId });
    } catch (error) {
      if (generation === this.generation) this.logFailure("warn", "agents.files.list", error);
      return;
    }
    if (
      generation !== this.generation ||
      !this.tracked(key) ||
      this.incarnations.get(key) !== incarnation
    )
      return;
    const root = asRecord(answer)?.workspace;
    const workspaceRoot = typeof root === "string" && root.startsWith("/") ? root : null;
    const current = this.state.transcripts[key];
    if (!current || current.workspaceRoot === workspaceRoot) return;
    this.setTranscript(key, () => ({ ...this.state.transcripts[key]!, workspaceRoot }));
  }

  /**
   * A recipient run a task's sends name that this client follows nowhere: its task was let go
   * while the sender's was not open, or it was never seen. The recipient's own history says
   * where it stands (in flight, or ended as its rows show), and from then on it is followed as
   * a session nobody has open, so the sender's card shows what the gateway established and
   * keeps up with it, rather than reading Sent. One read per recipient session, after each of
   * the sender's history reads, for the newest `MAX_LINKED_RUNS` recipients.
   */
  private async readRecipients(key: string, generation: number): Promise<void> {
    const transcript = this.state.transcripts[key];
    if (!transcript) return;
    const rawOf = (step: Run["steps"][number]) => step.raw ?? this.raw.get(key, step.id);
    const missing = new Map<string, Set<string>>();
    for (const link of recipientLinks(transcript.runs, rawOf).slice(-MAX_LINKED_RUNS)) {
      if (!link.runId || !link.sessionKey) continue;
      const runId = capId(link.runId, MAX_ID_CHARS);
      const sessionKey = capId(link.sessionKey, MAX_ID_CHARS);
      if (transcript.linkedRuns[runId] || this.tracked(sessionKey)) continue;
      if (this.foreign.get(sessionKey)?.runs.some((run) => run.id === runId)) continue;
      missing.set(sessionKey, (missing.get(sessionKey) ?? new Set()).add(runId));
    }
    for (const [sessionKey, ids] of missing) {
      if (generation !== this.generation || !this.tracked(key)) return;
      await this.readRecipientRuns(sessionKey, ids, generation, key);
    }
  }

  private async readRecipientRuns(
    sessionKey: string,
    ids: Set<string>,
    generation: number,
    senderKey?: string,
    terminal: {
      phase: "end" | "error";
      pairs: ReadonlyArray<readonly [string, string]>;
    } | null = null,
  ): Promise<boolean> {
    // True once its read was answered and applied: a read refused, failed or out of date is not.
    // The read carries its own invalidation token: a deletion of this session
    // cancels it, however many deletions of other sessions follow, and nothing
    // else does. Admission stays within the map and per-session caps.
    const token = { cancelled: false };
    let tokens = this.foreignReads.get(sessionKey);
    if (!tokens) {
      if (this.foreignReads.size >= MAX_FOREIGN_READ_SESSIONS) return false;
      tokens = new Set();
      this.foreignReads.set(sessionKey, tokens);
    }
    if (tokens.size >= MAX_FOREIGN_READS_PER_SESSION) return false;
    tokens.add(token);
    try {
      // What this read may settle was active before it was asked, so a run whose
      // live start arrives while the request is pending outlives a stale answer.
      const activeBefore = new Set(
        (this.foreign.get(sessionKey)?.runs ?? [])
          .filter((run) => ids.has(run.id) && !isTerminal(run.state))
          .map((run) => run.id),
      );
      // Quiet ends this read may settle: those that ended before it was asked (#680).
      const quietBefore = quietPending(
        (this.foreign.get(sessionKey)?.runs ?? []).filter((run) => ids.has(run.id)),
      );
      let history: RawRecord | null;
      try {
        history = asRecord(await this.request("chat.history", { sessionKey, limit: 40 }));
      } catch {
        return false;
      }
      if (
        generation !== this.generation ||
        this.tracked(sessionKey) ||
        (senderKey !== undefined && !this.tracked(senderKey)) ||
        // A deletion of this session while the read was on its way supersedes it.
        token.cancelled
      )
        return false;
      // The page's pairs, then those already known, which win: the session's own (retained) and
      // the terminal frame's.
      const aliases: Record<string, string> = {
        ...Object.fromEntries(historyQueuePairs(history?.messages)),
        ...(this.foreign.get(capId(sessionKey, MAX_ID_CHARS))?.queueAliases ?? {}),
        ...Object.fromEntries(terminal?.pairs ?? []),
      };
      const { messages, inFlight } = throughRunAliases(
        history?.messages,
        asRecord(history?.inFlightRun),
        aliases,
      );
      const ctx = { sessionKey, now: this.now(), raw: this.foreignRaw };
      const busy = inFlight !== null || holdsInput(history);
      const found = runsFromHistory(messages, inFlight, ctx, { busy }).filter((run) =>
        ids.has(run.id),
      );
      const historyIds = new Set(found.map((run) => run.id));
      // Ends history does not establish: a busy read leaves the newest rows' run
      // open, and an end history holds only in its rows' shape is never a reply.
      // A terminal row naming such a run must still settle it.
      const inferred = new Set(
        found
          .filter((run) => !run.outcomeKnown || (busy && !isTerminal(run.state)))
          .map((run) => run.id),
      );
      const inFlightId = typeof inFlight?.runId === "string" ? inFlight.runId : null;
      const ended = terminal
        ? new Map([...ids].map((id) => [id, terminal.phase] as const))
        : undefined;
      this.updateForeign(sessionKey, (activity) => {
        // A pair is one run: history under the gateway's id is the run the sender
        // follows under the send's id. Renamed, never dropped: a foreign run keeps
        // no steps, so nothing of a run still under way is lost with it.
        const aliased = (terminal?.pairs ?? []).reduce((next, [gateway, client]) => {
          if (gateway === client || next.queueAliases[gateway] === client) return next;
          const shown = findRun(next, gateway);
          const runs =
            shown && !findRun(next, client)
              ? next.runs.map((run) => (run === shown ? { ...run, id: client } : run))
              : next.runs;
          return { ...next, runs, queueAliases: { ...next.queueAliases, [gateway]: client } };
        }, activity);
        const followed = aliased.runs.filter((run) => ids.has(run.id));
        const merged = mergeHistoryRuns(followed, found, ctx, busy).runs;
        // A row said the run ended, but idle history cannot say how: settle it as
        // vanished rather than leave the card working, unless a turn is in flight.
        const runs = settleVanishedRuns(
          merged,
          activeBefore,
          historyIds,
          inFlightId,
          ctx,
          busy,
          ended,
          inferred,
        );
        // Only what the read holds whole: the others are read on (`settleForeignQuiet`).
        const settled = settleQuietEnds(
          runs.length === merged.length && runs.every((run, i) => run === merged[i])
            ? merged
            : runs,
          coveredRuns(history, quietBefore, (id) => startOf(merged, id), aliases),
        );
        return {
          ...aliased,
          runs: [...aliased.runs.filter((run) => !ids.has(run.id)), ...settled],
        };
      });
      return true;
    } finally {
      tokens.delete(token);
      if (tokens.size === 0 && this.foreignReads.get(sessionKey) === tokens)
        this.foreignReads.delete(sessionKey);
    }
  }

  /**
   * A run of a session nobody has open ended with an end the gateway marked not to show (#680):
   * its history says whether that is a quiet answer. One the read did not settle (refused, failed,
   * or from an earlier connection) stays the failure it was sent as.
   */
  private async settleForeignQuiet(sessionKey: string, ids: Set<string>): Promise<void> {
    const read = await this.readRecipientRuns(sessionKey, ids, this.generation);
    // Those its read didn't hold whole: read on once (`readQuiet`). A read that wasn't answered
    // isn't read on: each stays the failure it was sent as.
    const held = this.foreign.get(sessionKey);
    const left = quietPending((held?.runs ?? []).filter((run) => ids.has(run.id)));
    const quiet =
      read && left.size > 0 && held
        ? await this.readQuiet(sessionKey, left, held.queueAliases, (id) => startOf(held.runs, id))
        : null;
    if (!this.foreign.has(sessionKey)) return;
    this.updateForeign(sessionKey, (activity) => {
      const runs = settleQuietEnds(
        settleQuietEnds(activity.runs, quiet ?? new Set()),
        ids,
        quiet === null ? "unread" : "failed",
      );
      return runs === activity.runs ? activity : { ...activity, runs };
    });
    // The sidebar shows such a task's row by this run (`quietAnswer`).
    this.publishTasks();
  }

  /**
   * One read on, of `QUIET_CHECK_ROWS` rows, for marked ends a read didn't hold whole (#680): the
   * runs among `ids` it holds whole (`historyCoversRun`) with no row that answered nothing. Null
   * when the read failed.
   */
  private async readQuiet(
    sessionKey: string,
    ids: ReadonlySet<string>,
    aliases: Readonly<Record<string, string>>,
    started: (runId: string) => number | null,
  ): Promise<Set<string> | null> {
    let history: RawRecord | null;
    try {
      history = asRecord(
        await this.request("chat.history", {
          sessionKey,
          limit: QUIET_CHECK_ROWS,
          maxChars: QUIET_CHECK_CHARS,
        }),
      );
    } catch {
      return null;
    }
    // The page's own pairs too: a queued run's rows can be under the gateway's id for it.
    // A pair the client already knows wins over one inferred from the page.
    const pairs: Readonly<Record<string, string>> = {
      ...Object.fromEntries(historyQueuePairs(history?.messages)),
      ...aliases,
    };
    return new Set(
      [...coveredRuns(history, ids, started, pairs)].filter((id) =>
        runAliases(id, pairs).every((each) => quietInHistory(history?.messages, each)),
      ),
    );
  }

  /** Copy the state of every recipient run a task's `sessions_send` results name, where it is known. */
  private refreshLinkedRuns(key: string): void {
    const transcript = this.state.transcripts[key];
    if (!transcript) return;
    const rawOf = (step: Run["steps"][number]) => step.raw ?? this.raw.get(key, step.id);
    const links = recipientLinks(transcript.runs, rawOf);
    const known = this.recipients.get(key);
    const cap = (value: string) => capId(value, MAX_ID_CHARS);
    const runs = new Set(links.flatMap((link) => (link.runId ? [cap(link.runId)] : [])));
    const sessions = new Set(
      links.flatMap((link) => (link.sessionKey ? [cap(link.sessionKey)] : [])),
    );
    const grew =
      [...runs].some((id) => !known?.runs.has(id)) ||
      [...sessions].some((id) => !known?.sessions.has(id));
    this.recipients.set(key, { runs, sessions });
    // A send result naming a recipient can place an approval that arrived before it.
    if (grew) this.routeUnrouted();
    // The newest `MAX_LINKED_RUNS` recipients a task's sends name.
    const ids = recipientRunIds(transcript.runs, rawOf).slice(-MAX_LINKED_RUNS);
    const linked: Record<string, LinkedRun> = {};
    for (const id of ids) {
      for (const [sessionKey, activity] of [
        ...this.foreign.entries(),
        ...Object.entries(this.state.transcripts),
      ] as Array<[string, TaskActivity]>) {
        const run = findRun(activity, id);
        if (run) linked[id] = linkedRunOf(run, sessionKey);
      }
    }
    const current = transcript.linkedRuns;
    const same =
      Object.keys(current).length === Object.keys(linked).length &&
      Object.entries(linked).every(
        ([id, run]) =>
          current[id]?.state === run.state &&
          current[id]?.endedAt === run.endedAt &&
          current[id]?.outcomeKnown === run.outcomeKnown,
      );
    if (!same)
      this.setTranscript(key, () => ({ ...this.state.transcripts[key]!, linkedRuns: linked }));
  }

  // Questions -------------------------------------------------------------------

  /**
   * Answer a pending question card with `question.resolve`. `answers` maps
   * each question id to its answers: text as typed, sent as it is, or a shown
   * option named by its original place (`{option: index}`). An option is sent
   * by its identity, the gateway's value for it or else its label, read whole
   * from `question.list` at that place, never matched by the text shown.
   */
  async answerQuestion(
    key: string,
    questionId: string,
    answers: Record<string, QuestionAnswer[]>,
    options: { owner?: object } = {},
  ): Promise<void> {
    const question = this.pendingQuestion(key, questionId);
    const entries = Object.entries(answers);
    if (entries.length === 0) throw new Error("Choose or type an answer.");
    const chosen: Record<string, Array<string | QuestionOption>> = {};
    for (const [id, values] of entries) {
      const item = question.questions.find((each) => each.id === id);
      if (!item) throw new Error(`The card has no question ${id}.`);
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error(`The answer to ${id} is empty.`);
      }
      chosen[id] = values.map((value) => {
        if (typeof value === "string") return value;
        const option = item.options.find((each) => each.index === value?.option);
        if (!option) throw new Error(`The card shows no such option for ${id}.`);
        return option;
      });
    }
    await this.resolveQuestion(key, questionId, options.owner ?? null, async () => ({
      id: questionId,
      answers: { answers: await this.optionAnswers(question, chosen) },
    }));
  }

  /**
   * The strings sent for the chosen answers. Each chosen option is read from
   * `question.list` at its original place and sent as `value ?? label`, as
   * the gateway identifies options; the option there must still be the one
   * shown, or nothing is sent.
   */
  private async optionAnswers(
    question: QuestionCard,
    chosen: Record<string, Array<string | QuestionOption>>,
  ): Promise<Record<string, string[]>> {
    const named = Object.values(chosen).some((values) =>
      values.some((each) => typeof each !== "string"),
    );
    let items: unknown[] = [];
    if (named) {
      const listed = asRecord(await this.request("question.list", {}));
      const record = (Array.isArray(listed?.questions) ? listed.questions : [])
        .map((entry) => asRecord(entry))
        .find(
          (entry) => typeof entry?.id === "string" && capId(entry.id, MAX_ID_CHARS) === question.id,
        );
      if (!record) throw new Error("That question is no longer open.");
      items = Array.isArray(record.questions) ? record.questions : [];
    }
    const out: Record<string, string[]> = {};
    for (const [id, values] of Object.entries(chosen)) {
      out[id] = values.map((each) => {
        if (typeof each === "string") return each;
        const item = asRecord(items.find((entry) => asRecord(entry)?.questionId === id));
        const listed = asRecord((Array.isArray(item?.options) ? item.options : [])[each.index]);
        const label = listed?.label;
        const value = typeof listed?.value === "string" && listed.value ? listed.value : null;
        // The option at that place must still be the one shown, its kept text a prefix of its whole text.
        if (
          typeof label !== "string" ||
          !label.startsWith(each.label) ||
          (value === null) !== (each.value === null) ||
          (value !== null && !value.startsWith(each.value!))
        ) {
          throw new Error("The question changed since it was shown.");
        }
        return value ?? label;
      });
    }
    return out;
  }

  /** Close a question card with its X: the bot is told there is no answer and carries on. */
  async dismissQuestion(
    key: string,
    questionId: string,
    options: { owner?: object } = {},
  ): Promise<void> {
    this.pendingQuestion(key, questionId);
    await this.resolveQuestion(key, questionId, options.owner ?? null, () => ({
      id: questionId,
      cancel: true,
    }));
  }

  private pendingQuestion(key: string, questionId: string) {
    const question = this.state.transcripts[key]?.questions.find((each) => each.id === questionId);
    if (!question || question.status !== "pending")
      throw new Error("That question is no longer open.");
    if (question.submitting) throw new Error("An answer to that question is already on its way.");
    return question;
  }

  /**
   * Send an answer or dismissal. The card is marked as being answered before
   * anything is awaited, so a second answer is refused at once; what is sent
   * is built after access is held, and the card is checked again just before.
   */
  private async resolveQuestion(
    key: string,
    questionId: string,
    owner: object | null,
    build: () => RawRecord | Promise<RawRecord>,
  ): Promise<void> {
    this.updateActivity(key, (activity) =>
      markQuestion(activity, questionId, { submitting: true, error: null }),
    );
    try {
      await this.ensureScope(QUESTIONS_SCOPE, owner);
      const params = await build();
      this.checkNotWithdrawn(owner);
      const now = this.state.transcripts[key]?.questions.find((each) => each.id === questionId);
      if (!now || now.status !== "pending") throw new Error("That question is no longer open.");
      this.updateActivity(key, (activity) =>
        markQuestion(activity, questionId, {
          submitting: true,
          error: null,
          sent: { method: "question.resolve", params },
        }),
      );
      const reply = await this.request("question.resolve", params);
      const result = asRecord(reply);
      // Apply the answer at once; `question.resolved` repeats it. The reply is kept as sent.
      this.updateActivity(key, (activity) =>
        applyQuestionResolved(
          activity,
          {
            id: questionId,
            status: result?.status ?? ("cancel" in params ? "cancelled" : "answered"),
            ...(result?.answers ? { answers: result.answers } : {}),
          },
          { via: "question.resolve", record: reply },
        ),
      );
    } catch (error) {
      this.updateActivity(key, (activity) =>
        markQuestion(activity, questionId, { submitting: false, error: errorMessage(error) }),
      );
      this.noteMissingScope(error);
      throw error;
    }
  }

  /**
   * Pending questions for one task, from `question.list`, after it reloads.
   * Fenced like the approval lists: a response older than one applied, or
   * from an earlier opening or connection, changes nothing.
   */
  private async backfillQuestions(key: string, generation: number): Promise<void> {
    if (!this.holds(QUESTIONS_SCOPE)) return;
    const incarnation = this.incarnations.get(key);
    const listKey = `${key}\u0000question`;
    const revision = (this.listRequested.get(listKey) ?? 0) + 1;
    this.listRequested.set(listKey, revision);
    const stale = () =>
      generation !== this.generation ||
      !this.tracked(key) ||
      this.incarnations.get(key) !== incarnation ||
      (this.listApplied.get(listKey) ?? 0) > revision;
    const before = this.state.transcripts[key];
    const pendingBefore = new Set([
      ...(before?.questions ?? [])
        .filter((question) => question.status === "pending")
        .map((question) => question.id),
      ...(before ? questionMarkers(before) : []),
    ]);
    try {
      const result = asRecord(await this.request("question.list", {}));
      if (stale()) return;
      this.listApplied.set(listKey, revision);
      const records = (Array.isArray(result?.questions) ? result.questions : [])
        .map((entry) => asRecord(entry))
        .filter(
          (record): record is RawRecord =>
            record?.sessionKey === key && record.status === "pending",
        );
      this.updateActivity(key, (activity, ctx) => {
        let next = activity;
        for (const record of records) next = applyQuestionRequested(next, record, ctx);
        return settleMissingQuestions(
          next,
          new Set(records.map((record) => String(record.id))),
          pendingBefore,
        );
      });
    } catch (error) {
      if (!stale()) {
        this.listApplied.set(listKey, revision);
        this.noteMissingScope(error);
      }
      this.logFailure("warn", "question.list", error);
    }
  }

  /**
   * The whole text an approval asks the reviewer to decide on, read again from
   * the gateway's list and returned without being kept, with the digest an
   * allow of a cut approval must name (`resolveApproval`'s `shownDigest`).
   */
  async readApprovalText(
    key: string,
    approvalId: string,
    options: { owner?: object; maxChars?: number } = {},
  ): Promise<{ text: Record<string, string | string[] | null>; digest: string }> {
    const approval = this.state.transcripts[key]?.approvals.find((each) => each.id === approvalId);
    if (!approval) throw new Error("That approval is not in this task.");
    const source = APPROVAL_SOURCES.find((each) => each.kind === approval.kind)!;
    // A whole read like the others: it shares their gate, so viewers cannot hold many lists at once.
    const value = await this.wholeRead(() => this.request(source.method, {}));
    const record = asRecord(value);
    const items = Array.isArray(value)
      ? value
      : Array.isArray(record?.approvals)
        ? record.approvals
        : Array.isArray(record?.items)
          ? record.items
          : [];
    const whole = items
      .map((item) => source.parse(item))
      .find((card) => card !== null && capId(card.id, MAX_ID_CHARS) === approvalId);
    if (!whole) throw new Error("The gateway no longer lists that approval.");
    const shown = this.state.transcripts[key]?.approvals.find((each) => each.id === approvalId);
    if (!shown || whole.decisionDigest !== shown.decisionDigest) {
      throw new Error("The approval changed since it was shown; reopen the task.");
    }
    const read = { text: decisionText(whole), digest: whole.decisionDigest };
    // Recorded only once it can be given to the viewer whole: a read its channel cannot carry
    // leaves the approval deny-only for that viewer.
    if (options.maxChars !== undefined && jsonLength(read) > options.maxChars) {
      throw new Error(
        "This approval's whole text is too long to show here; deny it, or read it in the desktop app.",
      );
    }
    this.noteApprovalRead(key, approvalId, options.owner ?? DIRECT_CALLER, read.digest);
    return read;
  }

  /**
   * The gateway writes a system event it wakes a task with as its own user row's text
   * (`mapHistory`'s `gatewayEvents`): OpenClaw 2026.11.10, by its reported version.
   */
  private writesEvents(): boolean {
    return openClawAtLeast(this.state.connection.serverVersion, 2026, 11, 10);
  }

  /**
   * The gateway marks its skill notes (`mapHistory`'s `skillNotesMarked`): OpenClaw 2026.11.10, by
   * its reported version. An unmarked row of the note's form is then a bot's, never the note.
   */
  private marksSkillNotes(): boolean {
    return openClawAtLeast(this.state.connection.serverVersion, 2026, 11, 10);
  }

  /**
   * A history item whole, as the gateway has it now, returned without being
   * kept: the way to read text cut to its bound (`TranscriptItem.cut`).
   */
  async readHistoryItem(key: string, itemId: string): Promise<TranscriptItem | null> {
    if (!this.state.transcripts[key]) return null;
    // The length needed is not known here: the most the gateway gives. An item it still cut says so.
    const history = await this.readHistoryWhole(key, MAX_HISTORY_READ_CHARS);
    return (
      mapHistory(history?.messages, {
        startedAt: startedTaskSince(history),
        gatewayEvents: this.writesEvents(),
        skillNotesMarked: this.marksSkillNotes(),
      }).find((item) => item.id === itemId) ?? null
    );
  }

  /**
   * A history page read for a whole value, at most `MAX_FULL_READS` at once,
   * asking the gateway for text up to `maxChars` (it cuts to 8,000 otherwise).
   */
  private async readHistoryWhole(key: string, maxChars: number): Promise<RawRecord | null> {
    return asRecord(
      await this.wholeRead(() =>
        this.request("chat.history", { sessionKey: key, limit: HISTORY_LIMIT, maxChars }),
      ),
    );
  }

  /** One whole read (history or an approval list), at most `MAX_FULL_READS` at once; past it, refused. */
  private async wholeRead<T>(read: () => Promise<T>): Promise<T> {
    if (this.fullReads >= MAX_FULL_READS)
      throw new Error("Other whole texts are being read; try again in a moment.");
    this.fullReads += 1;
    try {
      return await read();
    } finally {
      this.fullReads -= 1;
    }
  }

  // Routines (`routines.ts`; automation.md sections 3 to 8), all at the read tier ----------

  /** Read the routine list and the scheduler's state again. */
  refreshRoutines(): Promise<void> {
    if (this.state.connection.status !== "connected") return Promise.resolve();
    return this.routines.load();
  }

  /** One bot's routines, for a list that keeps fewer than the gateway has; returned, not kept. */
  readBotRoutines(botId: string): Promise<BotRoutines> {
    return this.routines.botRoutines(botId);
  }

  /** A routine's runs, newest finished first, at most `MAX_ROUTINE_RUNS`; returned, not kept. */
  readRoutineRuns(id: string): Promise<RoutineRun[]> {
    return this.routines.runs(id);
  }

  /** Every routine's runs that started from `from` to `to`, for the calendar; returned, not kept. */
  readCalendarRuns(from: number, to: number): Promise<CalendarRuns> {
    return this.routines.calendarRuns(from, to);
  }

  /** One run's conversation, when the gateway keeps it; returned, not kept. */
  readRunConversation(id: string, run: RunSelector): Promise<RunConversation> {
    return this.routines.conversation(id, run);
  }

  // Changing routines (automation.md sections 9 and 10): `operator.admin`, checked by the engine.

  /** A new routine; `key` is its draft's, the same for every try of that draft. */
  createRoutine(
    input: NewRoutine,
    key: string,
    owner: object | null = null,
    stamp?: GatewayStamp,
  ): Promise<RoutineWrite> {
    return this.routines.create(input, key, owner, stamp);
  }

  /** One routine as the gateway has it now. */
  readRoutine(id: string, stamp?: GatewayStamp): Promise<Routine | null> {
    return this.routines.readOne(id, stamp);
  }

  /** What the gateway shows of a create whose answer never came, by its draft's key. */
  checkRoutineCreate(
    key: string,
    input: RoutineFields,
    stamp: GatewayStamp,
  ): Promise<RoutineSaveCheck> {
    return this.routines.checkCreate(key, input, stamp);
  }

  /** What the gateway shows of an edit whose answer never came. */
  checkRoutineUpdate(
    id: string,
    sent: { original: RoutineFields; edit: RoutineFields; expected: RoutineFields },
    stamp: GatewayStamp,
  ): Promise<RoutineSaveCheck> {
    return this.routines.checkUpdate(id, sent, stamp);
  }

  updateRoutine(
    id: string,
    original: RoutineFields,
    edit: RoutineFields,
    expected: RoutineRevision,
    owner: object | null = null,
    stamp?: GatewayStamp,
  ): Promise<RoutineWrite> {
    if (jsonTextLength(id) > MAX_ID_CHARS)
      return Promise.resolve({ status: "refused", error: "That routine id is too long." });
    return this.routines.update(id, original, edit, expected, owner, stamp);
  }

  setRoutineEnabled(
    id: string,
    enabled: boolean,
    owner: object | null = null,
    listedOn?: number,
    stamp?: GatewayStamp,
  ): Promise<RoutineWrite> {
    return this.routines.setEnabled(id, enabled, owner, listedOn, stamp);
  }

  runRoutineNow(
    id: string,
    owner: object | null = null,
    listedOn?: number,
    stamp?: GatewayStamp,
  ): Promise<RoutineRunNow> {
    return this.routines.runNow(id, owner, listedOn, stamp);
  }

  removeRoutine(
    id: string,
    owner: object | null = null,
    listedOn?: number,
    stamp?: GatewayStamp,
  ): Promise<RoutineRemove> {
    return this.routines.remove(id, owner, listedOn, stamp);
  }

  /** The gateway's inbound hooks, read with admin; null below it. */
  readGatewayHooks(): Promise<GatewayHooks | null> {
    return this.routines.hooks();
  }

  // Provider accounts (`accounts.ts`, `accounts-engine.ts`; bots.md sections 3 to 11) ----------

  /** Read the accounts, sign-ins, bindings and catalogue the account screens show. */
  refreshAccounts(): Promise<void> {
    if (this.state.connection.status !== "connected") return Promise.resolve();
    return this.accounts.load();
  }

  /** Read one provider's full list for "View more"; the answer is kept nowhere. */
  loadModelCatalog(provider: string): Promise<ModelList> {
    // The gateway's words go to the screen with no credential this client holds.
    return this.accounts
      .readModelList(provider)
      .then((list) =>
        list.status === "ready" ? list : { ...list, error: this.scrub(list.error) },
      );
  }

  /** Refresh in the Model menu: ask the gateway to look for a provider's models again (#565). */
  refreshModels(provider: string, stamp: GatewayStamp): Promise<ModelRefresh> {
    if (this.state.connection.status !== "connected")
      return Promise.reject(new Error("Not connected to a gateway."));
    return this.accounts
      .refreshModels(provider, stamp)
      .then((found) =>
        found.status === "error" ? { ...found, error: this.scrub(found.error) } : found,
      );
  }

  /** Read one bot's stored order and model again: the lock's evidence. */
  checkLock(botId: string): Promise<void> {
    if (this.state.connection.status !== "connected") return Promise.resolve();
    return this.accounts.checkLock(botId);
  }

  startSignIn(methodId: string, botId: string | null): Promise<void> {
    return this.accounts.startSignIn(methodId, botId);
  }

  /** A code or address pasted back, or a company address: sent once, kept nowhere. */
  answerSignIn(value: string): Promise<void> {
    return this.accounts.answerSignIn(value);
  }

  /** Cancel the sign-in under way; `cancelled` only when the gateway confirmed it. */
  cancelSignIn(): Promise<{ cancelled: boolean }> {
    return this.accounts.cancelSignIn();
  }

  /** Let go of a sign-in that has ended; one under way is kept unless the gateway confirms its cancel. */
  dismissSignIn(): Promise<{ dismissed: boolean }> {
    return this.accounts.dismissSignIn();
  }

  /** Read again where a finished sign-in's account landed, after that read failed. */
  recheckSignIn(): Promise<void> {
    return this.accounts.recheckSignIn();
  }

  /** Which of several new accounts is the sign-in's, as the person chose. */
  chooseSignInAccount(profileId: string): Promise<void> {
    return this.accounts.chooseSignInAccount(profileId);
  }

  /** An API key the person typed: sent once to the gateway, kept nowhere. */
  /**
   * With `stamp` (where Connect was opened), the key is sent only while the host still has that
   * target and that gateway connected: a key is a credential, and goes nowhere else.
   */
  async saveApiKey(
    provider: string,
    key: string,
    botId: string | null,
    stamp?: GatewayStamp,
  ): Promise<{ profileId: string | null }> {
    if (stamp !== undefined) await this.requireSameGateway(stamp);
    return this.accounts.saveKey(provider, key, botId);
  }

  setAccountLabel(profileId: string, label: string): Promise<void> {
    return this.accounts.setLabel(profileId, label);
  }

  /** With `stamp` (where the confirmation was opened), as for `saveApiKey`. */
  async disconnectAccount(profileId: string, stamp?: GatewayStamp): Promise<void> {
    if (stamp !== undefined) await this.requireSameGateway(stamp);
    return this.accounts.disconnect(profileId);
  }

  /**
   * Create a bot. With `stamp` (where the person's screen was read), nothing is sent unless the
   * host still has that target and that gateway connected.
   */
  async createBot(input: CreateBotInput, stamp?: GatewayStamp): Promise<CreatedBot> {
    const bound = stamp === undefined ? undefined : await this.requireSameGateway(stamp);
    // The connection the bot is made on: its guides go there or nowhere.
    const protocol = this.protocol;
    const epoch = this.epoch;
    const target = this.target;
    // Checked there: both known and current. The whole write stays bound to them.
    const created = await this.accounts.createBot(input, bound);
    const gatewayId = bound?.gatewayId ?? this.state.connection.gatewayId;
    const request = (method: string, params: unknown) =>
      protocol && this.protocol === protocol && this.epoch === epoch && this.target === target
        ? this.request(method, params)
        : Promise.reject(new Error(CONNECTION_CHANGED));
    // A bot made in Clawtrate gets the guides right away, as every bot does, on the connection it
    // was made on, once the gateway is known to be the one it was made on. It never fails the
    // creation.
    if (gatewayId !== null && (await this.routeIdentityHolds(gatewayId)) && this.guidesWritable())
      await this.guidesByThemselves(request, created.botId).catch((error: unknown) =>
        this.logFailure("warn", "guides for a new bot", error),
      );
    return created;
  }

  /**
   * Finish a bot whose creation is partial, by its id: what is missing, never a second bot. With
   * `stamp`, as for `createBot`, nothing is sent unless it is still the gateway connected.
   */
  async finishBot(botId: string, stamp?: GatewayStamp): Promise<CreatedBot> {
    if (stamp === undefined) return this.accounts.finishBot(botId);
    return this.accounts.finishBot(botId, await this.requireSameGateway(stamp));
  }

  dismissBotCreation(): void {
    this.accounts.dismissCreation();
  }

  /**
   * With `stamp` (where the bot's settings were read), nothing is sent unless the host still has
   * that target and that gateway connected, and each request checks the target again.
   */
  async changeBotAccount(
    botId: string,
    account: string | null,
    provider: string,
    model: string,
    effort: string | null,
    stamp?: GatewayStamp,
  ): Promise<void> {
    if (stamp === undefined)
      return this.accounts.changeAccount(botId, account, provider, model, effort);
    await this.requireSameGateway(stamp);
    return this.accounts.changeAccount(
      botId,
      account,
      provider,
      model,
      effort,
      this.sameConnection(stamp),
    );
  }

  /** With `stamp`, as for `changeBotAccount`. */
  async setBotModel(
    botId: string,
    model: string,
    effort: string | null,
    stamp?: GatewayStamp,
  ): Promise<void> {
    if (stamp === undefined) return this.accounts.setModel(botId, model, effort);
    await this.requireSameGateway(stamp);
    return this.accounts.setModel(botId, model, effort, this.sameConnection(stamp));
  }

  /** With `stamp`, as for `changeBotAccount`. */
  async removeBotFallbacks(botId: string, stamp?: GatewayStamp): Promise<void> {
    if (stamp === undefined) return this.accounts.removeFallbacks(botId);
    await this.requireSameGateway(stamp);
    return this.accounts.removeFallbacks(botId, this.sameConnection(stamp));
  }

  /**
   * Unlock, or Clear a kept order, after its confirmation (#660): only to the gateway the screen
   * showed (`stamp`), each request on the connection that check read, and only while the bot's
   * order still names `account` alone (`AccountsEngine.clearOrder`).
   */
  async clearBotOrder(
    id: string,
    botId: string,
    provider: string,
    account: string,
    kind: OrderClear["kind"],
    stamp: GatewayStamp,
  ): Promise<void> {
    if (this.options.readOnly) throw new Error("This host only reads.");
    await this.requireSameGateway(stamp);
    return this.accounts.clearOrder(id, botId, provider, account, kind, this.sameConnection(stamp));
  }

  /**
   * Rename on a name card: `name` and `gatewayId` must be the ones it shows (`bot-names.ts`).
   * Nothing is sent unless that gateway is still the one connected.
   */
  acceptBotName(botId: string, name: string, stamp: GatewayStamp): Promise<void> {
    if (this.options.readOnly) return Promise.reject(new Error("This host only reads."));
    return this.botNames.accept(botId, name, stamp);
  }

  /**
   * Update OpenClaw (#565): the person's press, after the confirmation. One `update.run`, only to
   * the gateway the screen showed (`stamp`), and only while it reports a newer OpenClaw.
   */
  startOpenClawUpdate(stamp: GatewayStamp): Promise<void> {
    if (this.options.readOnly) return Promise.reject(new Error("This host only reads."));
    return this.openclawUpdates.start(stamp);
  }

  /** Put away a finished update's line. Nothing is sent. */
  dismissOpenClawUpdate(): Promise<void> {
    return this.openclawUpdates.dismiss();
  }

  /**
   * Ask the gateway where updating stands (`update.status`): when Settings › Updates or the
   * confirmation opens, and on Check again. Only reads.
   */
  checkOpenClawUpdate(): Promise<void> {
    return this.openclawUpdates.look();
  }

  /** Stop waiting on a press whose answer was lost, once asking the gateway has failed. */
  releaseOpenClawUpdateHold(): Promise<void> {
    return this.openclawUpdates.release();
  }

  // Approving a waiting device (`device-approval.ts`, setup-effortless.md §5) ---------------

  /** The gateway's waiting devices, read again, and whether a list that new was applied. */
  readDeviceRequests(): Promise<DeviceListRead> {
    return this.deviceApprovals.readNow();
  }

  /** A window takes the one request the host opens by itself: true for the first that asks. */
  takeDevicePrompt(requestId: string): boolean {
    return this.deviceApprovals.takePrompt(requestId);
  }

  /**
   * The person picked `code` on the sheet that showed `scopes`, read on connection `listedOn`
   * (`deviceRequests.listedOn`) of the gateway of `stamp`.
   */
  async approveDevice(
    requestId: string,
    code: string,
    scopes: readonly string[],
    listedOn: number,
    stamp: GatewayStamp,
  ): Promise<DeviceDecision> {
    await this.requireSameGateway(stamp);
    return this.deviceApprovals.approve(requestId, code, scopes, listedOn);
  }

  /** "I didn't start this" denies the request; "None of these match" sends nothing. */
  async refuseDevice(
    requestId: string,
    why: "not-mine" | "none-match",
    listedOn: number,
    stamp: GatewayStamp,
  ): Promise<DeviceDecision> {
    await this.requireSameGateway(stamp);
    return this.deviceApprovals.refuse(requestId, why, listedOn);
  }

  /** Not now on a name card: kept on this device for that bot and that name. */
  /** Not now, with whether it answered the card shown now. */
  async declineBotName(
    botId: string,
    name: string,
    stamp: GatewayStamp,
  ): Promise<{ declined: boolean }> {
    return { declined: await this.botNames.decline(botId, name, stamp) };
  }

  /** A new picture for a bot: a creature with its choice inside, or the person's own (`avatar.ts`). */
  async setBotPicture(
    botId: string,
    avatar: string,
    stamp?: GatewayStamp,
  ): Promise<{ confirmed: boolean }> {
    if (stamp === undefined) return this.accounts.setBotPicture(botId, avatar);
    return this.accounts.setBotPicture(botId, avatar, await this.requireSameGateway(stamp));
  }

  /**
   * A setting's later steps, after `requireSameGateway`: each is sent only on the connection that
   * guard read, while the host keeps the stamp's target. Once a write has gone, the refusal says
   * the change is unconfirmed, not unsent.
   */
  private sameConnection(stamp: GatewayStamp): (sent: boolean) => void {
    const epoch = this.epoch;
    return (sent) => {
      if (this.target !== stamp.target || this.epoch !== epoch)
        throw new Error(sent ? CONNECTION_CHANGED_AFTER_SEND : CONNECTION_CHANGED);
    };
  }

  /** Refuse a write whose screen was read before the host was last pointed at a gateway anew. */
  private requireSameTarget(stamp: GatewayStamp): void {
    if (this.target !== stamp.target) throw new Error(CONNECTION_CHANGED);
  }

  /**
   * Refuse a change unless it was made for the gateway connected now. The screen's read was
   * stamped (`GatewayStamp`): the host must still have the target it had then, so no Connect,
   * Disconnect, switch or new pairing came between that read and now, and the gateway's
   * identity must be known on both sides and equal, read on one connection that is still the
   * one open. A missing identity on either side is a refusal, never a match. The answer is the
   * write's binding: a write that dispatches later checks the target again before it sends.
   */
  private async requireSameGateway(
    stamp: GatewayStamp,
  ): Promise<{ gatewayId: string; target: number }> {
    const protocol = this.protocol;
    const epoch = this.epoch;
    const alive = () =>
      protocol !== null &&
      this.protocol === protocol &&
      this.epoch === epoch &&
      this.state.connection.status === "connected" &&
      this.target === stamp.target;
    this.requireSameTarget(stamp);
    if (!alive()) throw new Error("Not connected to the gateway.");
    const gatewayId = stamp.gatewayId;
    if (gatewayId === null) throw new Error(UNNAMED_GATEWAY);
    const here = await this.readGatewayIdentity();
    // A bot command can be the first to identify this connection after discovery got no ID.
    this.confirmGatewayIdentity(here, alive);
    if (!alive()) throw new Error(CONNECTION_CHANGED);
    // An identity that wasn't read never matches, but it isn't known to be another gateway's.
    if (here === null) throw new Error(IDENTITY_UNREAD);
    if (here !== gatewayId) throw new Error(ANOTHER_GATEWAY);
    return { gatewayId, target: stamp.target };
  }

  // Check-ins (`check-ins.ts`; automation.md section 13) ---------------------------------------

  private checkInsContext(owner?: object | null): CheckInsContext {
    return {
      link: () => {
        const protocol = this.protocol;
        const epoch = this.epoch;
        const alive = () =>
          protocol !== null &&
          this.protocol === protocol &&
          this.epoch === epoch &&
          this.state.connection.status === "connected";
        return {
          alive,
          request: (method, params, options) =>
            protocol && alive()
              ? protocol.request(method, params, options)
              : Promise.reject(new NotSentError()),
        };
      },
      gateway: () => this.readGatewayIdentity(),
      target: () => this.target,
      begin: () => {
        const mine = (this.checkInReads += 1);
        return () => mine === this.checkInReads;
      },
      get: () => this.state.checkIns,
      set: (checkIns) => this.store.update((state) => ({ ...state, checkIns })),
      botIds: () => this.state.bots.map((bot) => bot.id),
      admin: () => this.holds(ADMIN_SCOPE) && this.state.connection.scopes.includes(ADMIN_SCOPE),
      checkNotWithdrawn: () => this.checkNotWithdrawn(owner),
      now: () => this.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
  }

  /** Read the bots' check-ins: their heartbeat jobs, the scheduler and their own settings. */
  refreshCheckIns(botId?: string): Promise<CheckInRead | null> {
    if (this.state.connection.status !== "connected") return Promise.resolve(null);
    return loadCheckIns(this.checkInsContext(), botId);
  }

  /** Save one bot's check-ins; the outcome is `checkIns.save` with this `saveId`. */
  async saveCheckIn(
    saveId: string,
    botId: string,
    draft: CheckInDraft,
    owner?: object | null,
  ): Promise<void> {
    if (!this.state.connection.canAdmin) throw new AdminNeededError("Changing check-ins");
    await this.requireSameGateway(draft.stamp);
    return saveCheckIn(this.checkInsContext(owner), saveId, botId, draft);
  }

  dismissCheckInSave(saveId: string): void {
    dismissCheckInSave(this.checkInsContext(), saveId);
  }

  // Where a bot runs and Machines (`machines.ts`; controls.md sections 14 and 15) ----------

  /** One part of a bot's placement: its command machine, workspace, browser, inventory or plugin credentials, read now. */
  readPlacement<P extends PlacementPart>(botId: string, part: P): Promise<PlacementParts[P]> {
    return this.machines.readPlacement(botId, part);
  }

  /** The gateway's machines, their approvals files (admin) and paired devices (pairing), read now. */
  readMachines(): Promise<MachinesView> {
    return this.machines.readMachines();
  }

  setCommandMachine(
    botId: string,
    target: { host: "gateway" } | { host: "node"; nodeId: string },
    baseHash: string | null,
  ): Promise<ConfigSave> {
    return this.machines.setCommandMachine(botId, target, baseHash);
  }

  async setBotWorkspace(
    botId: string,
    path: string,
  ): Promise<{ workspace: string | null; asTyped: boolean }> {
    // The bot list carries no workspace: nothing else is read, so no late list can replace a newer one.
    return this.machines.setWorkspace(botId, path);
  }

  /** `owner` names the viewer that asked: once it is withdrawn, the write read first is not sent. */
  setMachineDefaults(
    machineId: string,
    choice: DefaultsChoice,
    expectedHash: string | null,
    options: { owner?: object } = {},
  ): Promise<ApprovalsFile> {
    return this.machines.setMachineDefaults(machineId, choice, expectedHash, () =>
      this.checkNotWithdrawn(options.owner),
    );
  }

  renameMachine(nodeId: string, name: string): Promise<void> {
    return this.machines.renameMachine(nodeId, name);
  }

  /**
   * Unpair a node. With `stamp` (where Machines was read), nothing is sent unless the host still
   * has that target and that gateway connected: a restored copy has the same node ids.
   */
  async removeMachine(nodeId: string, stamp?: GatewayStamp): Promise<void> {
    if (stamp === undefined) return this.machines.removeMachine(nodeId);
    // One request, sent in the same turn as the guard's last check.
    await this.requireSameGateway(stamp);
    return this.machines.removeMachine(nodeId);
  }

  renameDevice(deviceId: string, name: string, options: { owner?: object } = {}): Promise<void> {
    return this.machines.renameDevice(deviceId, name, () => this.checkNotWithdrawn(options.owner));
  }

  /** Unpair a device. With `stamp`, as for `removeMachine`. */
  async removeDevice(deviceId: string, stamp?: GatewayStamp): Promise<void> {
    if (stamp === undefined) return this.machines.removeDevice(deviceId);
    await this.requireSameGateway(stamp);
    return this.machines.removeDevice(deviceId);
  }

  // Deleting a bot (`bot-delete.ts`) ------------------------------------------------------

  /**
   * What the delete dialog lists for a bot, from `agents.list`, read now, with the identity of
   * the gateway it was read from. A gateway that names none is not offered a delete.
   */
  async readBotDelete(botId: string): Promise<BotDeleteRead> {
    const link = this.deleteLink();
    const target = this.target;
    if (!link.alive()) throw new Error("Not connected to the gateway.");
    const gatewayId = await this.readGatewayIdentity();
    this.confirmGatewayIdentity(gatewayId, link.alive);
    if (!link.alive()) throw new Error("The connection changed while reading. Read again.");
    if (gatewayId === null)
      throw new Error(
        "The gateway hasn't said which gateway it is, so Clawtrate can't delete from it.",
      );
    return readBotDelete(this.botDeleteContext(link, { gatewayId, target }), botId);
  }

  /**
   * Delete a bot (admin), with what the gateway answered and the bot list read after it. Sent
   * only to the gateway the dialog read, on the target it was read on (`requireSameGateway`), and
   * the reads before and after it go over the same connection. One delete per gateway and bot at a time, whichever viewer asks.
   */
  async deleteBot(
    request: DeleteRequest,
    options: { owner?: object } = {},
  ): Promise<BotDeleteOutcome> {
    // Every refusal before the send is an outcome, never a rejection: a viewer that sees a
    // rejection can't tell it from a reply lost on the way, and treats it as unconfirmed.
    const notSent = (message: string): BotDeleteOutcome => ({ kind: "not-sent", message });
    // Ids are checked whole, never cut, by their JSON length, before anything is kept for them.
    if (
      jsonTextLength(request.botId) > MAX_ID_CHARS ||
      jsonTextLength(String(request.stamp.gatewayId)) > MAX_ID_CHARS
    )
      return notSent("This delete names a bot or gateway Clawtrate can't take. Nothing was sent.");
    const key = deleteKey(String(request.stamp.gatewayId), request.botId);
    if (this.botDeletes.has(key))
      return notSent(
        "This bot is already being deleted from another window. Nothing more was sent.",
      );
    if (this.botDeletes.size >= MAX_BOT_DELETES)
      return notSent("Too many deletes are under way. Nothing was sent; try again in a moment.");
    this.botDeletes.add(key);
    try {
      const link = this.deleteLink();
      let bound: { gatewayId: string; target: number };
      try {
        bound = await this.requireSameGateway(request.stamp);
      } catch (error) {
        return notSent(errorMessage(error));
      }
      if (!link.alive()) return notSent("The connection changed before the delete was sent.");
      return await deleteBot(this.botDeleteContext(link, bound, options.owner), request);
    } finally {
      this.botDeletes.delete(key);
    }
  }

  /**
   * The connection open now, on the target set now: its requests are refused once it closes,
   * another replaces it or the host is pointed at a gateway anew.
   */
  private deleteLink(): {
    alive: () => boolean;
    request: (method: string, params: unknown) => Promise<unknown>;
  } {
    const protocol = this.protocol;
    const epoch = this.epoch;
    const target = this.target;
    const alive = () =>
      protocol !== null &&
      this.protocol === protocol &&
      this.epoch === epoch &&
      this.target === target &&
      this.state.connection.status === "connected";
    return {
      alive,
      request: (method, params) =>
        protocol && alive() ? protocol.request(method, params) : Promise.reject(new NotSentError()),
    };
  }

  /**
   * One connection's reads for a delete. A read is shown as the bot list only when it is whole
   * and no newer read has been shown; one that isn't current decides nothing either.
   */
  private botDeleteContext(
    link: ReturnType<ClawtrateClient["deleteLink"]>,
    stamp: { gatewayId: string; target: number },
    owner?: object,
  ): BotDeleteContext {
    // The bot each listed task is under as the delete is sent: the read of the bots that drops the
    // deleted bot's rows can land before the gateway's answer to the delete.
    const listedUnder = new Map<string, string>();
    /** A task listed under a bot as the delete was sent goes by it; any other by `unlisted`. */
    const botOf = (task: string, unlisted: string | null) =>
      listedUnder.get(capId(task, MAX_ID_CHARS)) ?? unlisted;
    return {
      stamp,
      wanted: () => !(owner && this.withdrawnOwners.has(owner)),
      request: link.request,
      readBots: async () => {
        const issued = ++this.botsIssued;
        const result = await link.request("agents.list", {});
        const shown = wholeRoster(result) && link.alive() && this.newestBots(issued);
        if (shown) this.applyBots(result);
        // Asked again whenever it matters: a newer list shown since, or another connection, ends it.
        return { result, current: () => shown && link.alive() && this.botsShown === issued };
      },
      sending: () => {
        listedUnder.clear();
        for (const key of this.rows.keys()) {
          const bot = this.taskBot(key);
          if (bot !== null) listedUnder.set(key, bot);
        }
      },
      // The one evidence that the bot is gone, acted on as it arrives, whatever follows.
      deleted: (botId) => {
        const deleted = capId(botId, MAX_ID_CHARS);
        this.dropQueuedFor((key) => botOf(key, botIdFromSessionKey(key)) === deleted);
        // The gateway deleted the bot with its tasks and reports no removal for each task: the
        // pictures you sent in them go now. A task not listed goes by the bot noted when sent.
        this.dropDeletedPictures(({ task, bot }) => botOf(task, bot) === deleted);
      },
      admin: () =>
        this.options.readOnly !== true &&
        this.holds(ADMIN_SCOPE) &&
        this.state.connection.scopes.includes(ADMIN_SCOPE),
    };
  }

  /**
   * The gateway answered that it deleted the bot: its tasks' queued and held messages in this
   * host never go. Once, on that answer alone; the bot leaves the rail as any list change does.
   */
  private dropQueuedFor(deleted: (key: string) => boolean): void {
    const keys = Object.keys(this.state.transcripts).filter(deleted);
    for (const key of keys) {
      this.cancelAllQueued(key);
      this.updateActivity(key, (activity) => {
        let next = activity;
        for (const message of activity.outbox) {
          // Held, promoted from the queue but not yet out (as when a run ends in the same batch
          // as this answer), or still waiting for write access: it never leaves.
          const unsent =
            message.status === "held" ||
            (message.status === "sending" && message.leftAt == null) ||
            message.status === "awaiting-access";
          if (!unsent) continue;
          this.dropAttachments(message.id);
          next = updateMessage(next, message.id, { status: "cancelled" });
          // Every message cancelled here takes the local run it started, if the gateway never
          // named it, so no run is left showing as active.
          if (message.mode !== "steer" && findRun(next, message.id))
            next = dropUnboundRun(next, message.id);
        }
        return next;
      });
    }
  }

  /** Read the bot list again, after a bot was created or changed here. */
  private async refreshBots(): Promise<void> {
    const generation = this.generation;
    const issued = ++this.botsIssued;
    const result = await this.request("agents.list", {});
    if (generation !== this.generation || !this.newestBots(issued)) return;
    this.applyBots(result);
  }

  /**
   * Read the bot list again after the gateway reports its config changed: at most
   * one read in flight and one more queued for any burst of signals.
   */
  private async refreshBotsOnChange(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    const running = this.botsRefresh;
    if (running && running.generation === generation) {
      running.again = true;
      return;
    }
    const read = { generation, again: false };
    this.botsRefresh = read;
    try {
      do {
        read.again = false;
        const issued = ++this.botsIssued;
        try {
          const result = await this.request("agents.list", {});
          if (generation !== this.generation || !this.newestBots(issued)) continue;
          this.applyBots(result);
        } catch (error) {
          if (generation === this.generation) this.logFailure("warn", "agents.list", error);
        }
      } while (read.again && generation === this.generation && this.botsRefresh === read);
    } finally {
      if (this.botsRefresh === read) this.botsRefresh = null;
    }
  }

  /**
   * Publish the bot list. A whole roster also says which bots this connection no longer sees,
   * shown or not: their cached task rows go. Their unsent messages stay, since the gateway can
   * hide a bot it still has; only its answer to a delete cancels them (`dropQueuedFor`).
   */
  private applyBots(result: unknown): void {
    const shownBefore = this.state.bots;
    this.store.update((state) => ({ ...state, bots: mapAgents(result) }));
    this.botNames.onBots(this.state.bots);
    // Every id the gateway lists, system agents and bots past the display cap included.
    const listed = rosterIds(result);
    if (listed === null) return;
    const before = this.lastRoster;
    // Kept and compared within the host's id bound, as the other id maps are.
    const capped = new Set([...listed].map((id) => capId(id, MAX_ID_CHARS)));
    const added = [...capped].some((id) => !this.lastRosterIds.has(id));
    const fresh = [...listed].filter((id) => !this.lastRosterIds.has(capId(id, MAX_ID_CHARS)));
    const removed = new Set<string>();
    for (const id of this.lastRosterIds) if (!capped.has(id)) removed.add(id);
    this.lastRosterIds.clear();
    for (const id of [...capped].slice(0, MAX_BOTS)) this.lastRosterIds.add(id);
    this.lastRoster = listed.size <= MAX_BOTS ? "all" : "some";
    for (const id of listed) this.removedDuringRead.delete(id);
    for (const bot of shownBefore) if (!listed.has(bot.id)) removed.add(bot.id);
    for (const [key, row] of this.rows) {
      const botId = rowBotOf(key, row);
      if (botId && !listed.has(botId)) removed.add(botId);
    }
    // Past what the last roster kept, a bot may have left that nothing here can name.
    const unnamed = before === "some";
    // A task read already out can still list the removed bots' tasks: its rows for them are
    // dropped when it lands, or the whole answer when they can't all be named, and the tasks are
    // read once more after it.
    if (this.refreshing && (removed.size > 0 || unnamed)) {
      this.refreshAgain = true;
      if (unnamed) this.readOutdated = true;
      for (const id of removed) {
        if (this.removedDuringRead.size < MAX_BOTS) this.removedDuringRead.add(id);
        else this.readOutdated = true;
      }
    }
    // A bot the last roster on this connection didn't have: its tasks are read, since a bot hidden
    // from the list and shown again still has them. The connection's first read has its own.
    if (before === "some" || (before === "all" && added))
      void this.refreshSessions(this.generation);
    // A bot made while this connection is open, in Clawtrate or outside it: it gets the guides
    // now, as a bot does at a connect. The connection's first read has the change after its connect.
    if (before === "all")
      for (const id of fresh) void this.keepGuides(this.generation, this.epoch, { bot: id });
    if (removed.size === 0) return;
    let pruned = false;
    for (const [key, row] of [...this.rows]) {
      const botId = rowBotOf(key, row);
      if (!botId || !removed.has(botId)) continue;
      this.rows.delete(key);
      this.retireForeign(key);
      pruned = true;
    }
    if (pruned) this.publishTasks();
  }

  /**
   * Whether a read of the bot list may be shown, marking it shown: answers are ordered by when
   * they were asked, never by when they arrive, so a late answer never hides a bot a later read
   * showed.
   */
  private newestBots(issued: number): boolean {
    if (issued < this.botsShown) return false;
    this.botsShown = issued;
    return true;
  }

  // The Work pane's files (`files.ts`). All `operator.read`; nothing is kept in the state.

  /** One file list or read, at most `MAX_FILE_READS` at once; past it, refused. */
  private async fileRead<T>(
    read: (ctx: FileReaderContext) => Promise<T>,
    options: FileReadOptions,
  ): Promise<T> {
    if (this.state.connection.status !== "connected")
      throw new Error("Not connected to the gateway.");
    if (this.fileReads >= MAX_FILE_READS)
      throw new Error("Other files are being read; try again in a moment.");
    this.fileReads += 1;
    const owner = options.owner ?? DIRECT_CALLER;
    try {
      const result = await read({
        request: (method, params) => this.request(method, params),
        transfers: this.fileTransfers,
        owner,
        ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
        now: () => this.now(),
      });
      // A viewer that went away while this read ran can't release what it started: drop it now.
      if (this.withdrawnOwners.has(owner)) this.fileTransfers.release(owner);
      return result;
    } finally {
      this.fileReads -= 1;
    }
  }

  listMemory(botId: string) {
    return this.wholeRead(() =>
      listMemory((method, params) => this.request(method, params), botId),
    );
  }

  readMemory(botId: string, path: string) {
    return this.wholeRead(() =>
      readMemory((method, params) => this.request(method, params), botId, path),
    );
  }

  async writeMemory(
    botId: string,
    path: string,
    stamp: GatewayStamp,
    expectedHash: string | null,
    content: string | null,
  ) {
    if (this.options.readOnly || !this.state.connection.canAdmin)
      throw new Error("Changing memory requires admin access.");
    // The target half of the shared guard; `writeMemory` asks the gateway who it is itself, on
    // the request just before the write.
    this.requireSameTarget(stamp);
    await writeMemory(
      // Each of its requests is still held to the target its screen was read under.
      (method, params) =>
        this.target === stamp.target
          ? this.request(method, params)
          : Promise.reject(new Error(CONNECTION_CHANGED)),
      botId,
      path,
      stamp.gatewayId,
      expectedHash,
      content,
    );
  }

  /**
   * Whether the voice guide is added to the bots' prompts, read now from the gateway's voice
   * plugin, stamped with where it was read. The identity is null when the gateway names none or
   * the connection changed during the read, so it is never shown as another's.
   */
  async readBotVoice(): Promise<BotVoiceAnswer> {
    const protocol = this.protocol;
    const epoch = this.epoch;
    const target = this.target;
    const alive = () =>
      protocol !== null &&
      this.protocol === protocol &&
      this.epoch === epoch &&
      this.target === target &&
      this.state.connection.status === "connected";
    const gatewayId = await this.readGatewayIdentity();
    this.confirmGatewayIdentity(gatewayId, alive);
    const voice = await readVoice(
      (method, params) => this.request(method, params),
      this.voiceAdvertised,
    );
    return { ...voice, stamp: { gatewayId: alive() ? gatewayId : null, target } };
  }

  /**
   * Clawtrate's guides in the bots' `AGENTS.md` (guides.ts), read now, stamped with where they were
   * read. A guide change on its way (Clawtrate's own after a connect included) finishes first, so
   * what is shown is what it left. Reads need `operator.read`.
   */
  async readBotGuides(): Promise<BotGuidesAnswer> {
    // Bound to the connection it was asked on, before any wait: one that changes meanwhile
    // never answers for the one asked about.
    const protocol = this.protocol;
    const epoch = this.epoch;
    const target = this.target;
    // The change after this connection's connect is put in line only once its first reads are
    // done: a read made before then waits for it to be in line, then for it to finish.
    const pass = this.guidesConnectPass;
    if (pass?.epoch === epoch) await pass.queued;
    await this.guidesChanges;
    if (this.protocol !== protocol || this.epoch !== epoch || this.target !== target)
      throw new Error(CONNECTION_CHANGED);
    const alive = () =>
      protocol !== null &&
      this.protocol === protocol &&
      this.epoch === epoch &&
      this.target === target &&
      this.state.connection.status === "connected";
    const gatewayId = await this.readGatewayIdentity();
    this.confirmGatewayIdentity(gatewayId, alive);
    // Learning the name here can put the change that waited for it in line: what is shown is
    // what that change leaves.
    await this.guidesChanges;
    // Every read goes out on the connection this one began on: one gateway's files are never
    // shown as another's.
    const request = (method: string, params: unknown) =>
      alive() ? this.request(method, params) : Promise.reject(new Error(CONNECTION_CHANGED));
    const folders = await readGuideFolders(request);
    return { folders, stamp: { gatewayId: alive() ? gatewayId : null, target } };
  }

  /**
   * The guide changes (a new bot's, the one after a connect, the one after a run) run one at a
   * time, so two never write the same file from the same read.
   */
  private oneGuidesChangeAtATime<T>(run: () => Promise<T>): Promise<T> {
    const turn = this.guidesChanges.then(run, run);
    this.guidesChanges = turn.catch(() => undefined);
    return turn;
  }

  /** Whether this client writes the bots' files at all: admin access, not read-only, not turned off. */
  private guidesWritable(): boolean {
    return (
      this.options.keepGuides !== false && !this.options.readOnly && this.state.connection.canAdmin
    );
  }

  /**
   * Clawtrate's own guide change, with nothing asked (`keepGuidesCurrent`): every bot's section
   * kept as this build writes it, or `bot`'s alone, each file held to the hash read. A failure is
   * logged, never shown or thrown, and nothing is remembered of it: the next occasion tries again.
   * Answers the bots whose file doesn't exist yet.
   */
  private async guidesByThemselves(
    request: (method: string, params: unknown) => Promise<unknown>,
    bot?: string,
    /** Decided in line, just before: whether to write at all. */
    ready: () => Promise<boolean> = async () => true,
  ): Promise<string[]> {
    const { errors, missing } = await this.oneGuidesChangeAtATime(async () =>
      (await ready())
        ? keepGuidesCurrent(request, bot).catch((error: unknown) => ({
            errors: [error instanceof Error ? error.message : String(error)],
            missing: [] as string[],
          }))
        : { errors: [] as string[], missing: [] as string[] },
    );
    for (const error of errors) this.logFailure("warn", "guides", error);
    return missing;
  }

  /**
   * Clawtrate's own guide change on the gateway now connected (`guidesByThemselves`): after each
   * connect, for every bot; with `bot`, for one bot only (one made outside Clawtrate that the bot
   * list showed on this connection, or one whose file was missing and whose run just ended). The
   * bots whose file doesn't exist yet are read again, once each on this connection, when a run of
   * theirs ends (`guidesAfterRun`).
   */
  private async keepGuides(
    generation: number,
    epoch: number,
    options: { bot?: string; afterRun?: boolean; gatewayId?: string } = {},
  ): Promise<void> {
    const current = () =>
      generation === this.generation &&
      epoch === this.epoch &&
      this.state.connection.status === "connected" &&
      this.guidesWritable();
    if (!current()) return;
    if (options.bot === undefined) {
      this.guidesMissing.clear();
      // What builds before #795 kept on this device for their switch: nothing reads it now.
      for (const key of oldGuidesKeys(this.state.connection.gatewayId))
        void this.host.storage.delete(key).catch(() => undefined);
    }
    // In line at once, so a read of the guides made meanwhile waits for what it leaves. Nothing
    // is written until the gateway has named itself, as the saved route's gateway when the
    // connection has one: while it hasn't, the change waits for the name (`guidesUnnamed`).
    const known = options.gatewayId;
    const missing = await this.guidesByThemselves(
      (method, params) =>
        current() ? this.request(method, params) : Promise.reject(new Error(CONNECTION_CHANGED)),
      options.bot,
      async () => {
        // Named meanwhile by another read on this connection: that name, confirmed.
        const id = known ?? (await this.readGatewayIdentity()) ?? this.state.connection.gatewayId;
        if (!current()) return false;
        if (id === null) {
          this.guidesUnnamed = { generation, epoch };
          return false;
        }
        // Learned here first, the route's saved record is checked for it before anything is
        // written; publishing the name stays with the connection's own reads.
        if (known === undefined && this.bindRouteIdentity(id, current) === "changed") return false;
        if (!current()) return false;
        return this.routeIdentityHolds(id);
      },
    );
    if (!current()) return;
    // Read again once each: not after the read a run's end asked for.
    if (!options.afterRun) this.armGuidesMissing(missing, this.target);
  }

  /**
   * Whether `id` can be this connection's gateway as its saved route knows it: a route that has
   * bound an identity accepts only that one; no route, or one not bound yet, accepts any.
   */
  private async routeIdentityHolds(id: string): Promise<boolean> {
    // Another client on this store may have bound the route since this one loaded it.
    const binding = this.routeBinding;
    if (binding?.epoch === this.epoch && !(await binding.decided)) return false;
    const settings = this.settings;
    return (
      settings?.route === undefined || settings.gatewayId === undefined || settings.gatewayId === id
    );
  }

  /**
   * The bots whose file didn't exist yet are read again once each when a run of theirs ends, on
   * the connection now open (`target`), with admin access.
   */
  private armGuidesMissing(bots: string[], target: number): void {
    if (this.target !== target || !this.guidesWritable()) return;
    for (const id of bots)
      if (this.guidesMissing.size < MAX_BOTS) this.guidesMissing.add(capId(id, MAX_ID_CHARS));
  }

  /** A run of `botId` ended on this connection: once, its file is read again if it was missing. */
  private guidesAfterRun(botId: string | null): void {
    if (botId === null || !this.guidesMissing.delete(capId(botId, MAX_ID_CHARS))) return;
    void this.keepGuides(this.generation, this.epoch, { bot: botId, afterRun: true });
  }

  /** Settings reads the voice setting again (`state.voiceChanges`). */
  private voiceChanged(): void {
    this.store.update((state) => ({ ...state, voiceChanges: (state.voiceChanges ?? 0) + 1 }));
  }

  /**
   * Turn the voice guide on or off for the bots on the gateway (operator.write). `stamp` is where
   * the setting on screen was read: unless that gateway and target still hold, nothing is sent.
   * Nor is it sent once `owner`, the viewer that asked, is withdrawn.
   */
  async setBotVoice(
    on: boolean,
    stamp: GatewayStamp,
    owner: object | null = null,
  ): Promise<BotVoiceAnswer> {
    if (this.options.readOnly || !this.state.connection.canWrite)
      throw new Error("Changing how the bots talk needs write access.");
    // The connection the guard checks is the one the change goes out on: captured first,
    // checked again after the guard, and the request refused if it closed or moved on.
    const protocol = this.protocol;
    const epoch = this.epoch;
    const alive = () =>
      protocol !== null &&
      this.protocol === protocol &&
      this.epoch === epoch &&
      this.target === stamp.target &&
      this.state.connection.status === "connected";
    await this.requireSameGateway(stamp);
    if (!alive()) throw new Error(CONNECTION_CHANGED);
    this.checkNotWithdrawn(owner);
    const voice = await setVoice(
      (method, params) =>
        protocol && alive()
          ? protocol.request(method, params)
          : Promise.reject(new Error(CONNECTION_CHANGED)),
      on,
    );
    return { ...voice, stamp };
  }

  /**
   * Undo what a background skill review changed, the gateway's own way (OpenClaw 2026.11.10,
   * `skills.workshop.undo`, which needs `operator.admin`): `undone` is false when the gateway says
   * it was already undone. A refusal comes back with the gateway's words.
   */
  async undoSkillChange(
    agentId: string,
    reviewId: string,
    stamp: GatewayStamp,
    owner: object | null = null,
  ): Promise<{ undone: boolean }> {
    if (this.options.readOnly || !this.state.connection.canAdmin)
      throw new Error("Undoing a skill change needs admin access to the gateway.");
    // The connection the guard checks is the one the undo goes out on, as for the bots' voice.
    const protocol = this.protocol;
    const epoch = this.epoch;
    const alive = () =>
      protocol !== null &&
      this.protocol === protocol &&
      this.epoch === epoch &&
      this.target === stamp.target &&
      this.state.connection.status === "connected";
    await this.requireSameGateway(stamp);
    if (!alive()) throw new Error(CONNECTION_CHANGED);
    this.checkNotWithdrawn(owner);
    const answer = await protocol!.request("skills.workshop.undo", {
      agentId,
      runId: `${SKILL_REVIEW_RUN_PREFIX}${reviewId}`,
    });
    return { undone: asRecord(answer)?.status === "undone" };
  }

  /** A task's files and the folder it works in, read now (`sessions.files.list`, `sessions.describe`). */
  listTaskFiles(key: string, options: FileReadOptions = {}): Promise<TaskFileList> {
    return this.fileRead((ctx) => listTaskFiles(ctx, key), options);
  }

  /** One of a task's files, from the reader its place allows (work-pane.md, section 8). */
  readTaskFile(key: string, path: string, options: FileReadOptions = {}): Promise<FileRead> {
    const botId = botIdFromSessionKey(key);
    if (!botId) return Promise.reject(new Error("This task's bot is not known."));
    return this.fileRead((ctx) => readTaskFile(ctx, key, botId, path), options);
  }

  /** One page of a folder of a bot's workspace (`agents.workspace.list`). */
  listWorkspace(
    botId: string,
    path: string,
    offset: number,
    options: FileReadOptions = {},
  ): Promise<WorkspacePage> {
    return this.fileRead((ctx) => listWorkspace(ctx, botId, path, offset), options);
  }

  /** A file of a bot's workspace; `key` names the open task whose asset reader may send media. */
  readWorkspaceFile(
    botId: string,
    path: string,
    size: number | null,
    key: string | null,
    options: FileReadOptions = {},
  ): Promise<FileRead> {
    return this.fileRead((ctx) => readWorkspaceFile(ctx, botId, path, size, key), options);
  }

  /** The checkout's patch for one of a task's files (`sessions.diff`). */
  readCheckoutDiff(
    key: string,
    path: string,
    options: FileReadOptions = {},
  ): Promise<CheckoutDiff> {
    return this.fileRead((ctx) => readCheckoutDiff(ctx, key, path), options);
  }

  /** A picture the bot handed over in the task (`pictures.ts`), sharing the file reads' limit. */
  async readChatPicture(
    key: string,
    artifactId: string,
    options: FileReadOptions = {},
  ): Promise<ChatPictureRead> {
    return this.readHandedOver("picture", options, (ctx) => readChatPicture(ctx, key, artifactId));
  }

  /**
   * A file the bot handed over in the task that isn't a picture (`chat-files.ts`), the same way.
   * It is read when the person asks, which can be long after its row was drawn: with `stamp`
   * (the gateway that drew the row), nothing is asked unless the host still has that gateway.
   */
  async readChatFile(
    key: string,
    artifactId: string,
    options: FileReadOptions = {},
    stamp?: GatewayStamp,
  ): Promise<ChatFileRead> {
    // Checked before the read waits for a place and again after: the connection can move meanwhile.
    const refusal = async (): Promise<string | null> => {
      if (stamp === undefined) return null;
      try {
        await this.requireSameGateway(stamp);
        return null;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return /another gateway/.test(message) ? FILE_FROM_ANOTHER_GATEWAY : message;
      }
    };
    const before = await refusal();
    if (before !== null) return { status: "failed", message: before };
    return this.readHandedOver(
      "file",
      options,
      (ctx) => readChatFile(ctx, key, artifactId),
      refusal,
    );
  }

  /** A picture or file a bot handed over, read through the download the gateway issues. */
  private async readHandedOver<R extends { status: string }>(
    noun: string,
    options: FileReadOptions,
    read: (ctx: ChatPictureContext) => Promise<R>,
    /** Checked once the read has its place, just before anything is asked: why not, or null. */
    refusal?: () => Promise<string | null>,
  ): Promise<R | { status: "failed"; message: string }> {
    // A turn hands over up to four pictures and a task can hold several such turns, all drawn
    // at once: a picture waits up to 30 s for one of the file reads' places, and of the
    // transfers' that carry a picture to its viewer, instead of failing.
    const generation = this.generation;
    for (
      let waited = 0;
      (this.fileReads >= MAX_FILE_READS || this.fileTransfers.full()) && waited < 300;
      waited += 1
    )
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 100));
    // The task and picture are the connection's it was asked on: never read on a later one.
    if (generation !== this.generation)
      return { status: "failed", message: `The connection changed while this ${noun} waited.` };
    // A viewer that left while the picture waited asks for nothing.
    this.checkNotWithdrawn(options.owner);
    const refused = refusal ? await refusal() : null;
    if (refused !== null) return { status: "failed", message: refused };
    // The refusal can wait for the gateway's identity: the viewer is checked again, last.
    this.checkNotWithdrawn(options.owner);
    // The socket the read is asked on: one that answers after a reconnect is another's.
    const epoch = this.epoch;
    const gatewayUrl = this.state.connection.gatewayUrl ?? "";
    const answer = await this.fileRead(
      (ctx) => read({ ...ctx, fetch: this.host.fetch ?? null, gatewayUrl }),
      options,
    );
    // Bytes that arrive after a switch to another gateway, or a reconnect, are the old
    // connection's: none reach a viewer.
    if (generation !== this.generation || epoch !== this.epoch) {
      const transfer = (answer as { transfer?: { id: string | null } }).transfer;
      if (answer.status === "content" && transfer?.id)
        this.fileTransfers.release(options.owner ?? DIRECT_CALLER, transfer.id);
      return { status: "failed", message: `The connection changed while this ${noun} was read.` };
    }
    return answer;
  }

  /**
   * A picture a person sent with a message in this task. First from this client's own copy: by
   * the outgoing message's id while the outbox holds it, or by the key history stored its row
   * under (`namesOutgoing`) once it is there. Then from a picture this client read back before
   * (`readBackPictures`). Then, only at a protected address, read back from the gateway by the
   * reference the task's own row gave (`sentSources`, `fetchInboundPicture`), bound to the
   * connection it was asked on and, with `stamp`, to that screen's gateway. `index` is the
   * file's place among the message's attachments. A file whose bytes aren't the picture it is
   * named as is `not-a-picture`; with no copy and no read back, `cannot-load`.
   */
  async readSentPicture(
    key: string,
    messageKey: string,
    index: number,
    options: FileReadOptions = {},
    stamp?: GatewayStamp,
  ): Promise<SentPictureRead> {
    for (let waited = 0; this.fileTransfers.full() && waited < 300; waited += 1)
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 100));
    // A viewer that left while the picture waited is given nothing.
    this.checkNotWithdrawn(options.owner);
    const start = (bytes: Uint8Array) =>
      this.fileTransfers.start(options.owner ?? DIRECT_CALLER, bytes, options.maxChars);
    const outgoing = this.state.transcripts[key]?.outbox.find((each) => each.id === messageKey);
    const sending = outgoing ? this.attachmentContent.get(outgoing.id) : undefined;
    const kept = sending
      ? undefined
      : [...this.sentPictures.entries()].find(
          ([id, each]) =>
            each.task === key &&
            namesOutgoing(messageKey, { id, mode: each.mode, runId: each.runId }),
        )?.[1];
    if (kept?.notPictures.includes(index)) return { status: "not-a-picture" };
    const file = sending ? sending.files[index] : kept?.files.find((each) => each.index === index);
    if (file) return ownPictureRead(file, start);
    const id = `${key}\u0000${messageKey}\u0000${index}`;
    const readBack = this.readBackPictures.get(id);
    if (readBack) {
      // The newest again: the picture last shown gives way last.
      this.readBackPictures.delete(id);
      this.readBackPictures.set(id, readBack);
      return ownPictureRead(readBack, start);
    }
    const ref = this.sentSources.get(key)?.get(`${messageKey}\u0000${index}`);
    // Nothing is asked for at a loopback or `ws://` address, or without the row's own reference.
    if (!ref || !this.host.fetch || !readBackAddress(this.state.connection.gatewayUrl ?? ""))
      return { status: "cannot-load" };
    return this.readBackPicture(key, id, ref, options, start, stamp);
  }

  /** `readSentPicture`'s read from the gateway, sharing the file reads' limit. */
  private async readBackPicture(
    key: string,
    id: string,
    ref: string,
    options: FileReadOptions,
    start: (bytes: Uint8Array) => FileTransferStart,
    stamp: GatewayStamp | undefined,
  ): Promise<SentPictureRead> {
    const generation = this.generation;
    const epoch = this.epoch;
    if (this.pictureReadsInFlight.size >= MAX_PICTURE_READS)
      return {
        status: "failed",
        message: "Too many pictures are being read; try again in a moment.",
      };
    // Dropped when its task, or its bot, is deleted while it is read: a read for another task
    // goes on.
    const flight = { task: key, bot: this.taskBot(key), dropped: false };
    this.pictureReadsInFlight.add(flight);
    try {
      // The socket it was asked on, and the gateway the screen was drawn for: never another.
      const elsewhere = () =>
        generation !== this.generation ||
        epoch !== this.epoch ||
        (stamp !== undefined &&
          (stamp.gatewayId === null ||
            stamp.target !== this.target ||
            this.state.connection.gatewayId !== stamp.gatewayId));
      const changed = {
        status: "failed",
        message: "The connection changed while this picture was read.",
      } as const;
      if (elsewhere()) return changed;
      // Pictures on screen together queue for a place: nothing is awaited between the last look
      // at the gate and the read taking its place, so none is refused for another's.
      for (let waited = 0; this.fileReads >= MAX_FILE_READS && waited < 300; waited += 1)
        await new Promise<void>((resolve) => setTimeout(() => resolve(), 100));
      if (elsewhere()) return changed;
      this.checkNotWithdrawn(options.owner);
      const gatewayUrl = this.state.connection.gatewayUrl ?? "";
      const deviceId = this.state.connection.deviceId;
      const read = await this.fileRead(async (ctx) => {
        // This device's token for the gateway connected now, and no other gateway's.
        const held =
          deviceId && this.settings?.url === gatewayUrl
            ? await this.loadToken(gatewayUrl, deviceId, "operator")
            : null;
        if (elsewhere()) return changed;
        // A token bound to a proved route goes only on that route's sockets, never on this request.
        if (held?.route !== undefined) return { status: "cannot-load" } as const;
        const token = held?.token ?? null;
        return fetchInboundPicture(
          { fetch: this.host.fetch ?? null, gatewayUrl, token, now: ctx.now },
          key,
          ref,
        );
      }, options);
      // Bytes that arrive after a switch are the old gateway's, and a task deleted meanwhile keeps
      // none: neither is kept or shown.
      if (elsewhere() || flight.dropped) return changed;
      if (read.status !== "bytes") return read;
      this.keepReadBack(id, key, flight.bot, read.mimeType, read.bytes);
      try {
        // A viewer that left during the read is handed nothing.
        this.checkNotWithdrawn(options.owner);
        return {
          status: "content",
          kind: "image",
          mimeType: read.mimeType,
          bytes: read.bytes.length,
          transfer: start(read.bytes),
        };
      } catch (error) {
        return { status: "failed", message: errorMessage(error) };
      }
    } finally {
      this.pictureReadsInFlight.delete(flight);
    }
  }

  /** The next part of a file on its way to this viewer. */
  readFileChunk(id: string, index: number, owner: object = DIRECT_CALLER): { data: string } {
    return this.fileTransfers.chunk(owner, id, index);
  }

  holdsFile(id: string, owner: object): boolean {
    return this.fileTransfers.holds(owner, id);
  }

  /** Drop a file's transfer before its last part was read. */
  releaseFile(id: string, owner: object = DIRECT_CALLER): void {
    this.fileTransfers.release(owner, id);
  }

  /** The raw call and result of a step as the raw table keeps it now; null when it is not kept. */
  stepRaw(key: string, stepId: string): StepRaw | null {
    if (!this.state.transcripts[key]) return null;
    return this.raw.get(key, stepId);
  }

  /**
   * A failed run's Raw (F-301), read only when it is opened and returned without being kept in
   * the state. Null when the task has no such run.
   */
  readRunRaw(key: string, runId: string): RunRawRead | null {
    const transcript = this.state.transcripts[key];
    const run = transcript && findRun(transcript, runId);
    if (!run) return null;
    const described = run.error?.raw;
    if (!described) return { status: "not-kept", holds: null };
    const kept = this.raw.get(key, runErrorRawId(run.id));
    if (kept) return { status: "available", holds: described.holds, payload: kept.call };
    if (described.chars > MAX_RAW_ENTRY_CHARS)
      return {
        status: "too-large",
        holds: described.holds,
        chars: described.chars,
        limit: MAX_RAW_ENTRY_CHARS,
      };
    return { status: "not-kept", holds: described.holds };
  }

  /**
   * A step's whole raw call and result, returned without being kept: from the
   * raw table while it fits there, otherwise from the gateway's history once
   * that step is in history. Until then the answer is `not-available-yet`.
   * Null only when the task has no such step.
   */
  async readStepRaw(key: string, stepId: string): Promise<StepRead | null> {
    const find = () =>
      this.state.transcripts[key]?.runs
        .flatMap((run) => run.steps)
        .find((step) => step.id === stepId);
    const step = find();
    if (!step) return null;
    // What the raw table keeps is whole unless a history row it came from was cut.
    const kept = this.raw.get(key, stepId);
    if (kept && !step.truncated) return { status: "available", raw: kept };
    // Ask for the length the step needs; one the gateway cut gives no length, so the most it gives.
    const known = Math.max(
      ...[step.argsText, step.output, step.result].map((text) => text?.totalChars ?? 0),
    );
    const maxChars = step.truncated
      ? MAX_HISTORY_READ_CHARS
      : Math.min(MAX_HISTORY_READ_CHARS, Math.max(GATEWAY_HISTORY_TEXT_CHARS, known + 64));
    const history = await this.readHistoryWhole(key, maxChars);
    const current = this.state.transcripts[key];
    const shown = find();
    const run = current?.runs.find((each) => each.steps.some((one) => one.id === stepId));
    if (!current || !shown || !run) return null;
    // Rebuilt aside, as a resync would, into a table dropped after this read.
    const scratch = new RawTable(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    const ctx = { ...this.context(key), raw: scratch };
    const windowCut = history?.hasMore === true;
    const aliased = throughRunAliases(
      history?.messages,
      asRecord(history?.inFlightRun),
      current.queueAliases,
    );
    const fromHistory = runsFromHistory(aliased.messages, aliased.inFlight, ctx, { windowCut });
    const whole = scratch.get(key, stepId);
    const read = fromHistory.flatMap((each) => each.steps).find((each) => each.id === stepId);
    // A step's id is its place, which history can give another block: what was fetched is
    // this step only when it shows so. This check only ever withholds `available`.
    const same = whole !== null && read !== undefined && sameStep(shown, read, whole);
    // Its message replaced by the gateway's placeholder: not a cut text, and asking again does not help.
    if ((!same || read.truncated) && oversizedWhere(aliased.messages, run.id, shown, windowCut)) {
      return {
        status: "too-large-for-gateway",
        reason:
          "The gateway replaces a message this large with a placeholder in its history and will not return its text in full.",
      };
    }
    if (!same) {
      if (whole && read) {
        return {
          status: "not-established",
          reason:
            "What the gateway's history returned at this step's place could not be shown to be this step, so it is not offered as its text.",
        };
      }
      return {
        status: "not-available-yet",
        reason:
          "This step's whole text was too long to keep here, and the gateway's history did not return it: it may not hold it yet, or its page was too large to include it. Trying again later may help.",
      };
    }
    if (read.truncated) {
      return {
        status: "cut-by-gateway",
        raw: whole,
        receivedChars: Math.max(
          ...[read.argsText, read.output, read.result].map((text) => text?.totalChars ?? 0),
        ),
        reason: "The gateway's history holds this step's text only cut to a shorter length.",
      };
    }
    return { status: "available", raw: whole };
  }

  // Activity ------------------------------------------------------------------------

  private context(key: string): EngineContext {
    return { sessionKey: key, now: this.now(), raw: this.raw };
  }

  private updateActivity(
    key: string,
    fn: (activity: TaskActivity, ctx: EngineContext) => TaskActivity,
  ): void {
    const current = this.state.transcripts[key];
    if (!current) return;
    // After a confirmed Stop nothing starts by itself: what was held or queued stays, not sent.
    const next = retainActivity(
      settleQuestionsOfEndedRuns(
        normalizeApprovals(
          this.withKeptAttempts(
            current,
            parkAfterStop(current, fn(current, this.context(key)), this.now()),
          ),
          (runId) => this.otherRun(runId),
        ),
      ),
    );
    if (next === current) return;
    // Only a change of runs can take a payload out of what the task retains.
    if (next.runs !== current.runs) this.retainTaskRaw(key, next);
    this.setTranscript(key, () => withLive({ ...current, ...next }));
    this.afterActivity(key);
    this.refreshLinkersOf(key, current.runs, next.runs);
  }

  /**
   * A run in this task changed state, and another task's send names it (a
   * recipient whose task is open beside its sender's): that task's card
   * follows it now, not at its own next change.
   */
  private refreshLinkersOf(key: string, before: Run[], after: Run[]): void {
    const changed = after.filter(
      (run) => findRun({ ...emptyActivity, runs: before }, run.id)?.state !== run.state,
    );
    if (changed.length === 0) return;
    for (const transcript of Object.values(this.state.transcripts)) {
      if (transcript.sessionKey === key) continue;
      if (changed.some((run) => transcript.linkedRuns[run.id]))
        this.refreshLinkedRuns(transcript.sessionKey);
    }
  }

  /**
   * After any change: keep turn timers, release held messages once their
   * question is settled, start the oldest queued run once nothing is active,
   * and let go of a closed task whose work is done. Not re-entrant: a change
   * made while it runs makes it run once more instead of nesting, so no
   * message is claimed twice.
   */
  private afterActivity(key: string): void {
    if (this.afterRunning.has(key)) {
      this.afterAgain.add(key);
      return;
    }
    this.afterRunning.add(key);
    try {
      do {
        this.afterAgain.delete(key);
        this.afterActivityOnce(key);
      } while (this.afterAgain.has(key));
    } finally {
      this.afterRunning.delete(key);
    }
  }

  private afterActivityOnce(key: string): void {
    const transcript = this.state.transcripts[key];
    if (!transcript) return;
    // A run that ended or left the transcript keeps no stream baseline.
    this.streams.retire(key, (runId) => {
      const run = findRun(transcript, runId);
      return run !== undefined && !isTerminal(run.state);
    });
    this.refreshLinkedRuns(key);
    this.scheduleApprovalExpiry(key);
    void this.settleEndedRuns(key);
    // A run event can name the run before the send reply dispatches its first abort.
    for (const id of this.unsentStops.keys()) {
      const [task, runId] = id.split("\u0000") as [string, string];
      if (task !== key) continue;
      const run = findRun(transcript, runId);
      const waiting =
        run?.stopRequestedAt != null &&
        (run.state === "stopping" || (run.state === "stopped" && !run.outcomeKnown));
      if (!waiting) this.unsentStops.delete(id);
    }
    // The turn the gateway starts by itself after a recipient this client stopped (#645).
    // Read after `refreshLinkedRuns`: a recipient it has just seen finish keeps its reply running.
    this.stopFollowUps(key, this.state.transcripts[key] ?? transcript);
    for (const run of transcript.runs) {
      // A run this client stopped has ended as stopped: stop what its messages started (F-296).
      if (
        run.state === "stopped" &&
        run.outcomeKnown &&
        run.stopRequestedAt !== null &&
        !run.stoppedWith?.recipientsAsked &&
        this.state.connection.canWrite &&
        !this.options.readOnly
      )
        void this.stopRecipients(key, run.id);
      // Tool calls that keep timing out: the machine may not be responding. Stop the run (F-101).
      if (
        (run.state === "running" || run.state === "waiting") &&
        run.stoppedForTimeouts === undefined &&
        this.state.connection.canWrite &&
        !this.options.readOnly
      ) {
        const count = timeoutsInARow(run);
        if (count >= TIMEOUTS_IN_A_ROW && runningRunId(transcript, run.id) === run.id) {
          this.updateActivity(key, (activity) => markStoppedForTimeouts(activity, run.id, count));
          void this.stopRun(key, run.id).then(() => {
            // The stop was refused or could not be asked: the run goes on, not as stopped for this.
            const now = this.state.transcripts[key] && findRun(this.state.transcripts[key], run.id);
            if (now && (now.state === "running" || now.state === "waiting"))
              this.updateActivity(key, (activity) => markStoppedForTimeouts(activity, run.id, 0));
          });
        }
      }
      const timerKey = `${key}\u0000${run.id}`;
      const timer = this.turnTimers.get(timerKey);
      if (isTerminal(run.state)) {
        if (timer) clearTimeout(timer);
        this.turnTimers.delete(timerKey);
      } else if (
        !timer &&
        run.origin === "local" &&
        run.bound &&
        run.turnLimit === undefined &&
        isActive(run.state)
      ) {
        const limit = this.turnLimitMs;
        const elapsed = this.now() - (run.startedAt ?? this.now());
        this.turnTimers.set(
          timerKey,
          setTimeout(
            () => this.turnLimitReached(key, run.id),
            Math.min(MAX_TIMER_MS, Math.max(0, limit - elapsed)),
          ),
        );
      }
    }
    const active = activeRun(transcript);
    const held = transcript.outbox
      .filter((message) => message.status === "held")
      .map((message) => message.id);
    if (held.length > 0 && !questionPending(transcript, active)) {
      // The question is settled: release every held message at once, in the
      // order sent, each as a message sent now would go. Into a running run
      // as a steer, unless it was queued; queued while the run stops; and
      // once the run has ended, queued, so each starts a run of its own.
      const steered: string[] = [];
      this.updateActivity(key, (activity) => {
        let next = activity;
        const now = activeRun(activity);
        for (const id of held) {
          const message = next.outbox.find((each) => each.id === id);
          if (!message || message.status !== "held") continue;
          if (now && now.state !== "stopping" && message.mode !== "queue") {
            // Into the gateway's run: a queued run of its own it waited with goes.
            const waited = findRun(next, id)?.state === "queued" ? dropUnboundRun(next, id) : next;
            next = updateMessage(waited, id, {
              status: "sending",
              mode: "steer",
              runId: now.id,
            });
            steered.push(id);
          } else if (gatewayRunning(next, id)) {
            // The gateway is running a run under this message's own id: the message is out.
            next = updateMessage(next, id, { status: "sent", runId: id });
          } else {
            next = updateMessage(next, id, { status: "queued", mode: "queue", runId: null });
            // A message held after it started its own run (a question came with the run's end)
            // queues again in that run's place: one run per message, in the order written.
            next = requeueLocalRun(
              next,
              next.outbox.find((each) => each.id === id)!,
              this.now(),
            );
          }
        }
        return next;
      });
      for (const id of steered) this.enqueueDelivery(key, id);
    }
    const current = this.state.transcripts[key];
    if (!current) return;
    // Only a message still queued is started: a queued run whose message was cancelled or taken
    // back meanwhile never sends it.
    const next =
      activeRun(current) || questionPending(current)
        ? undefined
        : current.runs.find(
            (run) =>
              run.state === "queued" &&
              current.outbox.find((message) => message.id === run.id)?.status === "queued",
          );
    if (next) {
      this.updateActivity(key, (activity) =>
        // It keeps `mode: "queue"`: if the gateway refuses to start it, the
        // shelf says "Couldn't start" rather than a send failing.
        updateMessage(startQueuedRun(activity, next.id, this.now()), next.id, {
          status: "sending",
        }),
      );
      this.enqueueDelivery(key, next.id);
    }
    if (this.retained.has(key) && !hasUnsettledWork(this.state.transcripts[key] ?? emptyActivity)) {
      this.releaseTask(key);
    }
  }

  /**
   * Deliveries for one task run one at a time, in the order they were made,
   * so messages reach the gateway in the order the user sent them.
   */
  private enqueueDelivery(key: string, messageId: string): void {
    // A new attempt: until its frame leaves, a confirmed Stop parks it.
    if (this.outgoing(key, messageId)?.leftAt != null) {
      this.updateActivity(key, (activity) => updateMessage(activity, messageId, { leftAt: null }));
    }
    if (!this.state.connection.canWrite && this.outgoing(key, messageId)?.status === "sending") {
      this.updateActivity(key, (activity) =>
        updateMessage(activity, messageId, { status: "awaiting-access" }),
      );
    }
    const previous = this.deliveries.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.deliver(key, messageId))
      .catch((error: unknown) => this.logFailure("error", "delivery", error));
    this.deliveries.set(key, next);
    void next.then(() => {
      if (this.deliveries.get(key) === next) this.deliveries.delete(key);
    });
  }

  /**
   * Name the selected gateway on this device, or remove its name with an empty
   * one. Only the address the person saw: another viewer may have changed it.
   * Kept in the host's storage first; the gateway is never told.
   */
  async nameGateway(gatewayUrl: string, name: string): Promise<void> {
    if (this.state.connection.gatewayUrl !== gatewayUrl) throw new GatewayChangedError();
    return this.inOrder("gatewayNames", async () => {
      const next = withGatewayName(this.gatewayNames, gatewayUrl, name);
      await this.host.storage.set(GATEWAY_NAMES_KEY, writeGatewayNames(next));
      this.preferenceSets.gatewayNames += 1;
      this.gatewayNames = next;
      this.store.update((state) => ({ ...state }));
    });
  }

  /**
   * Set the "Turn time limit" (F-100), in whole minutes, and keep it for the next start. Runs
   * already going are timed against the new limit from when they started.
   */
  async setTurnLimit(minutes: number): Promise<void> {
    if (!validTurnLimit(minutes))
      throw new Error(
        `A turn limit is a whole number of minutes from ${MIN_TURN_LIMIT_MINUTES} to ${MAX_TURN_LIMIT_MINUTES}.`,
      );
    return this.inOrder("turnLimit", async () => {
      // Kept first: a limit the host could not keep is not taken, and the old one and its timers
      // stay.
      await this.host.storage.set(TURN_LIMIT_KEY, String(minutes));
      this.preferenceSets.turnLimit += 1;
      this.turnLimitMs = minutes * 60_000;
      this.store.update((state) => ({ ...state, turnLimitMinutes: minutes }));
      for (const [timerKey, timer] of this.turnTimers) {
        clearTimeout(timer);
        this.turnTimers.delete(timerKey);
      }
      for (const key of Object.keys(this.state.transcripts)) this.afterActivity(key);
    });
  }

  /**
   * "Show external channel chats": list chats that came in through Discord, Telegram and other
   * channels, or leave them out (the default). Kept for the next start. The rows are already
   * held, so the list changes at once, with nothing read again; a bot's main task always shows.
   */
  async setShowChannelChats(on: boolean): Promise<void> {
    return this.inOrder("channelChats", async () => {
      // Kept first: a choice the host could not keep is not taken.
      await this.host.storage.set(CHANNEL_CHATS_KEY, String(on));
      this.preferenceSets.channelChats += 1;
      this.showChannelChats = on;
      this.store.update((state) => ({ ...state, showChannelChats: on }));
      this.publishTasks();
    });
  }

  /**
   * "Show sessions from other tools": list sessions an API client, a scheduled run or another
   * tool opened with a bot (`origins.ts`), or leave them out (the default). Kept for the next
   * start, and applied to the rows already held, as `setShowChannelChats` is.
   */
  async setShowOtherToolSessions(on: boolean): Promise<void> {
    return this.inOrder("otherTools", async () => {
      await this.host.storage.set(OTHER_TOOLS_KEY, String(on));
      this.preferenceSets.otherTools += 1;
      this.showOtherToolSessions = on;
      this.store.update((state) => ({ ...state, showOtherToolSessions: on }));
      this.publishTasks();
    });
  }

  /**
   * "Show the gateway's own bot": list the gateway's default bot beside the others, or leave it
   * out while another bot exists (the default). Kept for the next start. Only what the app shows
   * changes; nothing is sent to the gateway.
   */
  async setShowGatewayBot(on: boolean): Promise<void> {
    return this.inOrder("gatewayBot", async () => {
      // Kept first: a choice the host could not keep is not taken.
      await this.host.storage.set(GATEWAY_BOT_KEY, String(on));
      this.preferenceSets.gatewayBot += 1;
      this.showGatewayBot = on;
      this.store.update((state) => ({ ...state, showGatewayBot: on }));
    });
  }

  private turnLimitReached(key: string, runId: string): void {
    this.turnTimers.delete(`${key}\u0000${runId}`);
    const run = this.state.transcripts[key] && findRun(this.state.transcripts[key], runId);
    if (!run || (run.state !== "running" && run.state !== "waiting")) return;
    const limit = this.turnLimitMs;
    if (this.now() - (run.startedAt ?? this.now()) < limit) {
      // Woken early by the timer ceiling: arm again.
      this.afterActivity(key);
      return;
    }
    // Stopped as any Stop is: "Stopping…" until the gateway confirms, put back if it refuses,
    // and asked again after a reconnect if unanswered. Nothing fails and nothing queued is
    // released on the limit alone; the limit is reached once per run.
    const minutes = Math.round(this.turnLimitMs / 60_000);
    if (
      !this.state.connection.canWrite ||
      this.options.readOnly ||
      runningRunId(this.state.transcripts[key]!, runId) !== runId
    ) {
      // Not stopped by the limit: it is not asked again, and no later stop is put down to it.
      this.updateActivity(key, (activity) => markTurnLimit(activity, runId, 0));
      return;
    }
    this.updateActivity(key, (activity) => markTurnLimit(activity, runId, minutes));
    void this.stopRun(key, runId);
  }

  private clearTurnTimers(key: string): void {
    const prefix = `${key}\u0000`;
    for (const [timerKey, timer] of this.turnTimers) {
      if (!timerKey.startsWith(prefix)) continue;
      clearTimeout(timer);
      this.turnTimers.delete(timerKey);
    }
  }

  /** The task was archived or deleted: its queued messages never run (F-420). */
  private cancelAllQueued(key: string): void {
    this.updateActivity(key, (activity) => {
      let next = activity;
      for (const run of activity.runs) {
        if (run.state !== "queued") continue;
        this.dropAttachments(run.id);
        next = updateMessage(cancelQueuedRun(next, run.id, this.now()), run.id, {
          status: "cancelled",
        });
      }
      return next;
    });
  }

  // Connection lifecycle -------------------------------------------------------

  private isAllowed(url: string): boolean {
    return this.options.allowGatewayUrl ? this.options.allowGatewayUrl(url) : true;
  }

  /**
   * Opens the selected gateway again, keeping a pending answer, from outside a change (an
   * approved access request's reconnect). A failure before the connection could retry by itself,
   * such as a read of the saved token, is shown and tried again with the reconnect backoff, for as
   * long as nothing opened or closed a connection since: a Disconnect, a switch or a stop ends it,
   * and closing clears the next try.
   */
  private reopen(attempt = 0): void {
    const opening = this.open({ keepPendingAnswer: true });
    const generation = this.generation;
    opening.catch(() => {
      if (generation !== this.generation || !this.settings) return;
      const reconnect = this.options.reconnect ?? { initialMs: 1000, maxMs: 30_000 };
      const delayMs = Math.min(reconnect.initialMs * 2 ** attempt, reconnect.maxMs);
      // A host can stop the client synchronously when it receives the retry notification.
      this.reopenTimer = setTimeout(() => {
        this.reopenTimer = null;
        this.reopen(attempt + 1);
      }, delayMs);
      this.setConnection({
        status: this.everConnected ? "reconnecting" : "connecting",
        error: {
          code: "RECONNECT_FAILED",
          message: "Clawtrate couldn't read this device's saved pairing to reconnect.",
          hint: null,
        },
        retryAt: this.now() + delayMs,
      });
      this.log("warn", "Could not reconnect to the gateway; trying again.");
    });
  }

  /** `newTarget`: the person pointed the host at a gateway anew, so no earlier screen's write goes. */
  private async open(options?: {
    keepPendingAnswer?: boolean;
    newTarget?: boolean;
  }): Promise<void> {
    this.close({ keepPendingAnswer: options?.keepPendingAnswer === true });
    if (options?.newTarget) {
      // A subscriber told of the new target may stop the client: then this open ends here.
      const before = this.generation;
      this.target += 1;
      this.setConnection({ target: this.target });
      if (this.generation !== before) return;
    }
    const settings = this.settings;
    if (!settings) return;
    const generation = ++this.generation;
    // Every read this connection makes logs fixed words if it is setup's, after setup ends too.
    this.setupGeneration = this.isSetup(settings.url) ? generation : null;
    // A connection made with the host's setup code stages its first token here.
    this.tokenGate =
      this.setupCode?.url === settings.url ? { generation, url: settings.url, staged: null } : null;
    const identity = await this.loadIdentity();
    if (generation !== this.generation) return;

    if (!this.isAllowed(settings.url)) {
      this.rows = new Map();
      this.store.set({
        ...initialState,
        turnLimitMinutes: this.turnLimitMs / 60_000,
        showChannelChats: this.showChannelChats,
        showOtherToolSessions: this.showOtherToolSessions,
        showGatewayBot: this.showGatewayBot,
        connection: {
          ...initialConnectionState,
          target: this.target,
          status: "error",
          gatewayUrl: settings.url,
          deviceId: identity.deviceId,
          error: {
            code: "GATEWAY_NOT_ALLOWED",
            message: new GatewayNotAllowedError(settings.url).message,
            hint: null,
          },
        },
      });
      return;
    }

    // Full access goes only over a protected route: a protected address (`protectedGatewayUrl`),
    // or this computer's gateway when every socket of the connection is proved (`socketsProved`,
    // setup-effortless.md §3). Elsewhere this device asks for read, as before, and a full
    // pairing's token there asks for read too. What a first pairing may ask for on that route
    // is `firstPairingMayAskFull`'s. Only a plain connect's token takes the proved route: a setup
    // code, and setup's reuse of a saved pairing, ask for read there.
    // There is no switch for it (docs/decisions.md, 2026-11-25): a host that allows writes and keeps
    // this device's credentials in secure storage asks for the six at a first pairing there.
    const full = !this.options.readOnly;
    // A gateway set up through local connect: every socket of this connection is the host's
    // proved one, once setup's own sockets end; false when the host can't prove it.
    const route =
      typeof settings.route !== "string"
        ? null
        : (this.options.localConnect?.(settings.url, settings.route) ?? false);
    this.savedRoute = route === null ? null : { url: settings.url, sockets: route };
    const proved = !this.setupIntent && !this.setupCode && this.socketsProved(settings.url);
    const routed = full && (protectedGatewayUrl(settings.url) || proved);
    // Every socket of this connection, retries included, is the proved route's, also after
    // setup's check ends at its first read: a full pairing's token never falls back to the
    // host's own socket here.
    const provedSocket =
      proved && this.setupCheck?.createSocket
        ? {
            createSocket: this.setupCheck.createSocket,
            prove: this.setupCheck.prove,
            refusal: this.setupCheck.refusal,
          }
        : undefined;
    const secure = routed ? await this.secureCredentials() : false;
    if (generation !== this.generation) return;
    this.fullAccess = routed && secure;
    // The same device at another spelling of this address is the same pairing (§6): a protected
    // address with no record of its own uses the one saved at another wss:// spelling of its
    // endpoint.
    // Only a protected address, whatever else may ask for the six: a token moves toward wss://.
    this.tokenAlias = null;
    const offerable = this.fullAccess && protectedGatewayUrl(settings.url);
    const spelling = offerable ? await this.pairingSpelling(settings.url, identity.deviceId) : null;
    if (generation !== this.generation) return;
    if (spelling) this.tokenAlias = { url: settings.url, spelling };
    // Read first, kept only while this open is current: a superseded read never lands.
    const offerAnswer = offerable
      ? await this.loadOfferAnswer(settings.url, identity.deviceId)
      : null;
    if (generation !== this.generation) return;
    this.offerAnswer = offerAnswer;
    const stored = await this.loadToken(settings.url, identity.deviceId, "operator");
    if (generation !== this.generation) return;
    // Reopening the same gateway keeps what is on screen until fresh data arrives.
    const sameGateway = this.state.connection.gatewayUrl === settings.url;
    const hasData = sameGateway && this.state.bots.length > 0;
    if (!sameGateway) {
      this.computer.reset();
      this.rows = new Map();
      this.raw.clear();
      // Work kept for another gateway's tasks is never carried to this one.
      this.retained.clear();
      this.forgetGatewayState();
    }
    this.everConnected = hasData;
    this.store.update((state) => ({
      ...(sameGateway
        ? state
        : {
            ...initialState,
            turnLimitMinutes: this.turnLimitMs / 60_000,
            showChannelChats: this.showChannelChats,
            showOtherToolSessions: this.showOtherToolSessions,
            showGatewayBot: this.showGatewayBot,
          }),
      connection: {
        ...initialConnectionState,
        target: this.target,
        status: hasData ? "reconnecting" : "connecting",
        gatewayUrl: settings.url,
        deviceId: identity.deviceId,
        // Not paired yet: only a hello says so, since a saved token may be one the gateway refuses.
        requestedScopes: this.scopesToAsk(settings.url, stored),
        upgrade: sameGateway ? state.connection.upgrade : initialScopeUpgrade,
        // A setup connection publishes only what its own hello reports (`setupVersion`), so an
        // earlier connection's version or update report isn't carried into one, even to the same
        // address (the setup contract).
        serverVersion:
          sameGateway && !this.isSetup(settings.url) ? state.connection.serverVersion : null,
        openclawUpdate:
          sameGateway && !this.isSetup(settings.url) ? state.connection.openclawUpdate : null,
        gatewayId: sameGateway ? state.connection.gatewayId : null,
      },
      transcripts: sameGateway
        ? state.transcripts
        : Object.fromEntries(
            [...this.openSessions.keys()].map((key) => [key, this.emptyTranscript(key)]),
          ),
    }));

    // A host can stop or replace this connection from the state notification above.
    if (generation !== this.generation) return;

    const owner = Symbol();
    const key = this.tokenKey(settings.url, identity.deviceId, "operator");
    const tokenStore = this.connectionTokenStore(settings.url, generation, owner);
    const lifecycle = new GatewayBrowserDeviceAuthLifecycle({
      loadIdentity: async () => {
        const loaded = await this.loadIdentity();
        return { ...loaded, sign: (payload) => this.host.signer.sign(payload) };
      },
      tokenStore,
      nowMs: () => this.now(),
    });
    this.auth = { url: settings.url, generation, tokenStore, lifecycle };

    const client = {
      id: CLIENT_ID,
      displayName: this.host.client.displayName,
      version: this.host.client.version,
      platform: this.host.client.platform,
      mode: CLIENT_MODE,
    } as const;
    const reconnect = this.options.reconnect ?? { initialMs: 1000, maxMs: 30_000 };
    // The current socket, with its setup listener reads: the read started as it opened, which its
    // plan waits for, and the signal both reads share, ended when the socket closes or their time is up.
    type SocketReads = {
      check: ClawtrateClient["setupCheck"];
      /** The host's second proof of this socket, asked last before its credential (local connect). */
      prove: ((signal: AbortSignal) => Promise<boolean>) | undefined;
      reads: AbortController;
      /** Settles when the reads end: the socket closed or was replaced, or their time is up. */
      ended: Promise<false>;
      end: () => void;
      timer: ReturnType<typeof setTimeout> | null;
      closed: boolean;
      ours: () => boolean;
      openRead: Promise<boolean> | null;
    };
    let current: SocketReads | null = null;
    /** `refusals` as the plan last read the saved token. */
    let refusalsAtRead = 0;
    /** `rotations` as the plan first read the saved token. */
    let rotationsAtPlan = 0;
    const endReads = (reads: SocketReads | null) => {
      if (!reads) return;
      if (reads.timer) clearTimeout(reads.timer);
      reads.reads.abort();
      reads.end();
    };

    this.protocol = new GatewayProtocolClient<Plan>({
      createSocket: (handlers) => {
        // Asked again before every attempt, including the protocol's own
        // retries: a gateway that stops being allowed is never reopened, and
        // throwing here ends the retries.
        if (!this.isAllowed(settings.url)) {
          if (generation === this.generation) {
            this.setConnection({
              status: "error",
              retryAt: null,
              error: {
                code: "GATEWAY_NOT_ALLOWED",
                message: new GatewayNotAllowedError(settings.url).message,
                hint: null,
              },
            });
          }
          throw new GatewayNotAllowedError(settings.url);
        }
        this.attemptGreeted = false;
        // An attempt is under way: no retry is waiting any more.
        if (this.state.connection.retryAt !== null) this.setConnection({ retryAt: null });
        // A setup connection opens no socket once its endpoint stops passing the host's check,
        // asked last, with nothing run between it and the socket.
        if (this.setupEndpointFails(settings.url, generation))
          throw new Error("the setup connection's endpoint changed");
        let socket: WebSocketLike;
        endReads(current);
        current = null;
        const check = this.setupCheck?.url === settings.url ? this.setupCheck : null;
        // The setup's own proved sockets, with their last proof, retries after its check ended
        // included; else, for a gateway saved with a route, the host's proved route.
        const own = check?.createSocket
          ? { createSocket: check.createSocket, prove: check.prove, refusal: check.refusal }
          : provedSocket;
        const fromRoute = own ? null : route;
        // A gateway set up through local connect opens no socket the host can't prove.
        if (fromRoute === false) {
          if (generation === this.generation)
            this.setConnection({
              status: "error",
              retryAt: null,
              error: {
                code: "LOCAL_UNVERIFIED",
                message: `Clawtrate couldn't verify what is listening at ${hostOf(settings.url)}.`,
                hint: LOCAL_WAY_ON,
              },
            });
          throw new Error("this gateway's sockets can't be proved");
        }
        try {
          const create = own?.createSocket ?? (fromRoute ? fromRoute.createSocket : undefined);
          // Whose proof speaks for this connection's sockets, should one refuse them.
          this.socketRefusal = {
            url: settings.url,
            refusal: own?.refusal ?? (fromRoute ? fromRoute.refusal : undefined) ?? null,
          };
          socket = create ? create(settings.url) : this.host.createWebSocket(settings.url);
        } catch (error) {
          // A setup socket that couldn't start is a terminal path: its code goes.
          if (this.isSetup(settings.url)) this.dropSetupCredentials();
          throw error;
        }
        let end = () => {};
        const ended = new Promise<false>((resolve) => (end = () => resolve(false)));
        const mine: SocketReads = {
          check,
          prove: own ? own.prove : fromRoute ? fromRoute.verify : undefined,
          reads: new AbortController(),
          ended,
          end,
          timer: null,
          closed: false,
          ours: () => false,
          openRead: null,
        };
        current = mine;
        this.writes.owners.set(key, owner);
        // Closing or replacing this connection stops its socket's reads too.
        this.endSocketReads = () => endReads(mine);
        // Still this socket of this connection, open, with the setup check it opened under.
        const ours = () =>
          !mine.closed &&
          current === mine &&
          generation === this.generation &&
          this.setupCheck === check;
        mine.ours = ours;
        socket.onopen = () => {
          // A setup socket reads the endpoint's listener again as soon as it is up, within the
          // time both its reads share.
          if (check?.verify && ours()) {
            mine.timer = setTimeout(
              () => endReads(mine),
              this.options.setupListenerReadsMs ?? SETUP_LISTENER_READS_MS,
            );
            mine.openRead = this.setupListenerHolds(check, mine, ours).then((holds) => {
              // A read that failed closes its own socket at once, challenge or not; it ends
              // the connection only while that socket is still the connection's.
              if (!holds) {
                const end = ours();
                socket.close();
                if (end) this.close();
              }
              return holds;
            });
          }
          handlers.open();
        };
        socket.onmessage = (event) => handlers.message(String(event.data));
        socket.onclose = (event) => {
          // A closed socket's reads stop, and whatever they started with them.
          mine.closed = true;
          if (current === mine && this.writes.owners.get(key) === owner)
            this.writes.owners.delete(key);
          endReads(mine);
          handlers.close(event.code, event.reason);
        };
        socket.onerror = () => handlers.error(new Error("WebSocket error"));
        return {
          isOpen: () => socket.readyState === 1,
          send: (data) => socket.send(data),
          close: (code, reason) => socket.close(code, reason),
        };
      },
      createRequestId: () => this.randomId(),
      buildConnectPlan: async ({ nonce, challengeTs, assertCurrent }) => {
        // The socket this plan is for. After every wait the plan is still that socket's, of this
        // connection, or it reads, publishes and closes nothing: a replacement is left alone.
        const mine = current;
        const stillCurrent = () => {
          assertCurrent();
          if (generation !== this.generation || current !== mine)
            throw new Error("the connection was replaced");
        };
        rotationsAtPlan = this.writes.rotations.get(key) ?? 0;
        const token = await this.loadToken(settings.url, identity.deviceId, "operator");
        stillCurrent();
        // A token saved over a proved route goes only on a socket of that route, proved again
        // last (local connect): never on a typed address's, or once the settings lost the route.
        const offRoute = (held: StoredDeviceToken | null) =>
          held?.route !== undefined && (settings.route !== held.route || !mine?.prove);
        if (offRoute(token)) {
          this.close();
          this.setConnection({
            status: "error",
            retryAt: null,
            error: {
              code: LOCAL_ROUTE_ONLY,
              message:
                "This device is paired for This computer, so it doesn't use that pairing at a typed address. No credential was sent.",
              hint: "Choose This computer to connect to it.",
            },
          });
          throw new Error("this device's token goes only through the route it was saved over");
        }
        if (token && !this.writes.grants.has(key)) this.writes.grants.set(key, grantBits(token));
        // A saved token this attempt used is gone: lost, so no full pairing replaces it by itself.
        if (token) this.planHadToken = true;
        else if (this.planHadToken) this.endEligibility();
        // After the wait for the token: the setup endpoint still passes, or nothing is signed.
        if (this.setupEndpointFails(settings.url, generation)) {
          this.close();
          throw new Error("the setup connection's endpoint changed");
        }
        // The listener as this socket opened: the one the look found, or nothing is signed.
        const opened = mine?.openRead;
        if (opened) {
          const holds = await opened;
          stillCurrent();
          if (!holds) throw new Error("the setup connection's endpoint changed");
        }
        this.heldToken = token?.token ?? null;
        const setup = this.isSetup(settings.url);
        // A new pairing, keyed on the host's pending code for this address whether or not it has
        // run out; a reuse, on the person's consent to reuse this device's saved pairing.
        const newPairing = setup && this.setupCode?.url === settings.url;
        const reuse = setup && !newPairing && this.setupIntent?.reuse === true;
        // A new pairing that finds a saved token for this address sends neither: the person
        // agreed to a new pairing, so the card asks whether to reuse that one.
        // A new pairing's code the gateway refused is used up for good: a Retry after it sends
        // no pairing saved since, and nothing else, and the card asks for a new consent.
        const refused =
          setup && this.setupIntent?.reuse === false && this.setupIntent.refusal === "invalid-code";
        if ((newPairing || refused) && token) {
          this.pairingAppeared();
          throw new Error("a saved pairing appeared");
        }
        if (refused) {
          this.close();
          this.setConnection({
            status: "error",
            retryAt: null,
            error: {
              code: "AUTH_BOOTSTRAP_TOKEN_INVALID",
              message: "The one-time code didn't work.",
              hint: null,
            },
          });
          throw new Error("the setup code was refused");
        }
        // A setup reuse whose token is gone sends nothing: the person consents again.
        if (reuse && !token) {
          this.pairingGone();
          throw new Error("the saved pairing is gone");
        }
        // The host's one-time code, while it lives, for a device not yet paired with this gateway.
        const code =
          !token && this.setupCode?.url === settings.url && this.now() < this.setupCode.expiresAtMs
            ? this.setupCode.bootstrapToken
            : null;
        // Once paired, the device token is the credential; the bootstrap token is no longer sent.
        // It is the one the settings carry now, not as this socket opened: dropped once a
        // pairing saved this device's token, so a retry after that token is lost sends none.
        const typed = this.settings?.url === settings.url ? this.settings.token : null;
        const bootstrap = token || code ? null : typed;
        // Exactly the scopes this client means to hold, never what the token happens to allow;
        // a setup connection asks for read alone, a token that arrived meanwhile included,
        // unless full access holds.
        const requested = this.scopesToAsk(settings.url, token);
        const plan = await lifecycle.buildPlan({
          client,
          role: "operator",
          defaultScopes: requested,
          ...(code ? { bootstrapToken: code, bootstrapScopes: requested } : {}),
          ...(bootstrap ? { token: bootstrap } : {}),
          nonce,
          challengeTs: challengeTs ?? null,
        });
        stillCurrent();
        // After the wait for the signature: the setup endpoint still passes, or nothing is sent.
        if (this.setupEndpointFails(settings.url, generation)) {
          this.close();
          throw new Error("the setup connection's endpoint changed");
        }
        // The plan as the lifecycle chose it, which may have read the store again, against the
        // consent given: a new pairing sends its code and never a stored token, a reuse sends
        // this device's token and nothing else.
        this.planMatchesConsent(plan, newPairing, reuse);
        // Just before the frame that carries the credential: the listener read again, within the
        // time this socket's reads share and stopped with the plan.
        if (setup) {
          const holds = mine ? await this.setupListenerHolds(mine.check, mine, mine.ours) : false;
          stillCurrent();
          if (!holds) {
            this.close();
            throw new Error("the setup connection's endpoint changed");
          }
        }
        // The saved token as it is after the last wait: still what the person agreed to, and still
        // the token the plan carries. One refused or replaced meanwhile is never sent, and the next
        // attempt plans again. A refusal accepted after this read stops the frame itself.
        const fullFirst = !token && requested.some((scope) => !READ_SCOPES.includes(scope));
        if (setup || plan.selectedAuth.usingStoredDeviceToken || fullFirst) {
          refusalsAtRead = this.writes.refusals;
          const saved = await this.loadToken(settings.url, identity.deviceId, "operator");
          stillCurrent();
          if (newPairing && saved) {
            this.pairingAppeared();
            throw new Error("a saved pairing appeared");
          }
          if (reuse && !saved) {
            this.pairingGone();
            throw new Error("the saved pairing is gone");
          }
          if (
            plan.selectedAuth.usingStoredDeviceToken &&
            (saved?.token.trim() !== plan.selectedAuth.storedToken || offRoute(saved))
          )
            throw new Error("the saved device token changed");
          // The signed scopes against what the saved record holds now: a grant narrowed or a
          // pairing that appeared since the plan means another plan.
          const now = this.scopesToAsk(settings.url, saved);
          if (!setup && now.join(",") !== requested.join(","))
            throw new Error("the saved grant changed since the plan");
        }
        // The signed payload covers these scopes, so check them before sending.
        if (plan.scopes.join(",") !== requested.join(",")) {
          throw new Error(`refusing to request scopes ${plan.scopes.join(", ")}`);
        }
        // Last, after the plan's final read: the host proves the far end of this very socket
        // again (local connect), so nothing but the send follows the proof. A refusal sends
        // nothing; a setup socket's ends its setup as a change, any other's is retried.
        if (mine?.prove) {
          const signal = mine.reads.signal;
          const holds =
            !signal.aborted &&
            (await Promise.race([mine.prove(signal).catch(() => false), mine.ended]));
          stillCurrent();
          if (!holds || signal.aborted) {
            if (setup && mine.check && mine.ours()) {
              this.setupEndpointChanged(mine.check.url, generation);
              this.close();
            }
            throw new Error("the far end of this socket couldn't be proved again");
          }
        }
        this.setConnection({ requestedScopes: [...requested] });
        return plan;
      },
      buildConnectParams: (plan) => {
        // The protocol calls this synchronously when it sends the plan. Signing and the final
        // storage read may have outlasted the code or the listener the person confirmed.
        if (this.setupEndpointFails(settings.url, generation)) {
          this.close();
          throw new Error("the setup connection's endpoint changed");
        }
        const code = this.setupCode;
        if (code?.url === settings.url && this.now() >= code.expiresAtMs) {
          this.setupEndpointChanged(settings.url, generation);
          this.close();
          throw new Error("the setup code ran out");
        }
        // The dialog deadline applies to the first send, including a saved token's.
        const consent = this.setupCheck?.url === settings.url ? this.setupCheck.consent : undefined;
        if (consent && this.isSetup(settings.url) && !consent()) {
          this.setupEndpointChanged(settings.url, generation);
          this.close();
          throw new Error("the setup consent ran out");
        }
        // The protocol sends a microtask after the plan's last read: a refusal accepted in between
        // may name this token, so none goes, and the next attempt plans again.
        if (plan.selectedAuth.usingStoredDeviceToken && this.writes.refusals !== refusalsAtRead)
          throw new Error("a device token was refused since the plan's last read");
        return {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client,
          role: plan.role,
          scopes: plan.scopes,
          caps: capsFor(plan.scopes),
          ...(plan.auth ? { auth: plan.auth } : {}),
          ...(plan.device ? { device: plan.device } : {}),
          locale: "en-US",
          userAgent: `clawtrate/${this.host.client.version}`,
        };
      },
      onConnectHello: async (hello, context) => {
        // Still the protocol's current socket: one replaced since, on this same address and
        // connection, stages, writes and saves nothing, after any of these waits.
        const live = () => {
          try {
            context.assertCurrent();
            return true;
          } catch {
            return false;
          }
        };
        // The lifecycle's acceptHello (a read of the saved record, then a store of the hello's
        // token), with this socket's liveness asked before the store and before its write.
        const issued = hello.auth?.deviceToken?.trim();
        // A first full pairing keeps a grant only from a valid hello; anything else writes nothing.
        const fullAsk = context.plan.scopes.some((scope) => !READ_SCOPES.includes(scope));
        // The grant's shape: enough to narrow a saved record, an empty grant included. A first
        // full pairing keeps nothing from an empty grant (in `save`).
        const grantValid = grantShapeValid(hello);
        if (issued && context.plan.identity && (grantValid || !fullAsk || !this.fullAccess)) {
          const role = hello.auth?.role ?? context.plan.role;
          const ids = { clientId: context.plan.clientId, deviceId: context.plan.identity.deviceId };
          const stored = await tokenStore.load({ ...ids, role });
          if (!live()) return;
          // A token rotated since this socket planned retires the one this hello carries, and a
          // refusal accepted since its last read may have named the token it echoes, removed by
          // now. Either way the hello leaves the saved token as it is.
          const sent = context.plan.selectedAuth.usingStoredDeviceToken
            ? context.plan.selectedAuth.storedToken
            : undefined;
          await tokenStore.save(
            {
              ...ids,
              role,
              token: issued,
              scopes: stored?.token === issued ? stored.scopes : (hello.auth?.scopes ?? []),
            },
            live,
            () =>
              (this.writes.rotations.get(key) ?? 0) === rotationsAtPlan &&
              !(issued === sent && this.writes.refusals !== refusalsAtRead),
            grantValid
              ? { asked: context.plan.scopes, granted: hello.auth.scopes ?? [] }
              : undefined,
          );
        }
        // A pairing made by this hello, not one this device kept: whatever a screen read before
        // was read under another pairing, so the host's target is new.
        if (
          issued &&
          !context.plan.selectedAuth.usingStoredDeviceToken &&
          generation === this.generation &&
          live()
        ) {
          this.target += 1;
          this.setConnection({ target: this.target });
        }
        // A full pairing's record narrows to what this hello granted of what was signed for,
        // whether or not the token changed.
        // A hello with a replacement token narrowed its record in that token's write, above.
        if (!issued && grantValid && context.plan.identity && live()) {
          const ids = { deviceId: context.plan.identity.deviceId, role: hello.auth.role };
          const granted = hello.auth.scopes ?? [];
          const asked = context.plan.scopes;
          // The token this hello is about: the one it issued, or else the one it was sent.
          const about = (
            issued ??
            (context.plan.selectedAuth.usingStoredDeviceToken
              ? context.plan.selectedAuth.storedToken
              : undefined)
          )?.trim();
          await this.changeConnection(async () => {
            if (!live() || generation !== this.generation || this.settings?.url !== settings.url)
              return;
            // As for a save: nothing once a rotation or another connection on this store retired
            // this socket's token, and only the record of the token this hello concerns.
            if ((this.writes.rotations.get(key) ?? 0) !== rotationsAtPlan) return;
            if (!tokenStore.ownsToken(ids.deviceId, ids.role)) return;
            const record = await this.loadToken(settings.url, ids.deviceId, ids.role);
            // Everything again after that read: it may have waited while another socket took over.
            if (!live() || generation !== this.generation || this.settings?.url !== settings.url)
              return;
            if ((this.writes.rotations.get(key) ?? 0) !== rotationsAtPlan) return;
            if (!tokenStore.ownsToken(ids.deviceId, ids.role)) return;
            if (!record?.fullGrant || about === undefined || record.token.trim() !== about) return;
            const held = narrowedHeld(record.heldScopes, { asked, granted });
            if (held.length === record.heldScopes.length) return;
            await this.writeToken(settings.url, ids.deviceId, ids.role, {
              ...record,
              heldScopes: held,
              grantedScopes: record.grantedScopes.filter((scope) => held.includes(scope)),
            });
          });
        }
        if (!live()) return;
        // Only this connection may drop this gateway's bootstrap secret.
        if (generation !== this.generation || this.settings?.url !== settings.url) return;
        // A hello is in: the dialog's consent is used, and later retries don't ask it again.
        if (this.setupCheck?.url === settings.url) delete this.setupCheck.consent;
        const gate = this.tokenGate;
        if (gate?.generation === generation) {
          // The code is used: it is forgotten whatever the grant.
          this.tokenGate = null;
          this.setupCode = null;
          // Another protocol: nothing is written, and the protocol notice says so (onHello).
          if (hello.protocol !== PROTOCOL_VERSION) return;
          const staged = gate.staged;
          const grant = setupGrant(hello, context.plan.scopes);
          if (grant === "other" || staged === null || staged.role !== "operator") {
            this.refuseSetupGrant();
            return;
          }
          // Still the setup's endpoint, or no token is kept.
          if (this.setupEndpointFails(settings.url, generation)) {
            this.close();
            return;
          }
          // The token stays a credential to take out of gateway text after its staging ends.
          this.heldToken = staged.token;
          // A record saved meanwhile keeps what it holds, as a replacement token does. Queued
          // with every other token change, so a late rejection cannot remove it.
          const written = await this.changeConnection(async () => {
            const existing = await this.loadToken(settings.url, staged.deviceId, staged.role);
            if (!live() || generation !== this.generation || this.settings?.url !== settings.url)
              return false;
            if (
              !tokenStore.ownsToken(staged.deviceId, staged.role) ||
              (this.writes.rotations.get(key) ?? 0) !== rotationsAtPlan
            ) {
              // Another connection on this store opened since, or an approved access request
              // rotated this token, which the setup's token mustn't replace. So the pairing isn't
              // saved and the one-time code is used. Setup ends here and asks for a new consent, as
              // when the saved pairing changes: no retry sends a token the person didn't agree to.
              this.endChangedPairing();
              this.setConnection({
                status: "error",
                retryAt: null,
                error: {
                  code: SETUP_PAIRING_UNSAVED,
                  message:
                    "Another connection from this device started while the pairing was being saved, so it wasn't saved.",
                  hint: null,
                },
              });
              return false;
            }
            // A first full pairing holds exactly what the gateway granted of what it asked for.
            await this.writeToken(
              settings.url,
              staged.deviceId,
              staged.role,
              !existing && grant === "within"
                ? fullRecord(staged.token, staged.scopes, context.plan.scopes)
                : existing?.fullGrant
                  ? {
                      ...existing,
                      token: staged.token,
                      heldScopes: narrowedHeld(existing.heldScopes, {
                        asked: context.plan.scopes,
                        granted: staged.scopes,
                      }),
                    }
                  : {
                      token: staged.token,
                      grantedScopes: [...staged.scopes],
                      heldScopes: existing ? [...existing.heldScopes] : [...READ_SCOPES],
                      ...(existing?.adminHeld ? { adminHeld: true } : {}),
                      ...(existing?.pairingHeld ? { pairingHeld: true } : {}),
                    },
            );
            // This attempt holds a token now: losing it later ends its full pairing.
            this.planHadToken = true;
            return true;
          });
          if (!written) return;
          // Queued with Connect and Disconnect, so it never saves a gateway forgotten meanwhile.
          await this.changeConnection(async () => {
            const current = this.settings;
            if (!live() || generation !== this.generation || current?.url !== settings.url) return;
            const choice = this.setupMaySave(settings.url);
            if (choice === null) return;
            await this.saveChoice(current, choice);
          });
          return;
        }
        // A setup that reused this device's pairing saves its gateway once its hello is in.
        const reuse = this.setupIntent?.url === settings.url && this.setupIntent.reuse;
        // Queued with Connect and Disconnect, so it never writes back a gateway forgotten meanwhile.
        await this.changeConnection(async () => {
          // Only this connection may drop this gateway's bootstrap secret.
          const current = this.settings;
          if (!live() || generation !== this.generation || current?.url !== settings.url) return;
          if (reuse) {
            if (this.setupEndpointFails(settings.url, generation)) {
              this.close();
              return;
            }
            const choice = this.setupMaySave(settings.url);
            if (choice === null) return;
            await this.saveChoice(current, choice);
            return;
          }
          // A Connect over a proved route replaces the saved gateway at its first paired hello,
          // also one that sent no token because this device was already paired there.
          const replaces = () =>
            this.replacing?.url === settings.url && current.route !== undefined;
          if (!current.token && !replaces()) return;
          // Paired, by this hello or an earlier one: the device token replaces the bootstrap secret.
          // Only a token saved here counts. A hello's token that wasn't saved, because another
          // socket on this store opened since, leaves the secret, so a restart can still connect.
          const paired =
            (await this.loadToken(settings.url, identity.deviceId, "operator")) !== null;
          if (!paired || !live()) return;
          // A Connect over a proved route replaces the saved gateway now, paired, and saves no
          // copy of the token it was paired with: the record was the earlier gateway's until here.
          if (replaces()) {
            const choice = this.setupMaySave(settings.url);
            if (choice === null) return;
            await this.saveChoice({ ...current, token: null }, choice);
            this.replacing = null;
            if (this.typedAttempt?.url === settings.url) this.typedAttempt = null;
            return;
          }
          if (!current.token) return;
          try {
            // Read at the moment of the write: another client on this store may have saved a
            // different gateway, forgotten this one or changed its record since. Only this
            // hello's secret goes, from the record as it is now.
            const saved = await this.savedSettings();
            if (saved?.url !== settings.url || !live()) return;
            if (saved.token === current.token) {
              // This client's settings take the record it wrote, with what another client
              // changed in it, a suspension for one, so Reconnect lifts that suspension.
              await this.writeRecord({ ...saved, token: null });
              this.settings = { ...saved, token: null };
            } else this.settings = { ...current, token: null };
            // A gateway set up over a proved route keeps no copy of the token it was paired with,
            // here or in the attempt: it is the person's own OpenClaw's token, read from its
            // settings for this pairing only, and its route reconnects with this device's token.
            if (current.route === undefined)
              this.writes.retiredShared.set(settings.url, current.token);
            else if (this.typedAttempt?.url === settings.url) this.typedAttempt = null;
          } catch {
            // The settings keep the secret, so the next hello tries again; this one goes on.
            this.log("warn", "Could not remove the shared gateway token from this device.");
          }
        });
      },
      onHello: (hello) => {
        if (generation !== this.generation) return;
        this.epoch += 1;
        this.endConnection();
        this.attemptGreeted = true;
        if (hello.protocol !== PROTOCOL_VERSION) {
          // Outside this client's range: nothing else is asked of this gateway.
          const protocol = { gateway: hello.protocol, client: PROTOCOL_VERSION };
          this.close();
          this.setConnection({
            status: "error",
            retryAt: null,
            protocol: hello.protocol,
            serverVersion: this.isSetup(settings.url)
              ? setupVersion(hello.server.version)
              : hello.server.version,
            error: {
              code: "PROTOCOL_MISMATCH",
              message: protocolMessage(protocol),
              hint: null,
              protocol,
            },
          });
          return;
        }
        this.handleHello(hello, generation);
      },
      onConnectFailure: async (error, context) =>
        this.handleConnectFailure(
          error,
          identity.deviceId,
          settings.url,
          tokenStore,
          generation,
          context.plan,
        ),
      resolveClose: (context) => {
        // A socket of a saved route that the host's proof refused: not retried (onClose).
        if (this.routeRefusal(settings.url)) return { retry: false, notify: true };
        // A setup connection that ended before its hello is not retried and its code is
        // forgotten, unless the gateway is waiting for its owner to approve this device.
        const setup = this.tokenGate?.generation === generation;
        if (setup && this.state.connection.status !== "pairing") this.setupCode = null;
        return {
          retry: !(setup && this.setupCode === null),
          notify: true,
          ...(context.connectFailure?.reconnectDelayMs !== undefined
            ? { reconnectDelayMs: context.connectFailure.reconnectDelayMs }
            : {}),
        };
      },
      onClose: () => {
        if (generation !== this.generation) return;
        this.epoch += 1;
        this.endConnection();
        this.discoveryRead = null;
        // The next socket's first roster is its own, as after an explicit close.
        this.lastRosterIds.clear();
        this.lastRoster = "none";
        this.selectionReady = -1;
        this.streams.clear();
        this.computer.connectionLost();
        this.accounts.onClose();
        this.invalidateCheckIns();
        this.routines.onClose();
        this.usage.onClose();
        this.openclawUpdates.onDisconnect();
        this.deviceApprovals.onClose();
        const status = this.state.connection.status;
        // The host refused a socket of this gateway's route: its words, and the way on.
        const refused = this.routeRefusal(settings.url);
        if (refused) {
          this.setConnection({
            status: "error",
            retryAt: null,
            error: { code: "LOCAL_UNVERIFIED", message: refused, hint: LOCAL_WAY_ON },
          });
          return;
        }
        if (status !== "pairing" && this.tokenGate?.generation === generation) {
          // The setup connection ended before its hello: its code is forgotten and it stops.
          this.setupCode = null;
          this.setConnection({
            status: "error",
            retryAt: null,
            ...(this.state.connection.error || this.attemptGreeted
              ? {}
              : {
                  error: {
                    code: "UNREACHABLE",
                    message: `Nothing answered at ${hostOf(settings.url)}.`,
                    hint: "Check that the gateway is running and that the address is right.",
                  },
                }),
          });
          return;
        }
        if (status !== "pairing" && status !== "error") {
          // Once this gateway has answered, every later drop is a reconnect, not a first connect.
          // An attempt that never got an answer says so, unless the gateway gave a reason.
          const unanswered =
            !this.attemptGreeted && !this.state.connection.error
              ? {
                  error: {
                    code: "UNREACHABLE",
                    message: `Nothing answered at ${hostOf(settings.url)}.`,
                    hint: "Check that the gateway is running and that the address is right.",
                  },
                }
              : {};
          this.setConnection({
            status: this.everConnected ? "reconnecting" : "connecting",
            ...unanswered,
            // No connection, no effective access; the next hello says what is granted.
            canWrite: false,
            canAnswer: false,
            canApprove: false,
            canAdmin: false,
          });
        }
      },
      onReconnectScheduled: (delayMs) => {
        if (generation !== this.generation) return;
        this.setConnection({ retryAt: this.now() + delayMs });
      },
      onReconnectStopped: (error) => {
        if (generation !== this.generation) return;
        this.rejectAccessWaiters(new Error(`The connection stopped: ${error.message}`));
        if (this.state.connection.status !== "error") {
          this.setConnection({
            status: "error",
            retryAt: null,
            error: { code: "STOPPED", message: error.message, hint: null },
          });
        }
      },
      onConnectError: (error) => {
        if (generation !== this.generation || !isRetryableNetworkFailure(error)) return;
        this.log("warn", `connection attempt failed: ${error.message}`);
      },
      // The protocol client closes the socket after a gap; the reconnect reloads open tasks.
      onGap: ({ expected, received }) => {
        if (generation !== this.generation) return;
        this.log("warn", `event gap: expected ${expected}, received ${received}`);
        this.pendingResync = "gap";
      },
      onEvent: (event) => {
        if (generation === this.generation) this.handleEvent(event, generation);
      },
      onCallbackError: (label, error) => this.log("error", `${label}: ${String(error)}`),
      handshake: { mode: "require-challenge", timeoutMs: DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS },
      requestTimeoutMs: this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      reconnect: { initialMs: reconnect.initialMs, multiplier: 2, maxMs: reconnect.maxMs },
    });
    this.protocol.start();
  }

  /** What one gateway reported that must never be read against another. */
  private forgetGatewayState(): void {
    this.accounts.reset();
    this.botNames.reset();
    this.openclawUpdates.reset();
    this.deviceApprovals.reset();
    if (this.state.checkIns) this.store.update(({ checkIns: _, ...state }) => state);
    this.routines.reset();
    this.store.update((state) => ({ ...state, usage: initialUsage }));
    // A creation belongs to the gateway it was asked of; it is never asked of another.
    for (const timer of this.creationTimers.values()) clearTimeout(timer);
    this.creationTimers.clear();
    for (const id of [...this.checkingSlots]) this.releaseCheckingSlot(id);
    this.creations.clear();
    for (const waiters of this.creationWaiters.values()) {
      for (const waiter of waiters) waiter.reject(new Error("Switched to another gateway."));
    }
    this.creationWaiters.clear();
    this.unsentStops.clear();
    this.followUps.clear();
    this.approvalOutcomes.clear();
    this.waiting.clear();
    this.quietChecks.clear();
    this.unrouted.clear();
    this.recipients.clear();
    this.spawnedBy.clear();
    this.foreign.clear();
    this.foreignReads.clear();
    this.endChecked.clear();
    this.listRequested.clear();
    this.listApplied.clear();
    this.toolReads.clear();
    this.approvalReads.clear();
    for (const { bytes } of this.attachmentContent.values()) this.attachmentBytes -= bytes;
    this.attachmentContent.clear();
    this.sentPictures.clear();
    this.sentPictureBytes = 0;
    this.readBackPictures.clear();
    this.readBackBytes = 0;
    this.sentSources.clear();
    this.historyReads.clear();
    this.taskNames.clear();
    this.firstMessageTitles.clear();
    this.firstMessageGateway = null;
  }

  private invalidateCheckIns(): void {
    const checkIns = this.state.checkIns;
    if (checkIns?.stamp)
      this.store.update((state) => ({ ...state, checkIns: { ...checkIns, stamp: null } }));
  }

  private close(options?: { keepPendingAnswer: boolean }): void {
    this.generation += 1;
    this.endConnection();
    if (this.reopenTimer !== null) clearTimeout(this.reopenTimer);
    this.reopenTimer = null;
    this.discoveryRead = null;
    this.botsRefresh = null;
    this.lastRosterIds.clear();
    this.lastRoster = "none";
    this.selectionReady = -1;
    this.endSocketReads();
    this.endSocketReads = () => {};
    // The replaced or stopped socket's credential is no longer needed to take it out of text.
    this.heldToken = null;
    this.invalidateCheckIns();
    this.accounts.onClose();
    this.routines.onClose();
    this.usage.onClose();
    this.deviceApprovals.onClose();
    this.protocol?.stop();
    this.protocol = null;
    this.computer.connectionLost(options?.keepPendingAnswer);
    this.streams.clear();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    for (const timer of this.historyTimers.values()) clearTimeout(timer);
    this.historyTimers.clear();
    for (const timer of this.turnTimers.values()) clearTimeout(timer);
    this.turnTimers.clear();
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    // Creations being checked are kept, and checked again after the next hello.
    for (const timer of this.creationTimers.values()) clearTimeout(timer);
    this.creationTimers.clear();
  }

  /** The setup connection was granted more or less than read: disconnect, nothing written. */
  private refuseSetupGrant(): void {
    this.close();
    this.setConnection({
      status: "error",
      retryAt: null,
      canWrite: false,
      canAnswer: false,
      canApprove: false,
      canAdmin: false,
      error: {
        code: SETUP_GRANT_REFUSED,
        message: "The gateway granted something other than read access, so Clawtrate disconnected.",
        hint: null,
      },
    });
  }

  private handleConnectFailure(
    error: GatewayProtocolRequestError,
    deviceId: string,
    url: string,
    tokenStore: ConnectionTokenStore,
    generation: number,
    plan: Plan | undefined,
  ) {
    // A failure of an older connection says nothing about this one.
    if (generation !== this.generation)
      return { closeCode: 1000, closeReason: "superseded", stop: true };
    const details = asRecord(error.details) ?? {};
    const raw = typeof details.code === "string" ? details.code : error.gatewayCode;
    // A setup connection publishes typed outcomes only: the few codes its screens name,
    // fixed words, and nothing else the gateway sent.
    const setup = this.isSetup(url);
    // An ordinary connection publishes the pinned protocol's named codes, and its own for any other.
    const code = setup
      ? namedSetupCode(raw)
        ? raw
        : SETUP_CONNECT_REFUSED
      : NAMED_CONNECT_CODES.has(raw)
        ? raw
        : CONNECT_REFUSED;
    const hint =
      !setup && typeof details.remediationHint === "string" ? details.remediationHint : null;
    const message = setup
      ? code === "AUTH_BOOTSTRAP_TOKEN_INVALID"
        ? "The one-time code didn't work."
        : "The gateway refused the setup connection."
      : error.message;
    // A setup connection keeps its code only while the gateway waits for its owner's approval.
    if (setup && code !== "PAIRING_REQUIRED") this.dropSetupCredentials();
    // A refused code ends this new pairing, apart from the code being used: a Retry can't reuse
    // a pairing saved in the meantime (the plan asks for a new consent instead).
    if (setup && code === "AUTH_BOOTSTRAP_TOKEN_INVALID" && this.setupIntent?.reuse === false)
      this.setupIntent = { ...this.setupIntent, refusal: "invalid-code" };

    const mismatch = protocolMismatch(details);
    if (mismatch) {
      if (setup) this.dropSetupCredentials();
      this.setConnection({
        status: "error",
        pairing: null,
        retryAt: null,
        error: {
          code: "PROTOCOL_MISMATCH",
          message: protocolMessage(mismatch),
          hint,
          protocol: mismatch,
        },
      });
      return { closeCode: 1000, closeReason: "protocol mismatch", stop: true };
    }

    if (code === "PAIRING_REQUIRED") {
      const requestId = typeof details.requestId === "string" ? details.requestId : "";
      // The request this client was waiting on is gone: the gateway's owner
      // rejected it, or it expired. Stop, and let the user ask again. A setup
      // connection keeps only a digest of the id.
      const seen = setup ? digest(requestId) : requestId;
      if (pairingEnded(this.pairingSeen, seen)) {
        this.pairingSeen = null;
        if (setup) this.dropSetupCredentials();
        this.setConnection({
          status: "error",
          pairing: null,
          retryAt: null,
          error: { ...PAIRING_ENDED, hint: null },
        });
        this.endTypedAttempt(url);
        return { closeCode: 1000, closeReason: "pairing request ended", stop: true };
      }
      if (requestId) this.pairingSeen = seen;
      // The gateway keeps this request's six whatever a retry asks (a smaller one only refreshes
      // it), so a first pairing that sent them with consent keeps asking for them while it waits.
      if (
        requestId &&
        plan &&
        !plan.selectedAuth.usingStoredDeviceToken &&
        plan.scopes.some((scope) => !READ_SCOPES.includes(scope))
      )
        this.fullPending = seen;
      // A setup connection shows this device, the scopes it asked for and the gateway's
      // pending-devices instruction, never the request's own fields.
      const scopes =
        setup || this.fullAccess
          ? [...this.state.connection.requestedScopes]
          : Array.isArray(details.requestedScopes)
            ? details.requestedScopes.filter((s): s is string => typeof s === "string")
            : [...this.state.connection.requestedScopes];
      const instructions = (this.host.approvalInstructions ?? defaultApprovalInstructions)(
        url,
        setup ? "" : requestId,
      );
      this.setConnection({
        status: "pairing",
        error: null,
        pairing: {
          requestId: setup ? "" : requestId,
          deviceId: !setup && typeof details.deviceId === "string" ? details.deviceId : deviceId,
          message: hint ?? "Approve this device from the gateway's pending pairing requests.",
          approveCommand: instructions.command,
          approveNote: instructions.note,
          requestedScopes: scopes,
          // From this device's own key and the gateway's id for its request (`pairCode`).
          code: this.identity ? pairCode(this.identity.publicKey, requestId) : null,
        },
      });
      // The request id stays the same while we retry, so keep trying quietly
      // and connect as soon as an operator approves it.
      const nextStep = details.recommendedNextStep;
      const terminal = nextStep !== undefined && nextStep !== "wait_then_retry";
      if (terminal) this.endTypedAttempt(url);
      if (terminal && setup) {
        // Its code is gone and nothing retries: an approval wait that can't end is not shown.
        this.dropSetupCredentials();
        this.pairingSeen = null;
        this.setConnection({
          status: "error",
          pairing: null,
          retryAt: null,
          error: { ...PAIRING_ENDED, hint: null },
        });
        return { closeCode: 1000, closeReason: "pairing request ended", stop: true };
      }
      return {
        closeCode: 1000,
        closeReason: "awaiting pairing approval",
        reconnectDelayMs: PAIRING_RETRY_MS,
        ...(terminal ? { stop: true } : {}),
      };
    }

    // The gateway's own code: a setup connection publishes a fixed one, and still forgets the token.
    const refused = raw === "AUTH_TOKEN_MISMATCH" || raw === "AUTH_DEVICE_TOKEN_MISMATCH";
    if (refused) {
      // A stored device token was revoked or rotated elsewhere. Forget it so the
      // next attempt can pair again with a bootstrap token, but only that token:
      // one saved since this attempt was sent is newer, and stays. The gateway's
      // refusal stays on screen whether or not the host could remove it.
      const rejected = plan?.selectedAuth.usingStoredDeviceToken
        ? plan.selectedAuth.storedToken
        : undefined;
      if (rejected) {
        tokenStore
          .forget(this.tokenParams(deviceId), rejected)
          .catch(() =>
            this.log("warn", "Could not remove the rejected device token from this device."),
          );
      }
    }

    const pause = setup || shouldPauseGatewayReconnect({ details: error.details });
    this.setConnection({
      status: pause ? "error" : this.everConnected ? "reconnecting" : "connecting",
      pairing: null,
      error: { code, message, hint },
      ...(refused ? { paired: false } : {}),
    });
    // The gateway stopped accepting this device: work waiting for access will not get it on this connection.
    if (pause) {
      this.rejectAccessWaiters(
        new Error(`The gateway refused this device: ${this.scrub(message)}`),
      );
      this.endTypedAttempt(url);
    }
    return {
      closeCode: 1000,
      closeReason: "connect rejected",
      ...(pause ? { stop: true } : {}),
    };
  }

  private handleHello(hello: HelloOk, generation: number): void {
    this.holdSetupUpdate(
      generation,
      this.isSetup(this.settings?.url) ? asRecord(hello.snapshot)?.updateAvailable : null,
    );
    const wasConnected = this.everConnected;
    this.everConnected = true;
    this.pairingSeen = null;
    // A gateway that refused the marker may since have been updated: each connection asks again.
    this.markerRefused = false;
    // Each connection may act for another person: read who again before marking reactions.
    this.selfId = null;
    // The protocol gives a boot id at most 96 characters; anything else names no start.
    const bootId = asRecord(hello.server)?.bootId;
    this.gatewayBootId =
      typeof bootId === "string" && bootId.length > 0 && bootId.length <= 96 ? bootId : null;
    const uptimeMs = asRecord(hello.snapshot)?.uptimeMs;
    this.gatewayStartedAt =
      typeof uptimeMs === "number" && Number.isSafeInteger(uptimeMs) && uptimeMs >= 0
        ? Date.now() - uptimeMs
        : null;
    // Only what this connection asked for is used: the signed request is the ceiling. A
    // wider grant that implies an asked scope supplies it; an unasked scope never enters.
    const asked = this.state.connection.requestedScopes;
    const granted = [...(hello.auth.scopes ?? [])];
    const scopes = asked.filter((scope) =>
      scope === PAIRING_SCOPE ? granted.includes(scope) : scopeSatisfied(granted, scope),
    );
    const canWrite = scopeSatisfied(scopes, WRITE_SCOPE);
    const policy = asRecord(hello.policy);
    const number = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    this.payloadLimits = {
      maxPayload: number(policy?.maxPayload),
      maxImageBytes: number(asRecord(policy?.attachments)?.maxImageBytes),
      maxFileBytes: number(asRecord(policy?.attachments)?.maxBytes),
    };
    // Update is held from this moment until what this device keeps for the gateway is read.
    if (!this.isSetup(this.settings?.url)) this.openclawUpdates.onConnected();
    // In place before anyone hears of the connect: a read of the guides that a subscriber makes
    // on `connected` waits for this connect's own pass (`readBotGuides`).
    let passQueued = () => {};
    this.guidesConnectPass = {
      epoch: this.epoch,
      queued: new Promise<void>((done) => (passQueued = done)),
    };
    this.setConnection({
      status: "connected",
      serverVersion: this.isSetup(this.settings?.url)
        ? setupVersion(hello.server.version)
        : hello.server.version,
      // A setup connection publishes none of the gateway's versions (the setup contract above):
      // its report is held, below, until setup succeeds on this connection.
      openclawUpdate: this.isSetup(this.settings?.url)
        ? null
        : readOpenClawUpdate(asRecord(hello.snapshot)?.updateAvailable),
      protocol: hello.protocol,
      scopes,
      canWrite,
      canAnswer: scopeSatisfied(scopes, QUESTIONS_SCOPE),
      canApprove: scopeSatisfied(scopes, APPROVALS_SCOPE),
      canAdmin: scopes.includes(ADMIN_SCOPE),
      fullPairing: this.fullAccess && this.holdsFullPairing(),
      fullOffer: this.offerFor(scopes),
      pairing: null,
      error: null,
      retryAt: null,
      connectedAt: this.now(),
      paired: true,
      sendLimits: this.sendLimits(),
    });
    // Device access asked for before this hello asks with what this connection holds, and no more.
    if (this.upgradeWanted && this.upgradeTier === "held" && !this.scopeUpgrade)
      this.heldBase = ADMIN_SCOPES.filter((scope) => scopes.includes(scope));
    if (
      this.tierScopes(this.upgradeTier).every((scope) => scopeSatisfied(scopes, scope)) &&
      (!this.pairingWanted || scopes.includes(PAIRING_SCOPE))
    ) {
      this.upgradeWanted = false;
      this.upgradeTier = "interactive";
      this.pairingWanted = false;
    } else if (this.upgradeWanted) {
      this.resumeUpgrade();
    }
    this.settleAccessWaiters();
    this.checkCreations();
    this.checkUnknownDecisions();
    // Whether the computer plugin is loaded comes from the hello's methods; panes that lost a
    // connection while control was held read the browser's leases again before offering anything.
    this.computer.reconnected();
    const methods = asRecord(hello.features)?.methods;
    const listed = Array.isArray(methods)
      ? methods.filter((m): m is string => typeof m === "string")
      : null;
    this.voiceAdvertised = listed === null ? null : listed.includes(VOICE_GET);
    this.computer.hello(listed ?? []);
    if (!this.isSetup(this.settings?.url)) this.deviceApprovals.onHello();
    const reason =
      this.pendingResync ?? (wasConnected && !this.quietReconnect ? "reconnect" : null);
    this.pendingResync = null;
    this.quietReconnect = false;
    const epoch = this.epoch;
    void this.bootstrap(generation, reason)
      .then(() => {
        if (generation !== this.generation || epoch !== this.epoch) return;
        this.accounts.onHello();
        // Every connect reads the list again: runs that started or ended while away are in it.
        if (this.state.connection.status === "connected") void this.routines.load();
        this.usage.onHello();
        if (!this.isSetup(this.settings?.url)) void this.openclawUpdates.onHello();
        void this.keepGuides(generation, epoch);
      })
      // The change is in line by now (keepGuides puts it there before its first await), or won't be.
      .finally(passQueued);
  }

  /** After a connect, read back every approval whose last decision got no answer. */
  private checkUnknownDecisions(): void {
    const ids = new Set<string>();
    for (const transcript of Object.values(this.state.transcripts)) {
      for (const approval of transcript.approvals) {
        if (approval.status === "pending" && approval.decisionError === "unknown")
          ids.add(approval.id);
      }
    }
    // And those no task shows now: their outcome is the approval's, not a task's.
    for (const [id, attempts] of this.approvalAttempts) {
      if (attempts.decisionError === "unknown") ids.add(id);
    }
    for (const id of ids) void this.checkApproval(this.keyShowing(id), id).catch(() => undefined);
  }

  private setDiscovery(patch: Partial<DiscoveryState>): void {
    this.store.update((state) => ({ ...state, discovery: { ...state.discovery, ...patch } }));
  }

  private confirmGatewayIdentity(id: string | null, current: () => boolean): void {
    if (id === null || !current()) return;
    // A route that answers as another gateway is stopped, and that identity isn't published.
    if (this.bindRouteIdentity(id, current) === "changed") return;
    this.accounts.onGateway(id);
    // Clearing another gateway's creation can notify a host that stops the connection.
    if (current() && this.state.connection.gatewayId !== id) this.setConnection({ gatewayId: id });
    // Titles kept from the connection that last confirmed this gateway are its own again. Another
    // gateway at the same address has other tasks under the same keys, and a connection that was
    // never confirmed may have been any gateway's. Those made on this connection are this one's.
    if (current()) {
      const before = this.firstMessageGateway;
      this.firstMessageGateway = { id, epoch: this.epoch };
      let changed = false;
      for (const [key, made] of this.firstMessageTitles) {
        if (made.epoch === this.epoch) continue;
        if (before?.id === id && made.epoch === before.epoch) made.epoch = this.epoch;
        else this.firstMessageTitles.delete(key);
        changed = true;
      }
      if (changed) this.publishTasks();
    }
    if (current()) this.settleReadStamps(id);
    // The guide change after this connection's connect found it unnamed: once, now it is named.
    const unnamed = this.guidesUnnamed;
    if (current() && unnamed?.generation === this.generation && unnamed.epoch === this.epoch) {
      this.guidesUnnamed = null;
      void this.keepGuides(unnamed.generation, unnamed.epoch, { gatewayId: id });
    }
  }

  /** The host's words for why it refused the latest socket of this gateway's route: setup's or saved. */
  private routeRefusal(url: string): string | null {
    const sockets = this.socketRefusal;
    return sockets?.url === url ? (sockets.refusal?.() ?? null) : null;
  }

  /** The proof that speaks for the sockets the current connection opens (`routeRefusal`). */
  private socketRefusal: { url: string; refusal: (() => string | null) | null } | null = null;

  /**
   * A gateway saved with a proved route is the gateway that route first reported
   * (docs/decisions.md, "Routes"): its identity is saved with the route at that hello. One that
   * reports another identity later has this device's token for it dropped and its connection
   * closed, and the route isn't used again until this device pairs there again.
   */
  private bindRouteIdentity(id: string, current: () => boolean): "changed" | void {
    const settings = this.settings;
    const deviceId = this.state.connection.deviceId;
    if (settings?.route === undefined || settings.gatewayId === id) return;
    const { url, route } = settings;
    // The token this connection's socket used, taken before the stop clears it: only that one
    // goes, never a pairing saved since by another connection on this store.
    const used = this.heldToken;
    // Known here to be another gateway: stopped now, before anything is awaited or published.
    if (settings.gatewayId !== undefined) {
      this.stopChangedRoute(url);
      void this.changeConnection(() => this.dropRouteToken(url, deviceId, used));
      return "changed";
    }
    const decided = this.changeConnection(async () => {
      const now = this.settings;
      if (!current() || now?.url !== url || now.route !== route) return false;
      // Decided from the record as it is now: another client on this store may have saved the
      // route's identity since this one read it.
      const saved = await this.savedSettings();
      if (!current() || saved?.url !== url || saved.route !== route) return false;
      const bound = now.gatewayId ?? saved.gatewayId;
      if (bound === undefined) {
        await this.writeRecord({ ...saved, gatewayId: id });
        if (this.settings === now) this.settings = { ...now, gatewayId: id };
        return true;
      }
      if (this.settings === now) this.settings = { ...now, gatewayId: bound };
      if (bound === id) return true;
      this.stopChangedRoute(url);
      await this.dropRouteToken(url, deviceId, used);
      return false;
    }).catch(() => {
      // A record that couldn't be read says nothing of which gateway the route is for: no upkeep
      // write goes until another check reads it.
      this.log("warn", "Could not check which gateway answers on this route.");
      return false;
    });
    this.routeBinding = { epoch: this.epoch, decided };
  }

  /**
   * The route answers as another gateway than the one it is saved with: the connection stops
   * and its eligibility ends, before this device's token for it is dropped (`dropRouteToken`).
   */
  private stopChangedRoute(url: string): void {
    this.endEligibility(url);
    this.close();
    this.setConnection({
      status: "error",
      retryAt: null,
      error: {
        code: ROUTE_IDENTITY_CHANGED,
        message:
          "Another OpenClaw gateway answers on this computer now, so Clawtrate removed this device's pairing for it. Connect again to pair with it.",
        hint: null,
      },
    });
  }

  /**
   * This device's token for a changed route, dropped once the connection has stopped, and only
   * while it is still `used`, the token that connection's socket used: one another connection
   * saved since is a newer pairing, and stays. One that couldn't be dropped is said, and the next
   * hello on the route stops it and tries again.
   */
  private async dropRouteToken(
    url: string,
    deviceId: string | null,
    used: string | null,
  ): Promise<void> {
    if (!deviceId || !used) return;
    const key = this.tokenKey(url, deviceId, "operator");
    try {
      const existing = await this.loadToken(url, deviceId, "operator", true, key);
      if (existing?.token.trim() !== used.trim()) return;
      this.writes.grants.set(key, null);
      await this.host.storage.delete(key);
    } catch {
      this.log("warn", "Could not remove this device's pairing for a route that changed gateway.");
      const { connection } = this.state;
      if (connection.gatewayUrl === url && connection.error?.code === ROUTE_IDENTITY_CHANGED)
        this.setConnection({
          error: {
            code: ROUTE_IDENTITY_CHANGED,
            message:
              "Another OpenClaw gateway answers on this computer now, and Clawtrate couldn't remove this device's pairing for it. Connect again to try again.",
            hint: null,
          },
        });
    }
  }

  /**
   * A list or the accounts read on this connection before its identity was known carry no name:
   * once the gateway names itself on that same connection, so do they, and their rows act again.
   */
  private settleReadStamps(id: string): void {
    const here = (read: ReadStamp | null) =>
      read !== null &&
      read.gatewayId === null &&
      read.target === this.target &&
      read.connectedAt === this.state.connection.connectedAt;
    const { discovery, accounts } = this.state;
    if (!here(discovery.tasksRead) && !here(accounts.readOn)) return;
    this.store.update((state) => ({
      ...state,
      discovery: here(state.discovery.tasksRead)
        ? { ...state.discovery, tasksRead: { ...state.discovery.tasksRead!, gatewayId: id } }
        : state.discovery,
      accounts: here(state.accounts.readOn)
        ? { ...state.accounts, readOn: { ...state.accounts.readOn!, gatewayId: id } }
        : state.accounts,
    }));
  }

  /** Read the identity again, a few times further apart, while this connection lasts without it. */
  private askIdentityAgain(current: () => boolean, attempt: number): void {
    if (attempt >= IDENTITY_RETRIES) return;
    setTimeout(
      () => {
        if (!current() || this.state.connection.gatewayId !== null) return;
        void this.readGatewayIdentity().then((id) => {
          if (id === null) this.askIdentityAgain(current, attempt + 1);
          else this.confirmGatewayIdentity(id, current);
        });
      },
      IDENTITY_RETRY_MS * 4 ** attempt,
    );
  }

  private readGatewayIdentity(): Promise<string | null> {
    const known = this.gatewayIdentity;
    if (known?.epoch === this.epoch) return known.id;
    const gatewayId = this.request("gateway.identity.get", {}).then(
      (result) => {
        const id = asRecord(result)?.deviceId;
        return typeof id === "string" && id ? id : null;
      },
      () => null,
    );
    void gatewayId.then((id) => {
      if (id === null && this.gatewayIdentity?.id === gatewayId) this.gatewayIdentity = null;
    });
    this.gatewayIdentity = { epoch: this.epoch, id: gatewayId };
    return gatewayId;
  }

  /**
   * Every successful connect is a fresh projection: re-list, re-subscribe, reload
   * open transcripts. Bots and tasks load independently, so one failing read
   * keeps the other's result and any data shown before it.
   */
  private async bootstrap(
    generation: number,
    resync: CaughtUp["reason"] | null,
    tries = READ_AGAIN_TRIES,
  ): Promise<void> {
    const selection = this.selectionApplied;
    // Closing the socket or starting another discovery retires this read.
    const epoch = this.epoch;
    const read = { sessionsChanged: false, botsChanged: false };
    this.discoveryRead = read;
    const sameSocket = () => generation === this.generation && epoch === this.epoch;
    const current = () =>
      this.discoveryRead === read && selection === this.selectionApplied && sameSocket();
    // The try the gateway's next event makes (`discoveryAgain`) leaves the failure on screen
    // until it has an answer, so the strip changes only for the news: loaded, or not.
    if (tries > 0) this.setDiscovery({ status: "loading", error: null, detail: null });
    // The last gateway's identity goes with the connection it came from, so a
    // write waits for this one's read (routines.ts `blocked`).
    this.setConnection({ gatewayId: null });
    // The gateway's identity comes with its bots, so what this device keeps
    // per gateway (pins, hidden bots, order) is known when the bots appear.
    const gatewayId = this.readGatewayIdentity();
    // Applied here too, so a bot list that fails or is slow to read does not
    // keep the identity back.
    void gatewayId.then((id) => this.confirmGatewayIdentity(id, sameSocket));
    // Every connection that can read can read it, so a read that failed is asked again:
    // a screen's write waits for the identity rather than going without it.
    void gatewayId.then((id) => {
      if (id === null) this.askIdentityAgain(sameSocket, 0);
    });
    // Bots are published as soon as they arrive, so the app can open on them
    // while tasks are still loading.
    const botsIssued = ++this.botsIssued;
    // A read the gateway answers as passing (it is still starting) is asked again while this
    // read is the current one.
    const [agents, sessions] = await Promise.allSettled([
      this.readAgain(() => this.request("agents.list", {}), current, tries).then(async (result) => {
        const id = await gatewayId;
        if (current()) {
          // A read asked later, after a bot was created, may have answered first.
          const newest = this.newestBots(botsIssued);
          // Only a read that found the identity writes it: an older refresh whose
          // read failed must not clear what a newer one on this connection confirmed.
          if (id !== null)
            this.store.update((state) => ({
              ...state,
              connection: { ...state.connection, gatewayId: id },
            }));
          if (newest) this.applyBots(result);
        }
        return result;
      }),
      this.readAgain(() => this.loadAllSessions(generation, "sessions.subscribe"), current, tries),
    ]);
    if (!current()) return;

    const failures: string[] = [];
    const reasons: unknown[] = [];
    if (agents.status !== "fulfilled") {
      failures.push(`bots: ${errorMessage(agents.reason)}`);
      reasons.push(agents.reason);
    }
    if (sessions.status === "fulfilled") {
      // The rows are this connection's, and so is the identity read on it: settled first, and
      // published only while this read is still the current one.
      const named = await gatewayId;
      if (!current()) return;
      this.replaceRows(
        sessions.value.rows,
        {
          gatewayId: named,
          target: this.target,
          connectedAt: this.state.connection.connectedAt,
        },
        sessions.value.epoch,
      );
      if (read.sessionsChanged) await this.refreshSessions(generation);
    } else {
      failures.push(`tasks: ${errorMessage(sessions.reason)}`);
      reasons.push(sessions.reason);
    }
    if (!current()) return;
    for (const key of Object.keys(this.state.transcripts)) {
      if (this.tracked(key)) void this.loadTranscript(key, true, resync);
    }
    void this.loadSidebar(generation);
    void this.loadWaitingQuestions(generation);
    void this.loadWaitingApprovals(generation);

    // The setup connection's first complete read of bots and tasks ends its setup: after it,
    // the connection is the saved gateway's own. A read that failed leaves setup on its failure
    // screen, so the connection stays setup's, and every handshake from there, a retry or a
    // reconnect included, asks for read alone; Back or another gateway ends it.
    if (!current()) return;
    this.discoveryRead = null;
    // After the last wait above, so a change reported during the task catch-up is read too, and
    // also when the first bot read failed: the change it missed is read now.
    if (read.botsChanged) void this.refreshBotsOnChange(generation);
    const setup = this.isSetup(this.settings?.url);
    if (setup && failures.length === 0) {
      this.setupIntent = null;
      // The connection is the saved gateway's own now, with no new hello: the report held while
      // it was setup's is published, if it was this connection's.
      const held = this.setupUpdate;
      if (held?.generation === generation) this.setConnection({ openclawUpdate: held.update });
      // Waiting devices start as on a hello: with admin the list is read now, so a request
      // already waiting is listed without an event.
      this.deviceApprovals.onHello();
    }
    if (setup) this.setupUpdate = null;
    // The host's check of the listener lasts until the bots are read, a retry's read included:
    // from then on the connection and its retries are the saved gateway's own.
    if (failures.length === 0 && this.setupCheck?.url === this.settings?.url)
      this.setupCheck = null;
    if (failures.length > 0 && setup) {
      this.log("error", "discovery failed on the setup connection");
      this.discoveryAgain = false;
      this.setDiscovery({ status: "error", error: "Could not load your bots." });
    } else if (failures.length > 0) {
      this.log("error", `discovery failed: ${failures.join("; ")}`);
      // The gateway's own words stay with the strip, but a passing answer is said plainly.
      const detail = this.scrub(`Could not load ${failures.join("; ")}`);
      const kinds = reasons.map(answerKind);
      this.setDiscovery({
        status: "error",
        // Said only when it is true: every failed read's last answer was marked passing.
        error: kinds.every((kind) => kind === "passing") ? DISCOVERY_NOT_READY : null,
        detail,
      });
      // Once more when the gateway next speaks, if every failure was one asked again; a read
      // that event started does not arm another.
      this.discoveryAgain = tries > 0 && kinds.every((kind) => kind !== "lasting");
    } else {
      this.discoveryAgain = false;
      this.selectionReady = selection;
      this.setDiscovery({
        status: "ready",
        error: null,
        detail: null,
        partial: sessions.status === "fulfilled" && sessions.value.partial,
      });
    }
  }

  // Sessions -------------------------------------------------------------------

  /**
   * Read the whole filtered task list, one page at a time. The first page comes
   * from `sessions.subscribe` at bootstrap and from `sessions.list` on refresh.
   */
  private async loadAllSessions(
    generation: number,
    firstMethod: "sessions.subscribe" | "sessions.list",
  ): Promise<{ rows: Map<string, RawRecord>; partial: boolean; epoch: number }> {
    const epoch = this.waitingEpoch;
    const first = asRecord(await this.request(firstMethod, SESSION_LIST_PARAMS));
    let page = firstMethod === "sessions.subscribe" ? asRecord(first?.list) : first;
    // Each page is bounded as it arrives: only task rows, only the fields read, the newest
    // `MAX_LISTED_TASKS` of them, so nothing accumulates across pages. The rows so far are
    // kept where the retention registry sees them (`listings`) until the read ends.
    const rows = new Map<string, RawRecord>();
    this.listings.add(rows);
    try {
      for (let pages = 1; ; pages += 1) {
        const next = newestRows([...rows.values(), ...sessionRowsFromList(page)], this.keeps);
        rows.clear();
        for (const [key, row] of next) rows.set(key, row);
        const nextOffset = page?.nextOffset;
        const more = page?.hasMore === true && typeof nextOffset === "number";
        if (!more) return { rows, partial: false, epoch };
        if (pages >= MAX_SESSION_PAGES || generation !== this.generation) {
          return { rows, partial: true, epoch };
        }
        page = asRecord(
          await this.request("sessions.list", { ...SESSION_LIST_PARAMS, offset: nextOffset }),
        );
      }
    } finally {
      this.listings.delete(rows);
    }
  }

  /**
   * Take a whole task list, read on the connection `read` names: the rows shown and where they
   * were read change together, so a row's write never carries an identity its read didn't have.
   * A task that began waiting while the read ran may have been cut from a page before it waited:
   * if one is missing, the list is read once more. Only a change during the read asks again, so a
   * waiting key the gateway doesn't list is not read for without end.
   */
  private replaceRows(rows: Map<string, RawRecord>, read: ReadStamp, epoch: number): void {
    this.rows = rows;
    // The rows first: between the two, a row shown with the earlier stamp is refused, never sent.
    this.publishTasks();
    this.setDiscovery({ tasksRead: read });
    if (epoch !== this.waitingEpoch && this.waiting.keys().some(this.unheldWait))
      this.scheduleRefresh(this.generation);
  }

  /**
   * Whether the task's row reports a failure whose end the gateway marked not to show
   * (`suppressErrorNotice`, OpenClaw 2026.11.10) and that end is a quiet answer (#680). The run
   * this client holds says; for one it doesn't hold, the gateway's history, read once. Until that
   * read has looked, it is the quiet answer it is meant to be; a read refused or failed leaves
   * the failure.
   */
  private quietAnswer(key: string): boolean {
    const row = this.rows.get(key);
    const runId = row?.suppressErrorNotice === true ? row.lastRunId : null;
    if (typeof runId !== "string" || !runId) return false;
    const transcript = this.state.transcripts[key];
    const foreign = this.foreign.get(capId(key, MAX_ID_CHARS));
    const run =
      (transcript ? findRun(transcript, runId) : undefined) ??
      (foreign ? findRun(foreign, runId) : undefined);
    // The run this client holds says, unless all it knows of it is history's rows, none of which
    // answered nothing: then the row's check says, as for a run it doesn't hold.
    const fromRowsAlone =
      run?.origin === "history" && run.state === "completed" && run.unansweredInHistory !== true;
    if (run && !fromRowsAlone) return run.state === "completed" && run.quietEnd !== undefined;
    const verdict = this.quietChecks.verdict(key, runId, this.epoch);
    if (verdict !== undefined) return verdict === "pending" || verdict === "quiet";
    const check = this.quietChecks.begin(key, runId, this.epoch);
    if (check === null) return false;
    void this.checkQuiet(key, runId, check);
    return true;
  }

  /**
   * Whether the list leaves the row out whatever it waits for: a channel chat or another tool's
   * session while its switch is off. One a viewer has open stays listed until that viewer leaves
   * it, so turning a switch off or answering what it waited on never closes a conversation in use.
   */
  private hiddenRow(task: { key: string; channel?: unknown; otherTool?: unknown }): boolean {
    if (this.openSessions.has(task.key)) return false;
    return (
      (!!task.channel && !this.showChannelChats) ||
      (!!task.otherTool && !this.showOtherToolSessions)
    );
  }

  /** Read the task's history for the run its row names, and say what it showed (`quietAnswer`). */
  private async checkQuiet(key: string, runId: string, check: number): Promise<void> {
    const epoch = this.epoch;
    // Unread: the failure stays, and a later connection reads again.
    // The row's start is its latest run's: the gateway writes the two together.
    const started = numberOr(this.rows.get(key)?.startedAt);
    const quiet = await this.readQuiet(key, new Set([runId]), {}, () => started);
    const verdict = quiet === null ? "unread" : quiet.has(runId) ? "quiet" : "failed";
    this.quietChecks.settle(key, check, verdict);
    if (verdict !== "quiet" && epoch === this.epoch) this.publishTasks();
  }

  /**
   * Keep the title a message makes for its task (the line the sidebar would preview it as, cut to a
   * title), made from the outgoing message `from` or, with null, from the task's history, in the
   * task's session `session` when known; true when what is kept changed.
   */
  private keepFirstMessage(
    id: string,
    text: string | null,
    from: string | null,
    session: string | null,
  ): boolean {
    const title = cleanLine(plainPreview(text) ?? "", MAX_TITLE_CHARS);
    if (!title) return this.firstMessageTitles.delete(id);
    const kept = this.firstMessageTitles.get(id);
    if (kept?.title === title && kept.from === from && kept.session === session) {
      kept.epoch = this.epoch;
      return false;
    }
    if (!kept && this.firstMessageTitles.size >= MAX_FIRST_MESSAGE_TITLES) {
      const oldest = this.firstMessageTitles.keys().next();
      if (!oldest.done) this.firstMessageTitles.delete(oldest.value);
    }
    this.firstMessageTitles.set(id, { title, from, session, epoch: this.epoch });
    return true;
  }

  /**
   * Bring a task's first-message title in line with what its transcript shows, once that reaches
   * the task's first row: the first message history holds; with none, the earliest message still
   * on its way (in the outbox, not cancelled) that was sent in the read's session on its
   * connection; with neither, no title. A transcript still loading, one that doesn't reach the
   * first row, one not read on this connection in the row's session (another gateway's, or another
   * session's under the key), or one nothing ties to a session while the row or the kept title
   * names one leaves what is kept, and so does an outbox whose messages were all sent elsewhere.
   * True when that changed.
   */
  private settleFirstMessage(key: string): boolean {
    const id = capId(key, MAX_ID_CHARS);
    if (!titledByGateway(id)) return false;
    const transcript = this.state.transcripts[key];
    if (transcript?.status !== "ready" || transcript.hasMore) return false;
    const read = this.historyReads.get(key);
    const row = sessionOfRow(this.rows.get(id));
    if (read?.epoch !== this.epoch || otherSession(read.session, row)) return false;
    const kept = this.firstMessageTitles.get(id);
    // Search can open a task by its key before its row is known, so the read may be another
    // session's; a new task's row or creation names its session before history answers.
    if (read.session === null && (row ?? kept?.session ?? null) !== null) {
      // Read again in the session the row now names.
      if (row !== null) {
        this.historyReads.delete(key);
        void this.loadTranscript(key, false, null);
      }
      return false;
    }
    const held = firstPersonText(transcript.items);
    if (held !== null) return this.keepFirstMessage(id, held, null, read.session);
    const waiting = transcript.outbox.filter(
      (message) => message.status !== "cancelled" && message.text.trim() !== "",
    );
    // A message is the read's when sent after it was asked, or when the title kept was made from
    // it in the read's session on this connection: one left from before a reset or another
    // gateway is not.
    const first = waiting.find(
      (message) =>
        message.createdAt >= read.at ||
        (message.id === kept?.from &&
          kept.epoch === read.epoch &&
          !otherSession(kept.session, read.session)),
    );
    if (first) return this.keepFirstMessage(id, first.text, first.id, read.session);
    return waiting.length === 0 && this.firstMessageTitles.delete(id);
  }

  /**
   * The title a task's first message makes, as far as this client knows it (`taskTitle`); none
   * for a row in another `session` under the key, which is another task.
   */
  private firstMessageTitle(key: string, session: string | null = null): string | null {
    const id = capId(key, MAX_ID_CHARS);
    const kept = this.firstMessageTitles.get(id);
    const row = sessionOfRow(this.rows.get(id));
    // The task was deleted and made again under its key while this client didn't see it; or the
    // title came from a history read nothing tied to a session, and the row now names one.
    if (
      kept &&
      (otherSession(kept.session, row) ||
        (row !== null && kept.session === null && kept.from === null))
    )
      this.firstMessageTitles.delete(id);
    // Made first, as it may be made again from history.
    this.settleFirstMessage(key);
    const made = this.firstMessageTitles.get(id);
    // One kept from an earlier connection waits for this one to confirm the same gateway.
    if (made?.epoch !== this.epoch && this.state.connection.status === "connected") return null;
    return made && !otherSession(made.session, session) ? made.title : null;
  }

  /**
   * `before`: the rows the cap kept before the change being published (`keptKeys`). Without it,
   * those kept when publishing starts, so a row that settles here is still seen to leave.
   */
  private publishTasks(before: ReadonlySet<string> = this.keptKeys()): void {
    // Channel chats and other tools' sessions are grouped too: one that waits for the person stays
    // listed while it waits, so an approval or question it asks is never out of sight (F-519).
    const tasksByBot = groupTasks(this.rows.values(), {
      showChannelChats: true,
      showOtherToolSessions: true,
      firstMessageTitle: (key) => this.firstMessageTitle(key),
    });
    // A check of a row's marked failure lasts while the row reports it for that run (#680).
    this.quietChecks.retain((key, runId) => {
      const row = this.rows.get(key);
      return row?.suppressErrorNotice === true && row.lastRunId === runId;
    });
    // What waits for the person, and whose latest run was stopped (`waiting.ts`): a task the
    // engine follows by its runs, any other by the gateway's events.
    for (const [botId, tasks] of Object.entries(tasksByBot)) {
      for (const [index, row] of tasks.entries()) {
        // A failure the row reports with an end the gateway marked not to show, which is a quiet
        // answer: the run ended with nothing to show, as on OpenClaw 2026.10.6 (#680).
        // A row the list hides (below) starts no check: it would hold one of the checks' places
        // for as long as it reports the failure (#780).
        const task =
          row.status === "failed" && !this.hiddenRow(row) && this.quietAnswer(row.key)
            ? { ...row, status: "done" as const }
            : row;
        if (task !== row) tasks[index] = task;
        // A row with no active run ends what waited before it; a newer marker stays.
        if (task.status !== "running") this.waiting.settle(task.key, task.updatedAt);
        // A run the row says started after a failure: the failure is no longer the latest (#664).
        this.waiting.settleFailure(task.key, numberOr(this.rows.get(task.key)?.startedAt));
        const waiting = this.waiting.waitingFor(task.key);
        if (waiting) {
          tasks[index] = {
            ...task,
            status: "waiting",
            waitingFor: waiting.kind,
            waitingSince: waiting.since,
          };
        } else if (
          (task.status === "idle" || task.status === "done") &&
          this.waiting.stoppedAt(task.key) !== null
        ) {
          // A run stopped with `chat.abort` leaves the row no status: its runs or its end said so.
          tasks[index] = { ...task, status: "stopped" };
        } else if (
          (task.status === "idle" || task.status === "done") &&
          this.waiting.failedAt(task.key) !== null
        ) {
          // A message OpenClaw 2026.11.10 failed before running it leaves the row no status: its
          // `chat` error, or the task's runs, said so (#663, #664).
          tasks[index] = { ...task, status: "failed" };
        }
      }
      if (this.showChannelChats && this.showOtherToolSessions) continue;
      const shown = tasks.filter((task) => task.status === "waiting" || !this.hiddenRow(task));
      if (shown.length > 0) tasksByBot[botId] = shown;
      else delete tasksByBot[botId];
    }
    this.store.update((state) => ({ ...state, tasksByBot }));
    this.releaseKeptRows(before);
  }

  /**
   * Read the list again when a row the cap kept before a change (`before`) is no longer kept and
   * the list is full, so a task it pushed out comes back: a waiting or open row never costs a task
   * for longer than it waits or is open.
   */
  private releaseKeptRows(before: ReadonlySet<string>): void {
    if (this.rows.size < MAX_LISTED_TASKS) return;
    const kept = this.keptKeys();
    if ([...before].some((key) => !kept.has(key))) this.scheduleRefresh(this.generation);
  }

  /** The keys of the held rows the cap keeps for now (`keeps`); built for one call, not kept. */
  private keptKeys(): Set<string> {
    const kept = new Set<string>();
    for (const key of this.rows.keys()) if (this.keeps(key)) kept.add(key);
    return kept;
  }

  /**
   * Whether a channel chat or another tool's session the client does not hold would give way at
   * once: the person's own tasks alone fill `MAX_LISTED_TASKS`, so reading the list again could
   * not keep it (`newestRows`).
   */
  private elsewhereRowGivesWay(row: RawRecord): boolean {
    const key = sessionRowKey(row);
    if (!isElsewhere(row) || (key !== null && this.keeps(key))) return false;
    if (this.rows.size < MAX_LISTED_TASKS) return false;
    let native = 0;
    for (const held of this.rows.values()) if (!isElsewhere(held)) native += 1;
    return native >= MAX_LISTED_TASKS;
  }

  /** One refresh at a time; one asked for meanwhile runs once after it. */
  private async refreshSessions(generation: number): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshAgain = false;
        // A read asked from here on lists only the bots the gateway has now.
        this.removedDuringRead.clear();
        this.readOutdated = false;
        try {
          const { rows, partial, epoch } = await this.loadAllSessions(generation, "sessions.list");
          if (generation !== this.generation) return;
          // The read after it, already asked for, is the one kept.
          if (this.readOutdated) continue;
          for (const [key, row] of rows) {
            const botId = rowBotOf(key, row);
            if (botId && this.removedDuringRead.has(botId)) rows.delete(key);
          }
          this.replaceRows(
            rows,
            {
              gatewayId: this.state.connection.gatewayId,
              target: this.target,
              connectedAt: this.state.connection.connectedAt,
            },
            epoch,
          );
          this.setDiscovery({ partial });
        } catch (error) {
          this.logFailure("warn", "sessions.list", error);
        }
      } while (this.refreshAgain && generation === this.generation);
    } finally {
      this.refreshing = false;
      this.removedDuringRead.clear();
      this.readOutdated = false;
    }
  }

  private scheduleRefresh(generation: number): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshSessions(generation);
    }, 250);
  }

  /**
   * A `sessions.changed` with `phase: "message"` for an open task: a message of it
   * changed in place. The gateway writes a picture a turn hands over into its
   * message after the turn ends, with no `session.message`, so history is read again.
   */
  private noteMessageChange(payload: unknown): void {
    const row = asRecord(payload);
    const key = typeof row?.sessionKey === "string" ? row.sessionKey : null;
    if (row?.phase === "message" && key && this.tracked(key)) this.scheduleHistory(key);
  }

  /** Whether the task rows shown were read on the connection open now (`discovery.tasksRead`). */
  private rowsReadHere(): boolean {
    const read = this.state.discovery.tasksRead;
    return (
      read === null ||
      (read.target === this.target && read.connectedAt === this.state.connection.connectedAt)
    );
  }

  /**
   * Apply a `sessions.changed` event with the same membership rules as the list.
   * A known row is merged and re-checked. An unknown row whose key is not ruled
   * out cannot prove membership from the payload, so the filtered list is
   * re-read instead of inserting it.
   */
  private handleSessionsChanged(payload: unknown, generation: number): void {
    if (this.discoveryRead) this.discoveryRead.sessionsChanged = true;
    this.noteRunChange(payload);
    this.noteMessageChange(payload);
    const row = sessionChangeRow(payload);
    const rowKey = row ? sessionRowKey(row) : null;
    // A new input admitted: a failure after it may be that message's (`waiting.ts`, #686).
    if (
      row &&
      rowKey &&
      (row.hasActiveRun === true || row.status === "queued" || row.status === "running")
    )
      this.waiting.noteInput(rowKey);
    // Rows are kept under the id cap.
    const key = rowKey === null ? null : capId(rowKey, MAX_ID_CHARS);
    if (!row || !key) {
      this.scheduleRefresh(generation);
      return;
    }
    if (isSessionRemoval(payload)) {
      this.cancelAllQueued(key);
      this.retireForeign(key);
      // Deleted elsewhere: the pictures you sent in it go too. An archived task keeps them.
      this.dropDeletedPictures(({ task }) => task === key);
      // So does the title its first message made: another task under the key is not this one.
      this.firstMessageTitles.delete(key);
      if (this.rows.delete(key)) this.publishTasks();
      return;
    }
    // Rows read on an earlier connection are not merged with this one's events: another gateway
    // may answer at the same address with the same keys. The list is read again instead.
    if (!this.rowsReadHere()) {
      this.scheduleRefresh(generation);
      return;
    }
    if (row.archived === true) this.cancelAllQueued(key);
    const cached = this.rows.get(key);
    if (!cached) {
      if (!isExcludedSessionKey(key) && !this.elsewhereRowGivesWay(row))
        this.scheduleRefresh(generation);
      return;
    }
    const merged = mergeSessionRow(cached, row);
    if (isTaskSession(merged)) this.rows.set(key, SESSION_ROW(merged));
    else this.rows.delete(key);
    this.publishTasks();
  }

  /**
   * A `sessions.changed` row for a run's phase. It names the gateway's run id
   * (`runId`) and, for a turn the gateway ran from its queue, the send's id the
   * turn's lifecycle and end carry (`clientRunId`): the first becomes an alias of
   * the second. Its `end` or `error` for a run the task still shows as active,
   * under either id, reads history again, so a run whose own end did not reach
   * this client under the id it knows is settled rather than shown working.
   */
  private noteRunChange(payload: unknown): void {
    const row = asRecord(payload);
    const key = typeof row?.sessionKey === "string" ? row.sessionKey : null;
    const runId = typeof row?.runId === "string" ? capId(row.runId, MAX_ID_CHARS) : null;
    if (!row || !key || !runId) return;
    const clientRunId =
      typeof row.clientRunId === "string" ? capId(row.clientRunId, MAX_ID_CHARS) : null;
    if (!this.tracked(key)) {
      if (row.phase !== "end" && row.phase !== "error") return;
      const sessionKey = capId(key, MAX_ID_CHARS);
      const activity = this.foreign.get(sessionKey);
      // A row naming a run id pair names one run: both ids are kept, so the
      // read and the merge see the run whatever id it or history holds it under.
      const pairs: Array<[string, string]> =
        clientRunId && clientRunId !== runId ? [[runId, clientRunId]] : [];
      const named = [runId, ...pairs.map(([, client]) => client)];
      const ids = new Set(
        named.filter((id) => {
          const run = activity && findRun(activity, id);
          return run
            ? !isTerminal(run.state)
            : [...this.recipients.values()].some((link) => link.runs.has(id));
        }),
      );
      if (ids.size === 0) return;
      for (const id of named) ids.add(id);
      void this.readRecipientRuns(sessionKey, ids, this.generation, undefined, {
        phase: row.phase === "error" ? "error" : "end",
        pairs,
      });
      return;
    }
    if (clientRunId && clientRunId !== runId) {
      this.updateActivity(key, (activity) => registerRunAlias(activity, runId, clientRunId));
    }
    if (row.phase !== "end" && row.phase !== "error") return;
    const transcript = this.state.transcripts[key];
    const named = [runId, clientRunId].flatMap((id) => {
      const run = id && transcript ? findRun(transcript, id) : undefined;
      return run ? [run] : [];
    });
    if (named.some((run) => !isTerminal(run.state) && run.state !== "queued")) {
      this.scheduleHistory(key);
    }
  }

  // Transcripts ----------------------------------------------------------------

  /**
   * A task opened now. What the engine already knows of its runs, from
   * following them while nobody had the task open (a recipient's run, and the
   * question it waits on, by id), is its from the first moment: an outgoing
   * message is held behind that question at once, and the history read and the
   * question list settle it by the same rules as any other.
   */
  private openedTranscript(key: string): Transcript {
    const sessionKey = capId(key, MAX_ID_CHARS);
    const known = this.foreign.get(sessionKey);
    const empty = this.emptyTranscript(key);
    // Only a run known to wait on a question is carried; history rebuilds every other run.
    const waiting = known ? runsWithQuestionMarkers(known) : [];
    // The task holds them now: none is kept twice, and no copy left here goes stale while the
    // task's own events update the task. Letting the task go keeps what another task links to.
    this.foreign.delete(sessionKey);
    if (waiting.length === 0) return empty;
    return { ...empty, runs: waiting };
  }

  private emptyTranscript(key: string): Transcript {
    return {
      ...emptyActivity,
      sessionKey: key,
      status: "loading",
      items: [],
      error: null,
      hasMore: false,
      live: null,
      linkedRuns: {},
      interSession: [],
      mcpTools: {},
      loadedAt: null,
    };
  }

  private setTranscript(key: string, fn: (current: Transcript | undefined) => Transcript): void {
    this.store.update((state) => ({
      ...state,
      transcripts: { ...state.transcripts, [key]: fn(state.transcripts[key]) },
    }));
    // The rail describes a task the engine follows by the same runs the conversation shows.
    const transcript = this.state.transcripts[key];
    // An open task is kept whatever its runs say, so only another's hold can change what is kept.
    const before = this.openSessions.has(key) ? undefined : this.keptKeys();
    // So is the title its first message makes, which follows what the transcript shows.
    const titled = this.settleFirstMessage(key);
    if ((transcript && this.waiting.hold(key, fromActivity(transcript))) || titled)
      this.publishTasks(before);
  }

  /**
   * Read a task's history and rebuild its runs from it. Runs already on screen
   * are merged by id and steps by id, and outgoing messages leave the outbox
   * once history holds them, so a reload never duplicates anything.
   */
  /**
   * Reads of one task run one at a time: a read asked for while one is in
   * flight runs once after it, with the strongest resync reason asked for.
   * A response is applied only to the same connection and the same opening of
   * the task, so a slow read never overwrites newer state.
   */
  private loadTranscript(
    key: string,
    subscribe: boolean,
    resync: CaughtUp["reason"] | null,
  ): Promise<void> {
    const load = this.loads.get(key);
    if (load) {
      load.again = {
        subscribe: (load.again?.subscribe ?? false) || subscribe,
        resync: strongerResync(load.again?.resync ?? null, resync),
      };
      return load.done;
    }
    const entry: {
      done: Promise<void>;
      again: { subscribe: boolean; resync: CaughtUp["reason"] | null } | null;
    } = {
      done: Promise.resolve(),
      again: null,
    };
    this.loads.set(key, entry);
    entry.done = (async () => {
      let next: { subscribe: boolean; resync: CaughtUp["reason"] | null } | null = {
        subscribe,
        resync,
      };
      while (next) {
        await this.readTranscript(key, next.subscribe, next.resync);
        // If `releaseTask` dropped this entry while the read was in flight, stop instead of
        // running queued work under a reopened task's new incarnation.
        if (this.loads.get(key) !== entry) break;
        next = entry.again;
        entry.again = null;
      }
      if (this.loads.get(key) === entry) this.loads.delete(key);
    })();
    return entry.done;
  }

  /**
   * Read a task's history and rebuild its runs from it. Runs already on screen
   * are merged by id and steps by id, and outgoing messages leave the outbox
   * once history holds them, so a reload never duplicates anything.
   */
  private async readTranscript(
    key: string,
    subscribe: boolean,
    resync: CaughtUp["reason"] | null,
  ): Promise<void> {
    const generation = this.generation;
    const epoch = this.epoch;
    const incarnation = this.incarnations.get(key);
    // The read belongs to its connection: after a drop and a new hello it publishes nothing,
    // a failure included, and the new connection's own read reloads the task.
    const stale = () =>
      generation !== this.generation ||
      epoch !== this.epoch ||
      !this.tracked(key) ||
      this.incarnations.get(key) !== incarnation;
    // Runs active when the read starts; one the gateway then no longer has has ended.
    const activeBefore = new Set(
      (this.state.transcripts[key]?.runs ?? [])
        .filter((run) => run.bound && !isTerminal(run.state) && run.state !== "queued")
        .map((run) => run.id),
    );
    // Quiet ends this read may settle: those that ended before it was asked (#680), and those an
    // earlier read failed for (#767).
    const quietBefore = quietToRead(this.state.transcripts[key]?.runs ?? []);
    // The task's live events come only through its subscription: asked again like the reads.
    // A subscription that failed for good stays failed through later history reads, and each of
    // them tries it again; only one that succeeds clears it.
    const unsubscribed = this.state.transcripts[key]?.error === LIVE_UPDATES_NOT_STARTED;
    let live = !unsubscribed;
    try {
      if (subscribe || unsubscribed) {
        live = await this.readAgain(
          () => this.request("sessions.messages.subscribe", { key }),
          () => !stale(),
        ).then(
          () => true,
          (error: unknown) => {
            this.logFailure("warn", "sessions.messages.subscribe", error);
            return false;
          },
        );
        if (stale()) return;
      }
      // The row's session as the read is asked: a reply that doesn't name its own is that one's.
      const asked = sessionOfRow(this.rows.get(capId(key, MAX_ID_CHARS)));
      const at = this.now();
      const history = asRecord(
        await this.readAgain(
          () => this.request("chat.history", { sessionKey: key, limit: HISTORY_LIMIT }),
          () => !stale(),
        ),
      );
      if (stale()) return;
      // A resync starts every stream of this task again from what the gateway sends next.
      if (resync) this.streams.retire(key);
      // A queued turn's two ids, as history pairs them, whatever this client holds: kept, so a
      // pairing frame missed in a gap, or a transcript built from history alone, still makes
      // one run, and later frames under either id update that run.
      const pairs = historyQueuePairs(history?.messages);
      if (pairs.length > 0) {
        this.updateActivity(key, (activity) =>
          pairs.reduce(
            // A pair already known wins over one the page infers for the same id (#680).
            (next, [gateway, client]) =>
              next.queueAliases[gateway] !== undefined
                ? next
                : registerRunAlias(next, gateway, client),
            activity,
          ),
        );
      }
      const { messages, inFlight } = throughRunAliases(
        history?.messages,
        asRecord(history?.inFlightRun),
        this.state.transcripts[key]?.queueAliases ?? {},
      );
      const inFlightId = typeof inFlight?.runId === "string" ? inFlight.runId : null;
      const ctx = this.context(key);
      // History is built aside; only the steps the merge takes from it bring their raw payloads.
      const scratch = new RawTable();
      // The gateway has a turn of this task in flight or queued: a run history only infers to
      // have ended is not ended by this read.
      const busy = inFlightId !== null || holdsInput(history);
      // What the rows alone rebuild, the run the row says failed unseen failed too (#766).
      const fromHistory = failedByRow(
        runsFromHistory(
          messages,
          inFlight,
          { ...ctx, raw: scratch },
          { windowCut: history?.hasMore === true, busy },
        ),
        messages,
        this.rows.get(key),
        this.state.transcripts[key]?.queueAliases ?? {},
      );
      const current = this.state.transcripts[key] ?? this.emptyTranscript(key);
      const merge = mergeHistoryRuns(current.runs, fromHistory, ctx, busy);
      for (const stepId of merge.fromHistory) {
        const payload = scratch.get(key, stepId);
        if (payload) this.raw.set(key, stepId, payload);
      }
      const historyIds = new Set(fromHistory.map((run) => run.id));
      const awaitingAnswer = new Set(
        current.outbox
          .filter((message) => message.status === "sending" || message.status === "awaiting-access")
          .map((message) => message.id),
      );
      const runs = settleQuietEnds(
        settleUnboundStops(
          settleVanishedRuns(merge.runs, activeBefore, historyIds, inFlightId, ctx, busy),
          inFlightId,
          historyIds,
          awaitingAnswer,
          ctx,
        ),
        // Only what the read holds whole: the others are read on (`settleQuietLater`).
        coveredRuns(
          history,
          quietBefore,
          (id) => startOf(merge.runs, id),
          this.state.transcripts[key]?.queueAliases ?? {},
        ),
      );
      // A Stop asked before the gateway named its run: the run in flight under the send's id
      // is that run, named now, and is stopped; so is one settled earlier with no known outcome.
      const toStop = runs.filter(
        (run) =>
          run.id === inFlightId &&
          run.stopRequestedAt !== null &&
          ((run.state === "stopping" && !findRun(current, run.id)?.bound) ||
            (run.state === "stopped" && !run.outcomeKnown)),
      );
      const reconciled = reconcileOutbox(
        parkAfterStop(current, { ...current, runs }, this.now()),
        messages,
      );
      // History holds these now: only their pictures are kept, to be shown.
      for (const message of current.outbox) {
        if (!reconciled.outbox.some((each) => each.id === message.id))
          this.keepSentPictures(message);
      }
      const activity = markUnconfirmed(reconciled);
      const items = mapHistory(messages, {
        startedAt: startedTaskSince(history),
        gatewayEvents: this.writesEvents(),
        skillNotesMarked: this.marksSkillNotes(),
      });
      this.sentSources.set(key, sentSources(messages));
      // The session the reply says it read, else the row's when it was asked (a row that moved
      // since is another session's, and takes no title from this read); with that row's revision
      // when the reply names the same id without one.
      const read = sessionOfRow(asRecord(history?.sessionInfo)) ?? sessionOfRow(history);
      this.historyReads.set(key, {
        session: read === null || asked?.startsWith(`${read}\u0000`) ? asked : read,
        epoch: this.epoch,
        at,
      });
      const rebuilt: Transcript = {
        ...current,
        ...retainActivity(
          settleQuestionsOfEndedRuns(normalizeApprovals(activity, (runId) => this.otherRun(runId))),
        ),
        sessionKey: key,
        // History shows, but without its subscription nothing live reaches the task: it says
        // so, and Try again subscribes again (`reloadSession`).
        status: live ? "ready" : "error",
        items,
        interSession: interSessionMessages(messages, items),
        // Reactions leave with the history they belonged to (F-283).
        ...(current.reactions ? { reactions: reactionsShown(current.reactions, items) } : {}),
        error: live ? null : LIVE_UPDATES_NOT_STARTED,
        hasMore: history?.hasMore === true,
        caughtUp: resync ? { reason: resync, at: this.now() } : current.caughtUp,
        loadedAt: this.now(),
      };
      this.retainTaskRaw(key, rebuilt);
      this.setTranscript(key, () => withLive(rebuilt));
      const left = quietToRead(rebuilt.runs.filter((run) => quietBefore.has(run.id)));
      if (left.size > 0) void this.settleQuietLater(key, left, generation);
      // A read is news of its own: the runs it leaves active are asked again.
      this.endChecked.delete(key);
      this.afterActivity(key);
      // A run settled from history may be a recipient another open task's card follows.
      this.refreshLinkersOf(key, current.runs, rebuilt.runs);
      for (const run of toStop) {
        this.unsentStops.delete(`${key}\u0000${run.id}`);
        void this.abortRun(key, run.id, this.historyStopCheck(key, run));
      }
      void this.readRecipients(key, generation);
      void this.backfillQuestions(key, generation);
      void this.backfillApprovals(key, generation);
      void this.readToolMap(key, generation);
      void this.readReactions(key, generation);
      if (current.workspaceRoot === undefined) void this.readWorkspaceRoot(key, generation);
    } catch (error) {
      if (stale()) return;
      const before = this.state.transcripts[key]?.runs ?? [];
      // Without its subscription, that is what the task says: Try again reads both again.
      this.setTranscript(key, (current) => ({
        ...(current ?? this.emptyTranscript(key)),
        // History unread can't show a quiet end to be one: each stays the failure it was sent as.
        runs: settleQuietEnds(current?.runs ?? [], quietBefore, "unread"),
        status: "error",
        error: live ? errorMessage(error) : LIVE_UPDATES_NOT_STARTED,
      }));
      // A run it failed may be a recipient another open task's card follows (as a read does).
      this.refreshLinkersOf(key, before, this.state.transcripts[key]?.runs ?? []);
    }
  }

  /**
   * Marked ends a task's own history read didn't hold whole (#680): read on once (`readQuiet`);
   * each is a quiet answer only if that read shows it, and otherwise the failure it was sent as.
   */
  private async settleQuietLater(key: string, ids: Set<string>, generation: number): Promise<void> {
    // A read the socket's end cut off says nothing: the next connection's read of the task does.
    const epoch = this.epoch;
    const held = this.state.transcripts[key];
    const quiet = await this.readQuiet(key, ids, held?.queueAliases ?? {}, (id) =>
      startOf(held?.runs ?? [], id),
    );
    if (generation !== this.generation || epoch !== this.epoch) return;
    this.updateActivity(key, (activity) => {
      const runs = settleQuietEnds(
        settleQuietEnds(activity.runs, quiet ?? new Set()),
        ids,
        quiet === null ? "unread" : "failed",
      );
      return runs === activity.runs ? activity : { ...activity, runs };
    });
  }

  private scheduleHistory(key: string, resync: CaughtUp["reason"] | null = null): void {
    if (resync) this.resyncReasons.set(key, resync);
    if (this.historyTimers.has(key)) return;
    this.historyTimers.set(
      key,
      setTimeout(() => {
        this.historyTimers.delete(key);
        const reason = this.resyncReasons.get(key) ?? null;
        this.resyncReasons.delete(key);
        void this.loadTranscript(key, false, reason);
      }, 150),
    );
  }

  private handleChat(event: EventFrame): void {
    const payload = asRecord(event.payload);
    const key = typeof payload?.sessionKey === "string" ? payload.sessionKey : null;
    const runId = typeof payload?.runId === "string" ? payload.runId : null;
    if (!payload || !key || !runId) return;
    this.noteSpawnedBy(payload);
    if (payload.state === "final" || payload.state === "error" || payload.state === "aborted") {
      const botId = botIdFromSessionKey(key);
      if (botId) this.usage.onRunEnded(botId);
    }
    if (!this.tracked(key)) {
      this.updateForeign(key, (activity, ctx) => applyChatEvent(activity, payload, null, ctx));
      return;
    }
    // Only tasks this client follows keep a stream baseline: the text, never the message.
    const projected = this.streams.project(payload);
    const text = payload.state === "delta" ? projected : null;
    this.updateActivity(key, (activity, ctx) => applyChatEvent(activity, payload, text, ctx));
    // final, aborted or error: the durable transcript now owns the text.
    if (payload.state !== "delta" && payload.state !== "status") this.scheduleHistory(key);
  }

  /** Agent events carry the session key on the wire; fall back to the open task that knows the run. */
  /** Remember which session spawned which, so a helper's approval reaches its parent task. */
  private noteSpawnedBy(payload: RawRecord): void {
    if (typeof payload.sessionKey !== "string" || typeof payload.spawnedBy !== "string") return;
    const child = capId(payload.sessionKey, MAX_ID_CHARS);
    const parent = capId(payload.spawnedBy, MAX_ID_CHARS);
    if (child === parent) return;
    const known = this.spawnedBy.get(child) === parent;
    this.spawnedBy.delete(child);
    this.spawnedBy.set(child, parent);
    while (this.spawnedBy.size > MAX_SPAWN_LINKS)
      this.spawnedBy.delete(this.spawnedBy.keys().next().value as string);
    // A helper's approval that arrived before its spawn was known can be placed now.
    if (!known) this.routeUnrouted();
  }

  private handleAgent(event: EventFrame): void {
    const payload = asRecord(event.payload);
    if (!payload || typeof payload.runId !== "string") return;
    this.noteSpawnedBy(payload);
    let key = typeof payload.sessionKey === "string" ? payload.sessionKey : null;
    if (!key) {
      const runId = payload.runId;
      key =
        Object.values(this.state.transcripts).find((transcript) => findRun(transcript, runId))
          ?.sessionKey ?? null;
    }
    if (!key) return;
    const lifecycle = asRecord(payload.data)?.phase;
    if (payload.stream === "lifecycle" && (lifecycle === "end" || lifecycle === "error"))
      this.guidesAfterRun(botIdFromSessionKey(key));
    if (!this.tracked(key)) {
      this.updateForeign(key, (activity, ctx) => applyAgentEvent(activity, payload, ctx).activity);
      return;
    }
    this.updateActivity(key, (activity, ctx) => applyAgentEvent(activity, payload, ctx).activity);
    const phase = asRecord(payload.data)?.phase;
    if (payload.stream === "lifecycle" && (phase === "end" || phase === "error")) {
      this.scheduleHistory(key);
      // Only while a viewer has the task open: a task kept for its unsettled work reads nothing.
      const botId = botIdFromSessionKey(key);
      if (botId && this.openSessions.has(key)) void this.botNames.afterRun(botId, payload.runId);
    }
  }

  private handleEvent(event: EventFrame, generation: number): void {
    // Not while a read of bots and tasks is out: it decides again when it ends.
    if (this.discoveryAgain && !this.discoveryRead) {
      this.discoveryAgain = false;
      void this.bootstrap(generation, null, 0);
    }
    switch (event.event) {
      case "update.available":
        // While a setup connection is open, the report is held, never published.
        if (this.isSetup(this.settings?.url)) {
          this.holdSetupUpdate(generation, asRecord(event.payload)?.updateAvailable);
          return;
        }
        this.setConnection({
          openclawUpdate: readOpenClawUpdate(asRecord(event.payload)?.updateAvailable),
        });
        return;
      case "device.pair.requested":
      case "device.pair.resolved":
      case "device.pair.changed":
        if (!this.isSetup(this.settings?.url))
          this.deviceApprovals.onEvent(event.event, event.payload);
        return;
      case "update.run.changed":
        if (!this.isSetup(this.settings?.url)) this.openclawUpdates.onRunChanged(event.payload);
        return;
      case "sessions.changed":
        this.handleSessionsChanged(event.payload, generation);
        return;
      case "config.changed":
        if (this.discoveryRead) this.discoveryRead.botsChanged = true;
        else void this.refreshBotsOnChange(generation);
        return;
      case "plugins.changed":
        // Tool-server tools come from the gateway's bundle-mcp plugin: read each task's map again.
        for (const key of Object.keys(this.state.transcripts)) {
          if (this.tracked(key)) void this.readToolMap(key, generation);
        }
        // The voice plugin may have come or gone, so the hello's list no longer says.
        this.voiceAdvertised = null;
        this.voiceChanged();
        return;
      case VOICE_CHANGED_EVENT:
        this.voiceChanged();
        return;
      case "session.message": {
        const key = asRecord(event.payload)?.sessionKey;
        if (typeof key === "string" && this.tracked(key)) this.scheduleHistory(key);
        return;
      }
      case "chat": {
        const payload = asRecord(event.payload);
        // Only a run's end can change the rail's word, so a streaming delta skips the scan of the
        // task list.
        if (payload && endsRun(payload)) {
          const before = this.keptKeys();
          // The gateway's time for it, as its row last gave it: what a later run's start is
          // compared with (`settleFailure`).
          const key = typeof payload.sessionKey === "string" ? payload.sessionKey : "";
          const at = numberOr(this.rows.get(capId(key, MAX_ID_CHARS))?.updatedAt) ?? this.now();
          if (this.waiting.onChat(payload, at)) this.waitingChanged(before);
        }
        this.handleChat(event);
        return;
      }
      case "agent": {
        const payload = asRecord(event.payload);
        if (payload) {
          const before = this.keptKeys();
          if (this.waiting.onAgent(payload, this.now())) this.waitingChanged(before);
        }
        this.handleAgent(event);
        return;
      }
      case "cron":
        this.routines.onEvent(event.payload);
        return;
      case "session.reaction": {
        // Someone, here or elsewhere, added or removed a reaction: the message's reactions now.
        const payload = asRecord(event.payload);
        const key = typeof payload?.sessionKey === "string" ? payload.sessionKey : null;
        const messageId = typeof payload?.messageId === "string" ? payload.messageId : null;
        if (key && messageId && this.tracked(key))
          this.applyReactions(key, messageId, payload?.reactions);
        return;
      }
      case "users.prefs.changed": {
        const keys = asRecord(event.payload)?.keys;
        if (Array.isArray(keys) && keys.includes(SIDEBAR_PREF_KEY))
          void this.loadSidebar(this.generation);
        this.usage.onPrefsChanged(keys);
        return;
      }
      case "question.requested": {
        const record = asRecord(event.payload);
        if (record) {
          const before = this.keptKeys();
          if (this.waiting.onQuestionRequested(record, this.now())) this.waitingChanged(before);
        }
        const key = typeof record?.sessionKey === "string" ? record.sessionKey : null;
        if (record && key && this.tracked(key)) {
          this.updateActivity(key, (activity, ctx) =>
            applyQuestionRequested(activity, record, ctx),
          );
        } else if (
          record &&
          key &&
          typeof record.runId === "string" &&
          this.foreign.get(capId(key, MAX_ID_CHARS))?.runs.some((run) => run.id === record.runId)
        ) {
          // A recipient's run this client follows asks its own user: it waits.
          this.updateForeign(key, (activity, ctx) =>
            foreignQuestionRequested(activity, record, ctx),
          );
        }
        return;
      }
      case "exec.approval.requested":
      case "plugin.approval.requested":
      case "openclaw.approval.requested": {
        const card =
          event.event === "exec.approval.requested"
            ? parseExecApproval(event.payload)
            : event.event === "plugin.approval.requested"
              ? parsePluginApproval(event.payload)
              : parseSystemAgentApproval(event.payload);
        if (card) {
          const admitted = admitApproval(card);
          // Its task waits, whether a followed task shows the card or it is kept unrouted.
          const before = this.keptKeys();
          if (
            admitted.status === "pending" &&
            !this.approvalOutcomes.has(admitted.id) &&
            this.waiting.restoreApproval(admitted, this.now())
          )
            this.waitingChanged(before);
          this.routeApproval(admitted);
        }
        return;
      }
      case "exec.approval.resolved":
      case "plugin.approval.resolved":
      case "openclaw.approval.resolved": {
        const kind: ApprovalKind =
          event.event === "exec.approval.resolved"
            ? "exec"
            : event.event === "plugin.approval.resolved"
              ? "plugin"
              : "system-agent";
        const resolution = parseApprovalResolved(event.payload, kind);
        const before = this.keptKeys();
        if (resolution && this.waiting.onApprovalResolved(resolution.id)) this.publishTasks(before);
        // Kept even when no card has arrived yet: its request or list entry may come later.
        if (resolution) this.noteApprovalOutcome(resolution);
        return;
      }
      case CONTROL_EVENT:
        this.computer.controlEvent(event.payload);
        return;
      case "question.resolved": {
        const payload = asRecord(event.payload);
        const id = payload?.id;
        if (!payload || typeof id !== "string") return;
        // Read from the runs as they were, told once the transcript records the closure.
        const closed = this.questionClosures(id, payload.status);
        const before = this.keptKeys();
        if (this.waiting.onQuestionResolved(id)) this.publishTasks(before);
        for (const [key, activity] of [...this.foreign.entries()]) {
          if (activity.runs.some((run) => run.pendingCards.some((card) => card.id === id)))
            this.updateForeign(key, (each) => foreignQuestionResolved(each, payload));
        }
        for (const transcript of Object.values(this.state.transcripts)) {
          if (transcript.questions.some((question) => question.id === id)) {
            this.updateActivity(transcript.sessionKey, (activity) =>
              applyQuestionResolved(activity, payload, {
                via: "question.resolved",
                record: event.payload,
              }),
            );
          } else if (questionMarkers(transcript).includes(id)) {
            // Known only by its id, from before the task was opened: its run goes on.
            this.updateActivity(transcript.sessionKey, (activity) =>
              foreignQuestionResolved(activity, payload),
            );
          }
        }
        for (const [key, code] of closed) this.computer.questionClosed(key, id, code);
        return;
      }
      default:
        return;
    }
  }

  // The Computer tab (`computer.ts`, `machine.ts`) ---------------------------------------

  /**
   * How a question closed, for each task that holds it, read from its run before the
   * resolution is applied: an answer queued behind a release of that task's browser is removed,
   * and the control bar learns the question went, once the transcript records it.
   */
  private questionClosures(id: string, status: unknown): Array<[string, ClosedCode]> {
    const out: Array<[string, ClosedCode]> = [];
    for (const transcript of Object.values(this.state.transcripts)) {
      const question = transcript.questions.find((q) => q.id === id);
      if (!question) continue;
      const run = question.runId ? findRun(transcript, question.runId) : undefined;
      // Only a run that has ended ended it; one still stopping has a Stop the gateway hasn't
      // confirmed, and the question it cancels was cancelled.
      const runOver = run !== undefined && isTerminal(run.state);
      const code: ClosedCode =
        status === "answered"
          ? "answered"
          : status === "expired"
            ? "expired"
            : runOver
              ? "run-ended"
              : status === "cancelled"
                ? run?.state === "stopping"
                  ? "cancelled"
                  : "dismissed"
                : "cancelled";
      out.push([transcript.sessionKey, code]);
    }
    return out;
  }

  /**
   * "Stop <Bot> in this task": the conversation's Stop, for every run of the task still going,
   * each by its own id as archive and delete stop them, even when none is established as the
   * current one. Asked for `owner`, it is withdrawn with it while it waits for write access.
   */
  private async stopTask(key: string, owner: object | null): Promise<StopAnswer> {
    const runs = (this.state.transcripts[key]?.runs ?? []).filter(
      (run) => run.state === "running" || run.state === "waiting",
    );
    if (runs.length === 0) {
      await this.ensureScope(WRITE_SCOPE, owner);
      this.checkNotWithdrawn(owner);
      const result = asRecord(await this.request("chat.abort", { sessionKey: key }));
      // As the gateway said it: `aborted` true or false, or null when its answer didn't say.
      return { runIds: [], aborted: typeof result?.aborted === "boolean" ? result.aborted : null };
    }
    // Each as the conversation's Stop: stopping until the run's end, back to running with the
    // gateway's refusal (`revertStop`).
    // All at once: one run's slow answer never holds another's Stop back.
    await Promise.all(
      runs.map((run) =>
        this.stopRun(
          key,
          run.id,
          // "The request affects only this task": nothing these runs' messages started is stopped.
          owner ? { owner, everyRun: true, taskOnly: true } : { everyRun: true, taskOnly: true },
        ),
      ),
    );
    return { runIds: runs.map((run) => run.id), aborted: null };
  }

  /** A viewer id for a bridge session: its pane in `state.computer.panes`. */
  computerViewer(): string {
    return this.computer.newViewer();
  }
  computerShow(viewer: string, key: string): void {
    this.computer.show(viewer, key);
  }
  computerLeave(viewer: string): void {
    this.computer.leave(viewer);
  }
  computerDispose(viewer: string): void {
    this.computer.dispose(viewer);
  }
  computerTabs(viewer: string): Promise<void> {
    return this.computer.readTabs(viewer);
  }
  computerChoose(viewer: string, targetId: string): void {
    this.computer.choose(viewer, targetId);
  }
  computerWatch(viewer: string): Promise<void> {
    return this.computer.watch(viewer);
  }
  computerStopWatching(viewer: string): void {
    this.computer.stopWatching(viewer);
  }
  computerFrame(viewer: string, n: number, after: number): Promise<ComputerFrame | null> {
    return this.computer.frame(viewer, n, after);
  }
  computerTake(viewer: string): Promise<void> {
    return this.computer.take(viewer);
  }
  computerCancelTake(viewer: string): void {
    this.computer.cancelTake(viewer);
  }
  computerInput(viewer: string, input: ComputerInput): boolean {
    return this.computer.input(viewer, input);
  }
  computerRelease(
    viewer: string,
    answer: { questionId: string; itemId: string; option: number } | null,
  ): void {
    this.computer.release(viewer, answer ? { answer } : {});
  }
  computerCheck(viewer: string): Promise<void> {
    return this.computer.check(viewer);
  }
  computerDismiss(viewer: string): void {
    this.computer.dismiss(viewer);
  }
  computerStopTask(viewer: string, options: { owner?: object } = {}): Promise<void> {
    return this.computer.stopTask(viewer, options.owner ?? null);
  }

  /** Where the task's bot runs its commands, and the named nodes' records, read now. */
  async readMachine(key: string, nodes: string[], probe = false): Promise<MachineFacts> {
    if (this.state.connection.status !== "connected")
      throw new Error("Not connected to the gateway.");
    const botId = botIdFromSessionKey(key);
    if (!botId) throw new Error("This task's bot is not known.");
    // Read on the gateway it started on, all of it: one chosen since answers nothing for it.
    const generation = this.generation;
    const same = () => {
      if (generation !== this.generation) throw new Error("Switched to another gateway.");
    };
    const request = async (method: string, params: unknown) => {
      same();
      const result = await this.request(method, params);
      same();
      return result;
    };
    // "Prepare it again" asks the gateway to prepare its own desktop; everything else only reads.
    if (probe) await request("computer.status", { probe: true }).catch(() => null);
    same();
    const facts = await readMachine(request, botId, nodes, this.now());
    same();
    return facts;
  }

  // Managing tasks and the rail's arrangement (`task-actions.ts`, `sidebar.ts`) --------

  /**
   * The context the rail's actions run in: the gateway, and the write tier,
   * asked for through the same request as sending (`ensureScope`) only when an
   * action needs it, by the viewer that started it. `bound` is the connection a guard read: the
   * action then sends only on it.
   */
  private actionContext(
    owner: object | null,
    bound: number | null = null,
    gatewayId: string | null = null,
  ): TaskActionContext & SidebarContext {
    const generation = this.generation;
    // The connection the action's first request went on, and whether it has sent a write yet.
    let epoch = bound;
    let wrote = false;
    return {
      request: async (method, params) => {
        this.checkNotWithdrawn(owner);
        // A Disconnect, a Connect or a switch closes the connection, and moves this on.
        if (generation !== this.generation) throw new Error("Switched to another gateway.");
        // A dropped connection and its reconnect don't, and another gateway can answer that
        // reconnect at the same address: a later step never goes on another connection.
        if (epoch !== null && epoch !== this.epoch)
          throw new Error(wrote ? CONNECTION_CHANGED_AFTER_SEND : CONNECTION_CHANGED);
        epoch = this.epoch;
        if (!taskRead(method)) wrote = true;
        try {
          return await this.request(method, params);
        } catch (error) {
          this.noteMissingScope(error);
          throw error;
        }
      },
      ensureWrite: async () => {
        if (this.options.readOnly)
          throw new Error("This host only reads; it does not change tasks.");
        // Bound to a connection that has gone, it asks none that replaced it, as `request` sends none.
        if (epoch !== null && epoch !== this.epoch)
          throw new Error(wrote ? CONNECTION_CHANGED_AFTER_SEND : CONNECTION_CHANGED);
        await this.ensureScope(WRITE_SCOPE, owner, gatewayId);
        this.checkNotWithdrawn(owner);
      },
      now: () => this.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      stopMark: (key) => this.waiting.stopMark(key),
      stopRuns: async (key) => {
        const runs = (this.state.transcripts[key]?.runs ?? []).filter(
          (run) => run.state === "running" || run.state === "waiting",
        );
        // The engine's Stop is a write of this action too, sent only on the action's connection.
        if (runs.length > 0) wrote = true;
        const here = epoch;
        const bound = () => here !== null && this.epoch === here && this.generation === generation;
        await Promise.all(
          runs.map((run) =>
            this.stopRun(key, run.id, { ...(owner ? { owner } : {}), everyRun: true, bound }),
          ),
        );
        // A Stop refused for want of room for its check: the action says so now, not after its wait.
        const refused = (this.state.transcripts[key]?.runs ?? []).some(
          (run) => run.stopError === TOO_MANY_STOPS && runs.some((each) => each.id === run.id),
        );
        if (refused) throw new Error(TOO_MANY_STOPS);
        return (this.state.transcripts[key]?.runs ?? []).filter((run) => isActive(run.state))
          .length;
      },
      runsActive: (key) =>
        (this.state.transcripts[key]?.runs ?? []).some((run) => isActive(run.state)),
      runMark: (key) => {
        const row = this.rows.get(capId(key, MAX_ID_CHARS));
        const active = row?.hasActiveRun === true || row?.status === "running";
        return `${this.waiting.latestRunId(key) ?? ""}\u0000${active ? "active" : "idle"}`;
      },
    };
  }

  /** A task the gateway just created, listed at once from its answer until `sessions.changed` brings its row. */
  private listCreated(created: CreatedTask): string {
    const key = capId(created.key, MAX_ID_CHARS);
    if (!this.rows.has(key) && isTaskSession(created.row)) {
      // Within the same bound as a list read: the newest `MAX_LISTED_TASKS`, the oldest giving way.
      this.rows = newestRows([...this.rows.values(), created.row], this.keeps);
      this.publishTasks();
    }
    // Made while the rows shown were read on an earlier connection: the list is read again, so
    // the task joins rows of this connection's own read.
    if (!this.rowsReadHere()) this.scheduleRefresh(this.generation);
    return created.key;
  }

  /** A new, empty task under a bot (F-054). Answers its key, already in the task list. */
  async newTask(
    botId: string,
    options: { label?: string | null; owner?: object } = {},
  ): Promise<string> {
    const ctx = this.actionContext(options.owner ?? null);
    const created = await newTask(ctx, botId, options.label ?? null);
    const key = this.listCreated(created);
    // An empty task is named from the first message with text the person sends in it, unless they
    // named it.
    if (!options.label?.trim()) {
      const sessionId = sessionOf(created.row.sessionId);
      this.keepTaskName(key, {
        stage: "waiting",
        sessionId,
        textless: [],
        first: null,
        withMessage: false,
      });
    }
    return key;
  }

  /**
   * A message this client sends in an empty task it made, before one with text (`taskNames`). One
   * with text names the task when everything the task holds is this client's own messages with no
   * text: each person's row in the task's history as the gateway has it just before the name is
   * made is one of them, by the key the gateway stored it under (`<id>:user`, both versions;
   * `onlyOwnRows`). The history this client holds can be behind the task's row, so it isn't what
   * decides. With nothing sent from here yet, a last-message preview on the row is another's
   * message and ends the wait; so does a fifth with no text.
   */
  private noteFirstSend(key: string, message: OutgoingMessage): void {
    const kept = this.taskNames.get(key);
    // Its message is chosen already: only that one, once accepted, names the task.
    if (kept?.stage !== "waiting" || kept.first !== null) return;
    const row = this.rows.get(capId(key, MAX_ID_CHARS));
    if (!this.taskBot(key) || (kept.textless.length === 0 && row?.lastMessagePreview)) {
      this.taskNames.delete(key);
    } else if (message.text) {
      // Named once the gateway accepts it (`nameAccepted`), never before: a message refused, held
      // or never sent goes to no model.
      kept.first = message.id;
    } else if (kept.textless.length < MAX_TEXTLESS_SENDS) {
      kept.textless.push(message.id);
    } else {
      this.taskNames.delete(key);
    }
  }

  /**
   * The gateway accepted a message's `chat.send`: the one a task this client names waits for starts
   * its name, once. For an empty task it is checked again against the task's history as the gateway
   * has it then (`onlyOwnRows`), which this client's copy can be behind.
   */
  private nameAccepted(key: string, messageId: string, text: string): void {
    const kept = this.taskNames.get(key);
    if (kept?.stage !== "waiting" || kept.first !== messageId) return;
    const bot = this.taskBot(key);
    if (!bot || !text) {
      this.taskNames.delete(key);
      return;
    }
    const ownSends = kept.withMessage ? undefined : [...kept.textless, messageId];
    this.startNaming(key, bot, text, kept.sessionId, ownSends);
  }

  /** Note a task this client names; the oldest goes past `MAX_NAMED_TASKS`. */
  private keepTaskName(key: string, naming: TaskNaming): void {
    // A key longer than a task can be opened with is never sent to from here: nothing to keep.
    if (jsonTextLength(key) > MAX_ID_CHARS) return;
    this.taskNames.delete(key);
    if (this.taskNames.size >= MAX_NAMED_TASKS) {
      const oldest = this.taskNames.keys().next();
      if (!oldest.done) this.taskNames.delete(oldest.value);
    }
    this.taskNames.set(key, naming);
  }

  /**
   * Name a task from its first message (`task-names.ts`), on the connection that just created it or
   * sent that message, so with the write access they had: nothing is asked of the person, and
   * nothing that goes wrong is shown.
   */
  private startNaming(
    key: string,
    botId: string,
    text: string,
    sessionId: string | null,
    ownSends?: string[],
  ): void {
    this.keepTaskName(key, {
      stage: "naming",
      sessionId,
      textless: [],
      first: null,
      withMessage: false,
    });
    const ctx = this.actionContext(null, this.epoch);
    const botModel = this.state.bots.find((bot) => bot.id === botId)?.model ?? null;
    void nameTask(
      { request: ctx.request, row: () => this.rows.get(capId(key, MAX_ID_CHARS)) ?? null },
      { key, sessionId, botId, botModel, text, ...(ownSends ? { ownSends } : {}) },
    )
      .catch(() => null)
      .finally(() => {
        if (this.taskNames.get(key)?.stage === "naming") this.taskNames.delete(key);
      });
  }

  /** A bot's replacement first task, "Main", after its last unarchived task went (F-424). */
  async newMainTask(botId: string, options: { owner?: object } = {}): Promise<string> {
    return this.listCreated(await newMainTask(this.actionContext(options.owner ?? null), botId));
  }

  /**
   * The context of a task action: with `stamp`, its write access, then its guard, and bound to
   * the connection that guard read. Access first: asking for it can reconnect, and the guard reads
   * the connection it ends on, so the grant's reconnect doesn't end the action. A drop after the
   * guard does, since another gateway can answer that reconnect at the same address.
   */
  private async settleTaskWrite(
    owner: object | null,
    stamp: GatewayStamp | undefined,
  ): Promise<TaskActionContext> {
    // Unstamped, nothing names the gateway the action was for, so the grant's reconnect still ends
    // it rather than send it to whichever gateway answered.
    if (!stamp) return this.actionContext(owner);
    // What the guard would refuse anyway is refused before access is asked, so a gateway the
    // screen wasn't read on is never asked for it. A connected host runs the guard itself first:
    // right after a hello the identity is still being read, and the guard waits for it.
    this.requireSameTarget(stamp);
    // No gateway answers to a stamp that names none, so none is asked, connected or not.
    if (stamp.gatewayId === null) throw new Error(UNNAMED_GATEWAY);
    if (this.state.connection.status === "connected") await this.requireSameGateway(stamp);
    // A viewer that closed during that wait had no access waiter to withdraw yet.
    this.checkNotWithdrawn(owner);
    // Asked while reconnecting, the access waits for the next gateway to name itself
    // (`resumeUpgrade`).
    await this.actionContext(owner, null, stamp.gatewayId).ensureWrite();
    const epoch = this.epoch;
    await this.requireSameGateway(stamp);
    return this.actionContext(owner, epoch, stamp.gatewayId);
  }

  /** With `stamp`, as for `archiveTask`. */
  async renameTask(
    key: string,
    label: string,
    options: { owner?: object; stamp?: GatewayStamp } = {},
  ): Promise<void> {
    await renameTask(await this.settleTaskWrite(options.owner ?? null, options.stamp), key, label);
  }

  /** With `stamp`, as for `archiveTask`. */
  async pinTask(
    key: string,
    pinned: boolean,
    options: { owner?: object; stamp?: GatewayStamp } = {},
  ): Promise<void> {
    await pinTask(await this.settleTaskWrite(options.owner ?? null, options.stamp), key, pinned);
  }

  /**
   * Mark a task unread or read, with `stamp` as for `archiveTask`. `opened` is a read the person
   * did not ask for (opening the task): it names the unread marker it saw, and is made only
   * while the connection already writes, never asking for access.
   */
  async markTask(
    key: string,
    unread: boolean,
    options: { owner?: object; opened?: boolean; stamp?: GatewayStamp } = {},
  ): Promise<void> {
    if (options.opened) {
      if (!this.holds(WRITE_SCOPE) || this.options.readOnly) return;
      const id = capId(key, MAX_ID_CHARS);
      const row = this.rows.get(id);
      if (!row || row.unread !== true || this.openedReads.has(id)) return;
      if (this.openedReads.size >= MAX_OPENED_READS) return;
      const marker = typeof row.markedUnreadAt === "number" ? row.markedUnreadAt : null;
      this.openedReads.add(id);
      try {
        await markTask(this.actionContext(options.owner ?? null), key, false, marker);
      } finally {
        this.openedReads.delete(id);
      }
      return;
    }
    await markTask(await this.settleTaskWrite(options.owner ?? null, options.stamp), key, unread);
  }

  /**
   * With `stamp` (where the rail listed the task), nothing is sent unless the host still has that
   * target and that gateway connected: a restored copy has the same task keys.
   */
  async archiveTask(
    key: string,
    options: { stop?: boolean; owner?: object; stamp?: GatewayStamp } = {},
  ): Promise<ArchiveResult> {
    return archiveTask(await this.settleTaskWrite(options.owner ?? null, options.stamp), key, {
      stop: options.stop === true,
    });
  }

  async restoreTask(key: string, options: { owner?: object } = {}): Promise<void> {
    await restoreTask(this.actionContext(options.owner ?? null), key);
  }

  /** With `stamp`, as for `archiveTask`. */
  async deleteTask(
    key: string,
    options: { owner?: object; stamp?: GatewayStamp } = {},
  ): Promise<void> {
    await deleteTask(await this.settleTaskWrite(options.owner ?? null, options.stamp), key);
    // Its conversation is gone from the gateway: so are the pictures you sent in it, and the
    // title its first message made.
    this.dropDeletedPictures(({ task }) => task === key);
    this.firstMessageTitles.delete(capId(key, MAX_ID_CHARS));
  }

  /** A bot's archived tasks, read now and not kept (`operator.read`). */
  async listArchived(botId: string): Promise<ArchivedList> {
    if (this.state.connection.status !== "connected")
      throw new Error("Not connected to the gateway.");
    return listArchived(this.actionContext(null), botId, {
      showChannelChats: this.showChannelChats,
      showOtherToolSessions: this.showOtherToolSessions,
      firstMessageTitle: (key, row) => this.firstMessageTitle(key, sessionOfRow(row)),
    });
  }

  // Search (`search.ts`; search.md). All `operator.read`; nothing is kept, and the query is never logged.

  private async search<T>(
    read: (request: (method: string, params: unknown) => Promise<unknown>) => Promise<T>,
  ): Promise<T> {
    if (this.state.connection.status !== "connected")
      throw new Error("Not connected to the gateway.");
    if (this.searches >= MAX_SEARCHES_IN_FLIGHT)
      throw new Error("Other searches are running; try again in a moment.");
    this.searches += 1;
    try {
      return await read((method, params) => this.request(method, params));
    } finally {
      this.searches -= 1;
    }
  }

  /**
   * Messages across bots, or one bot's (`sessions.search`). A chat from an external channel is
   * left out unless "Show external channel chats" is on, and a session another tool opened unless
   * "Show sessions from other tools" is on, as the task list leaves them out (F-519, F-563).
   */
  async searchMessages(query: string, botId: string | null): Promise<MessageSearch> {
    // Decided when the matches arrive, by the switches as they are then, from the session's row:
    // the one the gateway sends with the matches, else the one the list holds. A channel chat is
    // also known by its key; another tool's session that no row places is shown, as the list shows
    // a session it can't place.
    const hidden = (key: string, sent: RawRecord | null) => {
      const row = sent ?? this.rows.get(capId(key, MAX_ID_CHARS)) ?? null;
      return (
        (!this.showChannelChats && externalChannelOf(row ?? { key }) !== null) ||
        (!this.showOtherToolSessions && row !== null && isOtherToolSession(row))
      );
    };
    return this.search((request) =>
      searchMessages(request, query, botId, hidden, (key, row) =>
        this.firstMessageTitle(key, sessionOfRow(row)),
      ),
    );
  }

  /** One page of routines matching the query (`cron.list`). */
  searchRoutines(query: string, offset: number): Promise<RoutineSearch> {
    return this.search((request) => searchRoutines(request, query, offset));
  }

  /** One bot's file names, through its newest listed task (`sessions.files.list`, `sessions.describe`). */
  searchFiles(query: string, botId: string): Promise<FileSearch> {
    let newest: { key: string; updatedAt: number } | null = null;
    for (const task of this.state.tasksByBot[botId] ?? []) {
      const updatedAt = task.updatedAt ?? 0;
      if (!newest || updatedAt > newest.updatedAt) newest = { key: task.key, updatedAt };
    }
    const key = newest?.key ?? null;
    return this.search((request) => searchFiles(request, query, botId, key));
  }

  /** Change the rail's arrangement on the gateway; `base` is this device's, for the first change. */
  async changeSidebar(
    change: SidebarChange,
    base: SidebarPrefs | null,
    options: { owner?: object } = {},
  ): Promise<void> {
    const generation = this.generation;
    // Asked now: a read asked after this write began outranks its answer when they tie.
    const issued = ++this.sidebarIssued;
    const next = await changeSidebar(this.actionContext(options.owner ?? null), change, base);
    // Shown only if nothing newer, by the arrangement's own revision, is shown already.
    if (generation === this.generation) this.setSidebar(next, issued);
  }

  // Usage and warning budgets (`usage.ts`, `usage-engine.ts`; controls.md sections 16, 17) ------

  /** A page's usage figures, read now and not kept; `busy` while the host reads as many as it reads at once. */
  readUsage(request: Omit<UsageReportRequest, "bots">): Promise<UsageReport | UsageBusy> {
    if (this.state.connection.status !== "connected")
      return Promise.reject(new Error("Not connected to the gateway."));
    return this.usage.readReport({ ...request, bots: this.state.bots.map((bot) => bot.id) });
  }

  /** Set or remove a warning budget, kept with the gateway as this person's preference. */
  async changeBudget(change: BudgetChange, options: { owner?: object } = {}): Promise<void> {
    if (this.options.readOnly) throw new Error("This host only reads; it does not change budgets.");
    const owner = options.owner ?? null;
    const url = this.settings?.url;
    await this.actionContext(owner).ensureWrite();
    // A grant of write access reconnects to the same gateway, so the write is bound to the
    // connection that holds it now. A switch to another gateway is never written to.
    if (this.settings?.url !== url) throw new Error("Switched to another gateway.");
    // Every request of the write is the viewer's: none is sent once that viewer has gone.
    await this.usage.changeBudget(change, this.actionContext(owner).request);
  }

  /** The routines a budget can be set for, read now and not kept. */
  listRoutines(): Promise<BudgetRoutine[]> {
    if (this.state.connection.status !== "connected")
      return Promise.reject(new Error("Not connected to the gateway."));
    return this.usage.listRoutines();
  }

  /** Count every budget, and read the providers' limits, again now. */
  async refreshUsage(): Promise<void> {
    if (this.state.connection.status !== "connected") return;
    await Promise.all([this.usage.countBudgets(), this.usage.refreshLimits()]);
  }

  /**
   * Show an arrangement unless a newer one is shown: answers are ordered by the revision the
   * gateway holds with the arrangement (`SidebarPrefs.rev`), never by when they arrive, so a
   * late read or an old write's acknowledgement never hides another device's later change.
   */
  private setSidebar(sidebar: SidebarState, issued: number): void {
    const shown = this.state.sidebar;
    if (sidebar.status === "ok" && shown?.status === "ok") {
      const next = sidebarRev(sidebar.prefs);
      const now = sidebarRev(shown.prefs);
      // A tie (the same revision, or values with none) goes to what was asked last.
      if (next < now || (next === now && issued < this.sidebarShown)) return;
    }
    this.sidebarShown = Math.max(this.sidebarShown, issued);
    this.store.update((state) => ({ ...state, sidebar }));
  }

  /** Read the arrangement the gateway keeps; on any failure the rail keeps its own. */
  private async loadSidebar(generation: number): Promise<void> {
    const issued = ++this.sidebarIssued;
    const epoch = this.epoch;
    try {
      const sidebar = await this.readAgain(
        () => readSidebar(this.actionContext(null)),
        () => generation === this.generation && epoch === this.epoch,
      );
      if (generation === this.generation) this.setSidebar(sidebar, issued);
    } catch (error) {
      this.logFailure("warn", "users.prefs.get", error);
      if (generation === this.generation && this.state.sidebar?.status !== "ok")
        this.setSidebar({ ...initialSidebar, status: "unavailable" }, issued);
    }
  }

  /**
   * The approvals pending at a connect, for the rail's waiting state (needs
   * `operator.approvals`). The gateway lists a pending approval only to the
   * device whose run asked for it (and to admin), so this restores this device's
   * own; another device learns of one only from the run's live lifecycle.
   */
  private async loadWaitingApprovals(generation: number): Promise<void> {
    if (!this.holds(APPROVALS_SCOPE)) return;
    const epoch = this.epoch;
    let changed = false;
    let before: ReadonlySet<string> | null = null;
    for (const source of APPROVAL_SOURCES) {
      try {
        const value = await this.readAgain(
          () => this.request(source.method, {}),
          () => generation === this.generation && epoch === this.epoch,
        );
        if (generation !== this.generation) return;
        const record = asRecord(value);
        const items = Array.isArray(value)
          ? value
          : Array.isArray(record?.approvals)
            ? record.approvals
            : [];
        for (const item of items) {
          const card = source.parse(item);
          if (card?.status === "pending") {
            before ??= this.keptKeys();
            changed = this.waiting.restoreApproval(card, this.now()) || changed;
          }
        }
      } catch (error) {
        this.logFailure("warn", source.method, error);
      }
    }
    if (changed && before) this.waitingChanged(before);
  }

  /** The questions pending at a connect, for the rail's waiting state (needs `operator.questions`). */
  private async loadWaitingQuestions(generation: number): Promise<void> {
    if (!this.holds(QUESTIONS_SCOPE)) return;
    const epoch = this.epoch;
    try {
      const listed = asRecord(
        await this.readAgain(
          () => this.request("question.list", {}),
          () => generation === this.generation && epoch === this.epoch,
        ),
      );
      if (generation !== this.generation) return;
      const questions = Array.isArray(listed?.questions) ? listed.questions : [];
      const before = this.keptKeys();
      this.waiting.replaceQuestions(questions, this.now());
      this.waitingChanged(before);
    } catch (error) {
      this.logFailure("warn", "question.list", error);
    }
  }

  // Helpers --------------------------------------------------------------------

  /** `readAgain` with this client's first wait: `READ_AGAIN_MS` unless a test shortens it. */
  private readAgain<T>(read: () => Promise<T>, current: () => boolean, tries?: number): Promise<T> {
    return readAgain(read, current, {
      tries,
      firstMs: this.options.readAgainMs,
      ended: this.connectionEnded.signal,
    });
  }

  /** The current connection has ended: reads waiting to be asked again stop waiting. */
  private endConnection(): void {
    this.connectionEnded.abort();
    this.connectionEnded = new AbortController();
  }

  private request(
    method: string,
    params: unknown,
    options?: { onSent?: (requestId: string) => void },
  ): Promise<unknown> {
    if (!this.protocol) return Promise.reject(new NotSentError());
    // The log policy of the connection this goes out on: a late failure is logged with it,
    // never with that of a connection that replaced it.
    const quiet = this.quiet();
    return this.protocol.request(method, params, options).catch((error: unknown) => {
      if (typeof error === "object" && error !== null) this.dispatchedQuiet.set(error, quiet);
      throw error;
    });
  }

  private setConnection(patch: Partial<ConnectionState>): void {
    // The host pointed anew (Suspend, Disconnect, a fresh pairing): no name card or skipped file
    // read before counts, even on a reconnect to the same address.
    if (patch.target !== undefined && patch.target !== this.state.connection.target) {
      this.botNames.reset();
      this.openclawUpdates.reset();
    }
    const scrubbed = this.scrubConnection(patch);
    this.store.update((state) => ({ ...state, connection: { ...state.connection, ...scrubbed } }));
  }

  /**
   * Whether the host's check of the setup connection to `url` fails now. Once
   * it has failed it keeps failing for that connection: its code and staged
   * reply go, and the connection ends in `SETUP_ENDPOINT_CHANGED`.
   */
  private setupEndpointFails(url: string, generation: number): boolean {
    const setupCheck = this.setupCheck;
    if (setupCheck?.url !== url || setupCheck.check()) return false;
    this.setupEndpointChanged(url, generation);
    return true;
  }

  /**
   * Whether the host's read of the setup connection's listener for `url` now
   * finds what its look found. A failed or failing read is a change, and it
   * ends the connection as `setupEndpointFails` does.
   */
  private async setupListenerHolds(
    check: ClawtrateClient["setupCheck"],
    reads: { reads: AbortController; ended: Promise<false> },
    ours: () => boolean,
  ): Promise<boolean> {
    if (!check?.verify) return true;
    const signal = reads.reads.signal;
    // Never past the reads' end, whether or not the read itself stops then.
    const holds =
      !signal.aborted &&
      (await Promise.race([check.verify(signal).catch(() => false), reads.ended]));
    if (holds && !signal.aborted) return true;
    // Only while its socket is still the connection's, open, under the same setup check: a read
    // of a socket closed or replaced since, or of an earlier check, changes nothing now.
    if (ours()) this.setupEndpointChanged(check.url, this.generation);
    return false;
  }

  /**
   * The plan the lifecycle chose, against the consent the person gave: a new
   * pairing carries the host's code and no stored token, a reuse carries this
   * device's token. Any other plan sends nothing, and the card asks again.
   */
  private planMatchesConsent(plan: Plan, newPairing: boolean, reuse: boolean): void {
    const storedToken = Boolean(plan.selectedAuth.usingStoredDeviceToken || plan.auth?.deviceToken);
    if (newPairing && storedToken) {
      this.pairingAppeared();
      throw new Error("a saved pairing appeared");
    }
    if (newPairing && !plan.auth?.bootstrapToken) {
      // The code ran out before its frame: nothing goes, as with an endpoint that changed.
      this.setupEndpointChanged(this.setupCode?.url ?? this.settings?.url ?? "", this.generation);
      this.close();
      throw new Error("the setup code ran out");
    }
    if (reuse && !storedToken) {
      this.pairingGone();
      throw new Error("the saved pairing is gone");
    }
  }

  /** A setup connection whose endpoint changed: it keeps failing, its credentials go, it says "changed". */
  private setupEndpointChanged(url: string, generation: number): void {
    this.setupCheck = { url, check: () => false, verify: async () => false };
    this.dropSetupCredentials();
    if (generation === this.generation)
      this.setConnection({
        status: "error",
        retryAt: null,
        error: {
          code: SETUP_ENDPOINT_CHANGED,
          message: "The gateway on this computer changed, so Clawtrate didn't connect.",
          hint: null,
        },
      });
  }

  /**
   * A setup connection's report of a newer OpenClaw, validated and held, never published: it is
   * published only if this connection's setup succeeds (`bootstrap`), and dropped otherwise.
   */
  private holdSetupUpdate(generation: number, value: unknown): void {
    const update = readOpenClawUpdate(value);
    this.setupUpdate = update ? { generation, update } : null;
  }

  /** Whether the connection to `url` is the host's setup connection. */
  private isSetup(url: string | undefined): boolean {
    return url !== undefined && this.setupIntent?.url === url;
  }

  private endChangedPairing(): void {
    if (this.setupIntent) this.setupIntent.refusal = "pairing-changed";
    this.close();
    this.dropSetupCredentials();
  }

  /**
   * A new setup pairing found this device's saved pairing for its address:
   * nothing is sent, its code goes, and the card asks for consent to reuse it.
   */
  private pairingAppeared(): void {
    this.endChangedPairing();
    this.setConnection({
      status: "error",
      retryAt: null,
      error: {
        code: SETUP_PAIRING_APPEARED,
        message: "This device has a saved pairing for this address now.",
        hint: null,
      },
    });
  }

  /** A setup reuse found no saved token for its gateway: nothing is sent, the person consents again. */
  private pairingGone(): void {
    this.endChangedPairing();
    this.setConnection({
      status: "error",
      retryAt: null,
      error: {
        code: SETUP_PAIRING_GONE,
        message: "This device's saved pairing for this address is gone.",
        hint: null,
      },
    });
  }

  /** Every terminal path of a setup connection: its code and any staged reply go. */
  private dropSetupCredentials(): void {
    this.setupCode = null;
    if (this.tokenGate) this.tokenGate.staged = null;
  }

  /** The credentials this client holds now: a setup code, a staged or typed token. */
  private secrets(): string[] {
    return [
      this.setupCode?.bootstrapToken,
      this.tokenGate?.staged?.token,
      this.settings?.token,
      this.heldToken,
    ].filter((value): value is string => typeof value === "string" && value.length >= 8);
  }

  /** Any text the gateway sent, with every credential this client holds taken out. */
  private scrub(text: string): string {
    let out = text;
    for (const secret of this.secrets()) out = out.split(secret).join("[credential]");
    return out;
  }

  /** A connection patch with no credential in its error or pairing text. */
  private scrubConnection(patch: Partial<ConnectionState>): Partial<ConnectionState> {
    const next = { ...patch };
    if (next.error) {
      next.error = {
        ...next.error,
        message: this.scrub(next.error.message),
        hint: next.error.hint === null ? null : this.scrub(next.error.hint),
      };
    }
    if (next.pairing) {
      next.pairing = {
        ...next.pairing,
        requestId: this.scrub(next.pairing.requestId),
        deviceId: this.scrub(next.pairing.deviceId),
        approveCommand: this.scrub(next.pairing.approveCommand),
        requestedScopes: next.pairing.requestedScopes.map((scope) => this.scrub(scope)),
        message: this.scrub(next.pairing.message),
        approveNote:
          next.pairing.approveNote === null ? null : this.scrub(next.pairing.approveNote),
      };
    }
    return next;
  }

  private async loadIdentity() {
    this.identity ??= await this.host.signer.loadIdentity();
    return this.identity;
  }

  /** Whether the host keeps this device's credentials in secure storage now; false on any doubt. */
  private async secureCredentials(): Promise<boolean> {
    try {
      return (await this.host.secureCredentials?.()) === true;
    } catch {
      return false;
    }
  }

  /**
   * Whether every socket of the connection to `url` comes from a proved route to this computer's
   * gateway (setup-effortless.md §3): local connect's sockets, each proved when dialled and again
   * before its credential. Those are the setup's own factory with its last proof, or the route the
   * gateway was saved with, as the host gives it. The one place a proved route is named, for the
   * full-access gate.
   */
  private socketsProved(url: string): boolean {
    const check = this.setupCheck?.url === url ? this.setupCheck : null;
    // The setup's own factory, when it has one, makes every socket: its last proof decides.
    if (check?.createSocket) return !!check.prove;
    return this.savedRoute?.url === url && !!this.savedRoute.sockets;
  }

  /**
   * Whether a first pairing at `url` may ask for the six, given full access: always at a
   * protected address; over a proved route only while the person's consent for it holds. It is
   * asked here, before each first-pairing credential, until the first hello spends it or the
   * gateway holds such a request pending. Full access over that route is a plain connect's alone,
   * so a loopback setup code still starts read-only (F-509).
   */
  private firstPairingMayAskFull(url: string): boolean {
    if (protectedGatewayUrl(url)) return true;
    if (this.fullPending !== null && this.fullPending === this.pairingSeen) return true;
    const consent = this.setupCheck?.url === url ? this.setupCheck.consent : undefined;
    return consent?.() === true;
  }

  /**
   * The scopes a connect asks for. A read-only host asks for read. With no saved token, a
   * first pairing asks for all six with full access, and read otherwise. A saved token asks
   * for exactly what it holds, except that a setup connection reusing it asks for read.
   */
  private scopesToAsk(url: string, token: StoredDeviceToken | null): string[] {
    if (this.options.readOnly) return [...READ_SCOPES];
    if (!token)
      return this.fullAccess && this.fullEligible && this.firstPairingMayAskFull(url)
        ? [...FULL_SCOPES]
        : [...READ_SCOPES];
    // A full pairing's token is used for more than read only while full access holds.
    if (token.fullGrant && !this.fullAccess) return [...READ_SCOPES];
    // A setup reusing this device's saved pairing asks for read alone, as its consent says,
    // with full access too; ordinary reconnects ask for the saved grant.
    if (this.isSetup(url)) return [...READ_SCOPES];
    return [...token.heldScopes];
  }

  private async loadToken(
    url: string,
    deviceId: string,
    role: string,
    includeRejected = false,
    // A key captured earlier: a removal compares and deletes the same record it named.
    key = this.tokenKey(url, deviceId, role),
  ): Promise<StoredDeviceToken | null> {
    const raw = await this.host.storage.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDeviceToken> & { scopes?: string[] };
    if (typeof parsed.token !== "string") return null;
    if (!includeRejected && this.writes.rejected.get(key)?.has(parsed.token.trim())) return null;
    const route = typeof parsed.route === "string" ? { route: parsed.route } : {};
    // A token saved over another proved route than the one the settings name now (local
    // connect's profile folder, replaced since and found again) is that route's gateway's, not
    // this one's: it is never this route's, and this route's first pairing replaces it.
    const now = this.settings?.url === url ? this.settings.route : undefined;
    if (route.route !== undefined && now !== undefined && route.route !== now) return null;
    if (parsed.fullGrant === true) {
      const held = Array.isArray(parsed.heldScopes)
        ? FULL_SCOPES.filter((scope) => parsed.heldScopes!.includes(scope))
        : [];
      return {
        token: parsed.token,
        grantedScopes: Array.isArray(parsed.grantedScopes) ? [...parsed.grantedScopes] : held,
        heldScopes: held,
        fullGrant: true,
        ...route,
      };
    }
    return {
      ...route,
      token: parsed.token,
      // Earlier builds stored the grant as `scopes`.
      grantedScopes: parsed.grantedScopes ?? parsed.scopes ?? [],
      // Records from before the write step-up mean read only. Admin is held only when this
      // client asked for it and recorded the grant (`adminHeld`), never because a grant lists it.
      heldScopes: [
        ...normalizeHeldScopes(parsed.heldScopes),
        ...(parsed.adminHeld === true ? [ADMIN_SCOPE] : []),
        ...(parsed.pairingHeld === true ? [PAIRING_SCOPE] : []),
      ],
      ...(parsed.adminHeld === true ? { adminHeld: true } : {}),
      ...(parsed.pairingHeld === true ? { pairingHeld: true } : {}),
    };
  }

  private async writeToken(
    url: string,
    deviceId: string,
    role: string,
    record: StoredDeviceToken,
  ): Promise<void> {
    const key = this.tokenKey(url, deviceId, role);
    // Saved over a proved route, a token keeps that route, and goes on no other socket.
    const route = record.route ?? (this.settings?.url === url ? this.settings.route : undefined);
    await this.host.storage.set(
      key,
      JSON.stringify(route === undefined ? record : { ...record, route }),
    );
    this.writes.grants.set(key, grantBits(record));
  }

  private tokenParams(deviceId: string) {
    return { clientId: CLIENT_ID, deviceId, role: "operator" };
  }

  /** Whether this device's saved pairing with the current gateway is a full pairing's record. */
  private holdsFullPairing(): boolean {
    const url = this.settings?.url;
    const deviceId = this.state.connection.deviceId;
    if (!url || !deviceId) return false;
    return this.writes.grants.get(this.tokenKey(url, deviceId, "operator"))?.full === true;
  }

  /**
   * Device tokens are scoped to one gateway, so a token is never offered to another. An address
   * whose pairing is saved under another spelling of its endpoint uses that record (`tokenAlias`).
   */
  private tokenKey(url: string, deviceId: string, role: string): string {
    return `deviceToken:${encodeURIComponent(this.tokenAlias?.url === url ? this.tokenAlias.spelling : url)}:${deviceId}:${role}`;
  }

  /**
   * Another protected spelling of this address's endpoint with this device's saved pairing, when
   * the address has none of its own: the first found, in `endpointSpellings`'s order.
   */
  private async pairingSpelling(url: string, deviceId: string): Promise<string | null> {
    const key = (each: string) => `deviceToken:${encodeURIComponent(each)}:${deviceId}:operator`;
    if ((await this.host.storage.get(key(url))) !== null) return null;
    for (const each of endpointSpellings(url))
      // Only a protected spelling: a pairing saved at ws:// sent its token unencrypted, and a
      // full grant must never be kept where ws:// reads it.
      if (protectedGatewayUrl(each) && (await this.host.storage.get(key(each))) !== null)
        return each;
    return null;
  }

  /**
   * A token store for one connection. Every operation names its gateway URL,
   * and a write is dropped once that connection is no longer current, checked
   * after every wait, so a late write can never land after a switch, nor once a
   * later connection on the same host store has opened. Writes and removals run
   * in the queue with the gateway's settings, one after another.
   */
  private connectionTokenStore(
    url: string,
    generation: number,
    owner: symbol,
  ): ConnectionTokenStore & {
    /**
     * `store`, for one socket's hello: nothing is staged or written once that socket is retired,
     * and nothing is written once `keeps` says the saved token stays as it is.
     */
    save: (
      params: Parameters<GatewayBrowserDeviceTokenStore["store"]>[0],
      live: () => boolean,
      keeps?: () => boolean,
      grant?: SignedGrant,
    ) => Promise<void>;
  } {
    const current = () => generation === this.generation && this.settings?.url === url;
    const ownsToken = (deviceId: string, role: string) =>
      this.writes.owners.get(this.tokenKey(url, deviceId, role)) === owner;
    const save = async (
      { deviceId, role, token, scopes }: Parameters<GatewayBrowserDeviceTokenStore["store"]>[0],
      live: () => boolean,
      keeps = () => true,
      grant?: SignedGrant,
    ) => {
      if (!current() || !live()) return;
      // A setup connection's first token waits in memory for its grant to be checked.
      const gate = this.tokenGate;
      if (gate?.generation === generation && gate.url === url) {
        gate.staged = { deviceId, role, token, scopes: [...scopes] };
        return;
      }
      // A replacement token is this socket's credential now: taken out of gateway text too.
      this.heldToken = token;
      // Queued with every other token change, so a late rejection cannot remove it.
      await this.changeConnection(async () => {
        if (!current() || !live() || !keeps()) return;
        const existing = await this.loadToken(url, deviceId, role);
        if (!current() || !live() || !keeps()) return;
        if (!ownsToken(deviceId, role)) return;
        // A first pairing that asked for more than read holds exactly what the gateway granted
        // of what it asked for: a narrower grant is kept as it is, and nothing asks again.
        if (
          !existing &&
          this.fullAccess &&
          grant?.asked.some((scope) => !READ_SCOPES.includes(scope))
        ) {
          // A first full pairing granted nothing usable keeps nothing.
          if (!grant.granted.some((scope) => grant.asked.includes(scope))) return;
          await this.writeToken(url, deviceId, role, fullRecord(token, grant.granted, grant.asked));
          // This attempt holds a token now: losing it later ends its full pairing.
          this.planHadToken = true;
          return;
        }
        // A full pairing's replacement token and its narrowed grant go in one write.
        const held =
          existing?.fullGrant && grant
            ? narrowedHeld(existing.heldScopes, grant)
            : (existing?.heldScopes ?? [...READ_SCOPES]);
        await this.writeToken(url, deviceId, role, {
          token,
          // A replacement token is held to what this client asks for, whatever it was granted.
          grantedScopes: scopes.filter((scope) => held.includes(scope)),
          heldScopes: held,
          ...(existing?.adminHeld ? { adminHeld: true } : {}),
          ...(existing?.pairingHeld ? { pairingHeld: true } : {}),
          ...(existing?.fullGrant ? { fullGrant: true } : {}),
        });
        this.planHadToken = true;
      });
    };
    return {
      save,
      ownsToken,
      // The lifecycle uses the record's scopes for reconnects. Report the
      // scopes this client means to hold, so a broader grant is never asked for.
      load: async ({ deviceId, role }) => {
        const record = await this.loadToken(url, deviceId, role);
        if (!record) return null;
        return { token: record.token, scopes: this.scopesToAsk(url, record) };
      },
      store: (params) => save(params, () => true),
      // A removal that names no token could take one saved after the rejection.
      // This client removes a token only through `forget`.
      clear: async () => {},
      // Compare-and-delete, queued after every earlier token change: the token
      // goes only while it is still the one the gateway rejected. A refusal of
      // this connection is accepted now and removes its own gateway's token
      // even if a switch queued first. A connect sends the saved token trimmed,
      // so the comparison trims it too.
      forget: async ({ deviceId, role }, rejected) => {
        if (!current()) return;
        const key = this.tokenKey(url, deviceId, role);
        // Until the removal has run, loads skip the refused token, so a retry never sends it again.
        this.writes.rejected.set(key, (this.writes.rejected.get(key) ?? new Set()).add(rejected));
        // And no retry asks for the six in its place: that takes the person's decision.
        this.endEligibility(url);
        this.writes.refusals += 1;
        await this.changeConnection(async () => {
          const existing = await this.loadToken(url, deviceId, role, true, key);
          if (existing?.token.trim() === rejected) {
            await this.host.storage.delete(key);
            this.writes.grants.set(key, null);
          }
          const refused = this.writes.rejected.get(key);
          refused?.delete(rejected);
          if (refused?.size === 0) this.writes.rejected.delete(key);
        });
      },
    };
  }

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  private randomId(): string {
    if (this.host.randomId) return this.host.randomId();
    const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string): void {
    this.host.log?.(level, this.scrub(message));
  }

  /**
   * A request that failed, logged with the gateway's own words, except on a setup
   * connection: there it is a fixed line, like everything else setup publishes.
   */
  /** Whether this connection is, or was opened as, the host's setup connection. */
  private quiet(): boolean {
    return this.setupGeneration === this.generation || this.isSetup(this.settings?.url);
  }

  /** An engine's warning: on a setup connection, a fixed line, never the gateway's words. */
  private logEngine(message: string): void {
    this.log("warn", this.quiet() ? "a read failed on the setup connection" : message);
  }

  private logFailure(level: "warn" | "error", what: string, error: unknown): void {
    // Quiet if the request went out on a setup connection, or this one is setup's now.
    const setup =
      (typeof error === "object" && error !== null && this.dispatchedQuiet.get(error)) ||
      this.quiet();
    this.log(
      level,
      setup ? `${what} failed on the setup connection` : `${what} failed: ${errorMessage(error)}`,
    );
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const RESYNC_STRENGTH: Record<CaughtUp["reason"], number> = { reconnect: 1, gap: 2 };

function strongerResync(
  a: CaughtUp["reason"] | null,
  b: CaughtUp["reason"] | null,
): CaughtUp["reason"] | null {
  if (!a) return b;
  if (!b) return a;
  return RESYNC_STRENGTH[b] > RESYNC_STRENGTH[a] ? b : a;
}

/**
 * Whether a step rebuilt from history is the step shown: for a tool, the
 * gateway's own call id; for reasoning, the fetched text begins with the text
 * the shown step holds (which keeps the beginning of its text).
 */
function sameStep(
  shown: Run["steps"][number],
  read: Run["steps"][number],
  whole: StepRaw,
): boolean {
  if (shown.kind === "tool")
    return (
      read.kind === "tool" && shown.toolCallId !== null && read.toolCallId === shown.toolCallId
    );
  const thinking = asRecord(whole.call)?.thinking;
  return (
    read.kind === "reasoning" &&
    typeof thinking === "string" &&
    thinking.startsWith(shown.output?.text ?? "")
  );
}

/**
 * Whether the history the gateway returned replaced the message that holds a
 * step with its oversized placeholder (`__openclaw.truncated` with reason
 * `oversized`, for a message above its 131,072-byte limit, whatever
 * `maxChars` asked): a tool result naming the step's call, or an assistant
 * message of the step's run where the step's reasoning anchor is in effect.
 */
function oversizedWhere(
  messages: unknown,
  runId: string,
  step: Run["steps"][number],
  windowCut: boolean,
): boolean {
  const rows = Array.isArray(messages) ? messages : [];
  const oversized = (row: RawRecord) => {
    const meta = asRecord(row.__openclaw);
    return meta?.truncated === true && meta.reason === "oversized";
  };
  if (step.kind === "tool") {
    return rows.some((entry) => {
      const row = asRecord(entry);
      return (
        row !== null &&
        oversized(row) &&
        (row.toolCallId ?? row.tool_call_id ?? row.toolUseId ?? row.tool_use_id) === step.toolCallId
      );
    });
  }
  // The step's anchor, from its id: `reasoning:<runId>:<anchor>:<n>`.
  const prefix = `reasoning:${runId}:`;
  if (!step.id.startsWith(prefix)) return false;
  const rest = step.id.slice(prefix.length);
  const anchor = rest.slice(0, rest.lastIndexOf(":"));
  const first = asRecord(rows[0]);
  let current =
    windowCut && first && first.role !== "user" && asRecord(first.__openclaw)?.runId === runId
      ? "c"
      : "s";
  for (const entry of rows) {
    const row = asRecord(entry);
    if (!row || asRecord(row.__openclaw)?.runId !== runId || row.role !== "assistant") continue;
    if (oversized(row) && current === anchor) return true;
    for (const part of Array.isArray(row.content) ? row.content : []) {
      const block = asRecord(part);
      if (
        (block?.type === "toolCall" || block?.type === "tool_use") &&
        typeof block.id === "string"
      )
        current = `t.${block.id}`;
    }
  }
  return false;
}

/** A count a host sets: the default when it sets none, and never above it. */
export function hostLimit(value: number | undefined, max: number, name: string): number {
  if (value === undefined) return max;
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new RangeError(`${name} must be a whole number from 1 to ${max}.`);
  return value;
}

/** A turn the gateway owes a task after a Stop of this client's stopped a recipient (#645). */
type FollowUp = {
  /** The task's run whose Stop stopped the recipient. */
  stopped: string;
  /** When the wait ends, by this client's clock. */
  until: number;
  /** The run found to be that turn, once found. */
  claimedBy: string | null;
  /** Its stop has been asked: it is not asked again. */
  asked: boolean;
  /** The connection target the wait was made on (`ClawtrateClient.target`). */
  target: number;
  /** The connection the wait was made on (`ClawtrateClient.epoch`): a reconnect lets it go. */
  epoch: number;
};

/**
 * The person has steered `run`: a steer of theirs went into it from this device (its key's alias,
 * kept from when its frame left while the gateway holds it or once it joined), or a message of
 * theirs shows in the task after the message that started it (a steer from anywhere, or a message
 * queued behind it). A steer the gateway took in is part of the run, so the run is theirs, and no
 * automatic stop takes it (#645).
 */
function steeredByPerson(transcript: Transcript, run: Run): boolean {
  if (Object.values(transcript.steerAliases).includes(run.id)) return true;
  const at = transcript.items.findIndex((item) => item.id === run.anchorItemId);
  return at >= 0 && transcript.items.slice(at + 1).some((item) => item.role === "user");
}

/**
 * `run` started after `stopped`, by the gateway's own start times (one task's turns run one after
 * another). Without both times, only a run still going and not being stopped counts (#645).
 */
function startedAfter(run: Run, stopped: Run | undefined): boolean {
  const at = run.reportedStartAt;
  const from = stopped?.reportedStartAt ?? null;
  if (at !== null && from !== null) return at > from;
  return isActive(run.state) && run.state !== "stopping" && run.stopRequestedAt === null;
}

/**
 * The run was started by a message from `sessionKey` through `sessions_send`, as the gateway keeps
 * it: an inter-session row keyed by the run (#645).
 */
function startedBySend(transcript: Transcript, run: Run, sessionKey: string): boolean {
  return (
    run.anchorKeyed === true &&
    transcript.interSession.some(
      (message) =>
        message.itemId === run.anchorItemId &&
        message.sourceTool === BOT_MESSAGE_TOOL &&
        message.sourceSessionKey === sessionKey,
    )
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The reactions kept for the messages these history items show, and no others (F-283). */
function reactionsShown(
  reactions: Record<string, MessageReaction[]>,
  items: TranscriptItem[],
): Record<string, MessageReaction[]> {
  const shown = shownMessageIds({ items } as Transcript);
  const kept = Object.fromEntries(Object.entries(reactions).filter(([id]) => shown.has(id)));
  return Object.keys(kept).length === Object.keys(reactions).length ? reactions : kept;
}

/** The gateway's message ids a transcript shows: its history items' and their bubbles' (F-283). */
function shownMessageIds(transcript: Transcript): Set<string> {
  const ids = new Set<string>();
  for (const item of transcript.items) {
    if (item.messageId) ids.add(item.messageId);
    for (const block of item.blocks)
      if (block.kind === "text" && block.messageId) ids.add(block.messageId);
  }
  return ids;
}

/**
 * A message's reactions as the gateway summarises them (`[{emoji, count, identities}]`), the
 * most counted first, at most `MAX_REACTIONS_PER_MESSAGE`; `mine` when `selfId` reacted.
 */
function reactionsOf(summary: unknown, selfId: string | null): MessageReaction[] {
  if (!Array.isArray(summary)) return [];
  const out: MessageReaction[] = [];
  for (const entry of summary) {
    const row = asRecord(entry);
    const emoji = row?.emoji;
    const count = row?.count;
    if (typeof emoji !== "string" || !emoji || emoji.length > 64) continue;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) continue;
    const identities = Array.isArray(row?.identities) ? row.identities : [];
    const mine =
      selfId !== null && identities.some((each: unknown) => asRecord(each)?.id === selfId);
    out.push({ emoji, count, mine });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, MAX_REACTIONS_PER_MESSAGE);
}

function validTurnLimit(minutes: number): boolean {
  return (
    Number.isInteger(minutes) &&
    minutes >= MIN_TURN_LIMIT_MINUTES &&
    minutes <= MAX_TURN_LIMIT_MINUTES
  );
}
