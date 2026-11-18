// The media viewer (work-pane.md, section 14): pictures, videos and pages in
// one modal dialog over the whole window, on the dark theme's ground in
// either theme. Escape closes, Left and Right move, ⌘C copies the picture,
// ⌘S saves; focus starts on Close, stays inside, and returns to what opened it.
//
// A page is the gateway's canvas document shown in a frame of its own: an
// opaque origin (`sandbox` without `allow-same-origin`), under a policy that
// lets it load nothing from anywhere and run no script. It never runs inside
// the app's window with the app's privileges.

import { type Artifact } from "@clawtrate/core";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBridge } from "../bridge.tsx";
import { BackIcon, ChevronIcon, CloseIcon, CopyIcon, DownloadIcon } from "../icons.tsx";
import { Menu, type MenuEntry } from "../Menu.tsx";
import { collect, useArtifacts, type Content, type ViewerEntry } from "./context.tsx";
import { downloadName } from "./words.ts";

const SPEEDS = [0.5, 1, 1.5, 2] as const;
/** The video speed, kept for the session (section 14). */
let sessionSpeed = 1;

/** What a page may do in the viewer's frame: nothing but draw itself. */
export const PAGE_POLICY =
  "default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; font-src data:";

/**
 * A page's HTML for the frame: parsed aside (a parsed document loads nothing),
 * its scripts removed, and the frame's policy put first in its head, so it
 * binds before anything the page asks for.
 */
export function framedPage(html: string): string {
  const page = new DOMParser().parseFromString(html, "text/html");
  for (const script of page.querySelectorAll("script, base, meta[http-equiv]")) script.remove();
  const policy = page.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = PAGE_POLICY;
  page.head.prepend(policy);
  return `<!doctype html>${page.documentElement.outerHTML}`;
}

type Loaded = Content | { status: "loading" } | { status: "page"; html: string };

function entryTitle(entry: ViewerEntry) {
  return entry.type === "page" ? entry.title : entry.artifact.title;
}

