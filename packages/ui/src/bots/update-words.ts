// What Clawtrate says while it updates OpenClaw (#565), from the gateway's
// record and nothing invented. The phases and reason codes are the gateway's
// own words, shown as text; the sentences around them are Clawtrate's.

import type { OpenClawUpdateState, UpdateRunView } from "@clawtrate/core";

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

/** Where the run stands, in a line; the phase is the gateway's word for its step. */
export function runLine(run: UpdateRunView): string {
  const to = run.to ? ` to ${run.to}` : "";
  switch (run.outcome) {
    case "running": {
      const step = `step ${phaseNumber(run.phase)} of 8, ${run.phase}`;
      if (run.mine === true) return `Updating OpenClaw${to}: ${step}.`;
      if (run.mine === false)
        return `An update of OpenClaw${to}, started elsewhere, is under way: ${step}.`;
      // Nothing the gateway records ties this run to the person's press: say only what is known.
      return `An update of OpenClaw${to} is under way: ${step}. Clawtrate can't tell whether it's the one you started.`;
    }
    case "late":
      return "The gateway has been away longer than an update usually takes.";
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
      return "If the gateway was started by hand, the update may have left it stopped: start it again the way you normally start it. Clawtrate keeps waiting, and shows how the update ended when it's back.";
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
const phaseNumber = (phase: string) => PHASES.indexOf(phase) + 1;

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

/** How long an update takes, from real updates: usually 5 to 10 minutes, some installs longer. */
export const UPDATE_TIME_WORDS =
  "An update usually takes 5 to 10 minutes, and some installs take longer. The gateway restarts during it, so your bots can't be reached for part of that time. Clawtrate reconnects by itself.";
