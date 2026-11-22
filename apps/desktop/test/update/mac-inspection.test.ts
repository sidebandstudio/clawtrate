import { execFileSync } from "node:child_process";
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { arch } from "node:os";
import { join, resolve } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "./harness.ts";

type ZipEntry = {
  name: string;
  data?: Buffer;
  method?: 0 | 8;
  descriptor?: boolean;
  comment?: Buffer | undefined;
};

function le(...fields: [number, 2 | 4][]): Buffer {
  const out = Buffer.alloc(fields.reduce((sum, [, width]) => sum + width, 0));
  let at = 0;
  for (const [value, width] of fields) {
    if (width === 2) out.writeUInt16LE(value, at);
    else out.writeUInt32LE(value, at);
    at += width;
  }
  return out;
}

// A minimal ZIP writer, so each test can set exactly the field it breaks. Its
// central records carry a 32-byte NTFS extra field, as the release zips do, and
// a data-descriptor entry has zero sizes in its local header, as ditto writes.
function zipArchive(entries: ZipEntry[]): { bytes: Buffer; records: number[] } {
  const locals: Buffer[] = [],
    centrals: Buffer[] = [],
    records: number[] = [];
  let offset = 0;
  const offsets = entries.map((entry) => {
    const data = entry.data ?? Buffer.alloc(0),
      body = entry.method === 8 ? deflateRawSync(data) : data,
      name = Buffer.from(entry.name),
      crc = crc32(data),
      flags = entry.descriptor ? 8 : 0,
      method = entry.method ?? 0;
    const header = le(
      [0x04034b50, 4],
      [20, 2],
      [flags, 2],
      [method, 2],
      [0, 2],
      [0x21, 2],
      [entry.descriptor ? 0 : crc, 4],
      [entry.descriptor ? 0 : body.length, 4],
      [entry.descriptor ? 0 : data.length, 4],
      [name.length, 2],
      [0, 2],
    );
    const descriptor = entry.descriptor
      ? le([0x08074b50, 4], [crc, 4], [body.length, 4], [data.length, 4])
      : Buffer.alloc(0);
    locals.push(header, name, body, descriptor);
    const at = offset;
    offset += header.length + name.length + body.length + descriptor.length;
    return {
      at,
      crc,
      flags,
      method,
      name,
      size: body.length,
      length: data.length,
      comment: entry.comment,
    };
  });
  const start = offset;
  offsets.forEach(({ at, crc, flags, method, name, size, length, comment = Buffer.alloc(0) }) => {
    const extra = Buffer.concat([le([0x000a, 2], [32, 2]), Buffer.alloc(32)]);
    records.push(offset);
    const record = le(
      [0x02014b50, 4],
      [0x031e, 2],
      [20, 2],
      [flags, 2],
      [method, 2],
      [0, 2],
      [0x21, 2],
      [crc, 4],
      [size, 4],
      [length, 4],
      [name.length, 2],
      [extra.length, 2],
      [comment.length, 2],
      [0, 2],
      [0, 2],
      [(name.at(-1) === 0x2f ? 0o40755 : 0o100644) * 0x10000, 4],
      [at, 4],
    );
    centrals.push(record, name, extra, comment);
    offset += record.length + name.length + extra.length + comment.length;
  });
  const end = le(
    [0x06054b50, 4],
    [0, 2],
    [0, 2],
    [entries.length, 2],
    [entries.length, 2],
    [offset - start, 4],
    [start, 4],
    [0, 2],
  );
  return { bytes: Buffer.concat([...locals, ...centrals, end]), records };
}

// Store, Deflate and a data-descriptor entry, as packaging and ditto write them.
function validArchive(comment?: Buffer) {
  return zipArchive([
    { name: "Clawtrate.app/" },
    { name: "Clawtrate.app/stored", data: Buffer.from("stored") },
    { name: "Clawtrate.app/deflated", data: Buffer.alloc(4096, "a"), method: 8 },
    {
      name: "Clawtrate.app/descriptor",
      data: Buffer.alloc(4096, "b"),
      method: 8,
      descriptor: true,
      comment,
    },
  ]);
}

// Edit the valid archive at the central records of its stored entry and its last entry.
function edited(edit: (bytes: Buffer, stored: number, last: number) => void, comment?: Buffer) {
  const { bytes, records } = validArchive(comment);
  const [, stored, , last] = records;
  if (stored === undefined || last === undefined) throw new Error("expected four records");
  edit(bytes, stored, last);
  return bytes;
}

const endAt = (bytes: Buffer) => bytes.length - 22;

function zipTool(dir: string, name: string, tool: string, args: string[], input?: string): Buffer {
  const folder = join(dir, `tool-${name}`);
  mkdirSync(join(folder, "Clawtrate.app", "Contents"), { recursive: true });
  writeFileSync(join(folder, "Clawtrate.app", "Contents", "a.txt"), "hello hello hello\n");
  execFileSync(tool, args, { cwd: folder, input });
  return readFileSync(join(folder, "out.zip"));
}

