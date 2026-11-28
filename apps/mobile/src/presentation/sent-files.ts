// The files a person sent, on their own message (F-557), in the desktop's words
// (`packages/ui/src/SentFiles.tsx`; a unit test keeps them the same). A picture
// is read once it is on screen; any other file, and a picture that isn't one of
// the types drawn or is over 5 MB, is its name and size.

import { isShownPictureType, MAX_PICTURE_BYTES, type SentAttachment } from "@clawtrate/core";
import type { RowBox } from "./reading-place.ts";

export type SentPictureShown =
  | { status: "loading" }
  | { status: "shown"; uri: string }
  | { status: "not-a-picture" }
  | { status: "cannot-load" }
  | { status: "gone" }
  /** Not read this time: Try again reads it again. `reason` says why, for the app's log. */
  | { status: "failed"; reason: string };

/** The one line a picture that isn't shown carries, by why. */
export const SENT_PICTURE_LINES = {
  "cannot-load": "This connection can't load the picture back from the gateway.",
  gone: "The gateway no longer keeps this picture.",
  failed: "The picture didn't load.",
} as const;

/** The name a picture you sent is read out by. */
export const sentPictureAlt = (file: SentAttachment) => `Your picture: ${file.fileName}`;

const MIB = 1024 * 1024;

/** A file's size as the desktop writes it: "2 KB", "1.5 MB". */
export function fileSize(bytes: number): string {
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Whether a file is drawn as a picture: one of the types drawn, not over 5 MB as recorded. */
export const drawsAsPicture = (file: SentAttachment) =>
  isShownPictureType(file.mimeType) &&
  (file.sizeBytes === null || file.sizeBytes <= MAX_PICTURE_BYTES);

/** A picture's width over its height, from its own size; a very tall one keeps to 3:4. */
export const pictureRatio = (width: number, height: number) =>
  width > 0 && height > 0 ? Math.max(width / height, 3 / 4) : 4 / 3;

/** The rows any part of which is inside the view, which shows content from `top` for `height`. */
export function rowsOnScreen(boxes: readonly RowBox[], top: number, height: number): string[] {
  return boxes
    .filter((box) => box.y < top + height && box.y + box.height > top)
    .map((box) => box.key);
}
