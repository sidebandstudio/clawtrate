// Full control, explained before Connect and reported after it
// (docs/design/setup-effortless.md §2, "Consent before Connect"; §8, a narrower grant).
// Every sentence is the design's fixed copy.

import { FULL_SCOPES, PAIRING_SCOPE, scopeSatisfied, type ConnectionState } from "@clawtrate/core";
import { useId, useState } from "react";

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
