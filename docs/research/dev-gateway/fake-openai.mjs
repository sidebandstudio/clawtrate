#!/usr/bin/env node
// Scripted fake model provider for an OpenClaw development gateway.
// Speaks the OpenAI Chat Completions streaming API on loopback.
// No network access, no credentials. Node >= 22, no dependencies.
//
// Behaviour, decided from the last message of each request:
//   last message is a tool result  -> stream "Tool <name> returned: <result>"
//   user text "#tool <name> <json>" -> stream reasoning, then one tool call
//   user text "#ask <sessionKey> <message>" -> sessions_send tool call
//   user text "#slow <seconds> <text>" -> stream text slowly (abort, steer)
//   anything else                   -> stream reasoning, then "Echo: <text>"
//
// Usage: node fake-openai.mjs [--port 19102] [--log /path/requests.jsonl]

import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(argValue("--port", "19102"));
const logPath = argValue("--log", "");
const MODEL_ID = "scripted";

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .join("");
  }
  return "";
};

// OpenClaw wraps user text in an envelope: a "[timestamp] Conversation info"
// block with a JSON fence before the text and a "Runtime: ..." line after it.
// Use the last line that carries one of our directives, else the last line of
// the user's own text.
const ENVELOPE = /^(Runtime:|\[.*\] Conversation info|```|\{"sender")/;
const userIntent = (text) => {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !ENVELOPE.test(l))
    // The first turn of sessions.create keeps the timestamp on the text line.
    .map((l) => l.replace(/^\[[^\]]*\]\s*/, ""));
  const directive = [...lines].reverse().find((l) => l.startsWith("#tool ") || l.startsWith("#ask "));
  return directive ?? lines.at(-1) ?? "";
};

function plan(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = messages.at(-1) ?? {};
  if (last.role === "tool") {
    const call = messages
      .flatMap((m) => m.tool_calls ?? [])
      .find((c) => c.id === last.tool_call_id);
    const name = call?.function?.name ?? "tool";
    const result = textOf(last.content).slice(0, 400);
    return { reasoning: `The ${name} call finished.`, text: `Tool ${name} returned: ${result}` };
  }
  // Utility calls (session activity recaps, titles) carry no tools and a JSON
  // body; answer briefly so recaps do not grow by echoing themselves.
  if (!body.tools?.length && textOf(last.content).startsWith('{"previousRecap"')) {
    return { text: "Working on the latest request." };
  }
  // Inter-session turns (sessions_send) append a separate "OpenClaw runtime
  // context:" user message after the real one; skip those.
  const trailingUser = [];
  for (let i = messages.length - 1; i >= 0 && messages[i].role === "user"; i--) trailingUser.unshift(messages[i]);
  const own = trailingUser.filter((m) => !textOf(m.content).startsWith("OpenClaw runtime context:")).at(-1) ?? last;
  const intent = userIntent(textOf(own.content));
  const tool = intent.match(/^#tool\s+(\S+)\s*(.*)$/s);
  if (tool) {
    return {
      reasoning: `I should call ${tool[1]}.`,
      toolCall: { name: tool[1], arguments: tool[2] || "{}" },
    };
  }
  const ask = intent.match(/^#ask\s+(\S+)\s+(.+)$/s);
  if (ask) {
    return {
      reasoning: `I will message ${ask[1]}.`,
      toolCall: {
        name: "sessions_send",
        arguments: JSON.stringify({ sessionKey: ask[1], message: ask[2], timeoutSeconds: 60 }),
      },
    };
  }
  const slow = intent.match(/^#slow\s+(\d+)\s*(.*)$/s);
  if (slow) {
    // Stream for roughly <seconds>, for abort and steer tests.
    const words = Array.from({ length: Number(slow[1]) * 4 }, (_, i) => `word${i + 1} `).join("");
    return { reasoning: "Taking my time.", text: `${slow[2]} ${words}`, delayMs: 250 };
  }
  return { reasoning: `The user said: ${intent.slice(0, 80)}`, text: `Echo: ${intent}` };
}

const chunks = (s, n = 12) => s.match(new RegExp(`[\\s\\S]{1,${n}}`, "g")) ?? [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stream(res, p) {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const send = (delta, finish = null, extra = {}) =>
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: MODEL_ID,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...extra,
      })}\n\n`,
    );
  send({ role: "assistant" });
  for (const piece of chunks(p.reasoning ?? "")) {
    send({ reasoning_content: piece });
    await sleep(20);
  }
  if (p.toolCall) {
    const callId = `call_${Math.random().toString(36).slice(2, 14)}`;
    send({
      tool_calls: [{ index: 0, id: callId, type: "function", function: { name: p.toolCall.name, arguments: "" } }],
    });
    for (const piece of chunks(p.toolCall.arguments, 24)) {
      send({ tool_calls: [{ index: 0, function: { arguments: piece } }] });
      await sleep(10);
    }
    send({}, "tool_calls");
  } else {
    for (const piece of chunks(p.text ?? "")) {
      if (res.destroyed) return;
      send({ content: piece });
      await sleep(p.delayMs ?? 20);
    }
    send({}, "stop");
  }
  res.write(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: MODEL_ID,
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model", owned_by: "fake" }] }));
    return;
  }
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const p = plan(body);
    if (logPath) {
      appendFileSync(
        logPath,
        JSON.stringify({
          at: new Date().toISOString(),
          tools: (body.tools ?? []).map((t) => t.function?.name),
          last: body.messages?.at(-1),
          plan: p,
        }) + "\n",
      );
    }
    if (body.stream === false) {
      const message = p.toolCall
        ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: p.toolCall }] }
        : { role: "assistant", content: p.text };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          model: MODEL_ID,
          choices: [{ index: 0, message, finish_reason: p.toolCall ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    await stream(res, p);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake-openai listening on http://127.0.0.1:${port}/v1`);
});
