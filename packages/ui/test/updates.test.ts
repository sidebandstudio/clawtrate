import {
  type DesktopUpdateFailure,
  type DesktopUpdateSnapshot,
  type DesktopUpdateState,
  type UpdateTrack,
} from "@clawtrate/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Updates, showUpdateFooter } from "../src/Updates.tsx";

const snapshot: DesktopUpdateSnapshot = {
  runningVersion: "1.0.0",
  runningTrack: "stable",
  selectedTrack: "stable",
  tracks: [
    { track: "stable", source: "stable.example" },
    { track: "nightly", source: "nightly.example" },
  ],
  revision: 1,
  lastCheck: null,
  pendingTrack: null,
  preferenceIssue: null,
  state: { kind: "not-checked" },
  install: { kind: "unavailable-in-this-build" },
};
function render(
  state: DesktopUpdateState,
  extra: Partial<DesktopUpdateSnapshot> = {},
  pending: UpdateTrack | null = null,
) {
  const s = { ...snapshot, ...extra, state };
  const html = renderToStaticMarkup(
    createElement(Updates, {
      pending: pending ?? s.pendingTrack,
      snapshot: s,
      localChoice: null,
      working: false,
      message: null,
      retryRead: async () => {},
      chooseTrack: async () => {},
      check: async () => {},
      download: async () => {},
    }),
  ).replaceAll("&#x27;", "'");
  return {
    html,
    actions: [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]),
    footer: showUpdateFooter(s, pending ?? s.pendingTrack),
  };
}
const cases: Array<[DesktopUpdateState, string, string[], boolean]> = [
  [{ kind: "not-checked" }, "Not checked yet.", ["Check for Updates"], false],
  [{ kind: "checking" }, "Checking stable.example…", [], false],
  [
    { kind: "nothing-newer" },
    "No newer version was offered for this build by its update source.",
    ["Check for Updates"],
    false,
  ],
  [
    { kind: "offered", version: "1.1.0", releaseDate: "2026-10-01", offerId: "opaque" },
    "Clawtrate 1.1.0 is offered by the update source.",
    ["Download"],
    true,
  ],
  [
    { kind: "downloading", version: "1.1.0", received: 40, expected: 100 },
    "Downloading Clawtrate 1.1.0… 40 of 100 bytes",
    [],
    true,
  ],
  [
    { kind: "verified", offerId: "opaque", version: "1.1.0", size: 100 },
    "Clawtrate 1.1.0 is downloaded, and its size and checksum match the update source. Installation isn't available from this screen.",
    [],
    true,
  ],
];
it.each(cases)(
  "F-231 F-030: shows the host reading %j and its actions",
  (state, line, actions, footer) => {
    const result = render(state);
    expect(result.html).toContain(line);
    expect(result.actions).toEqual(actions);
    expect(result.footer).toBe(footer);
  },
);
const failures = {
  "development-build": "A development build. It doesn't update itself.",
  "not-configured": "This copy can't check for updates: no update source is set up for it.",
  "no-updater": "This copy can't check for updates: no update source is set up for it.",
  "no-file-for-this-system": "The update source has no file for this system.",
  "invalid-version": "This build's version couldn't be read. It can't check for updates.",
  "unsupported-system": "This build can't check for updates on this system.",
  "artifact-changed": null,
  unreachable: null,
  "timed-out": null,
  "http-status": null,
  "address-refused": null,
  "redirect-refused": null,
  "too-large": null,
  "malformed-feed": null,
  "wrong-track": null,
  "size-mismatch": null,
  "hash-mismatch": null,
  "write-failed": null,
} satisfies Record<DesktopUpdateFailure, string | null>;
it.each(Object.keys(failures) as DesktopUpdateFailure[])(
  "F-231 F-030: explains %s and offers only the matching action",
  (reason) => {
    const result = render({ kind: "failed", stage: "check", reason });
    const unsupported = [
      "development-build",
      "not-configured",
      "no-updater",
      "invalid-version",
      "unsupported-system",
    ].includes(reason);
    expect(result.html).toContain(failures[reason] ?? "Couldn't check for updates.");
    expect(result.actions).toEqual(
      unsupported ? [] : [reason === "no-file-for-this-system" ? "Check for Updates" : "Try again"],
    );
    expect(result.footer).toBe(!unsupported);
    if (unsupported) expect(result.html).not.toContain("radio");
    else {
      const dl = render({ kind: "failed", stage: "download", reason });
      const downloadErrors: Partial<Record<DesktopUpdateFailure, string>> = {
        "hash-mismatch": "The downloaded file doesn't match the update source.",
        "size-mismatch": "The downloaded file doesn't match the update source.",
        "artifact-changed": "Couldn't verify the saved update again.",
        "write-failed": "Couldn't save the update on this device.",
      };
      expect(dl.html).toContain(downloadErrors[reason] ?? "Couldn't download the update.");
      expect(dl.actions).toEqual(["Check for Updates"]);
      expect(dl.footer).toBe(true);
    }
  },
);
it("F-231: names the running and selected tracks and shows choices only with two sources", () => {
  const one = render({ kind: "not-checked" }, { tracks: snapshot.tracks.slice(0, 1) });
  expect(one.html).not.toContain("radio");
  expect(one.html).toContain("This copy is a Stable build.");
  const two = render({ kind: "nothing-newer" }, { selectedTrack: "nightly" });
  expect(two.html).toContain("Update track");
  expect(two.html).toContain(
    "No newer Nightly build was offered. Clawtrate 1.0.0 is still running.",
  );
  expect(two.html).toContain("Checks nightly.example for a newer build, only when you choose to.");
  expect(
    render({ kind: "not-checked" }, { tracks: snapshot.tracks.slice(1), selectedTrack: "nightly" })
      .html,
  ).toContain("The next check asks the Nightly source.");
});

