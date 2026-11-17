import type { ConnectionState, HostInfo } from "@clawtrate/core";
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import logoUrl from "./assets/logo-mark.png";
import { Character, type CharacterSpec } from "./Avatar.tsx";
import { useCommand } from "./bridge.tsx";
import { copyText, selectContents, type CopyResult } from "./clipboard.ts";
import { gatewayLabel } from "./format.ts";
import { CheckIcon, CopyIcon, EyeIcon } from "./icons.tsx";

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
          data-variant="quiet"
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

/** What a requested scope lets this device do, in plain words. */
const SCOPE_WORDS: Record<string, string> = {
  "operator.read": "Read bots, tasks and conversations",
};

function PairingPanel({ connection }: { connection: ConnectionState }) {
  const send = useCommand();
  const pairing = connection.pairing!;
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  // While it checks, the button stays focusable (aria-disabled, not disabled),
  // so keyboard focus is still on it when a check finds nothing.
  const check = async () => {
    if (checking) return;
    setChecking(true);
    try {
      await send({ type: "retry" });
    } finally {
      setChecking(false);
      setChecked(true);
    }
  };
  return (
    <section className="panel" aria-labelledby="pair-title">
      <h2 id="pair-title">Approve this device</h2>
      <p className="panel-lede">
        {gatewayLabel(connection.gatewayUrl)} has not seen this device before. Approve it once on
        the gateway's machine and {PRODUCT_NAME} connects by itself.
      </p>
      {pairing.approveNote && <p className="approve-note">{pairing.approveNote}</p>}
      <CommandLine command={pairing.approveCommand} label="Copy approve command" />
      <p className="waiting" role="status">
        <span className="status-dot" data-status="pairing" aria-hidden="true" />
        <span>
          {checked ? "Not approved yet, checking again" : "Waiting for approval, checking again"}
          <Countdown until={connection.retryAt} />
        </span>
      </p>
      <ul className="scopes" aria-label="This device asks to">
        {pairing.requestedScopes.map((scope) => (
          <li key={scope}>
            <EyeIcon />
            {SCOPE_WORDS[scope] ?? scope}
          </li>
        ))}
      </ul>
      <div className="actions">
        <button
          type="button"
          className="button"
          data-size="lg"
          aria-disabled={checking || undefined}
          onClick={() => void check()}
        >
          {checking ? "Checking…" : "Check now"}
        </button>
        <button
          type="button"
          className="button"
          data-variant="quiet"
          data-size="lg"
          onClick={() => void send({ type: "disconnect" })}
        >
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
  const [submitError, setSubmitError] = useState<{ title: string; message: string } | null>(null);
  const busy = connection.status === "connecting";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim()) {
      setSubmitError({
        title: "Enter the gateway's address",
        message: "It looks like ws://host:port or wss://host.",
      });
      return;
    }
    setSubmitError(null);
    send({ type: "connect", url: url.trim(), token: token || null }).catch((error: unknown) =>
      setSubmitError({
        title: "Could not connect",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const error = submitError
    ? { ...submitError, hint: null, code: null }
    : connection.error
      ? {
          title: "Could not connect",
          message: connection.error.message,
          hint: connection.error.hint,
          code: connection.error.code,
        }
      : null;

  return (
    <section className="panel" aria-labelledby="connect-title">
      <h2 id="connect-title" className="visually-hidden">
        Connect to your gateway
      </h2>
      <form onSubmit={submit} noValidate>
        <label className="field">
          <span className="visually-hidden">Gateway address</span>
          <input
            className="input"
            name="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="Gateway address"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span className="visually-hidden">Gateway token, needed for the first pairing only</span>
          <input
            className="input"
            name="token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Token, for the first pairing only"
            autoComplete="off"
          />
        </label>
        {error && (
          <div className="form-error" role="alert">
            <strong>{error.title}</strong>
            {error.message}
            {error.hint && ` ${error.hint}`}
            {error.code && <span className="form-error-code">{error.code}</span>}
          </div>
        )}
        <div className="actions">
          <button
            type="submit"
            className="button"
            data-variant="primary"
            data-size="lg"
            disabled={busy}
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
          {info.devGateway && (
            <button
              type="button"
              className="button"
              data-variant="quiet"
              data-size="lg"
              disabled={busy}
              title={`${gatewayLabel(info.devGateway.url)}, started with pnpm dev-gateway up`}
              onClick={() => void send({ type: "connectDevGateway" })}
            >
              Use the development gateway
            </button>
          )}
        </div>
        <p className="field-hint">
          {PRODUCT_NAME} works with an OpenClaw gateway you already run. It asks for read access
          only, and the token is used once.
        </p>
      </form>
    </section>
  );
}

/** The characters along the foot of the connection screens. Decoration only. */
const ENSEMBLE: Array<CharacterSpec & { size: number; sink: number; lean: number }> = [
  {
    body: "drop",
    color: "#45bdf5",
    tilt: 3,
    look: [0.3, 0.5],
    lift: 1,
    size: 132,
    sink: -0.3,
    lean: -8,
  },
  {
    body: "arch",
    color: "#ff8552",
    tilt: 5,
    look: [-0.7, 0.3],
    lift: -1.5,
    size: 176,
    sink: -0.26,
    lean: 5,
  },
  { body: "disc", color: "#f6bd3b", tilt: 6, look: [0.8, 0], size: 118, sink: -0.2, lean: -4 },
  { body: "block", color: "#5b8dff", tilt: 0, look: [0.9, 0.2], size: 204, sink: -0.3, lean: 3 },
  {
    body: "pebble",
    color: "#58c26f",
    tilt: -7,
    look: [0.6, -0.3],
    size: 160,
    sink: -0.24,
    lean: -6,
  },
  { body: "hex", color: "#ff6f9c", tilt: -4, look: [-0.8, 0.2], size: 124, sink: -0.26, lean: 7 },
  { body: "bloom", color: "#a98bff", tilt: -5, look: [0, -0.5], size: 186, sink: -0.28, lean: -3 },
  { body: "gem", color: "#a5d955", tilt: 0, look: [-0.4, -0.4], size: 122, sink: -0.24, lean: 4 },
];

function Ensemble() {
  return (
    <div className="ensemble" aria-hidden="true">
      {ENSEMBLE.map(({ size, sink, lean, ...spec }, index) => (
        <span
          key={index}
          className="avatar"
          style={
            {
              "--size": `${size}px`,
              "--sink": sink,
              "--tilt": `${lean}deg`,
            } as CSSProperties
          }
        >
          <Character spec={spec} />
        </span>
      ))}
    </div>
  );
}

export function ConnectScreen({
  connection,
  info,
}: {
  connection: ConnectionState;
  info: HostInfo;
}) {
  const pairing = connection.status === "pairing" && connection.pairing;
  const host = `${info.kind === "web" ? "Web preview" : "Desktop"} ${info.version}`;
  return (
    <main className="connect">
      <div className="connect-drag" />
      <div className="connect-card">
        {pairing ? (
          <>
            <header className="connect-brand">
              <img src={logoUrl} alt={PRODUCT_NAME} width={56} height={56} />
            </header>
            <PairingPanel connection={connection} />
            <p className="connect-foot">
              Request {pairing.requestId.slice(0, 8)} · this device{" "}
              {(connection.deviceId ?? pairing.deviceId).slice(0, 8)} · {host}
            </p>
          </>
        ) : (
          <>
            <header className="connect-brand">
              <img src={logoUrl} alt="" width={56} height={56} />
              <h1>{PRODUCT_NAME}</h1>
              <p>{SLOGAN}</p>
            </header>
            <ConnectForm connection={connection} info={info} />
            <p className="connect-foot">
              {connection.deviceId
                ? `This device ${connection.deviceId.slice(0, 8)}`
                : "Preparing device identity…"}
              {" · "}
              {host}
            </p>
          </>
        )}
      </div>
      <Ensemble />
    </main>
  );
}
