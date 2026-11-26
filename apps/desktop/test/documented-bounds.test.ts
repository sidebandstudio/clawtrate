// The retention figures `docs/decisions.md` states are the arithmetic over the
// named constants: each item, a task, the state, a viewer's snapshot, and the
// host with its web viewers, computed here from the code's own values. The
// item, task and state tables are checked figure by figure, row by row.

import {
  ACCOUNTS,
  APPROVAL,
  type Bound,
  CHECK_INS,
  COMPUTER,
  CREATION,
  hostWorstCase,
  hostWorstTotal,
  MAX_CHECKIN_PROMPT_CHARS,
  MAX_PENDING_APPROVAL_COUNT,
  MAX_PENDING_QUESTIONS_PER_TASK,
  MAX_SETTLED_APPROVAL_COUNT,
  MAX_SETTLED_QUESTION_COUNT,
  MAX_VIEWER_OPEN_TASKS,
  MAX_VIEWER_PENDING_COMMANDS,
  OUTGOING,
  QUESTION,
  ROUTINES,
  RUN,
  STATE,
  STEP,
  TRANSCRIPT,
  USAGE,
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

/** The bound at `path` beneath `bound`: field names, `item` for a list's item, `value` for a map's. */
function at(bound: Bound, path: string): Bound {
  return path.split(".").reduce((each, step) => {
    if (each.kind === "object" && each.fields[step]) return each.fields[step];
    if (each.kind === "list" && step === "item") return each.item;
    if (each.kind === "map" && step === "value") return each.value;
    throw new Error(`No ${step} in a ${each.kind} bound`);
  }, bound);
}
/** The count or cap of the bound at `path`. */
function max(bound: Bound, path: string): number {
  const found = at(bound, path);
  assert(found.kind !== "object" && found.kind !== "union", path);
  return found.max;
}
/** The cap on the keys of the map at `path`. */
function key(bound: Bound, path: string): number {
  const found = at(bound, path);
  assert(found.kind === "map", path);
  return found.key;
}
/** The worst case of the bound at `path`. */
const size = (bound: Bound, path: string) => worstCase(at(bound, path));
/** The worst case of one item of the list at `path`, without the lists that draw on its pools. */
function alone(bound: Bound, path: string): number {
  const list = at(bound, path);
  assert(list.kind === "list" && list.pools, path);
  return worstCase(list.item, new Map(Object.keys(list.pools).map((pool) => [pool, 0])));
}
/** How many items the lists beneath the list at `path` share from its pool `name`. */
function pool(bound: Bound, path: string, name: string): number {
  const list = at(bound, path);
  assert(list.kind === "list" && list.pools?.[name] !== undefined, `${path} ${name}`);
  return list.pools[name];
}
const sum = (parts: Row[]) => parts.reduce((total, [, , figure]) => total + figure, 0);

/**
 * A row of the item, task or state table: its name, the figures its middle
 * cell quotes, in order, and its own figure. A part's figure is its worst case
 * without its field name: the field names are counted in "the rest".
 */
type Row = [name: string, quotes: number[], figure: number];

const T = TRANSCRIPT;
const items: Row[] = [
  ["Step", [max(STEP, "files.paths")], worstCase(STEP)],
  ["Run", [worstCase(RUN, new Map([["steps", 0]]))], worstCase(RUN)],
  ["Outgoing message", [max(OUTGOING, "attachments")], worstCase(OUTGOING)],
  [
    "Question card",
    [max(QUESTION, "questions"), max(QUESTION, "questions.item.options")],
    worstCase(QUESTION),
  ],
  ["Approval card", [max(APPROVAL, "exec.commandArgv")], worstCase(APPROVAL)],
];
const taskParts: Row[] = [
  [
    "Runs",
    [max(T, "runs"), alone(T, "runs"), pool(T, "runs", "steps"), worstCase(STEP)],
    size(T, "runs"),
  ],
  ["Outbox", [max(T, "outbox"), worstCase(OUTGOING)], size(T, "outbox")],
  [
    "Questions",
    [MAX_PENDING_QUESTIONS_PER_TASK, MAX_SETTLED_QUESTION_COUNT, worstCase(QUESTION)],
    size(T, "questions"),
  ],
  [
    "Approvals",
    [MAX_PENDING_APPROVAL_COUNT, MAX_SETTLED_APPROVAL_COUNT, worstCase(APPROVAL)],
    size(T, "approvals"),
  ],
  [
    "History page",
    [
      max(T, "items"),
      alone(T, "items"),
      pool(T, "items", "blocks"),
      size(T, "items.item.blocks.item"),
      pool(T, "items", "pictures"),
      size(T, "items.item.pictures.item"),
      pool(T, "items", "files"),
      size(T, "items.item.files.item"),
      pool(T, "items", "attachments"),
      size(T, "items.item.attachments.item"),
    ],
    size(T, "items"),
  ],
  [
    "Inter-session messages",
    [max(T, "interSession"), size(T, "interSession.item")],
    size(T, "interSession"),
  ],
  [
    "Linked runs",
    [max(T, "linkedRuns"), key(T, "linkedRuns"), size(T, "linkedRuns.value")],
    size(T, "linkedRuns"),
  ],
  [
    "Steer aliases",
    [max(T, "steerAliases"), key(T, "steerAliases"), size(T, "steerAliases.value")],
    size(T, "steerAliases"),
  ],
  [
    "Queue aliases",
    [max(T, "queueAliases"), key(T, "queueAliases"), size(T, "queueAliases.value")],
    size(T, "queueAliases"),
  ],
  ["Tool map", [max(T, "mcpTools")], size(T, "mcpTools")],
  [
    "Tool inventory and workspace root",
    [max(T, "builtinTools")],
    size(T, "builtinTools") + size(T, "workspaceRoot"),
  ],
  [
    "Reactions",
    [
      max(T, "reactions"),
      key(T, "reactions"),
      max(T, "reactions.value"),
      size(T, "reactions.value.item"),
    ],
    size(T, "reactions"),
  ],
];
const task: Row[] = [
  ...taskParts,
  [
    "Streaming text, ids, error and the rest",
    [max(T, "live.text")],
    WORST_TASK_CHARS - sum(taskParts),
  ],
  ["Per task", [], WORST_TASK_CHARS],
];
const S = STATE;
const stateParts: Row[] = [
  ["Transcripts", [max(S, "transcripts"), size(S, "transcripts.value")], size(S, "transcripts")],
  ["Bots", [max(S, "bots"), size(S, "bots.item")], size(S, "bots")],
  [
    "Unrouted approvals",
    [max(S, "unroutedApprovals"), worstCase(APPROVAL)],
    size(S, "unroutedApprovals"),
  ],
  ["Task creations", [max(S, "creations"), worstCase(CREATION)], size(S, "creations")],
  [
    "Accounts",
    [
      max(ACCOUNTS, "accounts"),
      max(ACCOUNTS, "methods"),
      max(ACCOUNTS, "keyProviders"),
      max(ACCOUNTS, "models"),
      max(ACCOUNTS, "modelsCut"),
      max(ACCOUNTS, "bindings"),
    ],
    size(S, "accounts"),
  ],
  [
    "Routines",
    [max(ROUTINES, "routines"), max(ROUTINES, "routines.item.text")],
    size(S, "routines"),
  ],
  [
    "Usage",
    [
      max(USAGE, "budgets"),
      max(USAGE, "limits.providers"),
      max(USAGE, "limits.providers.item.windows"),
    ],
    size(S, "usage"),
  ],
  [
    "Check-ins",
    [max(CHECK_INS, "settings"), max(CHECK_INS, "defaults.inherited"), MAX_CHECKIN_PROMPT_CHARS],
    size(S, "checkIns"),
  ],
  [
    "Computer tab",
    [max(COMPUTER, "panes"), max(COMPUTER, "panes.value.tabs"), max(COMPUTER, "control")],
    size(S, "computer"),
  ],
  ["Bot names", [max(S, "botNames")], size(S, "botNames")],
  ["Bot name changes", [max(S, "botNameRecord.changes")], size(S, "botNameRecord")],
];
const state: Row[] = [
  ...stateParts,
  [
    "Task list, connection and the rest",
    [
      max(S, "tasksByBot.value"),
      size(S, "tasksByBot.value.item"),
      max(S, "tasksByBot"),
      size(S, "connection"),
    ],
    WORST_STATE_CHARS - sum(stateParts),
  ],
  ["State", [], WORST_STATE_CHARS],
  ["One viewer's snapshot", [MAX_VIEWER_OPEN_TASKS], worstViewerChars(MAX_VIEWER_OPEN_TASKS)],
];

/** A figure a cell quotes: a whole number, not digits inside a name. */
const FIGURE = /(?<![\w-])\d(?:[\d,]*\d)?(?!\w)/g;
const figures = (cell: string) =>
  [...cell.matchAll(FIGURE)].map(([each]) => Number(each.replaceAll(",", "")));

/**
 * What is wrong with the rows of the tables between `from` and `to`, each
 * with the line it should be.
 */
function check(from: string, to: string, expected: Row[]): string[] {
  const lines = docs.split("\n");
  const start = lines.findIndex((line) => line.startsWith(from));
  const end = lines.findIndex((line, index) => index > start && line.startsWith(to));
  assert(start >= 0 && end > start, `${from} … ${to}`);
  const byName = new Map(expected.map((row) => [row[0], row]));
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const line of lines.slice(start, end)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|");
    // Indentation, name, the middle cell, the figure, and what follows the last bar.
    if (cells.length !== 5) {
      problems.push(`A row of three cells is expected here:\n${line}`);
      continue;
    }
    const name = cells[1]!.trim();
    if (/^-+$/.test(name) || cells[3]!.trim() === "JSON characters") continue;
    const row = byName.get(name);
    if (!row) {
      problems.push(`"${name}" is not checked: add its figures to documented-bounds.test.ts.`);
      continue;
    }
    seen.add(name);
    const [, quotes, figure] = row;
    const found = figures(cells[2]!);
    if (found.length !== quotes.length) {
      problems.push(
        `"${name}" quotes ${found.length} figures where ${quotes.length} are expected: ${quotes.map(written).join("; ")}.`,
      );
      continue;
    }
    if (
      found.every((each, index) => each === quotes[index]) &&
      cells[3]!.trim() === written(figure)
    )
      continue;
    let index = 0;
    cells[2] = cells[2]!.replace(FIGURE, () => written(quotes[index++]!));
    cells[3] = ` ${written(figure)} `.padStart(cells[3]!.length);
    problems.push(`"${name}" should read:\n${cells.join("|")}`);
  }
  for (const [name, , figure] of expected) {
    if (!seen.has(name)) problems.push(`"${name}" is missing; its figure is ${written(figure)}.`);
  }
  return problems;
}

