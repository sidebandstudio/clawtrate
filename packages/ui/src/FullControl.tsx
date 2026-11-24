// Full control, explained before Connect and reported after it
// (docs/design/setup-effortless.md §2, "Consent before Connect"; §8, a narrower grant).
// Every sentence is the design's fixed copy.

import {
  FULL_SCOPES,
  gatewayStamp,
  PAIRING_SCOPE,
  scopeSatisfied,
  type ConnectionState,
  type GatewayStamp,
} from "@clawtrate/core";
import { useEffect, useId, useRef, useState } from "react";
import { useCommand } from "./bridge.tsx";
import { Dialog } from "./bots/Dialog.tsx";
import { CommandLine } from "./ConnectScreen.tsx";
import { gatewayLabel } from "./format.ts";

export const CONSENT_LINE =
  "Full control lets Clawtrate change gateway settings, approve devices and, when the gateway allows it, open a terminal on the computer running OpenClaw.";

/** What "What this means" opens: the five points of §2. */
export const WHAT_IT_MEANS = [
  "The terminal runs as the gateway's user and inherits that process's environment. It is on by default, within the gateway's and the sandbox's limits.",
  "Disconnecting this device leaves its pairing on the gateway. Removing it (Settings, Gateway, Devices, from another admin device) ends that pairing.",
  "If this device is lost, remove it from another admin connection.",
  "If the shared token leaked, rotate it on the gateway and review the other paired devices.",
  "Protecting this app's data limits copies made from backups and app files. It doesn't protect a computer that is already compromised.",
];

/** The consent line, directly above a pairing card's button, with its "What this means". */
export function FullControlConsent() {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="consent" data-testid="full-control-consent">
      <p className="consent-line">
        {CONSENT_LINE}{" "}
        <button
          type="button"
          className="consent-more"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        >
          What this means
        </button>
      </p>
      <ul id={id} className="consent-points" hidden={!open}>
        {WHAT_IT_MEANS.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
    </div>
  );
}

/** Each of the six in plain words, for what a narrower grant left out. */
const SCOPE_WORDS: Record<string, string> = {
  "operator.read": "reading",
  "operator.write": "sending and stopping",
  "operator.approvals": "deciding approvals",
  "operator.questions": "answering questions",
  "operator.admin": "changing gateway settings",
  "operator.pairing": "approving devices",
};

/**
 * What a full pairing's connection wasn't granted of the six, in plain words: empty when it
 * holds them all, or when this isn't a full pairing. Pairing counts only by name, as the
 * client holds it.
 */
export function notGranted(connection: ConnectionState): string[] {
  if (!connection.fullPairing || connection.status !== "connected") return [];
  return FULL_SCOPES.filter((scope) =>
    scope === PAIRING_SCOPE
      ? !connection.scopes.includes(scope)
      : !scopeSatisfied(connection.scopes, scope),
  ).map((scope) => SCOPE_WORDS[scope] ?? scope);
}

/** Whether the access request under way, or last ended, is the offer's: the six, in order. */
export function isFullRequest(connection: ConnectionState): boolean {
  const asked = connection.upgrade.scopes;
  return asked.length === FULL_SCOPES.length && FULL_SCOPES.every((scope, i) => asked[i] === scope);
}

/** What an offer is bound to: its gateway, this device and its stamp; null until all are known. */
type Binding = { gatewayUrl: string; deviceId: string; stamp: GatewayStamp };
export function offerBinding(connection: ConnectionState): Binding | null {
  if (!connection.gatewayUrl || !connection.deviceId || connection.gatewayId === null) return null;
  return {
    gatewayUrl: connection.gatewayUrl,
    deviceId: connection.deviceId,
    stamp: gatewayStamp(connection),
  };
}

/** Accept the offer for what it was shown for (`offerBinding`); a refusal is the message. */
function useAskFull(binding: Binding | null) {
  const send = useCommand();
  const [failure, setFailure] = useState<string | null>(null);
  const ask = () => {
    if (!binding) return;
    setFailure(null);
    send({ type: "requestFullControl", ...binding }).catch((error: unknown) =>
      setFailure(error instanceof Error ? error.message : String(error)),
    );
  };
  return { ask, failure };
}

