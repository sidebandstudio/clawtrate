// The way from a step to its file and back (work-pane.md, section 10). The
// shell provides it; a step in the conversation asks it for its links with
// `<StepFileLinks callId=… />`, and the Work pane uses `showInChat`.

import { createContext, useContext } from "react";

/** What "Open file" asks the pane to show. */
export type FileRequest = {
  path: string;
  /** The step it came from: a write opens on its change, a read on the source. */
  stepId: string | null;
  view: "changes" | "source" | null;
  /** Grows with every request, so the same file asked twice opens twice. */
  nonce: number;
};

export type WorkLinks = {
  /** The paths the step with this tool call id named, as the engine read them; [] for none. */
  pathsOf(callId: string): { paths: string[]; change: boolean };
  openFile(path: string, from: { stepId: string; change: boolean }): void;
  /** The file "Show in chat" left from, while the pane is not open on it. */
  back: { path: string; stepId: string } | null;
  goBack(): void;
};

export const WorkLinksContext = createContext<WorkLinks | null>(null);

const nameOf = (path: string) => path.split("/").pop() ?? path;

/**
 * "Open file" after a file step's path, and "Back to <file>" on the step "Show
 * in chat" reached. Nothing for a step that named no file.
 */
export function StepFileLinks({ callId }: { callId: string | null }) {
  const links = useContext(WorkLinksContext);
  if (!links || !callId) return null;
  const { paths, change } = links.pathsOf(callId);
  if (paths.length === 0) return null;
  const stepId = `tool:${callId}`;
  return (
    <p className="step-file-links">
      {paths.map((path) => (
        <span key={path} className="step-file-link">
          <code>{path}</code>
          <button
            type="button"
            className="link-button"
            aria-label={`Open ${nameOf(path)} in the Work pane`}
            onClick={() => links.openFile(path, { stepId, change })}
          >
            Open file
          </button>
          {links.back?.stepId === stepId && links.back.path === path && (
            <button type="button" className="link-button" onClick={links.goBack}>
              Back to {nameOf(path)}
            </button>
          )}
        </span>
      ))}
    </p>
  );
}

/** Where a step is in the conversation, by its tool call id. */
export function stepElement(callId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.transcript [data-call-id="${CSS.escape(callId)}"]`);
}

/**
 * Bring a step into view the way section 10 says: open its fold and the
 * step, scroll its first line just under the protected band, fill it for
 * 1.6 s and move focus to its summary. False when the conversation does not
 * show the step on its own (a run still under way draws its steps as one line).
 */
export function revealStep(callId: string): boolean {
  const step = stepElement(callId);
  if (!step) return false;
  const fold = step.closest<HTMLDetailsElement>("details.steps");
  if (fold) fold.open = true;
  if (step instanceof HTMLDetailsElement) step.open = true;
  const scroller = step.closest<HTMLElement>(".transcript");
  if (scroller) {
    const band = 100;
    const top = step.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += top - band;
  }
  step.dataset.flash = "true";
  const clear = () => delete step.dataset.flash;
  step.addEventListener("animationend", clear, { once: true });
  step.addEventListener("focusout", clear, { once: true });
  (step.querySelector<HTMLElement>("summary") ?? step).focus({ preventScroll: true });
  return true;
}
