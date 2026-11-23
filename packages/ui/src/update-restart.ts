import type {
  ClawtrateState,
  DesktopUpdateSnapshot,
  DesktopUpdateState,
  UpdateInspectionFailure,
} from "@clawtrate/core";

type Reason = Extract<DesktopUpdateState, { kind: "handoff-failed" }>["reason"];
const reasons: Record<Exclude<Reason, "no-verified-download">, string> = {
  "windows-install-pending-trial": "Restart to update on Windows is unavailable in this build.",
  "build-not-signed": "This build can't install updates itself.",
  "no-installer-path": "Clawtrate can't install updates on this system.",
  "artifact-changed": "Couldn't verify the saved update again.",
  "mac-designated-requirement": "The update doesn't meet this app's macOS signing requirement.",
  "inspection-failed": "Couldn't finish checking the downloaded update.",
  "running-signature-untrusted": "Couldn't verify the signature of the running app.",
  "installer-version": "The downloaded app's version doesn't match the offered version.",
  "mac-archive": "The downloaded archive can't be used for this update.",
  "mac-bundle-identifier": "The downloaded Mac app has a different app identifier.",
  "mac-architecture": "The downloaded Mac app is for a different processor.",
  "attempt-not-saved": "Couldn't save the restart attempt on this device.",
  "installer-failed": "Couldn't hand the update to the installer.",
  "mac-updater-refused":
    "The macOS updater refused the update before receiving it. Nothing was installed.",
};

export function refusalLine(reason: Reason) {
  if (reason === "no-verified-download") return "";
  return Object.hasOwn(reasons, reason)
    ? reasons[reason]
    : "This update can't be installed from here.";
}

/** The recorded reason an inspection failed, when the snapshot carries one. */
export function inspectionFailure(s: DesktopUpdateSnapshot): UpdateInspectionFailure | null {
  return (s.install.kind === "unavailable-in-this-build" && s.install.failure) || null;
}

const helperAnswers: Record<NonNullable<UpdateInspectionFailure["output"]>, string> = {
  empty: "it gave no answer",
  "no-line-ending": "its answer was cut off",
  "too-long": "its answer was too long",
  unrecognized: "it gave an answer Clawtrate doesn't know",
  reported: "it couldn't read a signature",
  complete: "it answered but didn't finish cleanly",
};

/** One plain sentence: where the inspection stopped and how. */
export function inspectionFailureLine(f: UpdateInspectionFailure): string {
  const code = f.errorCode ? ` (${f.errorCode})` : "";
  if (f.stage === "hold-archive")
    return `It stopped while keeping a private copy of the download${code}.`;
  if (f.stage === "start-helper") return `The update checker didn't start${code}.`;
  const what = f.stage === "running-signature" ? "this app's signature" : "the downloaded app";
  const how = f.signal
    ? `macOS stopped it with ${f.signal}`
    : f.exitCode !== null && f.exitCode !== 0
      ? `it exited with code ${f.exitCode}`
      : f.output
        ? helperAnswers[f.output]
        : `it was stopped${code}`;
  return `The update checker stopped while checking ${what}: ${how}.`;
}

/** A copy the check made and couldn't remove, in plain words, or null. */
export function cleanupLine(s: DesktopUpdateSnapshot): string | null {
  const cleanup = s.install.cleanup;
  if (!cleanup) return null;
  const copy =
    cleanup.copy === "checked-copy"
      ? "the copy of the app it checked"
      : "its private copy of the download";
  return `Clawtrate couldn't remove ${copy} (${cleanup.errorCode}). It tries again at the next start or check.`;
}

/** The full record, for "Copy details": codes and counts only. */
export function inspectionFailureDetails(
  f: UpdateInspectionFailure,
  runningVersion: string | null,
): string {
  return [
    "Clawtrate update inspection failed",
    `Version: ${runningVersion ?? "unknown"}`,
    `System: ${f.system}`,
    `Stage: ${f.stage}`,
    `Exit code: ${f.exitCode ?? "none"}`,
    `Signal: ${f.signal ?? "none"}`,
    `Output: ${f.output ?? "none"}`,
    `Helper step: ${f.helperStep ?? "none"}`,
    `Error code: ${f.errorCode ?? "none"}`,
    `Duration: ${f.durationMs} ms`,
  ].join("\n");
}

