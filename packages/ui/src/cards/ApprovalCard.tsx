// Approval cards (conversation.md section 12). A safety surface: Deny is
// always there, an allow is offered only when the request offers it, never
// again while a decision's outcome is unknown, and never while the text
// decided on was cut and has not been read whole.

import type { ApprovalCard as Approval, ApprovalDecision } from "@clawtrate/core";
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useCardEnv, useMinuteClock } from "./context.tsx";
import {
  allowLabel,
  approvalLine,
  approvalView,
  decisionPhase,
  expiryLine,
  resolvedView,
  sendableDecisions,
  type ApprovalView,
} from "./model.ts";
import {
  CardFoot,
  ChevronIcon,
  CopyButton,
  Fields,
  useRawDisclosure,
  WarningIcon,
  type RawContent,
} from "./parts.tsx";

const EVENT_NAMES: Record<Approval["kind"], string> = {
  exec: "exec.approval.requested",
  plugin: "plugin.approval.requested",
  "system-agent": "openclaw.approval.requested",
};

function approvalRaw(card: Approval): RawContent {
  const record = card.raw as Record<string, unknown> | null;
  const label =
    record && typeof record === "object" && "presentation" in record
      ? "approval.get, as the gateway sent it"
      : `${EVENT_NAMES[card.kind]}, as the gateway sent it`;
  const ids = [
    { label: "Approval", value: card.id },
    ...(card.toolCallId ? [{ label: "Tool call", value: card.toolCallId }] : []),
    ...(card.runId ? [{ label: "Run", value: card.runId }] : []),
    ...(card.sessionKey ? [{ label: "Session", value: card.sessionKey }] : []),
  ];
  const notes: string[] = [];
  if (record === null) notes.push("The request was too long for this app to keep as received.");
  if (card.status !== "pending") notes.push("This app does not keep the event that settled it.");
  return {
    state: "loaded",
    events: record === null ? [] : [[label, record]],
    ids,
    ...(notes.length ? { notes } : {}),
  };
}

/** The whole text of a cut request, read through the engine, with its digest. */
type WholeText = { text: string; digest: string };

function wholeText(value: Record<string, string | string[] | null>): string {
  return Object.values(value)
    .filter((part) => part !== null)
    .map((part) => (Array.isArray(part) ? part.join(" ") : part))
    .filter((part) => part !== "")
    .join("\n");
}

/** Arguments one by one, so their boundaries survive. */
function ArgumentList({ args }: { args: string[] }) {
  return (
    <ol className="request-args" aria-label="Arguments">
      {args.map((arg, index) => (
        <li key={index}>
          <code>{arg}</code>
        </li>
      ))}
    </ol>
  );
}

function FullRequest({
  view,
  card,
  whole,
  open,
}: {
  view: ApprovalView;
  card: Approval;
  whole: WholeText | null;
  open?: boolean;
}) {
  const exact = whole ? { label: view.exact?.label ?? "Request", text: whole.text } : view.exact;
  return (
    <details className="request-full" open={open}>
      <summary>
        <span className="when-closed">Show full request</span>
        <span className="when-open">Hide full request</span>
        <ChevronIcon className="chevron" />
      </summary>
      <div className="request-inset">
        {exact && (
          <div className="command-line">
            <code>{exact.text}</code>
            <CopyButton what={exact.label.toLowerCase()} text={exact.text} />
          </div>
        )}
        {view.argv && !whole && (
          <>
            <p className="code-label">Arguments</p>
            <ArgumentList args={view.argv} />
          </>
        )}
        {card.decisionCut && !whole && (
          <p className="request-cause">
            This shows the first part of a longer request. Read it whole before allowing it.
          </p>
        )}
        <Fields rows={view.rows.filter((row) => !row.list)} />
      </div>
    </details>
  );
}

