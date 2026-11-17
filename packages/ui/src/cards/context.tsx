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

export type CardSettings = {
  /**
   * The tool servers configured as T3 Code, by the name a call's result gives
   * its server (`details.mcpServer`): every call such a result names is a T3
   * Code call. Nothing is built in; without it, a call is T3 Code by its own
   * tool, as its result names it.
   */
  codingServers: readonly string[];
};

export const CardSettingsContext = createContext<CardSettings>({ codingServers: [] });

export const useCardSettings = () => useContext(CardSettingsContext);

/** How the reader left an ordinary tool step: open or closed, and whether focus was in it. */
export type StepState = { open: boolean; focused: boolean };

/**
 * An ordinary tool step that becomes a card once its result names it hands
 * the card its state: the card opens if the step was open, with its Raw view
 * open in place of the step's arguments and result as received, and takes
 * focus if the step had it. The step is then not drawn beside the card.
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
