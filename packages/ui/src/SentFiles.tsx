// The files a person sent, on their own message (#451), in the order sent. A
// picture shows from this app's own copy (`readSentPicture`), as long as this
// app holds it. Clawtrate doesn't load a person's picture from the gateway
// (#469), so on another device, or once the task was closed, the message says
// plainly that a picture was sent and isn't shown. Any other file, a picture of
// a type not drawn, one over 5 MB, or one whose bytes aren't the picture it is
// named as, is its name and size.

import {
  isShownPictureType,
  MAX_PICTURE_BYTES,
  toBase64,
  type SentAttachment,
} from "@clawtrate/core";
import { useEffect, useState } from "react";
import { useBridge } from "./bridge.tsx";
import { size } from "./Composer.tsx";
import { FileIcon } from "./icons.tsx";
import { OpenablePicture } from "./PictureViewer.tsx";
import { collectBytes } from "./work/content.ts";

type Shown =
  | { status: "loading" }
  | { status: "shown"; url: string }
  | { status: "not-kept" }
  | { status: "not-a-picture" }
  | { status: "failed"; message: string };

const sizeOf = (file: SentAttachment) => (file.sizeBytes === null ? "" : size(file.sizeBytes));

/** The text a picture you sent is read out as. */
export const sentPictureAlt = (file: SentAttachment) => `Your picture: ${file.fileName}`;

function SentPicture({
  taskKey,
  sessionId,
  messageKey,
  index,
  file,
}: {
  taskKey: string;
  sessionId: string | undefined;
  messageKey: string | null;
  index: number;
  file: SentAttachment;
}) {
  const bridge = useBridge();
  const [shown, setShown] = useState<Shown>(
    messageKey ? { status: "loading" } : { status: "not-kept" },
  );
  useEffect(() => {
    if (!messageKey) return;
    let current = true;
    const set = (next: Shown) => current && setShown(next);
    bridge
      .invoke({
        type: "readSentPicture",
        key: taskKey,
        messageKey,
        index,
        ...(sessionId ? { sessionId } : {}),
      })
      .then(
        async (read) => {
          if (read.status !== "content") return set(read);
          const data = await collectBytes(bridge, read.transfer, read.bytes);
          if (!(data instanceof Uint8Array))
            return set({ status: "failed", message: data.message });
          set({ status: "shown", url: `data:${read.mimeType};base64,${toBase64(data)}` });
        },
        (error: unknown) =>
          set({
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          }),
      );
    return () => {
      current = false;
    };
  }, [bridge, taskKey, sessionId, messageKey, index]);

  if (shown.status === "shown")
    return (
      <figure className="picture sent-picture" data-testid="sent-picture" data-state="shown">
        <OpenablePicture
          url={shown.url}
          alt={sentPictureAlt(file)}
          onError={() =>
            setShown({ status: "failed", message: "This device couldn't draw the picture." })
          }
        />
      </figure>
    );
  // Named as a picture, but its bytes aren't one: a file, by its name and size.
  if (shown.status === "not-a-picture") return <SentFile file={file} />;
  return (
    <p className="sent-file" data-testid="sent-picture" data-state={shown.status}>
      <FileIcon aria-hidden="true" />
      <span className="sent-file-name">{file.fileName}</span>
      <span className="sent-file-size">{sizeOf(file)}</span>
      <span className="sent-file-note" role={shown.status === "failed" ? "alert" : undefined}>
        {shown.status === "loading"
          ? "Loading the picture…"
          : shown.status === "not-kept"
            ? "Picture sent with this message. It shows only on the device that sent it, while the task is open."
            : `Couldn't show the picture. ${shown.message}`}
      </span>
    </p>
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
 * Every file of your message, in its order. `messageKey` names your copy: the outgoing message's
 * id, or the key history stored the row under; null when there is none to ask for.
 */
export function SentFiles({
  taskKey,
  sessionId,
  messageKey,
  files,
}: {
  taskKey: string;
  sessionId?: string | undefined;
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
            sessionId={sessionId}
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
