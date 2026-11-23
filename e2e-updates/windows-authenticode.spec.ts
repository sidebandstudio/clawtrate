// Real Authenticode signatures, read by the helper the Windows installer uses. The checks
// exist only on Windows. The first group signs nothing: it uses executables the machine already
// has, Node's own, another publisher's and Windows' own. The second runs the helper's version
// reader alone on files made here, with crafted resource tables. The third exists only when
// CLAWTRATE_AUTHENTICODE_FILES names the files CI's windows job signs with certificates it makes
// for the run.
import { expect, test } from "@playwright/test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectUpdateFile } from "../apps/desktop/src/main/inspect-update-file.ts";
import { runUpdatePowerShell } from "../apps/desktop/src/main/private-update-directory.ts";
import type { VerifiedArtifact } from "../apps/desktop/src/main/update/install.ts";
import {
  inspectSource,
  inspectWithPowerShell,
  windowsInstaller,
  windowsRefusal,
} from "../apps/desktop/src/main/windows-install.ts";

const windows = process.platform === "win32";
const files = process.env.CLAWTRATE_AUTHENTICODE_FILES;
const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32");

/** What Windows PowerShell's own cmdlets, which go through Windows' usual lookups, say of a file. */
async function windowsSays(script: string, path: string) {
  const { stdout } = await runUpdatePowerShell(script, { CLAWTRATE_CHECKED_FILE: path }, 60000);
  return stdout.trim();
}

/** The facts the helper's version reader gives for a file it holds, or the error it refuses it
 * with, and how many milliseconds the reading took. The reader expects the file's own SHA-512
 * unless given another. */
