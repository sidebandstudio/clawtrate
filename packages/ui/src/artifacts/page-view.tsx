// A bot's Page, full window (docs/design/library.md, sections 6 and 7). Every
// way to a Page, a card in the conversation or a row of "Sent in chat", opens
// this one view and passes its one gate. A Page is drawn on a platform only
// once that platform's rendering path passes the zero-request check; no
// platform does yet, so the view shows that it can't show pages here, and
// nothing of the Page is read, parsed or framed. Export reads it over the
// gateway's socket only when the person chooses it, for this occurrence alone.
// The hosted canvas address and the sandbox addresses are never read.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useBridge } from "../bridge.tsx";
import { CloseIcon, DownloadIcon } from "../icons.tsx";
import { formatSize } from "../work/files-format.ts";
import { clockTime } from "../format.ts";
import { collect } from "./context.tsx";
import { inertPage, MAX_PAGE_BYTES, pageFileName } from "./page.ts";

/** Where a Page is drawn: nowhere yet, until each platform's zero-request check passes. */
export const PAGES_DRAWN = { desktop: false, web: false } as const;

/** One occurrence of a Page in a task's transcript, as an opener passes it. */
export type PageOccurrence = {
  /** The task, its current session as the opener saw it, and the item that holds the occurrence. */
  taskKey: string;
  sessionId: string | null;
  itemId: string;
  docId: string;
  title: string;
  bot: string;
  task: string;
  sentAt: number | null;
};

