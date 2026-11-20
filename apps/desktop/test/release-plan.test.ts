import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  renameSync,
  symlinkSync,
  truncateSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { assemble, plan, feedFingerprint, type Candidate } from "../packaging/release-plan.ts";
import { artifactName, sha512Base64 } from "../packaging/feed.ts";
import { macReadback } from "../packaging/candidate-build.ts";
import { FILE_KEYS } from "../src/main/update/feed.ts";
import { MAX_DOWNLOAD_BYTES } from "../src/main/update/engine.ts";

let c: Candidate;
const path = (name: string) => join(c.dir, name);
const mac = "mac-arm64";
const file = () => path(artifactName(c.version, mac));
const read = (name: string) => JSON.parse(readFileSync(path(name), "utf8"));
const write = (name: string, value: unknown) => writeFileSync(path(name), JSON.stringify(value));
beforeEach(() => {
  c = {
    dir: mkdtempSync(join(tmpdir(), "release-test-")),
    track: "stable",
    version: "0.2.0",
    commit: "a".repeat(40),
    buildDate: "2026-11-19T00:00:00.000Z",
    feedUrl: "https://example.org/stable/feed.json",
  };
  for (const key of FILE_KEYS) {
    const name = artifactName(c.version, key);
    writeFileSync(path(name), key);
    write(key + ".json", {
      name,
      commit: c.commit,
      buildDate: c.buildDate,
      feedHash: feedFingerprint(c.feedUrl),
      sha512: sha512Base64(path(name)),
      signing: key === "win-x64" ? "authenticode-valid" : "developer-id-notarized",
    });
  }
  assemble(c);
});
afterEach(() => rmSync(c.dir, { recursive: true, force: true }));

it("checks the complete set of signed build receipts and all final bytes", () => {
  const result = plan(c);
  expect(result).toMatchObject({ verdict: "publishable", issues: [], holds: [] });
  expect(result.files).toHaveLength(3);
  expect(result.files[0]).toEqual({
    name: artifactName(c.version, mac),
    size: mac.length,
    sha512: sha512Base64(file()),
    signing: "developer-id-notarized",
  });
  expect(() => assemble(c)).toThrow();
});
it("reports missing, misnamed, empty and leftover artifacts together without printing foreign names", () => {
  renameSync(file(), path(artifactName("0.1.0", mac)));
  writeFileSync(path(artifactName(c.version, "mac-x64")), "");
  writeFileSync(path("private-name"), "");
  const result = plan(c);
  expect(result.issues).toEqual(
    expect.arrayContaining([
      "mac-arm64: missing regular file for this version.",
      "mac-x64: artifact is empty or exceeds the download limit.",
      "The candidate folder contains unexpected entries.",
    ]),
  );
  expect(JSON.stringify(result)).not.toContain("private-name");
  expect(result.verdict).toBe("not publishable");
});
it("rejects a symbolic link, oversized file or malformed receipt", () => {
  rmSync(file());
  symlinkSync(path(artifactName(c.version, "mac-x64")), file());
  truncateSync(path(artifactName(c.version, "win-x64")), MAX_DOWNLOAD_BYTES + 1);
  writeFileSync(path(mac + ".json"), "bad");
  expect(plan(c).issues).toEqual(
    expect.arrayContaining([
      "mac-arm64: missing regular file for this version.",
      "win-x64: artifact is empty or exceeds the download limit.",
      "mac-arm64: missing or wrong build receipt.",
    ]),
  );
});
it("checks feed format, track, source, date, version, system set, folder, size and checksum independently", () => {
  const feed = read("update-feed.json");
  Object.assign(feed, {
    format: 99,
    version: "0.1.0",
    sourceCommit: "b".repeat(40),
    releaseDate: "2026-11-20",
    track: "nightly",
  });
  delete feed.files["mac-x64"];
  feed.files.other = {};
  Object.assign(feed.files[mac], { url: c.feedUrl, size: 2, sha512: "bad" });
  write("update-feed.json", feed);
  expect(plan(c).issues).toEqual(
    expect.arrayContaining([
      "Missing or invalid feed format.",
      "Feed track differs.",
      "Feed source commit differs.",
      "Feed build date differs.",
      "Feed version differs.",
      "Feed contains an unexpected system.",
      "mac-x64: missing feed entry.",
      "mac-arm64: address differs from the expected versioned file.",
      "mac-arm64: feed size differs.",
      "mac-arm64: feed digest differs.",
    ]),
  );
});
it("binds the build receipt to its name, source, date, compiled feed address and bytes", () => {
  write(mac + ".json", {
    ...read(mac + ".json"),
    commit: "b".repeat(40),
    buildDate: "2026-11-20",
    name: "other",
    feedHash: "different",
    sha512: "wrong",
  });
  expect(plan(c).issues).toHaveLength(5);
});
it("checks version syntax, both track mismatches, commit, date and the HTTPS feed location", () => {
  for (const [version, track] of [
    ["0.1.0", "nightly"],
    ["0.1.1-nightly.20261119.1", "stable"],
    ["bad", "stable"],
    ["0.1.0", "bad"],
  ] as const)
    expect(plan({ ...c, version, track }).issues).toContain("Version and track must match.");
  const result = plan({
    ...c,
    version: "/private",
    track: "/private",
    commit: "/private",
    buildDate: "/private",
    feedUrl: "http://private.example/",
  });
  expect(result.issues).toEqual(
    expect.arrayContaining([
      "Expected a full source commit.",
      "Expected a UTC build date.",
      "Expected a direct HTTPS feed address.",
    ]),
  );
  expect(JSON.stringify(result)).not.toContain("private");
  expect(plan({ ...c, feedUrl: "https://updates.example/feed.json" }).holds).toContain(
    "The build uses a placeholder feed.",
  );
});
it.each([
  "ad hoc",
  "unsigned",
  "certificate",
  "unknown",
  "invalid",
  "authenticode-valid",
  "arbitrary personal data",
])("refuses Mac signing readback %s", (signing) => {
  write(mac + ".json", { ...read(mac + ".json"), signing });
  const result = plan(c);
  expect(result.verdict).toBe("not publishable");
  expect(result.holds[0]).toContain("requires developer-id-notarized");
  expect(JSON.stringify(result)).not.toContain("arbitrary personal data");
});
it("refuses unsigned Windows and distinguishes the packager's readback from its signing plan", () => {
  write("win-x64.json", { ...read("win-x64.json"), signing: "unsigned" });
  expect(plan(c).holds).toContain("win-x64: signing is unsigned; requires authenticode-valid.");
  for (const [log, kind] of [
    ["ad hoc", "ad hoc"],
    ["certificate", "certificate"],
    ["none", "unsigned"],
  ] as const)
    expect(macReadback("Signature of dist/mac-arm64/Clawtrate.app: " + log + ".", mac)).toBe(kind);
  expect(macReadback("Signing plan: certificate", mac)).toBe("unknown");
});
