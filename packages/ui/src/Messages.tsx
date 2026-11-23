// What a person can do with a message in the transcript (parity F-066, F-067,
// F-283): hovering, focusing or touching and holding a message shows react,
// reply and more beside it; reactions show as small emoji badges under it; a
// reply carries a line naming what it answers, and the thread view assembles
// a message and the replies to it from the gateway's own reply references,
// since the gateway keeps a reply only as a reference with no thread of its own.

import {
  botIdFromSessionKey,
  MAX_OUTBOX,
  namesOutgoing,
  type MessageReaction,
  type OutgoingMessage,
  type Transcript,
  type TranscriptItem,
} from "@clawtrate/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useBridge } from "./bridge.tsx";
import { copyText } from "./clipboard.ts";
import { useHoldsWords } from "./held-words.ts";
import { ArrowUpIcon, CloseIcon, MoreIcon, ReplyIcon, SmileIcon } from "./icons.tsx";
import { ShelfRow, takenBack } from "./Composer.tsx";
import {
  currentRun,
  DRAFT_GONE,
  DRAFT_MOVED,
  DRAFT_UNBOUND,
  joinDrafts,
  questionPending,
  sendWaits,
  shelfMessages,
  type Draft,
} from "./live.ts";
import { OutgoingBubble } from "./LiveTurn.tsx";
import { Markdown } from "./Markdown.tsx";
import { Menu, type MenuEntry } from "./Menu.tsx";

/** The reactions offered by the react button: one emoji each, as the gateway takes them. */
export const REACTIONS: Array<{ emoji: string; name: string }> = [
  { emoji: "👍", name: "Thumbs up" },
  { emoji: "❤️", name: "Heart" },
  { emoji: "😂", name: "Laughing" },
  { emoji: "🎉", name: "Party" },
  { emoji: "👀", name: "Looking" },
  { emoji: "🙏", name: "Thank you" },
];

/** How long a touch on a message is held before its actions show. */
const LONG_PRESS_MS = 500;

type MessageEnv = {
  taskKey: string;
  /** The task left the list and stays on screen for what it holds (F-278, F-277). */
  gone: boolean;
  transcript: Transcript;
  botName: string;
  /** The connection may write: reacting and replying are offered. */
  canWrite: boolean;
  /** Connected and caught up: a reply on its way is not waiting for a reconnect. */
  connected: boolean;
  openThread: (messageId: string, from: HTMLElement | null) => void;
  announce: (text: string) => void;
};

const MessageContext = createContext<MessageEnv | null>(null);

export function MessageProvider({ env, children }: { env: MessageEnv; children: ReactNode }) {
  return <MessageContext.Provider value={env}>{children}</MessageContext.Provider>;
}

const useMessages = () => useContext(MessageContext);

/**
 * One message the person can act on: a bubble and the gateway's id of the row it shows. A bot's
 * turn of several rows is several of them, so each action names the bubble it was chosen on.
 */
export type MessageRef = { messageId: string; role: "user" | "assistant"; text: string };

/**
 * A bubble with what can be done with it: its reactions under it, its replies link, and react,
 * reply and more beside it. Without the gateway's id of its row it is the bubble alone.
 */
