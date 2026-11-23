// A picture a bot made, in the conversation (F-535). The history is written in
// the gateway's own shapes, as a development gateway with the stand-in image
// provider recorded them: the bot's `image_generate` call starts a background
// task, and the gateway's own turn in the same task carries the picture as an
// `image` block. It goes through the engine (`mapHistory`, `runsFromHistory`).
// The picture is the stand-in's own (tools/dev-gateway/src/scripted-images.ts).

import {
  mapHistory,
  RawTable,
  runsFromHistory,
  type ChatPictureRead,
  type ClawtrateState,
  type EngineContext,
} from "@clawtrate/core";
import { OPEN_TASK } from "./data.ts";

export const PICTURE_SCENES = ["pictures", "pictures-failed"] as const;
export type PictureScene = (typeof PICTURE_SCENES)[number];

export const isPictureScene = (value: string): value is PictureScene =>
  (PICTURE_SCENES as readonly string[]).includes(value);

/** The stand-in image provider's 256 × 256 PNG. */
const PICTURE =
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAADPklEQVR42u3dQQ3CQABFwXWCAByQJhxxQQVUDHbQhQJOXAkcSMm+SZ6Bdv8c2x2H0yplG16BAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQANC7Hvfl8wBQcfezSgDA9JeyBABMP80AANNPGwDA+tMMADD9tAEArD9tAADrTxsAwPrTBgCw/rQBAKw/bQAAANIGALB+AGT9VQMAAJA2AID1AyAAqgYAsH4ABAAAAiBoAADrB0AAACAAggYAAAAAWT8AAgAAAQCAAABAAAAgAAAQAAAIAAAEAAACAAABAIAYAEAAACAAfA8gAAAQAwAIAH+FEAMACAC/RhQAAKhu4D9fGgAMACAA3BAjBlySJwYAEAPuCRYAbooXAzOvHwAM0usHgIH0+gFgoDt9ADCorx8ABrrTB4CE9PQB0JrdPQD6GsOUTw2A0gEgACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQA9u18236U9QAQmjsSAFg8DwAYPQwA2D0MABg9CQCYPgkA2D0GANg9CQCYPgYAmD4GAJg+BgCYPgYAmD4GaQAmi0EXgKViEAVgnQxEARglBl0AtshAFIAJYtAFYHkMRAEYHAZdAHbGQBeAhTEQBWBYGHQB2BMDXQCWxEAXgA0x0AVgPRh0ARgNA1EAtsJAF4CVMNAFYB8MdAFYBgNdADbBQBeANTAAgBhIAjACBroAHL+6AJy9ggaG9atsYFi/ygaGk1bZAABKGwBAAEhVAwAobQAApQ0AIACkqgEAlDYAgACQqgYAUNoAAAJAqhoAQGkDAAgAqWoAAAEgVQ0AIACkqgEABIBUNQCAAJCqBgAQAFLVAAACQAJAChoAQABIVQMACAApC+B4vUjZABAAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIA0qsn3zGYR7Xdo9MAAAAASUVORK5CYII=";
const PICTURE_BYTES = 887;
const PROMPT = "A sun over a green hill, in flat solid colours";
const TASK = "tool:image_generate:9b21401e-321f-48bb-a101-c2db7c0d78e9";
const SECOND = 1000;

/** The task's history: the ask, the call that starts the picture, and the gateway's turn with it. */
function rows(start: number) {
  const run = "508fda46-2d35-4b8c-becf-d4d3e61bbe7f";
  const meta = (id: string, runId: string | null, seq: number) => ({
    id,
    seq,
    ...(runId ? { runId } : {}),
  });
  return [
    {
      role: "user",
      content: "Draw the sun over a green hill for the newsletter.",
      timestamp: start,
      __openclaw: meta("row-1", null, 1),
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I will ask the image tool for a picture." },
        {
          type: "toolCall",
          id: "call_pic_1",
          name: "image_generate",
          arguments: { prompt: PROMPT },
        },
      ],
      timestamp: start + SECOND,
      model: "scripted/dev-1",
      __openclaw: meta("row-2", run, 2),
    },
    {
      role: "toolResult",
      toolCallId: "call_pic_1",
      toolName: "image_generate",
      content: [
        {
          type: "text",
          text: `Background task started for image generation (${TASK}). Do not call image_generate again for this request.`,
        },
      ],
      details: { async: true, status: "started", taskId: TASK },
      isError: false,
      timestamp: start + 2 * SECOND,
      __openclaw: meta("row-3", run, 3),
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "I asked for the picture. It will arrive in this task when it is ready.",
        },
      ],
      timestamp: start + 3 * SECOND,
      model: "scripted/dev-1",
      __openclaw: meta("row-4", run, 4),
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Here is the picture you asked for." },
        {
          type: "image",
          artifactId: "artifact_managed_image_2de197ca-510c-4299-bd7a-ded7fe92de0c",
          // Never loaded: the picture comes only through the download the gateway issues.
          url: "/api/chat/media/outgoing/agent%3Aotto%3Adisk-space/2de197ca/full",
          alt: "image-1.png",
          mimeType: "image/png",
          width: 256,
          height: 256,
          sizeBytes: PICTURE_BYTES,
        },
      ],
      timestamp: start + 10 * SECOND,
      model: "scripted/dev-1",
      __openclaw: meta("row-6", `image_generate:${TASK}:ok:agent-loop`, 6),
    },
  ];
}

export function pictureScene(base: ClawtrateState, now: number): ClawtrateState {
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

/** The host's answer for the picture: in `pictures-failed`, the first read fails and Try again works. */
export function pictureAnswers(name: string) {
  let reads = 0;
  return (): ChatPictureRead => {
    reads += 1;
    if (name === "pictures-failed" && reads === 1)
      return { status: "failed", message: "The gateway refused this picture's download ticket." };
    return {
      status: "content",
      kind: "image",
      mimeType: "image/png",
      bytes: PICTURE_BYTES,
      transfer: { id: null, chunks: 1, data: PICTURE },
    };
  };
}
