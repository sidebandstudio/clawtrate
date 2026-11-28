// The seed's coding-agent example survives a slow start of the `coder` server, and says so when
// the server never starts (#1036). On a loaded hosted runner OpenClaw's start of the server ran
// past its 30 s, and the next turn of the same bot got no `coder__` tools either: OpenClaw 2026.10.6
// and 2026.11.10 hold a bot's starts back for 30 s after one times out. The seed then stopped on
// "Hand off to the coding agent" with every scripted step missing. Here a stand-in gateway plays
// that start: a turn waits for the server up to the config's `connectionTimeoutMs` (OpenClaw's
// 30 s without it), and the model's request offers the tools only when the server started in
// that time. Time is faked; nothing waits.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { devConfig, sandboxProblems } from "../src/cli.ts";
import { CODING_AGENT_START_MS, SEND_MESSAGE_TEXT } from "../src/coding-agent-mcp.ts";
import { scriptedSteps, seedExample, unofferedCoderTools } from "../src/examples.ts";
import { OperatorSession } from "../src/operator.ts";
import { SCENARIO_EXAMPLES, sessionKeyFor, type ScenarioExample } from "../src/seed-data.ts";
import { toolJson } from "../src/versions.ts";

type JsonRecord = Record<string, unknown>;

const HANDOFF = SCENARIO_EXAMPLES.find((e) => e.slug === "coding-handoff")!;
const KEY = sessionKeyFor(HANDOFF.botId, HANDOFF.slug);
const CALL = scriptedSteps(HANDOFF).calls[0]!;
const RUN = "44444444-4444-4444-8444-444444444444";
/** OpenClaw's own limit for a server's start when the config gives none, in both versions. */
const OPENCLAW_DEFAULT_MS = 30_000;
/** The start that ran out on the loaded runner took longer than this. */
const SLOW_START_MS = 45_000;

const coderConfig = () =>
  (
    devConfig("token", undefined, "/state/dev") as {
      mcp: { servers: { coder: { connectionTimeoutMs?: number } } };
    }
  ).mcp.servers.coder;

/**
 * A paired connection to a stand-in gateway whose `coder` server starts after `startMs` (never
 * when null). The turn waits for it up to `limitMs`, then the model calls the tool if it was
 * offered, and the gateway answers "not found" when it was not.
 */
function standIn(startMs: number | null, limitMs: number) {
  const op = new (OperatorSession as unknown as new () => OperatorSession)();
  const emit = (event: string, payload: JsonRecord) =>
    (op as unknown as { record: (e: string, p: unknown) => void }).record(event, payload);
  const started = startMs !== null && startMs <= limitMs;
  let offered: string[] | null = null;
  let finished = false;
  Object.assign(op, {
    send: async () => {
      setTimeout(
        () => {
          offered = started ? ["coder__send_message", "read"] : ["read"];
          finished = true;
          emit("chat", { runId: RUN, sessionKey: KEY, state: "final" });
        },
        Math.min(startMs ?? limitMs, limitMs) + 2_000,
      );
      return { runId: RUN };
    },
    request: async (method: string) =>
      method === "chat.history" && finished ? { messages: rows(started) } : {},
  });
  return { op, offeredTools: async () => offered };
}

/** The task's history: the scripted handoff, or what the gateway records without the tool. */
const rows = (offered: boolean) => [
  { role: "user", content: HANDOFF.prompt },
  ...(offered
    ? [
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            { type: "thinking", thinking: scriptedSteps(HANDOFF).reasoning.join("\n") },
            { type: "toolCall", id: "c1", name: CALL.name, arguments: CALL.arguments },
          ],
        },
        {
          role: "toolResult",
          toolName: CALL.name,
          isError: false,
          content: [
            {
              type: "text",
              text: `structuredContent:\n${toolJson({
                reply: `Opened a branch and drafted the change for: ${String((CALL.arguments as JsonRecord).message)}`,
                threadId: "thread-1",
                url: "https://coding-agent.example/threads/thread-1",
              })}`,
            },
            { type: "text", text: SEND_MESSAGE_TEXT },
          ],
        },
      ]
    : [
        {
          role: "toolResult",
          toolName: CALL.name,
          isError: true,
          content: [{ type: "text", text: `Tool ${CALL.name} not found` }],
        },
      ]),
  { role: "assistant", stopReason: "stop", content: [{ type: "text", text: HANDOFF.finalText }] },
];

