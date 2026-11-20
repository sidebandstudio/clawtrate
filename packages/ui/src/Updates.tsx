import type { DesktopUpdateSnapshot, UpdateTrack } from "@clawtrate/core";
import type { useDesktopUpdateSnapshot } from "./update-reading.ts";
import { useRef, useState } from "react";
import { Confirm } from "./bots/Dialog.tsx";
import { handoffLocked, restartCapability, refusalLine, attemptLine } from "./update-restart.ts";
import { WarnIcon } from "./icons.tsx";
import "./styles/updates.css";

const names = { stable: "Stable", nightly: "Nightly" };
const capabilities = {
  "development-build": "A development build. It doesn't update itself.",
  "not-configured": "This copy can't check for updates: no update source is set up for it.",
  "no-updater": "This copy can't check for updates: no update source is set up for it.",
  "invalid-version": "This build's version couldn't be read. It can't check for updates.",
  "unsupported-system": "This build can't check for updates on this system.",
};
function capabilityLine(s: DesktopUpdateSnapshot) {
  const { state } = s;
  return state.kind === "failed" && Object.hasOwn(capabilities, state.reason)
    ? capabilities[state.reason as keyof typeof capabilities]
    : null;
}
function sourceFor(s: DesktopUpdateSnapshot) {
  if (capabilityLine(s)) return;
  return s.tracks.find((t) => t.track === s.selectedTrack)?.source;
}

export function showUpdateFooter(s: DesktopUpdateSnapshot | null, pending = s?.pendingTrack) {
  if (!s || pending || !sourceFor(s)) return false;
  switch (s.state.kind) {
    case "offered":
    case "downloading":
    case "verified":
    case "preparing":
    case "handing-off":
    case "handed-to-system":
    case "handoff-unconfirmed":
    case "handoff-failed":
      return true;
    case "failed":
      return s.state.stage !== "preferences";
    default:
      return false;
  }
}

function updateRow(
  s: DesktopUpdateSnapshot,
  pending: UpdateTrack | null,
): {
  line: string;
  action?: "Check for Updates" | "Try again" | "Download" | "Restart to Update" | undefined;
} {
  const { state } = s;
  const source = sourceFor(s);
  const unavailable = capabilityLine(s);
  if (unavailable || !source) return { line: unavailable ?? capabilities["not-configured"] };
  if (pending) return { line: "Not checked yet." };
  switch (state.kind) {
    case "not-checked":
      return { line: "Not checked yet.", action: "Check for Updates" };
    case "checking":
      return { line: `Checking ${source}…` };
    case "nothing-newer": {
      const date =
        s.lastCheck && s.lastCheck.track === s.selectedTrack ? new Date(s.lastCheck.readAt) : null;
      const time =
        date && Number.isFinite(date.getTime())
          ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
          : null;
      return {
        line:
          s.selectedTrack &&
          s.runningTrack &&
          s.runningVersion &&
          s.selectedTrack !== s.runningTrack
            ? `No newer ${names[s.selectedTrack]} build was offered. Clawtrate ${s.runningVersion} is still running.`
            : "No newer version was offered for this build by its update source." +
              (time ? ` Checked at ${time}.` : ""),
        action: "Check for Updates",
      };
    }
    case "offered":
      return {
        line: `Clawtrate ${state.version} is offered by the update source.`,
        action: "Download",
      };
    case "downloading":
      return {
        line: `Downloading Clawtrate ${state.version}… ${state.received.toLocaleString()} of ${state.expected.toLocaleString()} bytes`,
      };
    case "preparing":
      return { line: `Preparing Clawtrate ${state.version} for restart…` };
    case "handing-off":
      return { line: `Handing Clawtrate ${state.version} to the system updater…` };
    case "handed-to-system":
      return {
        line: "Clawtrate handed the update to the macOS updater. After restart, Clawtrate reports the version that is running.",
      };
    case "handoff-unconfirmed":
      return {
        line: "Clawtrate couldn't confirm that the macOS updater accepted the update. macOS may still install it when Clawtrate quits. After reopening, Clawtrate reports the version that is running.",
      };
    case "handoff-failed":
      return {
        line: refusalLine(state.reason),
        action: "Check for Updates",
      };
    case "verified":
      if (s.install.kind === "unavailable-in-this-build" && s.install.reason === "artifact-changed")
        return { line: refusalLine(s.install.reason), action: "Check for Updates" };
      if (restartCapability(s))
        return {
          line: `Clawtrate ${state.version} is downloaded, and its size and checksum match the update source. Ready to install.`,
          action: "Restart to Update",
        };
      return {
        line: `Clawtrate ${state.version} is downloaded, and its size and checksum match the update source. Installation isn't available from this screen.`,
      };
    case "failed":
      if (state.stage === "preferences")
        return { line: "Couldn't read or save the update settings.", action: "Check for Updates" };
      if (state.stage === "download") {
        let line = "Couldn't download the update.";
        if (state.reason === "hash-mismatch" || state.reason === "size-mismatch")
          line = "The downloaded file doesn't match the update source.";
        else if (state.reason === "artifact-changed")
          line = "Couldn't verify the saved update again.";
        else if (state.reason === "write-failed") line = "Couldn't save the update on this device.";
        return { line, action: "Check for Updates" };
      }
      if (state.reason === "no-file-for-this-system")
        return {
          line: "The update source has no file for this system.",
          action: "Check for Updates",
        };
      return { line: "Couldn't check for updates.", action: "Try again" };
  }
}

