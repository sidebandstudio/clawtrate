// The Files tab (work-pane.md, sections 3 to 9): a short stack, the task's
// list, then a folder of the workspace, then a file. Back returns to the
// level above with its scroll and the row that was opened focused.

import {
  commandsSince,
  fileMarks,
  type ClawtrateBridge,
  type FileMark,
  type TaskFile,
  type Transcript,
  type WorkspaceEntry,
} from "@clawtrate/core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { clockTime } from "../format.ts";
import { BackIcon, FileIcon, FolderIcon, RefreshIcon, SortIcon, WarnIcon } from "../icons.tsx";
import { readPreference, writePreference } from "../preferences.ts";
import { FileRow, onRowKeys } from "./FileRow.tsx";
import { folderOf } from "./files-format.ts";
import type { FileRequest } from "./links.tsx";
import { Reader, type View } from "./Reader.tsx";
import { useTaskFiles, useWorkspaceFolder } from "./useFiles.ts";

export type Level =
  | { kind: "task" }
  | { kind: "folder"; path: string; from: string | null }
  | {
      kind: "file";
      source: "task" | "workspace";
      path: string;
      size: number | null;
      view: View | null;
      stepId: string | null;
      from: string | null;
    };

/** Where Files was for a task, kept while the app runs (section 1): at most this many tasks. */
const MAX_PLACES = 16;
type Place = { stack: Level[]; scroll: Record<string, number> };
const places = new Map<string, Place>();
function rememberPlace(key: string, place: Place) {
  places.delete(key);
  places.set(key, place);
  while (places.size > MAX_PLACES) places.delete(places.keys().next().value!);
}

const levelKey = (level: Level) =>
  level.kind === "task"
    ? "task"
    : `${level.kind}:${level.kind === "file" ? level.source : ""}:${level.path}`;

/** Markers show in the workspace only when the task's folder is established as it. */
const NO_MARKS = new Map<string, FileMark>();

/** The filter appears past this many files (section 3). */
const FILTER_FROM = 12;