/** Seed the handoff against the stand-in for `ms` of fake time; the error, or null. */
async function seedFor(
  stand: ReturnType<typeof standIn>,
  ms: number,
  example: ScenarioExample = HANDOFF,
  withOffered = true,
): Promise<Error | null> {
  const outcome = seedExample(
    stand.op,
    example,
    () => {},
    withOffered ? stand.offeredTools : undefined,
  ).then(
    () => null,
    (error: unknown) => error as Error,
  );
  let settled = false;
  void outcome.then(() => (settled = true));
  for (let left = ms; left > 0 && !settled; left -= 1_000) {
    await vi.advanceTimersByTimeAsync(Math.min(1_000, left));
  }
  expect(settled, `the seed was still waiting after ${ms / 1000} s`).toBe(true);
  return outcome;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the coder server's start limit (#1036)", () => {
  it("gives the server two minutes to start, which the config contract keeps", () => {
    expect(CODING_AGENT_START_MS).toBe(120_000);
    expect(coderConfig().connectionTimeoutMs).toBe(CODING_AGENT_START_MS);
    const config = devConfig("token", undefined, "/state/dev");
    expect(sandboxProblems(config, undefined, "/state/dev")).toEqual([]);
  });

  it("covers the start that ran out on the loaded runner, inside the seed's run limit", () => {
    expect(CODING_AGENT_START_MS).toBeGreaterThan(2 * SLOW_START_MS);
    // A question in the same turn still comes within the seed's 180 s after the wait.
    expect(CODING_AGENT_START_MS).toBeLessThan(150_000);
  });
});

describe("a slow start of the coder server (#1036)", () => {
  it("stopped the seed as on the runner, with OpenClaw's own 30 s and only the history", async () => {
    const error = await seedFor(
      standIn(SLOW_START_MS, OPENCLAW_DEFAULT_MS),
      60_000,
      HANDOFF,
      false,
    );
    expect(error?.message).toMatch(/^clawtrate-main-bot \/ Hand off to the coding agent: /);
    expect(error?.message).toContain(
      `expected tool calls ["coder__send_message"], found []; result 1 (coder__send_message) has isError true, expected false`,
    );
    expect(error?.message).toContain('["Tool coder__send_message not found"]');
  });

  it("waits for the start now, and passes", async () => {
    const limit = coderConfig().connectionTimeoutMs!;
    const error = await seedFor(standIn(SLOW_START_MS, limit), 60_000);
    expect(error?.message).toBeUndefined();
  });

  it("is no slower when the server starts at once", async () => {
    const started = Date.now();
    const error = await seedFor(standIn(500, coderConfig().connectionTimeoutMs!), 10_000);
    expect(error?.message).toBeUndefined();
    expect(Date.now() - started).toBeLessThanOrEqual(5_000);
  });

  it("names the stage when the server never starts", async () => {
    const error = await seedFor(
      standIn(null, coderConfig().connectionTimeoutMs!),
      CODING_AGENT_START_MS + 10_000,
    );
    expect(error?.message).toBe(
      `clawtrate-main-bot / Hand off to the coding agent: the coder tools were not offered within 120 s: ` +
        `the model's request had no coder__send_message, so the gateway's "coder" server did not ` +
        `start in the time it is given (its [bundle-mcp] lines in the gateway's log say why)`,
    );
  });
});

describe("the coder tools an example needs", () => {
  it("are the coding agent's tools it calls that the request did not offer", () => {
    expect(unofferedCoderTools(HANDOFF, ["read"])).toEqual(["coder__send_message"]);
    expect(unofferedCoderTools(HANDOFF, ["coder__send_message"])).toEqual([]);
    // No request seen: the history check says what is wrong.
    expect(unofferedCoderTools(HANDOFF, null)).toEqual([]);
    // An example that calls no coder tool needs none.
    const other = SCENARIO_EXAMPLES.find((e) => e.slug === "show-your-work")!;
    expect(unofferedCoderTools(other, [])).toEqual([]);
  });
});
