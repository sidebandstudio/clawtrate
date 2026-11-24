// A picture in the conversation, opened larger (F-117's first slice): a preview
// is a button, and Enter or a click opens the picture over the whole app. Escape,
// the Close button or the backdrop closes it; focus stays inside while it is
// open and goes back to the preview after. The view draws the same bytes the
// preview drew, with the same text alternative, and fetches nothing.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./icons.tsx";

function PictureViewer({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "Tab") {
      // Close is the one control: focus stays on it.
      event.preventDefault();
      close.current?.focus();
    }
  };
  return createPortal(
    <div
      className="picture-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      // A click on the picture keeps focus inside, so Escape still closes it.
      tabIndex={-1}
      data-testid="picture-viewer"
      onKeyDown={onKey}
    >
      {/* The backdrop is for a pointer; Close is the named way out. */}
      <div className="picture-viewer-scrim" aria-hidden="true" onClick={onClose} />
      <img src={url} alt={alt} />
      <button type="button" className="picture-viewer-close" ref={close} onClick={onClose}>
        <CloseIcon />
        <span>Close</span>
      </button>
    </div>,
    document.querySelector(".app") ?? document.body,
  );
}

/** A drawn picture that opens larger: its name is its text alternative. */
export function OpenablePicture({
  url,
  alt,
  onError,
}: {
  url: string;
  alt: string;
  onError?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        type="button"
        className="picture-open"
        ref={button}
        aria-haspopup="dialog"
        title="Open larger"
        onClick={() => setOpen(true)}
      >
        <img src={url} alt={alt} onError={onError} />
      </button>
      {open && (
        <PictureViewer
          url={url}
          alt={alt}
          onClose={() => {
            setOpen(false);
            button.current?.focus();
          }}
        />
      )}
    </>
  );
}
