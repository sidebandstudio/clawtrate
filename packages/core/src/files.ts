// The Work pane's files (docs/design/work-pane.md, Part 1): a task's files, the
// bot's workspace one folder at a time, a file's content from exactly the
// reader the design allows, and the checkout's comparison. Everything here is
// read with `operator.read` and returned to the asking viewer; nothing is kept
// in the state. Content crosses to the viewer in chunks (`FileTransfers`) and
// is dropped as soon as the last chunk has been read.

import { fromBase64, sha256Hex, toBase64, utf8Bytes } from "./bytes.ts";
import { isChangeTool, isCommandTool } from "./file-paths.ts";
import { asRecord, type RawRecord } from "./mapping.ts";
import type { Run, Step, StepRaw } from "./runs.ts";
import type { Transcript } from "./types.ts";

// Limits the gateway applies (work-pane.md, section 8 and section 20) ----------

/** `sessions.files.get` and `agents.workspace.get` send text up to this (`WORKSPACE_PREVIEW_MAX_BYTES`). */
export const PREVIEW_MAX_BYTES = 262_144;
/** `agents.workspace.get` sends a picture up to this. */
export const WORKSPACE_PICTURE_MAX_BYTES = 5_242_880;
/** `sessions.files.assets` sends each asset up to this from an ordinary task folder. */
export const ASSET_MAX_BYTES = 1_048_576;
/** `agents.workspace.list` sends at most this many entries per page by default. */
export const WORKSPACE_PAGE = 250;

/** The browser picture types `sessions.files.get` admits. */
const TASK_PICTURE_TYPES = ["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"];
const PICTURE_EXTENSIONS = ["avif", "bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "webp"];
const AUDIO_EXTENSIONS = ["aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "weba"];
const VIDEO_EXTENSIONS = ["m4v", "mkv", "mov", "mp4", "ogv", "webm"];
const SCRIPT_EXTENSIONS = ["cjs", "css", "js", "mjs"];
/**
 * Kinds that are neither text nor media whatever their size: documents,
 * archives and programs. A larger file of another kind may still be text.
 */
const DOCUMENT_EXTENSIONS = [
  "7z",
  "bin",
  "dmg",
  "doc",
  "docx",
  "exe",
  "gz",
  "iso",
  "key",
  "numbers",
  "odp",
  "ods",
  "odt",
  "pages",
  "pdf",
  "ppt",
  "pptx",
  "rar",
  "tar",
  "tgz",
  "xls",
  "xlsx",
  "zip",
];

export type FileGuess = "picture" | "audio" | "video" | "script" | "document" | "other";

/** What a file's name says it is, before any reader has looked at its bytes. */
export function guessKind(name: string): FileGuess {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (PICTURE_EXTENSIONS.includes(ext)) return "picture";
  if (AUDIO_EXTENSIONS.includes(ext)) return "audio";
  if (VIDEO_EXTENSIONS.includes(ext)) return "video";
  if (SCRIPT_EXTENSIONS.includes(ext)) return "script";
  if (DOCUMENT_EXTENSIONS.includes(ext)) return "document";
  return "other";
}

// The task's folder, and when the workspace reader may read its files ----------

/**
 * Where a task works, as its row establishes it: the bot's configured
 * workspace, a folder of its own (`spawnedWorkspaceDir`, `spawnedCwd` or a
 * `worktree`), a repository the gateway keeps (`repositoryWorkspaceId`), or
 * unknown when its row could not be read.
 */
export type TaskFolderKind = "workspace" | "own" | "repository" | "unknown";

export type TaskFolder = {
  kind: TaskFolderKind;
  /**
   * True only when the gateway's own record establishes that the task's root
   * is the bot's configured workspace: its row carries none of the four
   * fields, and `sessions.files.list` returned a `root`. Only then is a task's
   * file read with `agents.workspace.get`.
   */
  sameAsWorkspace: boolean;
};

const present = (value: unknown) =>
  value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "");

/** The folder a task works in, from its row (`sessions.describe`) and the root its file list returned. */
export function establishFolder(row: RawRecord | null, listRoot: string | null): TaskFolder {
  if (!row) return { kind: "unknown", sameAsWorkspace: false };
  if (present(row.repositoryWorkspaceId)) return { kind: "repository", sameAsWorkspace: false };
  if (present(row.spawnedWorkspaceDir) || present(row.spawnedCwd) || present(row.worktree))
    return { kind: "own", sameAsWorkspace: false };
  return { kind: "workspace", sameAsWorkspace: listRoot !== null };
}

// What the pane can say about a file it cannot show --------------------------

/**
 * The limit a file met, from a reader's refusal or from the facts the list
 * gave. `size` is the file's size when known; `limit` the reader's limit.
 */
export type FileLimit =
  /** No reader sends files of this kind. */
  | { code: "not-text-or-media"; mimeType: string | null }
  /** Text over what the get readers send. */
  | { code: "text-too-large"; size: number | null; limit: number }
  /** A stylesheet or script over what `sessions.files.assets` sends. */
  | { code: "script-too-large"; size: number | null; limit: number }
  /** A recording or video over what `sessions.files.assets` sends. */
  | { code: "media-too-large"; size: number | null; limit: number; media: "audio" | "video" }
  /** A recording or video in a task that works in a repository the gateway keeps. */
  | { code: "media-in-repository"; media: "audio" | "video" }
  /** A recording or video in the bot's workspace, not established as this task's folder. */
  | { code: "media-outside-task"; media: "audio" | "video" }
  /**
   * A picture of a type no reader its place allows sends: the reader looked at
   * it and refused it for its type, not its size.
   */
  | { code: "picture-type-not-sent"; mimeType: string | null; where: "task" | "repository" }
  /** A picture over the limit of the reader its place allows. */
  | {
      code: "picture-too-large";
      size: number | null;
      limit: number;
      where: "task" | "workspace" | "repository";
    }
  /** A reader refused for a reason the pane has no sentence of its own for: the gateway's words. */
  | { code: "refused"; message: string };

// Reader plans ----------------------------------------------------------------

export type FileReaderName =
  "sessions.files.get" | "agents.workspace.get" | "sessions.files.assets";

/** One step of reading a file: ask a reader, or stop with the limit the facts already show. */
export type ReadStep = { reader: FileReaderName } | { stop: FileLimit };

/** A task's file as the plan needs it: its name, size and path in the task's root. */
export type PlanFile = { name: string; size: number | null; workspacePath: string | null };

const media = (guess: FileGuess): "audio" | "video" | null =>
  guess === "audio" || guess === "video" ? guess : null;
const relative = (path: string | null): path is string =>
  path !== null && path !== "" && !path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path);
