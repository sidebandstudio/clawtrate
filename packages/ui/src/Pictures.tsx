// The pictures a bot handed over, under its turn (F-535). Each is read through
// the host when it is drawn (`readChatPicture`): the gateway issues a download for
// it, and only the bytes that come back are shown, as a data: address. Nothing
// else in the message, such as the address it names, is ever loaded.

import { toBase64, type ChatPicture } from "@clawtrate/core";
import { useEffect, useState } from "react";
import { useBridge } from "./bridge.tsx";
import { collectBytes } from "./work/content.ts";

type Shown =
  { status: "loading" } | { status: "shown"; url: string } | { status: "failed"; message: string };

/** The text a picture is read out as: what it was asked to show, when the gateway says. */
export function pictureAlt(picture: ChatPicture): string {
  return picture.prompt
    ? `Picture made from the description: ${picture.prompt}`
    : "A picture the bot handed over";
}

function Picture({ taskKey, picture }: { taskKey: string; picture: ChatPicture }) {
  const bridge = useBridge();
  const [shown, setShown] = useState<Shown>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    const fail = (message: string) => current && setShown({ status: "failed", message });
    bridge.invoke({ type: "readChatPicture", key: taskKey, artifactId: picture.artifactId }).then(
      async (read) => {
        if (read.status !== "content") return fail(read.message);
        const data = await collectBytes(bridge, read.transfer, read.bytes);
        if (!(data instanceof Uint8Array)) return fail(data.message);
        if (current)
          setShown({ status: "shown", url: `data:${read.mimeType};base64,${toBase64(data)}` });
      },
      (error: unknown) => fail(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      current = false;
    };
  }, [bridge, taskKey, picture.artifactId, attempt]);

  // The gateway's own size keeps the place while the picture loads, so the transcript doesn't jump.
  const ratio =
    picture.width && picture.height ? `${picture.width} / ${picture.height}` : undefined;
  return (
    <figure
      className="picture"
      data-testid="picture"
      data-state={shown.status}
      style={{ aspectRatio: ratio, maxWidth: picture.width ? `${picture.width}px` : undefined }}
    >
      {shown.status === "shown" ? (
        <img
          src={shown.url}
          alt={pictureAlt(picture)}
          onError={() =>
            setShown({ status: "failed", message: "This device couldn't draw the picture." })
          }
        />
      ) : shown.status === "loading" ? (
        <figcaption className="picture-note" role="status">
          Loading the picture…
        </figcaption>
      ) : (
        <figcaption className="picture-note" role="alert">
          <span>Couldn't show the picture. {shown.message}</span>
          <button
            type="button"
            className="button"
            onClick={() => {
              setShown({ status: "loading" });
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </figcaption>
      )}
    </figure>
  );
}

/** Pictures of a bot's turn, in the order its messages gave them. */
export function Pictures({ taskKey, pictures }: { taskKey: string; pictures: ChatPicture[] }) {
  if (pictures.length === 0) return null;
  return (
    <div className="pictures">
      {pictures.map((picture, index) => (
        <Picture key={`${picture.artifactId}:${index}`} taskKey={taskKey} picture={picture} />
      ))}
    </div>
  );
}
