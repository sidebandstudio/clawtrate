// Approving a waiting device from inside Clawtrate (docs/design/setup-effortless.md §5): the
// sheet, the requests in Settings, Gateway, the quiet badge and, without admin, a notice. The
// person picks the code the waiting device shows; nothing is typed. The two refusals come
// first, focus starts on the title, outside the decisions, and Escape is "Not now".

import {
  gatewayStamp,
  spokenCode,
  type DeviceDecision,
  type DeviceRequest,
  type DeviceRequestBlock,
} from "@clawtrate/core";
import { useEffect, useRef, useState } from "react";
import { useBridge, useClawtrateState, useCommand } from "./bridge.tsx";
import { Dialog } from "./bots/Dialog.tsx";
import { gatewayLabel } from "./format.ts";

/** What each of the six lets a device do, in plain words. */
export const ALLOWED_WORDS: Record<string, string> = {
  "operator.read": "Read bots, tasks and conversations",
  "operator.write": "Send messages and stop runs",
  "operator.approvals": "Decide what a bot asks to run",
  "operator.questions": "Answer a bot's questions",
  "operator.admin": "Change the gateway's settings, bots and accounts",
  "operator.pairing": "Approve and remove other devices",
};

export const NOTICE_WITHOUT_ADMIN =
  "A device is asking to connect. Approve it in Clawtrate on a device with full control.";

const BLOCKED_WORDS: Record<DeviceRequestBlock, string> = {
  "not-operator":
    "It asks to join as more than an operator device, so Clawtrate doesn't approve it here.",
  repair:
    "This device is already paired and asks for more access. Clawtrate doesn't approve that here.",
  "unknown-scope":
    "It asks for access Clawtrate can't describe, so Clawtrate doesn't approve it here.",
  "bad-key": "Its key doesn't match the device it names, so Clawtrate doesn't approve it here.",
  "same-code":
    "Another waiting device shows the same code, so neither is approved here. Deny both, then ask again from the new device.",
  "too-many":
    "More devices are asking than Clawtrate shows, so none is approved here. Deny the ones you don't know, or approve on the gateway's computer.",
};

const listWords = (what: string[]) => what.join(" and ");

/** What a decision did, in a sentence that is true of it. */
export function decisionWords(decision: DeviceDecision): string {
  switch (decision.kind) {
    case "approved":
      return "Approved. The device connects in a moment.";
    case "wrong-code":
      return "That isn't this request's code, so nothing was approved. This request can't be picked again here.";
    case "none-match":
      return "Nothing was approved. The waiting request isn't from the device you're looking at.";
    case "denied":
      return "Denied. The device can ask again.";
    case "gone":
      return "This request is no longer pending.";
    case "changed":
      return `The request changed after it was shown (its ${listWords(decision.what)}). Nothing was approved.`;
    case "undone":
      return `The gateway paired the device with another ${listWords(decision.what)} than shown, so Clawtrate removed that pairing at once. Nothing stays approved.`;
    case "undo-failed":
      return `The gateway paired the device with another ${listWords(decision.what)} than shown, and Clawtrate couldn't remove it: ${decision.message} Remove it in Settings, Machines.`;
    case "refused":
      return `The gateway refused: ${decision.message} Nothing was approved.`;
    case "interrupted":
      return "The connection changed before Clawtrate could approve it. Nothing was approved.";
    case "unknown":
      return "Clawtrate didn't get the gateway's answer, so it can't say whether the device was approved. Look in Settings, Machines.";
    case "not-allowed":
      return "This request can't be approved here.";
  }
}

const reported = (text: string | null, none: string) => (text ? `${text} (reported)` : none);

/** The sheet for one request, as it first showed it, until it is closed. */
export function DeviceRequestSheet(props: { requestId: string; onClose: () => void }) {
  return (
    <Dialog
      kind="confirm"
      labelledBy="device-ask-title"
      describedBy="device-ask-lede"
      onClose={props.onClose}
      testId="device-request"
    >
      <DeviceRequestView {...props} />
    </Dialog>
  );
}

