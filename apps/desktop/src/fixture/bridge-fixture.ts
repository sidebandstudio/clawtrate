// A bridge that serves fixed state, for development and the visual tests. It
// implements the same ClawtrateBridge the desktop and web hosts do, holds
// everything in memory, and never opens a socket or makes a request.

import {
  initialState,
  type BridgeCommand,
  type ClawtrateBridge,
  type ClawtrateState,
  type ConnectionState,
  type HostInfo,
} from "@clawtrate/core";
import { FAILING_TASK, OPEN_TASK, fixtureBots, fixtureTasks, fixtureTranscripts } from "./data.ts";

export const FIXTURE_INFO: HostInfo = {
  kind: "web",
  version: "0.1.0",
  devGateway: { url: "ws://127.0.0.1:19001" },
};

const GATEWAY_URL = "ws://127.0.0.1:18789";
const DEVICE_ID = "a41c9e02f7d84b19c6e2";

/** Every scene the fixture can show, by the name used in `?scene=`. */
export const SCENES = [
  "main",
  "connect",
  "connect-error",
  "connecting",
  "pairing",
  "reconnecting",
  "reconnecting-unloaded",
  "offline",
  "offline-long-address",
  "catching-up",
  "synced",
  "sync-pending",
  "sync-failed",
  "refresh-failed",
  "load-failed",
  "loading",
  "discovery-error",
  "discovering",
  "empty",
  "partial",
  "zero-tasks",
] as const;

export type SceneName = (typeof SCENES)[number];

type Step = { after: number; change: (state: ClawtrateState) => ClawtrateState };

const connected: ConnectionState = {
  ...initialState.connection,
  status: "connected",
  gatewayUrl: GATEWAY_URL,
  serverVersion: "2026.10.6",
  protocol: 4,
  scopes: ["operator.read"],
  deviceId: DEVICE_ID,
  paired: true,
};

function loaded(now: number): ClawtrateState {
  const bots = fixtureBots();
  return {
    connection: { ...connected, connectedAt: now - 1000 },
    discovery: { status: "ready", error: null, partial: false },
    bots,
    tasksByBot: fixtureTasks(now, bots),
    transcripts: fixtureTranscripts(now, bots),
  };
}

function idle(): ClawtrateState {
  return { ...initialState, connection: { ...initialState.connection, deviceId: DEVICE_ID } };
}

function pairing(): ClawtrateState {
  return {
    ...initialState,
    connection: {
      ...initialState.connection,
      status: "pairing",
      gatewayUrl: GATEWAY_URL,
      deviceId: DEVICE_ID,
      retryAt: Date.now() + 4000,
      pairing: {
        requestId: "5d2a90c4-1b7e-4f0a-9c3d-2e8f6a1b0c55",
        deviceId: DEVICE_ID,
        message: "pairing required",
        approveCommand: "openclaw devices approve 5d2a90c4-1b7e-4f0a-9c3d-2e8f6a1b0c55",
        approveNote: "The gateway's owner runs this on the gateway's machine.",
        requestedScopes: ["operator.read"],
      },
    },
  };
}

const withConnection = (state: ClawtrateState, change: Partial<ConnectionState>) => ({
  ...state,
  connection: { ...state.connection, ...change },
});

const reconnecting = (state: ClawtrateState) =>
  withConnection(state, { status: "reconnecting", retryAt: Date.now() + 4000 });

/**
 * Strictly increasing times, so "loaded after the latest connect" holds even
 * when a test fixes the page's clock.
 */
let tick = 0;
const stamp = () => Date.now() + (tick += 1);

/** The connection is back: what was loaded before is now out of date. */
const catchingUp = (state: ClawtrateState): ClawtrateState => ({
  ...withConnection(state, {
    status: "connected",
    retryAt: null,
    error: null,
    connectedAt: stamp(),
  }),
  discovery: { ...state.discovery, status: "loading" },
});

/** Bots and tasks have loaded again; open transcripts have not reloaded yet. */
const discovered = (state: ClawtrateState): ClawtrateState => ({
  ...state,
  discovery: { status: "ready", error: null, partial: false },
});

/** Every transcript that did not fail has reloaded. */
const reloaded = (state: ClawtrateState): ClawtrateState => {
  const at = stamp();
  const transcripts = Object.fromEntries(
    Object.entries(state.transcripts).map(([key, transcript]) => [
      key,
      transcript.status === "error" ? transcript : { ...transcript, loadedAt: at },
    ]),
  );
  return { ...state, transcripts };
};

const caughtUp = (state: ClawtrateState): ClawtrateState => reloaded(discovered(state));

function failTranscript(state: ClawtrateState, key: string, keepItems: boolean): ClawtrateState {
  const transcript = state.transcripts[key];
  if (!transcript) return state;
  return {
    ...state,
    transcripts: {
      ...state.transcripts,
      [key]: {
        ...transcript,
        status: "error",
        items: keepItems ? transcript.items : [],
        live: null,
        error: "chat.history timed out after 15 seconds.",
      },
    },
  };
}

