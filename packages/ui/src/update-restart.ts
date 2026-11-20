import type { ClawtrateState, DesktopUpdateSnapshot, DesktopUpdateState } from "@clawtrate/core";

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
};

export function refusalLine(reason: Reason) {
  if (reason === "no-verified-download") return "";
  return Object.hasOwn(reasons, reason)
    ? reasons[reason]
    : "This update can't be installed from here.";
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

export function attemptLine(attempt: DesktopUpdateSnapshot["lastAttempt"]) {
  if (!attempt) return null;
  if (attempt.running) {
    if (attempt.kind === "target-running") return `Clawtrate ${attempt.running} is running.`;
    if (attempt.kind === "old-version-running")
      return `Clawtrate ${attempt.running} is running, not ${attempt.target}. Check for updates to try again.`;
    return `Clawtrate ${attempt.running} is running. Clawtrate couldn't confirm that it restarted into ${attempt.target}.`;
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
