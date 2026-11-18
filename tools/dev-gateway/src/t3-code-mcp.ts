// A scripted stand-in for T3 Code's tool server, for the development gateway.
// It mirrors the seven tools an outside client uses in the installed T3 Code
// build 0.1.8-nightly.20261109.4433 (docs/research/provider-accounts-and-t3-code.md,
// part B): their names, argument names, result fields (nullable and optional
// ones included), thread identity and the read's two dimensions of paging. It
// is not T3 Code: it never connects to anything, keeps its threads in memory,
// writes no file and makes no network request. The gateway runs it as a stdio
// command server named `t3code` (see `devConfig`), on the instance's own
// machine, so nothing it does leaves loopback and it needs no port. Links use
// the reserved `.example` domain, so they never resolve.
//
// A check that passes against it shows the cards handle this contract; it does
// not show that a real T3 Code accepts them.
//
// Beside the seven, one ordinary tool of the same server, `T3_thread_read`,
// whose effective name (`t3code__T3_thread_read-2`, after the gateway's
// case-insensitive collision rule) suggests T3 Code's read but whose result
// names another tool: nothing may treat it as T3 Code.

import { createInterface } from "node:readline";

export const T3_CODE_SERVER = "t3code";
/** The installed T3 Code build this stand-in mirrors. */
export const T3_CODE_BUILD = "0.1.8-nightly.20261109.4433";
export const T3_LINK_BASE = "https://t3-code.example/threads/local/";
/** The ordinary tool beside the seven, and the name the gateway gives it. */
export const DECOY_TOOL = "T3_thread_read";
export const DECOY_EFFECTIVE = `${T3_CODE_SERVER}__${DECOY_TOOL}-2`;
/** T3 Code's default cut of an item's text (`maxCharsPerItem`). */
export const MAX_CHARS_PER_ITEM = 20_000;
/** A thread that exists before any launch, for a follow-up whose launch is not in the record. */
export const SEEDED_THREAD = "mcp:00000000-0000-4000-8000-000000000001";

type Rec = Record<string, unknown>;
type JsonRpcMessage = { id?: number | string; method?: string; params?: Rec };
type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Rec;
  isError?: boolean;
};

type RunStatus =
  | "preparing"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "interrupted"
  | "failed"
  | "cancelled"
  | "rolled_back";

type Item = {
  position: number;
  itemId: string;
  runId: string;
  messageId: string | null;
  type: "user_message" | "assistant_message" | "tool";
  status: "completed";
  title: string | null;
  text: string;
  updatedAt: string;
  visibility: "local";
  sourceThreadId: string;
  createdBy: "user" | "agent";
  creationSource: "mcp" | "provider";
};

type Run = {
  runId: string;
  ordinal: number;
  status: RunStatus;
  message: string;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Waits it takes before it completes: 2 for a run that first waits on its user. */
  waits: number;
  /** How long a wait takes before the run completes, in milliseconds. */
  workMs: number;
};

type Thread = {
  threadId: string;
  projectId: string;
  title: string;
  runs: Run[];
  items: Item[];
  queued: string[];
  clientRequestId: string | null;
};

const PROJECTS = [
  {
    id: "proj-backup-scripts",
    title: "backup-scripts",
    workspaceRoot: "/srv/stand-in/backup-scripts",
    defaultModelSelection: { instanceId: "codex", model: "stand-in-model" },
    scripts: [],
    createdAt: "2026-11-01T09:00:00.000Z",
    updatedAt: "2026-11-10T09:00:00.000Z",
    deletedAt: null,
  },
  {
    id: "proj-trail-guide",
    title: "trail-guide",
    workspaceRoot: "/srv/stand-in/trail-guide",
    defaultModelSelection: { instanceId: "claude", model: "stand-in-model" },
    scripts: [],
    createdAt: "2026-11-02T09:00:00.000Z",
    updatedAt: "2026-11-11T09:00:00.000Z",
    deletedAt: null,
  },
  {
    id: "proj-scratchpad",
    title: "scratchpad",
    workspaceRoot: "/srv/stand-in/scratchpad",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-11-03T09:00:00.000Z",
    updatedAt: "2026-11-12T09:00:00.000Z",
    deletedAt: null,
  },
];

const ENV = { environmentId: { type: "string" } };
const describe = (text: string) =>
  `${text} (Development stand-in mirroring T3 Code ${T3_CODE_BUILD}; not T3 Code.)`;