const over = (size: number | null, limit: number) => size !== null && size > limit;

/**
 * The first reader for a task's file, or the limit that rules every reader
 * out (section 8). Never a reader the facts show will refuse; never
 * `agents.workspace.get` unless the folder is established as the bot's
 * workspace; never audio or video from a repository-backed task.
 */
export function planTaskRead(file: PlanFile, folder: TaskFolder): ReadStep {
  const guess = guessKind(file.name);
  const av = media(guess);
  if (av) {
    if (folder.kind === "repository") return { stop: { code: "media-in-repository", media: av } };
    if (over(file.size, ASSET_MAX_BYTES))
      return {
        stop: { code: "media-too-large", size: file.size, limit: ASSET_MAX_BYTES, media: av },
      };
    return { reader: "sessions.files.assets" };
  }
  if (!over(file.size, PREVIEW_MAX_BYTES)) {
    // Within the preview limit: the task's own reader says what the file is.
    return { reader: "sessions.files.get" };
  }
  if (guess === "picture") return largePictureStep(file, folder);
  if (guess === "script") {
    if (folder.kind === "repository")
      return { stop: { code: "text-too-large", size: file.size, limit: PREVIEW_MAX_BYTES } };
    if (over(file.size, ASSET_MAX_BYTES))
      return { stop: { code: "script-too-large", size: file.size, limit: ASSET_MAX_BYTES } };
    return { reader: "sessions.files.assets" };
  }
  if (guess === "document") return { stop: { code: "not-text-or-media", mimeType: null } };
  // Larger than the preview limit and of a kind the name does not settle: the
  // task reader's answer says whether it is text over its limit or not text.
  return { reader: "sessions.files.get" };
}

/** A picture past the task reader's limit, or one it would not send (its type), from its place. */
export function largePictureStep(file: PlanFile, folder: TaskFolder): ReadStep {
  if (folder.kind === "repository")
    return {
      stop: {
        code: "picture-too-large",
        size: file.size,
        limit: PREVIEW_MAX_BYTES,
        where: "repository",
      },
    };
  if (folder.sameAsWorkspace && relative(file.workspacePath)) {
    if (over(file.size, WORKSPACE_PICTURE_MAX_BYTES))
      return {
        stop: {
          code: "picture-too-large",
          size: file.size,
          limit: WORKSPACE_PICTURE_MAX_BYTES,
          where: "workspace",
        },
      };
    return { reader: "agents.workspace.get" };
  }
  if (over(file.size, ASSET_MAX_BYTES))
    return {
      stop: { code: "picture-too-large", size: file.size, limit: ASSET_MAX_BYTES, where: "task" },
    };
  return { reader: "sessions.files.assets" };
}

/**
 * What `sessions.files.get` sent instead of content, and where that leads:
 * `unsupported` for a picture of another type goes to the picture readers,
 * for audio or video to the asset reader (not from a repository), and for
 * anything else ends as "not text or media". `file.size` is the size the
 * reader's answer gave. A repository has no other picture reader: a picture
 * there within the preview limit was refused for its type, not its size.
 */
export function afterUnsupported(
  file: PlanFile,
  folder: TaskFolder,
  mimeType: string | null,
): ReadStep {
  const type = mimeType?.toLowerCase() ?? "";
  if (type.startsWith("image/")) {
    if (folder.kind === "repository" && !over(file.size, PREVIEW_MAX_BYTES))
      return { stop: { code: "picture-type-not-sent", mimeType, where: "repository" } };
    return largePictureStep(file, folder);
  }
  const av = type.startsWith("audio/")
    ? "audio"
    : type.startsWith("video/")
      ? "video"
      : media(guessKind(file.name));
  if (av && (type.startsWith("audio/") || type.startsWith("video/"))) {
    if (folder.kind === "repository") return { stop: { code: "media-in-repository", media: av } };
    if (over(file.size, ASSET_MAX_BYTES))
      return {
        stop: { code: "media-too-large", size: file.size, limit: ASSET_MAX_BYTES, media: av },
      };
    return { reader: "sessions.files.assets" };
  }
  return { stop: { code: "not-text-or-media", mimeType } };
}

/**
 * Where `sessions.files.get`'s refusal as too large leads, from the refusal's
 * own facts: its `size` and `limit`. A picture goes on to the picture
 * readers; a stylesheet or script (which the asset reader admits by its
 * extension) to the asset reader of an ordinary folder, up to its limit; a
 * document cannot be shown at any size; anything else is text over the
 * reader's limit.
 */
export function afterTooLarge(file: PlanFile, folder: TaskFolder, limit: number): ReadStep {
  const guess = guessKind(file.name);
  const av = media(guess);
  if (guess === "picture") return largePictureStep(file, folder);
  if (av) return planTaskRead(file, folder);
  if (guess === "document") return { stop: { code: "not-text-or-media", mimeType: null } };
  if (guess === "script" && folder.kind !== "repository") {
    if (over(file.size, ASSET_MAX_BYTES))
      return { stop: { code: "script-too-large", size: file.size, limit: ASSET_MAX_BYTES } };
    return { reader: "sessions.files.assets" };
  }
  return { stop: { code: "text-too-large", size: file.size, limit } };
}

/**
 * The reader for a file in the bot's workspace (the workspace browser). A
 * recording, a video or a large script is read with the open task's asset
 * reader only when that task's folder is established as this workspace;
 * otherwise the pane says why it cannot.
 */
