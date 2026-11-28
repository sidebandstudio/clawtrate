// Settings → Skills (F-361): the gateway's skill library (`skills.library.list`) and importing a
// local SKILL.md (`skills.library.save`, `operator.write`). Picking a file previews its own name,
// description and instructions locally as plain text cut to a bound; nothing reaches the gateway
// until the person presses "Save to library". "Saved" is shown only after the gateway confirms,
// and conflicts or refusals are shown in the gateway's own words.

import {
  gatewayStamp,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_PREVIEW_CHARS,
  parseSkillMarkdown,
  sameStamp,
  skillSlugProblem,
  type ConnectionState,
  type GatewayStamp,
  type HostInfo,
  type SkillImportPreview,
  type SkillLibraryEntry,
  type SkillLibraryList,
} from "@clawtrate/core";
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { useBridge, useCommand } from "../bridge.tsx";
import type { SectionView } from "../bots/AccountsSection.tsx";
import { CheckIcon, WarnIcon } from "../icons.tsx";
import "./skills.css";

export type SkillsLoadState =
  | { status: "idle" }
  | { status: "error"; message: string; key: string }
  | { status: "ready"; list: SkillLibraryList; key: string };

export type ImportDraft = {
  id: number;
  fileName: string;
  bytes: Uint8Array;
  preview: SkillImportPreview;
  slug: string;
  stamp: GatewayStamp;
  saving: boolean;
  /** Conflict refusal from the gateway, in its own words. */
  conflict: string | null;
  /** Any other refusal from the gateway or host, in its own words. */
  error: string | null;
};

export type SkillsLoadView = {
  list: SkillLibraryList | null;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  unidentified: boolean;
};

/** Resolve the current load state against the active gateway identity. */
export function skillsLoadView(
  load: SkillsLoadState,
  currentStamp: GatewayStamp,
  readKey: string,
  connected: boolean,
  active: boolean,
): SkillsLoadView {
  if (!connected || !active)
    return { list: null, error: null, loading: false, refreshing: false, unidentified: false };
  const list =
    load.status === "ready" && sameStamp(load.list.stamp, currentStamp) ? load.list : null;
  const unidentified =
    list === null &&
    load.status === "ready" &&
    load.key === readKey &&
    load.list.stamp.gatewayId === null;
  const error = load.status === "error" && load.key === readKey ? load.message : null;
  const loading = list === null && error === null && !unidentified;
  const refreshing = load.status === "idle" || load.key !== readKey;
  return { list, error, loading, refreshing, unidentified };
}

export function applyDraftSaveStart(
  current: ImportDraft | null,
  draftId: number,
): ImportDraft | null {
  return current?.id === draftId
    ? { ...current, saving: true, conflict: null, error: null }
    : current;
}

export function applyDraftSaveConflict(
  current: ImportDraft | null,
  draftId: number,
  message: string,
): ImportDraft | null {
  return current?.id === draftId
    ? { ...current, saving: false, conflict: message, error: null }
    : current;
}

export function applyDraftSaveSuccess(
  current: ImportDraft | null,
  draftId: number,
): ImportDraft | null {
  return current?.id === draftId ? null : current;
}

export function applyDraftSaveError(
  current: ImportDraft | null,
  draftId: number,
  message: string,
): ImportDraft | null {
  return current?.id === draftId
    ? { ...current, saving: false, error: message, conflict: null }
    : current;
}

export type PickReadOutcome =
  | { status: "stale" }
  | { status: "error"; message: string }
  | { status: "ready"; draft: ImportDraft };

