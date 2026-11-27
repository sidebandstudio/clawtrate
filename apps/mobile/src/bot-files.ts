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
import type { ShareFile } from "./host/share.ts";
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
 * that drew it. A row from before a reconnect keeps its stamp, and core refuses its Save; once
 * the history is read again on the new connection, its rows take that one, and Save works
 * without leaving the task (the desktop keeps a row's first stamp until the task is opened
 * again, #505). Watches the client's store from the app's start, so it sees every read.
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
 * as it comes (`set`). A closed sheet goes back to ready. `gone` says the row has left the
 * screen: from then on nothing more is asked or offered, and bytes already read are let go.
 */
export async function saveBotFile(
  send: Send,
  source: StateSource,
  drawnOn: ShownStamp,
  taskKey: string,
  file: ChatFile,
  shareFile: ShareFile,
  set: (phase: BotFilePhase) => void,
  gone: () => boolean,
): Promise<void> {
  const artifactId = file.artifactId;
  if (artifactId === null) return;
  set({ status: "reading" });
  try {
    // Right after a connect this waits for the gateway to name itself.
    const stamp = await screenStamp(source, drawnOn);
    if (gone()) return;
    const read = await send({ type: "readChatFile", key: taskKey, artifactId, stamp });
    if (read.status === "too-large") return set({ status: "too-large" });
    if (read.status !== "content") return set({ status: "failed", message: read.message });
    if (gone()) {
      if (read.transfer.id)
        void send({ type: "releaseFile", id: read.transfer.id }).catch(() => {});
      return;
    }
    const bytes = await collectPicture(send, read.transfer, read.bytes);
    if (!bytes) return set({ status: "failed", message: "The file's content could not be read." });
    if (gone()) return;
    set({ status: "sharing" });
    const outcome = await shareFile(file.name, bytes);
    set(outcome === "dismissed" ? { status: "ready" } : { status: outcome });
  } catch (error) {
    set({ status: "failed", message: error instanceof Error ? error.message : String(error) });
  }
}
