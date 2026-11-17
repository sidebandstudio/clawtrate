// The contract between a host process (Electron main, the web preview host) and
// the renderer. The host owns the gateway connection; the renderer receives state
// snapshots and sends commands. Transport is IPC in Electron and a WebSocket on the web.

import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  type AttachmentInfo,
  type AttachmentStore,
} from "./attachments.ts";
import { MAX_MESSAGE_CHARS, type ClawtrateClient } from "./client.ts";
import type { QuestionAnswer, StepRead } from "./runs.ts";
import type { ClawtrateState, TranscriptItem } from "./types.ts";

export type BridgeCommand =
  | { type: "connect"; url: string; token?: string | null }
  /** Connect to the local development gateway. The host supplies its token. */
  | { type: "connectDevGateway" }
  | { type: "disconnect" }
  | { type: "retry" }
  | { type: "openSession"; key: string }
  | { type: "closeSession"; key: string }
  /** Ask the gateway's owner for the interactive scopes; shown in `connection.upgrade`. */
  | { type: "requestAccess" }
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
  | { type: "dismissCreation"; creationId: string };

/** What each command answers with. */
export type BridgeResultFor<C extends BridgeCommand> = C extends { type: "sendMessage" }
  ? { messageId: string }
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
            : void;

export type HostInfo = {
  kind: "desktop" | "web";
  version: string;
  /** Set when the host was started against the local development gateway. */
  devGateway: { url: string } | null;
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
/** Tasks one viewer may hold open at once. */
export const MAX_VIEWER_OPEN_TASKS = 4;
/** Commands one viewer may have in flight at once. */
export const MAX_VIEWER_PENDING_COMMANDS = 16;
const BOT_ID_PATTERN = /^[\w.-]{1,128}$/;
const QUESTION_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_LABEL_CHARS = 512;
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
    case "connectDevGateway":
    case "disconnect":
    case "retry":
    case "requestAccess":
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
  const open = new Set<string>();
  /** Task creations under way: they count against this viewer's open tasks before the gateway is asked. */
  let creating = 0;
  let disposed = false;
  let inFlight = 0;
  /** Names this viewer to the client, so what it asked for is withdrawn when it goes away. */
  const owner = {};
  /** Task commands act only on tasks this viewer has open. */
  const mine = (key: string) => {
    if (!open.has(key)) throw new Error("This task is not open in this view.");
    return key;
  };
  const run = async (command: BridgeCommand): Promise<unknown> => {
    if (disposed) throw new Error("this viewer has disconnected");
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
      case "retry":
        return client.retryNow();
      case "openSession":
        if (!open.has(command.key)) {
          if (open.size + creating >= MAX_VIEWER_OPEN_TASKS) {
            throw new Error(`A view can hold ${MAX_VIEWER_OPEN_TASKS} tasks open at once.`);
          }
          client.openSession(command.key);
          open.add(command.key);
        }
        return;
      case "closeSession":
        if (open.delete(command.key)) client.closeSession(command.key);
        return;
      case "requestAccess":
        return client.requestAccess();
      case "sendMessage": {
        const key = mine(command.key);
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
        return client.retryMessage(mine(command.key), command.messageId);
      case "deleteMessage":
        return client.deleteMessage(mine(command.key), command.messageId);
      case "cancelQueued":
        return client.cancelQueued(mine(command.key), command.messageId);
      case "sendQueuedNow":
        return client.sendQueuedNow(mine(command.key), command.messageId);
      case "createTask": {
        // The new task is one of this viewer's open tasks from the start.
        if (open.size + creating >= MAX_VIEWER_OPEN_TASKS) {
          throw new Error(`A view can hold ${MAX_VIEWER_OPEN_TASKS} tasks open at once.`);
        }
        creating += 1;
        let key: string;
        try {
          // Until the gateway is asked, a viewer that goes away takes its request with it.
          key = await client.createTask(command.botId, command.text, {
            ...(command.label ? { label: command.label } : {}),
            owner,
          });
        } finally {
          creating -= 1;
        }
        // The client already counts this viewer's interest in the new task.
        if (disposed || open.has(key)) client.closeSession(key);
        else open.add(key);
        return { key };
      }
      case "stopRun":
        return client.stopRun(mine(command.key), command.runId, { owner });
      case "answerQuestion":
        return client.answerQuestion(mine(command.key), command.questionId, command.answers, {
          owner,
        });
      case "dismissQuestion":
        return client.dismissQuestion(mine(command.key), command.questionId, { owner });
      case "resolveApproval":
        return client.resolveApproval(mine(command.key), command.approvalId, command.decision, {
          expiresInDays: command.expiresInDays,
          owner,
          shownDigest: command.shownDigest ?? null,
        });
      case "readApprovalText":
        return client.readApprovalText(mine(command.key), command.approvalId, {
          owner,
          ...(policy.maxResultChars !== undefined ? { maxChars: policy.maxResultChars } : {}),
        });
      case "readHistoryItem":
        return client.readHistoryItem(mine(command.key), command.itemId);
      case "retryCreation": {
        if (open.size + creating >= MAX_VIEWER_OPEN_TASKS) {
          throw new Error(`A view can hold ${MAX_VIEWER_OPEN_TASKS} tasks open at once.`);
        }
        creating += 1;
        let key: string;
        try {
          key = await client.retryCreation(command.creationId, { owner });
        } finally {
          creating -= 1;
        }
        if (disposed || open.has(key)) client.closeSession(key);
        else open.add(key);
        return { key };
      }
      case "dismissCreation":
        return client.dismissCreation(command.creationId);
      case "readStepRaw":
        return client.readStepRaw(mine(command.key), command.stepId);
    }
  };
  return {
    apply: <C extends BridgeCommand>(command: C) => {
      if (inFlight >= MAX_VIEWER_PENDING_COMMANDS) {
        return Promise.reject(
          new Error("Too many requests are waiting; try again when they finish."),
        );
      }
      inFlight += 1;
      return run(command).finally(() => {
        inFlight -= 1;
      }) as Promise<BridgeResultFor<C>>;
    },
    openTasks: () => open,
    dispose() {
      if (disposed) return;
      disposed = true;
      // What this viewer asked for and the gateway has not been asked yet goes with it, now.
      client.withdraw(owner);
      for (const key of open) client.closeSession(key);
      open.clear();
    },
  };
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
