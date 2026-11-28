// The seed ends only once the gateway's own turns in the bots' main tasks have ended, and stops
// when one ended badly (#576). The seed's messages in Marlow's tasks queue a notice for Marlow's
// main task, their parent, and the gateway runs it there as a turn of its own about 20 s after the
// seed's last run there. Nothing waited for it: on a loaded runner it ended failed after the seed,
// and the iPhone's Home check found "Marlow, a run failed". Here a stand-in gateway plays that
// task's row. Time is faked; nothing waits.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAIN_TASK_QUIET_MS,
  SEED_RUN_MS,
  SEEDED_MAIN_TASKS,
  settleTasks,
} from "../src/examples.ts";

const MARLOW_MAIN = "agent:marlow:main";
const SEED_RUN = "11111111-1111-4111-8111-111111111111";
const GATEWAY_RUN = "22222222-2222-4222-8222-222222222222";

type Turn = { startsAfterMs: number; endsAfterMs: number | null; row: Record<string, unknown> };

/** Marlow's main task: the seed's run ended when the wait begins, then the gateway's turn, if any. */
function standIn(turn: Turn | null) {
  const begun = Date.now();
  const request = vi.fn(async (method: string, params: { agentId?: string; search?: string }) => {
    expect(method).toBe("sessions.list");
    expect(params).toEqual({ agentId: "marlow", search: MARLOW_MAIN });
    const now = Date.now() - begun;
    const done = { key: MARLOW_MAIN, status: "done", lastRunId: SEED_RUN, endedAt: begun };
    if (!turn || now < turn.startsAfterMs) return { sessions: [done] };
    if (turn.endsAfterMs === null || now < turn.endsAfterMs) {
      return {
        sessions: [{ ...done, status: "running", hasActiveRun: true, lastRunId: GATEWAY_RUN }],
      };
    }
    return {
      sessions: [
        { ...done, lastRunId: GATEWAY_RUN, endedAt: begun + turn.endsAfterMs, ...turn.row },
      ],
    };
  });
  return { request: request as never, calls: request };
}

/** The wait's outcome, and how long it took, once the faked time has run out. */
async function settle(op: { request: never }, runForMs: number) {
  const begun = Date.now();
  let outcome: { ok: true } | { ok: false; error: Error } | null = null;
  let tookMs = -1;
  void settleTasks(op, [MARLOW_MAIN]).then(
    () => ((outcome = { ok: true }), (tookMs = Date.now() - begun)),
    (error: Error) => ((outcome = { ok: false, error }), (tookMs = Date.now() - begun)),
  );
  await vi.advanceTimersByTimeAsync(runForMs);
  return { outcome: outcome as typeof outcome, tookMs };
}

/** When the gateway's notice turn comes: about 20 s after the seed's last run there. */
const NOTICE_AT_MS = 21_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the seed waits for the gateway's own turns in the main tasks (#576)", () => {
  it("waits for Marlow's main task, which the seed opens and Pip messages", () => {
    expect(SEEDED_MAIN_TASKS).toContain(MARLOW_MAIN);
  });

  it("waits longer than the gateway's 20 s before it runs a notice there", () => {
    expect(MAIN_TASK_QUIET_MS).toBeGreaterThan(20_000);
  });

  it("stops the seed when the gateway's turn there ends failed, naming it", async () => {
    const op = standIn({
      startsAfterMs: NOTICE_AT_MS,
      endsAfterMs: NOTICE_AT_MS + 2_000,
      row: {
        status: "failed",
        lastRunError: "Session event admission no longer owns its destination",
      },
    });
    const { outcome } = await settle(op, 5 * 60_000);
    expect(outcome).toMatchObject({ ok: false });
    const message = (outcome as unknown as { error: Error }).error.message;
    expect(message).toContain(MARLOW_MAIN);
    expect(message).toContain(GATEWAY_RUN);
    expect(message).toContain(
      "ended failed (Session event admission no longer owns its destination)",
    );
  });

  it("ends once that turn ended well and the task has had no run since for the stated time", async () => {
    const op = standIn({ startsAfterMs: NOTICE_AT_MS, endsAfterMs: NOTICE_AT_MS + 2_000, row: {} });
    const { outcome, tookMs } = await settle(op, 5 * 60_000);
    expect(outcome).toEqual({ ok: true });
    expect(tookMs).toBeGreaterThanOrEqual(NOTICE_AT_MS + 2_000 + MAIN_TASK_QUIET_MS);
    expect(tookMs).toBeLessThan(NOTICE_AT_MS + 2_000 + MAIN_TASK_QUIET_MS + 5_000);
  });

  it("ends after the stated time when no turn comes", async () => {
    const { outcome, tookMs } = await settle(standIn(null), 5 * 60_000);
    expect(outcome).toEqual({ ok: true });
    expect(tookMs).toBeGreaterThanOrEqual(MAIN_TASK_QUIET_MS);
    expect(tookMs).toBeLessThan(MAIN_TASK_QUIET_MS + 5_000);
  });

  it("counts an end the gateway marked not to show as no failure, as the app does", async () => {
    // 2026.11.10's end of a turn no person asked for that answered nothing.
    const op = standIn({
      startsAfterMs: NOTICE_AT_MS,
      endsAfterMs: NOTICE_AT_MS + 2_000,
      row: {
        status: "failed",
        lastRunError: "No answer was returned. Ask again if you still need one.",
        suppressErrorNotice: true,
      },
    });
    const { outcome } = await settle(op, 5 * 60_000);
    expect(outcome).toEqual({ ok: true });
  });

  it("stops the seed when that turn never ends, after a stated limit", async () => {
    const op = standIn({ startsAfterMs: NOTICE_AT_MS, endsAfterMs: null, row: {} });
    const limit = MAIN_TASK_QUIET_MS + SEED_RUN_MS;
    const { outcome, tookMs } = await settle(op, limit + 5_000);
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as unknown as { error: Error }).error.message).toBe(
      `${MARLOW_MAIN} still had a run after ${limit / 1000} s`,
    );
    expect(tookMs).toBeGreaterThanOrEqual(limit);
  });
});
