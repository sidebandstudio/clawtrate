// Files a bot handed over that aren't pictures, in the conversation (F-115).
// The history is written in the gateway's own shapes, as a development gateway
// recorded them (OpenClaw 2026.10.6, the `#attach` scenario): the bot's answer
// ends with `MEDIA:` lines, and the gateway's history gives its row an
// `attachment` block for each document, an `audio` block for a recording, and
// an `attachment_error` block for a file it couldn't hand over. A later answer
// is only a file. This host has a save of its own, as the desktop app does, so
// "Saved" shows once it has saved.

import {
  mapHistory,
  RawTable,
  runsFromHistory,
  type ChatFileRead,
  type ClawtrateState,
  type EngineContext,
  type SaveResult,
} from "@clawtrate/core";
import { reviewsDraftPdf } from "../../../../tools/dev-gateway/src/scripted-files.ts";
import { OPEN_TASK } from "./data.ts";

export const BOT_FILE_SCENES = ["bot-files"] as const;
export type BotFileScene = (typeof BOT_FILE_SCENES)[number];

export const isBotFileScene = (value: string): value is BotFileScene =>
  (BOT_FILE_SCENES as readonly string[]).includes(value);

const SECOND = 1000;
const PDF = "artifact_managed_media_470797d5-f45d-444a-901d-21a6bd2c2f96";
const NOTES = "artifact_managed_media_dcdee85c-5f62-4293-9cc5-68c53084eba3";
const PHOTOS = "artifact_managed_media_5b1f0c2e-8d4a-4f6e-9a3b-2c7d1e0f4a59";
const MEMO = "artifact_managed_media_918577ee-2ad0-4853-a314-7e97363a6b6d";
const ROUTE = "artifact_managed_media_8a3f8f11-0ea3-4b24-8c4d-4635cfe72160";

/** The address a block names: never loaded, only the download the gateway issues is. */
const outgoing = (artifactId: string) =>
  `/api/chat/media/outgoing/${encodeURIComponent(OPEN_TASK)}/${artifactId.slice(-36)}/full`;
const attachment = (artifactId: string, label: string, mimeType: string, sizeBytes: number) => ({
  type: "attachment",
  attachment: {
    artifactId,
    url: outgoing(artifactId),
    kind: "document",
    label,
    mimeType,
    sizeBytes,
  },
});

function rows(start: number) {
  const meta = (id: string, runId: string | null, seq: number) => ({
    id,
    seq,
    ...(runId ? { runId } : {}),
  });
  const pdf = reviewsDraftPdf();
  return [
    {
      role: "user",
      content: "Put both trail reviews in one PDF and attach it.",
      timestamp: start,
      __openclaw: meta("row-1", null, 1),
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_write_1",
          name: "write",
          arguments: { path: "reports/reviews-draft.pdf", content: pdf },
        },
      ],
      timestamp: start + SECOND,
      model: "scripted/dev-1",
      __openclaw: meta("row-2", "run-files-1", 2),
    },
    {
      role: "toolResult",
      toolCallId: "call_write_1",
      toolName: "write",
      content: [{ type: "text", text: `Successfully wrote ${pdf.length} bytes` }],
      isError: false,
      timestamp: start + 2 * SECOND,
      __openclaw: meta("row-3", "run-files-1", 3),
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Both reviews are in this two-page draft." },
        attachment(PDF, "reviews-draft.pdf", "application/pdf", pdf.length),
        attachment(NOTES, "reviews.txt", "text/plain", 55),
        attachment(PHOTOS, "trail-photos.zip", "application/zip", 6_291_456),
        {
          type: "audio",
          artifactId: MEMO,
          url: outgoing(MEMO),
          openUrl: outgoing(MEMO),
          fileName: "voice-note.wav",
          mimeType: "audio/wav",
          playback: "native",
          sizeBytes: 182_444,
        },
        {
          type: "attachment_error",
          attachment: {
            code: "delivery-failed",
            kind: "document",
            label: "gps-track.bin",
            mimeType: "application/octet-stream",
          },
        },
      ],
      timestamp: start + 3 * SECOND,
      model: "scripted/dev-1",
      __openclaw: meta("row-4", "run-files-1", 4),
    },
    {
      role: "user",
      content: "And the route as a spreadsheet?",
      timestamp: start + 60 * SECOND,
      __openclaw: meta("row-5", null, 5),
    },
    {
      role: "assistant",
      content: [attachment(ROUTE, "route.csv", "text/csv", 1_204)],
      timestamp: start + 62 * SECOND,
      model: "scripted/dev-1",
      __openclaw: meta("row-6", "run-files-2", 6),
    },
  ];
}

export function botFileScene(base: ClawtrateState, now: number): ClawtrateState {
  const history = rows(now - 20 * 60 * SECOND);
  const ctx: EngineContext = { sessionKey: OPEN_TASK, now, raw: new RawTable() };
  const transcript = base.transcripts[OPEN_TASK]!;
  return {
    ...base,
    transcripts: {
      ...base.transcripts,
      [OPEN_TASK]: {
        ...transcript,
        items: mapHistory(history),
        runs: runsFromHistory(history, null, ctx),
        outbox: [],
        approvals: [],
        questions: [],
      },
    },
  };
}

/** The host's read of a file: the PDF's bytes and the route's; the notes the gateway no longer has. */
export function botFileAnswer(command: { artifactId: string }): ChatFileRead {
  const text =
    command.artifactId === PDF
      ? reviewsDraftPdf()
      : command.artifactId === ROUTE
        ? "stop,km\nLake,0\nRidge,6\n"
        : null;
  if (text === null)
    return { status: "failed", message: "The gateway answered 404 for this file." };
  return {
    status: "content",
    mimeType: command.artifactId === PDF ? "application/pdf" : "text/csv",
    bytes: text.length,
    transfer: { id: null, chunks: 1, data: btoa(text) },
  };
}

/** What this host saved, by name, as base64: a check reads it back. */
export type SavedFile = { name: string; data: string };

/** The host's save: it says "saved" only once it has the bytes, and waits while answers are held. */
export function botFileSave(
  saved: SavedFile[],
  later: (run: () => void) => void,
): (file: { name: string; data: ArrayBuffer }) => Promise<SaveResult> {
  return (file) =>
    new Promise((resolve) =>
      later(() => {
        let binary = "";
        for (const byte of new Uint8Array(file.data)) binary += String.fromCharCode(byte);
        saved.push({ name: file.name, data: btoa(binary) });
        resolve({ status: "saved", name: file.name });
      }),
    );
}