/** Read and validate a picked SKILL.md file, dropping stale completions when another pick or Cancel superseded it. */
export async function readPickedSkillFile(
  file: Pick<File, "name" | "size" | "arrayBuffer">,
  id: number,
  stamp: GatewayStamp,
  isCurrent: () => boolean,
): Promise<PickReadOutcome> {
  if (file.size === 0) return { status: "error", message: "This SKILL.md file is empty." };
  if (file.size > MAX_SKILL_FILE_BYTES) {
    return {
      status: "error",
      message: `SKILL.md files can be at most 1 MB (${MAX_SKILL_FILE_BYTES.toLocaleString("en-US")} bytes).`,
    };
  }
  try {
    const buffer = await file.arrayBuffer();
    if (!isCurrent()) return { status: "stale" };
    const bytes = new Uint8Array(buffer);
    const parsed = parseSkillMarkdown(bytes);
    if (!parsed.ok) return { status: "error", message: parsed.error };
    return {
      status: "ready",
      draft: {
        id,
        fileName: file.name || "SKILL.md",
        bytes,
        preview: parsed.preview,
        slug: parsed.preview.slug,
        stamp,
        saving: false,
        conflict: null,
        error: null,
      },
    };
  } catch {
    if (!isCurrent()) return { status: "stale" };
    return { status: "error", message: "That file couldn't be read." };
  }
}

type SavedNotice = {
  slug: string;
  nextAction: string | null;
  stamp: GatewayStamp;
};

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function tagFor(entry: SkillLibraryEntry, profileId: string | null) {
  return profileId !== null && entry.ownerProfileId === profileId ? "Your skill" : "Team skill";
}

