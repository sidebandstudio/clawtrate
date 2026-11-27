// Approving a waiting device from inside Clawtrate (docs/design/setup-effortless.md §5): the
// sheet, the requests in Settings, Gateway, the quiet badge and, without admin, a notice. The
// person picks the code the waiting device shows; nothing is typed. The two refusals come
// first, focus starts on the title, outside the decisions, and Escape is "Not now".

import {
  gatewayStamp,
  HostReplyLost,
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
/** A decision came back not-allowed: nothing was decided; the list is being read again. */
export const REREADING_WORDS =
  "Nothing was approved or denied. Clawtrate is reading the waiting devices again.";
/** ...and that read was applied. */
export const REREAD_WORDS =
  "Nothing was approved or denied. Clawtrate read the waiting devices again; this is the request as it is now.";
/** ...and that read failed: the last list read stays, and says so. */
export const rereadFailedWords = (error: string | null) =>
  `Nothing was approved or denied. Clawtrate couldn't read the waiting devices again${error ? `: ${error}` : "."} What is listed here is from the last read that worked.`;
/** After an outcome that isn't known, the list is read to see what the gateway holds now. */
export const CHECKING_WORDS = "Clawtrate is checking the waiting devices again.";
export const CHECKED_WORDS =
  "Clawtrate read the waiting devices again: Settings, Gateway and Settings, Machines show what the gateway holds now.";
export const checkFailedWords = (error: string | null) =>
  `Clawtrate couldn't read the waiting devices again${error ? `: ${error}` : "."}`;
export const SPENT_WORDS =
  "A pick on this device already approved nothing for this request. Deny it, then ask again from the waiting device.";

/** Which decision was asked for: the words of an outcome depend on it. */
export type DecisionAct = "approve" | "deny" | "none-match";

/**
 * What the sheet shows of a decision: the host's answer, or, when the host didn't answer with
 * one, `not-sent` (the host refused it, or it never reached the host: nothing was decided).
 */
export type SheetOutcome = DeviceDecision | { kind: "not-sent"; message: string };

/** What a decision did, in a sentence that is true of it and of what was asked. */
export function decisionWords(decision: SheetOutcome, act: DecisionAct = "approve"): string {
  const none = act === "deny" ? "Nothing was denied." : "Nothing was approved.";
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
    case "undo-unknown":
      return `The gateway paired the device with another ${listWords(decision.what)} than shown. Clawtrate asked to remove that pairing but couldn't confirm it is gone. Look in Settings, Machines.`;
    case "refused":
      return `The gateway refused: ${decision.message} ${none}`;
    case "interrupted":
      return "The connection changed before Clawtrate could approve it. Nothing was approved.";
    case "unread":
      return `Clawtrate couldn't read the request again before approving it: ${decision.message} Nothing was approved.`;
    case "not-sent":
      return `Clawtrate couldn't send this: ${decision.message} ${none}`;
    case "unknown":
      return act === "deny"
        ? "Clawtrate didn't get the gateway's answer, so it can't say whether the request was denied."
        : act === "none-match"
          ? "Clawtrate didn't get an answer, so it can't say whether this pick was kept. Nothing was approved."
          : "Clawtrate didn't get the gateway's answer, so it can't say whether the device was approved. Look in Settings, Machines.";
    case "not-allowed":
      return "This request can't be approved here.";
  }
}

const actOf = (pick: Pick): DecisionAct =>
  pick.type === "approveDevice" ? "approve" : pick.why === "not-mine" ? "deny" : "none-match";

const reported = (text: string | null, none: string) => (text ? `${text} (reported)` : none);

/** The sheet for one request, as it first showed it, until it is closed. */
export function DeviceRequestSheet(props: {
  requestId: string;
  onClose: () => void;
  /** Where focus goes when the control that opened it is gone (its row decided and removed). */
  fallbackFocus?: RefObject<HTMLElement | null>;
}) {
  const { fallbackFocus, ...view } = props;
  return (
    <Dialog
      kind="confirm"
      fallbackFocus={fallbackFocus}
      labelledBy="device-ask-title"
      describedBy="device-ask-lede"
      onClose={props.onClose}
      testId="device-request"
    >
      <DeviceRequestView {...view} />
    </Dialog>
  );
}

/** A request as the sheet showed it, with the connection whose list it came from. */
type Seen = { request: DeviceRequest; listedOn: number };

type Pick =
  | { type: "approveDevice"; code: string }
  | { type: "refuseDevice"; why: "not-mine" | "none-match" };

