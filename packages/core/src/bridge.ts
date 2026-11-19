// The contract between a host process (Electron main, the web preview host) and
// the renderer. The host owns the gateway connection; the renderer receives state
// snapshots and sends commands. Transport is IPC in Electron and a WebSocket on the web.

import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  type AttachmentInfo,
  type AttachmentStore,
} from "./attachments.ts";
import { hostLimit, MAX_MESSAGE_CHARS, type ClawtrateClient } from "./client.ts";
import type { CheckoutDiff, FileRead, TaskFileList, WorkspacePage } from "./files.ts";
import type { QuestionAnswer, StepRead } from "./runs.ts";
import {
  MAX_SIDEBAR_BOTS,
  parseSidebar,
  sectionName,
  type SidebarChange,
  type SidebarPrefs,
} from "./sidebar.ts";
import { MAX_TASK_LABEL_CHARS, type ArchivedList, type ArchiveResult } from "./task-actions.ts";
import type { ClawtrateState, TranscriptItem } from "./types.ts";
import type { MissingStep } from "./accounts.ts";
import {
  CHECKIN_EVERY,
  MAX_CHECKIN_EVERY_CHARS,
  MAX_CHECKIN_KEPT,
  MAX_CHECKIN_PROMPT_CHARS,
  type CheckInDraft,
} from "./check-ins.ts";

export type BridgeCommand =
  | { type: "connect"; url: string; token?: string | null }
  /** Connect to the local development gateway. The host supplies its token. */
  | { type: "connectDevGateway" }
  | { type: "disconnect" }
  /** Close the connection and keep the gateway and the pairing, until `retry` reconnects. */
  | { type: "suspend" }
  | { type: "retry" }
  | { type: "openSession"; key: string }
  | { type: "closeSession"; key: string }
  /** Ask the gateway's owner for the interactive scopes; shown in `connection.upgrade`. */
  /** Ask the gateway's owner for the interactive tier, or with `tier: "admin"` for admin with it. */
  | { type: "requestAccess"; tier?: "admin" }
  /**
   * Send to a task this viewer has open. Files are not carried in the command:
   * they are added first (web upload path or Electron IPC) and named by id.
   */
  | {
      type: "sendMessage";
      key: string;
      text: string;
      mode: "auto" | "queue";
      attachmentIds: string[];
    }
  | { type: "retryMessage"; key: string; messageId: string }
  | { type: "deleteMessage"; key: string; messageId: string }
  | { type: "cancelQueued"; key: string; messageId: string }
  | { type: "sendQueuedNow"; key: string; messageId: string }
  /** Take a held or queued message back to edit it: its words and files, files held again under new ids. */
  | { type: "takeBackMessage"; key: string; messageId: string }
  /** Send a held message's words and files again as a new message (Try again on a failed turn). */
  | { type: "sendAgain"; key: string; messageId: string }
  /** A new task under a bot with its first message. The viewer then has it open. */
  | { type: "createTask"; botId: string; text: string; label: string | null }
  | { type: "stopRun"; key: string; runId: string }
  /** Each answer is text as typed, or a shown option named by its original place (`{option}`). */
  | {
      type: "answerQuestion";
      key: string;
      questionId: string;
      answers: Record<string, QuestionAnswer[]>;
    }
  | { type: "dismissQuestion"; key: string; questionId: string }
  /**
   * Allow once, deny, or a standing allow; `expiresInDays` only with
   * `allow-always`. An approval whose text was cut is allowed only with the
   * `shownDigest` `readApprovalText` returned with its whole text.
   */
  | {
      type: "resolveApproval";
      key: string;
      approvalId: string;
      decision: "allow-once" | "allow-always" | "deny";
      expiresInDays: number | null;
      shownDigest?: string | null;
    }
  /** The whole text an approval asks about, read again and not kept. */
  | { type: "readApprovalText"; key: string; approvalId: string }
  /** Read back an approval whose last decision was refused or got no answer. */
  | { type: "checkApproval"; key: string; approvalId: string }
  /** A history item whole, read again and not kept. */
  | { type: "readHistoryItem"; key: string; itemId: string }
  /**
   * The exact raw call and result behind a step card, read whole: available,
   * or not available yet when it was too long to keep and history does not
   * hold it yet.
   */
  | { type: "readStepRaw"; key: string; stepId: string }
  /** Ask again, with its own key, for a task creation the gateway refused, or whose outcome is unknown (it may create a second task). */
  | { type: "retryCreation"; creationId: string }
  /** Forget a task creation that failed, settled or cannot be established. */
  | { type: "dismissCreation"; creationId: string }
  /** A task's files and its folder, read now. */
  | { type: "listTaskFiles"; key: string }
  /** One of a task's files, by the path its list gave, from the reader its place allows. */
  | { type: "readTaskFile"; key: string; path: string }
  /** One page of a folder of a bot's workspace ("" is its root). */
  | { type: "listWorkspace"; botId: string; path: string; offset: number }
  /**
   * A file of a bot's workspace, with the size its listing gave. `key` names the
   * open task whose asset reader may send media, when its folder is the workspace.
   */
  | {
      type: "readWorkspaceFile";
      botId: string;
      path: string;
      size: number | null;
      key: string | null;
    }
  /** The checkout's patch for one of a task's files. */
  | { type: "readCheckoutDiff"; key: string; path: string }
  /** The next part of a file on its way to this viewer (`FileTransferStart`). */
  | { type: "readFileChunk"; id: string; index: number }
  /** Drop a file's transfer. */
  | { type: "releaseFile"; id: string }
  // Provider accounts (bots.md sections 3 to 11). Writes need admin.
  /** Read the accounts, sign-ins, bindings and catalogue again. */
  | { type: "refreshAccounts" }
  /** Read one bot's stored order again: the lock's evidence. */
  | { type: "checkLock"; botId: string }
  /** Start one of the gateway's sign-ins, for the bot the person works on (or null). */
  | { type: "startSignIn"; methodId: string; botId: string | null }
  /** The code or address pasted back, or a company address. Sent once and kept nowhere. */
  | { type: "answerSignIn"; value: string }
  | { type: "cancelSignIn" }
  | { type: "dismissSignIn" }
  /** Read again where a finished sign-in's account landed, after that read failed. */
  | { type: "recheckSignIn" }
  | { type: "chooseSignInAccount"; profileId: string }
  /** An API key the person typed. Sent once to the gateway and kept nowhere. */
  | { type: "saveApiKey"; provider: string; key: string; botId: string | null }
  | { type: "setAccountLabel"; profileId: string; label: string }
  | { type: "disconnectAccount"; profileId: string }
  /** New bot: its name and picture, and the account it runs on (null: the gateway chooses). */
  | {
      type: "createBot";
      name: string;
      avatar: string | null;
      account: string | null;
      provider: string;
      model: string;
      effort: string | null;
    }
  | { type: "dismissBotCreation" }
  /** Finish a bot whose creation is partial, by its id. */
  | { type: "finishBot"; botId: string }
  | {
      type: "changeBotAccount";
      botId: string;
      account: string | null;
      provider: string;
      model: string;
      effort: string | null;
    }
  | { type: "setBotModel"; botId: string; model: string; effort: string | null }
  | { type: "removeBotFallbacks"; botId: string }
  // Check-ins (`check-ins.ts`). Saving needs admin.
  | { type: "refreshCheckIns" }
  /** The draft as `CheckInDraft` says. The outcome is `checkIns.save`. */
  | ({ type: "saveCheckIn"; saveId: string; botId: string } & CheckInDraft)
  | { type: "dismissCheckInSave"; saveId: string }
  /**
   * The rail's task actions (`task-actions.ts`). They act on any task the rail
   * lists, open in this view or not, and each stays at `operator.write`.
   * `newTask` answers the new task's key; the viewer opens it as it opens any task.
   */
  | { type: "newTask"; botId: string; label: string | null }
  /** A bot's replacement first task, "Main" (F-424). */
  | { type: "newMainTask"; botId: string }
  | { type: "renameTask"; key: string; label: string }
  | { type: "pinTask"; key: string; pinned: boolean }
  /** Mark unread or read; `opened` is the read of opening a task, made only while the connection writes. */
  | { type: "markTask"; key: string; unread: boolean; opened: boolean }
  /** Archive; `stop` stops an active run first ("Stop and archive"). */
  | { type: "archiveTask"; key: string; stop: boolean }
  | { type: "restoreTask"; key: string }
  /** Delete a task and its transcript, stopping an active run first. */
  | { type: "deleteTask"; key: string }
  /** A bot's archived tasks, read now. */
  | { type: "listArchived"; botId: string }
  /** Change the rail's arrangement on the gateway; `base` is this device's, used when the gateway holds none. */
  | { type: "changeSidebar"; change: SidebarChange; base: SidebarPrefs | null };

