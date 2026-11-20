import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import expected from "./fixtures/release-workflow.json";

const raw = readFileSync(
  new URL("../../../.github/workflows/release-candidate.yml", import.meta.url),
  "utf8",
);
const yaml = createRequire(import.meta.url)("js-yaml");
it("fixes the exact manual unsigned workflow including job order, commands, guards and retained paths", () => {
  expect(yaml.load(raw)).toEqual(expected);
});
it.each([
  ["schedule", "  workflow_dispatch:", "  schedule: [{cron: '0 5 * * *'}]\n  workflow_dispatch:"],
  ["push tags", "  workflow_dispatch:", "  push: {tags: ['v*']}\n  workflow_dispatch:"],
  ["pull request", "  workflow_dispatch:", "  pull_request:\n  workflow_dispatch:"],
  ["repository write", "contents: read", "contents: write"],
  ["job write", "  macos:\n", "  macos:\n    permissions: {contents: write}\n"],
  ...["secrets.TEST", "secrets['TEST']", "toJSON(secrets)"].map((s) => [s, "inputs.version", s]),
  ...[
    "gh release create v0.1.0",
    "gh api --method POST repos/{owner}/{repo}/releases",
    "node extra-script",
    "git tag v0.1.0",
  ].map((s) => [s, "      - id: select", "      - run: " + s + "\n      - id: select"]),
  ["broader upload", "path: candidate/", "path: ./"],
  ["retention", "retention-days: 3", "retention-days: 30"],
  ["checkout ref", "persist-credentials: false", "persist-credentials: false\n          ref: main"],
  ["action pin", "checkout@v7", "checkout@v6"],
  [
    "unpacked Windows app guard",
    "unpacked-amd64 apps/desktop/dist/win-unpacked/Clawtrate.exe",
    "win-x64 candidate/installer.exe",
  ],
  ["assembly guard", 'test "$checked" = "$MAC_DIGESTS,$WIN_DIGEST"', "true"],
  [
    "native guard",
    "digests=$(node apps/desktop/packaging/check-unsigned.ts candidate",
    "digests=$(echo candidate",
  ],
])("rejects a workflow change to %s", (_label, before, after) => {
  expect(raw).toContain(before);
  expect(yaml.load(raw.replace(before!, after!))).not.toEqual(expected);
});
