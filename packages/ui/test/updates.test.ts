import {
  noDesktopUpdates,
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
  lastCheckedAt: null,
  state: { kind: "not-checked" },
  install: { kind: "unavailable-in-this-build" },
};
function render(
  state: DesktopUpdateState,
  extra: Partial<DesktopUpdateSnapshot> = {},
  refused: UpdateTrack | null = null,
) {
  const s = { ...snapshot, ...extra, state };
  const html = renderToStaticMarkup(
    createElement(Updates, { updates: noDesktopUpdates, snapshot: s, refused, onChoice: () => {} }),
  ).replaceAll("&#x27;", "'");
  return {
    html,
    actions: [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]),
    footer: showUpdateFooter(s),
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
    { kind: "verified", version: "1.1.0", size: 100 },
    "Clawtrate 1.1.0 is downloaded, and its size and checksum match the update source. Installation isn't available from this screen.",
    [],
    true,
  ],
];
it.each(cases)(
  "F-231 F-030 shows the host reading %j and its actions",
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
  "invalid-version": null,
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
  "F-231 F-030 explains %s and offers only the matching action",
  (reason) => {
    const result = render({ kind: "failed", stage: "check", reason });
    const unsupported = ["development-build", "not-configured", "no-updater"].includes(reason);
    expect(result.html).toContain(failures[reason] ?? "Couldn't check for updates.");
    expect(result.actions).toEqual(
      unsupported ? [] : [reason === "no-file-for-this-system" ? "Check for Updates" : "Try again"],
    );
    expect(result.footer).toBe(!unsupported);
    if (unsupported) expect(result.html).not.toContain("radio");
    else {
      const dl = render({ kind: "failed", stage: "download", reason });
      expect(dl.html).toContain("Couldn't download the update. Try again.");
      expect(dl.actions).toEqual(["Try again"]);
      expect(dl.footer).toBe(true);
    }
  },
);
it("F-231 names the running and selected tracks and shows choices only with two sources", () => {
  const one = render({ kind: "not-checked" }, { tracks: snapshot.tracks.slice(0, 1) });
  expect(one.html).not.toContain("radio");
  expect(one.html).toContain("This copy is a Stable build.");
  const two = render({ kind: "nothing-newer" }, { selectedTrack: "nightly" });
  expect(two.html).toContain("Update track");
  expect(two.html).toContain(
    "No newer Nightly build was offered. Clawtrate 1.0.0 is still running.",
  );
  expect(two.html).toContain("Checks nightly.example for a newer build, only when you choose to.");
  const refused = render(
    { kind: "failed", stage: "preferences", reason: "write-failed" },
    {},
    "stable",
  );
  expect(refused.html).toContain("Couldn't save the track. Stable is still selected.");
  expect(refused.footer).toBe(false);
  const startup = render({ kind: "failed", stage: "preferences", reason: "write-failed" });
  expect(startup.html).toContain("Update settings are unavailable.");
  expect(startup.html).not.toContain("save the track");
  expect(startup.footer).toBe(false);
});
