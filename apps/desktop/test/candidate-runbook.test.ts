import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("documents the install gate, isolated trial, feed comparison and withdrawal of held offers in order", () => {
  const guide = readFileSync(
    new URL("../../../docs/development/releases.md", import.meta.url),
    "utf8",
  );
  const steps = [
    "Updating in place is not built yet",
    '"$CURRENT_FEED" "$OTHER_FEED"',
    "### Trial on an isolated feed",
    "Install a signed predecessor compiled with that trial address",
    "exact prospective signed successor files",
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
