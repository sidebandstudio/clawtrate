// A task's model and effort on fixed state (docs/design/conversation.md,
// section 25): Otto's task "Disk almost full" on a scripted provider's model,
// the chip, the Details group, the line a change leaves and the turn's record,
// answered as the engine answers them. Scenes:
//
//   model-set      interactive; the task moved from acme/dev-1 to acme/dev-2, and
//                  its last turn ran on acme/dev-1 with low effort requested
//   model-held     interactive; a turn runs, and a change to acme/dev-2 is held
//   model-refused  interactive; a change of effort to High was refused, because
//                  the task now uses acme/dev-lite, which offers Off and Ultra
//   model-read     model-set on a connection that may only read
//
// `access=read` (accounts.ts) gives any of them the read-only form. Invented content only.

import {
  activeRun,
  INTERACTIVE_SCOPES,
  type BridgeCommand,
  type CatalogModel,
  type ClawtrateState,
  type Task,
  type TaskModelEvent,
  type TaskModelView,
} from "@clawtrate/core";
import { actionScene } from "./actions.ts";
import { OPEN_TASK } from "./data.ts";

export const MODEL_SCENES = ["model-set", "model-held", "model-refused", "model-read"] as const;
export type ModelScene = (typeof MODEL_SCENES)[number];

export function isModelScene(name: string | null): name is ModelScene {
  return MODEL_SCENES.includes(name as ModelScene);
}

const MINUTE = 60_000;
const LEVELS = ["off", "minimal", "low", "medium", "high", "ultra"];
/** The scripted provider's models, as the development gateway lists them, and one it marks unavailable. */
export const FIXTURE_MODELS: CatalogModel[] = [
  {
    provider: "acme",
    id: "dev-1",
    name: null,
    available: true,
    levels: LEVELS,
    defaultLevel: "low",
  },
  {
    provider: "acme",
    id: "dev-2",
    name: null,
    available: true,
    levels: LEVELS,
    defaultLevel: "low",
  },
  {
    provider: "acme",
    id: "dev-lite",
    name: null,
    available: true,
    levels: ["off", "ultra"],
    defaultLevel: "off",
  },
  { provider: "acme", id: "dev-old", name: null, available: false, levels: [], defaultLevel: null },
];

const interactive = (state: ClawtrateState): ClawtrateState => ({
  ...state,
  connection: {
    ...state.connection,
    scopes: [...INTERACTIVE_SCOPES],
    requestedScopes: [...INTERACTIVE_SCOPES],
    canWrite: true,
    canAnswer: true,
    canApprove: true,
  },
});

const withRow = (state: ClawtrateState, change: (task: Task) => Task): ClawtrateState => ({
  ...state,
  tasksByBot: Object.fromEntries(
    Object.entries(state.tasksByBot).map(([bot, tasks]) => [
      bot,
      tasks.map((task) => (task.key === OPEN_TASK ? change(task) : task)),
    ]),
  ),
});

/** Every finished run of the task ran on `model`, as its history row says. */
const ranOn = (state: ClawtrateState, model: string): ClawtrateState => {
  const transcript = state.transcripts[OPEN_TASK];
  if (!transcript) return state;
  return {
    ...state,
    transcripts: {
      ...state.transcripts,
      [OPEN_TASK]: {
        ...transcript,
        runs: transcript.runs.map((run) =>
          run.state === "completed"
            ? { ...run, provider: "acme", model, modelFrom: "history" as const }
            : run,
        ),
      },
    },
  };
};

const line = (
  now: number,
  change: Partial<TaskModelEvent> & Pick<TaskModelEvent, "outcome">,
): TaskModelEvent => ({
  id: `line-${change.outcome}-${change.model ?? change.effort ?? "x"}`,
  at: now - 2 * MINUTE,
  // After everything the transcript holds: the line is the last thing in it.
  after: now,
  model: null,
  effort: null,
  wasModel: "acme/dev-1",
  wasEffort: "low",
  followed: false,
  error: null,
  sessionId: null,
  ...change,
});

function view(state: ClawtrateState, change: Partial<TaskModelView>): TaskModelView {
  const runs = state.transcripts[OPEN_TASK]?.runs ?? [];
  return {
    catalog: "ready",
    catalogError: null,
    models: FIXTURE_MODELS,
    held: null,
    saving: false,
    refused: null,
    events: [],
    requested: runs
      .filter((run) => run.state === "completed")
      .map((run) => ({ runId: run.id, effort: "low", from: "thinkingDefault" as const })),
    ...change,
  };
}

