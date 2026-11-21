// Parts every card shares: marks, copy buttons, code blocks, label and value
// rows, and Raw (conversation.md section 9), one component for every card.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type SVGProps,
} from "react";
import { copyText, selectContents } from "../clipboard.ts";
import type { Row } from "./model.ts";
import type { RawContent } from "./raw.ts";

export type { RawContent };

// Icons, drawn for Clawtrate on the app's 16px grid ---------------------------------

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, className, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className ? `icon ${className}` : "icon"}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const CodeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5.5 5.25 2.75 8l2.75 2.75M10.5 5.25 13.25 8l-2.75 2.75M9.1 3.75l-2.2 8.5" />
  </Icon>
);
export const WarningIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 2.75 14 13H2L8 2.75ZM8 6.75v3M8 11.5v.05" />
  </Icon>
);
export const ExternalIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6.75 3.25h-3.5v9.5h9.5v-3.5M9.5 3.25h3.25V6.5M12.5 3.5 7.75 8.25" />
  </Icon>
);
export const ChevronIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m6 3.5 4.5 4.5L6 12.5" />
  </Icon>
);
export const CopyIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="5.25" y="5.25" width="8" height="8" rx="2" />
    <path d="M10.75 5.25V4a1.25 1.25 0 0 0-1.25-1.25H4A1.25 1.25 0 0 0 2.75 4v5.5A1.25 1.25 0 0 0 4 10.75h1.25" />
  </Icon>
);
export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m3.5 8.5 3 3 6-7" />
  </Icon>
);
export const CloseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
);
export const ArrowUpIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 13V3M3.75 7.25 8 3l4.25 4.25" />
  </Icon>
);
export const FileIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 2.75H4.75a1 1 0 0 0-1 1v8.5a1 1 0 0 0 1 1h6.5a1 1 0 0 0 1-1V6L9 2.75Z" />
    <path d="M9 2.75V6h3.25" />
  </Icon>
);

/** The mark for T3 Code: code brackets in a rounded tile. Clawtrate's own drawing. */
export function AgentMark() {
  return (
    <span className="agent-mark" aria-hidden="true">
      <CodeIcon />
    </span>
  );
}

/** A 12 px state mark; its shape carries the meaning. */
export function Glyph({ state }: { state: string }) {
  return <span className="glyph" data-state={state} aria-hidden="true" />;
}

// Announcements ---------------------------------------------------------------------

const AnnounceContext = createContext<(text: string) => void>(() => undefined);

/** One polite live region for what a card's action did: "Copied arguments". */
export function Announcer({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const announce = useCallback((text: string) => {
    // A repeated message is spoken again.
    setMessage("");
    requestAnimationFrame(() => setMessage(text));
  }, []);
  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div
        className="visually-hidden"
        role="status"
        aria-live="polite"
        data-testid="card-announcer"
      >
        {message}
      </div>
    </AnnounceContext.Provider>
  );
}

export const useAnnounce = () => useContext(AnnounceContext);

// Copy ------------------------------------------------------------------------------

/**
 * A copy button, named for exactly what it copies. It copies the text in
 * full, never a shortened view of it. On success the icon becomes a check for
 * 1.4 s; on failure a warning, and the text is selected for a manual copy.
 */
export function CopyButton({
  what,
  text,
  selectTarget,
  note,
}: {
  what: string;
  text: string;
  /** What to select when the clipboard refuses. */
  selectTarget?: () => Element | null;
  /** "what was received", when the text is what a cut result kept. */
  note?: string;
}) {
  const announce = useAnnounce();
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), 1400);
    return () => clearTimeout(timer);
  }, [result]);
  const onClick = async () => {
    const outcome = await copyText(text);
    if (outcome === "copied") {
      setResult("copied");
      announce(note ? `Copied ${note}` : `Copied ${what}`);
    } else {
      setResult("failed");
      const target = selectTarget?.() ?? null;
      if (target) selectContents(target);
      announce(target ? "Couldn't copy. The text is selected." : "Couldn't copy.");
    }
  };
  return (
    <button
      type="button"
      className="copy"
      aria-label={`Copy ${what}`}
      title={`Copy ${what}`}
      data-copied={result === "copied" ? "true" : result === "failed" ? "failed" : undefined}
      onClick={() => void onClick()}
    >
      {result === "copied" ? <CheckIcon /> : result === "failed" ? <WarningIcon /> : <CopyIcon />}
    </button>
  );
}

