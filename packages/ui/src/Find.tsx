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
import { markTranscriptNavigation } from "./reading-line.ts";

const ALL = "clawtrate-find";
const CURRENT = "clawtrate-find-current";

type Highlights = { set(name: string, value: unknown): void; delete(name: string): void };
const highlights = (): Highlights | null =>
  (globalThis.CSS as unknown as { highlights?: Highlights } | undefined)?.highlights ?? null;
const HighlightClass = (
  globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }
).Highlight;

/** The nearest ancestor of `node` under `root` that is not laid out inline: its block. */
function blockOf(node: Node, root: Element, cache: Map<Element, boolean>): Element {
  for (
    let element = node.parentElement;
    element && element !== root;
    element = element.parentElement
  ) {
    let inline = cache.get(element);
    if (inline === undefined) {
      inline = getComputedStyle(element).display.startsWith("inline");
      cache.set(element, inline);
    }
    if (!inline) return element;
  }
  return root;
}

/**
 * Every case-insensitive occurrence of `needle` in the text under `root`. Text
 * reads as it is rendered: a phrase matches across inline markup (bold, a link,
 * inline code) inside one block, but never runs on from one block into the next
 * or across a line break.
 */
export function findRanges(root: Element, needle: string): Range[] {
  const query = needle.toLocaleLowerCase();
  if (!query) return [];
  const ranges: Range[] = [];
  const cache = new Map<Element, boolean>();
  // A run is the text of consecutive text nodes in one block, with where each node starts.
  let run: { text: string; nodes: { node: Text; start: number }[] } = { text: "", nodes: [] };
  let runBlock: Element | null = null;
  const at = (offset: number, end: boolean): [Text, number] => {
    // The node holding the offset; an end offset belongs to the node it closes.
    let index = run.nodes.length - 1;
    while (
      index > 0 &&
      (end ? run.nodes[index]!.start >= offset : run.nodes[index]!.start > offset)
    )
      index -= 1;
    const { node, start } = run.nodes[index]!;
    return [node, offset - start];
  };
  const search = () => {
    const text = run.text.toLocaleLowerCase();
    for (
      let from = text.indexOf(query);
      from !== -1;
      from = text.indexOf(query, from + query.length)
    ) {
      const range = document.createRange();
      range.setStart(...at(from, false));
      range.setEnd(...at(from + query.length, true));
      ranges.push(range);
    }
    run = { text: "", nodes: [] };
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof HTMLBRElement) {
      search();
      continue;
    }
    if (!(node instanceof Text)) continue;
    const block = blockOf(node, root, cache);
    if (block !== runBlock) {
      search();
      runBlock = block;
    }
    run.nodes.push({ node, start: run.text.length });
    run.text += node.data;
  }
  search();
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
  onClose,
}: {
  /** The conversation whose transcript is searched. */
  scope: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Range[]>([]);
  const [current, setCurrent] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  // Find on every keystroke, and again whenever the transcript's text changes.
  const show = (found: Range[]) => {
    setMatches(found);
    setCurrent((index) => (found.length === 0 ? 0 : Math.min(index, found.length - 1)));
  };
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);
  useEffect(() => {
    const section = scope.current;
    if (!section) return;
    const observer = new MutationObserver(() => {
      const root = section.querySelector(".transcript-inner");
      const found = root ? findRanges(root, queryRef.current) : [];
      setMatches(found);
      setCurrent((index) => (found.length === 0 ? 0 : Math.min(index, found.length - 1)));
    });
    observer.observe(section, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [scope]);

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
      markTranscriptNavigation(scroller);
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
          const root = scope.current?.querySelector(".transcript-inner");
          show(root ? findRanges(root, event.target.value) : []);
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