export function planWorkspaceRead(
  file: { name: string; size: number | null },
  task: TaskFolder | null,
): ReadStep {
  const guess = guessKind(file.name);
  const av = media(guess);
  const viaTask = task?.sameAsWorkspace === true;
  if (av) {
    if (!viaTask) return { stop: { code: "media-outside-task", media: av } };
    if (over(file.size, ASSET_MAX_BYTES))
      return {
        stop: { code: "media-too-large", size: file.size, limit: ASSET_MAX_BYTES, media: av },
      };
    return { reader: "sessions.files.assets" };
  }
  if (guess === "picture") {
    if (over(file.size, WORKSPACE_PICTURE_MAX_BYTES))
      return {
        stop: {
          code: "picture-too-large",
          size: file.size,
          limit: WORKSPACE_PICTURE_MAX_BYTES,
          where: "workspace",
        },
      };
    return { reader: "agents.workspace.get" };
  }
  if (over(file.size, PREVIEW_MAX_BYTES)) {
    if (guess === "script" && viaTask && !over(file.size, ASSET_MAX_BYTES))
      return { reader: "sessions.files.assets" };
    if (guess === "script" && viaTask)
      return { stop: { code: "script-too-large", size: file.size, limit: ASSET_MAX_BYTES } };
    if (guess === "document") return { stop: { code: "not-text-or-media", mimeType: null } };
    return { stop: { code: "text-too-large", size: file.size, limit: PREVIEW_MAX_BYTES } };
  }
  if (guess === "document") return { stop: { code: "not-text-or-media", mimeType: null } };
  return { reader: "agents.workspace.get" };
}

// What the bridge answers -----------------------------------------------------

/** One file the task touched (`sessions.files.list`). */
export type TaskFile = {
  /** The path as the task's tools named it: what `sessions.files.get` and the steps use. */
  path: string;
  /** Its path in the task's root, or absolute when it is outside it. */
  workspacePath: string | null;
  name: string;
  kind: "modified" | "read";
  missing: boolean;
  size: number | null;
  updatedAt: number | null;
};

export type TaskFileList = {
  key: string;
  root: string | null;
  folder: TaskFolder;
  /** Whether the task's folder is in a git checkout, as the gateway says; null when it does not. */
  gitCheckout: boolean | null;
  files: TaskFile[];
  /** Files the gateway listed that did not fit this answer. */
  omitted: number;
  /** When the gateway answered. */
  checkedAt: number;
};

export type WorkspaceEntry = {
  path: string;
  name: string;
  kind: "file" | "directory";
  size: number | null;
  updatedAt: number | null;
};

export type WorkspacePage = {
  botId: string;
  path: string;
  entries: WorkspaceEntry[];
  totalEntries: number;
  offset: number;
  /** Where the next page starts: `offset` plus the entries this answer carries. */
  nextOffset: number;
  checkedAt: number;
  /** The gateway says the folder does not exist (`workspace_path_not_found`). */
  missing: boolean;
};

/** The facts block: what is known of a file whether or not it can be shown. */
export type FileFacts = {
  name: string;
  path: string;
  size: number | null;
  updatedAt: number | null;
  mimeType: string | null;
};

export type FileKind = "text" | "image" | "audio" | "video";

/**
 * The content's way to the viewer: the first chunk inline (base64), and when
 * there is more, the transfer to read the rest from with `readFileChunk`
 * before it expires.
 */
export type FileTransferStart = { id: string | null; chunks: number; data: string };

export type FileRead =
  | {
      status: "content";
      facts: FileFacts;
      reader: FileReaderName;
      kind: FileKind;
      mimeType: string;
      /** The exact number of bytes the reader sent. */
      bytes: number;
      /** SHA-256 of those bytes: the gateway's own for text it hashed, computed here otherwise. */
      hash: string;
      transfer: FileTransferStart;
    }
  | { status: "cannot-show"; facts: FileFacts; limit: FileLimit }
  | { status: "missing"; facts: FileFacts | null }
  | { status: "failed"; message: string };

/** The checkout's comparison for one file (`sessions.diff`). */
export type CheckoutDiff =
  | {
      status: "ok";
      /** The base named by the gateway: the default branch, or "HEAD" on it. */
      baseRef: string | null;
      branch: string | null;
      mergeBase: { sha: string; subject: string } | null;
      file: {
        path: string;
        status: "added" | "modified" | "deleted" | "renamed";
        additions: number;
        deletions: number;
        untracked: boolean;
        binary: boolean;
        /** The patch, or null when the gateway sent none. */
        patch: string | null;
        /** The gateway marked it too large to send. */
        truncated: boolean;
        /** Clawtrate did not carry the whole patch: longer than this viewer's channel takes. */
        cutByClient: boolean;
      } | null;
    }
  | { status: "unavailable"; reason: "not_git" | "unknown_session" | "workspace_stopped" | string };

// Mapping gateway answers -----------------------------------------------------

const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;
const int = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

/** At most this many characters of a path or name are kept. */
export const MAX_FILE_PATH_CHARS = 1024;
const cap = (value: string | null) =>
  value === null ? null : value.length > MAX_FILE_PATH_CHARS ? null : value;

export function mapTaskFile(raw: unknown): TaskFile | null {
  const entry = asRecord(raw);
  const path = cap(str(entry?.path));
  if (!entry || !path) return null;
  return {
    path,
    workspacePath: cap(str(entry.workspacePath)),
    name: cap(str(entry.name)) ?? path.split("/").pop() ?? path,
    kind: entry.kind === "modified" ? "modified" : "read",
    missing: entry.missing === true,
    size: int(entry.size),
    updatedAt: int(entry.updatedAtMs),
  };
}

export function mapWorkspaceEntry(raw: unknown): WorkspaceEntry | null {
  const entry = asRecord(raw);
  const path = cap(str(entry?.path));
  const name = cap(str(entry?.name));
  if (!entry || !path || !name) return null;
  return {
    path,
    name,
    kind: entry.kind === "directory" ? "directory" : "file",
    size: entry.kind === "directory" ? null : int(entry.size),
    updatedAt: int(entry.updatedAtMs),
  };
}

/** The gateway's error details: `{type, size, maxBytes|maxPreviewBytes}` on its file refusals. */
export function refusalOf(error: unknown): {
  type: string | null;
  size: number | null;
  limit: number | null;
  message: string;
} {
  const record = asRecord(error);
  const details =
    asRecord(record?.details) ??
    asRecord(asRecord(record?.error)?.details) ??
    asRecord(record?.data);
  const message =
    error instanceof Error
      ? error.message
      : (str(record?.message) ?? "The gateway did not send this file.");
  return {
    type: str(details?.type),
    size: int(details?.size),
    limit: int(details?.maxPreviewBytes) ?? int(details?.maxBytes),
    message,
  };
}

