import { describe, expect, it } from "vitest";
import {
  engineSummary,
  judgeEngine,
  type EngineEntry,
  type EnginePlan,
  type EngineView,
} from "../src/engine-record.ts";

const RUN = "5b3e3f4e-8c1a-4a57-9d2f-0c1f1d6f7a10";
const PRESS = { requester: { channel: "webchat", senderId: "clawtrate-update:1" } };
const PLAN: EnginePlan = { reconnects: 2 };

const view = (
  overrides: Partial<EngineView> = {},
  run: Partial<NonNullable<EngineView["run"]>> | null = null,
): EngineView => ({
  status: "connected",
  gatewayId: "gw",
  serverVersion: "2026.10.6",
  canAdmin: true,
  offer: "2026.11.10",
  run:
    run === null
      ? null
      : {
          runId: RUN,
          gatewayId: "gw",
          mine: true,
          phase: "requested",
          outcome: "running",
          from: "2026.10.6",
          to: "2026.11.10",
          reported: null,
          ...run,
        },
  starting: false,
  looking: false,
  error: null,
  ...overrides,
});

let clock = 0;
const at = () => (clock += 100);
const sent = (socket: number, id: string, method: string, params: unknown = null): EngineEntry => ({
  at: at(),
  kind: "sent",
  socket,
  id,
  method,
  params,
});
const answer = (socket: number, id: string, ok = true): EngineEntry => ({
  at: at(),
  kind: "answer",
  socket,
  id,
  ok,
  payload: null,
});
const state = (v: EngineView): EngineEntry => ({ at: at(), kind: "state", view: v });
const mark = (name: string, detail?: string): EngineEntry => ({
  at: at(),
  kind: "mark",
  name,
  ...(detail ? { detail } : {}),
});
const hello = (socket: number): EngineEntry => ({ at: at(), kind: "hello", socket });

/** A run that went as #569 means it to: connect, reconnects, confirmation, press, updated. */
function trace(): EngineEntry[] {
  clock = 0;
  return [
    sent(1, "c1", "connect"),
    answer(1, "c1"),
    hello(1),
    sent(1, "i1", "gateway.identity.get"),
    state(view()),
    mark("reconnect"),
    sent(2, "c2", "connect"),
    hello(2),
    sent(2, "i2", "gateway.identity.get"),
    mark("reconnected"),
    mark("reconnect"),
    sent(3, "c3", "connect"),
    hello(3),
    sent(3, "i3", "gateway.identity.get"),
    mark("reconnected"),
    mark("confirm"),
    sent(3, "s1", "update.status"),
    answer(3, "s1"),
    mark("press"),
    sent(3, "i4", "gateway.identity.get"),
    sent(3, "r1", "update.run", PRESS),
    answer(3, "r1"),
    state(view({}, { phase: "validating" })),
    sent(4, "c4", "connect"),
    hello(4),
    state(view({ serverVersion: "2026.11.10" }, { phase: "finished", outcome: "updated" })),
    sent(4, "m1", "models.list"),
  ];
}

