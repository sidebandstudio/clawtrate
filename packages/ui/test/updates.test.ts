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
import {
  attemptLine,
  cleanupLine,
  inspectionFailureDetails,
  inspectionFailureLine,
} from "../src/update-restart.ts";

const snapshot: DesktopUpdateSnapshot = {
  runningVersion: "1.0.0",
  runningTrack: "stable",
  selectedTrack: "stable",
  tracks: [
    { track: "stable", source: "stable.example" },
    { track: "nightly", source: "beta.example" },
  ],
  revision: 1,
  lastCheck: null,
  pendingTrack: null,
  preferenceIssue: null,
  state: { kind: "not-checked" },
  lastAttempt: null,
  install: { kind: "unavailable-in-this-build", reason: "no-verified-download" },
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
  // A definite refusal leaves nothing pending, so the person can check again.
  [
    { kind: "handoff-failed", version: "1.1.0", reason: "mac-updater-refused" },
    "The macOS updater refused the update before receiving it. Nothing was installed.",
    ["Check for Updates"],
    true,
  ],
  [
    { kind: "handoff-failed", version: "1.1.0", reason: "installer-failed" },
    "Couldn't hand the update to the installer.",
    ["Check for Updates"],
    true,
  ],
  [
    { kind: "handoff-unconfirmed", version: "1.1.0", offerId: "opaque" },
    "Clawtrate couldn't confirm that the macOS updater accepted the update.",
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
  expect(two.html).toContain("No newer Beta build was offered. Clawtrate 1.0.0 is still running.");
  expect(two.html).toContain("Checks beta.example for a newer build, only when you choose to.");
  expect(
    render({ kind: "not-checked" }, { tracks: snapshot.tracks.slice(1), selectedTrack: "nightly" })
      .html,
  ).toContain("The next check asks the Beta source.");
});

it("F-231: names the host it checks, but not as where a download comes from", () => {
  // A Beta download starts at GitHub, not at the feed's host.
  const offered = render(
    { kind: "offered", version: "1.1.0", releaseDate: "2026-10-01", offerId: "opaque" },
    { selectedTrack: "nightly" },
  );
  expect(offered.html).toContain("Downloads Clawtrate 1.1.0, only when you choose to.");
  expect(offered.html).not.toContain("beta.example");
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
  for (const bytes of [1000, 1001]) {
    const html = download(bytes);
    const checking = "Checking the downloaded update for Clawtrate 2.0.0…";
    expect(html).toContain('<dd class="b-wrap-value">' + checking);
    expect(html).toContain('role="status">' + checking);
    expect(html).not.toMatch(/Downloading|<progress|100%/);
  }
  expect(download(200)).toContain('role="status">Downloading Clawtrate 2.0.0… 20%');
});

it("F-231 F-030: a pending choice hides the retired offer, action and source", () => {
  const result = render(
    { kind: "offered", offerId: "retired", version: "2.0.0", releaseDate: "2026-11-01" },
    { pendingTrack: "nightly" },
  );
  expect(result.html).toContain("Saving Beta as the update track…");
  expect(result.html).toContain("Not checked yet.");
  expect(result.html).not.toMatch(/stable.example|2.0.0/);
  expect(result.actions).toEqual([]);
  expect(result.footer).toBe(false);
});

