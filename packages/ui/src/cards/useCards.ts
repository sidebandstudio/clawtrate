// The cards of one task, from the engine's state. `selectMessageCards` is the
// engine's own view over the task's steps; this hook only feeds it the
// previous selection, so states move forward only, and the whole raw payload
// of a call whose payload was too long to travel with the snapshot.

import {
  BOT_MESSAGE_TOOL,
  selectMessageCards,
  T3_CODE_TOOLS,
  type ClawtrateBridge,
  type SelectedCards,
  type Step,
  type StepRaw,
  type StepRead,
  type Transcript,
} from "@clawtrate/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RawContent } from "./raw.ts";

/** A call's raw payload, as far as this view knows it. */
export type StepRawState =
  | {
      state: "available";
      raw: StepRaw | null;
      load: () => void;
      /** The gateway's cut of the payload, with the engine's reason, when that is all there is. */
      cut?: string;
    }
  | { state: "pending"; content: RawContent; load: () => void };

/** Whole reads this view keeps while it is mounted; older ones are read again when needed. */
const MAX_READS = 24;
/** Whole reads this view has on their way at once; the engine refuses past its own `MAX_FULL_READS` (4). */
const MAX_READS_IN_FLIGHT = 2;

/** What a whole read answered, kept for this view. Only `available` carries the step's whole payload. */
function readOf(answer: StepRead | null, correction: number): Read {
  if (!answer) return { status: "failed" };
  switch (answer.status) {
    case "available":
      return { status: "available", raw: answer.raw, correction };
    case "cut-by-gateway":
      return { status: "cut", raw: answer.raw, reason: answer.reason };
    case "not-available-yet":
    case "not-established":
    case "too-large-for-gateway":
      return { status: "not-yet", reason: answer.reason };
  }
}

type Read =
  | { status: "loading" }
  | { status: "available"; raw: StepRaw; correction: number }
  /** Not readable now, with the engine's reason: not yet in history, not established, too large. */
  | { status: "not-yet"; reason: string }
  /** History holds it cut by the gateway: shown in Raw as cut, never used to decide a card's state. */
  | { status: "cut"; raw: StepRaw; reason: string }
  | { status: "failed" };

/**
 * The engine's card selection for a task, and which calls are T3 Code. That
 * is decided per call, never per server, and the call's own result decides:
 * a call is T3 Code when its result names its own tool (`details.mcpTool`) as
 * one of T3 Code's published tools (`T3_CODE_TOOLS`), whatever the server is
 * called. Nothing makes a server as a whole T3 Code.
 *
 * Before its result, the gateway's map from effective names to tools
 * (`mcpTools`, from `tools.effective`) is the evidence: a call whose effective
 * name maps to one of those tools shows as the T3 Code card from its start.
 * The map is rebuilt from the gateway's current catalog, so it can name
 * another tool than the running attempt had; the result overrules it, and a
 * call whose result names another tool is an ordinary step again. A result
 * that does not name its tool (history keeps no `details` for tool-server
 * results; a denial carries none) leaves the map's word for Failed, Not sent
 * or Delivery unknown, but the map alone never makes a call Call made: such
 * a call is an ordinary step. Nothing is read out of the effective name itself (`<safe
 * server>__<safe tool>`, cut to 64 characters and given a `-2` suffix on a
 * collision, `buildSafeToolName` in OpenClaw 2026.10.6).
 */
export function selectCards(
  transcript: Pick<Transcript, "runs" | "approvals" | "linkedRuns" | "interSession"> & {
    mcpTools?: Transcript["mcpTools"];
  },
  rawOf: (step: Step) => StepRaw | null,
  previous?: SelectedCards,
): SelectedCards {
  const selected = selectMessageCards(
    {
      runs: transcript.runs,
      approvals: transcript.approvals,
      linkedRuns: transcript.linkedRuns,
      interSession: transcript.interSession,
    },
    {
      mcpTools: transcript.mcpTools ?? {},
      rawOf,
      ...(previous ? { previous } : {}),
    },
  );
  const steps = new Map(transcript.runs.flatMap((run) => run.steps.map((step) => [step.id, step])));
  const isT3 = (tool: string) => T3_CODE_TOOLS.includes(tool);
  const mcpCalls = selected.mcpCalls.map((card) => {
    const step = steps.get(card.stepId);
    const raw = step ? rawOf(step) : null;
    const named = resultTool(raw);
    // A result that does not name its tool leaves the map's word, but never for Call made.
    const t3 = named ? isT3(named.tool) : isT3(card.tool) && card.state !== "returned";
    return t3 === card.codingAgent ? card : { ...card, codingAgent: t3 };
  });
  return { ...selected, mcpCalls };
}

/** The server and tool a call's result names (`details.mcpServer`, `details.mcpTool`), if it does. */
function resultTool(raw: StepRaw | null): { server: string; tool: string } | null {
  const result = raw?.result as Record<string, unknown> | null | undefined;
  const body = (result?.result ?? result) as Record<string, unknown> | null | undefined;
  const details = body?.details as Record<string, unknown> | null | undefined;
  return typeof details?.mcpServer === "string" && typeof details.mcpTool === "string"
    ? { server: details.mcpServer, tool: details.mcpTool }
    : null;
}

/** The cards' states, to tell when the remembered selection needs replacing. */
function statesOf(cards: SelectedCards | undefined): string {
  if (!cards) return "";
  return [...cards.botMessages, ...cards.mcpCalls]
    .map((card) => `${card.id}:${card.state}:${card.correction}`)
    .join("|");
}