it.each([
  ["preferences-not-read", "Couldn't read the saved update settings."],
  ["last-check-not-saved", "Couldn't save the time of the last check."],
  ["update-folder-unavailable", "Couldn't prepare update storage on this device."],
  ["track-not-saved", "Couldn't save the track. Stable is still selected."],
] as const)(
  "F-231 F-030: shows %s independently of the release result",
  (preferenceIssue, line) => {
    const r = render(
      { kind: "nothing-newer" },
      { preferenceIssue, lastCheck: { track: "stable", readAt: "2026-11-16T22:41:00Z" } },
    );
    expect(r.html).toContain(line);
    expect(r.html).toContain("Checked at ");
    expect(r.footer).toBe(false);
  },
);
it.each([
  ["nightly", "2026-11-16T22:41:00Z"],
  ["stable", "invalid"],
] as const)("F-231: ignores an inapplicable last check %s %s", (track, readAt) => {
  expect(render({ kind: "nothing-newer" }, { lastCheck: { track, readAt } }).html).not.toContain(
    "Checked at",
  );
});
it("F-231: announces download milestones while showing every reported byte count", () => {
  const download = (received: number) =>
    render({ kind: "downloading", version: "2.0.0", received, expected: 1000 }).html;
  expect(download(110)).toContain('role="status">Downloading Clawtrate 2.0.0… 10%');
  expect(download(119)).toContain('role="status">Downloading Clawtrate 2.0.0… 10%');
  expect(download(119)).toContain("119 of 1,000 bytes");
  expect(download(200)).toContain('role="status">Downloading Clawtrate 2.0.0… 20%');
});

it("F-231 F-030: a pending choice hides the retired offer, action and source", () => {
  const result = render(
    { kind: "offered", offerId: "retired", version: "2.0.0", releaseDate: "2026-11-01" },
    { pendingTrack: "nightly" },
  );
  expect(result.html).toContain("Saving Nightly as the update track…");
  expect(result.html).toContain("Not checked yet.");
  expect(result.html).not.toMatch(/stable.example|2.0.0/);
  expect(result.actions).toEqual([]);
  expect(result.footer).toBe(false);
});
