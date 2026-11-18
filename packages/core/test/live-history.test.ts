// One outcome for every kind, live and from history (conversation.md 7.3).
//
// Each case is a tool result as the installed OpenClaw 2026.10.6 builds it:
// `jsonResult(payload)` sends the payload as JSON text and as `details`;
// `textResult(text, details)` sends a sentence and `details`. History keeps
// the same text, and of `details` only what the gateway's chat display
// projection keeps (`projectToolResultDetails`): `exitCode`, `durationMs`,
// `cwd`, `sessionKey`, `ok`, `changed`, `created` and `diff`. Every case is
// read three ways: from the live step, from a history block alone, and from
// a history block with the step history rebuilt. All three must agree, and
// the outcome must be the one the result establishes. Invented content only.

import { describe, expect, it } from "vitest";
import {
  callFromBlock,
  callFromStep,
  lineOf,
  mapHistory,
  projectArgs,
  projectDetails,
  RawTable,
  runsFromHistory,
} from "../src/index.ts";
import type { Run, Step } from "../src/runs.ts";

type Rec = Record<string, unknown>;
type Case = {
  name: string;
  tool: string;
  args: Rec;
  /** The result's text, as sent and as history keeps it. */
  text: string;
  /** The result's `details`, live. */
  details: Rec | null;
  isError?: boolean;
  outcome: string;
};

const json = (payload: Rec) => JSON.stringify(payload, null, 2);
const jsonCase = (name: string, tool: string, args: Rec, payload: Rec, outcome: string): Case => ({
  name,
  tool,
  args,
  text: json(payload),
  details: payload,
  outcome,
});

/** The detail keys the gateway's history keeps (`projectToolResultDetails`). */
const HISTORY_KEEPS = [
  "exitCode",
  "durationMs",
  "cwd",
  "sessionKey",
  "ok",
  "changed",
  "created",
  "diff",
];
const kept = (details: Rec | null): Rec | null => {
  if (!details) return null;
  const out: Rec = {};
  for (const key of HISTORY_KEEPS) if (key in details) out[key] = details[key];
  return Object.keys(out).length ? out : null;
};

const NO_CONTENTS =
  "Read did not return file contents because it detected a binary document [application/pdf]. Use an available document parser or converter, or convert the file to text, Markdown, or CSV, then read the converted file.";
const FETCHED = {
  url: "https://source.example/guide",
  finalUrl: "https://source.example/guide",
  contentType: "text/plain",
  status: 200,
  extractMode: "markdown",
  extractor: "raw",
  externalContent: { untrusted: true, source: "web_fetch", wrapped: true },
  length: 10,
  fetchedAt: "2026-11-17T00:00:00Z",
  tookMs: 40,
  text: "Page excerpt",
};
const DIFF = "--- a/notes.md\n+++ b/notes.md\n@@ -0,0 +1 @@\n+Trail";