/** What each command answers with. */
export type BridgeResultFor<C extends BridgeCommand> = C extends { type: "sendMessage" }
  ? { messageId: string }
  : C extends { type: "sendAgain" }
    ? { messageId: string }
    : C extends { type: "takeBackMessage" }
      ? { text: string; attachments: AttachmentInfo[] }
      : C extends { type: "createTask" }
        ? { key: string }
        : C extends { type: "readStepRaw" }
          ? StepRead | null
          : C extends { type: "readApprovalText" }
            ? { text: Record<string, string | string[] | null>; digest: string }
            : C extends { type: "readHistoryItem" }
              ? TranscriptItem | null
              : C extends { type: "retryCreation" }
                ? { key: string }
                : C extends { type: "listTaskFiles" }
                  ? TaskFileList
                  : C extends { type: "readTaskFile" | "readWorkspaceFile" }
                    ? FileRead
                    : C extends { type: "listWorkspace" }
                      ? WorkspacePage
                      : C extends { type: "readCheckoutDiff" }
                        ? CheckoutDiff
                        : C extends { type: "readFileChunk" }
                          ? { data: string }
                          : C extends { type: "cancelSignIn" }
                            ? { cancelled: boolean }
                            : C extends { type: "dismissSignIn" }
                              ? { dismissed: boolean }
                              : C extends { type: "saveApiKey" }
                                ? { profileId: string | null }
                                : C extends { type: "createBot" | "finishBot" }
                                  ? { botId: string; missing: MissingStep[] }
                                  : C extends { type: "newTask" | "newMainTask" }
                                    ? { key: string }
                                    : C extends { type: "archiveTask" }
                                      ? ArchiveResult
                                      : C extends { type: "listArchived" }
                                        ? ArchivedList
                                        : void;

