// A seeded task the gateway was slow to make is never made twice: before sending
// `sessions.create` again, and after the gateway refuses it, the seed reads the task back by key
// (#700).
import { describe, expect, it } from "vitest";
import {
  createSeedSession,
  isCreateConflict,
  sessionMismatch,
  type ListedSession,
  type SeedSession,
} from "../src/cli.ts";

const SESSION: SeedSession = {
  key: "agent:pip:weekend-trip",
  agentId: "pip",
  label: "Two days in the mountains",
};
const LISTED: ListedSession = { ...SESSION };

/** A failed `openclaw gateway call sessions.create`, as `must` throws it, around the CLI's JSON. */
const failed = (error: Record<string, unknown>) =>
  new Error(
    `openclaw --profile clawtrate-dev-ios-2 gateway call sessions.create --json --timeout 60000 failed:\n${JSON.stringify(
      { ok: false, error },
      null,
      2,
    )}`,
  );

const TIMEOUT = failed({
  type: "gateway_transport_error",
  kind: "timeout",
  message: "gateway timeout after 60000ms",
  timeoutMs: 60000,
});
/** The refusal of the iOS workflow's run 45828834512: the retry raced a slow first try. */
const RACED = failed({
  type: "gateway_request_error",
  code: "INVALID_REQUEST",
  message: "session changed before sessions.create; retry the request",
  details: {
    code: "SESSION_MUTATION_AUTHORIZATION_CHANGED",
    method: "sessions.create",
    sessionKey: SESSION.key,
  },
  retryable: false,
});
/** The same refusal without its details. */
const RACED_BARE = failed({
  type: "gateway_request_error",
  code: "INVALID_REQUEST",
  message: "session changed before sessions.create; retry the request",
  retryable: false,
});
/** OpenClaw 2026.10.6's refusal of a label another of the bot's tasks has. */
const LABEL_TAKEN = failed({
  type: "gateway_request_error",
  code: "INVALID_REQUEST",
  message: `label already in use: ${SESSION.label}`,
  retryable: false,
});
const EXISTS = failed({
  type: "gateway_request_error",
  code: "INVALID_REQUEST",
  message: `session already exists: ${SESSION.key}`,
  retryable: false,
});
const OTHER_REFUSAL = failed({
  type: "gateway_request_error",
  code: "INVALID_REQUEST",
  message: "unknown agent",
  retryable: false,
});

