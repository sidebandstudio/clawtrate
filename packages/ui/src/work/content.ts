// A file's content as the viewer holds it while it is shown: the bytes put
// together from the reader's chunks, and what they say as text. Nothing here
// outlives the reader that shows it.

import {
  fromBase64,
  type ClawtrateBridge,
  type FileRead,
  type FileTransferStart,
} from "@clawtrate/core";

export type Shown = Extract<FileRead, { status: "content" }> & {
  data: Uint8Array;
  /** The text, strictly decoded, for a text file; null otherwise. */
  text: string | null;
};

/**
 * Every chunk of a transfer, put together: exactly `bytes` of them, or a sentence
 * saying what went wrong. The transfer ends with its last chunk.
 */
export async function collectBytes(
  bridge: ClawtrateBridge,
  transfer: FileTransferStart,
  bytes: number,
): Promise<Uint8Array | { status: "failed"; message: string }> {
  const parts: Uint8Array[] = [];
  const first = fromBase64(transfer.data);
  if (!first) return { status: "failed", message: "The file's content could not be read." };
  parts.push(first);
  try {
    for (let index = 1; index < transfer.chunks; index += 1) {
      const chunk = await bridge.invoke({ type: "readFileChunk", id: transfer.id!, index });
      const part = fromBase64(chunk.data);
      if (!part) throw new Error("The file's content could not be read.");
      parts.push(part);
    }
  } catch (error) {
    if (transfer.id) void bridge.send({ type: "releaseFile", id: transfer.id });
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
  const data = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    data.set(part, at);
    at += part.length;
  }
  if (data.length !== bytes)
    return { status: "failed", message: "The file's content arrived incomplete." };
  return data;
}

/** Read every chunk of a file's content; the transfer ends with its last chunk. */
export async function collect(bridge: ClawtrateBridge, read: FileRead): Promise<Shown | FileRead> {
  if (read.status !== "content") return read;
  const data = await collectBytes(bridge, read.transfer, read.bytes);
  if (!(data instanceof Uint8Array)) return data;
  let text: string | null = null;
  if (read.kind === "text") {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      return { status: "failed", message: "The file's text is not UTF-8." };
    }
  }
  return { ...read, data, text };
}

export function isShown(value: Shown | FileRead | null): value is Shown {
  return value !== null && value.status === "content" && "data" in value;
}
