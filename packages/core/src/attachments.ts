// Files a renderer hands to its host before sending them with a message. The
// bridge's own frames are small (64 KB on the web host), so files travel
// separately: the web host takes them on an upload path behind the same access
// token, the Electron host over IPC. Both put them here; a `sendMessage`
// command then names them by id. The gateway's ceilings are checked as they
// arrive (per image, per file) and again for the whole frame when sending.

import type { OutgoingAttachment } from "./client.ts";

/** Decoded image ceiling `chat.send` enforces (6 MiB). */
export const MAX_IMAGE_BYTES = 6_291_456;
/** Decoded per-file ceiling `chat.send` enforces by default (20 MiB). */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Most files one message may name. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 20;
/** Most files the host keeps waiting at once, counting ones still arriving. */
export const MAX_PENDING_ATTACHMENTS = 64;
/** Bytes the host keeps waiting at once, counting ones still arriving. */
export const MAX_PENDING_ATTACHMENT_BYTES = 32 * 1024 * 1024;
/** How long an added file waits for a message. */
export const ATTACHMENT_TTL_MS = 15 * 60_000;

/** Room held for a file while its bytes arrive. Release it on failure, or commit it. */
export type AttachmentReservation = {
  commit(encode: () => string): AttachmentInfo;
  release(): void;
};

export type AttachmentInfo = { id: string; fileName: string; mimeType: string; sizeBytes: number };

export class AttachmentTooLargeError extends Error {
  readonly limit: number;
  constructor(fileName: string, size: number, limit: number) {
    super(
      `${fileName} is ${size} bytes; the gateway accepts at most ${limit} bytes for this kind of file.`,
    );
    this.name = "AttachmentTooLargeError";
    this.limit = limit;
  }
}

export function isImageType(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("image/");
}

/** The decoded size the gateway allows for a file of this type. */
export function attachmentLimit(mimeType: string): number {
  return isImageType(mimeType) ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
}

const MIME_PATTERN = /^[\w.+-]{1,64}\/[\w.+-]{1,128}$/;

/** A file name and type a renderer may supply. Rejected, not rewritten, when malformed. */
export function validateAttachmentMeta(
  fileName: unknown,
  mimeType: unknown,
): { fileName: string; mimeType: string } {
  if (
    typeof fileName !== "string" ||
    fileName.length === 0 ||
    fileName.length > 255 ||
    /[/\\]/.test(fileName) ||
    [...fileName].some((char) => char.charCodeAt(0) < 0x20)
  ) {
    throw new Error("invalid file name");
  }
  if (typeof mimeType !== "string" || !MIME_PATTERN.test(mimeType))
    throw new Error("invalid file type");
  return { fileName, mimeType };
}

type Entry = { info: AttachmentInfo; attachment: OutgoingAttachment; expiresAt: number };

/**
 * Pending files, held in the host's memory until a message uses them or they
 * expire. Bounded in count and total bytes.
 */
export class AttachmentStore {
  private readonly entries = new Map<string, Entry>();
  /** Bytes held for files still arriving, by reservation. */
  private readonly reserved = new Map<object, number>();
  private readonly options: {
    newId: () => string;
    now: () => number;
    ttlMs: number;
    maxTotalBytes: number;
  };

  constructor(options: {
    newId: () => string;
    now?: () => number;
    ttlMs?: number;
    maxTotalBytes?: number;
  }) {
    this.options = {
      newId: options.newId,
      now: options.now ?? (() => Date.now()),
      ttlMs: options.ttlMs ?? ATTACHMENT_TTL_MS,
      maxTotalBytes: options.maxTotalBytes ?? MAX_PENDING_ATTACHMENT_BYTES,
    };
  }

  /** Room left for new files, after dropping expired ones and counting files still arriving. */
  available(): number {
    this.sweep();
    let used = 0;
    for (const entry of this.entries.values()) used += entry.info.sizeBytes;
    for (const bytes of this.reserved.values()) used += bytes;
    return Math.max(0, this.options.maxTotalBytes - used);
  }

  /**
   * Refuse a file before its bytes are read or kept: a malformed name or type,
   * a size over the gateway's ceiling for its type, or no room left.
   */
  check(
    meta: { fileName: unknown; mimeType: unknown },
    sizeBytes: number,
  ): { fileName: string; mimeType: string } {
    const valid = validateAttachmentMeta(meta.fileName, meta.mimeType);
    const limit = attachmentLimit(valid.mimeType);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new Error("invalid file size");
    if (sizeBytes > limit) throw new AttachmentTooLargeError(valid.fileName, sizeBytes, limit);
    if (
      sizeBytes > this.available() ||
      this.entries.size + this.reserved.size >= MAX_PENDING_ATTACHMENTS
    ) {
      throw new Error("Too many files are waiting to be sent.");
    }
    return valid;
  }

