import type { TranscriptItem } from "@clawtrate/core";
import { ChevronIcon } from "./icons.tsx";

/**
 * The gateway's own row for a system event it woke a task with (#637): a command that finished
 * later, a scheduled event, whatever a plugin or a bot's wake put there. A quiet line in
 * Clawtrate's words, never the person's bubble, with the event's text one step away, as text.
 * The disclosure names no author: the gateway wrote the row, but a bot or a command may have
 * chosen its words.
 */
export function GatewayEventLine({ item }: { item: TranscriptItem }) {
  const [line, event] = item.blocks.map((block) => (block.kind === "text" ? block.text : ""));
  return (
    <div className="update-line" data-testid="gateway-event">
      <p className="event-line" data-side="center">
        {line}
      </p>
      <details className="event-details">
        <summary className="event-line" data-side="center">
          Event text
          <ChevronIcon className="chevron" />
        </summary>
        <div className="card event-body">
          <p className="gateway-event-text">{event}</p>
        </div>
      </details>
    </div>
  );
}