export function FilesTab({
  bridge,
  botId,
  bot,
  taskKey,
  transcript,
  visible,
  online,
  connectedAt,
  request,
  drawer,
  now,
  announce,
  onShowInChat,
  onPathChange,
}: {
  bridge: ClawtrateBridge;
  botId: string;
  bot: string;
  taskKey: string;
  transcript: Transcript | undefined;
  visible: boolean;
  online: boolean;
  connectedAt: number | null;
  request: FileRequest | null;
  drawer: boolean;
  now: number;
  announce: (text: string) => void;
  onShowInChat: (stepId: string, from: { path: string }) => void;
  /** The file open in the reader, or null: so a step's "Back to <file>" knows. */
  onPathChange: (path: string | null) => void;
}) {
  const [stack, setStack] = useState<Level[]>(
    () => places.get(taskKey)?.stack ?? [{ kind: "task" }],
  );
  const scrolls = useRef<Record<string, number>>(places.get(taskKey)?.scroll ?? {});
  const level = stack.at(-1)!;
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusNext = useRef<"heading" | { row: string } | null>(null);

  // Remember the place for the task, and the open file for the conversation's links.
  useEffect(() => {
    rememberPlace(taskKey, { stack, scroll: scrolls.current });
    onPathChange(level.kind === "file" && level.source === "task" ? level.path : null);
  }, [stack, taskKey, level, onPathChange]);

  const scroller = () => rootRef.current?.closest<HTMLElement>(".work-sections") ?? null;
  const push = (next: Level, from: string | null) => {
    const el = scroller();
    if (el) scrolls.current[levelKey(level)] = el.scrollTop;
    focusNext.current = "heading";
    setStack((previous) => [...previous, { ...next, from } as Level]);
  };
  const back = useCallback(() => {
    setStack((previous) => {
      if (previous.length <= 1) return previous;
      const leaving = previous.at(-1)!;
      focusNext.current = "from" in leaving && leaving.from ? { row: leaving.from } : null;
      return previous.slice(0, -1);
    });
  }, []);

  // "Open file" from a step: Files with that file in the reader.
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (!request || handled.current === request.nonce) return;
    handled.current = request.nonce;
    focusNext.current = "heading";
    setStack([
      { kind: "task" },
      {
        kind: "file",
        source: "task",
        path: request.path,
        size: null,
        view: request.view,
        stepId: request.stepId,
        from: `task:${request.path}`,
      },
    ]);
  }, [request]);

  // After a level changes: its scroll back, and focus where it belongs. A
  // folder's rows arrive after it mounts, so it asks again once they render.
  const settleLevel = useCallback(() => {
    const target = focusNext.current;
    if (target === "heading") {
      focusNext.current = null;
      headingRef.current?.focus({ preventScroll: true });
      return;
    }
    const el = scroller();
    const saved = scrolls.current[levelKey(level)] ?? 0;
    if (el && el.scrollHeight - el.clientHeight >= saved) el.scrollTop = saved;
    if (!target) return;
    const row = rootRef.current?.querySelector<HTMLElement>(
      `[data-row="${CSS.escape(target.row)}"]`,
    );
    if (row) {
      focusNext.current = null;
      row.focus({ preventScroll: true });
    }
  }, [level]);
  useLayoutEffect(settleLevel, [settleLevel]);

  // Escape goes Back while docked; ⌘[ goes Back anywhere in Files.
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "[") {
      event.preventDefault();
      back();
    } else if (event.key === "Escape" && !drawer && stack.length > 1) {
      event.preventDefault();
      back();
    }
  };

  const files = useTaskFiles({ bridge, taskKey, transcript, visible, online, connectedAt });
  const marks = useMemo(
    () => (transcript ? fileMarks(transcript) : new Map<string, FileMark>()),
    [transcript],
  );

  return (
    <div className="files" ref={rootRef} onKeyDown={onKey} data-testid="files">
      {level.kind === "task" && (
        <TaskLevel
          files={files}
          marks={marks}
          bot={bot}
          online={online}
          transcript={transcript}
          now={now}
          onOpen={(file) =>
            push(
              {
                kind: "file",
                source: "task",
                path: file.path,
                size: file.size,
                view: null,
                stepId: null,
                from: null,
              },
              `task:${file.path}`,
            )
          }
          onWorkspace={() => push({ kind: "folder", path: "", from: null }, "workspace")}
        />
      )}
      {level.kind === "folder" && (
        <FolderLevel
          key={level.path}
          bridge={bridge}
          botId={botId}
          bot={bot}
          path={level.path}
          online={online}
          marks={files.list?.folder.sameAsWorkspace ? marks : NO_MARKS}
          now={now}
          backLabel={backLabel(stack)}
          headingRef={headingRef}
          onRows={settleLevel}
          onBack={back}
          onOpen={(entry) =>
            entry.kind === "directory"
              ? push({ kind: "folder", path: entry.path, from: null }, `folder:${entry.path}`)
              : push(
                  {
                    kind: "file",
                    source: "workspace",
                    path: entry.path,
                    size: entry.size,
                    view: null,
                    stepId: null,
                    from: null,
                  },
                  `folder:${entry.path}`,
                )
          }
        />
      )}
      {level.kind === "file" && (
        <Reader
          key={`${level.source}:${level.path}:${request?.nonce ?? 0}`}
          bridge={bridge}
          source={
            level.source === "task"
              ? { kind: "task", key: taskKey, path: level.path }
              : { kind: "workspace", botId, path: level.path, size: level.size, key: taskKey }
          }
          bot={bot}
          transcript={level.source === "task" ? transcript : undefined}
          list={level.source === "task" ? files.list : null}
          now={now}
          initialView={level.view}
          focusStep={level.stepId}
          backLabel={backLabel(stack)}
          onBack={back}
          onShowInChat={(stepId) => onShowInChat(stepId, { path: level.path })}
          announce={announce}
          headingRef={headingRef}
        />
      )}
    </div>
  );
}

function backLabel(stack: Level[]): string {
  const above = stack.at(-2);
  if (!above || above.kind === "task") return "Back to this task's files";
  if (above.kind === "folder")
    return above.path ? `Back to ${above.path.split("/").pop()}` : "Back to the workspace";
  return "Back";
}

