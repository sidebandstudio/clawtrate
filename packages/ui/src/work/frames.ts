// The live picture of a view (work-pane.md, section 17). Frames are asked of
// the host one at a time (`computerFrame`), decoded, drawn on every canvas the
// view is shown on, and dropped: none is written to a cache, a log or storage,
// and when the view ends the canvases are cleared and the decoded picture is
// closed. A frame for a view that has ended is dropped before it is decoded.

import type { ClawtrateBridge, ComputerView } from "@clawtrate/core";
import { useEffect, useMemo, useRef } from "react";

export type FrameCanvases = {
  /** Show the view on this canvas; the returned function stops it. */
  attach(canvas: HTMLCanvasElement): () => void;
};

function decode(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function draw(canvas: HTMLCanvasElement, picture: ImageBitmap | null): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  if (!picture) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  if (canvas.width !== picture.width || canvas.height !== picture.height) {
    canvas.width = picture.width;
    canvas.height = picture.height;
  }
  context.drawImage(picture, 0, 0);
}

/** Pull and draw one view's frames while it is connecting or live. */
export function useFrames(bridge: ClawtrateBridge, view: ComputerView | null): FrameCanvases {
  const canvases = useRef(new Set<HTMLCanvasElement>());
  const picture = useRef<ImageBitmap | null>(null);
  const n = view && view.status !== "ended" ? view.n : null;

  useEffect(() => {
    if (n === null) return;
    const shown = canvases.current;
    let stopped = false;
    let after = 0;
    void (async () => {
      while (!stopped) {
        let frame;
        try {
          frame = await bridge.invoke({ type: "computerFrame", n, after });
        } catch {
          // The host is busy or the view went: look again shortly while it lasts.
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        if (stopped) return;
        if (!frame || frame.n !== n) continue;
        after = frame.seq;
        let decoded: ImageBitmap;
        try {
          decoded = await createImageBitmap(new Blob([decode(frame.jpeg)], { type: "image/jpeg" }));
        } catch {
          continue;
        }
        if (stopped) {
          decoded.close();
          return;
        }
        picture.current?.close();
        picture.current = decoded;
        for (const canvas of shown) draw(canvas, decoded);
      }
    })();
    return () => {
      stopped = true;
      // Nothing of the picture remains.
      picture.current?.close();
      picture.current = null;
      for (const canvas of shown) draw(canvas, null);
    };
  }, [bridge, n]);

  return useMemo<FrameCanvases>(
    () => ({
      attach(canvas) {
        canvases.current.add(canvas);
        draw(canvas, picture.current);
        return () => {
          canvases.current.delete(canvas);
        };
      },
    }),
    [],
  );
}