export type HostInfo = {
  kind: "desktop" | "web";
  version: string;
  /**
   * Set when the host was started against the local development gateway.
   * `cli` is how a command reaches that instance on its machine
   * (`openclaw --profile <profile>`), for the commands the app shows.
   */
  devGateway: { url: string; cli?: string } | null;
  /** The name this device gives the gateway when it pairs, for example "Clawtrate Desktop". */
  deviceName?: string;
  /**
   * Set when the host pins its connection to the read tier: it never asks for
   * more access and refuses every command that writes.
   */
  readOnly?: boolean;
};

/** Renderer-side view of the bridge, implemented over IPC or a WebSocket. */
export type ClawtrateBridge = {
  info: HostInfo;
  getState(): ClawtrateState;
  subscribe(listener: (state: ClawtrateState) => void): () => void;
  send(command: BridgeCommand): Promise<void>;
  /** Like `send`, and resolves with the command's answer. */
  invoke<C extends BridgeCommand>(command: C): Promise<BridgeResultFor<C>>;
  /**
   * Hand a file to the host for a later `sendMessage`. Checked against the
   * gateway's per-image and per-file ceilings before it is kept.
   */
  attach(file: { name: string; type: string; data: ArrayBuffer }): Promise<AttachmentInfo>;
  /**
   * Save bytes the viewer holds to a file the person chooses (the desktop app's
   * save dialog). Absent where the host has none: a browser downloads instead.
   */
  save?(file: { name: string; data: ArrayBuffer }): Promise<SaveResult>;
};

/**
 * How a save ended. A failed write is read back before anything is said about
 * the file that was there: `unchanged` only when it still holds exactly its
 * earlier bytes, `absent` when nothing is there, `saved-anyway` when it holds
 * exactly the new bytes, and `unknown` otherwise.
 */
export type SaveResult =
  | { status: "saved"; name: string }
  | { status: "cancelled" }
  | {
      status: "failed";
      message: string;
      target: "unchanged" | "absent" | "saved-anyway" | "unknown";
    };

/** Messages a web host sends over its bridge socket. */
export type BridgeServerMessage =
  | { type: "hello"; info: HostInfo; state: ClawtrateState }
  | { type: "state"; state: ClawtrateState }
  | { type: "result"; id: string; ok: true; value?: unknown }
  | { type: "result"; id: string; ok: false; error: string };

/** Messages a renderer sends over a web bridge socket. */
export type BridgeClientMessage = { type: "command"; id: string; command: BridgeCommand };

const SESSION_KEY_PATTERN = /^[\w:.@+-]{1,512}$/;
/**
 * Gateway ids (runs, tool calls, approvals, questions) are opaque: the
 * OpenAI Responses adapter, for one, pairs ids with a vertical bar. They are
 * bounded strings without control characters, never parsed.
 */
export const MAX_OPAQUE_ID_CHARS = 512;
/** Tasks one viewer may hold open at once: the default, and the most a host may set (`BridgePolicy.maxOpenTasks`). */
export const MAX_VIEWER_OPEN_TASKS = 4;
/** Commands one viewer may have in flight at once. */
export const MAX_VIEWER_PENDING_COMMANDS = 16;
const BOT_ID_PATTERN = /^[\w.-]{1,128}$/;
const QUESTION_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_LABEL_CHARS = 512;
/** Why a held or queued message cannot be taken back to edit: its files would not fit. */
export const TAKE_BACK_NO_ROOM =
  "Too many files are waiting to be sent for this message's files to come back with it. The message stays as it is; send or remove some waiting files, then edit it.";
const MAX_ANSWER_CHARS = 4000;

function sessionKey(value: unknown): string {
  if (typeof value !== "string" || !SESSION_KEY_PATTERN.test(value)) {
    throw new Error("invalid session key");
  }
  return value;
}

function id(value: unknown, what: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_OPAQUE_ID_CHARS ||
    [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
  ) {
    throw new Error(`invalid ${what}`);
  }
  return value;
}

/** The longest file path a command may name. */
const MAX_FILE_PATH_CHARS = 4096;

/** A file path as a command names it: bounded, no control characters; "" only where allowed. */
function filePath(value: unknown, allowRoot = false): string {
  if (
    typeof value !== "string" ||
    (!allowRoot && value.length === 0) ||
    value.length > MAX_FILE_PATH_CHARS ||
    [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
  ) {
    throw new Error("invalid path");
  }
  return value;
}

function count(value: unknown, max: number, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max)
    throw new Error(`invalid ${what}`);
  return value;
}

function botId(value: unknown): string {
  if (typeof value !== "string" || !BOT_ID_PATTERN.test(value)) throw new Error("invalid bot id");
  return value;
}

function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("invalid flag");
  return value;
}

