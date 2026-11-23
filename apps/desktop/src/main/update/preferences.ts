import type { DesktopUpdateSnapshot, UpdateTrack } from "@clawtrate/core";
import { constants, writeFileSync } from "node:fs";
import { open, rename } from "node:fs/promises";
import { rm } from "../update-tree-fs.ts";
import { parseReleaseDate } from "./feed.ts";

import { readAttempt, readQuit, type UpdateQuit } from "./attempt.ts";

export const MAX_PREFERENCE_BYTES = 1024;

interface Preferences {
  attempt?: ReturnType<typeof readAttempt>;
  selectedTrack?: UpdateTrack;
  lastCheck?: NonNullable<DesktopUpdateSnapshot["lastCheck"]>;
}

export function readCheck(value: unknown): DesktopUpdateSnapshot["lastCheck"] {
  if (!value || typeof value !== "object" || !("track" in value) || !("readAt" in value))
    return null;
  const { track, readAt } = value;
  const date = parseReleaseDate(readAt);
  return (track === "stable" || track === "nightly") && date ? { track, readAt: date } : null;
}

type Key = keyof Preferences;
export interface StoredUpdatePreferences {
  prefs: Preferences;
  invalid: Set<Key>;
}

function project(value: unknown): StoredUpdatePreferences {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid update preferences");
  const prefs: Preferences = {},
    invalid = new Set<Key>();
  for (const key of ["selectedTrack", "lastCheck", "attempt"] as const) {
    if (!Object.hasOwn(value, key)) continue;
    const field: unknown = (value as Record<string, unknown>)[key];
    try {
      if (key === "selectedTrack") {
        if (field !== "stable" && field !== "nightly") throw Error("Invalid track");
        prefs.selectedTrack = field;
      } else {
        const record: unknown = typeof field === "string" ? JSON.parse(field) : field;
        if (key === "attempt") prefs.attempt = readAttempt(record);
        else {
          const check = readCheck(record);
          if (!check) throw Error("Invalid last check");
          prefs.lastCheck = check;
        }
      }
    } catch {
      invalid.add(key);
    }
  }
  return { prefs, invalid };
}

async function load(path: string): Promise<StoredUpdatePreferences> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!file) return project({});
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_PREFERENCE_BYTES)
      throw Error("Invalid update preferences file");
    const bytes = Buffer.alloc(MAX_PREFERENCE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_PREFERENCE_BYTES) throw Error("Update preferences are too large");
    return project(JSON.parse(bytes.toString("utf8", 0, offset)));
  } finally {
    await file.close();
  }
}

/** Only the main-process update service owns this file and serializes its writes. */
export function createUpdatePreferenceStore(path: string) {
  return {
    readPreferences: () => load(path),
    async get(key: string): Promise<string | null> {
      const { prefs, invalid } = await load(path);
      if (invalid.has(key as Key)) throw Error("Invalid update preference");
      if (key === "selectedTrack") return prefs.selectedTrack ?? null;
      if (key === "attempt") return prefs.attempt ? JSON.stringify(prefs.attempt) : null;
      if (key === "lastCheck") return prefs.lastCheck ? JSON.stringify(prefs.lastCheck) : null;
      throw Error("Unknown update preference");
    },
    /**
     * Synchronous, for the moment the app quits after a handoff, when nothing asynchronous
     * finishes. A failure is ignored: the next start then reports the quit as not finished.
     */
    markQuit(quit: UpdateQuit): void {
      try {
        writeFileSync(path + ".quit", JSON.stringify(quit), { mode: 0o600 });
      } catch {
        // Reported as a quit that didn't finish.
      }
    },
    async readQuit(): Promise<UpdateQuit | null> {
      try {
        const file = await open(path + ".quit", constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          const bytes = Buffer.alloc(MAX_PREFERENCE_BYTES + 1);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          const stat = await file.stat();
          if (!stat.isFile() || bytesRead > MAX_PREFERENCE_BYTES) return null;
          return readQuit(JSON.parse(bytes.toString("utf8", 0, bytesRead)));
        } finally {
          await file.close();
        }
      } catch {
        return null;
      }
    },
    async set(key: string, value: string): Promise<void> {
      if (key !== "selectedTrack" && key !== "lastCheck" && key !== "attempt")
        throw Error("Unknown update preference");
      const { prefs, invalid } = project({ ...(await load(path)).prefs, [key]: value });
      if (invalid.has(key)) throw Error("Invalid update preference");
      await save(prefs);
    },
    /** Once the attempted version runs, the attempt and its quit record are done with. */
    async forgetAttempt(): Promise<void> {
      const { prefs } = await load(path);
      if (prefs.attempt) {
        delete prefs.attempt;
        await save(prefs);
      }
      await rm(path + ".quit", { force: true });
    },
  };

  async function save(prefs: Preferences): Promise<void> {
    const temp = path + ".next";
    await rm(temp, { force: true });
    const file = await open(temp, "wx", 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(prefs));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  }
}
