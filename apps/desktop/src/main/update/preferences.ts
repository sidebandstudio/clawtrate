import type { DesktopUpdateSnapshot, UpdateTrack } from "@clawtrate/core";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { parseReleaseDate } from "./feed.ts";

import { readAttempt } from "./attempt.ts";

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

function project(value: unknown): Preferences {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid update preferences");
  const prefs: Preferences = {};
  if ("selectedTrack" in value) {
    const track = value.selectedTrack;
    if (track !== "stable" && track !== "nightly") throw Error("Invalid update track");
    prefs.selectedTrack = track;
  }
  if ("lastCheck" in value) {
    // Previous builds stored JSON values as strings in their shared file-store format.
    const record = readCheck(
      typeof value.lastCheck === "string" ? JSON.parse(value.lastCheck) : value.lastCheck,
    );
    if (!record) throw Error("Invalid last check");
    prefs.lastCheck = record;
  }
  if ("attempt" in value)
    prefs.attempt = readAttempt(
      typeof value.attempt === "string" ? JSON.parse(value.attempt) : value.attempt,
    );
  return prefs;
}

async function load(path: string): Promise<Preferences> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!file) return {};
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
    async get(key: string): Promise<string | null> {
      const prefs = await load(path);
      if (key === "selectedTrack") return prefs.selectedTrack ?? null;
      if (key === "attempt") return prefs.attempt ? JSON.stringify(prefs.attempt) : null;
      if (key === "lastCheck") return prefs.lastCheck ? JSON.stringify(prefs.lastCheck) : null;
      throw Error("Unknown update preference");
    },
    async set(key: string, value: string): Promise<void> {
      if (key !== "selectedTrack" && key !== "lastCheck" && key !== "attempt")
        throw Error("Unknown update preference");
      const prefs = project({ ...(await load(path)), [key]: value });
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
    },
  };
}