const restartFailures = [
  ["windows-install-pending-trial", "Restart to update on Windows is unavailable in this build."],
  ["build-not-signed", "This build can't install updates itself."],
  ["no-installer-path", "Clawtrate can't install updates on this system."],
  ["artifact-changed", "Couldn't verify the saved update again."],
  ["mac-designated-requirement", "The update doesn't meet this app's macOS signing requirement."],
  ["inspection-failed", "Couldn't finish checking the downloaded update."],
  ["running-signature-untrusted", "Couldn't verify the signature of the running app."],
  ["installer-version", "The downloaded app's version doesn't match the offered version."],
  ["mac-archive", "The downloaded archive can't be used for this update."],
  ["mac-bundle-identifier", "The downloaded Mac app has a different app identifier."],
  ["mac-architecture", "The downloaded Mac app is for a different processor."],
  ["attempt-not-saved", "Couldn't save the restart attempt on this device."],
  ["installer-failed", "Couldn't hand the update to the installer."],
] as const;
it.each([restartFailures[0], restartFailures[1], restartFailures[2]])(
  "F-231 F-030: an offer stays reachable but withholds Download for %s",
  (reason, line) => {
    const offer = render(
      { kind: "offered", version: "1.1.0", offerId: "shown", releaseDate: "2026-11-01" },
      {
        install: { kind: "unavailable-in-this-build", reason },
      },
    );
    expect(offer.actions).toEqual(["Check for Updates"]);
    expect(offer.html).toContain("Clawtrate 1.1.0 is offered by the update source.");
    expect(offer.html).toContain(line);
    expect(offer.html).not.toContain("Downloads Clawtrate");
    expect(offer.footer).toBe(true);
  },
);
const verified = { kind: "verified", offerId: "shown", version: "1.1.0", size: 100 } as const;
it.each(restartFailures)("F-231: explains the installer refusal %s", (reason, line) => {
  const failed = render({ kind: "handoff-failed", version: "1.1.0", reason });
  expect(failed.html).toContain(line);
  expect(failed.actions).toEqual(["Check for Updates"]);
  expect(failed.footer).toBe(true);
  if (reason === "attempt-not-saved" || reason === "installer-failed") return;
  const unavailable = render(verified, { install: { kind: "unavailable-in-this-build", reason } });
  expect(unavailable.actions).toEqual(reason === "artifact-changed" ? ["Check for Updates"] : []);
  expect(unavailable.html).toContain(line);
  const spoken = unavailable.html.match(/role="status">([^<]*)</)?.[1];
  expect(spoken?.split(line)).toHaveLength(2);
});
it("doesn't call restart unavailable when it is offered or still possible", () => {
  const install = { kind: "restart-available", offerId: "shown" } as const;
  for (const html of [render(verified, { install }).html, render({ kind: "not-checked" }).html])
    expect(html).not.toContain("Automatic restart is unavailable");
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
  [
    "handoff-unconfirmed",
    "Clawtrate couldn't confirm that the macOS updater accepted the update. macOS may still install it when Clawtrate quits. After reopening, Clawtrate reports the version that is running.",
  ],
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
  [
    "old-version-running",
    "1.0.0",
    "Clawtrate 1.0.0 is running, not 2.0.0. Check for updates to try again.",
  ],
  [
    "unconfirmed",
    "1.5.0",
    "Clawtrate 1.5.0 is running. Clawtrate couldn't confirm that it restarted into 2.0.0.",
  ],
  ["unconfirmed", null, "Clawtrate couldn't read the running version."],
] as const)("F-231: reports the observed %s version %s", (kind, running, line) => {
  expect(
    render(
      { kind: "not-checked" },
      {
        revision: 0,
        lastAttempt: { kind, running, target: "2.0.0", from: "1.0.0", track: "stable" },
      },
    ).html,
  ).toContain(line);
  expect(render({ kind: "not-checked" }).html).not.toContain(line);
});

it("F-231: the idle install capability adds no warning or restart", () => {
  for (const state of [{ kind: "not-checked" } as const, verified]) {
    const result = render(state, {
      install: { kind: "unavailable-in-this-build", reason: "no-verified-download" },
    });
    expect(result.html).not.toContain("b-note");
    expect(result.actions).not.toContain("Restart to Update");
  }
});

it("F-231: an unsupported desktop system explains the absent installer without an action", () => {
  const row = render(
    { kind: "failed", stage: "check", reason: "unsupported-system" },
    { install: { kind: "unavailable-in-this-build", reason: "no-installer-path" } },
  );
  expect(row.html).toContain("Clawtrate can't install updates on this system.");
  expect(row.actions).toEqual([]);
});

it("F-231: a previous attempt gives retry advice only on its idle startup track", () => {
  const lastAttempt = {
    kind: "old-version-running",
    from: "1.0.0",
    running: "1.0.0",
    target: "1.1.0",
    track: "stable",
  } as const;
  const startup = { revision: 0, lastAttempt };
  const idle = { kind: "not-checked" } as const;
  const advice = "Check for updates to try again.";
  expect(render(idle, startup).html).toContain(advice);
  for (const extra of [
    { revision: 1 },
    { selectedTrack: "nightly" as const },
    { pendingTrack: "nightly" as const },
  ])
    expect(render(idle, { ...startup, ...extra }).html).not.toContain(advice);
  for (const state of [
    ...cases.filter(([state]) => state.kind !== "not-checked").map(([state]) => state),
    ...(["preparing", "handing-off", "handed-to-system", "handoff-unconfirmed"] as const).map(
      (kind) => ({ kind, version: "1.1.0", offerId: "shown" }),
    ),
  ])
    expect(render(state, startup).html).not.toContain(advice);
});