/** "Checked 5:36 PM" and Refresh; "Checking…" while it fetches; no Refresh while offline. */
function Freshness({
  checkedAt,
  checking,
  online,
  onRefresh,
  note,
}: {
  checkedAt: number | null;
  checking: boolean;
  online: boolean;
  onRefresh: () => void;
  note?: string | null;
}) {
  return (
    <div className="files-fresh" data-testid="files-fresh">
      <span>
        {checking
          ? "Checking…"
          : checkedAt
            ? `${online ? "Checked" : "Last checked"} ${clockTime(checkedAt)}`
            : ""}
        {note && <span className="files-fresh-note">{note}</span>}
      </span>
      {online && (
        <button
          type="button"
          className="icon-button"
          data-variant="quiet"
          aria-label="Refresh the file list"
          title="Refresh"
          onClick={onRefresh}
          disabled={checking}
        >
          {checking ? (
            <span className="glyph" data-state="working" aria-hidden="true" />
          ) : (
            <RefreshIcon />
          )}
        </button>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="files-loading" aria-busy="true" aria-label="Loading files">
      <div className="skeleton-row" />
      <div className="skeleton-row" />
      <div className="skeleton-row" />
    </div>
  );
}

function TaskLevel({
  files,
  marks,
  bot,
  online,
  transcript,
  now,
  onOpen,
  onWorkspace,
}: {
  files: ReturnType<typeof useTaskFiles>;
  marks: Map<string, FileMark>;
  bot: string;
  online: boolean;
  transcript: Transcript | undefined;
  now: number;
  onOpen: (file: TaskFile) => void;
  onWorkspace: () => void;
}) {
  const [filter, setFilter] = useState("");
  const { list, loading, error } = files;
  const all = list?.files ?? [];
  // A file being written that the list does not have yet shows at the top of Changed.
  const writingNew: TaskFile[] = [...marks]
    .filter(([path, mark]) => mark === "writing" && !all.some((file) => file.path === path))
    .map(([path]) => ({
      path,
      workspacePath: null,
      name: path.split("/").pop() ?? path,
      kind: "modified",
      missing: false,
      size: null,
      updatedAt: null,
    }));
  const query = filter.trim().toLowerCase();
  const matches = (file: TaskFile) => !query || file.path.toLowerCase().includes(query);
  const newest = (a: TaskFile, b: TaskFile) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  const changed = [
    ...writingNew,
    ...all.filter((file) => file.kind === "modified").sort(newest),
  ].filter(matches);
  const read = all
    .filter((file) => file.kind === "read")
    .sort(newest)
    .filter(matches);
  const total = all.length + writingNew.length;
  const commands =
    list && transcript && commandsSince(transcript, list.checkedAt)
      ? `${bot} ran commands since then. Files they changed show after a refresh.`
      : null;

  const workspaceRow = (
    <ul className="file-list files-workspace" onKeyDown={onRowKeys}>
      <li>
        <button
          type="button"
          className="file-row"
          data-row="workspace"
          onClick={onWorkspace}
          aria-label={`${bot}'s workspace, all files, by folder`}
        >
          <span className="file-icon" aria-hidden="true">
            <FolderIcon />
          </span>
          <span className="file-name">{bot}'s workspace</span>
          <span className="file-time" />
          <span className="file-sub">All files, by folder</span>
          <BackIcon className="chevron forward" />
        </button>
      </li>
    </ul>
  );

  if (!list && loading) {
    return (
      <>
        <Freshness checkedAt={null} checking online={online} onRefresh={files.refresh} />
        <Skeleton />
        {workspaceRow}
      </>
    );
  }
  if (!list && error) {
    return (
      <>
        <div className="work-empty" data-tone="danger" data-testid="files-failed">
          <span className="empty-mark" data-tone="danger">
            <WarnIcon />
          </span>
          <h3>Couldn't load this task's files</h3>
          <p>{error}</p>
          {online && (
            <button type="button" className="button" data-variant="default" onClick={files.refresh}>
              Try again
            </button>
          )}
        </div>
        {workspaceRow}
      </>
    );
  }
  return (
    <>
      <Freshness
        checkedAt={list?.checkedAt ?? null}
        checking={loading}
        online={online}
        onRefresh={files.refresh}
        note={commands}
      />
      {error && list && (
        <div className="files-alert" role="alert" data-testid="files-stale">
          <span>Couldn't refresh. Showing the list from {clockTime(list.checkedAt)}.</span>
          <button type="button" className="button" onClick={files.refresh}>
            Try again
          </button>
        </div>
      )}
      {total > FILTER_FROM && (
        <div className="files-filter">
          <input
            className="input"
            type="search"
            placeholder="Filter by name"
            aria-label="Filter this task's files by name"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && filter) {
                event.preventDefault();
                event.stopPropagation();
                setFilter("");
              }
            }}
          />
          {query && (
            <p role="status">
              {changed.length + read.length} of {total} files
            </p>
          )}
        </div>
      )}
      {total === 0 ? (
        <div className="work-empty">
          <span className="empty-mark">
            <FileIcon />
          </span>
          <h3>No files yet</h3>
          <p>Files {bot} reads or writes in this task appear here.</p>
        </div>
      ) : (
        <div onKeyDown={onRowKeys} aria-busy={loading || undefined}>
          {changed.length > 0 && (
            <FileGroup
              title="Changed"
              files={changed}
              marks={marks}
              bot={bot}
              now={now}
              onOpen={onOpen}
            />
          )}
          {read.length > 0 && (
            <FileGroup
              title="Read"
              files={read}
              marks={marks}
              bot={bot}
              now={now}
              onOpen={onOpen}
            />
          )}
          {list && list.omitted > 0 && (
            <p className="files-note">
              {list.omitted} more of this task's files didn't fit here. The filter searches only the
              files listed above.
            </p>
          )}
        </div>
      )}
      {workspaceRow}
    </>
  );
}

