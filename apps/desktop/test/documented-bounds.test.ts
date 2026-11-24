// The retention totals `docs/decisions.md` states are the arithmetic over the
// named constants: each item, a task, the state, a viewer's snapshot, and the
// host with its web viewers, computed here from the code's own values.

import {
  APPROVAL,
  hostWorstCase,
  hostWorstTotal,
  MAX_VIEWER_OPEN_TASKS,
  MAX_VIEWER_PENDING_COMMANDS,
  OUTGOING,
  QUESTION,
  RUN,
  STATE,
  STEP,
  TRANSCRIPT,
  WORST_STATE_CHARS,
  WORST_TASK_CHARS,
  worstCase,
  worstViewerChars,
} from "@clawtrate/core";
import { readFileSync } from "node:fs";
import { assert, describe, expect, it } from "vitest";
import {
  MAX_RESULT_CHARS,
  MAX_SNAPSHOTS_IN_FLIGHT,
  MAX_UNACCEPTED_RESULTS,
  MAX_WEB_VIEWERS,
} from "../src/web-host/server.ts";

const docs = readFileSync(new URL("../../../docs/decisions.md", import.meta.url), "utf8");
/** Each table row's cells, trimmed. */
const rows = docs
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith("|"))
  .map((line) =>
    line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim()),
  );
/** Numbers as the documentation writes them, digits grouped by commas. */
const written = (value: number) => value.toLocaleString("en-US");
/** The table row whose first cell is `name`, and its last cell. */
const lastCell = (name: string) => rows.find((cells) => cells[0] === name)?.at(-1);

describe("the documented retention totals", () => {
  const limits = {
    viewers: MAX_WEB_VIEWERS,
    snapshotsInFlight: MAX_SNAPSHOTS_IN_FLIGHT,
    openTasksPerViewer: MAX_VIEWER_OPEN_TASKS,
    commandsPerViewer: MAX_UNACCEPTED_RESULTS,
    resultChars: MAX_RESULT_CHARS,
  };

  it("are the arithmetic over the constants", () => {
    assert(TRANSCRIPT.kind === "object");
    const rows: Array<[string, number]> = [
      ["Step", worstCase(STEP)],
      ["Run", worstCase(RUN)],
      ["Outgoing message", worstCase(OUTGOING)],
      ["Question card", worstCase(QUESTION)],
      ["Approval card", worstCase(APPROVAL)],
      ["History page", worstCase(TRANSCRIPT.fields.items!)],
      ["Per task", WORST_TASK_CHARS],
      ["State", WORST_STATE_CHARS],
      ["One viewer's snapshot", worstViewerChars(MAX_VIEWER_OPEN_TASKS)],
      ["Host", hostWorstTotal(limits)],
    ];
    for (const [name, value] of rows) expect(lastCell(name), name).toBe(written(value));
    for (const [part, value] of Object.entries(hostWorstCase(limits))) {
      expect(lastCell(`\`${part}\``), part).toBe(written(value));
    }
    // The connection's own cap, written inside the task list's row.
    assert(STATE.kind === "object");
    const listRow = docs.split("\n").find((line) => line.includes("| Task list, connection"));
    expect(listRow).toContain(`connection ${written(worstCase(STATE.fields.connection!))},`);
  });

  it("count each viewer's results at its command slots", () => {
    expect(MAX_UNACCEPTED_RESULTS).toBe(MAX_VIEWER_PENDING_COMMANDS);
  });
});
