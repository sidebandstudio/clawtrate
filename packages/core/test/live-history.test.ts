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
  applyAgentEvent,
  emptyActivity,
  callFromBlock,
  callFromStep,
  lineOf,
  mapHistory,
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
  /**
   * The outcome from history, where it cannot be the live one: the gateway cut
   * the stored text, so what only the cut part said is not known (7.3).
   */
  history?: string;
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
/** A page as the installed `web_fetch` returns it, its fields in their order. */
const pageOf = (truncated: boolean, text: string) => ({
  url: "https://source.example/guide",
  finalUrl: "https://source.example/guide",
  status: 200,
  contentType: "text/plain",
  extractMode: "markdown",
  extractor: "raw",
  externalContent: { untrusted: true, source: "web_fetch", wrapped: true },
  truncated,
  length: text.length,
  rawLength: truncated ? 95000 : text.length,
  text,
  tookMs: 29,
});
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
  // More of the installed shapes, kind by kind (OpenClaw 2026.10.6 result builders).
  // read: its notes and notices
  {
    name: "read: after a resolved filename",
    tool: "read",
    args: { path: "Survey Report.md" },
    text: "[Resolved filename: Survey\u00a0Report.md -> Survey Report.md.]\nA route\nA map",
    details: { kind: "file" },
    outcome: "done",
  },
  {
    name: "read: binary after a resolved filename",
    tool: "read",
    args: { path: "Survey Report.pdf" },
    text: `[Resolved filename: Survey\u00a0Report.pdf -> Survey Report.pdf.]\n${NO_CONTENTS}`,
    details: { kind: "text" },
    outcome: "unavailable",
  },
  {
    name: "read: empty file",
    tool: "read",
    args: { path: "empty.md" },
    text: "File is empty (0 bytes).",
    details: { kind: "text" },
    outcome: "made",
  },
  {
    name: "read: blank lines",
    tool: "read",
    args: { path: "blank.md" },
    text: "File contains 2 blank lines.",
    details: { kind: "text" },
    outcome: "done",
  },
  {
    name: "read: image",
    tool: "read",
    args: { path: "chart.png" },
    text: "Read image file [image/png]",
    details: { kind: "image" },
    outcome: "done",
  },
  {
    name: "read: image omitted for the model",
    tool: "read",
    args: { path: "chart.png" },
    text: "Read image file [image/png]\n[Current model does not support images. The image will be omitted from this request.]",
    details: { kind: "text" },
    outcome: "unavailable",
  },
  {
    name: "read: the page asked for",
    tool: "read",
    args: { path: "notes.md", limit: 1 },
    text: "A route\n\n[2 more lines in file. Use offset=2 to continue.]",
    details: { kind: "truncated", content: "A route" },
    outcome: "done",
  },
  {
    name: "read: capped by lines",
    tool: "read",
    args: { path: "long.md" },
    text: "Line one\nLine two\n\n[Showing lines 1-1227 of 3300 (50KB limit). Use offset=1228 to continue.]",
    details: { kind: "truncated" },
    outcome: "partial",
  },
  {
    name: "read: capped by bytes",
    tool: "read",
    args: { path: "wide.md" },
    text: "aaaa\n\n[Read output capped at 50KB for this call. Use offset=1, cursor=51200 to continue.]",
    details: { kind: "truncated" },
    outcome: "partial",
  },
  {
    name: "read: long content, cut in history",
    tool: "read",
    args: { path: "long.md" },
    text: "An ordinary line of the document.\n".repeat(400),
    details: { kind: "file" },
    outcome: "done",
    history: "made",
  },
  {
    name: "read: long capped content, cut in history",
    tool: "read",
    args: { path: "long.md" },
    text: `${"An ordinary line of the document.\n".repeat(400)}\n[Showing lines 1-400 of 3400 (50KB limit). Use offset=401 to continue.]`,
    details: { kind: "truncated" },
    outcome: "partial",
    history: "made",
  },
  // read: longer than this app keeps of a step's text, whole in history (a workspace file)
  {
    name: "read: longer than the engine's copy, whole",
    tool: "read",
    args: { path: "AGENTS.md" },
    text: "A line of the workspace guide.\n".repeat(200),
    details: { kind: "file" },
    outcome: "done",
  },
  {
    name: "read: longer than the engine's copy, capped at its end",
    tool: "read",
    args: { path: "long.md" },
    text: `${"A line of the long file.\n".repeat(200)}\n[Showing lines 1-200 of 3400 (50KB limit). Use offset=201 to continue.]`,
    details: { kind: "truncated" },
    outcome: "partial",
  },
  // command: backgrounded
  {
    name: "exec: returned to the background",
    tool: "exec",
    args: { command: "printf trail" },
    text: "Command still running (session review, pid 42). Use process (list/poll/log/write/kill/clear/remove) for follow-up.",
    details: { status: "running", sessionId: "review", pid: 42 },
    outcome: "made",
  },
  // web: the gateway's normalized answers
  jsonCase(
    "web_search: answer",
    "web_search",
    { query: "trail" },
    { kind: "answer", provider: "p", query: "trail", content: "The trail is open.", citations: [] },
    "done",
  ),
  jsonCase(
    "web_search: truncated results",
    "web_search",
    { query: "trail" },
    {
      kind: "results",
      provider: "p",
      query: "trail",
      count: 10,
      results: Array.from({ length: 10 }, () => ({
        title: "A trail",
        url: "https://search.example/t",
      })),
      truncated: true,
    },
    "partial",
  ),
  jsonCase(
    "web_search: truncated answer",
    "web_search",
    { query: "trail" },
    {
      kind: "answer",
      provider: "p",
      query: "trail",
      content: "The trail is open.",
      citations: [],
      truncated: true,
    },
    "partial",
  ),
  jsonCase(
    "web_search: provider error",
    "web_search",
    { query: "trail" },
    { kind: "error", provider: "p", error: "provider_error", message: "provider unavailable" },
    "unavailable",
  ),
  jsonCase(
    "web_search: raw payload",
    "web_search",
    { query: "trail" },
    { kind: "raw", provider: "p", data: { note: "no contract" } },
    "made",
  ),
  // page: long, cut in history after its `truncated`
  jsonCase(
    "web_fetch: long cut page",
    "web_fetch",
    { url: FETCHED.url },
    pageOf(true, "Ordinary text explaining the trail. ".repeat(420)),
    "partial",
  ),
  jsonCase(
    "web_fetch: long whole page",
    "web_fetch",
    { url: FETCHED.url },
    pageOf(false, "Ordinary text explaining the trail. ".repeat(420)),
    "done",
  ),
  jsonCase(
    "web_fetch: no text",
    "web_fetch",
    { url: FETCHED.url },
    pageOf(false, ""),
    "unavailable",
  ),
  // recall: a large partial search, whose `partial` history cuts away
  {
    ...jsonCase(
      "memory_search: large partial",
      "memory_search",
      { query: "trail" },
      {
        results: Array.from({ length: 15 }, (_, i) => ({
          path: `memory/n-${i}.md`,
          snippet: "An ordinary hit. ".repeat(40),
        })),
        provider: "local",
        partial: true,
      },
      "partial",
    ),
    history: "made",
  },
  // routines
  jsonCase(
    "automations: did not run",
    "automations",
    { action: "run", jobId: "sample" },
    { ok: true, ran: false, reason: "invalid-spec" },
    "refused",
  ),
  jsonCase(
    "automations: run finished with an error",
    "automations",
    { action: "run", jobId: "sample" },
    {
      ok: true,
      enqueued: true,
      finished: true,
      run: { status: "error", error: "The job failed." },
    },
    "failed",
  ),
  jsonCase(
    "automations: run finished, no record",
    "automations",
    { action: "run", jobId: "sample" },
    {
      ok: true,
      enqueued: true,
      finished: true,
      runId: "r",
      note: "Finished, but its run history is not visible to this turn",
    },
    "made",
  ),
  jsonCase(
    "automations: run complete",
    "automations",
    { action: "run", jobId: "sample" },
    { ok: true, enqueued: true, finished: true, run: { status: "ok" } },
    "done",
  ),
  jsonCase(
    "automations: next check",
    "automations",
    { action: "next_check" },
    { ok: true, delayMs: 60000 },
    "done",
  ),
  // channels: sent is sent, whatever happened to the reply
  {
    ...jsonCase(
      "conversations_turn: sent, reply timed out",
      "conversations_turn",
      { conversationRef: "c1", message: "Hi" },
      {
        conversationRef: "c1",
        channel: "example",
        status: "timeout",
        messageId: "m1",
        correlationPersisted: true,
      },
      "made",
    ),
    isError: true,
  },
  {
    ...jsonCase(
      "conversations_turn: sent, correlation off",
      "conversations_turn",
      { conversationRef: "c1", message: "Hi" },
      {
        conversationRef: "c1",
        channel: "example",
        status: "sent",
        messageId: "m1",
        error:
          "Channel delivery did not preserve its prepared message id; reply correlation was disabled.",
      },
      "done",
    ),
    isError: true,
  },
  jsonCase(
    "conversations_turn: replied",
    "conversations_turn",
    { conversationRef: "c1", message: "Hi" },
    { conversationRef: "c1", channel: "example", status: "replied", reply: "Thanks" },
    "done",
  ),
  // tool servers
  {
    name: "server: plain text",
    tool: "coder__slow_task",
    args: { seconds: 3 },
    text: "This workspace allows the quick mode only.",
    details: { mcpServer: "coder", mcpTool: "slow_task" },
    outcome: "done",
  },
  {
    name: "server: image only",
    tool: "coder__slow_task",
    args: {},
    text: "",
    details: { mcpServer: "coder", mcpTool: "slow_task" },
    outcome: "made",
  },
  {
    name: "server: plugin veto, flagged",
    tool: "coder__slow_task",
    args: { seconds: 3 },
    text: "This workspace allows the quick mode only.",
    details: {
      status: "blocked",
      deniedReason: "plugin-before-tool-call",
      reason: "This workspace allows the quick mode only.",
    },
    isError: true,
    outcome: "blocked",
    history: "failed",
  },
  // the rest
  jsonCase(
    "ask_user: dismissed",
    "ask_user",
    { questions: [{ question: "Which route?" }] },
    { status: "dismissed" },
    "made",
  ),
  jsonCase(
    "create_goal: set",
    "create_goal",
    { objective: "Plan the trip" },
    { ok: true, goal: { objective: "Plan the trip" } },
    "done",
  ),
  jsonCase(
    "image_generate: models listed",
    "image_generate",
    { action: "list" },
    { providers: [{ id: "acme" }] },
    "done",
  ),
  {
    name: "computer: screenshot",
    tool: "computer",
    args: { action: "screenshot" },
    text: "screenshot 1280x800 (screen 0, frameId f1)",
    details: { action: "screenshot", width: 1280, height: 800 },
    outcome: "done",
  },
  jsonCase("subagents: listed", "subagents", { action: "list" }, { agents: [] }, "done"),
  {
    name: "view_image: looked",
    tool: "view_image",
    args: { path: "chart.png" },
    text: "A bar chart of monthly costs.",
    details: null,
    outcome: "done",
  },
];

