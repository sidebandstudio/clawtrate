// Save on iPhone (F-115): a file a bot handed over goes to the system's share sheet, from
// which the person saves it to Files or sends it on. Its bytes are written to a folder of
// their own in the app's cache, under the file's name as core cleans it (`cleanFileName`),
// and the folder is deleted once the sheet closes, whatever was chosen there. What an earlier
// run left (the app was closed with the sheet open) is deleted before this run's first file.

import { cleanFileName } from "@clawtrate/core";

/** What the sheet did: saved to Files, done with by another activity, or closed. */
export type ShareOutcome = "saved" | "shared" | "dismissed";

export type ShareFile = (name: string, bytes: Uint8Array) => Promise<ShareOutcome>;

/** What sharing needs of the system: a folder in the app's cache, and the share sheet. */
export type ShareSystem = {
  /** Delete every folder earlier runs left. */
  clear(): void;
  /** A new, empty folder of its own. */
  folder(): {
    /** Write a file into it; its address. */
    write(name: string, bytes: Uint8Array): Promise<string>;
    /** Delete it, with what it holds. */
    remove(): void;
  };
  /** The share sheet for the file at `uri`; settles once it closes. */
  sheet(uri: string): Promise<{ completed: boolean; activityType: string | null }>;
};

/** Why a file read whole still didn't reach the share sheet. */
export const SHARE_WORDS = {
  notWritten: "This iPhone couldn't keep the file to share it.",
  noSheet: "The share sheet didn't open.",
} as const;

/** The share sheet's activity that saves to Files. */
export const SAVE_TO_FILES = "com.apple.DocumentManagerUICore.SaveToFiles";

export function createShareFile(system: ShareSystem): ShareFile {
  let cleared = false;
  return async (name, bytes) => {
    if (!cleared) {
      cleared = true;
      try {
        system.clear();
      } catch {
        // Left for the system, which clears the cache when it needs room.
      }
    }
    let folder: ReturnType<ShareSystem["folder"]>;
    try {
      folder = system.folder();
    } catch {
      throw new Error(SHARE_WORDS.notWritten);
    }
    try {
      let uri: string;
      try {
        uri = await folder.write(cleanFileName(name), bytes);
      } catch {
        throw new Error(SHARE_WORDS.notWritten);
      }
      let closed: Awaited<ReturnType<ShareSystem["sheet"]>>;
      try {
        closed = await system.sheet(uri);
      } catch {
        throw new Error(SHARE_WORDS.noSheet);
      }
      if (!closed.completed) return "dismissed";
      return closed.activityType === SAVE_TO_FILES ? "saved" : "shared";
    } finally {
      try {
        folder.remove();
      } catch {
        // As above: the next run's first file clears it.
      }
    }
  };
}
