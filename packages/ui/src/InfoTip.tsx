// A setting's explanation behind a small "i" beside its label (#798). It shows on hover, on
// keyboard focus and on tap, and goes with Escape, a second tap, or focus or the pointer
// leaving. It opens as a card below the setting's whole row (the nearest `.info-row`), so it
// never covers the control it explains and is as wide as the row, at phone width too. The text is
// always in the page, hidden while closed, so the control keeps `aria-describedby` to it and a
// screen reader reads it whether or not the "i" was opened.

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { InfoIcon } from "./icons.tsx";

/** How long the card waits after the pointer leaves, so it can be reached from the "i". */
const LEAVE_MS = 150;

export function InfoTip({
  id,
  about,
  children,
}: {
  /** The text's id: the control's `aria-describedby` names it. */
  id: string;
  /** The setting's name, for the button: "About <name>". */
  about: string;
  children: ReactNode;
}) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // Closed by Escape or a second press: stays closed until focus or the pointer leaves.
  const [dismissed, setDismissed] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = !dismissed && (pinned || hovered || focused);

  // A tap anywhere else puts an open card away, even while the "i" keeps focus (a tap on
  // something that takes no focus leaves it there).
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node)) return;
      // A press elsewhere also ends any hover: a pointer that rested on the "i" has moved on.
      if (leave.current) clearTimeout(leave.current);
      setHovered(false);
      setPinned(false);
      setDismissed(true);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  useEffect(
    () => () => {
      if (leave.current) clearTimeout(leave.current);
    },
    [],
  );

  const enter = (event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse") return;
    if (leave.current) clearTimeout(leave.current);
    setHovered(true);
    setDismissed(false);
  };
  const exit = (event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse") return;
    if (leave.current) clearTimeout(leave.current);
    leave.current = setTimeout(() => {
      setHovered(false);
      setDismissed(false);
    }, LEAVE_MS);
  };

  return (
    <span className="info-tip" ref={root} onPointerEnter={enter} onPointerLeave={exit}>
      <button
        type="button"
        className="info-tip-button"
        aria-label={`About ${about}`}
        aria-expanded={open}
        aria-controls={id}
        aria-describedby={id}
        data-testid={`${id}-i`}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          if (root.current?.contains(event.relatedTarget as Node)) return;
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
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !open) return;
          // Only the card goes: the dialog or form around it stays (Dialog.tsx).
          event.preventDefault();
          event.stopPropagation();
          setPinned(false);
          setDismissed(true);
        }}
      >
        <InfoIcon />
      </button>
      <span className="info-tip-card" id={id} role="note" hidden={!open}>
        {children}
      </span>
    </span>
  );
}
