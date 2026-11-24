// What a person can do with a message in the transcript (parity F-066, F-067,
// F-283): hovering, focusing or touching and holding a message shows react,
// reply and more beside it; reactions show as small emoji badges under it; a
// reply carries a line naming what it answers, and the thread view assembles
// a message and the replies to it from the gateway's own reply references,
// since the gateway keeps a reply only as a reference with no thread of its own.

import {
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
import { ArrowUpIcon, CloseIcon, MoreIcon, ReplyIcon, SmileIcon } from "./icons.tsx";
import { ShelfRow } from "./Composer.tsx";
import { currentRun, questionPending, shelfMessages } from "./live.ts";
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
/** How far a held finger may drift and still be a touch and hold, about what iOS and Android allow. */
const LONG_PRESS_SLOP = 10;

type MessageEnv = {
  taskKey: string;
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

/** Where a control takes a touch: its box, grown to the touch area centred on it where larger. */
function touchArea(control: Element) {
  const box = control.getBoundingClientRect();
  // A control with no touch area of its own has an "auto" one, and reaches no further than drawn.
  const area = getComputedStyle(control, "::after");
  const x = Math.max(0, Number.parseFloat(area.width) - box.width) / 2 || 0;
  const y = Math.max(0, Number.parseFloat(area.height) - box.height) / 2 || 0;
  return { top: box.top - y, right: box.right + x, bottom: box.bottom + y, left: box.left - x };
}

/** How far a bar's buttons reach past its edge where their touch areas are larger than drawn. */
function reachPast(toolbar: HTMLElement): number {
  const bar = toolbar.getBoundingClientRect();
  let reach = 0;
  for (const button of toolbar.querySelectorAll(":scope > button")) {
    const area = touchArea(button);
    reach = Math.max(
      reach,
      bar.left - area.left,
      area.right - bar.right,
      bar.top - area.top,
      area.bottom - bar.bottom,
    );
  }
  return reach;
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
  const closeActionsMenu = useCallback(
    (refocus: boolean) => {
      if (refocus) trigger?.focus();
      setMenu(null);
    },
    [trigger],
  );

  // Beside the message's bubble: to its right for the bot's, to its left for yours. False, with
  // the bar shut, when a finger's bar has no clear place.
  const measure = useCallback((): boolean => {
    const turn = turnRef.current;
    const toolbar = bar.current;
    if (!turn || !toolbar) return false;
    const bubbles = turn.querySelectorAll<HTMLElement>(".msg > .bubble");
    const bubble = bubbles[bubbles.length - 1];
    if (!bubble) return false;
    const turnBox = turn.getBoundingClientRect();
    const box = bubble.getBoundingClientRect();
    const width = toolbar.offsetWidth;
    const height = toolbar.offsetHeight;
    // A bar a finger opened counts the touch areas its buttons reach past it, and keeps them 2 px
    // within what shows of the transcript and of the screen, below the band kept clear for the
    // header and the strip, which lie over it. It keeps them 2 px off those of the quotes,
    // reactions and replies links near it, the message's own and its neighbours', off Jump to
    // latest, and off the bubbles after the message. A mouse's or a pen's stays beside the bubble
    // wherever there is room: above or below it, the pointer would leave the message on its way to
    // the bar, and the bar would hide.
    const touch = toolbar.dataset.pointer === "touch";
    const clear = reachPast(toolbar) + 2;
    const scroller = turn.closest<HTMLElement>(".transcript");
    const inner = scroller?.firstElementChild;
    const view = scroller?.getBoundingClientRect();
    const thread = touch ? scroller?.parentElement?.querySelector(":scope > .thread") : null;
    const conversation = scroller?.closest(".conversation");
    const header = conversation?.querySelector(":scope > .conversation-header");
    const strip = conversation?.querySelector(":scope > .status-strip:not([hidden])");
    const stripButton = strip?.querySelector("button");
    // A keyboard can shrink what shows of the screen and leave the page's own size as it was.
    const screen = window.visualViewport;
    const topEdge = Math.max(
      view?.top ?? -Infinity,
      header?.getBoundingClientRect().bottom ?? -Infinity,
      strip?.getBoundingClientRect().bottom ?? -Infinity,
      screen?.offsetTop ?? -Infinity,
      touch && scroller && view
        ? view.top +
            (Number.parseFloat(
              getComputedStyle(scroller).getPropertyValue("--transcript-mask-start"),
            ) || 0)
        : -Infinity,
    );
    const bottomEdge = Math.min(
      view?.bottom ?? Infinity,
      screen ? screen.offsetTop + screen.height : Infinity,
    );
    const leftEdge = Math.max(view?.left ?? -Infinity, screen?.offsetLeft ?? -Infinity);
    const rightEdge = Math.min(
      view?.right ?? Infinity,
      thread?.getBoundingClientRect().left ?? Infinity,
      screen ? screen.offsetLeft + screen.width : Infinity,
    );
    const dismiss = () => {
      setHeld(false);
      setMenu(null);
      delete toolbar.dataset.pointer;
      if (touch && toolbar.contains(document.activeElement))
        scroller?.focus({ preventScroll: true });
      return false;
    };
    if (
      touch &&
      (Math.max(box.top, topEdge) >= Math.min(box.bottom, bottomEdge) ||
        Math.max(box.left, leftEdge) >= Math.min(box.right, rightEdge))
    )
      return dismiss();

    const first =
      Math.max(topEdge, touch && stripButton ? touchArea(stripButton).bottom : -Infinity) +
      clear -
      turnBox.top;
    const last = bottomEdge - clear - height - turnBox.top;
    const minLeft = touch ? Math.max(0, leftEdge + clear - turnBox.left) : 0;
    const maxLeft =
      Math.min(turnBox.right, touch ? rightEdge - clear : Infinity) - turnBox.left - width;
    if (touch && (minLeft > maxLeft || first > last)) return dismiss();

    const quote = turn.previousElementSibling;
    // Only what lies within a bar and its reach of the message and its quote is looked at: the
    // message's row of the transcript, and the rows next to it out to that far. A 44 px touch area
    // reaches at most 22 px past its control.
    const margin = height + 2 * clear + 44;
    const from = Math.min(turnBox.top, quote?.getBoundingClientRect().top ?? Infinity) - margin;
    const to = turnBox.bottom + margin;
    const near = (element: Element) => {
      const each = element.getBoundingClientRect();
      return each.bottom > from && each.top < to;
    };
    const rows: Element[] = [];
    if (touch) {
      let row: Element = turn;
      while (inner?.contains(row) && row.parentElement !== inner) row = row.parentElement!;
      rows.push(row);
      if (row.parentElement === inner) {
        // A row that is not drawn has no place, and is passed over.
        const drawn = (each: Element) => each.getClientRects().length > 0;
        for (let each = row.previousElementSibling; each; each = each.previousElementSibling)
          if (drawn(each)) {
            if (each.getBoundingClientRect().bottom <= from) break;
            rows.push(each);
          }
        for (let each = row.nextElementSibling; each; each = each.nextElementSibling)
          if (drawn(each)) {
            if (each.getBoundingClientRect().top >= to) break;
            rows.push(each);
          }
      }
    }
    const all = (selector: string) =>
      rows.flatMap((row) => [...row.querySelectorAll(selector)]).filter(near);
    const controls = all(".reply-quote, .reaction, .replies-link");
    const jump = touch ? scroller?.parentElement?.querySelector(":scope > .jump-latest") : null;
    if (jump) controls.push(jump);
    const around = (area: { top: number; right: number; bottom: number; left: number }) => ({
      top: area.top - turnBox.top - clear,
      right: area.right - turnBox.left + clear,
      bottom: area.bottom - turnBox.top + clear,
      left: area.left - turnBox.left - clear,
    });
    const taken = [
      ...controls.map((control) => ({
        // The message's own: the quote over it, and its reactions and replies link under it.
        side: control === quote ? "over" : turn.contains(control) ? "under" : null,
        ...around(touchArea(control)),
      })),
      ...all(".msg > .bubble")
        // After the message, and not its own.
        .filter((each) => turn.compareDocumentPosition(each) === Node.DOCUMENT_POSITION_FOLLOWING)
        .map((each) => ({ side: null, ...around(each.getBoundingClientRect()) })),
    ];
    const over = taken.filter((area) => area.side === "over");
    const under = taken.filter((area) => area.side === "under");
    const fits = (top: number, left: number) =>
      !touch ||
      (top >= first &&
        top <= last &&
        taken.every(
          (area) =>
            top + height <= area.top ||
            top >= area.bottom ||
            left + width <= area.left ||
            left >= area.right,
        ));
    const fitted = (top: number, left: number) => (setPlace({ top, left }), true);
    const left =
      role === "user" ? box.left - turnBox.left - width - 6 : box.right - turnBox.left + 6;
    const top = box.top - turnBox.top;
    if (left >= minLeft && left <= maxLeft && fits(top, left)) return fitted(top, left);
    // Within the column: where there is no room beside it, it sits at the bubble's outer corner,
    // above the message, else below it, else inside it at the top of what shows of it, under its
    // quote. A finger's bar with none of these clear is shut: scrolled to the transcript's foot or
    // under the header, a message leaves its bar no room.
    const corner = Math.max(
      minLeft,
      Math.min(
        maxLeft,
        role === "user" ? box.left - turnBox.left : box.right - turnBox.left - width,
      ),
    );
    const above = Math.min(top - 4, ...over.map((area) => area.top)) - height;
    const below = Math.max(box.bottom - turnBox.top + 4, ...under.map((area) => area.bottom));
    const inside = Math.max(first, top, ...over.map((area) => area.bottom));
    for (const each of [above, below, inside]) if (fits(each, corner)) return fitted(each, corner);
    return dismiss();
  }, [turnRef, role]);

  // A bar whose width changes while it shows, as write access comes or goes, or whose column
  // changes width, is placed again. It shows while the stylesheet lets it take the pointer.
  useEffect(() => {
    const turn = turnRef.current;
    const toolbar = bar.current;
    if (!turn || !toolbar) return;
    const observer = new ResizeObserver(() => {
      if (getComputedStyle(toolbar).pointerEvents !== "none") measure();
    });
    observer.observe(toolbar);
    observer.observe(turn);
    return () => observer.disconnect();
  }, [turnRef, measure]);

  // An open bar is placed again as its transcript is resized or scrolled, as when the screen gets
  // shorter, as what shows of the screen changes, as when a keyboard comes up, and as Jump to
  // latest comes, goes or changes over the transcript's foot. A shut one listens for none of it.
  const open = held || menu !== null;
  useEffect(() => {
    if (!open) return;
    const scroller = turnRef.current?.closest<HTMLElement>(".transcript");
    const wrap = scroller?.parentElement;
    const conversation = scroller?.closest(".conversation");
    const screen = window.visualViewport;
    const again = () => measure();
    const resized = new ResizeObserver(again);
    if (scroller) resized.observe(scroller);
    const observeControls = () => {
      for (const element of [
        wrap?.querySelector(":scope > .jump-latest"),
        wrap?.querySelector(":scope > .thread"),
        conversation?.querySelector(":scope > .conversation-header"),
        conversation?.querySelector(":scope > .status-strip"),
      ])
        if (element) resized.observe(element);
    };
    observeControls();
    const changed = new MutationObserver(() => {
      observeControls();
      again();
    });
    if (wrap) changed.observe(wrap, { childList: true });
    if (conversation) changed.observe(conversation, { childList: true });
    scroller?.addEventListener("scroll", again, { passive: true });
    screen?.addEventListener("resize", again);
    screen?.addEventListener("scroll", again);
    return () => {
      resized.disconnect();
      changed.disconnect();
      scroller?.removeEventListener("scroll", again);
      screen?.removeEventListener("resize", again);
      screen?.removeEventListener("scroll", again);
    };
  }, [open, turnRef, measure]);

  // After the commit: the turn's own ref is set only once its children's layout effects ran.
  useEffect(() => {
    const turn = turnRef.current;
    if (!turn) return;
    // A mouse, or a pen above the screen, shows the actions while it is over the message: set here,
    // since a tap leaves :hover behind, and a touch screen in tablet mode can report no hover with
    // a mouse attached.
    const hovering = (event: PointerEvent) =>
      event.pointerType === "mouse" || (event.pointerType === "pen" && event.buttons === 0);
    const onEnter = (event: PointerEvent) => {
      const toolbar = bar.current;
      if (!toolbar || !hovering(event)) return;
      turn.dataset.hover = "true";
      if (toolbar.dataset.pointer === "touch" && toolbar.dataset.open === "true") return;
      toolbar.dataset.pointer = event.pointerType;
      measure();
    };
    // A tap takes the hover away; the mouse moving on over the message brings it back.
    const onHover = (event: PointerEvent) => {
      if (!turn.dataset.hover && hovering(event)) onEnter(event);
    };
    // A finger lifting is no mouse leaving: a mouse still over the message keeps the actions.
    const onLeave = (event: PointerEvent) => {
      if (event.pointerType !== "touch") delete turn.dataset.hover;
    };
    turn.addEventListener("pointerenter", onEnter);
    turn.addEventListener("pointermove", onHover);
    turn.addEventListener("pointerleave", onLeave);
    // Touch and hold on the message shows its actions; a tap elsewhere hides them. The finger that
    // starts it owns the gesture until it lifts or the browser takes it, which is how WebKit on iOS
    // hands a touch to a long press of its own: it cancels the pointer, with no contextmenu.
    let owner: number | null = null;
    let gesture: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let start = { x: 0, y: 0, top: 0 };
    let guardedTouch: number | null = null;
    let guard: AbortController | null = null;
    let guardTimer: ReturnType<typeof setTimeout> | null = null;
    const clearGuard = () => {
      if (guardTimer !== null) clearTimeout(guardTimer);
      guardTimer = null;
      guard?.abort();
      guard = null;
      guardedTouch = null;
    };
    const swallow = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || event.pointerId !== guardedTouch) return;
      event.preventDefault();
      event.stopPropagation();
      clearGuard();
    };
    const onNextDown = (event: PointerEvent) => {
      if (event.pointerType === "touch" && event.pointerId === guardedTouch) clearGuard();
    };
    // Ends the wait, not the gesture: the text stays unselectable until the finger lifts.
    const stop = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const open = () => {
      stop();
      // The transcript can scroll before its scroll event comes: a message that moved opens nothing.
      const toolbar = bar.current;
      if (!toolbar || owner === null || turn.getBoundingClientRect().top !== start.top) return;
      toolbar.dataset.pointer = "touch";
      if (!measure()) return;
      setHeld(true);
      clearGuard();
      guardedTouch = owner;
      guard = new AbortController();
      const options = { capture: true, signal: guard.signal };
      window.addEventListener("click", swallow, options);
      window.addEventListener("pointerdown", onNextDown, options);
    };
    const end = () => {
      stop();
      gesture?.abort();
      gesture = null;
      owner = null;
      delete turn.dataset.touching;
    };
    // A second finger anywhere ends the wait.
    const onOther = (event: PointerEvent) => {
      if (event.pointerType === "touch" && event.pointerId !== owner) stop();
    };
    // A held finger always drifts a little; only a move past the slop ends the wait.
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== owner) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP) stop();
    };
    const onEnd = (event: PointerEvent) => {
      if (event.pointerId !== owner) return;
      end();
      if (event.pointerId !== guardedTouch) return;
      if (event.type === "pointercancel") clearGuard();
      else guardTimer = setTimeout(clearGuard, 500);
    };
    // The message moving under the finger, as when the transcript scrolls, ends the wait.
    const onScroll = () => {
      if (turn.getBoundingClientRect().top !== start.top) stop();
    };
    // Chromium's own long press, its contextmenu, can come while this one waits: it opens the
    // actions at once, and Chromium's menu, which would cover them, stays shut. A right-click
    // meanwhile is the mouse's own, and leaves both alone.
    const onMenu = (event: MouseEvent) => {
      if ((event as PointerEvent).pointerType !== "touch") return;
      if (!turn.contains(event.target as Node)) return;
      event.preventDefault();
      if (timer) open();
    };
    const onDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      delete turn.dataset.hover;
      // A second finger is no touch and hold, nor the start of one.
      if (owner !== null || !event.isPrimary) return;
      if ((event.target as Element).closest(".msg-actions, button, a, summary")) return;
      owner = event.pointerId;
      start = { x: event.clientX, y: event.clientY, top: turn.getBoundingClientRect().top };
      // Until the finger lifts, so the system's own long press, which can come later than this
      // one, neither selects the text nor shows its callout. More has Copy text.
      turn.dataset.touching = "true";
      timer = setTimeout(open, LONG_PRESS_MS);
      // On the document: the finger's later events can land outside the message, as when the
      // text it went down on is replaced and the browser lets go of it.
      gesture = new AbortController();
      const options = { capture: true, signal: gesture.signal };
      document.addEventListener("pointerdown", onOther, options);
      document.addEventListener("pointermove", onMove, options);
      document.addEventListener("pointerup", onEnd, options);
      document.addEventListener("pointercancel", onEnd, options);
      document.addEventListener("lostpointercapture", onEnd, options);
      document.addEventListener("scroll", onScroll, options);
      document.addEventListener("contextmenu", onMenu, options);
    };
    turn.addEventListener("pointerdown", onDown);
    return () => {
      end();
      clearGuard();
      turn.removeEventListener("pointerenter", onEnter);
      turn.removeEventListener("pointermove", onHover);
      turn.removeEventListener("pointerleave", onLeave);
      turn.removeEventListener("pointerdown", onDown);
    };
  }, [turnRef, measure]);

  useEffect(() => {
    if (!held) {
      if (!menu && bar.current?.dataset.pointer === "touch") delete bar.current.dataset.pointer;
      return;
    }
    const onDown = (event: PointerEvent) => {
      if (!turnRef.current?.contains(event.target as Node)) setHeld(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [held, menu, turnRef]);

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
      onFocus={(event) => {
        if (
          event.currentTarget.dataset.pointer === "touch" &&
          event.target.matches(":focus-visible")
        ) {
          delete event.currentTarget.dataset.pointer;
          setHeld(false);
        }
        measure();
      }}
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
          onClose={closeActionsMenu}
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
export function ThreadView({ messageId, onClose }: { messageId: string; onClose: () => void }) {
  const env = useMessages();
  const bridge = useBridge();
  // Each thread keeps its own words and error, so a send refused after another thread was opened
  // comes back to the thread it was typed in, not the one on screen.
  const [drafts, setDrafts] = useState<Record<string, { text: string; error: string | null }>>({});
  const { text, error } = drafts[messageId] ?? { text: "", error: null };
  const setText = (next: string | ((current: string) => string), id = messageId) =>
    setDrafts((all) => {
      const now = all[id] ?? { text: "", error: null };
      return { ...all, [id]: { ...now, text: typeof next === "string" ? next : next(now.text) } };
    });
  const setError = (next: string | null, id = messageId) =>
    setDrafts((all) => ({ ...all, [id]: { text: all[id]?.text ?? "", error: next } }));
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
  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    setError(null);
    try {
      const answer = await bridge.invoke({
        type: "sendMessage",
        key: env.taskKey,
        text: body,
        mode: "auto",
        attachmentIds: [],
        replyToId: messageId,
      });
      sent.current.set(answer.messageId, { id: answer.messageId, mode: "new", runId: null });
      setAdded((count) => count + 1);
    } catch (failure) {
      // The refused words come back, ahead of anything typed since.
      setText((current) => (current.trim() ? `${body}\n${current}` : body));
      setError(failure instanceof Error ? failure.message : String(failure));
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
              onTakenBack={(back) =>
                setText((current) => (current.trim() ? `${current}\n${back.text}` : back.text))
              }
              onNotice={(notice) => setError(`${notice.title} ${notice.reason ?? ""}`.trim())}
            />
          ) : (
            <OutgoingBubble
              key={message.id}
              message={message}
              taskKey={env.taskKey}
              connected={env.connected}
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
              title="Send reply"
              disabled={!text.trim()}
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
