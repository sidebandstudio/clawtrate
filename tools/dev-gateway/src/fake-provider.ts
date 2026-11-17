// A scripted model server that speaks the OpenAI Chat Completions streaming API.
// The development gateway registers it as a custom `openai-completions` provider.
// Replies are deterministic: the same conversation always streams the same chunks.

import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MODEL_ID } from "./env.ts";
import { planReply, type ChatMessage, type ReplyStep } from "./scripts.ts";

export const FAKE_MODEL_ID = MODEL_ID;

type ToolSpec = { type?: string; function?: { name?: string } };

type CompletionRequest = {
  model?: string;
  messages?: ChatMessage[];
  tools?: ToolSpec[];
  stream?: boolean;
};

export type FakeProviderOptions = {
  port: number;
  host?: string;
  /** Delay between streamed chunks, in milliseconds. */
  chunkDelayMs?: number;
  log?: (line: string) => void;
  /** When set, the last request body is written here for debugging. */
  dumpPath?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Split text into small word-aligned pieces so the gateway sees a real stream. */
export function chunkText(text: string, size = 24): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const word of text.split(/(?<=\s)/)) {
    if (current.length + word.length > size && current) {
      pieces.push(current);
      current = "";
    }
    current += word;
  }
  if (current) pieces.push(current);
  return pieces;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function completionId(messages: ChatMessage[]): string {
  // Stable per conversation length, so retries of the same request match.
  return `chatcmpl-scripted-${messages.length}`;
}

async function streamSteps(
  res: ServerResponse,
  model: string,
  id: string,
  steps: ReplyStep[],
  delayMs: number,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const created = 1_767_225_600; // fixed timestamp keeps output deterministic
  const send = (delta: Record<string, unknown>, finishReason: string | null = null) => {
    const chunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  send({ role: "assistant", content: "" });
  let finish = "stop";
  let toolIndex = 0;
  for (const step of steps) {
    if (step.kind === "reasoning") {
      for (const piece of chunkText(step.text)) {
        send({ reasoning_content: piece });
        await sleep(delayMs);
      }
    } else if (step.kind === "text") {
      for (const piece of chunkText(step.text)) {
        send({ content: piece });
        await sleep(delayMs);
      }
    } else {
      const args = JSON.stringify(step.arguments);
      send({
        tool_calls: [
          {
            index: toolIndex,
            id: step.id,
            type: "function",
            function: { name: step.name, arguments: "" },
          },
        ],
      });
      for (const piece of chunkText(args, 32)) {
        send({ tool_calls: [{ index: toolIndex, function: { arguments: piece } }] });
        await sleep(delayMs);
      }
      toolIndex += 1;
      finish = "tool_calls";
    }
  }
  send({}, finish);
  const usage = { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 };
  res.write(
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

function nonStreamingBody(model: string, id: string, steps: ReplyStep[]) {
  const text = steps
    .filter((s) => s.kind === "text")
    .map((s) => s.text)
    .join("");
  const reasoning = steps
    .filter((s) => s.kind === "reasoning")
    .map((s) => s.text)
    .join("");
  const toolCalls = steps.flatMap((s) =>
    s.kind === "tool"
      ? [
          {
            id: s.id,
            type: "function",
            function: { name: s.name, arguments: JSON.stringify(s.arguments) },
          },
        ]
      : [],
  );
  return {
    id,
    object: "chat.completion",
    created: 1_767_225_600,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
  };
}

export function startFakeProvider(options: FakeProviderOptions) {
  const delayMs = options.chunkDelayMs ?? 8;
  const log = options.log ?? (() => {});
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        sendJson(res, 200, {
          object: "list",
          data: [{ id: FAKE_MODEL_ID, object: "model", owned_by: "clawtrate-dev" }],
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const raw = await readBody(req);
        let body: CompletionRequest;
        try {
          body = JSON.parse(raw) as CompletionRequest;
        } catch {
          sendJson(res, 400, { error: { message: "invalid JSON body", type: "invalid_request" } });
          return;
        }
        if (options.dumpPath) writeFileSync(options.dumpPath, JSON.stringify(body, null, 1));
        const messages = body.messages ?? [];
        const toolNames = (body.tools ?? [])
          .map((tool) => tool.function?.name)
          .filter((name): name is string => typeof name === "string");
        const steps = planReply(messages, new Set(toolNames));
        const model = body.model ?? FAKE_MODEL_ID;
        const id = completionId(messages);
        log(
          `completion messages=${messages.length} tools=[${toolNames.join(",")}] steps=${steps.map((s) => s.kind).join(",")}`,
        );
        if (body.stream === false) {
          sendJson(res, 200, nonStreamingBody(model, id, steps));
          return;
        }
        await streamSteps(res, model, id, steps, delayMs);
        return;
      }
      sendJson(res, 404, { error: { message: "not found", type: "not_found" } });
    })().catch((error: unknown) => {
      log(`error ${String(error)}`);
      if (!res.headersSent) sendJson(res, 500, { error: { message: "internal error" } });
      else res.end();
    });
  });
  server.listen(options.port, options.host ?? "127.0.0.1");
  return server;
}
