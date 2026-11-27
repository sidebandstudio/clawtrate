// What a person sees after a reload of a task whose gateway turn ended with reasoning only (#766),
// built from OpenClaw 2026.11.10's history and task row as a development gateway kept them, names
// made up: the failed-turn card the app showed while it followed the run, with the gateway's words,
// for an earlier turn. Without the gateway's mark (2026.10.6 never sends it) the run is drawn as
// history built it, as before.

import { failedByRow, RawTable, runsFromHistory } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { endingOf, failedTurnTitle, forEarlierMessage } from "../src/live.ts";

const KEY = "agent:otto:disk-space";
const NOW = 1_795_000_000_000;
const QUIET = "No answer was returned. Ask again if you still need one.";

const rows = [
  {
    role: "user",
    content: "Exec completed (otto-job, code 0) :: the command finished",
    timestamp: NOW,
    idempotencyKey: "evt-1",
    provenance: { kind: "internal_system", sourceTool: "cron" },
    __openclaw: { id: "e-1", idempotencyKey: "evt-1", seq: 1 },
  },
  ...[2, 3, 4].map((seq) => ({
    role: "assistant",
    content: [{ type: "thinking", thinking: "Only thinking, no answer." }],
    stopReason: "stop",
    timestamp: NOW + seq,
    __openclaw: { runId: "wake-1", id: `t-${seq}`, seq },
  })),
];

const row = (mark: boolean) => ({
  key: KEY,
  status: "failed",
  lastRunId: "wake-1",
  lastRunError: QUIET,
  suppressErrorNotice: mark,
});

const reloaded = (mark: boolean) =>
  failedByRow(
    runsFromHistory(rows, null, { sessionKey: KEY, now: NOW + 9_000, raw: new RawTable() }),
    rows,
    row(mark),
    {},
  )[0]!;

describe("#766: a gateway turn that ended with reasoning only, after a reload", () => {
  it("2026.11.10: the failed-turn card again, with the gateway's words, for an earlier turn", () => {
    const run = reloaded(true);
    expect(endingOf(run)).toEqual({ kind: "failed", reason: QUIET });
    expect(forEarlierMessage(run, { outbox: [] })).toBe(true);
    expect(failedTurnTitle("Otto", true)).toBe("Otto couldn't finish an earlier turn");
  });

  it("without the mark, the run is drawn as history built it: no card", () => {
    expect(endingOf(reloaded(false))).toBeNull();
  });
});
