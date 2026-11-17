// Find in the open conversation. Cmd/Ctrl+F opens a field in the title pill's
// place; every match is highlighted, the current one more strongly, and Enter
// and Shift+Enter step through them. Matches inside a folded group of steps
// count too, and the group opens when its match becomes the current one.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { ArrowDownIcon, ArrowUpIcon, CloseIcon, SearchIcon } from "./icons.tsx";

const ALL = "clawtrate-find";
const CURRENT = "clawtrate-find-current";

type Highlights = { set(name: string, value: unknown): void; delete(name: string): void };
const highlights = (): Highlights | null =>
  (globalThis.CSS as unknown as { highlights?: Highlights } | undefined)?.highlights ?? null;
const HighlightClass = (
  globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }
).Highlight;

/** Every case-insensitive occurrence of `needle` in the text under `root`. */
export function findRanges(root: Element, needle: string): Range[] {
  const query = needle.toLocaleLowerCase();
  if (!query) return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.toLocaleLowerCase() ?? "";
    for (let at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + query.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + query.length);
      ranges.push(range);
    }
  }
  return ranges;
}

/** Open the folded groups around a node, so a match inside one is drawn. */
function reveal(node: Node): void {
  for (let element = node.parentElement; element; element = element.parentElement) {
    if (element instanceof HTMLDetailsElement && !element.open) element.open = true;
  }
}

export function FindBar({
  scope,
  version,
  onClose,
}: {
  /** The conversation whose transcript is searched. */
  scope: RefObject<HTMLElement | null>;
  /** Changes whenever the transcript does, so matches are found again. */
  version: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Range[]>([]);
  const [current, setCurrent] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  // Find again when the query or the transcript changes.
  useLayoutEffect(() => {
    const root = scope.current?.querySelector(".transcript-inner");
    const found = root ? findRanges(root, query) : [];
    setMatches(found);
    setCurrent((index) => (found.length === 0 ? 0 : Math.min(index, found.length - 1)));
  }, [query, version, scope]);

  // Draw the highlights and bring the current match into view.
  useLayoutEffect(() => {
    const registry = highlights();
    const match = matches[current];
    if (registry && HighlightClass) {
      registry.set(ALL, new HighlightClass(...matches));
      if (match) registry.set(CURRENT, new HighlightClass(match));
      else registry.delete(CURRENT);
    }
    if (!match) return;
    reveal(match.startContainer);
    const scroller = scope.current?.querySelector<HTMLElement>(".transcript");
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    const at = match.getBoundingClientRect();
    // The protected band at the top keeps the header and the strip clear.
    const band = Number.parseFloat(
      getComputedStyle(scroller.firstElementChild ?? scroller).paddingTop,
    );
    if (at.top < box.top + band || at.bottom > box.bottom - 80) {
      scroller.scrollTop += at.top - box.top - band - (box.height - band) / 3;
    }
  }, [matches, current, scope]);

  useEffect(
    () => () => {
      highlights()?.delete(ALL);
      highlights()?.delete(CURRENT);
    },
    [],
  );

  const step = useCallback(
    (by: number) => {
      if (matches.length === 0) return;
      setCurrent((index) => (index + by + matches.length) % matches.length);
    },
    [matches.length],
  );

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  const count = !query
    ? ""
    : matches.length === 0
      ? "No matches"
      : `${current + 1} of ${matches.length}`;

  return (
    <div className="find-bar" role="search" data-testid="find-bar">
      <SearchIcon />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setCurrent(0);
        }}
        onKeyDown={onKey}
        placeholder="Find in conversation"
        aria-label="Find in conversation"
        autoComplete="off"
        spellCheck={false}
      />
      <span className="find-count" role="status" aria-live="polite">
        {count}
      </span>
      <button
        type="button"
        className="icon-button"
        data-variant="quiet"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={matches.length === 0}
        onClick={() => step(-1)}
      >
        <ArrowUpIcon />
      </button>
      <button
        type="button"
        className="icon-button"
        data-variant="quiet"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={matches.length === 0}
        onClick={() => step(1)}
      >
        <ArrowDownIcon />
      </button>
      <button
        type="button"
        className="icon-button"
        data-variant="quiet"
        aria-label="Close find"
        title="Close (Esc)"
        onClick={onClose}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
