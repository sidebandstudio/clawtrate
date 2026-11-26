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
import { useEffect, useRef, useState, type RefObject } from "react";
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

/** A decision on this request is under way: no other is taken until it ends. */
export const DECIDING_WORDS =
  "Deciding this request. Nothing else can be picked for it until it ends.";
/** A decision came back not-allowed: nothing was decided, and the list was read again. */
export const REREAD_WORDS =
  "Nothing was approved or denied. Clawtrate read the waiting devices again; this is the request as it is now.";
export const SPENT_WORDS =
  "A pick on this device already approved nothing for this request. Deny it, then ask again from the waiting device.";

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

/** A request as the sheet showed it, with the connection whose list it came from. */
type Seen = { request: DeviceRequest; listedOn: number };

type Pick =
  | { type: "approveDevice"; code: string }
  | { type: "refuseDevice"; why: "not-mine" | "none-match" };

/**
 * What the sheet shows, and its decisions. The request is kept as it was shown, with the list it
 * came from, and every decision carries that list back. A decision that comes back not-allowed
 * (its list is from an earlier connection, or the request is blocked or being decided) changed
 * nothing: the list is read again and the sheet shows the request as it is now.
 */
export function DeviceRequestView({
  requestId,
  onClose,
}: {
  requestId: string;
  onClose: () => void;
}) {
  const { connection, deviceRequests } = useClawtrateState();
  const bridge = useBridge();
  const send = useCommand();
  const admin = deviceRequests?.access === "admin";
  const listedOn = deviceRequests?.listedOn ?? 0;
  const live = admin
    ? (deviceRequests.requests.find((each) => each.requestId === requestId) ?? null)
    : null;
  // Null after a not-allowed answer: the sheet follows the list until the next pick.
  const [seen, setSeen] = useState<Seen | null>(() => (live ? { request: live, listedOn } : null));
  const [reread, setReread] = useState(false);
  const [stamp] = useState(() => gatewayStamp(connection));
  const [pending, setPending] = useState<Pick | null>(null);
  const [outcome, setOutcome] = useState<DeviceDecision | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (outcome) closeRef.current?.focus();
  }, [outcome]);
  const current: Seen | null = seen ?? (live ? { request: live, listedOn } : null);
  // The list it came from still lists it: what it can take now (a block, a spent pick) is the
  // list's. A list from another connection says nothing about it.
  const fresh = current !== null && current.listedOn === listedOn;
  const request: DeviceRequest | null =
    current && fresh && live
      ? { ...current.request, blocked: live.blocked, spent: live.spent, choices: live.choices }
      : (current?.request ?? null);
  // Taken before the first await, so a second press in the same moment sends nothing.
  const inFlight = useRef(false);
  const decide = (pick: Pick) => {
    if (inFlight.current || !current) return;
    inFlight.current = true;
    setPending(pick);
    setSeen(current);
    setReread(false);
    const sent =
      pick.type === "approveDevice"
        ? bridge.invoke({
            ...pick,
            requestId,
            scopes: current.request.scopes,
            listedOn: current.listedOn,
            stamp,
          })
        : bridge.invoke({ ...pick, requestId, listedOn: current.listedOn, stamp });
    sent
      .then(
        (decision) => {
          if (decision.kind !== "not-allowed") return setOutcome(decision);
          // Nothing was decided: read the list again and show the request as it is now.
          setOutcome(null);
          setSeen(null);
          setReread(true);
          titleRef.current?.focus();
          void send({ type: "readDeviceRequests" }).catch(() => {});
        },
        (error: unknown) =>
          setOutcome({
            kind: "refused",
            message: error instanceof Error ? error.message : String(error),
          }),
      )
      .finally(() => {
        inFlight.current = false;
        setPending(null);
      });
  };
  // Decided elsewhere or gone while open, by the list it came from, before any pick here.
  const ended = !outcome && !pending && (current === null || (fresh && admin && !live));
  const result: DeviceDecision | null =
    outcome ?? (ended ? (admin ? { kind: "gone" } : { kind: "not-allowed" }) : null);
  return (
    <DeviceRequestBody
      gateway={gatewayLabel(connection.gatewayUrl)}
      request={request}
      result={result}
      pending={pending}
      reread={reread}
      onDecide={decide}
      onClose={onClose}
      titleRef={titleRef}
      closeRef={closeRef}
    />
  );
}

