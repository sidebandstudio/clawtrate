// The Work pane's files in the engine (work-pane.md, Part 1, sections 4, 7, 8
// and 9): which reader may address a file and the limits each meets, the
// bounded way content reaches a viewer, and the run markers from file-tool
// evidence. Test names carry the parity rows they support.

import { describe, expect, it } from "vitest";
import { fromBase64, sha256Hex, toBase64, utf8Bytes } from "../src/bytes.ts";
import {
  afterTooLarge,
  afterUnsupported,
  ASSET_MAX_BYTES,
  chunkBytesFor,
  commandsSince,
  establishFolder,
  fileChanges,
  fileMarks,
  fileSource,
  FILE_TRANSFER_TTL_MS,
  FileTransfers,
  finishedChanges,
  listTaskFiles,
  MAX_FILE_TRANSFERS,
  MAX_SAVE_BYTES,
  PendingSaves,
  planTaskRead,
  planWorkspaceRead,
  PREVIEW_MAX_BYTES,
  readCheckoutDiff,
  readTaskFile,
  readWorkspaceFile,
  stepPatch,
  WORKSPACE_PICTURE_MAX_BYTES,
  type FileReaderContext,
  type FileRead,
  type TaskFolder,
} from "../src/files.ts";
import { filePathsOf } from "../src/file-paths.ts";
import { applyAgentEvent, emptyActivity, RawTable, type Run, type Step } from "../src/runs.ts";

const KEY = "agent:otto:task-1";
const ROOT = "/state/workspaces/otto";
const WORKSPACE: TaskFolder = { kind: "workspace", sameAsWorkspace: true };
const SPAWNED: TaskFolder = { kind: "own", sameAsWorkspace: false };
const REPOSITORY: TaskFolder = { kind: "repository", sameAsWorkspace: false };
const MiB = 1_048_576;

