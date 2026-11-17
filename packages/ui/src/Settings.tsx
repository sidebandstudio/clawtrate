// Settings, opened with Cmd/Ctrl+, from any screen (bots.md section 7). Two
// panes: the list of sections, and the chosen one. Its Gateway pane shows the
// connection as it is (address, state, this device, the scopes the gateway
// granted) and offers Reconnect and Disconnect; Accounts lists the gateway's
// accounts. A modal dialog: focus stays inside it, Escape closes it, and
// focus returns to where it was.

import type { AccountsState, Bot, ConnectionState, HostInfo } from "@clawtrate/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useCommand } from "./bridge.tsx";
import { useAccountsSection } from "./bots/AccountsSection.tsx";
import { Dialog } from "./bots/Dialog.tsx";
import { recall, remember } from "./bots/memory.ts";
import { useAnnouncer } from "./bots/parts.tsx";
import "./bots/bots.css";
import { failureTitle } from "./ConnectScreen.tsx";
import { gatewayLabel } from "./format.ts";
import { BackIcon, ChevronIcon, CloseIcon } from "./icons.tsx";

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
  if (error.code === "PAIRING_ENDED") {
    return { title: failureTitle(error.code), message: error.message };
  }
  if (connection.status === "connected") return null;
  return {
    title: "Can't reach the gateway",
    message: [error.message, error.hint].filter(Boolean).join(" "),
  };
}

type Section = "gateway" | "accounts";
const SECTIONS: Array<[Section, string]> = [
  ["gateway", "Gateway"],
  ["accounts", "Accounts"],
];
/** ⌘, opens on the section last shown, Gateway the first time. */
const SHOWN_LAST = "settings-section";

export function Settings({
  connection,
  info,
  accounts,
  bots,
  onClose,
}: {
  connection: ConnectionState;
  info: HostInfo;
  accounts: AccountsState;
  bots: readonly Bot[];
  onClose: () => void;
}) {
  const send = useCommand();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [section, setSectionState] = useState<Section>(
    () => recall<Section>(SHOWN_LAST) ?? "gateway",
  );
  // On a phone the list comes first; a section replaces it.
  const [pane, setPane] = useState<"nav" | "section">("nav");
  const [announcer, announce] = useAnnouncer();
  const setSection = (next: Section) => {
    remember(SHOWN_LAST, next);
    setSectionState(next);
    setPane("section");
    requestAnimationFrame(() =>
      dialogRef.current?.querySelector<HTMLElement>("#b-section-title")?.focus(),
    );
  };
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
    const dialog = dialogRef.current;
    const close = [...(dialog?.querySelectorAll<HTMLElement>(".settings-close") ?? [])].find(
      (each) => each.getClientRects().length > 0,
    );
    close?.focus();
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

  const dot =
    state === "Connected"
      ? "connected"
      : state === "Connecting" || state === "Pairing pending"
        ? "connecting"
        : state === "Offline"
          ? "error"
          : "disconnected";

  const toNav = (
    <button
      type="button"
      className="icon-button b-back"
      data-variant="quiet"
      data-b="to-nav"
      aria-label="Back to settings"
      onClick={() => {
        setPane("nav");
        requestAnimationFrame(() =>
          dialogRef.current
            ?.querySelector<HTMLElement>('.b-nav-item[aria-current="page"]')
            ?.focus(),
        );
      }}
    >
      <BackIcon />
    </button>
  );
  const closeButton = (
    <button
      type="button"
      className="icon-button b-close settings-close"
      aria-label="Close settings"
      title="Close (Esc)"
      onClick={onClose}
    >
      <CloseIcon />
    </button>
  );

  const accountsSection = useAccountsSection({ accounts, bots, connection, info, announce, toNav });

  const gatewayPane = (
    <>
      <dl className="facts" data-testid="gateway-facts">
        <div>
          <dt>Address</dt>
          <dd title={connection.gatewayUrl ?? undefined}>{connection.gatewayUrl ?? "None yet"}</dd>
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
          <dd data-testid="granted-scopes" className="b-wrap-value">
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
          <button type="button" className="button" onClick={() => void send({ type: "suspend" })}>
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
          disconnected.{" "}
          {connection.canAdmin
            ? "This device holds admin access, which it asked for to change bots and accounts."
            : "This device asks for more access only when you start something that needs it."}
        </p>
      )}
    </>
  );

  let content: ReactNode;
  if (section === "accounts" && accountsSection.connect) content = accountsSection.connect;
  else {
    const view =
      section === "accounts" && accountsSection.view
        ? accountsSection.view
        : { title: "Gateway", back: toNav, body: gatewayPane, foot: null };
    content = (
      <>
        <header className="b-section-head">
          {view.back}
          <h3 id="b-section-title" tabIndex={-1}>
            {view.title}
          </h3>
        </header>
        <div className="b-section-body">{view.body}</div>
        {view.foot && <footer className="b-section-foot">{view.foot}</footer>}
      </>
    );
  }

  return (
    <Dialog kind="settings" labelledBy="settings-title" onClose={onClose} testId="settings">
      <div className="b-settings" data-pane={pane} ref={dialogRef}>
        <nav className="b-nav" aria-label="Settings">
          <div className="b-nav-head">
            <h2 id="settings-title">Settings</h2>
            {closeButton}
          </div>
          {SECTIONS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="b-nav-item"
              aria-current={id === section ? "page" : undefined}
              onClick={() => setSection(id)}
            >
              {label}
              <ChevronIcon />
            </button>
          ))}
        </nav>
        <section className="b-section" aria-labelledby="b-section-title">
          {closeButton}
          {content}
        </section>
        {announcer}
      </div>
    </Dialog>
  );
}