export function MessageUnit({
  message,
  children,
}: {
  message: MessageRef | null;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  if (!message) return <>{children}</>;
  return (
    <div className="msg-unit" data-message={message.messageId} data-testid="message" ref={ref}>
      {children}
      <Reactions message={message} />
      <RepliesLink message={message} />
      <MessageActions message={message} unitRef={ref} />
    </div>
  );
}

/** The text a message shows, for Copy text. */
export function itemText(item: TranscriptItem): string {
  return item.blocks
    .map((block) => (block.kind === "text" ? block.text : ""))
    .filter((text) => text.trim())
    .join("\n\n");
}

/**
 * The message a transcript shows under an id: the user's item, or the bot's bubble whose row it
 * is. Null when the loaded history does not show it.
 */
export function messageOf(transcript: Transcript, messageId: string): MessageRef | null {
  for (const item of transcript.items) {
    if (item.role === "user" && item.messageId === messageId)
      return { messageId, role: "user", text: itemText(item) };
    if (item.role !== "assistant") continue;
    for (const block of item.blocks)
      if (block.kind === "text" && block.messageId === messageId)
        return { messageId, role: "assistant", text: block.text };
  }
  return null;
}

/**
 * React, reply and more, shown beside a message while it is hovered, while focus is in
 * them, or after a touch and hold. One tab stop: Left and Right move between them.
 */
export function MessageActions({
  message,
  unitRef,
}: {
  message: MessageRef;
  unitRef: RefObject<HTMLDivElement | null>;
}) {
  const turnRef = unitRef;
  const role = message.role;
  const env = useMessages();
  const bridge = useBridge();
  const [menu, setMenu] = useState<null | "react" | "more">(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const [held, setHeld] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const reactRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [current, setCurrent] = useState(0);
  /** The button whose menu is open, for focus to go back to. */
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);

  // Beside the message's bubble: to its right for the bot's, to its left for yours.
  const measure = useCallback(() => {
    const turn = turnRef.current;
    const toolbar = bar.current;
    if (!turn || !toolbar) return;
    const bubbles = turn.querySelectorAll<HTMLElement>(".msg > .bubble");
    const bubble = bubbles[bubbles.length - 1];
    if (!bubble) return;
    const turnBox = turn.getBoundingClientRect();
    const box = bubble.getBoundingClientRect();
    const width = toolbar.offsetWidth;
    const left =
      role === "user" ? box.left - turnBox.left - width - 6 : box.right - turnBox.left + 6;
    // Within the column: where there is no room beside it, it sits above the bubble's outer corner.
    const max = turnBox.width - width;
    const room = left >= 0 && left <= max;
    const top = box.top - turnBox.top;
    if (room) setPlace({ top, left });
    else
      setPlace({
        top: top - toolbar.offsetHeight - 4,
        left:
          role === "user"
            ? box.left - turnBox.left
            : Math.min(max, box.right - turnBox.left - width),
      });
  }, [turnRef, role]);

  // After the commit: the turn's own ref is set only once its children's layout effects ran.
  useEffect(() => {
    const turn = turnRef.current;
    if (!turn) return;
    const onEnter = () => measure();
    turn.addEventListener("pointerenter", onEnter);
    // Touch and hold on the message shows its actions; a tap elsewhere hides them.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      // A second finger makes it no touch and hold: the first one's wait ends too.
      if (timer) return cancel();
      if ((event.target as Element).closest(".msg-actions, button, a, summary")) return;
      timer = setTimeout(() => {
        measure();
        setHeld(true);
      }, LONG_PRESS_MS);
    };
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    turn.addEventListener("pointerdown", onDown);
    turn.addEventListener("pointerup", cancel);
    turn.addEventListener("pointercancel", cancel);
    turn.addEventListener("pointermove", cancel);
    return () => {
      cancel();
      turn.removeEventListener("pointerenter", onEnter);
      turn.removeEventListener("pointerdown", onDown);
      turn.removeEventListener("pointerup", cancel);
      turn.removeEventListener("pointercancel", cancel);
      turn.removeEventListener("pointermove", cancel);
    };
  }, [turnRef, measure]);

  useEffect(() => {
    if (!held) return;
    const onDown = (event: PointerEvent) => {
      if (!turnRef.current?.contains(event.target as Node)) setHeld(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [held, turnRef]);

  if (!env) return null;
  const messageId = message.messageId;
  const order = env.canWrite ? ["react", "reply", "more"] : ["more"];
  // The tab stop stays on a button that is there when write access comes or goes.
  const at = Math.min(current, order.length - 1);
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = (at + (event.key === "ArrowRight" ? 1 : -1) + order.length) % order.length;
    setCurrent(next);
    event.currentTarget.querySelectorAll<HTMLButtonElement>(":scope > button")[next]?.focus();
  };
  const tab = (name: string) => (order.indexOf(name) === at ? 0 : -1);

  const reactEntries: MenuEntry[] = REACTIONS.map(({ emoji, name }) => ({
    kind: "item",
    label: `${emoji} ${name}`,
    onSelect: () => {
      setMenu(null);
      reactRef.current?.focus();
      const mine = env.transcript.reactions?.[messageId]?.some(
        (each) => each.emoji === emoji && each.mine,
      );
      void bridge
        .invoke({ type: "setReaction", key: env.taskKey, messageId, emoji, remove: mine === true })
        .then(
          () => env.announce(mine ? `Removed ${emoji}` : `Reacted ${emoji}`),
          (error: unknown) =>
            env.announce(`Couldn't react: ${error instanceof Error ? error.message : error}`),
        );
    },
  }));
  const copy = async (text: string, what: string) => {
    env.announce((await copyText(text)) === "copied" ? `Copied ${what}` : "Couldn't copy.");
  };
  const moreEntries: MenuEntry[] = [
    {
      kind: "item",
      label: "Copy text",
      onSelect: () => {
        setMenu(null);
        moreRef.current?.focus();
        void copy(message.text, "text");
      },
    },
    {
      kind: "item",
      label: "Copy message ID",
      onSelect: () => {
        setMenu(null);
        moreRef.current?.focus();
        void copy(messageId, "message ID");
      },
    },
  ];

  return (
    <div
      ref={bar}
      className="msg-actions"
      role="toolbar"
      aria-label="Message actions"
      data-side={role === "user" ? "user" : "bot"}
      data-open={held || menu !== null ? "true" : undefined}
      data-testid="message-actions"
      style={place ? { top: place.top, left: place.left } : undefined}
      onFocus={measure}
      onKeyDown={onKey}
    >
      {env.canWrite && (
        <button
          ref={reactRef}
          type="button"
          className="icon-button"
          aria-label="Add a reaction"
          title="Add a reaction"
          aria-haspopup="menu"
          aria-expanded={menu === "react"}
          tabIndex={tab("react")}
          onClick={(event) => {
            setTrigger(event.currentTarget);
            setMenu(menu === "react" ? null : "react");
          }}
        >
          <SmileIcon />
        </button>
      )}
      {env.canWrite && (
        <button
          type="button"
          className="icon-button"
          aria-label="Reply in a thread"
          title="Reply in a thread"
          tabIndex={tab("reply")}
          onClick={(event) => env.openThread(messageId, event.currentTarget)}
        >
          <ReplyIcon />
        </button>
      )}
      <button
        ref={moreRef}
        type="button"
        className="icon-button"
        aria-label="More"
        title="More"
        aria-haspopup="menu"
        aria-expanded={menu === "more"}
        tabIndex={tab("more")}
        onClick={(event) => {
          setTrigger(event.currentTarget);
          setMenu(menu === "more" ? null : "more");
        }}
      >
        <MoreIcon />
      </button>
      {menu && (
        <Menu
          label={menu === "react" ? "Add a reaction" : "More"}
          className="msg-actions-menu"
          entries={menu === "react" ? reactEntries : moreEntries}
          trigger={trigger}
          onClose={(refocus) => {
            if (refocus) trigger?.focus();
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}

/** A reaction's name: what it is, how many, and what choosing it does. */
function reactionName(reaction: MessageReaction, canWrite: boolean): string {
  const count = `${reaction.count} ${reaction.count === 1 ? "reaction" : "reactions"}`;
  if (!canWrite) return `${reaction.emoji} ${count}`;
  return reaction.mine
    ? `${reaction.emoji} ${count}, yours among them. Remove yours`
    : `${reaction.emoji} ${count}. Add yours`;
}

/** The reactions on a message, as small emoji badges under it. */
function Reactions({ message }: { message: MessageRef }) {
  const env = useMessages();
  const bridge = useBridge();
  if (!env) return null;
  const messageId = message.messageId;
  const list = env.transcript.reactions?.[messageId] ?? [];
  if (list.length === 0) return null;
  return (
    <div
      className="reactions"
      data-side={message.role === "user" ? "user" : "bot"}
      data-testid="reactions"
      role="group"
      aria-label="Reactions"
    >
      {list.map((reaction) =>
        env.canWrite ? (
          <button
            key={reaction.emoji}
            type="button"
            className="reaction"
            aria-pressed={reaction.mine}
            aria-label={reactionName(reaction, true)}
            title={reactionName(reaction, true)}
            data-testid="reaction"
            onClick={() =>
              void bridge
                .invoke({
                  type: "setReaction",
                  key: env.taskKey,
                  messageId,
                  emoji: reaction.emoji,
                  remove: reaction.mine,
                })
                .then(
                  () =>
                    env.announce(
                      reaction.mine ? `Removed ${reaction.emoji}` : `Reacted ${reaction.emoji}`,
                    ),
                  (error: unknown) =>
                    env.announce(
                      `Couldn't react: ${error instanceof Error ? error.message : error}`,
                    ),
                )
            }
          >
            <span aria-hidden="true">{reaction.emoji}</span>
            <span aria-hidden="true">{reaction.count}</span>
          </button>
        ) : (
          <span
            key={reaction.emoji}
            className="reaction"
            role="img"
            aria-label={reactionName(reaction, false)}
            data-testid="reaction"
          >
            <span aria-hidden="true">{reaction.emoji}</span>
            <span aria-hidden="true">{reaction.count}</span>
          </span>
        ),
      )}
    </div>
  );
}

/** Whether the gateway has an outgoing message: it answered that it took it. */
const accepted = (message: OutgoingMessage) =>
  message.status === "sent" || message.status === "unconfirmed";

/**
 * The replies to a message, in the order they were written: the rows history marks as replies to
 * it, and yours on their way. A bot's turn of several rows joins only by the bubbles whose own row
 * names the message. Only what the gateway has counts as a reply (`count`).
 */
export function repliesTo(transcript: Transcript, messageId: string) {
  const history: Array<{ key: string; role: "user" | "assistant"; text: string }> = [];
  for (const item of transcript.items) {
    if (item.role === "user" && item.replyTo?.id === messageId)
      history.push({ key: item.id, role: "user", text: itemText(item) });
    if (item.role !== "assistant") continue;
    item.blocks.forEach((block, index) => {
      if (block.kind === "text" && block.replyToId === messageId)
        history.push({ key: `${item.id}:${index}`, role: "assistant", text: block.text });
    });
  }
  const pending = transcript.outbox.filter(
    (message) =>
      message.replyToId === messageId &&
      message.status !== "cancelled" &&
      message.status !== "handled",
  );
  return { history, pending, count: history.length + pending.filter(accepted).length };
}

/** "1 reply", "3 replies". */
const repliesWord = (count: number) => (count === 1 ? "1 reply" : `${count} replies`);

/**
 * The message a reply names, as a reply's reference gives it when the loaded history does not
 * show it: the gateway's preview of its text and its sender.
 */
function referenced(transcript: Transcript, messageId: string) {
  for (const item of transcript.items)
    if (item.replyTo?.id === messageId && item.replyTo.text !== null) return item.replyTo;
  return null;
}

/** Above a reply: what it answers. It opens the thread on that message. */
export function ReplyQuote({ item }: { item: TranscriptItem }) {
  const env = useMessages();
  if (!env || !item.replyTo) return null;
  const { id, text, sender } = item.replyTo;
  // Open when the message is shown, or when the gateway gave its text with the reference.
  const open = messageOf(env.transcript, id) !== null || text !== null;
  const words = `${sender ?? "A message"}: ${text ?? "a message no longer shown"}`;
  return (
    <button
      type="button"
      className="reply-quote"
      data-side={item.role === "user" ? "user" : "bot"}
      data-testid="reply-quote"
      disabled={!open}
      aria-label={`Replying to ${words}. ${open ? "Open the thread" : "Not in the loaded history"}`}
      onClick={(event) => env.openThread(id, event.currentTarget)}
    >
      <ReplyIcon />
      <span>{words}</span>
    </button>
  );
}

/** Under a message that has replies: how many, opening its thread. */
function RepliesLink({ message }: { message: MessageRef }) {
  const env = useMessages();
  if (!env) return null;
  const { count } = repliesTo(env.transcript, message.messageId);
  if (count === 0) return null;
  const messageId = message.messageId;
  return (
    <button
      type="button"
      className="replies-link"
      data-side={message.role === "user" ? "user" : "bot"}
      data-testid="replies-link"
      onClick={(event) => env.openThread(messageId, event.currentTarget)}
    >
      {repliesWord(count)}
    </button>
  );
}

type ReplyReceipt = Pick<OutgoingMessage, "id" | "mode" | "runId">;

/** Keep all live receipts and the newest sends missing from the outbox, up to its own limit. */
export function reconcileReplyReceipts(
  receipts: Map<string, ReplyReceipt>,
  transcript: Pick<Transcript, "outbox" | "items">,
): string[] {
  const delivered: string[] = [];
  const absent: string[] = [];
  for (const [id, previous] of receipts) {
    const outgoing = transcript.outbox.find((message) => message.id === id);
    const receipt = outgoing ? { id, mode: outgoing.mode, runId: outgoing.runId } : previous;
    // The outbox can drop a reply before history arrives. Only its gateway key proves delivery.
    if (transcript.items.some((item) => namesOutgoing(item.idempotencyKey ?? null, receipt))) {
      receipts.delete(id);
      delivered.push(id);
    } else if (outgoing) {
      receipts.set(id, receipt);
    } else {
      absent.push(id);
    }
  }
  for (const id of absent.slice(0, Math.max(0, absent.length - MAX_OUTBOX))) receipts.delete(id);
  return delivered;
}

/**
 * A message and its replies, with a field to reply from. The gateway keeps no thread, so it is
 * assembled here from its own reply references and nothing else: the message, then each row
 * history marks as a reply to it (yours, or a bot's bubble the gateway delivered as one). A reply on
 * its way shows as the main composer shows it: held, queued, not sent, failed or sent, with the
 * same recovery.
 */
/** A reply's words, where they go, and why the last send of them was refused. */
type ThreadDraft = Draft & { error: string | null };

export function ThreadView({ messageId, onClose }: { messageId: string; onClose: () => void }) {
  const env = useMessages();
  const bridge = useBridge();
  // Each thread keeps its own words and error, so a send refused after another thread was opened
  // comes back to the thread it was typed in, not the one on screen. Each keeps the session it was
  // started in too, with the message it replies to: it goes there only (F-278).
  const [drafts, setDrafts] = useState<Record<string, ThreadDraft>>({});
  const {
    text,
    error,
    sessionId: session,
    unbound,
  } = drafts[messageId] ?? { text: "", error: null };
  const shownSession = env?.transcript.sessionId;
  // The session each thread's message was shown in when the thread opened: a reply to it belongs
  // there, whatever the view shows by its first word, and goes nowhere else.
  const [parents, setParents] = useState<Record<string, string | undefined>>({});
  if (!Object.hasOwn(parents, messageId) && shownSession)
    setParents((all) => ({ ...all, [messageId]: shownSession }));
  const parent = parents[messageId];
  const bindTo = parent ?? shownSession;
  // Its words keep the task on screen should it leave the list (`keptOnScreen`).
  useHoldsWords(
    env?.taskKey ?? "",
    env !== null && Object.values(drafts).some((draft) => draft.text.trim()),
  );
  /** One change to a thread's draft: its words, their session and its error together. */
  const change = (id: string, next: (now: ThreadDraft) => ThreadDraft) =>
    setDrafts((all) => ({ ...all, [id]: next(all[id] ?? { text: "", error: null }) }));
  /** The person's words, bound at their first to the session of the message replied to. */
  const setText = (words: string) =>
    change(messageId, (now) =>
      !words.trim()
        ? { text: words, error: now.error }
        : {
            ...now,
            text: words,
            ...(now.sessionId === undefined && !now.unbound && bindTo ? { sessionId: bindTo } : {}),
          },
    );
  // Words typed before the view showed a session keep the session of the message they reply to.
  const adopt = Object.entries(drafts).filter(
    ([, draft]) => draft.text.trim() && draft.sessionId === undefined && !draft.unbound,
  );
  if (shownSession && adopt.length > 0)
    setDrafts((all) => ({
      ...all,
      ...Object.fromEntries(
        adopt.map(([id, draft]) => [id, { ...draft, sessionId: parents[id] ?? shownSession }]),
      ),
    }));
  const field = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const writable = env?.canWrite;
  useEffect(() => {
    // With no field to reply from (a read-only connection), the thread itself takes focus, so
    // Escape reaches it. Write access ending removes the field, and the focus it held with it.
    (field.current ?? panel.current)?.focus();
  }, [messageId, writable]);
  /** The replies sent from here that history does not hold yet, as the outbox last showed each. */
  const sent = useRef(new Map<string, ReplyReceipt>());
  const [added, setAdded] = useState(0);
  const watched = env?.transcript;
  const announce = env?.announce;
  useEffect(() => {
    if (!watched || !announce) return;
    reconcileReplyReceipts(sent.current, watched).forEach(() => announce("Reply sent"));
  }, [watched, announce, added]);
  if (!env) return null;
  const transcript = env.transcript;
  const root = messageOf(transcript, messageId);
  const reference = root ? null : referenced(transcript, messageId);
  const { history, pending, count } = repliesTo(transcript, messageId);
  const run = currentRun(transcript);
  const stopping = run?.state === "stopping";
  const asking = questionPending(transcript, run);
  // Until the view shows the task's session the words stay in the field. Started while it showed
  // another session, they go nowhere until the person picks a new task for them or deletes them.
  // Words that name no session it knows of wait for the person's choice (`DRAFT_UNBOUND`).
  const waits = sendWaits(transcript);
  const binding = unbound ? undefined : (session ?? (text.trim() ? bindTo : undefined));
  // So with a task that left the list: the reply's words stay, and go nowhere.
  const moved = env.gone
    ? Boolean(text.trim())
    : binding !== undefined && shownSession !== undefined && binding !== shownSession;
  const movedNote = env.gone ? DRAFT_GONE : DRAFT_MOVED;
  // "Send to the task shown" only where the message replied to is.
  const choose = Boolean(
    text.trim() &&
    unbound &&
    !waits &&
    shownSession &&
    !env.gone &&
    (parent === undefined || parent === shownSession),
  );
  /**
   * The words, refused by the host, back in the thread they were written in, ahead of anything
   * typed since, with their session and the reason, in one change.
   */
  const restore = (back: Draft, failure: unknown) =>
    change(messageId, (now) => ({
      ...joinDrafts(back, now),
      error: failure instanceof Error ? failure.message : String(failure),
    }));
  /** The words as they are bound now: their session, or none known. */
  const asBound = (body: string): Draft => ({
    text: body,
    ...(binding ? { sessionId: binding } : unbound ? { unbound: true } : {}),
  });
  /** `chosen`: the session the person chose for words that name none. */
  const send = async (chosen?: string) => {
    const body = text.trim();
    const to = chosen ?? binding;
    if (!body || waits || (moved && !chosen) || (unbound && !chosen) || !to) return;
    // A reply goes only to the session of the message it replies to.
    if (env.gone || (parent !== undefined && to !== parent)) return;
    const back = chosen ? { text: body, sessionId: chosen } : asBound(body);
    change(messageId, () => ({ text: "", error: null }));
    try {
      const answer = await bridge.invoke({
        type: "sendMessage",
        key: env.taskKey,
        text: body,
        mode: "auto",
        attachmentIds: [],
        replyToId: messageId,
        sessionId: to,
      });
      sent.current.set(answer.messageId, { id: answer.messageId, mode: "new", runId: null });
      setAdded((count) => count + 1);
    } catch (failure) {
      restore(back, failure);
    }
  };
  /** "Start a new task with this message", on a reply whose session is gone: its words only. */
  const startNew = async () => {
    const body = text.trim();
    const botId = botIdFromSessionKey(env.taskKey);
    if (!body || !botId) return;
    const back = asBound(body);
    change(messageId, () => ({ text: "", error: null }));
    try {
      const { key } = await bridge.invoke({ type: "createTask", botId, text: body, label: null });
      void bridge.send({ type: "closeSession", key });
      env.announce("Started as a new task");
    } catch (failure) {
      restore(back, failure);
    }
  };
  const line = (item: { role: string; text: string; author?: string }, key: string) => (
    <div className="thread-msg" data-role={item.role} key={key} data-testid="thread-message">
      <p className="thread-author">{item.author ?? (item.role === "user" ? "You" : env.botName)}</p>
      <div className="bubble">
        <Markdown text={item.text} />
      </div>
    </div>
  );
  const act = (action: () => unknown) => {
    const result = action();
    if (result instanceof Promise) result.catch(() => {});
    field.current?.focus();
  };
  return (
    <div
      ref={panel}
      className="thread"
      tabIndex={-1}
      role="dialog"
      aria-label="Thread"
      data-testid="thread"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="thread-head">
        <h2>Thread</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close the thread"
          title="Close the thread"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="thread-body" tabIndex={0} role="region" aria-label="Messages in the thread">
        {root ? (
          line(root, "root")
        ) : reference ? (
          line(
            { role: "reference", text: reference.text!, author: reference.sender ?? "A message" },
            "root",
          )
        ) : (
          <p className="raw-state">This message is no longer in the loaded history.</p>
        )}
        <p className="thread-count" data-testid="thread-count">
          {count === 0 ? "No replies yet" : repliesWord(count)}
        </p>
        {history.map((reply) => line(reply, reply.key))}
        {pending.map((message) =>
          shelfMessages({ ...transcript, outbox: [message] }).length > 0 ? (
            <ShelfRow
              key={message.id}
              message={message}
              taskKey={env.taskKey}
              stopping={stopping}
              asking={asking}
              act={act}
              // Words bound to another session than the reply's never join it (F-278).
              canTakeBack={(held) =>
                !text.trim() || (!unbound && binding !== undefined && binding === held.sessionId)
              }
              onTakenBack={(back) =>
                change(messageId, (now) => ({
                  ...joinDrafts(now, takenBack(back)),
                  error: now.error,
                }))
              }
              onNotice={(notice) =>
                change(messageId, (now) => ({
                  ...now,
                  error: `${notice.title} ${notice.reason ?? ""}`.trim(),
                }))
              }
              onAnnounce={env.announce}
            />
          ) : (
            <OutgoingBubble
              key={message.id}
              message={message}
              taskKey={env.taskKey}
              connected={env.connected}
              announce={env.announce}
            />
          ),
        )}
      </div>
      {env.canWrite && (
        <div className="thread-reply">
          {error && (
            <p className="thread-error" role="alert">
              Couldn't send this reply: {error}
            </p>
          )}
          {text.trim() && (waits || moved || unbound) && (
            <div
              className="composer-note"
              role="status"
              data-testid="thread-waits"
              data-tone={moved || choose ? "danger" : undefined}
            >
              <span>{moved ? movedNote : choose ? DRAFT_UNBOUND : waits}</span>
              {(moved || choose) && (
                <button type="button" className="link-button" onClick={() => void startNew()}>
                  Start a new task with this message
                </button>
              )}
              {moved && (
                <button type="button" className="link-button" onClick={() => setText("")}>
                  Delete
                </button>
              )}
              {choose && (
                // Only by the person's choice, and named as such: the session the view shows.
                <button
                  type="button"
                  className="link-button"
                  onClick={() => void send(shownSession)}
                >
                  Send to the task shown
                </button>
              )}
            </div>
          )}
          <div className="thread-field">
            <textarea
              ref={field}
              rows={1}
              value={text}
              placeholder="Reply…"
              aria-label="Reply in this thread"
              data-testid="thread-input"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing)
                  return;
                event.preventDefault();
                void send();
              }}
            />
            <button
              type="button"
              className="icon-button send-button"
              aria-label="Send reply"
              aria-description={waits ?? (moved ? movedNote : unbound ? DRAFT_UNBOUND : undefined)}
              title={waits ?? (moved ? movedNote : unbound ? DRAFT_UNBOUND : "Send reply")}
              disabled={!text.trim() || waits !== null || moved || unbound === true}
              onClick={() => void send()}
            >
              <ArrowUpIcon />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
