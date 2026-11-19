import {
  isStopNow,
  type AttachmentInfo,
  type Bot,
  type MenuRow,
  type Run,
  type SendLimits,
  type Transcript,
} from "@clawtrate/core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  couldNotStart,
  questionPending,
  sendName,
  shelfMessages,
  type ComposerView,
  type SendMode,
} from "./live.ts";
import { Menu, type MenuEntry } from "./Menu.tsx";

/** The gateway's limits, checked as files are added (conversation.md, section 15). */
const MIB = 1024 * 1024;
/**
 * Clawtrate's own ceilings, used until the gateway has said its own (`SendLimits`): each image
 * up to 6 MiB, each other file up to 20 MiB, the encoded request up to 25 MiB, 20 files.
 */
export const DEFAULT_LIMITS: SendLimits = {
  imageBytes: 6 * MIB,
  fileBytes: 20 * MIB,
  payloadBytes: 25 * MIB,
  files: 20,
};
/** Room in a frame for the request around the files and words, as the engine counts it. */
const FRAME_SLACK_BYTES = 1024;
/** The tag each kind of "/" or "@" row carries (F-071, F-070). */
const TAG: Record<MenuRow["kind"], string> = {
  skill: "Skill",
  action: "Action",
  bot: "Bot",
  routine: "Routine",
};

/** How long a touch on Send is held before its menu opens. */
const LONG_PRESS_MS = 500;

