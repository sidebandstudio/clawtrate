import type { UpdateNoticeLine } from "@clawtrate/core";
import { ChevronIcon } from "./icons.tsx";

/**
 * The gateway's own notice of an update this device saw succeed (F-590): a quiet line in
 * Clawtrate's words, with no avatar, bubble or message actions, and the gateway's sentence one
 * step away, as text.
 */
export function UpdateLine({ line }: { line: UpdateNoticeLine }) {
  return (
    <div className="update-line" data-testid="update-line">
      <p className="event-line" data-side="center">
        OpenClaw updated to {line.version}
      </p>
      <details className="event-details">
        <summary className="event-line" data-side="center">
          The gateway&apos;s message
          <ChevronIcon className="chevron" />
        </summary>
        <div className="card event-body">
          <p className="update-line-text">{line.text}</p>
        </div>
      </details>
    </div>
  );
}
