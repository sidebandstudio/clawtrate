// A file row (work-pane.md, section 4): the kind's tile, the name cut in the
// middle so its extension stays, the time, then the folder, the size and what
// happened to it.

import { guessKind, type FileMark } from "@clawtrate/core";
import type { ReactNode } from "react";
import { rowTime } from "../format.ts";
import {
  ChevronIcon,
  DocumentIcon,
  FileIcon,
  FolderIcon,
  MediaIcon,
  PictureIcon,
} from "../icons.tsx";
import { formatSize, nameParts } from "./files-format.ts";

export function KindIcon({ name, folder }: { name: string; folder?: boolean }) {
  if (folder) return <FolderIcon />;
  switch (guessKind(name)) {
    case "picture":
      return <PictureIcon />;
    case "audio":
    case "video":
      return <MediaIcon />;
    case "document":
      return <DocumentIcon />;
    default:
      return <FileIcon />;
  }
}

export function FileName({ name }: { name: string }) {
  const { start, end } = nameParts(name);
  return (
    <span className="file-name">
      <span className="file-name-start">{start}</span>
      {end && <span className="file-name-end">{end}</span>}
    </span>
  );
}

const MARK_WORDS: Record<FileMark, string> = {
  writing: "Writing…",
  "this-run": "Changed this run",
  "last-run": "Changed last run",
};

export function FileRow({
  rowKey,
  name,
  folder,
  size,
  updatedAt,
  mark,
  missing = false,
  isFolder = false,
  bot,
  now,
  onOpen,
  extra,
}: {
  rowKey: string;
  name: string;
  /** The folder it is in, relative to the root; "" or null at the root. */
  folder: string | null;
  size: number | null;
  updatedAt: number | null;
  mark?: FileMark | undefined;
  missing?: boolean;
  isFolder?: boolean;
  bot: string;
  now: number;
  onOpen: () => void;
  extra?: ReactNode;
}) {
  const time = rowTime(updatedAt, now);
  const writing = mark === "writing";
  const parts = [folder || null, isFolder ? "Folder" : formatSize(size) || null].filter(
    (part): part is string => part !== null,
  );
  const label = writing
    ? `${name}, ${bot} is writing it`
    : [
        name,
        folder ? `in ${folder}` : null,
        isFolder ? "folder" : formatSize(size) || null,
        time ? `changed ${time}` : null,
        missing ? "missing" : null,
        mark ? MARK_WORDS[mark].toLowerCase() : null,
      ]
        .filter(Boolean)
        .join(", ");
  return (
    <li>
      <button
        type="button"
        className="file-row"
        data-row={rowKey}
        title={name}
        aria-label={label}
        onClick={onOpen}
      >
        <span className="file-icon" aria-hidden="true">
          {writing ? (
            <span className="glyph" data-state="working" />
          ) : (
            <KindIcon name={name} folder={isFolder} />
          )}
        </span>
        <FileName name={name} />
        <span className="file-time">{isFolder ? "" : time}</span>
        <span className="file-sub">
          {[...parts, ...(isFolder && time ? [time] : [])].join(" · ")}
          {missing && <em>{parts.length ? " · " : ""}Missing</em>}
          {mark && (
            <strong data-mark={mark}>
              {parts.length || missing ? " · " : ""}
              {MARK_WORDS[mark]}
            </strong>
          )}
          {extra}
        </span>
        {isFolder && <ChevronIcon className="chevron" />}
      </button>
    </li>
  );
}

/** Up and Down move between rows of a list; Home and End go to the ends. */
export function onRowKeys(event: React.KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const target = event.target as HTMLElement;
  if (!target.classList.contains("file-row")) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(".file-row")];
  const index = rows.indexOf(target);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
  event.preventDefault();
  rows[next]?.focus();
}
