import type { ConnectionState, HostInfo } from "@clawtrate/core";
import { readOnlyWords } from "./conversation-words.ts";
import { useEffect, useState, type ReactNode } from "react";
import { useCommand } from "./bridge.tsx";
import { copyText } from "./clipboard.ts";
import { CommandLine } from "./ConnectScreen.tsx";
import { CheckIcon, CopyIcon, EyeIcon } from "./icons.tsx";

/**
 * What stands in the composer's place on the read tier (conversation.md,
 * section 3). One request covers sending, stopping and answering; it is made
 * only when the person chooses "Request access", never silently, and never
 * for admin. The command and the request id are the host's. The engine waits
 * on the gateway's answer continuously (`device.scopes.waitUpgrade`), so the
 * bar says it updates by itself and offers no "Check now" and no countdown;
 * nor "Cancel request", since the gateway has no way to withdraw a request
 * it holds.
 */
export function AccessBar({
  bot,
  connection,
  info,
}: {
  bot: string;
  connection: ConnectionState;
  info: HostInfo;
}) {
  const send = useCommand();
  const ask = () => void send({ type: "requestAccess" }).catch(() => {});
  const upgrade = connection.upgrade;

  let tone: "danger" | undefined;
  let body: ReactNode;
  let action: ReactNode = null;
  if (info.readOnly) {
    body = (
      <>
        <b>{readOnlyWords(bot).lead}</b>
        {readOnlyWords(bot).rest}
      </>
    );
  } else {
    switch (upgrade.status) {
      case "requesting":
        body = "Asking the gateway…";
        break;
      case "approved":
        body = (
          <>
            <b>Approved.</b> Connecting again with the new access…
          </>
        );
        break;
      case "pending":
        body = (
          <>
            <b>Waiting for the gateway's owner.</b>
            {upgrade.approveCommand
              ? " Approve this request on the gateway's machine:"
              : " The owner approves this request on the gateway's machine."}
          </>
        );
        break;
      case "rejected":
        body = (
          <>
            <b>The request was denied.</b> Nothing changed. This device can still read.
          </>
        );
        action = (
          <button type="button" className="button" onClick={ask}>
            Request again
          </button>
        );
        break;
      case "expired":
        body = (
          <>
            <b>The request expired</b> before it was approved.
          </>
        );
        action = (
          <button type="button" className="button" onClick={ask}>
            Request again
          </button>
        );
        break;
      case "error":
        tone = "danger";
        body = (
          <>
            <b>Couldn't send the request.</b> {upgrade.error}
          </>
        );
        action = (
          <button type="button" className="button" onClick={ask}>
            Try again
          </button>
        );
        break;
      case "idle":
        body = (
          <>
            <b>{readOnlyWords(bot).lead}</b>
            {readOnlyWords(bot).rest}
          </>
        );
        action = (
          <button type="button" className="button" data-variant="primary" onClick={ask}>
            Request access
          </button>
        );
        break;
    }
  }

  // Asking needs the gateway: while the connection is down the bar only explains.
  if (connection.status !== "connected") action = null;
  const pending = !info.readOnly && upgrade.status === "pending";
  return (
    <footer className="composer" data-readonly="true">
      <div className="composer-inner">
        <section
          className="access-bar"
          role="region"
          aria-label="Access"
          data-tone={tone}
          data-status={info.readOnly ? "pinned" : upgrade.status}
          data-testid="access-bar"
        >
          <div className="access-row">
            <EyeIcon />
            <span className="shelf-text" aria-live="polite">
              {body}
            </span>
            {action}
          </div>
          {pending && upgrade.approveCommand && (
            <CommandLine command={upgrade.approveCommand} label="Copy approve command" />
          )}
          {pending && (
            <p className="access-wait" data-testid="access-wait">
              This changes by itself as soon as the owner approves or denies the request, or it
              expires.
            </p>
          )}
          {pending && upgrade.requestId && (
            <div className="access-id">
              <span className="mono">Request {upgrade.requestId.slice(0, 8)}</span>
              <CopyValue value={upgrade.requestId} label="Copy request id" />
              {upgrade.approveNote && <span>{upgrade.approveNote}</span>}
            </div>
          )}
        </section>
      </div>
    </footer>
  );
}

/** A small copy button for one value, named for exactly what it copies. */
export function CopyValue({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1400);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className="icon-button copy"
      data-variant="quiet"
      aria-label={label}
      title={state === "copied" ? "Copied" : label}
      data-copied={state === "copied" || undefined}
      onClick={() => void copyText(value).then(setState)}
    >
      {state === "copied" ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}