/** The sheet's content for what it shows: a request, an outcome, or a decision under way. */
export function DeviceRequestBody({
  gateway,
  request,
  result,
  pending,
  reread = false,
  onDecide,
  onClose,
  titleRef,
  closeRef,
}: {
  gateway: string;
  request: DeviceRequest | null;
  result: DeviceDecision | null;
  /** The decision under way: every decision on this request waits for it. */
  pending: Pick | null;
  /** A decision came back not-allowed and the list was read again. */
  reread?: boolean;
  onDecide: (pick: Pick) => void;
  onClose: () => void;
  titleRef?: RefObject<HTMLHeadingElement | null>;
  closeRef?: RefObject<HTMLButtonElement | null>;
}) {
  const busy = pending !== null;
  const press = (pick: Pick) => () => {
    if (!busy) onDecide(pick);
  };
  const canDeny =
    result?.kind === "wrong-code" ||
    result?.kind === "none-match" ||
    (!result && request?.spent === true);
  return (
    <div className="b-confirm device-ask">
      <h2 id="device-ask-title" tabIndex={-1} ref={titleRef}>
        A device is asking to use this gateway
      </h2>
      <p id="device-ask-lede">
        {gateway}. Approve it only if you started it on a device you can see.
      </p>
      {request && (
        <>
          <dl className="device-facts">
            <div>
              <dt>It says it is</dt>
              <dd>{reported(request.name, "No name given")}</dd>
            </div>
            <div>
              <dt>Platform and app</dt>
              <dd>
                {reported(
                  [request.platform, request.app].filter(Boolean).join(" · ") || null,
                  "Not given",
                )}
              </dd>
            </div>
            <div>
              <dt>Seen by the gateway</dt>
              <dd>{request.remoteIp ? `From ${request.remoteIp}` : "Address not reported"}</dd>
            </div>
            {request.origin && (
              <div>
                <dt>Web page</dt>
                <dd>{reported(request.origin, "")}</dd>
              </div>
            )}
          </dl>
          <p className="device-allowed-title" id="device-allowed">
            It would be allowed to
          </p>
          <ul className="device-allowed" aria-labelledby="device-allowed">
            {request.scopes.map((scope) => (
              <li key={scope}>{ALLOWED_WORDS[scope] ?? scope}</li>
            ))}
          </ul>
        </>
      )}
      {reread && !result && (
        <p className="device-outcome" role="status" data-testid="device-reread">
          {REREAD_WORDS}
        </p>
      )}
      {busy && (
        <p className="device-outcome" role="status" data-testid="device-deciding">
          {DECIDING_WORDS}
        </p>
      )}
      {result ? (
        <p className="device-outcome" role="status" data-testid="device-outcome">
          {decisionWords(result)}
        </p>
      ) : request?.blocked ? (
        <p className="device-outcome" data-testid="device-blocked">
          {BLOCKED_WORDS[request.blocked]}
        </p>
      ) : request?.spent ? (
        <p className="device-outcome" data-testid="device-spent">
          {SPENT_WORDS}
        </p>
      ) : (
        request && (
          <fieldset className="device-pick" aria-busy={busy || undefined}>
            <legend>Which code does the waiting device show?</legend>
            <div className="device-refusals">
              <button
                type="button"
                className="button"
                aria-disabled={busy || undefined}
                onClick={press({ type: "refuseDevice", why: "not-mine" })}
              >
                I didn't start this
              </button>
              <button
                type="button"
                className="button"
                aria-disabled={busy || undefined}
                onClick={press({ type: "refuseDevice", why: "none-match" })}
              >
                None of these match
              </button>
            </div>
            <div className="device-codes">
              {request.choices.map((code) => (
                <button
                  key={code}
                  type="button"
                  className="button device-code"
                  aria-label={`Code ${spokenCode(code)}`}
                  aria-disabled={busy || undefined}
                  aria-pressed={
                    pending?.type === "approveDevice" && pending.code === code ? true : undefined
                  }
                  data-code={code}
                  onClick={press({ type: "approveDevice", code })}
                >
                  {code}
                </button>
              ))}
            </div>
          </fieldset>
        )
      )}
      <div className="b-actions">
        {(canDeny || (request?.blocked && !result)) && (
          <button
            type="button"
            className="button"
            data-tone="danger"
            aria-disabled={busy || undefined}
            onClick={press({ type: "refuseDevice", why: "not-mine" })}
          >
            {request?.blocked && !result ? "I didn't start this" : "Deny it"}
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
          {requests.length > 0 && " What is listed here is from the last read that worked."}
        </p>
      )}
    </section>
  );
}