function preferenceLine(s: DesktopUpdateSnapshot) {
  switch (s.preferenceIssue) {
    case "attempt-not-read":
      return "Couldn't read the last update attempt.";
    case "preferences-not-read":
      return "Couldn't read the saved update settings.";
    case "track-not-saved":
      return (
        s.selectedTrack && `Couldn't save the track. ${names[s.selectedTrack]} is still selected.`
      );
    case "last-check-not-saved":
      return "Couldn't save the time of the last check.";
    case "update-folder-unavailable":
      return "Couldn't prepare update storage on this device.";
    case null:
      return null;
  }
}

// React detaches this ref before removing the focused button. Progress updates
// never move focus, and the result stays in the dialog's normal reading order.
function focusResultOnRemoval(button: HTMLButtonElement | null) {
  if (button)
    return () => {
      if (document.activeElement === button) button.closest<HTMLElement>(".update-result")?.focus();
    };
}

export function Updates({
  snapshot: s,
  pending,
  message,
  working,
  retryRead,
  chooseTrack,
  check,
  download,
  restart,
  waitingMessages = "",
}: ReturnType<typeof useDesktopUpdateSnapshot> & { waitingMessages?: string }) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const result = useRef<HTMLDivElement>(null);
  if (!s)
    return (
      <div className="updates-section">
        <div
          key="result"
          className="update-result"
          tabIndex={-1}
          role="group"
          aria-label="Update status"
        >
          <span role="status">{message}</span>
          {message && (
            <div className="b-actions">
              <button
                ref={focusResultOnRemoval}
                type="button"
                className="button"
                aria-disabled={working || undefined}
                onClick={retryRead}
              >
                Retry reading settings
              </button>
            </div>
          )}
        </div>
      </div>
    );
  const { line, action } = updateRow(s, pending);
  const source = sourceFor(s);
  const state = s.state;
  const downloading = !pending && state.kind === "downloading";
  const notice = preferenceLine(s);
  const capability = restartCapability(s);
  const unavailable =
    s.install.kind === "unavailable-in-this-build" ? refusalLine(s.install.reason) : null;
  const installNotice =
    (source ||
      (state.kind === "failed" &&
        state.reason === "unsupported-system" &&
        s.install.kind === "unavailable-in-this-build" &&
        s.install.reason === "no-installer-path")) &&
    state.kind !== "handoff-failed" &&
    !handoffLocked(state) &&
    unavailable !== line
      ? unavailable
      : null;
  const confirm = capability && !pending && capability.offerId === confirmId;
  if (confirmId && !confirm) setConfirmId(null);
  const locked = handoffLocked(state);
  const attempt = attemptLine(s.lastAttempt);
  const saving = s.pendingTrack
    ? `Saving ${names[s.pendingTrack]} as the update track…`
    : pending
      ? "Changing the update track…"
      : null;
  const announcement = downloading
    ? `Downloading Clawtrate ${state.version}… ${Math.floor((10 * state.received) / state.expected) * 10}%`
    : line;
  return (
    <div className="updates-section">
      <p className="b-hint">Applies on this device.</p>
      {installNotice && (
        <div className="b-note" data-tone="warn">
          <WarnIcon />
          <p>{installNotice}</p>
        </div>
      )}
      {s.runningVersion && (
        <dl className="facts">
          <div>
            <dt>Version</dt>
            <dd className="b-wrap-value">
              Clawtrate {s.runningVersion}
              {s.runningTrack && (
                <p className="b-hint">This copy is a {names[s.runningTrack]} build.</p>
              )}
            </dd>
          </div>
        </dl>
      )}
      {source && s.tracks.length === 2 && (
        <fieldset disabled={locked || !!confirm} role="radiogroup" aria-label="Update track">
          <legend>Update track</legend>
          {s.tracks.map(({ track }) => (
            <label key={track}>
              <input
                type="radio"
                name="update-track"
                aria-disabled={pending ? true : undefined}
                checked={s.selectedTrack === track}
                onKeyDown={(e) => {
                  if (
                    pending &&
                    [" ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
                  )
                    e.preventDefault();
                }}
                onClick={(e) => {
                  if (pending) e.preventDefault();
                }}
                onChange={() => {
                  if (!pending) void chooseTrack(track);
                }}
              />
              {names[track]}
            </label>
          ))}
        </fieldset>
      )}
      {saving && <p className="b-hint">{saving}</p>}
      {!pending &&
        source &&
        s.selectedTrack &&
        s.runningTrack &&
        s.selectedTrack !== s.runningTrack && (
          <p className="b-hint">The next check asks the {names[s.selectedTrack]} source.</p>
        )}
      <div
        key="result"
        ref={result}
        className="update-result"
        tabIndex={-1}
        role="group"
        aria-label="Update status"
      >
        <dl className="facts">
          <div>
            <dt>Updates</dt>
            <dd className="b-wrap-value">
              {line}
              {downloading && (
                <progress
                  aria-label={`Downloading Clawtrate ${state.version}`}
                  value={state.received}
                  max={state.expected}
                />
              )}
            </dd>
          </div>
        </dl>
        {notice && !pending && <p>{notice}</p>}
        {attempt && <p>{attempt}</p>}
        {message && <p>{message}</p>}
        {action && s.selectedTrack && (
          <>
            <div className="b-actions">
              <button
                ref={focusResultOnRemoval}
                key={action}
                type="button"
                className="button"
                aria-disabled={working || undefined}
                data-variant={action === "Restart to Update" ? "primary" : undefined}
                aria-describedby={action === "Restart to Update" ? undefined : "update-source"}
                onClick={() => {
                  if (working) return;
                  if (capability) setConfirmId(capability.offerId);
                  else if (state.kind === "offered") void download(state.offerId);
                  else if (s.selectedTrack) void check(s.selectedTrack, s.revision);
                }}
              >
                {action}
              </button>
            </div>
            {action !== "Restart to Update" && (
              <p id="update-source" className="b-hint update-source">
                {state.kind === "offered"
                  ? `Downloads Clawtrate ${state.version} from ${source}, only when you choose to.`
                  : `Checks ${source} for a newer build, only when you choose to.`}
              </p>
            )}
          </>
        )}
      </div>
      {confirm && state.kind === "verified" && (
        <Confirm
          fallbackFocus={result}
          title="Restart to update?"
          action="Restart"
          text={`Clawtrate will close and start again to update to version ${state.version}.${capability.completesOnQuit ? " macOS installs the update when Clawtrate next quits, also if the restart does not complete." : ""}`}
          details={waitingMessages}
          onCancel={() => setConfirmId(null)}
          onAction={() => {
            setConfirmId(null);
            void restart(capability.offerId);
          }}
        />
      )}
      {source && <p className="b-hint">Automatic restart is unavailable in this build.</p>}
      <span className="visually-hidden" role="status">
        {[saving ?? announcement, !pending && notice, attempt, message].filter(Boolean).join(" ")}
      </span>
    </div>
  );
}
