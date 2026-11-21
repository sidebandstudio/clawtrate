import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("documents the install gate, isolated trial, feed comparison and withdrawal of held offers in order", () => {
  const guide = readFileSync(
    new URL("../../../docs/development/releases.md", import.meta.url),
    "utf8",
  ).replace(/\s+/g, " ");
  const steps = [
    "In-place installation is on `main` (#202); the Restart screen (#204) is not yet.",
    "Keep Stable and Windows closed until #204 is on `main` and the signed upgrade trial passes on all three systems.",
    "win-unpacked/Clawtrate.exe",
    '"$CURRENT_FEED" "$OTHER_FEED"',
    "### Trial on an isolated feed",
    "separate HTTPS endpoint",
    "Restrict network access to those machines",
    "without HTTP credentials",
    "signed predecessor's chosen track",
    "use this trial address",
    "leave its other track unset",
    "exact prospective signed successor files",
    "retains its compiled production addresses",
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
  const paragraph = guide
    .split(/\r?\n\s*\r?\n/)
    .map((text) => text.replace(/\s+/g, " "))
    .find((text) => text.includes("node packaging/feed.ts"));
  expect(paragraph).toContain("in-place installation gate");
  const links = [...(paragraph ?? "").matchAll(/\[[^\]]+\]\(([^)]+)\)/g)];
  expect(links.map((link) => link[1])).toContain("releases.md#owner-procedure");
});
