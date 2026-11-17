// Words and numbers the Files tab writes (work-pane.md, sections 4 and 8).

import type { FileLimit } from "@clawtrate/core";

/** "820 B", "2.4 KB", "14 MB": binary units, one decimal below 10. */
export function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = value < 9.95 ? value.toFixed(1) : String(Math.round(value));
  return `${shown.replace(/\.0$/, "")} ${units[unit]}`;
}

/** A name split so a long one is cut in the middle and keeps its end: "disk-report-…-final.md". */
export function nameParts(name: string): { start: string; end: string } {
  if (name.length <= 16) return { start: name, end: "" };
  const keep = Math.min(10, Math.max(name.length - name.lastIndexOf(".") + 3, 8));
  return { start: name.slice(0, name.length - keep), end: name.slice(name.length - keep) };
}

/** The folder a path is in ("" at the root). */
export function folderOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at > 0 ? path.slice(0, at) : "";
}

const what = (media: "audio" | "video") => (media === "audio" ? "recording" : "video");

/** The one sentence that names the limit a file met (section 8). */
export function limitSentence(name: string, limit: FileLimit, bot: string): string {
  switch (limit.code) {
    case "not-text-or-media":
      return `${name} isn't text or media. None of the gateway's file readers sends files like this, so it can't be shown or downloaded here.`;
    case "text-too-large":
      return `${sized(name, limit.size)}The gateway's file readers send text up to ${formatSize(limit.limit)}, so it can't be shown or downloaded here.`;
    case "script-too-large":
      return `${sized(name, limit.size)}The gateway sends stylesheets and scripts from a task's folder up to ${formatSize(limit.limit)}.`;
    case "media-too-large":
      return `${sized(name, limit.size)}The gateway sends recordings and videos from a task's folder up to ${formatSize(limit.limit)}, so it can't be played or downloaded here.`;
    case "media-in-repository":
      return `This task works in a repository the gateway keeps. The gateway sends only text and pictures from it, so ${name} can't be played or downloaded here.`;
    case "media-outside-task":
      return `This ${what(limit.media)} is in ${bot}'s workspace, outside this task's folder. The gateway sends ${what(limit.media)}s only from a task's folder, so it can't be played here.`;
    case "picture-too-large":
      return limit.where === "workspace"
        ? `${sized(name, limit.size)}The gateway sends pictures from the workspace up to ${formatSize(limit.limit)}.`
        : limit.where === "repository"
          ? `${sized(name, limit.size)}From a repository the gateway keeps, it sends pictures up to ${formatSize(limit.limit)}.`
          : `${sized(name, limit.size)}From this task's folder the gateway sends pictures up to ${formatSize(limit.limit)}.`;
    case "refused":
      return `The gateway didn't send ${name}: ${limit.message}`;
  }
}

function sized(name: string, size: number | null): string {
  return size === null ? `${name} is too large. ` : `${name} is ${formatSize(size)}. `;
}
