// Retention is bounded by construction. These tests hold the construction to
// its claims: every retained field is declared with a bound (a field added
// without one does not compile), the totals are arithmetic over the named
// constants and are the ones `docs/decisions.md` states, and no input, of any
// size or shape, makes the enforced state larger than those totals. That
// `docs/decisions.md` states these totals is checked in the desktop app's
// tests, which can read files.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBridgeSession, MAX_VIEWER_OPEN_TASKS } from "../src/bridge.ts";
import {
  enforce,
  jsonTextLength,
  object,
  text,
  unknownKeys,
  worstCase,
  type Bound,
} from "../src/bounds.ts";
import {
  MAX_PENDING_APPROVAL_COUNT,
  MAX_PENDING_QUESTIONS_PER_TASK,
  MAX_RUN_TEXT_CHARS,
  MAX_TRACKED_TASKS,
  MAX_UNROUTED,
  STATE,
  TRANSCRIPT,
  enforceState,
  WORST_STATE_CHARS,
  WORST_TASK_CHARS,
  APPROVAL,
  OUTGOING,
  QUESTION,
  RUN,
  STEP,
} from "../src/state-bounds.ts";
import type { ClawtrateState } from "../src/types.ts";
import { agentEvent, KEY, openTask, questionRecord } from "./client-harness.ts";
import { until } from "./fake-gateway.ts";

describe("the totals", () => {
  it("are the same when computed by hand for a small schema", () => {
    const bound = object<{ a: string; b: string }>()({ a: text(10), b: text(4) });
    // {"a":<10>,"b":<4>}: braces, then per field its quoted name, a colon, the value and a comma.
    expect(worstCase(bound)).toBe(2 + (3 + 1 + 10 + 1) + (3 + 1 + 4 + 1));
    expect(JSON.stringify({ a: "12345678", b: "12" }).length).toBeLessThanOrEqual(worstCase(bound));
  });
});

describe("a retained type", () => {
  it("cannot gain a field without a bound", () => {
    type Grown = { a: string; added: string };
    // @ts-expect-error `added` has no bound.
    object<Grown>()({ a: text(10) });
    expect(true).toBe(true);
  });
});

// Adversarial values, generated from the schema itself, so every declared field is exercised.

type Shape = "maximal" | "string" | "object" | "number";
const long = (count: number) => '"'.repeat(count);
const strings = new Map<number, string>();
const quoteString = (count: number) => {
  let value = strings.get(count);
  if (!value) strings.set(count, (value = long(count)));
  return value;
};

/** A value past `bound` in every dimension (`maximal`), or of the wrong shape and very large. */
function adversary(bound: Bound, shape: Shape, depth = 0, variant = { n: 0 }): unknown {
  if (shape !== "maximal" && depth > 0) {
    if (shape === "string") return quoteString(1_000_000);
    if (shape === "number") return -1.234567890123456e-300;
    return { huge: quoteString(1_000_000) };
  }
  switch (bound.kind) {
    case "text":
      return quoteString(bound.max * 2);
    case "id":
      return "i".repeat(bound.max + 10);
    case "scalar":
      return quoteString(bound.max * 4);
    case "json":
      return { inner: "j".repeat(Math.max(0, bound.max - 12)) };
    case "list": {
      const items = Array.from({ length: bound.max + 3 }, () =>
        adversary(bound.item, "maximal", depth + 1, variant),
      );
      return items;
    }
    case "map": {
      const out: Record<string, unknown> = {};
      for (let i = 0; i < bound.max + 3; i += 1) {
        const key = `k${i}`.padEnd(Math.max(2, bound.key - 2), "k");
        out[key] = adversary(bound.value, "maximal", depth + 1, variant);
      }
      return out;
    }
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(bound.fields)) {
        out[key] = adversary(field, "maximal", depth + 1, variant);
      }
      return out;
    }
    case "union": {
      const tags = Object.keys(bound.variants);
      const tag = tags[(variant.n += 1) % tags.length]!;
      return {
        ...(adversary(bound.variants[tag]!, "maximal", depth, variant) as object),
        [bound.tag]: tag,
      };
    }
  }
}

/** Every field of `bound` set to a wrongly shaped, very large value. */
function wrongShapes(bound: Bound, shape: Exclude<Shape, "maximal">): unknown {
  if (bound.kind !== "object") return adversary(bound, shape, 1);
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(bound.fields)) {
    out[key] = field.kind === "object" ? wrongShapes(field, shape) : adversary(field, shape, 1);
  }
  return out;
}