const failure = {
  stage: "running-signature",
  exitCode: 0,
  signal: null,
  output: "reported",
  helperStep: "parent-code -67065",
  errorCode: null,
  durationMs: 84,
  system: "macOS 27.2.1",
} as const;
it("F-231: a failed inspection says where it stopped, under the message it explains", () => {
  const install = {
    kind: "unavailable-in-this-build",
    reason: "inspection-failed",
    failure,
  } as const;
  const shown = render(verified, { install });
  const message = shown.html.indexOf("Couldn't finish checking the downloaded update.");
  const reason = shown.html.indexOf(
    "The update checker stopped while checking this app's signature: it couldn't read a signature.",
  );
  expect(message).toBeGreaterThan(-1);
  expect(reason).toBeGreaterThan(message);
  expect(shown.actions).toEqual(["Copy details"]);
  const failed = render(
    { kind: "handoff-failed", version: "1.1.0", reason: "inspection-failed", failure },
    { install },
  );
  expect(failed.html.indexOf("checking this app's signature")).toBeGreaterThan(
    failed.html.indexOf("Couldn't finish checking the downloaded update."),
  );
  expect(failed.actions).toEqual(["Copy details", "Check for Updates"]);
  // Without a record, nothing more is said.
  const bare = render(verified, {
    install: { kind: "unavailable-in-this-build", reason: "inspection-failed" },
  });
  expect(bare.actions).toEqual([]);
  expect(bare.html).not.toContain("update checker");
});
it.each([
  [
    { stage: "hold-archive", errorCode: "ENOSPC" },
    "It stopped while keeping a private copy of the download (ENOSPC).",
  ],
  [
    { stage: "start-helper", output: null, errorCode: "ENOENT" },
    "The update checker didn't start (ENOENT).",
  ],
  [
    { stage: "archive", signal: "SIGKILL", output: "empty" },
    "The update checker stopped while checking the downloaded app: macOS stopped it with SIGKILL.",
  ],
  [
    { stage: "archive", exitCode: 1, output: "empty" },
    "The update checker stopped while checking the downloaded app: it exited with code 1.",
  ],
  [{ output: "empty" }, "it gave no answer."],
  [{ output: "no-line-ending" }, "its answer was cut off."],
  [{ output: "too-long" }, "its answer was too long."],
  [{ output: "unrecognized" }, "it gave an answer Clawtrate doesn't know."],
] as const)("F-231: words a failed inspection %#", (change, line) => {
  expect(inspectionFailureLine({ ...failure, ...change })).toContain(line);
});
it("F-231: the details to copy are codes, counts and versions only", () => {
  expect(inspectionFailureDetails(failure, "0.1.1-beta.20261122.4")).toBe(
    [
      "Clawtrate update inspection failed",
      "Version: 0.1.1-beta.20261122.4",
      "System: macOS 27.2.1",
      "Stage: running-signature",
      "Exit code: 0",
      "Signal: none",
      "Output: reported",
      "Helper step: parent-code -67065",
      "Error code: none",
      "Duration: 84 ms",
    ].join("\n"),
  );
});

it("F-231: says when the check left a copy it couldn't remove, and that it tries again", () => {
  const install = {
    kind: "restart-available",
    offerId: "shown",
    cleanup: { copy: "checked-copy", errorCode: "ENOTEMPTY" },
  } as const;
  const line =
    "Clawtrate couldn't remove the copy of the app it checked (ENOTEMPTY). It tries again at the next start or check.";
  expect(cleanupLine({ ...snapshot, install })).toBe(line);
  expect(render(verified, { install }).html).toContain(line);
  expect(
    cleanupLine({
      ...snapshot,
      install: { ...install, cleanup: { copy: "held-copy", errorCode: "EPERM" } },
    }),
  ).toContain("its private copy of the download (EPERM)");
  expect(
    render(verified, { install: { kind: "restart-available", offerId: "shown" } }).html,
  ).not.toContain("couldn't remove");
});

it.each([
  [
    { quit: "not-finished" },
    "Clawtrate 1.0.0 is running, not 1.1.0. The app didn't finish quitting for the update, and macOS installs it only after that. Check for updates to try again.",
  ],
  [
    { quit: "finished", quitMs: 23_400 },
    "Clawtrate 1.0.0 is running, not 1.1.0. The app quit for the update after 23 s, but macOS didn't install it. Check for updates to try again.",
  ],
  [
    { quit: "finished" },
    "Clawtrate 1.0.0 is running, not 1.1.0. The app quit, but macOS didn't install the update. Check for updates to try again.",
  ],
  [{}, "Clawtrate 1.0.0 is running, not 1.1.0. Check for updates to try again."],
] as const)(
  "F-231: after an update that didn't take, says whether the app finished quitting %#",
  (quit, line) => {
    expect(
      attemptLine({
        kind: "old-version-running",
        target: "1.1.0",
        from: "1.0.0",
        track: "stable",
        running: "1.0.0",
        ...quit,
      }),
    ).toBe(line);
  },
);
