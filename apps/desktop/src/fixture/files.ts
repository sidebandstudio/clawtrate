// The Work pane's files on fixed data, for the fixture and the visual checks:
// Otto's disk task, its workspace, each file's content and every state the
// gateway's limits produce. Everything is invented, and the picture is drawn
// here. The address picks the state:
//
//   &files=loaded|loading|empty|error|stale|writing|commands|many|repo
//                        (error: the first fetch fails; stale: every fetch after the first)
//   &checkout=1          the task works in a git checkout
//   &fileload=failed     the first opening of a file fails; Try again succeeds

import {
  newRun,
  sha256Hex,
  toBase64,
  utf8Bytes,
  type BridgeCommand,
  type CheckoutDiff,
  type FileLimit,
  type FileRead,
  type Run,
  type Step,
  type TaskFile,
  type TaskFileList,
  type Transcript,
  type WorkspaceEntry,
  type WorkspacePage,
} from "@clawtrate/core";
import { OPEN_TASK } from "./data.ts";

export const FILE_STATES = [
  "loaded",
  "loading",
  "empty",
  "error",
  "stale",
  "writing",
  "commands",
  "many",
  "repo",
] as const;
export type FileState = (typeof FILE_STATES)[number];

const MINUTE = 60_000;

export type FileParams = { state: FileState | null; checkout: boolean; failFirstOpen: boolean };

export function fileParams(params: URLSearchParams): FileParams {
  const state = params.get("files");
  return {
    state: (FILE_STATES as readonly string[]).includes(state ?? "") ? (state as FileState) : null,
    checkout: params.get("checkout") === "1",
    failFirstOpen: params.get("fileload") === "failed",
  };
}

const NOTE_BEFORE =
  "# Disk on the media box, Nov 16\n\n- Disk was 94% full at 5:31 PM.\n- Largest: /var/lib/transcode-cache, about 180 GB.\n- Then: container images, about 40 GB; rotated logs, about 6 GB.\n";
const NOTE =
  "# Disk on the media box, Nov 16\n\n- Disk was 94% full at 5:31 PM; 61% after the move.\n- Largest: /var/lib/transcode-cache, about 180 GB.\n- Then: container images, about 40 GB; rotated logs, about 6 GB.\n\n## Changed\n\n- Moved the transcode cache to `transcode-cache.old`.\n- To undo, move it back.\n";
const MEDIA_BOX = "Watch disk use. Report above 90%.\n";
const AGENTS =
  "# Otto\n\nYou are Otto, the operator for a small home server.\n\n- Check before you change. Read logs and configs first.\n- Report in this order: what you found, what you changed, what is left.\n";
const INVENTORY =
  "# Inventory\n\n| Machine | Role | Disk |\n|---|---|---|\n| media-box | media server, transcoding | 2 TB |\n| rack-1 | backups | 8 TB |\n| rack-2 | containers | 1 TB |\n\nTranscodes go to /var/lib/transcode-cache and are regenerated on demand.\n";

/** A patch as a write or edit tool's result carries it. */
const PATCH_NOTE =
  "--- notes/disk-2026-11-16.md\n+++ notes/disk-2026-11-16.md\n@@ -1,5 +1,10 @@\n # Disk on the media box, Nov 16\n \n-- Disk was 94% full at 5:31 PM.\n+- Disk was 94% full at 5:31 PM; 61% after the move.\n - Largest: /var/lib/transcode-cache, about 180 GB.\n - Then: container images, about 40 GB; rotated logs, about 6 GB.\n+\n+## Changed\n+\n+- Moved the transcode cache to `transcode-cache.old`.\n+- To undo, move it back.\n";
const PATCH_NOTE_CREATED = `--- notes/disk-2026-11-16.md\n+++ notes/disk-2026-11-16.md\n@@ -0,0 +1,5 @@\n${NOTE_BEFORE.replace(
  /\n$/,
  "",
)
  .split("\n")
  .map((line) => `+${line}`)
  .join("\n")}\n`;
const PATCH_MEDIA_BOX =
  "--- notes/media-box.md\n+++ notes/media-box.md\n@@ -0,0 +1,1 @@\n+Watch disk use. Report above 90%.\n";