describe("which reader may address a task's file", () => {
  it("F-319: the workspace reader only when the row carries none of the four fields and the list returned a root", () => {
    expect(establishFolder({ key: KEY }, ROOT)).toEqual(WORKSPACE);
    expect(establishFolder({ key: KEY }, null)).toEqual({
      kind: "workspace",
      sameAsWorkspace: false,
    });
    for (const field of ["spawnedWorkspaceDir", "spawnedCwd"]) {
      expect(establishFolder({ key: KEY, [field]: "/elsewhere" }, ROOT)).toEqual(SPAWNED);
    }
    expect(
      establishFolder({ key: KEY, worktree: { id: "w", branch: "b", repoRoot: "/r" } }, ROOT),
    ).toEqual(SPAWNED);
    expect(establishFolder({ key: KEY, repositoryWorkspaceId: "repo-1" }, ROOT)).toEqual(
      REPOSITORY,
    );
    // A row that could not be read establishes nothing.
    expect(establishFolder(null, ROOT)).toEqual({ kind: "unknown", sameAsWorkspace: false });
    // An empty field is not a field.
    expect(establishFolder({ key: KEY, spawnedCwd: "  " }, ROOT)).toEqual(WORKSPACE);
  });

  it("F-319: text and pictures within 256 KiB go to the task's own reader first", () => {
    for (const folder of [WORKSPACE, SPAWNED, REPOSITORY]) {
      expect(
        planTaskRead({ name: "notes.md", size: 2_400, workspacePath: "notes.md" }, folder),
      ).toEqual({
        reader: "sessions.files.get",
      });
      expect(
        planTaskRead(
          { name: "chart.png", size: PREVIEW_MAX_BYTES, workspacePath: "chart.png" },
          folder,
        ),
      ).toEqual({
        reader: "sessions.files.get",
      });
    }
  });

  it("F-319: a larger picture uses the workspace reader only where the same folder is established", () => {
    const photo = { name: "photo.png", size: 3 * MiB, workspacePath: "pictures/photo.png" };
    expect(planTaskRead(photo, WORKSPACE)).toEqual({ reader: "agents.workspace.get" });
    // A spawned workspace: never the workspace reader, whatever the names say.
    expect(planTaskRead(photo, SPAWNED)).toEqual({
      stop: { code: "picture-too-large", size: 3 * MiB, limit: ASSET_MAX_BYTES, where: "task" },
    });
    expect(planTaskRead({ ...photo, size: 900_000 }, SPAWNED)).toEqual({
      reader: "sessions.files.assets",
    });
    // A repository-backed task: the preview limit only.
    expect(planTaskRead(photo, REPOSITORY)).toEqual({
      stop: {
        code: "picture-too-large",
        size: 3 * MiB,
        limit: PREVIEW_MAX_BYTES,
        where: "repository",
      },
    });
    // Past the workspace reader's own limit.
    expect(planTaskRead({ ...photo, size: 6 * MiB }, WORKSPACE)).toEqual({
      stop: {
        code: "picture-too-large",
        size: 6 * MiB,
        limit: WORKSPACE_PICTURE_MAX_BYTES,
        where: "workspace",
      },
    });
    // An absolute workspace path is outside the task's root: not the workspace reader.
    expect(
      planTaskRead({ ...photo, size: 900_000, workspacePath: "/tmp/photo.png" }, WORKSPACE),
    ).toEqual({
      reader: "sessions.files.assets",
    });
  });

  it("F-319: audio and video only from the asset reader of an ordinary folder, up to 1 MiB", () => {
    const memo = { name: "voice-memo.m4a", size: 800_000, workspacePath: "notes/voice-memo.m4a" };
    expect(planTaskRead(memo, WORKSPACE)).toEqual({ reader: "sessions.files.assets" });
    expect(planTaskRead(memo, SPAWNED)).toEqual({ reader: "sessions.files.assets" });
    expect(planTaskRead({ ...memo, size: 14 * MiB }, WORKSPACE)).toEqual({
      stop: { code: "media-too-large", size: 14 * MiB, limit: ASSET_MAX_BYTES, media: "audio" },
    });
    // Never from a repository, at any size.
    expect(planTaskRead({ ...memo, size: 10 }, REPOSITORY)).toEqual({
      stop: { code: "media-in-repository", media: "audio" },
    });
    expect(
      planTaskRead({ name: "walk.mp4", size: 10, workspacePath: "walk.mp4" }, REPOSITORY),
    ).toEqual({
      stop: { code: "media-in-repository", media: "video" },
    });
  });

  it("F-319: a stylesheet or script over 256 KiB from the asset reader of an ordinary folder, up to 1 MiB", () => {
    const script = { name: "dashboard.js", size: 400_000, workspacePath: "tools/dashboard.js" };
    expect(planTaskRead(script, SPAWNED)).toEqual({ reader: "sessions.files.assets" });
    expect(planTaskRead({ ...script, size: 2 * MiB }, SPAWNED)).toEqual({
      stop: { code: "script-too-large", size: 2 * MiB, limit: ASSET_MAX_BYTES },
    });
    expect(planTaskRead(script, REPOSITORY)).toEqual({
      stop: { code: "text-too-large", size: 400_000, limit: PREVIEW_MAX_BYTES },
    });
  });

  it("F-449: a large document is described without asking a reader; other large files ask the task reader what they are", () => {
    expect(
      planTaskRead(
        { name: "receipts.pdf", size: 3 * MiB, workspacePath: "receipts.pdf" },
        WORKSPACE,
      ),
    ).toEqual({
      stop: { code: "not-text-or-media", mimeType: null },
    });
    expect(
      planTaskRead(
        { name: "transcode.log", size: 3 * MiB, workspacePath: "transcode.log" },
        WORKSPACE,
      ),
    ).toEqual({
      reader: "sessions.files.get",
    });
  });

  it("F-449: what the task reader would not send leads on by the type it detected", () => {
    const file = { name: "scan.heic", size: 100_000, workspacePath: "scan.heic" };
    expect(afterUnsupported(file, WORKSPACE, "image/heic")).toEqual({
      reader: "agents.workspace.get",
    });
    expect(afterUnsupported(file, SPAWNED, "image/heic")).toEqual({
      reader: "sessions.files.assets",
    });
    expect(afterUnsupported({ ...file, name: "clip" }, REPOSITORY, "video/mp4")).toEqual({
      stop: { code: "media-in-repository", media: "video" },
    });
    expect(afterUnsupported({ ...file, name: "report.pdf" }, WORKSPACE, "application/pdf")).toEqual(
      {
        stop: { code: "not-text-or-media", mimeType: "application/pdf" },
      },
    );
  });

  it("F-449: a small picture of a type a repository's reader refused is described by its type, not as too large", () => {
    const tiny = { name: "tiny.bmp", size: 58, workspacePath: "tiny.bmp" };
    expect(afterUnsupported(tiny, REPOSITORY, "image/bmp")).toEqual({
      stop: { code: "picture-type-not-sent", mimeType: "image/bmp", where: "repository" },
    });
    expect(afterUnsupported({ ...tiny, size: 300_000 }, REPOSITORY, "image/bmp")).toEqual({
      stop: {
        code: "picture-too-large",
        size: 300_000,
        limit: PREVIEW_MAX_BYTES,
        where: "repository",
      },
    });
  });

  it("F-449: a refusal as too large leads on from its own size and limit", () => {
    const script = { name: "bundle.js", size: 300_010, workspacePath: "bundle.js" };
    expect(afterTooLarge(script, WORKSPACE, PREVIEW_MAX_BYTES)).toEqual({
      reader: "sessions.files.assets",
    });
    expect(afterTooLarge(script, SPAWNED, PREVIEW_MAX_BYTES)).toEqual({
      reader: "sessions.files.assets",
    });
    expect(afterTooLarge({ ...script, size: 2 * MiB }, SPAWNED, PREVIEW_MAX_BYTES)).toEqual({
      stop: { code: "script-too-large", size: 2 * MiB, limit: ASSET_MAX_BYTES },
    });
    expect(afterTooLarge(script, REPOSITORY, PREVIEW_MAX_BYTES)).toEqual({
      stop: { code: "text-too-large", size: 300_010, limit: PREVIEW_MAX_BYTES },
    });
    expect(
      afterTooLarge({ name: "report.pdf", size: null, workspacePath: null }, WORKSPACE, 262_144),
    ).toEqual({ stop: { code: "not-text-or-media", mimeType: null } });
    expect(
      afterTooLarge({ name: "server.log", size: 400_000, workspacePath: null }, WORKSPACE, 262_144),
    ).toEqual({ stop: { code: "text-too-large", size: 400_000, limit: 262_144 } });
  });

  it("F-152: in the workspace browser, media only through an open task whose folder is that workspace", () => {
    const memo = { name: "voice-memo.m4a", size: 800_000 };
    expect(planWorkspaceRead(memo, null)).toEqual({
      stop: { code: "media-outside-task", media: "audio" },
    });
    expect(planWorkspaceRead(memo, SPAWNED)).toEqual({
      stop: { code: "media-outside-task", media: "audio" },
    });
    expect(planWorkspaceRead(memo, WORKSPACE)).toEqual({ reader: "sessions.files.assets" });
    expect(planWorkspaceRead({ name: "photo.jpg", size: 4 * MiB }, null)).toEqual({
      reader: "agents.workspace.get",
    });
    expect(planWorkspaceRead({ name: "photo.heic", size: 7 * MiB }, null)).toEqual({
      stop: {
        code: "picture-too-large",
        size: 7 * MiB,
        limit: WORKSPACE_PICTURE_MAX_BYTES,
        where: "workspace",
      },
    });
    expect(planWorkspaceRead({ name: "transcode.log", size: 3 * MiB }, null)).toEqual({
      stop: { code: "text-too-large", size: 3 * MiB, limit: PREVIEW_MAX_BYTES },
    });
    expect(planWorkspaceRead({ name: "notes.md", size: 100 }, null)).toEqual({
      reader: "agents.workspace.get",
    });
  });
});

