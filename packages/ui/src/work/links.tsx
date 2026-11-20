// The way from a step to its file and back (work-pane.md, section 10). The
// shell provides it; a step in the conversation asks it for its links with
// `<StepFileLinks callId=… />`, and the Work pane uses `showInChat`.

import { createContext, useContext } from "react";
import { readView, viewKeys, writeView } from "../actions/view-state.ts";

/** What "Open file" asks the pane to show. */
export type FileRequest = {
  path: string;
  /** The step it came from: a write opens on its change, a read on the source. */
  stepId: string | null;
  view: "changes" | "source" | null;
  /** An item a bot handed over, by its occurrence key: Files opens it instead of `path`. */
  artifact?: string;
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

/** Where a call is in the conversation, by its tool call id: its card, or its row in a fold. */
export function stepElement(callId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.transcript [data-call="${CSS.escape(callId)}"]`);
}

/**
 * Bring a call into view the way section 10 says: open its fold and the call
 * itself through the conversation's view state, on its Readable view so
 * "Back to <file>" is there, then scroll its line just under the protected
 * band, fill it for 1.6 s and move focus to its summary. False when the
 * conversation does not show the call.
 */
export function revealStep(taskKey: string, callId: string): boolean {
  const fold = readView(taskKey, viewKeys.member(callId));
  const shown =
    stepElement(callId) !== null ||
    (typeof fold === "string" &&
      document.querySelector(`.transcript [data-first="${CSS.escape(fold)}"]`) !== null);
  if (!shown) return false;
  if (typeof fold === "string") writeView(taskKey, viewKeys.fold(fold), true);
  writeView(taskKey, viewKeys.call(callId), true);
  writeView(taskKey, viewKeys.view(callId), "readable");
  // Once the fold and the row are drawn open.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const step = stepElement(callId);
      if (!step) return;
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
      (step.querySelector<HTMLElement>(":scope > summary") ?? step).focus({ preventScroll: true });
    }),
  );
  return true;
}
