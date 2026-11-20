// What a bot hands over, on fixed data, for the fixture and the visual checks
// (work-pane.md, Part 2, and its prototype states): Juniper's task about the
// library's e-book app, with every kind of card. Everything is invented, and
// every picture, sound and clip is made by this repository. The address picks
// the state:
//
//   &artifacts=on        Juniper gains the task (agent:main:library-loans)
//   &artifactload=failed the first opening of an item fails; Try again succeeds
//   &thumbs=failed|original  the gateway's thumbnail fails, or comes back over 2 MB
//   &linkpreview=none    the link's page gives no preview

import {
  emptyActivity,
  sha256Hex,
  toBase64,
  utf8Bytes,
  type Artifact,
  type ArtifactList,
  type ArtifactRead,
  type BridgeCommand,
  type ClawtrateState,
  type LinkPreview,
  type Task,
  type Transcript,
  type TranscriptItem,
} from "@clawtrate/core";
import { blueClip, chartPicture, png, toneRecording } from "./files.ts";

export type ArtifactParams = {
  on: boolean;
  failFirstOpen: boolean;
  thumbs: "ok" | "failed" | "original";
  linkPreview: boolean;
  /** Pictures whose bytes are not the picture their type names (`artifactbytes=broken`). */
  brokenPictures: boolean;
  /** The zip's size is not reported, and its read is refused as too large (`sizes=unknown`). */
  unknownSizes: boolean;
  /** The report names a link by its words alone, and a relative one (`reportlinks=on`). */
  reportLinks: boolean;
  /** The recording's bytes are not audio this device can play (`audio=broken`). */
  brokenAudio: boolean;
  /** The recording's whole read answers after 800 ms (`audio=slow`). */
  slowAudio: boolean;
  /** The task's artifact listing is refused, and nothing else is (`artifactlist=failed`). */
  listFails: boolean;
};

export function artifactParams(params: URLSearchParams): ArtifactParams {
  const thumbs = params.get("thumbs");
  return {
    on: params.get("artifacts") === "on",
    failFirstOpen: params.get("artifactload") === "failed",
    thumbs: thumbs === "failed" || thumbs === "original" ? thumbs : "ok",
    linkPreview: params.get("linkpreview") !== "none",
    brokenPictures: params.get("artifactbytes") === "broken",
    unknownSizes: params.get("sizes") === "unknown",
    reportLinks: params.get("reportlinks") === "on",
    brokenAudio: params.get("audio") === "broken",
    slowAudio: params.get("audio") === "slow",
    listFails: params.get("artifactlist") === "failed",
  };
}

export const ARTIFACT_TASK = "agent:main:library-loans";
const MINUTE = 60_000;

/** Three apps compared: bars on a pale ground. */
function appsChart(): Uint8Array {
  const bars = [210, 150, 95];
  const colors: [number, number, number][] = [
    [91, 141, 255],
    [69, 189, 245],
    [120, 200, 160],
  ];
  return png(240, 180, (x, y) => {
    const bar = Math.floor((x - 30) / 66);
    if (bar >= 0 && bar < 3 && (x - 30) % 66 < 44 && y > 170 - bars[bar]! * 0.7 && y < 170)
      return colors[bar]!;
    return y === 170 ? [190, 190, 186] : [250, 250, 248];
  });
}

/** A growing curve, larger than a card draws from its own bytes: its card asks for the thumbnail. */
function growthPicture(): Uint8Array {
  return png(200, 140, (x, y) => {
    const curve = 130 - Math.pow(x / 200, 2) * 110;
    if (y > curve) return [255, 196, 120];
    return [252, 248, 240];
  });
}

const REPORT =
  "# Borrowing e-books\n\n## Found\n\n- Your library lends through Shelfwise.\n- Holds take about nine days.\n\n## Left\n\n- Renew the card before March.\n";
