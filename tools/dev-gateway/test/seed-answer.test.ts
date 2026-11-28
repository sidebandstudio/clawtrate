// The seed waits for an answer on its way, up to a stated limit, and stays strict about what it
// accepts (#883). On a loaded hosted runner Marlow's answer to Pip came about 45 s after the send,
// past the 30 s `sessions_send` was given, and the whole start stopped. Here a stand-in gateway
// plays OpenClaw 2026.10.6's `sessions_send`: the call returns "ok" with the reply when the other
// bot answers within the call's `timeoutSeconds`, and otherwise "accepted" at that limit, with
// the answer arriving later in a turn of its own. Time is faked; nothing waits.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SEED_ANSWER_MS,
  SEED_RUN_MS,
  lastReport,
  scriptedSteps,
  seedExample,
} from "../src/examples.ts";
import { OperatorSession } from "../src/operator.ts";
import { SCENARIO_CHECKS, type Harness } from "../src/scenario-check.ts";
import { SAME_CALL_REPLY_SECONDS, SAME_CALL_RUN_MS } from "../src/scenarios.ts";
import { SCENARIO_EXAMPLES, sessionKeyFor, type ScenarioExample } from "../src/seed-data.ts";
import { toolJson } from "../src/versions.ts";

type JsonRecord = Record<string, unknown>;

const example = (slug: string): ScenarioExample => SCENARIO_EXAMPLES.find((e) => e.slug === slug)!;
const ASK = example("ask-marlow");
const PIP_KEY = sessionKeyFor(ASK.botId, ASK.slug);
const MARLOW_KEY = ASK.recipientSession!;
const REPLY = example("main").finalText;
const CALL = scriptedSteps(ASK).calls[0]!;
const MESSAGE = String((CALL.arguments as JsonRecord).message);
/** The limit the seed's own script gives the call, in ms. */
const CALL_LIMIT_MS = Number((CALL.arguments as JsonRecord).timeoutSeconds) * 1000;

const PIP_RUN = "11111111-1111-4111-8111-111111111111";
const MARLOW_RUN = "22222222-2222-4222-8222-222222222222";
const LATE_RUN = "33333333-3333-4333-8333-333333333333";
/** The sender's run reaches its `sessions_send` call this long after the send. */
const TO_CALL_MS = 1_000;

type Play = {
  /** When Marlow's run ends after the call starts; null when it never does. */
  replyAfterMs: number | null;
  /** The session Marlow's run ends in. */
  replySession?: string;
  /** The text Marlow answers with. */
  reply?: string;
  /** Whether the sender's run reaches its call at all. */
  reachesCall?: boolean;
};

/** A paired connection to a stand-in gateway: the real event log and waits, scripted answers. */
function standIn(play: Play) {
  const op = new (OperatorSession as unknown as new () => OperatorSession)();
  const emit = (event: string, payload: JsonRecord) =>
    (op as unknown as { record: (e: string, p: unknown) => void }).record(event, payload);
  const reply = play.reply ?? REPLY;
  const later = (ms: number, then: () => void) => setTimeout(then, ms);
  const final = (runId: string, sessionKey: string) =>
    emit("chat", { runId, sessionKey, state: "final" });
  const toolResult = (details: JsonRecord) =>
    emit("agent", {
      runId: PIP_RUN,
      sessionKey: PIP_KEY,
      stream: "tool",
      data: { phase: "result", name: "sessions_send", result: { details } },
    });
  let answeredInCall = false;

  Object.assign(op, {
    send: async () => {
      if (play.reachesCall === false) return { runId: PIP_RUN };
      later(TO_CALL_MS, () => {
        emit("agent", {
          runId: PIP_RUN,
          sessionKey: PIP_KEY,
          stream: "tool",
          data: { phase: "start", name: "sessions_send", args: CALL.arguments },
        });
        const answer = play.replyAfterMs;
        // OpenClaw's rule: the reply within the call's limit, or "accepted" at the limit.
        if (answer !== null && answer <= CALL_LIMIT_MS) {
          later(answer, () => {
            answeredInCall = true;
            final(MARLOW_RUN, play.replySession ?? MARLOW_KEY);
            toolResult({ status: "ok", runId: MARLOW_RUN, sessionKey: MARLOW_KEY, reply });
            later(500, () => final(PIP_RUN, PIP_KEY));
          });
          return;
        }
        later(CALL_LIMIT_MS, () => {
          toolResult({
            status: "accepted",
            runId: MARLOW_RUN,
            sessionKey: MARLOW_KEY,
            targetDisposition: "queued",
            delivery: { status: "pending" },
          });
          later(500, () => final(PIP_RUN, PIP_KEY));
        });
        if (answer !== null) {
          // The late answer reaches Pip's task in a turn of its own.
          later(answer, () => {
            final(MARLOW_RUN, MARLOW_KEY);
            later(500, () => final(LATE_RUN, PIP_KEY));
          });
        }
      });
      return { runId: PIP_RUN };
    },
    request: async (method: string, params: JsonRecord = {}) => {
      if (method !== "chat.history") return {};
      return { messages: params.sessionKey === MARLOW_KEY ? marlowRows(reply) : pipRows() };
    },
  });

  /** Pip's task as the gateway records it: the call's result, then the scripted reply. */
  const pipRows = () => [
    { role: "user", content: ASK.prompt },
    {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: scriptedSteps(ASK).reasoning.join("\n") },
        { type: "toolCall", id: "c1", name: "sessions_send", arguments: CALL.arguments },
      ],
    },
    {
      role: "toolResult",
      toolName: "sessions_send",
      isError: false,
      content: [
        {
          type: "text",
          text: toolJson(
            answeredInCall
              ? {
                  runId: MARLOW_RUN,
                  sessionKey: MARLOW_KEY,
                  status: "ok",
                  delivery: { status: "skipped" },
                  reply,
                }
              : { runId: MARLOW_RUN, status: "accepted", sessionKey: MARLOW_KEY },
          ),
        },
      ],
      details: { sessionKey: MARLOW_KEY },
    },
    {
      role: "assistant",
      stopReason: "stop",
      content: [
        {
          type: "text",
          text: answeredInCall
            ? `Marlow replied:\n\n> ${reply}`
            : "Marlow is still working on it. Their reply will arrive in this task.",
        },
      ],
    },
  ];
  return op;
}

