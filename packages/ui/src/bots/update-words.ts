// What Clawtrate says while it updates OpenClaw (#565), from the gateway's
// record and nothing invented. The phases and reason codes are the gateway's
// own words, shown as text; the sentences around them are Clawtrate's.

import type { ClawtrateState, OpenClawUpdateState, UpdateRunView } from "@clawtrate/core";

/** OpenClaw's own update instructions: they differ by install. */
export const OPENCLAW_UPDATE_DOCS = "https://docs.openclaw.ai/install/updating";

/** What a reason code the gateway gives for not updating itself means, in plain words. */
const CANNOT_WORDS: Record<string, string> = {
  "unmanaged-package-install": "OpenClaw runs from a package folder it doesn't manage.",
  "container-image-install":
    "OpenClaw runs in a container, which is updated by replacing its image.",
  "external-supervisor-update-required": "Another program manages the gateway, and updates it.",
  "restart-unavailable": "The gateway can't restart itself.",
  "restart-disabled": "Restarting the gateway is turned off in its settings.",
  "not-openclaw-root": "The gateway couldn't find its own install.",
  "host-owned-install": "Another app on the gateway's machine owns this OpenClaw install.",
  "immutable-native-updater-required":
    "OpenClaw is installed read-only, and is updated by its owner on the gateway's machine.",
};

/** What a reason code the gateway gives for an update that failed means, in plain words. */
const FAILURE_WORDS: Record<string, string> = {
  "managed-service-handoff-helper-failed":
    "The updater gave up before it finished, and may have left the gateway stopped.",
  "managed-service-handoff-failed": "The gateway couldn't start the updater.",
};

/** Why this gateway can't update itself: Clawtrate's sentence, then the gateway's words. */
export function blockedWords(blocked: NonNullable<OpenClawUpdateState["blocked"]>): {
  why: string;
  gateway: string | null;
} {
  const why = CANNOT_WORDS[blocked.reason] ?? "The gateway can't update OpenClaw itself.";
  return { why, gateway: blocked.note ?? blocked.reason };
}

/** Who started a run under way, and where it goes, without its step. */
function underWay(run: UpdateRunView): string {
  const to = run.to ? ` to ${run.to}` : "";
  if (run.mine === true) return `Updating OpenClaw${to}`;
  if (run.mine === false) return `An update of OpenClaw${to}, started elsewhere, is under way`;
  return `An update of OpenClaw${to} is under way`;
}
/** Nothing the gateway records ties this run to the person's press: say only what is known. */
const untied = (run: UpdateRunView) =>
  run.mine === null ? " Clawtrate can't tell whether it's the one you started." : "";

/** Where the run stands, in a line; the phase is the gateway's word for its step. */
export function runLine(run: UpdateRunView): string {
  const to = run.to ? ` to ${run.to}` : "";
  switch (run.outcome) {
    case "running":
      return `${underWay(run)}: ${stepWords(run)}.${untied(run)}`;
    case "late":
      return `${underWay(run)}. This is taking longer than usual.${untied(run)}`;
    case "updated":
      return `Updated to OpenClaw ${run.to}.`;
    case "unconfirmed":
      return run.reported
        ? `The gateway's record says the update finished, but the gateway still reports OpenClaw ${run.reported}.`
        : run.note
          ? `${run.note} Clawtrate can't say whether OpenClaw was updated.`
          : `The gateway's record says the update finished, but the gateway hasn't reported OpenClaw${to} yet.`;
    case "failed": {
      const plain = run.reason ? FAILURE_WORDS[run.reason] : undefined;
      return plain ? `The update failed. ${plain}` : "The update failed.";
    }
    case "rolled-back":
      return "The update was rolled back: OpenClaw went back to the version it ran before.";
    case "skipped":
      return "The update was skipped.";
    case "away":
      return "The gateway hasn't come back since the update restarted it.";
    case "elsewhere":
      return "Clawtrate is connected to another gateway now, so it can't say how the update went.";
  }
}

/**
 * The card's line above its bar: the run's line without its step while it runs, since the step
 * is said beside the bar; every other outcome's line as it is.
 */
export function runHeading(run: UpdateRunView): string {
  return run.outcome === "running" ? `${underWay(run)}.${untied(run)}` : runLine(run);
}

/** What the person can do after an outcome, or null while it runs or when it worked. */
export function nextStep(run: UpdateRunView): string | null {
  switch (run.outcome) {
    case "failed":
    case "rolled-back":
    case "skipped":
      return "You can try again, or update OpenClaw on the gateway's machine with its update instructions.";
    case "unconfirmed":
      return "Check the gateway's version in Settings, then try again if it wasn't updated.";
    case "late":
      return "Clawtrate keeps waiting, and shows how the update ended when the gateway is back. If the gateway was started by hand, the update may have left it stopped: start it again the way you normally start it.";
    case "away":
      return "Check that the gateway's machine is on and that OpenClaw is running there. If it was started by hand, start it again the way you normally start it. Clawtrate keeps trying to reconnect.";
    default:
      return null;
  }
}

/** The gateway's own words about the outcome: its sentence, then its reason code. */
export function gatewayWords(run: UpdateRunView): string | null {
  // While it runs, the gateway's own sentence (its update manager's, for one it hands on).
  if (run.outcome === "running") return run.note;
  if (!["failed", "rolled-back", "skipped"].includes(run.outcome)) return null;
  if (run.note && run.reason) return `${run.note} (${run.reason})`;
  return run.note ?? run.reason;
}

