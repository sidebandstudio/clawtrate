// The waiting state of a request and what an approval came to (setup.md §9),
// as the access bars show them: the host's words for where the request waits,
// Check now and Stop waiting under the command, and the design's fixed words
// for each outcome. Nothing here approves, cancels or removes anything.

import { APPROVAL_WORDS, type ConnectionState, type ScopeUpgradeState } from "@clawtrate/core";
import type { ReactNode } from "react";
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
  // Connected, the host looks at the gateway again; disconnected, the person reconnects.
  const lookAgain = button(
    "Look again",
    connected ? quietly({ type: "checkAccess" }) : quietly({ type: "retry" }),
  );
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
      return {
        body: upgrade.nowShown ? (
          APPROVAL_WORDS.nowShown
        ) : (
          <>
            <b>Approved.</b> Connecting again with the new access…
          </>
        ),
        action: null,
      };
    case "unconfirmed":
      return {
        tone: "danger",
        body: (
          <>
            <b>{APPROVAL_WORDS.unconfirmed.title}</b> {APPROVAL_WORDS.unconfirmed.detail}
          </>
        ),
        action: lookAgain,
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
      return {
        tone: "danger",
        body: APPROVAL_WORDS.identityUnread,
        action: lookAgain,
        offline: true,
      };
    case "identity-changed":
      return {
        tone: "danger",
        body: APPROVAL_WORDS.identityChanged,
        action: lookAgain,
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

/**
 * Under the waiting state's command: the request's short id with its copy
 * button, "Check now" and "Stop waiting". Stop waiting stops this device's
 * wait; the gateway's request is not cancelled, and nothing says it was.
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
  return (
    <div className="access-id" data-testid="access-id">
      {upgrade.requestId && <span className="mono">Request {upgrade.requestId.slice(0, 8)}</span>}
      {upgrade.requestId && copy}
      <span className="access-id-actions">
        <button
          type="button"
          className="button"
          data-size={size ?? "sm"}
          data-variant="quiet"
          onClick={() => void send({ type: "checkAccess" }).catch(() => {})}
        >
          Check now
        </button>
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
