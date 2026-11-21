// The waiting state of a request and what an approval came to (setup.md §9),
// as the access bars show them: the host's words for where the request waits,
// the next check, Check now and Stop waiting under the command, and the
// design's fixed words for each outcome, each action doing what it says. Nothing
// here approves, cancels or removes anything.

import { APPROVAL_WORDS, type ConnectionState, type ScopeUpgradeState } from "@clawtrate/core";
import { useEffect, useState, type ReactNode } from "react";
import { useCommand } from "./bridge.tsx";

type Send = ReturnType<typeof useCommand>;

/** What a bar says and offers for one of §9's states, or null for a state the bar words itself. */
export type ApprovalShelf = {
  body: ReactNode;
  action: ReactNode;
  tone?: "danger";
  /** The action stays while disconnected: it is how the person reconnects. */
  offline?: boolean;
};

/**
 * The words and actions for the waiting state and the outcomes after an
 * approval; null for the states each bar words for itself (idle, requesting,
 * rejected, expired, error).
 */
export function approvalShelf(
  connection: ConnectionState,
  send: Send,
  ask: () => void,
  size?: "sm",
  /** Whether this host has setup's looks (the desktop app): Review and Look again open them. */
  looks = true,
): ApprovalShelf | null {
  const upgrade: ScopeUpgradeState = connection.upgrade;
  const connected = connection.status === "connected";
  const button = (label: string, onClick: () => void, primary = false) => (
    <button
      type="button"
      className="button"
      data-size={size}
      data-variant={primary ? "primary" : undefined}
      onClick={onClick}
    >
      {label}
    </button>
  );
  const quietly = (command: Parameters<Send>[0]) => () => void send(command).catch(() => {});
  // The route's own look (§6): that computer's screens again over SSH, this computer's look
  // here. An address route has none.
  const routeLook: Parameters<Send>[0] | null = !looks
    ? null
    : upgrade.place === "ssh"
      ? { type: "setupRetryRoute" }
      : upgrade.place === "here"
        ? { type: "setupLook" }
        : null;
  const reconnect = button("Reconnect", quietly({ type: "retry" }));
  const look = routeLook ? button("Look again", quietly(routeLook)) : null;
  switch (upgrade.status) {
    case "pending":
      return {
        body: (
          <>
            <b>{upgrade.approveTitle ?? "Waiting for approval."}</b>
            {upgrade.approveNote ? ` ${upgrade.approveNote}` : ""}
          </>
        ),
        action: null,
      };
    case "confirming":
      return {
        body: (
          <>
            <b>Approved.</b> Checking what the gateway granted…
          </>
        ),
        action: null,
      };
    case "approved":
      // Confirmed and kept: the strip and the bar say Granted (and, after a lost wait, that
      // the gateway now shows the access) once; nothing here is still under way.
      return null;
    case "unconfirmed":
      // The route's look first, as §6 shows it; reconnecting is its own, explicit, choice.
      return {
        tone: "danger",
        body: (
          <>
            <b>{APPROVAL_WORDS.unconfirmed.title}</b> {APPROVAL_WORDS.unconfirmed.detail}
          </>
        ),
        action: (
          <>
            {look}
            {reconnect}
          </>
        ),
        offline: true,
      };
    case "stale":
      return {
        body: APPROVAL_WORDS.stale,
        action: (
          <>
            {button("Check again", quietly({ type: "checkAccess" }))}
            {button("Request again", ask)}
          </>
        ),
      };
    case "other-request":
      return { body: APPROVAL_WORDS.otherRequest, action: button("Request again", ask) };
    case "identity-unread":
      // Waiting still, the host looks at the identity and version again; disconnected, the
      // route's look does, with the endpoint and version first.
      return {
        tone: "danger",
        body: APPROVAL_WORDS.identityUnread,
        action: connected
          ? button("Look again", quietly({ type: "checkAccess" }))
          : (look ?? reconnect),
        offline: true,
      };
    case "identity-changed":
      // Disconnected, the route retired (§8): its review, never a reconnect to that gateway.
      return {
        tone: "danger",
        body: APPROVAL_WORDS.identityChanged,
        action: routeLook ? button("Review", quietly(routeLook)) : null,
        offline: true,
      };
    case "list-unread":
      return {
        tone: "danger",
        body: upgrade.error,
        action: button("Check again", quietly({ type: "checkAccess" })),
      };
    default:
      return null;
  }
}

/** Whole seconds until `at`, counted down while it is ahead; null without one. */
function useSecondsUntil(at: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [at]);
  return at === null ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * Under the waiting state's command: the request's short id with its copy
 * button, when the request is next checked, "Check now" where the host can
 * look, and "Stop waiting". Stop waiting stops this device's wait; the
 * gateway's request is not cancelled, and nothing says it was.
 */
export function WaitingRow({
  upgrade,
  copy,
  size,
}: {
  upgrade: ScopeUpgradeState;
  copy: ReactNode;
  size?: "sm";
}) {
  const send = useCommand();
  const seconds = useSecondsUntil(upgrade.checkAt ?? null);
  // Only where the host looks at the gateway's computer: an address route's wait is continuous.
  const checks = typeof upgrade.checkAt === "number";
  return (
    <div className="access-id" data-testid="access-id">
      {upgrade.requestId && <span className="mono">Request {upgrade.requestId.slice(0, 8)}</span>}
      {upgrade.requestId && copy}
      {checks && (
        <span className="access-next" data-testid="access-next">
          {seconds ? `checking again in ${seconds}s` : "checking…"}
        </span>
      )}
      <span className="access-id-actions">
        {checks && (
          <button
            type="button"
            className="button"
            data-size={size ?? "sm"}
            data-variant="quiet"
            onClick={() => void send({ type: "checkAccess" }).catch(() => {})}
          >
            Check now
          </button>
        )}
        <button
          type="button"
          className="button"
          data-size={size ?? "sm"}
          data-variant="quiet"
          onClick={() => void send({ type: "stopWaiting" }).catch(() => {})}
        >
          Stop waiting
        </button>
      </span>
    </div>
  );
}