// Code and rows ---------------------------------------------------------------------

const CLIP_LINES = 8;

function countLines(text: string): number {
  return text.replace(/\n$/, "").split("\n").length;
}

/**
 * A labelled block of code. Long text shows eight whole lines, then "Show all
 * N lines"; nothing is drawn half-faded. Copy copies all of it.
 */
export function CodeBlock({
  label,
  text,
  copy,
  tone,
  truncated,
}: {
  label: string;
  text: string;
  /** What the copy button names; the label in lower case by default. */
  copy?: string;
  tone?: "danger";
  /** The gateway cut it: "text" gives the size received, "structured" does not. */
  truncated?: "text" | "structured";
}) {
  const [all, setAll] = useState(false);
  const block = useRef<HTMLPreElement>(null);
  const lines = countLines(text);
  const clipped = !all && lines > CLIP_LINES;
  return (
    <>
      <div className="code-head">
        <p className="code-label">{label}</p>
        <CopyButton
          what={copy ?? label.toLowerCase()}
          text={text}
          selectTarget={() => block.current}
          {...(truncated ? { note: "what was received" } : {})}
        />
      </div>
      <pre
        ref={block}
        className="code-block"
        data-clipped={clipped ? "true" : undefined}
        data-all={all && lines > CLIP_LINES ? "true" : undefined}
        data-tone={tone}
        tabIndex={0}
      >
        {text}
      </pre>
      {truncated && (
        <p className="code-truncated">
          <WarningIcon />
          {truncated === "text"
            ? `Truncated by the gateway. ${text.length.toLocaleString("en-US")} characters were received; the rest was not sent.`
            : "Truncated by the gateway. The rest was not sent."}
        </p>
      )}
      {lines > CLIP_LINES && (
        <p className="code-more">
          <button
            type="button"
            className="link-button"
            aria-expanded={all}
            onClick={() => setAll((open) => !open)}
          >
            {all ? "Show fewer" : `Show all ${lines} lines`}
          </button>
        </p>
      )}
    </>
  );
}