// Each one is refused before libarchive opens it.
const refused: [string, (dir: string) => Buffer][] = [
  [
    "an oversized directory",
    () =>
      zipArchive(Array.from({ length: 128 }, () => ({ name: "f", comment: Buffer.alloc(65535) })))
        .bytes,
  ],
  [
    "more than 32,768 records",
    () => zipArchive(Array.from({ length: 32769 }, () => ({ name: "f" }))).bytes,
  ],
  [
    "a record count that doesn't match the walk",
    () =>
      edited((bytes) => {
        bytes.writeUInt16LE(5, endAt(bytes) + 8);
        bytes.writeUInt16LE(5, endAt(bytes) + 10);
      }),
  ],
  [
    "a directory size that doesn't match the walk",
    () =>
      edited((bytes) =>
        bytes.writeUInt32LE(bytes.readUInt32LE(endAt(bytes) + 12) + 1, endAt(bytes) + 12),
      ),
  ],
  [
    "a directory entry that isn't a record",
    () => edited((bytes, _, last) => bytes.writeUInt32LE(0x04034b50, last)),
  ],
  [
    "a record that runs into the end record",
    () => edited((bytes, _, last) => bytes.writeUInt16LE(1, last + 32)),
  ],
  [
    "a ZIP64 archive from zip -fz",
    (dir) => zipTool(dir, "zip64", "/usr/bin/zip", ["-qr", "-fz", "out.zip", "Clawtrate.app"]),
  ],
  [
    "a ZIP64 locator just before the end record",
    () => edited(() => {}, Buffer.concat([le([0x07064b50, 4]), Buffer.alloc(16)])),
  ],
  [
    "a ZIP64 compressed size in a record",
    () => edited((bytes, stored) => bytes.writeUInt32LE(0xffffffff, stored + 20)),
  ],
  [
    "a ZIP64 uncompressed size in a record",
    () => edited((bytes, stored) => bytes.writeUInt32LE(0xffffffff, stored + 24)),
  ],
  [
    "a comment from zip -z",
    (dir) =>
      zipTool(dir, "comment", "/usr/bin/zip", ["-qrz", "out.zip", "Clawtrate.app"], "note\n"),
  ],
  [
    "an end record without its signature",
    () => edited((bytes) => bytes.writeUInt32LE(0, endAt(bytes))),
  ],
  [
    "a comment length in the end record",
    () => edited((bytes) => bytes.writeUInt16LE(1, endAt(bytes) + 20)),
  ],
  ["a second disk", () => edited((bytes) => bytes.writeUInt16LE(1, endAt(bytes) + 4))],
  [
    "a directory on a second disk",
    () => edited((bytes) => bytes.writeUInt16LE(1, endAt(bytes) + 6)),
  ],
  [
    "fewer records on this disk than in all",
    () => edited((bytes) => bytes.writeUInt16LE(3, endAt(bytes) + 8)),
  ],
  [
    "an LZMA entry in the central header",
    () => edited((bytes, stored) => bytes.writeUInt16LE(14, stored + 10)),
  ],
  [
    "an LZMA entry in only the local header",
    () => edited((bytes, stored) => bytes.writeUInt16LE(14, bytes.readUInt32LE(stored + 42) + 8)),
  ],
  [
    "a local offset that isn't a local header",
    () => edited((bytes, stored) => bytes.writeUInt32LE(1, stored + 42)),
  ],
  [
    "a local offset past the end of the file",
    () => edited((bytes, stored) => bytes.writeUInt32LE(bytes.length, stored + 42)),
  ],
  [
    // A well-formed local header, but inside the last record's comment.
    "a local header inside the directory",
    () => {
      const header = le(
        [0x04034b50, 4],
        [20, 2],
        [0, 2],
        [0, 2],
        [0, 2],
        [0x21, 2],
        [0, 4],
        [0, 4],
        [0, 4],
        [0, 2],
        [0, 2],
      );
      return edited((bytes, stored, last) => {
        const inside = last + 46 + bytes.readUInt16LE(last + 28) + bytes.readUInt16LE(last + 30);
        bytes.writeUInt32LE(inside, stored + 42);
      }, header);
    },
  ],
  ["an empty file", () => Buffer.alloc(0)],
];

function runWith(file: string, args: string[], archive: string, cwd: string): string {
  const fd = openSync(archive, "r");
  try {
    return execFileSync(file, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe", fd],
      encoding: "utf8",
    }).trim();
  } finally {
    closeSync(fd);
  }
}

