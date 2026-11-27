// Save for a file a bot handed over, in the iPhone chat (F-115), as the desktop saves one
// (`packages/ui/src/BotFiles.tsx`). Nothing is read until Save. Core then reads the file
// through the download the gateway issues for exactly that attachment (`readChatFile`), for
// the gateway whose history drew the row (its stamp), and refuses a read that crosses a
// reconnect. The bytes, put together from their parts, go to the share sheet as a file of
// their own (`host/share.ts`). A row that has left the screen reads and offers nothing.

import type {
  BridgeCommand,
  BridgeResultFor,
  ChatFile,
  ClawtrateState,
  TranscriptItem,
} from "@clawtrate/core";
import { screenStamp, shownStamp, type ShownStamp } from "../../../packages/ui/src/stamp.ts";
import type { ShareFile, Viewer } from "./host/share.ts";
import type { BotFilePhase } from "./presentation/bot-files.ts";
import { collectPicture } from "./sent-pictures.ts";

type Send = <C extends BridgeCommand>(command: C) => Promise<BridgeResultFor<C>>;
type StateSource = {
  getState(): ClawtrateState;
  subscribe(listener: (state: ClawtrateState) => void): () => void;
};

/** A stamp no connection has: core refuses what carries it. */
const NOWHERE: ShownStamp = { gatewayId: null, target: -1, connectedAt: null };

/**
 * Where the history each task shows was read: the connection in the first state that held
 * it. Every read of a task's history gives it new items, so a row takes the stamp of the read
 * that drew it, and keeps it. Core refuses its Save only when the target has changed since (a
 * Connect, Disconnect, switch or new pairing), when the identity read on the connection open now
 * differs, or when the read itself crosses a reconnect. A socket reconnect to the same gateway
 * keeps both, so Save still works there. After a switch, once the history is read again, its
 * rows take the new stamp and Save works without leaving the task (the desktop keeps a row's
 * first stamp until the task is opened again, #505). Watches the client's store from the app's
 * start, so it sees every read.
 */
export function historyStamps(source: StateSource): {
  of(items: readonly TranscriptItem[]): ShownStamp;
  stop(): void;
} {
  const stamps = new WeakMap<readonly TranscriptItem[], ShownStamp>();
  const note = (state: ClawtrateState) => {
    for (const transcript of Object.values(state.transcripts))
      if (transcript && !stamps.has(transcript.items))
        stamps.set(transcript.items, shownStamp(state.connection));
  };
  note(source.getState());
  return { of: (items) => stamps.get(items) ?? NOWHERE, stop: source.subscribe(note) };
}

/**
 * Save one file: read it through core, then offer it in the share sheet, saying each state
 * as it comes (`set`). A closed sheet goes back to ready. Once `viewer` has left the screen,
 * nothing more is asked or offered: a transfer under way is let go between its parts, bytes
 * already read are dropped, and the native side presents no sheet (`host/share.ts`). Core keeps
 * a read already waiting for its place (its owner is the app's one bridge session), but its
 * bytes are let go as soon as they come. Why a Save failed is shown and read out only with
 * every credential this host holds scrubbed out (`redact`): a gateway's error can echo one.
 */
export async function saveBotFile(
  send: Send,
  source: StateSource,
  drawnOn: ShownStamp,
  taskKey: string,
  file: ChatFile,
  shareFile: ShareFile,
  set: (phase: BotFilePhase) => void,
  viewer: Viewer,
  redact: (text: string) => string,
): Promise<void> {
  const artifactId = file.artifactId;
  if (artifactId === null) return;
  const fail = (message: string) => set({ status: "failed", message: redact(message) });
  const gone = viewer.gone;
  set({ status: "reading" });
  try {
    // Right after a connect this waits for the gateway to name itself.
    const stamp = await screenStamp(source, drawnOn);
    if (gone()) return;
    const read = await send({ type: "readChatFile", key: taskKey, artifactId, stamp });
    if (read.status === "too-large") return set({ status: "too-large" });
    if (read.status !== "content") return fail(read.message);
    if (gone()) {
      if (read.transfer.id)
        void send({ type: "releaseFile", id: read.transfer.id }).catch(() => {});
      return;
    }
    const bytes = await collectPicture(send, read.transfer, read.bytes, gone);
    if (gone()) return;
    if (!bytes) return fail("The file's content could not be read.");
    set({ status: "sharing" });
    const outcome = await shareFile(file.name, bytes, viewer);
    set(outcome === "dismissed" ? { status: "ready" } : { status: outcome });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
