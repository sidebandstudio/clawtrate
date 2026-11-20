import type { ClawtrateState, DesktopUpdateSnapshot, DesktopUpdateState } from "@clawtrate/core";

type Reason = Extract<DesktopUpdateState, { kind: "handoff-failed" }>["reason"];
const reasons: Record<Reason, string> = {
  "no-verified-download": "There is no verified update ready to install.",
  "build-not-signed": "This build can't install updates itself.",
  "no-installer-path": "This build has no installer for this system.",
  "artifact-changed": "Couldn't verify the saved update again.",
  "mac-designated-requirement": "The update doesn't meet this app's macOS signing requirement.",
  "authenticode-trust": "Windows couldn't verify the update's signature.",
  "publisher-mismatch": "The update was signed by a different publisher.",
  "installation-context": "Couldn't confirm where this copy of Clawtrate is installed.",
  "inspection-failed": "Couldn't finish checking the downloaded update.",
  "running-signature-untrusted": "Couldn't verify the signature of the running app.",
  "running-publisher-mismatch": "The running app was signed by a different publisher.",
  "installer-product": "The installer is for a different app.",
  "installer-version": "The installer's version doesn't match the offered version.",
  "mac-archive": "The downloaded archive can't be used for this update.",
  "mac-bundle-identifier": "The downloaded Mac app has a different app identifier.",
  "mac-architecture": "The downloaded Mac app is for a different processor.",
  "quit-blocked":
    "Clawtrate stayed open. Close whatever is blocking quit, then check and download the update again before choosing Restart to Update.",
  "handoff-unconfirmed": "Couldn't confirm the handoff to the system updater.",
  "attempt-not-saved": "Couldn't save the restart attempt on this device.",
  "installer-failed": "Couldn't hand the update to the installer.",
};

export function refusalLine(reason: Reason) {
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
    (state.kind === "handoff-failed" && state.reason === "handoff-unconfirmed")
  );
}

export function attemptLine(attempt: DesktopUpdateSnapshot["lastAttempt"]) {
  if (!attempt) return null;
  if (attempt.running) {
    if (attempt.kind === "target-running") return `Clawtrate ${attempt.running} is running.`;
    if (attempt.kind === "old-version-running")
      return `Clawtrate is still running ${attempt.running}.`;
    return `Clawtrate ${attempt.running} is running. Couldn't confirm the update attempt.`;
  }
  return "Couldn't confirm the update attempt.";
}

/** Use the frame handoff recorded in each outbox, including tasks outside the current view. */
export function restartWaitingMessages(
  state: Pick<ClawtrateState, "transcripts" | "tasksByBot" | "bots">,
) {
  const warnings: string[] = [];
  for (const [key, transcript] of Object.entries(state.transcripts)) {
    const pending = transcript.outbox.filter(
      (m) => !["cancelled", "failed", "handled"].includes(m.status),
    );
    if (!pending.length) continue;
    const bot = state.bots.find((bot) => state.tasksByBot[bot.id]?.some((t) => t.key === key));
    const to = bot ? " to " + bot.name : "";
    const unsent = pending.filter(
      (m) =>
        ["held", "queued", "not-sent", "awaiting-access"].includes(m.status) ||
        (m.status === "sending" && m.leftAt === null),
    ).length;
    const sent = pending.length - unsent;
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
  }
  return warnings.join(" ");
}
