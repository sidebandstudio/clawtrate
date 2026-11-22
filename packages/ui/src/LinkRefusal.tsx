import { useMemo, type RefObject } from "react";
import { Dialog } from "./bots/Dialog.tsx";
import { LINK_REFUSALS, type LinkRefusal as Refusal } from "./chat-link.ts";

/**
 * "Can't open link" (docs/design/links.md section 3): the confirmation card with
 * the reason and one Close button. Enter or Escape closes it. Focus returns to
 * the control that had it, or, when the app has just opened, to the heading or
 * first control of the screen shown when the card closes.
 */
export function LinkRefusal({
  refusal,
  firstControl,
  onClose,
}: {
  refusal: Refusal;
  /** A selector for the screen's first control, for a screen with no heading to focus. */
  firstControl: string;
  onClose: () => void;
}) {
  // Read when the card closes: the screen it opened over may have been replaced since.
  const fallback = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return (
          document.querySelector<HTMLElement>(".conversation h1[tabindex]") ??
          document.querySelector<HTMLElement>(firstControl)
        );
      },
    }),
    [firstControl],
  );
  return (
    <Dialog
      kind="confirm"
      labelledBy="link-refusal-title"
      describedBy="link-refusal-text"
      onClose={onClose}
      role="alertdialog"
      testId="link-refusal"
      fallbackFocus={fallback}
    >
      <div className="b-confirm">
        <h2 id="link-refusal-title">Can't open link</h2>
        <p id="link-refusal-text">{LINK_REFUSALS[refusal]}</p>
        <div className="b-actions">
          <button
            type="button"
            className="button"
            data-variant="primary"
            onClick={onClose}
            data-b-focus=""
          >
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}