// A gateway that answers the file methods from a table, recording each call.
type Answer = unknown | ((params: Record<string, unknown>) => unknown);
function gateway(answers: Record<string, Answer>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const request = async (method: string, params: unknown) => {
    const p = params as Record<string, unknown>;
    calls.push({ method, params: p });
    const answer = answers[method];
    if (answer === undefined) throw new Error(`unexpected ${method}`);
    const value =
      typeof answer === "function"
        ? (answer as (p: Record<string, unknown>) => unknown)(p)
        : answer;
    if (value instanceof Error) throw value;
    return value;
  };
  return { calls, request };
}
const refusal = (type: string, details: Record<string, unknown>) =>
  Object.assign(new Error("refused"), { details: { type, ...details } });
const context = (request: FileReaderContext["request"], maxChars?: number): FileReaderContext => ({
  request,
  transfers: new FileTransfers(() => 0),
  owner: {},
  ...(maxChars === undefined ? {} : { maxChars }),
  now: () => 1_000,
});
const listing = (files: Record<string, unknown>[], row: Record<string, unknown> = {}) => ({
  "sessions.files.list": { sessionKey: KEY, root: ROOT, files },
  "sessions.describe": { session: { key: KEY, ...row } },
});
const entry = (path: string, size: number, extra: Record<string, unknown> = {}) => ({
  path,
  workspacePath: path,
  name: path.split("/").pop(),
  kind: "modified",
  missing: false,
  size,
  updatedAtMs: 900,
  ...extra,
});
const contentBytes = (read: FileRead) => {
  if (read.status !== "content") throw new Error(`no content: ${JSON.stringify(read)}`);
  return fromBase64(read.transfer.data)!;
};

