// Words for what a bot handed over (work-pane.md, sections 11 to 14): an
// item's type in words, its card's second line, the name a download proposes,
// and where a link card goes.

import { MAX_ARTIFACT_BYTES, type Artifact, type TranscriptItem } from "@clawtrate/core";
import { formatSize } from "../work/files-format.ts";

const BY_TYPE: Record<string, string> = {
  "text/markdown": "Markdown",
  "text/plain": "Text",
  "text/csv": "CSV",
  "text/html": "HTML",
  "application/json": "JSON",
  "application/yaml": "YAML",
  "application/pdf": "PDF",
  "application/zip": "ZIP archive",
  "image/png": "PNG image",
  "image/jpeg": "JPEG image",
  "image/gif": "GIF image",
  "image/webp": "WebP image",
  "audio/wav": "WAV audio",
  "audio/mpeg": "MP3 audio",
  "audio/mp4": "Audio",
  "video/mp4": "MP4 video",
  "video/webm": "WebM video",
};

const BY_EXTENSION: Record<string, string> = {
  md: "Markdown",
  txt: "Text",
  csv: "CSV",
  json: "JSON",
  pdf: "PDF",
  zip: "ZIP archive",
  png: "PNG image",
  jpg: "JPEG image",
  jpeg: "JPEG image",
  wav: "WAV audio",
  mp3: "MP3 audio",
  m4a: "Audio",
  mp4: "MP4 video",
  webm: "WebM video",
};

const EXTENSION_OF: Record<string, string> = {
  "text/markdown": "md",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/json": "json",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

const extension = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** The type in words, from the media type the gateway reports, or the title's extension; "File" when neither says. */
export function typeWords(artifact: Pick<Artifact, "mimeType" | "title" | "kind">): string {
  const type = artifact.mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    BY_TYPE[type] ??
    BY_EXTENSION[extension(artifact.title)] ??
    (artifact.kind === "image"
      ? "Picture"
      : artifact.kind === "audio"
        ? "Audio"
        : artifact.kind === "video"
          ? "Video"
          : "File")
  );
}

/** "Markdown · 37 KB", or "PDF · from help.library.example" for an item elsewhere. */
export function cardSub(artifact: Artifact): string {
  if (artifact.place.kind === "elsewhere")
    return `${typeWords(artifact)} · from ${artifact.place.host}`;
  return [typeWords(artifact), formatSize(artifact.size)].filter(Boolean).join(" · ");
}

/** The name a download proposes: the title, with an extension from the media type when it has none. */
export function downloadName(artifact: Pick<Artifact, "title" | "mimeType">): string {
  if (extension(artifact.title)) return artifact.title;
  const type = artifact.mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
  const ext = EXTENSION_OF[type];
  return ext ? `${artifact.title}.${ext}` : artifact.title;
}

/** Whether the item's content is on the gateway: Download, Copy and the viewer are for these. */
export const fetchable = (artifact: Artifact) =>
  artifact.mode !== "unsupported" && artifact.place.kind === "gateway";

/** Over Clawtrate's limit for what it opens and saves, by the size the gateway gave. */
export const overLimit = (artifact: Artifact) => (artifact.size ?? 0) > MAX_ARTIFACT_BYTES;

/** Fetchable and within Clawtrate's limit: Download, Save and Copy are offered for these. */
export const downloadable = (artifact: Artifact) => fetchable(artifact) && !overLimit(artifact);

export type LinkTarget = { url: string; text: string; host: string };

const LINK = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/gi;

/**
 * A link card follows the bubble when the message is only a link, or ends
 * with one (section 12). `http:` and `https:` only; the address's own text,
 * or the link's text in Markdown, names it.
 */
export function trailingLink(text: string): LinkTarget | null {
  const trimmed = text.trim();
  const markdown = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)\s*[.!]?$/i.exec(trimmed);
  const found = markdown
    ? { url: markdown[2]!, text: markdown[1]! }
    : (() => {
        const matches = [...trimmed.matchAll(LINK)];
        const last = matches.at(-1);
        if (!last) return null;
        const after = trimmed.slice((last.index ?? 0) + last[0].length);
        return /^[.!]?$/.test(after.trim()) ? { url: last[0], text: "" } : null;
      })();
  if (!found) return null;
  try {
    const url = new URL(found.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.replace(/^www\./, "");
    const address = `${host}${url.pathname === "/" ? "" : url.pathname}`;
    return { url: url.toString(), text: found.text || address, host };
  } catch {
    return null;
  }
}

/** A recording's or video's length, "1:04", from seconds. */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * Page cards whose document a later message of the same transcript names
 * again, as `<item id>:<doc id>`: "Shown again below". The gateway names no
 * revision of a Page, so nothing says one share is newer than another.
 */
export function shownAgainBelow(items: TranscriptItem[]): Set<string> {
  const seen = new Set<string>();
  const again = new Set<string>();
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    for (const block of item.blocks) {
      if (block.kind !== "page" || !block.docId.trim()) continue;
      if (seen.has(block.docId)) again.add(`${item.id}:${block.docId}`);
      seen.add(block.docId);
    }
  }
  return again;
}