export function Fields({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return null;
  return (
    <dl className="fields">
      {rows.map((row) => (
        <div className="fields-row" key={row.label}>
          <dt>{row.label}</dt>
          <dd>
            <span className={row.mono ? "mono" : undefined}>{row.value}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

// Raw -------------------------------------------------------------------------------

export function formatJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** What the gateway sent, as it sent it. Nothing is invented to fill a part. */
export function RawView({ raw }: { raw: RawContent }) {
  if (raw.state === "loading") {
    return (
      <p className="raw-state" aria-busy="true">
        Loading what the gateway sent…
      </p>
    );
  }
  if (raw.state === "unavailable") return <p className="raw-state">{raw.reason}</p>;
  if (raw.state === "failed") {
    return (
      <p className="raw-state" data-tone="danger">
        Couldn't load what the gateway sent.{" "}
        <button type="button" className="link-button" onClick={raw.retry}>
          Try again
        </button>
      </p>
    );
  }
  // A part that was not received or kept, in its place, under its heading, said in words.
  const missing = (label: string) =>
    (raw.missing ?? [])
      .filter((part) => part.label === label)
      .map((part) => (
        <div key={part.label} data-testid="raw-missing">
          <p className="code-label">{part.label}</p>
          <p className="raw-state">{part.text}</p>
        </div>
      ));
  return (
    <>
      {(raw.notes ?? []).map((note) => (
        <p className="raw-note" key={note}>
          {note}
        </p>
      ))}
      {raw.tool && (
        <dl className="fields">
          <div className="fields-row">
            <dt>Tool</dt>
            <dd>
              <span className="tool-name">{raw.tool}</span>
              <CopyButton what="tool name" text={raw.tool} />
            </dd>
          </div>
        </dl>
      )}
      {missing("Arguments")}
      {raw.args !== undefined && (
        <CodeBlock
          label={raw.argsLabel ?? "Arguments"}
          text={formatJson(raw.args)}
          copy="arguments"
        />
      )}
      {raw.error ? (
        <CodeBlock label={raw.resultLabel ?? "Error"} text={raw.error} copy="error" tone="danger" />
      ) : raw.result !== undefined && raw.result !== null ? (
        <CodeBlock
          label={raw.resultLabel ?? "Result"}
          text={formatJson(raw.result)}
          copy="result"
          {...(raw.truncated ? { truncated: "structured" as const } : {})}
        />
      ) : raw.running ? (
        <p className="exchange-note raw-running">No result yet. This call is still running.</p>
      ) : null}
      {missing("Result")}
      {(raw.events ?? []).map(([label, value]) => (
        <CodeBlock key={label} label={label} text={formatJson(value)} copy={label.toLowerCase()} />
      ))}
      {raw.timing && raw.timing.length > 0 && (
        <>
          <p className="code-label">Timing</p>
          <CopyRows rows={raw.timing} suffix="time" />
        </>
      )}
      {raw.ids.length > 0 && (
        <>
          <p className="code-label">Identifiers</p>
          <CopyRows rows={raw.ids} suffix="id" />
        </>
      )}
    </>
  );
}

function CopyRows({ rows, suffix }: { rows: Row[]; suffix: string }) {
  return (
    <dl className="fields">
      {rows.map((row) => (
        <div className="fields-row" key={row.label}>
          <dt>{row.label}</dt>
          <dd>
            <span className="mono">{row.value}</span>
            {row.value !== "not reported" && (
              <CopyButton what={`${row.label.toLowerCase()} ${suffix}`} text={row.value} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export type RawDisclosure = {
  open: boolean;
  id: string;
  toggle: () => void;
  onPanelKey: (event: KeyboardEvent) => void;
};

/**
 * "Raw" at the end of a card's actions, and the panel it opens as the next
 * thing in the card. Enter or Space opens and closes it with focus kept on
 * the button; Escape inside the panel closes it and returns focus there.
 */
export function useRawDisclosure(load?: () => void, initiallyOpen = false): RawDisclosure {
  const [open, setOpen] = useState(initiallyOpen);
  // Open from the start: what it shows is read, once, as when opened.
  const loadFirst = useRef(initiallyOpen);
  useEffect(() => {
    if (!loadFirst.current) return;
    loadFirst.current = false;
    load?.();
  }, [load]);
  const id = useId();
  const toggle = () => {
    if (!open) load?.();
    setOpen(!open);
  };
  const onPanelKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
      document.querySelector<HTMLButtonElement>(`[aria-controls="${CSS.escape(id)}"]`)?.focus();
    }
  };
  return { open, id, toggle, onPanelKey };
}

/** A card's last row: its actions, then Raw at the right, then the Raw panel. */
export function CardFoot({
  children,
  disclosure,
  raw,
}: {
  children?: ReactNode;
  disclosure: RawDisclosure;
  raw: RawContent;
}) {
  return (
    <>
      <div className="card-actions">
        {children}
        <span className="spacer" />
        <button
          type="button"
          className="link-button"
          data-tone="muted"
          aria-expanded={disclosure.open}
          aria-controls={disclosure.id}
          onClick={disclosure.toggle}
        >
          Raw
        </button>
      </div>
      {disclosure.open && (
        <div
          className="raw-panel"
          id={disclosure.id}
          role="region"
          aria-label="What the gateway sent"
          onKeyDown={disclosure.onPanelKey}
        >
          <RawView raw={raw} />
        </div>
      )}
    </>
  );
}

/** A time for Timing and the cards, "5:25:41 PM", or "not reported". */
export function timeOf(at: number | null): string {
  return at === null
    ? "not reported"
    : new Date(at).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
}

export function tookOf(start: number | null, end: number | null): string {
  if (start === null || end === null || end < start) return "not reported";
  return `${((end - start) / 1000).toFixed(1)} s`;
}
