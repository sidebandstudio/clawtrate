import { execFileSync } from "node:child_process";
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { arch } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "./harness.ts";

// Exercise the ZIP reader and bundle metadata with inert fixtures. This
// executable has no caller for the Security or framework handoff functions.
describe.skipIf(process.platform !== "darwin")("Mac archive preflight", () => {
  let dir: ReturnType<typeof tempDir>, reader: string;
  beforeAll(() => {
    dir = tempDir();
    reader = join(dir.path, "fixture-reader");
    const source = join(dir.path, "read.m");
    writeFileSync(
      source,
      `#define main inspection_main
#include "inspect-archive.m"
#undef main
int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc == 2) {
      if (strcmp(argv[1], "adhoc") == 0) puts(signatureKind(0, @{(__bridge NSString *)kSecCodeInfoFlags:@(kSecCodeSignatureAdhoc), (__bridge NSString *)kSecCodeInfoIdentifier:@"fixture"}));
      else puts(signatureKind(0, @{}));
      return 0;
    }
    int root=open(argv[1],O_DIRECTORY|O_RDONLY);
    if (argc == 4 && strcmp(argv[2], "budget") == 0) {
      puts(unpackWithBudget(3,root,atoi(argv[3])) ? "ok" : "mac-archive");
      return 0;
    }
    if (!unpack(3,root)) {puts("mac-archive"); return 0;}
    NSURL *url=[NSURL fileURLWithPath:[@(argv[1]) stringByAppendingPathComponent:@"Clawtrate.app"]];
    puts(bundleFacts(url,@"dev.clawtrate.desktop",@(argv[2]),@(argv[3])) ?: "ok");
    return 0;
  }
}`,
    );
    execFileSync("/usr/bin/xcrun", [
      "clang",
      "-fobjc-arc",
      "-Werror",
      "-I",
      resolve(import.meta.dirname, "../../packaging/mac"),
      "-framework",
      "Foundation",
      "-framework",
      "Security",
      "-larchive.2",
      source,
      "-o",
      reader,
    ]);
  }, 30000);
  afterAll(() => dir.remove());
  it.each(["adhoc", "unsigned"])(
    "classifies %s signing information without trust evaluation or an archive",
    (kind) => {
      expect(execFileSync(reader, [kind], { encoding: "utf8" }).trim()).toBe("build-not-signed");
    },
  );
  it("rejects an archive whose implicit directories exceed the scratch entry limit", () => {
    const input = join(dir.path, "budget"),
      leaf = "Clawtrate.app/a/b/leaf";
    mkdirSync(join(input, "Clawtrate.app/a/b"), { recursive: true });
    writeFileSync(join(input, leaf), "");
    execFileSync("/usr/bin/zip", ["-Dq", "fixture.zip", leaf], { cwd: input });
    for (const limit of [2, 3, 4]) {
      const scratch = join(input, String(limit));
      mkdirSync(scratch);
      const fd = openSync(join(input, "fixture.zip"), "r");
      try {
        expect(
          execFileSync(reader, [scratch, "budget", String(limit)], {
            stdio: ["ignore", "pipe", "pipe", fd],
            encoding: "utf8",
          }).trim(),
        ).toBe(limit === 4 ? "ok" : "mac-archive");
        expect(readdirSync(scratch, { recursive: true })).toHaveLength(limit);
      } finally {
        closeSync(fd);
      }
    }
  });
  const version = "1.2.0-nightly.20261104.10";
  it.each([
    "ok",
    "mac-archive",
    "mac-architecture",
    "mac-bundle-identifier",
    "installer-version",
  ] as const)("reads the sealed bundle fields and one top-level app (%s)", (expected) => {
    const input = join(dir.path, expected),
      scratch = join(input, "scratch"),
      app = join(input, "Clawtrate.app");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(scratch);
    const identifier =
      expected === "mac-bundle-identifier" ? "dev.fixture.other" : "dev.clawtrate.desktop";
    const contents = {
      CFBundlePackageType: "APPL",
      CFBundleIdentifier: identifier,
      CFBundleExecutable: "Clawtrate",
      CFBundleShortVersionString: expected === "installer-version" ? "1.2.0" : version,
    };
    writeFileSync(
      join(app, "Contents", "Info.plist"),
      Buffer.from(
        execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "--", "-"], {
          input: JSON.stringify(contents),
        }),
      ),
    );
    // A Mach-O that the metadata reader can identify, never invoked from the fixture app.
    writeFileSync(join(app, "Contents", "MacOS", "Clawtrate"), readFileSync(reader), {
      mode: 0o700,
    });
    const entries = ["Clawtrate.app"];
    if (expected === "mac-archive") {
      mkdirSync(join(input, "Second.app"));
      entries.push("Second.app");
    }
    execFileSync("/usr/bin/zip", ["-qr", "fixture.zip", ...entries], { cwd: input });
    const fd = openSync(join(input, "fixture.zip"), "r");
    try {
      const cpu = expected === "mac-architecture" ? (arch() === "arm64" ? "x64" : "arm64") : arch();
      expect(
        execFileSync(reader, [scratch, version, cpu], {
          stdio: ["ignore", "pipe", "pipe", fd],
          encoding: "utf8",
        }).trim(),
      ).toBe(expected);
    } finally {
      closeSync(fd);
    }
  });
});
