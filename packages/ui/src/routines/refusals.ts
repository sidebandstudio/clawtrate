// What a routine action the host didn't send says, by its reason (`RoutineWrite` `not-sent`).
// A moved target (`changed`) and another gateway at the same address (`gateway`) are both a
// connection that changed since the screen was opened; only `admin` is about access.

import type { RoutineWrite } from "@clawtrate/core";

export type NotSentReason = "admin" | "offline" | "gateway" | "changed";

/** The words after "Couldn't pause: " and the like, in a row's note. */
export function notSentNote(reason: NotSentReason): string {
  return reason === "changed" || reason === "gateway"
    ? "the connection changed since this was opened, so nothing was sent. Look again, then try again."
    : "nothing was sent.";
}

/** The delete confirmation's line. */
export function notSentDelete(reason: NotSentReason): string {
  return reason === "changed" || reason === "gateway"
    ? "The connection changed since this was opened, so nothing was sent. Look again, then try again."
    : "Nothing was sent: this connection can't change routines.";
}

/**
 * A pause's or resume's outcome, under its row; null once saved. One sent and never settled is
 * "Not confirmed", never "Couldn't": it may have landed.
 */
export function switchNote(word: "pause" | "resume", result: RoutineWrite): string | null {
  switch (result.status) {
    case "saved":
      return null;
    case "unknown":
      return `Not confirmed. ${result.error}`;
    case "refused":
      return `Couldn't ${word}: ${result.error}`;
    case "deleted":
      return `Couldn't ${word}: it was deleted.`;
    case "not-sent":
      return `Couldn't ${word}: ${notSentNote(result.reason)}`;
    case "conflict":
      return `Couldn't ${word}: it changed meanwhile.`;
  }
}

/** How the last Run now went, under the page's header. */
export type RunNote =
  | { status: "starting" }
  | { status: "already" }
  | { status: "failed"; error: string }
  /** Sent and never settled: whether a run started isn't known. */
  | { status: "unknown"; error: string };

export function runNoteWords(note: RunNote, paused: boolean): string {
  switch (note.status) {
    case "starting":
      return paused ? "Starting a run. It stays paused." : "Starting…";
    case "already":
      return "It's already running.";
    case "failed":
      return `Couldn't start a run: ${note.error}`;
    case "unknown":
      return `Not confirmed. ${note.error}`;
  }
}