async function readVersions(path: string, sha512?: string) {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${inspectSource}
'@
$file = [IO.File]::OpenRead($env:CLAWTRATE_CHECKED_FILE)
$sha512 = [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash($file))
if ($env:CLAWTRATE_EXPECTED_SHA512) { $sha512 = $env:CLAWTRATE_EXPECTED_SHA512 }
$clock = [Diagnostics.Stopwatch]::StartNew()
try {
  [UpdateVersions]::Read($env:CLAWTRATE_CHECKED_FILE, $file, $sha512)
} catch {
  $cause = $_.Exception
  while ($cause.InnerException) { $cause = $cause.InnerException }
  "refused $($cause.GetType().Name)"
} finally {
  $file.Dispose()
}
"took $($clock.ElapsedMilliseconds)"
`;
  const values = { CLAWTRATE_CHECKED_FILE: path, CLAWTRATE_EXPECTED_SHA512: sha512 ?? "" };
  const lines = (await runUpdatePowerShell(script, values, 60000)).stdout.trim().split(/\r?\n/);
  const took = Number(/^took (\d+)$/.exec(lines.pop() ?? "")?.[1]);
  return { lines, took };
}

// A Portable Executable file with only what a version lookup reads: the headers, one section
// at RVA 0x1000 and a resource table in it.
const RVA = 0x1000;
const DIRECTORY = 0x80000000;

function portable(tree: Buffer) {
  const file = Buffer.alloc(0x200 + tree.length);
  file.write("MZ", 0, "latin1");
  file.writeUInt32LE(0x40, 0x3c);
  file.writeUInt32LE(0x4550, 0x40);
  file.writeUInt16LE(0x8664, 0x44);
  // One section, after an optional header of 240 bytes: PE32+ with 16 data directories, the
  // third of them the resource table.
  file.writeUInt16LE(1, 0x46);
  file.writeUInt16LE(240, 0x54);
  file.writeUInt16LE(0x20b, 0x58);
  file.writeUInt32LE(16, 0x58 + 108);
  file.writeUInt32LE(RVA, 0x58 + 128);
  file.writeUInt32LE(tree.length, 0x58 + 132);
  const section = 0x58 + 240;
  file.write(".rsrc", section, "latin1");
  file.writeUInt32LE(tree.length, section + 8);
  file.writeUInt32LE(RVA, section + 12);
  file.writeUInt32LE(tree.length, section + 16);
  file.writeUInt32LE(0x200, section + 20);
  tree.copy(file, 0x200);
  return file;
}

/** A resource directory whose entries all have the number id and point at these targets. */
function directory(targets: number[], id = 1) {
  const bytes = Buffer.alloc(16 + 8 * targets.length);
  bytes.writeUInt16LE(targets.length, 14);
  targets.forEach((target, i) => {
    bytes.writeUInt32LE(id, 16 + 8 * i);
    bytes.writeUInt32LE(target >>> 0, 20 + 8 * i);
  });
  return bytes;
}

function dataEntry(at: number, size: number) {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(RVA + at, 0);
  bytes.writeUInt32LE(size, 4);
  return bytes;
}

const pad = (bytes: Buffer) => Buffer.concat([bytes, Buffer.alloc(-bytes.length & 3)]);
const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** A version resource node: its length, its value's length, its type, its key, its value and its
 * children, each part on a four-byte boundary. */
function node(key: string, value: Buffer | string, ...children: Buffer[]) {
  const text = typeof value === "string";
  const data = text ? Buffer.from(value + "\0", "utf16le") : value;
  const head = pad(Buffer.concat([Buffer.alloc(6), Buffer.from(key + "\0", "utf16le")]));
  const bytes = Buffer.concat([head, pad(data), ...children.map(pad)]);
  bytes.writeUInt16LE(bytes.length, 0);
  bytes.writeUInt16LE(text ? data.length / 2 : data.length, 2);
  bytes.writeUInt16LE(text ? 1 : 0, 4);
  return bytes;
}

/** VS_VERSION_INFO with a fixed product version, string tables that each may have a
 * ProductVersion, and a list of translations as language and code page. */
function versionResource(
  product: [number, number, number, number],
  tables: [key: string, version: string | null][],
  translations: [language: number, codePage: number][],
) {
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xfeef04bd, 0);
  fixed.writeUInt32LE(((product[0] << 16) | product[1]) >>> 0, 16);
  fixed.writeUInt32LE(((product[2] << 16) | product[3]) >>> 0, 20);
  const strings = tables.map(([key, version]) =>
    node(
      key,
      Buffer.alloc(0),
      node("ProductName", "Clawtrate"),
      ...(version === null ? [] : [node("ProductVersion", version)]),
    ),
  );
  const list = Buffer.alloc(4 * translations.length);
  translations.forEach(([language, codePage], i) => {
    list.writeUInt16LE(language, 4 * i);
    list.writeUInt16LE(codePage, 4 * i + 2);
  });
  return node(
    "VS_VERSION_INFO",
    fixed,
    node("StringFileInfo", Buffer.alloc(0), ...strings),
    node("VarFileInfo", Buffer.alloc(0), node("Translation", list)),
  );
}

const release = versionResource([1, 2, 0, 0], [["040904b0", "1.2.0"]], [[0x409, 1200]]);

/** A resource table with one version resource: the root, type 16's directory, name 1's
 * directory, language 0x409's data entry and then the resource. */
function versionTree(resource: Buffer, size = resource.length) {
  return Buffer.concat([
    directory([DIRECTORY | 24], 16),
    directory([DIRECTORY | 48]),
    directory([72], 0x409),
    dataEntry(88, size),
    resource,
  ]);
}

/** Every name of type 16 leads to one directory, and every language there to one data entry,
 * so a reader without limits parses the same resource count × count times. */
function loopingTree(count: number) {
  const names = 24 + 16 + 8 * count,
    entry = names + 16 + 8 * count;
  return Buffer.concat([
    directory([DIRECTORY | 24], 16),
    directory(Array<number>(count).fill(DIRECTORY | names)),
    directory(Array<number>(count).fill(entry)),
    dataEntry(entry + 16, release.length),
    release,
  ]);
}

let dir = "";
test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clawtrate-authenticode-"));
});
test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function proof(path: string, version: string): Promise<VerifiedArtifact> {
  const file = await inspectUpdateFile(path, readFileSync(path).length);
  if (!file) throw Error("The helper could not read " + path);
  return { ...file, path, version, offerId: "offer", track: "stable" };
}

function place(name: string, bytes: Buffer) {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

function changedAfterSigning(bytes: Buffer) {
  const changed = Buffer.from(bytes);
  changed[Math.floor(changed.length / 2)]! ^= 0xff;
  return changed;
}

/** A copy of bytes with each UTF-16 occurrence of text written over with that many of digit,
 * and how many there were. */
function rewritten(bytes: Buffer, text: string, digit: string) {
  const copy = Buffer.from(bytes);
  const from = Buffer.from(text, "utf16le");
  let count = 0;
  for (let at = copy.indexOf(from); at >= 0; at = copy.indexOf(from, at + 1), count++)
    Buffer.from(digit.repeat(text.length), "utf16le").copy(copy, at);
  return { bytes: copy, count };
}

/** The same executable without its signature: no certificate table, and no bytes after it. */
function withoutSignature(bytes: Buffer) {
  const header = bytes.readUInt32LE(0x3c) + 24;
  const table = header + (bytes.readUInt16LE(header) === 0x20b ? 112 : 96) + 4 * 8;
  const copy = Buffer.from(bytes.subarray(0, bytes.readUInt32LE(table)));
  copy.fill(0, table, table + 8);
  return copy;
}

if (windows)
  test.describe("files this machine already has", () => {
    // Node's own executable stands in for the running app, signed by Node's publisher.
    const running = process.execPath;
    const version = process.versions.node;
    // Another publisher's signed executable: PowerShell 7 on CI's runner, else Git.
    const other = [
      join(process.env.ProgramFiles ?? "", "PowerShell", "7", "pwsh.exe"),
      join(process.env.ProgramFiles ?? "", "Git", "cmd", "git.exe"),
    ].find((path) => existsSync(path));
    const signed = () => readFileSync(running);

    test("F-231: accepts a copy of the running app's executable at its version", async () => {
      const path = place("setup.exe", signed());
      expect(await windowsInstaller(running).inspect(await proof(path, version))).toBeNull();
    });

    test("F-231: refuses it at another version", async () => {
      const path = place("setup.exe", signed());
      expect(await windowsInstaller(running).inspect(await proof(path, "0.0.1"))).toBe(
        "installer-version",
      );
    });

    test("F-231: refuses a copy changed after signing", async () => {
      const path = place("setup.exe", changedAfterSigning(signed()));
      expect(await windowsInstaller(running).inspect(await proof(path, version))).toBe(
        "windows-signature",
      );
    });

    test("F-231: refuses a copy without its signature", async () => {
      const path = place("setup.exe", withoutSignature(signed()));
      expect(await windowsInstaller(running).inspect(await proof(path, version))).toBe(
        "windows-signature",
      );
    });

    test("F-231: refuses a file Windows vouches for only through a catalog", async () => {
      const path = place(
        "setup.exe",
        readFileSync(join(system, "WindowsPowerShell", "v1.0", "powershell.exe")),
      );
      // First, that Windows trusts this copy, and only through a catalog.
      const trust = await windowsSays(
        `$s = Get-AuthenticodeSignature -LiteralPath $env:CLAWTRATE_CHECKED_FILE; "$($s.Status) $($s.SignatureType)"`,
        path,
      );
      expect(trust).toBe("Valid Catalog");
      expect(await windowsInstaller(running).inspect(await proof(path, version))).toBe(
        "windows-signature",
      );
    });

    test("F-231: reads an installer's own version, not one from a .mui file beside it or Windows' own", async () => {
      // cmd.exe is language-neutral: Windows' version lookup takes its version from a .mui file
      // in a language folder beside it, and System32 holds one. Here it is outside the system
      // folders, under its own name. Through the version reader alone: Windows vouches for
      // cmd.exe only through a catalog, so the whole check never gets as far as its version.
      const bytes = readFileSync(join(system, "cmd.exe"));
      const path = place("cmd.exe", bytes);
      const lookup = `[Diagnostics.FileVersionInfo]::GetVersionInfo($env:CLAWTRATE_CHECKED_FILE).ProductVersion`;
      const read = async () => {
        const { lines } = await readVersions(path);
        expect(lines[0]).toBe("versions 1");
        return Buffer.from(lines[1]!.split(" ")[2]!, "base64").toString("utf8");
      };
      // The file's own version, written over with 8s, tells its own strings from a .mui file's.
      const own = await read();
      expect(own).toMatch(/^\d+\.\d+/);
      const eights = rewritten(bytes, own, "8");
      expect(eights.count).toBeGreaterThan(0);
      writeFileSync(path, eights.bytes);
      // A copy of System32's .mui file beside it, its version written over with 9s.
      const muiPath = join(system, "en-US", "cmd.exe.mui");
      const text = await windowsSays(lookup, muiPath);
      const nines = rewritten(readFileSync(muiPath), text, "9");
      expect(nines.count).toBeGreaterThan(0);
      mkdirSync(join(dir, "en-US"));
      writeFileSync(join(dir, "en-US", "cmd.exe.mui"), nines.bytes);
      // Windows' version lookup takes the version from the .mui file beside the file.
      expect(await windowsSays(lookup, path)).toBe("9".repeat(text.length));
      // The reader takes the file's own, from neither that .mui file nor System32's, and leaves
      // no copy behind.
      expect(await read()).toBe("8".repeat(own.length));
      expect(readdirSync(dir).sort()).toEqual(["cmd.exe", "en-US"]);
    });

    test("F-231: never copies or reads the version of a download whose signature fails", async () => {
      // An unsigned file with a version resource the reader would read.
      const file = await proof(place("setup.exe", portable(versionTree(release))), "1.2.0");
      const output = await inspectWithPowerShell(file, running, new AbortController().signal);
      expect(output.trimEnd().split(/\r?\n/).at(-1)).toBe("versions unread");
      expect(windowsRefusal(output, file)).toBe("windows-signature");
      expect(readdirSync(dir)).toEqual(["setup.exe"]);
    });

    test("F-231: refuses another publisher's signed executable", async () => {
      expect(other, "a signed executable from another publisher").toBeDefined();
      const path = place("setup.exe", readFileSync(other!));
      expect(await windowsInstaller(running).inspect(await proof(path, version))).toBe(
        "windows-publisher",
      );
    });

    test("F-231: an unsigned running app is a build that cannot update itself", async () => {
      const unsigned = place("running.exe", withoutSignature(signed()));
      const path = place("setup.exe", signed());
      expect(await windowsInstaller(unsigned).inspect(await proof(path, version))).toBe(
        "build-not-signed",
      );
    });

    test("F-231: launch reads the download again, catches a change and otherwise waits for the trial", async () => {
      const path = place("setup.exe", signed());
      const file = await proof(path, version);
      const installer = windowsInstaller(running);
      expect(await installer.inspect(file)).toBeNull();
      expect(await installer.launch(file, new AbortController().signal, () => {})).toBe(
        "windows-install-pending-trial",
      );
      expect(await installer.inspect(file)).toBeNull();
      // The same file, rewritten in place: its identity stays, its bytes do not.
      writeFileSync(path, changedAfterSigning(signed()));
      expect(await installer.launch(file, new AbortController().signal, () => {})).toBe(
        "artifact-changed",
      );
    });
  });

if (windows)
  test.describe("the version reader, on crafted files", () => {
    test("F-231: gives the ProductVersion of every string table and translation", async () => {
      const resource = versionResource(
        [1, 2, 0, 7],
        [
          ["040904b0", "1.2.0"],
          ["040704B0", null],
        ],
        [
          [0x409, 1200],
          [0x407, 1200],
          [0xc0a, 1200],
        ],
      );
      const { lines } = await readVersions(place("setup.exe", portable(versionTree(resource))));
      // The German table has none, and the Spanish translation has no table.
      expect(lines).toEqual(["versions 1", `resource 1.2.0.7 ${base64("1.2.0")} - -`]);
    });

    test("F-231: refuses a copy without the held file's SHA-512 after the reading, and removes it", async () => {
      const path = place("setup.exe", portable(versionTree(release)));
      const { lines } = await readVersions(path, "A".repeat(86) + "==");
      expect(lines).toEqual(["refused InvalidDataException"]);
      expect(readdirSync(dir)).toEqual(["setup.exe"]);
    });

    const key = Buffer.from(release);
    // VS_VERSION_INFO's length now ends inside its key.
    key.writeUInt16LE(16, 0);
    const huge = Buffer.concat([release, Buffer.alloc(0x100000)]);
    // 65535 named entries and 65535 numbered ones.
    const crowded = Buffer.alloc(16);
    crowded.writeUInt32LE(0xffffffff, 12);
    // Windows finds one version resource by its number and language, and reads the length the
    // resource gives itself. So a table that leads to one resource many times, a data entry
    // over 64 KiB and 17 resources give the one release it finds. The rest give no version, or
    // fail, which the whole check refuses.
    const found = ["versions 1", `resource 1.2.0.0 ${base64("1.2.0")}`];
    const crafted: [string, Buffer, string[]][] = [
      [
        "reads one release from a resource table that reaches one directory and one data entry many times",
        loopingTree(4000),
        found,
      ],
      [
        "finds no version in a type directory that leads back to the root",
        directory([DIRECTORY | 0], 16),
        ["versions 0"],
      ],
      [
        "finds no version where a directory stands for a language's data entry",
        Buffer.concat([
          directory([DIRECTORY | 24], 16),
          directory([DIRECTORY | 48]),
          directory([DIRECTORY | 72], 0x409),
          directory([96], 0x409),
          dataEntry(112, release.length),
          release,
        ]),
        ["versions 0"],
      ],
      ["reads the release's own length from a data entry over 64 KiB", versionTree(huge), found],
      [
        "finds no version in a directory claiming more entries than it holds",
        crowded,
        ["versions 0"],
      ],
      [
        "fails on a version resource whose length ends inside its key",
        versionTree(key),
        ["refused IOException"],
      ],
      [
        "reads one release from 17 version resources",
        Buffer.concat([
          directory([DIRECTORY | 24], 16),
          directory([DIRECTORY | 48]),
          directory(
            Array.from({ length: 17 }, (_, i) => 48 + 16 + 8 * 17 + 16 * i),
            0x409,
          ),
          ...Array.from({ length: 17 }, () =>
            dataEntry(48 + 16 + 8 * 17 + 16 * 17, release.length),
          ),
          release,
        ]),
        found,
      ],
    ];
    for (const [name, tree, expected] of crafted)
      test(`F-231: ${name}, at once`, async () => {
        const { lines, took } = await readVersions(place("setup.exe", portable(tree)));
        expect(lines).toEqual(expected);
        expect(took).toBeLessThan(2000);
      });
  });

if (windows && files)
  test.describe("files signed for this run", () => {
    const version = (
      JSON.parse(readFileSync("apps/desktop/package.json", "utf8")) as { version: string }
    ).version;
    // Clawtrate.exe and the installer from this run's build, each signed by the job.
    const inspect = async (name: string, running = "running.exe") => {
      const path = join(dir, name);
      copyFileSync(join(files!, name), path);
      return windowsInstaller(join(files!, running)).inspect(await proof(path, version));
    };

    test("F-231: accepts the installer signed with the running app's certificate", async () => {
      expect(await inspect("setup.exe")).toBeNull();
    });

    test("F-231: accepts a renewed certificate with the same subject under the same root", async () => {
      expect(await inspect("renewed.exe")).toBeNull();
    });

    test("F-231: refuses the same subject under another trusted root", async () => {
      expect(await inspect("other-root.exe")).toBe("windows-publisher");
    });

    test("F-231: refuses another subject under the same root", async () => {
      expect(await inspect("other-subject.exe")).toBe("windows-publisher");
    });

    test("F-231: refuses the same subject under a root Windows does not trust", async () => {
      expect(await inspect("untrusted.exe")).toBe("windows-signature");
    });

    test("F-231: refuses the signed installer changed after signing", async () => {
      expect(await inspect("tampered.exe")).toBe("windows-signature");
    });

    test("F-231: refuses the installer as built, unsigned", async () => {
      expect(await inspect("unsigned.exe")).toBe("windows-signature");
    });

    // SHA-1 first and SHA-256 nested after it, the way electron-builder signs by default.
    test("F-231: accepts an installer and a running app each signed SHA-1 then SHA-256", async () => {
      expect(await inspect("dual.exe", "running-dual.exe")).toBeNull();
    });

    test("F-231: accepts a SHA-256 signature from the running app's certificate under another publisher's SHA-1 one", async () => {
      expect(await inspect("dual-other-sha1.exe")).toBeNull();
    });

    test("F-231: refuses another publisher's SHA-256 signature under the running app's SHA-1 one", async () => {
      expect(await inspect("dual-other-sha256.exe")).toBe("windows-publisher");
    });

    test("F-231: refuses an installer with only a SHA-1 signature from the running app's certificate", async () => {
      expect(await inspect("sha1.exe")).toBe("windows-signature");
    });
  });
