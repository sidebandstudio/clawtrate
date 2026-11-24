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
  type SentPictureRead,
  type ClawtrateState,
  type EngineContext,
} from "@clawtrate/core";
import { OPEN_TASK } from "./data.ts";

export const PICTURE_SCENES = [
  "pictures",
  "pictures-failed",
  "pictures-message",
  "pictures-sent",
] as const;
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

/**
 * `pictures-message`: the bot sends the picture with its message tool. The gateway
 * runs the send as its reply in the task, a row of its own in the same run
 * (`delivery-mirror`) with the text and the picture, and the bot then says one more line.
 */
function messageRows(start: number) {
  const run = "r7-1";
  const meta = (id: string, seq: number) => ({ id, seq, runId: run });
  return [
    {
      role: "user",
      content: "Send me the picture for the newsletter.",
      timestamp: start,
      __openclaw: { id: "row-1", seq: 1 },
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_send_1",
          name: "message",
          arguments: { action: "send", message: "Here is the picture.", media: "pictures/sun.png" },
        },
      ],
      timestamp: start + SECOND,
      model: "scripted/dev-1",
      __openclaw: meta("row-2", 2),
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Here is the picture." },
        {
          type: "image",
          artifactId: "artifact_managed_image_fbabd0fe-ab39-4db6-88ba-6bb4bb348ea3",
          // Never loaded: the picture comes only through the download the gateway issues.
          url: "/api/chat/media/outgoing/agent%3Aotto%3Adisk-space/fbabd0fe/full",
          alt: "sun.png",
          mimeType: "image/png",
          width: 256,
          height: 256,
          sizeBytes: PICTURE_BYTES,
        },
      ],
      timestamp: start + 2 * SECOND,
      model: "delivery-mirror",
      __openclaw: meta("row-3", 3),
    },
    {
      role: "toolResult",
      toolCallId: "call_send_1",
      toolName: "message",
      content: [
        {
          type: "text",
          text: "Sent visible reply to the current source conversation via internal-ui.",
        },
      ],
      isError: false,
      timestamp: start + 2 * SECOND,
      __openclaw: meta("row-4", 4),
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "It fits the top of the newsletter." }],
      timestamp: start + 3 * SECOND,
      model: "scripted/dev-1",
      __openclaw: meta("row-5", 5),
    },
  ];
}

/** A picture the fixture's person sent (#451): made here, 240 × 160. */
const SENT_PICTURE =
  "iVBORw0KGgoAAAANSUhEUgAAAPAAAACgCAIAAAC9uXYyAAACNklEQVR42u3csQ2EMBBFQRdGQFnU5DacuAiKcOKcAoi9wstIP3/SMtJd5HJet1maFScwoM2ANgPaDGgD2gxoM6DNgDYD2oA2A9oMaDOgzYA2oM2ANgPaDGgzoA1oM6DNgDYD2gxoA9oMaDOgzYA2A9qANtsAdO/NLM2Atoyg5xzB09VdMaB1gXZoXaB9YF2gdXWB1gXaoXWBdmhdoH1gXaB1dYHWBdqhdYF2aF2gfWBdoHV1gdYF2qF1gXZoXaB1dYHW1QVaF2iH1gXaoXWB1tUFWlcXaF2gHVoXaIfWBVpXF2hd3TdoM+9Dm3kf+hs/haMeYfOXw39ooIEGGmiggQYaaKCBBhpooIEGGmiggQYaaKCBBhpooIEGGmiggQYaaKCBBhpooIEGGmiggQYaaKCBBhpooIEGGmiggQYaaKCBBhpooIEGGmiggQYaaKCBBhpooIEGGmiggQYaaO9Dm3kf2sz70Lr+Qzu0LtAOrQu0ri7QurpA6wLt0LpAO7Qu0Lq6QOsC7dC6QDu0LtA+sC7QurpA6wLt0LpAO7Qu0D6wLtC6ukDrAu3QukA7tC7QurpA6+oCrQu0Q+sC7dC6QOvqAq2rC7Tun0CbeR/azPvQfoJ1/YfW1QVaF2iH1gXaoXWB9oF1gdbVBVoXaIfWBdqhdYHW1QVaVxdoXaAdWhdoh9YFWlcXaF1doHWBdmhdoB1aF2hdXaB1dYHWBdqhdYF2aF2gdXWB1tUFWhdoh9YF2qF1g/YAenFpZ9y1lUgAAAAASUVORK5CYII=";
const SENT_PICTURE_BYTES = 623;

/**
 * Your messages with files (#451), as the gateway keeps them (`__openclaw.media`): one with a
 * picture this app sent and still holds, one with a text file, and one sent from another device,
 * whose picture this app has no copy of.
 */
function sentRows(start: number) {
  const user = (id: string, text: string, media: unknown[], seq: number) => ({
    role: "user",
    content: text,
    timestamp: start + seq * SECOND,
    idempotencyKey: `${id}:user`,
    __openclaw: { id: `row-${seq}`, seq, idempotencyKey: `${id}:user`, media },
  });
  const bot = (text: string, runId: string, seq: number) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: start + seq * SECOND,
    model: "scripted/dev-1",
    __openclaw: { id: `row-${seq}`, seq, runId },
  });
  const media = (name: string, contentType: string, sizeBytes: number) => ({
    // Never loaded or kept: Clawtrate doesn't load a person's picture from the gateway (#469).
    url: `media://inbound/${name.replace(/\.[^.]+$/, "")}---7d0e1a3c-5b2f-4c9e-8a61-0f3b2d4c6e81${name.slice(name.lastIndexOf("."))}`,
    contentType,
    kind: contentType.startsWith("image/") ? "image" : "document",
    fileName: name,
    sizeBytes,
  });
  return [
    user(
      "sent-1",
      "can u add this to my calendar?",
      [media("calendar.png", "image/png", SENT_PICTURE_BYTES)],
      1,
    ),
    bot("Added: Thursday, 4 pm, dentist.", "sent-1", 2),
    user(
      "sent-2",
      "here are my notes",
      // scan.png is named as a picture, but the app found its bytes aren't one.
      [media("notes.txt", "text/plain", 2_310), media("scan.png", "image/png", 3_072)],
      3,
    ),
    bot("Got them. Milk, eggs and bread are on the list.", "sent-2", 4),
    user(
      "elsewhere-1",
      "and this one, from my phone",
      [media("receipt.jpg", "image/jpeg", 48_211)],
      5,
    ),
    bot("I can see you sent a picture.", "elsewhere-1", 6),
  ];
}

export function pictureScene(base: ClawtrateState, now: number, name: string): ClawtrateState {
  const start = now - 20 * 60 * SECOND;
  const history =
    name === "pictures-message"
      ? messageRows(start)
      : name === "pictures-sent"
        ? sentRows(start)
        : rows(start);
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

/** The host's answer for a picture you sent: the one this app sent and holds, and no other. */
export function sentPictureAnswer(command: { messageKey: string; index: number }): SentPictureRead {
  if (command.messageKey === "sent-2:user" && command.index === 1)
    return { status: "not-a-picture" };
  if (command.messageKey !== "sent-1:user" || command.index !== 0) return { status: "not-kept" };
  return {
    status: "content",
    kind: "image",
    mimeType: "image/png",
    bytes: SENT_PICTURE_BYTES,
    transfer: { id: null, chunks: 1, data: SENT_PICTURE },
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