const PAGE =
  '<!doctype html><html><body style="font:15px/1.5 system-ui,sans-serif;margin:32px 40px;color:#111213"><h2>E-book apps compared</h2><p>Sort by titles, wait time or cost.</p><table style="width:100%;border-collapse:collapse"><tr><th align=left>App</th><th align=left>Titles</th><th align=left>Typical wait</th></tr><tr><td>Shelfwise</td><td>48,000</td><td>9 days</td></tr><tr><td>PageLoop</td><td>31,000</td><td>14 days</td></tr><tr><td>Readmore</td><td>22,000</td><td>6 days</td></tr></table><p>Read <a href="https://library.example/compare">the comparison</a>.</p><form action="https://library.example/sort"><button>Sort</button></form><script>document.body.dataset.ran=\'yes\'</script><img src="https://tracker.example/pixel.png" alt=""></body></html>';

type FixtureItem = {
  artifact: Omit<Artifact, "key" | "position" | "messageSeq">;
  seq: number;
  bytes?: Uint8Array;
};

function fixtureItems(): FixtureItem[] {
  const terms = utf8Bytes("%PDF-1.4\n% A made-up lending terms document\n");
  const item = (
    seq: number,
    id: string,
    kind: Artifact["kind"],
    title: string,
    mimeType: string | null,
    size: number | null,
    mode: Artifact["mode"],
    place: Artifact["place"],
    bytes?: Uint8Array,
  ): FixtureItem => ({
    seq,
    artifact: {
      id,
      kind,
      title,
      mimeType,
      size: size ?? (bytes ? bytes.length : null),
      runId: "run-loans",
      mode,
      place,
    },
    ...(bytes ? { bytes } : {}),
  });
  const gateway = { kind: "gateway" } as const;
  return [
    item(
      3,
      "artifact_managed_media_10000000-0000-4000-8000-000000000001",
      "file",
      "borrowing-report.md",
      "text/markdown",
      null,
      "url",
      gateway,
      utf8Bytes(REPORT),
    ),
    item(
      3,
      "artifact_terms",
      "file",
      "lending-terms.pdf",
      "application/pdf",
      null,
      "bytes",
      gateway,
      terms,
    ),
    item(
      3,
      "artifact_managed_media_10000000-0000-4000-8000-000000000002",
      "file",
      "app-screens.zip",
      "application/zip",
      8_808_038,
      "url",
      gateway,
    ),
    item(3, "artifact_card", "file", "library-card.pkpass", null, null, "unsupported", {
      kind: "none",
    }),
    item(3, "artifact_faq", "file", "lending-faq.pdf", "application/pdf", null, "url", {
      kind: "elsewhere",
      host: "help.library.example",
      url: "https://help.library.example/lending-faq.pdf",
    }),
    item(6, "artifact_cover", "image", "cover.jpg", "image/jpeg", 214_000, "unsupported", {
      kind: "none",
    }),
    item(
      6,
      "artifact_managed_image_10000000-0000-4000-8000-000000000003",
      "image",
      "apps-compared.png",
      "image/png",
      null,
      "url",
      gateway,
      appsChart(),
    ),
    item(
      6,
      "artifact_managed_image_10000000-0000-4000-8000-000000000004",
      "image",
      "cache-growth.png",
      "image/png",
      3_250_585,
      "url",
      gateway,
      growthPicture(),
    ),
    item(
      6,
      "artifact_managed_image_10000000-0000-4000-8000-000000000005",
      "image",
      "usage.png",
      "image/png",
      null,
      "url",
      gateway,
      chartPicture(),
    ),
    item(
      6,
      "artifact_managed_media_10000000-0000-4000-8000-000000000006",
      "video",
      "borrowing-walkthrough.webm",
      "video/webm",
      null,
      "url",
      gateway,
      blueClip(),
    ),
    item(
      6,
      "artifact_managed_media_10000000-0000-4000-8000-000000000007",
      "audio",
      "voice-note.wav",
      "audio/wav",
      null,
      "url",
      gateway,
      toneRecording(),
    ),
  ];
}

