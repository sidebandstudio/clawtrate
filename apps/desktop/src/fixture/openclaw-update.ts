// Updating OpenClaw from Clawtrate (F-589): the state the engine publishes
// (`openclawUpdating`) for each step and outcome, built from the gateway's
// run record as OpenClaw 2026.10.6 defines it; no real update was run. With
// `openclawRun=<scene>` the fixture opens on that scene; Update in the
// confirmation starts a run, as the engine does once `update.run` answers.

import {
  gatewayStamp,
  sameStamp,
  type BridgeCommand,
  type ClawtrateState,
  type OpenClawUpdateState,
  type UpdateRunView,
} from "@clawtrate/core";

export const UPDATE_RUN_SCENES = [
  "running",
  "other",
  "updated",
  "unconfirmed",
  "failed",
  "rolled-back",
  "skipped",
  "away",
  "elsewhere",
  "blocked",
] as const;
export type UpdateRunScene = (typeof UPDATE_RUN_SCENES)[number];

export const isUpdateRunScene = (value: string | null): value is UpdateRunScene =>
  (UPDATE_RUN_SCENES as readonly string[]).includes(value ?? "");

const RUN = "3f2b8c1d-4e5a-4b6c-8d7e-9f0a1b2c3d4e";
const OLD = "2026.10.6";
const NEW = "2026.11.6";

export function updateRunScene(scene: UpdateRunScene, state: ClawtrateState): ClawtrateState {
  const gatewayId = state.connection.gatewayId ?? "fixture-gateway";
  const run = (patch: Partial<UpdateRunView>): UpdateRunView => ({
    runId: RUN,
    gatewayId,
    mine: true,
    from: OLD,
    to: NEW,
    phase: "staging",
    outcome: "running",
    reason: null,
    note: null,
    reported: null,
    ...patch,
  });
  const finished = (patch: Partial<UpdateRunView>) => run({ phase: "finished", ...patch });
  const runs: Record<UpdateRunScene, Partial<OpenClawUpdateState>> = {
    running: { run: run({}) },
    other: { run: run({ mine: false, phase: "validating" }) },
    updated: { run: finished({ outcome: "updated" }) },
    unconfirmed: { run: finished({ outcome: "unconfirmed", reported: OLD }) },
    failed: {
      run: finished({
        outcome: "failed",
        reason: "managed-service-handoff-failed",
        note: "The updater could not start: spawn EAGAIN.",
      }),
    },
    "rolled-back": {
      run: finished({
        outcome: "rolled-back",
        reason: "runtime-verification-failed",
        note: "Restored the previous package and restarted the gateway.",
      }),
    },
    skipped: {
      run: finished({
        outcome: "skipped",
        reason: "managed-service-handoff-already-running",
        note: "Another managed update is already running; retry after it completes.",
      }),
    },
    away: { run: run({ phase: "restarting", outcome: "away" }) },
    elsewhere: {
      run: finished({
        outcome: "elsewhere",
        gatewayId: "another-gateway",
        from: null,
        to: null,
      }),
    },
    blocked: { blocked: { reason: "unmanaged-package-install", note: null } },
  };
  return {
    ...state,
    openclawUpdating: {
      run: null,
      starting: false,
      blocked: null,
      error: null,
      ...runs[scene],
    },
  };
}

/** Update starts a run on the gateway the confirmation was opened for; Dismiss puts a line away. */
export function updateRunCommand(
  command: BridgeCommand,
  get: () => ClawtrateState,
  set: (state: ClawtrateState) => void,
): Promise<unknown> | undefined {
  if (command.type === "dismissOpenClawUpdate") {
    const state = get();
    const run = state.openclawUpdating?.run;
    if (run && run.outcome !== "running" && run.outcome !== "away")
      set({ ...state, openclawUpdating: { ...state.openclawUpdating!, run: null } });
    return Promise.resolve();
  }
  if (command.type !== "startOpenClawUpdate") return undefined;
  const state = get();
  if (!sameStamp(command.stamp, gatewayStamp(state.connection)))
    return Promise.reject(
      new Error("This change was made for another gateway, so nothing was sent."),
    );
  if (!state.connection.canAdmin)
    return Promise.reject(new Error("Updating OpenClaw needs admin access."));
  const update = state.connection.openclawUpdate;
  set({
    ...state,
    openclawUpdating: {
      run: {
        runId: RUN,
        gatewayId: state.connection.gatewayId!,
        mine: true,
        from: update?.current ?? OLD,
        to: update?.latest ?? NEW,
        phase: "requested",
        outcome: "running",
        reason: null,
        note: null,
        reported: null,
      },
      starting: false,
      blocked: null,
      error: null,
    },
  });
  return Promise.resolve();
}
