// The contract between a host process (Electron main, the web preview host) and
// the renderer. The host owns the gateway connection; the renderer receives state
// snapshots and sends commands. Transport is IPC in Electron and a WebSocket on the web.

import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  type AttachmentInfo,
  type AttachmentStore,
} from "./attachments.ts";
import { MAX_MESSAGE_CHARS, type ClawtrateClient } from "./client.ts";
import type { StepRaw } from "./runs.ts";
import type { ClawtrateState } from "./types.ts";

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
  | { type: "answerQuestion"; key: string; questionId: string; answers: Record<string, string[]> }
  | { type: "dismissQuestion"; key: string; questionId: string }
  /** Allow once, deny, or a standing allow; `expiresInDays` only with `allow-always`. */
  | {
      type: "resolveApproval";
      key: string;
      approvalId: string;
      decision: "allow-once" | "allow-always" | "deny";
      expiresInDays: number | null;
    }
  /** The exact raw call and result behind a step card, however large. */
  | { type: "readStepRaw"; key: string; stepId: string };

/** What each command answers with. */
export type BridgeResultFor<C extends BridgeCommand> = C extends { type: "sendMessage" }
  ? { messageId: string }
  : C extends { type: "createTask" }
    ? { key: string }
    : C extends { type: "readStepRaw" }
      ? StepRaw | null
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
const ID_PATTERN = /^[\w:.@+-]{1,256}$/;
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
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`invalid ${what}`);
  return value;
}

function messageText(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_MESSAGE_CHARS)
    throw new Error("invalid text");
  return value;
}

/** Answers for one card: up to three questions, a handful of strings each. */
function answers(value: unknown): Record<string, string[]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid answers");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 3) throw new Error("invalid answers");
  const out: Record<string, string[]> = {};
  for (const [key, list] of entries) {
    if (
      !QUESTION_ID_PATTERN.test(key) ||
      !Array.isArray(list) ||
      list.length === 0 ||
      list.length > 8
    ) {
      throw new Error("invalid answers");
    }
    if (list.some((item) => typeof item !== "string" || item.length > MAX_ANSWER_CHARS)) {
      throw new Error("invalid answers");
    }
    out[key] = list as string[];
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
        ids.some((each) => typeof each !== "string" || !ID_PATTERN.test(each))
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
      if (
        typeof command.approvalId !== "string" ||
        command.approvalId.length > 256 ||
        !command.approvalId
      ) {
        throw new Error("invalid approval id");
      }
      return {
        type: "resolveApproval",
        key: sessionKey(command.key),
        approvalId: command.approvalId,
        decision,
        expiresInDays: days ?? null,
      };
    }
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
};

/**
 * One viewer's side of the bridge: a renderer window or a browser tab. It
 * remembers which transcripts this viewer opened, so closing a task in one tab
 * never closes it for another, and `dispose()` releases everything the viewer
 * held when its window or socket goes away.
 */
export type BridgeSession = {
  apply<C extends BridgeCommand>(command: C): Promise<BridgeResultFor<C>>;
  dispose(): void;
};

export function createBridgeSession(
  client: ClawtrateClient,
  policy: BridgePolicy = {},
): BridgeSession {
  const open = new Set<string>();
  let disposed = false;
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
          open.add(command.key);
          client.openSession(command.key);
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
        const attachments = policy.attachments?.get(command.attachmentIds) ?? [];
        const messageId = client.sendMessage(key, command.text, {
          mode: command.mode,
          attachments,
        });
        policy.attachments?.release(command.attachmentIds);
        return { messageId };
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
        const key = await client.createTask(command.botId, command.text, {
          ...(command.label ? { label: command.label } : {}),
        });
        // The client already counts this viewer's interest in the new task.
        if (disposed || open.has(key)) client.closeSession(key);
        else open.add(key);
        return { key };
      }
      case "stopRun":
        return client.stopRun(mine(command.key), command.runId);
      case "answerQuestion":
        return client.answerQuestion(mine(command.key), command.questionId, command.answers);
      case "dismissQuestion":
        return client.dismissQuestion(mine(command.key), command.questionId);
      case "resolveApproval":
        return client.resolveApproval(mine(command.key), command.approvalId, command.decision, {
          expiresInDays: command.expiresInDays,
        });
      case "readStepRaw":
        return client.stepRaw(mine(command.key), command.stepId);
    }
  };
  return {
    apply: <C extends BridgeCommand>(command: C) => run(command) as Promise<BridgeResultFor<C>>,
    dispose() {
      if (disposed) return;
      disposed = true;
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
