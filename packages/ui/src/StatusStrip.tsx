import type { ClawtrateState, Transcript } from "@clawtrate/core";
import { useEffect, useState } from "react";
import { gatewayTitle } from "./format.ts";

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

/**
 * The open task's history has loaded since the latest connect. A transcript
 * kept from before the drop still says "ready", so its load time decides.
 */
export function taskInSync(state: ClawtrateState, taskKey: string | null): boolean {
  if (!taskKey) return true;
  const transcript = state.transcripts[taskKey];
  return (
    transcript?.status === "ready" &&
    (transcript.loadedAt ?? 0) >= (state.connection.connectedAt ?? 0)
  );
}

/**
 * What is on screen is current: the connection is up and nothing is still loading again after
 * a drop. A load that failed on the live connection ends the catching up too: it says that it
 * failed (the strip), and nothing reads as offline. Only a connection that is down, or back and
 * still loading, makes the composer say "Offline" and the run line "Reconnecting".
 */
export function caughtUpFor(
  state: ClawtrateState,
  phase: SyncPhase,
  taskKey: string | null,
): boolean {
  if (state.connection.status !== "connected") return false;
  if (phase !== "dropped") return true;
  const transcript = taskKey ? state.transcripts[taskKey] : undefined;
  return state.discovery.status === "error" || transcript?.status === "error";
}

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

export type Strip = {
  tone: "warn" | "danger" | "ok" | "off";
  /** The state. It keeps its place beside the action and shortens only after the explanation. */
  text: string;
  /** The state in fewer words, for the one-pane layout. */
  short?: string;
  /** The explanation after the middle dot; it shortens first. */
  more: string | null;
  /** The gateway's own words, when `more` says them plainly: in the strip's title, not its text. */
  detail?: string | null;
  action: "retry" | "reload" | "reconnect" | null;
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
  taskKey: string | null,
): Strip | null {
  const { connection, discovery } = state;
  const transcript = taskKey ? state.transcripts[taskKey] : undefined;
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
        text: `Can't reach ${gatewayTitle(connection)}`,
        short: "Can't reach the gateway",
        more: connection.error?.message ?? "showing saved messages",
        action: "retry",
        countdown: false,
      };
    case "disconnected":
      return {
        tone: "off",
        text: "Disconnected",
        more: "showing saved messages",
        action: "reconnect",
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
      text: "Couldn't load bots and tasks",
      short: "Couldn't load bots",
      more: discovery.error,
      detail: discovery.detail,
      action: "retry",
      countdown: false,
    };
  }
  if (phase === "dropped") {
    if (transcript?.status === "error") {
      return {
        tone: "danger",
        text: "Couldn't sync this task",
        more: null,
        action: "reload",
        countdown: false,
      };
    }
    // Back, but bots, tasks or the open task have not loaded again yet.
    return { tone: "warn", text: "Connected", more: "catching up", action: null, countdown: false };
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
      title={[text, strip.more, strip.detail !== strip.more && strip.detail]
        .filter(Boolean)
        .join(" · ")}
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
          {strip.action === "retry"
            ? "Retry now"
            : strip.action === "reconnect"
              ? "Reconnect"
              : "Try again"}
        </button>
      )}
    </div>
  );
}
