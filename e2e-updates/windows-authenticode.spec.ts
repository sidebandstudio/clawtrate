// Real Authenticode signatures, read by the helper the Windows installer uses. The checks
// exist only on Windows. The first group signs nothing: it uses executables the machine already
// has, Node's own and another publisher's. The second exists only when
// CLAWTRATE_AUTHENTICODE_FILES names the files CI's windows job signs with certificates it makes
// for the run.
import { expect, test } from "@playwright/test";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectUpdateFile } from "../apps/desktop/src/main/inspect-update-file.ts";
import type { VerifiedArtifact } from "../apps/desktop/src/main/update/install.ts";
import { windowsInstaller } from "../apps/desktop/src/main/windows-install.ts";

const windows = process.platform === "win32";
const files = process.env.CLAWTRATE_AUTHENTICODE_FILES;

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
      const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
      const path = place(
        "setup.exe",
        readFileSync(join(system, "WindowsPowerShell", "v1.0", "powershell.exe")),
      );
      expect(await windowsInstaller(running).inspect(await proof(path, version))).toBe(
        "windows-signature",
      );
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