export function ApprovalCardView({ card, domId }: { card: Approval; domId: string }) {
  const env = useCardEnv();
  const run = env.runOf(card.runId);
  const view = approvalView(card, env.bots, env.bot);
  const section = useRef<HTMLElement>(null);
  const resolvedLine = useRef<HTMLElement>(null);
  const focusInside = useRef(false);
  const wasPending = useRef(card.status === "pending");
  const raw = useRawDisclosure();

  // When the card resolves while focus is inside it, focus moves to the resolved card's line.
  useLayoutEffect(() => {
    if (wasPending.current && card.status !== "pending" && focusInside.current) {
      resolvedLine.current?.focus();
    }
    wasPending.current = card.status === "pending";
  }, [card.status]);

  const track = {
    onFocus: () => (focusInside.current = true),
    onBlur: (event: React.FocusEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        focusInside.current = false;
      }
    },
  };

  if (card.status !== "pending") {
    const outcome = resolvedView(card, env.bots, env.bot, run);
    const when = card.resolvedAt ?? card.expiresAt;
    return (
      <details
        className="card request"
        data-kind="approval"
        data-state={card.status}
        data-resolved=""
        id={domId}
        data-testid="approval-card"
        {...track}
      >
        <summary ref={resolvedLine}>
          <span className="tag" data-tone={outcome.tone ?? undefined}>
            {outcome.tag}
          </span>
          <span className="request-line" title={approvalLine(card, view)}>
            {approvalLine(card, view)}
          </span>
          <time className="request-when">
            {when
              ? new Date(when).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
              : ""}
          </time>
          <ChevronIcon className="chevron" />
        </summary>
        <div className="request-resolved-body">
          <p>
            {outcome.sentence}
            {outcome.winner ? ` ${outcome.winner}` : ""}
          </p>
          {outcome.saved && <p>{outcome.saved}</p>}
          <FullRequest view={view} card={card} whole={null} open />
          <CardFoot disclosure={raw} raw={approvalRaw(card)} />
        </div>
      </details>
    );
  }

  return (
    <PendingApproval
      card={card}
      view={view}
      domId={domId}
      section={section}
      track={track}
      raw={raw}
    />
  );
}

