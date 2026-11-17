// What a card's Raw panel shows: the gateway's record as it sent it, or why it
// is not here. Kept apart from the components so plain modules can name it.
import type { Row } from "./model.ts";

export type RawContent =
  | { state: "loading" }
  | { state: "unavailable"; reason: string }
  | { state: "failed"; retry: () => void }
  | {
      state: "loaded";
      /** The exact tool name, for a tool call. */
      tool?: string | null;
      args?: unknown;
      result?: unknown;
      error?: string | null;
      /** A tool call still running. */
      running?: boolean;
      /** Events as received, each under its own label. */
      events?: Array<[string, unknown]>;
      /** The gateway cut the result. */
      truncated?: boolean;
      timing?: Row[];
      ids: Row[];
      /** Plain sentences about what is not here, and why. */
      notes?: string[];
    };

/** A record the gateway sent that settled a request, or a request this app sent: as the engine keeps them. */
type Settling = { via: string; record: unknown };
type Sent = { method: string; params: unknown };

/** How a settling record is labelled: the event that settled it, a reply, or a read-back. */
function settlingLabel(via: string): string {
  if (via.endsWith(".resolved"))
    return `The event that settled it, as the gateway sent it (${via})`;
  if (via === "approval.get")
    return `The request as the gateway reported it when read back (${via})`;
  return `The gateway's reply to this app's request, as sent (${via})`;
}

/**
 * The records the gateway sent that settled a request and what this app
 * sent, each labelled; where the engine holds none for a settled request, a
 * line says so.
 */
export function settlingRaw(
  settled: boolean,
  settledBy: readonly Settling[],
  sent: readonly Sent[],
): { events: Array<[string, unknown]>; notes: string[] } {
  const events: Array<[string, unknown]> = [];
  const notes: string[] = [];
  for (const each of settledBy) {
    if (each.record === null)
      notes.push(`The gateway's record (${each.via}) was too long for this app to keep.`);
    else events.push([settlingLabel(each.via), each.record]);
  }
  for (const each of sent) {
    if (each.params === null)
      notes.push(`What this app sent (${each.method}) was too long to keep.`);
    else events.push([`What this app sent (${each.method})`, each.params]);
  }
  if (settled && settledBy.length === 0) {
    notes.push("This app did not receive the gateway's record of how it was settled.");
  }
  if (settled && sent.length === 0) notes.push("This app sent nothing to settle it.");
  return { events, notes };
}