const size = (value: unknown) => JSON.stringify(value)?.length ?? 0;

describe("no input exceeds the totals", () => {
  it(
    "a transcript past every bound is brought within the per-task total",
    { timeout: 120_000 },
    () => {
      const transcript = adversary(TRANSCRIPT, "maximal");
      const enforced = enforce(TRANSCRIPT, transcript);
      expect(size(enforced)).toBeLessThanOrEqual(WORST_TASK_CHARS);
      // The fixture is near the bound, so the bound is the one that held.
      expect(size(enforced)).toBeGreaterThan(WORST_TASK_CHARS / 4);
    },
  );

  // These build and measure states near the documented maximum, about 100 million characters:
  // seconds of work, more on a busy machine, so they are given the time it takes.
  it("a state past every bound is brought within the state total", { timeout: 120_000 }, () => {
    const state = adversary(STATE, "maximal") as ClawtrateState;
    const enforced = enforceState(state);
    const transcripts = Object.values(enforced.transcripts);
    expect(transcripts).toHaveLength(MAX_TRACKED_TASKS);
    // The state's JSON, measured in parts rather than built as one string of this size.
    let total = size({ ...enforced, transcripts: {} }) - 1;
    for (const [key, transcript] of Object.entries(enforced.transcripts)) {
      const each = size(transcript);
      expect(each).toBeLessThanOrEqual(WORST_TASK_CHARS);
      total += jsonTextLength(key) + 1 + each + 1;
    }
    expect(total).toBeLessThanOrEqual(WORST_STATE_CHARS);
  });

  it("an object inside a `cut` list is dropped, not kept past the bound", () => {
    const enforced = enforce(STEP, { cut: [{ unbounded: "x".repeat(100_000) }, "output.text"] });
    expect(size(enforced)).toBeLessThanOrEqual(worstCase(STEP));
    expect((enforced as { cut: unknown[] }).cut).toEqual(["output.text"]);
  });

  for (const shape of ["string", "object", "number"] as const) {
    it(
      `a ${shape} where any field belongs is brought within its bound`,
      { timeout: 120_000 },
      () => {
        for (const bound of [STEP, RUN, OUTGOING, QUESTION, APPROVAL, TRANSCRIPT, STATE]) {
          const enforced = enforce(bound, wrongShapes(bound, shape));
          expect(size(enforced)).toBeLessThanOrEqual(worstCase(bound));
        }
      },
    );
  }
});

/** The state's size within its totals, measured. */
function expectWithinTotals(state: ClawtrateState) {
  for (const transcript of Object.values(state.transcripts)) {
    expect(size(transcript)).toBeLessThanOrEqual(WORST_TASK_CHARS);
  }
  expect(size(state)).toBeLessThanOrEqual(WORST_STATE_CHARS);
}

