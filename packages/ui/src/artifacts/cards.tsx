// A message's items in the conversation (work-pane.md, section 12): the file
// card, pictures and their grid, the video tile, the audio card, the link
// card and its preview, the page card, the card's menu, and a file the
// gateway did not attach. Cards sit under the bubble of the message they
// belong to, left-aligned with the bot's bubbles.

import type { Artifact, LinkPreview, TranscriptItem } from "@clawtrate/core";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useBridge } from "../bridge.tsx";
import {
  ArchiveIcon,
  DocumentIcon,
  FileIcon,
  LinkIcon,
  MediaIcon,
  MoreIcon,
  PauseIcon,
  PictureIcon,
  PlayIcon,
  WarnIcon,
} from "../icons.tsx";
import { Menu, type MenuEntry } from "../Menu.tsx";
import { nameParts } from "../work/files-format.ts";
import { useArtifacts, type ArtifactsApi, type ViewerEntry } from "./context.tsx";
import {
  cardSub,
  clock,
  downloadable,
  fetchable,
  trailingLink,
  typeWords,
  type LinkTarget,
} from "./words.ts";

/** A name cut in the middle, so its extension stays. */
export function MiddleName({ name }: { name: string }) {
  const { start, end } = nameParts(name);
  return (
    <span className="artifact-name" title={name}>
      <span className="name-start">{start}</span>
      {end && <span className="name-end">{end}</span>}
    </span>
  );
}

export function kindIcon(artifact: Artifact): ReactNode {
  if (artifact.kind === "image") return <PictureIcon />;
  if (artifact.kind === "video" || artifact.kind === "audio") return <MediaIcon />;
  const type = artifact.mimeType ?? "";
  if (/zip|tar|gzip|compressed/.test(type) || /\.(zip|tar|gz|tgz|7z)$/i.test(artifact.title))
    return <ArchiveIcon />;
  if (type === "application/pdf" || /\.pdf$/i.test(artifact.title)) return <DocumentIcon />;
  return <FileIcon />;
}

/** What the card's menu offers for an item (section 12, "The card's menu"). */
export function artifactEntries(
  api: ArtifactsApi,
  artifact: Artifact,
  siblings: Artifact[],
  opener: HTMLElement | null,
): MenuEntry[] {
  const entries: MenuEntry[] = [];
  const can = downloadable(artifact);
  entries.push({
    kind: "item",
    label: "Open",
    onSelect: () => openItem(api, artifact, siblings, opener),
  });
  if (can)
    entries.push({ kind: "item", label: "Download", onSelect: () => void api.download(artifact) });
  if (artifact.place.kind === "elsewhere") {
    const { url } = artifact.place;
    entries.push({
      kind: "item",
      label: "Open in your browser",
      // The whole address, shown beside the choice before anything leaves the app.
      note: url,
      onSelect: () => openInBrowser(url),
    });
  }
  if (can && artifact.kind === "image")
    entries.push({
      kind: "item",
      label: "Copy image",
      onSelect: () => void api.copyImage(artifact),
    });
  if (can && (artifact.kind === "image" || artifact.kind === "video"))
    entries.push({
      kind: "item",
      label: artifact.kind === "image" ? "Save image…" : "Save video…",
      onSelect: () => void api.download(artifact),
    });
  if (can && artifact.kind === "file" && isText(artifact))
    entries.push({ kind: "item", label: "Copy text", onSelect: () => void api.copyText(artifact) });
  entries.push({ kind: "item", label: "Show in Files", onSelect: () => api.openInPane(artifact) });
  const ready = siblings.filter(downloadable);
  if (siblings.length > 1 && ready.length >= 2)
    entries.push({
      kind: "item",
      label:
        ready.length === siblings.length
          ? `Download all ${siblings.length}`
          : `Download ${ready.length} of ${siblings.length}`,
      onSelect: () => void api.downloadAll(siblings),
    });
  return entries;
}

const isText = (artifact: Artifact) =>
  /^(text\/|application\/(json|yaml|xml))/.test(artifact.mimeType ?? "") ||
  /\.(md|txt|csv|json|ya?ml|log)$/i.test(artifact.title);

/** Only `http:` and `https:` leave for the system browser; the host opens them, never this window. */
export function openInBrowser(url: string) {
  try {
    const { protocol } = new URL(url);
    if (protocol === "http:" || protocol === "https:")
      window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    // Not an address: nothing to open.
  }
}

/** The viewer's sequence for an item: the fetchable pictures and videos of its message. */
export function viewerSequence(siblings: Artifact[]): ViewerEntry[] {
  return siblings
    .filter((each) => (each.kind === "image" || each.kind === "video") && downloadable(each))
    .map((artifact) => ({ type: "artifact", artifact }));
}

