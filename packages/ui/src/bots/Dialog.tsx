// The dialog of bots.md section 2: New bot, Settings and confirmations. A
// native modal <dialog>: what is behind it is inert and Tab stays inside.
// Escape closes it, unless something inside it (a menu) handled Escape
// first; focus returns to the control that opened it.

import { useEffect, useRef, useState, type RefObject, type ReactNode } from "react";

/**
 * A native modal dialog is open: what is behind it is inert, the window's
 * shortcuts too. Every window-wide key handler checks it.
 */
export function dialogOpen(): boolean {
  return document.querySelector("dialog[open]") !== null;
}

export function Dialog({
  kind,
  fallbackFocus,
  labelledBy,
  describedBy,
  onClose,
  children,
  testId,
  role,
}: {
  fallbackFocus?: RefObject<HTMLElement | null> | undefined;
  kind: "create" | "settings" | "confirm";
  labelledBy: string;
  describedBy?: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
  role?: "alertdialog";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  // The control that opened it, as it was when the dialog first rendered.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    const dialog = ref.current;
    // Its element is read when the dialog closes: the screen it opened over may be gone by then.
    const fallbackRef = fallbackFocus;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    // The first control that asks for focus, or the title.
    const target =
      dialog.querySelector<HTMLElement>("[data-b-focus]:not([disabled])") ??
      dialog.querySelector<HTMLElement>("h2[tabindex], h3[tabindex]");
    target?.focus();
    return () => {
      if (dialog.open) dialog.close();
      requestAnimationFrame(() => {
        // Behind a dialog still open, the browser does not let it take focus: nothing happens.
        // Opened with nothing focused, the fallback takes focus.
        const fallback = fallbackRef?.current;
        if (opener?.isConnected && opener !== document.body && !opener.closest("[inert]"))
          opener.focus();
        else if (fallback?.isConnected) fallback.focus();
      });
    };
  }, [opener, fallbackFocus]);
  return (
    <dialog
      ref={ref}
      className="b-dialog"
      data-kind={kind}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      role={role}
      data-testid={testId}
      onCancel={(event) => {
        // Escape: the dialog closes as the screen decides, not by itself; a dialog inside
        // this one (a confirmation) handles its own.
        event.preventDefault();
        event.stopPropagation();
        if (event.target !== event.currentTarget) return;
        onCloseRef.current();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && event.defaultPrevented) event.stopPropagation();
        if (event.key !== "Tab" || !ref.current) return;
        // Tab stays inside: from the last control to the first, and back.
        const items = [
          ...ref.current.querySelectorAll<HTMLElement>(
            "button, a[href], input, select, textarea, summary, [tabindex]",
          ),
        ].filter(
          (element) =>
            element.tabIndex >= 0 &&
            !(element as HTMLButtonElement).disabled &&
            element.getClientRects().length > 0,
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
      }}
    >
      {children}
    </dialog>
  );
}

/** A confirmation: a small card, focus on Cancel, the action and Cancel. */
export function Confirm({
  title,
  text,
  details,
  action,
  cancel = "Cancel",
  onAction,
  onCancel,
  busy,
  fallbackFocus,
}: {
  title: string;
  text: ReactNode;
  details?: string;
  action: string;
  /** The words on Cancel. */
  cancel?: string;
  onAction: () => void;
  onCancel: () => void;
  busy?: boolean;
  fallbackFocus?: RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog
      fallbackFocus={fallbackFocus}
      kind="confirm"
      labelledBy="b-confirm-title"
      describedBy={details ? "b-confirm-text b-confirm-details" : "b-confirm-text"}
      onClose={onCancel}
      role="alertdialog"
      testId="confirm"
    >
      <div className="b-confirm" data-details={details ? true : undefined}>
        <h2 id="b-confirm-title">{title}</h2>
        <p id="b-confirm-text">{text}</p>
        {details && (
          <p id="b-confirm-details" tabIndex={0}>
            {details}
          </p>
        )}
        <div className="b-actions">
          <button
            type="button"
            className="button"
            data-variant="quiet"
            onClick={onCancel}
            data-b-focus=""
          >
            {cancel}
          </button>
          <button
            type="button"
            className="button"
            data-tone="danger"
            disabled={busy}
            onClick={onAction}
          >
            {busy ? `${action}…` : action}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
