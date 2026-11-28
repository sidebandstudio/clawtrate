// A picture a person sent, read for their message in the chat (F-557), as the desktop
// reads one (`packages/ui/src/SentFiles.tsx`): core gives it from this app's copy or
// reads it back from the gateway (`readSentPicture`), for the gateway the screen was
// drawn on (its stamp), and its bytes come in parts that are put together here.

import {
  fromBase64,
  toBase64,
  type BridgeCommand,
  type BridgeResultFor,
  type FileTransferStart,
} from "@clawtrate/core";
import { screenStamp, type ShownStamp } from "../../../packages/ui/src/stamp.ts";
import type { SentPictureShown } from "./presentation/sent-files.ts";

type Send = <C extends BridgeCommand>(command: C) => Promise<BridgeResultFor<C>>;
type StateSource = Parameters<typeof screenStamp>[0];

/**
 * Every part of a transfer joined: exactly `bytes` of them, or null. The transfer ends with its
 * last part. Once `stop` says so, between parts, no more are asked for and the transfer is let go.
 */
export async function collectPicture(
  send: Send,
  transfer: FileTransferStart,
  bytes: number,
  stop: () => boolean = () => false,
): Promise<Uint8Array | null> {
  const parts: Uint8Array[] = [];
  try {
    for (let index = 0; index < transfer.chunks; index += 1) {
      if (stop()) throw new Error("Stopped.");
      const data =
        index === 0
          ? transfer.data
          : (await send({ type: "readFileChunk", id: transfer.id!, index })).data;
      const part = fromBase64(data);
      if (!part) throw new Error("The picture's content could not be read.");
      parts.push(part);
    }
  } catch {
    if (transfer.id) void send({ type: "releaseFile", id: transfer.id }).catch(() => {});
    return null;
  }
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined.length === bytes ? joined : null;
}

/** Your picture `index` of the message `messageKey` in task `key`, as the chat shows it. */
export async function loadSentPicture(
  send: Send,
  source: StateSource,
  drawnOn: ShownStamp,
  picture: { key: string; messageKey: string; index: number },
): Promise<SentPictureShown> {
  try {
    const stamp = await screenStamp(source, drawnOn);
    const read = await send({ type: "readSentPicture", ...picture, stamp });
    if (read.status === "failed") return { status: "failed" };
    if (read.status !== "content") return { status: read.status };
    const bytes = await collectPicture(send, read.transfer, read.bytes);
    if (!bytes) return { status: "failed" };
    return { status: "shown", uri: `data:${read.mimeType};base64,${toBase64(bytes)}` };
  } catch {
    return { status: "failed" };
  }
}