/** Marlow's main task: its own note, Pip's message, and the answer after it. */
const marlowRows = (reply: string) => [
  { role: "user", content: example("main").prompt },
  { role: "assistant", stopReason: "stop", content: [{ type: "text", text: REPLY }] },
  {
    role: "assistant",
    provenance: { kind: "inter_session", sourceSessionKey: PIP_KEY, sourceTool: "sessions_send" },
    content: MESSAGE,
  },
  { role: "assistant", stopReason: "stop", content: [{ type: "text", text: reply }] },
];

/** Seed one example against the stand-in for `ms` of fake time; the error, or null. */
async function seedFor(op: OperatorSession, ms: number, which = ASK): Promise<Error | null> {
  const outcome = seedExample(op, which, () => {}).then(
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

describe("the seed waits for an answer on its way (#883)", () => {
  it("gives the bot-to-bot answer the stated limit, which covers the runner's late answer", () => {
    expect(SAME_CALL_REPLY_SECONDS).toBe(180);
    expect(CALL_LIMIT_MS).toBe(SAME_CALL_REPLY_SECONDS * 1000);
    expect(SEED_ANSWER_MS).toBe(180_000);
    // The run's own limit leaves room for the call's whole limit and the run around it.
    expect(SEED_RUN_MS).toBeGreaterThan(CALL_LIMIT_MS + 60_000);
  });

  it("reads an answer that comes 45 s after the send, as on the loaded runner", async () => {
    const op = standIn({ replyAfterMs: 45_000 });
    expect((await seedFor(op, 60_000))?.message).toBeUndefined();
  });

  it("is no slower when the answer is quick", async () => {
    const op = standIn({ replyAfterMs: 2_000 });
    const started = Date.now();
    expect((await seedFor(op, 10_000))?.message).toBeUndefined();
    expect(Date.now() - started).toBeLessThanOrEqual(5_000);
  });

  it("reads an answer just inside the limit", async () => {
    const op = standIn({ replyAfterMs: CALL_LIMIT_MS - 1_000 });
    expect((await seedFor(op, SEED_RUN_MS))?.message).toBeUndefined();
  });
});

describe("the seed stays strict with a longer wait (#883)", () => {
  it("stops when no answer comes, saying how long the call waited and what it reported", async () => {
    const op = standIn({ replyAfterMs: null });
    const error = await seedFor(op, SEED_RUN_MS);
    expect(error?.message).toBe(
      `pip / Ask Marlow about the plan: the message was not answered within the call's 180 s: sessions_send reported "accepted" (queued) after 180 s`,
    );
  });

  it("refuses an answer that comes after the call, in a turn of its own", async () => {
    const op = standIn({ replyAfterMs: CALL_LIMIT_MS + 20_000 });
    const error = await seedFor(op, SEED_RUN_MS);
    expect(error?.message).toMatch(
      /not answered within the call's 180 s: sessions_send reported "accepted" \(queued\) after 180 s$/,
    );
    // The answer did arrive, and the seed still did not take it.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(op.events.some((e) => (e.payload as JsonRecord).runId === LATE_RUN)).toBe(true);
  });

  it("refuses an answer from a run that ended in another task", async () => {
    const op = standIn({ replyAfterMs: 5_000, replySession: "agent:marlow:other" });
    const error = await seedFor(op, 20_000);
    expect(error?.message).toBe(
      "pip / Ask Marlow about the plan: the recipient's run did not finish in agent:marlow:main",
    );
  });

  it("refuses a wrong answer, however quickly it comes", async () => {
    const op = standIn({ replyAfterMs: 5_000, reply: "Sounds fine." });
    const error = await seedFor(op, 20_000);
    expect(error?.message).toMatch(/^pip \/ Ask Marlow about the plan: /);
    expect(error?.message).toContain("result 1 (sessions_send) text differs from the script");
    expect(error?.message).toContain("a completed reply differs from the scripted text");
    expect(error?.message).toContain("the recipient's reply is not after the message");
  });

  it("stops a run that never ends, with what the gateway last said about it", async () => {
    const op = standIn({ replyAfterMs: null });
    // The call starts and then nothing more comes: no result, no end of the run.
    Object.assign(op, {
      send: async () => {
        setTimeout(
          () =>
            (op as unknown as { record: (e: string, p: unknown) => void }).record("agent", {
              runId: PIP_RUN,
              stream: "tool",
              data: { phase: "start", name: "sessions_send" },
            }),
          TO_CALL_MS,
        );
        return { runId: PIP_RUN };
      },
    });
    const error = await seedFor(op, SEED_RUN_MS + 1_000);
    expect(error?.message).toBe(
      `pip / Ask Marlow about the plan: no end of the run after ${SEED_RUN_MS / 1000} s; the gateway last reported agent tool start sessions_send, ${SEED_RUN_MS / 1000 - 1} s before the seed stopped`,
    );
  });

  it("stops waiting for a question that never comes, after the stated limit", async () => {
    const op = standIn({ replyAfterMs: null, reachesCall: false });
    const error = await seedFor(op, SEED_ANSWER_MS + 1_000, example("route-question"));
    expect(error?.message).toBe(
      `pip / Which route on Saturday: no question after ${SEED_ANSWER_MS / 1000} s; the gateway last reported nothing about run ${PIP_RUN}`,
    );
  });
});

describe("what the gateway last reported", () => {
  it("names the event, its stream, phase or state and tool, and how long ago", () => {
    const now = Date.now();
    const events = [
      { at: now - 9_000, seq: 1, event: "chat", payload: { runId: "r", state: "delta" } },
      {
        at: now - 4_000,
        seq: 2,
        event: "agent",
        payload: { runId: "r", stream: "tool", data: { phase: "start", name: "exec" } },
      },
      { at: now, seq: 3, event: "chat", payload: { runId: "other", state: "final" } },
    ];
    expect(lastReport(events, "r", 0)).toBe("agent tool start exec, 4 s before the seed stopped");
    expect(lastReport(events, "r", 2)).toBe("nothing about run r");
    expect(lastReport(events.slice(0, 1), "r", 0)).toBe("chat delta, 9 s before the seed stopped");
  });
});

describe("the scenario check's same-call message (#883)", () => {
  it("waits for the sender's run as long as its call may wait for the answer, and more", async () => {
    const check = SCENARIO_CHECKS.find(
      (c) => c.name === "a message to another bot, answered in the same call",
    )!;
    const stop = new Error("stop after the wait");
    let waited: number | undefined;
    const h = {
      session: async () => "agent:pip:message",
      start: async () => ({}),
      wait: async (_view: unknown, timeoutMs?: number) => {
        waited = timeoutMs;
        throw stop;
      },
    } as unknown as Harness;
    await expect(check.run(h)).rejects.toBe(stop);
    expect(waited).toBe(SAME_CALL_RUN_MS);
    expect(SAME_CALL_RUN_MS).toBeGreaterThan(SAME_CALL_REPLY_SECONDS * 1000);
    // The seed's example run has the same bound.
    expect(SEED_RUN_MS).toBe(SAME_CALL_RUN_MS);
  });
});
