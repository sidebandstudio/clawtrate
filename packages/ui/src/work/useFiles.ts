// Keeping the Files tab's lists (work-pane.md, section 9): fetched when Files
// is shown, 600 ms after the last of a burst of file-tool results, after a
// history read while a finished change is not in the list yet, on Refresh and
// when the connection returns. Never on a timer, and never while nobody is
// looking at the list.

import {
  changesUnlisted,
  finishedChanges,
  type ClawtrateBridge,
  type TaskFileList,
  type Transcript,
  type WorkspaceEntry,
  type WorkspacePage,
} from "@clawtrate/core";
import { useCallback, useEffect, useRef, useState } from "react";

/** How long after the last file-tool result the list is fetched again. */
export const REFETCH_AFTER_MS = 600;

const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)) || "The gateway did not answer.";

export type ListState = {
  list: TaskFileList | null;
  loading: boolean;
  /** Why the last fetch failed; with a list loaded, the list stays. */
  error: string | null;
};

export function useTaskFiles({
  bridge,
  taskKey,
  transcript,
  visible,
  online,
  connectedAt,
}: {
  bridge: ClawtrateBridge;
  taskKey: string | null;
  transcript: Transcript | undefined;
  visible: boolean;
  online: boolean;
  connectedAt: number | null;
}): ListState & { refresh: () => void } {
  const [state, setState] = useState<ListState & { key: string | null }>({
    key: null,
    list: null,
    loading: false,
    error: null,
  });
  const generation = useRef(0);
  const fetchList = useCallback(() => {
    if (!taskKey) return;
    generation.current += 1;
    const mine = generation.current;
    setState((previous) =>
      previous.key === taskKey
        ? { ...previous, loading: true }
        : { key: taskKey, list: null, loading: true, error: null },
    );
    bridge.invoke({ type: "listTaskFiles", key: taskKey }).then(
      (list) => {
        if (mine === generation.current)
          setState({ key: taskKey, list, loading: false, error: null });
      },
      (error: unknown) => {
        if (mine === generation.current)
          setState((previous) => ({
            key: taskKey,
            list: previous.key === taskKey ? previous.list : null,
            loading: false,
            error: message(error),
          }));
      },
    );
  }, [bridge, taskKey]);

  // Shown, a different task, or the connection back: fetch.
  useEffect(() => {
    if (visible && online && taskKey) queueMicrotask(fetchList);
  }, [visible, online, taskKey, connectedAt, fetchList]);

  // A file tool's result landed: once, 600 ms after the last of a burst.
  const changes = transcript ? finishedChanges(transcript) : 0;
  const seen = useRef(changes);
  useEffect(() => {
    if (changes === seen.current) return;
    seen.current = changes;
    if (!visible || !online) return;
    const timer = setTimeout(fetchList, REFETCH_AFTER_MS);
    return () => clearTimeout(timer);
  }, [changes, visible, online, fetchList]);

  const current = state.key === taskKey ? state : { list: null, loading: false, error: null };

  // The gateway lists a file from its stored transcript, so a list read before it stored the
  // tool's result, or one that failed, does not show the change. While a finished change is
  // missing from the list, each history read (the gateway's signal that it stored more of the
  // task) fetches the list again, 600 ms after the last; never on a timer.
  const loadedAt = transcript?.loadedAt ?? null;
  const unlisted =
    transcript !== undefined && current.list !== null && changesUnlisted(transcript, current.list);
  const seenLoad = useRef(loadedAt);
  useEffect(() => {
    if (loadedAt === seenLoad.current) return;
    seenLoad.current = loadedAt;
    if (!unlisted || !visible || !online) return;
    const timer = setTimeout(fetchList, REFETCH_AFTER_MS);
    return () => clearTimeout(timer);
  }, [loadedAt, unlisted, visible, online, fetchList]);

  return { list: current.list, loading: current.loading, error: current.error, refresh: fetchList };
}

export type FolderState = {
  entries: WorkspaceEntry[];
  totalEntries: number;
  nextOffset: number;
  checkedAt: number | null;
  loading: boolean;
  missing: boolean;
  error: string | null;
};

const emptyFolder: FolderState = {
  entries: [],
  totalEntries: 0,
  nextOffset: 0,
  checkedAt: null,
  loading: true,
  missing: false,
  error: null,
};

/** A folder of the bot's workspace, one page at a time. */
export function useWorkspaceFolder(
  bridge: ClawtrateBridge,
  botId: string,
  path: string,
  online: boolean,
): FolderState & { more: () => void; refresh: () => void } {
  const [state, setState] = useState<FolderState>(emptyFolder);
  const generation = useRef(0);
  const load = useCallback(
    (offset: number) => {
      generation.current += 1;
      const mine = generation.current;
      setState((previous) => ({ ...previous, loading: true }));
      bridge.invoke({ type: "listWorkspace", botId, path, offset }).then(
        (page: WorkspacePage) => {
          if (mine !== generation.current) return;
          setState((previous) => ({
            entries: offset === 0 ? page.entries : [...previous.entries, ...page.entries],
            totalEntries: page.totalEntries,
            nextOffset: page.nextOffset,
            checkedAt: page.checkedAt,
            loading: false,
            missing: page.missing,
            error: null,
          }));
        },
        (error: unknown) => {
          if (mine === generation.current)
            setState((previous) => ({ ...previous, loading: false, error: message(error) }));
        },
      );
    },
    [bridge, botId, path],
  );
  useEffect(() => {
    if (online) queueMicrotask(() => load(0));
  }, [load, online]);
  return {
    ...state,
    more: () => load(state.nextOffset),
    refresh: () => load(0),
  };
}