// The chunked way to the viewer -----------------------------------------------

/** Transfers held at once, across every viewer. */
export const MAX_FILE_TRANSFERS = 4;
/**
 * A transfer not read for this long is dropped by the next transfer that
 * starts or the next chunk read, whichever comes first. Expiry is checked
 * then, not on a timer, so an idle transfer stays until one of those; the
 * count and size bounds hold either way.
 */
export const FILE_TRANSFER_TTL_MS = 60_000;
/**
 * The largest chunk, in bytes (a host with no channel limit, such as the
 * desktop app's). A multiple of 3, as every chunk size is, so that each
 * chunk's base64 ends on a four-character boundary and decodes by itself.
 */
export const MAX_CHUNK_BYTES = 1_048_575;
/** Room in an answer for everything but a chunk's data. */
export const FILE_ANSWER_ROOM_CHARS = 8_192;
/** The largest content any reader sends: the workspace reader's picture limit. */
export const MAX_TRANSFER_BYTES = WORKSPACE_PICTURE_MAX_BYTES;

/** Bytes per chunk so one chunk's base64 fits an answer of `maxChars`: always a multiple of 3. */
export function chunkBytesFor(maxChars: number | undefined): number {
  const room = maxChars === undefined ? Infinity : Math.max(4, maxChars - FILE_ANSWER_ROOM_CHARS);
  const bytes = Math.min(MAX_CHUNK_BYTES, Math.floor(room / 4) * 3);
  return Math.max(3, bytes - (bytes % 3));
}

type Transfer = {
  owner: object;
  /** The content's base64, sliced at chunk boundaries. */
  data: string;
  chunkChars: number;
  chunks: number;
  expires: number;
};

/**
 * Content on its way to a viewer: at most `MAX_FILE_TRANSFERS` at once, each
 * at most `MAX_TRANSFER_BYTES`, each dropped when its last chunk is read,
 * when its viewer releases it or goes away, or, once it has gone
 * `FILE_TRANSFER_TTL_MS` without a read, by the next transfer that starts or
 * chunk read (not on a timer). Nothing else of a file's content is kept.
 */
export class FileTransfers {
  private readonly held = new Map<string, Transfer>();
  private next = 0;
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  private sweep(): void {
    const at = this.now();
    for (const [id, transfer] of this.held) if (transfer.expires <= at) this.held.delete(id);
  }

  /** Start a transfer of `bytes` for `owner`; the first chunk goes in the answer. */
  start(owner: object, bytes: Uint8Array, maxChars: number | undefined): FileTransferStart {
    const chunkBytes = chunkBytesFor(maxChars);
    if (bytes.length <= chunkBytes) return { id: null, chunks: 1, data: toBase64(bytes) };
    this.sweep();
    if (this.held.size >= MAX_FILE_TRANSFERS)
      throw new Error("Other files are on their way to a viewer; try again in a moment.");
    if (bytes.length > MAX_TRANSFER_BYTES)
      throw new Error("This file is larger than any of the gateway's readers sends.");
    const data = toBase64(bytes);
    const chunkChars = (chunkBytes / 3) * 4;
    const chunks = Math.ceil(data.length / chunkChars);
    this.next += 1;
    const id = `file-${this.next}`;
    this.held.set(id, {
      owner,
      data,
      chunkChars,
      chunks,
      expires: this.now() + FILE_TRANSFER_TTL_MS,
    });
    return { id, chunks, data: data.slice(0, chunkChars) };
  }

  /** Chunk `index` (1 and on; 0 came with the answer). The last one ends the transfer. */
  chunk(owner: object, id: string, index: number): { data: string } {
    this.sweep();
    const transfer = this.held.get(id);
    if (!transfer || transfer.owner !== owner)
      throw new Error("This file's transfer has ended; open the file again.");
    if (!Number.isInteger(index) || index < 1 || index >= transfer.chunks)
      throw new Error("No such part of this file.");
    const data = transfer.data.slice(
      index * transfer.chunkChars,
      (index + 1) * transfer.chunkChars,
    );
    if (index === transfer.chunks - 1) this.held.delete(id);
    else transfer.expires = this.now() + FILE_TRANSFER_TTL_MS;
    return { data };
  }

  release(owner: object, id?: string): void {
    for (const [key, transfer] of this.held) {
      if (transfer.owner === owner && (id === undefined || id === key)) this.held.delete(key);
    }
  }

  get size(): number {
    return this.held.size;
  }
}

// Saving a file the viewer holds (the desktop app's save dialog) --------------

/** The most a viewer may hand the host to save: the largest content any reader sends. */
export const MAX_SAVE_BYTES = MAX_TRANSFER_BYTES;
/** Saves waiting for their dialog at once, across every window; the desktop app has one window. */
export const MAX_PENDING_SAVES = 1;

/**
 * Bytes a viewer handed the host to save, held only while their save dialog
 * is open: at most `MAX_PENDING_SAVES`, one per window, each at most
 * `MAX_SAVE_BYTES`. The host releases one when its dialog is cancelled, when
 * its write ends either way, and when its window or page goes.
 */
export class PendingSaves {
  /** By ticket: the window that handed the bytes over, and the bytes. */
  private readonly held = new Map<number, { owner: number; data: ArrayBuffer }>();
  private next = 0;

  /** Throws, holding nothing, for more than a reader sends or while a save is already waiting. */
  check(owner: number, bytes: number): void {
    if (bytes > MAX_SAVE_BYTES)
      throw new Error("This is more than any of the gateway's readers sends, so it was not saved.");
    const waiting = [...this.held.values()].some((each) => each.owner === owner);
    if (waiting || this.held.size >= MAX_PENDING_SAVES)
      throw new Error("Another file is waiting to be saved. Finish that save first.");
  }

  /**
   * Hold `data` for a dialog of `owner`'s, and answer the ticket that names
   * this save alone. Its bytes move here (`transfer`): what handed them over
   * is left empty, so they are held in one place only.
   */
  hold(owner: number, data: ArrayBuffer): number {
    this.check(owner, data.byteLength);
    this.next += 1;
    this.held.set(this.next, { owner, data: data.transfer() });
    return this.next;
  }