/** One change to the rail's arrangement, checked field by field. */
function sidebarChange(value: unknown): SidebarChange {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid change");
  const change = value as Record<string, unknown>;
  switch (change.op) {
    case "pin":
      return { op: "pin", botId: botId(change.botId), pinned: flag(change.pinned) };
    case "hide":
      return { op: "hide", botId: botId(change.botId), hidden: flag(change.hidden) };
    case "move": {
      if (!Array.isArray(change.shown) || change.shown.length > MAX_SIDEBAR_BOTS)
        throw new Error("invalid order");
      const before = change.before;
      return {
        op: "move",
        botId: botId(change.botId),
        before: before === null ? null : botId(before),
        shown: change.shown.map(botId),
      };
    }
    case "section": {
      const section = change.section;
      if (section !== null && typeof section !== "string") throw new Error("invalid section");
      return {
        op: "section",
        botId: botId(change.botId),
        section: section === null ? null : sectionName(section),
      };
    }
    default:
      throw new Error("invalid change");
  }
}

function messageText(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_MESSAGE_CHARS)
    throw new Error("invalid text");
  return value;
}

/** The most options a question can have (the protocol's `maxItems`). */
const MAX_PROTOCOL_OPTIONS = 64;

function answer(item: unknown): QuestionAnswer {
  if (typeof item === "string" && item.length <= MAX_ANSWER_CHARS) return item;
  if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    const entries = Object.entries(item as Record<string, unknown>);
    const option = (item as { option?: unknown }).option;
    if (
      entries.length === 1 &&
      typeof option === "number" &&
      Number.isInteger(option) &&
      option >= 0 &&
      option < MAX_PROTOCOL_OPTIONS
    )
      return { option };
  }
  throw new Error("invalid answers");
}

/** Answers for one card: up to three questions, a handful of answers each. */
function answers(value: unknown): Record<string, QuestionAnswer[]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid answers");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 3) throw new Error("invalid answers");
  const out: Record<string, QuestionAnswer[]> = {};
  for (const [key, list] of entries) {
    if (
      !QUESTION_ID_PATTERN.test(key) ||
      !Array.isArray(list) ||
      list.length === 0 ||
      list.length > 8
    ) {
      throw new Error("invalid answers");
    }
    out[key] = list.map(answer);
  }
  return out;
}

const PROVIDER_PATTERN = /^[\w.-]{1,128}$/;
const PROFILE_PATTERN = /^[\w.-]{1,128}:[^\s]{1,256}$/;

function providerId(value: unknown): string {
  if (typeof value !== "string" || !PROVIDER_PATTERN.test(value))
    throw new Error("invalid provider");
  return value;
}

function profileId(value: unknown): string {
  if (typeof value !== "string" || !PROFILE_PATTERN.test(value)) throw new Error("invalid account");
  return value;
}

function shortText(value: unknown, max: number, what: string): string {
  if (typeof value !== "string" || value.length > max) throw new Error(`invalid ${what}`);
  return value;
}

/**
 * A code, an address or a key the person typed. Its value is never part of
 * an error, so a refusal can be shown or logged without it.
 */
function secretText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192)
    throw new Error("invalid entry");
  return value;
}