export const TOOLS = [
  {
    name: "t3_project_list",
    description: describe("List projects."),
    inputSchema: {
      type: "object",
      properties: { ...ENV, cursor: { type: "integer" }, limit: { type: "integer" } },
    },
  },
  {
    name: "t3_thread_launch",
    description: describe(
      "Create one new top-level thread. Task in `message`. Follow it with t3_thread_read or t3_thread_wait.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        ...ENV,
        projectId: { type: "string" },
        scratch: { type: "boolean" },
        title: { type: "string" },
        modelSelection: { type: "object" },
        runtimeMode: { type: "string" },
        interactionMode: { type: "string" },
        workspaceStrategy: { type: "object" },
        message: { type: "string" },
        attachments: { type: "array" },
        clientRequestId: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "t3_thread_send",
    description: describe(
      "Send a message to any thread. `mode:'auto'` starts an idle thread, steers a running turn, or queues.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        ...ENV,
        threadId: { type: "string" },
        message: { type: "string" },
        mode: { type: "string", enum: ["auto", "queue", "steer", "restart"] },
        freshContext: { type: "boolean" },
        clientRequestId: { type: "string" },
      },
      required: ["threadId", "message"],
    },
  },
  {
    name: "t3_thread_read",
    description: describe("Read a thread's state and a page of its items, oldest first."),
    inputSchema: {
      type: "object",
      properties: {
        ...ENV,
        threadId: { type: "string" },
        itemId: { type: "string" },
        textOffset: { type: "integer" },
        view: { type: "string" },
        afterPosition: { type: "integer" },
        limit: { type: "integer" },
        runLimit: { type: "integer" },
        maxCharsPerItem: { type: "integer" },
      },
      required: ["threadId"],
    },
  },
  {
    name: "t3_thread_wait",
    description: describe("Wait for a thread's run to finish. No `runId`: latest. Idle: at once."),
    inputSchema: {
      type: "object",
      properties: {
        ...ENV,
        threadId: { type: "string" },
        runId: { type: "string" },
        timeoutMs: { type: "integer" },
        untilDelegatedWorkSettled: { type: "boolean" },
      },
      required: ["threadId"],
    },
  },
  {
    name: "t3_thread_list",
    description: describe("List threads. Pass `projectId` or `allProjects: true`."),
    inputSchema: {
      type: "object",
      properties: {
        ...ENV,
        projectId: { type: "string" },
        allProjects: { type: "boolean" },
        statuses: { type: "array" },
        cursor: { type: "integer" },
        limit: { type: "integer" },
      },
    },
  },
  {
    name: "t3_thread_interrupt",
    description: describe("Interrupt a thread's run. `stop: true` acts as the Stop button."),
    inputSchema: {
      type: "object",
      properties: {
        ...ENV,
        threadId: { type: "string" },
        runId: { type: "string" },
        reason: { type: "string" },
        stop: { type: "boolean" },
        clientRequestId: { type: "string" },
      },
      required: ["threadId"],
    },
  },
  {
    name: DECOY_TOOL,
    description:
      "Read a thread's notes in the stand-in's own format. An ordinary tool of this server, not one of T3 Code's.",
    inputSchema: { type: "object", properties: { threadId: { type: "string" } } },
  },
];

const FAILURE_CODES = new Set([
  "capability_denied",
  "thread_not_found",
  "run_not_found",
  "thread_not_sendable",
  "thread_not_interruptible",
  "invalid_request",
  "target_required",
]);

/** A failure, as T3 Code returns one: a result flagged `isError`, with `{code, message}`. */
function failure(code: string, message: string): ToolResult {
  if (!FAILURE_CODES.has(code)) throw new Error(`unknown failure code ${code}`);
  const value = { _tag: "OrchestratorMcpFailure", code, message };
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: true };
}

/** A success: the structured result, and the same JSON as one text item. */
const ok = (value: Rec): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});

const FINAL: ReadonlySet<RunStatus> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

/** The reply a run writes, from its message: long when the message asks for a long one. */
export function replyFor(message: string): string {
  const head = `Done: ${message.slice(0, 160)}`;
  if (!/\blong\b/i.test(message)) return `${head}\nThe change is on the branch, with a test.`;
  const line = "The weekly check now skips machines that are asleep and records them in the log.";
  const lines: string[] = [head];
  for (let i = 1; lines.join("\n").length <= MAX_CHARS_PER_ITEM + 4_000; i += 1)
    lines.push(`${String(i).padStart(4, "0")} ${line}`);
  return lines.join("\n");
}

