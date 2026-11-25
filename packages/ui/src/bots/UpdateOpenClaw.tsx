// Update OpenClaw from Clawtrate (#565): its own section of Settings › Updates
// holds the offer and its button, one confirmation before it starts, the
// gateway's steps as a bar, and how it ended (#590). A bot's Settings tab, the
// note near the Model menu and Settings › Gateway keep one line, with a link
// that opens that section. Only the person's press on Update sends anything
// (`startOpenClawUpdate`), stamped with the gateway the confirmation was
// opened for.

import {
  gatewayStamp,
  initialOpenClawUpdate,
  type ClawtrateState,
  type ConnectionState,
  type GatewayStamp,
  type UpdateRunView,
} from "@clawtrate/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { useBridge, useClawtrateState, useCommand } from "../bridge.tsx";
import { gatewayTitle } from "../format.ts";
import { ArrowUpIcon, ExternalIcon } from "../icons.tsx";
import { Dialog } from "./Dialog.tsx";
import { AdminBar, Note } from "./parts.tsx";
import {
  blockedWords,
  gatewayWords,
  nextStep,
  OPENCLAW_UPDATE_DOCS,
  runHeading,
  runLine,
  stepNumber,
  UPDATE_STEPS,
  UPDATE_TIME_WORDS,
  updateLinkLine,
  workWords,
} from "./update-words.ts";

/** Opens Settings › Updates at its OpenClaw section; absent where nothing can open it. */
export const OpenOpenClawUpdates = createContext<(() => void) | null>(null);

/** The id of the OpenClaw section's heading in Settings › Updates, where its link puts focus. */
export const OPENCLAW_UPDATES_HEADING = "settings-openclaw-updates";

/** Tasks the person sees working now: what the confirmation counts. */
export function workingTasks(state: ClawtrateState): number {
  return Object.values(state.tasksByBot)
    .flat()
    .filter((task) => task.status === "running").length;
}

/**
 * The run followed, when it belongs to the gateway connected now. Subscribed to that alone: a
 * screen that shows it doesn't draw again for every other change of the state.
 */
export function useUpdateRun(): UpdateRunView | null {
  const bridge = useBridge();
  return useSyncExternalStore(
    useCallback((listener) => bridge.subscribe(listener), [bridge]),
    () => runHere(bridge.getState()),
  );
}

function runHere(state: ClawtrateState): UpdateRunView | null {
  const run = state.openclawUpdating?.run ?? null;
  if (!run) return null;
  // On another gateway, only the line that says so: nothing of that gateway's version.
  return run.outcome === "elsewhere" || run.gatewayId === state.connection.gatewayId ? run : null;
}

/**
 * Settings › Updates' part for OpenClaw: the app's own updates (`app`), and below them a section
 * for OpenClaw on the gateway connected now when there is anything to say of it. Opening it asks
 * the gateway where updating stands (reads only), as opening Settings › Gateway did before. Never
 * on each connect: `update.status` reads the gateway's state database.
 */
export function UpdatesWithOpenClaw({ app }: { app: ReactNode }) {
  const state = useClawtrateState();
  const send = useCommand();
  const { connection } = state;
  const asks = connection.status === "connected" && connection.canAdmin;
  useEffect(() => {
    if (asks) void send({ type: "checkOpenClawUpdate" }).catch(() => {});
  }, [asks, send, connection.gatewayId, connection.connectedAt]);
  return <UpdatesWithOpenClawView state={state} app={app} />;
}

/**
 * `UpdatesWithOpenClaw` for the state given. With nothing to say of OpenClaw, the app's updates
 * alone, as before; otherwise each under a heading that names what it updates and where.
 */
export function UpdatesWithOpenClawView({
  state,
  app = null,
}: {
  state: ClawtrateState;
  app?: ReactNode;
}) {
  // Where focus goes when the button it came from gives way to the run's line.
  const place = useRef<HTMLDivElement>(null);
  const content = useUpdatePart(state, place);
  if (content === null) return app;
  return (
    <>
      {app !== null && (
        <>
          <h4 className="b-group">Clawtrate on this device</h4>
          {app}
        </>
      )}
      <section
        className="b-update-section"
        aria-labelledby={OPENCLAW_UPDATES_HEADING}
        data-testid="openclaw-updates"
      >
        <h4 className="b-group" id={OPENCLAW_UPDATES_HEADING} tabIndex={-1}>
          OpenClaw on {gatewayTitle(state.connection)}
        </h4>
        <p className="b-hint">Applies to the gateway, for every device connected to it.</p>
        <div className="b-update-place" ref={place} tabIndex={-1}>
          {content}
        </div>
      </section>
    </>
  );
}

