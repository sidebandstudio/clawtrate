// The title bar's update button (docs/design/titlebar.md, section 3): what the
// host's update snapshot says, in one button's words. Only "Restart to Update"
// acts, through the same confirmation as Settings; every other state opens
// Settings → Updates, which explains it, and Restarting does nothing.

import type { DesktopUpdateSnapshot, UpdateTrack } from "@clawtrate/core";
import { restartCapability } from "./update-restart.ts";
import { showUpdateFooter } from "./Updates.tsx";

export type UpdateEntry = {
  /** One word per state, for tests and styles. */
  state:
    | "offered"
    | "downloading"
    | "verifying"
    | "ready"
    | "downloaded"
    | "restarting"
    | "on-quit"
    | "unconfirmed"
    | "check-failed"
    | "download-failed"
    | "install-failed";
  /** The visible words. */
  text: string;
  /** The accessible name: the visible words first. */
  name: string;
  tone: "plain" | "ready" | "warn";
  icon: "download" | "restart" | "clock" | "warn" | "busy";
  press: "updates" | "confirm" | "none";
  /** Downloading: the share received, 0 to 100, rounded down to tens. */
  received?: number;
};

const OPEN = ". Open Updates";

/** Null while the update has nothing to say: the button is not shown. */
export function updateEntry(
  s: DesktopUpdateSnapshot | null,
  pending: UpdateTrack | null = s?.pendingTrack ?? null,
): UpdateEntry | null {
  if (!s || !showUpdateFooter(s, pending)) return null;
  const state = s.state;
  const named = (text: string, version?: string, press: UpdateEntry["press"] = "updates") =>
    `${text}${version ? `: Clawtrate ${version}` : ""}${press === "updates" ? OPEN : ""}`;
  const entry = (
    kind: UpdateEntry["state"],
    text: string,
    icon: UpdateEntry["icon"],
    tone: UpdateEntry["tone"] = "plain",
    version?: string,
    press: UpdateEntry["press"] = "updates",
  ): UpdateEntry => ({ state: kind, text, name: named(text, version, press), tone, icon, press });
  switch (state.kind) {
    case "offered":
      return entry("offered", "Update available", "download", "plain", state.version);
    case "downloading": {
      if (state.received >= state.expected)
        return {
          ...entry("verifying", "Checking download…", "download", "plain", state.version),
          received: 100,
        };
      const received = Math.floor((10 * state.received) / state.expected) * 10;
      return {
        ...entry("downloading", `Downloading ${received}%`, "download", "plain", state.version),
        received,
      };
    }
    case "verified":
      return restartCapability(s)
        ? entry("ready", "Restart to Update", "restart", "ready", state.version, "confirm")
        : entry("downloaded", "Update downloaded", "download", "plain", state.version);
    case "preparing":
    case "handing-off":
      return entry("restarting", "Restarting…", "busy", "plain", state.version, "none");
    case "handed-to-system":
      return entry("on-quit", "Installs on quit", "clock", "plain", state.version);
    case "handoff-unconfirmed":
      return entry("unconfirmed", "Update unconfirmed", "warn", "warn");
    case "handoff-failed":
      return entry("install-failed", "Couldn't install", "warn", "warn");
    case "failed":
      return state.stage === "download"
        ? entry("download-failed", "Download failed", "warn", "warn")
        : entry("check-failed", "Couldn't check", "warn", "warn");
    default:
      return null;
  }
}