/** Library list area: loading, error, unidentified gateway, notices, and entries. */
export function SkillLibraryView({
  list,
  loadError,
  loading,
  unidentified,
  onRetry,
}: {
  list: SkillLibraryList | null;
  loadError: string | null;
  loading: boolean;
  unidentified: boolean;
  onRetry: () => void;
}) {
  return (
    <>
      {loading && (
        <p className="b-hint" data-testid="skills-loading">
          Reading the skill library from the gateway…
        </p>
      )}

      {loadError && !list && (
        <div className="b-note" data-tone="danger" role="alert" data-testid="skills-load-error">
          <WarnIcon />
          <div>
            <p>Couldn&apos;t read the skill library. {loadError}</p>
            <div className="b-actions">
              <button type="button" className="button" data-size="sm" onClick={onRetry}>
                Try again
              </button>
            </div>
          </div>
        </div>
      )}

      {unidentified && (
        <div className="b-note" data-tone="warn" role="alert" data-testid="skills-unidentified">
          <WarnIcon />
          <div>
            <p>
              Couldn&apos;t confirm this gateway&apos;s identity, so its skill library can&apos;t be
              shown or imported into yet.
            </p>
            <div className="b-actions">
              <button type="button" className="button" data-size="sm" onClick={onRetry}>
                Try again
              </button>
            </div>
          </div>
        </div>
      )}

      {list && (
        <>
          <p className="b-group">Library</p>
          {list.defaultSelectionNotice && (
            <div className="b-note" role="status" data-testid="skills-selection-notice">
              <WarnIcon />
              <div>
                <p>{list.defaultSelectionNotice}</p>
              </div>
            </div>
          )}
          {list.truncated && (
            <p className="b-hint" role="status" data-testid="skills-truncated">
              {list.entries.length > 0
                ? `Showing the first ${list.entries.length.toLocaleString("en-US")} skills. Other skills may still be in your library.`
                : "This list was too large to display here. Other skills may still be in your library."}
            </p>
          )}
          {list.entries.length === 0 ? (
            !list.truncated && (
              <p className="b-hint" data-testid="skills-empty">
                No skills in your library yet. Import a <code>SKILL.md</code> file to save a copy
                here.
              </p>
            )
          ) : (
            <ul className="sk-list" data-testid="skills-list">
              {list.entries.map((entry) => (
                <li key={entry.skillId} className="sk-row" data-testid="skills-row">
                  <div className="sk-row-head">
                    <span className="sk-row-slug">{entry.slug}</span>
                    <span className="sk-tag">{tagFor(entry, list.profileId)}</span>
                    {!entry.enabled && <span className="sk-tag">Disabled</span>}
                  </div>
                  {entry.description && <p className="sk-row-desc">{entry.description}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

function WriteAccessBar({ connection, info }: { connection: ConnectionState; info: HostInfo }) {
  const send = useCommand();
  const upgrade = connection.upgrade;
  const status = upgrade.status;
  let body: ReactNode;
  let action: ReactNode = null;
  if (info.readOnly) {
    body = (
      <>
        <b>Read-only.</b> This connection can view skills, not import them.
      </>
    );
  } else if (connection.status === "connected" && connection.fullPairing) {
    body = (
      <>
        <b>Write access wasn&apos;t granted.</b> Importing skills needs write access to the gateway.
      </>
    );
  } else if (status === "requesting") {
    body = "Asking the gateway for write access…";
  } else if (status === "pending") {
    body = (
      <>
        <b>Waiting for the gateway&apos;s owner</b> to approve write access.
      </>
    );
  } else {
    body = (
      <>
        <b>Write access needed</b> to import skills into your library.
      </>
    );
    if (connection.status === "connected") {
      action = (
        <button
          type="button"
          className="button"
          data-variant="primary"
          data-size="sm"
          onClick={() => void send({ type: "requestAccess" }).catch(() => {})}
        >
          Request access
        </button>
      );
    }
  }
  return (
    <section className="access-bar" aria-label="Access" data-testid="skills-access-bar">
      <div className="access-bar-body">{body}</div>
      {action}
    </section>
  );
}

export function useSkillsSection({
  active,
  connection,
  info,
  announce,
  toNav,
}: {
  active: boolean;
  connection: ConnectionState;
  info: HostInfo;
  announce: (text: string) => void;
  toNav: ReactNode;
}): SectionView {
  const bridge = useBridge();
  const fileInput = useRef<HTMLInputElement>(null);
  const pickSeq = useRef(0);
  const connected = connection.status === "connected";
  const canWrite = connected && connection.canWrite && !info.readOnly;
  const currentStamp = gatewayStamp(connection);
  const latestStamp = useRef(currentStamp);

  const [load, setLoad] = useState<SkillsLoadState>({ status: "idle" });
  const [readNonce, setReadNonce] = useState(0);
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<SavedNotice | null>(null);

  const readKey = `${connection.gatewayId ?? ""}:${connection.target}:${connection.connectedAt ?? ""}:${readNonce}`;

  useEffect(() => {
    latestStamp.current = { gatewayId: currentStamp.gatewayId, target: currentStamp.target };
    return () => {
      pickSeq.current += 1;
    };
  }, [currentStamp.gatewayId, currentStamp.target]);

  useEffect(() => {
    if (!active || !connected) return;
    let live = true;
    bridge.invoke({ type: "listSkillLibrary" }).then(
      (list) => {
        if (!live) return;
        setLoad({ status: "ready", list, key: readKey });
      },
      (failure: unknown) => {
        if (!live) return;
        setLoad({
          status: "error",
          message: failure instanceof Error ? failure.message : String(failure),
          key: readKey,
        });
      },
    );
    return () => {
      live = false;
    };
  }, [bridge, active, connected, readKey]);

  const {
    list,
    error: loadError,
    loading,
    refreshing,
    unidentified,
  } = skillsLoadView(load, currentStamp, readKey, connected, active);
  const activeDraft = draft && sameStamp(draft.stamp, currentStamp) ? draft : null;
  const activeSaved =
    savedNotice && sameStamp(savedNotice.stamp, currentStamp) ? savedNotice : null;

  const pickFile = () => {
    setPickError(null);
    fileInput.current?.click();
  };

  const onFilePicked = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const seq = ++pickSeq.current;
    setPickError(null);
    setSavedNotice(null);
    const outcome = await readPickedSkillFile(
      file,
      seq,
      list?.stamp ?? currentStamp,
      () => pickSeq.current === seq,
    );
    if (outcome.status === "stale") return;
    if (outcome.status === "error") {
      setDraft(null);
      setPickError(outcome.message);
      return;
    }
    setDraft(outcome.draft);
  };

  const slugError = activeDraft ? skillSlugProblem(activeDraft.slug) : null;

  const saveImport = async () => {
    if (!activeDraft || activeDraft.saving || slugError || !canWrite) return;
    const { id: draftId, bytes, fileName, slug, stamp } = activeDraft;
    setDraft((current) => applyDraftSaveStart(current, draftId));
    try {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const attached = await bridge.attach({
        name: fileName,
        type: "text/markdown",
        data: copy.buffer,
      });
      const result = await bridge.invoke({
        type: "importLibrarySkill",
        slug,
        attachmentId: attached.id,
        stamp,
      });
      if (result.outcome === "conflict") {
        setDraft((current) => applyDraftSaveConflict(current, draftId, result.message));
        return;
      }
      setDraft((current) => applyDraftSaveSuccess(current, draftId));
      if (sameStamp(result.stamp, latestStamp.current)) {
        setSavedNotice({
          slug: result.entry.slug,
          nextAction: result.nextAction,
          stamp: result.stamp,
        });
        announce(`Saved ${result.entry.slug} to your skill library`);
        setReadNonce((n) => n + 1);
      }
      setLoad((current) => {
        if (current.status !== "ready" || !sameStamp(current.list.stamp, result.stamp))
          return current;
        const nextEntries = [
          ...current.list.entries.filter((each) => each.skillId !== result.entry.skillId),
          result.entry,
        ].sort((a, b) => a.slug.localeCompare(b.slug));
        return { status: "ready", list: { ...current.list, entries: nextEntries }, key: readKey };
      });
    } catch (failure: unknown) {
      const message = failure instanceof Error ? failure.message : String(failure);
      setDraft((current) => applyDraftSaveError(current, draftId, message));
    }
  };

  let body: ReactNode;
  if (!connected) {
    body = (
      <p className="b-hint" data-testid="skills-offline">
        Connect to your gateway to view your skill library and import SKILL.md files.
      </p>
    );
  } else {
    body = (
      <>
        <div className="sk-intro">
          <p>
            Skills in your gateway library are available to new tasks across your bots. Import a
            local <code>SKILL.md</code> to save a copy here.
          </p>
          <div className="sk-intro-actions">
            {canWrite && (
              <button
                type="button"
                className="button"
                data-variant="primary"
                data-size="sm"
                data-testid="skills-import-button"
                disabled={activeDraft?.saving === true || currentStamp.gatewayId === null}
                onClick={pickFile}
              >
                Import SKILL.md…
              </button>
            )}
            <button
              type="button"
              className="button"
              data-variant="quiet"
              data-size="sm"
              disabled={refreshing}
              onClick={() => setReadNonce((n) => n + 1)}
            >
              Refresh
            </button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".md,text/markdown,text/plain"
            hidden
            data-testid="skills-file-input"
            onChange={(event) => void onFilePicked(event)}
          />
        </div>

        {pickError && (
          <div className="b-note" data-tone="danger" role="alert" data-testid="skill-import-error">
            <WarnIcon />
            <div>
              <p>{pickError}</p>
            </div>
          </div>
        )}

        {activeSaved && (
          <div className="b-note" role="status" data-testid="skill-import-saved">
            <CheckIcon />
            <div>
              <p>
                <b>Saved {activeSaved.slug}</b> to your gateway skill library.
              </p>
              <p className="sk-pin-note">
                {activeSaved.nextAction ??
                  "Enabled for new tasks. Existing tasks keep their pinned skill revisions until you refresh them."}
              </p>
            </div>
          </div>
        )}

        {activeDraft && (
          <section
            className="sk-preview"
            aria-label="Import skill preview"
            data-testid="skill-import-preview"
          >
            <div className="sk-preview-head">
              <h4>Import skill</h4>
              <span className="sk-file-meta">
                {activeDraft.fileName} · {formatBytes(activeDraft.preview.sizeBytes)}
              </span>
            </div>

            <dl className="sk-preview-dl">
              <div>
                <dt>Name</dt>
                <dd data-testid="skill-preview-name">
                  {activeDraft.preview.name}
                  {activeDraft.preview.nameCut ? "…" : ""}
                </dd>
              </div>
              <div>
                <dt>Description</dt>
                <dd data-testid="skill-preview-description">{activeDraft.preview.description}</dd>
              </div>
            </dl>

            <div className="sk-slug-field">
              <label htmlFor="skill-import-slug">Library slug</label>
              <input
                id="skill-import-slug"
                className="input"
                type="text"
                value={activeDraft.slug}
                disabled={activeDraft.saving}
                data-testid="skill-import-slug"
                aria-invalid={slugError !== null || activeDraft.conflict !== null}
                onChange={(event) =>
                  setDraft((current) =>
                    current?.id === activeDraft.id
                      ? { ...current, slug: event.target.value, conflict: null, error: null }
                      : current,
                  )
                }
              />
              {slugError && (
                <p className="b-field-error" role="alert" data-testid="skill-slug-error">
                  {slugError}
                </p>
              )}
            </div>

            <div className="sk-instructions-wrap">
              <span className="sk-instructions-label">Instructions</span>
              <pre className="sk-instructions" data-testid="skill-preview-instructions">
                {activeDraft.preview.instructions || "(No body instructions after front matter.)"}
              </pre>
              {activeDraft.preview.instructionsCut && (
                <p className="sk-pin-note" data-testid="skill-preview-truncated">
                  Showing the first {MAX_SKILL_PREVIEW_CHARS.toLocaleString("en-US")} of{" "}
                  {activeDraft.preview.totalInstructionsChars.toLocaleString("en-US")} characters.
                  The full file is saved to the gateway.
                </p>
              )}
            </div>

            <p className="sk-pin-note">
              Saves a copy to your gateway skill library for new tasks. Existing tasks keep their
              pinned revisions until you refresh them.
            </p>

            {activeDraft.conflict && (
              <div
                className="b-note"
                data-tone="warn"
                role="alert"
                data-testid="skill-import-conflict"
              >
                <WarnIcon />
                <div>
                  <p>
                    <b>Name conflict</b>
                  </p>
                  <p>{activeDraft.conflict}</p>
                </div>
              </div>
            )}

            {activeDraft.error && (
              <div
                className="b-note"
                data-tone="danger"
                role="alert"
                data-testid="skill-import-error"
              >
                <WarnIcon />
                <div>
                  <p>{activeDraft.error}</p>
                </div>
              </div>
            )}

            <div className="sk-actions">
              <button
                type="button"
                className="button"
                data-variant="primary"
                data-size="sm"
                data-testid="skill-import-save"
                disabled={activeDraft.saving || slugError !== null || !canWrite}
                onClick={() => void saveImport()}
              >
                {activeDraft.saving ? "Saving…" : "Save to library"}
              </button>
              <button
                type="button"
                className="button"
                data-variant="quiet"
                data-size="sm"
                disabled={activeDraft.saving}
                onClick={pickFile}
              >
                Choose another file
              </button>
              <button
                type="button"
                className="button"
                data-variant="quiet"
                data-size="sm"
                disabled={activeDraft.saving}
                onClick={() => {
                  pickSeq.current += 1;
                  setDraft(null);
                }}
              >
                Cancel
              </button>
            </div>
          </section>
        )}

        <SkillLibraryView
          list={list}
          loadError={loadError}
          loading={loading}
          unidentified={unidentified}
          onRetry={() => setReadNonce((n) => n + 1)}
        />
      </>
    );
  }

  return {
    title: "Skills",
    back: toNav,
    body,
    foot: connected && !canWrite ? <WriteAccessBar connection={connection} info={info} /> : null,
  };
}