  /** The bytes of this save, or null once released. */
  get(ticket: number): ArrayBuffer | null {
    return this.held.get(ticket)?.data ?? null;
  }

  release(ticket: number): void {
    this.held.delete(ticket);
  }

  get size(): number {
    return this.held.size;
  }
}

// Reading through the gateway -------------------------------------------------

export type FileRequest = (method: string, params: unknown) => Promise<unknown>;

export type FileReaderContext = {
  request: FileRequest;
  transfers: FileTransfers;
  owner: object;
  /** The most JSON characters an answer may have on the viewer's channel. */
  maxChars?: number | undefined;
  now: () => number;
};

const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const basename = (path: string) => path.split("/").pop() ?? path;

/** Keep what fits an answer of `maxChars`, newest first as given; the rest are counted. */
function fitting<T>(
  items: T[],
  maxChars: number | undefined,
  room = 4_096,
): { kept: T[]; omitted: number } {
  if (maxChars === undefined) return { kept: items, omitted: 0 };
  let used = room;
  const kept: T[] = [];
  for (const item of items) {
    const size = JSON.stringify(item).length + 1;
    if (used + size > maxChars) break;
    used += size;
    kept.push(item);
  }
  return { kept, omitted: items.length - kept.length };
}

/** A task's file list and its folder, read fresh: `sessions.files.list` and `sessions.describe`. */
export async function listTaskFiles(ctx: FileReaderContext, key: string): Promise<TaskFileList> {
  const [listed, described] = await Promise.all([
    ctx.request("sessions.files.list", { sessionKey: key }),
    ctx.request("sessions.describe", { key }).catch(() => null),
  ]);
  const list = asRecord(listed);
  const root = str(list?.root);
  const row = asRecord(asRecord(described)?.session);
  const files = (Array.isArray(list?.files) ? list.files : [])
    .map(mapTaskFile)
    .filter((file): file is TaskFile => file !== null);
  const { kept, omitted } = fitting(files, ctx.maxChars);
  return {
    key,
    root,
    folder: establishFolder(row, root),
    gitCheckout: typeof list?.gitCheckout === "boolean" ? list.gitCheckout : null,
    files: kept,
    omitted,
    checkedAt: ctx.now(),
  };
}

/** One page of a folder of the bot's workspace (`agents.workspace.list`). */
export async function listWorkspace(
  ctx: FileReaderContext,
  botId: string,
  path: string,
  offset: number,
): Promise<WorkspacePage> {
  let raw: unknown;
  try {
    raw = await ctx.request("agents.workspace.list", {
      agentId: botId,
      ...(path ? { path } : {}),
      offset,
      limit: WORKSPACE_PAGE,
    });
  } catch (error) {
    if (refusalOf(error).type !== "workspace_path_not_found") throw error;
    return {
      botId,
      path,
      entries: [],
      totalEntries: 0,
      offset,
      nextOffset: offset,
      checkedAt: ctx.now(),
      missing: true,
    };
  }
  const answer = asRecord(raw);

  const entries = (Array.isArray(answer?.entries) ? answer.entries : [])
    .map(mapWorkspaceEntry)
    .filter((entry): entry is WorkspaceEntry => entry !== null);
  const { kept } = fitting(entries, ctx.maxChars);
  const start = int(answer?.offset) ?? offset;
  return {
    botId,
    path: str(answer?.path) ?? path,
    entries: kept,
    totalEntries: int(answer?.totalEntries) ?? kept.length,
    offset: start,
    nextOffset: start + kept.length,
    checkedAt: ctx.now(),
    missing: false,
  };
}

function contentOf(
  ctx: FileReaderContext,
  facts: FileFacts,
  reader: FileReaderName,
  kind: FileKind,
  mimeType: string,
  bytes: Uint8Array,
  hash: string | null,
): FileRead {
  return {
    status: "content",
    facts: { ...facts, size: facts.size ?? bytes.length },
    reader,
    kind,
    mimeType,
    bytes: bytes.length,
    hash: hash ?? sha256Hex(bytes),
    transfer: ctx.transfers.start(ctx.owner, bytes, ctx.maxChars),
  };
}

const kindOfMime = (mime: string): FileKind | null =>
  mime.startsWith("image/")
    ? "image"
    : mime.startsWith("audio/")
      ? "audio"
      : mime.startsWith("video/")
        ? "video"
        : mime === "text/css" || mime === "text/javascript"
          ? "text"
          : null;

/**
 * The task's row changed while one of its files was read, so the reader
 * chosen for the folder it had no longer addresses the task's folder. What
 * that reader sent is dropped.
 */
class FolderChanged extends Error {
  constructor() {
    super("This task's folder changed while the file was read. Try again.");
  }
}

/** Checked after a reader answers and before anything of its answer is used. */
type Confirm = () => Promise<void>;

/**
 * Whether the task's row, read now, still establishes that the task works in
 * the bot's configured workspace (section 8). The workspace reader reads a
 * task's file, and the task's asset reader a workspace file, only while it
 * does.
 */
async function sharesWorkspace(
  ctx: FileReaderContext,
  key: string,
  root: string | null,
): Promise<boolean> {
  const described = await ctx.request("sessions.describe", { key }).catch(() => null);
  return establishFolder(asRecord(asRecord(described)?.session), root).sameAsWorkspace;
}

/**
 * The decision that a reader of the other folder may address this file, made
 * from the task's row at the moment of the read: checked before the request,
 * and again once the reader has answered, before anything it sent is used.
 */
async function boundToSharedFolder(
  ctx: FileReaderContext,
  key: string,
  root: string | null,
): Promise<Confirm> {
  const confirm = async () => {
    if (!(await sharesWorkspace(ctx, key, root))) throw new FolderChanged();
  };
  await confirm();
  return confirm;
}

