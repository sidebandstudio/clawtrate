import type { AttachmentInfo, Bot, Run, Transcript } from "@clawtrate/core";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useBridge } from "./bridge.tsx";
import { ArrowUpIcon, ChevronIcon, CloseIcon, FileIcon, PlusIcon } from "./icons.tsx";
import {
  composerFor,
  questionPending,
  sendName,
  shelfMessages,
  type ComposerView,
  type SendMode,
} from "./live.ts";
import { Menu, type MenuEntry } from "./Menu.tsx";

/** The gateway's limits, checked as files are added (conversation.md, section 15). */
const MIB = 1024 * 1024;
export const IMAGE_LIMIT = 6 * MIB;
export const FILE_LIMIT = 20 * MIB;
export const MESSAGE_LIMIT = 25 * MIB;
const MAX_FILES = 20;

/** "8.2 MB", "640 KB". */
export function size(bytes: number): string {
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

type Attached = {
  /** Local key for the chip. */
  key: string;
  name: string;
  bytes: number;
  image: boolean;
  /** The host's id once it holds the file. */
  info: AttachmentInfo | null;
  /** Why this file cannot go. */
  refusal: string | null;
  uploading: boolean;
};

/** A file the gateway would refuse, said before anything is sent. */
export function refusalFor(file: { size: number; type: string }): string | null {
  const image = file.type.startsWith("image/");
  if (image && file.size > IMAGE_LIMIT) return `${size(file.size)}. Images can be up to 6 MB.`;
  if (!image && file.size > FILE_LIMIT) return `${size(file.size)}. Files can be up to 20 MB.`;
  return null;
}

// Drafts are the person's unsent words: kept per gateway and task for this
// viewer, in memory and, where the browser allows it, across reloads.
const drafts = new Map<string, string>();
function readDraft(key: string): string {
  if (drafts.has(key)) return drafts.get(key)!;
  try {
    return localStorage.getItem(`clawtrate.draft.${key}`) ?? "";
  } catch {
    return "";
  }
}
function writeDraft(key: string, text: string): void {
  drafts.set(key, text);
  try {
    if (text) localStorage.setItem(`clawtrate.draft.${key}`, text);
    else localStorage.removeItem(`clawtrate.draft.${key}`);
  } catch {
    // Storage may be unavailable; the draft still lives for this page.
  }
}

/** True on a Mac, where ⌘ is the command key; elsewhere Ctrl stands for it. */
const isMac = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "");
export const command = (event: { metaKey: boolean; ctrlKey: boolean }) =>
  isMac() ? event.metaKey : event.ctrlKey;

export type Notice = { id: string; title: string; reason: string | null; retry?: () => void };

/** What needs the person, for the shelf's row and ⌘J. */
export type NeedsYou = { kind: "approval" | "question"; text: string } | null;

