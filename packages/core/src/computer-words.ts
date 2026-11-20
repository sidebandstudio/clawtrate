// The Computer tab's sentences (docs/design/work-pane.md, sections 15 to 19),
// in one place, so the desktop app and the iOS app say the same thing and a
// translation replaces one module. The engine keeps codes; these turn them
// into the design's words. Every refusal of the computer plugin that the tab
// shows is mapped here, from the plugin's own reason.

import type { BusyReason, ClosedCode, ComputerOutcome, ViewEnd } from "./computer.ts";

/** The standing second line of "You have control": exactly what a grant guarantees. */
export const pausedLine = (bot: string) =>
  `${bot}'s new browser actions are paused. Something it already started can still change this page.`;

/** What reaches the page, and what stays open, while the person holds control. */
export const reachLine = (bot: string) =>
  `Clicks, scrolling and typed text reach the page; Enter, Tab and other keys don't yet. Until you give control back, ${bot}'s new browser actions are paused, in every one of ${bot}'s tasks; something it already started can still change this page. Other ways in aren't blocked: the gateway's own browser controls, and other tools such as commands, can still reach this browser. Pages you open aren't checked by the gateway's browser rules.`;

export const captionLine = (bot: string) => `${bot}'s browser, used by all of its tasks`;

export const firstWatchLine = (bot: string) =>
  `This is ${bot}'s browser, used by all of ${bot}'s tasks. It may be signed in to sites, and what you see here is live: anyone who can see your screen sees it too.`;

export const connectingLine = (bot: string) => `Connecting to ${bot}'s browser…`;

/** How a view ended, as section 17's table says it. */
export function viewEndLine(bot: string, end: ViewEnd, error: string | null): string {
  switch (end) {
    case "tab-closed":
      return "This tab was closed.";
    case "browser-gone":
      return `The view ended. ${bot}'s browser stopped answering.`;
    case "dropped":
      return "The view ended when the connection dropped.";
    case "failed":
      return error ? `Couldn't open the view. ${error}` : "Couldn't open the view.";
    case "gateway-ended":
    case "stopped":
      return "The view ended. The gateway stopped sending it.";
  }
}

export const noPluginTitle = "Watching isn't set up on this gateway";
export const noPluginBody = (bot: string) =>
  `To watch ${bot}'s browser here, the gateway's owner installs Clawtrate's computer plugin and gives ${bot} a browser of its own.`;
export const noPluginShared = (bot: string) =>
  `Without it, nothing here gives ${bot} a browser of its own. By default, bots that use the browser share one profile, with its sign-ins.`;
export const unconfiguredTitle = (bot: string) => `${bot} has no browser of its own yet.`;
export const unconfiguredBody = (bot: string) =>
  `The gateway's owner adds ${bot} to the computer plugin's list of bots. Until then ${bot}'s browser can't be watched here.`;
export const unconfiguredShared = (bot: string) =>
  `Nothing here gives ${bot} a browser of its own. By default, bots that use the browser share one profile, with its sign-ins.`;
export const notAllowedTitle = (bot: string) => `${bot} can't use a browser in this task.`;
export const notAllowedBody =
  "The gateway's tool policy for this task doesn't allow the browser, so there is nothing to watch here.";
export const askFailedLine = (bot: string) => `Couldn't ask the computer plugin about ${bot}.`;
export const readOnlyLine = "Watching needs a connection that can send. This device is read-only.";
export const unusedTitle = "No screen to show";
export const unusedBody = (bot: string) => `When ${bot} uses its browser, you can watch it here.`;
export const noTabsLine = (bot: string) =>
  `${bot}'s browser has no tabs open. If ${bot} opens one, it appears here.`;

export const elsewhereLine = (bot: string) =>
  `Someone on another device has control of ${bot}'s browser.`;
/** Another window or tab of this same app holds the lease: the plugin sees one device. */
export const otherWindowLine = (bot: string) =>
  `Another window of this app has control of ${bot}'s browser.`;
/** A take elsewhere is still waiting for the bot (`draining`): nobody has control yet. */
export const takingElsewhereLine = (bot: string) =>
  `Someone on another device is asking for control of ${bot}'s browser.`;
export const takingOtherWindowLine = (bot: string) =>
  `Another window of this app is asking for control of ${bot}'s browser.`;

export const waitingLine = (bot: string) =>
  `Waiting for ${bot} to finish what it's doing in the browser…`;

/** A take the plugin answered `busy`, by its reason. */
export function busyLine(bot: string, reason: BusyReason): string {
  return reason === "bot-still-acting"
    ? `${bot} is still acting in this browser. Try again in a moment.`
    : `Something ${bot} started in this browser hasn't finished yet, such as a page still loading or a download. Try again in a moment.`;
}

