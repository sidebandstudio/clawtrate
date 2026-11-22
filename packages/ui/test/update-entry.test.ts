// The title bar's update button and brand (docs/design/titlebar.md, sections 2 and 3).
import type { DesktopUpdateSnapshot, DesktopUpdateState } from "@clawtrate/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Brand } from "../src/TitleBar.tsx";
import { updateEntry } from "../src/update-entry.ts";

const base: DesktopUpdateSnapshot = {
  runningVersion: "1.0.0",
  runningTrack: "stable",
  selectedTrack: "stable",
  tracks: [{ track: "stable", source: "stable.example" }],
  revision: 1,
  lastCheck: null,
  pendingTrack: null,
  preferenceIssue: null,
  state: { kind: "not-checked" },
  lastAttempt: null,
  install: { kind: "unavailable-in-this-build", reason: "no-verified-download" },
};
const at = (state: DesktopUpdateState, extra: Partial<DesktopUpdateSnapshot> = {}) =>
  updateEntry({ ...base, ...extra, state });
const offer = { version: "1.1.0", offerId: "A" };

describe("F-520: the update button", () => {
  it("says each state in words, and only Restart to Update acts on its own", () => {
    const rows = [
      at({ kind: "offered", releaseDate: "2026-11-01", ...offer }),
      at({ kind: "downloading", version: "1.1.0", received: 59, expected: 100 }),
      at({ kind: "downloading", version: "1.1.0", received: 100, expected: 100 }),
      at(
        { kind: "verified", size: 100, ...offer },
        { install: { kind: "restart-available", offerId: "A" } },
      ),
      at({ kind: "verified", size: 100, ...offer }),
      at({ kind: "preparing", ...offer }),
      at({ kind: "handing-off", ...offer }),
      at({ kind: "handed-to-system", ...offer }),
      at({ kind: "handoff-unconfirmed", ...offer }),
      at({ kind: "handoff-failed", version: "1.1.0", reason: "installer-failed" }),
      at({ kind: "failed", stage: "check", reason: "unreachable" }),
      at({ kind: "failed", stage: "download", reason: "hash-mismatch" }),
    ].map((entry) => entry && [entry.text, entry.press, entry.tone, entry.name]);
    expect(rows).toEqual([
      ["Update available", "updates", "plain", "Update available: Clawtrate 1.1.0. Open Updates"],
      ["Downloading 50%", "updates", "plain", "Downloading 50%: Clawtrate 1.1.0. Open Updates"],
      [
        "Checking download…",
        "updates",
        "plain",
        "Checking download…: Clawtrate 1.1.0. Open Updates",
      ],
      ["Restart to Update", "confirm", "ready", "Restart to Update: Clawtrate 1.1.0"],
      ["Update downloaded", "updates", "plain", "Update downloaded: Clawtrate 1.1.0. Open Updates"],
      ["Restarting…", "none", "plain", "Restarting…: Clawtrate 1.1.0"],
      ["Restarting…", "none", "plain", "Restarting…: Clawtrate 1.1.0"],
      ["Installs on quit", "updates", "plain", "Installs on quit: Clawtrate 1.1.0. Open Updates"],
      ["Update unconfirmed", "updates", "warn", "Update unconfirmed. Open Updates"],
      ["Couldn't install", "updates", "warn", "Couldn't install. Open Updates"],
      ["Couldn't check", "updates", "warn", "Couldn't check. Open Updates"],
      ["Download failed", "updates", "warn", "Download failed. Open Updates"],
    ]);
  });

  it("shows nothing while the update has nothing to say", () => {
    expect(updateEntry(null)).toBeNull();
    for (const state of [
      { kind: "not-checked" },
      { kind: "checking" },
      { kind: "nothing-newer" },
      { kind: "failed", stage: "preferences", reason: "write-failed" },
      { kind: "failed", stage: "check", reason: "development-build" },
    ] as DesktopUpdateState[])
      expect(at(state), state.kind).toBeNull();
    // A track change in progress, and a build with no update source.
    expect(
      at({ kind: "offered", releaseDate: "x", ...offer }, { pendingTrack: "nightly" }),
    ).toBeNull();
    expect(at({ kind: "offered", releaseDate: "x", ...offer }, { tracks: [] })).toBeNull();
  });
});

describe("F-519: the brand", () => {
  const brand = (snapshot: DesktopUpdateSnapshot | null) =>
    renderToStaticMarkup(
      createElement(Brand, {
        reading: { snapshot } as Parameters<typeof Brand>[0]["reading"],
      }),
    );

  it("shows the Beta pill on a Beta build only, never guessing a channel", () => {
    expect(brand({ ...base, runningTrack: "nightly" })).toContain(">Beta</span>");
    expect(brand({ ...base, runningTrack: "stable" })).not.toContain("Beta");
    // A development build, a version that can't be read, or no reading yet.
    expect(brand({ ...base, runningTrack: null, runningVersion: null })).not.toContain("Beta");
    expect(brand(null)).not.toContain("Beta");
  });

  it("names Clawtrate in words beside a decorative mark", () => {
    const html = brand(null);
    expect(html).toMatch(/<img[^>]*alt=""/);
    expect(html).toContain(">Clawtrate</span>");
  });
});