/** One asset of a task file, named relative to its own folder (`sessions.files.assets`). */
async function readAsset(
  ctx: FileReaderContext,
  key: string,
  facts: FileFacts,
  rootPath: string,
  confirm?: Confirm,
): Promise<FileRead> {
  let raw: unknown;
  try {
    raw = await ctx.request("sessions.files.assets", {
      sessionKey: key,
      path: rootPath,
      refs: [encodeURIComponent(basename(rootPath))],
    });
  } catch (error) {
    await confirm?.();
    throw error;
  }
  await confirm?.();
  const answer = asRecord(raw);
  const asset = asRecord(Array.isArray(answer?.assets) ? answer.assets[0] : null);
  const error = str(asset?.error);
  if (error === "not_found") return { status: "missing", facts };
  if (error === "too_large") {
    const guess = guessKind(facts.name);
    const av = media(guess);
    return {
      status: "cannot-show",
      facts,
      limit: av
        ? { code: "media-too-large", size: facts.size, limit: ASSET_MAX_BYTES, media: av }
        : guess === "picture"
          ? { code: "picture-too-large", size: facts.size, limit: ASSET_MAX_BYTES, where: "task" }
          : { code: "script-too-large", size: facts.size, limit: ASSET_MAX_BYTES },
    };
  }
  if (error === "unsupported")
    return {
      status: "cannot-show",
      facts,
      limit: facts.mimeType?.toLowerCase().startsWith("image/")
        ? { code: "picture-type-not-sent", mimeType: facts.mimeType, where: "task" }
        : { code: "not-text-or-media", mimeType: facts.mimeType },
    };
  if (error) return { status: "cannot-show", facts, limit: { code: "refused", message: error } };
  const mimeType = str(asset?.mimeType);
  const bytes = typeof asset?.content === "string" ? fromBase64(asset.content) : null;
  const kind = mimeType ? kindOfMime(mimeType) : null;
  if (!mimeType || !bytes || !kind)
    return { status: "failed", message: "The gateway's answer could not be read." };
  return contentOf(
    ctx,
    { ...facts, mimeType },
    "sessions.files.assets",
    kind,
    mimeType,
    bytes,
    null,
  );
}

/** A file from the bot's workspace reader (`agents.workspace.get`). */
async function readFromWorkspace(
  ctx: FileReaderContext,
  botId: string,
  path: string,
  facts: FileFacts,
  confirm?: Confirm,
): Promise<FileRead> {
  let answer: RawRecord | null;
  try {
    answer = asRecord(await ctx.request("agents.workspace.get", { agentId: botId, path }));
  } catch (error) {
    await confirm?.();
    const refusal = refusalOf(error);
    if (refusal.type === "workspace_file_not_found") return { status: "missing", facts };
    if (refusal.type === "workspace_file_unsupported")
      return {
        status: "cannot-show",
        facts,
        limit: { code: "not-text-or-media", mimeType: facts.mimeType },
      };
    if (refusal.type === "workspace_file_too_large") {
      const size = refusal.size ?? facts.size;
      // The limit the reader applied says which it met: its picture limit, or its text limit.
      const picture =
        refusal.limit !== null
          ? refusal.limit > PREVIEW_MAX_BYTES
          : guessKind(facts.name) === "picture";
      const limit = refusal.limit ?? (picture ? WORKSPACE_PICTURE_MAX_BYTES : PREVIEW_MAX_BYTES);
      return {
        status: "cannot-show",
        facts: { ...facts, size },
        limit: picture
          ? { code: "picture-too-large", size, limit, where: "workspace" }
          : { code: "text-too-large", size, limit },
      };
    }
    throw error;
  }
  await confirm?.();
  const file = asRecord(answer?.file);
  const content = typeof file?.content === "string" ? file.content : null;
  const mimeType = str(file?.mimeType) ?? "text/plain";
  const next: FileFacts = {
    ...facts,
    size: int(file?.size) ?? facts.size,
    updatedAt: int(file?.updatedAtMs) ?? facts.updatedAt,
    mimeType,
  };
  if (content === null)
    return { status: "failed", message: "The gateway's answer could not be read." };
  if (file?.encoding === "base64") {
    const bytes = fromBase64(content);
    if (!bytes) return { status: "failed", message: "The gateway's answer could not be read." };
    return contentOf(ctx, next, "agents.workspace.get", "image", mimeType, bytes, null);
  }
  // Text is decoded strictly as UTF-8 by the gateway, so encoding it again gives the file's bytes.
  return contentOf(ctx, next, "agents.workspace.get", "text", mimeType, utf8Bytes(content), null);
}

/**
 * A task's file, from the reader section 8 allows: the task reader first when
 * the facts allow it, then the picture or asset reader its answer leads to.
 * The workspace reader is used only while the task's row, read just before
 * and just after it, establishes the bot's workspace as the task's folder;
 * when the row changed, what it sent is dropped and the file is read once
 * more from fresh facts.
 */
export async function readTaskFile(
  ctx: FileReaderContext,
  key: string,
  botId: string,
  path: string,
): Promise<FileRead> {
  try {
    return await readTaskFileOnce(ctx, key, botId, path);
  } catch (error) {
    if (!(error instanceof FolderChanged)) throw error;
  }
  try {
    return await readTaskFileOnce(ctx, key, botId, path);
  } catch (error) {
    if (!(error instanceof FolderChanged)) throw error;
    return { status: "failed", message: error.message };
  }
}

