import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  renameSync,
  symlinkSync,
  truncateSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assemble, plan, runPlan, type Candidate } from "../packaging/release-plan.ts";
import { feedAddresses, compiledAddresses } from "../packaging/candidate-addresses.ts";
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
// These tests start python3 and node, which can take seconds each on a busy machine: one took
// 3.4 s of the default 5 s with the load average at 6, and several ran out at 30 or more.
vi.setConfig({ testTimeout: 30_000 });

// Small structural fixtures. No fixture is executed or signed.
function macZip(cpu: number, variant = ""): Buffer {
  return execFileSync(process.platform === "win32" ? "python" : "python3", [
    "-I",
    "-c",
    `
import io, plistlib, stat, struct, sys, zipfile
variant = sys.argv[2]
header = struct.pack("<8I", 0xfeedfacf, int(sys.argv[1]), 0, 2, 2, 96, 0, 0)
segment = struct.pack("<II16s4Q4I", 0x19, 0 if variant == "zero command size" else 72,
                      b"__TEXT", 0, 129, 0, 129, 5, 5, 0, 0)
main = struct.pack("<IIQQ", 0x80000028, 24, 128, 0)
executable = header + segment + main + (b"" if variant == "truncated entry" else b"X")
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w") as z:
    contents = "Clawtrate.app/Contents/"
    marker = zipfile.ZipInfo(contents)
    marker.external_attr = (stat.S_IFLNK if variant == "slash-marked symlink" else stat.S_IFDIR) << 16
    z.writestr(marker, b"")
    z.writestr(contents + "Info.plist", plistlib.dumps({"CFBundleExecutable":"Clawtrate"}))
    z.writestr(contents + "MacOS/Clawtrate", executable)
    if variant == "case-folded twin":
        z.writestr(contents + "MacOS/clawtrate", executable)
    link = zipfile.ZipInfo(contents + "Frameworks/Example.framework/Versions/Current")
    link.external_attr = stat.S_IFLNK << 16
    z.writestr(link, b"A")
sys.stdout.buffer.write(buf.getvalue())`,
    String(cpu),
    variant,
  ]);
}
function pe(machine: number, mapped = true) {
  const b = Buffer.alloc(1024);
  b.write("MZ");
  b.writeUInt32LE(64, 60);
  b.write("PE", 64);
  b.writeUInt16LE(machine, 68);
  b.writeUInt16LE(1, 70);
  const optionalSize = machine === 0x014c ? 224 : 240;
  const section = 88 + optionalSize;
  b.writeUInt16LE(optionalSize, 84);
  b.writeUInt16LE(2, 86);
  b.writeUInt16LE(machine === 0x014c ? 0x10b : 0x20b, 88);
  b.writeUInt32LE(4096, 104);
  if (mapped) {
    b.writeUInt32LE(4096, 88 + 32);
    b.writeUInt32LE(512, 88 + 36);
    b.writeUInt32LE(8192, 88 + 56);
    b.writeUInt32LE(512, 88 + 60);
    b.writeUInt32LE(512, section + 8);
  }
  b.writeUInt32LE(4096, section + 12);
  b.writeUInt32LE(512, section + 16);
  b.writeUInt32LE(512, section + 20);
  b.writeUInt32LE(0x60000020, section + 36);
  return b;
}
const samples = {
  "mac-arm64": macZip(0x0100000c),
  "mac-x64": macZip(0x01000007),
  "win-x64": pe(0x014c),
};
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
    writeFileSync(path(name), samples[key]);
    write(key + ".json", {
      name,
      commit: c.commit,
      buildDate: c.buildDate,
      feedAddresses: feedAddresses(c.track, c.feedUrl),
      sha512: sha512Base64(path(name)),
    });
  }
  assemble(c);
});
afterEach(() => rmSync(c.dir, { recursive: true, force: true }));