describe("reading through the gateway", () => {
  it("F-319: text comes from the task reader with the gateway's hash, and its bytes are the file's", async () => {
    const text = "Leave at 8:30. Café ☕\n";
    const g = gateway({
      ...listing([entry("notes/edit-me.md", utf8Bytes(text).length)]),
      "sessions.files.get": {
        sessionKey: KEY,
        root: ROOT,
        file: {
          ...entry("notes/edit-me.md", 25),
          mimeType: "text/plain",
          contentEncoding: "utf8",
          previewKind: "text",
          content: text,
          hash: sha256Hex(utf8Bytes(text)),
        },
      },
    });
    const read = await readTaskFile(context(g.request), KEY, "otto", "notes/edit-me.md");
    expect(read).toMatchObject({
      status: "content",
      reader: "sessions.files.get",
      kind: "text",
      hash: sha256Hex(utf8Bytes(text)),
    });
    expect(contentBytes(read)).toEqual(utf8Bytes(text));
  });

  it("F-449: text over 256 KiB says so with the size and limit the gateway gave", async () => {
    const g = gateway({
      ...listing([entry("logs/transcode.log", 3_565_158)]),
      "sessions.files.get": () =>
        refusal("session_file_too_large", { size: 3_565_158, maxPreviewBytes: 262_144 }),
    });
    const read = await readTaskFile(context(g.request), KEY, "otto", "logs/transcode.log");
    expect(read).toMatchObject({
      status: "cannot-show",
      limit: { code: "text-too-large", size: 3_565_158, limit: 262_144 },
    });
  });

  it("F-449: a script the list showed small that the task reader refuses as too large comes from the asset reader", async () => {
    const bytes = utf8Bytes(`// script\n${"x".repeat(300_000)}`);
    const g = gateway({
      ...listing([entry("bundle.js", 12)], { spawnedCwd: `${ROOT}/site` }),
      "sessions.files.get": () =>
        refusal("session_file_too_large", { size: bytes.length, maxPreviewBytes: 262_144 }),
      "sessions.files.assets": {
        assets: [{ ref: "bundle.js", mimeType: "text/javascript", content: toBase64(bytes) }],
      },
    });
    const read = await readTaskFile(context(g.request), KEY, "otto", "bundle.js");
    expect(read).toMatchObject({
      status: "content",
      reader: "sessions.files.assets",
      kind: "text",
      bytes: bytes.length,
      facts: { size: bytes.length },
    });
    expect(contentBytes(read)).toEqual(bytes);
  });

  it("F-449: the workspace reader's refusal names the limit it applied: its picture limit or its text limit", async () => {
    const g = gateway({
      "agents.workspace.get": (p: Record<string, unknown>) =>
        p.path === "scan"
          ? refusal("workspace_file_too_large", { size: 6 * MiB, maxBytes: 5_242_880 })
          : refusal("workspace_file_too_large", { size: 300_000, maxBytes: 262_144 }),
    });
    expect(await readWorkspaceFile(context(g.request), "otto", "scan", 10, null)).toMatchObject({
      status: "cannot-show",
      limit: { code: "picture-too-large", size: 6 * MiB, limit: 5_242_880, where: "workspace" },
    });
    expect(await readWorkspaceFile(context(g.request), "otto", "fake.png", 10, null)).toMatchObject(
      {
        status: "cannot-show",
        limit: { code: "text-too-large", size: 300_000, limit: 262_144 },
      },
    );
  });

  it("F-319: a large picture in a spawned workspace never reaches the workspace reader", async () => {
    const g = gateway({
      ...listing([entry("photo.png", 3 * MiB)], {
        spawnedCwd: "/state/workspaces/otto/projects/site",
      }),
    });
    const read = await readTaskFile(context(g.request), KEY, "otto", "photo.png");
    expect(read).toMatchObject({
      status: "cannot-show",
      limit: { code: "picture-too-large", where: "task", limit: ASSET_MAX_BYTES },
    });
    expect(g.calls.map((call) => call.method)).not.toContain("agents.workspace.get");
    expect(g.calls.map((call) => call.method)).not.toContain("sessions.files.get");
  });

  it("F-319: a large picture in the bot's established workspace comes from the workspace reader by its workspace path", async () => {
    const bytes = Uint8Array.from({ length: 400_000 }, (_, i) => (i * 7) & 255);
    const g = gateway({
      ...listing([
        entry("pictures/summit.png", bytes.length, { workspacePath: "pictures/summit.png" }),
      ]),
      "agents.workspace.get": (p: Record<string, unknown>) => ({
        agentId: p.agentId,
        file: {
          path: p.path,
          name: "summit.png",
          size: bytes.length,
          updatedAtMs: 900,
          mimeType: "image/png",
          encoding: "base64",
          content: toBase64(bytes),
        },
      }),
    });
    const read = await readTaskFile(context(g.request), KEY, "otto", "pictures/summit.png");
    expect(read).toMatchObject({
      status: "content",
      reader: "agents.workspace.get",
      kind: "image",
    });
    expect(g.calls.find((call) => call.method === "agents.workspace.get")?.params).toEqual({
      agentId: "otto",
      path: "pictures/summit.png",
    });
    expect(contentBytes(read)).toEqual(bytes);
  });

  it("F-319: a task moved to its own folder while its picture was read shows nothing the workspace reader sent", async () => {
    const before = Uint8Array.from({ length: 400_000 }, (_, i) => (i * 7) & 255);
    const after = Uint8Array.from({ length: 400_000 }, (_, i) => (i * 11 + 3) & 255);
    let moved = false;
    const row = () => ({ session: { key: KEY, ...(moved ? { spawnedCwd: `${ROOT}/site` } : {}) } });
    const g = gateway({
      "sessions.files.list": { sessionKey: KEY, root: ROOT, files: [entry("trail.png", 400_000)] },
      "sessions.describe": row,
      "agents.workspace.get": () => {
        // The task gets its own folder after the reader was chosen, before it answers.
        moved = true;
        return {
          file: {
            size: before.length,
            mimeType: "image/png",
            encoding: "base64",
            content: toBase64(before),
          },
        };
      },
      "sessions.files.assets": {
        assets: [{ ref: "trail.png", mimeType: "image/png", content: toBase64(after) }],
      },
    });
    const ctx = context(g.request);
    const read = await readTaskFile(ctx, KEY, "otto", "trail.png");
    expect(read).toMatchObject({ status: "content", reader: "sessions.files.assets" });
    expect(contentBytes(read)).toEqual(after);
    expect(ctx.transfers.size).toBe(0);
  });

  it("F-319: the workspace reader is not asked when the row shows the task's own folder just before the read", async () => {
    let describes = 0;
    const g = gateway({
      "sessions.files.list": { sessionKey: KEY, root: ROOT, files: [entry("trail.png", 400_000)] },
      // The row the list came with shares the workspace; every later read of it does not.
      "sessions.describe": () => {
        describes += 1;
        return { session: { key: KEY, ...(describes > 1 ? { worktree: { path: "/wt" } } : {}) } };
      },
      "sessions.files.assets": { assets: [{ ref: "trail.png", error: "too_large" }] },
    });
    const read = await readTaskFile(context(g.request), KEY, "otto", "trail.png");
    expect(g.calls.map((call) => call.method)).not.toContain("agents.workspace.get");
    expect(read).toMatchObject({ status: "cannot-show", limit: { where: "task" } });
  });

  it("F-319: a task whose folder keeps changing while its file is read says so and shows nothing", async () => {
    let describes = 0;
    const g = gateway({
      "sessions.files.list": { sessionKey: KEY, root: ROOT, files: [entry("trail.png", 400_000)] },
      // Shared with the workspace on each fresh list, moved by the time the reader answers.
      "sessions.describe": () => {
        describes += 1;
        return { session: { key: KEY, ...(describes % 3 === 0 ? { spawnedCwd: "/x" } : {}) } };
      },
      "agents.workspace.get": {
        file: {
          size: 3,
          mimeType: "image/png",
          encoding: "base64",
          content: toBase64(Uint8Array.from([1, 2, 3])),
        },
      },
    });
    const read = await readTaskFile(context(g.request), KEY, "otto", "trail.png");
    expect(read).toEqual({
      status: "failed",
      message: "This task's folder changed while the file was read. Try again.",
    });
  });

  it("F-152: the workspace browser drops a recording the task's asset reader sent after the task moved", async () => {
    let moved = false;
    const g = gateway({
      "sessions.files.list": { sessionKey: KEY, root: ROOT, files: [] },
      "sessions.describe": () => ({
        session: { key: KEY, ...(moved ? { spawnedWorkspaceDir: "/elsewhere" } : {}) },
      }),
      "sessions.files.assets": () => {
        moved = true;
        return {
          assets: [
            { ref: "memo.m4a", mimeType: "audio/mp4", content: toBase64(Uint8Array.from([9])) },
          ],
        };
      },
    });
    const read = await readWorkspaceFile(context(g.request), "otto", "memo.m4a", 1, KEY);
    expect(read).toMatchObject({ status: "cannot-show", limit: { code: "media-outside-task" } });
  });

  it("F-319: a repository-backed task's recording asks no reader at all", async () => {
    const g = gateway(
      listing([entry("walkthrough.mp4", 200)], { repositoryWorkspaceId: "repo-1" }),
    );
    const read = await readTaskFile(context(g.request), KEY, "otto", "walkthrough.mp4");
    expect(read).toMatchObject({
      status: "cannot-show",
      limit: { code: "media-in-repository", media: "video" },
    });
    expect(g.calls.map((call) => call.method).sort()).toEqual([
      "sessions.describe",
      "sessions.files.list",
    ]);
  });

  it("F-319: a recording in an ordinary folder comes from the asset reader, named relative to its own folder", async () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 250]);
    const g = gateway({
      ...listing([entry("notes/voice memo.m4a", 5)]),
      "sessions.files.assets": {
        assets: [{ ref: "voice%20memo.m4a", mimeType: "audio/mp4", content: toBase64(bytes) }],
      },
    });
    const read = await readTaskFile(context(g.request), KEY, "otto", "notes/voice memo.m4a");
    expect(read).toMatchObject({
      status: "content",
      reader: "sessions.files.assets",
      kind: "audio",
      hash: sha256Hex(bytes),
    });
    expect(g.calls.find((call) => call.method === "sessions.files.assets")?.params).toEqual({
      sessionKey: KEY,
      path: "notes/voice memo.m4a",
      refs: ["voice%20memo.m4a"],
    });
  });

  it("F-449: a file no reader sends is described, with the type the gateway detected", async () => {
    const g = gateway({
      ...listing([entry("notes/receipts.pdf", 40_000)]),
      "sessions.files.get": {
        sessionKey: KEY,
        file: {
          ...entry("notes/receipts.pdf", 40_000),
          previewKind: "unsupported",
          mimeType: "application/pdf",
        },
      },
    });
    const read = await readTaskFile(context(g.request), KEY, "otto", "notes/receipts.pdf");
    expect(read).toMatchObject({
      status: "cannot-show",
      facts: { mimeType: "application/pdf", size: 40_000 },
      limit: { code: "not-text-or-media" },
    });
  });

  it("F-320: a missing file and a failed read are told apart", async () => {
    const missing = gateway({
      ...listing([entry("gone.md", 10)]),
      "sessions.files.get": () => refusal("session_file_not_found", { path: "gone.md" }),
    });
    expect(await readTaskFile(context(missing.request), KEY, "otto", "gone.md")).toMatchObject({
      status: "missing",
    });
    const failing = gateway({
      ...listing([entry("a.md", 10)]),
      "sessions.files.get": () => new Error("gateway timed out"),
    });
    expect(await readTaskFile(context(failing.request), KEY, "otto", "a.md")).toEqual({
      status: "failed",
      message: "gateway timed out",
    });
  });

  it("F-152: the workspace browser reads a recording only through the open task's established folder", async () => {
    const g = gateway(listing([], { spawnedCwd: "/elsewhere" }));
    const read = await readWorkspaceFile(
      context(g.request),
      "otto",
      "notes/voice-memo.m4a",
      100,
      KEY,
    );
    expect(read).toMatchObject({ status: "cannot-show", limit: { code: "media-outside-task" } });
    expect(g.calls.map((call) => call.method)).not.toContain("sessions.files.assets");
  });

  it("F-152: a list keeps what fits the viewer's channel and counts the rest", async () => {
    const files = Array.from({ length: 400 }, (_, i) =>
      entry(`notes/file-${String(i).padStart(3, "0")}-${"x".repeat(200)}.md`, i),
    );
    const g = gateway(listing(files));
    const list = await listTaskFiles(context(g.request, 50_000), KEY);
    expect(list.files.length).toBeGreaterThan(0);
    expect(list.files.length + list.omitted).toBe(400);
    expect(JSON.stringify(list).length).toBeLessThanOrEqual(50_000);
    expect(list.folder).toEqual(WORKSPACE);
  });

  it("F-152: the comparison is matched by absolute path and labelled by its base", async () => {
    const g = gateway({
      "sessions.files.list": {
        sessionKey: KEY,
        root: `${ROOT}/projects/site`,
        files: [entry("notes/scratch.md", 30)],
      },
      "sessions.describe": { session: { key: KEY, spawnedCwd: `${ROOT}/projects/site` } },
      "sessions.diff": {
        sessionKey: KEY,
        root: `${ROOT}/projects/site`,
        baseRef: "HEAD",
        branch: "main",
        files: [
          {
            path: "scratch.md",
            status: "added",
            additions: 1,
            deletions: 0,
            patch: "@@ -0,0 +1 @@\n+wrong file\n",
          },
          {
            path: "notes/scratch.md",
            status: "added",
            additions: 3,
            deletions: 0,
            untracked: true,
            patch: "@@ -0,0 +1,3 @@\n+a\n+b\n+c\n",
          },
        ],
        additions: 4,
        deletions: 0,
      },
    });
    const diff = await readCheckoutDiff(context(g.request), KEY, "notes/scratch.md");
    expect(diff).toMatchObject({
      status: "ok",
      baseRef: "HEAD",
      file: { path: "notes/scratch.md", additions: 3, untracked: true },
    });
    const outside = gateway({
      ...listing([entry("a.md", 1)]),
      "sessions.diff": {
        sessionKey: KEY,
        files: [],
        additions: 0,
        deletions: 0,
        unavailableReason: "not_git",
      },
    });
    expect(await readCheckoutDiff(context(outside.request), KEY, "a.md")).toEqual({
      status: "unavailable",
      reason: "not_git",
    });
  });
});

