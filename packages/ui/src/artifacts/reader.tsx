// An item a bot handed over, in the Files tab (work-pane.md, section 13): its
// head and facts at once, where it came from, its body by what the device can
// make of its bytes, and Raw, the record `artifacts.get` returns. And "Sent in
// chat", the task's items newest first, from the same list as the cards.

import type { Artifact, ArtifactRecord } from "@clawtrate/core";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useBridge } from "../bridge.tsx";
import { clockTime, stampTime } from "../format.ts";
import {
  BackIcon,
  DocumentIcon,
  CopyIcon,
  DownloadIcon,
  ExternalIcon,
  PauseIcon,
  PictureIcon,
  PlayIcon,
} from "../icons.tsx";
import { Markdown } from "../Markdown.tsx";
import { formatSize } from "../work/files-format.ts";
import { CodeView } from "../work/Reader.tsx";
import { kindIcon, MiddleName, openInBrowser, openItem } from "./cards.tsx";
import { useArtifacts, type Content } from "./context.tsx";
import { cardSub, clock, downloadName, fetchable, overLimit, typeWords } from "./words.ts";

const isMarkdown = (artifact: Artifact) =>
  artifact.mimeType === "text/markdown" || /\.(md|markdown)$/i.test(artifact.title);

/** The facts block: Name, Type, Size, Sent; and where the item is, when it is elsewhere. */
function Facts({ artifact, sentAt }: { artifact: Artifact; sentAt: number | null }) {
  const rows: Array<[string, string]> = [
    ["Name", artifact.title],
    ["Type", artifact.mimeType ?? "Not reported"],
    ["Size", artifact.size === null ? "Not reported" : formatSize(artifact.size)],
    ["Sent", sentAt === null ? "Not reported" : stampTime(sentAt)],
  ];
  if (artifact.place.kind === "elsewhere") rows.push(["At", artifact.place.host]);
  return (
    <dl className="facts reader-facts" data-testid="artifact-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd title={value}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ArtifactReader({
  artifactKey,
  backLabel,
  onBack,
  headingRef,
}: {
  artifactKey: string;
  backLabel: string;
  onBack: () => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const api = useArtifacts();
  const bridge = useBridge();
  const artifact = api?.list?.artifacts.find((each) => each.key === artifactKey) ?? null;
  // What was read, with the reading it answers: anything else is still loading.
  const [got, setGot] = useState<{ at: string; value: Content } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<"preview" | "source">("preview");
  const [raw, setRaw] = useState<ArtifactRecord | "loading" | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // On the gateway, or not established when listed: read when opened, and classified then.
  const canFetch = artifact ? fetchable(artifact) || artifact.place.kind === "unknown" : false;
  // Over Clawtrate's limit by the size the gateway gave: said without fetching.
  const tooLarge = artifact ? canFetch && overLimit(artifact) : false;

  useEffect(() => {
    if (!api || !artifact || !canFetch || tooLarge) return;
    let live = true;
    const at = `${artifact.key}:${attempt}`;
    void api.content(artifact).then((value) => live && setGot({ at, value }));
    return () => {
      live = false;
    };
  }, [artifact?.key, canFetch, tooLarge, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const retry = () => {
    if (artifact) api?.forget(artifact);
    setAttempt((n) => n + 1);
  };

  if (!api) return null;
  if (!artifact)
    return (
      <div className="reader" data-testid="artifact-reader">
        <div className="files-head">
          <button
            type="button"
            className="icon-button"
            data-variant="quiet"
            aria-label={backLabel}
            title={`${backLabel} (⌘[)`}
            onClick={onBack}
          >
            <BackIcon />
          </button>
          <h3 tabIndex={-1} ref={headingRef}>
            {api.list ? "Not in this task's items" : "Loading…"}
          </h3>
        </div>
        {api.list && (
          <p className="reader-why">The gateway no longer lists this item for this task.</p>
        )}
      </div>
    );

  const loaded: Content | { status: "loading" } =
    got?.at === `${artifact.key}:${attempt}` ? got.value : { status: "loading" };
  const name = downloadName(artifact);
  const sentAt = api.sentAt(artifact);
  const ready = loaded?.status === "ready" ? loaded : null;
  const siblings = [...api.byItem.values()].find((each) => each.includes(artifact)) ?? [artifact];
  const playing = api.playing?.key === artifact.key ? api.playing : null;

  // An address the message names, known when listed or learned on opening: never fetched here.
  const away =
    artifact.place.kind === "elsewhere"
      ? artifact.place
      : loaded.status === "elsewhere"
        ? { host: loaded.host, url: loaded.url }
        : null;

  let body;
  if (away) {
    const { url } = away;
    body = (
      <>
        <Facts artifact={artifact} sentAt={sentAt} />
        <p className="reader-why" data-testid="artifact-why">
          The message names this file by its address. Clawtrate doesn't fetch it; opening it leaves
          the app, and what is there may have changed since it was sent.
        </p>
        <p className="reader-address" data-testid="artifact-address">
          <code>{url}</code>
        </p>
        <p>
          <button
            type="button"
            className="button"
            data-variant="default"
            aria-label={`Open ${url} in your browser`}
            onClick={() => openInBrowser(url)}
          >
            <ExternalIcon />
            Open in your browser
          </button>
        </p>
      </>
    );
  } else if (artifact.mode === "unsupported" && artifact.kind === "image") {
    body = (
      <>
        <div className="media-quiet reader-quiet">
          <PictureIcon />
          <span>{artifact.title}</span>
          <span>No preview</span>
        </div>
        <p className="reader-why" data-testid="artifact-why">
          The gateway lists this picture, but not its content, so it can't be shown or downloaded
          here.
        </p>
      </>
    );
  } else if (!canFetch) {
    body = (
      <>
        <Facts artifact={artifact} sentAt={sentAt} />
        <p className="reader-why" data-testid="artifact-why">
          The gateway lists this item, but not its content, so it can't be opened or downloaded
          here.
        </p>
      </>
    );
  } else if (tooLarge) {
    body = (
      <>
        <Facts artifact={artifact} sentAt={sentAt} />
        <p className="reader-why" data-testid="artifact-why">
          {artifact.title} is {formatSize(artifact.size)}. Clawtrate opens and saves items up to 5
          MB (Clawtrate's limit), so it can't be opened here.
        </p>
      </>
    );
  } else if (!loaded || loaded.status === "loading") {
    body = (
      <p className="files-note" aria-busy="true" data-testid="artifact-loading">
        Loading {artifact.title}…
      </p>
    );
  } else if (loaded.status === "failed" || loaded.status === "gone") {
    body = (
      <div className="files-alert" role="alert" data-testid="artifact-failed">
        <span>
          Couldn't open {artifact.title}. {loaded.message}
        </span>
        <button type="button" className="button" data-size="sm" onClick={retry}>
          Try again
        </button>
      </div>
    );
  } else if (loaded.status === "too-large") {
    body = (
      <>
        <Facts artifact={artifact} sentAt={sentAt} />
        <p className="reader-why" data-testid="artifact-why">
          {artifact.title} is {formatSize(loaded.size ?? artifact.size)}. Clawtrate opens and saves
          items up to {formatSize(loaded.limit)} (Clawtrate's limit), so it can't be opened here.
        </p>
      </>
    );
  } else if (loaded.status !== "ready") {
    body = (
      <>
        <Facts artifact={artifact} sentAt={sentAt} />
        <p className="reader-why" data-testid="artifact-why">
          The gateway didn't send {artifact.title}.
        </p>
        <button type="button" className="button" onClick={retry}>
          Try again
        </button>
      </>
    );
  } else if (ready && ready.kind === "text" && ready.text !== null) {
    const markdown = isMarkdown(artifact);
    const shown = markdown ? view : "source";
    body = (
      <>
        {markdown && (
          <div className="seg reader-views" role="tablist" aria-label="View">
            {(["preview", "source"] as const).map((each) => (
              <button
                key={each}
                type="button"
                role="tab"
                aria-selected={shown === each}
                tabIndex={shown === each ? 0 : -1}
                onClick={() => setView(each)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                    event.preventDefault();
                    setView(each === "preview" ? "source" : "preview");
                  }
                }}
              >
                {each === "preview" ? "Preview" : "Source"}
              </button>
            ))}
          </div>
        )}
        <div
          className="reader-body"
          ref={bodyRef}
          tabIndex={0}
          aria-label={`${artifact.title}, ${shown === "preview" ? "preview" : "content"}`}
        >
          {shown === "preview" ? (
            <div className="reader-preview">
              <Markdown text={ready.text} />
            </div>
          ) : (
            <CodeView text={ready.text} wrap={false} />
          )}
        </div>
      </>
    );
  } else if (ready && ready.kind === "image") {
    body = (
      <button
        type="button"
        className="reader-image artifact-picture"
        aria-label={`Open ${artifact.title} full size`}
        onClick={(event) => openItem(api, artifact, siblings, event.currentTarget)}
      >
        <img src={ready.url} alt={artifact.title} data-testid="artifact-picture" />
      </button>
    );
  } else if (ready && ready.kind === "audio") {
    body = (
      <div className="audio-player">
        <div className="artifact" data-kind="audio">
          <button
            type="button"
            className="artifact-play"
            aria-pressed={playing !== null}
            aria-label={`${playing ? "Pause" : "Play"} ${artifact.title}`}
            onClick={() => api.togglePlay(artifact)}
          >
            <span className="artifact-tile" data-round="true">
              {playing ? <PauseIcon /> : <PlayIcon />}
            </span>
          </button>
          <span className="artifact-text">
            <MiddleName name={artifact.title} />
            <span className="artifact-sub">
              {playing
                ? `${clock(playing.time)} / ${playing.duration ? clock(playing.duration) : "…"}`
                : cardSub(artifact)}
            </span>
          </span>
        </div>
      </div>
    );
  } else if (ready && ready.kind === "video") {
    body = (
      <button
        type="button"
        className="reader-image artifact-video"
        aria-label={`Play ${artifact.title}`}
        onClick={(event) => openItem(api, artifact, siblings, event.currentTarget)}
      >
        <span className="media-quiet">
          {kindIcon(artifact)}
          <span>{artifact.title}</span>
        </span>
        <span className="media-play" aria-hidden="true">
          <PlayIcon />
        </span>
      </button>
    );
  } else {
    body = (
      <>
        <Facts artifact={artifact} sentAt={sentAt} />
        <p className="reader-why" data-testid="artifact-why">
          There's no preview for this kind of file.
        </p>
        <p>
          <button
            type="button"
            className="button"
            data-variant="default"
            onClick={() => void api.download(artifact)}
          >
            Download
          </button>
        </p>
      </>
    );
  }

  return (
    <div className="reader" data-testid="artifact-reader">
      <div className="files-head">
        <button
          type="button"
          className="icon-button"
          data-variant="quiet"
          aria-label={backLabel}
          title={`${backLabel} (⌘[)`}
          onClick={onBack}
        >
          <BackIcon />
        </button>
        <h3 tabIndex={-1} ref={headingRef} title={artifact.title}>
          {artifact.title}
        </h3>
        {ready && (
          <button
            type="button"
            className="icon-button"
            data-variant="quiet"
            aria-label={`Download ${name}`}
            title="Download"
            onClick={() => void api.download(artifact)}
          >
            <DownloadIcon />
          </button>
        )}
        {ready && (ready.text !== null || ready.kind === "image") && (
          <button
            type="button"
            className="icon-button"
            data-variant="quiet"
            aria-label={ready.kind === "image" ? "Copy the image" : `Copy the text of ${name}`}
            title="Copy"
            onClick={() =>
              void (ready.kind === "image" ? api.copyImage(artifact) : api.copyText(artifact))
            }
          >
            <CopyIcon />
          </button>
        )}
      </div>
      <p className="reader-meta">{cardSub(artifact)}</p>
      <p className="reader-source">
        <span>
          Sent by {api.bot}
          {sentAt !== null ? ` at ${clockTime(sentAt)}` : ""}
        </span>
        <button
          type="button"
          className="link-button"
          aria-label={`Show ${artifact.title} in the chat`}
          onClick={() => api.showInChat(artifact.key)}
        >
          Show in chat
        </button>
      </p>
      {body}
      <div className="card-actions artifact-raw">
        <button
          type="button"
          className="link-button"
          aria-expanded={raw !== null}
          onClick={() => {
            if (raw !== null) {
              setRaw(null);
              return;
            }
            setRaw("loading");
            bridge
              .invoke({ type: "readArtifactRecord", key: api.taskKey, artifactId: artifact.id })
              .then(setRaw, (reason: unknown) =>
                setRaw({
                  status: "failed",
                  message: reason instanceof Error ? reason.message : String(reason),
                }),
              );
          }}
        >
          Raw
        </button>
      </div>
      {raw !== null && (
        <div className="raw-panel" data-testid="artifact-raw">
          {raw === "loading" ? (
            <p className="files-note">Loading the record…</p>
          ) : raw.status === "ok" ? (
            <pre className="code-block">
              {raw.text}
              {raw.cut ? "\n… (cut here)" : ""}
            </pre>
          ) : (
            <p className="files-alert">Couldn't read the record. {raw.message}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** "Sent in chat" in the Files tab: the task's items newest first, as file rows. */
export function SentInChat({ onOpen }: { onOpen: (artifact: Artifact) => void }) {
  const api = useArtifacts();
  if (!api?.list) return null;
  const items = [...api.list.artifacts].reverse();
  // Pages are not artifacts: the transcript names them, and each row opens the same Page view.
  const pages = [...api.pages].reverse();
  if (items.length === 0 && pages.length === 0) return null;
  return (
    <section className="files-group" data-testid="sent-in-chat">
      <h3>Sent in chat</h3>
      <ul className="file-list">
        {pages.map((page) => (
          <li key={`page:${page.itemId}:${page.docId}`}>
            <button
              type="button"
              className="file-row"
              data-row={`page:${page.itemId}:${page.docId}`}
              data-testid="sent-page"
              aria-label={`${page.title}, page${page.sentAt !== null ? `, sent ${clockTime(page.sentAt)}` : ""}`}
              onClick={(event) => api.openPage(page, event.currentTarget)}
            >
              <span className="file-icon" aria-hidden="true">
                <DocumentIcon />
              </span>
              <span className="file-name">{page.title}</span>
              <span className="file-time">
                {page.sentAt !== null ? clockTime(page.sentAt) : ""}
              </span>
              <span className="file-sub">
                {page.sentAt !== null ? `Sent ${clockTime(page.sentAt)} · Page` : "Page"}
              </span>
            </button>
          </li>
        ))}
        {items.map((artifact) => {
          const sent = api.sentAt(artifact);
          const preview = artifact.kind === "image" ? api.preview(artifact) : undefined;
          const sub = [
            sent !== null ? `Sent ${clockTime(sent)}` : null,
            artifact.place.kind === "elsewhere"
              ? `from ${artifact.place.host}`
              : formatSize(artifact.size) || null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <li key={artifact.key}>
              <button
                type="button"
                className="file-row"
                data-row={`artifact:${artifact.key}`}
                aria-label={`${artifact.title}, ${typeWords(artifact)}${sub ? `, ${sub.replace(" · ", ", ")}` : ""}`}
                onClick={() => onOpen(artifact)}
              >
                <span
                  className={preview?.status === "ready" ? "file-icon file-thumb" : "file-icon"}
                  aria-hidden="true"
                >
                  {preview?.status === "ready" ? (
                    <img src={preview.url} alt="" />
                  ) : (
                    kindIcon(artifact)
                  )}
                </span>
                <span className="file-name">
                  <MiddleName name={artifact.title} />
                </span>
                <span className="file-time">{sent !== null ? clockTime(sent) : ""}</span>
                <span className="file-sub">{sub}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {api.list.omitted > 0 && (
        <p className="files-note">{api.list.omitted} more items didn't fit here.</p>
      )}
    </section>
  );
}