it("checks that the build records agree with all final artifact bytes", () => {
  const result = plan(c);
  expect(result).toMatchObject({ verdict: "complete and consistent", issues: [] });
  expect(result.files).toHaveLength(3);
  expect(result.files[0]).toEqual({
    name: artifactName(c.version, mac),
    size: samples[mac].length,
    sha512: sha512Base64(file()),
    format: "ZIP with arm64 Mach-O app executable",
    signing: "not checked by this plan",
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
  expect(result.verdict).toBe("refused");
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
    feedAddresses: "different",
    sha512: "wrong",
  });
  expect(plan(c).issues).toHaveLength(5);
});
it("checks version syntax, a dated version on Stable, commit, date and the HTTPS feed location", () => {
  // Three numbers can be a Beta build (F-559); a dated version is never a Stable one.
  expect(plan({ ...c, version: "0.1.0", track: "nightly" }).issues).not.toContain(
    "Version and track must match.",
  );
  for (const [version, track] of [
    ["0.1.1-beta.20261119.1", "stable"],
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
      "Expected distinct, canonical HTTPS feed addresses.",
    ]),
  );
  expect(JSON.stringify(result)).not.toContain("private");
});
it("refuses text, truncated archives, swapped Mac architectures even with matching receipts and feed digests", () => {
  for (const [key, bytes] of [
    [mac, Buffer.from("text")],
    [mac, samples[mac].subarray(0, -12)],
    [mac, samples["mac-x64"]],
  ] as const) {
    const name = artifactName(c.version, key);
    writeFileSync(path(name), bytes);
    write(key + ".json", { ...read(key + ".json"), sha512: sha512Base64(path(name)) });
    rmSync(path("update-feed.json"));
    assemble(c);
    expect(plan(c).issues).toContain(key + ": invalid artifact format or architecture.");
  }
});
it.each(["zero command size", "truncated entry", "slash-marked symlink", "case-folded twin"])(
  "refuses a Mac ZIP with %s even when both hashes match",
  (variant) => {
    writeFileSync(file(), macZip(0x0100000c, variant));
    write(mac + ".json", { ...read(mac + ".json"), sha512: sha512Base64(file()) });
    rmSync(path("update-feed.json"));
    assemble(c);
    expect(plan(c).issues).toEqual(["mac-arm64: invalid artifact format or architecture."]);
  },
);
it("labels signing as unchecked whatever the build record says", () => {
  for (const key of FILE_KEYS)
    write(key + ".json", { ...read(key + ".json"), signing: "arbitrary personal data" });
  const result = plan(c);
  expect(result.verdict).toBe("complete and consistent");
  expect(result.files.every((f) => f.signing === "not checked by this plan")).toBe(true);
  expect(JSON.stringify(result)).not.toContain("personal data");
  for (const [log, kind] of [
    ["ad hoc", "ad hoc"],
    ["certificate", "certificate"],
    ["none", "none"],
  ] as const)
    expect(macReadback("Signature of dist/mac-arm64/Clawtrate.app: " + log + ".", mac)).toBe(kind);
  expect(macReadback("Signing plan: certificate", mac)).toBe("unknown");
  expect(macReadback("", mac)).toBe("unknown");
});

it("rechecks the saved candidate from the command line and preserves the feed on refusal", () => {
  const lines: string[] = [];
  const check = () =>
    runPlan(["check", c.dir, c.track, c.version, c.commit, c.buildDate, c.feedUrl], (line) =>
      lines.push(line),
    );
  expect(check()).toBe(0);
  for (const key of FILE_KEYS)
    write(key + ".json", {
      ...read(key + ".json"),
      signing: key === "win-x64" ? "unsigned" : "ad hoc",
    });
  expect(check()).toBe(0);
  expect(lines.at(-1)).toContain(
    "stable 0.2.0 complete and consistent\nThis plan does not establish that the files may be published; signing, notarization and updating in place are verified by the owner on each system, as the runbook says.",
  );
  expect(read("release-plan.json")).toMatchObject({
    issues: [],
    verdict: "complete and consistent",
  });
  const feed = read("update-feed.json");
  // An interrupted previous write left extra output. A recheck must replace
  // the earlier successful verdict even while the leftover is present.
  write("release-plan.json.tmp", {});
  expect(check()).toBe(1);
  expect(read("release-plan.json")).toMatchObject({
    verdict: "refused",
    issues: ["The candidate folder contains unexpected entries."],
  });
  rmSync(path("release-plan.json.tmp"));
  expect(check()).toBe(0);
  writeFileSync(file(), "changed");
  expect(check()).toBe(1);
  expect(read("update-feed.json")).toEqual(feed);
});