/** What the OpenClaw section shows for this state, or null when it shows nothing. */
function useUpdatePart(state: ClawtrateState, place: RefObject<HTMLDivElement | null>): ReactNode {
  const { info } = useBridge();
  const send = useCommand();
  const connection = state.connection;
  const updating = state.openclawUpdating ?? initialOpenClawUpdate;
  const run = runHere(state);
  const [confirming, setConfirming] = useState<GatewayStamp | null>(null);
  const update = connection.openclawUpdate;
  const connected = connection.status === "connected";
  if (run) return <UpdateLine run={run} waiting={!connected} />;
  // A press whose answer was lost: no second one until the gateway's record settles it.
  if (updating.looking && updating.error)
    return (
      <div className="b-update" data-testid="update-looking-settings">
        <p role="status">{updating.error}</p>
        {updating.lookFailed && !info.readOnly && (
          <>
            <p className="b-hint">
              Stop waiting offers Update again. Clawtrate can't tell whether that press started an
              update; if one is running, the gateway says so instead of starting another.
            </p>
            <div className="b-update-actions">
              <button
                type="button"
                className="button"
                data-size="sm"
                disabled={!connected}
                onClick={() => void send({ type: "checkOpenClawUpdate" }).catch(() => {})}
              >
                Check again
              </button>
              <button
                type="button"
                className="button"
                data-size="sm"
                data-variant="quiet"
                onClick={() => void send({ type: "releaseOpenClawUpdateHold" }).catch(() => {})}
              >
                Stop waiting
              </button>
            </div>
          </>
        )}
      </div>
    );
  if (!update) return null;
  if (updating.blocked && connected && !info.readOnly) {
    const words = blockedWords(updating.blocked);
    return (
      <div className="b-update" data-testid="update-blocked-settings">
        <p>
          <b>This gateway can't update OpenClaw itself.</b> {words.why}
          {words.gateway ? (
            <>
              {" "}
              The gateway says: “<span className="b-update-words">{words.gateway}</span>”.
            </>
          ) : null}
        </p>
        <p>
          Update it on the gateway's machine the way it was installed:{" "}
          <a href={OPENCLAW_UPDATE_DOCS} target="_blank" rel="noreferrer noopener">
            OpenClaw's update instructions <ExternalIcon />
          </a>
        </p>
      </div>
    );
  }
  return (
    <div className="b-update" data-testid="update-offer-settings">
      <p>
        OpenClaw {update.latest} is out
        {update.channel && update.channel !== "latest"
          ? ` on the gateway's ${update.channel} channel${update.channel === "beta" || update.channel === "dev" ? ", not as a stable release" : ""}`
          : ""}
        . The gateway runs {update.current}.
      </p>
      {info.readOnly ? (
        <p>
          This device only reads, so it doesn't offer the update. Update OpenClaw on the gateway's
          machine:{" "}
          <a href={OPENCLAW_UPDATE_DOCS} target="_blank" rel="noreferrer noopener">
            OpenClaw's update instructions <ExternalIcon />
          </a>
        </p>
      ) : (
        connected && (
          <button
            type="button"
            className="button"
            data-size="sm"
            disabled={updating.starting}
            onClick={() => setConfirming(gatewayStamp(connection))}
          >
            Update OpenClaw to {update.latest}
          </button>
        )
      )}
      {updating.error && (
        <p className="b-hint" role="alert" data-testid="update-error">
          {updating.error}
        </p>
      )}
      {confirming && (
        <UpdateConfirm
          stamp={confirming}
          connection={connection}
          working={workingTasks(state)}
          onClose={() => setConfirming(null)}
          fallbackFocus={place}
        />
      )}
    </div>
  );
}

/**
 * The one line a bot's Settings tab, the note near the Model menu and Settings › Gateway keep
 * (`updateLinkLine`), with a link named for where it goes, which opens Settings › Updates at its
 * OpenClaw section. Subscribed to that line alone.
 */
export function useUpdateLinkLine(): string | null {
  const bridge = useBridge();
  return useSyncExternalStore(
    useCallback((listener) => bridge.subscribe(listener), [bridge]),
    () => {
      const state = bridge.getState();
      return updateLinkLine(state, runHere(state));
    },
  );
}

export function UpdateOpenClawLink({ line, where }: { line: string; where: "notice" | "gateway" }) {
  const open = useContext(OpenOpenClawUpdates);
  return (
    <p className="b-update-link" data-testid={`update-link-${where}`}>
      {line}
      {open && (
        <>
          {" "}
          <button type="button" className="link-button" onClick={open}>
            Settings › Updates
          </button>
        </>
      )}
    </p>
  );
}

/** The note near the Model menu: the one line and its link, or nothing. */
export function UpdateOpenClawNote() {
  const line = useUpdateLinkLine();
  return line === null ? null : (
    <Note icon={<ArrowUpIcon />} testId="openclaw-update">
      <UpdateOpenClawLink line={line} where="notice" />
    </Note>
  );
}

/**
 * The one confirmation: the version it runs and the one it goes to, the restart, what happens
 * to running work with how many tasks are working, and the reconnect. Without admin it asks
 * for it the way the other admin steps do, and Update waits for the grant.
 */
