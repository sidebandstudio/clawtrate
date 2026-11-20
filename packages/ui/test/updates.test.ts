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
  lastAttempt: null,
  install: { kind: "unavailable-in-this-build", reason: "build-not-signed" },
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
      restart: async () => {},
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
  ["attempt-not-read", "Couldn't read the last update attempt."],
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

const restartFailures = [
  ["no-verified-download", "There is no verified update ready to install."],
  ["build-not-signed", "This build can't install updates itself."],
  ["no-installer-path", "This build has no installer for this system."],
  ["artifact-changed", "Couldn't verify the saved update again."],
  ["mac-designated-requirement", "The update doesn't meet this app's macOS signing requirement."],
  ["authenticode-trust", "Windows couldn't verify the update's signature."],
  ["publisher-mismatch", "The update was signed by a different publisher."],
  ["installation-context", "Couldn't confirm where this copy of Clawtrate is installed."],
  ["inspection-failed", "Couldn't finish checking the downloaded update."],
  ["running-signature-untrusted", "Couldn't verify the signature of the running app."],
  ["running-publisher-mismatch", "The running app was signed by a different publisher."],
  ["installer-product", "The installer is for a different app."],
  ["installer-version", "The installer's version doesn't match the offered version."],
  ["mac-archive", "The downloaded archive can't be used for this update."],
  ["mac-bundle-identifier", "The downloaded Mac app has a different app identifier."],
  ["mac-architecture", "The downloaded Mac app is for a different processor."],
  [
    "quit-blocked",
    "Clawtrate stayed open. Close whatever is blocking quit, then check and download the update again before choosing Restart to Update.",
  ],
  ["handoff-unconfirmed", "Couldn't confirm the handoff to the system updater."],
  ["attempt-not-saved", "Couldn't save the restart attempt on this device."],
  ["installer-failed", "Couldn't hand the update to the installer."],
] as const;
const verified = { kind: "verified", offerId: "shown", version: "1.1.0", size: 100 } as const;
it.each(restartFailures)("F-231: explains the installer refusal %s", (reason, line) => {
  const failed = render({ kind: "handoff-failed", version: "1.1.0", reason });
  expect(failed.html).toContain(line);
  expect(failed.actions).toEqual(reason === "handoff-unconfirmed" ? [] : ["Check for Updates"]);
  expect(failed.footer).toBe(true);
  if (reason === "attempt-not-saved" || reason === "installer-failed") return;
  const unavailable = render(verified, { install: { kind: "unavailable-in-this-build", reason } });
  expect(unavailable.actions).toEqual([]);
  expect(unavailable.html).toContain(line);
});
it("F-231: only the matching verified offer can open Restart", () => {
  const install = { kind: "restart-available", offerId: "shown" } as const;
  expect(render(verified, { install }).actions).toEqual(["Restart to Update"]);
  expect(render(verified, { install: { ...install, offerId: "other" } }).actions).toEqual([]);
  expect(render({ kind: "checking" }, { install }).actions).toEqual([]);
  expect(
    render(verified, { install: { kind: "unavailable-in-this-build", reason: "future" as never } })
      .html,
  ).toContain("This update can't be installed from here.");
});
it.each([
  ["preparing", "Preparing Clawtrate 1.1.0 for restart…"],
  ["handing-off", "Handing Clawtrate 1.1.0 to the system updater…"],
  [
    "handed-to-system",
    "Clawtrate handed the update to the macOS updater. After restart, Clawtrate reports the version that is running.",
  ],
] as const)("F-231 F-030: locks actions during %s", (kind, line) => {
  const row = render({ kind, version: verified.version, offerId: verified.offerId });
  expect(row.html).toContain(line);
  expect(row.html).toMatch(/<fieldset disabled/);
  expect(row.actions).toEqual([]);
  expect(row.footer).toBe(true);
});
it.each([
  ["target-running", "2.0.0", "Clawtrate 2.0.0 is running."],
  ["old-version-running", "1.0.0", "Clawtrate is still running 1.0.0."],
  ["unconfirmed", "1.5.0", "Clawtrate 1.5.0 is running. Couldn't confirm the update attempt."],
  ["unconfirmed", null, "Couldn't confirm the update attempt."],
] as const)("F-231: reports the observed %s version %s", (kind, running, line) => {
  expect(
    render(
      { kind: "not-checked" },
      { lastAttempt: { kind, running, target: "2.0.0", from: "1.0.0", track: "stable" } },
    ).html,
  ).toContain(line);
  expect(render({ kind: "not-checked" }).html).not.toContain(line);
});