/** The scene's first state, and the changes that follow it. */
function scene(name: SceneName, now: number): { initial: ClawtrateState; steps: Step[] } {
  const base = loaded(now);
  switch (name) {
    case "main":
      return { initial: base, steps: [] };
    case "connect":
      return { initial: idle(), steps: [] };
    case "connect-error":
      return {
        initial: withConnection(idle(), {
          status: "error",
          gatewayUrl: GATEWAY_URL,
          error: {
            code: "ECONNREFUSED",
            message: "Nothing answered at 127.0.0.1:18789.",
            hint: "Check that the gateway is running and that the address and port are right.",
          },
        }),
        steps: [],
      };
    case "connecting":
      return {
        initial: withConnection(idle(), { status: "connecting", gatewayUrl: GATEWAY_URL }),
        steps: [],
      };
    case "pairing":
      return { initial: pairing(), steps: [] };
    case "reconnecting":
      return { initial: reconnecting(base), steps: [] };
    case "reconnecting-unloaded": {
      const transcripts = { ...base.transcripts };
      delete transcripts[OPEN_TASK];
      return { initial: reconnecting({ ...base, transcripts }), steps: [] };
    }
    case "offline":
      return {
        initial: withConnection(base, {
          status: "error",
          retryAt: null,
          error: { code: "ECONNREFUSED", message: "Connection refused", hint: null },
        }),
        steps: [],
      };
    case "offline-long-address":
      return {
        initial: withConnection(base, {
          status: "error",
          gatewayUrl: "wss://gateway-in-the-basement-rack-two.example:18789",
          retryAt: null,
          error: { code: "ECONNREFUSED", message: "Connection refused", hint: null },
        }),
        steps: [],
      };
    case "catching-up":
      return { initial: reconnecting(base), steps: [{ after: 60, change: catchingUp }] };
    case "synced":
      return {
        initial: reconnecting(base),
        steps: [
          { after: 60, change: catchingUp },
          { after: 160, change: caughtUp },
        ],
      };
    case "sync-pending":
      // Bots and tasks are back, but the open task has not reloaded.
      return {
        initial: reconnecting(base),
        steps: [
          { after: 60, change: catchingUp },
          { after: 160, change: discovered },
        ],
      };
    case "sync-failed":
      return {
        initial: reconnecting(base),
        steps: [
          { after: 60, change: (s) => failTranscript(catchingUp(s), OPEN_TASK, true) },
          { after: 160, change: caughtUp },
        ],
      };
    case "refresh-failed":
      return { initial: failTranscript(base, OPEN_TASK, true), steps: [] };
    case "load-failed":
      return { initial: failTranscript(base, FAILING_TASK, false), steps: [] };
    case "loading": {
      const transcripts = { ...base.transcripts };
      delete transcripts[OPEN_TASK];
      return { initial: { ...base, transcripts }, steps: [] };
    }
    case "discovery-error":
      return {
        initial: {
          ...base,
          discovery: {
            status: "error",
            error: "agents.list failed: the gateway is restarting.",
            partial: false,
          },
        },
        steps: [],
      };
    case "discovering":
      return {
        initial: {
          ...initialState,
          connection: connected,
          discovery: { ...base.discovery, status: "loading" },
        },
        steps: [],
      };
    case "empty":
      return {
        initial: { ...initialState, connection: connected, discovery: base.discovery },
        steps: [],
      };
    case "partial":
      return { initial: { ...base, discovery: { ...base.discovery, partial: true } }, steps: [] };
    case "zero-tasks":
      return { initial: { ...base, tasksByBot: { ...base.tasksByBot, marlow: [] } }, steps: [] };
  }
}

export function isScene(value: string | null): value is SceneName {
  return value !== null && (SCENES as readonly string[]).includes(value);
}

export function createFixtureBridge(name: SceneName): ClawtrateBridge & {
  setState(change: (state: ClawtrateState) => ClawtrateState): void;
} {
  const now = Date.now();
  const { initial, steps } = scene(name, now);
  let state = initial;
  const listeners = new Set<(state: ClawtrateState) => void>();
  const set = (next: ClawtrateState) => {
    state = next;
    for (const listener of listeners) listener(state);
  };
  for (const step of steps) setTimeout(() => set(step.change(state)), step.after);
  let pairingChecks = 0;

  async function apply(command: BridgeCommand): Promise<void> {
    switch (command.type) {
      case "connect":
      case "connectDevGateway":
        pairingChecks = 0;
        set(withConnection(idle(), { status: "connecting", gatewayUrl: GATEWAY_URL }));
        setTimeout(() => set(pairing()), 400);
        return;
      case "disconnect":
        set(idle());
        return;
      case "retry": {
        const { status } = state.connection;
        if (status === "pairing") {
          // "Check now": the first check finds nothing, the next one connects.
          await new Promise((resolve) => setTimeout(resolve, 500));
          pairingChecks += 1;
          if (pairingChecks === 1) set(withConnection(state, { retryAt: Date.now() + 5000 }));
          else set(loaded(Date.now()));
          return;
        }
        if (status === "connected" && state.discovery.status !== "error") return;
        set(catchingUp(state));
        setTimeout(() => set(caughtUp(state)), 700);
        return;
      }
      case "openSession":
      case "closeSession":
        return;
    }
  }

  return {
    info: FIXTURE_INFO,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: apply,
    setState: (change) => set(change(state)),
  };
}
