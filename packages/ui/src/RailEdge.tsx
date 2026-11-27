import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import {
  RAIL_PICTURES,
  RAIL_WIDEST,
  railWidthAfterKey,
  railWidthAt,
  railWidthShown,
  railWidthWords,
} from "./rail-width.ts";

/**
 * The sidebar's edge (#792): a separator a person drags, or moves with the arrow keys, Home and
 * End, between the rail of pictures and the widest width. A double-click, or Enter, goes back to
 * the default. While it is dragged the width is written to the shell's `--rail` at most once a
 * frame, without a render; the shell renders again only where the rail of pictures begins or ends,
 * and when the drag ends.
 */
export function RailEdge({
  width,
  windowWidth,
  shellRef,
  controls,
  onLive,
  onChange,
}: {
  /** The width shown now. */
  width: number;
  windowWidth: number | null;
  shellRef: RefObject<HTMLElement | null>;
  /** The id of the sidebar it sizes. */
  controls: string;
  /** During a drag, when the width crosses into or out of the rail of pictures. */
  onLive: (width: number) => void;
  /** A width to keep, or null for the default. */
  onChange: (width: number | null) => void;
}) {
  const edgeRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; from: number; now: number } | null>(null);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const widest = railWidthShown(RAIL_WIDEST, windowWidth);

  const show = (next: number) => {
    const shell = shellRef.current;
    const edge = edgeRef.current;
    if (!shell || !edge) return;
    shell.style.setProperty("--rail", `${next}px`);
    edge.setAttribute("aria-valuenow", String(next));
    edge.setAttribute("aria-valuetext", railWidthWords(next));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // No text selection starts, and the edge keeps the pointer wherever it goes.
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, x: event.clientX, from: width, now: width };
    shellRef.current?.setAttribute("data-resizing", "true");
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    const next = railWidthShown(railWidthAt(current.from + event.clientX - current.x), windowWidth);
    if (next === current.now) return;
    const crossed = (next === RAIL_PICTURES) !== (current.now === RAIL_PICTURES);
    current.now = next;
    if (crossed) onLive(next);
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (drag.current) show(drag.current.now);
    });
  };

  const end = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = null;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    shellRef.current?.removeAttribute("data-resizing");
    if (current.now !== current.from) onChange(current.now);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onChange(null);
      return;
    }
    const next = railWidthAfterKey(width, event.key, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    const shown = railWidthShown(next, windowWidth);
    if (shown !== width) onChange(shown);
  };

  return (
    <div
      ref={edgeRef}
      className="rail-edge"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Sidebar width"
      aria-controls={controls}
      aria-valuemin={RAIL_PICTURES}
      aria-valuemax={widest}
      aria-valuenow={width}
      aria-valuetext={railWidthWords(width)}
      title="Drag to resize. Double-click for the default width."
      data-testid="rail-edge"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => onChange(null)}
      onKeyDown={onKeyDown}
    />
  );
}