function transcriptItems(at: number): TranscriptItem[] {
  return [
    {
      id: "loans-1",
      role: "user",
      timestamp: at - 8 * MINUTE,
      blocks: [{ kind: "text", text: "Which e-book app does my library use, and is it any good?" }],
      model: null,
      seq: 1,
    },
    {
      id: "loans-2",
      role: "assistant",
      timestamp: at - 7 * MINUTE,
      blocks: [
        {
          kind: "text",
          text: "Your library lends e-books through Shelfwise. I compared it with the other two apps libraries use, and made a page you can sort. The library's own page is https://library.example/ebooks",
        },
        { kind: "page", docId: "apps-compared", title: "E-book apps compared" },
      ],
      model: "scripted/dev-1",
      seq: 3,
    },
    {
      id: "loans-3",
      role: "user",
      timestamp: at - 4 * MINUTE,
      blocks: [{ kind: "text", text: "Show me what borrowing looks like." }],
      model: null,
      seq: 4,
    },
    {
      id: "loans-4",
      role: "assistant",
      timestamp: at - 3 * MINUTE,
      blocks: [
        { kind: "text", text: "Here are the screens, a short walkthrough, and a note on holds." },
        {
          kind: "attachment-error",
          label: "reading-list.csv",
          code: "delivery-failed",
          media: "document",
        },
        // The same Page shared again: its earlier card says it is shown again below.
        { kind: "page", docId: "apps-compared", title: "E-book apps compared" },
      ],
      model: "scripted/dev-1",
      seq: 6,
    },
  ];
}

/** Juniper's task with every kind of card, added to the scene's state. */
/** Each fixture item's bytes by its title, for checks that compare what was saved or copied. */
export function artifactBytes(): Record<string, Uint8Array> {
  return Object.fromEntries(
    fixtureItems().flatMap((item) => (item.bytes ? [[item.artifact.title, item.bytes]] : [])),
  );
}

export function withArtifactTask(state: ClawtrateState, now: number): ClawtrateState {
  const task: Task = {
    key: ARTIFACT_TASK,
    botId: "main",
    sessionId: "main-library-loans",
    title: "Borrowing e-books from the library",
    preview: "Here are the screens, a short walkthrough, and a note on holds.",
    updatedAt: now - 3 * MINUTE,
    status: "done",
    unread: false,
  };
  const transcript: Transcript = {
    ...emptyActivity,
    runs: [],
    linkedRuns: {},
    interSession: [],
    mcpTools: {},
    sessionKey: ARTIFACT_TASK,
    status: "ready",
    items: transcriptItems(now),
    error: null,
    hasMore: false,
    live: null,
    loadedAt: now,
  };
  return {
    ...state,
    tasksByBot: { ...state.tasksByBot, main: [task, ...(state.tasksByBot.main ?? [])] },
    transcripts: { ...state.transcripts, [ARTIFACT_TASK]: transcript },
  };
}

const content = (
  bytes: Uint8Array,
  mimeType: string,
  kind: "text" | "image" | "audio" | "video" | "other",
  thumbnail = false,
): ArtifactRead => ({
  status: "content",
  kind,
  mimeType,
  bytes: bytes.length,
  hash: sha256Hex(bytes),
  thumbnail,
  transfer: { id: null, chunks: 1, data: toBase64(bytes) },
});

const kindOf = (mimeType: string) =>
  mimeType.startsWith("text/")
    ? "text"
    : mimeType.startsWith("image/")
      ? "image"
      : mimeType.startsWith("audio/")
        ? "audio"
        : mimeType.startsWith("video/")
          ? "video"
          : "other";

