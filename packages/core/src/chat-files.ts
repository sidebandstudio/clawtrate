// A file a bot handed over in a task that isn't a picture (F-115), read only
// when the person asks to save it. It takes the same route as a bot's picture
// (`pictures.ts`): `artifacts.download` issues a download on the gateway's own
// origin with a short ticket, and only that is fetched, by the host. Any type
// is read, never by its bytes: the viewer only hands them to the host to save,
// and nothing opens or runs them.

import type { FileTransferStart } from "./files.ts";
import { MAX_SAVE_BYTES } from "./files.ts";
import { readIssued, type ChatPictureContext } from "./pictures.ts";

/** The largest file saved: the most the host saves for a viewer (`MAX_SAVE_BYTES`, 5 MB). */
export const MAX_CHAT_FILE_BYTES = MAX_SAVE_BYTES;

export type ChatFileRead =
  | {
      status: "content";
      /** The type the gateway served it as, lower-cased; empty when it named none. */
      mimeType: string;
      /** The exact number of bytes fetched. */
      bytes: number;
      transfer: FileTransferStart;
    }
  | { status: "too-large"; limit: number }
  | { status: "failed"; message: string };

/** Whether a file of this size, as the gateway gave it, is over what Clawtrate saves. */
export const isTooLargeToSave = (sizeBytes: number | null): boolean =>
  sizeBytes !== null && sizeBytes > MAX_CHAT_FILE_BYTES;

/** One file of the task, by the id its message gave, read whole or not at all. */
export async function readChatFile(
  ctx: ChatPictureContext,
  key: string,
  artifactId: string,
): Promise<ChatFileRead> {
  const read = await readIssued(ctx, key, artifactId, {
    noun: "file",
    maxBytes: MAX_CHAT_FILE_BYTES,
    tooLarge: "",
    accepts: () => true,
    refused: "",
  });
  if (!read.ok)
    return read.tooLarge
      ? { status: "too-large", limit: MAX_CHAT_FILE_BYTES }
      : { status: "failed", message: read.message };
  let transfer: FileTransferStart;
  try {
    transfer = ctx.transfers.start(ctx.owner, read.bytes, ctx.maxChars);
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
  return { status: "content", mimeType: read.mimeType, bytes: read.bytes.length, transfer };
}