/** "8.2 MB", "640 KB". */
export function size(bytes: number): string {
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** A limit as a person reads it: "6 MB", "18.6 MB". */
function limit(bytes: number): string {
  const mb = bytes / MIB;
  return Number.isInteger(mb) ? `${mb} MB` : size(bytes);
}

/** The bytes a file takes in the `chat.send` frame: its base64 form, its name and type around it. */
export function encodedBytes(file: { bytes: number; name: string }): number {
  return Math.ceil(file.bytes / 3) * 4 + new TextEncoder().encode(file.name).length + 96;
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
export function refusalFor(
  file: { size: number; type: string },
  limits: SendLimits = DEFAULT_LIMITS,
): string | null {
  const image = file.type.startsWith("image/");
  if (image && file.size > limits.imageBytes)
    return `${size(file.size)}. Images can be up to ${limit(limits.imageBytes)}.`;
  if (!image && file.size > limits.fileBytes)
    return `${size(file.size)}. Files can be up to ${limit(limits.fileBytes)}.`;
  return null;
}

/** Why a message with these words and files cannot go as one request, or null. */
export function messageRefusal(
  text: string,
  files: Array<{ bytes: number; name: string }>,
  limits: SendLimits = DEFAULT_LIMITS,
): string | null {
  if (files.length > limits.files)
    return `${files.length} files attached. A message can carry up to ${limits.files} files.`;
  const encoded =
    files.reduce((sum, file) => sum + encodedBytes(file), 0) +
    new TextEncoder().encode(text).length +
    FRAME_SLACK_BYTES;
  if (files.length > 0 && encoded > limits.payloadBytes)
    return `${size(encoded)} to send with its files. A message can carry up to ${limit(limits.payloadBytes)}.`;
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
  limits,
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
  /** What the gateway said one message may carry; Clawtrate's own ceilings until it has. */
  limits: SendLimits | null;
}) {
  const ceilings = limits ?? DEFAULT_LIMITS;
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
  // Skills, actions, bots and routines chosen from the "/" and "@" menus: chips sent before the words.
  const [tokens, setTokens] = useState<MenuRow[]>([]);
  /** The menu the words before the caret open: its trigger, what follows it, and where it starts. */
  const [picker, setPicker] = useState<{ trigger: "/" | "@"; query: string; start: number } | null>(
    null,
  );
  const [menuRows, setMenuRows] = useState<{
    trigger: "/" | "@";
    rows: MenuRow[] | null;
    error: string | null;
  } | null>(null);
  const [active, setActive] = useState(0);
  /** Where the caret goes once the field shows the text just set, if somewhere. */
  const caretAt = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caretAt.current === null) return;
    focusRef.current?.setSelectionRange(caretAt.current, caretAt.current);
    caretAt.current = null;
  });
  const [menu, setMenuState] = useState<null | "mode" | "send">(null);
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  /** Open a menu; focus returns to `from` when it closes (Send, for a long press). */
  const setMenu = (next: null | "mode" | "send", from?: HTMLElement | null) => {
    setTrigger(
      from ?? (next === "mode" ? modeRef.current : next === "send" ? sendRef.current : null),
    );
    setMenuState(next);
  };
  // Touch and hold on Send opens the same menu, as a sheet from the foot of the screen.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const endPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
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

  const whole = messageRefusal(text, files, ceilings);
  const tooMuch = whole !== null;
  const refused = files.some((file) => file.refusal) || tooMuch;
  const uploading = files.some((file) => file.uploading);
  const hasContent = text.trim().length > 0 || files.length > 0 || tokens.length > 0;
  const canSend = hasContent && !refused && !uploading;
  const refusalReason = refused ? (whole ?? "Remove the files that are too large to send.") : null;

  const stop = useCallback(
    (run: Run) => {
      void bridge.send({ type: "stopRun", key: taskKey, runId: run.id }).catch(() => {});
      onAnnounce("Stopping");
    },
    [bridge, taskKey, onAnnounce],
  );

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
      // "Stop now" typed during a run is Stop, as the button is: it is not sent as words.
      if (how !== "new-task" && view.stoppable && files.length === 0 && isStopNow(text)) {
        setText("");
        stop(view.stoppable);
        return;
      }
      submitting.current = true;
      const words = text;
      const chips = tokens;
      // The chips go first, as their own text: the gateway runs a command or skill named so.
      const body = [...chips.map((chip) => chip.insert), words.trim()].filter(Boolean).join(" ");
      const taken = files;
      const attachmentIds = taken.flatMap((file) => (file.info ? [file.info.id] : []));
      setText("");
      setFiles([]);
      setTokens([]);
      setPicker(null);
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
        // A pending question holds every message, however it was sent.
        if (view.mode === "hold") onAnnounce("Held until you answer");
        else if (how === "queue" || view.stopping) onAnnounce("Queued");
      } catch (error) {
        setTextState((current) => {
          const back = current.trim() ? `${words}\n${current}` : words;
          writeDraft(draftKey, back);
          return back;
        });
        setFiles((current) => [...taken, ...current]);
        setTokens((current) => [...chips, ...current]);
        onNotice({
          title: how === "new-task" ? "Couldn't start a new task." : "Couldn't send this message.",
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        submitting.current = false;
      }
    },
    [
      canSend,
      text,
      files,
      tokens,
      bridge,
      bot.id,
      taskKey,
      draftKey,
      setText,
      onAnnounce,
      onNotice,
      view,
      stop,
    ],
  );

  // Window-wide keys: ⌘. stops, ⌘↵ sends from anywhere except inside a card
  // that answers it, ⌘I focuses the field, ⌘L adds the selected text.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!command(event) || event.defaultPrevented) return;
      if (!reachable(focusRef.current)) return;
      const target = event.target as Element | null;
      if (event.key === "." && !event.shiftKey) {
        if (view.stoppable) {
          event.preventDefault();
          stop(view.stoppable);
        }
      } else if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
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

  // The "/" and "@" menus (F-071, F-070): what the words before the caret open, read once per opening.
  const shownRows =
    picker && menuRows?.trigger === picker.trigger && menuRows.rows
      ? menuRows.rows
          .filter((row) => {
            const query = picker.query.toLowerCase();
            return (
              !query ||
              row.name.toLowerCase().includes(query) ||
              row.insert.toLowerCase().includes(query)
            );
          })
          .slice(0, 50)
      : [];
  const pickerOpen =
    picker !== null &&
    (menuRows === null ||
      menuRows.trigger !== picker.trigger ||
      menuRows.rows === null ||
      menuRows.error !== null ||
      shownRows.length > 0);
  const watchCaret = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const found = /(^|\s)([/@])([^\s/@]*)$/.exec(before);
    if (!found) {
      setPicker(null);
      return;
    }
    const trigger = found[2] as "/" | "@";
    // "/" opens the menu only at the start of the message, as a command is written.
    if (trigger === "/" && before.slice(0, before.length - found[3]!.length - 1).trim() !== "") {
      setPicker(null);
      return;
    }
    const start = before.length - found[3]!.length - 1;
    if (!picker || picker.trigger !== trigger || picker.start !== start) setActive(0);
    setPicker({ trigger, query: found[3]!, start });
    if (menuRows?.trigger !== trigger) {
      setMenuRows({ trigger, rows: null, error: null });
      void bridge.invoke({ type: "readComposerMenu", key: taskKey, trigger }).then(
        (rows) => setMenuRows({ trigger, rows, error: null }),
        (error: unknown) =>
          setMenuRows({
            trigger,
            rows: [],
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    }
  };
  const choose = (row: MenuRow) => {
    if (!picker) return;
    const caret = focusRef.current?.selectionStart ?? text.length;
    if (row.kind === "bot" || row.kind === "routine") {
      // A mention stays where it was typed, as text: the gateway's mentions are people only.
      const inserted = `${row.insert} `;
      const next = text.slice(0, picker.start) + inserted + text.slice(caret).replace(/^\s+/, "");
      setText(next);
      // The caret goes after the name as the new text is drawn, before any later key lands.
      caretAt.current = picker.start + inserted.length;
    } else {
      // The typed trigger and query leave the words; the skill or action becomes a chip.
      setText((text.slice(0, picker.start) + text.slice(caret)).replace(/^\s+/, ""));
      setTokens((current) => [...current, row]);
    }
    setPicker(null);
    onAnnounce(`${row.insert} added`);
    focusRef.current?.focus();
  };

  const onFieldKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen && !event.nativeEvent.isComposing) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPicker(null);
        return;
      }
      if (shownRows.length > 0) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          setActive((current) => (current + step + shownRows.length) % shownRows.length);
          return;
        }
        if (
          (event.key === "Enter" && !event.shiftKey && !event.altKey && !command(event)) ||
          event.key === "Tab"
        ) {
          event.preventDefault();
          choose(shownRows[Math.min(active, shownRows.length - 1)]!);
          return;
        }
      }
    }
    if (
      event.key === "Backspace" &&
      tokens.length > 0 &&
      (event.currentTarget.selectionStart ?? 0) === 0 &&
      (event.currentTarget.selectionEnd ?? 0) === 0
    ) {
      // Backspace at the start of the words takes the last chip away.
      event.preventDefault();
      const last = tokens.at(-1)!;
      setTokens((current) => current.slice(0, -1));
      onAnnounce(`${last.name} removed`);
      return;
    }
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
        const refusal = refusalFor(file, ceilings);
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
    [bridge, ceilings],
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
    const send = (type: "retryMessage" | "deleteMessage" | "cancelQueued" | "sendQueuedNow") =>
      act(() => bridge.send({ type, key: taskKey, messageId: message.id }));
    if (message.status === "not-sent") {
      rows.push(
        <div className="shelf-row" key={message.id} data-kind="not-sent" data-testid="shelf-row">
          <span className="glyph" data-state="stopped" aria-hidden="true" />
          <span className="shelf-text">
            <b>Not sent</b> <span>{message.text}</span>
          </span>
          <button
            type="button"
            className="button"
            data-size="sm"
            onClick={() => send("retryMessage")}
          >
            Send
          </button>
          <button
            type="button"
            className="button"
            data-size="sm"
            data-variant="quiet"
            onClick={() => send("deleteMessage")}
          >
            Remove
          </button>
        </div>,
      );
      continue;
    }
    if (couldNotStart(message)) {
      rows.push(
        <div
          className="shelf-row"
          key={message.id}
          data-kind="could-not-start"
          data-tone="danger"
          data-testid="shelf-row"
        >
          <span className="shelf-text" title={message.error ?? undefined}>
            <b>Couldn't start</b> {message.error && <span>{message.error}</span>}{" "}
            <span>{message.text}</span>
          </span>
          <button
            type="button"
            className="button"
            data-size="sm"
            onClick={() => send("retryMessage")}
          >
            Try again
          </button>
          <button
            type="button"
            className="button"
            data-size="sm"
            data-variant="quiet"
            onClick={() => send("deleteMessage")}
          >
            Delete
          </button>
        </div>,
      );
      continue;
    }
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
              // The message comes back as one record: its words and its files.
              void bridge
                .invoke({ type: "takeBackMessage", key: taskKey, messageId: message.id })
                .then(
                  (back) => {
                    // Unsent words are never lost: an existing draft keeps its place above them.
                    setTextState((current) => {
                      const next = current.trim() ? `${current}\n${back.text}` : back.text;
                      writeDraft(draftKey, next);
                      return next;
                    });
                    setFiles((current) => [
                      ...current,
                      ...back.attachments.map((info) => ({
                        key: info.id,
                        name: info.fileName,
                        bytes: info.sizeBytes,
                        image: info.mimeType.startsWith("image/"),
                        info,
                        refusal: null,
                        uploading: false,
                      })),
                    ]);
                  },
                  (error: unknown) =>
                    onNotice({
                      title: "Couldn't take this message back.",
                      reason: error instanceof Error ? error.message : String(error),
                    }),
                );
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
  const noticeRows: ReactNode[] = [];
  for (const notice of notices) {
    noticeRows.push(
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
    noticeRows.push(
      <div className="shelf-clear" key="clear-all">
        <button type="button" className="link-button" onClick={() => act(onClearNotices)}>
          Clear all
        </button>
      </div>,
    );
  }
  if (noticeRows.length > 0) {
    rows.push(
      <div className="shelf-notices" role="group" aria-label="Notifications" key="notices">
        {noticeRows}
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
  // On a phone the menu is a sheet from the foot of the screen.
  const touch =
    typeof document !== "undefined" && document.documentElement.dataset.input === "touch";

  return (
    <footer className="composer" data-testid="composer">
      <div className="composer-inner">
        <div className="composer-shelf" aria-label="Waiting to send">
          {rows}
        </div>
        <div className="composer-box" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          {pickerOpen && (
            <div className="composer-menu" data-testid="composer-menu">
              {menuRows?.trigger !== picker!.trigger || menuRows.rows === null ? (
                <p className="composer-menu-note" aria-busy="true">
                  {picker!.trigger === "/"
                    ? "Loading skills and actions…"
                    : "Loading bots and routines…"}
                </p>
              ) : menuRows.error ? (
                <p className="composer-menu-note" role="alert">
                  Couldn't load the list: {menuRows.error}
                </p>
              ) : (
                <ul
                  id="composer-menu"
                  role="listbox"
                  aria-label={
                    picker!.trigger === "/" ? "Skills and actions" : "Mention a bot or routine"
                  }
                >
                  {shownRows.map((row, index) => (
                    <li
                      key={`${row.kind}:${row.insert}`}
                      id={`composer-menu-${index}`}
                      role="option"
                      aria-selected={index === Math.min(active, shownRows.length - 1)}
                      className="composer-menu-row"
                      data-testid="composer-menu-row"
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => choose(row)}
                    >
                      <span className="composer-menu-name">{row.insert}</span>
                      {row.description && (
                        <span className="composer-menu-description">{row.description}</span>
                      )}
                      <span className="composer-menu-tag">{TAG[row.kind]}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {tokens.length > 0 && (
            <ul className="chips composer-tokens" aria-label="Sent first">
              {tokens.map((token, index) => (
                <li
                  key={`${token.insert}:${index}`}
                  className="chip"
                  data-kind={token.kind}
                  data-testid="token-chip"
                >
                  <span className="chip-tag">{TAG[token.kind]}</span>
                  <b>{token.insert}</b>
                  <button
                    type="button"
                    className="chip-remove"
                    aria-label={`Remove ${token.insert}`}
                    onClick={() => {
                      setTokens((current) => current.filter((_, at) => at !== index));
                      focusRef.current?.focus();
                    }}
                  >
                    <CloseIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
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
              onChange={(event) => {
                setText(event.target.value);
                watchCaret(
                  event.target.value,
                  event.target.selectionStart ?? event.target.value.length,
                );
              }}
              onSelect={(event) => {
                const field = event.currentTarget;
                if (picker) watchCaret(field.value, field.selectionStart ?? field.value.length);
              }}
              onBlur={() => setPicker(null)}
              aria-autocomplete="list"
              aria-controls={pickerOpen ? "composer-menu" : undefined}
              aria-expanded={pickerOpen}
              aria-activedescendant={
                pickerOpen && shownRows.length > 0
                  ? `composer-menu-${Math.min(active, shownRows.length - 1)}`
                  : undefined
              }
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
              onClick={() => {
                // The release that ends a long press is not a send.
                if (longPressed.current) {
                  longPressed.current = false;
                  return;
                }
                void sendAs(view.mode);
              }}
              onPointerDown={(event) => {
                if (event.pointerType !== "touch") return;
                longPressed.current = false;
                endPress();
                const from = event.currentTarget;
                pressTimer.current = setTimeout(() => {
                  longPressed.current = true;
                  setMenu(view.menu === "idle" ? "send" : "mode", from);
                }, LONG_PRESS_MS);
              }}
              onPointerUp={endPress}
              onPointerCancel={endPress}
              onPointerLeave={endPress}
              onContextMenu={(event) => {
                if (view.menu !== "idle" && !touch) return;
                event.preventDefault();
                if (!touch) setMenu("send");
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
          {menu && !touch && (
            <Menu label="How to send" entries={menuEntries} onClose={closeMenu} trigger={trigger} />
          )}
        </div>
      </div>
      {menu && touch && (
        <>
          <div className="sheet-scrim" aria-hidden="true" onPointerDown={() => closeMenu(true)} />
          <div className="composer-sheet" data-testid="send-sheet">
            <Menu label="How to send" entries={menuEntries} onClose={closeMenu} trigger={trigger} />
          </div>
        </>
      )}
    </footer>
  );
}

/**
 * Whether the window's shortcuts may act on this conversation: it is shown,
 * not inert behind a drawer, and no modal dialog is open over it.
 */
export function reachable(element: Element | null): boolean {
  if (!element || !element.isConnected) return false;
  if (element.closest("[inert]")) return false;
  if (!element.checkVisibility()) return false;
  const modal = document.querySelector('[aria-modal="true"]');
  return !modal || modal.contains(element);
}

function isLive(run: Run): boolean {
  return run.state === "running" || run.state === "waiting" || run.state === "stopping";
}
