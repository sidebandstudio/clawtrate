// The cards of one task, from the engine's state. `selectMessageCards` is the
// engine's own view over the task's steps; this hook only feeds it the
// previous selection, so states move forward only, and the whole raw payload
// of a call whose payload was too long to travel with the snapshot.

import {
  BOT_MESSAGE_TOOL,
  selectMessageCards,
  type ClawtrateBridge,
  type SelectedCards,
  type Step,
  type StepRaw,
  type Transcript,
} from "@clawtrate/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RawContent } from "./raw.ts";

/** A call's raw payload, as far as this view knows it. */
export type StepRawState =
  | { state: "available"; raw: StepRaw | null; load: () => void }
  | { state: "pending"; content: RawContent; load: () => void };

/** Whole reads this view keeps while it is mounted; older ones are read again when needed. */
const MAX_READS = 24;

type Read =
  | { status: "loading" }
  | { status: "available"; raw: StepRaw; correction: number }
  | { status: "not-yet"; reason: string }
  | { status: "failed" };

/**
 * The engine's card selection for a task. A call to a T3 Code server is
 * known before its result by its tool name, which starts with the server's
 * name and `__` (conversation.md section 21); after it, by the result's own
 * `details.mcpServer`.
 */
export function selectCards(
  transcript: Pick<Transcript, "runs" | "approvals" | "linkedRuns" | "interSession">,
  codingServers: readonly string[],
  rawOf: (step: Step) => StepRaw | null,
  previous?: SelectedCards,
): SelectedCards {
  const mcpTools: Record<string, { server: string; tool: string }> = {};
  for (const run of transcript.runs) {
    for (const step of run.steps) {
      const name = step.toolName;
      const server = name ? codingServers.find((each) => name.startsWith(`${each}__`)) : undefined;
      if (name && server) mcpTools[name] = { server, tool: name.slice(server.length + 2) };
    }
  }
  return selectMessageCards(
    {
      runs: transcript.runs,
      approvals: transcript.approvals,
      linkedRuns: transcript.linkedRuns,
      interSession: transcript.interSession,
    },
    { codingServers, mcpTools, rawOf, ...(previous ? { previous } : {}) },
  );
}

/** The cards' states, to tell when the remembered selection needs replacing. */
function statesOf(cards: SelectedCards | undefined): string {
  if (!cards) return "";
  return [...cards.botMessages, ...cards.mcpCalls]
    .map((card) => `${card.id}:${card.state}:${card.correction}`)
    .join("|");
}

/** Whether a step may be a call a card is drawn for, before its payload says so. */
function isCardCall(step: Step, codingServers: readonly string[]): boolean {
  if (step.kind !== "tool" || !step.toolName) return false;
  return (
    step.toolName === BOT_MESSAGE_TOOL ||
    codingServers.some((server) => step.toolName!.startsWith(`${server}__`))
  );
}

export function useCards(
  taskKey: string,
  transcript: Transcript,
  codingServers: readonly string[],
  invoke: ClawtrateBridge["invoke"],
) {
  const [reads, setReads] = useState<Map<string, Read>>(() => new Map());
  const asked = useRef(new Set<string>());

  const read = useCallback(
    (step: Step) => {
      const key = `${step.id}#${step.correction}`;
      asked.current.add(key);
      setReads((current) => new Map(current).set(step.id, { status: "loading" }));
      invoke({ type: "readStepRaw", key: taskKey, stepId: step.id })
        .then((answer) => {
          setReads((current) => {
            const next = new Map(current);
            next.set(
              step.id,
              answer?.status === "available"
                ? { status: "available", raw: answer.raw, correction: step.correction }
                : answer?.status === "not-available-yet"
                  ? { status: "not-yet", reason: answer.reason }
                  : { status: "failed" },
            );
            while (next.size > MAX_READS) next.delete(next.keys().next().value as string);
            return next;
          });
        })
        .catch(() => setReads((current) => new Map(current).set(step.id, { status: "failed" })));
    },
    [invoke, taskKey],
  );

  // A finished call whose payload did not travel with the snapshot is read whole once.
  const steps = useMemo(() => transcript.runs.flatMap((run) => run.steps), [transcript.runs]);
  useEffect(() => {
    for (const step of steps) {
      if (step.raw !== null || !isCardCall(step, codingServers)) continue;
      if (step.status === "running" || step.status === "waiting") continue;
      if (!asked.current.has(`${step.id}#${step.correction}`)) read(step);
    }
  }, [steps, codingServers, read]);

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
  const { runs, approvals, linkedRuns, interSession } = transcript;
  const selected = useMemo(
    () =>
      selectCards({ runs, approvals, linkedRuns, interSession }, codingServers, rawOf, previous),
    [runs, approvals, linkedRuns, interSession, codingServers, rawOf, previous],
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

  return { selected, rawState, settledRaw };
}
