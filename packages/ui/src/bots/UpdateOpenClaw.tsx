// Update OpenClaw from Clawtrate (#565): the button where Clawtrate says a
// newer OpenClaw is out, and in Settings › Gateway; one confirmation before it
// starts; then the gateway's steps as a quiet line, and how it ended. Only the
// person's press on Update sends anything (`startOpenClawUpdate`), stamped
// with the gateway the confirmation was opened for.

import {
  gatewayStamp,
  initialOpenClawUpdate,
  type ClawtrateState,
  type ConnectionState,
  type GatewayStamp,
  type UpdateRunView,
} from "@clawtrate/core";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { useBridge, useClawtrateState, useCommand } from "../bridge.tsx";
import { ExternalIcon } from "../icons.tsx";
import { Dialog } from "./Dialog.tsx";
import { AdminBar } from "./parts.tsx";
import {
  blockedWords,
  gatewayWords,
  nextStep,
  OPENCLAW_UPDATE_DOCS,
  runLine,
  UPDATE_TIME_WORDS,
  workWords,
} from "./update-words.ts";

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
 * The update's part of a notice or of Settings › Gateway: the line of the run followed, or the
 * button, or why the gateway can't update itself. `where` names the place for test ids.
 */
export function UpdateOpenClaw({ where }: { where: "notice" | "settings" }) {
  const state = useClawtrateState();
  const send = useCommand();
  const { connection } = state;
  const asks = where === "settings" && connection.status === "connected" && connection.canAdmin;
  // Settings › Gateway opened: the gateway is asked where updating stands (reads only). Never on
  // each connect: `update.status` reads the gateway's state database.
  useEffect(() => {
    if (asks) void send({ type: "checkOpenClawUpdate" }).catch(() => {});
  }, [asks, send, connection.gatewayId, connection.connectedAt]);
  return <UpdateOpenClawView state={state} where={where} />;
}

/** `UpdateOpenClaw` for the state given. */
export function UpdateOpenClawView({
  state,
  where,
}: {
  state: ClawtrateState;
  where: "notice" | "settings";
}) {
  // Where focus goes when the button it came from gives way to the run's line.
  const place = useRef<HTMLDivElement>(null);
  const content = useUpdatePart(state, where, place);
  return content === null ? null : (
    <div className="b-update-place" ref={place} tabIndex={-1}>
      {content}
    </div>
  );
}

/** What the update's part shows for this state, or null when it shows nothing. */
function useUpdatePart(
  state: ClawtrateState,
  where: "notice" | "settings",
  place: RefObject<HTMLDivElement | null>,
): ReactNode {
  const { info } = useBridge();
  const send = useCommand();
  const connection = state.connection;
  const updating = state.openclawUpdating ?? initialOpenClawUpdate;
  const run = runHere(state);
  const [confirming, setConfirming] = useState<GatewayStamp | null>(null);
  const update = connection.openclawUpdate;
  if (run) return <UpdateLine run={run} where={where} />;
  // A press whose answer was lost: no second one until the gateway's record settles it.
  if (updating.looking && updating.error)
    return (
      <div className="b-update" data-testid={`update-looking-${where}`}>
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
                disabled={connection.status !== "connected"}
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
  if (!update || info.readOnly || connection.status !== "connected") return null;
  // What this device keeps for the gateway isn't read yet: no Update until it is (F-589).
  if (updating.checkingKept) return null;
  if (updating.blocked) {
    const words = blockedWords(updating.blocked);
    return (
      <div className="b-update" data-testid={`update-blocked-${where}`}>
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
    <div className="b-update" data-testid={`update-offer-${where}`}>
      {where === "settings" && (
        <p>
          OpenClaw {update.latest} is out
          {update.channel && update.channel !== "latest"
            ? ` on the gateway's ${update.channel} channel${update.channel === "beta" || update.channel === "dev" ? ", not as a stable release" : ""}`
            : ""}
          .
        </p>
      )}
      <button
        type="button"
        className="button"
        data-size="sm"
        disabled={updating.starting}
        onClick={() => setConfirming(gatewayStamp(connection))}
      >
        Update OpenClaw to {update.latest}
      </button>
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
 * The run as a quiet line: the gateway's step while it runs, then how it ended. Progress is
 * announced politely once per step, the outcome once.
 */
function UpdateLine({ run, where }: { run: UpdateRunView; where: "notice" | "settings" }) {
  const send = useCommand();
  const line = runLine(run);
  const words = gatewayWords(run);
  const next = nextStep(run);
  const finished = run.outcome !== "running" && run.outcome !== "late" && run.outcome !== "away";
  return (
    <div className="b-update" data-testid={`update-run-${where}`} data-outcome={run.outcome}>
      <p className="b-update-line">
        {run.outcome === "updated" ? <b>{line}</b> : line}
        {words ? (
          <>
            {" "}
            The gateway says: “<span className="b-update-words">{words}</span>”.
          </>
        ) : null}
      </p>
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
