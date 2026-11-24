// The words of deleting a bot (docs/parity.md F-050, F-276, F-464): whether
// Delete is offered, what goes and what stays before anything is removed, and
// what the gateway's answer establishes afterwards. A result says only what
// the answer or the bot list read after it said; a partial cleanup is never
// worded as done.

import {
  canRemoveFolder,
  partialCleanup,
  type BotDeleteOutcome,
  type BotDeleteRead,
  type ConfirmTarget,
  type ConnectionState,
  type HostInfo,
} from "@clawtrate/core";

/**
 * Reads where only the newest counts: each call starts one and returns whether it is still the
 * newest, so an answer or a failure of a read a later one superseded is dropped.
 */
export function newestOnly(): () => () => boolean {
  let latest = 0;
  return () => {
    const mine = (latest += 1);
    return () => mine === latest;
  };
}

/** Whether this connection may delete the bot, and if not, why. */
export type DeleteOffer = "main" | "offline" | "needs-admin" | "ready";

export function deleteOffer(
  bot: { isDefault: boolean },
  connection: Pick<ConnectionState, "status" | "canAdmin">,
  info: Pick<HostInfo, "readOnly">,
): DeleteOffer {
  if (bot.isDefault) return "main";
  if (connection.status !== "connected") return "offline";
  if (info.readOnly || !connection.canAdmin) return "needs-admin";
  return "ready";
}

export const mainBotLine = (name: string) => `${name} is your Main Bot, so it can't be deleted.`;

/** "Also used by Marlow", "Also used by Marlow and Pip", "Also used by Marlow, Pip and 2 more". */
export function sharedLine(
  read: Pick<BotDeleteRead, "sharedWith" | "sharedOmitted">,
): string | null {
  const names = read.sharedWith;
  if (names.length === 0) return read.sharedOmitted > 0 ? "Also used by other bots" : null;
  if (read.sharedOmitted > 0)
    return `Also used by ${names.join(", ")} and ${read.sharedOmitted} more`;
  if (names.length === 1) return `Also used by ${names[0]}`;
  return `Also used by ${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export const FOLDER_OPTION = "Also remove this bot's workspace folder";
export const TRASH_LINE =
  "Folders go to the Trash on the gateway's machine. The gateway removes a folder only if no other bot uses it.";

/**
 * Whether the folder box is shown, and why it is disabled. A bot with no creation record has no
 * box: the gateway could be holding another bot under its id by the time the delete lands.
 */
export function folderOption(
  name: string,
  read: Pick<BotDeleteRead, "folder" | "createdAt" | "sharedWith" | "sharedOmitted">,
): { shown: boolean; enabled: boolean; line: string } {
  if (read.createdAt === null)
    return {
      shown: false,
      enabled: false,
      line: `The gateway keeps no creation record for ${name}, so Clawtrate asks the gateway to keep its files and workspace folder. You can remove them on the gateway itself.`,
    };
  if (read.folder === "shared") return { shown: true, enabled: false, line: sharedLine(read)! };
  if (read.folder === "unknown")
    return {
      shown: true,
      enabled: false,
      line: "The gateway doesn't say which folders its bots use, so Clawtrate can't offer to remove this one.",
    };
  return { shown: true, enabled: canRemoveFolder(read), line: TRASH_LINE };
}

/** The label over the field the person types in to confirm, naming what to type and why. */
export function confirmLabel(target: ConfirmTarget): string {
  switch (target.by) {
    case "name":
      return `To confirm, type the bot's name: ${target.text}`;
    case "unnamed":
      return `This bot has no name. To confirm, type its id: ${target.text}`;
    case "untypable":
      return `This bot's name can't be typed here. To confirm, type its id: ${target.text}`;
  }
}

/**
 * Said by the Delete button: what doesn't come back, true to the choice as it is. The gateway
 * moves folders it removes to its Trash; the bot and its tasks don't return.
 */
export const finalLine = (name: string, removeFolder: boolean): string =>
  removeFolder
    ? `This can't be undone. ${name} and its tasks won't come back; folders the gateway removes go to the Trash on its machine.`
    : `This can't be undone. ${name} and its tasks won't come back.`;

