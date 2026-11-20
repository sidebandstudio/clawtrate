import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { runUpdatePowerShell } from "./private-update-directory.ts";

interface FileProof {
  identity: string;
  size: number;
  sha512: string;
}

/** Windows has no O_NOFOLLOW in libuv. Open the reparse point itself and
 * inspect and hash the same disk handle, denying writes and deletion while open. */
const inspectWindows = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
public static class UpdateFile {
  [StructLayout(LayoutKind.Sequential)]
  struct Info {
    public uint attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME created, accessed, written;
    public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
  }
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security,
    uint creation, uint flags, IntPtr template);
  [DllImport("kernel32")] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("kernel32")] static extern uint GetFileType(SafeFileHandle handle);
  public static string Inspect(string path, long expected) {
    using (var handle = CreateFileW(path, 0x80000000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
      Info info;
      if (handle.IsInvalid || GetFileType(handle) != 1 || !GetFileInformationByHandle(handle, out info)
          || (info.attributes & 0x410) != 0) throw new IOException();
      using (var file = new FileStream(handle, FileAccess.Read)) {
        if (file.Length != expected) return "size-mismatch";
        using (var hash = SHA512.Create()) {
          return info.volume + "." + info.indexHigh + "." + info.indexLow + " " +
            Convert.ToBase64String(hash.ComputeHash(file));
        }
      }
    }
  }
}
'@
[UpdateFile]::Inspect($env:CLAWTRATE_UPDATE_FILE, [long]$env:CLAWTRATE_UPDATE_SIZE)
`;

export async function inspectUpdateFile(path: string, expected: number): Promise<FileProof | null> {
  if (process.platform === "win32") {
    const { stdout } = await runUpdatePowerShell(
      inspectWindows,
      {
        CLAWTRATE_UPDATE_FILE: path,
        CLAWTRATE_UPDATE_SIZE: String(expected),
      },
      120000,
    );
    if (stdout.trim() === "size-mismatch") return null;
    const match = /^(\d+\.\d+\.\d+) ([A-Za-z0-9+/]{86}==)$/.exec(stdout.trim());
    if (!match) throw Error("Cannot inspect update");
    return { identity: match[1]!, sha512: match[2]!, size: expected };
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile()) throw Error("Expected a regular update file");
    if (info.size !== BigInt(expected)) return null;
    const hash = createHash("sha512");
    const buffer = Buffer.alloc(64 * 1024);
    let received = 0;
    while (received <= expected) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, expected - received + 1),
      );
      if (!bytesRead) break;
      received += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (received !== expected) return null;
    const end = await lstat(path, { bigint: true });
    if (info.dev !== end.dev || info.ino !== end.ino || info.ctimeNs !== end.ctimeNs)
      throw Error("Update file changed");
    return {
      identity: [info.dev, info.ino, info.birthtimeNs].join("."),
      size: received,
      sha512: hash.digest("base64"),
    };
  } finally {
    await file.close();
  }
}
