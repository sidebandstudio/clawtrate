import { GATEWAY_EVENT_WORDS, type TranscriptItem } from "@clawtrate/core";
import { ChevronIcon } from "./icons.tsx";

/**
 * The gateway's own row for a system event it woke a task with (#637): a command that finished
 * later, a scheduled event, whatever a plugin or a bot's wake put there. A quiet line in
 * Clawtrate's words, never the person's bubble, with the event's text one step away, as text.
 * The gateway wrote the row, but not its words: any client with write access, a bot through its
 * scheduler tool, a command's output or a plugin chooses them. So the text never shows without
 * saying it isn't the gateway's or Clawtrate's own.
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
          {GATEWAY_EVENT_WORDS.label}
          <ChevronIcon className="chevron" />
        </summary>
        <div className="card event-body">
          <p className="gateway-event-note">{GATEWAY_EVENT_WORDS.attribution}</p>
          <p className="gateway-event-text">{event}</p>
        </div>
      </details>
    </div>
  );
}

/**
 * A system item in the conversation: the gateway's event line when the item carries an event's
 * text (`gatewayEvent`), otherwise the plain line its blocks say.
 */
export function SystemLine({ item }: { item: TranscriptItem }) {
  if (item.gatewayEvent) return <GatewayEventLine item={item} />;
  return (
    <p className="event-line" data-side="center">
      {item.blocks.map((block) => (block.kind === "text" ? block.text : "")).join(" ")}
    </p>
  );
}
