import type { ClawtrateState, Transcript } from "@clawtrate/core";
import { useEffect, useState } from "react";
import { gatewayLabel } from "./format.ts";

/**
 * Where the shell is after a connection problem: "dropped" from the moment the
 * connection is not connected until the gateway's bots and tasks (and the open
 * task) have loaded again, then "synced" for four seconds. Only a drop leads
 * to "Synced"; a first load never does.
 */
export type SyncPhase = "none" | "dropped" | "synced";

export const SYNCED_FOR_MS = 4000;

/** The open task failed to reload but still shows what was loaded before. */
export function refreshFailed(transcript: Transcript | undefined): boolean {
  return transcript?.status === "error" && transcript.items.length > 0;
}

export function useSyncPhase(state: ClawtrateState, transcript: Transcript | undefined): SyncPhase {
  const connected = state.connection.status === "connected";
  const [phase, setPhase] = useState<SyncPhase>(connected ? "none" : "dropped");
  // Adjusted while rendering, so the strip never shows a stale state for a frame.
  if (!connected && phase !== "dropped") setPhase("dropped");
  else if (
    connected &&
    phase === "dropped" &&
    state.discovery.status === "ready" &&
    !refreshFailed(transcript)
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

export type Strip = {
  tone: "warn" | "danger" | "ok";
  /** The state, always shown in full. */
  text: string;
  /** The explanation after the middle dot; it shortens first. */
  more: string | null;
  action: "retry" | "reload" | null;
  /** Show the host's retry countdown in the text. */
  countdown: boolean;
};

/**
 * The one strip for the conversation, from state the shell already has. The
 * footer's dot and words and the composer read the same connection state, so
 * the three always agree.
 */
export function stripFor(
  state: ClawtrateState,
  phase: SyncPhase,
  transcript: Transcript | undefined,
): Strip | null {
  const { connection, discovery } = state;
  switch (connection.status) {
    case "reconnecting":
    case "connecting":
      return {
        tone: "warn",
        text: "Reconnecting",
        more: "showing saved messages",
        action: "retry",
        countdown: true,
      };
    case "error":
      return {
        tone: "danger",
        text: `Can't reach ${gatewayLabel(connection.gatewayUrl)}`,
        more: connection.error?.message ?? "showing saved messages",
        action: "retry",
        countdown: false,
      };
    case "connected":
      break;
    default:
      return null;
  }
  if (discovery.status === "error") {
    return {
      tone: "danger",
      text: "Could not load this gateway's bots and tasks",
      more: discovery.error,
      action: "retry",
      countdown: false,
    };
  }
  if (phase === "dropped") {
    if (discovery.status !== "ready") {
      return {
        tone: "warn",
        text: "Connected",
        more: "catching up",
        action: null,
        countdown: false,
      };
    }
    if (refreshFailed(transcript)) {
      return {
        tone: "danger",
        text: "Couldn't sync this task",
        more: null,
        action: "reload",
        countdown: false,
      };
    }
  }
  if (phase === "synced") {
    return { tone: "ok", text: "Synced", more: null, action: null, countdown: false };
  }
  return null;
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
  const text = strip.countdown
    ? seconds
      ? `Reconnecting in ${seconds}s`
      : "Reconnecting…"
    : strip.text;
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
        <strong>{text}</strong>
        {strip.more && <span>· {strip.more}</span>}
      </span>
      {strip.action && (
        <button type="button" onClick={strip.action === "retry" ? onRetry : onReload}>
          {strip.action === "retry" ? "Retry now" : "Try again"}
        </button>
      )}
    </div>
  );
}