/**
 * Whether a step may be a call a card is drawn for, so its payload is worth
 * reading whole when it did not travel with the snapshot. Not an identity:
 * every tool-server call's effective name holds the gateway's `__` separator
 * (a safe server name is at most 30 characters of the 64), whatever it was
 * renamed to, so every such call is read and its result decides.
 */
export function isCardCall(step: Step): boolean {
  if (step.kind !== "tool" || !step.toolName) return false;
  // A task start is not read whole: its card draws from what the step keeps of the call and its
  // result, and its Raw view reads the payload only when opened.
  return step.toolName === BOT_MESSAGE_TOOL || step.toolName.includes("__");
}

/** Keep at most `MAX_READS` reads, the newest: every way into the map goes through here. */
function withRead(current: Map<string, Read>, stepId: string, read: Read): Map<string, Read> {
  const next = new Map(current);
  next.delete(stepId);
  next.set(stepId, read);
  while (next.size > MAX_READS) next.delete(next.keys().next().value as string);
  return next;
}

export function useCards(
  taskKey: string,
  transcript: Transcript,
  invoke: ClawtrateBridge["invoke"],
) {
  const [reads, setReads] = useState<Map<string, Read>>(() => new Map());
  const asked = useRef(new Set<string>());

  const read = useCallback(
    (step: Step) => {
      const key = `${step.id}#${step.correction}`;
      asked.current.add(key);
      setReads((current) => withRead(current, step.id, { status: "loading" }));
      invoke({ type: "readStepRaw", key: taskKey, stepId: step.id })
        .then((answer) =>
          setReads((current) => withRead(current, step.id, readOf(answer, step.correction))),
        )
        .catch(() => setReads((current) => withRead(current, step.id, { status: "failed" })));
    },
    [invoke, taskKey],
  );

  // A finished call whose payload did not travel with the snapshot is read whole once.
  const steps = useMemo(() => transcript.runs.flatMap((run) => run.steps), [transcript.runs]);
  // At most `MAX_READS_IN_FLIGHT` at once, inside the engine's own gate; the rest follow.
  useEffect(() => {
    let free =
      MAX_READS_IN_FLIGHT - [...reads.values()].filter((each) => each.status === "loading").length;
    for (const step of steps) {
      if (free <= 0) break;
      if (step.raw !== null || !isCardCall(step)) continue;
      if (step.status === "running" || step.status === "waiting") continue;
      if (asked.current.has(`${step.id}#${step.correction}`)) continue;
      read(step);
      free -= 1;
    }
    // Forget attempts for steps the task no longer keeps, or for a corrected result.
    const kept = new Set(steps.map((step) => `${step.id}#${step.correction}`));
    for (const key of asked.current) if (!kept.has(key)) asked.current.delete(key);
  }, [steps, reads, read]);

  const rawOf = useCallback(
    (step: Step): StepRaw | null => {
      if (step.raw) return step.raw;
      const known = reads.get(step.id);
      return known?.status === "available" && known.correction === step.correction
        ? known.raw
        : null;
    },
    [reads],
  );

  // The last selection, so a card's state only moves forward: the engine's
  // own `previous` input. It is replaced when a card's state changes.
  const [previous, setPrevious] = useState<SelectedCards | undefined>(undefined);
  const { runs, approvals, linkedRuns, interSession, mcpTools } = transcript;
  const selected = useMemo(
    () => selectCards({ runs, approvals, linkedRuns, interSession, mcpTools }, rawOf, previous),
    [runs, approvals, linkedRuns, interSession, mcpTools, rawOf, previous],
  );
  // Adjusted while rendering, as React does for state that follows other state;
  // the engine keeps states forward-only, so this settles after one pass.
  if (statesOf(selected) !== statesOf(previous)) setPrevious(selected);

  /** The raw payload a card's Raw shows, read whole when needed. */
  const rawState = useCallback(
    (stepId: string): StepRawState => {
      const step = steps.find((each) => each.id === stepId);
      const load = () => {
        if (step && !step.raw && reads.get(stepId)?.status !== "loading") read(step);
      };
      if (!step) {
        return {
          state: "pending",
          content: { state: "unavailable", reason: "This step is no longer kept here." },
          load,
        };
      }
      const raw = rawOf(step);
      if (raw) return { state: "available", raw, load };
      const known = reads.get(stepId);
      if (!known || known.status === "loading") {
        return { state: "pending", content: { state: "loading" }, load };
      }
      if (known.status === "not-yet") {
        return { state: "pending", content: { state: "unavailable", reason: known.reason }, load };
      }
      if (known.status === "cut") {
        return { state: "available", raw: known.raw, load, cut: known.reason };
      }
      if (known.status === "failed") {
        return { state: "pending", content: { state: "failed", retry: () => read(step) }, load };
      }
      return { state: "available", raw: null, load };
    },
    [steps, rawOf, reads, read],
  );

  /** A card whose call finished but whose payload is still being read is not drawn yet. */
  const settledRaw = useCallback(
    (stepId: string): boolean => {
      const step = steps.find((each) => each.id === stepId);
      if (!step || step.raw || step.status === "running" || step.status === "waiting") return true;
      const known = reads.get(stepId);
      return known !== undefined && known.status !== "loading";
    },
    [steps, reads],
  );

  return { selected, rawState, settledRaw, rawOf };
}
