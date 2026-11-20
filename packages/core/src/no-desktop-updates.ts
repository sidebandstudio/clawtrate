import type { DesktopUpdates, DesktopUpdateSnapshot } from "./desktop-updates.ts";

async function unavailable(): Promise<DesktopUpdateSnapshot> {
  return {
    runningVersion: null,
    runningTrack: null,
    tracks: [],
    selectedTrack: null,
    lastCheckedAt: null,
    state: { kind: "failed", stage: "check", reason: "no-updater" },
    install: { kind: "unavailable-in-this-build" },
  };
}

export const noDesktopUpdates: DesktopUpdates = {
  get: unavailable,
  check: unavailable,
  chooseTrack: unavailable,
  download: unavailable,
  subscribe: () => () => {},
};
