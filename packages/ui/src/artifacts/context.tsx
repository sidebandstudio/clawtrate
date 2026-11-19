// What a bot handed over, for the conversation's cards, the Files tab's "Sent
// in chat" and the media viewer (work-pane.md, sections 11 to 14). One list
// per open task from the one query the design uses, read again whenever the
// task's history is read again or its row changes: the gateway adds an item to
// the message in place, a few seconds after the run that sent it ends, and then
// says only that the session changed (`sessions.changed`, a newer `updatedAt`). Previews and content are fetched by
// the host from the gateway only, never from an address a bot wrote, and only
// a few are held at once.

import {
  fromBase64,
  toBase64,
  type Artifact,
  type ArtifactList,
  type ArtifactRead,
  type ClawtrateBridge,
  type FileTransferStart,
  type Transcript,
  type TranscriptItem,
} from "@clawtrate/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useBridge } from "../bridge.tsx";
import { downloadBytes } from "../work/download.ts";
import { downloadable, downloadName, fetchable, newerPageVersions } from "./words.ts";

export type Preview =
  { status: "loading" } | { status: "ready"; url: string } | { status: "none"; reason: string };

/** An item's own bytes as the viewer holds them while shown. */
export type Content =
  | {
      status: "ready";
      data: Uint8Array;
      mimeType: string;
      kind: "text" | "image" | "audio" | "video" | "other";
      /** A data: address: the app's policy admits it for pictures and media. */
      url: string;
      text: string | null;
    }
  | Exclude<ArtifactRead, { status: "content" }>;

export type ViewerEntry =
  | { type: "artifact"; artifact: Artifact }
  | { type: "page"; docId: string; title: string; key: string };

export type Playing = { key: string; task: string; time: number; duration: number | null };

export type ArtifactsApi = {
  taskKey: string;
  bot: string;
  online: boolean;
  list: ArtifactList | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /** The items under each transcript item, by its id, in the gateway's order. */
  byItem: Map<string, Artifact[]>;
  /** Page cards a later message names again, as `<item id>:<doc id>`: "A newer version is below". */
  newerPages: ReadonlySet<string>;
  /** When the message that carried an item was sent, as the transcript has it. */
  sentAt: (artifact: Artifact) => number | null;
  preview: (artifact: Artifact) => Preview | undefined;
  wantPreview: (artifact: Artifact) => void;
  content: (artifact: Artifact) => Promise<Content>;
  /** Drop a failed reading, so Try again asks the gateway again. */
  forget: (artifact: Artifact) => void;
  openInPane: (artifact: Artifact) => void;
  openViewer: (entries: ViewerEntry[], index: number, opener: HTMLElement | null) => void;
  showInChat: (key: string) => void;
  download: (artifact: Artifact) => Promise<void>;
  downloadAll: (artifacts: Artifact[]) => Promise<void>;
  copyImage: (artifact: Artifact) => Promise<void>;
  copyText: (artifact: Artifact) => Promise<void>;
  announce: (text: string) => void;
  playing: Playing | null;
  togglePlay: (artifact: Artifact) => void;
  viewer: { entries: ViewerEntry[]; index: number } | null;
  closeViewer: () => void;
  setViewerIndex: (index: number) => void;
};

const ArtifactsContext = createContext<ArtifactsApi | null>(null);

export const useArtifacts = () => useContext(ArtifactsContext);

/** Previews held at once, as data: addresses, newest kept. */
const MAX_PREVIEWS = 48;
/** Items' whole content held at once, for the viewer, the pane and audio, newest kept. */
const MAX_CONTENTS = 3;
/** Previews fetched at once; the rest wait their turn. */
const PREVIEWS_AT_ONCE = 2;

/** Read every chunk of a transfer; the transfer ends with its last chunk. */
export async function collect(
  bridge: ClawtrateBridge,
  transfer: FileTransferStart,
  bytes: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const first = fromBase64(transfer.data);
  if (!first) throw new Error("The content could not be read.");
  parts.push(first);
  try {
    for (let index = 1; index < transfer.chunks; index += 1) {
      const chunk = await bridge.invoke({ type: "readFileChunk", id: transfer.id!, index });
      const part = fromBase64(chunk.data);
      if (!part) throw new Error("The content could not be read.");
      parts.push(part);
    }
  } catch (error) {
    if (transfer.id) void bridge.send({ type: "releaseFile", id: transfer.id });
    throw error;
  }
  const data = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    data.set(part, at);
    at += part.length;
  }
  if (data.length !== bytes) throw new Error("The content arrived incomplete.");
  return data;
}

const dataUrl = (mimeType: string, data: Uint8Array) => `data:${mimeType};base64,${toBase64(data)}`;

