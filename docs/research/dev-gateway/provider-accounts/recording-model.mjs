// A minimal OpenAI Chat Completions stand-in that records which account reached it.
// Research code for docs/research/provider-accounts-and-t3-code.md.
//
//   node recording-model.mjs --port <19200-19999> --label <name> --log <file.jsonl>
//
// Every POST /v1/chat/completions appends one JSON line to the log:
//   {t, label, port, auth, model, marker, serverTools}
// where `auth` is the Authorization header the gateway sent (a scripted
// placeholder key, never a real credential) and `marker` is the control word
// found in the last user message, if any. Prompt text is not logged: the
// gateway adds runtime context to it. `serverTools` lists the offered tool names
// that come from a tool server (they contain "__").
// The reply is one streamed sentence naming the label, so a transcript also
// shows which server answered.
//
// The last user text can ask for a failure, so error handling can be observed:
//   contains "FAIL401" -> HTTP 401 {"error":{"type":"authentication_error"}}
//   contains "FAIL402" -> HTTP 402 {"error":{"type":"insufficient_quota"}}
//   contains "FAIL429" -> HTTP 429 {"error":{"type":"rate_limit_exceeded"}}, retry-after 1
//   contains "SLOW"    -> succeeds after 4 seconds
// Anything else succeeds at once.
//
// One account can also be made to fail whatever the prompt says, so a run that
// moves to another account of the same provider can be told apart by its key:
//   POST /control {"failKeys": {"<scripted key>": 401 | 402 | 429}}
// replaces the set of failing keys ({} clears it). The key is the bearer value
// without "Bearer ". A request whose key is listed gets that status; the log
// line then has `marker: "key-<status>"`.
//
// It listens on 127.0.0.1 only, and only on a port in the named-instance range
// 19200-19999, so it cannot take the default instance's or a preview's port.

import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { port: { type: "string" }, label: { type: "string" }, log: { type: "string" } },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 19200 || port > 19999) {
  console.error("--port must be in 19200-19999 (named development instances only)");
  process.exit(2);
}
if (!values.label || !/^[a-z0-9-]{1,32}$/.test(values.label)) {
  console.error("--label must be 1-32 lowercase letters, digits or hyphens");
  process.exit(2);
}
if (!values.log) {
  console.error("--log is required");
  process.exit(2);
}
const label = values.label;
let failKeys = {};

const text = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => part?.text ?? "").join("")
      : "";

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/v1/models") {
    json(res, 200, { object: "list", data: [{ id: "dev-1", object: "model", owned_by: label }] });
    return;
  }
  if (req.method === "POST" && url.pathname === "/control") {
    try {
      const next = JSON.parse(await readBody(req)).failKeys ?? {};
      if (Object.values(next).some((status) => ![401, 402, 429].includes(status))) throw new Error("status");
      failKeys = next;
      json(res, 200, { failKeys });
    } catch {
      json(res, 400, { error: { message: "failKeys must map keys to 401, 402 or 429" } });
    }
    return;
  }
  if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    json(res, 404, { error: { message: "not found" } });
    return;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: { message: "invalid JSON" } });
    return;
  }
  const users = (body.messages ?? []).filter((m) => m.role === "user");
  const prompt = text(users.at(-1)?.content);
  const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const keyStatus = failKeys[key] ?? null;
  const promptMarker = ["FAIL401", "FAIL402", "FAIL429", "SLOW"].find((word) => prompt.includes(word)) ?? null;
  const marker = keyStatus ? `key-${keyStatus}` : promptMarker;
  appendFileSync(
    values.log,
    `${JSON.stringify({ t: Date.now(), label, port, auth: req.headers.authorization ?? null, model: body.model ?? null, marker, serverTools: (body.tools ?? []).map((t) => t.function?.name).filter((n) => typeof n === "string" && n.includes("__")) })}\n`,
  );
  if (marker === "SLOW") await new Promise((resolve) => setTimeout(resolve, 4000));
  const failure = keyStatus ?? { FAIL401: 401, FAIL402: 402, FAIL429: 429 }[marker] ?? null;
  if (failure === 429) {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
    res.end(JSON.stringify({ error: { message: "Rate limit reached (scripted)", type: "rate_limit_exceeded", code: "rate_limit_exceeded" } }));
    return;
  }
  if (failure === 401) {
    json(res, 401, { error: { message: "Invalid API key (scripted)", type: "authentication_error", code: "invalid_api_key" } });
    return;
  }
  if (failure === 402) {
    json(res, 402, {
      error: { message: "You exceeded your current quota (scripted insufficient credits)", type: "insufficient_quota", code: "insufficient_quota" },
    });
    return;
  }
  const id = `chatcmpl-${label}-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model ?? "dev-1";
  const reply = `Answered by ${label}.`;
  if (body.stream === false) {
    json(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const chunk = (delta, finish = null) =>
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  chunk({ role: "assistant", content: reply });
  chunk({}, "stop");
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});
server.on("error", (err) => {
  console.error(`recording model ${label} could not listen on 127.0.0.1:${port}: ${err.message}`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => console.log(`recording model ${label} on 127.0.0.1:${port}`));
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
