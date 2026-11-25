import type { UpdateNoticeLine } from "@clawtrate/core";
import { ChevronIcon } from "./icons.tsx";

/**
 * The gateway's own notice of an update this device saw succeed (F-590): a quiet line in
 * Clawtrate's words, with no avatar, bubble or message actions, and the row's text one step away,
 * as text. The disclosure doesn't name its author: in the one case a bot can still write first
 * (docs/decisions.md, "The gateway's update notice"), the text is the bot's.
 */
export function UpdateLine({ line, messageId }: { line: UpdateNoticeLine; messageId?: string }) {
  return (
    // The row's gateway id, so a search hit on it is brought into view as a message's is.
    <div className="update-line" data-testid="update-line" data-message={messageId}>
      <p className="event-line" data-side="center">
        OpenClaw updated to {line.version}
      </p>
      <details className="event-details">
        <summary className="event-line" data-side="center">
          Message text
          <ChevronIcon className="chevron" />
        </summary>
        <div className="card event-body">
          <p className="update-line-text">{line.text}</p>
        </div>
      </details>
    </div>
  );
}
