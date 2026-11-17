import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Layout thresholds, shared with the stylesheet's container queries, so the
 * layout and the behaviour that depends on it switch at the same width.
 */
/** Below this width of `.app`, one pane shows at a time (app.css: `@container app (max-width: 687px)`). */
export const ONE_PANE_BELOW = 688;
/** At this width of `.main-pane` and above, Work docks (app.css: `@container main (min-width: 960px)`). */
export const DOCK_FROM = 960;

/** The content width of an element, kept current with a ResizeObserver. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
