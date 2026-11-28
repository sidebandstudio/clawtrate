// A stand-in for an external coding agent that a bot calls over MCP. The
// development gateway runs it as a stdio command server named `coder` (see
// `devConfig`). It speaks newline-delimited JSON-RPC on stdin and stdout, keeps
// its threads in memory, makes no network request and writes no file. Links it
// returns use the reserved `.example` domain, so they never resolve.
//
// Tools, as the model sees them (`coder__<tool>`):
//   send_message { message, threadId?, delaySeconds? } -> { threadId, reply, url }
//   run_checks   { threadId? }                          -> an MCP error result
//   slow_task    { seconds }                            -> { status: "done", seconds }
//   long_output  { lines }                              -> many numbered lines of text
//   received_notifications {}                           -> notifications the gateway sent
//   show_board   {}                                     -> an MCP App: the board at BOARD_URI

import { createInterface } from "node:readline";

export const CODING_AGENT_SERVER = "coder";
export const THREAD_URL_BASE = "https://coding-agent.example/threads/";
/** The text send_message returns beside its structured content. */
export const SEND_MESSAGE_TEXT = "Opened a branch and drafted the change.";
/** The App resource show_board names: a page with no script and no outside address. */
export const BOARD_URI = "ui://coder/board";
const BOARD_HTML =
  '<!doctype html><meta charset="utf-8"><title>Board</title><h1>Coding board</h1><p>Two threads open.</p>';

type JsonRpcMessage = { id?: number | string; method?: string; params?: Record<string, unknown> };
type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

export const TOOLS = [
  {
    name: "send_message",
    description: "Send a message to a coding thread and return the agent's reply with a link.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
        threadId: { type: "string" },
        delaySeconds: { type: "number", description: "Wait this long before replying (0-600)." },
      },
      required: ["message"],
    },
  },
  {
    name: "run_checks",
    description: "Run the thread's checks. The stand-in always reports a failure.",
    inputSchema: { type: "object", properties: { threadId: { type: "string" } } },
  },
  {
    name: "slow_task",
    description: "Wait the given number of seconds (0-3600), then report done.",
    inputSchema: {
      type: "object",
      properties: { seconds: { type: "number" } },
      required: ["seconds"],
    },
  },
  {
    name: "long_output",
    description: "Return the given number of numbered lines (1-20000).",
    inputSchema: {
      type: "object",
      properties: { lines: { type: "number" } },
      required: ["lines"],
    },
  },
  {
    name: "received_notifications",
    description: "List the notifications this server has received, such as cancellations.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "show_board",
    description: "Show the coding board as an interactive app.",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { resourceUri: BOARD_URI } },
  },
];

const json = (value: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});

export function createCodingAgent() {
  const threads = new Map<string, string[]>();
  const notifications: { method: string; params?: unknown }[] = [];
  const timers = new Set<NodeJS.Timeout>();

  const later = (seconds: number, result: () => ToolResult): Promise<ToolResult> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve(result());
      }, seconds * 1000);
      timers.add(timer);
    });

  async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (name === "send_message") {
      const message = String(args.message ?? "");
      const threadId =
        typeof args.threadId === "string" && args.threadId
          ? args.threadId
          : `thread-${threads.size + 1}`;
      const log = threads.get(threadId) ?? [];
      log.push(message);
      threads.set(threadId, log);
      const out = {
        threadId,
        reply: `Opened a branch and drafted the change for: ${message.slice(0, 200)}`,
        url: `${THREAD_URL_BASE}${threadId}`,
      };
      // A sentence of its own beside the structured reply, as a real agent
      // would send; other tools repeat their structured content as text.
      const result: ToolResult = {
        content: [{ type: "text", text: SEND_MESSAGE_TEXT }],
        structuredContent: out,
      };
      const delay = clamp(args.delaySeconds, 0, 600, 0);
      return delay > 0 ? later(delay, () => result) : result;
    }
    if (name === "run_checks") {
      return {
        content: [
          { type: "text", text: "Checks failed: 2 of 14 tests failed in the stand-in suite." },
        ],
        isError: true,
      };
    }
    if (name === "slow_task") {
      const seconds = clamp(args.seconds, 0, 3600, 0);
      return later(seconds, () => json({ status: "done", seconds }));
    }
    if (name === "long_output") {
      const lines = clamp(args.lines, 1, 20_000, 1);
      const text = Array.from({ length: lines }, (_, i) => `line ${i + 1} of ${lines}`).join("\n");
      return { content: [{ type: "text", text }] };
    }
    if (name === "received_notifications") {
      return json({ notifications: notifications.slice(-20) });
    }
    if (name === "show_board") return json({ threads: threads.size });
    throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
  }

  /** Handle one message; returns the reply to write, or null for a notification. */
  async function handle(message: JsonRpcMessage): Promise<Record<string, unknown> | null> {
    const { id, method, params } = message;
    if (id === undefined) {
      notifications.push({ method: String(method), params });
      return null;
    }
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, text: string) => ({
      jsonrpc: "2.0",
      id,
      error: { code, message: text },
    });
    switch (method) {
      case "initialize":
        return reply({
          protocolVersion: (params?.protocolVersion as string | undefined) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "stand-in-coding-agent", version: "0.0.0" },
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call":
        try {
          const args = (params?.arguments as Record<string, unknown> | undefined) ?? {};
          return reply(await callTool(String(params?.name), args));
        } catch (error) {
          return fail((error as { code?: number }).code ?? -32603, (error as Error).message);
        }
      case "resources/list":
        return reply({ resources: [] });
      case "resources/read":
        return params?.uri === BOARD_URI
          ? reply({
              contents: [
                { uri: BOARD_URI, mimeType: "text/html;profile=mcp-app", text: BOARD_HTML },
              ],
            })
          : fail(-32002, `resource not found: ${String(params?.uri)}`);
      case "prompts/list":
        return reply({ prompts: [] });
      default:
        return fail(-32601, `method not found: ${String(method)}`);
    }
  }

  return {
    handle,
    close: () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

if (import.meta.main) {
  const agent = createCodingAgent();
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    void agent.handle(message).then((out) => {
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    });
  });
  lines.on("close", () => {
    agent.close();
    process.exit(0);
  });
}