/** Fakes for the gateway: each call takes the next of its answers, an Error is thrown. */
function gateway(options: {
  creates: Array<Error | "ok">;
  finds: Array<Error | ListedSession | undefined>;
}) {
  const calls: string[] = [];
  const waits: number[] = [];
  const lines: string[] = [];
  const next = <T>(answers: Array<Error | T>, what: string): T => {
    calls.push(what);
    if (answers.length === 0) throw new Error(`an unexpected ${what}`);
    const answer = answers.shift()!;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return {
    calls,
    waits,
    lines,
    run: (delays: readonly number[] = [5, 10, 20]) =>
      createSeedSession({
        session: SESSION,
        create: async () => next(options.creates, "create"),
        find: async () => next(options.finds, "find"),
        delays,
        sleep: async (ms) => waits.push(ms),
        log: (line) => lines.push(line),
      }),
  };
}

describe("which sessions.create refusals mean the task may be there already", () => {
  it("a raced create, with or without its details, and an existing task or label are", () => {
    expect(isCreateConflict(RACED)).toBe(true);
    expect(isCreateConflict(RACED_BARE)).toBe(true);
    expect(isCreateConflict(LABEL_TAKEN)).toBe(true);
    expect(isCreateConflict(EXISTS)).toBe(true);
  });

  it("a timeout and any other refusal are not", () => {
    expect(isCreateConflict(TIMEOUT)).toBe(false);
    expect(isCreateConflict(OTHER_REFUSAL)).toBe(false);
  });
});

describe("a listed task against the seed's", () => {
  it("is the seed's with the same bot and label", () => {
    expect(sessionMismatch(LISTED, SESSION)).toBeNull();
  });

  it("names each field that differs", () => {
    expect(sessionMismatch({ ...LISTED, label: "Something else" }, SESSION)).toBe(
      'its label is "Something else", not "Two days in the mountains"',
    );
    expect(sessionMismatch({ key: SESSION.key, agentId: "otto" }, SESSION)).toBe(
      'its bot is otto, not pip; its label is null, not "Two days in the mountains"',
    );
  });
});

describe("a seeded task made when the gateway is slow or refuses", () => {
  it("is made by one call when the gateway answers", async () => {
    const fake = gateway({ creates: ["ok"], finds: [] });
    await fake.run();
    expect(fake.calls).toEqual(["create"]);
    expect(fake.waits).toEqual([]);
  });

  it("carries on when a slow first try made it and the second is refused", async () => {
    // The first try times out on the client but is still running; the read sees nothing yet, so
    // it is sent again, and the gateway refuses that one once the first has made the task.
    const fake = gateway({ creates: [TIMEOUT, RACED], finds: [undefined, LISTED] });
    await fake.run();
    expect(fake.calls).toEqual(["create", "find", "create", "find"]);
    expect(fake.waits).toEqual([5]);
    expect(fake.lines.at(-1)).toBe(
      "  agent:pip:weekend-trip is on the gateway as the seed makes it; carrying on",
    );
  });

  it("carries on without sending again when the read after a timeout finds it", async () => {
    const fake = gateway({ creates: [TIMEOUT], finds: [LISTED] });
    await fake.run();
    expect(fake.calls).toEqual(["create", "find"]);
  });

  it("carries on when the gateway refuses it as already there and it is the seed's", async () => {
    for (const refusal of [EXISTS, LABEL_TAKEN, RACED_BARE]) {
      const fake = gateway({ creates: [refusal], finds: [LISTED] });
      await fake.run();
      expect(fake.calls).toEqual(["create", "find"]);
      expect(fake.waits).toEqual([]);
    }
  });

  it("stops, naming the key and what differs, when the task there isn't the seed's", async () => {
    const other = { ...LISTED, label: "Something else" };
    for (const fake of [
      gateway({ creates: [EXISTS], finds: [other] }),
      gateway({ creates: [TIMEOUT], finds: [other] }),
    ]) {
      await expect(fake.run()).rejects.toThrow(
        'agent:pip:weekend-trip is on the gateway, but not as the seed makes it: its label is "Something else", not "Two days in the mountains"',
      );
      // Never sent again: a second sessions.create would relabel the task.
      expect(fake.calls).toEqual(["create", "find"]);
    }
  });

  it("sends it again once when a timeout made nothing, and it is made", async () => {
    const fake = gateway({ creates: [TIMEOUT, "ok"], finds: [undefined] });
    await fake.run();
    expect(fake.calls).toEqual(["create", "find", "create"]);
    expect(fake.waits).toEqual([5]);
    expect(fake.lines).toEqual([
      "  the gateway didn't answer sessions.create for agent:pip:weekend-trip; reading its tasks in 0.005 s",
    ]);
  });

  it("reads again, without sending, when a read isn't answered", async () => {
    const fake = gateway({ creates: [TIMEOUT, "ok"], finds: [TIMEOUT, undefined] });
    await fake.run();
    expect(fake.calls).toEqual(["create", "find", "find", "create"]);
    expect(fake.waits).toEqual([5, 10]);
  });

  it("never sends it again after a refusal, and stops when the waits end without it", async () => {
    const fake = gateway({ creates: [RACED], finds: [undefined, undefined, TIMEOUT, undefined] });
    const failure = await fake.run().then(
      () => new Error("it was made"),
      (error: unknown) => error as Error,
    );
    expect(fake.calls).toEqual(["create", "find", "find", "find", "find"]);
    expect(fake.waits).toEqual([5, 10, 20]);
    expect(failure.message).toMatch(
      /^sessions\.create for agent:pip:weekend-trip was refused, and the gateway doesn't list agent:pip:weekend-trip: openclaw .* failed:\n/,
    );
    expect(failure.message).toContain("session changed before sessions.create");
  });

  it("throws any other refusal at once", async () => {
    const fake = gateway({ creates: [OTHER_REFUSAL], finds: [] });
    await expect(fake.run()).rejects.toBe(OTHER_REFUSAL);
    expect(fake.calls).toEqual(["create"]);
  });

  it("throws the last timeout when the gateway never answers", async () => {
    const fake = gateway({
      creates: [TIMEOUT, TIMEOUT, TIMEOUT, TIMEOUT],
      finds: [undefined, undefined, undefined],
    });
    await expect(fake.run()).rejects.toBe(TIMEOUT);
    expect(fake.calls).toEqual(["create", "find", "create", "find", "create", "find", "create"]);
  });
});