/**
 * The list read again after a decision: under way, applied, or failed with why. While it is
 * under way after a not-allowed answer, nothing on the request can be decided.
 */
type Check = {
  after: "not-allowed" | "unknown";
  read: "reading" | "read" | "failed";
  error?: string | null;
};

/**
 * What the sheet shows, and its decisions. The request is kept as it was shown, with the list it
 * came from, and every decision carries that list back. A decision that comes back not-allowed
 * (its list is from an earlier connection, or the request is blocked or being decided) changed
 * nothing: the list is read again, and only once that read was applied does the sheet say so and
 * show the request as it is now. An outcome that isn't known has the list read again too.
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
  const admin = deviceRequests?.access === "admin";
  const listedOn = deviceRequests?.listedOn ?? 0;
  const live = admin
    ? (deviceRequests.requests.find((each) => each.requestId === requestId) ?? null)
    : null;
  // Null once a read after a not-allowed answer ended: the sheet follows the list until the next pick.
  const [seen, setSeen] = useState<Seen | null>(() => (live ? { request: live, listedOn } : null));
  const [check, setCheck] = useState<Check | null>(null);
  const [stamp] = useState(() => gatewayStamp(connection));
  const [pending, setPending] = useState<Pick | null>(null);
  const [outcome, setOutcome] = useState<{ shown: SheetOutcome; act: DecisionAct } | null>(null);
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
  /** Read the list again and say how that went; after not-allowed, then follow the list. */
  const readAgain = (after: Check["after"]) => {
    setCheck({ after, read: "reading" });
    const ended = (read: "read" | "failed", error: string | null = null) => {
      if (after === "not-allowed") setSeen(null);
      setCheck({ after, read, error });
    };
    bridge.invoke({ type: "readDeviceRequests" }).then(
      (answer) => (answer?.fresh ? ended("read") : ended("failed", answer?.error ?? null)),
      (error: unknown) => ended("failed", error instanceof Error ? error.message : String(error)),
    );
  };
  // Taken before the first await, so a second press in the same moment sends nothing.
  const inFlight = useRef(false);
  const decide = (pick: Pick) => {
    if (inFlight.current || !current) return;
    inFlight.current = true;
    setPending(pick);
    setSeen(current);
    setCheck(null);
    const act = actOf(pick);
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
          if (decision.kind === "not-allowed") {
            // Nothing was decided: the sheet waits for the list read again before saying so.
            setOutcome(null);
            titleRef.current?.focus();
            readAgain("not-allowed");
            return;
          }
          setOutcome({ shown: decision, act });
          if (decision.kind === "unknown") readAgain("unknown");
        },
        (error: unknown) => {
          // A reply lost with the host link: the host may have acted, so it isn't known. Any
          // other refusal is the host's own, before anything went to the gateway.
          if (error instanceof HostReplyLost) {
            setOutcome({ shown: { kind: "unknown" }, act });
            readAgain("unknown");
          } else
            setOutcome({
              shown: {
                kind: "not-sent",
                message: error instanceof Error ? error.message : String(error),
              },
              act,
            });
        },
      )
      .finally(() => {
        inFlight.current = false;
        setPending(null);
      });
  };
  const rereading = check?.after === "not-allowed" && check.read === "reading";
  // Decided elsewhere or gone while open, by the list it came from, before any pick here.
  const ended =
    !outcome && !pending && !rereading && (current === null || (fresh && admin && !live));
  const result: SheetOutcome | null =
    outcome?.shown ?? (ended ? (admin ? { kind: "gone" } : { kind: "not-allowed" }) : null);
  const note =
    check === null
      ? null
      : check.after === "not-allowed"
        ? outcome
          ? null
          : check.read === "reading"
            ? REREADING_WORDS
            : check.read === "read"
              ? REREAD_WORDS
              : rereadFailedWords(check.error ?? null)
        : check.read === "reading"
          ? CHECKING_WORDS
          : check.read === "read"
            ? CHECKED_WORDS
            : checkFailedWords(check.error ?? null);
  return (
    <DeviceRequestBody
      gateway={gatewayLabel(connection.gatewayUrl)}
      request={request}
      result={result}
      act={outcome?.act ?? "approve"}
      pending={pending}
      held={rereading}
      note={note}
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
  act = "approve",
  pending,
  held = false,
  note = null,
  onDecide,
  onClose,
  titleRef,
  closeRef,
}: {
  gateway: string;
  request: DeviceRequest | null;
  result: SheetOutcome | null;
  /** What was asked for, for the outcome's words. */
  act?: DecisionAct;
  /** The decision under way: every decision on this request waits for it. */
  pending: Pick | null;
  /** No decision can be made yet (the list is being read again after a not-allowed answer). */
  held?: boolean;
  /** What the list read again after a decision says, under the outcome or above the pick. */
  note?: string | null;
  onDecide: (pick: Pick) => void;
  onClose: () => void;
  titleRef?: RefObject<HTMLHeadingElement | null>;
  closeRef?: RefObject<HTMLButtonElement | null>;
}) {
  const busy = pending !== null || held;
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
              <li key={scope}>
                {Object.hasOwn(ALLOWED_WORDS, scope) ? ALLOWED_WORDS[scope] : scope}
              </li>
            ))}
          </ul>
        </>
      )}
      {note && !result && (
        <p className="device-outcome" role="status" data-testid="device-reread">
          {note}
        </p>
      )}
      {pending && (
        <p className="device-outcome" role="status" data-testid="device-deciding">
          {DECIDING_WORDS}
        </p>
      )}
      {result ? (
        <>
          <p className="device-outcome" role="status" data-testid="device-outcome">
            {decisionWords(result, act)}
          </p>
          {note && (
            <p className="device-outcome" role="status" data-testid="device-check">
              {note}
            </p>
          )}
        </>
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

/**
 * The person is typing: a text field has focus, or the composer holds words not yet sent. A sheet
 * opening now would take the keystrokes meant for it.
 */
function typing(): boolean {
  const active = document.activeElement;
  if (
    active instanceof HTMLElement &&
    (active.isContentEditable ||
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLInputElement &&
        !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file"].includes(
          active.type,
        )))
  )
    return true;
  return [...document.querySelectorAll<HTMLTextAreaElement>(".composer-input")].some(
    (input) => input.value.trim() !== "",
  );
}

