// Settings, opened with Cmd/Ctrl+, from any screen (bots.md section 7). Two
// panes: the list of sections, and the chosen one. Its Gateway pane shows the
// connection as it is (address, state, this device, the scopes the gateway
// granted) and offers Reconnect and Disconnect; Accounts lists the gateway's
// accounts. A modal dialog: focus stays inside it, Escape closes it, and
// focus returns to where it was.

import {
  INTERACTIVE_SCOPES,
  scopeSatisfied,
  type AccountsState,
  type Bot,
  type ConnectionState,
  type HostInfo,
} from "@clawtrate/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useCommand } from "./bridge.tsx";
import { useAccountsSection } from "./bots/AccountsSection.tsx";
import { Dialog } from "./bots/Dialog.tsx";
import { recall, remember } from "./bots/memory.ts";
import { useAnnouncer } from "./bots/parts.tsx";
import "./bots/bots.css";
import { CopyValue } from "./AccessBar.tsx";
import { CommandLine } from "./ConnectScreen.tsx";
import { gatewayLabel } from "./format.ts";
import {
  gatewayActions,
  gatewayDot,
  gatewayProblem,
  gatewayState,
  grantedWords,
  pairingNote,
  serverWords,
  SETTINGS_WORDS as W,
} from "./gateway-state.ts";
import { BackIcon, ChevronIcon, CloseIcon } from "./icons.tsx";

export { gatewayProblem, gatewayState } from "./gateway-state.ts";

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
  const actions = gatewayActions(connection);
  const server = serverWords(connection);
  const deviceName =
    info.deviceName ?? (info.kind === "desktop" ? "Clawtrate Desktop" : "Clawtrate Web");
  // Re-pair (F-456): ask the gateway's owner for this device's interactive access. The old
  // authorization keeps working until they approve; then the new one replaces it.
  const upgrade = connection.upgrade;
  const holdsAll =
    connection.status === "connected" &&
    INTERACTIVE_SCOPES.every((scope) => scopeSatisfied(connection.scopes, scope));
  const rePairing = upgrade.status === "requesting" || upgrade.status === "pending";
  const canRePair = !info.readOnly && connection.status === "connected" && !holdsAll && !rePairing;
  const rePairProblem =
    upgrade.status === "rejected"
      ? "The gateway's owner rejected the new pairing. This device keeps its earlier access."
      : upgrade.status === "expired"
        ? "The pairing request expired before it was approved. This device keeps its earlier access."
        : upgrade.status === "error"
          ? `Couldn't re-pair. ${upgrade.error ?? ""}`.trim()
          : null;

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

  const dot = gatewayDot(state);

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
      aria-label={W.close}
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
          <dt>{W.address}</dt>
          <dd title={connection.gatewayUrl ?? undefined}>{connection.gatewayUrl ?? W.noAddress}</dd>
        </div>
        <div>
          <dt>{W.state}</dt>
          <dd className="settings-state" data-testid="gateway-state">
            <span className="status-dot" data-status={dot} aria-hidden="true" />
            {state}
          </dd>
        </div>
        <div>
          <dt>{W.device}</dt>
          <dd>
            {deviceName}
            {connection.deviceId ? ` · ${connection.deviceId.slice(0, 8)}` : ""}
          </dd>
        </div>
        <div>
          <dt>{W.scopes}</dt>
          <dd data-testid="granted-scopes" className="b-wrap-value">
            {grantedWords(connection)}
          </dd>
        </div>
        {server && (
          <div>
            <dt>{W.server}</dt>
            <dd>{server}</dd>
          </div>
        )}
      </dl>
      {problem && (
        <div className="form-error" role="alert" data-testid="gateway-problem">
          <strong>{problem.title}</strong>
          {problem.message}
        </div>
      )}
      {!info.readOnly && rePairProblem && !holdsAll && (
        <div className="form-error" role="alert" data-testid="repair-problem">
          {rePairProblem}
        </div>
      )}
      {!info.readOnly && connection.status === "connected" && rePairing && (
        <div className="settings-repair" data-testid="repair-pending">
          <p>
            Waiting for the gateway's owner to approve this device's new pairing. It changes by
            itself once they approve or reject it; until then this device keeps its earlier access.
          </p>
          {upgrade.approveCommand && (
            <CommandLine command={upgrade.approveCommand} label="Copy approve command" />
          )}
          {upgrade.requestId && (
            <div className="access-id">
              <span className="mono">Request {upgrade.requestId.slice(0, 8)}</span>
              <CopyValue value={upgrade.requestId} label="Copy request id" />
            </div>
          )}
        </div>
      )}
      <div className="settings-actions">
        {actions.reconnect && (
          <button
            type="button"
            className="button"
            data-variant="primary"
            onClick={() => void send({ type: "retry" })}
          >
            {W.reconnect}
          </button>
        )}
        {actions.disconnect && (
          <button type="button" className="button" onClick={() => void send({ type: "suspend" })}>
            {W.disconnect}
          </button>
        )}
        {actions.forget && (
          <button
            type="button"
            className="button"
            data-variant="quiet"
            onClick={() => {
              onClose();
              void send({ type: "disconnect" });
            }}
          >
            {W.useAnother}
          </button>
        )}
      </div>
      {canRePair && (
        <div className="settings-repair-actions">
          <button
            type="button"
            className="button"
            data-size="sm"
            onClick={() => void send({ type: "requestAccess" }).catch(() => {})}
          >
            Re-pair
          </button>
        </div>
      )}
      {connection.gatewayUrl && (
        <p className="settings-note">
          {pairingNote(gatewayLabel(connection.gatewayUrl), {
            admin: connection.canAdmin,
            holdsAll,
            readOnly: info.readOnly,
          })}
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