/** Where the offer's request stands, in a sentence; null before it was asked. */
function fullRequestNote(connection: ConnectionState): string | null {
  if (connection.fullPairing && connection.status === "connected") {
    const missing = notGranted(connection);
    return missing.length === 0
      ? "This device has full control."
      : `OpenClaw granted less than full control. Not granted: ${missing.join(", ")}. This device keeps what was granted.`;
  }
  if (!isFullRequest(connection)) return null;
  const { upgrade } = connection;
  switch (upgrade.status) {
    case "requesting":
      return "Asking the gateway…";
    case "pending":
      return "Waiting for the gateway's owner. They decide once; until then this device keeps its current access.";
    case "approved":
      return "Approved. Connecting again with full control…";
    case "rejected":
      return "The gateway's owner refused. This device keeps its current access.";
    case "expired":
      return "The request expired before it was decided. This device keeps its current access. You can ask again from Settings, Gateway.";
    case "error":
      return `Couldn't ask for full control. ${upgrade.error ?? ""}`.trim();
    default:
      return null;
  }
}

/**
 * The one-time offer of full control to a device paired with less (setup-effortless.md §6):
 * "Give this device full control" sends one request for the six, under the consent line;
 * "Keep current access", or Escape, answers it. Either way it doesn't show by itself again.
 * Once asked, it says where the request stands until it is closed.
 */
export function FullControlOffer({
  connection,
  onClose,
}: {
  connection: ConnectionState;
  onClose: () => void;
}) {
  const send = useCommand();
  // Bound to the gateway as the dialog first showed it: a switch since sends nothing.
  const [binding] = useState(() => offerBinding(connection));
  const { ask, failure } = useAskFull(binding);
  const [asked, setAsked] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asked) closeRef.current?.focus();
  }, [asked]);
  // Answered in another window: this one asks nothing more by itself.
  const answeredElsewhere = !asked && connection.fullOffer !== "offer";
  useEffect(() => {
    if (answeredElsewhere) onClose();
  }, [answeredElsewhere, onClose]);
  const keep = () => {
    if (binding) void send({ type: "dismissFullControl", ...binding }).catch(() => {});
    onClose();
  };
  const note = failure ?? fullRequestNote(connection);
  return (
    <Dialog
      kind="confirm"
      labelledBy="full-offer-title"
      describedBy="full-offer-text"
      onClose={asked ? onClose : keep}
      testId="full-control-offer"
    >
      <div className="b-confirm full-offer">
        <h2 id="full-offer-title">Give this device full control</h2>
        <p id="full-offer-text">
          This device is paired with {gatewayLabel(connection.gatewayUrl)} with less than full
          control. One request asks the gateway's owner for full control, once.
        </p>
        {asked ? (
          <>
            <p role="status" aria-live="polite" data-testid="full-offer-status">
              {note}
            </p>
            {!connection.fullPairing &&
              connection.upgrade.status === "pending" &&
              connection.upgrade.approveCommand && (
                <CommandLine
                  command={connection.upgrade.approveCommand}
                  label="Copy approve command"
                />
              )}
            <div className="b-actions">
              <button type="button" className="button" ref={closeRef} onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <FullControlConsent />
            <div className="b-actions">
              <button
                type="button"
                className="button"
                data-variant="quiet"
                data-b-focus=""
                onClick={keep}
              >
                Keep current access
              </button>
              <button
                type="button"
                className="button"
                data-variant="primary"
                onClick={() => {
                  setAsked(true);
                  ask();
                }}
              >
                Give this device full control
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

/**
 * The offer in Settings, Gateway, Access, whenever it applies, answered or not: the consent
 * line directly above "Give this device full control".
 */
export function FullControlAsk({ connection }: { connection: ConnectionState }) {
  // As this screen shows the gateway now.
  const { ask, failure } = useAskFull(offerBinding(connection));
  // While it waits, and once approved until the next hello, Settings' own lines say where it stands.
  const waiting =
    isFullRequest(connection) &&
    (connection.upgrade.status === "requesting" ||
      connection.upgrade.status === "pending" ||
      connection.upgrade.status === "approved");
  return (
    <div className="settings-full" data-testid="full-control-ask">
      {failure && (
        <div className="form-error" role="alert">
          {failure}
        </div>
      )}
      {!waiting && (
        <>
          <FullControlConsent />
          <div className="settings-repair-actions">
            <button type="button" className="button" data-size="sm" onClick={ask}>
              Give this device full control
            </button>
          </div>
        </>
      )}
    </div>
  );
}