  /**
   * Hold room for a file before reading its bytes, so files arriving at the
   * same time cannot together exceed the bounds. Throws as `check` does.
   */
  reserve(
    meta: { fileName: unknown; mimeType: unknown },
    sizeBytes: number,
  ): AttachmentReservation {
    const { fileName, mimeType } = this.check(meta, sizeBytes);
    const handle = {};
    this.reserved.set(handle, sizeBytes);
    return {
      commit: (encode) => {
        if (!this.reserved.delete(handle)) throw new Error("The reservation was released.");
        return this.keep(fileName, mimeType, sizeBytes, encode());
      },
      release: () => {
        this.reserved.delete(handle);
      },
    };
  }

  /** Add a file once its bytes are in. `encode` gives its base64 and runs only after the checks pass. */
  add(
    meta: { fileName: unknown; mimeType: unknown },
    sizeBytes: number,
    encode: () => string,
  ): AttachmentInfo {
    const { fileName, mimeType } = this.check(meta, sizeBytes);
    return this.keep(fileName, mimeType, sizeBytes, encode());
  }

  private keep(
    fileName: string,
    mimeType: string,
    sizeBytes: number,
    base64: string,
  ): AttachmentInfo {
    const info: AttachmentInfo = { id: this.options.newId(), fileName, mimeType, sizeBytes };
    this.entries.set(info.id, {
      info,
      attachment: {
        type: isImageType(mimeType) ? "image" : "file",
        mimeType,
        fileName,
        content: base64,
      },
      expiresAt: this.options.now() + this.options.ttlMs,
    });
    return info;
  }

  /** The files for these ids, in order. Throws if any is unknown or expired. */
  get(ids: readonly string[]): OutgoingAttachment[] {
    this.sweep();
    if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE)
      throw new Error("Too many files for one message.");
    return ids.map((id) => {
      const entry = this.entries.get(id);
      if (!entry) throw new Error("A file is no longer available; add it again.");
      return entry.attachment;
    });
  }

  /**
   * Take files for a message: they leave the store, so the message's owner
   * counts them from now on. `restore` puts them back, unchanged, when the
   * message is refused.
   */
  take(ids: readonly string[]): { attachments: OutgoingAttachment[]; restore(): void } {
    const attachments = this.get(ids);
    const taken = ids.map((id) => [id, this.entries.get(id)!] as const);
    for (const [id] of taken) this.entries.delete(id);
    return {
      attachments,
      restore: () => {
        for (const [id, entry] of taken) this.entries.set(id, entry);
      },
    };
  }

  /**
   * Whether these files, taken together, can be held again: each valid and
   * within its type's ceiling, and the whole batch within the bytes and the
   * number of files left, counting files still arriving.
   */
  fits(attachments: readonly OutgoingAttachment[]): boolean {
    this.sweep();
    if (this.entries.size + this.reserved.size + attachments.length > MAX_PENDING_ATTACHMENTS)
      return false;
    let bytes = 0;
    for (const each of attachments) {
      const size = decodedSize(each.content);
      try {
        validateAttachmentMeta(each.fileName, each.mimeType);
      } catch {
        return false;
      }
      if (size > attachmentLimit(each.mimeType)) return false;
      bytes += size;
    }
    return bytes <= this.available();
  }

  /**
   * Hold files again that a message gave back (taken back to be edited), as
   * new entries the composer names by their new ids. The batch is checked
   * whole, bytes and count (`fits`); if it does not fit, none is kept.
   */
  restore(attachments: readonly OutgoingAttachment[]): AttachmentInfo[] {
    if (!this.fits(attachments)) throw new Error("Too many files are waiting to be sent.");
    return attachments.map((each) =>
      this.keep(each.fileName, each.mimeType, decodedSize(each.content), each.content),
    );
  }

  /** Forget files once a message has taken them. */
  release(ids: readonly string[]): void {
    for (const id of ids) this.entries.delete(id);
  }

  private sweep(): void {
    const now = this.options.now();
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id);
  }
}

/** Bytes a base64 text decodes to. */
function decodedSize(base64: string): number {
  const clean = base64.replace(/\s+/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}
