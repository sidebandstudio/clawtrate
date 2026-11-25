// A scripted turn the gateway doesn't answer is never sent twice: the seed reads the task's
// history and sends it again only when it isn't there and no try reached the gateway (#627).
import { describe, expect, it } from "vitest";
import {
  expectedFinalText,
  isTurnTransportFailure,
  neverReachedGateway,
  runSeedTurn,
  turnLanding,
  type AgentRunOutput,
  type HistoryMessage,
} from "../src/cli.ts";
import { SEED_BOTS } from "../src/seed-data.ts";

// Otto's first turn in "Disk almost full on the media box", which calls tools before it replies.
const TASK = SEED_BOTS.find((bot) => bot.id === "otto")!.tasks.find(
  (task) => task.slug === "disk-space",
)!;
const FIRST = TASK.turns[0]!;
const SECOND = TASK.turns[1]!;

/** The `agent` command's failure in the iOS workflow's run 45716912815, as `must` throws it. */
const UNREACHABLE = new Error(
  `openclaw --profile clawtrate-dev-ios-5ff27c0285c9 agent --agent main --session-key agent:main:heat-pump-brief --message What should I ask an installer before signing anything? --thinking low --json failed:
{
  "ok": false,
  "error": {
    "type": "cli_error",
    "message": "Gateway not reachable at ws://127.0.0.1:19440 (ETIMEDOUT).\\nStart it with \`openclaw gateway run\` or check \`openclaw gateway status\`."
  }
}
Gateway agent call connection closed; the Gateway may still be running this turn. Check \`openclaw gateway status\` and the session transcript before retrying or rerunning with --local, so the turn does not execute twice.`,
);
/** A request that reached the gateway and got no answer in time. */
const NO_ANSWER = new Error(
  `openclaw agent failed:\n${JSON.stringify({ ok: false, error: { type: "gateway_transport_error", kind: "timeout", message: "gateway timeout after 60000ms" } })}`,
);
const REFUSED = new Error(
  `openclaw agent failed:\n${JSON.stringify({ ok: false, error: { type: "gateway_error", message: "unknown agent" } })}`,
);

const user = (text: string): HistoryMessage => ({ role: "user", content: text });
const working: HistoryMessage = {
  role: "assistant",
  stopReason: "toolUse",
  content: [{ type: "toolCall", name: "read" }],
};
const result: HistoryMessage = { role: "toolResult", content: [{ type: "text", text: "ok" }] };
const reply = (text: string, stopReason = "stop"): HistoryMessage => ({
  role: "assistant",
  stopReason,
  content: [{ type: "text", text }],
});
const finished = (turn = FIRST) => [
  user(turn.prompt),
  working,
  result,
  reply(expectedFinalText(turn)),
];
const ok: AgentRunOutput = {
  status: "ok",
  summary: "completed",
  result: { meta: { stopReason: "stop", finalAssistantVisibleText: expectedFinalText(FIRST) } },
};

describe("which turn failures are the gateway not answering, and which never reached it", () => {
  it("a gateway the command couldn't reach is both; a request without an answer only the first", () => {
    expect(isTurnTransportFailure(UNREACHABLE)).toBe(true);
    expect(neverReachedGateway(UNREACHABLE)).toBe(true);
    expect(isTurnTransportFailure(NO_ANSWER)).toBe(true);
    expect(neverReachedGateway(NO_ANSWER)).toBe(false);
    expect(isTurnTransportFailure(REFUSED)).toBe(false);
  });
});