/** Focus stays inside the topmost dialog. */
function trapTab(event: KeyboardEvent<HTMLElement>, root: HTMLElement | null) {
  if (event.key !== "Tab" || !root) return;
  const items = [...root.querySelectorAll<HTMLElement>("button, input, [tabindex]")].filter(
    (element) => element.tabIndex >= 0 && !element.hasAttribute("disabled"),
  );
  const first = items[0];
  const last = items.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

type Read =
  | { status: "reading" }
  | { status: "failed"; message: string }
  | { status: "too-large" }
  | { status: "read"; original: Uint8Array; inert: Uint8Array };

function ExportDialog({
  occurrence,
  onClose,
  announce,
}: {
  occurrence: PageOccurrence;
  onClose: () => void;
  announce: (text: string) => void;
}) {
  const bridge = useBridge();
  const root = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<{ at: number; value: Read } | null>(null);
  const [choice, setChoice] = useState<"inert" | "original">("inert");
  const [error, setError] = useState<string | null>(null);
  const name = pageFileName(occurrence.title);

  useEffect(() => {
    root.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  // One read for this dialog and this occurrence; a reply after it closed is dropped.
  useEffect(() => {
    let live = true;
    const at = attempt;
    const settle = (value: Read) => live && setRead({ at, value });
    bridge
      .invoke({
        type: "readPage",
        key: occurrence.taskKey,
        sessionId: occurrence.sessionId,
        itemId: occurrence.itemId,
        docId: occurrence.docId,
      })
      .then(async (answer) => {
        if (answer.status === "too-large") return settle({ status: "too-large" });
        if (answer.status !== "content")
          return settle({ status: "failed", message: answer.message });
        const original = await collect(bridge, answer.transfer, answer.bytes);
        if (original.length > MAX_PAGE_BYTES) return settle({ status: "too-large" });
        const inert = new TextEncoder().encode(inertPage(new TextDecoder().decode(original)).html);
        settle({ status: "read", original, inert });
      })
      .catch((reason: unknown) =>
        settle({
          status: "failed",
          message: reason instanceof Error ? reason.message : String(reason),
        }),
      );
    return () => {
      live = false;
    };
  }, [bridge, occurrence, attempt]);

  const value: Read = read?.at === attempt ? read.value : { status: "reading" };
  const same =
    value.status === "read" &&
    value.original.length === value.inert.length &&
    value.original.every((byte, i) => byte === value.inert[i]);

  const save = async () => {
    if (value.status !== "read") return;
    const bytes = same || choice === "inert" ? value.inert : value.original;
    const data = new ArrayBuffer(bytes.length);
    new Uint8Array(data).set(bytes);
    if (bridge.save) {
      try {
        const result = await bridge.save({ name, data });
        if (result.status === "cancelled") return;
        if (result.status === "saved") {
          announce(`Exported ${result.name}`);
          onClose();
          return;
        }
        setError(
          `Couldn't save ${name}. ${result.message}${
            result.target === "saved-anyway" ? " The chosen file holds these bytes." : ""
          }`,
        );
      } catch (reason) {
        setError(
          `Couldn't save ${name}. ${reason instanceof Error ? reason.message : String(reason)}`,
        );
      }
      return;
    }
    // The browser chooses where to save it, and whether: Clawtrate knows only that it started.
    const url = URL.createObjectURL(new Blob([data], { type: "text/html" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    announce(`Sent a download request for ${name}.`);
    onClose();
  };

  return (
    <div
      className="page-export"
      role="dialog"
      aria-modal="true"
      aria-label={`Export ${occurrence.title}`}
      ref={root}
      data-testid="page-export"
      // Escape is the Page view's, at the document, so it reaches Export wherever focus is.
      onKeyDown={(event) => trapTab(event, root.current)}
    >
      <h2>Export {occurrence.title}</h2>
      {value.status === "reading" && (
        <p aria-busy="true" data-testid="page-export-reading">
          Reading {occurrence.title} from the gateway…
        </p>
      )}
      {value.status === "failed" && (
        <p role="alert" data-testid="page-export-failed">
          Couldn't read this page. {value.message}{" "}
          <button type="button" className="button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </p>
      )}
      {value.status === "too-large" && (
        <p role="alert">{occurrence.title} is larger than Clawtrate exports (5 MiB).</p>
      )}
      {value.status === "read" && (
        <fieldset className="page-export-choices">
          <legend className="visually-hidden">Which version</legend>
          <label>
            <input
              type="radio"
              name="page-version"
              checked={same || choice === "inert"}
              onChange={() => setChoice("inert")}
            />
            <span>
              <strong>{same ? "The page's HTML" : "Clawtrate version"}</strong>
              <span>
                {same
                  ? "The gateway's HTML matches the export copy."
                  : "Saves a copy with scripts and link controls removed."}{" "}
                {formatSize(value.inert.length)}.
              </span>
            </span>
          </label>
          {!same && (
            <label>
              <input
                type="radio"
                name="page-version"
                checked={choice === "original"}
                onChange={() => setChoice("original")}
              />
              <span>
                <strong>Original HTML from the gateway</strong>
                <span>
                  Saves the original HTML. When opened, it can run scripts or contact other sites.{" "}
                  {formatSize(value.original.length)}.
                </span>
              </span>
            </label>
          )}
        </fieldset>
      )}
      <p className="page-export-note">
        The file holds the page's HTML only: files kept beside it on the gateway aren't included.
        Saving exports the HTML as a local file.
      </p>
      {error && (
        <p role="alert" className="files-alert">
          {error}
        </p>
      )}
      <div className="page-export-actions">
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button"
          data-variant="default"
          disabled={value.status !== "read"}
          onClick={() => void save()}
        >
          <DownloadIcon />
          Save…
        </button>
      </div>
    </div>
  );
}

/** The Page view: with no platform's gate open, the unavailable state and Export. */
export function PageView({
  occurrence,
  onClose,
  announce,
}: {
  occurrence: PageOccurrence;
  onClose: () => void;
  announce: (text: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [exporting, setExporting] = useState(false);
  const exportRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  const closeExport = useCallback(() => {
    setExporting(false);
    requestAnimationFrame(() => exportRef.current?.focus());
  }, []);
  // Escape closes the topmost dialog wherever focus is, on a dialog's text included: Export
  // while it is open, with focus back on Export…, and otherwise the view.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (exporting) closeExport();
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeExport, exporting, onClose]);
  const line = [
    "Page",
    occurrence.bot,
    occurrence.task,
    occurrence.sentAt !== null ? clockTime(occurrence.sentAt) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return createPortal(
    <div
      className="page-view"
      role="dialog"
      aria-modal="true"
      aria-label={occurrence.title}
      ref={root}
      data-testid="page-view"
      onKeyDown={(event) => {
        if (exporting) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "e") {
          event.preventDefault();
          setExporting(true);
        } else trapTab(event, root.current);
      }}
    >
      <div className="page-bar">
        <button
          type="button"
          className="icon-button"
          ref={closeRef}
          inert={exporting}
          aria-label="Close the page (Esc)"
          title="Close the page (Esc)"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
        <div className="page-title">
          <strong>{occurrence.title}</strong>
          <span>{line}</span>
        </div>
        <button
          type="button"
          className="button"
          ref={exportRef}
          inert={exporting}
          onClick={() => setExporting(true)}
        >
          Export…
        </button>
      </div>
      <div className="page-frame-unavailable" inert={exporting} data-testid="page-unavailable">
        <p>
          <strong>Clawtrate can't show pages here yet.</strong>
        </p>
        <p>You can export this page as a file.</p>
      </div>
      {exporting && (
        <ExportDialog occurrence={occurrence} announce={announce} onClose={closeExport} />
      )}
    </div>,
    document.querySelector(".app") ?? document.body,
  );
}
