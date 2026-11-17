// What every card in one task's transcript shares: the task, the bots, what
// this connection may do, and the bridge's commands. Cards read the engine's
// state through this and keep no copy of it.

import type {
  Bot,
  BridgeCommand,
  BridgeResultFor,
  ConnectionState,
  Run,
  Transcript,
} from "@clawtrate/core";
import { createContext, useContext, useEffect, useState } from "react";

/**
 * How the reader left a call's ordinary step or its T3 Code card (`from`):
 * open or closed, and whether focus was in it.
 */
export type StepState = {
  open: boolean;
  focused: boolean;
  from: "step" | "card";
  /** The card's Raw view was open. */
  raw?: boolean;
  /** The control inside that had focus, by its accessible name; null for the line itself. */
  control?: string | null;
};

/** A focused control's accessible name, for the drawing that takes over to focus its counterpart. */
export function controlName(element: Element | null, within: Element): string | null {
  if (!element || element === within || !within.contains(element)) return null;
  if (element.matches(":scope > summary")) return null;
  return element.getAttribute("aria-label") ?? element.textContent?.trim() ?? null;
}

/**
 * A call drawn one way hands the other its state when the evidence changes:
 * an ordinary step that becomes the T3 Code card opens the card, with its Raw
 * view open in place of the step's arguments and result as received, and
 * gives it focus if the step had it; a card whose result names another tool
 * becomes the ordinary step again, open, in its open group, with focus, as the
 * card was. Only one of them is drawn at a time.
 */
export type StepHandover = {
  /** Whether this call is drawn as a card. */
  isCard: (callId: string) => boolean;
  /** The step's state, as the reader leaves it. */
  note: (callId: string, state: StepState) => void;
  /** The state the step had, if it was drawn. */
  stateOf: (callId: string) => StepState | undefined;
};

export const StepHandoverContext = createContext<StepHandover | null>(null);

export const useStepHandover = () => useContext(StepHandoverContext);

/** Moving to another task, for "Open in <bot>". The shell supplies it. */
export type OpenTask = (botId: string, key: string) => void;

export const OpenTaskContext = createContext<OpenTask | null>(null);

export type CardEnv = {
  taskKey: string;
  /** The task's own bot. */
  bot: Bot | undefined;
  bots: Bot[];
  transcript: Transcript;
  connection: ConnectionState;
  /** Connected, so a command can reach the gateway now. */
  connected: boolean;
  invoke: <C extends BridgeCommand>(command: C) => Promise<BridgeResultFor<C>>;
  send: (command: BridgeCommand) => Promise<void>;
  runOf: (runId: string | null) => Run | undefined;
  /** Every task's transcript this viewer holds, for a recipient's live phrase. */
  transcripts: Record<string, Transcript>;
  openTask: OpenTask | null;
};

export const CardEnvContext = createContext<CardEnv | null>(null);

export function useCardEnv(): CardEnv {
  const env = useContext(CardEnvContext);
  if (!env) throw new Error("cards need a CardEnvContext");
  return env;
}

/** The time, a minute at a time, for "Expires in …". */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