/** Validate an untrusted command from a renderer before it reaches the client. */
export function parseBridgeCommand(value: unknown): BridgeCommand {
  if (value === null || typeof value !== "object") throw new Error("invalid command");
  const command = value as Record<string, unknown>;
  switch (command.type) {
    case "connect": {
      if (typeof command.url !== "string" || command.url.length > 2048)
        throw new Error("invalid url");
      const token = command.token;
      if (
        token !== undefined &&
        token !== null &&
        (typeof token !== "string" || token.length > 4096)
      ) {
        throw new Error("invalid token");
      }
      return { type: "connect", url: command.url, token: token ?? null };
    }
    case "requestAccess":
      return command.tier === "admin"
        ? { type: "requestAccess", tier: "admin" }
        : { type: "requestAccess" };
    case "refreshCheckIns":
      return { type: command.type };
    case "saveCheckIn": {
      const every = (value: unknown) =>
        value === null ? null : shortText(value, MAX_CHECKIN_EVERY_CHARS, "cadence");
      const prompt = (value: unknown) =>
        value === null ? null : shortText(value, MAX_CHECKIN_PROMPT_CHARS, "prompt");
      if (command.every !== null && !CHECKIN_EVERY.test(String(command.every)))
        throw new Error("invalid check-in cadence");
      const was = command.was as Record<string, unknown> | null;
      if (!was || typeof was !== "object") throw new Error("invalid draft");
      if (!Array.isArray(command.kept) || command.kept.length > MAX_CHECKIN_KEPT)
        throw new Error("invalid draft");
      return {
        type: "saveCheckIn",
        saveId: id(command.saveId, "save"),
        botId: botId(command.botId),
        gatewayId: id(command.gatewayId, "gateway"),
        every: every(command.every),
        prompt: prompt(command.prompt),
        was: { every: every(was.every), prompt: prompt(was.prompt) },
        kept: command.kept.map((each: Record<string, unknown>) => ({
          botId: botId(each?.botId),
          every: shortText(each?.every, MAX_CHECKIN_EVERY_CHARS, "cadence"),
        })),
      };
    }
    case "dismissCheckInSave":
      return { type: "dismissCheckInSave", saveId: id(command.saveId, "save") };
    case "refreshAccounts":
    case "cancelSignIn":
    case "dismissSignIn":
    case "recheckSignIn":
    case "dismissBotCreation":
      return { type: command.type };
    case "checkLock":
    case "finishBot":
    case "removeBotFallbacks":
      return { type: command.type, botId: botId(command.botId) };
    case "startSignIn":
      return {
        type: "startSignIn",
        methodId: id(command.methodId, "sign-in method"),
        botId: command.botId === null || command.botId === undefined ? null : botId(command.botId),
      };
    case "answerSignIn":
      return { type: "answerSignIn", value: secretText(command.value) };
    case "saveApiKey":
      return {
        type: "saveApiKey",
        provider: providerId(command.provider),
        key: secretText(command.key),
        botId: command.botId === null || command.botId === undefined ? null : botId(command.botId),
      };
    case "chooseSignInAccount":
      return { type: "chooseSignInAccount", profileId: profileId(command.profileId) };
    case "setAccountLabel":
      return {
        type: "setAccountLabel",
        profileId: profileId(command.profileId),
        label: shortText(command.label, 128, "label"),
      };
    case "disconnectAccount":
      return { type: "disconnectAccount", profileId: profileId(command.profileId) };
    case "createBot":
      return {
        type: "createBot",
        name: shortText(command.name, 128, "name"),
        avatar:
          command.avatar === null || command.avatar === undefined
            ? null
            : shortText(command.avatar, 32_768, "picture"),
        account:
          command.account === null || command.account === undefined
            ? null
            : profileId(command.account),
        provider: providerId(command.provider),
        model: id(command.model, "model"),
        effort:
          command.effort === null || command.effort === undefined
            ? null
            : id(command.effort, "effort"),
      };
    case "changeBotAccount":
      return {
        type: "changeBotAccount",
        botId: botId(command.botId),
        account:
          command.account === null || command.account === undefined
            ? null
            : profileId(command.account),
        provider: providerId(command.provider),
        model: id(command.model, "model"),
        effort:
          command.effort === null || command.effort === undefined
            ? null
            : id(command.effort, "effort"),
      };
    case "setBotModel":
      return {
        type: "setBotModel",
        botId: botId(command.botId),
        model: id(command.model, "model"),
        effort:
          command.effort === null || command.effort === undefined
            ? null
            : id(command.effort, "effort"),
      };
    case "connectDevGateway":
    case "disconnect":
    case "suspend":
    case "retry":
      return { type: command.type };
    case "sendMessage": {
      const ids = command.attachmentIds ?? [];
      if (
        !Array.isArray(ids) ||
        ids.length > MAX_ATTACHMENTS_PER_MESSAGE ||
        ids.some((each) => {
          try {
            id(each, "attachment id");
            return false;
          } catch {
            return true;
          }
        })
      ) {
        throw new Error("invalid attachments");
      }
      return {
        type: "sendMessage",
        key: sessionKey(command.key),
        text: messageText(command.text),
        mode: command.mode === "queue" ? "queue" : "auto",
        attachmentIds: ids as string[],
      };
    }
    case "retryMessage":
    case "deleteMessage":
    case "cancelQueued":
    case "sendQueuedNow":
    case "takeBackMessage":
    case "sendAgain":
      return {
        type: command.type,
        key: sessionKey(command.key),
        messageId: id(command.messageId, "message id"),
      };
    case "createTask": {
      if (typeof command.botId !== "string" || !BOT_ID_PATTERN.test(command.botId)) {
        throw new Error("invalid bot id");
      }
      const label = command.label;
      if (
        label !== undefined &&
        label !== null &&
        (typeof label !== "string" || label.length > MAX_LABEL_CHARS)
      ) {
        throw new Error("invalid label");
      }
      return {
        type: "createTask",
        botId: command.botId,
        text: messageText(command.text),
        label: label ?? null,
      };
    }
    case "stopRun":
      return { type: "stopRun", key: sessionKey(command.key), runId: id(command.runId, "run id") };
    case "answerQuestion":
      return {
        type: "answerQuestion",
        key: sessionKey(command.key),
        questionId: id(command.questionId, "question id"),
        answers: answers(command.answers),
      };
    case "dismissQuestion":
      return {
        type: "dismissQuestion",
        key: sessionKey(command.key),
        questionId: id(command.questionId, "question id"),
      };
    case "resolveApproval": {
      const decision = command.decision;
      if (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny") {
        throw new Error("invalid decision");
      }
      const days = command.expiresInDays;
      if (
        days !== undefined &&
        days !== null &&
        (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650)
      ) {
        throw new Error("invalid duration");
      }
      const shown = command.shownDigest;
      if (
        shown !== undefined &&
        shown !== null &&
        (typeof shown !== "string" || shown.length > 128)
      ) {
        throw new Error("invalid digest");
      }
      return {
        type: "resolveApproval",
        key: sessionKey(command.key),
        approvalId: id(command.approvalId, "approval id"),
        decision,
        expiresInDays: days ?? null,
        shownDigest: shown ?? null,
      };
    }
    case "readApprovalText":
      return {
        type: "readApprovalText",
        key: sessionKey(command.key),
        approvalId: id(command.approvalId, "approval id"),
      };
    case "checkApproval":
      return {
        type: "checkApproval",
        key: sessionKey(command.key),
        approvalId: id(command.approvalId, "approval id"),
      };
    case "readHistoryItem":
      return {
        type: "readHistoryItem",
        key: sessionKey(command.key),
        itemId: id(command.itemId, "item id"),
      };
    case "retryCreation":
    case "dismissCreation":
      return { type: command.type, creationId: id(command.creationId, "creation id") };
    case "readStepRaw":
      return {
        type: "readStepRaw",
        key: sessionKey(command.key),
        stepId: id(command.stepId, "step id"),
      };
    case "openSession":
    case "closeSession":
      return { type: command.type, key: sessionKey(command.key) };
    case "listTaskFiles":
      return { type: "listTaskFiles", key: sessionKey(command.key) };
    case "readTaskFile":
    case "readCheckoutDiff":
      return { type: command.type, key: sessionKey(command.key), path: filePath(command.path) };
    case "listWorkspace":
      return {
        type: "listWorkspace",
        botId: botId(command.botId),
        path: filePath(command.path, true),
        offset: count(command.offset, 1_000_000, "offset"),
      };
    case "readWorkspaceFile":
      return {
        type: "readWorkspaceFile",
        botId: botId(command.botId),
        path: filePath(command.path),
        size:
          command.size === null || command.size === undefined
            ? null
            : count(command.size, Number.MAX_SAFE_INTEGER, "size"),
        key: command.key === null || command.key === undefined ? null : sessionKey(command.key),
      };
    case "readFileChunk":
      return {
        type: "readFileChunk",
        id: id(command.id, "transfer id"),
        index: count(command.index, 100_000, "index"),
      };
    case "releaseFile":
      return { type: "releaseFile", id: id(command.id, "transfer id") };
    case "newTask": {
      const label = command.label;
      if (
        label !== null &&
        label !== undefined &&
        (typeof label !== "string" || label.length > MAX_TASK_LABEL_CHARS)
      )
        throw new Error("invalid label");
      return { type: "newTask", botId: botId(command.botId), label: label ?? null };
    }
    case "newMainTask":
    case "listArchived":
      return { type: command.type, botId: botId(command.botId) };
    case "renameTask":
      if (typeof command.label !== "string" || command.label.length > MAX_TASK_LABEL_CHARS)
        throw new Error("invalid label");
      return { type: "renameTask", key: sessionKey(command.key), label: command.label };
    case "pinTask":
      return { type: "pinTask", key: sessionKey(command.key), pinned: flag(command.pinned) };
    case "markTask":
      return {
        type: "markTask",
        key: sessionKey(command.key),
        unread: flag(command.unread),
        opened: command.opened === undefined ? false : flag(command.opened),
      };
    case "archiveTask":
      return { type: "archiveTask", key: sessionKey(command.key), stop: flag(command.stop) };
    case "restoreTask":
    case "deleteTask":
      return { type: command.type, key: sessionKey(command.key) };
    case "changeSidebar":
      return {
        type: "changeSidebar",
        change: sidebarChange(command.change),
        base:
          command.base === null || command.base === undefined ? null : parseSidebar(command.base),
      };
    default:
      throw new Error("unknown command");
  }
}

