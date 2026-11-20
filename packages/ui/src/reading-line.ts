/**
 * The blocks of text a reader's place is held by (`useHoldPlace` in
 * Conversation.tsx): the first one drawn at or below the reading line, just
 * under the transcript column's top padding, holds the place. Shared with the
 * checks that measure the reading line, so they measure what the
 * conversation holds.
 */
export const TEXT_BLOCKS =
  ".task-line, .stamp, .event-line, .action > summary, .step > summary, .status-phrase, " +
  ".request-title, .card > summary, " +
  ".bubble :is(p, li, h1, h2, h3, h4, h5, h6, pre, td, th, blockquote)";

/**
 * Mark a jump the page makes in the transcript for the reader (a control brought into view), so
 * the scroll it causes is the reader's and stops following the end. Call it before the jump.
 */
export function markTranscriptNavigation(target: Element): void {
  target
    .closest('[data-testid="transcript"]')
    ?.dispatchEvent(new Event("clawtrate:transcript-navigation"));
}
