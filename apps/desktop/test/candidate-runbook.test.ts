import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("documents the install gate, isolated trial, feed comparison and withdrawal of held offers in order", () => {
  const guide = readFileSync(
    new URL("../../../docs/development/releases.md", import.meta.url),
    "utf8",
  );
  const steps = [
    "In-place installation is not on `main` yet",
    "win-unpacked/Clawtrate.exe",
    '"$CURRENT_FEED" "$OTHER_FEED"',
    "### Trial on an isolated feed",
    "separate HTTPS endpoint to exercise the chosen track on the trial machines",
    "Restrict network access to those machines",
    "without HTTP credentials",
    "Compile the signed predecessor's chosen track to use this trial address and leave its other track unset",
    "exact prospective signed successor files",
    "The successor retains its compiled production addresses when it relaunches",
    "Keep both production feeds closed",
    "### Offer a version",
    "Upload the three immutable binaries first",
    "atomically replace the chosen track",
    "### Withdraw a version",
    "Restore and verify the last good feed",
    "remove the withdrawn binaries",
    "needs a newer signed build",
  ];
  let previous = -1;
  for (const step of steps) {
    const index = guide.indexOf(step);
    expect(index, step).toBeGreaterThan(previous);
    previous = index;
  }
});

it("links the packaging guide’s feed generator to the owner’s installation gate", () => {
  const guide = readFileSync(
    new URL("../../../docs/development/packaging.md", import.meta.url),
    "utf8",
  );
  const paragraph = guide.split("\n\n").find((text) => text.includes("node packaging/feed.ts"));
  expect(paragraph).toContain(
    "[owner procedure](releases.md#owner-procedure) and its in-place installation gate",
  );
});
