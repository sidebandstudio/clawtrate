// A file a bot hands over that isn't a picture, under the message that carried it in the
// iPhone chat (F-115). The row says what the desktop's says where both do the same
// (`packages/ui/src/BotFiles.tsx`; a unit test keeps them the same). Save reads the file
// and opens the system's share sheet for it, so "Reading…" comes first and the sheet says
// the rest; a closed sheet says nothing.

import {
  gatewayOrigin,
  isTooLargeToSave,
  MAX_CHAT_FILE_BYTES,
  type ChatFile,
} from "@clawtrate/core";

/** Where Save is: before it, reading, the sheet open, its outcome, or why it stopped. */
export type BotFilePhase =
  | { status: "ready" }
  | { status: "reading" }
  | { status: "sharing" }
  | { status: "saved" }
  | { status: "shared" }
  | { status: "too-large" }
  | { status: "failed"; message: string };

const LIMIT = `${MAX_CHAT_FILE_BYTES / 1_048_576} MB`;

export const BOT_FILE_WORDS = {
  unreadable: "The gateway didn't hand this file over, so it can't be saved.",
  tooLarge: `Too large to save here: Clawtrate saves files up to ${LIMIT}.`,
  /** The iPhone reads a gateway's files only over https (`host/fetch.ts`). */
  cannotLoad: "This connection can't load the file from the gateway. A wss:// address can.",
  reading: "Reading…",
  saved: "Saved to Files.",
  shared: "Shared.",
  failed: (message: string) => `Couldn't save it. ${message}`,
  save: "Save",
  tryAgain: "Try again",
} as const;

/** What a row is now: its state, the line under the name, and the one button it offers. */
export type BotFileView = {
  state: "unreadable" | "too-large" | "cannot-load" | BotFilePhase["status"];
  note: string | null;
  action: "save" | "try-again" | null;
  /** Save was pressed and hasn't finished: pressing again does nothing. */
  busy: boolean;
};

/** Whether this connection's files can be read here: only from an https origin, as `wss://` gives. */
export const canLoadFiles = (gatewayUrl: string | null): boolean =>
  gatewayOrigin(gatewayUrl ?? "")?.startsWith("https:") === true;

/** The row for `file` in `phase`, at a connection that can (or can't) load files. */
export function botFileView(file: ChatFile, phase: BotFilePhase, canLoad: boolean): BotFileView {
  const W = BOT_FILE_WORDS;
  const still = (state: BotFileView["state"], note: string): BotFileView => ({
    state,
    note,
    action: null,
    busy: false,
  });
  if (file.artifactId === null) return still("unreadable", W.unreadable);
  if (phase.status === "too-large" || isTooLargeToSave(file.sizeBytes))
    return still("too-large", W.tooLarge);
  if (!canLoad) return still("cannot-load", W.cannotLoad);
  switch (phase.status) {
    case "reading":
      return { state: "reading", note: W.reading, action: "save", busy: true };
    case "sharing":
      // The sheet is over the row while it is open, so Save is pressed again only once it has
      // gone: never stuck waiting for a sheet that didn't say it closed.
      return { state: "sharing", note: null, action: "save", busy: false };
    case "saved":
      return { state: "saved", note: W.saved, action: "save", busy: false };
    case "shared":
      return { state: "shared", note: W.shared, action: "save", busy: false };
    case "failed":
      return {
        state: "failed",
        note: W.failed(phase.message),
        action: "try-again",
        busy: false,
      };
    case "ready":
      return { state: "ready", note: null, action: "save", busy: false };
  }
}
