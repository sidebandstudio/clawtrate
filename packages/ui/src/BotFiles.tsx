// The files a bot handed over that aren't pictures, under the message that
// carried them (F-115): a document icon, the file's name and size, and Save.
// Nothing is fetched until the person asks: Save reads the bytes through the
// download the gateway issues (`readChatFile`) and hands them to the host to
// save, the desktop app's save dialog or the browser's download. Nothing is
// opened or run. "Saved" is said only once the host says the bytes are there.
// The file is read only while the host still has the gateway that drew the row.

import {
  isTooLargeToSave,
  MAX_CHAT_FILE_BYTES,
  type ChatFile,
  type ClawtrateBridge,
} from "@clawtrate/core";
import { useRef, useState } from "react";
import { useBridge } from "./bridge.tsx";
import { size } from "./Composer.tsx";
import { FileIcon } from "./icons.tsx";
import { screenStamp, shownStamp, type ShownStamp } from "./stamp.ts";
import { collectBytes } from "./work/content.ts";
import { downloadBytes } from "./work/download.ts";

export type Phase =
  | { status: "ready" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "downloaded" }
  | { status: "too-large" }
  | { status: "failed"; message: string };

const LIMIT = `${MAX_CHAT_FILE_BYTES / 1_048_576} MB`;

/** What the row says under the file's name, for each state. */
export function fileNote(file: ChatFile, phase: Phase): string | null {
  if (file.artifactId === null)
    return "The gateway didn't hand this file over, so it can't be saved.";
  if (phase.status === "too-large" || isTooLargeToSave(file.sizeBytes))
    return `Too large to save here: Clawtrate saves files up to ${LIMIT}.`;
  switch (phase.status) {
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved.";
    case "downloaded":
      return "Handed to your browser's downloads.";
    case "failed":
      return `Couldn't save it. ${phase.message}`;
    default:
      return null;
  }
}

/**
 * Save one file, saying each state as it comes: read it through the host, hand
 * its bytes to the host's save, and say "Saved" only once the host has. A
 * closed save dialog goes back to ready, saying nothing.
 */
export async function saveChatFile(
  bridge: ClawtrateBridge,
  taskKey: string,
  file: ChatFile,
  set: (phase: Phase) => void,
  shown: ShownStamp,
): Promise<void> {
  const artifactId = file.artifactId;
  if (artifactId === null) return;
  set({ status: "saving" });
  const fail = (message: string) => set({ status: "failed", message });
  try {
    const stamp = await screenStamp(bridge, shown);
    const read = await bridge.invoke({ type: "readChatFile", key: taskKey, artifactId, stamp });
    if (read.status === "too-large") return set({ status: "too-large" });
    if (read.status !== "content") return fail(read.message);
    const data = await collectBytes(bridge, read.transfer, read.bytes);
    if (!(data instanceof Uint8Array)) return fail(data.message);
    const outcome = await downloadBytes(bridge, file.name, data);
    if (outcome === null) return set({ status: "ready" });
    if (!outcome.ok) return fail(outcome.detail ?? outcome.announcement);
    set({ status: bridge.save ? "saved" : "downloaded" });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function BotFile({ taskKey, file }: { taskKey: string; file: ChatFile }) {
  const bridge = useBridge();
  // The gateway this row was drawn from: Save reads the file only while the host still has it.
  const [shown] = useState(() => shownStamp(bridge.getState().connection));
  const [phase, setPhase] = useState<Phase>({ status: "ready" });
  const row = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const artifactId = file.artifactId;
  const state =
    artifactId === null
      ? "unreadable"
      : isTooLargeToSave(file.sizeBytes)
        ? "too-large"
        : phase.status;
  const savable = state !== "unreadable" && state !== "too-large";

  const save = () => {
    // Pressed again while saving: nothing. The button stays focusable, so focus stays on it.
    if (phase.status === "saving") return;
    void saveChatFile(
      bridge,
      taskKey,
      file,
      (next) => {
        // The button goes once the file turns out too large: focus stays in the row.
        if (next.status === "too-large" && document.activeElement === button.current)
          row.current?.focus();
        setPhase(next);
      },
      shown,
    );
  };

  const note = fileNote(file, phase);
  const details = [file.sizeBytes === null ? null : size(file.sizeBytes), file.mimeType]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="bot-file" data-testid="bot-file" data-state={state} ref={row} tabIndex={-1}>
      <FileIcon aria-hidden="true" />
      <span className="bot-file-text">
        <span className="bot-file-name">{file.name}</span>
        {details && <span className="bot-file-details">{details}</span>}
      </span>
      {savable && (
        <button
          ref={button}
          type="button"
          className="button"
          aria-label={`Save ${file.name}`}
          aria-disabled={phase.status === "saving" ? true : undefined}
          onClick={save}
        >
          Save
        </button>
      )}
      {/* One live region, always in the page with the same role: each state's words are announced. */}
      <span className="bot-file-note" role="status">
        {note}
      </span>
    </div>
  );
}

/** Files of a bot's message, in the order it gave them. */
export function BotFiles({ taskKey, files }: { taskKey: string; files: readonly ChatFile[] }) {
  if (files.length === 0) return null;
  return (
    <div className="bot-files" data-testid="bot-files">
      {files.map((file, index) => (
        <BotFile key={`${file.artifactId ?? "none"}:${index}`} taskKey={taskKey} file={file} />
      ))}
    </div>
  );
}