export function openItem(
  api: ArtifactsApi,
  artifact: Artifact,
  siblings: Artifact[],
  opener: HTMLElement | null,
) {
  const sequence = viewerSequence(siblings);
  const at = sequence.findIndex(
    (entry) => entry.type === "artifact" && entry.artifact.key === artifact.key,
  );
  if (at >= 0) api.openViewer(sequence, at, opener);
  else api.openInPane(artifact);
}

type MenuState = { artifact: Artifact; x: number; y: number; trigger: HTMLElement | null };

/** The menu's ways in: the More button, right-click, Shift+F10 or the Menu key, and touch and hold. */
function useCardMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = useCallback(
    (artifact: Artifact, x: number, y: number, trigger: HTMLElement | null) => {
      setMenu({
        artifact,
        x: Math.max(8, Math.min(x, window.innerWidth - 240)),
        y: Math.max(8, Math.min(y, window.innerHeight - 320)),
        trigger,
      });
    },
    [],
  );
  const at = (element: HTMLElement) => {
    const box = element.getBoundingClientRect();
    return { x: box.right - 232, y: box.bottom + 6 };
  };
  const handlers = (artifact: Artifact) => ({
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      open(artifact, event.clientX, event.clientY, event.currentTarget);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        const place = at(event.currentTarget);
        open(artifact, place.x, place.y, event.currentTarget);
      }
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType !== "touch") return;
      const target = event.currentTarget;
      const { clientX, clientY } = event;
      hold.current = setTimeout(() => open(artifact, clientX, clientY, target), 500);
    },
    onPointerUp: () => hold.current && clearTimeout(hold.current),
    onPointerCancel: () => hold.current && clearTimeout(hold.current),
  });
  return { menu, setMenu, open, at, handlers };
}

function MoreButton({
  label,
  onOpen,
  className = "artifact-more",
}: {
  label: string;
  onOpen: (button: HTMLElement) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      data-variant="quiet"
      aria-haspopup="menu"
      aria-label={`More for ${label}`}
      title="More"
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <MoreIcon />
    </button>
  );
}

/** A file or a recording: one button that opens it in the pane, and More. */
function FileCard({
  api,
  artifact,
  menu,
}: {
  api: ArtifactsApi;
  artifact: Artifact;
  menu: ReturnType<typeof useCardMenu>;
}) {
  const audio = artifact.kind === "audio";
  const playing = api.playing?.key === artifact.key ? api.playing : null;
  const sub = cardSub(artifact);
  const spoken =
    artifact.place.kind === "elsewhere"
      ? `${artifact.title}, ${typeWords(artifact)}, from ${artifact.place.host}. Open in the Work pane.`
      : `${[artifact.title, sub.replace(" · ", ", ")].join(", ")}. Open in the Work pane.`;
  return (
    <div
      className="artifact"
      data-kind={artifact.kind}
      data-artifact={artifact.key}
      data-testid="artifact-card"
      {...menu.handlers(artifact)}
    >
      {audio && fetchable(artifact) && (
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
      )}
      <button
        type="button"
        className="artifact-main"
        aria-label={spoken}
        onClick={() => api.openInPane(artifact)}
      >
        {!(audio && fetchable(artifact)) && (
          <span className="artifact-tile">{kindIcon(artifact)}</span>
        )}
        <span className="artifact-text">
          <MiddleName name={artifact.title} />
          <span className="artifact-sub">
            {playing ? (
              <>
                <span className="audio-track" aria-hidden="true">
                  <span
                    style={{
                      width: `${playing.duration ? Math.min(100, (playing.time / playing.duration) * 100) : 0}%`,
                    }}
                  />
                </span>
                {clock(playing.time)} / {playing.duration ? clock(playing.duration) : "…"}
              </>
            ) : (
              sub
            )}
          </span>
        </span>
      </button>
      <MoreButton
        label={artifact.title}
        onOpen={(button) => {
          const place = menu.at(button);
          menu.open(artifact, place.x, place.y, button);
        }}
      />
    </div>
  );
}