/** The heading over what Clawtrate asks the gateway to keep: asked, never promised. */
export const KEEPS_HEADING = "Clawtrate asks the gateway to keep";

/** What the gateway removes and what it is asked to keep, for the box as it is. */
export function deleteLines(
  name: string,
  read: Pick<BotDeleteRead, "workspace" | "folder" | "createdAt" | "sharedWith" | "sharedOmitted">,
  removeFolder: boolean,
): { goes: string[]; stays: string[] } {
  const shared = read.folder === "shared";
  const folder = removeFolder && canRemoveFolder(read);
  const goes = [
    `${name}, with its settings and its place in your sidebar`,
    "Its tasks",
    "Its routines and channel routes",
    "Approvals saved for its commands",
  ];
  const stays: string[] = [];
  // The gateway decides at the delete, by folders this list may not show: never promised.
  if (folder)
    goes.push(
      `Its workspace folder, with its files and memory, if no other bot uses it: ${read.workspace}`,
      "Its own folder, which may hold its sign-ins, and its tasks' transcripts, if no other bot uses them",
    );
  else {
    const line = sharedLine(read);
    stays.push(
      shared && line
        ? `Its workspace folder, with its files and memory. ${line}.`
        : "Its workspace folder, with its files and memory",
      "Its own folder and its tasks' transcripts",
    );
  }
  stays.push(`What ${name} said in other bots' tasks`);
  return { goes, stays };
}

export type ResultLine = { text: string; tone?: "danger" | "warn" };

/** Said when the list no longer shows the bot but no answer said the gateway deleted it. */
const folderUnknown = (name: string): ResultLine => ({
  text: `What became of ${name}'s folder is the gateway's to say.`,
});
const unlistedTitle = (name: string) => `${name} is no longer listed on this gateway`;
/** After a partial clean-up: nothing is sent again, so what is left is the gateway's. */
export const LEFT_LINE = "What is left has to be handled on the gateway's machine.";

export type ResultView = {
  title: string;
  tone: "danger" | "warn" | null;
  lines: ResultLine[];
  /** Read the bot list again; it sends nothing. */
  check: boolean;
};

/**
 * What the list read after the delete says. It establishes only whether a bot has this id, so a
 * listed one is named as the gateway names it now, which may be another bot.
 */
const listedLine = (
  name: string,
  outcome: { listed: boolean | null; listedAs?: string },
): ResultLine =>
  outcome.listed === false
    ? { text: `The gateway no longer lists ${name}.` }
    : outcome.listed === true
      ? {
          // Named only as the gateway names it: never given the deleted bot's name.
          text:
            outcome.listedAs === undefined
              ? "The gateway still lists a bot under the same id."
              : `The gateway still lists a bot under the same id: ${outcome.listedAs}.`,
          tone: "warn",
        }
      : { text: "Clawtrate couldn't read the gateway's bot list to check.", tone: "warn" };

/**
 * How the dialog shows a delete's outcome, from the answer and the list read after it alone.
 * "Deleted" is said only on the gateway's `ok` answer for the bot; a list that lacks it says it
 * is no longer listed, never more.
 */