export function downloadBlocked(install: DesktopUpdateSnapshot["install"]) {
  return (
    install.kind === "unavailable-in-this-build" &&
    (install.reason === "build-not-signed" ||
      install.reason === "windows-install-pending-trial" ||
      install.reason === "no-installer-path")
  );
}

export function restartCapability(s: DesktopUpdateSnapshot) {
  return s.state.kind === "verified" &&
    s.install.kind === "restart-available" &&
    s.state.offerId === s.install.offerId
    ? s.install
    : null;
}

export function handoffLocked(state: DesktopUpdateState) {
  return (
    state.kind === "preparing" ||
    state.kind === "handing-off" ||
    state.kind === "handed-to-system" ||
    state.kind === "handoff-unconfirmed"
  );
}

/** Whether the app that handed the update off finished quitting, when it recorded that. */
function quitLine(attempt: NonNullable<DesktopUpdateSnapshot["lastAttempt"]>) {
  if (attempt.quit === "not-finished")
    return " The app didn't finish quitting for the update, and macOS installs it only after that.";
  if (attempt.quit !== "finished") return "";
  if (attempt.quitMs === undefined) return " The app quit, but macOS didn't install the update.";
  return ` The app quit for the update after ${Math.max(1, Math.round(attempt.quitMs / 1000))} s, but macOS didn't install it.`;
}

export function attemptLine(attempt: DesktopUpdateSnapshot["lastAttempt"]) {
  if (!attempt) return null;
  if (attempt.running) {
    if (attempt.kind === "target-running") return `Clawtrate ${attempt.running} is running.`;
    if (attempt.kind === "old-version-running")
      return `Clawtrate ${attempt.running} is running, not ${attempt.target}.${quitLine(attempt)} Check for updates to try again.`;
    return `Clawtrate ${attempt.running} is running. Clawtrate couldn't confirm that it restarted into ${attempt.target}.${quitLine(attempt)}`;
  }
  return "Clawtrate couldn't read the running version.";
}

/** Use the frame handoff recorded in each outbox, including tasks outside the current view. */
export function restartWaitingMessages(
  state: Pick<ClawtrateState, "transcripts" | "tasksByBot" | "bots">,
) {
  let sent = 0;
  let unsent = 0;
  let recipient: string | null | undefined;
  for (const [key, transcript] of Object.entries(state.transcripts)) {
    const pending = transcript.outbox.filter(
      (m) => !["cancelled", "failed", "handled"].includes(m.status),
    );
    if (!pending.length) continue;
    const bot = state.bots.find((bot) => state.tasksByBot[bot.id]?.some((t) => t.key === key));
    if (recipient === undefined) recipient = bot?.name ?? null;
    else if (bot?.name !== recipient) recipient = null;
    for (const message of pending) {
      if (
        ["held", "queued", "not-sent", "awaiting-access"].includes(message.status) ||
        (message.status === "sending" && message.leftAt === null)
      )
        unsent++;
      else sent++;
    }
  }
  const to = recipient ? " to " + recipient : "";
  const warnings: string[] = [];
  if (unsent)
    warnings.push(
      unsent === 1
        ? `1 message${to} hasn't been sent yet. Restarting discards it: it isn't kept as a draft. Runs on the gateway keep going.`
        : `${unsent} messages${to} haven't been sent yet. Restarting discards them: they aren't kept as drafts. Runs on the gateway keep going.`,
    );
  if (sent)
    warnings.push(
      sent === 1
        ? `1 message${to} was sent to the gateway and isn't confirmed yet. Restarting stops following it. The gateway may still have it.`
        : `${sent} messages${to} were sent to the gateway and aren't confirmed yet. Restarting stops following them. The gateway may still have them.`,
    );
  return warnings.join(" ");
}
