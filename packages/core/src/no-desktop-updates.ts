import type { DesktopUpdates, DesktopUpdateSnapshot } from "./desktop-updates.ts";

async function unavailable(): Promise<DesktopUpdateSnapshot> {
  return {
    runningVersion: null,
    runningTrack: null,
    tracks: [],
    revision: 0,
    selectedTrack: null,
    pendingTrack: null,
    lastCheck: null,
    preferenceIssue: null,
    state: { kind: "failed", stage: "check", reason: "no-updater" },
    install: { kind: "unavailable-in-this-build" },
  };
}

const refuse = async () => ({ outcome: "invalid" as const, snapshot: await unavailable() });
export const noDesktopUpdates: DesktopUpdates = {
  get: unavailable,
  check: refuse,
  chooseTrack: refuse,
  download: refuse,
  subscribe: () => () => {},
};