export function Composer({
  bot,
  gateway,
  taskKey,
  transcript,
  connected,
  notices,
  needsYou,
  onReview,
  onNotice,
  onDismissNotice,
  onClearNotices,
  onAnnounce,
  focusRef,
}: {
  bot: Bot;
  /** The gateway's address: drafts are kept per gateway and per task. */
  gateway: string | null;
  taskKey: string;
  transcript: Transcript | undefined;
  connected: boolean;
  notices: Notice[];
  needsYou: NeedsYou;
  onReview: () => void;
  onNotice: (notice: Omit<Notice, "id">) => void;
  onDismissNotice: (id: string) => void;
  onClearNotices: () => void;
  onAnnounce: (text: string) => void;
  focusRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const bridge = useBridge();
  // A draft belongs to one task on one gateway.
  const draftKey = `${gateway ?? ""}|${taskKey}`;
  const [text, setTextState] = useState(() => readDraft(draftKey));
  const setText = useCallback(
    (next: string) => {
      setTextState(next);
      writeDraft(draftKey, next);
    },
    [draftKey],
  );
  const [files, setFiles] = useState<Attached[]>([]);
  const [menu, setMenuState] = useState<null | "mode" | "send">(null);
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const setMenu = (next: null | "mode" | "send") => {
    setTrigger(next === "mode" ? modeRef.current : next === "send" ? sendRef.current : null);
    setMenuState(next);
  };
  // The mode chosen from the menu lasts for the run it was chosen in.
  const [chosen, setChosen] = useState<{ run: string; mode: "steer" | "queue" } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const modeRef = useRef<HTMLButtonElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);

  const runId = transcript?.runs.find((run) => run.state !== "queued" && isLive(run))?.id ?? null;
  const view: ComposerView = composerFor(transcript, {
    bot: bot.name,
    connected,
    chosen: chosen && chosen.run === runId ? chosen.mode : null,
  });

  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  const tooMuch = total > MESSAGE_LIMIT || files.length > MAX_FILES;
  const refused = files.some((file) => file.refusal) || tooMuch;
  const uploading = files.some((file) => file.uploading);
  const hasContent = text.trim().length > 0 || files.length > 0;
  const canSend = hasContent && !refused && !uploading;
  const refusalReason = refused
    ? tooMuch
      ? files.length > MAX_FILES
        ? `${files.length} files attached. A message can carry up to 20 files.`
        : `${size(total)} attached. A message can carry up to 25 MB.`
      : "Remove the files that are too large to send."
    : null;

  // One submit sends once: while a send is on its way, another does nothing.
  const submitting = useRef(false);

  /**
   * The one send operation: Enter, Send and the menu all come here. The send
   * takes the draft and its files at once, so the field is free for the next
   * words while it goes out and nothing later clears them. If the host
   * refuses it, the words and files come back, ahead of anything typed since.
   */
  const sendAs = useCallback(
    async (how: SendMode | "new-task") => {
      if (!canSend || submitting.current) return;
      if (how === "new-task" && files.length > 0) {
        // Task creation takes no files yet; nothing is sent, and nothing is lost.
        onNotice({
          title: "Couldn't start a new task.",
          reason: "A new task can't take files yet. Send them in this task, or remove them first.",
        });
        return;
      }
      submitting.current = true;
      const body = text;
      const taken = files;
      const attachmentIds = taken.flatMap((file) => (file.info ? [file.info.id] : []));
      setText("");
      setFiles([]);
      try {
        if (how === "new-task") {
          const { key } = await bridge.invoke({
            type: "createTask",
            botId: bot.id,
            text: body,
            label: null,
          });
          // The new task runs on its own; this viewer stays on this one.
          void bridge.send({ type: "closeSession", key });
          onAnnounce("Started as a new task");
          return;
        }
        await bridge.invoke({
          type: "sendMessage",
          key: taskKey,
          text: body,
          mode: how === "queue" ? "queue" : "auto",
          attachmentIds,
        });
        if (how === "hold") onAnnounce("Held until you answer");
        else if (how === "queue" || view.stopping) onAnnounce("Queued");
      } catch (error) {
        setTextState((current) => {
          const back = current.trim() ? `${body}\n${current}` : body;
          writeDraft(draftKey, back);
          return back;
        });
        setFiles((current) => [...taken, ...current]);
        onNotice({
          title: how === "new-task" ? "Couldn't start a new task." : "Couldn't send this message.",
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        submitting.current = false;
      }
    },
    [canSend, text, files, bridge, bot.id, taskKey, draftKey, setText, onAnnounce, onNotice, view],
  );

  const stop = useCallback(
    (run: Run) => {
      void bridge.send({ type: "stopRun", key: taskKey, runId: run.id }).catch(() => {});
      onAnnounce("Stopping");
    },
    [bridge, taskKey, onAnnounce],
  );

  // Window-wide keys: ⌘. stops, ⌘↵ sends from anywhere except inside a card
  // that answers it, ⌘I focuses the field, ⌘L adds the selected text.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!command(event) || event.defaultPrevented) return;
      const target = event.target as Element | null;
      if (event.key === "." && !event.shiftKey) {
        if (view.stoppable) {
          event.preventDefault();
          stop(view.stoppable);
        }
      } else if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
        if (target?.closest("[data-answers-mod-enter]")) return;
        if (target === focusRef.current) return;
        event.preventDefault();
        void sendAs(view.mode);
      } else if (event.key.toLowerCase() === "i" && !event.shiftKey) {
        event.preventDefault();
        focusRef.current?.focus();
      } else if (event.key.toLowerCase() === "l" && !event.shiftKey) {
        const selected = globalThis.getSelection?.()?.toString() ?? "";
        if (!selected.trim() || target === focusRef.current) return;
        event.preventDefault();
        setText(text ? `${text}\n${selected}` : selected);
        focusRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, stop, sendAs, focusRef, setText, text]);

  const onFieldKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.shiftKey && !command(event)) return; // a new line
    event.preventDefault();
    if (event.shiftKey && command(event)) void sendAs("new-task");
    else if (event.altKey) void sendAs("queue");
    else void sendAs(view.mode);
  };

  const addFiles = useCallback(
    (list: FileList | File[]) => {
      for (const file of [...list]) {
        const key = `${file.name}:${file.size}:${Math.random().toString(36).slice(2)}`;
        const refusal = refusalFor(file);
        const entry: Attached = {
          key,
          name: file.name,
          bytes: file.size,
          image: file.type.startsWith("image/"),
          info: null,
          refusal,
          uploading: refusal === null,
        };
        setFiles((current) => [...current, entry]);
        if (refusal) continue;
        void file
          .arrayBuffer()
          .then((data) =>
            bridge.attach({ name: file.name, type: file.type || "application/octet-stream", data }),
          )
          .then(
            (info) =>
              setFiles((current) =>
                current.map((each) =>
                  each.key === key ? { ...each, info, uploading: false } : each,
                ),
              ),
            (error: unknown) =>
              setFiles((current) =>
                current.map((each) =>
                  each.key === key
                    ? {
                        ...each,
                        uploading: false,
                        refusal: error instanceof Error ? error.message : String(error),
                      }
                    : each,
                ),
              ),
          );
      }
    },
    [bridge],
  );

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (event.clipboardData.files.length > 0) {
      event.preventDefault();
      addFiles(event.clipboardData.files);
    }
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    addFiles(event.dataTransfer.files);
  };

  /**
   * Run an action whose control then goes away (Stop, a row's buttons, a
   * notice's Dismiss): focus moves to the field instead of being lost.
   */
  const act = (action: () => unknown) => {
    const result = action();
    if (result instanceof Promise) result.catch(() => {});
    focusRef.current?.focus();
  };

  // Rows on the shelf, oldest first, newest at the bottom.
  const rows: ReactNode[] = [];
  const run = transcript?.runs.find((each) => each.id === runId) ?? null;
  const asking = run && transcript ? questionPending(transcript, run) : false;
  for (const message of shelfMessages(transcript)) {
    const held = message.status === "held";
    rows.push(
      <div
        className="shelf-row"
        key={message.id}
        data-kind={message.status}
        data-testid="shelf-row"
      >
        <span className="glyph" data-state="queued" aria-hidden="true" />
        <span className="shelf-text">
          <b>{held ? "Held until you answer" : "Queued"}</b> <span>{message.text}</span>
        </span>
        {held ? (
          <button
            type="button"
            className="button"
            data-size="sm"
            onClick={() => {
              act(() => bridge.send({ type: "cancelQueued", key: taskKey, messageId: message.id }));
              // Unsent words are never lost: an existing draft keeps its place above them.
              setText(text.trim() ? `${text}\n${message.text}` : message.text);
              focusRef.current?.focus();
            }}
          >
            Edit
          </button>
        ) : (
          !view.stopping &&
          !asking && (
            <button
              type="button"
              className="button"
              data-size="sm"
              onClick={() =>
                act(() =>
                  bridge.send({ type: "sendQueuedNow", key: taskKey, messageId: message.id }),
                )
              }
            >
              Send now
            </button>
          )
        )}
        <button
          type="button"
          className="button"
          data-size="sm"
          data-variant="quiet"
          onClick={() =>
            act(() => bridge.send({ type: "cancelQueued", key: taskKey, messageId: message.id }))
          }
        >
          Cancel
        </button>
      </div>,
    );
  }
  if (needsYou) {
    rows.push(
      <div className="shelf-row" data-tone="warn" key="needs-you" data-testid="needs-you">
        <span className="glyph" data-state="waiting" aria-hidden="true" />
        <span className="shelf-text">
          {needsYou.kind === "question" && text.trim()
            ? `${bot.name} asked a question. A message sent now is held until you answer.`
            : needsYou.text}
        </span>
        <button type="button" className="button" data-size="sm" onClick={onReview}>
          Review
        </button>
      </div>,
    );
  }
  for (const notice of notices) {
    rows.push(
      <div className="shelf-row" data-tone="danger" key={notice.id} role="alert">
        <span className="shelf-text">
          <b>{notice.title}</b> {notice.reason && <span>{notice.reason}</span>}
        </span>
        {notice.retry && (
          <button type="button" className="button" data-size="sm" onClick={notice.retry}>
            Try again
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          data-variant="quiet"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={() => act(() => onDismissNotice(notice.id))}
        >
          <CloseIcon />
        </button>
      </div>,
    );
  }
  if (notices.length > 1) {
    rows.push(
      <div className="shelf-clear" key="clear-all">
        <button type="button" className="link-button" onClick={() => act(onClearNotices)}>
          Clear all
        </button>
      </div>,
    );
  }

  const menuEntries: MenuEntry[] =
    menu === "send" || view.menu === "idle"
      ? [
          { kind: "item", label: "Send", hint: "↵", onSelect: () => pick("send") },
          {
            kind: "item",
            label: "Start as new task",
            hint: "⇧⌘↵",
            onSelect: () => pick("new-task"),
          },
        ]
      : [
          view.menu === "hold"
            ? {
                kind: "radio",
                label: "Hold until you answer",
                hint: "↵",
                checked: true,
                onSelect: () => pick("hold"),
              }
            : {
                kind: "radio",
                label: "Steer this turn",
                hint: "↵",
                checked: view.mode === "steer",
                onSelect: () => pick("steer"),
              },
          {
            kind: "radio",
            label: "Queue after this turn",
            hint: "⌥↵",
            checked: view.mode === "queue",
            onSelect: () => pick("queue"),
          },
          {
            kind: "item",
            label: "Start as new task",
            hint: "⇧⌘↵",
            onSelect: () => pick("new-task"),
          },
        ];

  function pick(how: SendMode | "new-task") {
    setMenu(null);
    if (how === "new-task") void sendAs("new-task");
    else if (how === "send") void sendAs("send");
    else if ((how === "steer" || how === "queue") && runId) {
      setChosen({ run: runId, mode: how });
      focusRef.current?.focus();
    } else focusRef.current?.focus();
  }

  const closeMenu = useCallback(
    (refocus: boolean) => {
      if (refocus) trigger?.focus();
      setMenuState(null);
    },
    [trigger],
  );

  const showMode = view.modeWord !== null && text.trim().length > 0;

  return (
    <footer className="composer" data-testid="composer">
      <div className="composer-inner">
        <div className="composer-shelf" aria-label="Waiting to send">
          {rows}
        </div>
        <div className="composer-box" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          {files.length > 0 && (
            <div className="attachments">
              <ul className="chips">
                {files.map((file) => (
                  <li
                    key={file.key}
                    className="chip"
                    data-tone={file.refusal ? "danger" : undefined}
                    aria-busy={file.uploading || undefined}
                  >
                    <FileIcon />
                    <b>{file.name}</b>
                    <span>{file.refusal ?? size(file.bytes)}</span>
                    <button
                      type="button"
                      className="chip-remove"
                      aria-label={`Remove ${file.name}`}
                      onClick={() =>
                        setFiles((current) => current.filter((each) => each.key !== file.key))
                      }
                    >
                      <CloseIcon />
                    </button>
                  </li>
                ))}
              </ul>
              {tooMuch && <p className="attachments-note">{refusalReason}</p>}
            </div>
          )}
          <div className="composer-row">
            <button
              type="button"
              className="icon-button"
              aria-label="Attach files"
              title="Attach files"
              onClick={() => fileInput.current?.click()}
            >
              <PlusIcon />
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                if (event.target.files) addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <textarea
              ref={focusRef}
              className="composer-input"
              rows={1}
              value={text}
              placeholder={view.placeholder}
              aria-label={view.placeholder}
              data-testid="composer-input"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onFieldKey}
              onPaste={onPaste}
            />
            {showMode && (
              <button
                ref={modeRef}
                type="button"
                className="send-mode"
                aria-haspopup="menu"
                aria-expanded={menu === "mode"}
                aria-label={`How to send: ${view.modeWord}`}
                onClick={() => setMenu(menu === "mode" ? null : "mode")}
              >
                {view.modeWord}
                <ChevronIcon />
              </button>
            )}
            {view.stopping && <span className="composer-status">Stopping…</span>}
            {view.stoppable && (
              <button
                type="button"
                className="icon-button stop-button"
                aria-label={`Stop ${bot.name}`}
                title={`Stop ${bot.name} (⌘.)`}
                data-testid="stop"
                onClick={() => act(() => stop(view.stoppable!))}
              />
            )}
            <button
              ref={sendRef}
              type="button"
              className="icon-button send-button"
              aria-label={sendName(view.mode)}
              aria-description={refusalReason ?? undefined}
              title={refusalReason ?? sendName(view.mode)}
              disabled={!canSend}
              data-testid="send"
              onClick={() => void sendAs(view.mode)}
              onContextMenu={(event) => {
                if (view.menu !== "idle") return;
                event.preventDefault();
                setMenu("send");
              }}
              onKeyDown={(event) => {
                if (
                  view.menu === "idle" &&
                  ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu")
                ) {
                  event.preventDefault();
                  setMenu("send");
                }
              }}
            >
              <ArrowUpIcon />
            </button>
          </div>
          {menu && (
            <Menu label="How to send" entries={menuEntries} onClose={closeMenu} trigger={trigger} />
          )}
        </div>
      </div>
    </footer>
  );
}

function isLive(run: Run): boolean {
  return run.state === "running" || run.state === "waiting" || run.state === "stopping";
}