/** The line without its duration, which history does not report. */
const said = (spoken: string) =>
  spoken.replace(/, [0-9.]+ seconds?(?=$|,)/, "").replace(/, done$/, "");

/** How the gateway stores a result's text in history: up to 8,000 characters, then cut and flagged. */
const HISTORY_TEXT_CHARS = 8000;

/** The live run's step for the case, through the engine's own events. */
function liveOf(c: Case): { step: Step; run: Run } {
  let activity = emptyActivity;
  let seq = 0;
  const ctx = { sessionKey: "agent:otto:disk-space", now: 5_000, raw: new RawTable() };
  const send = (stream: string, data: Rec) => {
    seq += 1;
    activity = applyAgentEvent(
      activity,
      { runId: "run-l", seq, stream, ts: 1_000 + seq * 300, sessionKey: ctx.sessionKey, data },
      ctx,
    ).activity;
  };
  send("lifecycle", { phase: "start", startedAt: 1_000 });
  send("tool", { phase: "start", name: c.tool, toolCallId: c.name, args: c.args });
  send("tool", {
    phase: "result",
    name: c.tool,
    toolCallId: c.name,
    isError: c.isError === true,
    result: {
      content: [{ type: "text", text: c.text }],
      ...(c.details ? { details: c.details } : {}),
    },
  });
  send("lifecycle", { phase: "end" });
  const run = activity.runs[0]!;
  return { step: run.steps.find((each) => each.toolCallId === c.name)!, run };
}

