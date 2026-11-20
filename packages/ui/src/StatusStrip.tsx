import type { ClawtrateState } from "@clawtrate/core";
import { useEffect, useState } from "react";
import {
  STRIP_ACTION_WORDS,
  stripText,
  SYNCED_FOR_MS,
  taskInSync,
  type Strip,
  type SyncPhase,
} from "./strip.ts";

export {
  refreshFailed,
  stripFor,
  SYNCED_FOR_MS,
  taskInSync,
  type Strip,
  type SyncPhase,
} from "./strip.ts";

export function useSyncPhase(state: ClawtrateState, taskKey: string | null): SyncPhase {
  const connected = state.connection.status === "connected";
  const [phase, setPhase] = useState<SyncPhase>(connected ? "none" : "dropped");
  // Adjusted while rendering, so the strip never shows a stale state for a frame.
  // "Synced" waits for bots, tasks and the open task's reload to succeed.
  if (!connected && phase !== "dropped") setPhase("dropped");
  else if (
    connected &&
    phase === "dropped" &&
    state.discovery.status === "ready" &&
    taskInSync(state, taskKey)
  ) {
    setPhase("synced");
  }
  useEffect(() => {
    if (phase !== "synced") return;
    const timer = setTimeout(() => setPhase("none"), SYNCED_FOR_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  return phase;
}

/**
 * One compact pill in the protected band under the title pill, centred on the
 * conversation. It overlays the transcript, so nothing moves when it comes or
 * goes, and it mounts only when needed, so its countdown starts then.
 */
export function StatusStrip({
  strip,
  retryAt,
  onRetry,
  onReload,
}: {
  strip: Strip;
  retryAt: number | null;
  onRetry: () => void;
  onReload: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!strip.countdown) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [strip.countdown]);
  const seconds =
    strip.countdown && retryAt !== null ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : null;
  const text = stripText(strip, seconds);
  return (
    <div
      className="status-strip"
      role="status"
      data-tone={strip.tone}
      data-testid="status-strip"
      title={strip.more ? `${text} · ${strip.more}` : text}
    >
      <span className="status-dot" aria-hidden="true" />
      <span className="status-strip-text">
        {strip.short ? (
          <strong>
            <span className="strip-long">{text}</span>
            <span className="strip-short">{strip.short}</span>
          </strong>
        ) : (
          <strong>{text}</strong>
        )}
        {strip.more && <span>· {strip.more}</span>}
      </span>
      {strip.action && (
        <button type="button" onClick={strip.action === "reload" ? onReload : onRetry}>
          {STRIP_ACTION_WORDS[strip.action]}
        </button>
      )}
    </div>
  );
}