describe("the documented retention totals", () => {
  const limits = {
    viewers: MAX_WEB_VIEWERS,
    snapshotsInFlight: MAX_SNAPSHOTS_IN_FLIGHT,
    openTasksPerViewer: MAX_VIEWER_OPEN_TASKS,
    commandsPerViewer: MAX_UNACCEPTED_RESULTS,
    resultChars: MAX_RESULT_CHARS,
  };

  it("are the arithmetic over the constants", () => {
    expect(lastCell("Host"), "Host").toBe(written(hostWorstTotal(limits)));
    for (const [part, value] of Object.entries(hostWorstCase(limits))) {
      expect(lastCell(`\`${part}\``), part).toBe(written(value));
    }
  });

  it("quote, row by row, the figures the code computes", () => {
    const problems = [
      ...check("- **The worst case of each item:**", "- **Per task**", items),
      ...check("- **Per task**", "- **The state**", task),
      ...check("- **The state**", "- **The host:**", state),
    ];
    assert(
      problems.length === 0,
      `docs/decisions.md is out of date. Replace each row below, then run ` +
        `\`pnpm exec prettier --write docs/decisions.md\` to realign the tables.\n\n` +
        problems.join("\n\n"),
    );
  });

  it("count each viewer's results at its command slots", () => {
    expect(MAX_UNACCEPTED_RESULTS).toBe(MAX_VIEWER_PENDING_COMMANDS);
  });
});