/**
 * Artifacts placed under the assistant item whose messages hold them: the
 * item's `seq` is its last message's, so an item's message falls after the
 * item before it with a `seq` and at or before its own. Before the first item
 * of a window that does not reach the task's start, nothing is placed.
 */
export function placeArtifacts(
  items: TranscriptItem[],
  artifacts: Artifact[],
  reachesStart: boolean,
): Map<string, Artifact[]> {
  const placed = new Map<string, Artifact[]>();
  for (const artifact of artifacts) {
    const seq = artifact.messageSeq;
    if (seq === null) continue;
    let before: number | null = null;
    for (const item of items) {
      if (item.seq === undefined) continue;
      if (item.seq >= seq) {
        const known = before !== null || reachesStart;
        if (item.role === "assistant" && known && (before === null || before < seq))
          placed.set(item.id, [...(placed.get(item.id) ?? []), artifact]);
        break;
      }
      before = item.seq;
    }
  }
  return placed;
}

export function ArtifactsProvider({
  taskKey,
  bot,
  transcript,
  changedAt,
  online,
  onOpenInPane,
  onShowInChat,
  onModal,
  children,
}: {
  taskKey: string;
  bot: string;
  transcript: Transcript | undefined;
  /** When the gateway last said the task's session changed (its row's `updatedAt`). */
  changedAt: number | null;
  online: boolean;
  onOpenInPane: (artifact: Artifact) => void;
  /** Close the drawer, if it is one, then call `reveal`. */
  onShowInChat: (reveal: () => void) => void;
  onModal: (open: boolean) => void;
  children: ReactNode;
}) {
  const bridge = useBridge();
  const [list, setList] = useState<ArtifactList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const generation = useRef(0);

  // The list follows the open task, and is read again each time its history is.
  const loadedAt = transcript?.loadedAt ?? null;
  const ready = transcript?.status === "ready";
  useEffect(() => {
    if (!online || !ready) return;
    generation.current += 1;
    const mine = generation.current;
    const timer = setTimeout(() => {
      setLoading(true);
      bridge.invoke({ type: "listArtifacts", key: taskKey }).then(
        (answer) => {
          if (mine !== generation.current) return;
          setList(answer);
          setError(null);
          setLoading(false);
        },
        (reason: unknown) => {
          if (mine !== generation.current) return;
          setError(reason instanceof Error ? reason.message : String(reason));
          setLoading(false);
        },
      );
    }, 200);
    return () => clearTimeout(timer);
  }, [bridge, taskKey, online, ready, loadedAt, changedAt, nonce]);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const items = transcript?.items;
  const byItem = useMemo(
    () =>
      placeArtifacts(
        items ?? [],
        list?.key === taskKey ? list.artifacts : [],
        transcript?.hasMore === false,
      ),
    [items, list, taskKey, transcript?.hasMore],
  );
  const newerPages = useMemo(() => newerPageVersions(items ?? []), [items]);
  const sentAt = useCallback(
    (artifact: Artifact) => {
      for (const [itemId, placed] of byItem)
        if (placed.includes(artifact))
          return items?.find((item) => item.id === itemId)?.timestamp ?? null;
      return null;
    },
    [byItem, items],
  );

  // Announcements, polite, for what the person did.
  const [announcement, setAnnouncement] = useState("");
  const announce = useCallback((text: string) => {
    setAnnouncement("");
    requestAnimationFrame(() => setAnnouncement(text));
  }, []);

  // Previews: fetched when a card asks (it is in view), a few at a time.
  const [previews, setPreviews] = useState<Map<string, Preview>>(() => new Map());
  const queue = useRef<Artifact[]>([]);
  const running = useRef(0);
  const asked = useRef(new Set<string>());
  const pumpRef = useRef<() => void>(() => {});
  const pump = useCallback(() => {
    while (running.current < PREVIEWS_AT_ONCE && queue.current.length > 0) {
      const artifact = queue.current.shift()!;
      running.current += 1;
      const settle = (preview: Preview) => {
        running.current -= 1;
        setPreviews((current) => {
          const next = new Map(current);
          next.delete(`${taskKey}|${artifact.key}`);
          next.set(`${taskKey}|${artifact.key}`, preview);
          while (next.size > MAX_PREVIEWS) next.delete(next.keys().next().value!);
          return next;
        });
        pumpRef.current();
      };
      bridge
        .invoke({ type: "readArtifact", key: taskKey, artifactId: artifact.id, part: "preview" })
        .then(async (read) => {
          if (read.status !== "content") {
            settle({ status: "none", reason: "reason" in read ? read.reason : read.status });
            return;
          }
          const data = await collect(bridge, read.transfer, read.bytes);
          settle({ status: "ready", url: dataUrl(read.mimeType, data) });
        })
        .catch((reason: unknown) =>
          settle({
            status: "none",
            reason: reason instanceof Error ? reason.message : String(reason),
          }),
        );
    }
  }, [bridge, taskKey]);
  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);
  const wantPreview = useCallback(
    (artifact: Artifact) => {
      if (!online || !fetchable(artifact) || artifact.kind !== "image") return;
      const held = `${taskKey}|${artifact.key}`;
      if (asked.current.has(held)) return;
      asked.current.add(held);
      // The set of asked previews is bounded as the previews are.
      if (asked.current.size > MAX_PREVIEWS * 2) asked.current.clear();
      setPreviews((current) => new Map(current).set(held, { status: "loading" }));
      queue.current.push(artifact);
      pump();
    },
    [online, pump, taskKey],
  );
  useEffect(() => {
    queue.current = [];
  }, [taskKey]);
  const preview = useCallback(
    (artifact: Artifact) => previews.get(`${taskKey}|${artifact.key}`),
    [previews, taskKey],
  );

  // Whole content: for the viewer, the pane, Download, Copy and audio.
  const contents = useRef(new Map<string, Promise<Content>>());
  const content = useCallback(
    (artifact: Artifact): Promise<Content> => {
      const held = contents.current.get(artifact.key);
      if (held) return held;
      const loading = bridge
        .invoke({ type: "readArtifact", key: taskKey, artifactId: artifact.id, part: "full" })
        .then(async (read): Promise<Content> => {
          if (read.status !== "content") return read;
          const data = await collect(bridge, read.transfer, read.bytes);
          let text: string | null = null;
          if (read.kind === "text") {
            try {
              text = new TextDecoder("utf-8", { fatal: true }).decode(data);
            } catch {
              text = null;
            }
          }
          return {
            status: "ready",
            data,
            mimeType: read.mimeType,
            kind: read.kind === "text" && text === null ? "other" : read.kind,
            url: dataUrl(read.mimeType, data),
            text,
          };
        })
        .catch((reason: unknown): Content => ({
          status: "failed",
          message: online
            ? reason instanceof Error
              ? reason.message
              : String(reason)
            : "Can't reach the gateway. Try again when it's back.",
        }));
      contents.current.set(artifact.key, loading);
      while (contents.current.size > MAX_CONTENTS)
        contents.current.delete(contents.current.keys().next().value!);
      // A failure is not kept: Try again asks again.
      void loading.then((result) => {
        if (result.status === "failed" || result.status === "gone")
          contents.current.delete(artifact.key);
      });
      return loading;
    },
    [bridge, taskKey, online],
  );
  const forget = useCallback((artifact: Artifact) => {
    contents.current.delete(artifact.key);
  }, []);
  useEffect(() => {
    contents.current.clear();
  }, [taskKey]);

  const download = useCallback(
    async (artifact: Artifact) => {
      const name = downloadName(artifact);
      const got = await content(artifact);
      if (got.status !== "ready") {
        announce(`Couldn't download ${name}.`);
        return;
      }
      const result = await downloadBytes(bridge, name, got.data);
      if (result) announce(result.announcement);
    },
    [announce, bridge, content],
  );
  const downloadAll = useCallback(
    async (artifacts: Artifact[]) => {
      const saved: string[] = [];
      const left: string[] = artifacts.filter((each) => !downloadable(each)).map(downloadName);
      for (const artifact of artifacts.filter(downloadable)) {
        const name = downloadName(artifact);
        const got = await content(artifact);
        if (got.status !== "ready") {
          left.push(name);
          continue;
        }
        const result = await downloadBytes(bridge, name, got.data);
        if (result?.ok) saved.push(name);
        else left.push(name);
      }
      announce(
        left.length === 0
          ? `Downloaded ${saved.length} items`
          : `Downloaded ${saved.length} of ${artifacts.length}. Not downloaded: ${left.join(", ")}`,
      );
    },
    [announce, bridge, content],
  );
  const copyImage = useCallback(
    async (artifact: Artifact) => {
      const got = await content(artifact);
      try {
        if (got.status !== "ready" || got.kind !== "image") throw new Error("no picture");
        const png =
          got.mimeType === "image/png"
            ? new Blob([got.data.slice().buffer], { type: "image/png" })
            : await toPng(got.url);
        await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
        announce("Copied the image");
      } catch {
        announce("Couldn't copy the image.");
      }
    },
    [announce, content],
  );
  const copyText = useCallback(
    async (artifact: Artifact) => {
      const got = await content(artifact);
      try {
        if (got.status !== "ready" || got.text === null) throw new Error("no text");
        await navigator.clipboard.writeText(got.text);
        announce(`Copied ${downloadName(artifact)}`);
      } catch {
        announce(`Couldn't copy ${downloadName(artifact)}.`);
      }
    },
    [announce, content],
  );

  // One recording plays at a time.
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<Playing | null>(null);
  const togglePlay = useCallback(
    (artifact: Artifact) => {
      const element = (audio.current ??= new Audio());
      if (playing?.key === artifact.key) {
        element.pause();
        setPlaying(null);
        return;
      }
      element.pause();
      setPlaying({ key: artifact.key, task: taskKey, time: 0, duration: null });
      void content(artifact).then((got) => {
        if (got.status !== "ready" || got.kind !== "audio") {
          setPlaying(null);
          announce(`Couldn't play ${artifact.title}.`);
          return;
        }
        element.src = got.url;
        element.ontimeupdate = () =>
          setPlaying((now) =>
            now?.key === artifact.key
              ? {
                  ...now,
                  time: element.currentTime,
                  duration: Number.isFinite(element.duration) ? element.duration : null,
                }
              : now,
          );
        element.onended = () => setPlaying(null);
        void element.play().catch(() => setPlaying(null));
      });
    },
    [announce, content, playing, taskKey],
  );
  useEffect(
    () => () => {
      audio.current?.pause();
    },
    [],
  );
  useEffect(() => {
    audio.current?.pause();
  }, [taskKey]);
  // A recording of another task is not shown as playing here.
  const playingHere = playing && playing.task === taskKey ? playing : null;

  // The viewer, modal over the whole window.
  const [viewer, setViewer] = useState<{ entries: ViewerEntry[]; index: number } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const openViewer = useCallback(
    (entries: ViewerEntry[], index: number, from: HTMLElement | null) => {
      opener.current = from;
      audio.current?.pause();
      setPlaying(null);
      setViewer({ entries, index });
      onModal(true);
    },
    [onModal],
  );
  const closeViewer = useCallback(() => {
    setViewer(null);
    onModal(false);
    const back = opener.current;
    requestAnimationFrame(() => {
      if (back?.isConnected) back.focus();
    });
  }, [onModal]);
  const setViewerIndex = useCallback(
    (index: number) => setViewer((current) => (current ? { ...current, index } : current)),
    [],
  );

  const showInChat = useCallback(
    (key: string) =>
      onShowInChat(() => {
        const card = document.querySelector<HTMLElement>(
          `.transcript [data-artifact="${CSS.escape(key)}"]`,
        );
        if (!card) {
          announce("This item isn't in the chat: it is not loaded here.");
          return;
        }
        card.scrollIntoView({ block: "center" });
        card.dataset.flash = "true";
        const clear = () => delete card.dataset.flash;
        card.addEventListener("animationend", clear, { once: true });
        card.addEventListener("focusout", clear, { once: true });
        (card.querySelector<HTMLElement>("button") ?? card).focus({ preventScroll: true });
        announce("Showing the item in the chat");
      }),
    [announce, onShowInChat],
  );

  const api = useMemo<ArtifactsApi>(
    () => ({
      taskKey,
      bot,
      online,
      list: list?.key === taskKey ? list : null,
      loading,
      error,
      refresh,
      byItem,
      newerPages,
      sentAt,
      preview,
      wantPreview,
      content,
      forget,
      openInPane: onOpenInPane,
      openViewer,
      showInChat,
      download,
      downloadAll,
      copyImage,
      copyText,
      announce,
      playing: playingHere,
      togglePlay,
      viewer,
      closeViewer,
      setViewerIndex,
    }),
    [
      taskKey,
      bot,
      online,
      list,
      loading,
      error,
      refresh,
      byItem,
      newerPages,
      sentAt,
      preview,
      wantPreview,
      content,
      forget,
      onOpenInPane,
      openViewer,
      showInChat,
      download,
      downloadAll,
      copyImage,
      copyText,
      announce,
      playingHere,
      togglePlay,
      viewer,
      closeViewer,
      setViewerIndex,
    ],
  );
  return (
    <ArtifactsContext.Provider value={api}>
      {children}
      <p
        className="visually-hidden"
        role="status"
        aria-live="polite"
        data-testid="artifact-announcer"
      >
        {announcement}
      </p>
    </ArtifactsContext.Provider>
  );
}

/** A picture as PNG, for the clipboard, which takes only PNG. */
async function toPng(url: string): Promise<Blob> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d")!.drawImage(image, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no PNG"))), "image/png"),
  );
}