/** What the sheet shows, and its decisions. */
export function DeviceRequestView({
  requestId,
  onClose,
}: {
  requestId: string;
  onClose: () => void;
}) {
  const { connection, deviceRequests } = useClawtrateState();
  const bridge = useBridge();
  const live = deviceRequests?.requests.find((each) => each.requestId === requestId) ?? null;
  const [shown] = useState<DeviceRequest | null>(live);
  const [stamp] = useState(() => gatewayStamp(connection));
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<DeviceDecision | null>(shown ? null : { kind: "gone" });
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (outcome) closeRef.current?.focus();
  }, [outcome]);
  const decide = (
    command:
      | { type: "approveDevice"; code: string }
      | { type: "refuseDevice"; why: "not-mine" | "none-match" },
  ) => {
    if (busy || !shown) return;
    setBusy(true);
    const sent =
      command.type === "approveDevice"
        ? bridge.invoke({ ...command, requestId, scopes: shown.scopes, stamp })
        : bridge.invoke({ ...command, requestId, stamp });
    sent
      .then(setOutcome, (error: unknown) =>
        setOutcome({
          kind: "refused",
          message: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => setBusy(false));
  };
  // Decided elsewhere or gone while open, before any pick here.
  const ended = !outcome && !busy && shown && !live;
  const result = outcome ?? (ended ? ({ kind: "gone" } as const) : null);
  const canDeny =
    result?.kind === "wrong-code" ||
    result?.kind === "none-match" ||
    (!result && shown?.spent === true);
  return (
    <div className="b-confirm device-ask">
      <h2 id="device-ask-title" tabIndex={-1}>
        A device is asking to use this gateway
      </h2>
      <p id="device-ask-lede">
        {gatewayLabel(connection.gatewayUrl)}. Approve it only if you started it on a device you can
        see.
      </p>
      {shown && (
        <>
          <dl className="device-facts">
            <div>
              <dt>It says it is</dt>
              <dd>{reported(shown.name, "No name given")}</dd>
            </div>
            <div>
              <dt>Platform and app</dt>
              <dd>
                {reported(
                  [shown.platform, shown.app].filter(Boolean).join(" · ") || null,
                  "Not given",
                )}
              </dd>
            </div>
            <div>
              <dt>Seen by the gateway</dt>
              <dd>{shown.remoteIp ? `From ${shown.remoteIp}` : "Address not reported"}</dd>
            </div>
            {shown.origin && (
              <div>
                <dt>Web page</dt>
                <dd>{reported(shown.origin, "")}</dd>
              </div>
            )}
          </dl>
          <p className="device-allowed-title" id="device-allowed">
            It would be allowed to
          </p>
          <ul className="device-allowed" aria-labelledby="device-allowed">
            {shown.scopes.map((scope) => (
              <li key={scope}>{ALLOWED_WORDS[scope] ?? scope}</li>
            ))}
          </ul>
        </>
      )}
      {result ? (
        <p className="device-outcome" role="status" data-testid="device-outcome">
          {decisionWords(result)}
        </p>
      ) : shown?.blocked ? (
        <p className="device-outcome">{BLOCKED_WORDS[shown.blocked]}</p>
      ) : shown?.spent ? (
        <p className="device-outcome">
          A pick on this device already approved nothing for this request. Deny it, then ask again
          from the waiting device.
        </p>
      ) : (
        shown && (
          <fieldset className="device-pick" aria-busy={busy || undefined}>
            <legend>Which code does the waiting device show?</legend>
            <div className="device-refusals">
              <button
                type="button"
                className="button"
                aria-disabled={busy || undefined}
                onClick={() => decide({ type: "refuseDevice", why: "not-mine" })}
              >
                I didn't start this
              </button>
              <button
                type="button"
                className="button"
                aria-disabled={busy || undefined}
                onClick={() => decide({ type: "refuseDevice", why: "none-match" })}
              >
                None of these match
              </button>
            </div>
            <div className="device-codes">
              {shown.choices.map((code) => (
                <button
                  key={code}
                  type="button"
                  className="button device-code"
                  aria-label={`Code ${spokenCode(code)}`}
                  aria-disabled={busy || undefined}
                  data-code={code}
                  onClick={() => decide({ type: "approveDevice", code })}
                >
                  {code}
                </button>
              ))}
            </div>
          </fieldset>
        )
      )}
      <div className="b-actions">
        {(canDeny || (shown?.blocked && !result)) && (
          <button
            type="button"
            className="button"
            data-tone="danger"
            aria-disabled={busy || undefined}
            onClick={() => decide({ type: "refuseDevice", why: "not-mine" })}
          >
            {shown?.blocked ? "I didn't start this" : "Deny it"}
          </button>
        )}
        <button
          type="button"
          className="button"
          data-variant="quiet"
          ref={closeRef}
          onClick={onClose}
        >
          {result ? "Close" : "Not now"}
        </button>
      </div>
    </div>
  );
}

/** The one request the host opens by itself, in the window that has focus when it comes. */
export function DeviceRequestPrompt({ inert }: { inert: boolean }) {
  const { deviceRequests } = useClawtrateState();
  const bridge = useBridge();
  const [open, setOpen] = useState<string | null>(null);
  const prompt = deviceRequests?.prompt ?? null;
  useEffect(() => {
    if (!prompt || open || inert) return;
    const take = () => {
      if (!document.hasFocus()) return;
      bridge
        .invoke({ type: "takeDevicePrompt", requestId: prompt })
        .then((answer) => {
          if (answer.taken) setOpen(prompt);
        })
        .catch(() => {});
    };
    take();
    window.addEventListener("focus", take);
    return () => window.removeEventListener("focus", take);
  }, [prompt, open, inert, bridge]);
  return open ? <DeviceRequestSheet requestId={open} onClose={() => setOpen(null)} /> : null;
}

/** In the rail: waiting requests as one quiet line, or the notice without admin. */
export function DevicesAsking({ onReview }: { onReview: () => void }) {
  const { deviceRequests } = useClawtrateState();
  if (!deviceRequests) return null;
  if (deviceRequests.access === "notice")
    return (
      <div className="rail-notice" data-tone="info" role="status" data-testid="devices-notice">
        <span>{NOTICE_WITHOUT_ADMIN}</span>
      </div>
    );
  const count = deviceRequests.requests.length + deviceRequests.omitted;
  if (deviceRequests.access !== "admin" || count === 0) return null;
  return (
    <div className="rail-notice" data-tone="info" role="status" data-testid="devices-asking">
      <span>
        {count === 1 ? "A device is asking" : `${count} devices are asking`} to use this gateway.
      </span>
      <button type="button" className="button" data-size="sm" onClick={onReview}>
        Review
      </button>
    </div>
  );
}

/** Settings, Gateway: the requests waiting, each opening the sheet. */
export function DeviceRequestsList() {
  const [open, setOpen] = useState<string | null>(null);
  // The open sheet stays while the list changes under it, even to empty: it shows what it
  // was opened on and its outcome until it is closed.
  return (
    <>
      <DeviceRequestRows onOpen={setOpen} />
      {open && <DeviceRequestSheet requestId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function DeviceRequestRows({ onOpen }: { onOpen: (requestId: string) => void }) {
  const { deviceRequests } = useClawtrateState();
  const send = useCommand();
  const admin = deviceRequests?.access === "admin";
  useEffect(() => {
    if (admin) void send({ type: "readDeviceRequests" }).catch(() => {});
  }, [admin, send]);
  if (!deviceRequests || deviceRequests.access === "none") return null;
  if (deviceRequests.access === "notice")
    return (
      <p className="settings-note" data-testid="devices-notice">
        {NOTICE_WITHOUT_ADMIN}
      </p>
    );
  const { requests, omitted, error } = deviceRequests;
  if (requests.length === 0 && !error) return null;
  return (
    <section className="device-requests" aria-labelledby="device-requests-title">
      <h4 id="device-requests-title">Devices asking</h4>
      <ul>
        {requests.map((request) => (
          <li key={request.requestId}>
            <button
              type="button"
              className="button"
              data-variant="quiet"
              onClick={() => onOpen(request.requestId)}
            >
              <span>{reported(request.name, "No name given")}</span>
              <span className="device-request-seen">
                {request.remoteIp ? `From ${request.remoteIp}` : "Address not reported"}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {omitted > 0 && (
        <p className="settings-note">
          {omitted} more {omitted === 1 ? "is" : "are"} waiting. Clawtrate shows the newest{" "}
          {requests.length}.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          Clawtrate couldn't read the waiting devices: {error}
        </p>
      )}
    </section>
  );
}