async function readTaskFileOnce(
  ctx: FileReaderContext,
  key: string,
  botId: string,
  path: string,
): Promise<FileRead> {
  const list = await listTaskFiles({ ...ctx, maxChars: undefined }, key);
  const listed = list.files.find((file) => file.path === path) ?? null;
  const facts: FileFacts = {
    name: listed?.name ?? basename(path),
    path,
    size: listed?.size ?? null,
    updatedAt: listed?.updatedAt ?? null,
    mimeType: null,
  };
  if (listed?.missing) return { status: "missing", facts };
  const plan: PlanFile = {
    name: facts.name,
    size: facts.size,
    workspacePath: listed?.workspacePath ?? null,
  };
  const rootPath = relative(plan.workspacePath) ? plan.workspacePath : path;
  const follow = (step: ReadStep): Promise<FileRead> | FileRead => {
    if ("stop" in step) return { status: "cannot-show", facts, limit: step.stop };
    if (step.reader === "sessions.files.assets") return readAsset(ctx, key, facts, rootPath);
    if (step.reader === "agents.workspace.get") return fromWorkspace(facts);
    return readWithTaskReader();
  };
  const fromWorkspace = async (facts: FileFacts): Promise<FileRead> =>
    readFromWorkspace(
      ctx,
      botId,
      plan.workspacePath!,
      facts,
      await boundToSharedFolder(ctx, key, list.root),
    );
  const readWithTaskReader = async (): Promise<FileRead> => {
    let answer: RawRecord | null;
    try {
      answer = asRecord(await ctx.request("sessions.files.get", { sessionKey: key, path }));
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal.type === "session_file_not_found") return { status: "missing", facts };
      if (refusal.type === "session_file_too_large") {
        // What follows comes from this refusal's own size and limit, not from the list's.
        const size = refusal.size ?? facts.size;
        const sized = { ...facts, size };
        const step = afterTooLarge(
          { ...plan, size },
          list.folder,
          refusal.limit ?? PREVIEW_MAX_BYTES,
        );
        if ("stop" in step) return { status: "cannot-show", facts: sized, limit: step.stop };
        if (step.reader === "sessions.files.assets") return readAsset(ctx, key, sized, rootPath);
        if (step.reader === "agents.workspace.get") return fromWorkspace(sized);
        return { status: "failed", message: refusal.message };
      }
      throw error;
    }
    const file = asRecord(answer?.file);
    const mimeType = str(file?.mimeType);
    const next: FileFacts = {
      ...facts,
      size: int(file?.size) ?? facts.size,
      updatedAt: int(file?.updatedAtMs) ?? facts.updatedAt,
      mimeType,
    };
    if (!file || file.missing === true) return { status: "missing", facts: next };
    const content = typeof file.content === "string" ? file.content : null;
    if (file.previewKind === "text" && content !== null) {
      const hash =
        typeof file.hash === "string" && /^[a-f0-9]{64}$/.test(file.hash) ? file.hash : null;
      return contentOf(
        ctx,
        next,
        "sessions.files.get",
        "text",
        mimeType ?? "text/plain",
        utf8Bytes(content),
        hash,
      );
    }
    if (file.previewKind === "image" && content !== null) {
      const bytes = fromBase64(content);
      if (!bytes || !mimeType || !TASK_PICTURE_TYPES.includes(mimeType))
        return { status: "failed", message: "The gateway's answer could not be read." };
      return contentOf(ctx, next, "sessions.files.get", "image", mimeType, bytes, null);
    }
    const after = afterUnsupported({ ...plan, size: next.size }, list.folder, mimeType);
    if ("stop" in after) return { status: "cannot-show", facts: next, limit: after.stop };
    const nextFacts = next;
    if (after.reader === "sessions.files.assets") return readAsset(ctx, key, nextFacts, rootPath);
    if (after.reader === "agents.workspace.get") return fromWorkspace(nextFacts);
    return { status: "cannot-show", facts: next, limit: { code: "not-text-or-media", mimeType } };
  };
  try {
    return await follow(planTaskRead(plan, list.folder));
  } catch (error) {
    if (error instanceof FolderChanged) throw error;
    return { status: "failed", message: refusalOf(error).message };
  }
}

/**
 * A file of the bot's workspace. With `key`, the open task whose asset reader
 * may send its recordings, videos and large scripts, while that task's row,
 * read just before and just after the asset reader, establishes its folder as
 * this workspace; when the row changed, what it sent is dropped and the file
 * is planned once more from fresh facts.
 */
export async function readWorkspaceFile(
  ctx: FileReaderContext,
  botId: string,
  path: string,
  size: number | null,
  key: string | null,
): Promise<FileRead> {
  const facts: FileFacts = { name: basename(path), path, size, updatedAt: null, mimeType: null };
  const once = async (): Promise<FileRead> => {
    const list = key ? await listTaskFiles({ ...ctx, maxChars: undefined }, key) : null;
    const step = planWorkspaceRead({ name: facts.name, size }, list?.folder ?? null);
    if ("stop" in step) return { status: "cannot-show", facts, limit: step.stop };
    if (step.reader === "sessions.files.assets" && key && list)
      return await readAsset(ctx, key, facts, path, await boundToSharedFolder(ctx, key, list.root));
    return await readFromWorkspace(ctx, botId, path, facts);
  };
  try {
    try {
      return await once();
    } catch (error) {
      if (!(error instanceof FolderChanged)) throw error;
    }
    return await once();
  } catch (error) {
    return { status: "failed", message: refusalOf(error).message };
  }
}

/** The checkout's patch for one of the task's files (`sessions.diff`), matched by absolute path. */
export async function readCheckoutDiff(
  ctx: FileReaderContext,
  key: string,
  path: string,
): Promise<CheckoutDiff> {
  const [diffAnswer, list] = await Promise.all([
    ctx.request("sessions.diff", { sessionKey: key }),
    listTaskFiles({ ...ctx, maxChars: undefined }, key),
  ]);
  const diff = asRecord(diffAnswer);
  const reason = str(diff?.unavailableReason);
  if (reason) return { status: "unavailable", reason };
  const commit = asRecord(diff?.mergeBase);
  const base = {
    status: "ok" as const,
    baseRef: str(diff?.baseRef),
    branch: str(diff?.branch),
    mergeBase:
      commit && str(commit.sha)
        ? {
            sha: str(commit.sha)!,
            subject: typeof commit.subject === "string" ? commit.subject : "",
          }
        : null,
  };
  const listed = list.files.find((file) => file.path === path);
  const diffRoot = str(diff?.root);
  const absolute =
    listed?.workspacePath && list.root
      ? listed.workspacePath.startsWith("/")
        ? listed.workspacePath
        : `${list.root.replace(/\/+$/, "")}/${listed.workspacePath}`
      : null;
  const files = Array.isArray(diff?.files) ? diff.files : [];
  const found =
    absolute && diffRoot
      ? files
          .map((each) => asRecord(each))
          .find((each) => {
            const relativePath = str(each?.path);
            return (
              relativePath !== null &&
              `${diffRoot.replace(/\/+$/, "")}/${relativePath}` === absolute
            );
          })
      : undefined;
  if (!found) return { ...base, file: null };
  const status = str(found.status);
  const patch = typeof found.patch === "string" ? found.patch : null;
  const budget =
    ctx.maxChars === undefined ? Number.POSITIVE_INFINITY : ctx.maxChars - FILE_ANSWER_ROOM_CHARS;
  const cutByClient = patch !== null && JSON.stringify(patch).length > budget;
  return {
    ...base,
    file: {
      path: str(found.path)!,
      status:
        status === "added" || status === "deleted" || status === "renamed" ? status : "modified",
      additions: int(found.additions) ?? 0,
      deletions: int(found.deletions) ?? 0,
      untracked: found.untracked === true,
      binary: found.binary === true,
      patch: cutByClient ? null : patch,
      truncated: found.truncated === true,
      cutByClient,
    },
  };
}