export type BridgePolicy = {
  /** Connection details for the development gateway, when the host has them. */
  devGateway?: { url: string; token: string | null } | null;
  /** Files viewers added for their next message. */
  attachments?: AttachmentStore;
  /**
   * The most JSON characters a command's answer may have on this host's
   * channel. A whole approval text longer than it is not given, and so not
   * recorded as read: that approval stays deny-only for the viewer.
   */
  maxResultChars?: number;
  /** Tasks one viewer may hold open: `MAX_VIEWER_OPEN_TASKS` unless the host sets fewer. */
  maxOpenTasks?: number;
};

/**
 * One viewer's side of the bridge: a renderer window or a browser tab. It
 * remembers which transcripts this viewer opened, so closing a task in one tab
 * never closes it for another, and `dispose()` releases everything the viewer
 * held when its window or socket goes away.
 */
export type BridgeSession = {
  apply<C extends BridgeCommand>(command: C): Promise<BridgeResultFor<C>>;
  /** The tasks this viewer has open: what its snapshots carry. */
  openTasks(): ReadonlySet<string>;
  dispose(): void;
};

export function createBridgeSession(
  client: ClawtrateClient,
  policy: BridgePolicy = {},
): BridgeSession {
  return new ViewerSession(client, policy);
}

/**
 * A viewer's session. Everything it keeps is an own property, so the
 * retention registry (`owners.ts`) can name each collection and a test can
 * find any it does not name.
 */
class ViewerSession implements BridgeSession {
  /** The tasks this viewer has open, at most `openLimit`. */
  private readonly open = new Set<string>();
  /** Task creations under way: they count against this viewer's open tasks before the gateway is asked. */
  private creating = 0;
  private disposed = false;
  private inFlight = 0;
  /** Names this viewer to the client, so what it asked for is withdrawn when it goes away. */
  private readonly owner = {};
  private readonly client: ClawtrateClient;
  private readonly policy: BridgePolicy;

  /** Tasks this viewer may hold open: the host's count, at most `MAX_VIEWER_OPEN_TASKS`. */
  private readonly openLimit: number;