function FileGroup({
  title,
  files,
  marks,
  bot,
  now,
  onOpen,
}: {
  title: string;
  files: TaskFile[];
  marks: Map<string, FileMark>;
  bot: string;
  now: number;
  onOpen: (file: TaskFile) => void;
}) {
  return (
    <>
      <h3>{title}</h3>
      <ul className="file-list" aria-label={title}>
        {files.map((file) => (
          <FileRow
            key={file.path}
            rowKey={`task:${file.path}`}
            name={file.name}
            folder={folderOf(file.path) || null}
            size={file.size}
            updatedAt={file.updatedAt}
            mark={marks.get(file.path)}
            missing={file.missing}
            bot={bot}
            now={now}
            onOpen={() => onOpen(file)}
          />
        ))}
      </ul>
    </>
  );
}

type Sort = "name" | "modified";

function FolderLevel({
  bridge,
  botId,
  bot,
  path,
  online,
  marks,
  now,
  backLabel,
  headingRef,
  onRows,
  onBack,
  onOpen,
}: {
  bridge: ClawtrateBridge;
  botId: string;
  bot: string;
  path: string;
  online: boolean;
  marks: Map<string, FileMark>;
  now: number;
  backLabel: string;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  /** Called once the folder's rows have rendered: focus and scroll can go back to them. */
  onRows: () => void;
  onBack: () => void;
  onOpen: (entry: WorkspaceEntry) => void;
}) {
  const folder = useWorkspaceFolder(bridge, botId, path, online);
  const rowsAt = folder.checkedAt;
  useEffect(() => {
    if (rowsAt !== null) onRows();
  }, [rowsAt, onRows]);
  const [sort, setSortState] = useState<Sort>(() =>
    readPreference(`workspaceSort.${botId}`) === "modified" ? "modified" : "name",
  );
  const setSort = (next: Sort) => {
    setSortState(next);
    writePreference(`workspaceSort.${botId}`, next);
  };
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (menu) menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [menu]);
  const title = path ? path.split("/").pop()! : `${bot}'s workspace`;
  const sorted = [...folder.entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    if (sort === "modified")
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name);
  });
  const partial = folder.entries.length < folder.totalEntries;
  const moreRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <div className="files-head">
        <button
          type="button"
          className="icon-button"
          data-variant="quiet"
          aria-label={backLabel}
          title={`${backLabel} (⌘[)`}
          onClick={onBack}
        >
          <BackIcon />
        </button>
        <h3 tabIndex={-1} ref={headingRef}>
          {title}
        </h3>
        <div className="sort">
          <button
            type="button"
            className="sort-button"
            aria-haspopup="menu"
            aria-expanded={menu}
            aria-label={`Sort: ${sort === "name" ? "Name" : "Modified, newest first"}`}
            onClick={() => setMenu((open) => !open)}
          >
            {sort === "name" ? "Name" : "Modified"}
            <SortIcon />
          </button>
          {menu && (
            <ul
              className="menu files-sort-menu"
              role="menu"
              aria-label="Sort"
              ref={menuRef}
              onKeyDown={(event) => {
                const items = [
                  ...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
                ];
                const at = items.indexOf(document.activeElement as HTMLElement);
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  items[
                    (at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length
                  ]?.focus();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setMenu(false);
                }
              }}
            >
              {(["name", "modified"] as const).map((each) => (
                <li role="none" key={each}>
                  <button
                    type="button"
                    className="menu-item"
                    role="menuitemradio"
                    aria-checked={sort === each}
                    onClick={() => {
                      setSort(each);
                      setMenu(false);
                    }}
                  >
                    {each === "name" ? "Name" : "Modified, newest first"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className="files-path">
        {path && <code>{path}</code>}
        {path && " · "}
        {folder.checkedAt !== null &&
          `${folder.totalEntries.toLocaleString("en-US")} ${folder.totalEntries === 1 ? "item" : "items"}`}
        {partial &&
          ` · Sorted by ${sort === "name" ? "name" : "modified time"} among the ${folder.entries.length.toLocaleString("en-US")} loaded.`}
      </p>
      <Freshness
        checkedAt={folder.checkedAt}
        checking={folder.loading}
        online={online}
        onRefresh={folder.refresh}
      />
      {folder.missing ? (
        <div className="files-note" data-testid="folder-gone">
          <p>This folder no longer exists.</p>
          <button type="button" className="button" onClick={onBack}>
            Back
          </button>
        </div>
      ) : folder.error && folder.checkedAt === null ? (
        <div className="work-empty" data-testid="folder-failed">
          <span className="empty-mark" data-tone="danger">
            <WarnIcon />
          </span>
          <h3>Couldn't open this folder.</h3>
          <p>{folder.error}</p>
          <button type="button" className="button" data-variant="default" onClick={folder.refresh}>
            Try again
          </button>
        </div>
      ) : folder.checkedAt === null ? (
        <Skeleton />
      ) : (
        <>
          {folder.error && (
            <div className="files-alert" role="alert">
              <span>Couldn't refresh. Showing the folder from {clockTime(folder.checkedAt)}.</span>
              <button type="button" className="button" onClick={folder.refresh}>
                Try again
              </button>
            </div>
          )}
          {sorted.length === 0 ? (
            <p className="files-note">This folder is empty.</p>
          ) : (
            <ul className="file-list" onKeyDown={onRowKeys} aria-label={title}>
              {sorted.map((entry) => (
                <FileRow
                  key={entry.path}
                  rowKey={`folder:${entry.path}`}
                  name={entry.name}
                  folder={null}
                  size={entry.size}
                  updatedAt={entry.updatedAt}
                  isFolder={entry.kind === "directory"}
                  mark={marks.get(entry.path)}
                  bot={bot}
                  now={now}
                  onOpen={() => onOpen(entry)}
                />
              ))}
              {partial && (
                <li>
                  <button
                    type="button"
                    className="file-row files-more"
                    ref={moreRef}
                    onClick={() => folder.more()}
                    disabled={folder.loading}
                  >
                    <span className="file-icon" aria-hidden="true" />
                    <span className="file-name">
                      Show {Math.min(250, folder.totalEntries - folder.entries.length)} more ·{" "}
                      {folder.entries.length.toLocaleString("en-US")} of{" "}
                      {folder.totalEntries.toLocaleString("en-US")}
                    </span>
                  </button>
                </li>
              )}
            </ul>
          )}
        </>
      )}
    </>
  );
}