export function MediaViewer() {
  const api = useArtifacts();
  const bridge = useBridge();
  const viewer = api?.viewer ?? null;
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // What was read, with the reading it answers: anything else is still loading.
  const [got, setGot] = useState<{ at: string; value: Loaded } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The item shown at its actual size, if any: another item opens fitted.
  const [actual, setActual] = useState<string | null>(null);
  const [speed, setSpeed] = useState(sessionSpeed);
  const [speedMenu, setSpeedMenu] = useState<HTMLElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Swipes on a touch screen: left and right move, down closes.
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const entry = viewer ? viewer.entries[viewer.index] : undefined;
  const key = entry ? (entry.type === "page" ? entry.key : entry.artifact.key) : null;

  useEffect(() => {
    if (viewer) closeRef.current?.focus();
  }, [viewer !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!api || !entry) return;
    let live = true;
    const at = `${key}:${attempt}`;
    const setLoaded = (value: Loaded) => live && setGot({ at, value });
    if (entry.type === "page") {
      bridge
        .invoke({ type: "readPage", key: api.taskKey, docId: entry.docId })
        .then(async (read) => {
          if (read.status !== "content")
            return {
              status: "failed" as const,
              message:
                read.status === "too-large"
                  ? "The page is larger than Clawtrate shows."
                  : read.message,
            };
          const data = await collect(bridge, read.transfer, read.bytes);
          return { status: "page" as const, html: new TextDecoder().decode(data) };
        })
        .catch((reason: unknown) => ({
          status: "failed" as const,
          message: reason instanceof Error ? reason.message : String(reason),
        }))
        .then(setLoaded);
    } else {
      void api.content(entry.artifact).then(setLoaded);
    }
    return () => {
      live = false;
    };
  }, [key, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!api || !viewer || !entry) return null;
  const loaded: Loaded = got?.at === `${key}:${attempt}` ? got.value : { status: "loading" };
  const count = viewer.entries.length;
  const index = viewer.index;
  const artifact = entry.type === "artifact" ? entry.artifact : null;
  const title = entryTitle(entry);
  const ready = loaded.status === "ready" ? loaded : null;
  const move = (step: number) => {
    if (count < 2) return;
    setMenu(null);
    api.setViewerIndex((index + step + count) % count);
  };
  const copy = () => artifact && ready?.kind === "image" && void api.copyImage(artifact);
  const save = () => artifact && ready && void api.download(artifact);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const meta = event.metaKey || event.ctrlKey;
    if (event.key === "Escape") {
      if (speedMenu || menu) return;
      event.preventDefault();
      api.closeViewer();
    } else if (event.key === "ArrowLeft" && !speedMenu && !menu && !isControl(event.target)) {
      event.preventDefault();
      move(-1);
    } else if (event.key === "ArrowRight" && !speedMenu && !menu && !isControl(event.target)) {
      event.preventDefault();
      move(1);
    } else if (meta && event.key.toLowerCase() === "c" && ready?.kind === "image") {
      event.preventDefault();
      copy();
    } else if (meta && event.key.toLowerCase() === "s" && ready) {
      event.preventDefault();
      save();
    } else if (event.key === "Tab") {
      // Tab stays inside the viewer.
      const items = [
        ...(dialog.current?.querySelectorAll<HTMLElement>("button, [tabindex], video, iframe") ??
          []),
      ].filter((element) => element.tabIndex >= 0);
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };

  let stage: ReactNode;
  if (loaded.status === "loading") {
    const thumb = artifact ? api.preview(artifact) : undefined;
    stage = (
      <div className="viewer-loading" aria-busy="true" aria-label={`Loading ${title}`}>
        {thumb?.status === "ready" && <img src={thumb.url} alt="" />}
        <span className="glyph" data-state="working" aria-hidden="true" />
      </div>
    );
  } else if (loaded.status === "page") {
    stage = (
      <iframe
        className="viewer-page"
        title={title}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={framedPage(loaded.html)}
        data-testid="viewer-page"
      />
    );
  } else if (loaded.status === "ready" && loaded.kind === "image") {
    stage = (
      <div
        className="viewer-image"
        data-zoom={actual === key ? "actual" : "fit"}
        onClick={() => setActual((now) => (now === key ? null : key))}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <img src={loaded.url} alt={title} draggable={false} data-testid="viewer-image" />
      </div>
    );
  } else if (loaded.status === "ready" && loaded.kind === "video") {
    stage = (
      <div
        className="viewer-video"
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <video
          src={loaded.url}
          controls
          aria-label={title}
          data-testid="viewer-video"
          ref={(video) => {
            if (video) video.playbackRate = speed;
          }}
          onKeyDown={(event) => {
            if (event.key === " ") {
              event.preventDefault();
              const video = event.currentTarget;
              if (video.paused) void video.play();
              else video.pause();
            }
          }}
        />
        <div className="video-bar">
          <button
            type="button"
            className="speed-button"
            aria-haspopup="menu"
            aria-expanded={speedMenu !== null}
            aria-label={`Speed: ${speed}×`}
            onClick={(event) => setSpeedMenu(event.currentTarget)}
          >
            {speed}×
          </button>
          {speedMenu && (
            <Menu
              label="Speed"
              className="speed-menu"
              entries={SPEEDS.map((each): MenuEntry => ({
                kind: "radio",
                label: `${each}×`,
                checked: each === speed,
                onSelect: () => {
                  sessionSpeed = each;
                  setSpeed(each);
                  setSpeedMenu(null);
                  speedMenu.focus();
                },
              }))}
              onClose={(refocus) => {
                const trigger = speedMenu;
                setSpeedMenu(null);
                if (refocus) trigger.focus();
              }}
              trigger={speedMenu}
            />
          )}
        </div>
      </div>
    );
  } else {
    const why =
      loaded.status === "failed" || loaded.status === "gone"
        ? loaded.message
        : loaded.status === "too-large"
          ? "It is larger than the 5 MB Clawtrate opens (Clawtrate's limit)."
          : loaded.status === "ready"
            ? "This device can't show it."
            : "The gateway sent nothing to show.";
    stage = (
      <div className="viewer-failed" role="alert">
        <p>
          {entry.type === "page" ? "This page can't be shown here." : `Couldn't load ${title}.`}{" "}
          {why}
        </p>
        <button
          type="button"
          className="button"
          onClick={() => {
            if (artifact) api.forget(artifact);
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  const menuEntries: MenuEntry[] =
    artifact && ready
      ? ready.kind === "image"
        ? [
            {
              kind: "item",
              label: "Copy image",
              onSelect: () => {
                setMenu(null);
                copy();
              },
            },
            {
              kind: "item",
              label: "Save image…",
              onSelect: () => {
                setMenu(null);
                save();
              },
            },
          ]
        : [
            {
              kind: "item",
              label: "Save video…",
              onSelect: () => {
                setMenu(null);
                save();
              },
            },
          ]
      : [];

  return createPortal(
    <div
      className="viewer"
      data-theme="dark"
      role="dialog"
      aria-modal="true"
      aria-label={count > 1 ? `${title}, ${index + 1} of ${count}` : title}
      ref={dialog}
      // A click on the picture keeps focus in the dialog, so its keys keep working.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-testid="media-viewer"
      onPointerDown={(event) => {
        if (event.pointerType === "touch") swipe.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={(event) => {
        const start = swipe.current;
        swipe.current = null;
        if (!start || event.pointerType !== "touch") return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (dy > 80 && Math.abs(dy) > Math.abs(dx)) api.closeViewer();
        else if (Math.abs(dx) > 60) move(dx < 0 ? 1 : -1);
      }}
    >
      <div className="viewer-bar">
        <div className="viewer-title">
          <strong>{title}</strong>
          {count > 1 && (
            <span>
              {index + 1} of {count}
            </span>
          )}
        </div>
        {artifact && ready && (
          <button
            type="button"
            className="icon-button"
            aria-label={`Download ${downloadName(artifact)}`}
            title="Download (⌘S)"
            onClick={save}
          >
            <DownloadIcon />
          </button>
        )}
        {artifact && ready?.kind === "image" && (
          <button
            type="button"
            className="icon-button"
            aria-label="Copy the image"
            title="Copy (⌘C)"
            onClick={copy}
          >
            <CopyIcon />
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          ref={closeRef}
          aria-label="Close the viewer"
          title="Close (Esc)"
          onClick={api.closeViewer}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="viewer-stage">{stage}</div>
      {count > 1 && (
        <>
          <button
            type="button"
            className="icon-button viewer-nav"
            data-side="start"
            aria-label="Previous"
            onClick={() => move(-1)}
          >
            <BackIcon />
          </button>
          <button
            type="button"
            className="icon-button viewer-nav"
            data-side="end"
            aria-label="Next"
            onClick={() => move(1)}
          >
            <ChevronIcon />
          </button>
          <div className="viewer-strip" role="group" aria-label="Items">
            {viewer.entries.slice(0, 12).map((each, n) => (
              <Thumb
                key={n}
                entry={each}
                current={n === index}
                onChoose={() => api.setViewerIndex(n)}
              />
            ))}
          </div>
        </>
      )}
      {menu && menuEntries.length > 0 && (
        <Menu
          label={title}
          className="rail-menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 240),
            top: Math.min(menu.y, window.innerHeight - 120),
          }}
          entries={menuEntries}
          onClose={() => setMenu(null)}
        />
      )}
    </div>,
    document.querySelector(".app") ?? document.body,
  );
}

const isControl = (target: EventTarget) =>
  target instanceof HTMLElement &&
  (target.tagName === "VIDEO" || target.getAttribute("role") === "slider");

function Thumb({
  entry,
  current,
  onChoose,
}: {
  entry: ViewerEntry;
  current: boolean;
  onChoose: () => void;
}) {
  const api = useArtifacts();
  const artifact: Artifact | null = entry.type === "artifact" ? entry.artifact : null;
  const preview = artifact ? api?.preview(artifact) : undefined;
  return (
    <button
      type="button"
      className="viewer-thumb"
      aria-label={entryTitle(entry)}
      aria-current={current}
      onClick={onChoose}
    >
      {preview?.status === "ready" && <img src={preview.url} alt="" />}
    </button>
  );
}