// A picture drawn here: a bar chart, as an uncompressed PNG ------------------

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function png(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      const [r, g, b] = pixel(x, y);
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  // zlib with stored blocks: no compression, so nothing but this file is needed.
  const blocks: number[] = [0x78, 0x01];
  for (let at = 0; at < raw.length; at += 65_535) {
    const size = Math.min(65_535, raw.length - at);
    blocks.push(
      at + size >= raw.length ? 1 : 0,
      size & 255,
      size >> 8,
      ~size & 255,
      (~size >> 8) & 255,
    );
    for (let i = 0; i < size; i += 1) blocks.push(raw[at + i]!);
  }
  let a = 1;
  let b = 0;
  for (const byte of raw) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  blocks.push(b >> 8, b & 255, a >> 8, a & 255);
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array(4 + data.length);
    body.set([...type].map((c) => c.charCodeAt(0)));
    body.set(data, 4);
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(body, 4);
    view.setUint32(8 + data.length, crc32(body));
    return out;
  };
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", Uint8Array.from(blocks)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Disk use before and after, by folder: four pairs of bars on a light ground. */
export function chartPicture(): Uint8Array {
  const bars = [
    [180, 0],
    [40, 40],
    [6, 6],
    [200, 200],
  ];
  return png(320, 180, (x, y) => {
    const row = Math.floor((y - 24) / 38);
    const inRow = (y - 24) % 38;
    if (row >= 0 && row < 4 && x >= 24) {
      const [before, after] = bars[row]!;
      const width = (value: number) => Math.max(2, Math.round((value / 200) * 270));
      if (inRow >= 2 && inRow < 14 && x < 24 + width(before!)) return [91, 141, 255];
      if (inRow >= 16 && inRow < 28 && x < 24 + width(after!)) return [69, 189, 245];
    }
    return [251, 251, 250];
  });
}

// The task's files and the workspace ----------------------------------------

type FixtureFile = {
  path: string;
  kind: "modified" | "read";
  ago: number;
  content?: Uint8Array;
  text?: string;
  mimeType?: string;
  size?: number;
  /** What the readers say instead of content. */
  limit?: FileLimit;
  missing?: boolean;
};

function taskFiles(now: number, params: FileParams): FixtureFile[] {
  const picture = chartPicture();
  const files: FixtureFile[] = [
    {
      path: "notes/disk-2026-11-16.md",
      kind: "modified",
      ago: 4,
      text: NOTE,
      mimeType: "text/markdown",
    },
    {
      path: "notes/media-box.md",
      kind: "modified",
      ago: 26 * 60,
      text: MEDIA_BOX,
      mimeType: "text/markdown",
    },
    { path: "charts/usage.png", kind: "modified", ago: 3, content: picture, mimeType: "image/png" },
    { path: "AGENTS.md", kind: "read", ago: 60 * 24 * 3, text: AGENTS, mimeType: "text/markdown" },
    {
      path: "inventory.md",
      kind: "read",
      ago: 60 * 24 * 7,
      text: INVENTORY,
      mimeType: "text/markdown",
    },
    {
      path: "logs/transcode.log",
      kind: "read",
      ago: 11,
      size: 3_565_158,
      limit: { code: "text-too-large", size: 3_565_158, limit: 262_144 },
    },
    {
      path: "notes/receipts.pdf",
      kind: "read",
      ago: 60 * 24 * 2,
      size: 48_213,
      mimeType: "application/pdf",
      limit: { code: "not-text-or-media", mimeType: "application/pdf" },
    },
    params.state === "repo"
      ? {
          path: "notes/cache-walkthrough.mp4",
          kind: "read",
          ago: 30,
          size: 412_000,
          limit: { code: "media-in-repository", media: "video" },
        }
      : {
          path: "notes/cache-walkthrough.mp4",
          kind: "read",
          ago: 30,
          size: 14_680_064,
          limit: { code: "media-too-large", size: 14_680_064, limit: 1_048_576, media: "video" },
        },
  ];
  if (params.state === "many") {
    for (let i = 1; i <= 33; i += 1)
      files.push({
        path: `logs/rotate-${String(i).padStart(2, "0")}.log`,
        kind: "read",
        ago: 60 + i,
        text: `rotated ${i}\n`,
      });
  }
  void now;
  return files;
}

function toTaskFile(file: FixtureFile, now: number): TaskFile {
  const bytes = file.content ?? (file.text !== undefined ? utf8Bytes(file.text) : null);
  return {
    path: file.path,
    workspacePath: file.path,
    name: file.path.split("/").pop()!,
    kind: file.kind,
    missing: file.missing === true,
    size: file.size ?? bytes?.length ?? null,
    updatedAt: now - file.ago * MINUTE,
  };
}

const WORKSPACE: Record<
  string,
  Array<{ name: string; kind: "file" | "directory"; ago: number; size?: number }>
