// What one `chat.send` may carry, computed in one place (parity F-074, F-285): the engine builds
// the request here and checks it here before it reaches the socket, and the composer checks a
// draft with the same function, against the same limits, so a refusal is seen before anything
// is sent and the two never disagree.

import { MAX_ATTACHMENTS_PER_MESSAGE } from "./attachments.ts";
import { utf8Length } from "./encoding.ts";
import type { SendLimits } from "./types.ts";

/** A file as a request carries it, its content aside: what its size depends on. */
export type SizedFile = { fileName: string; mimeType: string; bytes: number };

/** The parts of a `chat.send` its size depends on, as the engine sends them. */
export type SendShape = {
  sessionKey: string;
  /** The words as sent, a command chip's text in front where there is one. */
  text: string;
  /** The message id, which is the request's idempotency key. */
  idempotencyKey: string;
  queueMode: "steer" | "followup";
  replyToId?: string | null;
  /** The gateway's id of the session the task's history came from, when it named one. */
  sessionId?: string | null;
  files: SizedFile[];
};

/** The id length the request frame's `id` is counted at: past any the protocol client makes. */
const FRAME_ID_CHARS = 64;
/** The request frame around `params` (`{"type":"req","id":…,"method":"chat.send","params":…}`). */
const FRAME_ENVELOPE_BYTES =
  utf8Length(
    JSON.stringify({ type: "req", id: "x".repeat(FRAME_ID_CHARS), method: "chat.send", params: 0 }),
  ) - 1;

/** A file's type as `chat.send` names it. */
export const attachmentType = (mimeType: string) =>
  mimeType.toLowerCase().startsWith("image/") ? "image" : "file";

/** The `chat.send` parameters, built only here. `content` is each file's base64. */
export function chatSendParams<A extends { fileName: string; mimeType: string; content: string }>(
  shape: Omit<SendShape, "files">,
  attachments: Array<A & { type: string }>,
) {
  return {
    sessionKey: shape.sessionKey,
    message: shape.text,
    idempotencyKey: shape.idempotencyKey,
    // Always the mode meant: with none the gateway steers.
    queueMode: shape.queueMode,
    // For that session only: under a key whose task was deleted, the gateway refuses the send
    // instead of starting a new, empty task there (F-278). It applies neither to a steer.
    ...(shape.sessionId && shape.queueMode !== "steer"
      ? { sessionId: shape.sessionId, expectedLeafEntryId: null }
      : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(shape.replyToId ? { replyToId: shape.replyToId } : {}),
  };
}

/** The bytes of a file's base64 form: four for every three, padded. */
const base64Bytes = (bytes: number) => Math.ceil(bytes / 3) * 4;

/**
 * The exact size in bytes of the request frame that would carry this message: its parameters as
 * JSON, every escape counted, each file's base64 (which needs none), and the frame around them.
 */
export function sendFrameBytes(shape: SendShape): number {
  const params = chatSendParams(
    shape,
    shape.files.map((file) => ({
      type: attachmentType(file.mimeType),
      mimeType: file.mimeType,
      fileName: file.fileName,
      content: "",
    })),
  );
  return (
    utf8Length(JSON.stringify(params)) +
    shape.files.reduce((sum, file) => sum + base64Bytes(file.bytes), 0) +
    FRAME_ENVELOPE_BYTES
  );
}

/** Why one file cannot go, or null. */
export type FileRefusal = { kind: "image" | "file"; bytes: number; limit: number };

export function fileRefusal(file: SizedFile, limits: SendLimits): FileRefusal | null {
  const image = attachmentType(file.mimeType) === "image";
  const limit = image ? limits.imageBytes : limits.fileBytes;
  return file.bytes > limit ? { kind: image ? "image" : "file", bytes: file.bytes, limit } : null;
}

/** Why a message cannot go as one request: too many files, one too large, or the whole frame. */
export type SendRefusal =
  | { kind: "count"; count: number; limit: number }
  | ({ index: number } & FileRefusal)
  | { kind: "frame"; bytes: number; limit: number };

export function sendRefusal(shape: SendShape, limits: SendLimits): SendRefusal | null {
  const most = Math.min(limits.files, MAX_ATTACHMENTS_PER_MESSAGE);
  if (shape.files.length > most) return { kind: "count", count: shape.files.length, limit: most };
  for (const [index, file] of shape.files.entries()) {
    const refused = fileRefusal(file, limits);
    if (refused) return { index, ...refused };
  }
  const bytes = sendFrameBytes(shape);
  return bytes > limits.payloadBytes ? { kind: "frame", bytes, limit: limits.payloadBytes } : null;
}
