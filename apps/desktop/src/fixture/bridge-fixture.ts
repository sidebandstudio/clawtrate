// A bridge that serves fixed state, for development and the visual tests. It
// implements the same ClawtrateBridge the desktop and web hosts do, holds
// everything in memory, and never opens a socket or makes a request.

import {
  applyApprovalResolved,
  applyQuestionResolved,
  decisionText,
  initialState,
  markApproval,
  markQuestion,
  type ApprovalCard,
  type BridgeCommand,
  type BridgeResultFor,
  type ClawtrateBridge,
  type ClawtrateState,
  type ConnectionState,
  type HostInfo,
  type TaskActivity,
  type Transcript,
} from "@clawtrate/core";
import {
  CARD_SCENES,
  cardScene,
  isCardScene,
  wholeApproval,
  type CardSceneName,
  type DecisionMode,
} from "./cards.ts";
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

export type SceneName = (typeof SCENES)[number] | CardSceneName;

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
    unroutedApprovals: [],
    unroutedApprovalsOmitted: 0,
    creations: [],
    retention: initialState.retention,
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
  if (isCardScene(name)) return { initial: cardScene(name, now).change(base), steps: [] };
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
  return value !== null && [...SCENES, ...CARD_SCENES].includes(value as SceneName);
}

/** Change one task's live state, as the engine would. */
function inTask(
  state: ClawtrateState,
  key: string,
  change: (activity: TaskActivity) => TaskActivity,
): ClawtrateState {
  const transcript = state.transcripts[key];
  if (!transcript) return state;
  return {
    ...state,
    transcripts: {
      ...state.transcripts,
      [key]: { ...transcript, ...change(transcript) } as Transcript,
    },
  };
}

/** The strings the gateway would report for an answer: each chosen option's value or label. */
function answerStrings(
  transcript: Transcript | undefined,
  questionId: string,
  answers: Record<string, Array<string | { option: number }>>,
): Record<string, string[]> {
  const card = transcript?.questions.find((each) => each.id === questionId);
  return Object.fromEntries(
    Object.entries(answers).map(([id, list]) => {
      const item = card?.questions.find((each) => each.id === id);
      return [
        id,
        list.map((answer) => {
          if (typeof answer === "string") return answer;
          const option = item?.options.find((each) => each.index === answer.option);
          return option?.value ?? option?.label ?? String(answer.option);
        }),
      ];
    }),
  );
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
  // How this scene's gateway answers a decision: it applies it, refuses it, or never answers.
  const decisions: DecisionMode = isCardScene(name) ? cardScene(name, now).decisions : "apply";
  const later = (ms: number, change: (state: ClawtrateState) => ClawtrateState) =>
    setTimeout(() => set(change(state)), ms);
  const approval = (key: string, id: string): ApprovalCard | undefined =>
    state.transcripts[key]?.approvals.find((each) => each.id === id);

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
      case "requestAccess":
        return;
      case "resolveApproval": {
        const { key, approvalId, decision } = command;
        const card = approval(key, approvalId);
        if (!card || card.status !== "pending") throw new Error("That approval is no longer open.");
        // As the engine: Deny goes out while another decision is on its way; a second allow does not.
        if (card.submitting && (decision !== "deny" || card.submittingDecision === "deny")) {
          throw new Error("An answer to that approval is already on its way.");
        }
        if (decision !== "deny" && card.decisionError === "unknown") {
          throw new Error("Whether the last decision was applied is not known yet.");
        }
        if (
          decision !== "deny" &&
          card.decisionCut &&
          command.shownDigest !== card.decisionDigest
        ) {
          throw new Error("This approval's text was cut; read it whole before allowing it.");
        }
        set(
          inTask(state, key, (a) =>
            markApproval(a, approvalId, {
              submitting: true,
              submittingDecision: decision,
              error: null,
              decisionError: null,
              stillOpen: false,
            }),
          ),
        );
        const mode = decision === "deny" ? "apply" : decisions;
        if (mode === "apply") {
          later(400, (s) =>
            inTask(s, key, (a) =>
              applyApprovalResolved(a, {
                id: approvalId,
                status: decision === "deny" ? "denied" : "allowed",
                decision,
                reason: "user",
                resolvedAt: Date.now(),
                resolvedBy: null,
                resolver: null,
                applicationStatus: null,
                authoritative: true,
                lossy: false,
                sessionKey: key,
                runId: card.runId,
              }),
            ),
          );
        } else if (mode === "refuse") {
          later(400, (s) =>
            inTask(s, key, (a) =>
              markApproval(a, approvalId, {
                submitting: false,
                error: "allow-always is unavailable for this command",
                decisionError: "refused",
                stillOpen: false,
              }),
            ),
          );
          later(800, (s) =>
            inTask(s, key, (a) =>
              markApproval(a, approvalId, {
                submitting: false,
                error: "allow-always is unavailable for this command",
                stillOpen: true,
              }),
            ),
          );
        } else {
          later(400, (s) =>
            inTask(s, key, (a) =>
              markApproval(a, approvalId, {
                submitting: false,
                error: "The gateway did not answer within 60 seconds.",
                decisionError: "unknown",
              }),
            ),
          );
        }
        return;
      }
      case "checkApproval": {
        // Read back: still pending on the gateway, so the unanswered decision was not applied.
        const { key, approvalId } = command;
        await new Promise((resolve) => setTimeout(resolve, 300));
        set(
          inTask(state, key, (a) => {
            const card = a.approvals.find((each) => each.id === approvalId);
            if (!card || card.decisionError === null) return a;
            return card.decisionError === "unknown"
              ? markApproval(a, approvalId, {
                  submitting: false,
                  error: null,
                  decisionError: null,
                  stillOpen: false,
                })
              : markApproval(a, approvalId, {
                  submitting: false,
                  error: card.error,
                  stillOpen: true,
                });
          }),
        );
        return;
      }
      case "answerQuestion": {
        const { key, questionId } = command;
        const answers = answerStrings(state.transcripts[key], questionId, command.answers);
        set(
          inTask(state, key, (a) => markQuestion(a, questionId, { submitting: true, error: null })),
        );
        later(300, (s) =>
          inTask(s, key, (a) =>
            applyQuestionResolved(a, { id: questionId, status: "answered", answers: { answers } }),
          ),
        );
        return;
      }
      case "dismissQuestion": {
        const { key, questionId } = command;
        set(
          inTask(state, key, (a) => markQuestion(a, questionId, { submitting: true, error: null })),
        );
        later(300, (s) =>
          inTask(s, key, (a) => applyQuestionResolved(a, { id: questionId, status: "cancelled" })),
        );
        return;
      }
    }
  }

  async function answer<C extends BridgeCommand>(command: C): Promise<BridgeResultFor<C>> {
    switch (command.type) {
      case "readApprovalText": {
        const whole = wholeApproval(name, now, command.approvalId);
        if (!whole) throw new Error("That approval is no longer open.");
        return { text: decisionText(whole), digest: whole.decisionDigest } as BridgeResultFor<C>;
      }
      case "readStepRaw": {
        const transcript = state.transcripts[command.key];
        const step = transcript?.runs
          .flatMap((run) => run.steps)
          .find((each) => each.id === command.stepId);
        return (step?.raw ? { status: "available", raw: step.raw } : null) as BridgeResultFor<C>;
      }
      default:
        await apply(command);
        return undefined as BridgeResultFor<C>;
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
    invoke: answer,
    attach: () => Promise.reject(new Error("the fixture does not hold files")),
    setState: (change) => set(change(state)),
  };
}