const CASES: Case[] = [
  // 1 read
  {
    name: "read: content",
    tool: "read",
    args: { path: "notes.md" },
    text: "Trail note",
    details: { kind: "file", content: "Trail note" },
    outcome: "done",
  },
  {
    name: "read: binary document",
    tool: "read",
    args: { path: "report.pdf" },
    text: NO_CONTENTS,
    details: { kind: "text", content: NO_CONTENTS },
    outcome: "unavailable",
  },
  {
    name: "read: no readable text",
    tool: "read",
    args: { path: "blob.bin" },
    text: "File contains no readable text (512 bytes).",
    details: { kind: "text" },
    outcome: "unavailable",
  },
  {
    name: "read: past the end",
    tool: "read",
    args: { path: "notes.md", offset: 90 },
    text: "Offset 90 is beyond end of file (12 lines total). Retry with offset <= 12.",
    details: { kind: "text" },
    outcome: "unavailable",
  },
  {
    name: "read: optional file absent",
    tool: "read",
    args: { path: "maybe.md", optional: true },
    text: "Optional file not found: maybe.md.",
    details: { kind: "not_found", status: "not_found", path: "maybe.md", optional: true },
    outcome: "notfound",
  },
  {
    name: "read: error",
    tool: "read",
    args: { path: "gone.md" },
    text: "ENOENT: no such file",
    details: null,
    isError: true,
    outcome: "failed",
  },
  // 2 ls
  {
    name: "ls: listing",
    tool: "ls",
    args: { path: "." },
    text: "notes.md\nlogs/",
    details: { content: "notes.md\nlogs/" },
    outcome: "done",
  },
  // 3, 4 edit and memory
  {
    name: "write: created",
    tool: "write",
    args: { path: "notes.md", content: "Trail" },
    text: "Successfully wrote 5 bytes to notes.md",
    details: { changed: true, created: true, diff: DIFF },
    outcome: "done",
  },
  {
    name: "edit: unchanged",
    tool: "edit",
    args: { path: "notes.md", edits: [] },
    text: "No changes made to notes.md",
    details: { changed: false },
    outcome: "unchanged",
  },
  {
    name: "memory: saved",
    tool: "write",
    args: { path: "memory/2026-11-17.md", content: "Trail" },
    text: "Successfully wrote 5 bytes to memory/2026-11-17.md",
    details: { changed: true, created: true, diff: DIFF },
    outcome: "done",
  },
  {
    name: "patch: no words",
    tool: "apply_patch",
    args: { input: "*** Update File: notes.md" },
    text: "",
    details: null,
    outcome: "made",
  },
  // 5 memory look-ups
  jsonCase(
    "memory_search: results",
    "memory_search",
    { query: "trail" },
    { results: [{ path: "memory/a.md" }] },
    "done",
  ),
  jsonCase(
    "memory_search: partial",
    "memory_search",
    { query: "trail" },
    { results: [], partial: true },
    "partial",
  ),
  jsonCase(
    "memory_search: disabled",
    "memory_search",
    { query: "trail" },
    { results: [], disabled: true, warning: "Memory search is off." },
    "unavailable",
  ),
  jsonCase(
    "memory_get: not found",
    "memory_get",
    { path: "a.md" },
    { status: "not_found", path: "a.md", text: "" },
    "notfound",
  ),
  jsonCase(
    "memory_get: error",
    "memory_get",
    { path: "a.md" },
    { status: "error", error: "read failed", text: "" },
    "failed",
  ),
  jsonCase(
    "memory_get: forbidden",
    "memory_get",
    { path: "a.md" },
    { status: "forbidden", error: "Not allowed" },
    "refused",
  ),
  // 6 commands
  {
    name: "exec: exit 0",
    tool: "exec",
    args: { command: "echo trail" },
    text: "trail",
    details: { status: "completed", exitCode: 0, durationMs: 40, cwd: "/workspace/bot" },
    outcome: "done",
  },
  {
    name: "exec: exit 1",
    tool: "exec",
    args: { command: "grep -c x notes.md" },
    text: "0",
    details: { status: "completed", exitCode: 1, durationMs: 40 },
    outcome: "done",
  },
  {
    name: "exec: approval pending",
    tool: "exec",
    args: { command: "mv a b" },
    text: "Approval required (id ab12, full ab12-cd34).\nHost: gateway\nCWD: /workspace/bot\nCommand:\n```sh\nmv a b\n```",
    details: { status: "approval-pending", approvalId: "ab12-cd34" },
    outcome: "waiting",
  },
  {
    name: "exec: timed out",
    tool: "exec",
    args: { command: "rsync a b", timeoutSeconds: 120 },
    text: "Command timed out after 120 seconds.",
    details: { status: "failed", timedOut: true },
    isError: true,
    outcome: "failed",
  },
  {
    name: "exec: denied",
    tool: "exec",
    args: { command: "rm a" },
    text: "Exec denied (gateway id=ab12, user-denied): rm a",
    details: null,
    isError: true,
    outcome: "denied",
  },
  // 8, 9, 10 web
  jsonCase(
    "web_search: results",
    "web_search",
    { query: "trail" },
    { query: "trail", count: 1, results: [{ title: "Trail", url: "https://search.example/t" }] },
    "done",
  ),
  jsonCase(
    "web_search: unavailable",
    "web_search",
    { query: "trail" },
    { error: "missing_brave_api_key", message: "Search needs a key." },
    "unavailable",
  ),
  jsonCase(
    "x_search: unavailable",
    "x_search",
    { query: "trail" },
    { error: "missing_xai_api_key", message: "x_search needs xAI credentials." },
    "unavailable",
  ),
  jsonCase(
    "web_fetch: whole page",
    "web_fetch",
    { url: FETCHED.url },
    { ...FETCHED, truncated: false, rawLength: 10 },
    "done",
  ),
  jsonCase(
    "web_fetch: cut page",
    "web_fetch",
    { url: FETCHED.url },
    { ...FETCHED, truncated: true, rawLength: 2000 },
    "partial",
  ),
  // 12 computer: its act's result is its text, and its details' `result`
  {
    name: "computer: confirmed",
    tool: "computer",
    args: { action: "left_click" },
    text: json({ action: "left_click", ok: true, effect: "confirmed" }),
    details: { action: "left_click", result: { ok: true, effect: "confirmed" } },
    outcome: "done",
  },
  {
    name: "computer: not confirmed",
    tool: "computer",
    args: { action: "left_click" },
    text: json({ action: "left_click", ok: true, effect: "unverifiable" }),
    details: { action: "left_click", result: { ok: true, effect: "unverifiable" } },
    outcome: "unconfirmed",
  },
  {
    name: "computer: failed act",
    tool: "computer",
    args: { action: "left_click" },
    text: json({ action: "left_click", ok: false }),
    details: { action: "left_click", result: { ok: false } },
    outcome: "failed",
  },
  // 13 phone
  jsonCase(
    "mobile_ui: needs confirmation",
    "mobile_ui",
    { action: "act", mobileAction: { type: "tap" } },
    { code: "confirmation_required", package: "app", target: "Pay", proposedEffect: "pays" },
    "refused",
  ),
  jsonCase(
    "mobile_ui: observed",
    "mobile_ui",
    { action: "observe" },
    { snapshotId: "s1", package: "app" },
    "done",
  ),
  // 15 routines
  jsonCase(
    "automations: added",
    "automations",
    { action: "add", job: { name: "Cleanup" } },
    { id: "job-1", name: "Cleanup" },
    "done",
  ),
  jsonCase(
    "automations: queued run",
    "automations",
    { action: "run", id: "job-1" },
    { enqueued: true },
    "queued",
  ),
  jsonCase(
    "automations: nothing to remove",
    "automations",
    { action: "remove", id: "job-1" },
    { removed: false },
    "notfound",
  ),
  // 17 tasks
  jsonCase(
    "sessions_history: forbidden",
    "sessions_history",
    { sessionKey: "agent:marlow:main" },
    { status: "forbidden", error: "Visibility restricted" },
    "refused",
  ),
  jsonCase(
    "sessions_list: listed",
    "sessions_list",
    { limit: 5 },
    { count: 2, sessions: [{}, {}] },
    "done",
  ),
  // 18 helpers
  jsonCase(
    "sessions_spawn: accepted",
    "sessions_spawn",
    { task: "Price check" },
    { status: "accepted", childSessionKey: "agent:otto:sub" },
    "started",
  ),
  jsonCase(
    "sessions_spawn: forbidden",
    "sessions_spawn",
    { task: "Price check" },
    { status: "forbidden", error: "Not allowed" },
    "refused",
  ),
  // 19 question: words, then its JSON
  {
    name: "ask_user: answered",
    tool: "ask_user",
    args: { questions: [{ question: "Which route?" }] },
    text: `Route: Lake loop\n\n${json({ status: "answered", answers: { route: ["Lake loop"] } })}`,
    details: { status: "answered", answers: { route: ["Lake loop"] } },
    outcome: "done",
  },
  {
    name: "ask_user: no answer",
    tool: "ask_user",
    args: { questions: [{ question: "Which route?" }] },
    text: json({ status: "no_answer" }),
    details: { status: "no_answer" },
    outcome: "made",
  },
  // 20 plan and goal: the card's words, then its JSON, joined
  {
    name: "progress_card: first",
    tool: "progress_card",
    args: { plan: [{ step: "a", status: "pending" }] },
    text: `Progress card updated (rev 1, 0/1 done)${json({ revision: 1, steps: { completed: 0, total: 1 } })}`,
    details: { revision: 1, steps: { completed: 0, total: 1 } },
    outcome: "done",
  },
  {
    name: "progress_card: cleared",
    tool: "progress_card",
    args: {},
    text: `Progress card cleared${json({ revision: null, steps: null })}`,
    details: { revision: null, steps: null },
    outcome: "done",
  },
  jsonCase(
    "update_goal: refused transition",
    "update_goal",
    { status: "complete" },
    { status: "error", error: "No active goal requires a status change." },
    "failed",
  ),
  // 21 media
  {
    name: "image_generate: made",
    tool: "image_generate",
    args: { action: "generate", prompt: "A house" },
    text: "Generated 2 images with acme/pic-1.\nMEDIA: out/a.png\nMEDIA: out/b.png",
    details: { paths: ["out/a.png", "out/b.png"] },
    outcome: "done",
  },
  {
    name: "image_generate: started",
    tool: "image_generate",
    args: { action: "generate", prompt: "A house" },
    text: "Background task started for image generation (task-1). Do not call image_generate again for this request.",
    details: { async: true, status: "started", taskId: "task-1" },
    outcome: "started",
  },
  {
    name: "image_generate: empty list",
    tool: "image_generate",
    args: { action: "generate", prompt: "A house" },
    text: "",
    details: { paths: [] },
    outcome: "made",
  },
  {
    name: "tts: spoken",
    tool: "tts",
    args: { text: "Hello" },
    text: "(spoken) Hello",
    details: { audioPath: "out/a.mp3", provider: "acme" },
    outcome: "done",
  },
  // 22 documents and images
  {
    name: "pdf: too many",
    tool: "pdf",
    args: { pdfs: Array(11).fill("a.pdf") },
    text: "Too many PDFs: 11 provided, maximum is 10. Please reduce the number.",
    details: { error: "too_many_pdfs", count: 11, max: 10 },
    outcome: "refused",
  },
  {
    name: "pdf: unsupported",
    tool: "pdf",
    args: { pdf: "ftp://a.example/a.pdf" },
    text: "Unsupported PDF reference: ftp://a.example/a.pdf. Use a file path, file:// URL, or http(s) URL.",
    details: { error: "unsupported_pdf_reference", pdf: "ftp://a.example/a.pdf" },
    outcome: "refused",
  },
  {
    name: "view_image: too many",
    tool: "view_image",
    args: { paths: Array(21).fill("a.png") },
    text: "Too many images: 21 provided, maximum is 20. Please reduce the number of images.",
    details: { error: "too_many_images", count: 21, max: 20 },
    outcome: "refused",
  },
  {
    name: "pdf: read",
    tool: "pdf",
    args: { pdf: "a.pdf" },
    text: "The report covers two sites.",
    details: { model: "acme/doc" },
    outcome: "done",
  },
  // 23 channels
  jsonCase(
    "conversations_send: sent",
    "conversations_send",
    { conversationRef: "c1", message: "Hi" },
    { status: "sent", channel: "telegram" },
    "done",
  ),
  jsonCase(
    "conversations_send: queued",
    "conversations_send",
    { conversationRef: "c1", message: "Hi" },
    { status: "queued", channel: "telegram" },
    "queued",
  ),
  jsonCase(
    "conversations_send: suppressed",
    "conversations_send",
    { conversationRef: "c1", message: "Hi" },
    { status: "suppressed" },
    "suppressed",
  ),
  // 24 a tool server: its text is the server's output, never read as the gateway's payload
  {
    name: "server: JSON output",
    tool: "coder__slow_task",
    args: { seconds: 8 },
    text: JSON.stringify({ status: "done", seconds: 8 }),
    details: {
      mcpServer: "coder",
      mcpTool: "slow_task",
      structuredContent: { status: "done", seconds: 8 },
    },
    outcome: "done",
  },
  {
    name: "server: empty output",
    tool: "coder__slow_task",
    args: { seconds: 8 },
    text: "",
    details: { mcpServer: "coder", mcpTool: "slow_task" },
    outcome: "made",
  },
  // 24 a call the gateway blocked before launch: its details are not kept, its words are
  {
    name: "server: blocked at admission",
    tool: "coder__send_message",
    args: { message: "Hi" },
    text: "Tool execution was blocked before launch.",
    details: { status: "blocked", deniedReason: "tool-admission" },
    outcome: "blocked",
  },
  // 26 any other tool
  jsonCase("general: ok", "skills_search", { query: "invoice" }, { ok: true, results: [] }, "done"),
  jsonCase(
    "general: unrecognized",
    "skills_search",
    { query: "invoice" },
    { requestId: "r1" },
    "made",
  ),
  jsonCase(
    "general: nested failure",
    "skills_search",
    { query: "invoice" },
    { status: "redirect", result: { ok: false } },
    "failed",
  ),
];

