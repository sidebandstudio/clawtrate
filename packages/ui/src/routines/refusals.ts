// What a routine action the host didn't send says, by its reason (`RoutineWrite` `not-sent`).
// A moved target (`changed`) and another gateway at the same address (`gateway`) are both a
// connection that changed since the screen was opened; only `admin` is about access.

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