// Views over the task's runs: markers, sources, changes, commands -------------

export type FileMark = "writing" | "this-run" | "last-run";

const isActive = (run: Run) =>
  run.state === "running" || run.state === "waiting" || run.state === "stopping";

/** The run whose file changes the markers name: the latest run that has started. */
function latestStarted(transcript: Pick<Transcript, "runs">): Run | null {
  const started = transcript.runs.filter((run) => run.state !== "queued");
  return started.at(-1) ?? null;
}

/**
 * The run markers (section 4, F-321), from file-tool evidence only: "writing"
 * between a change tool's start and its result; "this-run" for a path a
 * successful change result named in the active run; "last-run" for one named
 * in the run that ended, until the next run starts. A failed call, or one
 * whose result says nothing changed, marks nothing. A command marks nothing.
 */
export function fileMarks(transcript: Pick<Transcript, "runs">): Map<string, FileMark> {
  const marks = new Map<string, FileMark>();
  const run = latestStarted(transcript);
  if (!run) return marks;
  const active = isActive(run);
  for (const step of run.steps) {
    if (step.kind !== "tool" || !step.files || !isChangeTool(step.toolName)) continue;
    for (const path of step.files.paths) {
      if (step.status === "running" || step.status === "waiting") {
        if (active) marks.set(path, "writing");
      } else if (step.status === "done" && step.files.changed !== false) {
        if (marks.get(path) !== "writing") marks.set(path, active ? "this-run" : "last-run");
      }
    }
  }
  return marks;
}

/** The latest time a command started in the task, or null when none has. */
export function lastCommandAt(transcript: Pick<Transcript, "runs">): number | null {
  let latest: number | null = null;
  for (const run of transcript.runs) {
    for (const step of run.steps) {
      if (step.kind !== "tool" || !isCommandTool(step.toolName)) continue;
      const at = step.startedAt ?? step.endedAt;
      if (at !== null && (latest === null || at > latest)) latest = at;
    }
  }
  return latest;
}

/** Whether the task ran a command after `checkedAt` (section 9, F-448). */
export function commandsSince(transcript: Pick<Transcript, "runs">, checkedAt: number): boolean {
  const at = lastCommandAt(transcript);
  return at !== null && at > checkedAt;
}

/**
 * How many file-tool changes have finished in the task: a number that grows
 * when a result lands, so a view can fetch its list again after one.
 */
export function finishedChanges(transcript: Pick<Transcript, "runs">): number {
  let count = 0;
  for (const run of transcript.runs)
    for (const step of run.steps)
      if (
        step.kind === "tool" &&
        step.files &&
        isChangeTool(step.toolName) &&
        (step.status === "done" || step.status === "failed")
      )
        count += 1;
  return count;
}

/** A step that touched a file: what it did and when, to say so and to reach it. */
export type FileSource = {
  stepId: string;
  toolCallId: string | null;
  runId: string;
  action: "read" | "write" | "edit" | "patch";
  at: number | null;
  status: Step["status"];
  created: boolean | null;
};

const actionOf = (name: string | null): FileSource["action"] | null => {
  switch (name?.toLowerCase()) {
    case "read":
      return "read";
    case "write":
      return "write";
    case "edit":
      return "edit";
    case "apply_patch":
      return "patch";
    default:
      return null;
  }
};

/**
 * Every step in the task that named this exact path, oldest first. The path
 * is compared as the tools gave it, the same string the gateway's own list
 * reads from the same calls; nothing is matched by name.
 */
export function fileSteps(transcript: Pick<Transcript, "runs">, path: string): FileSource[] {
  const out: FileSource[] = [];
  for (const run of transcript.runs) {
    for (const step of run.steps) {
      const action = actionOf(step.toolName);
      if (step.kind !== "tool" || !step.files || !action || !step.files.paths.includes(path))
        continue;
      out.push({
        stepId: step.id,
        toolCallId: step.toolCallId,
        runId: run.id,
        action,
        at: step.endedAt ?? step.startedAt,
        status: step.status,
        created: step.files.created,
      });
    }
  }
  return out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

/** The step that last touched the file in this task (section 6's source line), or null. */
export function fileSource(transcript: Pick<Transcript, "runs">, path: string): FileSource | null {
  const steps = fileSteps(transcript, path).filter((step) => step.status !== "failed");
  const changed = steps.filter((step) => step.action !== "read");
  return changed.at(-1) ?? steps.at(-1) ?? null;
}

/** The successful changes the file tools made to this path, newest first (section 7). */
export function fileChanges(transcript: Pick<Transcript, "runs">, path: string): FileSource[] {
  return fileSteps(transcript, path)
    .filter((step) => step.action !== "read" && step.status === "done")
    .reverse();
}

/**
 * A change from a step's raw result, live (`result.details`) or from history
 * (`details`). The live result carries the unified `patch`; the gateway's
 * history keeps only `diff`, the same change as numbered lines ("+3 text",
 * "-3 text", " 4 text", and "..." between distant parts).
 */
export function stepPatch(raw: StepRaw | null): {
  patch: string | null;
  diff: string | null;
  created: boolean | null;
  tooLarge: boolean;
} {
  const result = asRecord(raw?.result);
  const details = asRecord(asRecord(result?.result)?.details) ?? asRecord(result?.details) ?? null;
  const patch = typeof details?.patch === "string" ? details.patch : null;
  const diff = typeof details?.diff === "string" ? details.diff : null;
  return {
    patch,
    diff,
    created: typeof details?.created === "boolean" ? details.created : null,
    tooLarge: details?.truncated === true && patch === null && diff === null,
  };
}

/** The folder of a path, relative to the task's root ("" at the root). */
export function folderOf(path: string): string {
  return dirname(path);
}
