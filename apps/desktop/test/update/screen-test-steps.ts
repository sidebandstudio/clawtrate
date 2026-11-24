// Only linked by the standalone update check, and read by its runner. Records
// when each step of a check or download starts and ends, so a failure's host
// state says which step it stopped in and for how long (#207). Step names,
// outcomes and times only: never a path, an address or a file's contents.
import type { DesktopUpdateState } from "@clawtrate/core";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const STEP_LOG = "update-steps.jsonl";

/** A state the screens show, which lasts until the next; or a step's start, or with `outcome` its end. */
type StepLine = { at: number } & ({ state: string } | { step: string; outcome?: string });

export interface Step {
  readonly state?: string;
  readonly step?: string;
  /** From the start of the last check or download. */
  readonly atMs: number;
  /** How long it took, or for the current state or a step still running, how long so far. */
  readonly ms: number;
  readonly outcome?: string;
  readonly current?: true;
  readonly running?: true;
}

/** A state's kind, the step after the last byte, or why it failed. */
function stateName(state: DesktopUpdateState): string {
  if (state.kind === "downloading") return state.step ?? "downloading";
  if (state.kind === "failed" || state.kind === "handoff-failed")
    return `${state.kind} ${state.reason}`;
  return state.kind;
}

/** An error's signal or code, never its message, which can name the file. */
function threw(error: unknown): string {
  const { code, signal } = (error ?? {}) as { code?: unknown; signal?: unknown };
  return `threw ${String(signal ?? code ?? "an error")}`;
}

/** Appends to the log in the app's profile folder. */
export function stepLog(profile: string, now: () => number = Date.now) {
  const write = (line: StepLine) => {
    try {
      appendFileSync(join(profile, STEP_LOG), JSON.stringify(line) + "\n");
    } catch {
      // The check under way outranks its diagnostics.
    }
  };
  return {
    state: (state: DesktopUpdateState) => write({ at: now(), state: stateName(state) }),
    async time<T>(step: string, work: () => Promise<T>, outcome: (value: T) => string) {
      write({ at: now(), step });
      let value: T;
      try {
        value = await work();
      } catch (error) {
        write({ at: now(), step, outcome: threw(error) });
        throw error;
      }
      write({ at: now(), step, outcome: outcome(value) });
      return value;
    },
  };
}

/** The last check's or download's states and steps, oldest first. Null without a log. */
export function readSteps(profile: string, now = Date.now()): Step[] | null {
  let lines: StepLine[];
  try {
    // The app may be writing a line as this reads: the text after the last line ending is dropped.
    const text = readFileSync(join(profile, STEP_LOG), "utf8");
    lines = text
      .split("\n")
      .slice(0, -1)
      .map((line) => JSON.parse(line) as StepLine);
  } catch {
    return null;
  }
  type Found = { state?: string; step?: string; at: number; end?: number; outcome?: string };
  const found: Found[] = [];
  let shown: Found | undefined;
  for (const line of lines) {
    if ("state" in line) {
      // A repeat, such as more bytes received, is the same state.
      if (line.state === shown?.state) continue;
      if (line.state === "checking" || line.state === "downloading") found.length = 0;
      if (shown) shown.end = line.at;
      found.push((shown = { state: line.state, at: line.at }));
    } else if (line.outcome === undefined) found.push({ step: line.step, at: line.at });
    else {
      const started = found.findLast((each) => each.step === line.step && each.end === undefined);
      if (started) Object.assign(started, { end: line.at, outcome: line.outcome });
    }
  }
  const start = found[0]?.at ?? now;
  return found.map(({ at, end, outcome, ...name }) => ({
    ...name,
    atMs: at - start,
    ms: (end ?? now) - at,
    ...(outcome !== undefined && { outcome }),
    ...(end === undefined &&
      (name.state === undefined ? { running: true as const } : { current: true as const })),
  }));
}