> = {
  "": [
    { name: "charts", kind: "directory", ago: 3 },
    { name: "logs", kind: "directory", ago: 11 },
    { name: "notes", kind: "directory", ago: 4 },
    { name: "AGENTS.md", kind: "file", ago: 60 * 24 * 3, size: 220 },
    { name: "inventory.md", kind: "file", ago: 60 * 24 * 7, size: 352 },
  ],
  notes: [
    { name: "disk-2026-11-16.md", kind: "file", ago: 4, size: 361 },
    { name: "media-box.md", kind: "file", ago: 26 * 60, size: 34 },
    { name: "receipts.pdf", kind: "file", ago: 60 * 24 * 2, size: 48_213 },
    { name: "cache-walkthrough.mp4", kind: "file", ago: 30, size: 14_680_064 },
  ],
  charts: [{ name: "usage.png", kind: "file", ago: 3, size: 0 }],
  logs: Array.from({ length: 300 }, (_, i) => ({
    name: i === 0 ? "transcode.log" : `service-${String(i).padStart(3, "0")}.log`,
    kind: "file" as const,
    ago: 11 + i,
    size: i === 0 ? 3_565_158 : 2_048 + i,
  })),
};

// The runs that touched them, as the engine keeps them ----------------------

function fileStep(
  callId: string,
  toolName: string,
  path: string,
  at: number,
  status: Step["status"],
  patch: string | null,
  created: boolean | null,
): Step {
  return {
    id: `tool:${callId}`,
    kind: "tool",
    title: toolName === "read" ? `Read from ${path}` : `Write to ${path}`,
    toolName,
    toolCallId: callId,
    status,
    startedAt: at,
    endedAt: status === "running" ? null : at + 400,
    argsText: null,
    output: null,
    result: null,
    error: null,
    approvalId: null,
    failureKind: null,
    truncated: false,
    replaceable: false,
    correction: 0,
    continuation: null,
    raw:
      status === "running"
        ? null
        : {
            source: "history",
            runId: "fixture-files",
            call: null,
            result: { role: "toolResult", details: patch ? { patch, created, changed: true } : {} },
          },
    rawSize: null,
    files: {
      paths: [path],
      changed: status === "done" && toolName !== "read" ? true : null,
      created,
    },
  };
}

/** A command's step: it names no file. */
function commandStep(step: Step): Step {
  const { files: _files, ...rest } = step;
  void _files;
  return { ...rest, title: "Run a command" };
}

/** Runs of the disk task with its file steps, by the same call ids its history shows. */
export function fileRuns(now: number, params: FileParams): Run[] {
  const yesterday = now - 24 * 60 * MINUTE - 3 * 60 * MINUTE;
  const earlier = newRun(
    "fixture-files-1",
    { state: "completed", origin: "history", bound: true },
    yesterday,
  );
  earlier.steps = [
    fileStep(
      "c3",
      "write",
      "notes/media-box.md",
      yesterday + 4 * MINUTE,
      "done",
      PATCH_MEDIA_BOX,
      true,
    ),
  ];
  const today = newRun(
    "fixture-files-2",
    { state: "completed", origin: "history", bound: true },
    now - 9 * MINUTE,
  );
  today.steps = [
    fileStep("c5", "read", "AGENTS.md", now - 8 * MINUTE, "done", null, null),
    fileStep(
      "c8",
      "write",
      "notes/disk-2026-11-16.md",
      now - 6 * MINUTE,
      "done",
      PATCH_NOTE_CREATED,
      true,
    ),
    fileStep(
      "c6",
      "write",
      "notes/disk-2026-11-16.md",
      now - 4 * MINUTE,
      "done",
      PATCH_NOTE,
      false,
    ),
  ];
  const runs = [earlier, today];
  if (params.state === "writing" || params.state === "commands") {
    const active = newRun(
      "fixture-files-3",
      { state: "running", origin: "gateway", bound: true },
      now - MINUTE,
    );
    active.steps =
      params.state === "writing"
        ? [
            fileStep("c9", "edit", "notes/disk-2026-11-16.md", now - 30_000, "running", null, null),
            fileStep("c10", "write", "notes/cleanup-plan.md", now - 20_000, "running", null, null),
          ]
        : [commandStep(fileStep("c11", "exec", "", now - 20_000, "done", null, null))];
    runs.push(active);
  }
  return runs;
}

/** The disk task's transcript with its file runs, for the Files scenes. */
export function withFileRuns(
  transcripts: Record<string, Transcript>,
  now: number,
  params: FileParams,
) {
  if (params.state === null) return transcripts;
  const disk = transcripts[OPEN_TASK];
  if (!disk) return transcripts;
  const runs = fileRuns(now, params);
  const active = runs.find((run) => run.state === "running");
  return {
    ...transcripts,
    [OPEN_TASK]: {
      ...disk,
      runs,
      live: active ? { runId: active.id, text: "" } : disk.live,
    },
  };
}

// The answers ----------------------------------------------------------------

const forever = new Promise<never>(() => {});

