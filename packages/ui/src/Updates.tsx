import type { DesktopUpdateSnapshot, DesktopUpdates, UpdateTrack } from "@clawtrate/core";
import { useEffect, useRef, useState } from "react";
import "./styles/updates.css";

const names = { stable: "Stable", nightly: "Nightly" };

export function useDesktopUpdateSnapshot(updates: DesktopUpdates) {
  const [snapshot, setSnapshot] = useState<DesktopUpdateSnapshot | null>(null);
  const choosing = useRef<UpdateTrack | null>(null);
  const [savingTrack, setSavingTrack] = useState(false);
  const [refused, setRefused] = useState<UpdateTrack | null>(null);
  const [checkPreferenceFailure, setCheckPreferenceFailure] = useState(false);
  useEffect(() => {
    let acceptInitial = true;
    let checking = false;
    const stop = updates.subscribe((next) => {
      acceptInitial = false;
      const preferences = next.state.kind === "failed" && next.state.stage === "preferences";
      setRefused(
        preferences && choosing.current !== null && next.selectedTrack !== choosing.current
          ? next.selectedTrack
          : null,
      );
      setCheckPreferenceFailure(preferences && checking && choosing.current === null);
      checking = next.state.kind === "checking";
      setSnapshot(next);
    });
    void updates
      .get()
      .then((first) => {
        if (acceptInitial) setSnapshot(first);
      })
      .catch(() => {});
    return () => {
      acceptInitial = false;
      stop();
    };
  }, [updates]);
  async function chooseTrack(track: UpdateTrack) {
    if (choosing.current) return;
    choosing.current = track;
    setSavingTrack(true);
    try {
      await updates.chooseTrack(track);
    } finally {
      choosing.current = null;
      setSavingTrack(false);
    }
  }
  return { snapshot, chooseTrack, refused, checkPreferenceFailure, savingTrack };
}

function sourceFor(s: DesktopUpdateSnapshot) {
  if (
    s.state.kind === "failed" &&
    ["development-build", "not-configured", "no-updater"].includes(s.state.reason)
  )
    return;
  return s.tracks.find((t) => t.track === s.selectedTrack)?.source;
}

export function showUpdateFooter(s: DesktopUpdateSnapshot | null) {
  if (!s || !sourceFor(s)) return false;
  switch (s.state.kind) {
    case "offered":
    case "downloading":
    case "verified":
      return true;
    case "failed":
      return s.state.stage !== "preferences";
    default:
      return false;
  }
}

function updateRow(
  s: DesktopUpdateSnapshot,
  refused: UpdateTrack | null,
): { line: string; action?: "Check for Updates" | "Try again" | "Download" } {
  const { state } = s;
  const source = sourceFor(s);
  if (state.kind === "failed" && state.reason === "development-build")
    return { line: "A development build. It doesn't update itself." };
  if (!source)
    return { line: "This copy can't check for updates: no update source is set up for it." };
  switch (state.kind) {
    case "not-checked":
      return { line: "Not checked yet.", action: "Check for Updates" };
    case "checking":
      return { line: `Checking ${source}…` };
    case "nothing-newer": {
      const time =
        s.lastCheckedAt &&
        new Date(s.lastCheckedAt).toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
        });
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
    case "verified":
      return {
        line: `Clawtrate ${state.version} is downloaded, and its size and checksum match the update source. Installation isn't available from this screen.`,
      };
    case "failed":
      if (state.stage === "preferences" && refused && s.selectedTrack === refused)
        return {
          line: `Couldn't save the track. ${names[refused]} is still selected.`,
          action: "Check for Updates",
        };
      if (state.stage === "preferences")
        return { line: "Update settings are unavailable.", action: "Check for Updates" };
      if (state.stage === "download")
        return { line: "Couldn't download the update. Try again.", action: "Try again" };
      if (state.reason === "no-file-for-this-system")
        return {
          line: "The update source has no file for this system.",
          action: "Check for Updates",
        };
      return { line: "Couldn't check for updates.", action: "Try again" };
  }
}

export function Updates({
  snapshot: s,
  updates,
  savingTrack,
  refused,
  onChoice,
}: {
  snapshot: DesktopUpdateSnapshot | null;
  updates: DesktopUpdates;
  savingTrack: boolean;
  refused: UpdateTrack | null;
  onChoice: (track: UpdateTrack) => void;
}) {
  if (!s) return null;
  const { line, action } = updateRow(s, refused);
  const source = sourceFor(s);
  const state = s.state;
  const downloading = state.kind === "downloading";
  const announcement = downloading
    ? `Downloading Clawtrate ${state.version}… ${Math.floor((10 * state.received) / state.expected) * 10}%`
    : line;
  return (
    <div className="updates-section">
      <p className="b-hint">Applies on this device.</p>
      {source && <p>This build can't install updates itself.</p>}
      <dl className="facts">
        {s.runningVersion && (
          <div>
            <dt>Version</dt>
            <dd className="b-wrap-value">
              Clawtrate {s.runningVersion}
              {s.runningTrack && (
                <p className="b-hint">This copy is a {names[s.runningTrack]} build.</p>
              )}
            </dd>
          </div>
        )}
        <div>
          <dt>Updates</dt>
          <dd className="b-wrap-value">{line}</dd>
        </div>
      </dl>
      {downloading && (
        <progress
          aria-label={`Downloading Clawtrate ${state.version}`}
          value={state.received}
          max={state.expected}
        />
      )}
      {source && s.tracks.length === 2 && (
        <fieldset role="radiogroup" aria-label="Update track">
          <legend>Update track</legend>
          {s.tracks.map(({ track }) => (
            <label key={track}>
              <input
                type="radio"
                name="update-track"
                aria-disabled={savingTrack || undefined}
                checked={track === s.selectedTrack}
                onChange={() => onChoice(track)}
              />
              {names[track]}
            </label>
          ))}
          {s.selectedTrack && s.runningTrack && s.runningTrack !== s.selectedTrack && (
            <p className="b-hint">The next check asks the {names[s.selectedTrack]} source.</p>
          )}
        </fieldset>
      )}
      {action && (
        <>
          <button
            className="button"
            disabled={savingTrack}
            type="button"
            onClick={() => {
              void (state.kind === "offered" ? updates.download(state.offerId) : updates.check());
            }}
          >
            {action}
          </button>
          <p className="b-hint">
            {state.kind === "offered"
              ? `Downloads Clawtrate ${state.version} from ${source}, only when you choose to.`
              : `Checks ${source} for a newer build, only when you choose to.`}
          </p>
        </>
      )}
      {source && <p className="b-hint">Automatic restart is unavailable in this build.</p>}
      <span className="visually-hidden" role="status">
        {announcement}
      </span>
    </div>
  );
}