describe("the engine's verdict", () => {
  it("passes a run that went as #569 means it to", () => {
    const verdict = judgeEngine(trace(), PLAN);
    expect(verdict.failures).toEqual([]);
    expect(verdict.facts).toMatchObject({
      updateRequestsBeforeConfirm: [],
      statusOnConfirm: 1,
      presses: 1,
      modelReadsAfterUpdated: 1,
      updateRequestsAfterUpdated: [],
      serverVersion: "2026.11.10",
    });
    expect(verdict.facts.outcomes.map((o) => `${o.outcome}/${o.phase}`)).toEqual([
      "running/validating",
      "updated/finished",
    ]);
    expect(engineSummary(verdict, "engine")).toContain("(engine): passed");
  });

  it("fails an update request on a plain reconnect, and too few reconnects", () => {
    const entries = trace();
    entries.splice(8, 0, sent(2, "x", "update.status"));
    expect(judgeEngine(entries, PLAN).failures).toEqual([
      "asked update.status before anything asked it to",
    ]);
    expect(judgeEngine(trace(), { reconnects: 3 }).failures).toEqual([
      "2 reconnects were seen, not 3",
    ]);
  });

  it("fails a confirmation that asks update.status other than once", () => {
    const twice = trace();
    twice.splice(17, 0, sent(3, "s2", "update.status"));
    expect(judgeEngine(twice, PLAN).failures).toEqual([
      "opening the confirmation asked update.status 2 times, not once",
    ]);
  });

  it("fails a second update.run, an untagged one, or one with no identity read on its connection", () => {
    const twice = [...trace(), sent(4, "r2", "update.run", PRESS)];
    expect(judgeEngine(twice, PLAN).failures).toEqual([
      "update.run was sent 2 times, not once",
      'asked update.run after "updated"',
    ]);
    const bare = trace().map((e) =>
      e.kind === "sent" && e.method === "update.run" ? { ...e, params: {} } : e,
    );
    expect(judgeEngine(bare, PLAN).failures).toEqual(["update.run was sent with {}"]);
    const elsewhere = trace().map((e) =>
      e.kind === "sent" && e.method === "update.run" ? { ...e, socket: 9 } : e,
    );
    expect(judgeEngine(elsewhere, PLAN).failures).toEqual([
      "update.run was sent with no identity read on its connection",
    ]);
  });

  it("fails an outcome other than updated, another device's run, or a version mismatch", () => {
    const last = (run: Partial<NonNullable<EngineView["run"]>>, version = "2026.11.10") => {
      const entries = trace();
      entries.splice(25, 1, state(view({ serverVersion: version }, { phase: "finished", ...run })));
      return judgeEngine(entries, PLAN).failures;
    };
    expect(last({ outcome: "unconfirmed" })).toEqual(["the engine's outcome is unconfirmed"]);
    expect(last({ outcome: "updated", mine: false })).toEqual([
      "the engine showed the run as mine: false",
    ]);
    expect(last({ outcome: "updated" }, "2026.11.9")).toEqual([
      '"updated" to 2026.11.10, but the gateway reports 2026.11.9',
    ]);
  });

  it("fails a model list read more than once after updated, or an update request after it", () => {
    const twice = [...trace(), sent(4, "m2", "models.list")];
    expect(judgeEngine(twice, PLAN).failures).toEqual([
      'the model list was read 2 times after "updated", not once',
    ]);
    const asked = [...trace(), sent(4, "g1", "update.runs.get")];
    expect(judgeEngine(asked, PLAN).failures).toEqual(['asked update.runs.get after "updated"']);
  });

  it("checks a lost answer is settled by asking update.status first, with no second press", () => {
    const plan: EnginePlan = { ...PLAN, dropAnswer: true };
    const dropped = (first: string, answered = false): EngineEntry[] => {
      const entries = trace();
      const press = entries.findIndex((e) => e.kind === "sent" && e.method === "update.run");
      entries.splice(
        press + 1,
        1,
        ...(answered ? [answer(3, "r1")] : []),
        mark("dropped"),
        sent(5, "c5", "connect"),
        hello(5),
        sent(5, "a1", first),
        sent(5, "a2", "update.runs.list"),
      );
      return entries;
    };
    const verdict = judgeEngine(dropped("update.status"), plan);
    expect(verdict.failures).toEqual([]);
    expect(verdict.facts.afterDrop).toEqual(["update.status", "update.runs.list"]);
    expect(judgeEngine(dropped("update.runs.get"), plan).failures).toEqual([
      "after the drop the engine asked update.runs.get first, not update.status",
    ]);
    expect(judgeEngine(dropped("update.status", true), plan).failures).toEqual([
      "the update.run answer arrived before the connection dropped",
    ]);
  });

  it("checks Update stays held after a reopen until the gateway's status answers", () => {
    const plan: EnginePlan = { ...PLAN, reopen: true };
    const reopened = (held: boolean, refused = true): EngineEntry[] => {
      const entries = trace();
      const validating = entries.findIndex(
        (e) => e.kind === "state" && e.view.run?.phase === "validating",
      );
      entries.splice(
        validating + 1,
        0,
        mark("reopen"),
        sent(6, "c6", "connect"),
        hello(6),
        state(view({}, held ? { phase: "validating" } : null)),
        mark(refused ? "press-refused" : "press-accepted", "An update may be under way."),
        sent(6, "s6", "update.status"),
        answer(6, "s6"),
      );
      return entries;
    };
    const verdict = judgeEngine(reopened(true), plan);
    expect(verdict.failures).toEqual([]);
    expect(verdict.facts.heldOnReopen).toBe(true);
    expect(judgeEngine(reopened(false), plan).failures).toEqual([
      "Update was not held after the reopen before the status answered",
    ]);
    expect(judgeEngine(reopened(true, false), plan).failures).toEqual([
      "a press right after the reopen was not refused",
    ]);
  });
});
