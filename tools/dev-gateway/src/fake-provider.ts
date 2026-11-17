// A scripted model server that speaks the OpenAI Chat Completions streaming API.
// The development gateway registers it as a custom `openai-completions` provider.
// Replies are deterministic: the same conversation always streams the same chunks.

import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MODEL_ID } from "./env.ts";
import { ScriptedAccounts, type FailureStatus, type ScriptedFailure } from "./scripted-accounts.ts";
import {
  messageText,
  gatewayTurnPrompt,
  planReply,
  SILENT_REPLY,
  runtimeFacts,
  type ChatMessage,
  type ReplyStep,
} from "./scripts.ts";

export const FAKE_MODEL_ID = MODEL_ID;

/** Where the gateway's Ollama search provider asks a local host first. */
export const WEB_SEARCH_PATH = "/api/experimental/web_search";

/** Three fixed results on the reserved `.example` domain; nothing is fetched. */
export function scriptedSearchResults(query: string) {
  const topic = query.trim() || "your search";
  return {
    results: [1, 2, 3].map((n) => ({
      title: `Result ${n} for ${topic}`,
      url: `https://search.example/results/${n}`,
      content: `A scripted search result (${n} of 3) about ${topic}.`,
    })),
  };
}

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
        if (res.destroyed) return;
        send({ reasoning_content: piece });
        await sleep(step.delayMs ?? delayMs);
      }
    } else if (step.kind === "text") {
      for (const piece of chunkText(step.text)) {
        // A stopped run closes the request; stop streaming into it.
        if (res.destroyed) return;
        send({ content: piece });
        await sleep(step.delayMs ?? delayMs);
      }
    } else if (step.kind === "tool") {
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
      for (const piece of chunkText(args, step.argumentPiece ?? 32)) {
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

/** Where the scenario check reads the tools the gateway offered in a session. */
export const OFFERED_TOOLS_PATH = "/scripted/offered-tools";
/** The turns the gateway started itself in a session and the scripted model answered quietly, by the prompt each was. */
export const QUIET_TURNS_PATH = "/scripted/quiet-turns";

/** A scripted account failure, in the shape the providers' APIs answer it. */
function failureBody({ status, message }: ScriptedFailure) {
  const fixed = defaultFailure(status);
  return message === undefined ? fixed : { ...fixed, message };
}

function defaultFailure(status: FailureStatus) {
  if (status === 401) {
    return {
      message: "Invalid API key (scripted)",
      type: "authentication_error",
      code: "invalid_api_key",
    };
  }
  if (status === 402) {
    return {
      message: "You exceeded your current quota (scripted insufficient credits)",
      type: "insufficient_quota",
      code: "insufficient_quota",
    };
  }
  return {
    message: "Rate limit reached (scripted)",
    type: "rate_limit_exceeded",
    code: "rate_limit_exceeded",
  };
}

export function startFakeProvider(options: FakeProviderOptions) {
  const delayMs = options.chunkDelayMs ?? 8;
  // Which account each request came from, failures per account, and the
  // scripted sign-ins (scripted-accounts.ts).
  const accounts = new ScriptedAccounts({
    baseUrl: () => {
      const address = server.address();
      return `http://127.0.0.1:${typeof address === "object" && address ? address.port : options.port}`;
    },
  });
  // The tool names of the latest model request in each session, as evidence
  // of which tools the gateway really offers a bot.
  const offered = new Map<string, string[]>();
  // Gateway-started turns answered with the silent reply, which leave no trace
  // in the gateway's history, counted per session.
  const quiet = new Map<string, string[]>();
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
      if (req.method === "GET" && url.pathname === OFFERED_TOOLS_PATH) {
        const session = url.searchParams.get("session") ?? "";
        sendJson(res, 200, { session, tools: offered.get(session) ?? null });
        return;
      }
      if (req.method === "GET" && url.pathname === QUIET_TURNS_PATH) {
        const session = url.searchParams.get("session") ?? "";
        sendJson(res, 200, { session, prompts: quiet.get(session) ?? [] });
        return;
      }
      if (req.method === "POST" && url.pathname === WEB_SEARCH_PATH) {
        // The gateway's Ollama web search provider, pointed here by the config.
        let query = "";
        try {
          query = String((JSON.parse(await readBody(req)) as { query?: unknown }).query ?? "");
        } catch {
          // an unreadable body is answered with no query
        }
        log(`web search ${JSON.stringify(query.slice(0, 80))}`);
        sendJson(res, 200, scriptedSearchResults(query));
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
        const session = runtimeFacts(messages).sessionKey;
        const { failure: accountFailure, record } = accounts.observe({
          authorization: req.headers.authorization,
          model: body.model ?? null,
          session: session ?? null,
        });
        if (accountFailure) {
          log(
            `completion failing with ${accountFailure.status} for its account (or no credential)`,
          );
          if (accountFailure.status === 429) res.setHeader("retry-after", "1");
          sendJson(res, accountFailure.status, { error: failureBody(accountFailure) });
          return;
        }
        if (session) offered.set(session, [...toolNames].sort());
        const steps = planReply(messages, new Set(toolNames));
        if (
          session &&
          steps.length === 1 &&
          steps[0]!.kind === "text" &&
          steps[0]!.text === SILENT_REPLY
        ) {
          quiet.set(session, [
            ...(quiet.get(session) ?? []),
            gatewayTurnPrompt(messages) ?? "other",
          ]);
        }
        const model = body.model ?? FAKE_MODEL_ID;
        const id = completionId(messages);
        const failure = steps.find((step) => step.kind === "fail");
        if (failure) accounts.answered(record, failure.status);
        if (failure) {
          log(`completion messages=${messages.length} failing with ${failure.status}`);
          sendJson(res, failure.status, {
            error: {
              message: failure.message,
              type: "invalid_request_error",
              code: "scripted_failure",
            },
          });
          return;
        }
        const last = messages.at(-1);
        log(
          `completion messages=${messages.map((m) => m.role[0]).join("")} tools=${toolNames.length} steps=${steps.map((s) => s.kind).join(",")} last=${last?.role ?? "-"}:${JSON.stringify(messageText(last ?? { role: "user" }).slice(0, 200))}`,
        );
        if (body.stream === false) {
          sendJson(res, 200, nonStreamingBody(model, id, steps));
          return;
        }
        await streamSteps(res, model, id, steps, delayMs);
        return;
      }
      if (url.pathname.startsWith("/scripted/") && (await accounts.handle(req, res, url))) return;
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