it("reports absent evidence without claiming a different build was observed", () => {
  rmSync(path(mac + ".json"));
  const feed = read("update-feed.json");
  delete feed.files[mac];
  write("update-feed.json", feed);
  expect(plan(c).issues).toEqual([
    "mac-arm64: missing feed entry.",
    "mac-arm64: missing or wrong build receipt.",
  ]);
});

it("invalidates a previous successful verdict if the inspector cannot start", () => {
  const args = ["check", c.dir, c.track, c.version, c.commit, c.buildDate, c.feedUrl];
  expect(runPlan(args, () => {})).toBe(0);
  expect(read("release-plan.json").verdict).toBe("complete and consistent");
  const command = fileURLToPath(new URL("../packaging/release-plan.ts", import.meta.url));
  const result = spawnSync(process.execPath, [command, ...args], {
    env: { ...process.env, PATH: c.dir },
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Could not inspect the files or write a fresh record.");
  expect(existsSync(path("release-plan.json"))).toBe(false);
  expect(runPlan(args, () => {})).toBe(0);
});

it("compares both compiled feed addresses including absence and rejects ambiguous paths", () => {
  expect(plan({ ...c, otherFeedUrl: "https://example.org/nightly/feed.json" }).issues).toContain(
    "mac-arm64: feed address pair differs in the build record.",
  );
  expect(compiledAddresses("nightly", { CLAWTRATE_NIGHTLY_UPDATE_FEED_URL: c.feedUrl })).toEqual({
    nightly: expect.any(String),
    stable: null,
  });
  for (const url of [
    c.feedUrl,
    c.feedUrl.replace("org", "org."),
    c.feedUrl.replace("stable", "%2e%2e"),
    c.feedUrl.replace("stable", "stable%2Fnested"),
    c.feedUrl + "/../feed.json",
    c.feedUrl + "?",
    c.feedUrl + "#",
    c.feedUrl.replace("org", "org:443"),
  ]) {
    expect(plan({ ...c, otherFeedUrl: url }).issues).toContain(
      "Expected distinct, canonical HTTPS feed addresses.",
    );
    expect(() =>
      compiledAddresses("stable", {
        CLAWTRATE_UPDATE_FEED_URL: c.feedUrl,
        CLAWTRATE_NIGHTLY_UPDATE_FEED_URL: url,
      }),
    ).toThrow();
  }
});

it("compares the supplied track feeds offline, including stale, reused and superseding versions", () => {
  const feed = read("update-feed.json");
  const current = path("published.json");
  const check = (version: string, track: string, candidate = c) => {
    write("published.json", { ...feed, version, track });
    return plan({
      ...candidate,
      ...(candidate.track === track ? { currentFeed: current } : { otherFeed: current }),
    });
  };
  expect(plan(c).comparison).toContain("not compared with any published release");
  expect(check(c.version, "stable").issues).toContain("stable: feed already names this version.");
  expect(check("0.2.1", "stable").issues).toContain(
    "stable: candidate must be newer than the supplied release.",
  );
  expect(check("0.2.1-beta.20261119.1", "nightly").issues).toContain(
    "nightly: candidate must be newer than the supplied release.",
  );
  expect(check("0.2.0-beta.20261119.9", "nightly").comparison).toContain("supplied nightly");
  const nightly = { ...c, track: "nightly", version: "0.2.0-beta.20261119.9" };
  expect(check("0.2.0", "stable", nightly).issues).toContain(
    "stable: candidate must be newer than the supplied release.",
  );
  expect(check("0.2.0-beta.20261119.10", "nightly", nightly).issues).toContain(
    "nightly: candidate must be newer than the supplied release.",
  );
  expect(plan({ ...c, currentFeed: path("missing") }).issues).toContain(
    "stable: invalid published comparison feed.",
  );
  expect(plan({ ...nightly, buildDate: "2026-11-20T00:00:00.000Z" }).issues).toContain(
    "Beta version day differs from the UTC build date.",
  );
});

it("accepts a mapped 32-bit PE without an installer payload and refuses unmapped files with matching hashes", () => {
  expect(plan(c)).toMatchObject({
    verdict: "complete and consistent",
    files: expect.arrayContaining([
      expect.objectContaining({
        format: "Windows PE executable",
        installedArchitecture: "not read from the candidate executable",
        buildJobObservation: null,
      }),
    ]),
  });
  const lines: string[] = [];
  const check = () =>
    runPlan(["check", c.dir, c.track, c.version, c.commit, c.buildDate, c.feedUrl], (line) =>
      lines.push(line),
    );
  expect(check()).toBe(0);
  expect(lines.at(-1)).toContain("Windows candidate: Windows PE executable.");
  write("win-x64.json", { ...read("win-x64.json"), unpackedAppMachine: "AMD64" });
  expect(check()).toBe(0);
  expect(lines.at(-1)).toContain(
    "Windows build record attributes this observation to the build job: win-unpacked/Clawtrate.exe is AMD64.",
  );
  expect(read("release-plan.json").verdict).toBe("complete and consistent");
  const name = artifactName(c.version, "win-x64");
  for (const bytes of [pe(0x014c, false), Buffer.from("MZ but no executable header")]) {
    writeFileSync(path(name), bytes);
    write("win-x64.json", { ...read("win-x64.json"), sha512: sha512Base64(path(name)) });
    rmSync(path("update-feed.json"));
    assemble(c);
    expect(plan(c)).toMatchObject({
      verdict: "refused",
      issues: ["win-x64: invalid Windows executable."],
    });
  }
});

it("the Windows job records AMD64 only after reading the unpacked app header", () => {
  const unpacked = path("win-unpacked");
  const exe = join(unpacked, "Clawtrate.exe");
  const inspect = () =>
    spawnSync(process.platform === "win32" ? "python" : "python3", [
      "-I",
      join(import.meta.dirname, "../packaging/inspect-candidate.py"),
      "unpacked-amd64",
      exe,
      path("win-x64.json"),
    ]).status;
  expect(inspect()).toBe(1);
  mkdirSync(unpacked);
  writeFileSync(exe, pe(0x014c));
  expect(inspect()).toBe(1);
  writeFileSync(exe, pe(0xaa64));
  expect(inspect()).toBe(1);
  writeFileSync(exe, pe(0x8664, false));
  expect(inspect()).toBe(1);
  expect(read("win-x64.json").unpackedAppMachine).toBeUndefined();
  writeFileSync(exe, pe(0x8664));
  expect(inspect()).toBe(0);
  rmSync(unpacked, { recursive: true });
  const lines: string[] = [];
  expect(
    runPlan(["check", c.dir, c.track, c.version, c.commit, c.buildDate, c.feedUrl], (line) =>
      lines.push(line),
    ),
  ).toBe(0);
  expect(lines.join("\n")).toContain(
    "Installed app architecture: not read from the candidate executable.\nWindows build record attributes this observation to the build job: win-unpacked/Clawtrate.exe is AMD64.",
  );
  expect(read("release-plan.json").files[2].buildJobObservation).toBe(
    "win-unpacked/Clawtrate.exe is AMD64",
  );
  write("win-x64.json", { ...read("win-x64.json"), unpackedAppMachine: "untrusted free text" });
  expect(plan(c)).toMatchObject({ verdict: "complete and consistent" });
  expect(plan(c).files[2]?.buildJobObservation).toBeNull();
});
