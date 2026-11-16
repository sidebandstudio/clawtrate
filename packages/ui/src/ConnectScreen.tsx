import type { ConnectionState, HostInfo } from "@clawtrate/core";
import { useEffect, useRef, useState, type FormEvent } from "react";
import logoUrl from "./assets/logo-mark.png";
import { useCommand } from "./bridge.tsx";
import { copyText, selectContents, type CopyResult } from "./clipboard.ts";
import { gatewayLabel } from "./format.ts";
import { CheckIcon, CopyIcon } from "./icons.tsx";

export const PRODUCT_NAME = "Clawtrate";
export const SLOGAN = "Your OpenClaw agents, orchestrated.";

/** A command with a copy button that works over plain http too, or says how to copy by hand. */
export function CommandLine({ command, label }: { command: string; label: string }) {
  const [state, setState] = useState<"idle" | CopyResult>("idle");
  const codeRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    const result = await copyText(command);
    if (result === "manual" && codeRef.current) selectContents(codeRef.current);
    setState(result);
  };
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘C" : "Ctrl+C";
  return (
    <>
      <div className="command">
        <code ref={codeRef}>{command}</code>
        <button
          type="button"
          className="icon-button"
          aria-label={state === "copied" ? "Copied" : label}
          title={state === "copied" ? "Copied" : label}
          onClick={() => void copy()}
        >
          {state === "copied" ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
      <p className="copy-status" role="status" aria-live="polite">
        {state === "copied"
          ? "Copied."
          : state === "manual"
            ? `Selected. Press ${shortcut} to copy.`
            : ""}
      </p>
    </>
  );
}

function Countdown({ until }: { until: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  if (until === null) return null;
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  return <>{seconds > 0 ? ` in ${seconds}s` : " now"}</>;
}

function PairingPanel({ connection }: { connection: ConnectionState }) {
  const send = useCommand();
  const pairing = connection.pairing!;
  return (
    <section className="panel" aria-labelledby="pair-title">
      <h2 id="pair-title">Approve this device</h2>
      <p className="panel-lede">
        {gatewayLabel(connection.gatewayUrl)} has not seen this device before. It is approved once;
        after that it connects with its own device token.
      </p>
      <ol className="pair-steps">
        <li className="pair-step" data-state="done">
          <span className="pair-marker">
            <CheckIcon width={12} height={12} />
          </span>
          <div>
            <h3>Pairing requested</h3>
            <p>
              Request <span className="request-id">{pairing.requestId.slice(0, 8)}</span> asks for{" "}
              {pairing.requestedScopes.join(", ") || "no scopes"}.
            </p>
          </div>
        </li>
        <li className="pair-step" data-state="active">
          <span className="pair-marker">2</span>
          <div>
            <h3>Approve the request</h3>
            <p>{pairing.approveNote ?? "Run this in the repository that started the gateway:"}</p>
            <CommandLine command={pairing.approveCommand} label="Copy approve command" />
          </div>
        </li>
        <li className="pair-step" data-state="pending">
          <span className="pair-marker">3</span>
          <div>
            <h3>Connect</h3>
            <p className="waiting" role="status">
              <span className="run-node" aria-hidden="true" />
              Waiting for approval, checking again
              <Countdown until={connection.retryAt} />
            </p>
          </div>
        </li>
      </ol>
      <div className="actions">
        <button
          type="button"
          className="button"
          data-variant="primary"
          onClick={() => void send({ type: "retry" })}
        >
          Check now
        </button>
        <button type="button" className="button" onClick={() => void send({ type: "disconnect" })}>
          Use another gateway
        </button>
      </div>
    </section>
  );
}

function ConnectForm({ connection, info }: { connection: ConnectionState; info: HostInfo }) {
  const send = useCommand();
  const [url, setUrl] = useState(connection.gatewayUrl ?? info.devGateway?.url ?? "");
  const [token, setToken] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const busy = connection.status === "connecting";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitError(null);
    send({ type: "connect", url, token: token || null }).catch((error: unknown) =>
      setSubmitError(error instanceof Error ? error.message : String(error)),
    );
  };

  const error = submitError
    ? { title: "Could not connect", message: submitError, hint: null }
    : connection.error
      ? {
          title: connection.error.code,
          message: connection.error.message,
          hint: connection.error.hint,
        }
      : null;

  return (
    <section className="panel" aria-labelledby="connect-title">
      <h2 id="connect-title">Connect to your gateway</h2>
      <p className="panel-lede">
        Clawtrate connects to an OpenClaw gateway you already run. This version is read-only: it
        asks for <code>operator.read</code> and nothing more.
      </p>
      {info.devGateway && (
        <>
          <button
            type="button"
            className="button"
            data-variant="primary"
            style={{ width: "100%" }}
            disabled={busy}
            onClick={() => void send({ type: "connectDevGateway" })}
          >
            Use the development gateway
          </button>
          <p className="field-hint" style={{ textAlign: "center" }}>
            {gatewayLabel(info.devGateway.url)}, started with <code>pnpm dev-gateway up</code>
          </p>
          <div className="divider">or connect to another</div>
        </>
      )}
      <form onSubmit={submit}>
        <label className="field">
          <span className="field-label">
            <span>Gateway URL</span>
          </span>
          <input
            className="input"
            name="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="wss://gateway.example.com"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </label>
        <label className="field">
          <span className="field-label">
            <span>Gateway token</span>
            <span>first pairing only</span>
          </span>
          <input
            className="input"
            name="token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Shared bootstrap token"
            autoComplete="off"
          />
          <p className="field-hint">
            Used once to request pairing. After approval Clawtrate keeps only its device token.
          </p>
        </label>
        <div className="actions">
          <button
            type="submit"
            className="button"
            data-variant={info.devGateway ? undefined : "primary"}
            disabled={busy}
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </form>
      {error && (
        <div className="form-error" role="alert">
          <strong>{error.title}</strong>
          {error.message}
          {error.hint && <div>{error.hint}</div>}
        </div>
      )}
    </section>
  );
}

export function ConnectScreen({
  connection,
  info,
}: {
  connection: ConnectionState;
  info: HostInfo;
}) {
  return (
    <main className="connect">
      <div className="connect-drag" />
      <div className="connect-card">
        <header className="connect-brand">
          <img src={logoUrl} alt="" />
          <div>
            <h1>{PRODUCT_NAME}</h1>
            <p>{SLOGAN}</p>
          </div>
        </header>
        {connection.status === "pairing" && connection.pairing ? (
          <PairingPanel connection={connection} />
        ) : (
          <ConnectForm connection={connection} info={info} />
        )}
        <p className="connect-foot">
          {connection.deviceId
            ? `This device: ${connection.deviceId.slice(0, 12)}…`
            : "Preparing device identity…"}
          {" · "}
          {info.kind === "web" ? "Web preview" : "Desktop"} {info.version}
        </p>
      </div>
    </main>
  );
}