export function resultView(name: string, outcome: BotDeleteOutcome): ResultView | null {
  if (outcome.kind === "changed" || outcome.kind === "not-sent" || outcome.kind === "unread")
    return null;
  const gone = outcome.listed === false;
  const listed = listedLine(name, outcome);
  switch (outcome.kind) {
    // Whatever failed once the request left: the list, read again, says whether it is listed.
    case "unconfirmed":
      return {
        title: gone ? unlistedTitle(name) : "The gateway didn't confirm the delete",
        tone: "warn",
        lines: [
          { text: `The gateway didn't confirm the delete: ${outcome.message}`, tone: "warn" },
          listed,
          ...(gone ? [folderUnknown(name)] : []),
        ],
        check: true,
      };
    case "answered": {
      const partial = partialCleanup(outcome);
      const lines: ResultLine[] = [listed];
      // Asked to keep them, the gateway can still finish an earlier delete's choice: said first.
      const trashed =
        outcome.removed.filter((each) => each.method === "trash").length + outcome.removedOmitted;
      if (!outcome.deleteFiles && trashed > 0)
        lines.unshift({
          text: `Clawtrate asked the gateway to keep ${name}'s folders, but it moved ${trashed === 1 ? "one" : trashed} to the Trash on its machine. ${trashed === 1 ? "It is" : "They are"} in the Trash there, not gone.`,
          tone: "danger",
        });
      if (outcome.purgeFailed)
        lines.push({
          text: "The gateway couldn't clear its task records.",
          tone: "danger",
        });
      for (const each of outcome.failed)
        lines.push({
          text: `Couldn't move to the Trash: ${each.path}. ${each.reason}`,
          tone: "danger",
        });
      if (outcome.failedOmitted > 0)
        lines.push({
          text: `${outcome.failedOmitted} more ${outcome.failedOmitted === 1 ? "path" : "paths"} couldn't be moved.`,
          tone: "danger",
        });
      for (const each of outcome.removed)
        lines.push({
          text:
            each.method === "trash"
              ? `Moved to the Trash: ${each.path}`
              : `Already gone: ${each.path}`,
        });
      // Paths counted but not shown (past those named, or too long to show whole) are moves and
      // finds all the same.
      const shown = outcome.removed.length > 0;
      if (outcome.removedOmitted > 0)
        lines.push({
          text: shown
            ? `And ${outcome.removedOmitted} more the gateway moved to the Trash.`
            : `The gateway moved ${outcome.removedOmitted === 1 ? "one path" : `${outcome.removedOmitted} paths`} to the Trash, not shown here.`,
        });
      if (outcome.missingOmitted > 0)
        lines.push({
          text: shown
            ? `And ${outcome.missingOmitted} more already gone.`
            : `${outcome.missingOmitted === 1 ? "One path was" : `${outcome.missingOmitted} paths were`} already gone, not shown here.`,
        });
      if (outcome.removedBindings > 0)
        lines.push({
          text: `Channel routes removed: ${outcome.removedBindings}.`,
        });
      if (!outcome.deleteFiles) {
        if (trashed === 0) lines.push({ text: "Clawtrate asked the gateway to keep its folders." });
      } else if (
        !partial &&
        outcome.removed.length + outcome.removedOmitted + outcome.missingOmitted === 0
      )
        lines.push({ text: "The gateway didn't report moving any folder." });
      if (partial) lines.push({ text: LEFT_LINE, tone: "danger" });
      return {
        title: partial ? `${name} was deleted, but some of it is left` : `${name} was deleted`,
        tone: partial ? "danger" : outcome.listed === true ? "warn" : null,
        lines,
        // The answer stands; a list that couldn't be read can be read again.
        check: outcome.listed === null,
      };
    }
  }
}

/**
 * Whether closing the result means the bot is gone, so the app lands on the Main Bot: only on the
 * gateway's own answer, never on a list that merely lacks the bot.
 */
export const deletedOnClose = (outcome: BotDeleteOutcome): boolean =>
  outcome.kind === "answered" && outcome.listed === false;

/** Why nothing was sent, said over the dialog read again. */
export function changedLine(name: string, outcome: BotDeleteOutcome): string | null {
  if (outcome.kind !== "changed") return null;
  switch (outcome.reason) {
    case "gone":
      return `${name} is no longer listed on the gateway. Nothing was sent.`;
    case "main":
      return `${mainBotLine(name)} Nothing was sent.`;
    case "replaced":
      return "The bot you reviewed has changed on the gateway. Nothing was sent. Check what goes, then delete again.";
    case "moved":
      return `${name}'s workspace folder has changed on the gateway. Nothing was sent, and the folder box is cleared. Check what goes, then delete again.`;
    case "shared":
      return `${sharedLine(outcome.read) ?? "Another bot now uses this folder"}, so Clawtrate won't ask to remove its workspace folder. Nothing was sent. Check what goes, then delete again.`;
    case "changed":
      return `${name} has changed on the gateway since you looked. Nothing was sent. Check what goes, then delete again.`;
    case "files":
      return `Clawtrate can't remove ${name}'s folder now. Nothing was sent. Check what goes, then delete again.`;
  }
}
