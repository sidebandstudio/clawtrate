#!/usr/bin/env node
// Stand-in for a coding-agent app that exposes MCP tools and threads.
// Minimal MCP server over stdio (newline-delimited JSON-RPC), no dependencies.
// Tools: send_message({ threadId?, message }) -> { threadId, reply }
//        list_threads() -> { threads }

import { createInterface } from "node:readline";

const threads = new Map();
const tools = [
  {
    name: "send_message",
    description: "Send a message to a coding thread and return the agent's reply.",
    inputSchema: {
      type: "object",
      properties: { threadId: { type: "string" }, message: { type: "string" } },
      required: ["message"],
    },
  },
  {
    name: "list_threads",
    description: "List coding threads.",
    inputSchema: { type: "object", properties: {} },
  },
];

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-coding-agent", version: "0.0.1" },
    });
  }
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools });
  if (method === "tools/call") {
    const args = params?.arguments ?? {};
    if (params?.name === "list_threads") {
      const list = [...threads.entries()].map(([threadId, t]) => ({ threadId, messages: t.length }));
      return reply(id, { content: [{ type: "text", text: JSON.stringify({ threads: list }) }], structuredContent: { threads: list } });
    }
    if (params?.name === "send_message") {
      const threadId = args.threadId || `thread-${threads.size + 1}`;
      const log = threads.get(threadId) ?? [];
      log.push(String(args.message ?? ""));
      threads.set(threadId, log);
      const out = { threadId, reply: `Scripted coding agent received: ${String(args.message ?? "").slice(0, 200)}` };
      return reply(id, { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out });
    }
    return fail(id, -32602, `unknown tool ${params?.name}`);
  }
  if (method === "resources/list") return reply(id, { resources: [] });
  if (method === "prompts/list") return reply(id, { prompts: [] });
  fail(id, -32601, `method not found: ${method}`);
});