/** One cell of the picture grid, or a picture by itself: drawn from its preview once that is fetched. */
function MediaCell({
  api,
  artifact,
  siblings,
  single,
  menu,
}: {
  api: ArtifactsApi;
  artifact: Artifact;
  siblings: Artifact[];
  single: boolean;
  menu: ReturnType<typeof useCardMenu>;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const can = fetchable(artifact);
  const { wantPreview } = api;
  // Asked for when the cell comes into view, from the gateway only.
  useEffect(() => {
    const element = ref.current;
    if (!element || !can || artifact.kind !== "image") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        wantPreview(artifact);
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [artifact, can, wantPreview]);
  const preview = api.preview(artifact);
  const shown = preview?.status === "ready" ? preview.url : null;
  const busy =
    can && artifact.kind === "image" && (preview === undefined || preview.status === "loading");
  const video = artifact.kind === "video";
  return (
    <button
      ref={ref}
      type="button"
      className="media-cell"
      data-kind={artifact.kind}
      data-artifact={artifact.key}
      data-testid="media-cell"
      aria-busy={busy || undefined}
      aria-label={
        video
          ? `${artifact.title}, video. Play`
          : can
            ? `${artifact.title}. Open full size`
            : `${artifact.title}. Open in the Work pane`
      }
      onClick={(event) => openItem(api, artifact, siblings, event.currentTarget)}
      {...menu.handlers(artifact)}
    >
      {shown ? (
        <img src={shown} alt="" draggable={false} data-single={single || undefined} />
      ) : (
        <span className="media-quiet">
          <PictureIcon />
          <span>{artifact.title}</span>
          <span>{busy || video ? (cardSub(artifact).split(" · ")[1] ?? "") : "No preview"}</span>
        </span>
      )}
      {video && (
        <span className="media-play" aria-hidden="true">
          <PlayIcon />
        </span>
      )}
    </button>
  );
}

function MediaGrid({
  api,
  media,
  siblings,
  menu,
}: {
  api: ArtifactsApi;
  media: Artifact[];
  siblings: Artifact[];
  menu: ReturnType<typeof useCardMenu>;
}) {
  const shown = media.length > 4 ? media.slice(0, 4) : media;
  const extra = media.length - shown.length;
  return (
    <div className="media-grid" data-count={Math.min(media.length, 4)} data-testid="media-grid">
      {shown.map((artifact, i) => (
        <div className="media-slot" key={artifact.key}>
          <MediaCell
            api={api}
            artifact={artifact}
            siblings={siblings}
            single={media.length === 1}
            menu={menu}
          />
          {extra > 0 && i === 3 && (
            <span className="media-extra" aria-hidden="true">
              +{extra + 1}
            </span>
          )}
        </div>
      ))}
      <MoreButton
        className="media-more"
        label={media.length === 1 ? media[0]!.title : `these ${media.length} items`}
        onOpen={(button) => {
          const place = menu.at(button);
          menu.open(media[0]!, place.x, place.y, button);
        }}
      />
    </div>
  );
}

/** A link the bot ended its message with: opens in the system browser; its preview on hover or hold. */
function LinkCard({ link }: { link: LinkTarget }) {
  const bridge = useBridge();
  const [preview, setPreview] = useState<LinkPreview | "loading" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const asked = useRef(false);
  const ask = () => {
    if (!asked.current) {
      asked.current = true;
      setPreview("loading");
      bridge
        .invoke({ type: "previewLink", url: link.url })
        .then(setPreview, () => setPreview({ status: "none", url: link.url }));
    } else if (preview === null) setPreview({ status: "none", url: link.url });
  };
  const [shown, setShown] = useState(false);
  const start = () => {
    timer.current = setTimeout(() => {
      setShown(true);
      ask();
    }, 500);
  };
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    setShown(false);
  };
  return (
    <div
      className="artifact"
      data-kind="link"
      data-testid="link-card"
      onMouseEnter={start}
      onMouseLeave={stop}
    >
      <button
        type="button"
        className="artifact-main"
        aria-label={`${link.text}, ${link.host}. Opens in your browser.`}
        onClick={() => openInBrowser(link.url)}
        onPointerDown={(event) => {
          if (event.pointerType === "touch") start();
        }}
        onPointerUp={(event) => {
          if (event.pointerType === "touch" && timer.current) clearTimeout(timer.current);
        }}
        onContextMenu={(event) => {
          if (shown) event.preventDefault();
        }}
      >
        <span className="artifact-tile">
          <LinkIcon />
        </span>
        <span className="artifact-text">
          <span className="artifact-name">{link.text}</span>
          <span className="artifact-sub">{link.host}</span>
        </span>
      </button>
      {shown && preview !== null && (
        <div className="link-preview" role="tooltip" data-testid="link-preview">
          {preview === "loading" ? (
            <span>Loading the preview…</span>
          ) : preview.status === "ok" ? (
            <>
              {preview.image && (
                <img src={`data:${preview.image.mimeType};base64,${preview.image.data}`} alt="" />
              )}
              {preview.title && <strong>{preview.title}</strong>}
              {preview.description && <p>{preview.description}</p>}
              <span>{link.url}</span>
            </>
          ) : (
            <>
              <span>{link.url}</span>
              <p>No preview</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PageCard({
  api,
  docId,
  title,
  newer,
  itemId,
}: {
  api: ArtifactsApi;
  docId: string;
  title: string;
  newer: boolean;
  itemId: string;
}) {
  const key = `page:${itemId}:${docId}`;
  return (
    <div className="artifact" data-kind="page" data-artifact={key} data-testid="page-card">
      <button
        type="button"
        className="artifact-main"
        aria-label={`${title}, page.${newer ? " A newer version is below." : ""} Open`}
        onClick={(event) =>
          api.openViewer([{ type: "page", docId, title, key }], 0, event.currentTarget)
        }
      >
        <span className="artifact-tile">
          <DocumentIcon />
        </span>
        <span className="artifact-text">
          <span className="artifact-name">{title}</span>
          <span className="artifact-sub">{newer ? "Page · A newer version is below" : "Page"}</span>
        </span>
        <span className="artifact-open" aria-hidden="true">
          Open
        </span>
      </button>
    </div>
  );
}

const REFUSALS: Record<string, string> = {
  "delivery-failed": "The gateway couldn't attach it.",
  "file-not-found": "The file wasn't there to attach.",
  "invalid-reference": "The gateway doesn't attach files from that address.",
  "unsupported-format": "The gateway doesn't attach files of this kind.",
};

/** A file the bot named that the gateway did not attach: said, never offered. */
function RefusedCard({ label, code }: { label: string; code: string }) {
  return (
    <div className="artifact" data-kind="refused" data-testid="refused-card">
      <div
        className="artifact-main"
        role="group"
        aria-label={`${label}, not attached. ${REFUSALS[code] ?? "The gateway didn't attach it."}`}
      >
        <span className="artifact-tile" data-tone="warn">
          <WarnIcon />
        </span>
        <span className="artifact-text">
          <MiddleName name={label} />
          <span className="artifact-sub">
            Not attached · {REFUSALS[code] ?? "The gateway didn't attach it."}
          </span>
        </span>
      </div>
    </div>
  );
}

/**
 * Everything one message handed over, under its bubble: the link it ends
 * with, its pages, its files and recordings, then its pictures and videos,
 * and what the gateway did not attach.
 */
export function MessageArtifacts({ item }: { item: TranscriptItem }) {
  const api = useArtifacts();
  const menu = useCardMenu();
  if (!api) return null;
  const artifacts = api.byItem.get(item.id) ?? [];
  const texts = item.blocks.filter((block) => block.kind === "text");
  const lastText = texts.at(-1);
  const link = lastText && lastText.kind === "text" ? trailingLink(lastText.text) : null;
  const pages = item.blocks.filter((block) => block.kind === "page");
  const refused = item.blocks.filter((block) => block.kind === "attachment-error");
  const files = artifacts.filter((each) => each.kind === "file" || each.kind === "audio");
  const media = artifacts.filter((each) => each.kind === "image" || each.kind === "video");
  if (!link && pages.length === 0 && artifacts.length === 0 && refused.length === 0) return null;
  const close = (refocus: boolean) => {
    const trigger = menu.menu?.trigger;
    menu.setMenu(null);
    if (refocus) trigger?.focus();
  };
  return (
    <div className="artifacts" data-msg={item.id} data-testid="message-artifacts">
      {link && <LinkCard link={link} />}
      {pages.map((block) =>
        block.kind === "page" ? (
          <PageCard
            key={block.docId}
            api={api}
            docId={block.docId}
            title={block.title ?? "Page"}
            newer={api.newerPages.has(`${item.id}:${block.docId}`)}
            itemId={item.id}
          />
        ) : null,
      )}
      {files.map((artifact) => (
        <FileCard key={artifact.key} api={api} artifact={artifact} menu={menu} />
      ))}
      {media.length > 0 && <MediaGrid api={api} media={media} siblings={artifacts} menu={menu} />}
      {refused.map((block, i) =>
        block.kind === "attachment-error" ? (
          <RefusedCard key={i} label={block.label} code={block.code} />
        ) : null,
      )}
      {menu.menu && (
        <Menu
          label={menu.menu.artifact.title}
          className="rail-menu artifact-menu"
          style={{ left: menu.menu.x, top: menu.menu.y }}
          entries={artifactEntries(api, menu.menu.artifact, artifacts, menu.menu.trigger).map(
            (entry) =>
              entry.kind === "item"
                ? {
                    ...entry,
                    onSelect: () => {
                      close(false);
                      entry.onSelect();
                    },
                  }
                : entry,
          )}
          onClose={close}
          trigger={menu.menu.trigger}
        />
      )}
    </div>
  );
}
