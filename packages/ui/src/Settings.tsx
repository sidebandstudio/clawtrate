// Settings, opened with Cmd/Ctrl+, from any screen. Its Gateway pane shows the
// connection as it is (address, state, this device, the scopes the gateway
// granted) and offers Reconnect and Disconnect. A modal dialog: focus stays
// inside it, Escape closes it, and focus returns to where it was.

import type { ConnectionState, HostInfo } from "@clawtrate/core";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { useCommand } from "./bridge.tsx";
import { failureTitle } from "./ConnectScreen.tsx";
import { gatewayLabel } from "./format.ts";
import { CloseIcon } from "./icons.tsx";

/** The connection's state, as the Gateway pane names it. */
export function gatewayState(connection: ConnectionState): string {
  switch (connection.status) {
    case "connected":
      return "Connected";
    case "pairing":
      return "Pairing pending";
    case "disconnected":
      return "Disconnected";
    case "idle":
      return "Not connected";
    case "error":
      return "Offline";
    case "connecting":
    case "reconnecting":
      // An attempt under way is connecting; waiting for the next one is offline.
      return connection.retryAt === null ? "Connecting" : "Offline";
  }
}

/** The pane's error line: pairing rejected or expired, unreachable, protocol incompatible. */
function gatewayProblem(connection: ConnectionState): { title: string; message: string } | null {
  const error = connection.error;
  if (!error) return null;
  if (error.code === "PROTOCOL_MISMATCH") {
    return { title: "This gateway speaks another protocol", message: error.message };
  }
  if (error.code === "PAIRING_REJECTED" || error.code === "PAIRING_EXPIRED") {
    return { title: failureTitle(error.code), message: error.message };
  }
  if (connection.status === "connected") return null;
  return {
    title: "Can't reach the gateway",
    message: [error.message, error.hint].filter(Boolean).join(" "),
  };
}

export function Settings({
  connection,
  info,
  onClose,
}: {
  connection: ConnectionState;
  info: HostInfo;
  onClose: () => void;
}) {
  const send = useCommand();
  const dialogRef = useRef<HTMLElement>(null);
  const state = gatewayState(connection);
  const problem = gatewayProblem(connection);
  const canReconnect = state === "Offline" || state === "Disconnected";
  const canDisconnect =
    connection.status === "connected" ||
    connection.status === "connecting" ||
    connection.status === "reconnecting";
  const deviceName =
    info.deviceName ?? (info.kind === "desktop" ? "Clawtrate Desktop" : "Clawtrate Web");

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>(".settings-close")?.focus();
  }, []);

  // An action replaces its own button (Disconnect gives way to Reconnect, and
  // back), which drops focus out of the dialog. Put it on the action that took
  // its place, or on Close, so focus and Escape stay in the dialog.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.contains(document.activeElement)) return;
    (
      dialog.querySelector<HTMLElement>(".settings-actions .button") ??
      dialog.querySelector<HTMLElement>(".settings-close")
    )?.focus();
  });

  // The dialog keeps focus inside itself; Escape closes it.
  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const items = [...dialogRef.current.querySelectorAll<HTMLElement>("button, [tabindex='0']")];
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const dot =
    state === "Connected"
      ? "connected"
      : state === "Connecting" || state === "Pairing pending"
        ? "connecting"
        : state === "Offline"
          ? "error"
          : "disconnected";

  return (
    <div className="settings-layer">
      <button
        type="button"
        className="settings-scrim"
        aria-label="Close settings"
        tabIndex={-1}
        onClick={onClose}
      />
      <section
        ref={dialogRef}
        className="settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        data-testid="settings"
        onKeyDown={onKey}
      >
        <header className="settings-head">
          <h2 id="settings-title">Settings</h2>
          <button
            type="button"
            className="icon-button settings-close"
            aria-label="Close settings"
            title="Close (Esc)"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </header>
        <section className="settings-pane" aria-labelledby="settings-gateway">
          <h3 id="settings-gateway">Gateway</h3>
          <dl className="facts" data-testid="gateway-facts">
            <div>
              <dt>Address</dt>
              <dd title={connection.gatewayUrl ?? undefined}>
                {connection.gatewayUrl ?? "None yet"}
              </dd>
            </div>
            <div>
              <dt>State</dt>
              <dd className="settings-state" data-testid="gateway-state">
                <span className="status-dot" data-status={dot} aria-hidden="true" />
                {state}
              </dd>
            </div>
            <div>
              <dt>This device</dt>
              <dd>
                {deviceName}
                {connection.deviceId ? ` · ${connection.deviceId.slice(0, 8)}` : ""}
              </dd>
            </div>
            <div>
              <dt>Granted scopes</dt>
              <dd data-testid="granted-scopes">
                {connection.status === "connected" && connection.scopes.length > 0
                  ? connection.scopes.join(", ")
                  : "None while not connected"}
              </dd>
            </div>
            {connection.serverVersion && (
              <div>
                <dt>Gateway</dt>
                <dd>
                  OpenClaw {connection.serverVersion}
                  {connection.protocol !== null ? ` · protocol ${connection.protocol}` : ""}
                </dd>
              </div>
            )}
          </dl>
          {problem && (
            <div className="form-error" role="alert" data-testid="gateway-problem">
              <strong>{problem.title}</strong>
              {problem.message}
            </div>
          )}
          <div className="settings-actions">
            {canReconnect && (
              <button
                type="button"
                className="button"
                data-variant="primary"
                onClick={() => void send({ type: "retry" })}
              >
                Reconnect
              </button>
            )}
            {canDisconnect && (
              <button
                type="button"
                className="button"
                onClick={() => void send({ type: "suspend" })}
              >
                Disconnect
              </button>
            )}
            {connection.gatewayUrl && (
              <button
                type="button"
                className="button"
                data-variant="quiet"
                onClick={() => {
                  onClose();
                  void send({ type: "disconnect" });
                }}
              >
                Use another gateway
              </button>
            )}
          </div>
          {connection.gatewayUrl && (
            <p className="settings-note">
              {gatewayLabel(connection.gatewayUrl)} keeps this device's pairing while it is
              disconnected. This device asks for read access only.
            </p>
          )}
        </section>
      </section>
    </div>
  );
}