  constructor(client: ClawtrateClient, policy: BridgePolicy) {
    this.client = client;
    this.policy = policy;
    this.openLimit = hostLimit(policy.maxOpenTasks, MAX_VIEWER_OPEN_TASKS, "maxOpenTasks");
  }

  /** Task commands act only on tasks this viewer has open. */
  private mine(key: string): string {
    if (!this.open.has(key)) throw new Error("This task is not open in this view.");
    return key;
  }

  /** File reads answer this viewer: its transfers are its own, sized to its channel. */
  private fileOptions(): { owner: object; maxChars?: number } {
    return {
      owner: this.owner,
      ...(this.policy.maxResultChars !== undefined ? { maxChars: this.policy.maxResultChars } : {}),
    };
  }

  private checkRoom(): void {
    if (this.open.size + this.creating >= this.openLimit) {
      throw new Error(`A view can hold ${this.openLimit} tasks open at once.`);
    }
  }

  /** A task this viewer asked to create, or to create again, is one of its open tasks from the start. */
  private async created(make: () => Promise<string>): Promise<{ key: string }> {
    this.checkRoom();
    this.creating += 1;
    let key: string;
    try {
      key = await make();
    } finally {
      this.creating -= 1;
    }
    // The client already counts this viewer's interest in the new task.
    if (this.disposed || this.open.has(key)) this.client.closeSession(key);
    else this.open.add(key);
    return { key };
  }

