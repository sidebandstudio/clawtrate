// A setting's explanation behind a small "i" beside its name (#798). `InfoTip` is the "i";
// `InfoCard` is the explanation, placed in the layout's flow right after the setting's row, so
// an open card pushes what follows down and covers nothing: not its own control, not another, not
// a warning that stays in view. The card shows on hover (of the "i", or of the open card), on
// keyboard focus and on tap; Escape (wherever focus is), a second press, a press elsewhere and
// focus leaving put it away; one card is open at a time. The text is always in the page, hidden while closed, so the control keeps
// `aria-describedby` to it and a screen reader reads it whether or not the "i" was opened.

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { InfoIcon } from "./icons.tsx";

/** How long the card waits after the pointer leaves, so a pointer passing by doesn't flicker it. */
const LEAVE_MS = 150;

// The one card open now, by its id, shared by every "i" on the page.
let openId: string | null = null;
const listeners = new Set<() => void>();
const setOpenId = (next: string | null) => {
  if (openId === next) return;
  openId = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
// Each "i"'s hover handlers, by its card's id: the pointer over an open card holds it the way the
// pointer over its "i" does, so the card can be read with the pointer on it (WCAG 1.4.13).
const hovers = new Map<string, Record<"enter" | "exit", (event: ReactPointerEvent) => void>>();
const useOpenId = () =>
  useSyncExternalStore(
    subscribe,
    () => openId,
    () => null,
  );

/** The "i" beside a setting's name. `id` is its card's (`InfoCard`). */
export function InfoTip({
  id,
  about,
}: {
  /** The card's id: the control's `aria-describedby` names it too. */
  id: string;
  /** The setting's name, for the button: "About <name>". */
  about: string;
}) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // Put away by Escape, a second press or a press elsewhere: stays away until focus leaves the
  // "i" or the pointer comes back to it.
  const [dismissed, setDismissed] = useState(false);
  const root = useRef<HTMLButtonElement>(null);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wanted = !dismissed && (pinned || hovered || focused);
  const current = useOpenId();
  const open = current === id;

  const putAway = () => {
    if (leave.current) clearTimeout(leave.current);
    setHovered(false);
    setPinned(false);
    setDismissed(true);
  };

  // Each "i" takes the one place when it is hovered, focused or pressed (below), so the last one
  // asked for is the one shown; it gives the place up once its card isn't wanted any more.
  useEffect(() => {
    if (!wanted && openId === id) setOpenId(null);
  }, [wanted, id]);
  // While its card is open: Escape, wherever focus is, puts away only the card (not the dialog
  // or form around it); a press anywhere but the "i" puts it away too.
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      putAway();
    };
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) putAway();
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", away);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", away);
    };
  }, [open]);
  useEffect(
    () => () => {
      if (leave.current) clearTimeout(leave.current);
      if (openId === id) setOpenId(null);
    },
    [id],
  );

  const enter = (event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse") return;
    if (leave.current) clearTimeout(leave.current);
    setHovered(true);
    setDismissed(false);
    setOpenId(id);
  };
  const exit = (event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse") return;
    if (leave.current) clearTimeout(leave.current);
    leave.current = setTimeout(() => setHovered(false), LEAVE_MS);
  };
  useEffect(() => {
    hovers.set(id, { enter, exit });
    return () => {
      hovers.delete(id);
    };
  });

  return (
    <button
      ref={root}
      type="button"
      className="info-tip-button"
      aria-label={`About ${about}`}
      aria-expanded={open}
      aria-controls={id}
      aria-describedby={id}
      data-testid={`${id}-i`}
      onPointerEnter={enter}
      onPointerLeave={exit}
      onFocus={() => {
        setFocused(true);
        setOpenId(id);
      }}
      onBlur={() => {
        setFocused(false);
        setPinned(false);
        setDismissed(false);
      }}
      onClick={() => {
        if (open && pinned) {
          setPinned(false);
          setDismissed(true);
        } else {
          setPinned(true);
          setDismissed(false);
          setOpenId(id);
        }
      }}
    >
      <InfoIcon />
    </button>
  );
}

/** A setting's explanation, right after its row: shown while its "i" (`InfoTip`) is open. */
export function InfoCard({ id, children }: { id: string; children: ReactNode }) {
  const open = useOpenId() === id;
  return (
    <p
      className="info-tip-card"
      id={id}
      role="note"
      hidden={!open}
      onPointerEnter={(event) => hovers.get(id)?.enter(event)}
      onPointerLeave={(event) => hovers.get(id)?.exit(event)}
    >
      {children}
    </p>
  );
}