/** The artifact commands, answered as the engine would from this task's items. */
export function artifactAnswers(params: ArtifactParams) {
  const items = fixtureItems().map((item) => {
    if (params.brokenPictures && item.artifact.kind === "image" && item.bytes)
      return { ...item, bytes: utf8Bytes("These bytes are not a picture.") };
    if (params.reportLinks && item.artifact.title === "borrowing-report.md") {
      const bytes = utf8Bytes(
        "# Borrowing e-books\n\nSee [Library conditions](https://library.example/conditions) and [my notes](notes.md).\n",
      );
      return { ...item, bytes, artifact: { ...item.artifact, size: bytes.length } };
    }
    if (params.brokenAudio && item.artifact.kind === "audio")
      return { ...item, bytes: utf8Bytes("These bytes are not a recording.") };
    if (params.unknownSizes && item.artifact.title === "app-screens.zip")
      return { ...item, artifact: { ...item.artifact, size: null } };
    return item;
  });
  const positions = new Map<number, number>();
  const artifacts: Artifact[] = items.map(({ artifact, seq }) => {
    const position = positions.get(seq) ?? 0;
    positions.set(seq, position + 1);
    return { ...artifact, key: `${seq}:${position}:${artifact.id}`, position, messageSeq: seq };
  });
  let opens = 0;
  return async (command: BridgeCommand): Promise<unknown> => {
    switch (command.type) {
      case "listArtifacts": {
        if (params.listFails) throw new Error("The gateway refused artifacts.list.");
        const list: ArtifactList = {
          key: command.key,
          artifacts: command.key === ARTIFACT_TASK ? artifacts : [],
          omitted: 0,
          checkedAt: Date.now(),
        };
        return list;
      }
      case "readArtifact": {
        const index = artifacts.findIndex((each) => each.id === command.artifactId);
        const found = items[index];
        const artifact = artifacts[index];
        if (!found || !artifact)
          return { status: "gone", message: "The gateway no longer has this item." };
        if (artifact.mode === "unsupported") return { status: "unsupported" };
        if (artifact.place.kind === "elsewhere")
          return { status: "elsewhere", host: artifact.place.host, url: artifact.place.url };
        if (command.part === "preview") {
          if (artifact.kind !== "image" || !found.bytes)
            return { status: "no-preview", reason: "Only pictures have previews." };
          if ((artifact.size ?? 0) > 262_144) {
            if (params.thumbs === "failed")
              return { status: "no-preview", reason: "The gateway has no preview of this item." };
            if (params.thumbs === "original")
              return { status: "no-preview", reason: "The gateway's preview is over 2 MB." };
            return content(found.bytes, "image/png", "image", true);
          }
          return content(found.bytes, artifact.mimeType ?? "image/png", "image");
        }
        if (
          (artifact.size ?? 0) > 5_242_880 ||
          (params.unknownSizes && artifact.title === "app-screens.zip")
        )
          return { status: "too-large", size: artifact.size, limit: 5_242_880 };
        opens += 1;
        if (params.failFirstOpen && opens === 1)
          return {
            status: "failed",
            message: "The gateway's download link expired before it was used.",
          };
        if (params.slowAudio && artifact.kind === "audio")
          await new Promise((resolve) => setTimeout(resolve, 800));
        const mimeType = artifact.mimeType ?? "application/octet-stream";
        return content(found.bytes ?? new Uint8Array(0), mimeType, kindOf(mimeType));
      }
      case "readArtifactRecord": {
        const artifact = artifacts.find((each) => each.id === command.artifactId);
        if (!artifact) return { status: "failed", message: "artifact not found" };
        const record = {
          artifact: {
            id: artifact.id,
            type: artifact.kind,
            title: artifact.title,
            ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
            ...(artifact.size !== null ? { sizeBytes: artifact.size } : {}),
            sessionKey: command.key,
            runId: artifact.runId,
            messageSeq: artifact.messageSeq,
            source: "session-transcript",
            download: { mode: artifact.mode },
          },
        };
        return { status: "ok", text: JSON.stringify(record, null, 2), cut: false };
      }
      case "readPage": {
        const bytes = utf8Bytes(PAGE);
        return {
          status: "content",
          bytes: bytes.length,
          hash: sha256Hex(bytes),
          transfer: { id: null, chunks: 1, data: toBase64(bytes) },
        };
      }
      case "previewLink": {
        const preview: LinkPreview = params.linkPreview
          ? {
              status: "ok",
              url: command.url,
              title: "Library e-books",
              description: "Borrow e-books and audiobooks with your library card.",
              image: null,
            }
          : { status: "none", url: command.url };
        return preview;
      }
      default:
        return undefined;
    }
  };
}

export const ARTIFACT_COMMANDS = new Set([
  "listArtifacts",
  "readArtifact",
  "readArtifactRecord",
  "readPage",
  "previewLink",
]);