/**
 * A modal dialog is open anywhere in the window (the shared `Dialog`, or anything marked modal),
 * whoever opened it; the Work drawer, modal only to the shell behind it, isn't one.
 */
function modalOpen(): boolean {
  return document.querySelector('dialog[open], [aria-modal="true"]:not(.work-panel)') !== null;
}

/**
 * The one request the host opens by itself, in the window that has focus when it comes, and only
 * while the person isn't busy: no dialog open (`busy`: Settings, Search, New bot and the others
 * the shell knows) and no typing. Each condition is checked when the host offers the request
 * and again when its answer comes. A request this window took but can't show then isn't opened
 * later by itself: it waits in the rail line and in Settings, Gateway.
 */
export function DeviceRequestPrompt({
  busy,
  onOpenChange,
}: {
  busy: boolean;
  /** The sheet opened or closed: the shell's own keys leave it alone while it is open. */
  onOpenChange?: (open: boolean) => void;
}) {
  const { deviceRequests } = useClawtrateState();
  const bridge = useBridge();
  const [open, setOpen] = useState<string | null>(null);
  const prompt = deviceRequests?.prompt ?? null;
  // The latest `busy`, for an answer that comes after this render.
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  useEffect(() => {
    onOpenChange?.(open !== null);
  }, [open, onOpenChange]);
  useEffect(() => {
    if (!prompt || open || busy) return;
    const free = () => document.hasFocus() && !busyRef.current && !modalOpen() && !typing();
    const take = () => {
      if (!free()) return;
      bridge
        .invoke({ type: "takeDevicePrompt", requestId: prompt })
        .then((answer) => {
          // Again on the answer: focus may have moved, a dialog opened or typing started.
          if (answer.taken && free()) setOpen(prompt);
        })
        .catch(() => {});
    };
    take();
    window.addEventListener("focus", take);
    return () => window.removeEventListener("focus", take);
  }, [prompt, open, busy, bridge]);
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
  // Focus returns here when the row that opened the sheet was decided and left the list.
  const place = useRef<HTMLDivElement>(null);
  // The open sheet stays while the list changes under it, even to empty: it shows what it
  // was opened on and its outcome until it is closed.
  return (
    <div className="device-requests-place" ref={place} tabIndex={-1}>
      <DeviceRequestRows onOpen={setOpen} />
      {open && (
        <DeviceRequestSheet requestId={open} onClose={() => setOpen(null)} fallbackFocus={place} />
      )}
    </div>
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