const PHASES = [
  "requested",
  "staging",
  "validating",
  "repairing",
  "activating",
  "restarting",
  "verifying",
  "finished",
];
/** How many steps the gateway counts, and which of them a run is on (1 to 8). */
export const UPDATE_STEPS = PHASES.length;
export const stepNumber = (phase: string) => PHASES.indexOf(phase) + 1;

/** The run's step in the gateway's words: "step 5 of 8, activating". */
export function stepWords(run: UpdateRunView): string {
  return `step ${stepNumber(run.phase)} of ${UPDATE_STEPS}, ${run.phase}`;
}

/**
 * An update the engine follows on the gateway on screen while the connection is down and coming
 * back by itself: a run it follows that is running, or past the times its steps name ("late",
 * "away"), or a press whose answer it is waiting to hear about ("held"). Null otherwise: any
 * other lost connection, another gateway, or nothing the engine knows. Never guessed from a
 * version or from the gateway being away.
 */
export type UpdatingHere = { stage: "updating" | "held" | "late" | "away"; to: string | null };

export function updatingHere(
  state: Pick<ClawtrateState, "connection" | "openclawUpdating">,
): UpdatingHere | null {
  const { connection } = state;
  if (connection.status !== "reconnecting" && connection.status !== "connecting") return null;
  const gatewayId = connection.gatewayId;
  if (gatewayId === null) return null;
  const updating = state.openclawUpdating;
  const run = updating?.run;
  if (run?.gatewayId === gatewayId) {
    if (run.outcome === "running") return { stage: "updating", to: run.to };
    if (run.outcome === "late" || run.outcome === "away") return { stage: run.outcome, to: run.to };
  }
  if (updating?.looking && updating.held?.gatewayId === gatewayId)
    return { stage: "held", to: updating.held.to };
  return null;
}

/**
 * The connection strip's words while OpenClaw updates: the state, the same in fewer words, and
 * whether Retry is offered. While an update is within what it usually takes, there is no
 * countdown and no Retry; a held press has no measure of that, so Retry stays.
 */
export function updatingStripWords(updating: UpdatingHere): {
  text: string;
  short: string;
  retry: boolean;
} {
  const to = updating.to ? ` to ${updating.to}` : "";
  switch (updating.stage) {
    case "updating":
      return { text: `Updating OpenClaw${to}`, short: "Updating OpenClaw", retry: false };
    case "held":
      return {
        text: `OpenClaw may be updating${to}`,
        short: "OpenClaw may be updating",
        retry: true,
      };
    case "late":
      return {
        text: "OpenClaw's update is taking longer than usual",
        short: "Update taking longer than usual",
        retry: true,
      };
    case "away":
      return {
        text: "The gateway hasn't come back from the update",
        short: "Gateway not back from the update",
        retry: true,
      };
  }
}

/** The footer's few words for the same states. */
export function updatingPresence(updating: UpdatingHere): string {
  switch (updating.stage) {
    case "updating":
      return "Updating OpenClaw…";
    case "held":
      return "OpenClaw may be updating…";
    case "late":
      return "Update taking longer than usual";
    case "away":
      return "Not back from the update";
  }
}

/**
 * The one line a bot's Settings tab, the note near the Model menu and Settings › Gateway keep:
 * that OpenClaw is updating while one runs here, that one may be under way from a held press,
 * or that a newer OpenClaw is out. Null when there is nothing to say. The rest lives in
 * Settings › Updates.
 */
export function updateLinkLine(state: ClawtrateState, run: UpdateRunView | null): string | null {
  const updating = state.openclawUpdating;
  const offer = state.connection.openclawUpdate;
  if (run && run.outcome !== "elsewhere") {
    const to = run.to ? ` to ${run.to}` : "";
    if (run.outcome === "running") return `OpenClaw is updating${to}.`;
    if (run.outcome === "late")
      return `OpenClaw is updating${to}. This is taking longer than usual.`;
    if (run.outcome === "away")
      return "The gateway hasn't come back since the update restarted it.";
  }
  if (updating?.looking) return "An update may be under way from the last Update press.";
  if (!offer) return null;
  const channel =
    offer.channel && offer.channel !== "latest"
      ? ` on its ${offer.channel} channel${offer.channel === "beta" || offer.channel === "dev" ? ", not as a stable release" : ""}`
      : "";
  return `Your gateway runs OpenClaw ${offer.current}, and ${offer.latest} is out${channel}. Updating the gateway is how newer models get listed.`;
}

/**
 * The confirmation's sentence about running work, with how many tasks are working now. Real
 * updates on Linux stopped a turn in flight after a short wait and did not pick it up again
 * (`docs/research/model-catalog.md` section 7).
 */
export function workWords(working: number): string {
  const stopped =
    "Work that is running when the gateway restarts is stopped, and may not be picked up again.";
  if (working === 0) return `No task is working now. ${stopped}`;
  const count = working === 1 ? "1 task is working now" : `${working} tasks are working now`;
  return `${count}, and will be stopped when the gateway restarts. Stopped work may not be picked up again.`;
}

/**
 * How long an update takes, from real updates: 3.5 to 11 minutes on Linux, 11.4 on the first
 * macOS gateway under launchd; some installs take longer.
 */
export const UPDATE_TIME_WORDS =
  "An update usually takes 5 to 15 minutes, and some installs take longer. The gateway restarts during it, so your bots can't be reached for part of that time. Clawtrate reconnects by itself.";