export function modelScene(name: ModelScene, base: ClawtrateState, now: number): ClawtrateState {
  if (name === "model-held") {
    let state = actionScene("actions-running", base, now).initial;
    state = withRow(interactive(state), (task) => ({
      ...task,
      model: "acme/dev-1",
      effortDefault: "low",
    }));
    return {
      ...state,
      taskModels: {
        [OPEN_TASK]: view(state, {
          held: { model: "acme/dev-2", effort: null, at: now, sessionId: null },
        }),
      },
    };
  }
  let state = ranOn(interactive(actionScene("actions-short", base, now).initial), "dev-1");
  if (name === "model-refused") {
    state = withRow(state, (task) => ({ ...task, model: "acme/dev-lite", effortDefault: "off" }));
    const reason = 'thinkingLevel "high" is not supported for acme/dev-lite (use off|ultra)';
    return {
      ...state,
      taskModels: {
        [OPEN_TASK]: view(state, {
          refused: { error: reason, at: now - MINUTE },
          events: [
            line(now, {
              outcome: "changed",
              model: "acme/dev-lite",
              effort: "off",
              followed: true,
            }),
            {
              ...line(now, { outcome: "refused", effort: "high", error: reason }),
              at: now - MINUTE,
              wasModel: "acme/dev-lite",
              wasEffort: "off",
            },
          ],
        }),
      },
    };
  }
  state = withRow(state, (task) => ({ ...task, model: "acme/dev-2", effortDefault: "low" }));
  const scene = {
    ...state,
    taskModels: {
      [OPEN_TASK]: view(state, {
        events: [line(now, { outcome: "changed", model: "acme/dev-2" })],
      }),
    },
  };
  return name === "model-read"
    ? {
        ...scene,
        connection: {
          ...scene.connection,
          scopes: ["operator.read"],
          requestedScopes: ["operator.read"],
          canWrite: false,
          canAnswer: false,
          canApprove: false,
        },
      }
    : scene;
}

/**
 * The commands the scenes answer, as the engine would: a change is held while
 * a turn runs, otherwise saved at once and posted as a line; Keep lets go.
 */
export function modelCommand(
  command: BridgeCommand,
  get: () => ClawtrateState,
  set: (state: ClawtrateState) => void,
  now: () => number,
): Promise<unknown> | null {
  if (command.type === "readTaskModels") return Promise.resolve();
  if (command.type === "keepTaskModel") {
    const state = get();
    const current = state.taskModels[command.key];
    if (current)
      set({
        ...state,
        taskModels: { ...state.taskModels, [command.key]: { ...current, held: null } },
      });
    return Promise.resolve();
  }
  if (command.type !== "setTaskModel") return null;
  const state = get();
  const current = state.taskModels[command.key];
  const task = Object.values(state.tasksByBot)
    .flat()
    .find((each) => each.key === command.key);
  if (!current || !task) return Promise.reject(new Error("That task is not open here."));
  const transcript = state.transcripts[command.key];
  const model = command.model ?? current.held?.model ?? null;
  const was = task.effort ?? task.effortDefault ?? null;
  const entry = FIXTURE_MODELS.find((each) => `${each.provider}/${each.id}` === model);
  const effort =
    command.effort ??
    (command.model && entry && was && !entry.levels.includes(was) ? entry.defaultLevel : null);
  if (transcript && activeRun(transcript)) {
    set({
      ...state,
      taskModels: {
        ...state.taskModels,
        [command.key]: { ...current, held: { model, effort, at: now(), sessionId: null } },
      },
    });
    return Promise.resolve("held");
  }
  const event: TaskModelEvent = {
    id: `line-${now()}`,
    outcome: "changed",
    at: now(),
    after: now(),
    model: command.model && command.model !== task.model ? command.model : null,
    effort: effort && effort !== was ? effort : null,
    wasModel: task.model ?? null,
    wasEffort: was,
    followed: Boolean(command.model && effort && !command.effort),
    error: null,
    sessionId: task.sessionId,
  };
  const next = withRow(state, (row) => ({
    ...row,
    ...(event.model ? { model: event.model } : {}),
    ...(effort ? { effort } : {}),
  }));
  set({
    ...next,
    taskModels: {
      ...next.taskModels,
      [command.key]: { ...current, held: null, events: [...current.events, event] },
    },
  });
  return Promise.resolve("saved");
}
