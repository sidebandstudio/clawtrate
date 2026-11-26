// The files a person sent, on their own message (#451), in the order sent. A
// picture shows from this app's own copy while it holds one; otherwise the host
// reads it back from the gateway (`readSentPicture`, #469), once the picture is
// on screen. While it loads, a quiet placeholder keeps its place. A line shows
// only when it truly can't be shown: this connection can't load it back, the
// gateway no longer keeps it, or the read failed, with Try again. Any other
// file, a picture of a type not drawn, one over 5 MB, or one whose bytes aren't
// the picture it is named as, is its name and size.

import {
  isShownPictureType,
  MAX_PICTURE_BYTES,
  toBase64,
  type SentAttachment,
} from "@clawtrate/core";
import { useEffect, useRef, useState, type Ref } from "react";
import { useBridge } from "./bridge.tsx";
import { size } from "./Composer.tsx";
import { FileIcon } from "./icons.tsx";
import { OpenablePicture } from "./PictureViewer.tsx";
import { screenStamp, shownStamp, type ShownStamp } from "./stamp.ts";
import { collectBytes } from "./work/content.ts";

export type SentPictureShown =
  | { status: "loading" }
  | { status: "shown"; url: string }
  | { status: "not-a-picture" }
  | { status: "cannot-load" }
  | { status: "gone" }
  | { status: "failed" };

/** The one line a picture that isn't shown carries, by why. */
export const SENT_PICTURE_LINES = {
  "cannot-load": "This connection can't load the picture back from the gateway.",
  gone: "The gateway no longer keeps this picture.",
  failed: "The picture didn't load.",
} as const;

const sizeOf = (file: SentAttachment) => (file.sizeBytes === null ? "" : size(file.sizeBytes));

/** The text a picture you sent is read out as. */
export const sentPictureAlt = (file: SentAttachment) => `Your picture: ${file.fileName}`;

/** One picture you sent, in each of its states. */
export function SentPictureView({
  file,
  shown,
  placeholder,
  onRetry,
  onDrawError,
}: {
  file: SentAttachment;
  shown: SentPictureShown;
  /** The loading placeholder: what is watched to start the read once it is on screen. */
  placeholder?: Ref<HTMLElement>;
  onRetry: () => void;
  onDrawError: () => void;
}) {
  if (shown.status === "shown")
    return (
      <figure className="picture sent-picture" data-testid="sent-picture" data-state="shown">
        <OpenablePicture url={shown.url} alt={sentPictureAlt(file)} onError={onDrawError} />
      </figure>
    );
  if (shown.status === "loading")
    return (
      <figure
        ref={placeholder}
        className="picture sent-picture sent-picture-loading"
        data-testid="sent-picture"
        data-state="loading"
        aria-busy="true"
      >
        <span className="visually-hidden">{`Loading ${sentPictureAlt(file)}`}</span>
      </figure>
    );
  // Named as a picture, but its bytes aren't one, or it's over 5 MB: a file, by its name and size.
  if (shown.status === "not-a-picture") return <SentFile file={file} />;
  return (
    <p className="sent-file" data-testid="sent-picture" data-state={shown.status}>
      <FileIcon aria-hidden="true" />
      <span className="sent-file-name">{file.fileName}</span>
      <span className="sent-file-size">{sizeOf(file)}</span>
      <span className="sent-file-note">
        {SENT_PICTURE_LINES[shown.status]}
        {shown.status === "failed" && (
          <button type="button" className="button sent-file-retry" onClick={onRetry}>
            Try again
          </button>
        )}
      </span>
    </p>
  );
}

function SentPicture({
  taskKey,
  messageKey,
  index,
  file,
}: {
  taskKey: string;
  messageKey: string | null;
  index: number;
  file: SentAttachment;
}) {
  const bridge = useBridge();
  const [shown, setShown] = useState<SentPictureShown>(
    messageKey ? { status: "loading" } : { status: "cannot-load" },
  );
  const [attempt, setAttempt] = useState(0);
  // Read only once the placeholder is on screen: a message scrolled past asks for nothing.
  const [onScreen, setOnScreen] = useState(false);
  const placeholder = useRef<HTMLElement>(null);
  // Where this conversation was drawn: a read back goes only to that gateway.
  const drawnOn = useRef<ShownStamp | null>(null);
  useEffect(() => {
    if (onScreen || shown.status !== "loading") return;
    const element = placeholder.current;
    if (!element || typeof IntersectionObserver === "undefined") return setOnScreen(true);
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setOnScreen(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onScreen, shown.status]);
  useEffect(() => {
    if (!messageKey || !onScreen) return;
    let current = true;
    const set = (next: SentPictureShown) => current && setShown(next);
    drawnOn.current ??= shownStamp(bridge.getState().connection);
    screenStamp(bridge, drawnOn.current)
      .then((stamp) =>
        bridge.invoke({ type: "readSentPicture", key: taskKey, messageKey, index, stamp }),
      )
      .then(
        async (read) => {
          if (read.status !== "content")
            return set(read.status === "failed" ? { status: "failed" } : { status: read.status });
          const data = await collectBytes(bridge, read.transfer, read.bytes);
          if (!(data instanceof Uint8Array)) return set({ status: "failed" });
          set({ status: "shown", url: `data:${read.mimeType};base64,${toBase64(data)}` });
        },
        () => set({ status: "failed" }),
      );
    return () => {
      current = false;
    };
  }, [bridge, taskKey, messageKey, index, onScreen, attempt]);

  return (
    <SentPictureView
      file={file}
      shown={shown}
      placeholder={placeholder}
      onRetry={() => {
        setShown({ status: "loading" });
        setAttempt((n) => n + 1);
      }}
      onDrawError={() => setShown({ status: "failed" })}
    />
  );
}

/** A file you sent that isn't shown as a picture: its name and size. */
function SentFile({ file }: { file: SentAttachment }) {
  return (
    <p className="sent-file" data-testid="sent-file">
      <FileIcon aria-hidden="true" />
      <span className="sent-file-name">{file.fileName}</span>
      <span className="sent-file-size">{sizeOf(file)}</span>
    </p>
  );
}

/**
 * Every file of your message, in its order. `messageKey` names your message: the outgoing
 * message's id, or the key history stored the row under; null when there is none to ask for.
 */
export function SentFiles({
  taskKey,
  messageKey,
  files,
}: {
  taskKey: string;
  messageKey: string | null;
  files: readonly SentAttachment[];
}) {
  if (files.length === 0) return null;
  return (
    <div className="sent-files" data-testid="sent-files">
      {files.map((file, index) =>
        isShownPictureType(file.mimeType) &&
        (file.sizeBytes === null || file.sizeBytes <= MAX_PICTURE_BYTES) ? (
          <SentPicture
            key={index}
            taskKey={taskKey}
            messageKey={messageKey}
            index={index}
            file={file}
          />
        ) : (
          <SentFile key={index} file={file} />
        ),
      )}
    </div>
  );
}