const RUN = { state: "completed", error: null, ending: null, origin: "gateway" } as unknown as Run;

function step(c: Case, details: Rec | null, history = false): Step {
  return {
    id: `tool:${c.name}`,
    kind: "tool",
    title: c.tool,
    toolName: c.tool,
    toolCallId: c.name,
    status: c.isError ? "failed" : "done",
    startedAt: 1_000,
    endedAt: 1_400,
    argsText: null,
    output: null,
    result: { text: c.text, totalChars: c.text.length },
    error: c.isError ? c.text : null,
    approvalId: null,
    failureKind: null,
    truncated: false,
    replaceable: false,
    correction: 0,
    continuation: null,
    raw: null,
    rawSize: null,
    args: projectArgs(c.args),
    details: projectDetails(details),
    ...(c.tool === "exec" ? { commandBearing: true } : {}),
    ...(history ? { rowTimes: true } : {}),
  } as Step;
}

/** The line without its duration, which history does not report. */
const said = (spoken: string) =>
  spoken.replace(/, [0-9.]+ seconds?(?=$|,)/, "").replace(/, done$/, "");

/** The case as `chat.history` returns it: the call's row and its result's row, details as kept. */
function historyOf(c: Case) {
  const rows = [
    { role: "user", content: "Go.", timestamp: 1_000, __openclaw: { id: "u1" } },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: c.name, name: c.tool, arguments: c.args }],
      timestamp: 2_000,
      __openclaw: { id: "a1", runId: "run-h" },
    },
    {
      role: "toolResult",
      toolCallId: c.name,
      toolName: c.tool,
      content: [{ type: "text", text: c.text }],
      isError: c.isError === true,
      ...(kept(c.details) ? { details: kept(c.details) } : {}),
      timestamp: 2_400,
      __openclaw: { id: "r1", runId: "run-h" },
    },
  ];
  const ctx = { sessionKey: "agent:otto:disk-space", now: 5_000, raw: new RawTable() };
  const block = mapHistory(rows)
    .flatMap((item) => item.blocks)
    .find((each) => each.kind === "tool-call")!;
  const run = runsFromHistory(rows, null, ctx)[0]!;
  return {
    block: block as Extract<typeof block, { kind: "tool-call" }>,
    step: run.steps.find((each) => each.toolCallId === c.name)!,
    run,
  };
}

describe("every kind's outcome is the same live and from history", () => {
  for (const c of CASES) {
    it(`${c.name}: ${c.outcome}`, () => {
      // What the app reads every call with: the gateway's name map for tool-server tools
      // (`tools.effective`), which a reload needs since history keeps no `mcpServer`.
      const ctx = { toolServers: { coder__slow_task: { server: "coder", tool: "slow_task" } } };
      const live = lineOf(callFromStep(step(c, c.details, false), RUN), ctx);
      const history = historyOf(c);
      // History with the engine's step, and history's block alone (the step not kept).
      const rebuilt = lineOf(callFromBlock(history.block, history.step, history.run), ctx);
      const alone = lineOf(callFromBlock(history.block, undefined, undefined), ctx);
      expect(live.outcome).toBe(c.outcome);
      expect(rebuilt.outcome).toBe(c.outcome);
      expect(alone.outcome).toBe(c.outcome);
      // The same words, the duration aside.
      expect(said(rebuilt.spoken)).toBe(said(live.spoken));
      expect(said(alone.spoken)).toBe(said(live.spoken));
    });
  }
});
