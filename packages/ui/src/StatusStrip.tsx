import type { ClawtrateState, Transcript } from "@clawtrate/core";
import { useEffect, useId, useState } from "react";
import { updatingHere, updatingStripWords } from "./bots/update-words.ts";
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
 * What the conversation may say about the connection and about the open task's live work.
 * `connected` is the connection alone: only it makes the composer say "Offline", an outgoing
 * message "Sends when reconnected" and the window read as lost. Loads being tried again, or
 * failed, never do (#592). `current` is that the open task's live work is this connection's:
 * the connection is up, and after a drop the open task has loaded again since it came back, or
 * that load failed (the strip says so). Until then the run line and the action cards say what
 * was last seen. Bots and tasks don't hold it: they don't change what the open task shows.
 */
export function liveFlags(
  state: ClawtrateState,
  phase: SyncPhase,
  taskKey: string | null,
): { connected: boolean; current: boolean } {
  const connected = state.connection.status === "connected";
  if (!connected || phase !== "dropped") return { connected, current: connected };
  const transcript = taskKey ? state.transcripts[taskKey] : undefined;
  return { connected, current: transcript?.status === "error" || taskInSync(state, taskKey) };
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
  /**
   * The gateway's own words for the failure, behind the strip's "Gateway's message" disclosure:
   * never the headline, and reachable by keyboard, touch and screen reader.
   */
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
    case "connecting": {
      // OpenClaw updating on this gateway, as the update engine knows it (#590).
      const updating = updatingHere(state);
      if (updating) {
        const words = updatingStripWords(updating);
        return {
          tone: updating.stage === "away" ? "danger" : "warn",
          text: words.text,
          short: words.short,
          more: "showing saved messages",
          action: words.retry ? "retry" : null,
          countdown: false,
        };
      }
      return {
        tone: "warn",
        text: "Reconnecting",
        more: "showing saved messages",
        action: "retry",
        countdown: true,
      };
    }
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
/** The most of the gateway's message the strip shows. */
export const DETAIL_SHOWN_CHARS = 600;

/** The gateway's message as plain text: no control characters, spaces collapsed, bounded. */
export function detailText(detail: string): string {
  const plain = detail
    // eslint-disable-next-line no-control-regex -- control characters are what is removed
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return plain.length > DETAIL_SHOWN_CHARS
    ? `${plain.slice(0, DETAIL_SHOWN_CHARS - 1).trimEnd()}…`
    : plain;
}

export function StatusStrip({
  strip,
  retryAt,
  onRetry,
  onReload,
  detailOpen = false,
}: {
  strip: Strip;
  retryAt: number | null;
  onRetry: () => void;
  onReload: () => void;
  /** Whether the gateway's message starts open. */
  detailOpen?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(detailOpen);
  const detailId = useId();
  const detail = strip.detail ? detailText(strip.detail) : null;
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
    <>
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
        {detail && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => setOpen((was) => !was)}
          >
            Gateway's message
          </button>
        )}
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
      {/* Outside the live region: opened on request, never announced by itself. */}
      {detail && open && (
        <div
          id={detailId}
          className="status-strip-detail"
          role="region"
          aria-label="Gateway's message"
          data-testid="status-strip-detail"
        >
          <p>{detail}</p>
        </div>
      )}
    </>
  );
}