// The shipped helper, built with packaging's flags (packaging/config.ts) and
// its own main(). The test process is the helper's parent, and it isn't a
// signed Clawtrate, so a run that reaches inspect() classifies that signature.
describe.skipIf(process.platform !== "darwin")("Mac update inspection helper", () => {
  let dir: ReturnType<typeof tempDir>, helper: string;
  beforeAll(() => {
    dir = tempDir();
    helper = join(dir.path, "ClawtrateUpdateInspection");
    execFileSync("/usr/bin/xcrun", [
      "clang",
      "-fobjc-arc",
      "-Wall",
      "-Werror",
      "-O2",
      "-arch",
      "arm64",
      "-arch",
      "x86_64",
      "-mmacosx-version-min=12.0",
      "-framework",
      "Foundation",
      "-framework",
      "Security",
      "-larchive.2",
      resolve(import.meta.dirname, "../../packaging/mac/inspect-archive.m"),
      "-o",
      helper,
    ]);
  }, 60000);
  afterAll(() => dir.remove());
  const archiveArgs = ["scratch", "dev.clawtrate.desktop", "1.2.0", arch()];
  it.each([
    ["the running signature", ["--running-signature", "dev.clawtrate.desktop"]],
    ["a downloaded archive", archiveArgs],
  ])("starts and classifies %s", (_, args) => {
    const archive = join(dir.path, "valid.zip");
    writeFileSync(archive, validArchive().bytes);
    expect(["build-not-signed", "running-signature-untrusted"]).toContain(
      runWith(helper, args, archive, dir.path),
    );
  });
  // The archive check runs before inspect() reads the running signature.
  it.each(refused.filter(([name]) => /LZMA entry in only|zip -fz|empty file/.test(name)))(
    "refuses %s before it classifies anything",
    (name, build) => {
      const archive = join(dir.path, `${name}.zip`);
      writeFileSync(archive, build(dir.path));
      expect(runWith(helper, archiveArgs, archive, dir.path)).toBe("mac-archive");
    },
  );
});

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
      if (strcmp(argv[1], "preflight") == 0) puts(preflight(3) ? "ok" : "mac-archive");
      else if (strcmp(argv[1], "adhoc") == 0) puts(signatureKind(0, @{(__bridge NSString *)kSecCodeInfoFlags:@(kSecCodeSignatureAdhoc), (__bridge NSString *)kSecCodeInfoIdentifier:@"fixture"}));
      else puts(signatureKind(0, @{}));
      return 0;
    }
    int root=open(argv[1],O_DIRECTORY|O_RDONLY);
    if (argc == 4 && strcmp(argv[2], "budget") == 0) {
      puts(unpackWithBudget(3,root,atoi(argv[3])) ? "ok" : "mac-archive");
      return 0;
    }
    if (!preflight(3) || !unpack(3,root)) {puts("mac-archive"); return 0;}
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
  const preflight = (name: string, bytes: Buffer) => {
    const archive = join(dir.path, `${name}.zip`);
    writeFileSync(archive, bytes);
    return runWith(reader, ["preflight"], archive, dir.path);
  };
  it.each(["adhoc", "unsigned"])(
    "classifies %s signing information without trust evaluation or an archive",
    (kind) => {
      expect(execFileSync(reader, [kind], { encoding: "utf8" }).trim()).toBe("build-not-signed");
    },
  );
  it.each<[string, (dir: string) => Buffer]>([
    ["Store, Deflate and a data descriptor", () => validArchive().bytes],
    [
      "exactly 32,768 records",
      () => zipArchive(Array.from({ length: 32768 }, () => ({ name: "f" }))).bytes,
    ],
    [
      "a ditto archive",
      (dir) =>
        zipTool(dir, "ditto", "/usr/bin/ditto", [
          "-c",
          "-k",
          "--keepParent",
          "Clawtrate.app",
          "out.zip",
        ]),
    ],
    [
      // The release script's path when it staples again: extended attributes go to __MACOSX.
      "a ditto --sequesterRsrc archive with extended attributes",
      (dir) =>
        zipTool(dir, "sequester", "/bin/sh", [
          "-c",
          [
            "xattr -w dev.clawtrate.test 1 Clawtrate.app/Contents/a.txt",
            "ditto -c -k --sequesterRsrc --keepParent Clawtrate.app out.zip",
            "/usr/bin/unzip -tqq out.zip __MACOSX/Clawtrate.app/Contents/._a.txt",
          ].join(" && "),
        ]),
    ],
    [
      "a zip archive",
      (dir) => zipTool(dir, "zip", "/usr/bin/zip", ["-qr", "out.zip", "Clawtrate.app"]),
    ],
  ])("passes %s", (name, build) => {
    expect(preflight(name, build(dir.path))).toBe("ok");
  });
  it.each(refused)("refuses %s", (name, build) => {
    expect(preflight(name, build(dir.path))).toBe("mac-archive");
  });
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
  const version = "1.2.0-beta.20261104.10";
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
