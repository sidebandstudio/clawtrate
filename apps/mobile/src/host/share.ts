// Save on iPhone (F-115): a file a bot handed over goes to the system's share sheet, from
// which the person saves it to Files or sends it on. Its bytes are written to a folder of
// their own in the app's cache, under the file's name as core cleans it (`cleanFileName`),
// and that folder is deleted once the sheet is done with, whatever was chosen there.
//
// Only one sheet is up at a time: a Save while another file's sheet is open is refused with
// words that say so, and never takes the first as closed, since iOS can still be reading its
// file. The folders of shares under way are kept; a sweep deletes every other folder in the
// app's share folder, when the app starts (a force-quit with the sheet open) and before each
// new file, and a delete or sweep that fails is tried again later, still sparing the folders in
// use then. A row that left the screen opens no sheet: the native side checks its token just
// before presenting (`ShareSystem.sheet`), its file is deleted and nothing is presented.

import { cleanFileName } from "@clawtrate/core";

/** What the sheet did: saved to Files, done with by another activity, or closed. */
export type ShareOutcome = "saved" | "shared" | "dismissed";

/**
 * The row a share is for: gone once it has left the screen, set at once when it does, and
 * told to whoever waits on it.
 */
export type Viewer = {
  gone(): boolean;
  /** Call `listener` once the viewer is gone; returns a call that stops listening. */
  whenGone(listener: () => void): () => void;
};

/** A viewer that `leave` marks gone, at once and for good. */
export function createViewer(): Viewer & { leave(): void } {
  let gone = false;
  const listeners = new Set<() => void>();
  return {
    gone: () => gone,
    whenGone: (listener) => {
      if (gone) {
        listener();
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    leave: () => {
      if (gone) return;
      gone = true;
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
  };
}

/** Offer `bytes` as a file named `name`, for the row `viewer` while it is still on screen. */
export type ShareFile = (name: string, bytes: Uint8Array, viewer: Viewer) => Promise<ShareOutcome>;

/** How the sheet ended, as the native side reports it, exactly once. */
export type SheetEnd =
  | { end: "completed"; activityType: string | null }
  | { end: "dismissed"; activityType: string | null }
  /** The chosen activity failed. */
  | { end: "failed" }
  /** Cancelled before it was presented: nothing was shown. */
  | { end: "not-presented" }
  /** There was no screen to present it on, or iOS refused to present it. */
  | { end: "no-screen" };

/** What sharing needs of the system: folders in the app's cache, and the share sheet. */
export type ShareSystem = {
  /** A new name for a folder. */
  newName(): string;
  /** The names of the folders now in the app's share folder. */
  list(): string[];
  /** Make an empty folder named `name`, and write a file into it; the file's address. */
  write(folder: string, name: string, bytes: Uint8Array): Promise<string>;
  /** Delete the folder `name`, with what it holds. */
  remove(folder: string): void;
  /** The share sheet for the file at `uri`, named `id`, settling once it ends. */
  sheet(id: string, uri: string): Promise<SheetEnd>;
  /** Present nothing for the sheet `id` if it hasn't been presented yet. */
  cancel(id: string): void;
  /** Run `work` later, once (a delete tried again). */
  later(work: () => void): void;
};

/** Why a file read whole still didn't reach the share sheet, or what the sheet did. */
export const SHARE_WORDS = {
  notWritten: "This iPhone couldn't keep the file to share it.",
  noSheet: "The share sheet didn't open.",
  busy: "Another file's share sheet is open. Try again once it has closed.",
  activityFailed: "The app you chose couldn't take the file.",
} as const;

/** The share sheet's activity that saves to Files. */
export const SAVE_TO_FILES = "com.apple.DocumentManagerUICore.SaveToFiles";

export function createSharing(system: ShareSystem): {
  share: ShareFile;
  /** Delete every folder in the app's share folder that no share is using. */
  sweep: () => void;
} {
  /** The folders of shares under way: never swept. */
  const active = new Set<string>();

  /** `work`, or once more later if it throws; still failing, the next sweep takes what is left. */
  const tryTwice = (work: () => void) => {
    try {
      work();
    } catch {
      system.later(() => {
        try {
          work();
        } catch {
          // Left for the next sweep: before the next file, or when the app starts again.
        }
      });
    }
  };
  const removeIdle = (folder: string) => {
    if (!active.has(folder)) system.remove(folder);
  };
  const sweep = () =>
    tryTwice(() => {
      // Each folder is spared if it is in use when the sweep reaches it, a retry's too.
      let failed = false;
      for (const folder of system.list()) {
        try {
          removeIdle(folder);
        } catch {
          failed = true;
        }
      }
      if (failed) throw new Error("Not every folder was deleted.");
    });

  const share: ShareFile = async (name, bytes, viewer) => {
    // One sheet at a time: the first may still be in use, so it is never taken as closed.
    if (active.size > 0) throw new Error(SHARE_WORDS.busy);
    const folder = system.newName();
    active.add(folder);
    try {
      sweep();
      let uri: string;
      try {
        uri = await system.write(folder, cleanFileName(name), bytes);
      } catch {
        throw new Error(SHARE_WORDS.notWritten);
      }
      // Gone while the file was written: nothing is presented over another screen.
      if (viewer.gone()) return "dismissed";
      // Gone between here and the native present: the native side presents nothing.
      const stop = viewer.whenGone(() => system.cancel(folder));
      let ended: SheetEnd;
      try {
        ended = await system.sheet(folder, uri);
      } catch {
        throw new Error(SHARE_WORDS.noSheet);
      } finally {
        stop();
      }
      switch (ended.end) {
        case "completed":
          return ended.activityType === SAVE_TO_FILES ? "saved" : "shared";
        case "dismissed":
        case "not-presented":
          return "dismissed";
        case "failed":
          throw new Error(SHARE_WORDS.activityFailed);
        case "no-screen":
          throw new Error(SHARE_WORDS.noSheet);
      }
    } finally {
      active.delete(folder);
      tryTwice(() => removeIdle(folder));
    }
  };

  return { share, sweep };
}
