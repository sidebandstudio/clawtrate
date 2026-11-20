import { ROOT_MEMORY, type MemoryDocument, type MemoryList } from "@clawtrate/core";
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
type Draft = { path: string; text: string; item: Item | null };

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
  const [data, setData] = useState<{ root: MemoryDocument[]; notes: MemoryList } | null>(null);
  const [note, setNote] = useState<MemoryDocument | null>(null);
  const [readingNote, setReadingNote] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<Item | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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
      Promise.all(ROOT_MEMORY.map((path) => bridge.invoke({ type: "readMemory", botId, path }))),
      bridge.invoke({ type: "listMemory", botId }),
    ]).then(
      ([root, notes]) => {
        if (active) {
          setData({ root, notes });
          setReadError(null);
        }
      },
      (error: unknown) => {
        if (active) setReadError(errorText(error));
      },
    );
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
    const now = data.root.find((entry) => entry.path === file.path);
    return (now?.hash ?? null) === file.hash ? null : { text: now?.content ?? "" };
  })();

  async function openNote(path: string) {
    setNote(null);
    setReadingNote(path);
    setActionError(null);
    try {
      setNote(await bridge.invoke({ type: "readMemory", botId, path }));
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setReadingNote(null);
    }
  }

  async function save(path: string, text: string | null, item: Item | null) {
    const isNote = path.startsWith("memory/");
    const file = item?.file ?? data?.root.find((doc) => doc.path === path);
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
        expectedHash: file?.hash ?? null,
        content,
      });
      setDraft(null);
      setDeleting(null);
      setNote(null);
      setRevision((current) => current + 1);
      announce(text === null ? "Memory deleted" : "Memory saved");
    } catch (error) {
      setDeleting(null);
      setActionError(errorText(error));
      setRevision((current) => current + 1);
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
          void save(current.path, current.text, current.item);
      }}
    >
      {!current.item && !data?.notes.notesError && (
        <label>
          Save in
          <select
            className="input"
            disabled={busy}
            value={current.path === "MEMORY.md" ? "root" : "note"}
            onChange={(event) =>
              setDraft({
                ...current,
                path: event.target.value === "root" ? "MEMORY.md" : "memory/",
              })
            }
          >
            <option value="root">Root memory</option>
            <option value="note">As a note</option>
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
            {changed.text === null ? "." : "; the file now has:"}
          </p>
          {changed.text !== null && <p>{changed.text || "Nothing."}</p>}
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
        {canEdit && (
          <div className="b-actions">
            <button
              type="button"
              className="button"
              data-size="sm"
              disabled={busy || draft !== null}
              onClick={() => {
                setActionError(null);
                setDraft({ path: item.file.path, text: item.text, item });
              }}
            >
              Edit
            </button>
            <button
              type="button"
              className="button"
              data-size="sm"
              disabled={busy || draft !== null}
              onClick={() => setDeleting(item)}
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
      {online && !data && !readError && <p role="status">Loading memory…</p>}
      {readError && (
        <p role="alert">
          Couldn't load memory. {readError}{" "}
          <button
            type="button"
            className="button"
            onClick={() => setRevision((current) => current + 1)}
          >
            Try again
          </button>
        </p>
      )}
      {data && (
        <>
          <p className="b-hint">
            Root memory and About you can load into new private tasks within the gateway's prompt
            limits. Tasks already open may keep their earlier copy. Routines, helpers, group and
            channel tasks can have different memory, and your own profile can take precedence over
            About you.
          </p>
          {data.root.map((file) => (
            <section key={file.path}>
              <h4 className="b-group">{file.path === "MEMORY.md" ? "Root memory" : "About you"}</h4>
              {changed !== null && draft?.item?.file.path === file.path && form(draft)}
              {file.content.trim() ? (
                <ul className="memory-items">{items(file).map(renderItem)}</ul>
              ) : (
                <p className="b-hint">No text stored in {file.path}.</p>
              )}
            </section>
          ))}
          <section>
            <h4 className="b-group">Notes</h4>
            <p className="b-hint">
              Notes are stored separately and don't load into new tasks. Search can lag behind
              stored changes.
            </p>
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
              !draft &&
              !readError && (
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    setActionError(null);
                    setDraft({ path: "MEMORY.md", text: "", item: null });
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
              “{deleting.text}” will be removed from {deleting.file.path}. Chat history, earlier
              prompts and any stale search results stay.
            </>
          }
          action="Delete"
          busy={busy}
          onCancel={() => {
            if (!busy) setDeleting(null);
          }}
          onAction={() => void save(deleting.file.path, null, deleting)}
        />
      )}
    </div>
  );
}
