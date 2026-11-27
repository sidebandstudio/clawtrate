// Save on iPhone (F-115): a file a bot handed over goes to the system's share sheet, from
// which the person saves it to Files or sends it on. Its bytes are written to a folder of
// their own in the app's cache, under the file's name as core cleans it (`cleanFileName`),
// and the folder is deleted once the sheet closes, whatever was chosen there. Nothing waits on
// the sheet for its cleanup alone: everything in the app's share folder is deleted when the
// app starts and before each new file (a force-quit, a delete that failed, a sheet that never
// answered), and a share still waiting when the next one starts is taken as closed, since only
// one sheet is ever on screen. A row that left the screen while its file was written opens no
// sheet: its file is deleted and nothing is presented.

import { cleanFileName } from "@clawtrate/core";

/** What the sheet did: saved to Files, done with by another activity, or closed. */
export type ShareOutcome = "saved" | "shared" | "dismissed";

/**
 * Offer `bytes` as a file named `name`. `wanted` says the one who asked is still on screen: it is
 * asked last, just before the sheet would open.
 */
export type ShareFile = (
  name: string,
  bytes: Uint8Array,
  wanted?: () => boolean,
) => Promise<ShareOutcome>;

/** What sharing needs of the system: a folder in the app's cache, and the share sheet. */
export type ShareSystem = {
  /** Delete the app's share folder, with every file in it. */
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
  /** Run `work` later, once (a delete tried again). */
  later(work: () => void): void;
};

/** Why a file read whole still didn't reach the share sheet. */
export const SHARE_WORDS = {
  notWritten: "This iPhone couldn't keep the file to share it.",
  noSheet: "The share sheet didn't open.",
} as const;

/** The share sheet's activity that saves to Files. */
export const SAVE_TO_FILES = "com.apple.DocumentManagerUICore.SaveToFiles";

/** A delete, tried again once later when it fails; whatever is still left goes with the next sweep. */
function deleteNowOrLater(system: ShareSystem, remove: () => void): void {
  try {
    remove();
  } catch {
    system.later(() => {
      try {
        remove();
      } catch {
        // The next sweep takes it: at the next file, or when the app starts again.
      }
    });
  }
}

export function createSharing(system: ShareSystem): {
  share: ShareFile;
  /** Delete everything in the app's share folder; the app does so when it starts. */
  sweep: () => void;
} {
  const sweep = () => deleteNowOrLater(system, () => system.clear());
  /** Takes the share still waiting on its sheet as closed. */
  let abandon: (() => void) | null = null;

  const share: ShareFile = async (name, bytes, wanted = () => true) => {
    abandon?.();
    sweep();
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
      // Gone while the file was written: nothing is presented over another screen.
      if (!wanted()) return "dismissed";
      let closed: Awaited<ReturnType<ShareSystem["sheet"]>> | "abandoned";
      let mine: (() => void) | null = null;
      try {
        closed = await new Promise((resolve, reject) => {
          mine = () => resolve("abandoned");
          abandon = mine;
          system.sheet(uri).then(resolve, reject);
        });
      } catch {
        throw new Error(SHARE_WORDS.noSheet);
      } finally {
        if (abandon === mine) abandon = null;
      }
      if (closed === "abandoned" || !closed.completed) return "dismissed";
      return closed.activityType === SAVE_TO_FILES ? "saved" : "shared";
    } finally {
      deleteNowOrLater(system, () => folder.remove());
    }
  };

  return { share, sweep };
}