describe("content on its way to a viewer", () => {
  it("F-319: chunks put together give exactly the bytes the reader sent", () => {
    const transfers = new FileTransfers(() => 0);
    const owner = {};
    const bytes = Uint8Array.from({ length: 700_001 }, (_, i) => (i * 31 + 7) & 255);
    const start = transfers.start(owner, bytes, 262_144 - 512);
    expect(start.id).not.toBeNull();
    const parts = [start.data];
    for (let i = 1; i < start.chunks; i += 1) parts.push(transfers.chunk(owner, start.id!, i).data);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(262_144 - 512);
    expect(fromBase64(parts.join(""))).toEqual(bytes);
    // Read to the end: nothing of it is kept.
    expect(transfers.size).toBe(0);
  });

  it("small content needs no transfer", () => {
    const transfers = new FileTransfers(() => 0);
    expect(transfers.start({}, utf8Bytes("hi"), 1_000_000)).toEqual({
      id: null,
      chunks: 1,
      data: toBase64(utf8Bytes("hi")),
    });
    expect(transfers.size).toBe(0);
  });

  it("holds at most four transfers, each its viewer's own, dropped when released or idle", () => {
    let now = 0;
    const transfers = new FileTransfers(() => now);
    const one = {};
    const two = {};
    const big = new Uint8Array(chunkBytesFor(100_000) * 2);
    const ids = Array.from(
      { length: MAX_FILE_TRANSFERS },
      () => transfers.start(one, big, 100_000).id!,
    );
    expect(() => transfers.start(two, big, 100_000)).toThrow(/try again/);
    expect(() => transfers.chunk(two, ids[0]!, 1)).toThrow(/ended/);
    transfers.release(one, ids[0]);
    expect(transfers.size).toBe(MAX_FILE_TRANSFERS - 1);
    now += FILE_TRANSFER_TTL_MS + 1;
    expect(transfers.start(two, big, 100_000).id).not.toBeNull();
    expect(transfers.size).toBe(1);
    transfers.release(two);
    expect(transfers.size).toBe(0);
  });

  it("F-319: a file waiting to be saved is at most what a reader sends, one per window, and its bytes move", () => {
    const saves = new PendingSaves();
    const tooLarge = new ArrayBuffer(MAX_SAVE_BYTES + 1);
    expect(() => saves.hold(1, tooLarge)).toThrow(/more than any of the gateway's readers sends/);
    expect(tooLarge.byteLength).toBe(MAX_SAVE_BYTES + 1);
    expect(saves.size).toBe(0);
    const handed = Uint8Array.from([239, 187, 191, 97, 10]).buffer;
    const ticket = saves.hold(1, handed);
    // Moved, not copied: what handed them over is left empty.
    expect(handed.byteLength).toBe(0);
    expect(new Uint8Array(saves.get(ticket)!)).toEqual(Uint8Array.from([239, 187, 191, 97, 10]));
    expect(() => saves.hold(1, new ArrayBuffer(1))).toThrow(/waiting to be saved/);
    expect(() => saves.hold(2, new ArrayBuffer(1))).toThrow(/waiting to be saved/);
    saves.release(ticket);
    expect(saves.get(ticket)).toBeNull();
    expect(saves.size).toBe(0);
    // A later save of the same window has a ticket of its own.
    const later = saves.hold(1, new ArrayBuffer(2));
    expect(later).not.toBe(ticket);
    expect(saves.get(ticket)).toBeNull();
    saves.release(later);
    saves.hold(2, new ArrayBuffer(MAX_SAVE_BYTES));
    expect(saves.size).toBe(1);
  });

  it("an idle transfer is dropped past its time by the next transfer or chunk read, not on a timer", () => {
    let now = 0;
    const transfers = new FileTransfers(() => now);
    const owner = {};
    const big = new Uint8Array(chunkBytesFor(100_000) * 2);
    const id = transfers.start(owner, big, 100_000).id!;
    now += FILE_TRANSFER_TTL_MS + 1;
    // Nothing has asked since: it is still held, and still counts against the four.
    expect(transfers.size).toBe(1);
    expect(() => transfers.chunk(owner, id, 1)).toThrow(/ended/);
    expect(transfers.size).toBe(0);
  });

  it("base64, UTF-8 and SHA-256 give the standard answers", () => {
    const bytes = Uint8Array.from({ length: 1000 }, (_, i) => (i * 13) & 255);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(toBase64(utf8Bytes("Man"))).toBe("TWFu");
    expect(toBase64(utf8Bytes("Ma"))).toBe("TWE=");
    expect(toBase64(utf8Bytes("M"))).toBe("TQ==");
    expect(fromBase64("not base64!")).toBeNull();
    expect(sha256Hex(utf8Bytes("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex(utf8Bytes("a".repeat(1000)))).toBe(
      "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
    );
    expect([...utf8Bytes("é☕𝄞")]).toEqual([0xc3, 0xa9, 0xe2, 0x98, 0x95, 0xf0, 0x9d, 0x84, 0x9e]);
  });
});

// Markers and sources, from steps as the run engine builds them.
const step = (
  id: string,
  toolName: string,
  paths: string[],
  status: Step["status"],
  at: number,
  extra: Partial<Step> = {},
): Step => ({
  id: `tool:${id}`,
  kind: "tool",
  title: toolName,
  toolName,
  toolCallId: id,
  status,
  startedAt: at,
  endedAt: status === "running" ? null : at + 1,
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
  raw: null,
  rawSize: null,
  ...(paths.length
    ? { files: { paths, changed: status === "done" ? true : null, created: null } }
    : {}),
  ...extra,
});
const run = (id: string, state: Run["state"], steps: Step[]): Run =>
  ({ ...emptyRunFields, id, state, steps }) as unknown as Run;
const emptyRunFields = {
  bound: true,
  origin: "gateway",
  steps: [],
  pendingCards: [],
  closedCards: [],
};

describe("the run markers and the step behind a file", () => {
  it("F-321: writing, then changed this run, then changed last run, until the next run starts", () => {
    const writing = run("r1", "running", [step("a", "write", ["notes/a.md"], "running", 10)]);
    expect([...fileMarks({ runs: [writing] })]).toEqual([["notes/a.md", "writing"]]);
    const written = run("r1", "running", [step("a", "write", ["notes/a.md"], "done", 10)]);
    expect([...fileMarks({ runs: [written] })]).toEqual([["notes/a.md", "this-run"]]);
    const ended = { ...written, state: "completed" as const };
    expect([...fileMarks({ runs: [ended] })]).toEqual([["notes/a.md", "last-run"]]);
    const next = run("r2", "running", []);
    expect([...fileMarks({ runs: [ended, next] })]).toEqual([]);
  });

  it("F-321: a failed write, a write that changed nothing, a read and a command mark nothing", () => {
    const steps = [
      step("a", "write", ["a.md"], "failed", 10),
      step("b", "edit", ["b.md"], "done", 11, {
        files: { paths: ["b.md"], changed: false, created: null },
      }),
      step("c", "read", ["c.md"], "done", 12),
      step("d", "exec", [], "done", 13),
    ];
    expect([...fileMarks({ runs: [run("r1", "running", steps)] })]).toEqual([]);
  });

  it("F-448: commands since the list was checked are noticed; file results are counted for the refetch", () => {
    const runs = [
      run("r1", "running", [
        step("a", "exec", [], "done", 500),
        step("b", "write", ["a.md"], "done", 600),
      ]),
    ];
    expect(commandsSince({ runs }, 400)).toBe(true);
    expect(commandsSince({ runs }, 500)).toBe(false);
    expect(finishedChanges({ runs })).toBe(1);
  });

  it("F-447: the source is the last change of exactly this path, else its read; never a name match", () => {
    const runs = [
      run("r1", "completed", [
        step("a", "read", ["notes/a.md"], "done", 10),
        step("b", "write", ["notes/a.md"], "done", 20),
      ]),
      run("r2", "completed", [
        step("c", "read", ["notes/a.md"], "done", 30),
        step("d", "write", ["other/a.md"], "done", 40),
      ]),
    ];
    expect(fileSource({ runs }, "notes/a.md")?.stepId).toBe("tool:b");
    expect(fileSource({ runs }, "a.md")).toBeNull();
    expect(fileChanges({ runs }, "notes/a.md").map((each) => each.stepId)).toEqual(["tool:b"]);
  });

  it("F-152: a change is read from a live result's patch and from the diff history keeps", () => {
    expect(
      stepPatch({
        source: "live",
        runId: "r",
        call: null,
        result: { result: { details: { patch: "@@", created: true } } },
      }),
    ).toEqual({ patch: "@@", diff: null, created: true, tooLarge: false });
    expect(
      stepPatch({
        source: "history",
        runId: "r",
        call: null,
        // As the gateway's history keeps a write's result: its diff, not its patch.
        result: {
          role: "toolResult",
          details: { changed: true, diff: "-1 Leave at 9:00.\n+1 Leave at 8:30." },
        },
      }),
    ).toEqual({
      patch: null,
      diff: "-1 Leave at 9:00.\n+1 Leave at 8:30.",
      created: null,
      tooLarge: false,
    });
  });

  it("the paths a file tool's call names, as the gateway's list reads them", () => {
    expect(filePathsOf("write", { path: "notes/a.md", content: "x" })).toEqual(["notes/a.md"]);
    expect(filePathsOf("read", { file_path: "b.md" })).toEqual(["b.md"]);
    expect(filePathsOf("exec", { path: "x" })).toEqual([]);
    expect(
      filePathsOf("apply_patch", {
        input: "*** Begin Patch\n*** Update File: a.md\n*** Move to: c.md\n*** Add File: b.md\n",
      }),
    ).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("F-321: the run engine keeps a file tool's paths and its result's details on the step", () => {
    const raw = new RawTable();
    const ctx = { sessionKey: KEY, now: 5_000, raw };
    const agent = (seq: number, data: Record<string, unknown>) => ({
      runId: "r1",
      seq,
      stream: "tool",
      ts: 1_000 + seq,
      sessionKey: KEY,
      data,
    });
    let activity = emptyActivity;
    activity = applyAgentEvent(
      activity,
      {
        runId: "r1",
        seq: 1,
        stream: "lifecycle",
        ts: 1_000,
        sessionKey: KEY,
        data: { phase: "start" },
      },
      ctx,
    ).activity;
    activity = applyAgentEvent(
      activity,
      agent(2, {
        phase: "start",
        name: "write",
        toolCallId: "c1",
        args: { path: "notes/a.md", content: "hi" },
      }),
      ctx,
    ).activity;
    expect(fileMarks(activity).get("notes/a.md")).toBe("writing");
    activity = applyAgentEvent(
      activity,
      agent(3, {
        phase: "result",
        name: "write",
        toolCallId: "c1",
        isError: false,
        result: {
          content: [{ type: "text", text: "ok" }],
          details: { changed: true, created: true, patch: "@@" },
        },
      }),
      ctx,
    ).activity;
    const written = activity.runs[0]!.steps.find((each) => each.id === "tool:c1")!;
    expect(written.files).toEqual({ paths: ["notes/a.md"], changed: true, created: true });
    expect(fileMarks(activity).get("notes/a.md")).toBe("this-run");
  });
});
