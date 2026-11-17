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
   * The tool servers that are T3 Code, by the name the gateway's tool events
   * give them (`details.mcpServer`, or the `<server>__` tool-name prefix).
   * Nothing is built in: a host that knows which server is T3 Code says so.
   */
  codingServers: readonly string[];
};

export const CardSettingsContext = createContext<CardSettings>({ codingServers: [] });

export const useCardSettings = () => useContext(CardSettingsContext);

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