export function createT3Code(clock: () => number = Date.now) {
  const threads = new Map<string, Thread>();
  const timers = new Set<NodeJS.Timeout>();
  let next = 1;
  let positions = 0;
  const at = () => new Date(clock()).toISOString();
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  const item = (thread: Thread, run: Run, type: Item["type"], text: string, title: string | null) => {
    positions += 1;
    thread.items.push({
      position: thread.items.length,
      itemId: `item-${positions}`,
      runId: run.runId,
      messageId: type === "tool" ? null : `msg-${positions}`,
      type,
      status: "completed",
      title,
      text,
      updatedAt: at(),
      visibility: "local",
      sourceThreadId: thread.threadId,
      createdBy: type === "user_message" ? "user" : "agent",
      creationSource: type === "user_message" ? "mcp" : "provider",
    });
  };

  const startRun = (thread: Thread, message: string, status: RunStatus = "running"): Run => {
    const run: Run = {
      runId: `run-${thread.runs.length + 1}-${thread.threadId.slice(-4)}`,
      ordinal: thread.runs.length + 1,
      status,
      message,
      requestedAt: at(),
      startedAt: status === "running" ? at() : null,
      completedAt: null,
      waits: /\bask\b/i.test(message) ? 2 : 1,
      workMs: /\bslow\b/i.test(message) ? 6_000 : 0,
    };
    thread.runs.push(run);
    item(thread, run, "user_message", message, null);
    if (status === "running") item(thread, run, "tool", "Ran the project's checks.", "Checks");
    return run;
  };

  const finish = (thread: Thread, run: Run) => {
    run.status = /\bFAIL\b/.test(run.message) ? "failed" : "completed";
    run.completedAt = at();
    if (run.status === "completed") item(thread, run, "assistant_message", replyFor(run.message), null);
    // A queued message starts the next run.
    const queued = thread.queued.shift();
    if (queued !== undefined) startRun(thread, queued);
  };

  /** One wait's worth of work on the thread's latest run. */
  const tick = (thread: Thread, run: Run) => {
    if (FINAL.has(run.status)) return;
    run.waits -= 1;
    if (run.waits > 0) run.status = "waiting";
    else finish(thread, run);
  };

  const newThread = (projectId: string, title: string, id = `mcp:${uuid((next += 1))}`): Thread => {
    const thread: Thread = { threadId: id, projectId, title, runs: [], items: [], queued: [], clientRequestId: null };
    threads.set(id, thread);
    return thread;
  };

  // A thread from before any launch, with an earlier run whose reply is not the latest result.
  {
    const seeded = newThread("proj-backup-scripts", "Weekly check notes", SEEDED_THREAD);
    const first = startRun(seeded, "Summarize last week's backup check.");
    finish(seeded, first);
    const second = startRun(seeded, "List the machines the check skipped.");
    finish(seeded, second);
  }

  const latest = (thread: Thread) => thread.runs.at(-1) ?? null;
  /** A thread's status: its latest run's, or idle before any run. */
  const threadStatus = (thread: Thread): RunStatus | "idle" => latest(thread)?.status ?? "idle";
  const link = (thread: Thread) => `${T3_LINK_BASE}${encodeURIComponent(thread.threadId)}`;
  const active = (thread: Thread) => {
    const run = latest(thread);
    return run && !FINAL.has(run.status) ? run : null;
  };

  const later = (ms: number, result: () => ToolResult): Promise<ToolResult> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve(result());
      }, ms);
      timers.add(timer);
    });

  const refusals = (args: Rec): ToolResult | null => {
    // Unsupported inputs are refused, not ignored, so no check passes on behavior this stand-in lacks.
    if (args.environmentId !== undefined)
      return failure("invalid_request", "This stand-in does not support environmentId.");
    if (args.attachments !== undefined)
      return failure("invalid_request", "This stand-in does not support attachments.");
    if (args.interactionMode === "plan")
      return failure("invalid_request", "This stand-in does not support interactionMode plan.");
    return null;
  };

  const threadOf = (args: Rec): Thread | ToolResult => {
    const id = typeof args.threadId === "string" ? args.threadId : "";
    const thread = threads.get(id);
    return thread ?? failure("thread_not_found", `No thread ${id || "(none given)"}.`);
  };

  const threadRecord = (thread: Thread) => {
    const run = latest(thread);
    const live = active(thread);
    return {
      threadId: thread.threadId,
      projectId: thread.projectId,
      title: thread.title,
      link: link(thread),
      status: threadStatus(thread),
      latestRunId: run?.runId ?? null,
      activeRunId: live?.runId ?? null,
      providerInstanceId: "codex",
      model: "stand-in-model",
      runtimeMode: "auto-accept-edits",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      runCount: thread.runs.length,
      itemCount: thread.items.length,
      pendingRequestCount: 0,
      archived: false,
      settled: live === null,
    };
  };

  async function callTool(name: string, args: Rec): Promise<ToolResult> {
    if (name === DECOY_TOOL) {
      return ok({ notes: ["The stand-in keeps no notes."], threadId: String(args.threadId ?? "") });
    }
    const refused = refusals(args);
    if (refused) return refused;
    switch (name) {
      case "t3_project_list": {
        const limit = Math.min(100, Math.max(1, Number(args.limit ?? 100)));
        const cursor = Math.max(0, Number(args.cursor ?? 0));
        const page = PROJECTS.slice(cursor, cursor + limit);
        return ok({ projects: page, nextCursor: cursor + limit < PROJECTS.length ? cursor + limit : null });
      }
      case "t3_thread_launch": {
        const projectId = typeof args.projectId === "string" ? args.projectId : null;
        if (!projectId && args.scratch !== true)
          return failure("target_required", "Pass projectId or scratch: an outside launch needs a target.");
        const project = PROJECTS.find((each) => each.id === projectId);
        if (projectId && !project) return failure("invalid_request", "The project was not found.");
        const selection = (args.modelSelection ?? project?.defaultModelSelection ?? null) as Rec | null;
        if (!selection) return failure("invalid_request", "Pass modelSelection: the project has no default model");
        const request = typeof args.clientRequestId === "string" ? args.clientRequestId : null;
        const replay = request ? [...threads.values()].find((each) => each.clientRequestId === request) : undefined;
        const thread = replay ?? newThread(projectId ?? "scratch", String(args.title ?? "Untitled"));
        thread.clientRequestId = request;
        const message = typeof args.message === "string" && args.message ? args.message : null;
        const run = replay ? latest(thread) : message ? startRun(thread, message) : null;
        return ok({
          threadId: thread.threadId,
          link: link(thread),
          projectId: thread.projectId,
          modelSelection: {
            instanceId: String(selection.instanceId ?? selection.provider ?? "codex"),
            model: String(selection.model ?? "stand-in-model"),
          },
          runId: run?.runId ?? null,
          status: run?.status ?? null,
        });
      }
      case "t3_thread_send": {
        const thread = threadOf(args);
        if (!("threadId" in thread)) return thread;
        const message = String(args.message ?? "");
        const mode = typeof args.mode === "string" ? args.mode : "auto";
        const running = active(thread);
        let delivery: "started" | "queued" | "steered" | "restarted";
        let run: Run;
        if (mode === "steer" && !running)
          return failure("thread_not_sendable", "Nothing is running to steer: the thread is idle.");
        if (mode === "restart" && running) {
          running.status = "interrupted";
          running.completedAt = at();
          run = startRun(thread, message);
          delivery = "restarted";
        } else if (running && (mode === "queue" || args.freshContext === true)) {
          thread.queued.push(message);
          run = running;
          delivery = "queued";
        } else if (running) {
          // A steer joins the running turn: its reply will reflect the message.
          running.message = `${running.message}\n${message}`;
          item(thread, running, "user_message", message, null);
          run = running;
          delivery = "steered";
        } else {
          run = startRun(thread, message);
          delivery = "started";
        }
        return ok({
          threadId: thread.threadId,
          link: link(thread),
          messageId: thread.items.at(-1)?.messageId ?? null,
          runId: run.runId,
          status: run.status,
          delivery,
        });
      }
      case "t3_thread_read": {
        const thread = threadOf(args);
        if (!("threadId" in thread)) return thread;
        const max = Math.min(50_000, Math.max(1, Number(args.maxCharsPerItem ?? MAX_CHARS_PER_ITEM)));
        const shape = (each: Item, offset = 0) => {
          const rest = each.text.slice(offset);
          const cut = rest.length > max;
          return {
            ...each,
            text: cut ? rest.slice(0, max) : rest,
            textTruncated: cut,
            ...(cut ? { nextTextOffset: offset + max } : {}),
          };
        };
        let items: ReturnType<typeof shape>[];
        let nextPosition: number | null;
        let hasMore: boolean;
        if (typeof args.itemId === "string") {
          const found = thread.items.find((each) => each.itemId === args.itemId);
          if (!found) return failure("invalid_request", `No item ${args.itemId}.`);
          items = [shape(found, Math.max(0, Number(args.textOffset ?? 0)))];
          nextPosition = found.position;
          hasMore = found.position < thread.items.length - 1;
        } else {
          const after = Number(args.afterPosition ?? -1);
          const limit = Math.min(100, Math.max(1, Number(args.limit ?? 50)));
          const rest = thread.items.filter((each) => each.position > after);
          items = rest.slice(0, limit).map((each) => shape(each));
          nextPosition = items.at(-1)?.position ?? null;
          hasMore = rest.length > limit;
        }
        const runLimit = Math.min(50, Math.max(1, Number(args.runLimit ?? 10)));
        return ok({
          thread: threadRecord(thread),
          recentRuns: thread.runs.slice(-runLimit).map((run) => ({
            runId: run.runId,
            ordinal: run.ordinal,
            status: run.status,
            providerInstanceId: "codex",
            model: "stand-in-model",
            requestedAt: run.requestedAt,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
          })),
          items,
          nextPosition,
          hasMore,
        });
      }
      case "t3_thread_wait": {
        const thread = threadOf(args);
        if (!("threadId" in thread)) return thread;
        const run =
          typeof args.runId === "string" ? thread.runs.find((each) => each.runId === args.runId) : latest(thread);
        if (typeof args.runId === "string" && !run) return failure("run_not_found", `No run ${args.runId}.`);
        if (!run) return ok({ threadId: thread.threadId, runId: null, status: "idle", timedOut: false });
        const timeout = typeof args.timeoutMs === "number" ? Math.max(0, args.timeoutMs) : 30_000;
        const answer = (timedOut: boolean) =>
          ok({
            threadId: thread.threadId,
            runId: run.runId,
            status: run.status,
            timedOut,
            ...(args.untilDelegatedWorkSettled === true && !timedOut
              ? { resultRun: { runId: run.runId, status: run.status } }
              : {}),
          });
        if (FINAL.has(run.status)) return answer(false);
        if (timeout < Math.max(1_000, run.workMs)) return later(Math.min(timeout, 2_000), () => answer(true));
        return later(run.workMs, () => {
          tick(thread, run);
          return answer(false);
        });
      }
      case "t3_thread_list": {
        const projectId = typeof args.projectId === "string" ? args.projectId : null;
        if (!projectId && args.allProjects !== true)
          return failure("target_required", "Pass projectId or allProjects: true.");
        const listed = [...threads.values()].filter((each) => !projectId || each.projectId === projectId);
        return ok({
          projectId,
          currentThreadId: null,
          threads: listed.map((each) => {
            const record = threadRecord(each);
            return {
              threadId: each.threadId,
              projectId: each.projectId,
              title: each.title,
              link: record.link,
              status: record.status,
              latestRunId: record.latestRunId,
              providerInstanceId: "codex",
              model: "stand-in-model",
              runtimeMode: "auto-accept-edits",
              interactionMode: "default",
              settled: record.settled,
              parentThreadId: null,
              itemCount: each.items.length,
              createdAt: each.runs[0]?.requestedAt ?? at(),
              updatedAt: at(),
            };
          }),
          nextCursor: null,
          total: listed.length,
        });
      }
      case "t3_thread_interrupt": {
        const thread = threadOf(args);
        if (!("threadId" in thread)) return thread;
        const run = active(thread);
        if (args.stop === true) thread.queued.length = 0;
        if (!run) return ok({ threadId: thread.threadId, runId: latest(thread)?.runId ?? null, status: "no_active_run" });
        run.status = "interrupted";
        run.completedAt = at();
        return ok({ threadId: thread.threadId, runId: run.runId, status: "interrupt_requested" });
      }
      default:
        throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
    }
  }

  async function handle(message: JsonRpcMessage): Promise<Rec | null> {
    const { id, method, params } = message;
    if (id === undefined) return null;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
    switch (method) {
      case "initialize":
        return reply({
          protocolVersion: (params?.protocolVersion as string | undefined) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "T3 Code stand-in", version: T3_CODE_BUILD },
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call":
        try {
          const args = (params?.arguments as Rec | undefined) ?? {};
          return reply(await callTool(String(params?.name), args));
        } catch (error) {
          return fail((error as { code?: number }).code ?? -32603, (error as Error).message);
        }
      case "resources/list":
        return reply({ resources: [] });
      case "prompts/list":
        return reply({ prompts: [] });
      default:
        return fail(-32601, `method not found: ${String(method)}`);
    }
  }

  return {
    handle,
    callTool,
    close: () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

if (import.meta.main) {
  const server = createT3Code();
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    void server.handle(message).then((out) => {
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    });
  });
  lines.on("close", () => {
    server.close();
    process.exit(0);
  });
}