/**
 * The case as `chat.history` returns it: the call's row and its result's row,
 * details as kept. `gatewayCut` stores the text as the gateway does, cut and
 * flagged past its bound; without it the whole text reaches this app, which
 * cuts its block at its own bound.
 */
function historyOf(c: Case, gatewayCut = true) {
  const long = c.text.length > HISTORY_TEXT_CHARS;
  const cut = gatewayCut && long;
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
      content: [
        {
          type: "text",
          text: cut ? `${c.text.slice(0, HISTORY_TEXT_CHARS)}\n...(truncated)...` : c.text,
        },
      ],
      isError: c.isError === true,
      ...(kept(c.details) ? { details: kept(c.details) } : {}),
      timestamp: 2_400,
      __openclaw: { id: "r1", runId: "run-h", ...(cut ? { truncated: true } : {}) },
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
    it(`${c.name}: ${c.outcome}${c.history ? `, from history ${c.history}` : ""}`, () => {
      // What the app reads every call with: the gateway's name map for tool-server tools
      // (`tools.effective`), which a reload needs since history keeps no `mcpServer`.
      const ctx = { toolServers: { coder__slow_task: { server: "coder", tool: "slow_task" } } };
      const live = liveOf(c);
      const liveLine = lineOf(callFromStep(live.step, live.run), ctx);
      const history = historyOf(c);
      const whole = historyOf(c, false);
      // History with the engine's step; history's block alone (the step not kept); and the
      // block of a whole stored text, cut at this app's own bound.
      const readings = [
        lineOf(callFromBlock(history.block, history.step, history.run), ctx),
        lineOf(callFromBlock(history.block, undefined, undefined), ctx),
        lineOf(callFromBlock(whole.block, undefined, undefined), ctx),
      ];
      expect(liveLine.outcome).toBe(c.outcome);
      for (const reading of readings) {
        expect(reading.outcome).toBe(c.history ?? c.outcome);
        // The same words as live, the duration aside, where history can say what live said.
        // (A read's line count included: "200 lines" from the whole text, however it was kept.)
        if (!c.history) expect(said(reading.spoken)).toBe(said(liveLine.spoken));
        // Never more than live: a cut result is never Done from history when live was not.
        if (liveLine.outcome !== "done") expect(reading.outcome).not.toBe("done");
      }
    });
  }
});