/** Let the client take in what the gateway sent. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 100));

describe("the client keeps within the totals", () => {
  // Every key the engine writes is one the schema names.
  beforeAll(() => unknownKeys.clear());
  afterAll(() => expect([...unknownKeys]).toEqual([]));

  it("with 34 pending questions of a million characters each", async () => {
    const { client, gateway, transcript } = await openTask();
    try {
      await until(() => transcript().approvalAccess === "ready");
      gateway.emit("agent", agentEvent("qrun", 1, "lifecycle", { phase: "start" }));
      for (let i = 0; i < 34; i += 1) {
        const record = questionRecord(`ask_${i}`, "qrun");
        record.questions[0]!.question = "x".repeat(1_000_000);
        gateway.emit("question.requested", record);
      }
      await settle();
      const pending = transcript().questions.filter((each) => each.status === "pending");
      expect(pending).toHaveLength(MAX_PENDING_QUESTIONS_PER_TASK);
      expect(transcript().questionsOmitted).toBe(34 - MAX_PENDING_QUESTIONS_PER_TASK);
      expectWithinTotals(client.state);
    } finally {
      client.stop();
    }
  }, 30_000);

  it.each([
    // One viewer opens its own most, `MAX_VIEWER_OPEN_TASKS`; four reach the client's, `MAX_TRACKED_TASKS`.
    [1, MAX_VIEWER_OPEN_TASKS],
    [4, MAX_TRACKED_TASKS],
  ])(
    "with nine tasks asked for, of 30 questions each, across %i viewers: opens %i",
    async (count, expected) => {
      const { client, gateway } = await openTask();
      const viewers = Array.from({ length: count }, () => createBridgeSession(client));
      try {
        // The task the harness opened is let go, so the viewers have every slot.
        client.closeSession(KEY);
        const keys = Array.from({ length: 9 }, (_, i) => `agent:otto:questions-${i}`);
        const opened: string[] = [];
        const refused: string[] = [];
        for (const [i, key] of keys.entries()) {
          await viewers[i % count]!.apply({ type: "openSession", key }).then(
            () => opened.push(key),
            (error: Error) => refused.push(error.message),
          );
        }
        // What was opened is exactly what the bounds allow, and the rest were refused for them.
        expect(opened).toHaveLength(expected);
        expect(refused).toHaveLength(9 - expected);
        for (const message of refused) expect(message).toMatch(/open at once/);
        await until(() =>
          opened.every((key) => client.state.transcripts[key]?.approvalAccess === "ready"),
        );
        for (const key of opened) {
          gateway.emit("agent", agentEvent(`r-${key}`, 1, "lifecycle", { phase: "start" }, key));
          for (let j = 0; j < 30; j += 1) {
            const record = questionRecord(`ask_${j}`, `r-${key}`, key);
            record.questions[0]!.question = "q".repeat(1_000_000);
            gateway.emit("question.requested", record);
          }
        }
        await settle();
        for (const key of opened) {
          const pending = client.state.transcripts[key]!.questions.filter(
            (each) => each.status === "pending",
          );
          expect(pending).toHaveLength(MAX_PENDING_QUESTIONS_PER_TASK);
        }
        expect(Object.keys(client.state.transcripts).sort()).toEqual([...opened].sort());
        expectWithinTotals(client.state);
      } finally {
        viewers.forEach((viewer) => viewer.dispose());
        client.stop();
      }
    },
    30_000,
  );

  it("with 64 unrouted approvals of 2.1 million characters each", async () => {
    const { client, gateway, transcript } = await openTask();
    try {
      await until(() => transcript().approvalAccess === "ready");
      for (let i = 0; i < 64; i += 1) {
        gateway.emit("exec.approval.requested", {
          id: `unrouted-${i}`,
          request: {
            sessionKey: "agent:otto:unopened",
            command: `${i}:${"x".repeat(2_100_000)}`,
            allowedDecisions: ["allow-once", "deny"],
          },
          createdAtMs: 1,
          expiresAtMs: 9_000_000_000_000,
        });
      }
      await until(() => client.state.unroutedApprovals.length > 0);
      await settle();
      expect(client.state.unroutedApprovals).toHaveLength(MAX_UNROUTED);
      expect(size(client.state.unroutedApprovals)).toBeLessThanOrEqual(
        MAX_UNROUTED * worstCase(APPROVAL) + MAX_UNROUTED + 2,
      );
      for (const card of client.state.unroutedApprovals) {
        expect(card.cut).toContain("exec.command");
      }
      expectWithinTotals(client.state);
    } finally {
      client.stop();
    }
  }, 30_000);

  it("with 16 pending approvals and more for one task", async () => {
    const { client, gateway, transcript } = await openTask();
    try {
      await until(() => transcript().approvalAccess === "ready");
      for (let i = 0; i < MAX_PENDING_APPROVAL_COUNT + 8; i += 1) {
        gateway.emit("exec.approval.requested", {
          id: `ap-${i}`,
          request: {
            sessionKey: KEY,
            command: "uname -s",
            allowedDecisions: ["allow-once", "deny"],
          },
          createdAtMs: 1,
          expiresAtMs: 9_000_000_000_000,
        });
      }
      await until(() => transcript().approvals.length > 0);
      await settle();
      expect(transcript().approvals.filter((each) => each.status === "pending")).toHaveLength(
        MAX_PENDING_APPROVAL_COUNT,
      );
      expectWithinTotals(client.state);
    } finally {
      client.stop();
    }
  }, 30_000);

  it("with nine million quote characters of streamed text, counted as JSON", async () => {
    const { client, gateway, transcript } = await openTask();
    try {
      gateway.emit("agent", agentEvent("escape", 1, "assistant", { text: '"'.repeat(9_000_000) }));
      gateway.emit("agent", agentEvent("escape", 2, "assistant", { delta: '"'.repeat(9_000_000) }));
      await until(() => transcript().runs.length === 1);
      await settle();
      const run = transcript().runs[0]!;
      expect(jsonTextLength(run.text)).toBeLessThanOrEqual(MAX_RUN_TEXT_CHARS);
      expect(run.cut).toContain("text");
      expectWithinTotals(client.state);
    } finally {
      client.stop();
    }
  }, 30_000);
});