describe("how far a turn got, from its task's history", () => {
  it("not there, running, then done", () => {
    expect(turnLanding([], 0, FIRST)).toEqual({ state: "absent" });
    expect(turnLanding([user(FIRST.prompt)], 0, FIRST)).toEqual({ state: "running" });
    expect(turnLanding([user(FIRST.prompt), working], 0, FIRST)).toEqual({ state: "running" });
    expect(turnLanding([user(FIRST.prompt), working, result], 0, FIRST)).toEqual({
      state: "running",
    });
    expect(turnLanding(finished(), 0, FIRST)).toEqual({ state: "done" });
    // The second turn, after the first ended.
    expect(turnLanding(finished(), 1, SECOND)).toEqual({ state: "absent" });
    expect(turnLanding([...finished(), ...finished(SECOND)], 1, SECOND)).toEqual({
      state: "done",
    });
  });

  it("names what doesn't fit: another message, one too many, an error, another reply", () => {
    expect(turnLanding([user("something else")], 0, FIRST)).toEqual({
      problem: "the last message in the task isn't this turn's",
    });
    expect(turnLanding([user(FIRST.prompt), user(FIRST.prompt)], 0, FIRST)).toEqual({
      problem: "expected 1 messages of the person's, found 2",
    });
    expect(turnLanding([user(FIRST.prompt), reply("", "error")], 0, FIRST)).toEqual({
      problem: "the turn ended with error",
    });
    expect(turnLanding([user(FIRST.prompt), reply("Something else.")], 0, FIRST)).toEqual({
      problem: "the turn's reply differs from the script",
    });
  });
});

describe("a seed turn the gateway doesn't answer", () => {
  /** A turn run with scripted answers: each send and each history read takes the next one. */
  async function run(sends: Array<AgentRunOutput | Error>, reads: Array<HistoryMessage[] | Error>) {
    let sent = 0;
    let read = 0;
    const outcome = await runSeedTurn({
      turn: FIRST,
      index: 0,
      what: "agent:otto:disk-space",
      delays: [1, 2, 3],
      sleep: async () => {},
      log: () => {},
      send: async () => {
        const next = sends[sent++]!;
        if (next instanceof Error) throw next;
        return next;
      },
      history: async () => {
        const next = reads[read++]!;
        if (next instanceof Error) throw next;
        return next;
      },
    }).then(
      (problem) => ({ problem }),
      (error: unknown) => ({ error }),
    );
    return { ...outcome, sent, read };
  }

  it("answered at once: no history is read", async () => {
    expect(await run([ok], [])).toEqual({ problem: null, sent: 1, read: 0 });
  });

  it("done although its answer was lost: not sent again", async () => {
    expect(await run([UNREACHABLE], [finished()])).toEqual({ problem: null, sent: 1, read: 1 });
  });

  it("its message there without the reply yet: waited for, not sent again", async () => {
    expect(
      await run([NO_ANSWER], [[user(FIRST.prompt)], [user(FIRST.prompt), working], finished()]),
    ).toEqual({ problem: null, sent: 1, read: 3 });
  });

  it("not there, and the gateway was never reached: sent again", async () => {
    expect(await run([UNREACHABLE, ok], [[]])).toEqual({ problem: null, sent: 2, read: 1 });
  });

  it("not there, but the request reached the gateway: never sent again, and fails when the waits end", async () => {
    const outcome = await run([NO_ANSWER], [[], [], []]);
    expect(outcome).toEqual({ error: NO_ANSWER, sent: 1, read: 3 });
  });

  it("seen running once, then not there: not sent again, and fails when the waits end", async () => {
    expect(await run([UNREACHABLE], [[user(FIRST.prompt)], [], []])).toEqual({
      error: UNREACHABLE,
      sent: 1,
      read: 3,
    });
  });

  it("a history read the gateway doesn't answer is read again later", async () => {
    expect(await run([NO_ANSWER], [NO_ANSWER, finished()])).toEqual({
      problem: null,
      sent: 1,
      read: 2,
    });
  });

  it("a refusal is thrown at once, and a history that doesn't fit is named", async () => {
    expect(await run([REFUSED], [])).toEqual({ error: REFUSED, sent: 1, read: 0 });
    expect(await run([UNREACHABLE], [[user("something else")]])).toEqual({
      problem: "the last message in the task isn't this turn's",
      sent: 1,
      read: 1,
    });
  });
});