export function UpdateConfirm({
  stamp,
  connection,
  working,
  onClose,
  fallbackFocus,
}: {
  stamp: GatewayStamp;
  connection: ConnectionState;
  working: number;
  onClose: () => void;
  fallbackFocus?: RefObject<HTMLElement | null>;
}) {
  const send = useCommand();
  // Opened: the gateway is asked where updating stands, so a run started elsewhere or a reason
  // it can't update itself shows before Update is pressed. Reads only.
  useEffect(() => {
    void send({ type: "checkOpenClawUpdate" }).catch(() => {});
  }, [send]);
  const { info } = useBridge();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = connection.openclawUpdate;
  const admin = connection.status === "connected" && connection.canAdmin;
  const press = async () => {
    setBusy(true);
    setError(null);
    try {
      await send({ type: "startOpenClawUpdate", stamp });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  };
  return (
    <Dialog
      kind="confirm"
      labelledBy={`${id}-title`}
      describedBy={`${id}-text`}
      onClose={onClose}
      role="alertdialog"
      testId="update-confirm"
      fallbackFocus={fallbackFocus}
    >
      <div className="b-confirm">
        <h2 id={`${id}-title`}>Update OpenClaw?</h2>
        <div id={`${id}-text`} className="b-update-facts">
          <p>
            Your gateway goes from OpenClaw {update?.current ?? connection.serverVersion} to{" "}
            {update?.latest ?? "the newer version"}.
          </p>
          <p>{UPDATE_TIME_WORDS}</p>
          <p data-testid="update-work">{workWords(working)}</p>
        </div>
        {!admin && (
          <AdminBar
            connection={connection}
            info={info}
            need="Updating OpenClaw needs admin access."
          />
        )}
        {error && (
          <p className="form-error" role="alert" data-testid="update-confirm-error">
            {error}
          </p>
        )}
        <div className="b-actions">
          <button
            type="button"
            className="button"
            data-variant="quiet"
            onClick={onClose}
            data-b-focus=""
          >
            Not now
          </button>
          <button
            type="button"
            className="button"
            data-variant="primary"
            disabled={busy || !admin || !update}
            onClick={() => void press()}
          >
            {busy ? "Update…" : "Update"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The run: its line, the gateway's steps as a bar with its words beside it while it runs, then
 * how it ended. Progress is announced politely once per step, the outcome once.
 */
function UpdateLine({ run, waiting }: { run: UpdateRunView; waiting: boolean }) {
  const send = useCommand();
  const line = runLine(run);
  const heading = runHeading(run);
  const words = gatewayWords(run);
  const next = nextStep(run);
  const finished = run.outcome !== "running" && run.outcome !== "late" && run.outcome !== "away";
  return (
    <div className="b-update" data-testid="update-run-settings" data-outcome={run.outcome}>
      <p className="b-update-line">
        {run.outcome === "updated" ? <b>{heading}</b> : heading}
        {words ? (
          <>
            {" "}
            The gateway says: “<span className="b-update-words">{words}</span>”.
          </>
        ) : null}
      </p>
      {!finished && <UpdateSteps run={run} waiting={waiting} />}
      {next && <p className="b-hint">{next}</p>}
      {(run.outcome === "failed" || run.outcome === "rolled-back" || run.outcome === "skipped") && (
        <p>
          <a href={OPENCLAW_UPDATE_DOCS} target="_blank" rel="noreferrer noopener">
            OpenClaw's update instructions <ExternalIcon />
          </a>
        </p>
      )}
      {finished && (
        <button
          type="button"
          className="button"
          data-size="sm"
          data-variant="quiet"
          onClick={() => void send({ type: "dismissOpenClawUpdate" }).catch(() => {})}
        >
          Dismiss
        </button>
      )}
      {/* Its text changes once per step and once for the outcome: each change is said once. */}
      <p className="visually-hidden" role="status" aria-live="polite">
        {line}
      </p>
    </div>
  );
}

/**
 * The gateway's steps as a bar: one segment per step it counts, those before its step filled,
 * its step marked, and its words beside it. Nothing finer than the gateway's step is shown, and
 * nothing moves: while the gateway is away its step is marked as waiting, and the bar stays.
 */
function UpdateSteps({ run, waiting }: { run: UpdateRunView; waiting: boolean }) {
  const step = stepNumber(run.phase);
  const words = `Step ${step} of ${UPDATE_STEPS}, ${run.phase}${waiting ? ": waiting for the gateway to come back" : ""}`;
  return (
    <div className="b-update-steps" data-waiting={waiting || undefined}>
      <div
        className="b-update-bar"
        role="progressbar"
        aria-label="OpenClaw update"
        aria-valuemin={0}
        aria-valuemax={UPDATE_STEPS}
        aria-valuenow={step}
        aria-valuetext={words}
      >
        {Array.from({ length: UPDATE_STEPS }, (_, index) => (
          <span
            key={index}
            data-step={index + 1 < step ? "done" : index + 1 === step ? "now" : undefined}
          />
        ))}
      </div>
      <span className="b-update-step">{words}</span>
    </div>
  );
}