export const stuckLine = (bot: string) =>
  `${bot}'s browser has been busy for a while. A call that never finished can keep control from being handed over. If stopping doesn't free it, the gateway's owner can restart the gateway.`;
export const stopConfirmLine = (bot: string) =>
  `Stop ${bot}'s runs in this task? Steps already done stay done. ${bot}'s other tasks and other bots keep going.`;
export const stoppedLine = (bot: string) =>
  `Stopped ${bot}'s runs in this task. Its other tasks and other bots keep going.`;
/** Asked, and not yet ended by the runs themselves (`stopProgress`). */
export const stoppingLine = (bot: string) => `Stopping ${bot}'s runs in this task…`;
export const endedBeforeStopLine = (bot: string) =>
  `${bot}'s runs in this task ended before the stop took effect.`;
export const stopRefusedLine = (bot: string, error: string) =>
  `Couldn't stop ${bot}'s runs in this task. ${error}`;
export const nothingToStopLine = (bot: string) =>
  `Nothing of ${bot}'s was running in this task, so nothing was stopped.`;
export const stopAcceptedLine = (bot: string) =>
  `The gateway took the stop for this task. It shows here once ${bot}'s run ends.`;

export const controlEndedLine = (cause: "expired" | "revoked" | null) =>
  cause === "expired"
    ? "Your control ended. It expired."
    : cause === "revoked"
      ? "Your control ended. It was revoked."
      : "Your control ended.";
export const releasingLine = "Giving control back…";
export const unconfirmedLine = (bot: string) =>
  `Giving control back wasn't confirmed. This device may still have control of ${bot}'s browser.`;
export const stillHeldLine = "You still have control.";
/** No renewal confirmed the lease (`unverified`): input has stopped until one does. */
export const unverifiedLine = (bot: string) =>
  `The gateway hasn't confirmed that you still have control of ${bot}'s browser. Input has stopped.`;
export const answerNotSentLine =
  "Your answer wasn't sent. Answer in the chat once control is given back.";
export const answeringLine = "Sending your answer…";
export const outOfSightLine = (bot: string, renewWithinMs: number | null) =>
  `This device may still have control of ${bot}'s browser. Giving it back wasn't confirmed; it ends by itself within about ${Math.max(1, Math.round((renewWithinMs ?? 20_000) / 1000))} seconds.`;
export const droppedLine =
  "The connection dropped. Input has stopped. The gateway ends control when it observes this connection close; check its state after reconnecting.";
export const checkingLine = (bot: string) => `Checking ${bot}'s question and browser…`;

const closedWords: Record<ClosedCode, string> = {
  answered: "was answered on another device",
  dismissed: "was dismissed",
  cancelled: "was cancelled",
  expired: "expired",
  "run-ended": "",
};

/** The question closed while an answer waited behind the release. */
export function droppedAnswerLine(bot: string, code: ClosedCode): string {
  return code === "run-ended"
    ? `${bot}'s run ended, so your answer wasn't sent.`
    : `${bot}'s question ${closedWords[code]}, so your answer wasn't sent.`;
}

/** The question closed while the person held control. */
export function questionGoneLine(bot: string, code: ClosedCode): string {
  return code === "run-ended" ? `${bot}'s run ended.` : `${bot}'s question ${closedWords[code]}.`;
}

/** How the answer that followed a confirmed release ended. */
export function outcomeLine(bot: string, outcome: ComputerOutcome): string {
  switch (outcome) {
    case "answered":
      return `Answer sent. ${bot} can carry on.`;
    case "answer-failed":
      return `Couldn't send your answer. Control is back with ${bot}; answer in the chat.`;
    case "already-answered":
      return `${bot}'s question was already answered on another device.`;
    case "already-dismissed":
      return `${bot}'s question was dismissed.`;
    case "already-cancelled":
      return `${bot}'s question was cancelled.`;
    case "already-expired":
      return `${bot}'s question had expired.`;
    case "answer-not-sent":
      return answerNotSentLine;
    case "dropped-answered":
      return droppedAnswerLine(bot, "answered");
    case "dropped-dismissed":
      return droppedAnswerLine(bot, "dismissed");
    case "dropped-cancelled":
      return droppedAnswerLine(bot, "cancelled");
    case "dropped-expired":
      return droppedAnswerLine(bot, "expired");
    case "dropped-run-ended":
      return droppedAnswerLine(bot, "run-ended");
  }
}

export const waitingBanner = (bot: string, again: boolean) =>
  again ? `${bot} is still waiting for you` : `${bot} is waiting for you`;

/** The picture shown is no longer live: its age, rounded down (`pictureAge`). */
export function lastPictureLine(ageMs: number): string {
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `Last picture, ${s} s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `Last picture, ${m} min ago` : "Last picture, over an hour ago";
}
/** A view is open but no usable frame has been drawn yet. */
export const noPictureLine = "No picture yet";
