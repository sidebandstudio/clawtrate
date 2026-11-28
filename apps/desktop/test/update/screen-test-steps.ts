// Only linked by the standalone update check, and read by its runner. Times the
// two steps Windows runs in PowerShell, making an offer's folders and reading a
// download back, so every run's log says how long each took and a failure's host
// state says which one it stopped in (#577). It keeps step names, times and
// outcomes, never a path, an address or an error's message, which can name the file.
import { appendFileSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";

const STEP_LOG = "update-steps.jsonl";

/** A step's start, or with `ms` its end. */
type Line = { step: string; at: number; ms?: number; outcome?: string };

export type Step =
  | {
      readonly step: string;
      readonly at: string;
      /** How long it took, from its end record. */
      readonly ms?: number;
      readonly outcome?: string;
      /** No end was read. The step may still run, or its app ended or couldn't write the end. */
      readonly endUnknown?: true;
    }
  /** How many lines in a row couldn't be read here; their text is never kept. */
  | { readonly unreadable: number };

/** An error's signal or code, never its message. */
function threw(error: unknown): string {
  const { code, signal } = (error ?? {}) as { code?: unknown; signal?: unknown };
  if (typeof signal === "string" && Object.hasOwn(constants.signals, signal))
    return `threw ${signal}`;
  if (typeof code === "string" && Object.hasOwn(constants.errno, code)) return `threw ${code}`;
  if (typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255)
    return `threw ${code}`;
  return "threw";
}

/** Runs one step, appending its start and then its end to the log in the app's profile folder. */
export async function timeStep<T>(
  profile: string,
  step: string,
  work: () => Promise<T>,
  outcome: (value: T) => string,
  now: () => number = Date.now,
): Promise<T> {
  const write = (line: Line) => {
    try {
      // On a line of its own, even after an app that ended partway through writing one.
      appendFileSync(join(profile, STEP_LOG), "\n" + JSON.stringify(line) + "\n");
    } catch {
      // The step outranks its timing.
    }
  };
  const at = now();
  write({ step, at });
  let value: T;
  try {
    value = await work();
  } catch (error) {
    write({ step, at, ms: now() - at, outcome: threw(error) });
    throw error;
  }
  write({ step, at, ms: now() - at, outcome: outcome(value) });
  return value;
}

/** One line of the log, or null for a torn or foreign one. */
function parse(text: string): Line | null {
  try {
    const line = JSON.parse(text) as Partial<Record<keyof Line, unknown>> | null;
    if (
      typeof line?.step === "string" &&
      typeof line.at === "number" &&
      !Number.isNaN(new Date(line.at).getTime()) &&
      (line.ms === undefined || Number.isFinite(line.ms)) &&
      (line.outcome === undefined || typeof line.outcome === "string")
    )
      return line as Line;
  } catch {
    // Counted below.
  }
  return null;
}

/** Every step in the log, oldest first, and where lines couldn't be read. Null without a log. */
export function readSteps(profile: string): Step[] | null {
  let log: string;
  try {
    log = readFileSync(join(profile, STEP_LOG), "utf8");
  } catch {
    return null;
  }
  const entries: (Line | { unreadable: number })[] = [];
  // A line torn when an app ended, or one the app is still writing, counts as unreadable.
  for (const raw of log.split("\n")) {
    if (!raw) continue;
    const line = parse(raw);
    if (!line) {
      const last = entries.at(-1);
      if (last && "unreadable" in last) last.unreadable++;
      else entries.push({ unreadable: 1 });
      continue;
    }
    const started =
      line.ms !== undefined &&
      entries.findLast(
        (each): each is Line =>
          "step" in each && each.step === line.step && each.at === line.at && each.ms === undefined,
      );
    if (started) Object.assign(started, line);
    else entries.push({ ...line });
  }
  return entries.map((each): Step => {
    if ("unreadable" in each) return { unreadable: each.unreadable };
    const { step, at, ms, outcome } = each;
    return {
      step,
      at: new Date(at).toISOString(),
      ...(ms === undefined ? { endUnknown: true as const } : { ms }),
      ...(outcome !== undefined && { outcome }),
    };
  });
}