function PendingApproval({
  card,
  view,
  domId,
  section,
  track,
  raw,
}: {
  card: Approval;
  view: ApprovalView;
  domId: string;
  section: React.RefObject<HTMLElement | null>;
  track: { onFocus: () => void; onBlur: (event: React.FocusEvent) => void };
  raw: ReturnType<typeof useRawDisclosure>;
}) {
  const env = useCardEnv();
  const now = useMinuteClock();
  const [formOpen, setFormOpen] = useState(false);
  const [chosen, setChosen] = useState<ApprovalDecision | null>(null);
  const [days, setDays] = useState("");
  const [whole, setWhole] = useState<WholeText | null>(null);
  const [reading, setReading] = useState<"idle" | "loading" | "failed">("idle");
  const [checking, setChecking] = useState(false);
  const alwaysButton = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const phase = decisionPhase(card);
  const sendable = sendableDecisions(card, whole !== null);
  const name = env.bot?.name ?? "The bot";
  // Without approval access nothing here decides: no button, no shortcut, no command.
  const mayDecide = env.connection.canApprove;
  const readOnly = env.connected && !mayDecide;

  const daysValue = days.trim() === "" ? null : Number(days);
  const daysInvalid =
    daysValue !== null && (!Number.isInteger(daysValue) || daysValue < 1 || daysValue > 3650);

  const decide = (decision: ApprovalDecision) => {
    if (!mayDecide) return;
    // A second decision while one is on its way is only ever Deny, which the gateway may still take.
    if (!sendable.has(decision) || (card.submitting && decision !== "deny")) return;
    if (card.submitting && chosen === "deny") return;
    setChosen(decision);
    void env
      .invoke({
        type: "resolveApproval",
        key: env.taskKey,
        approvalId: card.id,
        decision,
        expiresInDays: decision === "allow-always" && view.form.days ? daysValue : null,
        shownDigest: decision !== "deny" && whole ? whole.digest : null,
      })
      .catch(() => undefined);
  };

  const readWhole = () => {
    setReading("loading");
    env
      .invoke({ type: "readApprovalText", key: env.taskKey, approvalId: card.id })
      .then((result) => {
        setWhole({ text: wholeText(result.text), digest: result.digest });
        setReading("idle");
      })
      .catch(() => setReading("failed"));
  };

  const checkAgain = () => {
    setChecking(true);
    void env
      .invoke({ type: "checkApproval", key: env.taskKey, approvalId: card.id })
      .catch(() => undefined)
      .finally(() => setChecking(false));
  };

  const openForm = () => {
    setFormOpen(true);
    requestAnimationFrame(() => saveButton.current?.focus());
  };
  const closeForm = () => {
    setFormOpen(false);
    requestAnimationFrame(() => alwaysButton.current?.focus());
  };

  // ⌘↵ inside the card is Allow once, or Allow and save with the form open. Deny has no shortcut.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      if (phase !== "choose" || !mayDecide) return;
      if (formOpen) {
        if (!daysInvalid) decide("allow-always");
      } else if (view.once) decide("allow-once");
      return;
    }
    if (event.key === "Escape" && formOpen && phase !== "sending") {
      event.stopPropagation();
      closeForm();
    }
  };

  const sending = phase === "sending";
  const denyButton = (
    <button
      type="button"
      className="button"
      data-variant="quiet"
      data-decision="deny"
      aria-disabled={(sending && chosen === "deny") || undefined}
      onClick={() => decide("deny")}
    >
      {sending && chosen === "deny" ? "Sending…" : "Deny"}
    </button>
  );

  /** The line where the form's sentence, or the decision's outcome, goes. */
  const outcomeLine = (sentence: ReactNode): ReactNode =>
    sending ? (
      <p className="standing-outcome" aria-busy="true">
        Sending your decision…
      </p>
    ) : phase === "refused" ? (
      <div className="standing-error" role="alert">
        <b>The gateway refused this decision.</b> {card.error}
        {card.stillOpen ? " The request is still open." : ""}
      </div>
    ) : phase === "unknown" ? (
      <div className="standing-note" role="status">
        <WarningIcon />
        <span>
          <b>No answer from the gateway says what happened.</b> Your decision may or may not have
          been applied.
        </span>
      </div>
    ) : (
      sentence
    );

  // A refused decision this view sent can be tried again; one refused before this view
  // was opened leaves the ordinary choices beside the refusal.
  const retrying =
    phase === "refused" && chosen !== null && chosen !== "deny" && sendable.has(chosen);
  /** The buttons for a decision that failed: try again, or check. */
  const afterFailure =
    phase === "unknown" ? (
      <button
        type="button"
        className="button"
        data-variant="primary"
        disabled={checking}
        onClick={checkAgain}
      >
        {checking ? "Checking…" : "Check again"}
      </button>
    ) : retrying && chosen ? (
      <>
        <button
          type="button"
          className="button"
          data-variant="primary"
          onClick={() => decide(chosen)}
        >
          Try again
        </button>
        {chosen === "allow-always" && sendable.has("allow-once") && (
          <button type="button" className="button" onClick={() => decide("allow-once")}>
            Allow once instead
          </button>
        )}
      </>
    ) : null;

  const allowOnce = view.once && sendable.has("allow-once") && (
    <button
      type="button"
      className="button"
      data-variant="primary"
      data-decision="allow-once"
      aria-disabled={sending || undefined}
      onClick={() => decide("allow-once")}
    >
      {sending && chosen === "allow-once" ? "Sending…" : allowLabel(view)}
    </button>
  );
  const alwaysAllow = view.always && sendable.has("allow-always") && !sending && (
    <button
      ref={alwaysButton}
      type="button"
      className="button"
      aria-expanded={formOpen}
      aria-disabled={sending || undefined}
      onClick={() => !sending && openForm()}
    >
      Always allow…
    </button>
  );

  const failureOrSending = phase !== "choose";
  const failed = phase === "unknown" || retrying;
  const formShown = formOpen && view.always;

  return (
    <section
      ref={section}
      className="card request"
      data-kind="approval"
      data-state="pending"
      data-pending="true"
      id={domId}
      tabIndex={-1}
      role="region"
      aria-label={`${view.title}. Needs approval.`}
      data-testid="approval-card"
      onKeyDown={onKeyDown}
      {...track}
    >
      <header className="request-head">
        <h3 className="request-title">{view.title}</h3>
        <span className="tag" data-tone="warn">
          Needs approval
        </span>
      </header>
      <p className="request-summary">
        {view.summary.lead}
        {view.summary.code && (
          <code className="request-code" title={view.summary.codeFull ?? undefined}>
            {view.summary.code}
          </code>
        )}
        {view.summary.middle}
        {view.summary.machine && <b>{view.summary.machine}</b>}
        {view.summary.code ? "." : ""}
      </p>
      {view.askerLine && <p className="request-asker">{view.askerLine}</p>}
      {view.warnings.length > 0 && (
        <ul className="request-warnings">
          {view.warnings.map((warning) => (
            <li key={warning}>
              <WarningIcon />
              {warning}
            </li>
          ))}
        </ul>
      )}
      {card.runEnded && (
        <p className="request-ended">
          {name}'s run has ended. This request is still open, and you can still answer it.
        </p>
      )}
      <FullRequest view={view} card={card} whole={whole} />
      {readOnly ? (
        <>
          <p className="request-ended">
            You can read this request but not answer it from this device.
          </p>
          <div className="request-actions">
            <button
              type="button"
              className="button"
              data-variant="primary"
              onClick={() => void env.send({ type: "requestAccess" })}
            >
              Request access
            </button>
          </div>
        </>
      ) : (
        <>
          {card.decisionCut && !whole && (
            <div className="standing-note" role="note">
              <WarningIcon />
              <span>
                <b>This request is longer than this app keeps.</b>{" "}
                {reading === "failed"
                  ? "Couldn't read it whole. Only Deny is offered until it is read."
                  : "Only Deny is offered until you read it whole."}{" "}
                <button
                  type="button"
                  className="link-button"
                  disabled={reading === "loading"}
                  onClick={readWhole}
                >
                  {reading === "loading" ? "Reading…" : "Read the whole request"}
                </button>
              </span>
            </div>
          )}
          {!formShown && (
            <>
              {failureOrSending && outcomeLine(null)}
              <div className="request-actions" data-row="main">
                {failed ? afterFailure : allowOnce}
                {!failed && alwaysAllow}
                <span className="spacer" />
                {denyButton}
              </div>
            </>
          )}
          {formShown && (
            <div className="standing" role="group" aria-label="Always allow">
              <dl className="standing-grid">
                {view.form.rows.map((row) => (
                  <div key={row.label} className="standing-row">
                    <dt>{row.label}</dt>
                    <dd>
                      {row.list ? (
                        <ArgumentList args={row.list} />
                      ) : row.mono ? (
                        <code className="tool-name">{row.value}</code>
                      ) : (
                        row.value
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
              {outcomeLine(<p className="standing-outcome">{view.form.sentence}</p>)}
              {view.form.days && phase === "choose" && (
                <>
                  <label className="days">
                    Lasts
                    <input
                      type="number"
                      min={1}
                      max={3650}
                      step={1}
                      inputMode="numeric"
                      placeholder="default"
                      aria-label="Number of days"
                      aria-invalid={daysInvalid}
                      aria-describedby={daysInvalid ? `${domId}-days` : undefined}
                      value={days}
                      onChange={(event) => setDays(event.target.value)}
                    />
                    days
                  </label>
                  {daysInvalid && (
                    <p className="days-error" id={`${domId}-days`}>
                      Between 1 and 3650 days.
                    </p>
                  )}
                </>
              )}
              <div className="request-actions">
                {failed ? (
                  afterFailure
                ) : (
                  <button
                    ref={saveButton}
                    type="button"
                    className="button"
                    data-variant="primary"
                    disabled={daysInvalid}
                    aria-disabled={sending || undefined}
                    onClick={() => decide("allow-always")}
                  >
                    {sending && chosen === "allow-always" ? "Sending…" : "Allow and save"}
                  </button>
                )}
                {phase !== "unknown" && (
                  <button
                    type="button"
                    className="button"
                    data-variant="quiet"
                    aria-disabled={sending || undefined}
                    onClick={() => !sending && closeForm()}
                  >
                    Back
                  </button>
                )}
                <span className="spacer" />
                {denyButton}
              </div>
            </div>
          )}
        </>
      )}
      {expiryLine(card, now) && <p className="request-foot">{expiryLine(card, now)}</p>}
      <CardFoot disclosure={raw} raw={approvalRaw(card)} />
    </section>
  );
}