  private async run(command: BridgeCommand): Promise<unknown> {
    const { client, policy, owner } = this;
    if (this.disposed) throw new Error("this viewer has disconnected");
    switch (command.type) {
      case "connect":
        return client.connect({ url: command.url, token: command.token ?? null });
      case "connectDevGateway":
        if (!policy.devGateway) {
          throw new Error("No development gateway is configured on this host.");
        }
        return client.connect(policy.devGateway);
      case "disconnect":
        return client.disconnect();
      case "suspend":
        return client.suspend();
      case "retry":
        return client.retryNow();
      case "openSession":
        if (!this.open.has(command.key)) {
          this.checkRoom();
          client.openSession(command.key);
          this.open.add(command.key);
        }
        return;
      case "closeSession":
        if (this.open.delete(command.key)) client.closeSession(command.key);
        return;
      case "requestAccess":
        return client.requestAccess(command.tier === "admin" ? "admin" : "interactive");
      case "refreshAccounts":
        return client.refreshAccounts();
      case "checkLock":
        return client.checkLock(command.botId);
      case "startSignIn":
        return client.startSignIn(command.methodId, command.botId);
      case "answerSignIn":
        return client.answerSignIn(command.value);
      case "cancelSignIn":
        return client.cancelSignIn();
      case "dismissSignIn":
        return client.dismissSignIn();
      case "recheckSignIn":
        return client.recheckSignIn();
      case "chooseSignInAccount":
        return client.chooseSignInAccount(command.profileId);
      case "saveApiKey":
        return client.saveApiKey(command.provider, command.key, command.botId);
      case "setAccountLabel":
        return client.setAccountLabel(command.profileId, command.label);
      case "disconnectAccount":
        return client.disconnectAccount(command.profileId);
      case "createBot":
        return client.createBot({
          name: command.name,
          avatar: command.avatar,
          account: command.account,
          provider: command.provider,
          model: command.model,
          effort: command.effort,
        });
      case "dismissBotCreation":
        return client.dismissBotCreation();
      case "finishBot":
        return client.finishBot(command.botId);
      case "changeBotAccount":
        return client.changeBotAccount(
          command.botId,
          command.account,
          command.provider,
          command.model,
          command.effort,
        );
      case "setBotModel":
        return client.setBotModel(command.botId, command.model, command.effort);
      case "removeBotFallbacks":
        return client.removeBotFallbacks(command.botId);
      case "refreshCheckIns":
        return client.refreshCheckIns();
      case "saveCheckIn":
        return client.saveCheckIn(command.saveId, command.botId, {
          gatewayId: command.gatewayId,
          every: command.every,
          prompt: command.prompt,
          was: command.was,
          kept: command.kept,
        });
      case "dismissCheckInSave":
        return client.dismissCheckInSave(command.saveId);
      case "sendMessage": {
        const key = this.mine(command.key);
        if (command.attachmentIds.length > 0 && !policy.attachments) {
          throw new Error("This host does not take files.");
        }
        // The files leave the store as the message takes them, so they are never counted twice;
        // a refused message puts them back.
        const taken = policy.attachments?.take(command.attachmentIds) ?? {
          attachments: [],
          restore: () => {},
        };
        try {
          const messageId = client.sendMessage(key, command.text, {
            mode: command.mode,
            attachments: taken.attachments,
          });
          return { messageId };
        } catch (error) {
          taken.restore();
          throw error;
        }
      }
      case "retryMessage":
        return client.retryMessage(this.mine(command.key), command.messageId);
      case "deleteMessage":
        return client.deleteMessage(this.mine(command.key), command.messageId);
      case "cancelQueued":
        return client.cancelQueued(this.mine(command.key), command.messageId);
      case "sendQueuedNow":
        return client.sendQueuedNow(this.mine(command.key), command.messageId);
      case "sendAgain":
        return { messageId: client.sendAgain(this.mine(command.key), command.messageId) };
      case "takeBackMessage": {
        const key = this.mine(command.key);
        if (!policy.attachments) {
          const back = client.takeBack(key, command.messageId);
          if (back.attachments.length > 0) throw new Error("This host does not take files.");
          return { text: back.text, attachments: [] };
        }
        // All or nothing: the whole batch is checked, bytes and count, before the message
        // is taken back; when it cannot fit, the message stays exactly as it was.
        const files = client.peekTakeBack(key, command.messageId).attachments;
        if (!policy.attachments.fits(files)) throw new Error(TAKE_BACK_NO_ROOM);
        const back = client.takeBack(key, command.messageId);
        return { text: back.text, attachments: policy.attachments.restore(back.attachments) };
      }
      case "createTask":
        // Until the gateway is asked, a viewer that goes away takes its request with it.
        return this.created(() =>
          client.createTask(command.botId, command.text, {
            ...(command.label ? { label: command.label } : {}),
            owner,
          }),
        );
      case "stopRun":
        return client.stopRun(this.mine(command.key), command.runId, { owner });
      case "answerQuestion":
        return client.answerQuestion(this.mine(command.key), command.questionId, command.answers, {
          owner,
        });
      case "dismissQuestion":
        return client.dismissQuestion(this.mine(command.key), command.questionId, { owner });
      case "resolveApproval":
        return client.resolveApproval(
          this.mine(command.key),
          command.approvalId,
          command.decision,
          {
            expiresInDays: command.expiresInDays,
            owner,
            shownDigest: command.shownDigest ?? null,
          },
        );
      case "readApprovalText":
        return client.readApprovalText(this.mine(command.key), command.approvalId, {
          owner,
          ...(policy.maxResultChars !== undefined ? { maxChars: policy.maxResultChars } : {}),
        });
      case "checkApproval":
        return client.checkApproval(this.mine(command.key), command.approvalId);
      case "readHistoryItem":
        return client.readHistoryItem(this.mine(command.key), command.itemId);
      case "retryCreation":
        return this.created(() => client.retryCreation(command.creationId, { owner }));
      case "dismissCreation":
        return client.dismissCreation(command.creationId);
      case "readStepRaw":
        return client.readStepRaw(this.mine(command.key), command.stepId);
      case "listTaskFiles":
        return client.listTaskFiles(this.mine(command.key), this.fileOptions());
      case "readTaskFile":
        return client.readTaskFile(this.mine(command.key), command.path, this.fileOptions());
      case "readCheckoutDiff":
        return client.readCheckoutDiff(this.mine(command.key), command.path, this.fileOptions());
      case "listWorkspace":
        return client.listWorkspace(
          command.botId,
          command.path,
          command.offset,
          this.fileOptions(),
        );
      case "readWorkspaceFile":
        return client.readWorkspaceFile(
          command.botId,
          command.path,
          command.size,
          command.key === null ? null : this.mine(command.key),
          this.fileOptions(),
        );
      case "readFileChunk":
        return client.readFileChunk(command.id, command.index, owner);
      case "releaseFile":
        return client.releaseFile(command.id, owner);
      case "newTask":
        return { key: await client.newTask(command.botId, { label: command.label, owner }) };
      case "newMainTask":
        return { key: await client.newMainTask(command.botId, { owner }) };
      case "renameTask":
        return client.renameTask(command.key, command.label, { owner });
      case "pinTask":
        return client.pinTask(command.key, command.pinned, { owner });
      case "markTask":
        return client.markTask(command.key, command.unread, { owner, opened: command.opened });
      case "archiveTask":
        return client.archiveTask(command.key, { stop: command.stop, owner });
      case "restoreTask":
        return client.restoreTask(command.key, { owner });
      case "deleteTask":
        return client.deleteTask(command.key, { owner });
      case "listArchived":
        return client.listArchived(command.botId);
      case "changeSidebar":
        return client.changeSidebar(command.change, command.base, { owner });
    }
  }

  apply<C extends BridgeCommand>(command: C): Promise<BridgeResultFor<C>> {
    if (this.inFlight >= MAX_VIEWER_PENDING_COMMANDS) {
      return Promise.reject(
        new Error("Too many requests are waiting; try again when they finish."),
      );
    }
    this.inFlight += 1;
    return this.run(command).finally(() => {
      this.inFlight -= 1;
    }) as Promise<BridgeResultFor<C>>;
  }

  openTasks(): ReadonlySet<string> {
    return this.open;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // What this viewer asked for and the gateway has not been asked yet goes with it, now.
    this.client.withdraw(this.owner);
    for (const key of this.open) this.client.closeSession(key);
    this.open.clear();
  }
}

/**
 * Coalesce rapid store updates into one snapshot per tick, so a burst of
 * streaming events does not flood IPC or the bridge socket.
 */
export function batchSnapshots(
  subscribe: (listener: (state: ClawtrateState) => void) => () => void,
  emit: (state: ClawtrateState) => void,
  delayMs = 16,
): () => void {
  let pending: ClawtrateState | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = subscribe((state) => {
    pending = state;
    timer ??= setTimeout(() => {
      timer = null;
      if (pending) emit(pending);
      pending = null;
    }, delayMs);
  });
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}
