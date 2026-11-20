import {
  MEMORY_NOTES_WRITABLE,
  ROOT_MEMORY,
  type MemoryDocument,
  type MemoryList,
} from "@clawtrate/core";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { useBridge } from "../bridge.tsx";
import { Confirm } from "../bots/Dialog.tsx";
import { AdminBar, GrantedBar, useGranted } from "../bots/parts.tsx";
import { fullDate } from "../format.ts";
import { BackIcon, ChevronIcon } from "../icons.tsx";

export function MemoryRow({ onOpen }: { onOpen: () => void }) {
  return (
    <>
      <h3 className="b-tabgroup">Memory</h3>
      <dl className="facts">
        <div>
          <button type="button" className="b-open" data-bs="memory" onClick={onOpen}>
            <span>Memory</span>
            <ChevronIcon />
          </button>
        </div>
      </dl>
    </>
  );
}

type Item = { file: MemoryDocument; start: number; end: number; text: string };
type Draft = {
  path: string;
  text: string;
  item: Item | null;
  /** The gateway identity that supplied the text, from `gateway.identity.get`. */
  gatewayId: string | null;
};
/** One root file's first load: a failed read stands alone beside its own file. */
type RootLoad = { path: string; file: MemoryDocument | null; error: string | null };

function items(file: MemoryDocument): Item[] {
  const { content } = file;
  if (!content.trim()) return [];
  if (file.path.startsWith("memory/"))
    return [{ file, start: 0, end: content.length, text: content }];
  // Keep compound Markdown together so an edit cannot remove half a fenced block or HTML comment.
  const blocks = /(?:```|~~~|<!--|^ {4}|^\t)/m.test(content)
    ? [content]
    : content
        .split(/(\r?\n[ \t]*\r?\n+)/)
        .flatMap((block) =>
          /^(?:[-*+]|\d+[.)])[ \t]/.test(block)
            ? block.split(/(\r?\n)(?=(?:[-*+]|\d+[.)])[ \t])/)
            : [block],
        );
  let start = 0;
  return blocks.flatMap((text) => {
    const from = start;
    start += text.length;
    return text.trim() ? [{ file, start: from, end: start, text }] : [];
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function BotMemory({
  botId,
  name,
  connection,
  info,
  announce,
  onBack,
  visible,
}: Pick<ComponentProps<typeof AdminBar>, "connection" | "info"> & {
  botId: string;
  visible: boolean;
  name: string;
  announce: (message: string) => void;
  onBack: () => void;
}) {
  const bridge = useBridge();
  const title = useRef<HTMLHeadingElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const [data, setData] = useState<{ root: RootLoad[]; notes: MemoryList } | null>(null);
  const [note, setNote] = useState<MemoryDocument | null>(null);
  const [readingNote, setReadingNote] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<{ item: Item; gatewayId: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  /** The gateway's current text of a note whose refused save left a draft: read again to show it. */
  const [conflictNote, setConflictNote] = useState<string | null>(null);
  const online = connection.status === "connected";
  const canEdit = online && connection.canAdmin && !info.readOnly;
  const granted = useGranted(connection);

  useEffect(() => title.current?.focus(), []);
  const editing = draft !== null;
  useEffect(() => editor.current?.focus(), [editing]);
  useEffect(() => {
    if (!online || !visible) return;
    let active = true;
    void Promise.all([
      // Each root file stands alone: one failing read keeps the other usable.
      Promise.all(
        ROOT_MEMORY.map(async (path): Promise<RootLoad> => {
          try {
            return {
              path,
              file: await bridge.invoke({ type: "readMemory", botId, path }),
              error: null,
            };
          } catch (error) {
            return { path, file: null, error: errorText(error) };
          }
        }),
      ),
      // The notes list stands alone too; its own failure keeps the roots usable.
      bridge
        .invoke({ type: "listMemory", botId })
        .catch((error: unknown) => ({ files: [], notesError: errorText(error), truncated: false })),
    ]).then(([root, notes]) => {
      if (active) setData({ root, notes });
    });
    return () => {
      active = false;
    };
  }, [bridge, botId, online, revision, visible, connection.connectedAt]);

  // Set when an edit began from an older revision; `text` is the root file's current text.
  const changed = (() => {
    const file = draft?.item?.file;
    if (!file || !data) return null;
    if (file.path.startsWith("memory/")) {
      const now = data.notes.files.find((entry) => entry.path === file.path);
      return (now?.hash ?? null) === file.hash ? null : { text: null };
    }
    const now = data.root.find((entry) => entry.path === file.path)?.file;
    return (now?.hash ?? null) === file.hash ? null : { text: now?.content ?? "" };
  })();

  /** The list's metadata for a note can lag behind a read; a read's revision is the current one. */
  const noteRead = (document: MemoryDocument) => {
    setNote(document);
    setData((current) =>
      current && current.notes.files.some((entry) => entry.path === document.path)
        ? {
            ...current,
            notes: {
              ...current.notes,
              files: current.notes.files.map((entry) =>
                entry.path === document.path
                  ? { path: entry.path, hash: document.hash, modifiedAt: document.modifiedAt }
                  : entry,
              ),
            },
          }
        : current,
    );
  };

  async function openNote(path: string) {
    setNote(null);
    setReadingNote(path);
    setActionError(null);
    try {
      noteRead(await bridge.invoke({ type: "readMemory", botId, path }));
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setReadingNote(null);
    }
  }

  async function save(
    path: string,
    text: string | null,
    item: Item | null,
    gatewayId: string | null,
  ) {
    const isNote = path.startsWith("memory/");
    const file = item?.file ?? data?.root.find((doc) => doc.path === path)?.file;
    const content = isNote
      ? text
      : item
        ? item.file.content.slice(0, item.start) + (text ?? "") + item.file.content.slice(item.end)
        : (file?.content.trim() ? file.content.trimEnd() + "\n\n" : "") + text + "\n";
    setBusy(true);
    setActionError(null);
    try {
      await bridge.invoke({
        type: "writeMemory",
        botId,
        path,
        gatewayId,
        expectedHash: file?.hash ?? null,
        content,
      });
      setDraft(null);
      setDeleting(null);
      setNote(null);
      setConflictNote(null);
      setRevision((current) => current + 1);
      announce(text === null ? "Memory deleted" : "Memory saved");
    } catch (error) {
      setDeleting(null);
      setActionError(errorText(error));
      setRevision((current) => current + 1);
      // A refused save leaves the draft; read the note again so the screen says what it now holds.
      if (isNote) {
        try {
          setConflictNote((await bridge.invoke({ type: "readMemory", botId, path })).content);
        } catch {
          // The next open of the note reports the read failure itself.
        }
      }
    } finally {
      setBusy(false);
    }
  }

  const form = (current: Draft) => (
    <form
      className="b-note memory-item"
      onSubmit={(event) => {
        event.preventDefault();
        if (canEdit && !busy && changed === null && current.text.trim())
          void save(current.path, current.text, current.item, current.gatewayId);
      }}
    >
      {!current.item && (
        <label>
          Save in
          <select
            className="input"
            disabled={busy}
            value={current.path.startsWith("memory/") ? "note" : current.path}
            onChange={(event) =>
              setDraft({
                ...current,
                path: event.target.value === "note" ? "memory/" : event.target.value,
              })
            }
          >
            <option value="MEMORY.md">Root memory</option>
            <option value="USER.md">About you</option>
            {MEMORY_NOTES_WRITABLE && data?.notes && !data.notes.notesError && (
              <option value="note">As a note</option>
            )}
          </select>
        </label>
      )}
      {!current.item && current.path.startsWith("memory/") && (
        <label>
          Note filename
          <input
            className="input"
            readOnly={busy}
            required
            value={current.path.slice(7)}
            pattern=".+\.md"
            onChange={(event) => setDraft({ ...current, path: `memory/${event.target.value}` })}
            placeholder="example.md"
          />
        </label>
      )}
      <label>
        Memory text
        <textarea
          className="input"
          ref={editor}
          readOnly={busy}
          required
          rows={6}
          value={current.text}
          onChange={(event) => setDraft({ ...current, text: event.target.value })}
        />
      </label>
      {changed !== null && (
        <div role="status">
          <p>
            {name}'s memory changed while you were editing. Your text is kept here
            {(changed.text ?? conflictNote) === null ? "." : "; the file now has:"}
          </p>
          {(changed.text ?? conflictNote) !== null && (
            <p>{(changed.text ?? conflictNote) || "Nothing."}</p>
          )}
        </div>
      )}
      {actionError && <p role="alert">{actionError}</p>}
      <div className="b-actions">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => {
            setDraft(null);
            setConflictNote(null);
            setActionError(null);
          }}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="button"
          data-variant="primary"
          disabled={busy || !canEdit || changed !== null || !current.text.trim()}
        >
          Save memory
        </button>
      </div>
    </form>
  );

  const renderItem = (item: Item) => {
    const isNote = item.file.path.startsWith("memory/");
    if (
      draft?.item?.file.path === item.file.path &&
      draft.item.file.hash === item.file.hash &&
      draft.item.start === item.start
    )
      return <li key={item.start}>{form(draft)}</li>;
    return (
      <li className="b-note memory-item" key={item.start}>
        <p>{item.text}</p>
        <small>
          {item.file.path} · {name} only
        </small>
        <small>
          Revision {item.file.hash?.slice(0, 7)}
          {item.file.modifiedAt !== null && `, changed ${fullDate(item.file.modifiedAt)}`}. Who
          saved this revision isn't recorded.
        </small>
        <small>
          {isNote
            ? "Not loaded into tasks."
            : `Loads into ${name}'s new private tasks, within the conditions above.`}{" "}
          Search for this revision is unconfirmed.
        </small>
        {canEdit && (!isNote || MEMORY_NOTES_WRITABLE) && (
          <div className="b-actions">
            <button
              type="button"
              className="button"
              data-size="sm"
              disabled={busy || draft !== null}
              onClick={() => {
                setActionError(null);
                setDraft({
                  path: item.file.path,
                  text: item.text,
                  item,
                  gatewayId: connection.gatewayId,
                });
                setConflictNote(null);
              }}
            >
              Edit
            </button>
            <button
              type="button"
              className="button"
              data-size="sm"
              disabled={busy || draft !== null}
              onClick={() => setDeleting({ item, gatewayId: connection.gatewayId })}
            >
              Delete
            </button>
          </div>
        )}
      </li>
    );
  };
  return (
    <div data-testid="memory-page">
      <div className="b-subhead">
        <button
          type="button"
          className="icon-button"
          data-variant="quiet"
          aria-label="Back to settings"
          onClick={onBack}
          disabled={busy}
        >
          <BackIcon />
        </button>
        <h3 ref={title} tabIndex={-1}>
          {name}'s memory
        </h3>
      </div>
      {!canEdit && !granted && (
        <AdminBar
          connection={connection}
          info={info}
          need={`Changing ${name}'s memory needs admin access.`}
        />
      )}
      {granted && <GrantedBar />}
      {!online && <p className="b-hint">Connect to the gateway to read memory.</p>}
      {online && !data && <p role="status">Loading memory…</p>}
      {data && (
        <>
          <p className="b-hint">
            Root memory and About you can load into new private tasks within the gateway's prompt
            limits. Tasks already open may keep their earlier copy. Routines, helpers, group and
            channel tasks can have different memory, and your own profile can take precedence over
            About you.
          </p>
          {data.root.map(({ path, file, error }) => (
            <section key={path}>
              <h4 className="b-group">{path === "MEMORY.md" ? "Root memory" : "About you"}</h4>
              {changed !== null && draft?.item?.file.path === path && form(draft)}
              {error ? (
                <p role="alert">
                  Couldn't read {path}. {error}{" "}
                  <button
                    type="button"
                    className="button"
                    onClick={() => setRevision((current) => current + 1)}
                  >
                    Try again
                  </button>
                </p>
              ) : (
                file &&
                (file.content.trim() ? (
                  <ul className="memory-items">{items(file).map(renderItem)}</ul>
                ) : (
                  <p className="b-hint">No text stored in {path}.</p>
                ))
              )}
            </section>
          ))}
          <section>
            <h4 className="b-group">Notes</h4>
            <p className="b-hint">
              Notes are stored separately and don't load into new tasks. Search can lag behind
              stored changes.
            </p>
            {!MEMORY_NOTES_WRITABLE && (
              <p className="b-hint">
                Notes are read-only here until the memory plugin's security review is recorded.
              </p>
            )}
            {data.notes.notesError && (
              <p className="b-hint">Couldn't list notes. {data.notes.notesError}</p>
            )}
            {data.notes.truncated && (
              <p className="b-hint">The gateway returned a partial list of notes.</p>
            )}
            {!data.notes.notesError && data.notes.files.length === 0 && (
              <p className="b-hint">No notes.</p>
            )}
            <dl className="facts">
              {data.notes.files.map((file) => (
                <div key={file.path}>
                  <button
                    type="button"
                    className="b-open"
                    disabled={!online || readingNote !== null || busy || draft !== null}
                    onClick={() => void openNote(file.path)}
                  >
                    {file.path}
                    <ChevronIcon />
                  </button>
                </div>
              ))}
            </dl>
            {readingNote && <p role="status">Reading {readingNote}…</p>}
            {note && (
              <ul className="memory-items">
                {renderItem({ file: note, text: note.content, start: 0, end: note.content.length })}
              </ul>
            )}
          </section>
          {draft && !draft.item
            ? form(draft)
            : canEdit &&
              !draft && (
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    setActionError(null);
                    setDraft({
                      path: "MEMORY.md",
                      text: "",
                      item: null,
                      gatewayId: connection.gatewayId,
                    });
                    setConflictNote(null);
                  }}
                >
                  Add memory
                </button>
              )}
        </>
      )}
      {actionError && !draft && <p role="alert">{actionError}</p>}
      {deleting && (
        <Confirm
          title="Delete this memory?"
          text={
            <>
              “{deleting.item.text}” will be removed from {deleting.item.file.path}. Chat history,
              earlier prompts and any stale search results stay.
            </>
          }
          action="Delete"
          busy={busy}
          onCancel={() => {
            if (!busy) setDeleting(null);
          }}
          onAction={() =>
            void save(deleting.item.file.path, null, deleting.item, deleting.gatewayId)
          }
        />
      )}
    </div>
  );
}
