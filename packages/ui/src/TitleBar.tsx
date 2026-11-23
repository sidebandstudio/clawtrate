// The title bar (docs/design/titlebar.md, section 2): Clawtrate's mark and
// name, the Beta pill on a Beta build only, and the update button. In the
// one-pane layout the rail's top band shows the same brand and button instead.

import { useEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import logoUrl from "./assets/logo-mark.png";
import { Confirm } from "./bots/Dialog.tsx";
import { ClockIcon, DownloadIcon, RefreshIcon, WarnIcon } from "./icons.tsx";
import type { useDesktopUpdateSnapshot } from "./update-reading.ts";
import { restartCapability } from "./update-restart.ts";
import { updateEntry, type UpdateEntry } from "./update-entry.ts";
import "./styles/titlebar.css";

type Reading = ReturnType<typeof useDesktopUpdateSnapshot>;

/** The mark, the name and, only when the running copy is a Beta build, the Beta pill. */
export function Brand({ reading }: { reading: Reading }) {
  const beta = reading.snapshot?.runningTrack === "nightly";
  return (
    <div className="brand" data-testid="brand">
      <img className="brand-mark" src={logoUrl} alt="" width={20} height={20} />
      <span className="brand-name">Clawtrate</span>
      {beta && (
        <span className="channel-pill" title="This copy is a Beta build">
          Beta
        </span>
      )}
    </div>
  );
}

const icons: Record<Exclude<UpdateEntry["icon"], "busy">, () => JSX.Element> = {
  download: () => <DownloadIcon />,
  restart: () => <RefreshIcon />,
  clock: () => <ClockIcon />,
  warn: () => <WarnIcon />,
};

/**
 * The update button, while the update has something to say. "Restart to
 * Update" asks first, as Settings → Updates does; Restarting can't be pressed;
 * every other state opens Updates.
 */
export function UpdateButton({
  reading,
  waitingMessages,
  onOpenUpdates,
  round = false,
}: {
  reading: Reading;
  waitingMessages: string;
  onOpenUpdates: () => void;
  /** The one-pane form: an icon, its words in the tooltip and the name. */
  round?: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const entry = updateEntry(reading.snapshot, reading.pending);
  const s = reading.snapshot;
  const capability = s && restartCapability(s);
  const confirming = !!capability && capability.offerId === confirmId;
  if (confirmId && !confirming) setConfirmId(null);
  // A restart asked for here that the host refused or never answered: its reason is said only in
  // Settings → Updates, so that opens.
  const restartAsked = useRef(false);
  useEffect(() => {
    if (!restartAsked.current || reading.working) return;
    restartAsked.current = false;
    if (reading.message) onOpenUpdates();
  }, [reading.working, reading.message, onOpenUpdates]);
  if (!entry) return null;
  return (
    <>
      <button
        ref={button}
        type="button"
        className="update-button"
        data-state={entry.state}
        data-tone={entry.tone}
        data-shape={round ? "round" : undefined}
        aria-label={entry.name}
        title={round ? entry.text : undefined}
        aria-disabled={entry.press === "none" || reading.working || undefined}
        onClick={() => {
          if (entry.press === "none" || reading.working) return;
          if (entry.press === "confirm" && capability) setConfirmId(capability.offerId);
          else onOpenUpdates();
        }}
      >
        {entry.icon === "busy" ? (
          <span className="update-spin" aria-hidden="true" />
        ) : (
          icons[entry.icon]()
        )}
        {!round && <span>{entry.text}</span>}
        {entry.received !== undefined && (
          <span
            className="update-bar"
            aria-hidden="true"
            style={{ "--received": `${entry.received}%` } as CSSProperties}
          />
        )}
      </button>
      {confirming && s.state.kind === "verified" && (
        <Confirm
          fallbackFocus={button}
          title="Restart to update?"
          action="Restart"
          text={`Restart asks Clawtrate to install version ${s.state.version} and reopen.${capability.completesOnQuit ? " If macOS stages the update, it can install the next time Clawtrate quits." : ""}`}
          details={waitingMessages}
          onCancel={() => setConfirmId(null)}
          onAction={() => {
            setConfirmId(null);
            restartAsked.current = true;
            void reading.restart(capability.offerId);
          }}
        />
      )}
    </>
  );
}

/**
 * Says each new state of the update button once, politely, wherever the
 * button is shown. Progress is left to Settings → Updates.
 */
export function UpdateAnnouncer({ reading }: { reading: Reading }) {
  const entry = updateEntry(reading.snapshot, reading.pending);
  const state = entry?.state ?? null;
  const [said, setSaid] = useState<{ state: string | null; text: string }>({
    state,
    text: "",
  });
  if (said.state !== state)
    setSaid({ state, text: entry ? entry.name.replace(/\. Open Updates$/, "") : "" });
  return (
    <span className="visually-hidden" role="status" data-testid="update-announcer">
      {said.text}
    </span>
  );
}

/** The two-pane layout's title row. It drags the window everywhere but its button. */
export function TitleBar({
  reading,
  waitingMessages,
  onOpenUpdates,
  inert = false,
}: {
  reading: Reading;
  waitingMessages: string;
  onOpenUpdates: () => void;
  /** Set while Settings covers the window. */
  inert?: boolean;
}) {
  return (
    <header className="titlebar" data-testid="titlebar" inert={inert}>
      <Brand reading={reading} />
      <UpdateButton
        reading={reading}
        waitingMessages={waitingMessages}
        onOpenUpdates={onOpenUpdates}
      />
    </header>
  );
}