export function fileAnswers(now: number, params: FileParams) {
  const files = taskFiles(now, params);
  let lists = 0;
  let opens = 0;
  const checkedAt = now - 4 * MINUTE;
  const list = (key: string): TaskFileList => ({
    key,
    root: "/srv/otto",
    folder:
      params.state === "repo"
        ? { kind: "repository", sameAsWorkspace: false }
        : { kind: "workspace", sameAsWorkspace: true },
    gitCheckout: params.checkout,
    // Scenes that are not about files show a task that has touched none.
    files:
      params.state === "empty" || params.state === null
        ? []
        : files.map((file) => toTaskFile(file, now)),
    omitted: 0,
    checkedAt,
  });
  const read = (path: string, workspace: boolean): FileRead => {
    const file = files.find((each) => each.path === path) ?? null;
    if (!file) {
      const listed = WORKSPACE[
        path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""
      ]?.find((entry) => entry.name === path.split("/").pop());
      if (listed?.name.endsWith(".mp4"))
        return {
          status: "cannot-show",
          facts: {
            name: listed.name,
            path,
            size: listed.size ?? null,
            updatedAt: now - listed.ago * MINUTE,
            mimeType: null,
          },
          limit: { code: "media-outside-task", media: "video" },
        };
      return { status: "missing", facts: null };
    }
    const facts = {
      name: file.path.split("/").pop()!,
      path,
      size: toTaskFile(file, now).size,
      updatedAt: now - file.ago * MINUTE,
      mimeType: file.mimeType ?? null,
    };
    if (file.limit) return { status: "cannot-show", facts, limit: file.limit };
    const bytes = file.content ?? utf8Bytes(file.text ?? "");
    const image = file.mimeType?.startsWith("image/") === true;
    return {
      status: "content",
      facts,
      reader: workspace ? "agents.workspace.get" : "sessions.files.get",
      kind: image ? "image" : "text",
      mimeType: file.mimeType ?? "text/plain",
      bytes: bytes.length,
      hash: sha256Hex(bytes),
      transfer: { id: null, chunks: 1, data: toBase64(bytes) },
    };
  };
  const diff: CheckoutDiff = {
    status: "ok",
    baseRef: "main",
    branch: "otto/disk-cleanup",
    mergeBase: { sha: "4f2a9c1", subject: "Start the notes" },
    file: {
      path: "notes/disk-2026-11-16.md",
      status: "added",
      additions: 10,
      deletions: 0,
      untracked: true,
      binary: false,
      patch: `@@ -0,0 +1,10 @@\n${NOTE.replace(/\n$/, "")
        .split("\n")
        .map((line) => `+${line}`)
        .join("\n")}\n`,
      truncated: false,
      cutByClient: false,
    },
  };

  return async (command: BridgeCommand): Promise<unknown> => {
    switch (command.type) {
      case "listTaskFiles": {
        lists += 1;
        if (params.state === "loading") return forever;
        // The first fetch fails; Try again succeeds.
        if (params.state === "error" && lists === 1)
          throw new Error("The gateway did not answer in time.");
        if (params.state === "stale" && lists > 1)
          throw new Error("The gateway did not answer in time.");
        return list(command.key);
      }
      case "readTaskFile":
      case "readWorkspaceFile": {
        opens += 1;
        if (params.failFirstOpen && opens === 1)
          return { status: "failed", message: "The gateway did not answer in time." };
        return read(command.path, command.type === "readWorkspaceFile");
      }
      case "listWorkspace": {
        const entries: WorkspaceEntry[] = (WORKSPACE[command.path] ?? []).map((entry) => ({
          path: command.path ? `${command.path}/${entry.name}` : entry.name,
          name: entry.name,
          kind: entry.kind,
          size: entry.kind === "directory" ? null : (entry.size ?? null),
          updatedAt: now - entry.ago * MINUTE,
        }));
        const page = entries.slice(command.offset, command.offset + 250);
        const answer: WorkspacePage = {
          botId: command.botId,
          path: command.path,
          entries: page,
          totalEntries: entries.length,
          offset: command.offset,
          nextOffset: command.offset + page.length,
          checkedAt: now - MINUTE,
          missing: !(command.path in WORKSPACE),
        };
        return answer;
      }
      case "readCheckoutDiff":
        return command.path === diff.file?.path ? diff : { ...diff, file: null };
      case "readFileChunk":
        throw new Error("No such transfer.");
      case "releaseFile":
        return;
      default:
        return undefined;
    }
  };
}

export const FILE_COMMANDS = new Set([
  "listTaskFiles",
  "readTaskFile",
  "readWorkspaceFile",
  "listWorkspace",
  "readCheckoutDiff",
  "readFileChunk",
  "releaseFile",
]);
